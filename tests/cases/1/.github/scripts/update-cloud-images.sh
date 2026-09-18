#!/usr/bin/env bash
# @pipe stdin: {"environment": string, "parsed_images": {"target_family": string, "platforms": [string], "images": [{"platform": string, "registry": string, "repository": string, "image_name": string, "deployment_names": [string], "tag": string} | {"platform": string, "registry": string, "repository": string, "image_name": string, "deployment_names": [string], "digest": string}]}}
# @pipe stdout: {"target_family": string, "kustomization_file_path": string, "platforms": [string], "restart_targets": {} | {"aws": {"deployments": [string], "namespace": string}} | {"huaweicloud": {"deployments": [string], "namespace": string}} | {"aws": {"deployments": [string], "namespace": string}, "huaweicloud": {"deployments": [string], "namespace": string}}}

# Update overlays from an environment and parsed-images JSON; emit update metadata.
set -euo pipefail
export LC_ALL=C

fail() {
  printf 'ERROR: %s\n' "$1" >&2
  exit 1
}

# Consume stdin once; extract both parameters from the captured JSON document.
input_json="$(jq -c '.')"
environment="$(jq -er '.environment' <<< "$input_json")"
parsed_images_json="$(jq -c '.parsed_images' <<< "$input_json")"
case "$environment" in
  dev|pre-dev|test|staging|prod) ;;
  *) fail 'unsupported environment.' ;;
esac

# Validate consumed fields; image-reference validation belongs to the parser.
if ! jq -e '
  type == "object" and
  (.target_family | type == "string" and length > 0) and
  (.images | type == "array" and length > 0 and all(.[];
    (.platform | type == "string" and length > 0) and
    (.image_name | type == "string" and length > 0) and
    (.repository | type == "string" and length > 0) and
    (.deployment_names | type == "array" and
      all(.[]; type == "string" and length > 0)) and
    ((has("digest") and (.digest | type == "string" and length > 0)) or
     (has("tag") and (.tag | type == "string" and length > 0)))
  ))
' <<< "$parsed_images_json" >/dev/null; then
  fail 'invalid parsed images JSON.'
fi

target_family="$(jq -er '.target_family' <<< "$parsed_images_json")"
case "$target_family" in
  cloud|cloud-auth|omp) ;;
  *) fail 'unsupported target family.' ;;
esac

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd -- "$script_dir/../.." && pwd)"
kustomization_file_path="resources/$target_family/overlays/$environment"
overlay_path="$repo_root/$kustomization_file_path"
[[ -d "$overlay_path" ]] || fail 'target family is not deployed to this environment.'

if ! jq -e '
  .images as $images |
  ($images | map([.platform, .image_name])) as $targets |
  ($targets | length) == ($targets | unique | length)
' <<< "$parsed_images_json" >/dev/null; then
  fail 'duplicate image target.'
fi

# These selectors are static code; image input only enters yq through strenv.
image_selector='.images[] | select(.name == strenv(IMAGE_ORIGIN_NAME) or .newName == strenv(IMAGE_REPOSITORY))'
portal_image_selector='select(.kind == "Deployment" and .metadata.name == "support-portal") | .spec.template.spec.containers[] | select(.name == "support-portal") | .image'

# Validate all overlays and image targets before any writes.
platform_namespaces='{}'
while IFS= read -r image; do
  platform="$(jq -er '.platform' <<< "$image")"
  image_name="$(jq -er '.image_name' <<< "$image")"
  image_repository="$(jq -er '.repository' <<< "$image")"
  case "$platform" in
    aws|huaweicloud) ;;
    *) fail 'unsupported deployment platform.' ;;
  esac

  kustomization_file="$overlay_path/$platform/kustomization.yaml"
  [[ -f "$kustomization_file" ]] || fail 'target overlay does not exist.'

  # The overlay is authoritative: OMP prod uses "omp", not "omp-prod".
  deployment_namespace="$(yq eval -o=json '.namespace' "$kustomization_file" |
    jq -er 'select(type == "string" and length > 0)')" \
    || fail 'target overlay namespace is missing or invalid.'
  platform_namespaces="$(jq -c --arg platform "$platform" --arg namespace "$deployment_namespace" \
    '.[$platform] = $namespace' <<< "$platform_namespaces")"

  export IMAGE_ORIGIN_NAME="$image_name"
  export IMAGE_REPOSITORY="$image_repository"
  if [[ "$image_name" == support-portal ]]; then
    target_file="$overlay_path/$platform/support-portal.yaml"
    [[ -f "$target_file" ]] || fail 'Portal manifest does not exist.'
    yq eval-all -e \
      "([$portal_image_selector] | length) == 1" \
      "$target_file" >/dev/null \
      || fail 'expected exactly one Portal container.'
  else
    yq eval -e \
      "([$image_selector] | length) == 1" \
      "$kustomization_file" >/dev/null \
      || fail 'target image name is not configured uniquely in the overlay.'
  fi
