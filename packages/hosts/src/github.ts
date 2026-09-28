import { createSpan, type Span, type Template } from "@pipe-ls/core";
import {
  isAlias,
  isMap,
  isScalar,
  isSeq,
  parseDocument,
  type YAMLMap,
} from "yaml";
import { type MappedText, mapYamlScalar } from "./source-map.js";

export interface WorkflowIssue {
  readonly code: "PIPE001" | "PIPE104" | "PIPE203";
  readonly message: string;
  readonly span: Span;
}
export interface RunUnit {
  readonly script: string;
  readonly map: MappedText;
  readonly span: Span;
  readonly shell: "bash" | "other" | "unknown";
  readonly rootWorkingDirectory: boolean;
  readonly repositoryAvailable: boolean;
  readonly env: Readonly<Record<string, EnvBinding>>;
  readonly jobId?: string;
  readonly stepId?: string;
  readonly stepIndex: number;
  readonly conditional: boolean;
  readonly condition?: EnvBinding;
}
/** Bash text supplied to an opaque action; its execution/effects are not trusted. */
export interface OpaqueCommand {
  readonly script: string;
  readonly map: MappedText;
  readonly span: Span;
}
export interface EnvBinding {
  readonly text: string;
  readonly span: Span;
  readonly scalar: string | number | boolean;
}
export interface LocalDependency {
  readonly path: string;
  readonly span: Span;
  readonly jobId?: string;
  readonly with: Readonly<Record<string, EnvBinding>> | undefined;
  /** Only the names are retained; secret values must never enter reports. */
  readonly secrets: "inherit" | "unverified" | readonly string[] | undefined;
  readonly condition?: EnvBinding;
}
export interface JobOutputReference {
  readonly jobId: string;
  readonly name: string;
  readonly span: Span;
}
export interface JobOutputMapping {
  readonly jobId: string;
  readonly name: string;
  readonly stepId: string;
  readonly stepOutput: string;
  readonly span: Span;
}
export interface GithubWorkflow {
  readonly runs: readonly RunUnit[];
  /** Step positions whose effects on later job env cannot be trusted. */
  readonly unverifiedSteps: readonly {
    readonly jobId: string;
    readonly stepIndex: number;
  }[];
  readonly opaqueCommands: readonly OpaqueCommand[];
  readonly dependencies: readonly LocalDependency[];
  readonly issues: readonly WorkflowIssue[];
  readonly inputs: Readonly<Record<string, Template>>;
  readonly outputReferences: readonly JobOutputReference[];
  readonly jobOutputMappings: readonly JobOutputMapping[];
  readonly jobNeeds: Readonly<Record<string, readonly string[]>>;
  readonly jobConditional: Readonly<Record<string, boolean>>;
  readonly jobConditions: Readonly<Record<string, EnvBinding>>;
  /** Empty means no reusable outputs are declared; undefined means unknown. */
  readonly workflowCallOutputs: readonly string[] | undefined;
  readonly workflowCallable: boolean;
  readonly workflowCallInputs:
    | Readonly<
        Record<
          string,
          {
            readonly type: Template;
            readonly required: boolean;
            readonly defaultValue?: string | number | boolean;
          }
        >
      >
    | undefined;
  /** Undefined means declarations could not be verified. */
  readonly workflowCallSecrets: Readonly<Record<string, boolean>> | undefined;
}

export const MAX_WORKFLOW_YAML_NODES = 10_000;
export const MAX_WORKFLOW_YAML_DEPTH = 128;
export const MAX_WORKFLOW_YAML_ALIASES = 128;

function yamlBudgetIssue(
  root: unknown,
  sourceLength: number,
): WorkflowIssue | undefined {
  const pending: Array<{ readonly node: unknown; readonly depth: number }> = [
    { node: root, depth: 0 },
  ];
  let nodes = 0;
  let aliases = 0;
  const issue = (message: string): WorkflowIssue => ({
    code: "PIPE203",
    message,
    span: createSpan(0, sourceLength),
  });
  while (pending.length) {
    const { node, depth } = pending.pop() as {
      readonly node: unknown;
      readonly depth: number;
    };
    if (node === null || node === undefined) continue;
    if (++nodes > MAX_WORKFLOW_YAML_NODES)
      return issue("Workflow YAML node budget exceeded");
    if (depth > MAX_WORKFLOW_YAML_DEPTH)
      return issue("Workflow YAML depth budget exceeded");
    if (isAlias(node)) {
      if (++aliases > MAX_WORKFLOW_YAML_ALIASES)
        return issue("Workflow YAML alias budget exceeded");
      continue;
    }
    if (isMap(node)) {
      for (const pair of node.items) {
        pending.push({ node: pair.key, depth: depth + 1 });
        pending.push({ node: pair.value, depth: depth + 1 });
      }
    } else if (isSeq(node))
      for (const item of node.items)
        pending.push({ node: item, depth: depth + 1 });
  }
  return undefined;
}

