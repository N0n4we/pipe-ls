import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { checkPaths } from "../src/index.js";

interface Case {
  readonly id: string;
  readonly entry: string;
  readonly snippet?: string;
  readonly mutation?: {
    readonly target: string;
    readonly search?: string;
    readonly replace?: string;
    readonly removeLineStarting?: string;
  };
  readonly expectedCodes?: readonly string[];
}
const fixture = fileURLToPath(
  new URL("../../../tests/cases/1/", import.meta.url),
);
const matrix = JSON.parse(
  readFileSync(join(fixture, "matrix.json"), "utf8"),
) as { readonly cases: readonly Case[] };
const byId = (id: string): Case => {
  const item = matrix.cases.find((candidate) => candidate.id === id);
  if (!item) throw new Error(`Missing case 1 oracle ${id}`);
  return item;
};

describe("case 1 executable diagnostic subset", () => {
  it("keeps every matrix scenario attached to an executable oracle", () => {
    expect(matrix.cases.map((item) => item.id).sort()).toEqual(
      [
        "tag-aws",
        "digest-aws",
        "dual-platform",
        "update-only-empty-restart",
        "special-chars-env",
        "position-argument",
        "bare-platform-env",
        "bare-script-stdin",
        "double-encoded-nested-object",
        "missing-required-field",
        "consume-undeclared-stdout",
        "missing-job-output-map",
        "conditional-step-output",
        "missing-required-env",
        "missing-reusable-secret",
        "consume-ci-without-workflow-output",
        "jq-raw-stdout-string",
        "jq-multiple-stdout-values",
        "stdin-read-after-eof",
        "missing-overlays",
        "missing-reusable-workflow",
        "unsupported-source-effect",
        "unknown-business-command",
        "dynamic-run-interpolation",
      ].sort(),
    );
  });

  it("analyzes the allowlist parser but keeps missing overlays and the real reusable workflow blocked", async () => {
    const parse = await checkPaths([
      join(fixture, ".github/scripts/parse-cloud-images.sh"),
    ]);
    expect(parse.complete).toBe(true);
    expect(parse.diagnostics).toEqual([]);

    const update = await checkPaths([
      join(fixture, ".github/scripts/update-cloud-images.sh"),
    ]);
    expect(update.complete).toBe(false);
    expect(update.diagnostics.length).toBeGreaterThan(0);
    expect(update.diagnostics.every((issue) => issue.code === "PIPE204")).toBe(
      true,
    );
    for (const code of byId("missing-overlays").expectedCodes ?? [])
      expect(update.diagnostics.map((issue) => issue.code)).toContain(code);

    const workflow = await checkPaths([
      join(fixture, ".github/workflows/cloud.yaml"),
    ]);
    const called = workflow.diagnostics.filter((issue) =>
      issue.message.includes("do-rollout-restart.yaml"),
    );
    expect(called.map((issue) => issue.code)).toContain("PIPE202");
    expect(called.map((issue) => issue.code)).not.toContain("PIPE204");
    const callee = workflow.diagnostics.filter((issue) =>
      issue.uri.endsWith("/do-rollout-restart.yaml"),
    );
    expect(
      callee.some(
        (issue) =>
          issue.code === "PIPE204" &&
          issue.message.includes("tool-versions.env"),
      ),
    ).toBe(true);
    expect(
      callee.some(
        (issue) =>
          issue.code === "PIPE201" &&
          issue.message === "Command sha256sum has no contract",
      ),
    ).toBe(true);
    expect(
      callee.some(
        (issue) =>
          issue.code === "PIPE202" &&
          issue.message.includes("HUAWEI_CLOUD_CLI_URL"),
      ),
    ).toBe(true);
    expect(callee.map((issue) => issue.code)).not.toContain("PIPE101");
    const retryLine = readFileSync(
      join(fixture, ".github/workflows/do-rollout-restart.yaml"),
      "utf8",
    )
      .split("\n")
      .findIndex((line) =>
        line.includes("clusters=$(hcloud cce ListClusters)"),
      );
    expect(retryLine).toBeGreaterThan(0);
    expect(
      callee.some(
        (issue) =>
          issue.code === "PIPE201" && issue.range.start.line === retryLine,
      ),
    ).toBe(true);
  });

  it("keeps a missing local reusable workflow as a blocking matrix case", async () => {
    const scenario = byId("missing-reusable-workflow");
    const mutation = scenario.mutation;
    if (!mutation?.search || mutation.replace === undefined)
      throw new Error("Missing reusable workflow mutation is incomplete");
    const root = mkdtempSync(join(tmpdir(), "pipe-ls-missing-reusable-"));
    try {
      for (const relative of [
        scenario.entry,
        ".github/workflows/do-rollout-restart.yaml",
      ]) {
        const target = join(root, relative);
        mkdirSync(dirname(target), { recursive: true });
        copyFileSync(join(fixture, relative), target);
      }
      const entry = join(root, scenario.entry);
      const original = readFileSync(entry, "utf8");
      expect(original.split(mutation.search)).toHaveLength(2);
      writeFileSync(entry, original.replace(mutation.search, mutation.replace));
      const report = await checkPaths([entry]);
      for (const code of scenario.expectedCodes ?? [])
        expect(
          report.diagnostics
            .filter((issue) =>
              issue.message.includes("missing-rollout-restart.yaml"),
            )
            .map((issue) => issue.code),
        ).toContain(code);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("analyzes both update loops with synthetic local overlays and rejects an unverified namespace map", async () => {
    const root = mkdtempSync(join(tmpdir(), "pipe-ls-case1-overlays-"));
    try {
      const script = join(root, ".github/scripts/update-cloud-images.sh");
      mkdirSync(dirname(script), { recursive: true });
      copyFileSync(
        join(fixture, ".github/scripts/update-cloud-images.sh"),
        script,
      );
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
            writeFileSync(
              join(directory, "kustomization.yaml"),
              "namespace: synthetic\nimages:\n  - name: frontend\n    newName: repo\n",
            );
            writeFileSync(
              join(directory, "support-portal.yaml"),
              "kind: Deployment\nmetadata:\n  name: support-portal\nspec:\n  template:\n    spec:\n      containers:\n        - name: support-portal\n          image: repo:tag\n",
            );
          }
      const report = await checkPaths([script]);
      expect(report.complete).toBe(true);
      expect(report.diagnostics).toEqual([]);
      expect(report.fileEffects).toHaveLength(60);
      for (const relative of [
        ".github/scripts/parse-cloud-images.sh",
        ".github/scripts/cloud-image-allowlist.tsv",
        ".github/workflows/cloud.yaml",
      ]) {
        const target = join(root, relative);
        mkdirSync(dirname(target), { recursive: true });
        copyFileSync(join(fixture, relative), target);
      }
      const workflow = await checkPaths([
        join(root, ".github/workflows/cloud.yaml"),
      ]);
      expect(workflow.complete).toBe(false);
      expect(
        workflow.diagnostics.some((issue) =>
          issue.message.includes(
            "Job output update.restart_targets has no verified producing step",
          ),
        ),
      ).toBe(false);
      expect(
        workflow.diagnostics.some((issue) =>
          issue.message.includes(
            "GitHub env KUSTOMIZATION_FILE_PATH has no statically proven injection",
          ),
        ),
      ).toBe(false);
      expect(
        workflow.diagnostics.some((issue) =>
          issue.message.includes(
            "GitHub env NEW_BRANCH_NAME has no statically proven injection",
          ),
        ),
      ).toBe(false);
      expect(
        workflow.diagnostics.some(
          (issue) =>
            issue.code === "PIPE204" &&
            issue.message.includes("do-rollout-restart.yaml"),
        ),
      ).toBe(true);
      writeFileSync(
        join(root, ".github/workflows/do-rollout-restart.yaml"),
        `on:
  workflow_call:
    inputs:
      platform:
        type: string
        required: true
      namespace:
        type: string
        required: true
      name:
        type: string
        required: true
jobs:
  decode:
    runs-on: ubuntu-latest
    defaults:
      run:
        shell: bash
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
`,
      );
      const withStub = await checkPaths([
        join(root, ".github/workflows/cloud.yaml"),
      ]);
      expect(withStub.complete).toBe(true);
      expect(withStub.diagnostics).toEqual([]);
      expect(withStub.fileEffects).toHaveLength(60);
      expect(withStub.externalEffects).toContain("git push origin");
      expect(withStub.externalEffects).toContain("gh pr create");
      expect(
        withStub.diagnostics.some((issue) =>
          issue.message.includes(
            "Reusable workflow input namespace expression",
          ),
        ),
      ).toBe(false);
      expect(
        withStub.diagnostics.some((issue) =>
          issue.message.includes("Reusable workflow input name expression"),
        ),
      ).toBe(false);
      expect(
        withStub.diagnostics.some(
          (issue) =>
            issue.code === "PIPE204" &&
            issue.message.includes("do-rollout-restart.yaml"),
        ),
      ).toBe(false);
      copyFileSync(
        join(fixture, ".github/workflows/do-rollout-restart.yaml"),
        join(root, ".github/workflows/do-rollout-restart.yaml"),
      );
      const withRealCallee = await checkPaths([
        join(root, ".github/workflows/cloud.yaml"),
      ]);
      expect(withRealCallee.complete).toBe(false);
      expect(withRealCallee.checkedUnits).toBeGreaterThan(
        withStub.checkedUnits,
      );
      const calleeIssues = withRealCallee.diagnostics.filter((issue) =>
        issue.uri.endsWith("/do-rollout-restart.yaml"),
      );
      expect(calleeIssues.length).toBeGreaterThan(0);
      expect(
        calleeIssues.some((issue) =>
          issue.message.includes("Command aws has no contract"),
        ),
      ).toBe(true);
      expect(
        calleeIssues.some(
          (issue) =>
            issue.code === "PIPE204" &&
            issue.message.includes("tool-versions.env"),
        ),
      ).toBe(true);
      expect(
        calleeIssues.some(
          (issue) =>
            issue.code === "PIPE101" && issue.message.includes("RESTART_"),
        ),
      ).toBe(false);
      expect(
        calleeIssues.some((issue) =>
          issue.message.includes("jq -e exit status may be nonzero"),
        ),
      ).toBe(false);
      const original = readFileSync(script, "utf8");
      expect(original).toContain("'.[$platform] = $namespace'");
      writeFileSync(
        script,
        original.replace("'.[$platform] = $namespace'", "'.aws = $namespace'"),
      );
      const mutated = await checkPaths([script]);
      expect(mutated.complete).toBe(false);
      expect(
        mutated.diagnostics.some((issue) => issue.code === "PIPE102"),
      ).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects consuming cloud.yaml as a reusable workflow with no outputs", async () => {
    const item = byId("consume-ci-without-workflow-output");
    const root = mkdtempSync(join(tmpdir(), "pipe-ls-case1-reusable-"));
    try {
      const called = join(root, item.entry);
      mkdirSync(dirname(called), { recursive: true });
      copyFileSync(join(fixture, item.entry), called);
      const caller = join(dirname(called), "caller.yml");
      writeFileSync(caller, item.snippet ?? "");
      const report = await checkPaths([caller]);
      for (const code of item.expectedCodes ?? [])
        expect(
          report.diagnostics.map((diagnostic) => diagnostic.code),
        ).toContain(code);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects a case 1 restart call that omits the callee's required secret", async () => {
    const item = byId("missing-reusable-secret");
    const mutation = item.mutation;
    if (!mutation?.search || mutation.replace === undefined)
      throw new Error("Missing reusable secret mutation is incomplete");
    const root = mkdtempSync(join(tmpdir(), "pipe-ls-case1-secret-"));
    try {
      for (const relative of [
        ".github/workflows/cloud.yaml",
        ".github/workflows/do-rollout-restart.yaml",
        ".github/scripts/parse-cloud-images.sh",
        ".github/scripts/update-cloud-images.sh",
      ]) {
        const target = join(root, relative);
        mkdirSync(dirname(target), { recursive: true });
        copyFileSync(join(fixture, relative), target);
      }
      const entry = join(root, item.entry);
      const original = readFileSync(entry, "utf8");
      expect(original.split(mutation.search)).toHaveLength(2);
      const before = await checkPaths([entry]);
      expect(
        before.diagnostics.some((issue) =>
          issue.message.includes(
            "requires secret CLOUD_ONE_PASSWORD_SERVICE_ACCOUNT_TOKEN",
          ),
        ),
      ).toBe(false);
      writeFileSync(entry, original.replace(mutation.search, mutation.replace));
      const after = await checkPaths([entry]);
      expect(
        after.diagnostics.some(
          (issue) =>
            issue.code === "PIPE104" &&
            issue.message.includes(
              "requires secret CLOUD_ONE_PASSWORD_SERVICE_ACCOUNT_TOKEN",
            ),
        ),
      ).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  for (const id of [
    "jq-raw-stdout-string",
    "jq-multiple-stdout-values",
    "stdin-read-after-eof",
    "unsupported-source-effect",
    "unknown-business-command",
    "dynamic-run-interpolation",
  ]) {
    it(`checks ${id} against its matrix oracle`, async () => {
      const item = byId(id);
      const root = mkdtempSync(join(tmpdir(), "pipe-ls-case1-snippet-"));
      try {
        const path = join(root, item.entry);
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(
          path,
          item.entry.endsWith(".sh")
            ? `#!/usr/bin/env bash\n${item.snippet ?? ""}`
            : (item.snippet ?? ""),
        );
        const report = await checkPaths([path]);
        expect(report.complete).toBe(false);
        for (const code of item.expectedCodes ?? [])
          expect(
            report.diagnostics.map((diagnostic) => diagnostic.code),
          ).toContain(code);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  }

  for (const id of [
    "bare-platform-env",
    "bare-script-stdin",
    "position-argument",
    "double-encoded-nested-object",
    "missing-required-field",
    "consume-undeclared-stdout",
    "missing-job-output-map",
    "conditional-step-output",
    "missing-required-env",
  ]) {
    it(`checks ${id} mutation in the original workflow`, async () => {
      const item = byId(id);
      const mutation = item.mutation;
      if (!mutation) throw new Error(`Missing mutation for ${id}`);
      const root = mkdtempSync(join(tmpdir(), "pipe-ls-case1-mutation-"));
      try {
        for (const relative of [
          ".github/workflows/cloud.yaml",
          ".github/scripts/parse-cloud-images.sh",
          ".github/scripts/update-cloud-images.sh",
        ]) {
          const path = join(root, relative);
          mkdirSync(dirname(path), { recursive: true });
          copyFileSync(join(fixture, relative), path);
        }
        const target = join(root, mutation.target);
        const source = readFileSync(target, "utf8");
        if (mutation.search) expect(source).toContain(mutation.search);
        if (mutation.removeLineStarting)
          expect(
            source
              .split(/\n/u)
              .some((line) =>
                line.startsWith(mutation.removeLineStarting ?? ""),
              ),
          ).toBe(true);
        const original = await checkPaths([join(root, item.entry)]);
        const changedSource = mutation.removeLineStarting
          ? source
              .split(/(?<=\n)/u)
              .filter(
                (line) => !line.startsWith(mutation.removeLineStarting ?? ""),
              )
              .join("")
          : source.replace(mutation.search ?? "", mutation.replace ?? "");
        writeFileSync(target, changedSource);
        const changed = await checkPaths([join(root, item.entry)]);
        for (const code of item.expectedCodes ?? []) {
          expect(
            original.diagnostics.some((diagnostic) => diagnostic.code === code),
          ).toBe(false);
          expect(
            changed.diagnostics.some((diagnostic) => diagnostic.code === code),
          ).toBe(true);
        }
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  }
});
