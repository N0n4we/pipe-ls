import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { MAX_WORKFLOW_YAML_DEPTH } from "@pipe-ls/hosts";
import { MAX_SOURCE_BYTES } from "@pipe-ls/workspace";
import { describe, expect, it } from "vitest";
import { checkPaths, runCli } from "../src/index.js";

describe("CLI static check", () => {
  it("checks a bounded retry envelope with possible effects from both bodies, never executing the action", async () => {
    const root = mkdtempSync(join(tmpdir(), "pipe-ls-retry-envelope-"));
    try {
      const folder = join(root, ".github", "workflows");
      mkdirSync(folder, { recursive: true });
      const path = join(folder, "retry.yml");
      const first = join(root, "MUST-NOT-CREATE-1");
      const second = join(root, "MUST-NOT-CREATE-2");
      const source = `jobs:
  test:
    steps:
      - uses: nick-fields/retry@v3
        with:
          shell: bash
          max_attempts: 3
          timeout_seconds: 30
          continue_on_error: true
          command: |
            set -e
            mkdir -p -- '${first}'
          new_command_on_retry: |
            set -e
            mkdir -p -- '${second}'
`;
      writeFileSync(path, source);
      const report = await checkPaths([path]);
      expect(report.complete).toBe(true);
      expect(report.checkedUnits).toBe(2);
      expect(report.diagnostics).toEqual([]);
      expect(report.externalEffects).toEqual([
        "github retry bash",
        "mkdir directory",
      ]);
      expect(report.fileEffects).toEqual([
        pathToFileURL(first).href,
        pathToFileURL(second).href,
      ]);
      expect(report.fileEffectsUnknown).toBe(true);
      expect(existsSync(first)).toBe(false);
      expect(existsSync(second)).toBe(false);
      writeFileSync(
        path,
        source.replace(`mkdir -p -- '${second}'`, "unknown-alternate-command"),
      );
      const invalid = await checkPaths([path]);
      expect(invalid.complete).toBe(false);
      expect(
        invalid.diagnostics.some(
          (issue) =>
            issue.code === "PIPE201" &&
            issue.message.includes("unknown-alternate-command"),
        ),
      ).toBe(true);
      writeFileSync(
        path,
        source
          .replace("max_attempts: 3", "max_attempts: 1")
          .replace(`mkdir -p -- '${second}'`, "unknown-alternate-command"),
      );
      const unreachable = await checkPaths([path]);
      expect(unreachable.complete).toBe(true);
      expect(unreachable.checkedUnits).toBe(1);
      expect(unreachable.fileEffects).toEqual([pathToFileURL(first).href]);
      expect(existsSync(first)).toBe(false);
      expect(existsSync(second)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("uses runner INPUT defaults and the same action-entry environment for both retry bodies", async () => {
    const root = mkdtempSync(join(tmpdir(), "pipe-ls-retry-env-entry-"));
    try {
      const folder = join(root, ".github", "workflows");
      mkdirSync(folder, { recursive: true });
      const path = join(folder, "retry.yml");
      const source = `jobs:
  test:
    defaults:
      run: {shell: bash}
    steps:
      - run: |
          printf 'NAME=%s\\n' '"entry"' >> "$GITHUB_ENV"
          printf 'INPUT_MAX_ATTEMPTS=%s\\n' '42' >> "$GITHUB_ENV"
      - uses: nick-fields/retry@v3
        env:
          INPUT_MAX_ATTEMPTS: 99
          INPUT_SHELL: ignored
          INPUT_TIMEOUT_SECONDS: ignored
          BASH_ENV: ''
        with:
          shell: bash
          max_attempts: 3
          timeout_minutes: 5
          command: |
            # @pipe env NAME: "entry"
            # @pipe env INPUT_MAX_ATTEMPTS: 3
            jq '.' <<< "$NAME"
            printf 'NAME=%s\\n' '"changed"' >> "$GITHUB_ENV"
          new_command_on_retry: |
            # @pipe env NAME: "entry"
            # @pipe env INPUT_MAX_ATTEMPTS: 3
            # @pipe stdout: {"shell": "bash", "seconds": ""}
            jq -n --arg shell "$INPUT_SHELL" --arg seconds "$INPUT_TIMEOUT_SECONDS" '{shell: $shell, seconds: $seconds}'
`;
      writeFileSync(path, source);
      const report = await checkPaths([path]);
      expect(report.complete).toBe(true);
      expect(report.checkedUnits).toBe(3);
      expect(report.externalEffects).toEqual(["github retry bash"]);
      expect(report.fileEffectsUnknown).toBe(true);
      writeFileSync(path, source.replace("max_attempts: 3", "max_attempts: 4"));
      const mismatch = await checkPaths([path]);
      expect(mismatch.complete).toBe(false);
      // Both bodies reject the same binding; CLI deduplicates one original
      // YAML location rather than issuing two copies of the input error.
      expect(
        mismatch.diagnostics.filter((issue) => issue.code === "PIPE102"),
      ).toHaveLength(1);
      const inputError = mismatch.diagnostics.find(
        (issue) => issue.code === "PIPE102",
      );
      expect(inputError?.range.start.line).toBe(
        source
          .split("\n")
          .findIndex((line) => line.includes("max_attempts: 3")),
      );
      expect(JSON.stringify(mismatch)).not.toContain("changed");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not infer retry completion, stdin injection, outputs, repository or startup proofs from action success", async () => {
    const root = mkdtempSync(join(tmpdir(), "pipe-ls-retry-no-proofs-"));
    try {
      const folder = join(root, ".github", "workflows");
      mkdirSync(folder, { recursive: true });
      writeFileSync(join(root, ".github", "pins.env"), "VERSION=synthetic\n");
      const path = join(folder, "retry.yml");
      const source = (
        body: string,
        after: string = "",
        output: string = "",
      ) => `jobs:
  test:
${output}    defaults:
      run: {shell: bash}
    steps:
      - uses: actions/checkout@v4
      - id: retried
        uses: nick-fields/retry@v3
        with:
          shell: bash
          max_attempts: 3
          timeout_seconds: 30
          command: |
${body
  .split("\n")
  .map((line) => `            ${line}`)
  .join("\n")}
${after}`;
      writeFileSync(path, source("# @pipe stdin: string\njq '.'"));
      const stdin = await checkPaths([path]);
      expect(stdin.complete).toBe(false);
      expect(stdin.diagnostics).toContainEqual(
        expect.objectContaining({
          code: "PIPE104",
          message: "Retry command has no injected stdin interface",
        }),
      );
      writeFileSync(
        path,
        source(
          `sed -E '/^[[:space:]]*(#|$)/d' .github/pins.env >> "$GITHUB_ENV"`,
        ),
      );
      const snapshot = await checkPaths([path]);
      expect(snapshot.complete).toBe(false);
      expect(
        snapshot.diagnostics.some((issue) =>
          issue.message.includes("unverified action"),
        ),
      ).toBe(true);
      const producer = `printf 'NAME=%s\\n' '"not-guaranteed"' >> "$GITHUB_ENV"\nprintf 'value=%s\\n' '"not-guaranteed"' >> "$GITHUB_OUTPUT"`;
      writeFileSync(
        path,
        source(
          producer,
          `      - run: |\n          # @pipe env NAME: string\n          jq '.' <<< "$NAME"\n`,
        ),
      );
      const env = await checkPaths([path]);
      expect(env.complete).toBe(false);
      expect(
        env.diagnostics.some((issue) =>
          issue.message.includes("env NAME has no statically proven injection"),
        ),
      ).toBe(true);
      writeFileSync(
        path,
        source(
          producer,
          "",
          `    outputs:\n      value: \${{ steps.retried.outputs.exit_code }}\n`,
        ),
      );
      const output = await checkPaths([path]);
      expect(output.complete).toBe(false);
      expect(
        output.diagnostics.some((issue) =>
          issue.message.includes("no verified producing step"),
        ),
      ).toBe(true);
      writeFileSync(path, source("printf 'log'", `      - run: jq -n '1'\n`));
      expect(
        (await checkPaths([path])).diagnostics.some((issue) =>
          issue.message.includes("Bash startup"),
        ),
      ).toBe(true);
      writeFileSync(
        path,
        source(
          "printf 'log'",
          `      - env: {BASH_ENV: ''}\n        run: jq -n '1'\n`,
        ),
      );
      expect((await checkPaths([path])).complete).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("checks a bounded retry reusable workflow against actual caller wires, not just its inner body", async () => {
    const root = mkdtempSync(join(tmpdir(), "pipe-ls-retry-callable-"));
    try {
      const folder = join(root, ".github", "workflows");
      mkdirSync(folder, { recursive: true });
      const path = join(folder, "caller.yml");
      writeFileSync(
        join(folder, "callee.yml"),
        `on:
  workflow_call:
    inputs:
      name: {type: string, required: true}
jobs:
  test:
    env:
      NAME: \${{ inputs.name }}
    steps:
      - uses: nick-fields/retry@v3
        with:
          shell: bash
          max_attempts: 3
          timeout_minutes: 5
          command: |
            # @pipe env NAME: string
            jq '.' <<< "$NAME"
          new_command_on_retry: |
            # @pipe env NAME: string
            jq '.' <<< "$NAME"
`,
      );
      const render = (name: string) =>
        `jobs:\n  call:\n    uses: ./.github/workflows/callee.yml\n    with:\n      name: ${name}\n`;
      writeFileSync(path, render(`'"synthetic"'`));
      const report = await checkPaths([path]);
      expect(report.complete).toBe(true);
      expect(report.checkedUnits).toBe(2);
      expect(report.externalEffects).toEqual(["github retry bash"]);
      writeFileSync(path, render("synthetic"));
      const invalid = await checkPaths([path]);
      expect(invalid.complete).toBe(false);
      expect(
        invalid.diagnostics.filter((issue) => issue.code === "PIPE101"),
      ).toHaveLength(1);
      expect(invalid.checkedUnits).toBe(2);
      expect(
        invalid.diagnostics.some((issue) =>
          issue.message.includes(
            "Reusable workflow contract is not yet verified",
          ),
        ),
      ).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("checks the complete real Huawei retry body independently without executing cloud or file commands", async () => {
    const root = mkdtempSync(join(tmpdir(), "pipe-ls-huawei-no-execution-"));
    try {
      const { extractGithubWorkflow } = await import("@pipe-ls/hosts");
      const workflow = extractGithubWorkflow(
        readFileSync(
          fileURLToPath(
            new URL(
              "../../../tests/cases/1/.github/workflows/do-rollout-restart.yaml",
              import.meta.url,
            ),
          ),
          "utf8",
        ),
      );
      const retry = workflow.opaqueCommands.find((unit) =>
        unit.script.includes("hcloud cce ListClusters/v3"),
      );
      if (!retry) throw new Error("Missing real Huawei retry body");
      const folder = join(root, ".github", "workflows");
      mkdirSync(folder, { recursive: true });
      const path = join(folder, "retry-body.yml");
      // This is the full inner Bash body, not a replacement reusable workflow
      // or an assertion that the surrounding retry Action has been verified.
      const render = (body: string) =>
        `jobs:\n  test:\n    steps:\n      - shell: bash\n        run: |\n${body
          .trimEnd()
          .split("\n")
          .map((line) => `          ${line}`)
          .join("\n")}\n`;
      writeFileSync(path, render(retry.script));
      const result = await checkPaths([path]);
      expect(result.complete).toBe(true);
      expect(result.diagnostics).toEqual([]);
      expect(result.externalEffects).toEqual([
        "hcloud cce CreateKubernetesClusterCert",
        "hcloud cce ListClusters",
        "hcloud configure set",
        "mkdir directory",
        "mktemp file",
        "mv file",
        "rm file",
        "test file size",
      ]);
      expect(result.fileEffectsUnknown).toBe(true);
      expect(existsSync(join(root, ".kube"))).toBe(false);
      const marker = join(root, "MUST-NOT-WRITE-CERT");
      writeFileSync(
        path,
        render(retry.script.replace('> "$config_file"', `> '${marker}'`)),
      );
      const redirected = await checkPaths([path]);
      expect(redirected.complete).toBe(true);
      expect(redirected.fileEffects).toContain(pathToFileURL(marker).href);
      expect(existsSync(marker)).toBe(false);
      writeFileSync(
        path,
        render(
          retry.script.replace(
            "--duration=1825",
            "--duration=1825 --cli-warning=false",
          ),
        ),
      );
      const invalid = await checkPaths([path]);
      expect(invalid.complete).toBe(false);
      expect(invalid.diagnostics.map((issue) => issue.code)).toContain(
        "PIPE202",
      );
      expect(existsSync(marker)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("checks the real installation filesystem chain without installing binaries or running Huawei commands", async () => {
    const root = mkdtempSync(join(tmpdir(), "pipe-ls-install-no-execution-"));
    try {
      const { extractGithubWorkflow } = await import("@pipe-ls/hosts");
      const workflow = extractGithubWorkflow(
        readFileSync(
          fileURLToPath(
            new URL(
              "../../../tests/cases/1/.github/workflows/do-rollout-restart.yaml",
              import.meta.url,
            ),
          ),
          "utf8",
        ),
      );
      const install = workflow.runs.find((unit) =>
        unit.script.includes("sudo -n -- install"),
      );
      if (!install) throw new Error("Missing real installation body");
      const folder = join(root, ".github", "workflows");
      mkdirSync(folder, { recursive: true });
      const path = join(folder, "install.yml");
      const artifact = join(root, "MUST-NOT-INSTALL");
      const render = (body: string) => `jobs:
  test:
    steps:
      - shell: bash
        env:
          HUAWEI_CLOUD_CLI_VERSION: 0.0.0-synthetic
          HW_ACCESS_KEY: STATIC_TEST_KEY_NEVER_USE
          HW_SECRET_KEY: STATIC_TEST_SECRET_NEVER_USE
        run: |
${body
  .trimEnd()
  .split("\n")
  .map((line) => `          ${line}`)
  .join("\n")}
`;
      const body = install.script.replace("/usr/local/bin/hcloud", artifact);
      writeFileSync(path, render(body));
      const checked = await checkPaths([path]);
      expect(checked.complete).toBe(true);
      expect(checked.diagnostics).toEqual([]);
      expect(checked.externalEffects).toEqual([
        "hcloud configure set",
        "hcloud version",
        "mktemp directory",
        "rm directory",
        "sudo install file",
        "tar extract",
      ]);
      expect(checked.fileEffects).toEqual([pathToFileURL(artifact).href]);
      expect(checked.fileEffectsUnknown).toBe(true);
      expect(existsSync(artifact)).toBe(false);
      expect(JSON.stringify(checked)).not.toContain(
        "STATIC_TEST_SECRET_NEVER_USE",
      );
      // The independent full body above has synthetic native metadata. This
      // does not verify the surrounding Actions/secret/pins data flow.
      const filesystemBody = body.slice(
        0,
        body.indexOf("hcloud configure set"),
      );
      writeFileSync(path, render(filesystemBody));
      expect((await checkPaths([path])).complete).toBe(true);
      expect(existsSync(artifact)).toBe(false);
      writeFileSync(
        path,
        render(filesystemBody.replace("sudo -n --", "sudo --")),
      );
      const interactive = await checkPaths([path]);
      expect(interactive.complete).toBe(false);
      expect(interactive.diagnostics.map((issue) => issue.code)).toContain(
        "PIPE202",
      );
      expect(existsSync(artifact)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("revokes later repository proofs after native directory creation without actually creating the target", async () => {
    const root = mkdtempSync(join(tmpdir(), "pipe-ls-mkdir-static-"));
    try {
      const folder = join(root, ".github", "workflows");
      mkdirSync(folder, { recursive: true });
      writeFileSync(join(root, ".github", "pins.env"), "VERSION=synthetic\n");
      const path = join(folder, "mkdir.yml");
      const target = join(root, "MUST-NOT-CREATE");
      writeFileSync(
        path,
        `jobs:
  test:
    defaults:
      run: {shell: bash}
    steps:
      - uses: actions/checkout@v4
      - run: |
          set -e
          mkdir -p -- '${target}'
      - run: sed -E '/^[[:space:]]*(#|$)/d' .github/pins.env >> "$GITHUB_ENV"
`,
      );
      const checked = await checkPaths([path]);
      expect(checked.complete).toBe(false);
      expect(checked.externalEffects).toEqual(["mkdir directory"]);
      expect(checked.fileEffectsUnknown).toBe(true);
      expect(
        checked.diagnostics.some((issue) =>
          issue.message.includes(
            "Repository contents may have changed after an unverified run",
          ),
        ),
      ).toBe(true);
      expect(existsSync(target)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("passes verified YAML native metadata into Bash without treating raw bytes as JSON", async () => {
    const root = mkdtempSync(join(tmpdir(), "pipe-ls-native-env-"));
    try {
      const folder = join(root, ".github", "workflows");
      mkdirSync(folder, { recursive: true });
      const path = join(folder, "native.yml");
      const source = `env:
  VERSION: workflow
jobs:
  test:
    env:
      VERSION: job
    steps:
      - shell: bash
        env:
          VERSION: step
        run: |
          # @pipe stdout: "step"
          jq -cn --arg version "$VERSION" '$version'
`;
      writeFileSync(path, source);
      expect((await checkPaths([path])).complete).toBe(true);
      writeFileSync(
        path,
        source
          .replace("VERSION: step", "VERSION: SECRET_MARKER")
          .replace(
            `jq -cn --arg version "$VERSION" '$version'`,
            `jq '.' <<< "$VERSION"`,
          ),
      );
      const raw = await checkPaths([path]);
      expect(raw.diagnostics.map((issue) => issue.code)).toContain("PIPE101");
      expect(JSON.stringify(raw)).not.toContain("SECRET_MARKER");
      writeFileSync(
        path,
        source.replace(
          "VERSION: step",
          `VERSION: '\${{ secrets.UNKNOWN_NATIVE_VALUE }}'`,
        ),
      );
      const unknown = await checkPaths([path]);
      expect(unknown.complete).toBe(false);
      expect(
        unknown.diagnostics.some((issue) =>
          issue.message.includes("Unknown Bash variable VERSION"),
        ),
      ).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("keeps evolving global env separate from explicit step overrides across direct and reusable checks", async () => {
    const root = mkdtempSync(join(tmpdir(), "pipe-ls-native-env-order-"));
    try {
      const folder = join(root, ".github", "workflows");
      mkdirSync(folder, { recursive: true });
      const path = join(folder, "callee.yml");
      const caller = join(folder, "caller.yml");
      writeFileSync(
        caller,
        "jobs:\n  call:\n    uses: ./.github/workflows/callee.yml\n",
      );
      const source = (conditional: boolean, override: boolean) => `on:
  workflow_call:
env:
  VERSION: old
jobs:
  test:
    defaults:
      run:
        shell: bash
    steps:
      - ${conditional ? `if: \${{ true }}\n        ` : ""}run: printf 'VERSION=%s\\n' 'new' >> "$GITHUB_ENV"
      - ${override ? "env:\n          VERSION: step\n        " : ""}run: |
          # @pipe stdout: "${override ? "step" : "new"}"
          jq -cn --arg version "$VERSION" '$version'
`;
      for (const entry of [path, caller]) {
        writeFileSync(path, source(false, false));
        expect((await checkPaths([entry])).complete).toBe(true);
        writeFileSync(path, source(true, false));
        expect((await checkPaths([entry])).complete).toBe(false);
        writeFileSync(path, source(true, true));
        expect((await checkPaths([entry])).complete).toBe(true);
        writeFileSync(
          path,
          source(false, true).replace(
            "      - run: printf",
            "      - uses: third-party/action@v1\n      - run: printf",
          ),
        );
        const isolated = await checkPaths([entry]);
        expect(isolated.complete).toBe(false);
        expect(
          isolated.diagnostics.some(
            (issue) =>
              issue.message.includes("Unknown Bash variable VERSION") ||
              issue.message.includes("stdout does not match"),
          ),
        ).toBe(false);
        const startupSource = source(true, true).replace(
          "printf 'VERSION=%s",
          "printf 'BASH_ENV=%s",
        );
        writeFileSync(path, startupSource);
        const startup = await checkPaths([entry]);
        expect(startup.complete).toBe(false);
        expect(
          startup.diagnostics.some(
            (issue) =>
              issue.message === "Bash startup environment is not yet analyzed",
          ),
        ).toBe(true);
        writeFileSync(
          path,
          startupSource.replace(
            "          VERSION: step",
            "          BASH_ENV: ''\n          VERSION: step",
          ),
        );
        expect((await checkPaths([entry])).complete).toBe(true);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("checks curl files statically, invalidates downstream snapshots and never downloads", async () => {
    const root = mkdtempSync(join(tmpdir(), "pipe-ls-curl-no-execution-"));
    try {
      const folder = join(root, ".github", "workflows");
      mkdirSync(folder, { recursive: true });
      const path = join(folder, "download.yml");
      const artifact = join(root, "DOWNLOADED");
      const pins = join(root, ".github", "pins.env");
      writeFileSync(pins, "VERSION=synthetic\n");
      const source = `jobs:
  test:
    defaults:
      run:
        shell: bash
    steps:
      - uses: actions/checkout@v4
      - env:
          URL: https://static-test.invalid/archive
          DESTINATION: ${artifact}
        run: |
          set -e
          curl --disable --globoff --proto '=https' --proto-redir '=https' --fail --silent --show-error --location --retry 3 --url "$URL" --output "$DESTINATION"
`;
      writeFileSync(path, source);
      const checked = await checkPaths([path]);
      expect(checked.complete).toBe(true);
      expect(checked.externalEffects).toEqual(["curl download"]);
      expect(checked.fileEffects).toEqual([pathToFileURL(artifact).href]);
      expect(checked.fileEffectsUnknown).toBe(true);
      expect(existsSync(artifact)).toBe(false);
      writeFileSync(
        path,
        `${source}      - run: sed -E '/^[[:space:]]*(#|$)/d' .github/pins.env >> "$GITHUB_ENV"\n`,
      );
      const stale = await checkPaths([path]);
      expect(stale.complete).toBe(false);
      expect(
        stale.diagnostics.some((issue) =>
          issue.message.includes(
            "Repository contents may have changed after an unverified run",
          ),
        ),
      ).toBe(true);
      expect(existsSync(artifact)).toBe(false);
      writeFileSync(
        path,
        source.replace(
          "          URL:",
          "          BASH_ENV: unsafe-startup.sh\n          URL:",
        ),
      );
      const startup = await checkPaths([path]);
      expect(startup.complete).toBe(false);
      expect(
        startup.diagnostics.some(
          (issue) =>
            issue.message === "Bash startup environment is not yet analyzed",
        ),
      ).toBe(true);
      writeFileSync(
        path,
        source.replace(
          "          URL:",
          `          BASH_ENV: '\${{ secrets.STARTUP_PATH }}'\n          URL:`,
        ),
      );
      const unknownStartup = await checkPaths([path]);
      expect(unknownStartup.complete).toBe(false);
      expect(
        unknownStartup.diagnostics.some(
          (issue) =>
            issue.message === "Bash startup environment is not yet analyzed",
        ),
      ).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("never executes a project script while producing diagnostics", async () => {
    const root = mkdtempSync(join(tmpdir(), "pipe-ls-no-execution-"));
    try {
      const folder = join(root, ".github", "scripts");
      mkdirSync(folder, { recursive: true });
      const script = join(folder, "side-effect.sh");
      const marker = join(root, "EXECUTED");
      writeFileSync(
        script,
        `#!/usr/bin/env bash\nprintf 'executed\\n' > "${marker}"\n`,
      );
      chmodSync(script, 0o755);
      const report = await checkPaths([script]);
      expect(report.complete).toBe(false);
      expect(report.diagnostics.length).toBeGreaterThan(0);
      expect(existsSync(marker)).toBe(false);
      const output: string[] = [];
      expect(
        await runCli(["check", "--json", script], (part) => output.push(part)),
      ).toBe(1);
      expect(JSON.parse(output.join("")).complete).toBe(false);
      expect(existsSync(marker)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("preserves safe discovery errors with exit code 2", async () => {
    const root = mkdtempSync(join(tmpdir(), "pipe-ls-cli-discovery-"));
    try {
      const missing = join(root, "missing.sh");
      const errors: string[] = [];
      expect(
        await runCli(
          ["check", missing],
          () => {},
          (part) => errors.push(part),
        ),
      ).toBe(2);
      expect(errors.join("")).toContain("Entry is not readable");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not treat the incomplete case 1 fixture as a passing product check", async () => {
    const root = fileURLToPath(
      new URL("../../../tests/cases/1/", import.meta.url),
    );
    const report = await checkPaths([root]);
    expect(report.complete).toBe(false);
    expect(report.diagnostics.some((item) => item.code === "PIPE204")).toBe(
      true,
    );
    expect(report.diagnostics.some((item) => item.status === "blocked")).toBe(
      true,
    );
    expect(
      report.diagnostics.some(
        (item) =>
          item.code === "PIPE204" &&
          item.message.includes("resources/cloud/overlays/staging"),
      ),
    ).toBe(true);
  });
  it("checks finite overlay paths through the read-only project snapshot", async () => {
    const root = mkdtempSync(join(tmpdir(), "pipe-ls-overlays-"));
    try {
      const script = join(root, ".github", "scripts", "paths.sh");
      mkdirSync(join(root, ".github", "scripts"), { recursive: true });
      writeFileSync(
        script,
        `#!/usr/bin/env bash\n# @pipe stdin: {"family": string, "environment": string}\n# @pipe stdout: number\ndoc="$(jq -c '.')"\nfamily="$(jq -r '.family' <<< "$doc")"\nenvironment="$(jq -r '.environment' <<< "$doc")"\ncase "$family" in alpha|beta) ;; *) exit 1;; esac\ncase "$environment" in dev|prod) ;; *) exit 1;; esac\nscript_dir="$(cd -- "$(dirname -- "${"$"}{BASH_SOURCE[0]}")" && pwd)"\nrepo_root="$(cd -- "$script_dir/../.." && pwd)"\npath="$repo_root/resources/$family/overlays/$environment"\nif [[ -d "$path" ]]; then jq -n '1'; else exit 1; fi\n`,
      );
      const missing = await checkPaths([script]);
      expect(missing.complete).toBe(false);
      expect(
        missing.diagnostics.filter((item) => item.code === "PIPE204"),
      ).toHaveLength(4);
      expect(missing.unverifiedDependencies).toHaveLength(4);
      for (const family of ["alpha", "beta"])
        for (const environment of ["dev", "prod"])
          mkdirSync(join(root, "resources", family, "overlays", environment), {
            recursive: true,
          });
      const present = await checkPaths([script]);
      expect(present.diagnostics).toEqual([]);
      expect(present.complete).toBe(true);
      expect(present.unverifiedDependencies).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
  it("reports the parse fixture's missing TSV allowlist from its redirection", async () => {
    const fixture = fileURLToPath(
      new URL(
        "../../../tests/cases/1/.github/scripts/parse-cloud-images.sh",
        import.meta.url,
      ),
    );
    const root = mkdtempSync(join(tmpdir(), "pipe-ls-allowlist-"));
    try {
      const script = join(root, ".github", "scripts", "parse-cloud-images.sh");
      mkdirSync(join(root, ".github", "scripts"), { recursive: true });
      copyFileSync(fixture, script);
      const report = await checkPaths([script]);
      expect(
        report.diagnostics.some(
          (item) =>
            item.code === "PIPE204" &&
            item.message.includes("cloud-image-allowlist.tsv"),
        ),
      ).toBe(true);
      expect(
        report.unverifiedDependencies.some((path) =>
          path.endsWith("/cloud-image-allowlist.tsv"),
        ),
      ).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not read a local-script dependency outside its .github project", async () => {
    const root = mkdtempSync(join(tmpdir(), "pipe-ls-cross-project-"));
    try {
      const project = join(root, "project");
      const other = join(root, "other");
      mkdirSync(join(project, ".github"), { recursive: true });
      mkdirSync(join(other, ".github"), { recursive: true });
      const caller = join(project, "caller.sh");
      writeFileSync(
        caller,
        `#!/usr/bin/env bash
# @pipe stdout: number
value="$(./../other/secret.sh)"
printf '%s\\n' "$value"
`,
      );
      writeFileSync(
        join(other, "secret.sh"),
        "#!/usr/bin/env bash\n# @pipe stdout: number\n# SECRET_MARKER_MUST_NOT_LEAK\njq -n '42'\n",
      );
      const report = await checkPaths([caller]);
      expect(report.complete).toBe(false);
      expect(report.diagnostics.map((issue) => issue.code)).toContain(
        "PIPE204",
      );
      expect(JSON.stringify(report)).not.toContain(
        "SECRET_MARKER_MUST_NOT_LEAK",
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
  it("returns success only for a checked script with no diagnostics", async () => {
    const root = mkdtempSync(join(tmpdir(), "pipe-ls-cli-"));
    try {
      mkdirSync(join(root, ".github"));
      const good = join(root, "good.sh");
      writeFileSync(
        good,
        "#!/usr/bin/env bash\n# @pipe stdout: number\njq -n '42'\n",
      );
      const report = await checkPaths([good]);
      expect(report.checkedUnits).toBe(1);
      expect(report.complete).toBe(true);
      const output: string[] = [];
      expect(
        await runCli(["check", "--json", good], (value) => output.push(value)),
      ).toBe(0);
      expect(JSON.parse(output.join("")).diagnostics).toEqual([]);
      writeFileSync(
        good,
        "#!/usr/bin/env bash\n# @pipe stdout: number\nbusiness-command\n",
      );
      const blocked = await checkPaths([good]);
      expect(blocked.complete).toBe(false);
      expect(blocked.diagnostics.map((item) => item.code)).toEqual(["PIPE201"]);
      writeFileSync(good, "# @pipe stdout: number\njq -n '42'\n");
      expect(
        (await checkPaths([good])).diagnostics.map((item) => item.code),
      ).toEqual(["PIPE203"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("reports the published CLI version without scanning a project", async () => {
    const output: string[] = [];
    expect(await runCli(["--version"], (value) => output.push(value))).toBe(0);
    expect(output.join("")).toBe("0.1.0\n");
  });

  it("aggregates explicit paths from separate .github projects without merging roots", async () => {
    const base = mkdtempSync(join(tmpdir(), "pipe-ls-multi-project-"));
    try {
      const first = join(base, "first");
      const second = join(base, "second");
      for (const root of [first, second])
        mkdirSync(join(root, ".github"), { recursive: true });
      const one = join(first, "good.sh");
      const two = join(second, "bad.sh");
      writeFileSync(
        one,
        "#!/usr/bin/env bash\n# @pipe stdout: number\njq -n '1'\n",
      );
      writeFileSync(
        two,
        `#!/usr/bin/env bash
# @pipe stdout: number
jq -n '"wrong"'
`,
      );
      const report = await checkPaths([two, one]);
      expect(report.checkedUnits).toBe(2);
      expect(report.complete).toBe(false);
      expect(report.diagnostics.map((issue) => issue.code)).toEqual([
        "PIPE102",
      ]);
      expect(report.diagnostics[0]?.uri).toContain("/second/bad.sh");
      writeFileSync(
        two,
        "#!/usr/bin/env bash\n# @pipe stdout: number\njq -n '2'\n",
      );
      expect((await checkPaths([two, one])).complete).toBe(true);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("reports an oversized source as a blocked dependency instead of parsing it", async () => {
    const root = mkdtempSync(join(tmpdir(), "pipe-ls-budget-"));
    try {
      mkdirSync(join(root, ".github"));
      const path = join(root, "huge.sh");
      writeFileSync(path, "x".repeat(MAX_SOURCE_BYTES + 1));
      const report = await checkPaths([path]);
      expect(report.complete).toBe(false);
      expect(report.diagnostics.map((item) => item.code)).toEqual(["PIPE204"]);
      expect(report.diagnostics[0]?.message).toContain("byte budget");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("keeps malformed YAML source text out of both CLI output formats", async () => {
    const root = mkdtempSync(join(tmpdir(), "pipe-ls-yaml-secret-"));
    try {
      const folder = join(root, ".github", "workflows");
      mkdirSync(folder, { recursive: true });
      const path = join(folder, "bad.yaml");
      const secret = "SECRET_MARKER_MUST_NOT_LEAK";
      writeFileSync(
        path,
        `jobs:\n  test:\n    steps:\n      - run: [${secret}\n`,
      );
      const report = await checkPaths([path]);
      expect(report.complete).toBe(false);
      expect(report.diagnostics[0]?.code).toBe("PIPE001");
      expect(JSON.stringify(report)).not.toContain(secret);
      for (const mode of [[], ["--json"]]) {
        const output: string[] = [];
        expect(
          await runCli(["check", ...mode, path], (part) => output.push(part)),
        ).toBe(1);
        expect(output.join("")).not.toContain(secret);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("keeps malformed script contract and jq tokens out of CLI diagnostics", async () => {
    const root = mkdtempSync(join(tmpdir(), "pipe-ls-script-secret-"));
    try {
      const folder = join(root, ".github", "scripts");
      mkdirSync(folder, { recursive: true });
      const path = join(folder, "bad.sh");
      const secret = "SECRET_MARKER_MUST_NOT_LEAK";
      writeFileSync(
        path,
        `#!/usr/bin/env bash\n# @pipe stdin: {"${secret}": number, "${secret}": string}\njq -n '"ok" ${secret}'\n`,
      );
      const report = await checkPaths([path]);
      expect(report.complete).toBe(false);
      expect(report.diagnostics.map((item) => item.code)).toContain("PIPE104");
      expect(report.diagnostics.map((item) => item.code)).toContain("PIPE001");
      expect(JSON.stringify(report)).not.toContain(secret);
      for (const mode of [[], ["--json"]]) {
        const output: string[] = [];
        expect(
          await runCli(["check", ...mode, path], (part) => output.push(part)),
        ).toBe(1);
        expect(output.join("")).not.toContain(secret);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("blocks a budgeted YAML workflow instead of checking its otherwise valid run", async () => {
    const root = mkdtempSync(join(tmpdir(), "pipe-ls-yaml-budget-"));
    try {
      const folder = join(root, ".github", "workflows");
      mkdirSync(folder, { recursive: true });
      const path = join(folder, "deep.yaml");
      const nested = Array.from(
        { length: MAX_WORKFLOW_YAML_DEPTH + 2 },
        (_, index) => `${"  ".repeat(index + 1)}child:\n`,
      ).join("");
      writeFileSync(
        path,
        `jobs:\n  test:\n    runs-on: ubuntu-latest\n    defaults:\n      run:\n        shell: bash\n    steps:\n      - run: jq -n '42'\nspare:\n${nested}${"  ".repeat(MAX_WORKFLOW_YAML_DEPTH + 3)}end: value\n`,
      );
      const report = await checkPaths([path]);
      expect(report.complete).toBe(false);
      expect(
        report.diagnostics.map((item) => [item.code, item.status]),
      ).toEqual([["PIPE203", "blocked"]]);
      expect(report.diagnostics[0]?.message).toContain("YAML depth budget");
      const output: string[] = [];
      expect(
        await runCli(["check", "--json", path], (text) => output.push(text)),
      ).toBe(1);
      expect(JSON.parse(output.join("")).complete).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("maps run diagnostics to YAML and reports absent local workflows", async () => {
    const root = mkdtempSync(join(tmpdir(), "pipe-ls-workflow-"));
    try {
      mkdirSync(join(root, ".github", "workflows"), { recursive: true });
      const path = join(root, ".github", "workflows", "main.yml");
      writeFileSync(
        path,
        "jobs:\n  test:\n    defaults:\n      run:\n        shell: bash\n    steps:\n      - run: |\n          # @pipe stdout: [number]\n          jq -n '1, 2'\n  next:\n    uses: ./.github/workflows/missing.yml\n",
      );
      const report = await checkPaths([path]);
      expect(report.complete).toBe(false);
      expect(report.diagnostics.map((item) => item.code)).toEqual([
        "PIPE103",
        "PIPE204",
      ]);
      expect(report.diagnostics[0]?.range.start.line).toBe(8);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("checks a local Bash callee contract through a GitHub run", async () => {
    const root = mkdtempSync(join(tmpdir(), "pipe-ls-local-call-"));
    try {
      mkdirSync(join(root, ".github", "workflows"), { recursive: true });
      const workflow = join(root, ".github", "workflows", "main.yml");
      const child = join(root, "child.sh");
      const run = (input: string, checkout = true) =>
        `jobs:\n  test:\n    defaults:\n      run:\n        shell: bash\n    steps:\n${checkout ? "      - uses: actions/checkout@v4\n" : ""}      - run: |\n          # @pipe stdout: number\n          value=$(./child.sh <<< '${input}')\n          printf '%s\\n' "$value"\n`;
      writeFileSync(
        child,
        "#!/usr/bin/env bash\n# @pipe stdin: number\n# @pipe stdout: number\njq -c '.'\n",
      );
      writeFileSync(workflow, run("42", false));
      const noCheckout = await checkPaths([workflow]);
      expect(noCheckout.complete).toBe(false);
      expect(noCheckout.diagnostics.map((item) => item.code)).toContain(
        "PIPE204",
      );
      writeFileSync(workflow, run("42"));
      expect((await checkPaths([workflow])).diagnostics).toEqual([]);
      writeFileSync(workflow, run('"wrong"'));
      expect(
        (await checkPaths([workflow])).diagnostics.map((item) => item.code),
      ).toEqual(["PIPE102"]);
      writeFileSync(workflow, run("42"));
      writeFileSync(
        child,
        "#!/usr/bin/env bash\n# @pipe stdin: number\njq -c '.'\n",
      );
      expect(
        (await checkPaths([workflow])).diagnostics.map((item) => item.code),
      ).toEqual(["PIPE104"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("checks local reusable workflow input names and primitive types without running it", async () => {
    const root = mkdtempSync(join(tmpdir(), "pipe-ls-reusable-inputs-"));
    try {
      const workflows = join(root, ".github", "workflows");
      mkdirSync(workflows, { recursive: true });
      const callee = join(workflows, "callee.yml");
      const caller = join(workflows, "caller.yml");
      writeFileSync(
        callee,
        "on:\n  workflow_call:\n    inputs:\n      name:\n        type: string\n        required: true\n      count:\n        type: number\njobs:\n  test:\n    steps: []\n",
      );
      const run = async (args: string) => {
        writeFileSync(
          caller,
          `jobs:\n  call:\n    uses: ./.github/workflows/callee.yml\n    with:\n${args}`,
        );
        return (await checkPaths([caller])).diagnostics;
      };
      expect(
        (await run("      name: alice\n      count: 3\n")).map((d) => d.code),
      ).toEqual(["PIPE202"]);
      expect(
        (await run("      count: 3\n")).some((d) =>
          d.message.includes("requires input name"),
        ),
      ).toBe(true);
      writeFileSync(
        caller,
        "jobs:\n  call:\n    uses: ./.github/workflows/callee.yml\n",
      );
      expect(
        (await checkPaths([caller])).diagnostics.some((d) =>
          d.message.includes("requires input name"),
        ),
      ).toBe(true);
      expect(
        (await run("      name: alice\n      count: nope\n")).some(
          (d) => d.code === "PIPE102",
        ),
      ).toBe(true);
      expect(
        (await run("      name: alice\n      unknown: yes\n")).some((d) =>
          d.message.includes("has no input unknown"),
        ),
      ).toBe(true);
      expect(
        (await run("      name: $" + "{{ github.event.issue.title }}\n")).some(
          (d) => d.code === "PIPE203",
        ),
      ).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects omitted or undeclared reusable workflow secrets", async () => {
    const root = mkdtempSync(join(tmpdir(), "pipe-ls-reusable-secrets-"));
    try {
      const workflows = join(root, ".github", "workflows");
      mkdirSync(workflows, { recursive: true });
      const callee = join(workflows, "callee.yml");
      const caller = join(workflows, "caller.yml");
      writeFileSync(
        callee,
        `on:
  workflow_call:
    secrets:
      TOKEN:
        required: true
jobs:
  test:
    runs-on: ubuntu-latest
    defaults:
      run:
        shell: bash
    steps:
      - run: set -euo pipefail
`,
      );
      const check = async (secrets: string) => {
        writeFileSync(
          caller,
          `jobs:\n  call:\n    uses: ./.github/workflows/callee.yml\n${secrets}`,
        );
        return checkPaths([caller]);
      };
      const missing = await check("");
      expect(missing.complete).toBe(false);
      expect(
        missing.diagnostics.some(
          (issue) =>
            issue.code === "PIPE104" &&
            issue.message.includes("requires secret TOKEN"),
        ),
      ).toBe(true);
      const supplied = await check(
        `    secrets:\n      TOKEN: \${{ secrets.PRIVATE_TOKEN }}\n`,
      );
      expect(supplied.complete).toBe(true);
      expect(supplied.diagnostics).toEqual([]);
      expect(JSON.stringify(supplied)).not.toContain("PRIVATE_TOKEN");
      const inherited = await check("    secrets: inherit\n");
      expect(inherited.complete).toBe(true);
      const wrong = await check(
        `    secrets:\n      OTHER: \${{ secrets.PRIVATE_TOKEN }}\n`,
      );
      expect(wrong.complete).toBe(false);
      expect(wrong.diagnostics.map((issue) => issue.code)).toContain("PIPE104");
      expect(
        wrong.diagnostics.some((issue) =>
          issue.message.includes("has no secret OTHER"),
        ),
      ).toBe(true);
      const unverified = await check("    secrets: unknown\n");
      expect(unverified.complete).toBe(false);
      expect(unverified.diagnostics.map((issue) => issue.code)).toContain(
        "PIPE203",
      );
      expect(
        unverified.diagnostics.some((issue) =>
          issue.message.includes("requires secret TOKEN"),
        ),
      ).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("verifies a called Bash workflow against caller-provided JSON wire values", async () => {
    const root = mkdtempSync(join(tmpdir(), "pipe-ls-called-run-"));
    try {
      const workflows = join(root, ".github", "workflows");
      mkdirSync(workflows, { recursive: true });
      writeFileSync(
        join(workflows, "callee.yml"),
        `on:
  workflow_call:
    inputs:
      name:
        type: string
        required: true
      kind:
        type: string
        default: '"deployment"'
jobs:
  decode:
    runs-on: ubuntu-latest
    defaults:
      run:
        shell: bash
    steps:
      - env:
          NAME_JSON: \${{ inputs.name }}
          KIND_JSON: \${{ inputs.kind }}
        run: |
          # @pipe env NAME_JSON: string
          # @pipe env KIND_JSON: string
          value="$(jq -er '.' <<< "$NAME_JSON")"
          kind="$(jq -er '.' <<< "$KIND_JSON")"
`,
      );
      const standalone = await checkPaths([join(workflows, "callee.yml")]);
      expect(standalone.complete).toBe(false);
      expect(standalone.diagnostics.map((d) => d.code)).toContain("PIPE203");
      expect(standalone.diagnostics.map((d) => d.code)).not.toContain(
        "PIPE101",
      );
      const caller = join(workflows, "caller.yml");
      const workflow = (value: string) => `jobs:
  call:
    uses: ./.github/workflows/callee.yml
    with:
      name: ${value}
`;
      writeFileSync(caller, workflow("$" + "{{ toJSON('Alice') }}"));
      const good = await checkPaths([caller]);
      expect(good.complete).toBe(true);
      expect(good.diagnostics).toEqual([]);
      expect(good.checkedUnits).toBe(1);
      const callee = join(workflows, "callee.yml");
      const encodedDefault = readFileSync(callee, "utf8");
      writeFileSync(
        callee,
        encodedDefault.replace(
          "default: '\"deployment\"'",
          "default: deployment",
        ),
      );
      const rawDefault = await checkPaths([caller]);
      expect(rawDefault.complete).toBe(false);
      expect(rawDefault.diagnostics.map((d) => d.code)).toContain("PIPE101");
      writeFileSync(callee, encodedDefault);
      writeFileSync(caller, workflow("Alice"));
      const raw = await checkPaths([caller]);
      expect(raw.complete).toBe(false);
      expect(raw.diagnostics.map((d) => d.code)).toContain("PIPE101");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("checks reusable input wires despite an unrelated unsupported action", async () => {
    const root = mkdtempSync(join(tmpdir(), "pipe-ls-partial-reusable-"));
    try {
      const workflows = join(root, ".github", "workflows");
      mkdirSync(workflows, { recursive: true });
      writeFileSync(
        join(workflows, "callee.yml"),
        `on:
  workflow_call:
    inputs:
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
      - uses: third-party/action@v1
      - env:
          NAME_JSON: \${{ inputs.name }}
        run: |
          # @pipe env NAME_JSON: string
          value="$(jq -er '.' <<< "$NAME_JSON")"
`,
      );
      const caller = join(workflows, "caller.yml");
      const call = (value: string) => `jobs:
  decode:
    uses: ./.github/workflows/callee.yml
    with:
      name: ${value}
`;
      writeFileSync(caller, call("$" + "{{ toJSON('Alice') }}"));
      const encoded = await checkPaths([caller]);
      expect(encoded.complete).toBe(false);
      expect(encoded.checkedUnits).toBe(1);
      expect(encoded.diagnostics.map((d) => d.code)).toContain("PIPE203");
      expect(encoded.diagnostics.map((d) => d.code)).not.toContain("PIPE101");
      writeFileSync(caller, call("Alice"));
      const raw = await checkPaths([caller]);
      expect(raw.complete).toBe(false);
      expect(raw.diagnostics.map((d) => d.code)).toContain("PIPE101");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("keeps independent callee file diagnostics when a caller input wire is unverified", async () => {
    const root = mkdtempSync(join(tmpdir(), "pipe-ls-partial-callee-"));
    try {
      const workflows = join(root, ".github", "workflows");
      mkdirSync(workflows, { recursive: true });
      writeFileSync(
        join(workflows, "callee.yml"),
        `on:
  workflow_call:
    inputs:
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
      - uses: actions/checkout@v4
      - run: sed -E '/^[[:space:]]*(#|$)/d' .github/pins.env >> "$GITHUB_ENV"
      - env:
          NAME_JSON: \${{ inputs.name }}
        run: |
          # @pipe env NAME_JSON: string
          jq -c '.' <<< "$NAME_JSON"
`,
      );
      const caller = join(workflows, "caller.yml");
      const report = async (binding: string) => {
        writeFileSync(
          caller,
          `jobs:\n  decode:\n    uses: ./.github/workflows/callee.yml\n    with:\n      name: ${binding}\n`,
        );
        return checkPaths([caller]);
      };
      const unknown = await report("$" + "{{ github.event.issue.title }}");
      expect(unknown.complete).toBe(false);
      expect(
        unknown.diagnostics.some(
          (item) =>
            item.code === "PIPE204" && item.message.includes("pins.env"),
        ),
      ).toBe(true);
      expect(
        unknown.diagnostics.some((item) =>
          item.message.includes("env NAME_JSON injection is not verified"),
        ),
      ).toBe(true);
      expect(unknown.diagnostics.map((item) => item.code)).not.toContain(
        "PIPE101",
      );
      expect(unknown.unverifiedDependencies).toContain(
        pathToFileURL(join(realpathSync(root), ".github", "pins.env")).href,
      );
      const raw = await report("Alice");
      expect(raw.diagnostics.map((item) => item.code)).toContain("PIPE101");
      expect(raw.diagnostics.map((item) => item.code)).toContain("PIPE204");
      writeFileSync(
        caller,
        `jobs:
  first:
    uses: ./.github/workflows/callee.yml
    with:
      name: \${{ github.event.issue.title }}
  second:
    uses: ./.github/workflows/callee.yml
    with:
      name: \${{ github.event.issue.title }}
`,
      );
      const repeated = await checkPaths([caller]);
      expect(
        repeated.diagnostics.filter(
          (item) =>
            item.code === "PIPE204" && item.message.includes("pins.env"),
        ),
      ).toHaveLength(1);
      expect(
        repeated.diagnostics.filter((item) =>
          item.message.includes(
            "Reusable workflow contract is not yet verified",
          ),
        ),
      ).toHaveLength(2);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("checks decoded reusable input conditions without trusting conditional env writes", async () => {
    const root = mkdtempSync(join(tmpdir(), "pipe-ls-reusable-condition-"));
    try {
      const workflows = join(root, ".github", "workflows");
      mkdirSync(workflows, { recursive: true });
      const callee = join(workflows, "callee.yml");
      const caller = join(workflows, "caller.yml");
      const source = (extra = "") => `on:
  workflow_call:
    inputs:
      platform:
        type: string
        required: true
jobs:
  decode:
    runs-on: ubuntu-latest
    defaults:
      run:
        shell: bash
    steps:
      - if: \${{ fromJSON(inputs.platform) == 'aws' }}
        env:
          PLATFORM_JSON: \${{ inputs.platform }}
        run: |
          # @pipe env PLATFORM_JSON: string
          selected="$(jq -er '.' <<< "$PLATFORM_JSON")"
${extra}`;
      writeFileSync(callee, source());
      const call = (value: string) => `jobs:
  restart:
    uses: ./.github/workflows/callee.yml
    with:
      platform: ${value}
`;
      writeFileSync(caller, call("$" + "{{ toJSON('aws') }}"));
      expect((await checkPaths([caller])).diagnostics).toEqual([]);
      writeFileSync(caller, call("aws"));
      expect(
        (await checkPaths([caller])).diagnostics.map((d) => d.code),
      ).toContain("PIPE203");
      writeFileSync(caller, call("$" + "{{ toJSON('aws') }}"));
      writeFileSync(
        callee,
        source(`      - if: \${{ fromJSON(inputs.platform) == 'aws' }}
        run: |
          printf 'VALUE=%s\\n' '"ok"' >> "$GITHUB_ENV"
      - run: |
          # @pipe env VALUE: string
          jq -c '.' <<< "$VALUE"
`),
      );
      const conditionalWrite = await checkPaths([caller]);
      expect(conditionalWrite.complete).toBe(false);
      expect(
        conditionalWrite.diagnostics.some((d) =>
          d.message.includes("env VALUE injection is not verified"),
        ),
      ).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("resolves a fixed GitHub env version file from the project snapshot", async () => {
    const root = mkdtempSync(join(tmpdir(), "pipe-ls-github-env-file-"));
    try {
      const workflows = join(root, ".github", "workflows");
      mkdirSync(workflows, { recursive: true });
      const source = join(root, ".github", "tool-versions.env");
      const workflow = join(workflows, "versions.yml");
      writeFileSync(
        workflow,
        `jobs:
  load:
    runs-on: ubuntu-latest
    defaults:
      run:
        shell: bash
    steps:
      - uses: actions/checkout@v4
      - run: sed -E '/^[[:space:]]*(#|$)/d' .github/tool-versions.env >> "$GITHUB_ENV"
      - run: |
          # @pipe env VERSION_JSON: string
          jq -c '.' <<< "$VERSION_JSON"
`,
      );
      writeFileSync(source, 'VERSION_JSON="1.2.3"\n');
      expect((await checkPaths([workflow])).diagnostics).toEqual([]);
      const baseline = readFileSync(workflow, "utf8");
      writeFileSync(
        workflow,
        baseline.replace("      - uses: actions/checkout@v4\n", ""),
      );
      const noCheckout = await checkPaths([workflow]);
      expect(noCheckout.complete).toBe(false);
      expect(
        noCheckout.diagnostics.some((d) =>
          d.message.includes("Repository checkout is not proven"),
        ),
      ).toBe(true);
      writeFileSync(
        workflow,
        baseline.replace(
          "        shell: bash\n    steps:",
          "        shell: bash\n        working-directory: nested\n    steps:",
        ),
      );
      const unknownCwd = await checkPaths([workflow]);
      expect(unknownCwd.complete).toBe(false);
      expect(
        unknownCwd.diagnostics.some((d) =>
          d.message.includes("GitHub working directory is not proven"),
        ),
      ).toBe(true);
      writeFileSync(workflow, baseline);
      writeFileSync(source, "VERSION_JSON=1.2.3\n");
      expect(
        (await checkPaths([workflow])).diagnostics.map((d) => d.code),
      ).toContain("PIPE101");
      rmSync(source);
      const missing = await checkPaths([workflow]);
      expect(missing.diagnostics.map((d) => d.code)).toContain("PIPE204");
      expect(missing.unverifiedDependencies).toContain(
        pathToFileURL(join(realpathSync(root), ".github", "tool-versions.env"))
          .href,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not report a passing workflow when a run uses an unsupported shell", async () => {
    const root = mkdtempSync(join(tmpdir(), "pipe-ls-shell-"));
    try {
      const path = join(root, ".github", "workflows", "mixed.yml");
      mkdirSync(join(root, ".github", "workflows"), { recursive: true });
      writeFileSync(
        path,
        "jobs:\n  test:\n    steps:\n      - shell: bash\n        run: jq -n '1'\n      - shell: sh\n        run: echo unchecked\n",
      );
      const report = await checkPaths([path]);
      expect(report.complete).toBe(false);
      expect(report.diagnostics.map((item) => item.code)).toContain("PIPE203");
      expect(
        report.diagnostics.some((item) =>
          item.message.includes("non-Bash shell"),
        ),
      ).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("reports unresolved AWS file effects and blocks stale repository reads across direct and reusable workflow steps", async () => {
    const root = mkdtempSync(join(tmpdir(), "pipe-ls-aws-snapshot-"));
    try {
      const directory = join(root, ".github", "workflows");
      const scripts = join(root, ".github", "scripts");
      mkdirSync(directory, { recursive: true });
      mkdirSync(scripts, { recursive: true });
      const path = join(directory, "main.yml");
      const callee = join(directory, "callee.yml");
      const update =
        'set -e\naws eks --region us-west-2 update-kubeconfig --name "cluster" --no-cli-auto-prompt';
      writeFileSync(
        join(scripts, "write.sh"),
        `#!/usr/bin/env bash\n${update}\n`,
      );
      writeFileSync(
        join(scripts, "read.sh"),
        "#!/usr/bin/env bash\njq -n '1'\n",
      );
      writeFileSync(join(root, ".github", "pins.env"), 'NAME="Alice"\n');
      for (const reusable of [false, true]) {
        for (const writer of [update, "./.github/scripts/write.sh"])
          for (const reader of [
            "./.github/scripts/read.sh",
            `sed -E '/^[[:space:]]*(#|$)/d' .github/pins.env >> "$GITHUB_ENV"`,
          ]) {
            const source = (
              restore: boolean,
            ) => `${reusable ? "on:\n  workflow_call: {}\n" : ""}jobs:
  test:
    runs-on: ubuntu-latest
    defaults:
      run:
        shell: bash
    steps:
      - uses: actions/checkout@v4
      - run: |
          ${writer.split("\n").join("\n          ")}
${restore ? "      - uses: actions/checkout@v4\n" : ""}      - run: ${reader}
`;
            if (reusable)
              writeFileSync(
                path,
                "jobs:\n  call:\n    uses: ./.github/workflows/callee.yml\n",
              );
            const target = reusable ? callee : path;
            writeFileSync(target, source(false));
            const blocked = await checkPaths([path]);
            expect(blocked.complete, writer).toBe(false);
            expect(
              blocked.diagnostics.some((issue) => issue.code === "PIPE204"),
              reader,
            ).toBe(true);
            const dependency = reader.startsWith("./")
              ? join(scripts, "read.sh")
              : join(root, ".github", "pins.env");
            expect(blocked.unverifiedDependencies).toContain(
              pathToFileURL(realpathSync(dependency)).href,
            );
            expect(blocked.fileEffectsUnknown).toBe(true);
            expect(blocked.fileEffects).toEqual([]);
            expect(blocked.externalEffects).toContain(
              "aws eks update-kubeconfig",
            );
            writeFileSync(target, source(true));
            const restored = await checkPaths([path]);
            expect(restored.diagnostics, writer).toEqual([]);
            expect(restored.complete).toBe(true);
            expect(restored.fileEffectsUnknown).toBe(true);
          }
      }
      const output: string[] = [];
      expect(
        await runCli(["check", "--json", path], (part) => output.push(part)),
      ).toBe(0);
      expect(JSON.parse(output.join(""))).toMatchObject({
        complete: true,
        fileEffects: [],
        fileEffectsUnknown: true,
        externalEffects: ["aws eks update-kubeconfig"],
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("withholds GitHub env and output facts after unresolved file writes, including inside callees", async () => {
    const root = mkdtempSync(join(tmpdir(), "pipe-ls-aws-github-files-"));
    try {
      const directory = join(root, ".github", "workflows");
      mkdirSync(directory, { recursive: true });
      const main = join(directory, "main.yml");
      const callee = join(directory, "callee.yml");
      const update =
        'aws eks --region us-west-2 update-kubeconfig --name "cluster" --no-cli-auto-prompt';
      const source = (
        reusable: boolean,
        write: boolean,
      ) => `${reusable ? "on:\n  workflow_call: {}\n" : ""}jobs:
  test:
    runs-on: ubuntu-latest
${reusable ? "" : "    outputs:\n      value: $" + "{{ steps.writer.outputs.value }}\n"}    defaults:
      run:
        shell: bash
    steps:
      - run: printf 'NAME=%s\\n' '"Alice"' >> "$GITHUB_ENV"
      - id: writer
        run: |
          set -e
          printf 'value=%s\\n' '"Alice"' >> "$GITHUB_OUTPUT"
          ${write ? update : "jq -n '1' >/dev/null"}
      - run: |
          # @pipe env NAME: string
          jq -c '.' <<< "$NAME"
`;
      for (const reusable of [false, true]) {
        if (reusable)
          writeFileSync(
            main,
            "jobs:\n  call:\n    uses: ./.github/workflows/callee.yml\n",
          );
        const target = reusable ? callee : main;
        writeFileSync(target, source(reusable, true));
        const rejected = await checkPaths([main]);
        expect(rejected.complete).toBe(false);
        expect(rejected.fileEffectsUnknown).toBe(true);
        expect(
          rejected.diagnostics.some((issue) =>
            issue.message.includes("env NAME"),
          ),
        ).toBe(true);
        if (!reusable)
          expect(
            rejected.diagnostics.some((issue) =>
              issue.message.includes(
                "Job output test.value has no verified producing step",
              ),
            ),
          ).toBe(true);
        writeFileSync(target, source(reusable, false));
        const checked = await checkPaths([main]);
        expect(checked.diagnostics).toEqual([]);
        expect(checked.fileEffectsUnknown).toBe(false);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("checks explicit Bash on static runner selectors without inferring runner capabilities", async () => {
    const root = mkdtempSync(join(tmpdir(), "pipe-ls-static-runners-"));
    try {
      const path = join(root, ".github", "workflows", "runners.yml");
      mkdirSync(join(root, ".github", "workflows"), { recursive: true });
      const source = (runner: string) => `jobs:
  test:
    runs-on: ${runner}
    defaults:
      run:
        shell: bash
    steps:
      - run: jq -n '1'
`;
      for (const selector of [
        "aliyun-ack",
        "windows-latest",
        "ubuntu-24.04",
        "[self-hosted, linux, x64]",
      ]) {
        writeFileSync(path, source(selector));
        const checked = await checkPaths([path]);
        expect(checked.diagnostics, selector).toEqual([]);
        expect(checked.complete).toBe(true);
        writeFileSync(
          path,
          source(selector).replace(
            "    defaults:\n      run:\n        shell: bash\n",
            "",
          ),
        );
        const noShell = await checkPaths([path]);
        expect(noShell.complete).toBe(false);
        expect(
          noShell.diagnostics.some(
            (issue) =>
              issue.message === "Bash shell context cannot be established",
          ),
        ).toBe(true);
      }
      writeFileSync(path, source(`'\${{ inputs.runner }}'`));
      const dynamic = await checkPaths([path]);
      expect(dynamic.complete).toBe(false);
      expect(
        dynamic.diagnostics.some(
          (issue) =>
            issue.message === "GitHub runs-on context is not yet analyzed",
        ),
      ).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("checks retry action Bash text without trusting its execution or environment writes", async () => {
    const root = mkdtempSync(join(tmpdir(), "pipe-ls-retry-command-"));
    try {
      const path = join(root, ".github", "workflows", "retry.yml");
      mkdirSync(join(root, ".github", "workflows"), { recursive: true });
      const source = `jobs:
  test:
    runs-on: ubuntu-latest
    defaults:
      run:
        shell: bash
    steps:
      - uses: nick-fields/retry@v3
        with:
          shell: bash
          max_attempts: 3
          command: |
            unknown-business-command
            printf 'NAME=%s\\n' '"Alice"' >> "$GITHUB_ENV"
      - run: |
          # @pipe env NAME: string
          jq -c '.' <<< "$NAME"
`;
      writeFileSync(path, source);
      const report = await checkPaths([path]);
      expect(report.complete).toBe(false);
      const command = report.diagnostics.find((item) =>
        item.message.includes(
          "Command unknown-business-command has no contract",
        ),
      );
      expect(command?.code).toBe("PIPE201");
      expect(command?.range.start.line).toBe(
        source.slice(0, source.indexOf("unknown-business-command")).split("\n")
          .length - 1,
      );
      expect(
        report.diagnostics.some((item) =>
          item.message.includes("env NAME has no statically proven injection"),
        ),
      ).toBe(true);
      expect(report.externalEffects).not.toContain("unknown-business-command");
      writeFileSync(
        path,
        source.replace(
          "unknown-business-command",
          "echo $" + "{{ inputs.script }}",
        ),
      );
      const dynamic = await checkPaths([path]);
      expect(
        dynamic.diagnostics.some((item) =>
          item.message.includes("Opaque action command contains"),
        ),
      ).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("checks both retry bodies with their YAML env bindings and original locations", async () => {
    const root = mkdtempSync(join(tmpdir(), "pipe-ls-retry-bindings-"));
    try {
      const path = join(root, ".github", "workflows", "retry.yml");
      mkdirSync(join(root, ".github", "workflows"), { recursive: true });
      const source = (value: string) => `jobs:
  test:
    steps:
      - uses: nick-fields/retry@v3
        env:
          NAME: ${value}
          ALTERNATE_NAME: ${value}
        with:
          shell: bash
          command: |
            # @pipe env NAME: string
            jq -c '.' <<< "$NAME"
          new_command_on_retry: |
            # @pipe env ALTERNATE_NAME: string
            unknown-alternate-command "$ALTERNATE_NAME"
`;
      writeFileSync(path, source(`'"Alice"'`));
      const report = await checkPaths([path]);
      expect(report.checkedUnits).toBe(2);
      expect(report.complete).toBe(false);
      expect(
        report.diagnostics.some((issue) => issue.message.includes("env NAME")),
      ).toBe(false);
      const alternate = report.diagnostics.find((issue) =>
        issue.message.includes(
          "Command unknown-alternate-command has no contract",
        ),
      );
      expect(alternate?.code).toBe("PIPE201");
      const text = source(`'"Alice"'`);
      expect(alternate?.range.start.line).toBe(
        text.slice(0, text.indexOf("unknown-alternate-command")).split("\n")
          .length - 1,
      );
      for (const [value, code] of [
        ["Alice", "PIPE101"],
        ["42", "PIPE102"],
      ] as const) {
        writeFileSync(path, source(value));
        const invalid = await checkPaths([path]);
        expect(
          invalid.diagnostics.filter((issue) => issue.code === code),
        ).toHaveLength(2);
      }
      writeFileSync(
        path,
        text.replace(
          "unknown-alternate-command",
          "echo $" + "{{ inputs.script }}",
        ),
      );
      const dynamic = await checkPaths([path]);
      expect(dynamic.diagnostics).toContainEqual(
        expect.objectContaining({
          code: "PIPE203",
          message:
            "Opaque action command contains an unanalyzed GitHub expression",
        }),
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("never executes retry commands, alternate commands or cleanup hooks", async () => {
    const root = mkdtempSync(join(tmpdir(), "pipe-ls-retry-no-execution-"));
    try {
      const folder = join(root, ".github", "workflows");
      mkdirSync(folder, { recursive: true });
      const path = join(folder, "retry.yml");
      const marker = join(root, "EXECUTED");
      writeFileSync(
        path,
        `jobs:
  test:
    steps:
      - uses: nick-fields/retry@v3
        with:
          shell: bash
          command: printf 'executed' > "${marker}"
          new_command_on_retry: printf 'executed' > "${marker}"
          on_retry_command: printf 'executed' > "${marker}"
`,
      );
      const report = await checkPaths([path]);
      expect(report.complete).toBe(false);
      expect(report.checkedUnits).toBe(2);
      expect(report.diagnostics).toContainEqual(
        expect.objectContaining({
          code: "PIPE203",
          message: "Retry hook shell context cannot be established",
        }),
      );
      expect(existsSync(marker)).toBe(false);
      const output: string[] = [];
      expect(
        await runCli(["check", "--json", path], (part) => output.push(part)),
      ).toBe(1);
      expect(JSON.parse(output.join("")).complete).toBe(false);
      expect(existsSync(marker)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("checks an opaque-only reusable workflow against the actual caller's JSON input wires", async () => {
    const root = mkdtempSync(join(tmpdir(), "pipe-ls-retry-caller-"));
    try {
      const folder = join(root, ".github", "workflows");
      mkdirSync(folder, { recursive: true });
      const caller = join(folder, "caller.yml");
      const callee = join(folder, "callee.yml");
      writeFileSync(
        callee,
        `on:
  workflow_call:
    inputs:
      name:
        type: string
        required: true
jobs:
  test:
    steps:
      - uses: nick-fields/retry@v3
        env:
          NAME: \${{ inputs.name }}
        with:
          shell: bash
          command: |
            # @pipe env NAME: string
            jq -c '.' <<< "$NAME"
`,
      );
      const source = (value: string) => `jobs:
  call:
    uses: ./.github/workflows/callee.yml
    with:
      name: '${value}'
`;
      writeFileSync(caller, source('"Alice"'));
      const validWire = await checkPaths([caller]);
      expect(validWire.complete).toBe(false);
      expect(validWire.checkedUnits).toBe(1);
      expect(
        validWire.diagnostics.some((issue) =>
          issue.message.includes("env NAME"),
        ),
      ).toBe(false);
      expect(
        validWire.diagnostics.some(
          (issue) =>
            issue.message === "GitHub uses context is not yet analyzed",
        ),
      ).toBe(true);
      for (const [value, code] of [
        ["Alice", "PIPE101"],
        ["42", "PIPE102"],
      ] as const) {
        writeFileSync(caller, source(value));
        const report = await checkPaths([caller]);
        expect(report.diagnostics).toContainEqual(
          expect.objectContaining({
            code,
            uri: pathToFileURL(realpathSync(callee)).href,
          }),
        );
      }
      const standalone = await checkPaths([callee]);
      expect(standalone.diagnostics).toContainEqual(
        expect.objectContaining({
          code: "PIPE203",
          message: "GitHub env NAME expression is not yet analyzed",
        }),
      );
      expect(
        standalone.diagnostics.some((issue) => issue.code === "PIPE101"),
      ).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("summarizes modeled retry body effects but never propagates its env or output proofs", async () => {
    const root = mkdtempSync(join(tmpdir(), "pipe-ls-retry-effects-"));
    try {
      const folder = join(root, ".github", "workflows");
      mkdirSync(folder, { recursive: true });
      const path = join(folder, "retry.yml");
      for (const update of [false, true]) {
        writeFileSync(
          path,
          `jobs:
  test:
    defaults:
      run:
        shell: bash
    outputs:
      value: \${{ steps.retried.outputs.exit_code }}
    steps:
      - run: printf 'OLD=%s\\n' '"before"' >> "$GITHUB_ENV"
      - id: retried
        uses: nick-fields/retry@v3
        with:
          shell: bash
          command: |
            set -e
            printf 'NAME=%s\\n' '"inside"' >> "$GITHUB_ENV"
            printf 'exit_code=%s\\n' '0' >> "$GITHUB_OUTPUT"
${update ? '            aws eks --region us-west-2 update-kubeconfig --name "cluster" --no-cli-auto-prompt\n' : ""}      - run: |
          # @pipe env NAME: string
          # @pipe env OLD: string
          jq -c '.' <<< "$NAME"
`,
        );
        const report = await checkPaths([path]);
        expect(report.complete).toBe(false);
        expect(report.fileEffectsUnknown).toBe(update);
        expect(report.externalEffects).toEqual(
          update ? ["aws eks update-kubeconfig"] : [],
        );
        for (const name of ["NAME", "OLD"])
          expect(
            report.diagnostics.some((issue) =>
              issue.message.includes(
                `env ${name} has no statically proven injection`,
              ),
            ),
          ).toBe(true);
        expect(report.diagnostics).toContainEqual(
          expect.objectContaining({
            code: "PIPE203",
            message: "Job output test.value has no verified producing step",
          }),
        );
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("propagates only verified GITHUB_ENV writes to later steps in the same job", async () => {
    const root = mkdtempSync(join(tmpdir(), "pipe-ls-github-env-flow-"));
    try {
      const path = join(root, ".github", "workflows", "flow.yml");
      mkdirSync(join(root, ".github", "workflows"), { recursive: true });
      const workflow = (
        write: string,
        condition = "",
        otherJob = false,
      ) => `jobs:
  first:
    defaults:
      run:
        shell: bash
    steps:
      - ${condition}run: |
          ${write.split("\n").join("\n          ")}
${otherJob ? "  second:\n    defaults:\n      run:\n        shell: bash\n    steps:\n" : ""}      - run: |
          # @pipe env NAME: string
          jq -c '.' <<< "$NAME"
`;
      writeFileSync(
        path,
        workflow(
          `printf 'NAME=%s\\n' "$(jq -cn --arg value 'Alice' '$value')" >> "$GITHUB_ENV"`,
        ),
      );
      expect((await checkPaths([path])).diagnostics).toEqual([]);
      writeFileSync(
        path,
        workflow(`printf 'NAME=%s\\n' 'Alice' >> "$GITHUB_ENV"`),
      );
      expect(
        (await checkPaths([path])).diagnostics.map((d) => d.code),
      ).toContain("PIPE101");
      writeFileSync(
        path,
        workflow(
          `printf 'NAME=%s\\n' '"Alice"' >> "$GITHUB_ENV"`,
          "if: $" + "{{ inputs.enabled }}\n        ",
        ),
      );
      expect(
        (await checkPaths([path])).diagnostics.some((d) =>
          d.message.includes("no statically proven injection"),
        ),
      ).toBe(true);
      writeFileSync(
        path,
        workflow(`# @pipe env INPUT: string
printf 'NAME=%s\\n' "$(jq -cn --arg value "$INPUT" '$value')" >> "$GITHUB_ENV"`),
      );
      const unverified = await checkPaths([path]);
      expect(
        unverified.diagnostics.filter((d) =>
          d.message.includes("no statically proven injection"),
        ),
      ).toHaveLength(2);
      writeFileSync(
        path,
        workflow(`printf 'NAME=%s\\n' '"Alice"' >> "$GITHUB_ENV"`, "", true),
      );
      expect(
        (await checkPaths([path])).diagnostics.some((d) =>
          d.message.includes("no statically proven injection"),
        ),
      ).toBe(true);
      writeFileSync(
        path,
        `jobs:
  first:
    defaults:
      run:
        shell: bash
    steps:
      - run: |
          printf 'NAME=%s\\n' '42' >> "$GITHUB_ENV"
      - env:
          NAME: '"Alice"'
        run: |
          # @pipe env NAME: string
          jq -c '.' <<< "$NAME"
`,
      );
      const overridden = await checkPaths([path]);
      expect(overridden.diagnostics).toEqual([]);
      expect(overridden.complete).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not trust protected GITHUB_ENV names or partial env-file writes", async () => {
    const root = mkdtempSync(join(tmpdir(), "pipe-ls-protected-github-env-"));
    try {
      const workflow = join(root, ".github", "workflows", "flow.yml");
      const pins = join(root, ".github", "pins.env");
      mkdirSync(join(root, ".github", "workflows"), { recursive: true });
      const source = (writer: string, name: string) => `jobs:
  test:
    runs-on: ubuntu-latest
    defaults:
      run:
        shell: bash
    steps:
      - uses: actions/checkout@v4
      - run: ${writer}
      - run: |
          # @pipe env ${name}: string
          jq -c '.' <<< "$${name}"
`;
      writeFileSync(
        workflow,
        source(
          `printf 'NODE_OPTIONS=%s\\n' '"spoofed"' >> "$GITHUB_ENV"`,
          "NODE_OPTIONS",
        ),
      );
      const direct = await checkPaths([workflow]);
      expect(direct.complete).toBe(false);
      expect(
        direct.diagnostics.some((issue) =>
          issue.message.includes(
            "NODE_OPTIONS cannot be set through GITHUB_ENV",
          ),
        ),
      ).toBe(true);
      expect(
        direct.diagnostics.some((issue) =>
          issue.message.includes("no statically proven injection"),
        ),
      ).toBe(true);
      writeFileSync(pins, 'NAME="Alice"\nNODE_OPTIONS=SECRET_MARKER\n');
      writeFileSync(
        workflow,
        source(
          `sed -E '/^[[:space:]]*(#|$)/d' .github/pins.env >> "$GITHUB_ENV"`,
          "NAME",
        ),
      );
      const filtered = await checkPaths([workflow]);
      expect(filtered.complete).toBe(false);
      expect(
        filtered.diagnostics.some((issue) =>
          issue.message.includes(
            "NODE_OPTIONS cannot be set through GITHUB_ENV",
          ),
        ),
      ).toBe(true);
      expect(
        filtered.diagnostics.some((issue) =>
          issue.message.includes(
            "GitHub env NAME has no statically proven injection",
          ),
        ),
      ).toBe(true);
      expect(JSON.stringify(filtered)).not.toContain("SECRET_MARKER");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not reuse an env fact across a conditional overwrite", async () => {
    const root = mkdtempSync(join(tmpdir(), "pipe-ls-conditional-env-"));
    try {
      const workflows = join(root, ".github", "workflows");
      mkdirSync(workflows, { recursive: true });
      const body = `    runs-on: ubuntu-latest
    defaults:
      run:
        shell: bash
    steps:
      - run: printf 'NAME=%s\\n' '"A"' >> "$GITHUB_ENV"
      - if: inputs.enabled == 'yes'
        run: printf 'NAME=%s\\n' '"B"' >> "$GITHUB_ENV"
      - run: |
          # @pipe env NAME: "A"
          jq -c '.' <<< "$NAME"
`;
      const ordinary = join(workflows, "ordinary.yml");
      writeFileSync(
        ordinary,
        `on:
  workflow_dispatch:
    inputs:
      enabled:
        type: string
jobs:
  test:
${body}`,
      );
      const direct = await checkPaths([ordinary]);
      expect(direct.complete).toBe(false);
      expect(
        direct.diagnostics.some((issue) =>
          issue.message.includes(
            "GitHub env NAME has no statically proven injection",
          ),
        ),
      ).toBe(true);
      writeFileSync(
        ordinary,
        `on:
  workflow_dispatch:
    inputs:
      enabled:
        type: string
jobs:
  test:
    runs-on: ubuntu-latest
    defaults:
      run:
        shell: bash
    steps:
      - run: printf 'NAME=%s\\n' '"A"' >> "$GITHUB_ENV"
      - env:
          FLAG_JSON: \${{ toJSON(inputs.enabled) }}
        run: |
          # @pipe env FLAG_JSON: string
          flag="$(jq -er '.' <<< "$FLAG_JSON")"
          if [[ "$flag" == yes ]]; then printf 'NAME=%s\\n' '"B"' >> "$GITHUB_ENV"; fi
      - run: |
          # @pipe env NAME: "A"
          jq -c '.' <<< "$NAME"
`,
      );
      const internal = await checkPaths([ordinary]);
      expect(internal.complete).toBe(false);
      expect(
        internal.diagnostics.some((issue) =>
          issue.message.includes(
            "GitHub env NAME has no statically proven injection",
          ),
        ),
      ).toBe(true);
      const callee = join(workflows, "callee.yml");
      writeFileSync(
        callee,
        `on:
  workflow_call:
    inputs:
      enabled:
        type: string
        required: true
jobs:
  test:
${body}`,
      );
      const caller = join(workflows, "caller.yml");
      writeFileSync(
        caller,
        "jobs:\n  call:\n    uses: ./.github/workflows/callee.yml\n    with:\n      enabled: yes\n",
      );
      const called = await checkPaths([caller]);
      expect(called.complete).toBe(false);
      expect(
        called.diagnostics.some((issue) =>
          issue.message.includes(
            "Reusable workflow env NAME injection is not verified",
          ),
        ),
      ).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("invalidates prior GITHUB_ENV facts across an opaque action step", async () => {
    const root = mkdtempSync(join(tmpdir(), "pipe-ls-action-env-barrier-"));
    try {
      const workflow = join(root, ".github", "workflows", "flow.yml");
      mkdirSync(join(root, ".github", "workflows"), { recursive: true });
      const source = (actionBeforeWrite: boolean) => `jobs:
  test:
    runs-on: ubuntu-latest
    defaults:
      run:
        shell: bash
    steps:
${actionBeforeWrite ? "      - uses: third-party/action@v1\n" : ""}      - run: printf 'NAME=%s\\n' '"Alice"' >> "$GITHUB_ENV"
${actionBeforeWrite ? "" : "      - uses: third-party/action@v1\n"}      - run: |
          # @pipe env NAME: string
          jq -c '.' <<< "$NAME"
`;
      writeFileSync(workflow, source(false));
      const after = await checkPaths([workflow]);
      expect(after.complete).toBe(false);
      expect(
        after.diagnostics.some((issue) =>
          issue.message.includes(
            "GitHub env NAME has no statically proven injection",
          ),
        ),
      ).toBe(true);
      writeFileSync(workflow, source(true));
      const before = await checkPaths([workflow]);
      expect(before.complete).toBe(false);
      expect(
        before.diagnostics.some((issue) =>
          issue.message.includes(
            "GitHub env NAME has no statically proven injection",
          ),
        ),
      ).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not trust repository files after an opaque action until checkout runs again", async () => {
    const root = mkdtempSync(join(tmpdir(), "pipe-ls-action-file-barrier-"));
    try {
      const workflow = join(root, ".github", "workflows", "flow.yml");
      const pins = join(root, ".github", "pins.env");
      mkdirSync(join(root, ".github", "workflows"), { recursive: true });
      writeFileSync(pins, 'NAME="Alice"\n');
      const source = (restore: boolean) => `jobs:
  test:
    runs-on: ubuntu-latest
    defaults:
      run:
        shell: bash
    steps:
      - uses: actions/checkout@v4
      - uses: third-party/action@v1
${restore ? "      - uses: actions/checkout@v4\n" : ""}      - run: sed -E '/^[[:space:]]*(#|$)/d' .github/pins.env >> "$GITHUB_ENV"
      - run: |
          # @pipe env NAME: string
          jq -c '.' <<< "$NAME"
`;
      writeFileSync(workflow, source(false));
      const uncertain = await checkPaths([workflow]);
      expect(uncertain.complete).toBe(false);
      expect(uncertain.unverifiedDependencies).toContain(
        pathToFileURL(realpathSync(pins)).href,
      );
      expect(
        uncertain.diagnostics.some((issue) =>
          issue.message.includes(
            "Repository contents may have changed after an unverified action",
          ),
        ),
      ).toBe(true);
      expect(
        uncertain.diagnostics.some((issue) =>
          issue.message.includes(
            "GitHub env NAME has no statically proven injection",
          ),
        ),
      ).toBe(true);
      writeFileSync(workflow, source(true));
      const restored = await checkPaths([workflow]);
      expect(restored.complete).toBe(false);
      expect(restored.unverifiedDependencies).not.toContain(
        pathToFileURL(realpathSync(pins)).href,
      );
      expect(
        restored.diagnostics.some((issue) =>
          issue.message.includes(
            "Repository contents may have changed after an unverified action",
          ),
        ),
      ).toBe(false);
      expect(
        restored.diagnostics.some((issue) =>
          issue.message.includes(
            "GitHub env NAME has no statically proven injection",
          ),
        ),
      ).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not reuse a repository snapshot after an unverified run", async () => {
    const root = mkdtempSync(join(tmpdir(), "pipe-ls-run-file-barrier-"));
    try {
      const workflow = join(root, ".github", "workflows", "flow.yml");
      const pins = join(root, ".github", "pins.env");
      mkdirSync(join(root, ".github", "workflows"), { recursive: true });
      writeFileSync(pins, 'NAME="Alice"\n');
      const source = (restore: boolean) => `jobs:
  test:
    runs-on: ubuntu-latest
    defaults:
      run:
        shell: bash
    steps:
      - uses: actions/checkout@v4
      - run: unknown-business-command
${restore ? "      - uses: actions/checkout@v4\n" : ""}      - run: sed -E '/^[[:space:]]*(#|$)/d' .github/pins.env >> "$GITHUB_ENV"
      - run: |
          # @pipe env NAME: string
          jq -c '.' <<< "$NAME"
`;
      writeFileSync(workflow, source(false));
      const uncertain = await checkPaths([workflow]);
      expect(uncertain.complete).toBe(false);
      expect(uncertain.unverifiedDependencies).toContain(
        pathToFileURL(realpathSync(pins)).href,
      );
      expect(
        uncertain.diagnostics.some((issue) =>
          issue.message.includes(
            "Repository contents may have changed after an unverified run",
          ),
        ),
      ).toBe(true);
      writeFileSync(workflow, source(true));
      const restored = await checkPaths([workflow]);
      expect(restored.complete).toBe(false);
      expect(
        restored.diagnostics.some((issue) =>
          issue.message.includes(
            "Repository contents may have changed after an unverified run",
          ),
        ),
      ).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("blocks local script contracts after opaque repository changes", async () => {
    const root = mkdtempSync(join(tmpdir(), "pipe-ls-action-script-barrier-"));
    try {
      const workflow = join(root, ".github", "workflows", "flow.yml");
      mkdirSync(join(root, ".github", "workflows"), { recursive: true });
      writeFileSync(
        join(root, "child.sh"),
        "#!/usr/bin/env bash\n# @pipe stdout: number\njq -n '42'\n",
      );
      const source = (restore: boolean) => `jobs:
  test:
    runs-on: ubuntu-latest
    defaults:
      run:
        shell: bash
    steps:
      - uses: actions/checkout@v4
      - uses: third-party/action@v1
${restore ? "      - uses: actions/checkout@v4\n" : ""}      - run: ./child.sh
`;
      writeFileSync(workflow, source(false));
      const uncertain = await checkPaths([workflow]);
      expect(uncertain.complete).toBe(false);
      expect(uncertain.unverifiedDependencies).toContain(
        pathToFileURL(realpathSync(join(root, "child.sh"))).href,
      );
      expect(
        uncertain.diagnostics.some(
          (issue) =>
            issue.code === "PIPE204" &&
            issue.message.includes("Local script dependency is unavailable"),
        ),
      ).toBe(true);
      writeFileSync(workflow, source(true));
      const restored = await checkPaths([workflow]);
      expect(restored.complete).toBe(false);
      expect(restored.diagnostics.map((issue) => issue.code)).not.toContain(
        "PIPE204",
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("requires a verified GITHUB_OUTPUT producer for every explicit job output", async () => {
    const root = mkdtempSync(join(tmpdir(), "pipe-ls-job-output-"));
    try {
      const path = join(root, ".github", "workflows", "output.yml");
      mkdirSync(join(root, ".github", "workflows"), { recursive: true });
      const workflow = (body: string) => `jobs:
  first:
    defaults:
      run:
        shell: bash
    outputs:
      result: \${{ steps.setup.outputs.result }}
    steps:
      - id: setup
        run: |
          ${body}
`;
      writeFileSync(
        path,
        workflow("printf 'result=%s\\n' '42' >> \"$GITHUB_OUTPUT\""),
      );
      expect((await checkPaths([path])).diagnostics).toEqual([]);
      writeFileSync(
        path,
        workflow("printf 'other=%s\\n' '42' >> \"$GITHUB_OUTPUT\""),
      );
      expect(
        (await checkPaths([path])).diagnostics.map((d) => d.code),
      ).toContain("PIPE104");
      writeFileSync(path, workflow("unknown-business-command"));
      expect(
        (await checkPaths([path])).diagnostics.some((d) =>
          d.message.includes("no verified producing step"),
        ),
      ).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("types needs output env injections in dependency order, including JSON double encoding", async () => {
    const root = mkdtempSync(join(tmpdir(), "pipe-ls-needs-output-"));
    try {
      const path = join(root, ".github", "workflows", "needs.yml");
      mkdirSync(join(root, ".github", "workflows"), { recursive: true });
      const workflow = (binding: string, emitted: string) => `jobs:
  consumer:
    needs: producer
    defaults:
      run:
        shell: bash
    steps:
      - env:
          VALUE_JSON: ${binding}
        run: |
          # @pipe env VALUE_JSON: number
          jq -c '.' <<< "$VALUE_JSON"
  producer:
    defaults:
      run:
        shell: bash
    outputs:
      value: \${{ steps.emit.outputs.value }}
    steps:
      - id: emit
        run: |
          ${emitted}
`;
      const direct = "$" + "{{ needs.producer.outputs.value }}";
      const encoded = "$" + "{{ toJSON(needs.producer.outputs.value) }}";
      const decoded =
        "$" + "{{ toJSON(fromJSON(needs.producer.outputs.value)) }}";
      writeFileSync(
        path,
        workflow(direct, `printf 'value=%s\\n' '42' >> "$GITHUB_OUTPUT"`),
      );
      expect((await checkPaths([path])).diagnostics).toEqual([]);
      writeFileSync(
        path,
        workflow(encoded, `printf 'value=%s\\n' '42' >> "$GITHUB_OUTPUT"`),
      );
      expect(
        (await checkPaths([path])).diagnostics.map((d) => d.code),
      ).toContain("PIPE102");
      writeFileSync(
        path,
        workflow(decoded, `printf 'value=%s\\n' '42' >> "$GITHUB_OUTPUT"`),
      );
      expect((await checkPaths([path])).diagnostics).toEqual([]);
      writeFileSync(
        path,
        workflow(direct, `printf 'value=%s\\n' 'Alice' >> "$GITHUB_OUTPUT"`),
      );
      expect(
        (await checkPaths([path])).diagnostics.map((d) => d.code),
      ).toContain("PIPE101");
      writeFileSync(path, workflow(direct, "unknown-business-command"));
      expect(
        (await checkPaths([path])).diagnostics.some((d) =>
          d.message.includes("expression is not yet analyzed"),
        ),
      ).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("uses a necessary job guard when typing local reusable workflow inputs", async () => {
    const root = mkdtempSync(join(tmpdir(), "pipe-ls-reusable-guard-"));
    try {
      const workflows = join(root, ".github", "workflows");
      mkdirSync(workflows, { recursive: true });
      writeFileSync(
        join(workflows, "restart.yml"),
        "on:\n  workflow_call:\n    inputs:\n      namespace:\n        type: string\n        required: true\n      name:\n        type: string\n        required: true\njobs:\n  run:\n    steps: []\n",
      );
      const caller = join(workflows, "caller.yml");
      const source = `on:
  workflow_dispatch:
    inputs:
      enabled:
        type: boolean
jobs:
  update:
    defaults:
      run:
        shell: bash
    outputs:
      restart: \${{ steps.setup.outputs.restart }}
    steps:
      - id: setup
        env:
          ENABLED: \${{ toJSON(inputs.enabled) }}
        run: |
          # @pipe env ENABLED: boolean
          if [[ "$ENABLED" == true ]]; then
            printf 'restart=%s\\n' '{}' >> "$GITHUB_OUTPUT"
          else
            printf 'restart=%s\\n' '{"aws":{"namespace":"prod","deployments":["app"]}}' >> "$GITHUB_OUTPUT"
          fi
  restart:
    needs: update
    if: \${{ fromJSON(needs.update.outputs.restart).aws != null }}
    uses: ./.github/workflows/restart.yml
    with:
      namespace: \${{ toJSON(fromJSON(needs.update.outputs.restart).aws.namespace) }}
      name: \${{ toJSON(join(fromJSON(needs.update.outputs.restart).aws.deployments, ' ')) }}
`;
      writeFileSync(caller, source);
      const guarded = await checkPaths([caller]);
      expect(
        guarded.diagnostics.some((d) =>
          d.message.includes("input namespace expression"),
        ),
      ).toBe(false);
      expect(
        guarded.diagnostics.some((d) =>
          d.message.includes("input name expression"),
        ),
      ).toBe(false);
      expect(guarded.diagnostics.map((d) => d.code)).toContain("PIPE202");
      writeFileSync(
        caller,
        source.replace(
          "if: $" + "{{ fromJSON(needs.update.outputs.restart).aws != null }}",
          "if: $" + "{{ true }}",
        ),
      );
      const unguarded = await checkPaths([caller]);
      expect(
        unguarded.diagnostics.some((d) =>
          d.message.includes("input namespace expression"),
        ),
      ).toBe(true);
      expect(
        unguarded.diagnostics.some((d) =>
          d.message.includes("input name expression"),
        ),
      ).toBe(true);
      writeFileSync(
        caller,
        source.replace(
          "if: $" + "{{ fromJSON(needs.update.outputs.restart).aws != null }}",
          "if: $" +
            "{{ true || fromJSON(needs.update.outputs.restart).aws != null }}",
        ),
      );
      expect(
        (await checkPaths([caller])).diagnostics.some((d) =>
          d.message.includes("input namespace expression"),
        ),
      ).toBe(true);
      writeFileSync(
        caller,
        source.replace(
          "if: $" + "{{ fromJSON(needs.update.outputs.restart).aws != null }}",
          "if: $" +
            "{{ !cancelled() && fromJSON(needs.update.outputs.restart).aws != null }}",
        ),
      );
      expect(
        (await checkPaths([caller])).diagnostics.some((d) =>
          d.message.includes("input namespace expression"),
        ),
      ).toBe(true);
      writeFileSync(
        caller,
        source.replace(
          "if: $" + "{{ fromJSON(needs.update.outputs.restart).aws != null }}",
          "if: $" +
            "{{ !cancelled() && needs.update.result == 'success' && fromJSON(needs.update.outputs.restart).aws != null }}",
        ),
      );
      expect(
        (await checkPaths([caller])).diagnostics.some((d) =>
          d.message.includes("input namespace expression"),
        ),
      ).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("checks step output conditions and requires an explicit status guard for skipped needs", async () => {
    const root = mkdtempSync(join(tmpdir(), "pipe-ls-conditions-"));
    try {
      const path = join(root, ".github", "workflows", "condition.yml");
      mkdirSync(join(root, ".github", "workflows"), { recursive: true });
      const workflow = (stepOutput: string, guard: string) => `jobs:
  first:
    defaults:
      run:
        shell: bash
    steps:
      - id: emit
        run: |
          printf 'flag=%s\\n' 'true' >> "$GITHUB_OUTPUT"
      - if: steps.emit.outputs.${stepOutput} == 'true'
        run: jq -n '1'
  second:
    needs: first
    if: \${{ ${guard}needs.first.result == 'skipped' }}
    defaults:
      run:
        shell: bash
    steps:
      - run: jq -n '1'
`;
      writeFileSync(path, workflow("flag", "!cancelled() && "));
      expect((await checkPaths([path])).diagnostics).toEqual([]);
      writeFileSync(path, workflow("missing", "!cancelled() && "));
      expect(
        (await checkPaths([path])).diagnostics.some((d) =>
          d.message.includes("GitHub step if expression"),
        ),
      ).toBe(true);
      writeFileSync(path, workflow("flag", ""));
      expect(
        (await checkPaths([path])).diagnostics.some((d) =>
          d.message.includes("GitHub job if expression"),
        ),
      ).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("blocks status-override steps before trusting a previous GITHUB_ENV write", async () => {
    const root = mkdtempSync(join(tmpdir(), "pipe-ls-step-status-"));
    try {
      const path = join(root, ".github", "workflows", "status.yml");
      mkdirSync(join(root, ".github", "workflows"), { recursive: true });
      const source = (condition: string) => `jobs:
  test:
    defaults:
      run:
        shell: bash
    steps:
      - run: |
          printf 'READY=%s\\n' '"ok"' >> "$GITHUB_ENV"
      - ${condition}run: |
          # @pipe env READY: string
          jq -c '.' <<< "$READY"
`;
      writeFileSync(path, source(""));
      expect((await checkPaths([path])).diagnostics).toEqual([]);
      writeFileSync(path, source("if: $" + "{{ !cancelled() }}\n        "));
      const changed = await checkPaths([path]);
      expect(changed.complete).toBe(false);
      expect(
        changed.diagnostics.some(
          (issue) =>
            issue.code === "PIPE203" &&
            issue.message.includes("GitHub step if expression"),
        ),
      ).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not assume a needs output exists when a status function bypasses implicit success", async () => {
    const root = mkdtempSync(join(tmpdir(), "pipe-ls-needs-presence-"));
    try {
      const path = join(root, ".github", "workflows", "presence.yml");
      mkdirSync(join(root, ".github", "workflows"), { recursive: true });
      const source = (guard: string, suffix = "") => `jobs:
  first:
    outputs:
      flag: \${{ steps.emit.outputs.flag }}
    defaults:
      run:
        shell: bash
    steps:
      - id: emit
        run: |
          printf 'flag=%s\\n' '"ok"' >> "$GITHUB_OUTPUT"
  second:
    needs: first
    if: \${{ ${guard}needs.first.outputs.flag == '"ok"'${suffix} }}
    defaults:
      run:
        shell: bash
    steps:
      - run: jq -n '1'
`;
      writeFileSync(path, source("!cancelled() && "));
      expect(
        (await checkPaths([path])).diagnostics.some((issue) =>
          issue.message.includes("GitHub job if expression"),
        ),
      ).toBe(true);
      writeFileSync(
        path,
        source("!cancelled() && needs.first.result == 'success' && "),
      );
      expect((await checkPaths([path])).diagnostics).toEqual([]);
      writeFileSync(
        path,
        source(
          "!cancelled() && needs.first.result == 'success' && ",
          " || true",
        ),
      );
      expect(
        (await checkPaths([path])).diagnostics.some((issue) =>
          issue.message.includes("GitHub job if expression"),
        ),
      ).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("resolves multi-hop local calls once and blocks dependency cycles", async () => {
    const root = mkdtempSync(join(tmpdir(), "pipe-ls-local-graph-"));
    try {
      mkdirSync(join(root, ".github", "workflows"), { recursive: true });
      const workflow = join(root, ".github", "workflows", "main.yml");
      const middle = join(root, "middle.sh");
      const child = join(root, "child.sh");
      writeFileSync(
        workflow,
        "jobs:\n  test:\n    defaults:\n      run:\n        shell: bash\n    steps:\n      - uses: actions/checkout@v4\n      - run: |\n          # @pipe stdout: number\n          ./middle.sh\n",
      );
      writeFileSync(
        middle,
        "#!/usr/bin/env bash\n# @pipe stdout: number\n./child.sh\n",
      );
      writeFileSync(
        child,
        "#!/usr/bin/env bash\n# @pipe stdout: number\njq -n '42'\n",
      );
      expect((await checkPaths([root])).diagnostics).toEqual([]);
      writeFileSync(
        child,
        "#!/usr/bin/env bash\n# @pipe stdout: number\n./middle.sh\n",
      );
      const cycle = await checkPaths([root]);
      expect(cycle.complete).toBe(false);
      expect(cycle.diagnostics.some((item) => item.code === "PIPE202")).toBe(
        true,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("checks GitHub toJSON env injection against the run contract", async () => {
    const root = mkdtempSync(join(tmpdir(), "pipe-ls-env-"));
    try {
      mkdirSync(join(root, ".github", "workflows"), { recursive: true });
      const path = join(root, ".github", "workflows", "env.yml");
      const workflow = (binding: string) =>
        "on:\n  workflow_dispatch:\n    inputs:\n      name:\n        type: string\n        required: true\njobs:\n  test:\n    defaults:\n      run:\n        shell: bash\n    steps:\n      - env:\n          NAME_JSON: " +
        binding +
        "\n        run: |\n          # @pipe env NAME_JSON: string\n          # @pipe stdout: string\n          jq -c '.' <<< \"$NAME_JSON\"\n";
      writeFileSync(path, workflow("$" + "{{ toJSON(inputs.name) }}"));
      expect((await checkPaths([path])).diagnostics).toEqual([]);
      writeFileSync(path, workflow("Alice"));
      expect(
        (await checkPaths([path])).diagnostics.map((item) => item.code),
      ).toEqual(["PIPE101"]);
      writeFileSync(path, workflow("$" + "{{ inputs.name }}"));
      expect(
        (await checkPaths([path])).diagnostics.map((item) => item.code),
      ).toEqual(["PIPE101"]);
      writeFileSync(path, workflow("42"));
      expect(
        (await checkPaths([path])).diagnostics.map((item) => item.code),
      ).toEqual(["PIPE102"]);
      writeFileSync(
        path,
        workflow("$" + "{{ toJSON(inputs.name) }}").replace(
          "required: true",
          "required: false",
        ),
      );
      expect(
        (await checkPaths([path])).diagnostics.map((item) => item.code),
      ).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects consumption of an undeclared reusable workflow output", async () => {
    const root = mkdtempSync(join(tmpdir(), "pipe-ls-reusable-output-"));
    try {
      mkdirSync(join(root, ".github", "workflows"), { recursive: true });
      const caller = join(root, ".github", "workflows", "caller.yml");
      const callee = join(root, ".github", "workflows", "callee.yml");
      writeFileSync(
        caller,
        `jobs:
  call:
    uses: ./.github/workflows/callee.yml
  consumer:
    needs: call
    if: \${{ needs.call.outputs.result == 'ok' }}
    steps: []
`,
      );
      writeFileSync(
        callee,
        "on: workflow_dispatch\njobs:\n  work:\n    steps: []\n",
      );
      expect(
        (await checkPaths([caller])).diagnostics.map((item) => item.code),
      ).toContain("PIPE104");
      writeFileSync(
        callee,
        `on:
  workflow_call:
    outputs:
      result:
        value: \${{ jobs.work.outputs.result }}
jobs:
  work:
    steps: []
`,
      );
      expect(
        (await checkPaths([caller])).diagnostics.map((item) => item.code),
      ).not.toContain("PIPE104");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