function checkNeedsOutputs(
  node: unknown,
  outputs: ReadonlyMap<string, ReadonlySet<string> | undefined>,
  needs: ReadonlySet<string>,
  issues: WorkflowIssue[],
  references: JobOutputReference[],
): void {
  if (isScalar(node) && typeof node.value === "string") {
    for (const expression of node.value.matchAll(/\$\{\{([\s\S]*?)\}\}/gu)) {
      for (const match of (expression[1] ?? "").matchAll(
        /\bneeds\.([A-Za-z_][A-Za-z_0-9-]*)\.(outputs\.([A-Za-z_][A-Za-z_0-9-]*)|result)\b/gu,
      )) {
        const job = match[1] ?? "";
        const key = match[3];
        const declared = outputs.get(job);
        const span = createSpan(node.range?.[0] ?? 0, node.range?.[1] ?? 0);
        if (!needs.has(job))
          issues.push({
            code: "PIPE104",
            message: `Job ${job} is referenced without a needs dependency`,
            span,
          });
        if (key === undefined) continue;
        references.push({ jobId: job, name: key, span });
        if (!outputs.has(job) || (declared && !declared.has(key)))
          issues.push({
            code: "PIPE104",
            message: `Job output ${job}.${key} has no explicit mapping`,
            span,
          });
      }
    }
  } else if (isMap(node)) {
    for (const pair of node.items)
      checkNeedsOutputs(pair.value, outputs, needs, issues, references);
  } else if (isSeq(node)) {
    for (const item of node.items)
      checkNeedsOutputs(item, outputs, needs, issues, references);
  }
}

function needsAt(
  job: YAMLMap<unknown, unknown>,
  issues: WorkflowIssue[],
): ReadonlySet<string> {
  const node = job.get("needs", true);
  if (node === undefined) return new Set();
  const values = isSeq(node) ? node.items : [node];
  const names = new Set<string>();
  for (const value of values) {
    if (!isScalar(value) || typeof value.value !== "string") {
      unsupported(job, "needs", issues);
      return names;
    }
    names.add(value.value);
  }
  return names;
}

function workflowCallInputs(
  workflow: YAMLMap<unknown, unknown>,
): GithubWorkflow["workflowCallInputs"] {
  const on = workflow.get("on", true);
  if (!isMap(on)) return {};
  const call = on.get("workflow_call", true);
  if (call === undefined || (isScalar(call) && call.value === null)) return {};
  if (!isMap(call)) return undefined;
  const declarations = call.get("inputs", true);
  if (declarations === undefined) return {};
  if (!isMap(declarations)) return undefined;
  const result: Record<
    string,
    {
      type: Template;
      required: boolean;
      defaultValue?: string | number | boolean;
    }
  > = Object.create(null);
  for (const pair of declarations.items) {
    if (
      !isScalar(pair.key) ||
      typeof pair.key.value !== "string" ||
      !isMap(pair.value)
    )
      return undefined;
    const declared = stringAt(pair.value, "type");
    if (!declared || !["string", "number", "boolean"].includes(declared))
      return undefined;
    const required = pair.value.get("required", true);
    const defaultNode = pair.value.get("default", true);
    if (
      required !== undefined &&
      (!isScalar(required) || typeof required.value !== "boolean")
    )
      return undefined;
    if (
      defaultNode !== undefined &&
      (!isScalar(defaultNode) || typeof defaultNode.value !== declared)
    )
      return undefined;
    const isRequired =
      isScalar(required) &&
      required.value === true &&
      defaultNode === undefined;
    const defaultValue =
      defaultNode !== undefined && isScalar(defaultNode)
        ? (defaultNode.value as string | number | boolean)
        : isRequired
          ? undefined
          : declared === "string"
            ? ""
            : declared === "number"
              ? 0
              : false;
    result[pair.key.value] = {
      type: {
        kind: "primitive",
        name: declared as "string" | "number" | "boolean",
      },
      required: isRequired,
      ...(defaultValue !== undefined ? { defaultValue } : {}),
    };
  }
  return result;
}

