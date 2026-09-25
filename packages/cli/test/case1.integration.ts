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

function run(
  executable: string,
  args: readonly string[],
  root: string,
  bin: string,
  input = "",
): string {
  const result = spawnSync(executable, [...args], {
    cwd: root,
    env: {
      PATH: bin,
      HOME: root,
      TMPDIR: root,
      LC_ALL: "C",
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
  return result.stdout;
}

describe("case 1 controlled integration inputs", () => {
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