done < <(jq -c '.images[]' <<< "$parsed_images_json")

while IFS= read -r image; do
  platform="$(jq -er '.platform' <<< "$image")"
  image_name="$(jq -er '.image_name' <<< "$image")"
  image_repository="$(jq -er '.repository' <<< "$image")"
  has_digest="$(jq -r 'has("digest")' <<< "$image")"
  if [[ "$has_digest" == true ]]; then
    image_version="$(jq -er '.digest' <<< "$image")"
    image_reference="$image_repository@$image_version"
  else
    image_version="$(jq -er '.tag' <<< "$image")"
    image_reference="$image_repository:$image_version"
  fi

  kustomization_file="$overlay_path/$platform/kustomization.yaml"
  export IMAGE_ORIGIN_NAME="$image_name"
  export IMAGE_REPOSITORY="$image_repository"
  export IMAGE_VERSION="$image_version"
  export IMAGE_REFERENCE="$image_reference"

  if [[ "$image_name" == support-portal ]]; then
    target_file="$overlay_path/$platform/support-portal.yaml"
    # yq normalizes multi-document whitespace even for an identity assignment.
    # Leave an unchanged image byte-for-byte intact so it takes the restart path.
    current_reference="$(yq eval -r "$portal_image_selector" "$target_file")"
    if [[ "$current_reference" != "$image_reference" ]]; then
      yq eval "($portal_image_selector) = strenv(IMAGE_REFERENCE)" -i "$target_file"
    fi
  else
    if [[ "$has_digest" == true ]]; then
      version_field=digest
      obsolete_field=newTag
    else
      version_field=newTag
      obsolete_field=digest
    fi
    yq eval \
      "($image_selector | .newName) = strenv(IMAGE_REPOSITORY) |
       ($image_selector | .$version_field) = strenv(IMAGE_VERSION) |
       del($image_selector | .$obsolete_field)" \
      -i "$kustomization_file"
  fi
done < <(jq -c '.images[]' <<< "$parsed_images_json")

platforms_json="$(jq -c '
  reduce (.images[] | .platform) as $platform
    ([]; if index($platform) == null then . + [$platform] else . end)
' <<< "$parsed_images_json")"
# Update-only images do not contribute restart targets.
restart_targets_json="$(jq -c --argjson namespaces "$platform_namespaces" '
  reduce (.images[] | select(.deployment_names | length > 0)) as $image ({};
    .[$image.platform] //= {
      deployments: [],
      namespace: $namespaces[$image.platform]
    }
    | .[$image.platform].deployments += $image.deployment_names
    | .[$image.platform].deployments |= unique
  )
' <<< "$parsed_images_json")"
if ! jq -e '
  all(.[];
    (.namespace | type == "string" and length > 0) and
    (.deployments | type == "array" and length > 0 and all(.[]; type == "string" and length > 0))
  )
' <<< "$restart_targets_json" >/dev/null; then
  fail 'failed to build platform-specific restart targets.'
fi
jq -n \
  --arg target_family "$target_family" \
  --arg kustomization_file_path "$kustomization_file_path" \
  --argjson platforms "$platforms_json" \
  --argjson restart_targets "$restart_targets_json" \
  '{
    target_family: $target_family,
    kustomization_file_path: $kustomization_file_path,
    platforms: $platforms,
    restart_targets: $restart_targets
  }'
