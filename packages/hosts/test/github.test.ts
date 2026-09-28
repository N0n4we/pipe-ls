import { describe, expect, it } from "vitest";
import {
  extractGithubWorkflow,
  MAX_WORKFLOW_YAML_ALIASES,
  MAX_WORKFLOW_YAML_DEPTH,
  MAX_WORKFLOW_YAML_NODES,
} from "../src/index.js";

describe("GitHub workflow run extraction", () => {
  it("does not copy malformed YAML source into syntax diagnostics", () => {
    const secret = "SECRET_MARKER_MUST_NOT_LEAK";
    for (const source of [
      `jobs:\n  test:\n    steps:\n      - run: [${secret}\n`,
      `jobs:\n  test:\n    steps:\n      - run: "bad\\q${secret}"\n`,
      `jobs:\n  test: ${secret}: another\n`,
    ]) {
      const result = extractGithubWorkflow(source);
      expect(result.issues.length).toBeGreaterThan(0);
      expect(result.issues.every((issue) => issue.code === "PIPE001")).toBe(
        true,
      );
      expect(JSON.stringify(result.issues)).not.toContain(secret);
      for (const issue of result.issues) {
        expect(issue.message).toMatch(
          /^Workflow YAML syntax error \([A-Z_0-9]+\)$/u,
        );
        expect(issue.span.start).toBeGreaterThanOrEqual(0);
        expect(issue.span.end).toBeLessThanOrEqual(source.length);
      }
    }
  });

  it("bounds YAML nodes, nesting and aliases before analyzing any run", () => {
    const base = `jobs:
  test:
    runs-on: ubuntu-latest
    defaults:
      run:
        shell: bash
    steps:
      - run: echo ok
`;
    const ordinary = extractGithubWorkflow(base);
    expect(ordinary.issues).toEqual([]);
    expect(ordinary.runs).toHaveLength(1);

    const tooManyNodes = `${base}spare: [${Array.from(
      { length: MAX_WORKFLOW_YAML_NODES + 1 },
      () => "0",
    ).join(", ")}]\n`;
    const deeplyNested = `${base}spare:\n${Array.from(
      { length: MAX_WORKFLOW_YAML_DEPTH + 2 },
      (_, index) => `${"  ".repeat(index + 1)}child:\n`,
    ).join("")}  ${"  ".repeat(MAX_WORKFLOW_YAML_DEPTH + 2)}end: value\n`;
    const tooManyAliases = `${base}anchor: &item value\nspare:\n${"  - *item\n".repeat(MAX_WORKFLOW_YAML_ALIASES + 1)}`;
    const overBudget: readonly (readonly [string, string])[] = [
      [tooManyNodes, "node"],
      [deeplyNested, "depth"],
      [tooManyAliases, "alias"],
    ];
    for (const [source, name] of overBudget) {
      const result = extractGithubWorkflow(source);
      expect(result.runs, name).toEqual([]);
      expect(result.issues, name).toEqual([
        expect.objectContaining({
          code: "PIPE203",
          message: `Workflow YAML ${name} budget exceeded`,
        }),
      ]);
    }
  });

  it("keeps original YAML positions and shell inheritance", () => {
    const source =
      "defaults:\n  run:\n    shell: bash\njobs:\n  test:\n    steps:\n      - run: |\n          # @pipe stdout: number\n          jq -n '1, 2'\n      - shell: sh\n        run: echo ignored\n  downstream:\n    uses: ./.github/workflows/missing.yml\n";
    const result = extractGithubWorkflow(source);
    expect(result.issues).toEqual([]);
    expect(result.runs.map((run) => run.shell)).toEqual(["bash", "other"]);
    const first = result.runs[0];
    expect(first).toBeDefined();
    if (!first) return;
    const offset = first.script.indexOf("jq -n");
    const original = first.map.mapSpan({ start: offset, end: offset + 2 });
    expect(source.slice(original.span.start, original.span.end)).toBe("jq");
    expect(result.dependencies.map((item) => item.path)).toEqual([
      "./.github/workflows/missing.yml",
    ]);
  });

  it("extracts Bash embedded in retry@v3 without trusting the action", () => {
    const source = `jobs:
  test:
    steps:
      - uses: nick-fields/retry@v3
        with:
          shell: bash
          max_attempts: 3
          command: |
            set -e
            unknown-business-command
`;
    const result = extractGithubWorkflow(source);
    expect(result.issues.map((item) => item.code)).toContain("PIPE203");
    expect(result.runs).toHaveLength(0);
    expect(result.unverifiedSteps).toEqual([{ jobId: "test", stepIndex: 0 }]);
    expect(result.opaqueCommands).toHaveLength(1);
    const command = result.opaqueCommands[0];
    expect(command?.script).toContain("unknown-business-command");
    if (!command) return;
    const start = command.script.indexOf("unknown-business-command");
    const mapped = command.map.mapSpan({
      start,
      end: start + "unknown-business-command".length,
    });
    expect(source.slice(mapped.span.start, mapped.span.end)).toBe(
      "unknown-business-command",
    );
    expect(
      extractGithubWorkflow(source.replace("shell: bash", "shell: sh"))
        .opaqueCommands,
    ).toEqual([]);
  });

  it("retains step order across trusted checkout and opaque action barriers", () => {
    const result = extractGithubWorkflow(`jobs:
  test:
    defaults:
      run:
        shell: bash
    steps:
      - uses: actions/checkout@v4
      - run: echo first
      - uses: third-party/action@v1
      - run: echo second
`);
    expect(result.runs.map((run) => run.stepIndex)).toEqual([1, 3]);
    expect(result.unverifiedSteps).toEqual([{ jobId: "test", stepIndex: 2 }]);
  });

  it("blocks inherited working directories until path resolution is modeled", () => {
    const source =
      "defaults:\n  run:\n    shell: bash\n    working-directory: nested\njobs:\n  test:\n    steps:\n      - run: ./child.sh\n";
    const result = extractGithubWorkflow(source);
    expect(result.runs).toHaveLength(1);
    expect(result.runs[0]?.rootWorkingDirectory).toBe(false);
    expect(result.issues.map((item) => item.code)).toEqual(["PIPE203"]);
    expect(
      source.slice(result.issues[0]?.span.start, result.issues[0]?.span.end),
    ).toBe("nested");
  });

  it("reports references to missing explicit job outputs", () => {
    const source = `jobs:
  update:
    outputs:
      target: \${{ steps.setup.outputs.target }}
    steps: []
  next:
    needs: update
    if: \${{ needs.update.outputs.target == 'yes' && needs.update.outputs.missing == 'no' }}
    steps: []
`;
    const result = extractGithubWorkflow(source);
    expect(
      result.issues
        .filter((issue) => issue.code === "PIPE104")
        .map((issue) => issue.message),
    ).toEqual(["Job output update.missing has no explicit mapping"]);
  });

  it("keeps optional inputs with GitHub's typed empty defaults", () => {
    const source = `on:
  workflow_dispatch:
    inputs:
      label:
        type: string
        required: false
      enabled:
        type: boolean
      count:
        type: number
jobs:
  test:
    steps: []
`;
    expect(extractGithubWorkflow(source).inputs).toEqual({
      label: { kind: "primitive", name: "string" },
      enabled: { kind: "primitive", name: "boolean" },
      count: { kind: "primitive", name: "number" },
    });
  });

  it("requires needs edges for output and result references", () => {
    const source = `jobs:
  first:
    outputs:
      value: one
    steps: []
  second:
    if: \${{ needs.first.result == 'success' && needs.first.outputs.value == 'one' }}
    steps: []
  third:
    needs: [first, absent]
    if: \${{ needs.first.outputs.value == 'one' }}
    steps: []
`;
    const result = extractGithubWorkflow(source);
    expect(result.issues.map((issue) => issue.message)).toContain(
      "Job first is referenced without a needs dependency",
    );
    expect(result.issues.map((issue) => issue.message)).toContain(
      "Job needs unknown dependency absent",
    );
    expect(
      result.issues.filter((issue) =>
        issue.message.includes("without a needs dependency"),
      ),
    ).toHaveLength(2);
  });

  it("extracts reusable workflow input declarations and caller with bindings", () => {
    const callee = extractGithubWorkflow(`on:
  workflow_call:
    inputs:
      name:
        type: string
        required: true
      retries:
        type: number
      kind:
        type: string
        default: '"deployment"'
jobs:
  test:
    steps: []
`);
    expect(callee.workflowCallable).toBe(true);
    expect(callee.workflowCallInputs).toEqual({
      name: { type: { kind: "primitive", name: "string" }, required: true },
      retries: {
        type: { kind: "primitive", name: "number" },
        required: false,
        defaultValue: 0,
      },
      kind: {
        type: { kind: "primitive", name: "string" },
        required: false,
        defaultValue: '"deployment"',
      },
    });
    const caller = extractGithubWorkflow(`jobs:
  test:
    uses: ./.github/workflows/callee.yml
    with:
      name: alice
      retries: 3
`);
    expect(caller.dependencies[0]?.with).toMatchObject({
      name: { scalar: "alice" },
      retries: { scalar: 3 },
    });
  });

  it("blocks a reusable input declaration without a declared GitHub type", () => {
    const result = extractGithubWorkflow(`on:
  workflow_call:
    inputs:
      value:
        required: true
jobs:
  test:
    steps: []
`);
    expect(result.workflowCallInputs).toBeUndefined();
    expect(result.issues.map((issue) => issue.code)).toContain("PIPE203");
  });

  it("extracts reusable secret names without retaining their values", () => {
    const callee = extractGithubWorkflow(`on:
  workflow_call:
    secrets:
      TOKEN:
        required: true
      OPTIONAL:
        required: false
jobs:
  test:
    steps: []
`);
    expect(callee.workflowCallSecrets).toEqual({
      TOKEN: true,
      OPTIONAL: false,
    });
    const caller = extractGithubWorkflow(`jobs:
  test:
    uses: ./.github/workflows/callee.yml
    secrets:
      TOKEN: \${{ secrets.PRIVATE_TOKEN }}
`);
    expect(caller.dependencies[0]?.secrets).toEqual(["TOKEN"]);
    expect(JSON.stringify(caller.dependencies)).not.toContain("PRIVATE_TOKEN");
    const inherited = extractGithubWorkflow(`jobs:
  test:
    uses: ./.github/workflows/callee.yml
    secrets: inherit
`);
    expect(inherited.dependencies[0]?.secrets).toBe("inherit");
    const malformed = extractGithubWorkflow(`on:
  workflow_call:
    secrets:
      TOKEN:
        required: yes
jobs:
  test:
    steps: []
`);
    expect(malformed.workflowCallSecrets).toBeUndefined();
    expect(malformed.issues.map((issue) => issue.code)).toContain("PIPE203");
  });

  it("rejects a reusable job that also declares local steps", () => {
    const result = extractGithubWorkflow(`jobs:
  call:
    uses: ./.github/workflows/callee.yml
    steps:
      - run: jq -n '1'
`);
    expect(result.issues.map((issue) => issue.code)).toContain("PIPE104");
  });

  it("blocks YAML aliases in run bodies rather than treating their target as verified Bash", () => {
    const workflow = extractGithubWorkflow(`x-script: &body |
  jq -n '1'
jobs:
  test:
    defaults:
      run:
        shell: bash
    steps:
      - run: *body
`);
    expect(workflow.runs).toEqual([]);
    expect(workflow.issues.map((issue) => issue.code)).toContain("PIPE203");
  });

  it("blocks execution modifiers that can invalidate a run or its output guarantees", () => {
    const base = `jobs:
  test:
    defaults:
      run:
        shell: bash
    steps:
      - run: jq -n '1'
`;
    for (const changed of [
      base.replace("    steps:", "    continue-on-error: true\n    steps:"),
      base.replace("    steps:", "    container: alpine:latest\n    steps:"),
      base.replace("    steps:", "    services: {}\n    steps:"),
      base.replace("    steps:", "    runs-on: windows-latest\n    steps:"),
      base.replace(
        "      - run:",
        "      - continue-on-error: true\n        run:",
      ),
      base.replace("      - run:", "      - timeout-minutes: 1\n        run:"),
      base.replace(
        "      - run:",
        "      - with:\n          value: ignored\n        run:",
      ),
      base.replace("      - run:", "      - shell: false\n        run:"),
      base.replace("        shell: bash", "        shell: false"),
    ])
      expect(
        extractGithubWorkflow(changed).issues.map((issue) => issue.code),
        changed,
      ).toContain("PIPE203");
  });

  it("models only known unconditional checkout forms and their step order", () => {
    const workflow = (uses: string, ref: string) => `jobs:
  test:
    steps:
      - uses: ${uses}
        with:
          ref: ${ref}
`;
    expect(
      extractGithubWorkflow(workflow("actions/checkout@v4", "main")).issues,
    ).toEqual([]);
    const ordered = extractGithubWorkflow(`jobs:
  test:
    steps:
      - run: jq -n '1'
      - uses: actions/checkout@v4
      - run: jq -n '2'
`);
    expect(ordered.issues).toEqual([]);
    expect(ordered.runs.map((run) => run.repositoryAvailable)).toEqual([
      false,
      true,
    ]);
    const conditional = extractGithubWorkflow(`jobs:
  test:
    steps:
      - if: \${{ true }}
        uses: actions/checkout@v4
      - run: jq -n '1'
`);
    expect(conditional.runs[0]?.repositoryAvailable).toBe(false);
    expect(
      extractGithubWorkflow(
        workflow("actions/checkout@v4", "feature"),
      ).issues.map((issue) => issue.code),
    ).toContain("PIPE203");
    expect(
      extractGithubWorkflow(
        workflow("third-party/action@v1", "main"),
      ).issues.map((issue) => issue.code),
    ).toContain("PIPE203");
    expect(
      extractGithubWorkflow(
        workflow("actions/checkout@v4", "main").replace(
          "        with:",
          "        continue-on-error: true\n        with:",
        ),
      ).issues.map((issue) => issue.code),
    ).toContain("PIPE203");
  });
});
