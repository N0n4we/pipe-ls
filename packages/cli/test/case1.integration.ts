import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  accessSync,
  constants,
  copyFileSync,
  existsSync,
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
import jmespath from "jmespath";
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
  it("syntax-checks both real scripts and all caller/callee Bash bodies without executing commands", () => {
    const workflows = ["cloud.yaml", "do-rollout-restart.yaml"].map((name) =>
      extractGithubWorkflow(
        readFileSync(join(fixture, ".github/workflows", name), "utf8"),
      ),
    );
    const bodies = workflows.map((workflow) => [
      ...workflow.runs,
      ...workflow.opaqueCommands,
    ]);
    expect(bodies.map((units) => units.length)).toEqual([5, 8]);
    const scripts = ["parse-cloud-images.sh", "update-cloud-images.sh"].map(
      (name) => readFileSync(join(fixture, ".github/scripts", name), "utf8"),
    );
    for (const body of [
      ...scripts,
      ...bodies.flat().map((unit) => unit.script),
    ]) {
      const result = spawnSync(
        toolPath("bash"),
        ["--noprofile", "--norc", "-n"],
        {
          input: body,
          env: { BASH_ENV: "", ENV: "", LC_ALL: "C" },
          encoding: "utf8",
          timeout: 1000,
        },
      );
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(0);
      expect(result.stdout).toBe("");
      expect(result.stderr).toBe("");
    }
  });

  it("validates only the reviewed real AWS credential guard on synthetic inputs, never running an Action or AWS", () => {
    const workflow = extractGithubWorkflow(
      readFileSync(
        join(fixture, ".github/workflows/do-rollout-restart.yaml"),
        "utf8",
      ),
    );
    const body = workflow.runs.find(
      (unit) => unit.stepId === "aws_credentials",
    )?.script;
    const reviewed = String.raw`# @pipe env ACCESS_KEY_JSON: string | null
# @pipe env SECRET_KEY_JSON: string | null
set -euo pipefail
access_key="$(jq -er 'select(type == "string" and test("[!-~]") and index("\n") == null and index("\r") == null and index("\u0000") == null)' <<< "$ACCESS_KEY_JSON")"
secret_key="$(jq -er 'select(type == "string" and test("[!-~]") and index("\n") == null and index("\r") == null and index("\u0000") == null)' <<< "$SECRET_KEY_JSON")"
printf 'ACCESS_KEY_ID=%s\n' "$access_key" >> "$GITHUB_OUTPUT"
printf 'SECRET_ACCESS_KEY=%s\n' "$secret_key" >> "$GITHUB_OUTPUT"
`;
    if (body !== reviewed)
      throw new Error(
        "AWS credential validation fixture changed; do not execute an unreviewed body",
      );
    const root = mkdtempSync(join(tmpdir(), "pipe-ls-aws-guard-only-"));
    try {
      const bin = join(root, "bin");
      mkdirSync(bin);
      for (const tool of ["bash", "jq"])
        symlinkSync(toolPath(tool), join(bin, tool));
      const output = join(root, "output.txt");
      const script = join(root, "guard-only.sh");
      writeFileSync(script, body);
      for (const [key, secret, valid] of [
        ["SYNTHETIC_KEY", "SYNTHETIC_SECRET/+==", true],
        [null, "synthetic", false],
        ["", "synthetic", false],
        [" \t\uFEFF", "synthetic", false],
        ["key", null, false],
        ["key", "", false],
        ["key", " \t\uFEFF", false],
        ["key\nINJECT=bad", "secret", false],
        ["key", "secret\r", false],
        ["key", "secret\0", false],
        [1, "secret", false],
      ] as const) {
        writeFileSync(output, "");
        const result = spawnSync(join(bin, "bash"), [script], {
          cwd: root,
          env: {
            PATH: bin,
            HOME: root,
            TMPDIR: root,
            LC_ALL: "C",
            BASH_ENV: "",
            GITHUB_OUTPUT: output,
            ACCESS_KEY_JSON: JSON.stringify(key),
            SECRET_KEY_JSON: JSON.stringify(secret),
          },
          encoding: "utf8",
          timeout: 5000,
        });
        expect(result.error).toBeUndefined();
        expect(result.status === 0).toBe(valid);
        expect(result.stdout).toBe("");
        expect(readFileSync(output, "utf8")).toBe(
          valid ? `ACCESS_KEY_ID=${key}\nSECRET_ACCESS_KEY=${secret}\n` : "",
        );
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("checks the real Huawei projection and unique-cluster guard against synthetic API data without running hcloud", () => {
    const workflow = extractGithubWorkflow(
      readFileSync(
        join(fixture, ".github/workflows/do-rollout-restart.yaml"),
        "utf8",
      ),
    );
    const retry = workflow.opaqueCommands.find((unit) =>
      unit.script.includes("hcloud cce ListClusters/v3"),
    );
    if (!retry) throw new Error("Missing real Huawei retry body");
    const query = /--cli-query='([^']+)'/u.exec(retry.script)?.[1];
    const filter =
      /cluster_id=\$\(printf '%s\\n' "\$clusters" \| jq -er '([\s\S]*?)'\)/u.exec(
        retry.script,
      )?.[1];
    // Fail closed if the reviewed pure projection/filter changes. No API,
    // download, install, configure, filesystem body or workflow is executed.
    expect(query).toBe("{items: items[*].{uid: metadata.uid}}");
    expect(
      filter
        ?.trim()
        .split("\n")
        .map((line) => line.trim())
        .join("\n"),
    ).toBe(
      `(.items // []) as $items |\nif ($items | type) == "array" and ($items | length) == 1 then\n$items[0].uid | select(type == "string" and length > 0)\nelse error("expected exactly one CCE cluster") end`,
    );
    if (!query || !filter) throw new Error("Missing reviewed query/filter");
    const root = mkdtempSync(join(tmpdir(), "pipe-ls-huawei-jq-only-"));
    try {
      const bin = join(root, "bin");
      mkdirSync(bin);
      symlinkSync(toolPath("jq"), join(bin, "jq"));
      for (const { api, expected } of [
        {
          api: {
            kind: "Cluster",
            extra: "not a closed response",
            items: [
              {
                metadata: { uid: "synthetic-中文-id", name: "ignored" },
                spec: { extra: true },
              },
            ],
          },
          expected: "synthetic-中文-id\n",
        },
        { api: { items: [] }, expected: null },
        { api: {}, expected: null },
        { api: { items: null }, expected: null },
        { api: { items: [{ metadata: {} }] }, expected: null },
        { api: { items: [{ metadata: null }] }, expected: null },
        { api: { items: [{ metadata: { uid: null } }] }, expected: null },
        { api: { items: [{ metadata: { uid: "" } }] }, expected: null },
        { api: { items: [{ metadata: { uid: 123 } }] }, expected: null },
        {
          api: {
            items: [{ metadata: { uid: "one" } }, { metadata: { uid: "two" } }],
          },
          expected: null,
        },
        {
          api: { items: [{ metadata: { uid: "one" } }, { metadata: {} }] },
          expected: null,
        },
        {
          api: { items: [{ metadata: {} }, { metadata: { uid: "one" } }] },
          expected: null,
        },
      ]) {
        const projected: unknown = jmespath.search(api, query);
        // Unlike items[*].metadata.uid, a per-item hash preserves null UID
        // entries: two clusters cannot accidentally become a unique cluster.
        if (Array.isArray(api.items))
          expect((projected as { items: unknown[] }).items).toHaveLength(
            api.items.length,
          );
        const result = spawnSync(join(bin, "jq"), ["-er", filter], {
          cwd: root,
          env: { PATH: bin, HOME: root },
          input: JSON.stringify(projected),
          encoding: "utf8",
          timeout: 10_000,
        });
        expect(result.error).toBeUndefined();
        if (expected === null)
          expect(result.status, JSON.stringify(api)).not.toBe(0);
        else {
          expect(result.status).toBe(0);
          expect(result.stdout).toBe(expected);
          expect(result.stderr).toBe("");
        }
      }
      // Lock the regression that makes the simpler UID projection unsafe.
      expect(
        jmespath.search(
          { items: [{ metadata: { uid: "one" } }, { metadata: {} }] },
          "items[*].metadata.uid",
        ),
      ).toEqual(["one"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("checks only real retry filesystem staging and cleanup with synthetic bytes, never hcloud", () => {
    const workflow = extractGithubWorkflow(
      readFileSync(
        join(fixture, ".github/workflows/do-rollout-restart.yaml"),
        "utf8",
      ),
    );
    const retry = workflow.opaqueCommands.find((unit) =>
      unit.script.includes("hcloud cce CreateKubernetesClusterCert"),
    );
    if (!retry) throw new Error("Missing real retry body");
    const lines = retry.script.trimEnd().split("\n");
    const one = (reviewed: string): string => {
      const selected = lines.filter((line) => line.trim() === reviewed);
      if (selected.length !== 1)
        throw new Error("Real filesystem fixture changed");
      return selected[0] as string;
    };
    const prefix = [
      one("set -euo pipefail"),
      one('mkdir -p -- "$HOME/.kube"'),
      one('config_file="$(mktemp -- "$HOME/.kube/config.XXXXXX")"'),
      one(`trap 'rm -f -- "$config_file"' EXIT`),
    ];
    const suffix = [
      one('test -s "$config_file"'),
      one('mv -f -- "$config_file" "$HOME/.kube/config"'),
    ];
    const root = mkdtempSync(join(tmpdir(), "pipe-ls-file-staging-only-"));
    try {
      const bin = join(root, "bin");
      mkdirSync(bin);
      for (const tool of ["bash", "mkdir", "mktemp", "rm", "mv"])
        symlinkSync(toolPath(tool), join(bin, tool));
      const home = join(root, "中文 space\\home");
      mkdirSync(join(home, ".kube"), { recursive: true });
      const script = join(root, "stage-only.sh");
      const render = (bytes: string) =>
        [
          ...prefix,
          'printf \'%s\\n\' "$config_file" > "$HOME/temp-name.txt"',
          bytes,
          ...suffix,
          "printf 'STAGED-SYNTHETIC-CONFIG\\n'",
        ].join("\n");
      writeFileSync(
        script,
        render("printf 'SYNTHETIC CONFIG\\n' > \"$config_file\""),
      );
      writeFileSync(join(home, ".kube", "config"), "OLD-SYNTHETIC-CONFIG\n");
      const success = runCaptured(join(bin, "bash"), [script], root, bin, "", {
        HOME: home,
      });
      expect(success.stdout).toBe("STAGED-SYNTHETIC-CONFIG\n");
      expect(success.stderr).toBe("");
      expect(readFileSync(join(home, ".kube", "config"), "utf8")).toBe(
        "SYNTHETIC CONFIG\n",
      );
      expect(
        existsSync(readFileSync(join(home, "temp-name.txt"), "utf8").trimEnd()),
      ).toBe(false);
      writeFileSync(script, render("printf '%s' '' > \"$config_file\""));
      writeFileSync(join(home, ".kube", "config"), "PRESERVE-ON-FAILURE\n");
      const failure = spawnSync(join(bin, "bash"), [script], {
        cwd: root,
        env: { PATH: bin, HOME: home },
        encoding: "utf8",
        timeout: 10_000,
      });
      expect(failure.error).toBeUndefined();
      expect(failure.status).not.toBe(0);
      expect(failure.stdout).toBe("");
      expect(readFileSync(join(home, ".kube", "config"), "utf8")).toBe(
        "PRESERVE-ON-FAILURE\n",
      );
      expect(
        existsSync(readFileSync(join(home, "temp-name.txt"), "utf8").trimEnd()),
      ).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("checks only the real filename guard and checksum with synthetic artifacts using local sha256sum compatibility", () => {
    const workflow = extractGithubWorkflow(
      readFileSync(
        join(fixture, ".github/workflows/do-rollout-restart.yaml"),
        "utf8",
      ),
    );
    const download = workflow.runs.find((unit) =>
      unit.script.includes("curl --disable"),
    );
    if (!download) throw new Error("Missing real Huawei download body");
    const lines = download.script.trimEnd().split("\n");
    const curlLine = lines.findIndex((line) => line.includes("curl --disable"));
    const checksum = lines.find((line) => line.includes("sha256sum --check -"));
    const guardLine = lines.find((line) => line.includes('archive="$(jq -ner'));
    const filter = guardLine && /'([^']+)'/u.exec(guardLine)?.[1];
    if (curlLine < 0 || !checksum || !filter)
      throw new Error("Missing real guard or checksum fixture");
    expect(lines.slice(0, curlLine).map((line) => line.trim())).toEqual([
      "set -euo pipefail",
      `archive="\${RUNNER_TEMP}/huaweicloud-cli-\${HUAWEI_CLOUD_CLI_VERSION}-linux-amd64.tar.gz"`,
      String.raw`archive="$(jq -ner --arg path "$archive" '$path | select(index("\n") == null and index("\r") == null and index("\u0000") == null)')"`,
    ]);
    expect(checksum.trim()).toBe(
      String.raw`printf '%s  %s\n' "$HUAWEI_CLOUD_CLI_SHA256" "$archive" | sha256sum --check -`,
    );
    const root = mkdtempSync(join(tmpdir(), "pipe-ls-checksum-only-"));
    try {
      const bin = join(root, "bin");
      mkdirSync(bin);
      for (const tool of ["bash", "jq", "sha256sum"])
        symlinkSync(toolPath(tool), join(bin, tool));
      // Compatibility evidence for the available local checker (Darwin on
      // macOS), not a claim that GNU sha256sum or a downloaded tool was run.
      const script = join(root, "check-only.sh");
      writeFileSync(
        script,
        `${lines.slice(0, curlLine).join("\n")}\n${checksum}\nprintf 'VERIFIED-SYNTHETIC-ARTIFACT\\n'\n`,
      );
      const bytes = "SYNTHETIC OFFLINE ARTIFACT: NOT A TOOL\n";
      const digest = createHash("sha256").update(bytes).digest("hex");
      const runnerTemp = join(root, "中文 space\\directory");
      mkdirSync(runnerTemp);
      for (const version of [
        "0.0.0-synthetic",
        "space version",
        "中文\\version",
      ]) {
        writeFileSync(
          join(runnerTemp, `huaweicloud-cli-${version}-linux-amd64.tar.gz`),
          bytes,
        );
        const extraEnv = {
          RUNNER_TEMP: runnerTemp,
          HUAWEI_CLOUD_CLI_VERSION: version,
          HUAWEI_CLOUD_CLI_SHA256: digest,
        };
        const matched = runCaptured(
          join(bin, "bash"),
          [script],
          root,
          bin,
          "",
          extraEnv,
        );
        expect(matched.stdout).toContain("VERIFIED-SYNTHETIC-ARTIFACT\n");
        expect(matched.stderr).toBe("");
        const mismatched = spawnSync(join(bin, "bash"), [script], {
          cwd: root,
          env: {
            PATH: bin,
            HOME: root,
            ...extraEnv,
            HUAWEI_CLOUD_CLI_SHA256: "0".repeat(64),
          },
          encoding: "utf8",
          timeout: 10_000,
        });
        expect(mismatched.error).toBeUndefined();
        expect(mismatched.status).not.toBe(0);
        expect(mismatched.stdout).not.toContain("VERIFIED-SYNTHETIC-ARTIFACT");
      }
      for (const version of ["injected\nrecord", "injected\rrecord"]) {
        const rejected = spawnSync(join(bin, "bash"), [script], {
          cwd: root,
          env: {
            PATH: bin,
            HOME: root,
            RUNNER_TEMP: runnerTemp,
            HUAWEI_CLOUD_CLI_VERSION: version,
            HUAWEI_CLOUD_CLI_SHA256: digest,
          },
          encoding: "utf8",
          timeout: 10_000,
        });
        expect(rejected.error).toBeUndefined();
        expect(rejected.status).not.toBe(0);
        expect(rejected.stdout).toBe("");
      }
      // NUL cannot be passed in native env/argv. Exercise the actual filter
      // with a JSON-bound string without truncating it through Bash.
      for (const path of ["bad\0name", "bad\nname", "bad\rname"]) {
        const rejected = spawnSync(
          join(bin, "jq"),
          ["-ner", "--argjson", "path", JSON.stringify(path), filter],
          {
            cwd: root,
            env: { PATH: bin, HOME: root },
            encoding: "utf8",
            timeout: 10_000,
          },
        );
        expect(rejected.error).toBeUndefined();
        expect(rejected.status).not.toBe(0);
        expect(rejected.stdout).toBe("");
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects absent or ambiguous clusters using only the real EKS jq filter, never AWS", () => {
    const workflow = extractGithubWorkflow(
      readFileSync(
        join(fixture, ".github/workflows/do-rollout-restart.yaml"),
        "utf8",
      ),
    );
    const eks = workflow.runs.find((run) =>
      run.script.includes("aws eks list-clusters"),
    );
    if (!eks) throw new Error("Missing real AWS EKS run fixture");
    const filter = /\|\s*jq -er '([\s\S]*?)'\)/u.exec(eks.script)?.[1];
    if (!filter) throw new Error("Missing static EKS selection filter");
    const root = mkdtempSync(join(tmpdir(), "pipe-ls-eks-jq-only-"));
    try {
      const bin = join(root, "bin");
      mkdirSync(bin);
      symlinkSync(toolPath("jq"), join(bin, "jq"));
      const name = "platform-manager-stack-riA1G-example";
      for (const clusters of [[name], ["other-cluster", name]]) {
        const selected = runCaptured(
          join(bin, "jq"),
          ["-er", filter],
          root,
          bin,
          JSON.stringify(clusters),
        );
        expect(selected.stdout).toBe(`${name}\n`);
        expect(selected.stderr).toBe("");
      }
      for (const input of [
        null,
        [],
        ["other-cluster"],
        [name, `${name}-second`],
        [42],
      ]) {
        const rejected = spawnSync(join(bin, "jq"), ["-er", filter], {
          cwd: root,
          env: { PATH: bin, HOME: root, LC_ALL: "C" },
          input: JSON.stringify(input),
          encoding: "utf8",
          timeout: 1000,
        });
        expect(rejected.error).toBeUndefined();
        expect(rejected.status).not.toBe(0);
        expect(rejected.stdout).toBe("");
      }
      const syntax = spawnSync(toolPath("bash"), ["-n"], {
        input: eks.script,
        encoding: "utf8",
        timeout: 1000,
      });
      expect(syntax.error).toBeUndefined();
      expect(syntax.status).toBe(0);
      expect(syntax.stderr).toBe("");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

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
        // Matrix oracles must not just agree with the parser's own output:
        // independently pin the business facts for these reviewed inputs.
        const updateOnly = scenario.id === "update-only-empty-restart";
        const expectedPlatforms =
          scenario.id === "dual-platform" ? ["aws", "huaweicloud"] : ["aws"];
        const expectedDeployments = updateOnly ? [] : ["cloud-admin", "cloud"];
        expect(parsed.target_family).toBe(updateOnly ? "omp" : "cloud");
        expect(parsed.platforms).toEqual(expectedPlatforms);
        expect(parsed.images).toHaveLength(expectedPlatforms.length);
        expect(parsed.platforms).toEqual([
          ...new Set(parsed.images.map((image) => image.platform)),
        ]);
        const expectedVersion = scenario.id === "digest-aws" ? "digest" : "tag";
        for (const image of parsed.images) {
          expect(image.image_name).toBe(
            updateOnly ? "cloud-cost-exporter" : "cloud-admin-frontend",
          );
          expect(image.deployment_names).toEqual(expectedDeployments);
          expect(image.repository).toBe(
            `${image.platform === "aws" ? "xxxxxxxxxxxx.dkr.ecr.us-west-2.amazonaws.com" : "swr.cn-east-3.myhuaweicloud.com/cloud-console"}/${image.image_name}`,
          );
          expect(image[expectedVersion]).toBe(
            expectedVersion === "digest" ? `sha256:${"a".repeat(64)}` : "dev",
          );
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
        expect(result.restart_targets).toEqual(
          Object.fromEntries(
            (updateOnly ? [] : expectedPlatforms).map((platform) => [
              platform,
              {
                namespace: `synthetic-${platform}`,
                // jq unique returns sorted values, unlike the TSV input order.
                deployments: [...expectedDeployments].sort(),
              },
            ]),
          ),
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
