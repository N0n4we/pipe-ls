import {
  copyFileSync,
  existsSync,
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

const fixture = fileURLToPath(
  new URL("../../../tests/cases/1/", import.meta.url),
);
const paths = [
  ".github/scripts/parse-cloud-images.sh",
  ".github/scripts/update-cloud-images.sh",
  ".github/scripts/cloud-image-allowlist.tsv",
  ".github/workflows/cloud.yaml",
  ".github/workflows/do-rollout-restart.yaml",
];
interface MatrixCase {
  readonly id: string;
  readonly kind: "positive" | "negative" | "blocked";
  readonly entry: string;
  readonly snippet?: string;
  readonly missingDependency?: string;
  readonly mutation?: {
    readonly target: string;
    readonly search?: string;
    readonly replace?: string;
    readonly removeLineStarting?: string;
  };
  readonly expectedCodes?: readonly string[];
}
const matrix = JSON.parse(
  readFileSync(join(fixture, "matrix.json"), "utf8"),
) as { readonly cases: readonly MatrixCase[] };

async function withFullFixture(
  check: (root: string) => Promise<void>,
): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "pipe-ls-real-case1-matrix-"));
  try {
    for (const relative of paths) {
      const destination = join(root, relative);
      mkdirSync(dirname(destination), { recursive: true });
      copyFileSync(join(fixture, relative), destination);
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
          writeFileSync(
            join(directory, "kustomization.yaml"),
            "namespace: synthetic\nimages:\n  - name: frontend\n    newName: repo\n",
          );
          writeFileSync(
            join(directory, "support-portal.yaml"),
            "kind: Deployment\nmetadata:\n  name: support-portal\nspec:\n  template:\n    spec:\n      containers:\n        - name: support-portal\n          image: repo:tag\n",
          );
        }
    writeFileSync(
      join(root, ".github", "tool-versions.env"),
      `# SYNTHETIC STATIC-ONLY: NEVER DOWNLOAD OR EXECUTE\nHUAWEI_CLOUD_CLI_VERSION=0.0.0-synthetic\nHUAWEI_CLOUD_CLI_URL=https://static-test.invalid/hcloud.tar.gz\nHUAWEI_CLOUD_CLI_SHA256=${"0".repeat(64)}\n`,
    );
    await check(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe("case 1 full static matrix with real caller/callee, no Action or workflow stubs", () => {
  it("completes the real generic input/call graph backing all five controlled positive inputs", async () => {
    expect(
      matrix.cases.filter((item) => item.kind === "positive"),
    ).toHaveLength(5);
    await withFullFixture(async (root) => {
      const sourceBefore = paths.map((relative) =>
        readFileSync(join(root, relative), "utf8"),
      );
      const report = await checkPaths([
        join(root, ".github/workflows/cloud.yaml"),
      ]);
      expect(report.diagnostics).toEqual([]);
      expect(report.complete).toBe(true);
      expect(report.checkedUnits).toBe(27);
      expect(report.unverifiedDependencies).toEqual([]);
      expect(report.externalEffects).toEqual(
        expect.arrayContaining([
          "github onepassword configure",
          "github onepassword load-secrets",
          "github aws credentials",
          "github aws credentials cleanup",
          "aws sts GetCallerIdentity",
          "aws eks list-clusters",
          "aws eks update-kubeconfig",
          "curl download",
          "sha256sum check",
          "tar extract",
          "hcloud configure set",
          "hcloud cce ListClusters",
          "hcloud cce CreateKubernetesClusterCert",
          "github retry bash",
          "kubectl rollout restart",
          "kubectl rollout status",
        ]),
      );
      expect(report.fileEffects).toHaveLength(61);
      expect(report.fileEffectsUnknown).toBe(true);
      expect(
        paths.map((relative) => readFileSync(join(root, relative), "utf8")),
      ).toEqual(sourceBefore);
      expect(existsSync(join(root, "resources/cloud/base"))).toBe(false);
    });
  });

  for (const item of matrix.cases.filter((item) => item.kind !== "positive")) {
    it(`rejects ${item.id} with all unrelated dependencies present`, async () => {
      await withFullFixture(async (root) => {
        const entry = join(root, item.entry);
        // Mutation/dependency cases start from a fully checked real chain.
        if (!item.snippet)
          expect((await checkPaths([entry])).complete).toBe(true);
        if (item.mutation) {
          const target = join(root, item.mutation.target);
          const source = readFileSync(target, "utf8");
          if (item.mutation.removeLineStarting) {
            const prefix = item.mutation.removeLineStarting;
            expect(
              source.split("\n").some((line) => line.startsWith(prefix)),
            ).toBe(true);
            writeFileSync(
              target,
              source
                .split(/(?<=\n)/u)
                .filter((line) => !line.startsWith(prefix))
                .join(""),
            );
          } else {
            if (!item.mutation.search || item.mutation.replace === undefined)
              throw new Error("Matrix mutation is incomplete");
            expect(source).toContain(item.mutation.search);
            writeFileSync(
              target,
              source.replace(item.mutation.search, item.mutation.replace),
            );
          }
        } else if (item.snippet) {
          writeFileSync(
            entry,
            `${item.entry.endsWith(".sh") ? "#!/usr/bin/env bash\n" : ""}${item.snippet}`,
          );
        } else if (item.missingDependency) {
          expect(existsSync(join(root, item.missingDependency))).toBe(true);
          rmSync(join(root, item.missingDependency));
        } else throw new Error("Matrix case has no executable mutation");
        const report = await checkPaths([entry]);
        expect(report.complete).toBe(false);
        for (const code of item.expectedCodes ?? [])
          expect(report.diagnostics.some((issue) => issue.code === code)).toBe(
            true,
          );
      });
    });
  }
});