function workflowCallOutputs(
  workflow: YAMLMap<unknown, unknown>,
): readonly string[] | undefined {
  const on = workflow.get("on", true);
  if (!isMap(on)) return [];
  const call = on.get("workflow_call", true);
  if (call === undefined || (isScalar(call) && call.value === null)) return [];
  if (!isMap(call)) return undefined;
  const outputs = call.get("outputs", true);
  if (outputs === undefined) return [];
  if (!isMap(outputs)) return undefined;
  const names: string[] = [];
  for (const pair of outputs.items) {
    if (!isScalar(pair.key) || typeof pair.key.value !== "string")
      return undefined;
    names.push(pair.key.value);
  }
  return names;
}

function workflowCallSecrets(
  workflow: YAMLMap<unknown, unknown>,
): GithubWorkflow["workflowCallSecrets"] {
  const on = workflow.get("on", true);
  if (!isMap(on)) return {};
  const call = on.get("workflow_call", true);
  if (call === undefined || (isScalar(call) && call.value === null)) return {};
  if (!isMap(call)) return undefined;
  const secrets = call.get("secrets", true);
  if (secrets === undefined) return {};
  if (!isMap(secrets)) return undefined;
  const result: Record<string, boolean> = Object.create(null);
  for (const pair of secrets.items) {
    if (
      !isScalar(pair.key) ||
      typeof pair.key.value !== "string" ||
      !isMap(pair.value)
    )
      return undefined;
    const required = pair.value.get("required", true);
    if (
      required !== undefined &&
      (!isScalar(required) || typeof required.value !== "boolean")
    )
      return undefined;
    result[pair.key.value] = isScalar(required) && required.value === true;
  }
  return result;
}

function callerSecrets(
  job: YAMLMap<unknown, unknown>,
  issues: WorkflowIssue[],
): LocalDependency["secrets"] {
  const node = job.get("secrets", true);
  if (node === undefined) return undefined;
  if (isScalar(node) && node.value === "inherit") return "inherit";
  if (isMap(node)) {
    const names: string[] = [];
    for (const pair of node.items) {
      if (
        !isScalar(pair.key) ||
        typeof pair.key.value !== "string" ||
        !isScalar(pair.value) ||
        typeof pair.value.value !== "string" ||
        !/^\$\{\{\s*secrets\.[A-Za-z_][A-Za-z_0-9-]*\s*\}\}$/u.test(
          pair.value.value,
        )
      ) {
        unsupported(job, "secrets", issues);
        return "unverified";
      }
      names.push(pair.key.value);
    }
    return names;
  }
  unsupported(job, "secrets", issues);
  return "unverified";
}

function envAt(
  map: YAMLMap<unknown, unknown>,
  issues: WorkflowIssue[],
): Record<string, EnvBinding> {
  const env = map.get("env", true);
  const values: Record<string, EnvBinding> = Object.create(null);
  if (env === undefined) return values;
  if (!isMap(env)) {
    unsupported(map, "env", issues);
    return values;
  }
  for (const pair of env.items) {
    const key = pair.key;
    const value = pair.value;
    if (
      !isScalar(key) ||
      typeof key.value !== "string" ||
      !/^[A-Za-z_][A-Za-z_0-9]*$/u.test(key.value) ||
      !isScalar(value) ||
      !["string", "number", "boolean"].includes(typeof value.value)
    ) {
      issues.push({
        code: "PIPE203",
        message: "GitHub env entry is not a static scalar",
        span: createSpan(env.range?.[0] ?? 0, env.range?.[1] ?? 0),
      });
      continue;
    }
    values[key.value] = {
      text: String(value.value),
      span: createSpan(value.range?.[0] ?? 0, value.range?.[1] ?? 0),
      scalar: value.value as string | number | boolean,
    };
  }
  return values;
}

function conditionAt(
  map: YAMLMap<unknown, unknown>,
  issues: WorkflowIssue[],
): EnvBinding | undefined {
  const node = map.get("if", true);
  if (node === undefined) return undefined;
  if (!isScalar(node) || typeof node.value !== "string") {
    unsupported(map, "if", issues);
    return undefined;
  }
  return {
    text: node.value,
    scalar: node.value,
    span: createSpan(node.range?.[0] ?? 0, node.range?.[1] ?? 0),
  };
}

