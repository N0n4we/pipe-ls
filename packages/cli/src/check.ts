import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  analyzeScript,
  type BashParser,
  createBashParser,
  type Diagnostic,
  type GithubFileValue,
  isAssignable,
  type LocalScriptSummary,
  parseScriptContract,
  type Span,
  type Template,
  templateOfJson,
  union,
} from "@pipe-ls/core";
import {
  extractGithubWorkflow,
  type GithubActionUnit,
  type GithubWorkflow,
  type LocalDependency,
  type RunUnit,
} from "@pipe-ls/hosts";
import {
  discoverProjectRoot,
  discoverTargets,
  ProjectDiscoveryError,
  ProjectSnapshot,
  type Target,
} from "@pipe-ls/workspace";

export const CLI_VERSION = "0.1.0" as const;

export interface ReportDiagnostic {
  readonly uri: string;
  readonly code: Diagnostic["code"];
  readonly message: string;
  readonly status: Diagnostic["status"];
  readonly range: {
    readonly start: { readonly line: number; readonly character: number };
    readonly end: { readonly line: number; readonly character: number };
  };
  readonly offset: Span;
}
export interface CheckReport {
  readonly schemaVersion: 1;
  readonly version: typeof CLI_VERSION;
  readonly checkedUnits: number;
  readonly complete: boolean;
  readonly diagnostics: readonly ReportDiagnostic[];
  readonly unverifiedDependencies: readonly string[];
  /** Verified local may-write effects; not exhaustive when complete is false. */
  readonly fileEffects: readonly string[];
  /** At least one modeled file write has no finite verified target. */
  readonly fileEffectsUnknown: boolean;
  /** Statically modeled command families that may run; no arguments or secrets. */
  readonly externalEffects: readonly string[];
}

function position(
  source: string,
  offset: number,
): { line: number; character: number } {
  const prefix = source.slice(0, offset);
  const line = (prefix.match(/\n/gu) ?? []).length;
  return { line, character: prefix.length - (prefix.lastIndexOf("\n") + 1) };
}
function detail(
  path: string,
  source: string,
  diagnostic: Diagnostic,
): ReportDiagnostic {
  return {
    uri: pathToFileURL(path).href,
    code: diagnostic.code,
    message: diagnostic.message,
    status: diagnostic.status,
    range: {
      start: position(source, diagnostic.span.start),
      end: position(source, diagnostic.span.end),
    },
    offset: diagnostic.span,
  };
}
function blocked(
  code: Diagnostic["code"],
  message: string,
  span: Span,
): Diagnostic {
  return { code, message, span, status: "blocked" };
}

type WorkflowUnit = RunUnit | GithubActionUnit;
interface StepOutputProducer {
  readonly complete: boolean;
  readonly conditional: boolean;
  readonly condition?: string;
  readonly values: Readonly<Record<string, GithubFileValue>>;
  /** Runner strings when written, null when absent; no definite secret outputs. */
  readonly optionalRawOutputs?: true | readonly string[];
}
interface StepOutputContext {
  readonly jobId: string;
  readonly outputs: ReadonlyMap<string, StepOutputProducer>;
  readonly condition?: string | undefined;
}

function ownFileValue(
  values: Readonly<Record<string, GithubFileValue>> | undefined,
  name: string,
): GithubFileValue | undefined {
  return values && Object.hasOwn(values, name) ? values[name] : undefined;
}

/** Stable input-only equality guards, not a general condition implication solver. */
function stepOutputIsAvailable(
  producer: StepOutputProducer,
  condition: string | undefined,
): boolean {
  if (!producer.complete) return false;
  if (!producer.conditional) return true;
  const guard = (text: string | undefined): string | undefined => {
    if (!text) return undefined;
    const source = text
      .trim()
      .replace(/^\$\{\{\s*|\s*\}\}$/gu, "")
      .trim();
    return /^(?:inputs\.[A-Za-z_][A-Za-z_0-9-]*|fromJSON\(\s*inputs\.[A-Za-z_][A-Za-z_0-9-]*\s*\))\s*==\s*'[^']*'$/iu.test(
      source,
    )
      ? source
      : undefined;
  };
  const expected = guard(producer.condition);
  return expected !== undefined && expected === guard(condition);
}
function githubEnvValue(
  text: string,
  inputs: Readonly<Record<string, Template>>,
  outputs: ReadonlyMap<
    string,
    Readonly<Record<string, GithubFileValue>>
  > = new Map(),
  // null means a workflow_call input is being checked without a caller.
  inputWires?: Readonly<Record<string, GithubFileValue>> | null,
  steps?: StepOutputContext,
):
  | { readonly kind: "json"; readonly type: Template }
  | { readonly kind: "raw" }
  | { readonly kind: "unknown" } {
  const stepExpression = /^\$\{\{\s*(.*?)\s*\}\}$/u.exec(text)?.[1];
  const serializedStep = stepExpression
    ? /^toJSON\(\s*(.*?)\s*\)$/iu.exec(stepExpression)?.[1]
    : undefined;
  const stepReference =
    /^steps\.([A-Za-z_][A-Za-z_0-9-]*)\.outputs\.([A-Za-z_][A-Za-z_0-9-]*)$/u.exec(
      serializedStep ?? stepExpression ?? "",
    );
  if (steps && stepReference) {
    const producer = steps.outputs.get(`${steps.jobId}\0${stepReference[1]}`);
    if (
      producer?.optionalRawOutputs === true ||
      producer?.optionalRawOutputs?.includes(stepReference[2] ?? "")
    )
      return serializedStep !== undefined
        ? {
            kind: "json",
            // Missing dictionary entries evaluate to null before toJSON;
            // direct env rendering converts that null to the empty string.
            type: union([
              { kind: "primitive", name: "string" },
              { kind: "primitive", name: "null" },
            ]),
          }
        : { kind: "raw" };
    const output =
      producer && stepOutputIsAvailable(producer, steps.condition)
        ? ownFileValue(producer.values, stepReference[2] ?? "")
        : undefined;
    if (output)
      return serializedStep !== undefined
        ? { kind: "json", type: { kind: "primitive", name: "string" } }
        : output.encoded
          ? { kind: "json", type: output.type }
          : { kind: "raw" };
    return { kind: "unknown" };
  }
  const needOutput = (source: string): GithubFileValue | undefined => {
    const match =
      /^needs\.([A-Za-z_][A-Za-z_0-9-]*)\.outputs\.([A-Za-z_][A-Za-z_0-9-]*)$/u.exec(
        source,
      );
    return match
      ? ownFileValue(outputs.get(match[1] ?? ""), match[2] ?? "")
      : undefined;
  };
  const parsedOutput =
    /^\$\{\{\s*toJSON\(\s*fromJSON\(\s*(needs\.[A-Za-z_][A-Za-z_0-9-]*\.outputs\.[A-Za-z_][A-Za-z_0-9-]*)\s*\)\s*\)\s*\}\}$/iu.exec(
      text,
    );
  if (parsedOutput) {
    const output = needOutput(parsedOutput[1] ?? "");
    return output?.encoded
      ? { kind: "json", type: output.type }
      : { kind: "unknown" };
  }
  const expression = /^\$\{\{\s*toJSON\(\s*([^()]+?)\s*\)\s*\}\}$/iu.exec(text);
  if (expression) {
    const source = expression[1]?.trim() ?? "";
    if (needOutput(source))
      return { kind: "json", type: { kind: "primitive", name: "string" } };
    if (source.startsWith("inputs.")) {
      const type = inputs[source.slice(7)];
      return type ? { kind: "json", type } : { kind: "unknown" };
    }
    if (["github.actor", "github.token", "github.repository"].includes(source))
      return { kind: "json", type: { kind: "primitive", name: "string" } };
    const literal = /^'([^']*)'$/u.exec(source);
    if (literal)
      return {
        kind: "json",
        type: { kind: "literal", value: literal[1] ?? "" },
      };
    return { kind: "unknown" };
  }
  const direct = /^\$\{\{\s*([^{}]+?)\s*\}\}$/u.exec(text)?.[1]?.trim();
  if (direct) {
    const output = needOutput(direct);
    if (output)
      return output.encoded
        ? { kind: "json", type: output.type }
        : { kind: "raw" };
    if (direct.startsWith("inputs.")) {
      // A reusable workflow input is a GitHub string wire. Its contents may
      // be JSON supplied by a caller, so absence of caller evidence is not
      // proof of a raw, unencoded business value.
      if (inputWires === null) return { kind: "unknown" };
      const wire = inputWires?.[direct.slice(7)];
      if (wire)
        return wire.encoded
          ? { kind: "json", type: wire.type }
          : { kind: "raw" };
      if (inputWires !== undefined) return { kind: "unknown" };
      const type = inputs[direct.slice(7)];
      return type?.kind === "primitive" && type.name === "string"
        ? { kind: "raw" }
        : { kind: "unknown" };
    }
    if (["github.actor", "github.token", "github.repository"].includes(direct))
      return { kind: "raw" };
  }
  if (text.includes("${{")) return { kind: "unknown" };
  try {
    return { kind: "json", type: templateOfJson(JSON.parse(text)) };
  } catch {
    return { kind: "raw" };
  }
}

