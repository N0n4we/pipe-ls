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
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { MAX_SOURCE_BYTES } from "@pipe-ls/workspace";
import { describe, expect, it } from "vitest";
import { checkPaths, runCli } from "../src/index.js";

describe("CLI static check", () => {
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
      const run = (input: string) =>
        `jobs:\n  test:\n    defaults:\n      run:\n        shell: bash\n    steps:\n      - run: |\n          # @pipe stdout: number\n          value=$(./child.sh <<< '${input}')\n          printf '%s\\n' "$value"\n`;
      writeFileSync(
        child,
        "#!/usr/bin/env bash\n# @pipe stdin: number\n# @pipe stdout: number\njq -c '.'\n",
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
      expect(
        (await checkPaths([path])).diagnostics.some((d) =>
          d.message.includes("precedence is not yet analyzed"),
        ),
      ).toBe(true);
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
        "jobs:\n  test:\n    defaults:\n      run:\n        shell: bash\n    steps:\n      - run: |\n          # @pipe stdout: number\n          ./middle.sh\n",
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
