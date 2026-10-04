import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { cpus, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath, pathToFileURL } from "node:url";

const project = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const fixture = join(project, "tests/cases/1");
const paths = [
  ".github/scripts/parse-cloud-images.sh",
  ".github/scripts/update-cloud-images.sh",
  ".github/scripts/cloud-image-allowlist.tsv",
  ".github/workflows/cloud.yaml",
  ".github/workflows/do-rollout-restart.yaml",
];
const overlay =
  "namespace: synthetic\nimages:\n  - name: frontend\n    newName: repo\n";
const portal =
  "kind: Deployment\nmetadata:\n  name: support-portal\nspec:\n  template:\n    spec:\n      containers:\n        - name: support-portal\n          image: repo:tag\n";
// Metadata only: the real workflow is checked, never run. No action, command
// or workflow stub replaces the caller/callee. These pins are not a download.
const pins = `# SYNTHETIC STATIC-ONLY VALUES: NEVER DOWNLOAD OR EXECUTE
HUAWEI_CLOUD_CLI_VERSION=0.0.0-synthetic
HUAWEI_CLOUD_CLI_URL=https://static-test.invalid/hcloud.tar.gz
HUAWEI_CLOUD_CLI_SHA256=${"0".repeat(64)}
`;
const counts = { parse: 40, update: 40, workflow: 20 };
const sourceHashes = Object.fromEntries(
  paths.map((path) => [
    path,
    createHash("sha256")
      .update(readFileSync(join(fixture, path)))
      .digest("hex"),
  ]),
);
// Keep the actual case 1 parser's semantic work, with comment padding to
// 100 KiB. This is a bounded sample, not a claim about all 100 KiB programs.
const parser = readFileSync(join(fixture, paths[0]), "utf8");
const warmSource = `${parser}\n#${" ".repeat(100 * 1024 - Buffer.byteLength(parser) - 3)}\n`;
const warm = {
  bytes: Buffer.byteLength(warmSource),
  sha256: createHash("sha256").update(warmSource).digest("hex"),
  warmupRuns: 5,
  measuredRuns: 20,
};
const manifestSha256 = createHash("sha256")
  .update(JSON.stringify({ sourceHashes, overlay, portal, pins, counts, warm }))
  .digest("hex");

const root = realpathSync(mkdtempSync(join(tmpdir(), "pipe-ls-mixed-bench-")));
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
  writeFileSync(join(root, ".github/tool-versions.env"), pins);

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
      sourceHashes,
      counts,
      warm,
      dependencies:
        "synthetic local data; real caller/callee; no workflow execution",
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
      cwd: root,
      env: { HOME: root, TMPDIR: root, LC_ALL: "C" },
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
      report.checkedUnits < 100 ||
      !report.externalEffects.includes("github aws credentials") ||
      !report.externalEffects.includes("hcloud cce ListClusters") ||
      !report.externalEffects.includes("github retry bash")
    )
      throw new Error(`Cold CLI run ${run} did not fully check the fixture`);
    const maxRssBytes = timed
      ? Number(/(\d+) {2}maximum resident set size/u.exec(result.stderr)?.[1])
      : null;
    if (timed && (!Number.isFinite(maxRssBytes) || maxRssBytes <= 0))
      throw new Error("Cold CLI RSS measurement is missing");
    process.stdout.write(
      `${JSON.stringify({
        run,
        elapsedMs,
        checkedUnits: report.checkedUnits,
        diagnostics: report.diagnostics.length,
        fileEffects: report.fileEffects.length,
        fileEffectsUnknown: report.fileEffectsUnknown,
        maxRssBytes,
        targetMs: 5000,
        withinTarget: elapsedMs < 5000,
      })}\n`,
    );
    if (elapsedMs >= 5000) process.exitCode = 1;
  }

  const warmPath = join(root, ".github/scripts/parse-warm.sh");
  writeFileSync(warmPath, warmSource);
  const { checkPaths } = await import(
    pathToFileURL(join(project, "packages/cli/dist/index.js")).href
  );
  const samples = [];
  for (let run = 0; run < warm.warmupRuns + warm.measuredRuns; run++) {
    const start = performance.now();
    const report = await checkPaths([warmPath]);
    const elapsedMs = performance.now() - start;
    if (
      !report.complete ||
      report.diagnostics.length ||
      report.checkedUnits !== 1
    )
      throw new Error("Warm document check did not fully check the fixture");
    if (run >= warm.warmupRuns) samples.push(elapsedMs);
  }
  const sorted = [...samples].sort((a, b) => a - b);
  const p95Ms = sorted[Math.ceil(0.95 * sorted.length) - 1];
  process.stdout.write(
    `${JSON.stringify({
      warmDocument: warm,
      samplesMs: samples.map((value) => Number(value.toFixed(2))),
      p95Ms: Number(p95Ms.toFixed(2)),
      parentMaxRssBytes: process.resourceUsage().maxRSS * 1024,
      targetMs: 200,
      withinTarget: p95Ms < 200,
    })}\n`,
  );
  if (p95Ms >= 200) process.exitCode = 1;
} finally {
  rmSync(root, { recursive: true, force: true });
}