function githubWithValue(
  binding: RunUnit["env"][string],
  inputs: Readonly<Record<string, Template>>,
  outputs: ReadonlyMap<string, Readonly<Record<string, GithubFileValue>>>,
  guards: ReadonlySet<string>,
): { readonly type: Template; readonly wire: GithubFileValue } | undefined {
  const stringType: Template = { kind: "primitive", name: "string" };
  if (!binding.text.includes("${{")) {
    const type = templateOfJson(binding.scalar);
    const value = githubEnvValue(binding.text, inputs, outputs);
    return {
      type,
      wire:
        value.kind === "json"
          ? { type: value.type, encoded: true, text: binding.text }
          : { type, encoded: false, text: binding.text },
    };
  }
  const serialized = /^\$\{\{\s*toJSON\(\s*([\s\S]*)\s*\)\s*\}\}$/iu
    .exec(binding.text)?.[1]
    ?.trim();
  if (serialized) {
    const joined = /^join\(\s*([\s\S]+?)\s*,\s*' '\s*\)$/iu.exec(serialized);
    if (joined) {
      const array = githubFromJsonPath(joined[1] ?? "", outputs, guards);
      return array &&
        isAssignable(array, {
          kind: "array",
          element: { kind: "primitive", name: "string" },
        })
        ? { type: stringType, wire: { type: stringType, encoded: true } }
        : undefined;
    }
    const parsed = githubFromJsonPath(serialized, outputs, guards);
    if (parsed)
      return { type: stringType, wire: { type: parsed, encoded: true } };
  }
  const value = githubEnvValue(binding.text, inputs, outputs);
  if (value.kind === "json")
    return { type: stringType, wire: { type: value.type, encoded: true } };
  if (value.kind === "raw")
    return { type: stringType, wire: { type: stringType, encoded: false } };
  return undefined;
}

function githubEnvironmentSource(
  unit: WorkflowUnit,
  name: string,
  prior: Readonly<Record<string, GithubFileValue>> | undefined,
  globalsUnverified: boolean,
): {
  readonly binding?: RunUnit["env"][string] | undefined;
  readonly prior?: GithubFileValue;
} {
  if (unit.stepEnvNames?.includes(name)) return { binding: unit.env[name] };
  if (prior?.[name]) return { prior: prior[name] };
  return globalsUnverified ? {} : { binding: unit.env[name] };
}

function githubNativeEnvironment(
  unit: WorkflowUnit,
  inputs: Readonly<Record<string, Template>>,
  prior: Readonly<Record<string, GithubFileValue>> | undefined,
  globalsUnverified: boolean,
  outputs: ReadonlyMap<string, Readonly<Record<string, GithubFileValue>>>,
  inputWires?: Readonly<Record<string, GithubFileValue>> | null,
  jobCondition?: string,
  declaredEnv: Readonly<Record<string, Template>> = {},
  startupUnverified = false,
  steps?: StepOutputContext,
): Readonly<Record<string, GithubFileValue>> {
  const facts: Record<string, GithubFileValue> = Object.assign(
    Object.create(null),
    prior,
  );
  for (const [name, binding] of Object.entries(unit.env)) {
    const selected = githubEnvironmentSource(
      unit,
      name,
      prior,
      globalsUnverified,
    );
    if (selected.prior) continue;
    if (!selected.binding) {
      delete facts[name];
      continue;
    }
    delete facts[name];
    const value = githubEnvValue(
      binding.text,
      inputs,
      outputs,
      inputWires,
      steps,
    );
    if (name === "BASH_ENV" && value.kind === "unknown")
      facts.BASH_ENV = {
        type: { kind: "primitive", name: "string" },
        encoded: false,
      };
    if (
      value.kind === "unknown" ||
      !githubNeedsOutputsAvailable(
        binding.text,
        unit.condition?.text,
        jobCondition,
      )
    )
      continue;
    const input = /^\$\{\{\s*inputs\.([A-Za-z_][A-Za-z_0-9-]*)\s*\}\}$/u.exec(
      binding.text,
    )?.[1];
    const reference =
      /^\$\{\{\s*steps\.([A-Za-z_][A-Za-z_0-9-]*)\.outputs\.([A-Za-z_][A-Za-z_0-9-]*)\s*\}\}$/u.exec(
        binding.text,
      );
    const producer =
      reference && steps
        ? steps.outputs.get(`${steps.jobId}\0${reference[1]}`)
        : undefined;
    const stepWire =
      producer && stepOutputIsAvailable(producer, steps?.condition)
        ? ownFileValue(producer.values, reference?.[2] ?? "")
        : undefined;
    const text = binding.text.includes("${{")
      ? input
        ? inputWires?.[input]?.text
        : stepWire?.text
      : binding.text;
    facts[name] = {
      type:
        value.kind === "json"
          ? value.type
          : { kind: "primitive", name: "string" },
      encoded: value.kind === "json",
      ...(stepWire?.nonBlank ? { nonBlank: true as const } : {}),
      ...(text !== undefined
        ? { text, singleLine: !/[\r\n\0]/u.test(text) }
        : stepWire?.singleLine !== undefined
          ? { singleLine: stepWire.singleLine }
          : {}),
    };
  }
  if (
    startupUnverified &&
    !unit.stepEnvNames?.includes("BASH_ENV") &&
    !Object.hasOwn(facts, "BASH_ENV")
  )
    facts.BASH_ENV = {
      type: { kind: "primitive", name: "string" },
      encoded: false,
    };
  // Default GitHub variables retain the host's existing, unknown-byte model.
  for (const name of Object.keys(facts))
    if (/^(?:GITHUB_|RUNNER_)/u.test(name) || Object.hasOwn(declaredEnv, name))
      delete facts[name];
  return facts;
}

function githubDefaultWire(value: string | number | boolean): GithubFileValue {
  if (typeof value !== "string")
    return { type: templateOfJson(value), encoded: true };
  try {
    return {
      type: templateOfJson(JSON.parse(value)),
      encoded: true,
      text: value,
    };
  } catch {
    return {
      type: { kind: "primitive", name: "string" },
      encoded: false,
      text: value,
    };
  }
}

function invalidateGithubEnvFacts(
  environments: Map<string, Record<string, GithubFileValue>>,
  jobId: string,
  names?: readonly string[],
): void {
  if (names === undefined) {
    environments.delete(jobId);
    return;
  }
  const known = environments.get(jobId);
  if (!known) return;
  for (const name of names) delete known[name];
  if (Object.keys(known).length === 0) environments.delete(jobId);
}

interface StepBarrierState {
  readonly indices: number[];
  cursor: number;
}

function unverifiedStepBarriers(
  workflow: GithubWorkflow,
): Map<string, StepBarrierState> {
  const barriers = new Map<string, StepBarrierState>();
  for (const step of workflow.unverifiedSteps) {
    const state = barriers.get(step.jobId) ?? { indices: [], cursor: 0 };
    state.indices.push(step.stepIndex);
    barriers.set(step.jobId, state);
  }
  return barriers;
}

/** Opaque action bodies still need caller wires, env bindings and step order. */
function workflowUnits(workflow: GithubWorkflow): readonly WorkflowUnit[] {
  return [
    ...workflow.runs,
    ...workflow.opaqueCommands,
    ...workflow.actions,
  ].sort(
    (a, b) =>
      (a.jobId ?? "").localeCompare(b.jobId ?? "") || a.stepIndex - b.stepIndex,
  );
}

interface InvocationEnvironment {
  readonly prior: Readonly<Record<string, GithubFileValue>> | undefined;
  readonly globalsUnverified: boolean;
  readonly startupUnverified: boolean;
}

/** Every retry child inherits the same action-entry env, not a later GENV write. */
function invocationEnvironment(
  unit: WorkflowUnit,
  environments: ReadonlyMap<string, Record<string, GithubFileValue>>,
  globalsUnverified: ReadonlySet<string>,
  startupUnverified: ReadonlySet<string>,
  retryEntries: Map<string, InvocationEnvironment>,
): InvocationEnvironment {
  const job = unit.jobId ?? "";
  const key = `${job}\0${unit.stepIndex}`;
  const previous = unit.retryModel && retryEntries.get(key);
  if (previous) return previous;
  const prior = environments.get(job);
  const entry = {
    prior: prior ? { ...prior } : undefined,
    globalsUnverified: globalsUnverified.has(job),
    startupUnverified: startupUnverified.has(job),
  };
  if (unit.retryModel) retryEntries.set(key, entry);
  return entry;
}

function crossedUnverifiedStep(
  barriers: Map<string, StepBarrierState>,
  unit: WorkflowUnit,
): boolean {
  const state = barriers.get(unit.jobId ?? "");
  if (!state) return false;
  let crossed = false;
  while (
    state.cursor < state.indices.length &&
    (state.indices[state.cursor] ?? Number.POSITIVE_INFINITY) <= unit.stepIndex
  ) {
    crossed = true;
    state.cursor++;
  }
  return crossed;
}

interface RepositoryRunState {
  readonly checkoutGeneration: Map<string, number>;
  readonly unverifiedAfterRun: Set<string>;
}

