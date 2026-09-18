#!/usr/bin/env bash
# @pipe stdin: string
# @pipe stdout: {"target_family": string, "platforms": [string], "images": [{"platform": string, "registry": string, "repository": string, "image_name": string, "deployment_names": [string], "tag": string} | {"platform": string, "registry": string, "repository": string, "image_name": string, "deployment_names": [string], "digest": string}]}

# Validate allowlisted image references and emit JSON without side effects.
set -euo pipefail
export LC_ALL=C

input="$(jq -er '.')"
if [[ -z "$input" ]]; then
  printf 'ERROR: expected non-empty images JSON string on stdin.\n' >&2
  exit 1
fi

if [[ "$input" == ,* || "$input" == *, || "$input" == *,,* ]]; then
  printf 'ERROR: empty image reference.\n' >&2
  exit 1
fi
if [[ "$input" =~ [^a-zA-Z0-9./,@:_-] ]]; then
  printf 'ERROR: image reference contains forbidden characters.\n' >&2
  exit 1
fi

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
allowlist="$script_dir/cloud-image-allowlist.tsv"
IFS=',' read -r -a references <<< "$input"
seen_targets=''
images_json='[]'
selected_target_family=''

for reference in "${references[@]}"; do
  tag=''
  digest=''
  if [[ "$reference" =~ ^[a-z0-9./_-]+:[a-zA-Z0-9_][a-zA-Z0-9_.-]{0,127}$ ]]; then
    repository="${reference%:*}"
    tag="${reference##*:}"
  elif [[ "$reference" =~ ^[a-z0-9./_-]+@sha256:[0-9a-f]{64}$ ]]; then
    repository="${reference%@*}"
    digest="${reference#*@}"
  else
    printf 'ERROR: image references must use an explicit tag or a full lowercase sha256 digest.\n' >&2
    exit 1
  fi

  matches=0
  matched_target_family=''
  matched_platform=''
  matched_repository=''
  matched_registry=''
  matched_image_name=''
  matched_deployment_name=''
  while IFS=$'\t' read -r target_family platform allowlist_repository image_name deployment_name; do
    [[ -n "$target_family" && "$target_family" != \#* ]] || continue
    if [[ "$repository" == "$allowlist_repository" ]]; then
      matches=$((matches + 1))
      matched_target_family="$target_family"
      matched_platform="$platform"
      matched_repository="$allowlist_repository"
      matched_registry="${allowlist_repository%/"$image_name"}"
      matched_image_name="$image_name"
      matched_deployment_name="$deployment_name"
    fi
  done < "$allowlist"

  if (( matches != 1 )); then
    printf 'ERROR: image reference is not allowlisted.\n' >&2
    exit 1
  fi
  if [[ -n "$selected_target_family" && "$selected_target_family" != "$matched_target_family" ]]; then
    printf 'ERROR: image references must belong to one target family.\n' >&2
    exit 1
  fi

  # Each overlay image can only receive one version, even across repositories.
  target="$matched_platform/$matched_image_name"
  if [[ "|$seen_targets" == *"|$target|"* ]]; then
    printf 'ERROR: duplicate image target.\n' >&2
    exit 1
  fi
  seen_targets+="$target|"

  # '-' explicitly opts out of restart (e.g. an image used only by a CronJob).
  image_json="$(jq -cn \
    --arg platform "$matched_platform" \
    --arg registry "$matched_registry" \
    --arg repository "$matched_repository" \
    --arg image_name "$matched_image_name" \
    --arg deployment_name "$matched_deployment_name" \
    --arg tag "$tag" \
    --arg digest "$digest" \
    '{
      platform: $platform,
      registry: $registry,
      repository: $repository,
      image_name: $image_name,
      deployment_names: (if $deployment_name == "-" then []
        else $deployment_name | split(" ") | map(select(length > 0)) |
          if length > 0 then . else error("missing deployment mapping; use - for update-only images") end
        end)
    } + (if $digest != "" then {digest: $digest} else {tag: $tag} end)')"
  images_json="$(jq -c --argjson image "$image_json" '. + [$image]' <<< "$images_json")"
  selected_target_family="$matched_target_family"
done

platforms_json="$(jq -c '
  reduce .[] as $image
    ([]; if index($image.platform) == null then . + [$image.platform] else . end)
' <<< "$images_json")"
jq -n \
  --arg target_family "$selected_target_family" \
  --argjson platforms "$platforms_json" \
  --argjson images "$images_json" \
  '{
    target_family: $target_family,
    platforms: $platforms,
    images: $images
  }'