function inputTypes(
  workflow: YAMLMap<unknown, unknown>,
): Record<string, Template> {
  const result: Record<string, Template> = Object.create(null);
  const on = workflow.get("on", true);
  if (!isMap(on)) return result;
  for (const trigger of ["workflow_dispatch", "workflow_call"]) {
    const event = on.get(trigger, true);
    if (!isMap(event)) continue;
    const inputs = event.get("inputs", true);
    if (!isMap(inputs)) continue;
    for (const pair of inputs.items) {
      if (
        !isScalar(pair.key) ||
        typeof pair.key.value !== "string" ||
        !isMap(pair.value)
      )
        continue;
      // GitHub assigns absent optional inputs a typed default ("", 0 or false).
      const declared = stringAt(pair.value, "type") ?? "string";
      const name =
        declared === "boolean"
          ? "boolean"
          : declared === "number"
            ? "number"
            : ["string", "choice", "environment"].includes(declared)
              ? "string"
              : undefined;
      if (name) result[pair.key.value] = { kind: "primitive", name };
    }
  }
  return result;
}

function unsupported(
  map: YAMLMap<unknown, unknown>,
  key: string,
  issues: WorkflowIssue[],
): void {
  const node = map.get(key, true);
  if (node === undefined) return;
  const range =
    isMap(node) || isSeq(node) || isScalar(node) ? node.range : undefined;
  issues.push({
    code: "PIPE203",
    message: `GitHub ${key} context is not yet analyzed`,
    span: createSpan(range?.[0] ?? 0, range?.[1] ?? 0),
  });
}

function stringAt(
  map: YAMLMap<unknown, unknown>,
  key: string,
): string | undefined {
  const node = map.get(key, true);
  return isScalar(node) && typeof node.value === "string"
    ? node.value
    : undefined;
}
function defaultsShell(
  map: YAMLMap<unknown, unknown>,
  issues: WorkflowIssue[],
): string | undefined {
  const defaults = map.get("defaults", true);
  if (defaults === undefined) return undefined;
  if (!isMap(defaults)) {
    unsupported(map, "defaults", issues);
    return undefined;
  }
  const run = defaults.get("run", true);
  if (run === undefined) return undefined;
  if (!isMap(run)) {
    unsupported(defaults, "run", issues);
    return undefined;
  }
  unsupported(run, "working-directory", issues);
  if (run.has("shell") && stringAt(run, "shell") === undefined)
    unsupported(run, "shell", issues);
  return stringAt(run, "shell");
}

function hasUnverifiedDefaultWorkingDirectory(
  map: YAMLMap<unknown, unknown>,
): boolean {
  const defaults = map.get("defaults", true);
  if (defaults === undefined) return false;
  if (!isMap(defaults)) return true;
  const run = defaults.get("run", true);
  return run !== undefined && (!isMap(run) || run.has("working-directory"));
}
function shellKind(shell: string | undefined): RunUnit["shell"] {
  if (shell === undefined) return "unknown";
  if (shell === "bash") return "bash";
  if (["sh", "zsh", "pwsh", "powershell", "cmd", "python"].includes(shell))
    return "other";
  return "unknown";
}

function modeledCheckout(step: YAMLMap<unknown, unknown>): boolean {
  if (
    stringAt(step, "uses") !== "actions/checkout@v4" ||
    step.has("if") ||
    step.has("run")
  )
    return false;
  if (
    step.items.some(
      (pair) =>
        !isScalar(pair.key) ||
        typeof pair.key.value !== "string" ||
        !["name", "uses", "with"].includes(pair.key.value),
    )
  )
    return false;
  const withNode = step.get("with", true);
  if (withNode === undefined) return true;
  if (!isMap(withNode) || withNode.items.length !== 1) return false;
  const [entry] = withNode.items;
  return (
    isScalar(entry?.key) &&
    entry.key.value === "ref" &&
    isScalar(entry.value) &&
    entry.value.value === "main"
  );
}