function repositoryProofForRun(
  unit: WorkflowUnit,
  state: RepositoryRunState,
): { readonly verified: boolean; readonly reason: string } {
  const jobId = unit.jobId;
  if (jobId) {
    const previous = state.checkoutGeneration.get(jobId) ?? 0;
    if (unit.repositoryCheckoutGeneration > previous) {
      state.checkoutGeneration.set(jobId, unit.repositoryCheckoutGeneration);
      state.unverifiedAfterRun.delete(jobId);
    }
  }
  if (!unit.repositoryAvailable)
    return {
      verified: false,
      reason: "Repository checkout is not proven before this run",
    };
  if (!unit.repositoryContentsVerified)
    return {
      verified: false,
      reason: "Repository contents may have changed after an unverified action",
    };
  if (jobId && state.unverifiedAfterRun.has(jobId))
    return {
      verified: false,
      reason: "Repository contents may have changed after an unverified run",
    };
  return { verified: true, reason: "" };
}

function unverifyRepositoryAfterRun(
  unit: WorkflowUnit,
  state: RepositoryRunState,
): void {
  if (unit.jobId) state.unverifiedAfterRun.add(unit.jobId);
}

function githubFromJsonPath(
  expression: string,
  outputs: ReadonlyMap<string, Readonly<Record<string, GithubFileValue>>>,
  guards: ReadonlySet<string>,
): Template | undefined {
  const match =
    /^fromJSON\(\s*needs\.([A-Za-z_][A-Za-z_0-9-]*)\.outputs\.([A-Za-z_][A-Za-z_0-9-]*)\s*\)((?:\.[A-Za-z_][A-Za-z_0-9-]*)+)$/iu.exec(
      expression,
    );
  if (!match) return undefined;
  const job = match[1] ?? "";
  const output = match[2] ?? "";
  const wire = outputs.get(job)?.[output];
  if (!wire?.encoded) return undefined;
  let current: Template = wire.type;
  const path = (match[3] ?? "").slice(1).split(".");
  for (const [index, field] of path.entries()) {
    const next: Template[] = [];
    const members = current.kind === "union" ? current.options : [current];
    for (const member of members) {
      if (member.kind === "object" && Object.hasOwn(member.fields, field)) {
        const value = member.fields[field];
        if (value) next.push(value);
      } else if (index !== 0 || !guards.has(`${job}\0${output}\0${field}`))
        return undefined;
    }
    if (!next.length) return undefined;
    current = union(next);
  }
  return current;
}

function githubPresenceGuards(
  condition: string | undefined,
): ReadonlySet<string> {
  if (!condition) return new Set();
  let source = condition.trim();
  if (source.startsWith("${{") && source.endsWith("}}"))
    source = source.slice(3, -2).trim();
  const conjuncts: string[] = [];
  let depth = 0;
  let quoted = false;
  let start = 0;
  for (let index = 0; index < source.length; index++) {
    const character = source[index];
    if (character === "'") quoted = !quoted;
    if (quoted) continue;
    if (character === "(") depth++;
    if (character === ")") depth--;
    if (depth < 0 || (depth === 0 && source.slice(index, index + 2) === "||"))
      return new Set();
    if (depth === 0 && source.slice(index, index + 2) === "&&") {
      conjuncts.push(source.slice(start, index).trim());
      index++;
      start = index + 1;
    }
  }
  if (depth !== 0 || quoted) return new Set();
  conjuncts.push(source.slice(start).trim());
  const guards = new Set<string>();
  for (const part of conjuncts) {
    const match =
      /^fromJSON\(\s*needs\.([A-Za-z_][A-Za-z_0-9-]*)\.outputs\.([A-Za-z_][A-Za-z_0-9-]*)\s*\)\.([A-Za-z_][A-Za-z_0-9-]*)\s*!=\s*null$/iu.exec(
        part,
      );
    if (match) guards.add(`${match[1]}\0${match[2]}\0${match[3]}`);
  }
  return guards;
}

function splitGithubCondition(
  source: string,
  operator: "&&" | "||",
): readonly string[] | undefined {
  let depth = 0;
  let quoted = false;
  let start = 0;
  const parts: string[] = [];
  for (let index = 0; index < source.length; index++) {
    const character = source[index];
    if (character === "'") {
      quoted = !quoted;
      continue;
    }
    if (quoted) continue;
    if (character === "(") depth++;
    if (character === ")") depth--;
    if (depth < 0) return undefined;
    if (depth === 0 && source.slice(index, index + 2) === operator) {
      const part = source.slice(start, index).trim();
      if (!part) return undefined;
      parts.push(part);
      index++;
      start = index + 1;
    }
  }
  if (depth !== 0 || quoted) return undefined;
  const last = source.slice(start).trim();
  if (!last) return undefined;
  parts.push(last);
  return parts;
}

function githubConditionProvesNeedSucceeded(
  condition: string | undefined,
  producer: string,
): boolean {
  if (!condition) return true; // GitHub supplies implicit success().
  let source = condition.trim();
  if (source.startsWith("${{") && source.endsWith("}}"))
    source = source.slice(3, -2).trim();
  if (!/\b(?:always|cancelled|success|failure)\(\)/u.test(source)) return true;
  const alternatives = splitGithubCondition(source, "||");
  if (alternatives?.length !== 1) return false;
  const conjuncts = splitGithubCondition(source, "&&");
  if (!conjuncts) return false;
  return conjuncts.some(
    (part) =>
      part === "success()" || part === `needs.${producer}.result == 'success'`,
  );
}

function githubNeedsOutputsAvailable(
  expression: string,
  condition: string | undefined,
  jobCondition?: string,
): boolean {
  for (const match of expression.matchAll(
    /\bneeds\.([A-Za-z_][A-Za-z_0-9-]*)\.outputs\.[A-Za-z_][A-Za-z_0-9-]*/gu,
  )) {
    const producer = match[1] ?? "";
    if (
      !githubConditionProvesNeedSucceeded(condition, producer) ||
      !githubConditionProvesNeedSucceeded(jobCondition, producer)
    )
      return false;
  }
  return true;
}

function githubConditionIsTyped(
  text: string,
  context: {
    readonly jobId: string;
    readonly needs: readonly string[];
    readonly inputs: Readonly<Record<string, Template>>;
    readonly inputWires?: Readonly<Record<string, GithubFileValue>>;
    readonly jobOutputs: ReadonlyMap<
      string,
      Readonly<Record<string, GithubFileValue>>
    >;
    readonly stepOutputs: ReadonlyMap<string, StepOutputProducer>;
  },
): boolean {
  let source = text.trim();
  if (source.startsWith("${{") && source.endsWith("}}"))
    source = source.slice(3, -2).trim();
  if (source.length === 0 || source.length > 4096 || source.includes("${{"))
    return false;
  if (!githubNeedsOutputsAvailable(source, source)) return false;
  if (
    /\bneeds\.[A-Za-z_][A-Za-z_0-9-]*\.result\s*==\s*'skipped'/u.test(source) &&
    !/\b(?:cancelled|always|success|failure)\(\)/u.test(source)
  )
    return false;
  const typed = (expression: string, depth: number): boolean => {
    if (depth > 32) return false;
    const value = expression.trim();
    const ors = splitGithubCondition(value, "||");
    if (!ors) return false;
    if (ors.length > 1) return ors.every((part) => typed(part, depth + 1));
    const ands = splitGithubCondition(value, "&&");
    if (!ands) return false;
    if (ands.length > 1) return ands.every((part) => typed(part, depth + 1));
    if (value.startsWith("(") && value.endsWith(")"))
      return typed(value.slice(1, -1), depth + 1);
    if (value.startsWith("!")) return typed(value.slice(1), depth + 1);
    if (["true", "false", "cancelled()"].includes(value)) return true;

    const step =
      /^steps\.([A-Za-z_][A-Za-z_0-9-]*)\.outputs\.([A-Za-z_][A-Za-z_0-9-]*)\s*(?:==|!=)\s*'[^']*'$/u.exec(
        value,
      );
    if (step) {
      const producer = context.stepOutputs.get(`${context.jobId}\0${step[1]}`);
      return Boolean(
        producer?.optionalRawOutputs === true ||
          producer?.optionalRawOutputs?.includes(step[2] ?? "") ||
          (producer?.complete && ownFileValue(producer.values, step[2] ?? "")),
      );
    }
    const output =
      /^needs\.([A-Za-z_][A-Za-z_0-9-]*)\.outputs\.([A-Za-z_][A-Za-z_0-9-]*)\s*(?:==|!=)\s*'[^']*'$/u.exec(
        value,
      );
    if (output)
      return (
        context.needs.includes(output[1] ?? "") &&
        Boolean(context.jobOutputs.get(output[1] ?? "")?.[output[2] ?? ""])
      );
    const result =
      /^needs\.([A-Za-z_][A-Za-z_0-9-]*)\.result\s*(?:==|!=)\s*'(?:success|failure|cancelled|skipped)'$/u.exec(
        value,
      );
    if (result) return context.needs.includes(result[1] ?? "");
    const input =
      /^inputs\.([A-Za-z_][A-Za-z_0-9-]*)\s*(?:==|!=)\s*'[^']*'$/u.exec(value);
    if (input)
      return Boolean(
        context.inputs[input[1] ?? ""] &&
          isAssignable(context.inputs[input[1] ?? ""] as Template, {
            kind: "primitive",
            name: "string",
          }),
      );
    const decodedInput =
      /^fromJSON\(\s*inputs\.([A-Za-z_][A-Za-z_0-9-]*)\s*\)\s*(?:==|!=)\s*'[^']*'$/iu.exec(
        value,
      );
    if (decodedInput) {
      const name = decodedInput[1] ?? "";
      const wire = context.inputWires?.[name];
      return Boolean(
        context.inputs[name] &&
          wire?.encoded &&
          isAssignable(wire.type, { kind: "primitive", name: "string" }),
      );
    }
    const presence =
      /^fromJSON\(\s*needs\.([A-Za-z_][A-Za-z_0-9-]*)\.outputs\.([A-Za-z_][A-Za-z_0-9-]*)\s*\)\.([A-Za-z_][A-Za-z_0-9-]*)\s*(?:==|!=)\s*null$/iu.exec(
        value,
      );
    if (presence) {
      if (!context.needs.includes(presence[1] ?? "")) return false;
      const wire = context.jobOutputs.get(presence[1] ?? "")?.[
        presence[2] ?? ""
      ];
      if (!wire?.encoded) return false;
      const members =
        wire.type.kind === "union" ? wire.type.options : [wire.type];
      return members.every((member) => member.kind === "object");
    }
    return false;
  };
  return typed(source, 0);
}

