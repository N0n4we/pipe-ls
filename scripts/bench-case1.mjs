import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { cpus, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

const project = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const fixture = join(project, "tests/cases/1");
const paths = [
  ".github/scripts/parse-cloud-images.sh",
  ".github/scripts/update-cloud-images.sh",
  ".github/scripts/cloud-image-allowlist.tsv",
  ".github/workflows/cloud.yaml",
];
const overlay =
  "namespace: synthetic\nimages:\n  - name: frontend\n    newName: repo\n";
const portal =
  "kind: Deployment\nmetadata:\n  name: support-portal\nspec:\n  template:\n    spec:\n      containers:\n        - name: support-portal\n          image: repo:tag\n";
const stub = `on:
  workflow_call:
    inputs:
      platform: {type: string, required: true}
      namespace: {type: string, required: true}
      name: {type: string, required: true}
jobs:
  decode:
    runs-on: ubuntu-latest
    defaults:
      run: {shell: bash}
    steps:
      - env:
          PLATFORM_JSON: \${{ inputs.platform }}
          NAMESPACE_JSON: \${{ inputs.namespace }}
          NAME_JSON: \${{ inputs.name }}
        run: |
          # @pipe env PLATFORM_JSON: string
          # @pipe env NAMESPACE_JSON: string
          # @pipe env NAME_JSON: string
          set -e
          platform="$(jq -er '.' <<< "$PLATFORM_JSON")"
          namespace="$(jq -er '.' <<< "$NAMESPACE_JSON")"
          name="$(jq -er '.' <<< "$NAME_JSON")"
`;
const counts = { parse: 40, update: 40, workflow: 20 };
const manifestSha256 = createHash("sha256")
  .update(
    JSON.stringify({
      sourceHashes: paths.map((path) =>
        createHash("sha256")
          .update(readFileSync(join(fixture, path)))
          .digest("hex"),
      ),
      overlay,
      portal,
      stub,
      counts,
    }),
  )
  .digest("hex");

const root = mkdtempSync(join(tmpdir(), "pipe-ls-mixed-bench-"));
const copy = (source, target = source) => {
  const destination = join(root, target);
  mkdirSync(dirname(destination), { recursive: true });
  copyFileSync(join(fixture, source), destination);
  return destination;
};

try {
  for (const path of paths) copy(path);
  for (const family of ["cloud", "cloud-auth", "omp"])
    for (const environment of ["dev", "pre-dev", "test", "staging", "prod"])
      for (const platform of ["aws", "huaweicloud"]) {
        const directory = join(
          root,
          "resources",
          family,
          "overlays",
          environment,
          platform,
        );
        mkdirSync(directory, { recursive: true });
        writeFileSync(join(directory, "kustomization.yaml"), overlay);
        writeFileSync(join(directory, "support-portal.yaml"), portal);
      }
  writeFileSync(join(root, ".github/workflows/do-rollout-restart.yaml"), stub);

  const entries = [];
  for (let index = 0; index < counts.parse; index++)
    entries.push(copy(paths[0], `.github/scripts/parse-${index}.sh`));
  for (let index = 0; index < counts.update; index++)
    entries.push(copy(paths[1], `.github/scripts/update-${index}.sh`));
  for (let index = 0; index < counts.workflow; index++)
    entries.push(copy(paths[3], `.github/workflows/cloud-${index}.yaml`));

  process.stdout.write(
    `${JSON.stringify({
      node: process.version,
      model: cpus()[0]?.model,
      platform: process.platform,
      arch: process.arch,
      manifestSha256,
    })}\n`,
  );
  const bin = join(project, "packages/cli/dist/bin.js");
  for (let run = 1; run <= 3; run++) {
    const timed = process.platform === "darwin";
    const program = timed ? "/usr/bin/time" : process.execPath;
    const args = timed
      ? ["-l", process.execPath, bin, "check", "--json", ...entries]
      : [bin, "check", "--json", ...entries];
    const start = performance.now();
    const result = spawnSync(program, args, {
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
      timeout: 30_000,
    });
    const elapsedMs = Math.round(performance.now() - start);
    if (result.error || result.status !== 0)
      throw new Error(
        `Cold CLI run ${run} failed: ${result.error?.message ?? result.stderr}`,
      );
    const report = JSON.parse(result.stdout);
    if (
      !report.complete ||
      report.diagnostics.length ||
      report.checkedUnits < 100
    )
      throw new Error(`Cold CLI run ${run} did not fully check the fixture`);
    const maxRssBytes = timed
      ? Number(/(\d+) {2}maximum resident set size/u.exec(result.stderr)?.[1])
      : null;
    process.stdout.write(
      `${JSON.stringify({
        run,
        elapsedMs,
        checkedUnits: report.checkedUnits,
        diagnostics: report.diagnostics.length,
        fileEffects: report.fileEffects.length,
        maxRssBytes,
      })}\n`,
    );
  }
} finally {
  rmSync(root, { recursive: true, force: true });
}