/** Extract run units with original YAML locations, without evaluating expressions. */
export function extractGithubWorkflow(source: string): GithubWorkflow {
  const runs: RunUnit[] = [];
  const unverifiedSteps: Array<{ jobId: string; stepIndex: number }> = [];
  const opaqueCommands: OpaqueCommand[] = [];
  const dependencies: LocalDependency[] = [];
  const issues: WorkflowIssue[] = [];
  const outputReferences: JobOutputReference[] = [];
  const jobOutputMappings: JobOutputMapping[] = [];
  const jobNeeds: Record<string, readonly string[]> = Object.create(null);
  const jobConditional: Record<string, boolean> = Object.create(null);
  const jobConditions: Record<string, EnvBinding> = Object.create(null);
  const finish = (
    inputs: Readonly<Record<string, Template>>,
    callableOutputs: readonly string[] | undefined,
    callable = false,
    callInputs?: GithubWorkflow["workflowCallInputs"],
    callSecrets?: GithubWorkflow["workflowCallSecrets"],
  ): GithubWorkflow => ({
    runs,
    unverifiedSteps,
    opaqueCommands,
    dependencies,
    issues,
    inputs,
    outputReferences,
    jobOutputMappings,
    jobNeeds,
    jobConditional,
    jobConditions,
    workflowCallOutputs: callableOutputs,
    workflowCallable: callable,
    workflowCallInputs: callInputs,
    workflowCallSecrets: callSecrets,
  });
  let document: ReturnType<typeof parseDocument>;
  try {
    document = parseDocument(source, {
      keepSourceTokens: true,
      uniqueKeys: true,
    });
  } catch {
    issues.push({
      code: "PIPE203",
      message: "Workflow YAML parser failed within analysis budget",
      span: createSpan(0, source.length),
    });
    return finish({}, undefined);
  }
  for (const error of document.errors) {
    const pos = error.pos;
    const start = Math.max(0, Math.min(pos[0], source.length));
    const end = Math.max(start, Math.min(pos[1], source.length));
    const safeCode = /^[A-Z][A-Z_0-9]{0,63}$/u.test(error.code)
      ? error.code
      : "YAML_PARSE_ERROR";
    issues.push({
      code: "PIPE001",
      // yaml's error.message embeds source lines, which may contain secrets.
      message: `Workflow YAML syntax error (${safeCode})`,
      span: createSpan(start, end),
    });
  }
  if (issues.length) return finish({}, undefined);
  const budgetIssue = yamlBudgetIssue(document.contents, source.length);
  if (budgetIssue) {
    issues.push(budgetIssue);
    return finish({}, undefined);
  }
  const workflow = document.contents;
  if (!isMap(workflow)) {
    issues.push({
      code: "PIPE001",
      message: "Workflow must be a mapping",
      span: createSpan(0, source.length),
    });
    return finish({}, undefined);
  }
  const jobs = workflow.get("jobs", true);
  if (!isMap(jobs)) {
    issues.push({
      code: "PIPE203",
      message: "Workflow jobs are not statically available",
      span: createSpan(0, source.length),
    });
    return finish({}, undefined);
  }
  const inputs = inputTypes(workflow);
  const on = workflow.get("on", true);
  const callable = isMap(on) && on.has("workflow_call");
  const callInputs = workflowCallInputs(workflow);
  if (callable && callInputs === undefined)
    issues.push({
      code: "PIPE203",
      message:
        "Reusable workflow input declarations are not statically available",
      span: createSpan(
        isMap(on) ? (on.range?.[0] ?? 0) : 0,
        isMap(on) ? (on.range?.[1] ?? 0) : 0,
      ),
    });
  const callSecrets = workflowCallSecrets(workflow);
  if (callable && callSecrets === undefined)
    issues.push({
      code: "PIPE203",
      message:
        "Reusable workflow secret declarations are not statically available",
      span: createSpan(
        isMap(on) ? (on.range?.[0] ?? 0) : 0,
        isMap(on) ? (on.range?.[1] ?? 0) : 0,
      ),
    });
  const jobOutputs = new Map<string, ReadonlySet<string> | undefined>();
  for (const pair of jobs.items) {
    if (!isScalar(pair.key) || typeof pair.key.value !== "string") continue;
    const job = pair.value;
    if (!isMap(job)) continue;
    const uses = job.get("uses", true);
    const outputMap = job.get("outputs", true);
    if (uses !== undefined || (outputMap !== undefined && !isMap(outputMap))) {
      jobOutputs.set(pair.key.value, undefined);
      continue;
    }
    const names = new Set<string>();
    if (isMap(outputMap))
      for (const output of outputMap.items) {
        if (!isScalar(output.key) || typeof output.key.value !== "string") {
          unsupported(job, "outputs", issues);
          continue;
        }
        names.add(output.key.value);
        const valueNode = output.value;
        if (!isScalar(valueNode) || typeof valueNode.value !== "string") {
          unsupported(job, "outputs", issues);
          continue;
        }
        const expression =
          /^\$\{\{\s*steps\.([A-Za-z_][A-Za-z_0-9-]*)\.outputs\.([A-Za-z_][A-Za-z_0-9-]*)\s*\}\}$/u.exec(
            valueNode.value,
          );
        if (!expression) {
          unsupported(job, "outputs", issues);
          continue;
        }
        jobOutputMappings.push({
          jobId: pair.key.value,
          name: output.key.value,
          stepId: expression[1] ?? "",
          stepOutput: expression[2] ?? "",
          span: createSpan(
            valueNode.range?.[0] ?? 0,
            valueNode.range?.[1] ?? 0,
          ),
        });
      }
    jobOutputs.set(pair.key.value, names);
  }
  for (const pair of jobs.items) {
    if (!isMap(pair.value)) continue;
    const needs = needsAt(pair.value, issues);
    if (isScalar(pair.key) && typeof pair.key.value === "string") {
      jobNeeds[pair.key.value] = [...needs];
      jobConditional[pair.key.value] = pair.value.has("if");
    }
    for (const name of needs)
      if (!jobOutputs.has(name))
        issues.push({
          code: "PIPE104",
          message: `Job needs unknown dependency ${name}`,
          span: createSpan(
            pair.value.range?.[0] ?? 0,
            pair.value.range?.[1] ?? 0,
          ),
        });
    checkNeedsOutputs(pair.value, jobOutputs, needs, issues, outputReferences);
  }
  const workflowEnv = envAt(workflow, issues);
  const workflowShell = defaultsShell(workflow, issues);
  const workflowRootCwd = !hasUnverifiedDefaultWorkingDirectory(workflow);
  for (const pair of jobs.items) {
    const job = pair.value;
    if (!isMap(job)) {
      issues.push({
        code: "PIPE203",
        message: "Job is not a static mapping",
        span: createSpan(0, source.length),
      });
      continue;
    }
    unsupported(job, "strategy", issues);
    unsupported(job, "continue-on-error", issues);
    unsupported(job, "container", issues);
    unsupported(job, "services", issues);
    const runner = job.get("runs-on", true);
    if (runner !== undefined && stringAt(job, "runs-on") !== "ubuntu-latest")
      unsupported(job, "runs-on", issues);
    const jobIf = conditionAt(job, issues);
    if (jobIf && isScalar(pair.key) && typeof pair.key.value === "string")
      jobConditions[pair.key.value] = jobIf;
    const jobEnv = { ...workflowEnv, ...envAt(job, issues) };
    const uses = job.get("uses", true);
    if (uses !== undefined && job.has("steps")) {
      issues.push({
        code: "PIPE104",
        message: "A reusable workflow job cannot also define steps",
        span: createSpan(job.range?.[0] ?? 0, job.range?.[1] ?? 0),
      });
    }
    if (
      isScalar(uses) &&
      typeof uses.value === "string" &&
      uses.value.startsWith("./")
    ) {
      const withNode = job.get("with", true);
      let withValues: Record<string, EnvBinding> | undefined =
        Object.create(null);
      if (withNode !== undefined) {
        if (!isMap(withNode)) {
          unsupported(job, "with", issues);
          withValues = undefined;
        } else {
          for (const argument of withNode.items) {
            if (
              !isScalar(argument.key) ||
              typeof argument.key.value !== "string" ||
              !isScalar(argument.value) ||
              !["string", "number", "boolean"].includes(
                typeof argument.value.value,
              )
            ) {
              unsupported(job, "with", issues);
              withValues = undefined;
              break;
            }
            if (withValues)
              withValues[argument.key.value] = {
                text: String(argument.value.value),
                span: createSpan(
                  argument.value.range?.[0] ?? 0,
                  argument.value.range?.[1] ?? 0,
                ),
                scalar: argument.value.value as string | number | boolean,
              };
          }
        }
      }
      dependencies.push({
        path: uses.value,
        span: createSpan(uses.range?.[0] ?? 0, uses.range?.[1] ?? 0),
        with: withValues,
        secrets: callerSecrets(job, issues),
        ...(jobIf ? { condition: jobIf } : {}),
        ...(isScalar(pair.key) && typeof pair.key.value === "string"
          ? { jobId: pair.key.value }
          : {}),
      });
    } else if (uses !== undefined) unsupported(job, "uses", issues);
    const steps = job.get("steps", true);
    if (steps !== undefined && !isSeq(steps)) {
      issues.push({
        code: "PIPE203",
        message: "Job steps are not a static sequence",
        span: createSpan(0, source.length),
      });
      continue;
    }
    if (!isSeq(steps)) continue;
    const jobShell = defaultsShell(job, issues) ?? workflowShell;
    const jobRootCwd =
      workflowRootCwd && !hasUnverifiedDefaultWorkingDirectory(job);
    const stepIds = new Set<string>();
    let repositoryAvailable = false;
    const jobId =
      isScalar(pair.key) && typeof pair.key.value === "string"
        ? pair.key.value
        : undefined;
    for (const [stepIndex, step] of steps.items.entries()) {
      if (!isMap(step)) {
        if (jobId) unverifiedSteps.push({ jobId, stepIndex });
        issues.push({
          code: "PIPE203",
          message: "Step is not a static mapping",
          span: createSpan(0, source.length),
        });
        continue;
      }
      const checkout = step.has("uses") && modeledCheckout(step);
      if (step.has("uses") && !checkout) {
        unsupported(step, "uses", issues);
        if (jobId) unverifiedSteps.push({ jobId, stepIndex });
      }
      unsupported(step, "continue-on-error", issues);
      unsupported(step, "timeout-minutes", issues);
      if (step.has("run") && !step.has("uses"))
        unsupported(step, "with", issues);
      const stepIf = conditionAt(step, issues);
      const idNode = step.get("id", true);
      const stepId = stringAt(step, "id");
      if (
        idNode !== undefined &&
        (!stepId || !/^[A-Za-z_][A-Za-z_0-9-]*$/u.test(stepId))
      )
        unsupported(step, "id", issues);
      if (stepId) {
        if (stepIds.has(stepId))
          issues.push({
            code: "PIPE104",
            message: `Duplicate GitHub step id ${stepId}`,
            span: createSpan(
              isScalar(idNode) ? (idNode.range?.[0] ?? 0) : 0,
              isScalar(idNode) ? (idNode.range?.[1] ?? 0) : 0,
            ),
          });
        stepIds.add(stepId);
      }
      const run = step.get("run", true);
      if (checkout) repositoryAvailable = true;
      if (stringAt(step, "uses") === "nick-fields/retry@v3") {
        const withNode = step.get("with", true);
        const command = isMap(withNode)
          ? withNode.get("command", true)
          : undefined;
        if (
          isMap(withNode) &&
          stringAt(withNode, "shell") === "bash" &&
          isScalar(command) &&
          typeof command.value === "string"
        )
          opaqueCommands.push({
            script: command.value,
            map: mapYamlScalar(source, command),
            span: createSpan(command.range?.[0] ?? 0, command.range?.[1] ?? 0),
          });
      }
      if (run === undefined) continue;
      if (!isScalar(run) || typeof run.value !== "string") {
        issues.push({
          code: "PIPE203",
          message: "Run body is not a static string",
          span: createSpan(0, source.length),
        });
        continue;
      }
      unsupported(step, "working-directory", issues);
      if (step.has("shell") && stringAt(step, "shell") === undefined)
        unsupported(step, "shell", issues);
      const env = { ...jobEnv, ...envAt(step, issues) };
      const span = createSpan(run.range?.[0] ?? 0, run.range?.[1] ?? 0);
      runs.push({
        script: run.value,
        map: mapYamlScalar(source, run),
        span,
        shell: shellKind(stringAt(step, "shell") ?? jobShell),
        rootWorkingDirectory: jobRootCwd && !step.has("working-directory"),
        repositoryAvailable,
        env,
        stepIndex,
        conditional: step.has("if"),
        ...(stepIf ? { condition: stepIf } : {}),
        ...(isScalar(pair.key) && typeof pair.key.value === "string"
          ? { jobId: pair.key.value }
          : {}),
        ...(stepId ? { stepId } : {}),
      });
    }
  }
  return finish(
    inputs,
    workflowCallOutputs(workflow),
    callable,
    callInputs,
    callSecrets,
  );
}