function orderGithubJobs(needs: Readonly<Record<string, readonly string[]>>): {
  readonly order: readonly string[];
  readonly cycle: boolean;
  readonly overBudget: boolean;
} {
  const ids = Object.keys(needs);
  if (ids.length > 256) return { order: ids, cycle: false, overBudget: true };
  const visiting = new Set<string>();
  const done = new Set<string>();
  const order: string[] = [];
  let cycle = false;
  const visit = (id: string): void => {
    if (done.has(id)) return;
    if (visiting.has(id)) {
      cycle = true;
      return;
    }
    visiting.add(id);
    for (const parent of needs[id] ?? [])
      if (Object.hasOwn(needs, parent)) visit(parent);
    visiting.delete(id);
    done.add(id);
    order.push(id);
  };
  for (const id of ids) visit(id);
  return { order, cycle, overBudget: false };
}

async function loadParser(): Promise<BashParser> {
  const cliRequire = createRequire(import.meta.url);
  const grammarPath = resolve(
    dirname(cliRequire.resolve("@vscode/tree-sitter-wasm/package.json")),
    "wasm/tree-sitter-bash.wasm",
  );
  const coreRequire = createRequire(import.meta.resolve("@pipe-ls/core"));
  const runtimePath = resolve(
    dirname(coreRequire.resolve("web-tree-sitter")),
    "web-tree-sitter.wasm",
  );
  const grammar = readFileSync(grammarPath);
  const runtime = readFileSync(runtimePath);
  if (
    createHash("sha256").update(grammar).digest("hex") !==
      "a14e9ed880b2c3f16cd00c796c38d237a3e9b028bdec5b4315c76976e67b01ca" ||
    createHash("sha256").update(runtime).digest("hex") !==
      "c03bccdc3b448a32848f5ae327e209c982bbb0840d43eec8bc2d5759544a1ed3"
  )
    throw new Error("Bash WASM asset checksum mismatch");
  return createBashParser(runtime, grammar);
}

