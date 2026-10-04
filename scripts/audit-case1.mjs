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
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Always use the real caller AND callee. Synthetic local data is not a stub
// for unsupported workflow steps, downloaded programs, secrets or cloud APIs.
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
const pins = `# SYNTHETIC STATIC-ONLY VALUES: NEVER DOWNLOAD OR EXECUTE
HUAWEI_CLOUD_CLI_VERSION=0.0.0-synthetic
HUAWEI_CLOUD_CLI_URL=https://static-test.invalid/hcloud.tar.gz
HUAWEI_CLOUD_CLI_SHA256=${"0".repeat(64)}
`;
const sourceHashes = Object.fromEntries(
  paths.map((path) => [
    path,
    createHash("sha256")
      .update(readFileSync(join(fixture, path)))
      .digest("hex"),
  ]),
);
const manifestSha256 = createHash("sha256")
  .update(JSON.stringify({ sourceHashes, overlay, portal, pins }))
  .digest("hex");
const root = realpathSync(
  mkdtempSync(join(tmpdir(), "pipe-ls-real-case1-audit-")),
);

try {
  for (const path of paths) {
    const destination = join(root, path);
    mkdirSync(dirname(destination), { recursive: true });
    copyFileSync(join(fixture, path), destination);
  }
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
  process.stdout.write(
    `${JSON.stringify({ node: process.version, manifestSha256, sourceHashes, dependencies: "synthetic local data; real caller/callee; no workflow execution" })}\n`,
  );
  for (const withPins of [false, true]) {
    if (withPins) writeFileSync(join(root, ".github/tool-versions.env"), pins);
    const result = spawnSync(
      process.execPath,
      [
        join(project, "packages/cli/dist/bin.js"),
        "check",
        "--json",
        join(root, ".github/workflows/cloud.yaml"),
      ],
      {
        cwd: root,
        env: { HOME: root, TMPDIR: root, LC_ALL: "C" },
        encoding: "utf8",
        timeout: 30_000,
        maxBuffer: 16 * 1024 * 1024,
      },
    );
    if (result.error || ![0, 1].includes(result.status))
      throw new Error("Real case 1 audit produced no valid CLI result");
    const report = JSON.parse(result.stdout);
    if (
      report.schemaVersion !== 1 ||
      report.checkedUnits === 0 ||
      result.status !== (report.complete ? 0 : 1)
    )
      throw new Error("Real case 1 audit has an inconsistent CLI result");
    if (
      !withPins &&
      (report.complete ||
        !report.diagnostics.some(
          (issue) =>
            issue.code === "PIPE204" &&
            issue.message.includes("tool-versions.env"),
        ))
    )
      throw new Error(
        "Missing synthetic pins must remain a diagnosed dependency gap",
      );
    const audit = {
      withPins,
      cliExitCode: result.status,
      checkedUnits: report.checkedUnits,
      complete: report.complete,
      fileEffects: report.fileEffects.length,
      fileEffectsUnknown: report.fileEffectsUnknown,
      diagnosticCount: report.diagnostics.length,
      externalEffects: report.externalEffects,
      diagnostics: report.diagnostics.map((issue) => ({
        path: relative(root, fileURLToPath(issue.uri)),
        code: issue.code,
        status: issue.status,
        line: issue.range.start.line + 1,
        message: issue.message.replaceAll(root, "<fixture>"),
      })),
    };
    process.stdout.write(`${JSON.stringify(audit)}\n`);
    if (withPins && (!report.complete || report.diagnostics.length))
      process.exitCode = 1;
  }
} finally {
  rmSync(root, { recursive: true, force: true });
}
