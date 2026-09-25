import { describe, expect, it } from "vitest";
import {
  extractGithubWorkflow,
  MAX_WORKFLOW_YAML_ALIASES,
  MAX_WORKFLOW_YAML_DEPTH,
  MAX_WORKFLOW_YAML_NODES,
} from "../src/index.js";

describe("GitHub workflow run extraction", () => {
  it("extracts only an explicit AWS IAM envelope without retaining literal credential bytes", () => {
    const source = `jobs:
  test:
    steps:
      - uses: aws-actions/configure-aws-credentials@v4
        id: aws
        with:
          aws-region: us-west-2
          aws-access-key-id: SYNTHETIC_KEY_DO_NOT_RETAIN
          aws-secret-access-key: SYNTHETIC_SECRET_DO_NOT_RETAIN
          output-env-credentials: true
          role-chaining: false
          use-existing-credentials: false
`;
    const result = extractGithubWorkflow(source);
    expect(result.issues).toEqual([]);
    expect(result.unverifiedSteps).toEqual([]);
    expect(result.actions[0]?.actionModel).toMatchObject({
      kind: "aws-credentials",
      region: "us-west-2",
      roleFromEnvironment: true,
      roleChaining: false,
      useExisting: false,
      accessKey: { source: { kind: "literal", nonBlank: true } },
      secretKey: { source: { kind: "literal", nonBlank: true } },
    });
    expect(JSON.stringify(result)).not.toContain("SYNTHETIC_KEY_DO_NOT_RETAIN");
    expect(JSON.stringify(result)).not.toContain(
      "SYNTHETIC_SECRET_DO_NOT_RETAIN",
    );
    const blanks = extractGithubWorkflow(
      source.replace("SYNTHETIC_KEY_DO_NOT_RETAIN", "'  '"),
    );
    expect(blanks.actions[0]?.actionModel).toMatchObject({
      accessKey: { source: { kind: "literal", nonBlank: false } },
    });
    for (const changed of [
      source.replace("role-chaining: false", "role-chaining: true"),
      source.replace(
        "use-existing-credentials: false",
        "use-existing-credentials: true",
      ),
      source.replace(
        "output-env-credentials: true",
        "output-env-credentials: false",
      ),
      source.replace(
        "output-env-credentials: true",
        "output-env-credentials: 'TRUE'",
      ),
      source.replace(
        "aws-region: us-west-2",
        `aws-region: \${{ inputs.region }}`,
      ),
      source.replace("aws-region: us-west-2", "aws-region: 'invalid region'"),
      source.replace(
        "aws-region: us-west-2",
        "aws-region: us-west-2\n          role-to-assume: arn:aws:iam::synthetic:role/other",
      ),
      source.replace("role-chaining: false", "role-chaining: maybe"),
      source.replace(
        "role-chaining: false",
        "role-chaining: false\n          unknown: true",
      ),
      source.replace(
        "        with:",
        "        continue-on-error: true\n        with:",
      ),
      source.replace(
        "        with:",
        "        timeout-minutes: 1\n        with:",
      ),
    ]) {
      expect(extractGithubWorkflow(changed).actions).toEqual([]);
      expect(
        extractGithubWorkflow(changed).issues.some(
          (issue) => issue.code === "PIPE203",
        ),
      ).toBe(true);
    }
  });

  it("extracts 1Password envelopes without retaining configure inputs or closing secret output names", () => {
    const source = `jobs:
  test:
    steps:
      - uses: 1password/load-secrets-action/configure@v2
        with:
          service-account-token: SECRET_MARKER_DO_NOT_RETAIN
      - uses: 1password/load-secrets-action@v2
        id: load
        with:
          export-env: 'FALSE'
          unset-previous: 'True'
      - shell: bash
        env:
          VALUE: \${{ steps.load.outputs.INHERITED_REFERENCE }}
        run: printf '%s' "$VALUE"
`;
    const result = extractGithubWorkflow(source);
    expect(result.issues).toEqual([]);
    expect(result.actions.map((unit) => unit.actionModel)).toEqual([
      { kind: "onepassword-configure" },
      { kind: "onepassword-load", exportEnv: false, unsetPrevious: true },
    ]);
    expect(result.actions.map((unit) => unit.stepIndex)).toEqual([0, 1]);
    expect(result.unverifiedSteps).toEqual([]);
    expect(result.runs[0]?.repositoryContentsVerified).toBe(false);
    expect(JSON.stringify(result)).not.toContain("SECRET_MARKER_DO_NOT_RETAIN");
    const defaults = extractGithubWorkflow(
      source.replace(
        "        with:\n          export-env: 'FALSE'\n          unset-previous: 'True'\n",
        "",
      ),
    );
    expect(defaults.actions[1]?.actionModel).toEqual({
      kind: "onepassword-load",
      exportEnv: true,
      unsetPrevious: false,
    });
    expect(defaults.issues.some((issue) => issue.code === "PIPE104")).toBe(
      true,
    );
  });

  it("keeps dynamic options, unknown inputs and execution modifiers outside 1Password envelopes", () => {
    const source = `jobs:\n  test:\n    steps:\n      - uses: 1password/load-secrets-action@v2\n        with:\n          export-env: false\n`;
    for (const modified of [
      source.replace("false", "1"),
      source.replace("false", "''"),
      source.replace("false", `'\${{ inputs.export }}'`),
      source.replace("false", "false\n          unknown: false"),
      source.replace("false", "false\n          unset-previous: perhaps"),
      source.replace(
        "        with:",
        "        timeout-minutes: 1\n        with:",
      ),
      source.replace(
        "        with:",
        "        continue-on-error: true\n        with:",
      ),
      source.replace(
        "        with:",
        "        run: printf 'not an Action'\n        with:",
      ),
    ]) {
      const result = extractGithubWorkflow(modified);
      expect(result.actions).toEqual([]);
      expect(result.unverifiedSteps).toEqual([{ jobId: "test", stepIndex: 0 }]);
      expect(result.issues.some((issue) => issue.code === "PIPE203")).toBe(
        true,
      );
    }
    const configure = source
      .replace("action@v2", "action/configure@v2")
      .replace(
        "export-env: false",
        `service-account-token: \${{ secrets.TOKEN }}`,
      );
    expect(extractGithubWorkflow(configure).actions).toHaveLength(1);
    expect(
      extractGithubWorkflow(configure.replace("secrets.TOKEN", "unknown()"))
        .actions,
    ).toEqual([]);
  });

  it("models only a static bounded retry envelope and runner-injected INPUT precedence, without promising child completion", () => {
    const source = `jobs:
  test:
    steps:
      - uses: actions/checkout@v4
      - uses: nick-fields/retry@v3
        id: retry
        env:
          INPUT_MAX_ATTEMPTS: ignored
          INPUT_ON_RETRY_COMMAND: ignored
        with:
          shell: bash
          max_attempts: 3
          timeout_seconds: 30
          continue_on_error: true
          retry_on: timeout
          retry_on_exit_code: 1
          warning_on_retry: false
          retry_wait_seconds: 0
          polling_interval_seconds: 0
          command: |
            printf 'main'
          new_command_on_retry: |
            printf 'alternate'
          on_retry_command: '  '
`;
    const result = extractGithubWorkflow(source);
    expect(result.issues).toEqual([]);
    expect(result.unverifiedSteps).toEqual([]);
    expect(result.opaqueCommands).toHaveLength(2);
    for (const unit of result.opaqueCommands) {
      expect(unit.retryModel).toEqual({
        maxAttempts: 3,
        timeoutMilliseconds: 30_000,
      });
      expect(unit.executionUnverified).toBe(true);
      expect(unit.repositoryContentsVerified).toBe(false);
      expect(unit.env.INPUT_MAX_ATTEMPTS?.text).toBe("3");
      expect(unit.env.INPUT_ON_RETRY_COMMAND?.text).toBe("  ");
      expect(unit.env.INPUT_TIMEOUT_MINUTES?.text).toBe("");
      expect(unit.env.INPUT_COMMAND?.text).toBe("printf 'main'\n");
      expect(unit.stepEnvNames).toContain("INPUT_TIMEOUT_MINUTES");
    }
    const one = extractGithubWorkflow(
      source.replace("max_attempts: 3", "max_attempts: 1"),
    );
    expect(one.issues).toEqual([]);
    expect(one.opaqueCommands.map((unit) => unit.commandInput)).toEqual([
      "command",
    ]);
    const defaults = extractGithubWorkflow(
      source.replace("          max_attempts: 3\n", ""),
    );
    expect(defaults.opaqueCommands[0]?.retryModel?.maxAttempts).toBe(3);
    expect(defaults.opaqueCommands[0]?.env.INPUT_MAX_ATTEMPTS?.text).toBe("3");
  });

  it("keeps unsupported retry options, dynamic envelopes and nonempty default-shell hooks blocked", () => {
    const source = `jobs:\n  test:\n    steps:\n      - uses: nick-fields/retry@v3\n        with:\n          shell: bash\n          max_attempts: 3\n          timeout_minutes: 5\n          command: printf 'main'\n`;
    for (const invalid of [
      source.replace("max_attempts: 3", "max_attempts: 0"),
      source.replace("max_attempts: 3", "max_attempts: -1"),
      source.replace("max_attempts: 3", "max_attempts: '3garbage'"),
      source.replace(
        "max_attempts: 3",
        `max_attempts: '\${{ inputs.attempts }}'`,
      ),
      source.replace("timeout_minutes: 5", "timeout_minutes: 0"),
      source.replace(
        "timeout_minutes: 5",
        "timeout_minutes: 5\n          timeout_seconds: 30",
      ),
      source.replace("timeout_minutes: 5", "timeout_minutes: '5minutes'"),
      source.replace("          timeout_minutes: 5\n", ""),
      source.replace("shell: bash", "shell: 'bash -e'"),
      source.replace("shell: bash", "shell: sh"),
      source.replace("shell: bash", `shell: '\${{ inputs.shell }}'`),
      source.replace(
        "command: printf 'main'",
        `command: '\${{ inputs.command }}'`,
      ),
      source.replace("command: printf 'main'", "command: ''"),
      source.replace("max_attempts: 3", "max_attempts: [3]"),
      source.replace(
        "max_attempts: 3",
        "max_attempts: 3\n          unknown_input: 1",
      ),
      source.replace(
        "max_attempts: 3",
        "max_attempts: 3\n          continue_on_error: maybe",
      ),
      source.replace(
        "max_attempts: 3",
        "max_attempts: 3\n          retry_wait_seconds: -1",
      ),
      source.replace(
        "max_attempts: 3",
        "max_attempts: 3\n          polling_interval_seconds: '1s'",
      ),
      source.replace(
        "max_attempts: 3",
        "max_attempts: 3\n          retry_on: unknown",
      ),
      source.replace(
        "max_attempts: 3",
        "max_attempts: 3\n          retry_on_exit_code: 256",
      ),
      source.replace(
        "max_attempts: 3",
        "max_attempts: 3\n          warning_on_retry: maybe",
      ),
      source.replace(
        "max_attempts: 3",
        "max_attempts: 3\n          on_retry_command: printf 'hook'",
      ),
      source.replace(
        "        with:",
        "        continue-on-error: true\n        with:",
      ),
      source.replace(
        "        with:",
        "        timeout-minutes: 1\n        with:",
      ),
      source.replace(
        "        with:",
        "        working-directory: nested\n        with:",
      ),
    ]) {
      const result = extractGithubWorkflow(invalid);
      expect(
        result.issues.map((issue) => issue.code),
        invalid,
      ).toContain("PIPE203");
      expect(
        result.opaqueCommands.every((unit) => !unit.retryModel),
        invalid,
      ).toBe(true);
      expect(result.unverifiedSteps, invalid).toEqual([
        { jobId: "test", stepIndex: 0 },
      ]);
    }
  });

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
    expect(result.runs.map((run) => run.repositoryContentsVerified)).toEqual([
      true,
      false,
    ]);
    expect(result.unverifiedSteps).toEqual([{ jobId: "test", stepIndex: 2 }]);
  });

  it("retains retry body bindings and inspects alternate commands without trusting the action", () => {
    const source = `env:
  NAME: '"workflow"'
jobs:
  test:
    env:
      NAME: '"job"'
    defaults:
      run:
        working-directory: nested
        shell: sh
    steps:
      - uses: actions/checkout@v4
      - id: retry
        if: \${{ true }}
        uses: nick-fields/retry@v3
        env:
          NAME: '"step"'
        with:
          shell: bash
          command: |
            jq -c '.' <<< "$NAME"
          new_command_on_retry: |
            unknown-alternate-command
`;
    const result = extractGithubWorkflow(source);
    expect(result.opaqueCommands.map((body) => body.commandInput)).toEqual([
      "command",
      "new_command_on_retry",
    ]);
    for (const body of result.opaqueCommands) {
      expect(body).toMatchObject({
        shell: "bash",
        jobId: "test",
        stepId: "retry",
        stepIndex: 1,
        conditional: true,
        executionUnverified: true,
        repositoryAvailable: true,
        repositoryContentsVerified: false,
        repositoryCheckoutGeneration: 1,
        rootWorkingDirectory: true,
        env: { NAME: { text: '"step"' } },
      });
    }
    const alternate = result.opaqueCommands[1];
    if (!alternate) throw new Error("Missing alternate command");
    const start = alternate.script.indexOf("unknown-alternate-command");
    const mapped = alternate.map.mapSpan({
      start,
      end: start + "unknown-alternate-command".length,
    });
    expect(source.slice(mapped.span.start, mapped.span.end)).toBe(
      "unknown-alternate-command",
    );
  });

  it("does not assume the retry hook uses with.shell", () => {
    const source = `jobs:
  test:
    steps:
      - uses: nick-fields/retry@v3
        with:
          shell: bash
          command: echo main
          on_retry_command: echo cleanup
`;
    const result = extractGithubWorkflow(source);
    expect(result.opaqueCommands).toHaveLength(1);
    const hook = result.issues.find((issue) =>
      issue.message.includes("Retry hook shell context"),
    );
    expect(hook?.code).toBe("PIPE203");
    expect(source.slice(hook?.span.start, hook?.span.end)).toBe("echo cleanup");
    expect(
      extractGithubWorkflow(
        source.replace(
          "on_retry_command: echo cleanup",
          "on_retry_command: ''",
        ),
      ).issues.some((issue) => issue.message.includes("Retry hook")),
    ).toBe(false);
    for (const shell of ["sh", `'\${{ inputs.shell }}'`])
      expect(
        extractGithubWorkflow(source.replace("shell: bash", `shell: ${shell}`))
          .opaqueCommands,
      ).toEqual([]);
  });

  it("checks retry output names without proving their presence or values", () => {
    const source = (name: string) => `jobs:
  test:
    steps:
      - id: retried
        uses: nick-fields/retry@v3
        with:
          command: echo main
      - uses: third-party/action@v1
        with:
          value: \${{ steps.retried.outputs.${name} }}
`;
    for (const name of ["total_attempts", "exit_code", "exit_error"])
      expect(
        extractGithubWorkflow(source(name)).issues.map((issue) => issue.code),
      ).not.toContain("PIPE104");
    const result = extractGithubWorkflow(source("stdout"));
    expect(result.issues).toContainEqual(
      expect.objectContaining({
        code: "PIPE104",
        message: "Action step retried does not declare output stdout",
      }),
    );
    expect(result.unverifiedSteps).toHaveLength(2);
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
      base.replace(
        "    steps:",
        `    runs-on: '\${{ inputs.runner }}'\n    steps:`,
      ),
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

  it("separates static runner selection from explicit shell, OS and tool availability", () => {
    const source = (runner: string, shell = "bash") => `jobs:
  test:
    runs-on: ${runner}
    defaults:
      run:
        shell: ${shell}
    steps:
      - run: jq -n '1'
`;
    for (const selector of [
      "aliyun-ack",
      "ubuntu-22.04",
      "windows-latest",
      "[self-hosted, linux, x64, aliyun-ack]",
    ]) {
      const result = extractGithubWorkflow(source(selector));
      expect(result.issues, selector).toEqual([]);
      expect(result.runs[0]?.shell).toBe("bash");
      expect(
        extractGithubWorkflow(source(selector, "pwsh")).runs[0]?.shell,
      ).toBe("other");
      const noShell = extractGithubWorkflow(
        source(selector).replace(
          "    defaults:\n      run:\n        shell: bash\n",
          "",
        ),
      );
      expect(noShell.runs[0]?.shell).toBe("unknown");
    }
    for (const selector of [
      "[]",
      "''",
      "[self-hosted, 1]",
      "{group: selected}",
      `'\${{ inputs.runner }}'`,
      JSON.stringify("x".repeat(129)),
      `[${Array.from({ length: 33 }, () => "linux").join(",")}]`,
    ])
      expect(
        extractGithubWorkflow(source(selector)).issues.some(
          (issue) =>
            issue.message === "GitHub runs-on context is not yet analyzed",
        ),
        selector,
      ).toBe(true);
  });

  it("checks prior step and known action output names without trusting action effects or secrets", () => {
    const source = (
      exportEnv = "false",
      producer = "load",
      output = "VALUE",
    ) => `jobs:
  test:
    defaults:
      run:
        shell: bash
    steps:
      - uses: 1password/load-secrets-action@v2
        id: load
        with:
          export-env: ${exportEnv}
        env:
          VALUE: op://vault/item/value
      - uses: aws-actions/configure-aws-credentials@v4
        with:
          aws-access-key-id: \${{ steps.${producer}.outputs.${output} }}
          aws-secret-access-key: SECRET_MARKER_NEVER_LOG
          aws-region: us-west-2
      - env:
          VALUE_JSON: \${{ toJSON(steps.${producer}.outputs.${output}) }}
        run: jq -n '1'
`;
    const permitted = extractGithubWorkflow(source());
    expect(permitted.issues.some((issue) => issue.code === "PIPE104")).toBe(
      false,
    );
    expect(permitted.unverifiedSteps).toEqual([]);
    expect(permitted.actions[1]?.actionModel.kind).toBe("aws-credentials");
    expect(permitted.actions[0]?.actionModel).toEqual({
      kind: "onepassword-load",
      exportEnv: false,
      unsetPrevious: false,
    });
    expect(permitted.runs[0]?.repositoryContentsVerified).toBe(false);
    for (const disabled of ["true", "'true'"]) {
      const result = extractGithubWorkflow(source(disabled));
      const issues = result.issues.filter((issue) => issue.code === "PIPE104");
      expect(issues).toHaveLength(2);
      expect(
        issues.every(
          (issue) =>
            issue.message === "Action step load does not declare output VALUE",
        ),
      ).toBe(true);
      expect(JSON.stringify(result)).not.toContain("SECRET_MARKER_NEVER_LOG");
      for (const issue of issues)
        expect(
          source(disabled).slice(issue.span.start, issue.span.end),
        ).toContain("steps.load.outputs.VALUE");
    }
    expect(
      extractGithubWorkflow(source("false", "missing")).issues.filter(
        (issue) => issue.code === "PIPE104",
      ),
    ).toHaveLength(2);
    const configured = source("true").replace(
      "1password/load-secrets-action@v2",
      "1password/load-secrets-action/configure@v2",
    );
    expect(
      extractGithubWorkflow(configured).issues.filter(
        (issue) => issue.code === "PIPE104",
      ),
    ).toHaveLength(2);
    const aws = source().replace(
      "1password/load-secrets-action@v2",
      "aws-actions/configure-aws-credentials@v4",
    );
    expect(
      extractGithubWorkflow(aws).issues.filter(
        (issue) => issue.code === "PIPE104",
      ),
    ).toHaveLength(2);
    expect(
      extractGithubWorkflow(
        aws.replaceAll("outputs.VALUE", "outputs.aws-account-id"),
      ).issues.some((issue) => issue.code === "PIPE104"),
    ).toBe(false);
    // helpers.exportAccountId sets this source-declared output even though
    // the manifest does not list it. Names must cover actual production.
    expect(
      extractGithubWorkflow(
        aws.replaceAll("outputs.VALUE", "outputs.authenticated-arn"),
      ).issues.some((issue) => issue.code === "PIPE104"),
    ).toBe(false);
    // A dynamic option and inherited op:// references must stay open; absence
    // of a field from the step's env is not evidence that no output exists.
    expect(
      extractGithubWorkflow(
        source(`'\${{ inputs.export }}'`, "load", "INHERITED_VALUE"),
      ).issues.some((issue) => issue.code === "PIPE104"),
    ).toBe(false);
  });

  it("does not treat self, future, other-job or quoted lookalikes as available step output producers", () => {
    const source = (binding: string) => `jobs:
  other:
    steps:
      - id: future
        run: jq -n '1'
  test:
    steps:
      - id: first
        env:
          VALUE: ${binding}
        run: jq -n '1'
      - id: future
        run: jq -n '1'
`;
    for (const binding of [
      `\${{ steps.first.outputs.value }}`,
      `\${{ steps.future.outputs.value }}`,
      `\${{ toJSON(steps.future.outputs.value) }}`,
    ])
      expect(
        extractGithubWorkflow(source(binding)).issues.filter(
          (issue) => issue.code === "PIPE104",
        ),
      ).toHaveLength(1);
    for (const binding of [
      "'literal steps.future.outputs.value'",
      `\${{ toJSON('steps.future.outputs.value') }}`,
      `\${{ steps.future.outputs.value) }}`,
    ])
      expect(
        extractGithubWorkflow(source(binding)).issues.some(
          (issue) => issue.code === "PIPE104",
        ),
      ).toBe(false);
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