/** Read-only CLI analysis; never executes scripts or external business tools. */
export async function checkPaths(
  entries: readonly string[],
): Promise<CheckReport> {
  const paths = entries.length ? entries : [process.cwd()];
  const targets = new Map<string, Target>();
  for (const entry of paths) {
    const root = discoverProjectRoot(entry);
    for (const target of discoverTargets(
      root,
      entries.length ? entry : undefined,
    ))
      targets.set(target.path, target);
  }
  if (targets.size === 0)
    throw new ProjectDiscoveryError(
      "No Bash scripts or GitHub workflows found",
    );
  const parser = await loadParser();
  const diagnostics: ReportDiagnostic[] = [];
  const unverifiedDependencies = new Set<string>();
  const fileEffects = new Set<string>();
  let fileEffectsUnknown = false;
  const externalEffects = new Set<string>();
  const markUnverified = (path: string): void => {
    if (isAbsolute(path))
      unverifiedDependencies.add(pathToFileURL(resolve(path)).href);
  };
  const snapshots = new Map<string, ProjectSnapshot>();
  const snapshotOf = (root: string): ProjectSnapshot => {
    let snapshot = snapshots.get(root);
    if (!snapshot) {
      snapshot = new ProjectSnapshot(root);
      snapshots.set(root, snapshot);
    }
    return snapshot;
  };
  const failedReads = new Set<string>();
  const sourceAt = (root: string, path: string): string | undefined => {
    const result = snapshotOf(root).read(path);
    if (result.kind === "file") return result.source;
    if (!failedReads.has(path) && result.reason.includes("byte budget")) {
      failedReads.add(path);
      diagnostics.push(
        detail(
          path,
          "",
          blocked("PIPE204", result.reason, { start: 0, end: 0 }),
        ),
      );
    }
    return undefined;
  };
  const readGithubFile = (
    root: string,
    caller: string,
    candidate: string,
    rootWorkingDirectory: boolean,
    repositoryProof: { readonly verified: boolean; readonly reason: string },
  ) => {
    if (!rootWorkingDirectory && !isAbsolute(candidate))
      return {
        kind: "unavailable" as const,
        reason: "GitHub working directory is not proven",
      };
    const path = isAbsolute(candidate) ? candidate : resolve(root, candidate);
    snapshotOf(root).recordDependency(caller, path);
    if (!repositoryProof.verified) {
      markUnverified(path);
      return {
        kind: "unavailable" as const,
        reason: repositoryProof.reason,
      };
    }
    const result = snapshotOf(root).read(path);
    if (result.kind === "unavailable") markUnverified(path);
    return result;
  };
  const localCache = new Map<string, LocalScriptSummary>();
  const loadingLocal = new Set<string>();
  let checkedUnits = 0;
  const resolveLocalPath = (
    root: string,
    path: string,
  ): LocalScriptSummary | undefined => {
    const source = sourceAt(root, path);
    if (source === undefined) return undefined;
    const cached = localCache.get(path);
    if (cached) return cached;
    const contract = parseScriptContract(source);
    if (loadingLocal.has(path)) return { contract, complete: false };
    loadingLocal.add(path);
    try {
      const shebang = source.split(/\r?\n/u, 1)[0] ?? "";
      if (
        !/^#!(?:\S*\/bash|\S*\/env(?:\s+-S)?\s+bash)(?:\s|$)/u.test(shebang)
      ) {
        diagnostics.push(
          detail(
            path,
            source,
            blocked("PIPE203", "Local script has no Bash execution context", {
              start: 0,
              end: shebang.length,
            }),
          ),
        );
        const summary = { contract, complete: false };
        localCache.set(path, summary);
        return summary;
      }
      const result = analyzeScript(source, parser, {
        resolveLocalScript: (command) => resolveLocal(root, path, command),
        scriptDirectory: dirname(path),
        resolveDirectory: (candidate) => {
          snapshotOf(root).recordDependency(path, candidate);
          const result = snapshotOf(root).directory(candidate);
          if (result.kind === "unavailable") markUnverified(candidate);
          return result;
        },
        readLocalFile: (candidate) => {
          snapshotOf(root).recordDependency(path, candidate);
          const result = snapshotOf(root).read(candidate);
          if (result.kind === "unavailable") markUnverified(candidate);
          return result;
        },
      });
      for (const path of result.effects.filesMayWrite)
        if (isAbsolute(path))
          fileEffects.add(pathToFileURL(resolve(path)).href);
      fileEffectsUnknown ||= result.effects.filesMayWriteUnknown;
      for (const effect of result.effects.externalMayRun)
        externalEffects.add(effect);
      for (const item of result.diagnostics)
        diagnostics.push(detail(path, source, item));
      const summary = {
        contract,
        complete: result.complete,
        effects: result.effects,
      };
      localCache.set(path, summary);
      return summary;
    } finally {
      loadingLocal.delete(path);
    }
  };
  const resolveLocal = (
    root: string,
    caller: string,
    command: string,
  ): LocalScriptSummary | undefined => {
    const path = resolve(root, command);
    snapshotOf(root).recordDependency(caller, path);
    const result = resolveLocalPath(root, path);
    if (!result) markUnverified(path);
    return result;
  };
  const resolveGithubLocal = (
    root: string,
    caller: string,
    command: string,
    unit: RunUnit,
    repositoryProof: { readonly verified: boolean; readonly reason: string },
  ): LocalScriptSummary | undefined => {
    if (!unit.rootWorkingDirectory || !repositoryProof.verified) {
      const path = resolve(root, command);
      snapshotOf(root).recordDependency(caller, path);
      markUnverified(path);
      return undefined;
    }
    return resolveLocal(root, caller, command);
  };
  const resolveGithubDirectory = (
    root: string,
    caller: string,
    candidate: string,
    unit: RunUnit,
    repositoryProof: { readonly verified: boolean; readonly reason: string },
  ) => {
    snapshotOf(root).recordDependency(caller, candidate);
    if (!unit.rootWorkingDirectory || !repositoryProof.verified) {
      markUnverified(candidate);
      return {
        kind: "unavailable" as const,
        reason: !unit.rootWorkingDirectory
          ? "GitHub working directory is not proven"
          : repositoryProof.reason,
      };
    }
    const result = snapshotOf(root).directory(candidate);
    if (result.kind === "unavailable") markUnverified(candidate);
    return result;
  };
  const analyzeAction = (
    path: string,
    source: string,
    workflow: GithubWorkflow,
    unit: GithubActionUnit,
    invocation: InvocationEnvironment,
    environments: Map<string, Record<string, GithubFileValue>>,
    unprovenEnvironmentJobs: Set<string>,
    unprovenStartupJobs: Set<string>,
    stepOutputs: Map<string, StepOutputProducer>,
    jobOutputs: ReadonlyMap<string, Readonly<Record<string, GithubFileValue>>>,
    inputWires?: Readonly<Record<string, GithubFileValue>> | null,
  ): void => {
    checkedUnits++;
    const before = diagnostics.length;
    const job = unit.jobId ?? "";
    const stepContext = {
      jobId: job,
      outputs: stepOutputs,
      condition: unit.condition?.text,
    };
    if (
      unit.conditional &&
      (!unit.condition ||
        !githubConditionIsTyped(unit.condition.text, {
          jobId: job,
          needs: workflow.jobNeeds[job] ?? [],
          inputs: workflow.inputs,
          ...(inputWires ? { inputWires } : {}),
          jobOutputs,
          stepOutputs,
        }))
    )
      diagnostics.push(
        detail(
          path,
          source,
          blocked(
            "PIPE203",
            "Action if context is not verified",
            unit.condition?.span ?? unit.span,
          ),
        ),
      );
    const facts = githubNativeEnvironment(
      unit,
      workflow.inputs,
      invocation.prior,
      invocation.globalsUnverified,
      jobOutputs,
      inputWires,
      workflow.jobConditions[job]?.text,
      {},
      invocation.startupUnverified,
      stepContext,
    );
    // configure uses Bash, and load-secrets may invoke its Bash installer.
    // No startup code is read or executed by this checker.
    if (
      unit.actionModel.kind !== "aws-credentials" &&
      facts.BASH_ENV &&
      facts.BASH_ENV.text !== ""
    )
      diagnostics.push(
        detail(
          path,
          source,
          blocked(
            "PIPE203",
            "Action Bash startup context is not verified",
            unit.env.BASH_ENV?.span ?? unit.span,
          ),
        ),
      );
    let awsOutputs: readonly string[] | undefined;
    if (unit.actionModel.kind === "aws-credentials") {
      const model = unit.actionModel;
      for (const [name, input] of [
        ["access key", model.accessKey],
        ["secret key", model.secretKey],
      ] as const) {
        const inputSource = input.source;
        const producer =
          inputSource.kind === "step-output"
            ? stepOutputs.get(`${job}\0${inputSource.stepId}`)
            : undefined;
        const wire =
          inputSource.kind === "step-output" &&
          producer &&
          stepOutputIsAvailable(producer, unit.condition?.text)
            ? ownFileValue(producer.values, inputSource.name)
            : undefined;
        const nonBlank =
          inputSource.kind === "literal"
            ? inputSource.nonBlank
            : Boolean(
                wire?.nonBlank ||
                  (wire?.text !== undefined && wire.text.trim() !== ""),
              );
        if (!nonBlank)
          diagnostics.push(
            detail(
              path,
              source,
              blocked(
                "PIPE203",
                `AWS ${name} input is not proven nonblank after input trimming; default credential fallback is not modeled`,
                input.span,
              ),
            ),
          );
      }
      if (model.sessionToken?.source.kind === "step-output") {
        const reference = model.sessionToken.source;
        const producer = stepOutputs.get(`${job}\0${reference.stepId}`);
        if (
          !producer ||
          !stepOutputIsAvailable(producer, unit.condition?.text) ||
          !ownFileValue(producer.values, reference.name)
        )
          diagnostics.push(
            detail(
              path,
              source,
              blocked(
                "PIPE203",
                "AWS session token source is not verified",
                model.sessionToken.span,
              ),
            ),
          );
      }
      const empty = (name: string): boolean => facts[name]?.text === "";
      const blankInput = (name: string): boolean =>
        facts[name]?.text !== undefined && facts[name]?.text?.trim() === "";
      const disabled = (pinned: false | undefined, name: string): boolean =>
        pinned === false ||
        (facts[name]?.text !== undefined &&
          (blankInput(name) ||
            facts[name]?.text?.trim().toLowerCase() !== "true"));
      if (
        (model.roleFromEnvironment && !blankInput("ROLE_TO_ASSUME")) ||
        !disabled(model.roleChaining, "ROLE_CHAINING") ||
        !disabled(model.useExisting, "USE_EXISTING_CREDENTIALS") ||
        !empty("AWS_PROFILE") ||
        !empty("HTTP_PROXY") ||
        !empty("HTTPS_PROXY")
      )
        diagnostics.push(
          detail(
            path,
            source,
            blocked(
              "PIPE203",
              "AWS IAM envelope requires verified disabled role/existing-credential controls and empty profile/proxy environment",
              unit.span,
            ),
          ),
        );
      // Optional output activation may be inherited; both branches are bounded.
      const outputCredentials =
        model.outputCredentials ??
        (facts.OUTPUT_CREDENTIALS?.text === undefined
          ? undefined
          : facts.OUTPUT_CREDENTIALS.text.trim().toLowerCase() === "true");
      awsOutputs = [
        "aws-account-id",
        "authenticated-arn",
        ...(outputCredentials !== false
          ? ["aws-access-key-id", "aws-secret-access-key", "aws-session-token"]
          : []),
      ];
      externalEffects.add("github aws credentials");
      externalEffects.add("aws sts GetCallerIdentity");
      externalEffects.add("github aws credentials cleanup");
    } else
      externalEffects.add(
        unit.actionModel.kind === "onepassword-configure"
          ? "github onepassword configure"
          : "github onepassword load-secrets",
      );
    // configure's ordinary echo allows LF-injected arbitrary GENV records.
    // load scans inherited env, may unset arbitrary managed names, adds PATH,
    // and may install op in files/dirs that are not stable repository facts.
    // Keep all these effects, even in output-only mode and on interrupted runs.
    fileEffectsUnknown = true;
    if (unit.jobId) {
      invalidateGithubEnvFacts(environments, unit.jobId);
      unprovenEnvironmentJobs.add(unit.jobId);
      unprovenStartupJobs.add(unit.jobId);
    }
    if (unit.jobId && unit.stepId)
      stepOutputs.set(`${unit.jobId}\0${unit.stepId}`, {
        complete: diagnostics.length === before,
        conditional: unit.conditional,
        ...(unit.condition ? { condition: unit.condition.text } : {}),
        values: {},
        ...(diagnostics.length === before && awsOutputs
          ? { optionalRawOutputs: awsOutputs }
          : {}),
        ...(diagnostics.length === before &&
        unit.actionModel.kind === "onepassword-load" &&
        !unit.actionModel.exportEnv
          ? { optionalRawOutputs: true as const }
          : {}),
      });
  };
  const verifyCallableWorkflow = (
    root: string,
    path: string,
    source: string,
    workflow: GithubWorkflow,
    inputWires: Readonly<Record<string, GithubFileValue>>,
  ): boolean => {
    const before = diagnostics.length;
    for (const issue of workflow.issues)
      diagnostics.push(
        detail(path, source, {
          ...issue,
          status:
            issue.code === "PIPE001" || issue.code === "PIPE104"
              ? "error"
              : "blocked",
        }),
      );
    const hostContextProven = workflow.issues.length === 0;
    const units = workflowUnits(workflow);
    const runJobs = new Set(units.map((unit) => unit.jobId));
    if (
      !workflow.workflowCallable ||
      !workflow.workflowCallInputs ||
      !workflow.workflowCallSecrets ||
      workflow.workflowCallOutputs?.length !== 0 ||
      workflow.dependencies.length > 0 ||
      workflow.jobOutputMappings.length > 0 ||
      units.length === 0 ||
      Object.keys(workflow.jobConditions).length > 0 ||
      Object.entries(workflow.jobNeeds).some(
        ([job, needs]) => needs.length > 0 || !runJobs.has(job),
      ) ||
      workflow.issues.some((issue) => issue.code === "PIPE001")
    )
      return false;
    const priorEnv = new Map<string, Record<string, GithubFileValue>>();
    const unprovenEnvironmentJobs = new Set<string>();
    const unprovenStartupJobs = new Set<string>();
    const retryEntries = new Map<string, InvocationEnvironment>();
    const stepOutputs = new Map<string, StepOutputProducer>();
    const barriers = unverifiedStepBarriers(workflow);
    const repositoryState: RepositoryRunState = {
      checkoutGeneration: new Map(),
      unverifiedAfterRun: new Set(),
    };
    for (const unit of units) {
      const repositoryProof = repositoryProofForRun(unit, repositoryState);
      if (unit.jobId && crossedUnverifiedStep(barriers, unit)) {
        invalidateGithubEnvFacts(priorEnv, unit.jobId);
        unprovenEnvironmentJobs.add(unit.jobId);
      }
      const invocation = invocationEnvironment(
        unit,
        priorEnv,
        unprovenEnvironmentJobs,
        unprovenStartupJobs,
        retryEntries,
      );
      if ("actionModel" in unit) {
        analyzeAction(
          path,
          source,
          workflow,
          unit,
          invocation,
          priorEnv,
          unprovenEnvironmentJobs,
          unprovenStartupJobs,
          stepOutputs,
          new Map(),
          inputWires,
        );
        unverifyRepositoryAfterRun(unit, repositoryState);
        continue;
      }
      checkedUnits++;
      if (unit.retryModel) {
        externalEffects.add("github retry bash");
        // The wrapper writes its runner output file; interrupted attempts can
        // leave partial records and unresolved descendants/file effects.
        fileEffectsUnknown = true;
        if (unit.jobId) unprovenStartupJobs.add(unit.jobId);
      }
      if (
        unit.shell !== "bash" ||
        (unit.conditional &&
          (!unit.condition ||
            !githubConditionIsTyped(unit.condition.text, {
              jobId: unit.jobId ?? "",
              needs: workflow.jobNeeds[unit.jobId ?? ""] ?? [],
              inputs: workflow.inputs,
              inputWires,
              jobOutputs: new Map(),
              stepOutputs,
            }))) ||
        unit.script.includes("${{")
      ) {
        if (unit.jobId) {
          invalidateGithubEnvFacts(priorEnv, unit.jobId);
          unprovenEnvironmentJobs.add(unit.jobId);
        }
        unverifyRepositoryAfterRun(unit, repositoryState);
        diagnostics.push(
          detail(
            path,
            source,
            blocked(
              "PIPE203",
              unit.executionUnverified && unit.script.includes("${{")
                ? "Opaque action command contains an unanalyzed GitHub expression"
                : "Reusable workflow run context is not yet analyzed",
              unit.span,
            ),
          ),
        );
        continue;
      }
      const contract = parseScriptContract(unit.script);
      if (unit.retryModel && contract.stdin)
        diagnostics.push(
          detail(path, source, {
            code: "PIPE104",
            status: "error",
            span: unit.span,
            message: "Retry command has no injected stdin interface",
          }),
        );
      const beforeEnv = diagnostics.length;
      for (const [name, expected] of Object.entries(contract.env)) {
        const { binding, prior } = githubEnvironmentSource(
          unit,
          name,
          invocation.prior,
          invocation.globalsUnverified,
        );
        const value = binding
          ? githubEnvValue(
              binding.text,
              workflow.inputs,
              new Map(),
              inputWires,
              {
                jobId: unit.jobId ?? "",
                outputs: stepOutputs,
                condition: unit.condition?.text,
              },
            )
          : prior
            ? prior.encoded
              ? { kind: "json" as const, type: prior.type }
              : { kind: "raw" as const }
            : { kind: "unknown" as const };
        if (value.kind === "unknown")
          diagnostics.push(
            detail(
              path,
              source,
              blocked(
                "PIPE203",
                `Reusable workflow env ${name} injection is not verified`,
                binding?.span ?? unit.span,
              ),
            ),
          );
        else if (value.kind === "raw")
          diagnostics.push(
            detail(path, source, {
              code: "PIPE101",
              message: `Reusable workflow env ${name} is not JSON encoded`,
              span: binding?.span ?? unit.span,
              status: "error",
            }),
          );
        else if (!isAssignable(value.type, expected))
          diagnostics.push(
            detail(path, source, {
              code: "PIPE102",
              message: `Reusable workflow env ${name} does not match declared JSON type`,
              span: binding?.span ?? unit.span,
              status: "error",
            }),
          );
      }
      const envProven = diagnostics.length === beforeEnv;
      const analysis = analyzeScript(unit.script, parser, {
        githubFiles: true,
        environment: githubNativeEnvironment(
          unit,
          workflow.inputs,
          invocation.prior,
          invocation.globalsUnverified,
          new Map(),
          inputWires,
          undefined,
          contract.env,
          invocation.startupUnverified,
          {
            jobId: unit.jobId ?? "",
            outputs: stepOutputs,
            condition: unit.condition?.text,
          },
        ),
        resolveLocalScript: (command) =>
          resolveGithubLocal(root, path, command, unit, repositoryProof),
        resolveDirectory: (candidate) =>
          resolveGithubDirectory(root, path, candidate, unit, repositoryProof),
        readLocalFile: (candidate) =>
          readGithubFile(
            root,
            path,
            candidate,
            unit.rootWorkingDirectory,
            repositoryProof,
          ),
      });
      if (
        unit.executionUnverified ||
        !analysis.complete ||
        !envProven ||
        analysis.effects.filesMayWrite.length ||
        analysis.effects.filesMayWriteUnknown
      )
        unverifyRepositoryAfterRun(unit, repositoryState);
      for (const file of analysis.effects.filesMayWrite)
        if (isAbsolute(file))
          fileEffects.add(pathToFileURL(resolve(file)).href);
      fileEffectsUnknown ||= analysis.effects.filesMayWriteUnknown;
      for (const effect of analysis.effects.externalMayRun)
        externalEffects.add(effect);
      for (const issue of analysis.diagnostics)
        diagnostics.push(
          detail(path, source, {
            ...issue,
            span: unit.map.mapSpan(issue.span).span,
          }),
        );
      if (unit.jobId) {
        if (
          analysis.effects.githubEnvMayWrite.includes("BASH_ENV") &&
          (unit.conditional ||
            !Object.hasOwn(analysis.effects.githubEnv, "BASH_ENV"))
        )
          unprovenStartupJobs.add(unit.jobId);
        if (
          hostContextProven &&
          !unit.executionUnverified &&
          analysis.complete &&
          envProven &&
          !analysis.effects.filesMayWriteUnknown
        ) {
          invalidateGithubEnvFacts(
            priorEnv,
            unit.jobId,
            analysis.effects.githubEnvMayWrite,
          );
          if (!unit.conditional) {
            const environment = priorEnv.get(unit.jobId) ?? Object.create(null);
            Object.assign(environment, analysis.effects.githubEnv);
            priorEnv.set(unit.jobId, environment);
          }
          const definite = new Set(Object.keys(analysis.effects.githubEnv));
          if (
            analysis.effects.githubEnvMayWrite.some(
              (name) => unit.conditional || !definite.has(name),
            )
          )
            unprovenEnvironmentJobs.add(unit.jobId);
        } else {
          invalidateGithubEnvFacts(priorEnv, unit.jobId);
          unprovenEnvironmentJobs.add(unit.jobId);
        }
      }
      if (unit.jobId && unit.stepId)
        stepOutputs.set(`${unit.jobId}\0${unit.stepId}`, {
          complete:
            !unit.executionUnverified &&
            analysis.complete &&
            envProven &&
            !analysis.effects.filesMayWriteUnknown,
          conditional: unit.conditional,
          ...(unit.condition ? { condition: unit.condition.text } : {}),
          values: analysis.effects.githubOutput,
        });
    }
    return diagnostics.length === before;
  };
  try {
    for (const target of targets.values()) {
      const source = sourceAt(target.root, target.path);
      if (source === undefined) {
        if (!failedReads.has(target.path)) {
          const read = snapshotOf(target.root).read(target.path);
          diagnostics.push(
            detail(
              target.path,
              "",
              blocked(
                "PIPE204",
                `Target source is unavailable: ${read.kind === "unavailable" ? read.reason : "unknown read failure"}`,
                { start: 0, end: 0 },
              ),
            ),
          );
          failedReads.add(target.path);
        }
        continue;
      }
      if (target.kind === "script") {
        checkedUnits++;
        resolveLocalPath(target.root, target.path);
        continue;
      }
      const workflow = extractGithubWorkflow(source);
      for (const item of workflow.issues)
        diagnostics.push(
          detail(target.path, source, {
            ...item,
            status:
              item.code === "PIPE001" || item.code === "PIPE104"
                ? "error"
                : "blocked",
          }),
        );
      const pendingCalls: Array<{
        readonly dependency: LocalDependency;
        readonly callee: GithubWorkflow;
        readonly path: string;
        readonly source: string;
      }> = [];
      for (const dependency of workflow.dependencies) {
        const path = resolve(target.root, dependency.path);
        snapshotOf(target.root).recordDependency(target.path, path);
        const calleeSource = sourceAt(target.root, path);
        if (calleeSource === undefined) {
          markUnverified(path);
          diagnostics.push(
            detail(
              target.path,
              source,
              blocked(
                "PIPE204",
                `Local workflow dependency is unavailable: ${dependency.path}`,
                dependency.span,
              ),
            ),
          );
        } else {
          const callee = extractGithubWorkflow(calleeSource);
          pendingCalls.push({
            dependency,
            callee,
            path,
            source: calleeSource,
          });
          if (!callee.workflowCallable)
            diagnostics.push(
              detail(target.path, source, {
                code: "PIPE104",
                message: `Local workflow ${dependency.path} does not declare workflow_call`,
                span: dependency.span,
                status: "error",
              }),
            );
          if (callee.workflowCallOutputs !== undefined)
            for (const reference of workflow.outputReferences) {
              if (
                reference.jobId === dependency.jobId &&
                !callee.workflowCallOutputs.includes(reference.name)
              )
                diagnostics.push(
                  detail(target.path, source, {
                    code: "PIPE104",
                    message: `Reusable workflow ${dependency.path} has no output ${reference.name}`,
                    span: reference.span,
                    status: "error",
                  }),
                );
            }
        }
      }
      const jobEnvironment = new Map<string, Record<string, GithubFileValue>>();
      const unprovenEnvironmentJobs = new Set<string>();
      const unprovenStartupJobs = new Set<string>();
      const retryEntries = new Map<string, InvocationEnvironment>();
      const verifiedJobOutputs = new Map<
        string,
        Readonly<Record<string, GithubFileValue>>
      >();
      const stepOutputs = new Map<string, StepOutputProducer>();
      const finishJob = (jobId: string): void => {
        const values: Record<string, GithubFileValue> = Object.create(null);
        for (const mapping of workflow.jobOutputMappings) {
          if (mapping.jobId !== jobId) continue;
          const producer = stepOutputs.get(
            `${mapping.jobId}\0${mapping.stepId}`,
          );
          if (producer?.conditional)
            diagnostics.push(
              detail(target.path, source, {
                code: "PIPE104",
                message: `Job output ${mapping.jobId}.${mapping.name} may be absent because step ${mapping.stepId} is conditional`,
                span: mapping.span,
                status: "error",
              }),
            );
          else if (workflow.jobConditional[jobId])
            diagnostics.push(
              detail(
                target.path,
                source,
                blocked(
                  "PIPE203",
                  `Job output ${mapping.jobId}.${mapping.name} may be absent because the job is conditional`,
                  mapping.span,
                ),
              ),
            );
          else if (!producer?.complete || producer.optionalRawOutputs)
            diagnostics.push(
              detail(
                target.path,
                source,
                blocked(
                  "PIPE203",
                  `Job output ${mapping.jobId}.${mapping.name} has no verified producing step`,
                  mapping.span,
                ),
              ),
            );
          else {
            const value = ownFileValue(producer.values, mapping.stepOutput);
            if (!value)
              diagnostics.push(
                detail(target.path, source, {
                  code: "PIPE104",
                  message: `Step ${mapping.stepId} does not write GITHUB_OUTPUT ${mapping.stepOutput}`,
                  span: mapping.span,
                  status: "error",
                }),
              );
            else values[mapping.name] = value;
          }
        }
        verifiedJobOutputs.set(jobId, values);
      };
      const jobOrder = orderGithubJobs(workflow.jobNeeds);
      if (jobOrder.cycle || jobOrder.overBudget)
        diagnostics.push(
          detail(
            target.path,
            source,
            blocked(
              "PIPE203",
              jobOrder.cycle
                ? "GitHub job needs graph contains a cycle"
                : "GitHub job graph exceeds its analysis budget",
              { start: 0, end: 0 },
            ),
          ),
        );
      const ranks = new Map(jobOrder.order.map((job, index) => [job, index]));
      const orderedRuns = [...workflowUnits(workflow)].sort(
        (a, b) =>
          (ranks.get(a.jobId ?? "") ?? Number.MAX_SAFE_INTEGER) -
          (ranks.get(b.jobId ?? "") ?? Number.MAX_SAFE_INTEGER),
      );
      const barriers = unverifiedStepBarriers(workflow);
      const repositoryState: RepositoryRunState = {
        checkoutGeneration: new Map(),
        unverifiedAfterRun: new Set(),
      };
      let priorJob: string | undefined;
      const finishedJobs = new Set<string>();
      for (const unit of orderedRuns) {
        if (priorJob && priorJob !== unit.jobId) {
          finishJob(priorJob);
          finishedJobs.add(priorJob);
        }
        priorJob = unit.jobId;
        const repositoryProof = repositoryProofForRun(unit, repositoryState);
        if (unit.jobId && crossedUnverifiedStep(barriers, unit)) {
          invalidateGithubEnvFacts(jobEnvironment, unit.jobId);
          unprovenEnvironmentJobs.add(unit.jobId);
        }
        const invocation = invocationEnvironment(
          unit,
          jobEnvironment,
          unprovenEnvironmentJobs,
          unprovenStartupJobs,
          retryEntries,
        );
        if ("actionModel" in unit) {
          analyzeAction(
            target.path,
            source,
            workflow,
            unit,
            invocation,
            jobEnvironment,
            unprovenEnvironmentJobs,
            unprovenStartupJobs,
            stepOutputs,
            verifiedJobOutputs,
            workflow.workflowCallable ? null : undefined,
          );
          unverifyRepositoryAfterRun(unit, repositoryState);
          continue;
        }
        if (unit.retryModel) {
          externalEffects.add("github retry bash");
          fileEffectsUnknown = true;
          if (unit.jobId) unprovenStartupJobs.add(unit.jobId);
        }
        const producerKey =
          unit.jobId && unit.stepId
            ? `${unit.jobId}\0${unit.stepId}`
            : undefined;
        if (producerKey)
          stepOutputs.set(producerKey, {
            complete: false,
            conditional: unit.conditional,
            values: {},
          });
        if (
          unit.condition &&
          (/\b(?:always|cancelled|success|failure)\(\)/u.test(
            unit.condition.text,
          ) ||
            !githubNeedsOutputsAvailable(
              unit.condition.text,
              unit.condition.text,
              workflow.jobConditions[unit.jobId ?? ""]?.text,
            ) ||
            !githubConditionIsTyped(unit.condition.text, {
              jobId: unit.jobId ?? "",
              needs: workflow.jobNeeds[unit.jobId ?? ""] ?? [],
              inputs: workflow.inputs,
              jobOutputs: verifiedJobOutputs,
              stepOutputs,
            }))
        )
          diagnostics.push(
            detail(
              target.path,
              source,
              blocked(
                "PIPE203",
                "GitHub step if expression or its output source is not yet verified",
                unit.condition.span,
              ),
            ),
          );
        checkedUnits++;
        if (unit.shell !== "bash") {
          unverifyRepositoryAfterRun(unit, repositoryState);
          if (unit.jobId) {
            invalidateGithubEnvFacts(jobEnvironment, unit.jobId);
            unprovenEnvironmentJobs.add(unit.jobId);
          }
          diagnostics.push(
            detail(
              target.path,
              source,
              blocked(
                "PIPE203",
                unit.shell === "other"
                  ? "Run uses a non-Bash shell outside the first-version analysis scope"
                  : "Bash shell context cannot be established",
                unit.span,
              ),
            ),
          );
          continue;
        }
        const contract = parseScriptContract(unit.script);
        if (unit.retryModel && contract.stdin)
          diagnostics.push(
            detail(target.path, source, {
              code: "PIPE104",
              status: "error",
              span: unit.span,
              message: "Retry command has no injected stdin interface",
            }),
          );
        const beforeEnv = diagnostics.length;
        for (const [name, expected] of Object.entries(contract.env)) {
          const { binding, prior } = githubEnvironmentSource(
            unit,
            name,
            invocation.prior,
            invocation.globalsUnverified,
          );
          if (!binding) {
            if (!prior)
              diagnostics.push(
                detail(
                  target.path,
                  source,
                  workflow.issues.length || invocation.globalsUnverified
                    ? blocked(
                        "PIPE203",
                        `GitHub env ${name} has no statically proven injection`,
                        unit.span,
                      )
                    : {
                        code: "PIPE104",
                        message: `GitHub env ${name} has no statically proven injection`,
                        span: unit.span,
                        status: "error",
                      },
                ),
              );
            else if (!prior.encoded)
              diagnostics.push(
                detail(target.path, source, {
                  code: "PIPE101",
                  message: `GitHub env ${name} from a previous step is not JSON encoded`,
                  span: unit.span,
                  status: "error",
                }),
              );
            else if (!isAssignable(prior.type, expected))
              diagnostics.push(
                detail(target.path, source, {
                  code: "PIPE102",
                  message: `GitHub env ${name} from a previous step does not match declared JSON type`,
                  span: unit.span,
                  status: "error",
                }),
              );
            continue;
          }
          const value = githubEnvValue(
            binding.text,
            workflow.inputs,
            verifiedJobOutputs,
            workflow.workflowCallable ? null : undefined,
            {
              jobId: unit.jobId ?? "",
              outputs: stepOutputs,
              condition: unit.condition?.text,
            },
          );
          if (
            value.kind === "unknown" ||
            !githubNeedsOutputsAvailable(
              binding.text,
              unit.condition?.text,
              workflow.jobConditions[unit.jobId ?? ""]?.text,
            )
          )
            diagnostics.push(
              detail(
                target.path,
                source,
                blocked(
                  "PIPE203",
                  `GitHub env ${name} expression is not yet analyzed`,
                  binding.span,
                ),
              ),
            );
          else if (value.kind === "raw")
            diagnostics.push(
              detail(target.path, source, {
                code: "PIPE101",
                message: `GitHub env ${name} is not JSON encoded`,
                span: binding.span,
                status: "error",
              }),
            );
          else if (!isAssignable(value.type, expected))
            diagnostics.push(
              detail(target.path, source, {
                code: "PIPE102",
                message: `GitHub env ${name} does not match declared JSON type`,
                span: binding.span,
                status: "error",
              }),
            );
        }
        const envProven = diagnostics.length === beforeEnv;
        if (unit.script.includes("${{")) {
          unverifyRepositoryAfterRun(unit, repositoryState);
          if (unit.jobId) {
            invalidateGithubEnvFacts(jobEnvironment, unit.jobId);
            unprovenEnvironmentJobs.add(unit.jobId);
          }
          diagnostics.push(
            detail(
              target.path,
              source,
              blocked(
                "PIPE203",
                unit.executionUnverified
                  ? "Opaque action command contains an unanalyzed GitHub expression"
                  : "Direct GitHub expression in run is not yet analyzed",
                unit.span,
              ),
            ),
          );
          continue;
        }
        const analysis = analyzeScript(unit.script, parser, {
          githubFiles: true,
          environment: githubNativeEnvironment(
            unit,
            workflow.inputs,
            invocation.prior,
            invocation.globalsUnverified,
            verifiedJobOutputs,
            workflow.workflowCallable ? null : undefined,
            workflow.jobConditions[unit.jobId ?? ""]?.text,
            contract.env,
            invocation.startupUnverified,
            {
              jobId: unit.jobId ?? "",
              outputs: stepOutputs,
              condition: unit.condition?.text,
            },
          ),
          resolveLocalScript: (command) =>
            resolveGithubLocal(
              target.root,
              target.path,
              command,
              unit,
              repositoryProof,
            ),
          resolveDirectory: (candidate) =>
            resolveGithubDirectory(
              target.root,
              target.path,
              candidate,
              unit,
              repositoryProof,
            ),
          readLocalFile: (candidate) =>
            readGithubFile(
              target.root,
              target.path,
              candidate,
              unit.rootWorkingDirectory,
              repositoryProof,
            ),
        });
        if (
          unit.executionUnverified ||
          !analysis.complete ||
          !envProven ||
          analysis.effects.filesMayWrite.length ||
          analysis.effects.filesMayWriteUnknown
        )
          unverifyRepositoryAfterRun(unit, repositoryState);
        for (const path of analysis.effects.filesMayWrite)
          if (isAbsolute(path))
            fileEffects.add(pathToFileURL(resolve(path)).href);
        fileEffectsUnknown ||= analysis.effects.filesMayWriteUnknown;
        for (const effect of analysis.effects.externalMayRun)
          externalEffects.add(effect);
        for (const item of analysis.diagnostics) {
          const origin = unit.map.mapSpan(item.span).span;
          diagnostics.push(
            detail(target.path, source, { ...item, span: origin }),
          );
        }
        if (unit.jobId) {
          if (
            analysis.effects.githubEnvMayWrite.includes("BASH_ENV") &&
            (unit.conditional ||
              !Object.hasOwn(analysis.effects.githubEnv, "BASH_ENV"))
          )
            unprovenStartupJobs.add(unit.jobId);
          if (
            !unit.executionUnverified &&
            analysis.complete &&
            envProven &&
            !analysis.effects.filesMayWriteUnknown
          ) {
            const mayWrite = analysis.effects.githubEnvMayWrite;
            invalidateGithubEnvFacts(jobEnvironment, unit.jobId, mayWrite);
            if (!unit.conditional) {
              const environment =
                jobEnvironment.get(unit.jobId) ?? Object.create(null);
              Object.assign(environment, analysis.effects.githubEnv);
              jobEnvironment.set(unit.jobId, environment);
            }
            const definite = new Set(Object.keys(analysis.effects.githubEnv));
            if (
              mayWrite.some((name) =>
                unit.conditional ? true : !definite.has(name),
              )
            )
              unprovenEnvironmentJobs.add(unit.jobId);
          } else {
            invalidateGithubEnvFacts(jobEnvironment, unit.jobId);
            unprovenEnvironmentJobs.add(unit.jobId);
          }
        }
        if (producerKey)
          stepOutputs.set(producerKey, {
            complete:
              !unit.executionUnverified &&
              analysis.complete &&
              envProven &&
              !analysis.effects.filesMayWriteUnknown,
            conditional: unit.conditional,
            ...(unit.condition ? { condition: unit.condition.text } : {}),
            values: analysis.effects.githubOutput,
          });
      }
      if (priorJob) {
        finishJob(priorJob);
        finishedJobs.add(priorJob);
      }
      for (const jobId of jobOrder.order)
        if (!finishedJobs.has(jobId)) finishJob(jobId);
      for (const [jobId, condition] of Object.entries(workflow.jobConditions))
        if (
          !githubConditionIsTyped(condition.text, {
            jobId,
            needs: workflow.jobNeeds[jobId] ?? [],
            inputs: workflow.inputs,
            jobOutputs: verifiedJobOutputs,
            stepOutputs,
          })
        )
          diagnostics.push(
            detail(
              target.path,
              source,
              blocked(
                "PIPE203",
                "GitHub job if expression or its dependency is not yet verified",
                condition.span,
              ),
            ),
          );
      for (const call of pendingCalls) {
        const { dependency, callee } = call;
        const beforeCall = diagnostics.length;
        if (callee.workflowCallSecrets) {
          const supplied = dependency.secrets;
          for (const [name, required] of Object.entries(
            callee.workflowCallSecrets,
          ))
            if (
              required &&
              supplied !== "inherit" &&
              supplied !== "unverified" &&
              !supplied?.includes(name)
            )
              diagnostics.push(
                detail(target.path, source, {
                  code: "PIPE104",
                  message: `Reusable workflow ${dependency.path} requires secret ${name}`,
                  span: dependency.span,
                  status: "error",
                }),
              );
          if (supplied && supplied !== "inherit" && supplied !== "unverified")
            for (const name of supplied)
              if (!Object.hasOwn(callee.workflowCallSecrets, name))
                diagnostics.push(
                  detail(target.path, source, {
                    code: "PIPE104",
                    message: `Reusable workflow ${dependency.path} has no secret ${name}`,
                    span: dependency.span,
                    status: "error",
                  }),
                );
        }
        const inputWires: Record<string, GithubFileValue> = Object.create(null);
        if (callee.workflowCallInputs) {
          const bindings: NonNullable<LocalDependency["with"]> =
            dependency.with ?? Object.create(null);
          for (const [name, declaration] of Object.entries(
            callee.workflowCallInputs,
          )) {
            if (declaration.required && !Object.hasOwn(bindings, name))
              diagnostics.push(
                detail(target.path, source, {
                  code: "PIPE104",
                  message: `Reusable workflow ${dependency.path} requires input ${name}`,
                  span: dependency.span,
                  status: "error",
                }),
              );
            if (
              !Object.hasOwn(bindings, name) &&
              declaration.defaultValue !== undefined
            )
              inputWires[name] = githubDefaultWire(declaration.defaultValue);
          }
          const guards = githubPresenceGuards(dependency.condition?.text);
          for (const [name, binding] of Object.entries(bindings)) {
            const declaration = callee.workflowCallInputs[name];
            if (!declaration) {
              diagnostics.push(
                detail(target.path, source, {
                  code: "PIPE104",
                  message: `Reusable workflow ${dependency.path} has no input ${name}`,
                  span: binding.span,
                  status: "error",
                }),
              );
              continue;
            }
            const actual = githubWithValue(
              binding,
              workflow.inputs,
              verifiedJobOutputs,
              guards,
            );
            if (
              !actual ||
              !githubNeedsOutputsAvailable(
                binding.text,
                dependency.condition?.text,
              )
            )
              diagnostics.push(
                detail(
                  target.path,
                  source,
                  blocked(
                    "PIPE203",
                    `Reusable workflow input ${name} expression is not yet analyzed`,
                    binding.span,
                  ),
                ),
              );
            else if (!isAssignable(actual.type, declaration.type))
              diagnostics.push(
                detail(target.path, source, {
                  code: "PIPE102",
                  message: `Reusable workflow input ${name} does not match declared type`,
                  span: binding.span,
                  status: "error",
                }),
              );
            else inputWires[name] = actual.wire;
          }
        }
        const inputsVerified = diagnostics.length === beforeCall;
        const calleeVerified = verifyCallableWorkflow(
          target.root,
          call.path,
          call.source,
          callee,
          inputWires,
        );
        const verified = inputsVerified && calleeVerified;
        if (!verified) {
          unverifiedDependencies.add(pathToFileURL(call.path).href);
          diagnostics.push(
            detail(
              target.path,
              source,
              blocked(
                "PIPE202",
                `Reusable workflow contract is not yet verified: ${dependency.path}`,
                dependency.span,
              ),
            ),
          );
        }
      }
    }
  } finally {
    parser.delete();
  }
  if (checkedUnits === 0 && diagnostics.length === 0)
    throw new ProjectDiscoveryError("No analyzable Bash units found");
  diagnostics.sort(
    (a, b) =>
      a.uri.localeCompare(b.uri) ||
      a.offset.start - b.offset.start ||
      a.code.localeCompare(b.code),
  );
  const seenDiagnostics = new Set<string>();
  const uniqueDiagnostics = diagnostics.filter((item) => {
    const key = JSON.stringify([
      item.uri,
      item.offset.start,
      item.offset.end,
      item.code,
      item.message,
      item.status,
    ]);
    if (seenDiagnostics.has(key)) return false;
    seenDiagnostics.add(key);
    return true;
  });
  return {
    schemaVersion: 1,
    version: CLI_VERSION,
    checkedUnits,
    complete: uniqueDiagnostics.length === 0,
    diagnostics: uniqueDiagnostics,
    unverifiedDependencies: [...unverifiedDependencies].sort(),
    fileEffects: [...fileEffects].sort(),
    fileEffectsUnknown,
    externalEffects: [...externalEffects].sort(),
  };
}
