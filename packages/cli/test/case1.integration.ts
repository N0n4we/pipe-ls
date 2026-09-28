import { spawnSync } from "node:child_process";
import {
  accessSync,
  constants,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { extractGithubWorkflow } from "@pipe-ls/hosts";
import { describe, expect, it } from "vitest";

interface PositiveCase {
  readonly id: string;
  readonly kind: "positive";
  readonly input: {
    readonly environment: string;
    readonly images: string;
    readonly distinct_id?: string;
  };
}
interface ParsedImage {
  readonly platform: string;
  readonly repository: string;
  readonly image_name: string;
  readonly deployment_names: readonly string[];
  readonly tag?: string;
  readonly digest?: string;
}
interface ParsedImages {
  readonly target_family: string;
  readonly platforms: readonly string[];
  readonly images: readonly ParsedImage[];
}
interface UpdateResult {
  readonly target_family: string;
  readonly kustomization_file_path: string;
  readonly platforms: readonly string[];
  readonly restart_targets: Readonly<
    Record<
      string,
      { readonly namespace: string; readonly deployments: readonly string[] }
    >
  >;
}

const fixture = fileURLToPath(
  new URL("../../../tests/cases/1/", import.meta.url),
);
const cases = (
  JSON.parse(readFileSync(join(fixture, "matrix.json"), "utf8")) as {
    readonly cases: readonly PositiveCase[];
  }
).cases.filter((item) => item.kind === "positive");

function toolPath(name: string): string {
  for (const directory of (process.env.PATH ?? "").split(delimiter)) {
    if (!directory) continue;
    const candidate = join(directory, name);
    try {
      accessSync(candidate, constants.X_OK);
      return realpathSync(candidate);
    } catch {
      // Continue through the developer's PATH; never fetch a binary.
    }
  }
  throw new Error(`Required local integration tool ${name} is unavailable`);
}

function runCaptured(
  executable: string,
  args: readonly string[],
  root: string,
  bin: string,
  input = "",
  extraEnv: Readonly<Record<string, string>> = {},
): { readonly stdout: string; readonly stderr: string } {
  const result = spawnSync(executable, [...args], {
    cwd: root,
    env: {
      PATH: bin,
      HOME: root,
      TMPDIR: root,
      LC_ALL: "C",
      ...extraEnv,
    },
    input,
    encoding: "utf8",
    timeout: 10_000,
    maxBuffer: 4 * 1024 * 1024,
  });
  if (result.error || result.status !== 0)
    throw new Error(
      `Controlled fixture command failed: ${args[0] ?? executable}: ${String(result.error ?? result.stderr).slice(0, 2000)}`,
    );
  return { stdout: result.stdout, stderr: result.stderr };
}

function run(
  executable: string,
  args: readonly string[],
  root: string,
  bin: string,
  input = "",
): string {
  return runCaptured(executable, args, root, bin, input).stdout;
}

describe("case 1 controlled integration inputs", () => {
  it("round-trips special characters through the real distinct-ID run body", () => {
    const scenario = cases.find((item) => item.id === "special-chars-env");
    if (!scenario?.input.distinct_id)
      throw new Error("Missing special-chars-env matrix input");
    const workflow = extractGithubWorkflow(
      readFileSync(join(fixture, ".github/workflows/cloud.yaml"), "utf8"),
    );
    const unit = workflow.runs.find((run) =>
      run.script.includes("jq -r '.' <<< \"$DISTINCT_ID\""),
    );
    if (!unit) throw new Error("Missing distinct-ID run body");
    const root = mkdtempSync(join(tmpdir(), "pipe-ls-case1-env-run-"));
    try {
      const bin = join(root, "bin");
      mkdirSync(bin);
      for (const name of ["bash", "jq"])
        symlinkSync(toolPath(name), join(bin, name));
      const result = runCaptured(
        `${bin}/bash`,
        ["-c", unit.script],
        root,
        bin,
        "",
        {
          DISTINCT_ID: JSON.stringify(scenario.input.distinct_id),
        },
      );
      expect(result.stdout).toBe("");
      expect(result.stderr).toBe(`${scenario.input.distinct_id}\n`);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("writes verified one-line GitHub outputs from the real setup run body", () => {
    const scenario = cases.find((item) => item.id === "tag-aws");
    if (!scenario) throw new Error("Missing tag-aws matrix input");
    const workflow = extractGithubWorkflow(
      readFileSync(join(fixture, ".github/workflows/cloud.yaml"), "utf8"),
    );
    const unit = workflow.runs.find((run) => run.stepId === "setup");
    if (!unit) throw new Error("Missing setup run body");
    const root = mkdtempSync(join(tmpdir(), "pipe-ls-case1-setup-run-"));
    try {
      const bin = join(root, "bin");
      mkdirSync(bin);
      for (const name of ["bash", "date", "dirname", "jq", "yq"])
        symlinkSync(toolPath(name), join(bin, name));
      for (const relative of [
        ".github/scripts/parse-cloud-images.sh",
        ".github/scripts/update-cloud-images.sh",
        ".github/scripts/cloud-image-allowlist.tsv",
      ]) {
        const target = join(root, relative);
        mkdirSync(dirname(target), { recursive: true });
        copyFileSync(join(fixture, relative), target);
      }
      const overlay = join(root, "resources/cloud/overlays/staging/aws");
      mkdirSync(overlay, { recursive: true });
      writeFileSync(
        join(overlay, "kustomization.yaml"),
        "namespace: synthetic-aws\nimages:\n  - name: cloud-admin-frontend\n    newName: old.example/repo\n    newTag: old\n",
      );
      const githubOutput = join(root, "GITHUB_OUTPUT");
      const githubEnv = join(root, "GITHUB_ENV");
      writeFileSync(githubOutput, "");
      writeFileSync(githubEnv, "");
      const result = runCaptured(
        `${bin}/bash`,
        ["-c", unit.script],
        root,
        bin,
        "",
        {
          IMAGES_INPUT: JSON.stringify(scenario.input.images),
          DEPLOY_ENVIRONMENT: JSON.stringify(scenario.input.environment),
          GITHUB_OUTPUT: githubOutput,
          GITHUB_ENV: githubEnv,
        },
      );
      expect(result.stdout).toBe("");
      expect(result.stderr).toBe("");
      const outputLines = readFileSync(githubOutput, "utf8")
        .trimEnd()
        .split("\n");
      expect(outputLines).toHaveLength(1);
      expect(outputLines[0]?.startsWith("restart_targets=")).toBe(true);
      const restartTargets = JSON.parse(
        outputLines[0]?.slice("restart_targets=".length) ?? "",
      ) as UpdateResult["restart_targets"];
      expect(restartTargets.aws?.namespace).toBe("synthetic-aws");
      expect(restartTargets.aws?.deployments.length).toBeGreaterThan(0);
      const envLines = readFileSync(githubEnv, "utf8").trimEnd().split("\n");
      expect(envLines).toHaveLength(3);
      const values = Object.fromEntries(
        envLines.map((line) => {
          const separator = line.indexOf("=");
          expect(separator).toBeGreaterThan(0);
          return [
            line.slice(0, separator),
            JSON.parse(line.slice(separator + 1)) as string,
          ];
        }),
      );
      expect(Object.keys(values).sort()).toEqual([
        "CLOUD_UPDATE_MESSAGE",
        "KUSTOMIZATION_FILE_PATH",
        "NEW_BRANCH_NAME",
      ]);
      expect(values.KUSTOMIZATION_FILE_PATH).toBe(
        "resources/cloud/overlays/staging",
      );
      expect(values.CLOUD_UPDATE_MESSAGE).toBe("chore: bump cloud in staging");
      expect(values.NEW_BRANCH_NAME).toMatch(
        /^bump-cloud-in-staging-\d{8}-\d{6}$/u,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);

  for (const scenario of cases) {
    it(scenario.id, () => {
      const root = mkdtempSync(join(tmpdir(), "pipe-ls-case1-runtime-"));
      try {
        const bin = join(root, "bin");
        mkdirSync(bin);
        for (const name of ["bash", "dirname", "jq", "yq"])
          symlinkSync(toolPath(name), join(bin, name));
        for (const relative of [
          ".github/scripts/parse-cloud-images.sh",
          ".github/scripts/update-cloud-images.sh",
          ".github/scripts/cloud-image-allowlist.tsv",
        ]) {
          const target = join(root, relative);
          mkdirSync(dirname(target), { recursive: true });
          copyFileSync(join(fixture, relative), target);
        }
        const parse = join(root, ".github/scripts/parse-cloud-images.sh");
        const update = join(root, ".github/scripts/update-cloud-images.sh");
        const parsed = JSON.parse(
          run(
            `${bin}/bash`,
            [parse],
            root,
            bin,
            `${JSON.stringify(scenario.input.images)}\n`,
          ),
        ) as ParsedImages;
        expect(parsed.images.length).toBeGreaterThan(0);
        expect(parsed.platforms).toEqual([
          ...new Set(parsed.images.map((image) => image.platform)),
        ]);
        const expectedVersion = scenario.id === "digest-aws" ? "digest" : "tag";
        for (const image of parsed.images) {
          expect(Object.hasOwn(image, expectedVersion)).toBe(true);
          expect(
            Object.hasOwn(image, expectedVersion === "tag" ? "digest" : "tag"),
          ).toBe(false);
        }

        for (const platform of parsed.platforms) {
          const directory = join(
            root,
            "resources",
            parsed.target_family,
            "overlays",
            scenario.input.environment,
            platform,
          );
          mkdirSync(directory, { recursive: true });
          const imageNames = [
            ...new Set(
              parsed.images
                .filter((image) => image.platform === platform)
                .map((image) => image.image_name),
            ),
          ];
          writeFileSync(
            join(directory, "kustomization.yaml"),
            `namespace: synthetic-${platform}\nimages:\n${imageNames
              .map(
                (name) =>
                  `  - name: ${name}\n    newName: old.example/repo\n    newTag: old`,
              )
              .join("\n")}\n`,
          );
        }
        const result = JSON.parse(
          run(
            `${bin}/bash`,
            [update],
            root,
            bin,
            `${JSON.stringify({ environment: scenario.input.environment, parsed_images: parsed })}\n`,
          ),
        ) as UpdateResult;
        expect(result.target_family).toBe(parsed.target_family);
        expect(result.platforms).toEqual(parsed.platforms);
        expect(result.kustomization_file_path).toBe(
          `resources/${parsed.target_family}/overlays/${scenario.input.environment}`,
        );
        const restarted = [
          ...new Set(
            parsed.images
              .filter((image) => image.deployment_names.length > 0)
              .map((image) => image.platform),
          ),
        ];
        expect(Object.keys(result.restart_targets).sort()).toEqual(
          restarted.sort(),
        );
        for (const platform of restarted) {
          const target = result.restart_targets[platform];
          expect(target?.namespace).toBe(`synthetic-${platform}`);
          expect(target?.deployments.length).toBeGreaterThan(0);
        }
        for (const image of parsed.images) {
          const path = join(
            root,
            result.kustomization_file_path,
            image.platform,
            "kustomization.yaml",
          );
          const document = JSON.parse(
            run(`${bin}/yq`, ["eval", "-o=json", ".", path], root, bin),
          ) as {
            readonly images: readonly Record<string, string>[];
          };
          const entry = document.images.find(
            (candidate) => candidate.name === image.image_name,
          );
          expect(entry?.newName).toBe(image.repository);
          if (image.digest) {
            expect(entry?.digest).toBe(image.digest);
            expect(entry?.newTag).toBeUndefined();
          } else {
            expect(entry?.newTag).toBe(image.tag);
            expect(entry?.digest).toBeUndefined();
          }
        }
        if (scenario.input.distinct_id !== undefined) {
          const output = run(
            `${bin}/jq`,
            ["-r", "."],
            root,
            bin,
            `${JSON.stringify(scenario.input.distinct_id)}\n`,
          );
          expect(output.slice(0, -1)).toBe(scenario.input.distinct_id);
        }
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }, 30_000);
  }

  it("updates a support-portal manifest and preserves an unchanged second run", () => {
    const root = mkdtempSync(join(tmpdir(), "pipe-ls-case1-portal-"));
    try {
      const bin = join(root, "bin");
      mkdirSync(bin);
      for (const name of ["bash", "dirname", "jq", "yq"])
        symlinkSync(toolPath(name), join(bin, name));
      for (const relative of [
        ".github/scripts/parse-cloud-images.sh",
        ".github/scripts/update-cloud-images.sh",
        ".github/scripts/cloud-image-allowlist.tsv",
      ]) {
        const target = join(root, relative);
        mkdirSync(dirname(target), { recursive: true });
        copyFileSync(join(fixture, relative), target);
      }
      const repository =
        "xxxxxxxxxxxx.dkr.ecr.us-west-2.amazonaws.com/support-portal";
      const parsed = JSON.parse(
        run(
          `${bin}/bash`,
          [join(root, ".github/scripts/parse-cloud-images.sh")],
          root,
          bin,
          `${JSON.stringify(`${repository}:dev`)}\n`,
        ),
      ) as ParsedImages;
      const overlay = join(root, "resources/cloud/overlays/staging/aws");
      mkdirSync(overlay, { recursive: true });
      writeFileSync(
        join(overlay, "kustomization.yaml"),
        "namespace: portal-ns\n",
      );
      const portal = join(overlay, "support-portal.yaml");
      writeFileSync(
        portal,
        "kind: Deployment\nmetadata:\n  name: support-portal\nspec:\n  template:\n    spec:\n      containers:\n        - name: support-portal\n          image: old.example/portal:old\n",
      );
      const input = `${JSON.stringify({ environment: "staging", parsed_images: parsed })}\n`;
      const update = join(root, ".github/scripts/update-cloud-images.sh");
      const first = JSON.parse(
        run(`${bin}/bash`, [update], root, bin, input),
      ) as UpdateResult;
      expect(first.restart_targets.aws?.namespace).toBe("portal-ns");
      const changed = readFileSync(portal, "utf8");
      expect(changed).toContain(`image: ${repository}:dev`);
      const second = JSON.parse(
        run(`${bin}/bash`, [update], root, bin, input),
      ) as UpdateResult;
      expect(second).toEqual(first);
      expect(readFileSync(portal, "utf8")).toBe(changed);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);
});
