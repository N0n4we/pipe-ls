import { isMap, isScalar, isSeq, parseAllDocuments, parseDocument } from "yaml";
import type { BashParser, BashSyntaxNode } from "./bash-parser.js";
import { parseScriptContract, type ScriptContract } from "./contract.js";
import {
  type JqNode,
  JqSyntaxError,
  JqUnsupportedSyntaxError,
  parseJq,
} from "./jq-parser.js";
import { createSpan, type Span } from "./span.js";
import {
  isAssignable,
  type Template,
  templateOfJson,
  union,
} from "./template.js";

export interface Diagnostic {
  readonly code:
    | "PIPE001"
    | "PIPE101"
    | "PIPE102"
    | "PIPE103"
    | "PIPE104"
    | "PIPE201"
    | "PIPE202"
    | "PIPE203"
    | "PIPE204";
  readonly message: string;
  readonly span: Span;
  readonly status: "error" | "blocked";
}
export interface AnalysisResult {
  readonly diagnostics: readonly Diagnostic[];
  readonly complete: boolean;
  readonly effects: {
    readonly filesMayWrite: readonly string[];
    /** Definite writes on every successful run path, not arbitrary file writes. */
    readonly githubEnv: Readonly<Record<string, GithubFileValue>>;
    readonly githubOutput: Readonly<Record<string, GithubFileValue>>;
    readonly externalMayRun: readonly string[];
  };
}
export interface GithubFileValue {
  readonly type: Template;
  readonly encoded: boolean;
  /** Bytes have no line break or NUL; compact jq output establishes this without exact bytes. */
  readonly singleLine?: boolean;
  readonly text?: string;
}
export interface LocalScriptSummary {
  readonly contract: ScriptContract;
  readonly complete: boolean;
  readonly effects?: AnalysisResult["effects"];
}
export interface AnalyzeOptions {
  /** Caller owns project snapshots, path checks and dependency recursion. */
  readonly resolveLocalScript?: (
    command: string,
  ) => LocalScriptSummary | undefined;
  /** Only supplied for a script whose source location is already verified. */
  readonly scriptDirectory?: string;
  readonly resolveDirectory?: (
    path: string,
  ) =>
    | { readonly kind: "directory"; readonly path: string }
    | { readonly kind: "unavailable"; readonly reason: string };
  readonly readLocalFile?: (
    path: string,
  ) =>
    | { readonly kind: "file"; readonly source: string }
    | { readonly kind: "unavailable"; readonly reason: string };
  /** A GitHub run owns the special environment/output files. */
  readonly githubFiles?: boolean;
}
interface Value {
  readonly type: Template;
  readonly min: number;
  readonly max: number;
  readonly encoded: boolean;
  readonly singleLine?: boolean;
  /** Whether stdout ends with a separator that keeps a later JSON value distinct. */
  readonly delimited?: boolean;
  /** Exact Bash bytes when known, before a command adds its output newline. */
  readonly text?: string;
  /** Bounded alternatives for shell bytes; never implies a JSON union by itself. */
  readonly texts?: readonly string[];
  /** jq branch with no successful result because it raises an error. */
  readonly alwaysFails?: boolean;
  /** Valid only while the referenced shell variable still holds this value. */
  readonly presenceTest?: {
    readonly sourceName: string;
    readonly sourceValue: Value;
    readonly key: string;
  };
  readonly originSource?: Value;
  readonly originArrayField?: string;
  readonly originField?: string;
  readonly coversArrayKeys?: {
    readonly sourceValue: Value;
    readonly arrayField: string;
    readonly keyField: string;
    readonly valueType: Template;
  };
  readonly githubAssignment?: {
    readonly name: string;
    readonly payload: Value;
  };
}
interface ShellArray {
  readonly element: Value;
  readonly elements?: readonly Value[];
  readonly min: number;
  readonly max: number;
}

const MAX_FINITE_TEXTS = 64;
const IMAGE_SELECTOR =
  ".images[] | select(.name == strenv(IMAGE_ORIGIN_NAME) or .newName == strenv(IMAGE_REPOSITORY))";
const PORTAL_IMAGE_SELECTOR =
  'select(.kind == "Deployment" and .metadata.name == "support-portal") | .spec.template.spec.containers[] | select(.name == "support-portal") | .image';

const nullType: Template = { kind: "primitive", name: "null" };
function couldBeString(type: Template): boolean {
  if (type.kind === "union") return type.options.some(couldBeString);
  return (
    (type.kind === "primitive" && type.name === "string") ||
    (type.kind === "literal" && typeof type.value === "string")
  );
}
function couldBeFalseOrNull(type: Template): boolean {
  if (type.kind === "union") return type.options.some(couldBeFalseOrNull);
  return (
    (type.kind === "primitive" &&
      (type.name === "null" || type.name === "boolean")) ||
    (type.kind === "literal" && type.value === false)
  );
}
function truthyPart(type: Template): Template | undefined {
  if (type.kind === "union") {
    const options = type.options.flatMap((option) => {
      const value = truthyPart(option);
      return value ? [value] : [];
    });
    return options.length ? union(options) : undefined;
  }
  if (type.kind === "primitive") {
    if (type.name === "null") return undefined;
    return type.name === "boolean" ? { kind: "literal", value: true } : type;
  }
  return type.kind === "literal" && type.value === false ? undefined : type;
}
function members(type: Template): readonly Template[] {
  return type.kind === "union" ? type.options.flatMap(members) : [type];
}
function narrowByHas(
  predicate: JqNode,
  type: Template,
  whenTrue: boolean,
): Template | undefined {
  const node =
    predicate.kind === "group"
      ? (predicate.children[0] ?? predicate)
      : predicate;
  if (
    node.kind !== "call" ||
    node.value !== "has" ||
    node.children.length !== 1 ||
    node.children[0]?.kind !== "literal"
  )
    return type;
  let key: unknown;
  try {
    key = JSON.parse(node.children[0].value ?? "");
  } catch {
    return type;
  }
  if (typeof key !== "string") return type;
  return narrowObjectPresence(type, key, whenTrue);
}
function narrowObjectPresence(
  type: Template,
  key: string,
  whenPresent: boolean,
): Template | undefined {
  const alternatives = members(type);
  if (!alternatives.every((option) => option.kind === "object")) return type;
  const selected = alternatives.filter(
    (option) =>
      option.kind === "object" &&
      Object.hasOwn(option.fields, key) === whenPresent,
  );
  return selected.length ? union(selected) : undefined;
}
function jqAsBindings(node: JqNode): readonly JqNode[] | undefined {
  if (node.kind !== "binary") return undefined;
  if (node.value === "as") return [node];
  if (
    node.value !== "|" ||
    node.children[1]?.kind !== "binary" ||
    node.children[1].value !== "as"
  )
    return undefined;
  const previous = node.children[0]
    ? jqAsBindings(node.children[0])
    : undefined;
  return previous && node.children[1]
    ? [...previous, node.children[1]]
    : undefined;
}
function jsonTypeName(type: Template): string {
  if (type.kind === "object") return "object";
  if (type.kind === "array") return "array";
  if (type.kind === "primitive") return type.name;
  if (type.kind === "literal") return typeof type.value;
  throw new TypeError("Union must be expanded before naming its JSON type");
}
function one(type: Template, encoded = true, text?: string): Value {
  return text === undefined
    ? { type, min: 1, max: 1, encoded }
    : {
        type,
        min: 1,
        max: 1,
        encoded,
        text,
        singleLine: !/[\r\n\0]/u.test(text),
      };
}
function exactScalar(
  type: Template,
): string | number | boolean | null | undefined {
  if (type.kind === "literal") return type.value;
  return type.kind === "primitive" && type.name === "null" ? null : undefined;
}
function finiteStringKeys(type: Template): readonly string[] | undefined {
  const alternatives = members(type);
  if (
    alternatives.length === 0 ||
    alternatives.length > 16 ||
    alternatives.some(
      (member) => member.kind !== "literal" || typeof member.value !== "string",
    )
  )
    return undefined;
  return [
    ...new Set(
      alternatives.flatMap((member) =>
        member.kind === "literal" && typeof member.value === "string"
          ? [member.value]
          : [],
      ),
    ),
  ];
}
function partitionReduceBindings(
  type: Template,
  fields: ReadonlySet<string>,
): readonly Template[] | undefined {
  if (fields.size === 0) return [type];
  const result: Template[] = [];
  for (const member of members(type)) {
    let partitions: Template[] = [member];
    if (member.kind === "object")
      for (const [key, value] of Object.entries(member.fields)) {
        if (!fields.has(key)) continue;
        const alternatives = finiteStringKeys(value);
        if (!alternatives || alternatives.length < 2) continue;
        partitions = partitions.flatMap((part) =>
          part.kind === "object"
            ? alternatives.map(
                (literal) =>
                  ({
                    kind: "object",
                    fields: {
                      ...part.fields,
                      [key]: { kind: "literal", value: literal },
                    },
                  }) as Template,
              )
            : [part],
        );
        if (partitions.length + result.length > 16) return undefined;
      }
    result.push(...partitions);
    if (result.length > 16) return undefined;
  }
  return result;
}
function reduceUpdateKeyFields(
  step: JqNode,
  variable: string,
): ReadonlySet<string> {
  const fields = new Set<string>();
  const pending = [step];
  while (pending.length) {
    const node = pending.pop();
    if (!node) continue;
    if (
      node.kind === "binary" &&
      ["=", "//=", "+=", "|="].includes(node.value ?? "") &&
      node.children[0]
    ) {
      const target = [node.children[0]];
      while (target.length) {
        const part = target.pop();
        if (!part) continue;
        if (part.kind === "index") {
          const key = part.children[1];
          if (
            key?.kind === "field" &&
            key.children[0]?.kind === "variable" &&
            key.children[0].value === variable &&
            key.value
          )
            fields.add(key.value);
        }
        if (part.children[0]) target.push(part.children[0]);
      }
    }
    for (const child of node.children) pending.push(child);
  }
  return fields;
}
function inputArrayGeneratorField(node: JqNode): string | undefined {
  if (node.kind === "group" && node.children[0])
    return inputArrayGeneratorField(node.children[0]);
  if (
    node.kind === "binary" &&
    node.value === "|" &&
    node.children[1]?.kind === "call" &&
    node.children[1].value === "select" &&
    node.children[0]
  )
    return inputArrayGeneratorField(node.children[0]);
  const field = node.kind === "iterate" ? node.children[0] : undefined;
  return field?.kind === "field" && field.children[0]?.kind === "identity"
    ? field.value
    : undefined;
}
function plusType(left: Template, right: Template): Template | undefined {
  const results: Template[] = [];
  const pairs = members(left).length * members(right).length;
  if (pairs > 64) return undefined;
  for (const a of members(left)) {
    for (const b of members(right)) {
      if (a.kind === "primitive" && a.name === "null") results.push(b);
      else if (b.kind === "primitive" && b.name === "null") results.push(a);
      else if (a.kind === "array" && b.kind === "array") {
        results.push({
          kind: "array",
          element:
            a.element && b.element
              ? union([a.element, b.element])
              : (a.element ?? b.element),
        });
      } else if (a.kind === "object" && b.kind === "object")
        results.push({ kind: "object", fields: { ...a.fields, ...b.fields } });
      else if (couldBeString(a) && couldBeString(b)) {
        results.push(
          a.kind === "literal" && b.kind === "literal"
            ? { kind: "literal", value: String(a.value) + String(b.value) }
            : { kind: "primitive", name: "string" },
        );
      } else if (
        a.kind === "literal" &&
        b.kind === "literal" &&
        typeof a.value === "number" &&
        typeof b.value === "number" &&
        Number.isFinite(a.value + b.value)
      )
        results.push({ kind: "literal", value: a.value + b.value });
      else return undefined;
    }
  }
  return union(results);
}
function missingRequiredFields(
  actual: Template,
  expected: Template,
): readonly string[] {
  if (actual.kind !== "object" || expected.kind !== "object") return [];
  return Object.keys(expected.fields).filter(
    (key) => !Object.hasOwn(actual.fields, key),
  );
}
function count(a: number, b: number): number {
  return a === Number.POSITIVE_INFINITY || b === Number.POSITIVE_INFINITY
    ? Number.POSITIVE_INFINITY
    : a + b;
}
function multiply(a: number, b: number): number {
  return a === 0 || b === 0
    ? 0
    : a === Number.POSITIVE_INFINITY || b === Number.POSITIVE_INFINITY
      ? Number.POSITIVE_INFINITY
      : a * b;
}

/** A deliberately conservative first vertical slice. Unsupported effects block, never pass. */
export function analyzeScript(
  source: string,
  parser: BashParser,
  options: AnalyzeOptions = {},
): AnalysisResult {
  const diagnostics: Diagnostic[] = [];
  const report = (
    code: Diagnostic["code"],
    message: string,
    span: Span,
    status: Diagnostic["status"] = "error",
  ): void => {
    if (
      diagnostics.some(
        (item) =>
          item.code === code &&
          item.message === message &&
          item.span.start === span.start &&
          item.span.end === span.end,
      )
    )
      return;
    diagnostics.push({ code, message, span, status });
  };
  const contract = parseScriptContract(source);
  for (const issue of contract.issues)
    report(issue.code, issue.message, issue.span);
  const tree = parser.parse(source);
  if (!tree) {
    report(
      "PIPE204",
      "Bash parser returned no tree",
      createSpan(0, 0),
      "blocked",
    );
    return {
      diagnostics,
      complete: false,
      effects: {
        filesMayWrite: [],
        githubEnv: {},
        githubOutput: {},
        externalMayRun: [],
      },
    };
  }
  let variables = new Map<string, Value>();
  let arrays = new Map<string, ShellArray>();
  let exported = new Set<string>();
  let failedVariables = new Set<string>();
  let maybeVariables = new Set<string>();
  let invalidatedVariables = new Set<string>();
  for (const [name, type] of Object.entries(contract.env)) {
    variables.set(name, one(type));
    exported.add(name);
  }
  let consumed: "no" | "yes" | "maybe" = "no";
  let errexit = false;
  let pipefail = false;
  let output: Value | undefined;
  let lastOutputSpan: Span | undefined;
  let blocked = false;
  let dead = false;
  let functions = new Map<string, "fatal" | "unsupported">();
  const filesMayWrite = new Set<string>();
  const externalMayRun = new Set<string>();
  let checkedOutBranch: Value | undefined;
  const provenGitStatusLists = new Set<number>();
  let githubEnv = new Map<string, Value>();
  let githubOutput = new Map<string, Value>();
  let githubRedirectTarget: "env" | "output" | undefined;
  const verifiedPortalImageWrites = new Set<string>();
  const verifiedKustomizationWrites = new Set<string>();
  const block = (message: string, span: Span): void => {
    blocked = true;
    report("PIPE202", message, span, "blocked");
  };
  const emit = (value: Value, span: Span): void => {
    lastOutputSpan = span;
    if (value.max === 0) return;
    if (!output) output = value;
    else if (
      output.max > 0 &&
      value.max > 0 &&
      (!output.delimited || !value.delimited)
    )
      block("Concatenated stdout bytes are not yet analyzed", span);
    else
      output = {
        type: union([output.type, value.type]),
        min: count(output.min, value.min),
        max: count(output.max, value.max),
        encoded: output.encoded && value.encoded,
        delimited: true,
      };
  };
  const spanOf = (node: BashSyntaxNode): Span =>
    createSpan(node.startIndex, node.endIndex);

  function literalBytes(bytes: string): Value {
    try {
      return one(templateOfJson(JSON.parse(bytes)), true, bytes);
    } catch {
      return one({ kind: "primitive", name: "string" }, false, bytes);
    }
  }

  function finiteBytes(value: Value): readonly string[] | undefined {
    return value.text !== undefined ? [value.text] : value.texts;
  }
  function withFiniteBytes(value: Value, bytes: readonly string[]): Value {
    return {
      type: value.type,
      min: value.min,
      max: value.max,
      encoded: value.encoded,
      singleLine: bytes.every((item) => !/[\r\n\0]/u.test(item)),
      ...(value.delimited !== undefined ? { delimited: value.delimited } : {}),
      ...(bytes.length === 1
        ? { text: bytes[0] as string }
        : { texts: [...bytes] }),
    };
  }

  function bashValue(node: BashSyntaxNode): Value | undefined {
    if (node.type === "raw_string") return literalBytes(node.text.slice(1, -1));
    if (node.type === "number") return literalBytes(node.text);
    if (node.type === "arithmetic_expansion") {
      const expression =
        /^\$\(\(\s*([A-Za-z_][A-Za-z_0-9]*)\s*\+\s*1\s*\)\)$/u.exec(node.text);
      const name = expression?.[1];
      const value =
        name && !maybeVariables.has(name) && !invalidatedVariables.has(name)
          ? variables.get(name)
          : undefined;
      const numbers = value && finiteBytes(value);
      if (!numbers || numbers.length > MAX_FINITE_TEXTS) {
        block("Bash arithmetic input is not a bounded integer", spanOf(node));
        return undefined;
      }
      let result: Value | undefined;
      for (const bytes of numbers) {
        if (!/^(?:0|[1-9][0-9]*)$/u.test(bytes)) {
          block("Bash arithmetic input is not a decimal integer", spanOf(node));
          return undefined;
        }
        const next = Number(bytes) + 1;
        if (!Number.isSafeInteger(next)) {
          block("Bash arithmetic exceeds safe integer precision", spanOf(node));
          return undefined;
        }
        const item = literalBytes(String(next));
        result = result ? joinValue(result, item) : item;
      }
      return result;
    }
    if (node.type === "word" && /^[A-Za-z0-9_.-]+$/u.test(node.text))
      return literalBytes(node.text);
    if (node.type === "string") {
      const quotedSuffix =
        /^"\$\{([A-Za-z_][A-Za-z_0-9]*)%\/"\$([A-Za-z_][A-Za-z_0-9]*)"\}"$/u.exec(
          node.text,
        );
      if (quotedSuffix) {
        const sourceName = quotedSuffix[1] ?? "";
        const suffixName = quotedSuffix[2] ?? "";
        const sourceValue =
          maybeVariables.has(sourceName) || invalidatedVariables.has(sourceName)
            ? undefined
            : variables.get(sourceName);
        const suffixValue =
          maybeVariables.has(suffixName) || invalidatedVariables.has(suffixName)
            ? undefined
            : variables.get(suffixName);
        if (!sourceValue || !suffixValue) {
          block("Bash quoted suffix input is unverified", spanOf(node));
          return undefined;
        }
        const sources = finiteBytes(sourceValue);
        const suffixes = finiteBytes(suffixValue);
        if (!sources || !suffixes)
          return one({ kind: "primitive", name: "string" }, false);
        if (sources.length * suffixes.length > MAX_FINITE_TEXTS) {
          block("Bash quoted suffix alternatives exceed budget", spanOf(node));
          return undefined;
        }
        let result: Value | undefined;
        for (const source of sources)
          for (const suffix of suffixes) {
            if (source.includes("\0") || suffix.includes("\0")) {
              block("NUL in Bash variable is not analyzed", spanOf(node));
              return undefined;
            }
            const ending = `/${suffix}`;
            const bytes = source.endsWith(ending)
              ? source.slice(0, -ending.length)
              : source;
            const item = literalBytes(bytes);
            result = result ? joinValue(result, item) : item;
          }
        return result;
      }
      const removal =
        /^"\$\{([A-Za-z_][A-Za-z_0-9]*)(%:\*|##\*:|%@\*|#\*@)\}"$/u.exec(
          node.text,
        );
      if (removal) {
        const name = removal[1] ?? "";
        const value =
          maybeVariables.has(name) || invalidatedVariables.has(name)
            ? undefined
            : variables.get(name);
        if (!value) {
          if (maybeVariables.has(name))
            block(`Bash variable ${name} may be undefined`, spanOf(node));
          else if (invalidatedVariables.has(name))
            block(
              `Bash variable ${name} has an unverified write`,
              spanOf(node),
            );
          else if (!failedVariables.has(name))
            block(`Unknown Bash variable ${name}`, spanOf(node));
          return undefined;
        }
        const known = finiteBytes(value);
        if (!known) return one({ kind: "primitive", name: "string" }, false);
        let result: Value | undefined;
        for (const bytes of known) {
          if (bytes.includes("\0")) {
            block("NUL in Bash variable is not analyzed", spanOf(node));
            return undefined;
          }
          const operation = removal[2];
          const separator = operation?.includes(":") ? ":" : "@";
          const position =
            operation === "#*@"
              ? bytes.indexOf(separator)
              : bytes.lastIndexOf(separator);
          const removed =
            position < 0
              ? bytes
              : operation === "#*@" || operation === "##*:"
                ? bytes.slice(position + 1)
                : bytes.slice(0, position);
          result = result
            ? joinValue(result, literalBytes(removed))
            : literalBytes(removed);
        }
        return result;
      }
      const variable =
        /^"\$(?:([A-Za-z_][A-Za-z_0-9]*)|\{([A-Za-z_][A-Za-z_0-9]*)\})"$/u.exec(
          node.text,
        );
      if (variable) {
        const name = variable[1] ?? variable[2] ?? "";
        if (maybeVariables.has(name)) {
          block(`Bash variable ${name} may be undefined`, spanOf(node));
          return undefined;
        }
        if (invalidatedVariables.has(name)) {
          block(`Bash variable ${name} has an unverified write`, spanOf(node));
          return undefined;
        }
        const value = variables.get(name);
        if (value) return value;
        if (failedVariables.has(name)) return undefined;
        block(`Unknown Bash variable ${name}`, spanOf(node));
        return undefined;
      }
      const substitution = node.namedChildren[0];
      if (
        node.namedChildren.length === 1 &&
        substitution?.type === "command_substitution" &&
        node.text === `"${substitution.text}"`
      )
        return evalSubstitution(substitution);
      if (node.text.startsWith('"') && node.text.endsWith('"')) {
        const inner = node.text.slice(1, -1);
        let candidates: string[] | undefined = [""];
        const append = (parts: readonly string[] | undefined): void => {
          if (!candidates || !parts) {
            candidates = undefined;
            return;
          }
          const next: string[] = [];
          for (const prefix of candidates)
            for (const suffix of parts) {
              next.push(prefix + suffix);
              if (next.length > MAX_FINITE_TEXTS) {
                candidates = undefined;
                return;
              }
            }
          candidates = next;
        };
        for (let i = 0; i < inner.length; i++) {
          const character = inner[i];
          if (character === undefined) break;
          if (character === "\\") {
            const next = inner[i + 1];
            if (next === undefined) {
              block("Incomplete Bash quoted escape", spanOf(node));
              return undefined;
            }
            if (["$", '"', "\\", "`"].includes(next)) {
              append([next]);
              i++;
            } else if (next === "\n") i++;
            else append([character]);
            continue;
          }
          if (character === "$") {
            const remainder = inner.slice(i);
            const match =
              /^\$(?:([A-Za-z_][A-Za-z_0-9]*)|\{([A-Za-z_][A-Za-z_0-9]*)\})/u.exec(
                remainder,
              );
            if (!match) {
              block(
                "Bash parameter expansion is not yet analyzed",
                spanOf(node),
              );
              return undefined;
            }
            const name = match[1] ?? match[2] ?? "";
            const value =
              maybeVariables.has(name) || invalidatedVariables.has(name)
                ? undefined
                : variables.get(name);
            if (!value) {
              if (maybeVariables.has(name))
                block(`Bash variable ${name} may be undefined`, spanOf(node));
              else if (invalidatedVariables.has(name))
                block(
                  `Bash variable ${name} has an unverified write`,
                  spanOf(node),
                );
              else if (!failedVariables.has(name))
                block(`Unknown Bash variable ${name}`, spanOf(node));
              return undefined;
            }
            append(finiteBytes(value));
            i += match[0].length - 1;
            continue;
          }
          if (character === "`") {
            block(
              "Bash backtick substitution is not yet analyzed",
              spanOf(node),
            );
            return undefined;
          }
          append([character]);
        }
        if (!candidates)
          return one({ kind: "primitive", name: "string" }, false);
        let combined: Value | undefined;
        for (const bytes of new Set(candidates))
          combined = combined
            ? joinValue(combined, literalBytes(bytes))
            : literalBytes(bytes);
        return combined;
      }
    }
    block("Bash expansion is not yet analyzed", spanOf(node));
    return undefined;
  }

  function evalJq(
    node: JqNode,
    input: Value,
    base: number,
    bindings: ReadonlyMap<string, Value>,
    failure: { observed: boolean },
  ): Value | undefined {
    const at = createSpan(base + node.span.start, base + node.span.end);
    const child = (index: number, context = input): Value | undefined => {
      const part = node.children[index];
      return part ? evalJq(part, context, base, bindings, failure) : undefined;
    };
    switch (node.kind) {
      case "identity":
        return input;
      case "group":
        return child(0);
      case "literal": {
        try {
          const value = JSON.parse(node.value ?? "");
          return one(templateOfJson(value), true, JSON.stringify(value));
        } catch {
          block("Invalid jq literal", at);
          return undefined;
        }
      }
      case "field": {
        const object = child(0);
        if (!object) return undefined;
        const name = node.value?.startsWith('"')
          ? (JSON.parse(node.value) as string)
          : node.value;
        const alternatives = members(object.type);
        const fields: Template[] = [];
        for (const member of alternatives) {
          if (member.kind === "object") {
            const field = member.fields[name ?? ""];
            if (!field) {
              report("PIPE102", `Undeclared JSON field ${name}`, at);
              return undefined;
            }
            fields.push(field);
          } else if (member.kind === "primitive" && member.name === "null")
            fields.push(nullType);
          else {
            report("PIPE102", "Field access requires an object", at);
            return undefined;
          }
        }
        return {
          type: union(fields),
          min: object.min,
          max: object.max,
          encoded: true,
          ...(object.originSource
            ? {
                originSource: object.originSource,
                ...(object.originArrayField
                  ? { originArrayField: object.originArrayField }
                  : {}),
                originField: name ?? "",
              }
            : {}),
        };
      }
      case "index": {
        const container = child(0);
        const indexNode = node.children[1];
        if (!container || !indexNode) return undefined;
        const indexValue = evalJq(indexNode, input, base, bindings, failure);
        if (!indexValue) return undefined;
        if (indexValue.min !== 1 || indexValue.max !== 1) {
          block("Dynamic jq index is not yet analyzed", at);
          return undefined;
        }
        const keys = finiteStringKeys(indexValue.type);
        const numericKey =
          indexValue.type.kind === "literal" &&
          typeof indexValue.type.value === "number" &&
          Number.isInteger(indexValue.type.value)
            ? indexValue.type.value
            : undefined;
        if (!keys && numericKey === undefined) {
          block("Dynamic jq index is not yet analyzed", at);
          return undefined;
        }
        if ((keys?.length ?? 1) * members(container.type).length > 64) {
          block("jq index alternatives exceed budget", at);
          return undefined;
        }
        const coverage = container.coversArrayKeys;
        const covered =
          coverage &&
          indexValue.originSource === coverage.sourceValue &&
          indexValue.originArrayField === coverage.arrayField &&
          indexValue.originField === coverage.keyField;
        const results: Template[] = [];
        for (const member of members(container.type)) {
          if (member.kind === "object" && keys) {
            for (const key of keys)
              results.push(
                covered ? coverage.valueType : (member.fields[key] ?? nullType),
              );
          } else if (member.kind === "array" && numericKey !== undefined) {
            results.push(
              member.element === null
                ? nullType
                : union([member.element, nullType]),
            );
          } else {
            report("PIPE102", "jq index is incompatible with its input", at);
            return undefined;
          }
        }
        if (
          !covered &&
          keys?.some(
            (key) =>
              !members(container.type).some(
                (member) =>
                  member.kind === "object" && Object.hasOwn(member.fields, key),
              ),
          )
        ) {
          report("PIPE102", "jq index references an undeclared JSON key", at);
          return undefined;
        }
        return {
          type: union(results),
          min: container.min,
          max: container.max,
          encoded: true,
        };
      }
      case "iterate": {
        const container = child(0);
        if (!container) return undefined;
        const outputs: Template[] = [];
        let minimum = Number.POSITIVE_INFINITY;
        let maximum = 0;
        for (const member of members(container.type)) {
          if (member.kind === "array") {
            if (member.element) outputs.push(member.element);
            minimum = 0;
            maximum = member.element
              ? Number.POSITIVE_INFINITY
              : Math.max(maximum, 0);
          } else if (member.kind === "object") {
            const values = Object.values(member.fields);
            outputs.push(...values);
            minimum = Math.min(minimum, values.length);
            maximum = Math.max(maximum, values.length);
          } else {
            report("PIPE102", "jq .[] requires an array or object", at);
            return undefined;
          }
        }
        return {
          type: outputs.length ? union(outputs) : nullType,
          min: multiply(container.min, Number.isFinite(minimum) ? minimum : 0),
          max: multiply(container.max, maximum),
          encoded: true,
        };
      }
      case "array": {
        if (node.children.length === 0)
          return one({ kind: "array", element: null });
        const inner = child(0);
        if (inner?.alwaysFails) return inner;
        return inner
          ? one({ kind: "array", element: inner.max === 0 ? null : inner.type })
          : undefined;
      }
      case "object": {
        const fields: Record<string, Template> = Object.create(null);
        let min = 1;
        let max = 1;
        for (const property of node.children) {
          const valueNode = property.children[0];
          if (!valueNode) {
            block("Invalid jq object property", at);
            return undefined;
          }
          const value = evalJq(valueNode, input, base, bindings, failure);
          if (!value) return undefined;
          if (value.alwaysFails) return value;
          const key = property.value?.startsWith('"')
            ? (JSON.parse(property.value) as string)
            : property.value;
          fields[key ?? ""] = value.type;
          min = multiply(min, value.min);
          max = multiply(max, value.max);
        }
        return { type: { kind: "object", fields }, min, max, encoded: true };
      }
      case "binary": {
        if (["//=", "+=", "|="].includes(node.value ?? "")) {
          const target = node.children[0];
          const expression = node.children[1];
          if (!target || !expression) {
            block("jq update is incomplete", at);
            return undefined;
          }
          const path: string[][] = [];
          const collect = (part: JqNode): boolean => {
            if (part.kind === "identity") return true;
            if (part.kind === "group" && part.children[0])
              return collect(part.children[0]);
            const parent = part.children[0];
            if (!parent || !collect(parent)) return false;
            if (part.kind === "field" && part.value) {
              path.push([part.value]);
              return true;
            }
            if (part.kind === "index" && part.children[1]) {
              const key = evalJq(
                part.children[1],
                input,
                base,
                bindings,
                failure,
              );
              const keys =
                key?.min === 1 && key.max === 1
                  ? finiteStringKeys(key.type)
                  : undefined;
              if (!keys) return false;
              path.push([...keys]);
              return true;
            }
            return false;
          };
          if (!collect(target) || path.length === 0 || path.length > 4) {
            block("jq update target needs bounded object keys", at);
            return undefined;
          }
          let combinations = 1;
          for (const segment of path) combinations *= segment.length;
          if (combinations * members(input.type).length > 64) {
            block("jq update path alternatives exceed budget", at);
            return undefined;
          }
          let cachedRight: Value | undefined;
          const rightOnRoot = (): Value | undefined => {
            if (!cachedRight)
              cachedRight = evalJq(expression, input, base, bindings, failure);
            return cachedRight;
          };
          const replaceLeaf = (
            old: Template | undefined,
          ): Template | undefined => {
            if (node.value === "|=") {
              if (!old) {
                block("jq |= target is absent", at);
                return undefined;
              }
              const updated = evalJq(
                expression,
                one(old),
                base,
                bindings,
                failure,
              );
              if (updated?.min !== 1 || updated.max !== 1) {
                block("jq |= update must yield one value", at);
                return undefined;
              }
              return updated.type;
            }
            if (node.value === "//=" && old && !couldBeFalseOrNull(old))
              return old;
            const right = rightOnRoot();
            if (right?.min !== 1 || right.max !== 1) {
              block("jq update value must yield one value", at);
              return undefined;
            }
            if (node.value === "+=") {
              const added = plusType(old ?? nullType, right.type);
              if (!added) block("jq += types are incompatible", at);
              return added;
            }
            const truthy = old && truthyPart(old);
            return truthy ? union([truthy, right.type]) : right.type;
          };
          const rewrite = (
            type: Template,
            depth: number,
          ): Template | undefined => {
            const results: Template[] = [];
            for (const member of members(type)) {
              if (member.kind !== "object") {
                block("jq update requires an object path", at);
                return undefined;
              }
              for (const key of path[depth] ?? []) {
                const old = member.fields[key];
                const value =
                  depth === path.length - 1
                    ? replaceLeaf(old)
                    : old
                      ? rewrite(old, depth + 1)
                      : undefined;
                if (!value) {
                  if (!old && depth < path.length - 1)
                    block("jq nested update path is absent", at);
                  return undefined;
                }
                results.push({
                  kind: "object",
                  fields: { ...member.fields, [key]: value },
                });
              }
            }
            return results.length ? union(results) : undefined;
          };
          const updated = rewrite(input.type, 0);
          return updated
            ? {
                type: updated,
                min: input.min,
                max: input.max,
                encoded: true,
              }
            : undefined;
        }
        if (node.value === "=") {
          const target = node.children[0];
          const expression = node.children[1];
          if (!target || !expression) {
            block("jq assignment is incomplete", at);
            return undefined;
          }
          let keys: readonly string[] | undefined;
          if (
            target.kind === "field" &&
            target.children[0]?.kind === "identity" &&
            target.value
          )
            keys = [target.value];
          else if (
            target.kind === "index" &&
            target.children[0]?.kind === "identity" &&
            target.children[1]
          ) {
            const key = evalJq(
              target.children[1],
              input,
              base,
              bindings,
              failure,
            );
            if (!key) return undefined;
            if (key.min !== 1 || key.max !== 1) {
              block("jq assignment key cardinality is not yet analyzed", at);
              return undefined;
            }
            keys = finiteStringKeys(key.type);
          }
          if (!keys) {
            block("jq assignment target needs finite object keys", at);
            return undefined;
          }
          const assigned = evalJq(expression, input, base, bindings, failure);
          if (!assigned) return undefined;
          if (assigned.alwaysFails) return assigned;
          if (assigned.min !== 1 || assigned.max !== 1) {
            block("jq assignment value cardinality is not yet analyzed", at);
            return undefined;
          }
          const objects = members(input.type);
          if (
            objects.length * keys.length > 64 ||
            objects.some((member) => member.kind !== "object")
          ) {
            block("jq assignment requires bounded object input", at);
            return undefined;
          }
          const results: Template[] = [];
          for (const object of objects)
            if (object.kind === "object")
              for (const key of keys)
                results.push({
                  kind: "object",
                  fields: { ...object.fields, [key]: assigned.type },
                });
          return {
            type: union(results),
            min: input.min,
            max: input.max,
            encoded: true,
          };
        }
        if (["==", "!=", "<", ">", "<=", ">="].includes(node.value ?? "")) {
          const left = child(0);
          const right = child(1);
          if (!left || !right) return undefined;
          if (
            left.min !== 1 ||
            left.max !== 1 ||
            right.min !== 1 ||
            right.max !== 1
          ) {
            block("jq comparison stream cardinality is not yet analyzed", at);
            return undefined;
          }
          let type: Template = { kind: "primitive", name: "boolean" };
          if (node.value === "==" || node.value === "!=") {
            const a = exactScalar(left.type);
            const b = exactScalar(right.type);
            if (a !== undefined && b !== undefined)
              type = {
                kind: "literal",
                value: node.value === "==" ? a === b : a !== b,
              };
          } else {
            const a = exactScalar(left.type);
            const b = exactScalar(right.type);
            if (
              (typeof a === "number" && typeof b === "number") ||
              (typeof a === "string" && typeof b === "string")
            ) {
              const comparison = a < b ? -1 : a > b ? 1 : 0;
              type = {
                kind: "literal",
                value:
                  node.value === "<"
                    ? comparison < 0
                    : node.value === ">"
                      ? comparison > 0
                      : node.value === "<="
                        ? comparison <= 0
                        : comparison >= 0,
              };
            }
          }
          return one(type);
        }
        if (node.value === "and" || node.value === "or") {
          const left = child(0);
          if (!left) return undefined;
          if (left.alwaysFails) return left;
          if (left.min !== 1 || left.max !== 1) {
            block("jq logical stream cardinality is not yet analyzed", at);
            return undefined;
          }
          const leftTrue = truthyPart(left.type) !== undefined;
          const leftFalse = couldBeFalseOrNull(left.type);
          if (node.value === "and" && !leftTrue)
            return one({ kind: "literal", value: false });
          if (node.value === "or" && !leftFalse)
            return one({ kind: "literal", value: true });
          const predicate = node.children[0];
          const narrowed = predicate
            ? narrowByHas(predicate, input.type, node.value === "and")
            : input.type;
          if (!narrowed)
            return one({
              kind: "literal",
              value: node.value === "or",
            });
          const right = child(1, { ...input, type: narrowed });
          if (!right) return undefined;
          if (right.alwaysFails)
            return node.value === "and" && leftFalse
              ? { ...one({ kind: "literal", value: false }), min: 0 }
              : node.value === "or" && leftTrue
                ? { ...one({ kind: "literal", value: true }), min: 0 }
                : right;
          if (right.min !== 1 || right.max !== 1) {
            block("jq logical stream cardinality is not yet analyzed", at);
            return undefined;
          }
          const rightTrue = truthyPart(right.type) !== undefined;
          const rightFalse = couldBeFalseOrNull(right.type);
          const canBeTrue =
            node.value === "and"
              ? leftTrue && rightTrue
              : leftTrue || rightTrue;
          const canBeFalse =
            node.value === "and"
              ? leftFalse || rightFalse
              : leftFalse && rightFalse;
          return one(
            canBeTrue !== canBeFalse
              ? { kind: "literal", value: canBeTrue }
              : { kind: "primitive", name: "boolean" },
          );
        }
        if (node.value === "+") {
          const left = child(0);
          const right = child(1);
          if (!left || !right) return undefined;
          if (
            left.min !== 1 ||
            left.max !== 1 ||
            right.min !== 1 ||
            right.max !== 1
          ) {
            block("jq + stream cardinality is not yet analyzed", at);
            return undefined;
          }
          const type = plusType(left.type, right.type);
          if (!type) {
            block("jq + type combination or budget is not yet analyzed", at);
            return undefined;
          }
          return one(type);
        }
        if (node.value === "//") {
          const left = child(0);
          if (!left) return undefined;
          if (left.alwaysFails) return left;
          const truthy = truthyPart(left.type);
          if (left.max === 0 || !truthy) return child(1);
          if (left.min > 0 && !couldBeFalseOrNull(left.type)) return left;
          if (left.max > 1) {
            block(
              "jq // on a multi-result stream needs branch correlation",
              at,
            );
            return undefined;
          }
          const right = child(1);
          if (!right) return undefined;
          return {
            type: union([truthy, right.type]),
            min:
              left.min === 1 && left.max === 1
                ? Math.min(1, right.min)
                : right.min > 0
                  ? 1
                  : 0,
            max: Math.max(left.max, right.max),
            encoded: left.encoded && right.encoded,
          };
        }
        if (node.value === "|") {
          const leftNode = node.children[0];
          const asBindings = leftNode ? jqAsBindings(leftNode) : undefined;
          if (asBindings) {
            const bodyNode = node.children[1];
            if (!bodyNode || asBindings.length > 16) {
              block("Invalid jq as binding", at);
              return undefined;
            }
            const scoped = new Map(bindings);
            let min = 1;
            let max = 1;
            for (const binding of asBindings) {
              const sourceNode = binding.children[0];
              const bindingNode = binding.children[1];
              if (!sourceNode || !bindingNode?.value) {
                block("Invalid jq as binding", at);
                return undefined;
              }
              const bound = evalJq(sourceNode, input, base, scoped, failure);
              if (!bound || bound.max === 0) return bound;
              scoped.set(bindingNode.value, one(bound.type));
              min = multiply(min, bound.min);
              max = multiply(max, bound.max);
            }
            const body = evalJq(bodyNode, input, base, scoped, failure);
            return body
              ? {
                  ...body,
                  min: multiply(min, body.min),
                  max: multiply(max, body.max),
                }
              : undefined;
          }
          const left = child(0);
          if (!left) return undefined;
          if (left.max === 0) return left;
          const right = child(1, one(left.type));
          return right
            ? {
                ...right,
                min: multiply(left.min, right.min),
                max: multiply(left.max, right.max),
              }
            : undefined;
        }
        if (node.value === ",") {
          const left = child(0);
          const right = child(1);
          if (left?.alwaysFails) return left;
          if (right?.alwaysFails) return right;
          if (left?.max === 0) return right;
          if (right?.max === 0) return left;
          return left && right
            ? {
                type: union([left.type, right.type]),
                min: count(left.min, right.min),
                max: count(left.max, right.max),
                encoded: left.encoded && right.encoded,
              }
            : undefined;
        }
        block(`jq operator ${node.value ?? "?"} is not yet analyzed`, at);
        return undefined;
      }
      case "if": {
        const condition = child(0);
        if (!condition) return undefined;
        if (condition.min !== 1 || condition.max !== 1) {
          block("jq if condition cardinality is not yet analyzed", at);
          return undefined;
        }
        const canBeTrue = truthyPart(condition.type) !== undefined;
        const canBeFalse = couldBeFalseOrNull(condition.type);
        if (canBeTrue && !canBeFalse) return child(1);
        if (canBeFalse && !canBeTrue) return child(2);
        const yes = child(1);
        const no = child(2);
        if (!yes || !no) return undefined;
        if (yes.alwaysFails && no.alwaysFails) return yes;
        if (yes.alwaysFails) return no;
        if (no.alwaysFails) return yes;
        if (yes.max === 0) return { ...no, min: 0 };
        if (no.max === 0) return { ...yes, min: 0 };
        return {
          type: union([yes.type, no.type]),
          min: Math.min(yes.min, no.min),
          max: Math.max(yes.max, no.max),
          encoded: yes.encoded && no.encoded,
        };
      }
      case "reduce": {
        const generator = node.children[0];
        const variable = node.children[1]?.value;
        const seed = node.children[2];
        const step = node.children[3];
        if (!generator || !variable || !seed || !step) {
          block("Invalid jq reduce expression", at);
          return undefined;
        }
        const generated = evalJq(generator, input, base, bindings, failure);
        const initial = evalJq(seed, input, base, bindings, failure);
        if (!generated || !initial) return undefined;
        if (initial.min !== 1 || initial.max !== 1) {
          block("jq reduce initializer must yield exactly one value", at);
          return undefined;
        }
        if (generated.max === 0) return initial;
        const alternatives = partitionReduceBindings(
          generated.type,
          reduceUpdateKeyFields(step, variable),
        );
        if (!alternatives) {
          block("jq reduce binding alternatives exceed budget", at);
          return undefined;
        }
        const originArrayField = input.originSource
          ? inputArrayGeneratorField(generator)
          : undefined;
        let state = initial.type;
        for (let iteration = 0; iteration < 8; iteration++) {
          const updates: Template[] = [];
          for (const alternative of alternatives) {
            const scoped = new Map(bindings);
            scoped.set(variable, {
              ...one(alternative),
              ...(originArrayField && input.originSource
                ? {
                    originSource: input.originSource,
                    originArrayField,
                  }
                : {}),
            });
            const updated = evalJq(step, one(state), base, scoped, failure);
            if (!updated) return undefined;
            if (updated.min !== 1 || updated.max !== 1) {
              block("jq reduce update must yield exactly one value", at);
              return undefined;
            }
            updates.push(updated.type);
          }
          const updatedType = union(updates);
          if (isAssignable(updatedType, state))
            return {
              type: state,
              min: input.min,
              max: input.max,
              encoded: true,
            };
          state = isAssignable(state, updatedType)
            ? updatedType
            : union([state, updatedType]);
          if (JSON.stringify(state).length > 8192) break;
        }
        block("jq reduce type fixed point exceeded its budget", at);
        return undefined;
      }
      case "call": {
        if (node.value === "error" && node.children.length <= 1) {
          if (node.children.length === 1 && !child(0)) return undefined;
          failure.observed = true;
          return {
            type: nullType,
            min: 0,
            max: 0,
            encoded: true,
            alwaysFails: true,
          };
        }
        if (node.value === "split" && node.children.length === 1) {
          const separator = child(0);
          if (!separator) return undefined;
          if (
            separator.min !== 1 ||
            separator.max !== 1 ||
            !members(input.type).every(couldBeString) ||
            !members(separator.type).every(couldBeString)
          ) {
            report(
              "PIPE102",
              "split requires one string separator and string input",
              at,
            );
            return undefined;
          }
          return {
            type: {
              kind: "array",
              element: { kind: "primitive", name: "string" },
            },
            min: input.min,
            max: input.max,
            encoded: true,
          };
        }
        if (node.value === "index" && node.children.length === 1) {
          const needle = child(0);
          if (!needle) return undefined;
          if (needle.min !== 1 || needle.max !== 1) {
            block("index argument cardinality is not yet analyzed", at);
            return undefined;
          }
          for (const member of members(input.type)) {
            if (member.kind === "array") continue;
            if (
              couldBeString(member) &&
              members(needle.type).every(couldBeString)
            )
              continue;
            report(
              "PIPE102",
              "index requires an array or compatible strings",
              at,
            );
            return undefined;
          }
          return {
            type: union([nullType, { kind: "primitive", name: "number" }]),
            min: input.min,
            max: input.max,
            encoded: true,
          };
        }
        if (node.value === "all" && node.children.length === 2) {
          const generated = child(0);
          if (!generated) return undefined;
          if (generated.alwaysFails) return generated;
          if (generated.max === 0)
            return {
              ...one({ kind: "literal", value: true }),
              min: input.min,
              max: input.max,
            };
          const predicate = child(1, one(generated.type));
          if (!predicate) return undefined;
          if (predicate.min !== 1 || predicate.max !== 1) {
            block("all predicate cardinality is not yet analyzed", at);
            return undefined;
          }
          return {
            type: { kind: "primitive", name: "boolean" },
            min: input.min,
            max: input.max,
            encoded: true,
          };
        }
        if (node.value === "map" && node.children.length === 1) {
          const elements: Template[] = [];
          for (const member of members(input.type)) {
            if (member.kind === "array") {
              if (member.element) elements.push(member.element);
            } else if (member.kind === "object")
              elements.push(...Object.values(member.fields));
            else {
              report("PIPE102", "map requires an array or object", at);
              return undefined;
            }
          }
          if (elements.length === 0)
            return {
              type: { kind: "array", element: null },
              min: input.min,
              max: input.max,
              encoded: true,
            };
          const filter = node.children[0];
          if (!filter) return undefined;
          const mapped = evalJq(
            filter,
            one(union(elements)),
            base,
            bindings,
            failure,
          );
          if (!mapped) return undefined;
          if (mapped.alwaysFails) return mapped;
          return {
            type: {
              kind: "array",
              element: mapped.max === 0 ? null : mapped.type,
            },
            min: input.min,
            max: input.max,
            encoded: true,
          };
        }
        if (node.value === "has" && node.children.length === 1) {
          const argument = node.children[0];
          if (argument?.kind !== "literal") {
            block("Dynamic has key is not yet analyzed", at);
            return undefined;
          }
          let key: unknown;
          try {
            key = JSON.parse(argument.value ?? "");
          } catch {
            block("Invalid has key", at);
            return undefined;
          }
          const outcomes: Template[] = [];
          for (const member of members(input.type)) {
            if (member.kind === "object" && typeof key === "string")
              outcomes.push({
                kind: "literal",
                value: Object.hasOwn(member.fields, key),
              });
            else if (
              member.kind === "array" &&
              typeof key === "number" &&
              Number.isInteger(key)
            )
              outcomes.push(
                member.element === null
                  ? { kind: "literal", value: false }
                  : { kind: "primitive", name: "boolean" },
              );
            else {
              report("PIPE102", "has key is incompatible with its input", at);
              return undefined;
            }
          }
          return {
            type: union(outcomes),
            min: input.min,
            max: input.max,
            encoded: true,
          };
        }
        if (node.value === "select" && node.children.length === 1) {
          const predicate = child(0);
          if (!predicate) return undefined;
          if (predicate.max !== 1 || predicate.min !== 1) {
            block("select predicate cardinality is not yet analyzed", at);
            return undefined;
          }
          const truthy = truthyPart(predicate.type);
          if (!truthy) return { ...input, min: 0, max: 0 };
          return couldBeFalseOrNull(predicate.type)
            ? { ...input, min: 0 }
            : input;
        }
        block(`jq call ${node.value ?? "?"} is not yet analyzed`, at);
        return undefined;
      }
      case "name": {
        if (node.value === "empty")
          return { type: nullType, min: 0, max: 0, encoded: true };
        if (node.value === "unique") {
          if (!members(input.type).every((member) => member.kind === "array")) {
            report("PIPE102", "unique requires an array", at);
            return undefined;
          }
          return {
            type: input.type,
            min: input.min,
            max: input.max,
            encoded: true,
          };
        }
        if (node.value === "type") {
          const types = members(input.type).map(
            (member) =>
              ({ kind: "literal", value: jsonTypeName(member) }) as Template,
          );
          return {
            type: union(types),
            min: input.min,
            max: input.max,
            encoded: true,
          };
        }
        if (node.value === "length") {
          const results: Template[] = [];
          for (const member of members(input.type)) {
            if (
              (member.kind === "primitive" && member.name === "boolean") ||
              (member.kind === "literal" && typeof member.value === "boolean")
            ) {
              report("PIPE102", "length does not accept boolean", at);
              return undefined;
            }
            if (member.kind === "primitive" && member.name === "null")
              results.push({ kind: "literal", value: 0 });
            else if (member.kind === "array" && member.element === null)
              results.push({ kind: "literal", value: 0 });
            else if (member.kind === "object")
              results.push({
                kind: "literal",
                value: Object.keys(member.fields).length,
              });
            else if (
              member.kind === "literal" &&
              typeof member.value === "string"
            )
              results.push({
                kind: "literal",
                value: [...member.value].length,
              });
            else if (
              member.kind === "literal" &&
              typeof member.value === "number"
            )
              results.push({ kind: "literal", value: Math.abs(member.value) });
            else results.push({ kind: "primitive", name: "number" });
          }
          return {
            type: union(results),
            min: input.min,
            max: input.max,
            encoded: true,
          };
        }
        if (node.value === "ascii_upcase") {
          if (
            !members(input.type).every(
              (member) =>
                (member.kind === "primitive" && member.name === "string") ||
                (member.kind === "literal" && typeof member.value === "string"),
            )
          ) {
            report("PIPE102", "ascii_upcase requires a string", at);
            return undefined;
          }
          return {
            type: { kind: "primitive", name: "string" },
            min: input.min,
            max: input.max,
            encoded: true,
          };
        }
        block(`jq builtin ${node.value ?? "?"} is not yet analyzed`, at);
        return undefined;
      }
      case "variable": {
        const value = bindings.get(node.value ?? "");
        if (value) return value;
        block(`Unbound jq variable ${node.value ?? "?"}`, at);
        return undefined;
      }
      default:
        block(`jq ${node.kind} is not yet analyzed`, at);
        return undefined;
    }
  }

  let verifiedVersionPair: boolean | undefined;
  function hasVerifiedVersionFieldPair(): boolean {
    if (verifiedVersionPair !== undefined) return verifiedVersionPair;
    if (!tree) return false;
    const pending = [tree.rootNode];
    const writes: BashSyntaxNode[] = [];
    const conditions: BashSyntaxNode[] = [];
    let inspected = 0;
    while (pending.length) {
      const part = pending.pop();
      if (!part) continue;
      if (++inspected > 100_000) {
        verifiedVersionPair = false;
        return false;
      }
      if (
        part.type === "variable_assignment" &&
        ["version_field", "obsolete_field"].includes(
          part.namedChildren[0]?.text ?? "",
        )
      )
        writes.push(part);
      if (part.type === "if_statement") conditions.push(part);
      for (const child of part.namedChildren) pending.push(child);
    }
    if (writes.length !== 4) {
      verifiedVersionPair = false;
      return false;
    }
    const pairs = conditions.filter((condition) => {
      const children = condition.namedChildren;
      const alternative = children.findIndex(
        (part) => part.type === "else_clause",
      );
      if (
        children[0]?.type !== "test_command" ||
        alternative !== 3 ||
        children.length !== 4
      )
        return false;
      const yes = children.slice(1, alternative);
      const no = children[alternative]?.namedChildren ?? [];
      if (
        yes.length !== 2 ||
        no.length !== 2 ||
        [...yes, ...no].some((part) => !writes.includes(part))
      )
        return false;
      const values = (
        parts: readonly BashSyntaxNode[],
      ): Record<string, string> =>
        Object.fromEntries(
          parts.map((part) => [
            part.namedChildren[0]?.text ?? "",
            part.namedChildren[1]?.text ?? "",
          ]),
        );
      const first = values(yes);
      const second = values(no);
      return (
        (first.version_field === "digest" &&
          first.obsolete_field === "newTag" &&
          second.version_field === "newTag" &&
          second.obsolete_field === "digest") ||
        (first.version_field === "newTag" &&
          first.obsolete_field === "digest" &&
          second.version_field === "digest" &&
          second.obsolete_field === "newTag")
      );
    });
    verifiedVersionPair = pairs.length === 1;
    return verifiedVersionPair;
  }

  function quotedCommandArgument(node: BashSyntaxNode | undefined): boolean {
    if (node?.type !== "string" || /\$\(|`|<\(|>\(/u.test(node.text))
      return false;
    const value = bashValue(node);
    return Boolean(value && value.min === 1 && value.max === 1);
  }

  function sameCommandArgument(left: Value, right: Value): boolean {
    if (left === right) return true;
    const a = finiteBytes(left);
    const b = finiteBytes(right);
    return Boolean(
      a &&
        b &&
        a.length === b.length &&
        a.every((bytes, index) => bytes === b[index]),
    );
  }

  function gitDiffArguments(node: BashSyntaxNode): boolean {
    if (node.childForFieldName("name")?.text !== "git") return false;
    const args = node.namedChildren.slice(1);
    return (
      args.length === 4 &&
      args[0]?.text === "diff" &&
      args[1]?.text === "--quiet" &&
      args[2]?.text === "--" &&
      quotedCommandArgument(args[3])
    );
  }

  function evalCommand(
    node: BashSyntaxNode,
    piped?: Value,
    expectsReturn = false,
    inPipeline = false,
    conditional = false,
  ): Value | undefined {
    const nameNode = node.childForFieldName("name");
    const name = nameNode?.text;
    if (name && functions.has(name)) {
      block(
        `Function ${name} in a pipeline or substitution is not yet analyzed`,
        spanOf(node),
      );
      return undefined;
    }
    const nameIndex = node.namedChildren.findIndex(
      (part) =>
        part.startIndex === nameNode?.startIndex &&
        part.endIndex === nameNode?.endIndex,
    );
    const prefixes =
      nameIndex < 0 ? [] : node.namedChildren.slice(0, nameIndex);
    if (prefixes.some((part) => part.type !== "variable_assignment")) {
      block("Command prefix is not yet analyzed", spanOf(node));
      return undefined;
    }
    if (name === "read") {
      const source = node.namedChildren.filter(
        (part) => part.type === "herestring_redirect",
      );
      const args = node.namedChildren
        .slice(nameIndex + 1)
        .filter((part) => part.type !== "herestring_redirect");
      const ifsAssignment = prefixes[0];
      const ifsValue = ifsAssignment?.namedChildren.find(
        (part) => part.type !== "variable_name",
      );
      const separator = ifsValue ? bashValue(ifsValue) : undefined;
      const name = args[2]?.text;
      if (
        prefixes.length !== 1 ||
        ifsAssignment?.namedChildren[0]?.text !== "IFS" ||
        separator?.text !== "," ||
        args.length !== 3 ||
        args[0]?.text !== "-r" ||
        args[1]?.text !== "-a" ||
        !name ||
        !/^[A-Za-z_][A-Za-z_0-9]*$/u.test(name) ||
        source.length !== 1
      ) {
        block(
          "Bash read options or IFS source are not yet analyzed",
          spanOf(node),
        );
        return undefined;
      }
      const inputNode = source[0]?.namedChildren[0];
      const input = inputNode ? bashValue(inputNode) : undefined;
      if (!input) return undefined;
      if (variables.has(name) || exported.has(name)) {
        block("Bash read array conflicts with a scalar variable", spanOf(node));
        return undefined;
      }
      const texts = finiteBytes(input);
      const bytes = texts?.length === 1 ? texts[0] : undefined;
      if (bytes !== undefined && !/[\n\r\0]/u.test(bytes)) {
        const fields = bytes.split(",");
        while (fields.at(-1) === "") fields.pop();
        const elements = fields.map(literalBytes);
        arrays.set(name, {
          element: one({ kind: "primitive", name: "string" }, false),
          elements,
          min: elements.length,
          max: elements.length,
        });
      } else
        arrays.set(name, {
          element: one({ kind: "primitive", name: "string" }, false),
          min: 0,
          max: Number.POSITIVE_INFINITY,
        });
      return { type: nullType, min: 0, max: 0, encoded: true };
    }
    const localCommand =
      name &&
      (name.startsWith("./") || name.startsWith(".github/")) &&
      name.endsWith(".sh");
    if (prefixes.length && !localCommand) {
      block(
        "Command-scoped env is only analyzed for local scripts",
        spanOf(node),
      );
      return undefined;
    }
    const scopedEnv = new Map<string, Value>();
    for (const prefix of prefixes) {
      const key = prefix.namedChildren.find(
        (part) => part.type === "variable_name",
      )?.text;
      const valueNode = prefix.namedChildren.find(
        (part) => part.type !== "variable_name",
      );
      if (!key || !valueNode) {
        block(
          "Command-scoped env assignment is not yet analyzed",
          spanOf(prefix),
        );
        return undefined;
      }
      const value = bashValue(valueNode);
      if (!value) return undefined;
      scopedEnv.set(key, value);
    }
    const redirects = node.namedChildren.filter(
      (part) => part.type === "herestring_redirect",
    );
    if (redirects.length > 1 || (redirects.length && piped)) {
      block("Multiple stdin sources are not yet analyzed", spanOf(node));
      return undefined;
    }
    const hereValue = redirects[0]?.namedChildren[0];
    const supplied = hereValue ? bashValue(hereValue) : piped;
    if (hereValue && !supplied) return undefined;
    const args = node.namedChildren
      .slice(nameIndex + 1)
      .filter((part) => part.type !== "herestring_redirect");
    if (name === "jq") {
      let noInput = false;
      let raw = false;
      let compact = false;
      let exitCheck = false;
      let filter: BashSyntaxNode | undefined;
      const bindings = new Map<string, Value>();
      for (let i = 0; i < args.length; i++) {
        const arg = args[i] as BashSyntaxNode;
        if (
          arg.type === "word" &&
          ["--arg", "--argjson"].includes(arg.text) &&
          !filter
        ) {
          const key = args[i + 1];
          const argument = args[i + 2];
          if (
            !key ||
            !argument ||
            key.type !== "word" ||
            !/^[A-Za-z_][A-Za-z_0-9]*$/u.test(key.text)
          ) {
            block(`Invalid jq ${arg.text} binding`, spanOf(arg));
            return undefined;
          }
          let value = bashValue(argument);
          if (!value && arg.text === "--arg") {
            const variable = /^"\$([A-Za-z_][A-Za-z_0-9]*)"$/u.exec(
              argument.text,
            )?.[1];
            if (variable && failedVariables.has(variable))
              value = one({ kind: "primitive", name: "string" }, false);
          }
          if (!value) return undefined;
          if (arg.text === "--argjson") {
            if (value.min !== 1 || value.max !== 1) {
              report(
                "PIPE103",
                "--argjson requires exactly one JSON value",
                spanOf(argument),
              );
              return undefined;
            }
            if (!value.encoded) {
              report(
                "PIPE101",
                "--argjson argument is not JSON encoded",
                spanOf(argument),
              );
              return undefined;
            }
            bindings.set(`$${key.text}`, value);
          } else {
            const bytes = finiteBytes(value);
            bindings.set(
              `$${key.text}`,
              one(
                !bytes?.length
                  ? { kind: "primitive", name: "string" }
                  : union(
                      bytes.map((item) => ({
                        kind: "literal" as const,
                        value: item,
                      })),
                    ),
                true,
                value.text === undefined
                  ? undefined
                  : JSON.stringify(value.text),
              ),
            );
          }
          i += 2;
        } else if (arg.type === "word" && arg.text.startsWith("-") && !filter) {
          if (!/^-[cnre]+$/u.test(arg.text)) {
            block(`Unsupported jq option ${arg.text}`, spanOf(arg));
            return undefined;
          }
          noInput ||= arg.text.includes("n");
          compact ||= arg.text.includes("c");
          raw ||= arg.text.includes("r");
          exitCheck ||= arg.text.includes("e");
        } else if (arg.type === "raw_string" && !filter) filter = arg;
        else {
          block(
            "Dynamic jq filter or arguments are not yet analyzed",
            spanOf(arg),
          );
          return undefined;
        }
      }
      if (!filter) {
        block("Missing static jq filter", spanOf(node));
        return undefined;
      }
      const filterSource = filter.text.slice(1, -1);
      try {
        const syntax = parseJq(filterSource);
        let channel: Value;
        if (noInput) channel = one(nullType);
        else if (supplied) channel = supplied;
        else if (!contract.stdin) {
          report("PIPE104", "jq reads undeclared stdin", spanOf(node));
          return undefined;
        } else {
          channel = {
            type: contract.stdin,
            min: consumed === "yes" ? 0 : consumed === "maybe" ? 0 : 1,
            max: consumed === "yes" ? 0 : 1,
            encoded: true,
          };
          consumed = "yes";
        }
        if (!channel.encoded) {
          report("PIPE101", "jq stdin is not JSON encoded", spanOf(node));
          return undefined;
        }
        if (channel.max === 0) return channel;
        const failure = { observed: false };
        const sourceName =
          hereValue &&
          /^"\$([A-Za-z_][A-Za-z_0-9]*)"$/u.exec(hereValue.text)?.[1];
        const originSource =
          sourceName && variables.get(sourceName) === channel
            ? channel
            : undefined;
        const result = evalJq(
          syntax,
          {
            ...one(channel.type),
            ...(originSource ? { originSource } : {}),
          },
          filter.startIndex + 1,
          bindings,
          failure,
        );
        if (!result) return undefined;
        if (failure.observed && !conditional) {
          if (result.alwaysFails || result.max === 0) {
            block("jq error leaves no proven successful result", spanOf(node));
            return undefined;
          }
          if (!errexit || (inPipeline && !pipefail)) {
            block(
              "jq error may continue without proven errexit/pipefail",
              spanOf(node),
            );
            return undefined;
          }
        }
        if (
          exitCheck &&
          !conditional &&
          (result.min === 0 || couldBeFalseOrNull(result.type))
        ) {
          block(
            "jq -e exit status may be nonzero; failure path is not yet analyzed",
            spanOf(node),
          );
          return undefined;
        }
        if (
          exitCheck &&
          conditional &&
          (result.max === 0 || !truthyPart(result.type))
        )
          return { ...result, min: 0, max: 0, alwaysFails: true };
        let presenceTest: Value["presenceTest"];
        if (
          sourceName &&
          supplied &&
          variables.get(sourceName) === supplied &&
          syntax.kind === "call" &&
          syntax.value === "has" &&
          syntax.children.length === 1 &&
          syntax.children[0]?.kind === "literal" &&
          result.min === 1 &&
          result.max === 1
        ) {
          try {
            const key: unknown = JSON.parse(syntax.children[0].value ?? "");
            if (typeof key === "string")
              presenceTest = { sourceName, sourceValue: supplied, key };
          } catch {
            // Invalid jq literals have already been diagnosed by evalJq.
          }
        }
        const withPresence = (value: Value): Value =>
          presenceTest ? { ...value, presenceTest } : value;
        const cardinality = {
          ...result,
          min: multiply(channel.min, result.min),
          max: multiply(channel.max, result.max),
          singleLine: compact && !raw,
        };
        if (!raw || !couldBeString(cardinality.type))
          return withPresence({ ...cardinality, delimited: true });
        if (
          cardinality.type.kind === "literal" &&
          typeof cardinality.type.value === "string"
        ) {
          return withPresence({
            ...literalBytes(cardinality.type.value),
            min: cardinality.min,
            max: cardinality.max,
            delimited: true,
          });
        }
        const rawStrings = finiteStringKeys(cardinality.type);
        if (rawStrings && rawStrings.length > 1)
          return withPresence({
            type: cardinality.type,
            min: cardinality.min,
            max: cardinality.max,
            encoded: false,
            texts: rawStrings,
            delimited: true,
          });
        return withPresence({
          type: cardinality.type,
          min: cardinality.min,
          max: cardinality.max,
          encoded: false,
          delimited: true,
        });
      } catch (error) {
        if (
          error instanceof JqSyntaxError ||
          error instanceof JqUnsupportedSyntaxError
        ) {
          report(
            error instanceof JqSyntaxError ? "PIPE001" : "PIPE202",
            error.message,
            createSpan(
              filter.startIndex + 1 + error.span.start,
              filter.startIndex + 1 + error.span.end,
            ),
            error instanceof JqSyntaxError ? "error" : "blocked",
          );
          if (error instanceof JqUnsupportedSyntaxError) blocked = true;
          return undefined;
        }
        throw error;
      }
    }
    if (name === "printf") {
      const formatNode = args[0];
      if (formatNode?.type !== "raw_string") {
        block("Dynamic printf format is not yet analyzed", spanOf(node));
        return undefined;
      }
      const rawFormat = formatNode.text.slice(1, -1);
      if (
        rawFormat.includes("%%") ||
        /%(?!s)/u.test(rawFormat) ||
        /\\(?!n|t|\\)/u.test(rawFormat)
      ) {
        block(
          "printf conversion or escape is not yet analyzed",
          spanOf(formatNode),
        );
        return undefined;
      }
      const fields = (rawFormat.match(/%s/gu) ?? []).length;
      if (fields !== args.length - 1) {
        block("printf argument repetition is not yet analyzed", spanOf(node));
        return undefined;
      }
      const values: Value[] = [];
      for (const arg of args.slice(1)) {
        const value = bashValue(arg);
        if (!value) return undefined;
        if (value.min !== 1 || value.max !== 1) {
          block(
            "printf argument stream cardinality is not yet analyzed",
            spanOf(arg),
          );
          return undefined;
        }
        values.push(value);
      }
      const assignmentName = /^([A-Za-z_][A-Za-z_0-9]*)=%s\\n$/u.exec(
        rawFormat,
      )?.[1];
      const githubAssignment =
        assignmentName && values[0] && values.length === 1
          ? { name: assignmentName, payload: values[0] }
          : undefined;
      if (rawFormat === "%s" || rawFormat === "%s\\n") {
        const value = values[0];
        return value
          ? { ...value, delimited: rawFormat.endsWith("\\n") }
          : undefined;
      }
      const segments = rawFormat
        .replaceAll("\\n", "\n")
        .replaceAll("\\t", "\t")
        .replaceAll("\\\\", "\\")
        .split("%s");
      const known = values.every((value) => value.text !== undefined);
      if (!known)
        return {
          type: { kind: "primitive", name: "string" },
          min: 1,
          max: 1,
          encoded: false,
          delimited: rawFormat.endsWith("\\n"),
          ...(githubAssignment ? { githubAssignment } : {}),
        };
      const bytes = segments.reduce(
        (result, segment, index) =>
          result + (index > 0 ? (values[index - 1]?.text ?? "") : "") + segment,
        "",
      );
      return {
        ...literalBytes(bytes),
        delimited: bytes.endsWith("\n"),
        ...(githubAssignment ? { githubAssignment } : {}),
      };
    }
    if (name === "yq") {
      if (args.length !== 4 || !args[3] || !options.readLocalFile) {
        block("yq invocation or file effect is not yet analyzed", spanOf(node));
        return undefined;
      }
      const namespaceMode =
        args[0]?.text === "eval" &&
        args[1]?.text === "-o=json" &&
        args[2]?.text === "'.namespace'";
      const kustomizationFilter =
        "($image_selector | .newName) = strenv(IMAGE_REPOSITORY) | ($image_selector | .$version_field) = strenv(IMAGE_VERSION) | del($image_selector | .$obsolete_field)";
      const kustomizationWriteMode =
        args[0]?.text === "eval" &&
        args[2]?.text === "-i" &&
        args[1]?.type === "string" &&
        args[1].text.startsWith('"') &&
        args[1].text.endsWith('"') &&
        args[1].text.slice(1, -1).replace(/\s+/gu, " ").trim() ===
          kustomizationFilter;
      const writeFilter =
        args[0]?.text === "eval" &&
        args[2]?.text === "-i" &&
        args[1] &&
        !kustomizationWriteMode
          ? bashValue(args[1])
          : undefined;
      const portalWriteMode =
        writeFilter?.text ===
        `(${PORTAL_IMAGE_SELECTOR}) = strenv(IMAGE_REFERENCE)`;
      const filterValue =
        namespaceMode || portalWriteMode || kustomizationWriteMode || !args[2]
          ? undefined
          : bashValue(args[2]);
      const imageMode =
        args[0]?.text === "eval" &&
        args[1]?.text === "-e" &&
        filterValue?.text === `([${IMAGE_SELECTOR}] | length) == 1`;
      const portalMode =
        args[0]?.text === "eval-all" &&
        args[1]?.text === "-e" &&
        filterValue?.text === `([${PORTAL_IMAGE_SELECTOR}] | length) == 1`;
      const portalReadMode =
        args[0]?.text === "eval" &&
        args[1]?.text === "-r" &&
        filterValue?.text === PORTAL_IMAGE_SELECTOR;
      if (
        !namespaceMode &&
        !imageMode &&
        !portalMode &&
        !portalReadMode &&
        !portalWriteMode &&
        !kustomizationWriteMode
      ) {
        block("yq invocation or file effect is not yet analyzed", spanOf(node));
        return undefined;
      }
      if (
        filesMayWrite.size > 0 &&
        (!(portalReadMode || portalWriteMode || kustomizationWriteMode) ||
          [...filesMayWrite].some(
            (candidate) =>
              !verifiedPortalImageWrites.has(candidate) &&
              !verifiedKustomizationWrites.has(candidate),
          ))
      ) {
        block("yq snapshot read follows an unmodeled file write", spanOf(node));
        return undefined;
      }
      if (kustomizationWriteMode) {
        const selector = variables.get("image_selector");
        const versionField = variables.get("version_field");
        const obsoleteField = variables.get("obsolete_field");
        const versions = versionField && finiteBytes(versionField);
        const obsolete = obsoleteField && finiteBytes(obsoleteField);
        if (
          selector?.text !== IMAGE_SELECTOR ||
          !hasVerifiedVersionFieldPair() ||
          !versions ||
          !obsolete ||
          versions.some((value) => !["digest", "newTag"].includes(value)) ||
          obsolete.some((value) => !["digest", "newTag"].includes(value))
        ) {
          block("yq version-field pair is not proven", spanOf(node));
          return undefined;
        }
        for (const envName of [
          "IMAGE_ORIGIN_NAME",
          "IMAGE_REPOSITORY",
          "IMAGE_VERSION",
        ]) {
          const value = variables.get(envName);
          if (
            !value ||
            !exported.has(envName) ||
            value.encoded ||
            !members(value.type).every(couldBeString)
          ) {
            block(
              `yq update env ${envName} is not verified raw string`,
              spanOf(node),
            );
            return undefined;
          }
        }
      }
      if (portalWriteMode) {
        const reference = variables.get("IMAGE_REFERENCE");
        if (
          !reference ||
          !exported.has("IMAGE_REFERENCE") ||
          reference.encoded ||
          !members(reference.type).every(couldBeString)
        ) {
          block(
            "yq portal write needs a verified raw IMAGE_REFERENCE",
            spanOf(node),
          );
          return undefined;
        }
      }
      const path = bashValue(args[3]);
      const paths = path && finiteBytes(path);
      if (!paths || paths.length > 32) {
        block("yq source has no bounded verified file paths", spanOf(args[3]));
        return undefined;
      }
      if (
        (portalWriteMode &&
          paths.some(
            (candidate) => !candidate.endsWith("/support-portal.yaml"),
          )) ||
        (kustomizationWriteMode &&
          paths.some((candidate) => !candidate.endsWith("/kustomization.yaml")))
      ) {
        block(
          "yq update target is not a verified overlay file",
          spanOf(args[3]),
        );
        return undefined;
      }
      const values: Template[] = [];
      let anyUniqueMatch = false;
      let everyQueryMatches = true;
      let totalBytes = 0;
      for (const candidate of paths) {
        const source = options.readLocalFile(candidate);
        if (source.kind === "unavailable") {
          blocked = true;
          report(
            "PIPE204",
            `Local YAML dependency is unavailable: ${candidate}: ${source.reason}`,
            spanOf(args[3]),
            "blocked",
          );
          return undefined;
        }
        totalBytes += source.source.length;
        if (source.source.length > 1_048_576 || totalBytes > 4_194_304) {
          block("yq source exceeds its byte budget", spanOf(args[3]));
          return undefined;
        }
        if (namespaceMode) {
          const document = parseDocument(source.source, {
            uniqueKeys: true,
            keepSourceTokens: false,
          });
          if (document.errors.length || !isMap(document.contents)) {
            block(
              "yq source is not a single valid YAML mapping",
              spanOf(args[3]),
            );
            return undefined;
          }
          const namespace = document.contents.get("namespace", true);
          if (namespace === undefined) values.push(nullType);
          else if (
            isScalar(namespace) &&
            (namespace.value === null ||
              typeof namespace.value === "string" ||
              typeof namespace.value === "boolean" ||
              (typeof namespace.value === "number" &&
                Number.isFinite(namespace.value)))
          )
            values.push(templateOfJson(namespace.value));
          else {
            block("yq namespace value is not a scalar", spanOf(args[3]));
            return undefined;
          }
          continue;
        }
        const documents = parseAllDocuments(source.source, {
          uniqueKeys: true,
          keepSourceTokens: false,
        });
        if (
          documents.length === 0 ||
          (imageMode && documents.length !== 1) ||
          documents.some(
            (document) =>
              document.errors.length > 0 || !isMap(document.contents),
          )
        ) {
          block(
            "yq selector source is not valid YAML mappings",
            spanOf(args[3]),
          );
          return undefined;
        }
        if (imageMode || kustomizationWriteMode) {
          const images = documents[0]?.contents;
          const sequence = isMap(images)
            ? images.get("images", true)
            : undefined;
          if (!isSeq(sequence) || sequence.items.length > 128) {
            block(
              "yq image selector needs a bounded images sequence",
              spanOf(args[3]),
            );
            return undefined;
          }
          const pairs: Array<{ name?: string; newName?: string }> = [];
          for (const item of sequence.items) {
            if (!isMap(item)) {
              block(
                "yq image selector found a non-object image",
                spanOf(args[3]),
              );
              return undefined;
            }
            const name = item.get("name", true);
            const newName = item.get("newName", true);
            pairs.push({
              ...(isScalar(name) && typeof name.value === "string"
                ? { name: name.value }
                : {}),
              ...(isScalar(newName) && typeof newName.value === "string"
                ? { newName: newName.value }
                : {}),
            });
          }
          if (kustomizationWriteMode) continue;
          const origin = variables.get("IMAGE_ORIGIN_NAME");
          const repository = variables.get("IMAGE_REPOSITORY");
          if (
            !origin ||
            !repository ||
            !exported.has("IMAGE_ORIGIN_NAME") ||
            !exported.has("IMAGE_REPOSITORY") ||
            origin.encoded ||
            repository.encoded ||
            !members(origin.type).every(couldBeString) ||
            !members(repository.type).every(couldBeString)
          ) {
            block(
              "yq image selector environment is not verified raw strings",
              spanOf(node),
            );
            return undefined;
          }
          const names = [
            ...new Set(
              pairs.flatMap((entry) => (entry.name ? [entry.name] : [])),
            ),
          ];
          const newNames = [
            ...new Set(
              pairs.flatMap((entry) => (entry.newName ? [entry.newName] : [])),
            ),
          ];
          const choices = (
            known: readonly string[] | undefined,
            candidates: string[],
          ): string[] => {
            if (known) return [...known];
            let other = "__pipe_unmatched__";
            while (candidates.includes(other)) other += "_";
            return [...candidates, other];
          };
          const origins = choices(finiteBytes(origin), names);
          const repositories = choices(finiteBytes(repository), newNames);
          let candidateMatches = false;
          let candidateAlwaysMatches = true;
          for (const originName of origins)
            for (const repositoryName of repositories) {
              const matches = pairs.filter(
                (entry) =>
                  entry.name === originName || entry.newName === repositoryName,
              ).length;
              candidateMatches ||= matches === 1;
              candidateAlwaysMatches &&= matches === 1;
            }
          anyUniqueMatch ||= candidateMatches;
          everyQueryMatches &&= candidateAlwaysMatches;
        } else {
          let count = 0;
          let portalImageIsString = true;
          for (const document of documents) {
            const root = document.contents;
            if (!isMap(root)) continue;
            const kind = root.get("kind", true);
            const metadata = root.get("metadata", true);
            const metadataName = isMap(metadata)
              ? metadata.get("name", true)
              : undefined;
            const kindValue: unknown = isScalar(kind) ? kind.value : undefined;
            const metadataNameValue: unknown = isScalar(metadataName)
              ? metadataName.value
              : undefined;
            if (
              kindValue !== "Deployment" ||
              metadataNameValue !== "support-portal"
            )
              continue;
            const spec = root.get("spec", true);
            const template = isMap(spec)
              ? spec.get("template", true)
              : undefined;
            const podSpec = isMap(template)
              ? template.get("spec", true)
              : undefined;
            const containers = isMap(podSpec)
              ? podSpec.get("containers", true)
              : undefined;
            if (!isSeq(containers) || containers.items.length > 128) {
              block(
                "yq portal selector needs bounded containers",
                spanOf(args[3]),
              );
              return undefined;
            }
            for (const container of containers.items) {
              const name = isMap(container)
                ? container.get("name", true)
                : undefined;
              if (isScalar(name) && name.value === "support-portal") {
                count++;
                const image = isMap(container)
                  ? container.get("image", true)
                  : undefined;
                portalImageIsString &&=
                  isScalar(image) && typeof image.value === "string";
              }
            }
          }
          if (
            (portalReadMode || portalWriteMode) &&
            (count !== 1 || !portalImageIsString)
          ) {
            block(
              "yq portal image read has no single string value",
              spanOf(node),
            );
            return undefined;
          }
          anyUniqueMatch ||= count === 1;
          everyQueryMatches &&= count === 1;
        }
      }
      if (kustomizationWriteMode) {
        for (const candidate of paths) {
          filesMayWrite.add(candidate);
          verifiedKustomizationWrites.add(candidate);
        }
        return { type: nullType, min: 0, max: 0, encoded: true };
      }
      if (portalWriteMode) {
        if (!everyQueryMatches) {
          block("yq portal write has an unverified target", spanOf(node));
          return undefined;
        }
        for (const candidate of paths) {
          filesMayWrite.add(candidate);
          verifiedPortalImageWrites.add(candidate);
        }
        return { type: nullType, min: 0, max: 0, encoded: true };
      }
      if (portalReadMode)
        return {
          type: { kind: "primitive", name: "string" },
          min: 1,
          max: 1,
          encoded: false,
          delimited: true,
        };
      if (!namespaceMode) {
        if (!anyUniqueMatch) {
          block(
            "yq selector has no possible unique match in verified files",
            spanOf(node),
          );
          return undefined;
        }
        return {
          type: everyQueryMatches
            ? { kind: "literal", value: true }
            : { kind: "primitive", name: "boolean" },
          min: 1,
          max: 1,
          encoded: true,
          delimited: true,
        };
      }
      const type = union(values);
      return { type, min: 1, max: 1, encoded: true, delimited: true };
    }
    if (name === "dirname") {
      if (args.length !== 2 || args[0]?.text !== "--" || !args[1]) {
        block("dirname arguments are not yet analyzed", spanOf(node));
        return undefined;
      }
      let directory: string | undefined;
      if (args[1].text === `"\${BASH_SOURCE[0]}"`)
        directory = options.scriptDirectory;
      else {
        const path = bashValue(args[1]);
        if (path?.text !== undefined) {
          const trimmed = path.text.replace(/\/+$/u, "") || "/";
          const slash = trimmed.lastIndexOf("/");
          directory =
            slash < 0 ? "." : slash === 0 ? "/" : trimmed.slice(0, slash);
        }
      }
      if (directory === undefined) {
        block("dirname path is not statically known", spanOf(node));
        return undefined;
      }
      return { ...literalBytes(`${directory}\n`), delimited: true };
    }
    if (name === "date") {
      if (
        args.length === 1 &&
        ['+"%Y%m%d-%H%M%S"', "'+%Y%m%d-%H%M%S'", "+%Y%m%d-%H%M%S"].includes(
          args[0]?.text ?? "",
        )
      )
        return {
          type: { kind: "primitive", name: "string" },
          min: 1,
          max: 1,
          encoded: false,
          delimited: true,
        };
      block("date format or options are not yet analyzed", spanOf(node));
      return undefined;
    }
    if (name === "set") {
      const words = args.map((arg) => arg.text);
      if (
        (words.length === 1 && /^-[eu]+$/u.test(words[0] ?? "")) ||
        (words.length === 2 &&
          /^-[eu]*o$/u.test(words[0] ?? "") &&
          words[1] === "pipefail")
      ) {
        if (expectsReturn || inPipeline) {
          block(
            "Shell options in a subshell are not yet analyzed",
            spanOf(node),
          );
          return undefined;
        }
        errexit ||= words[0]?.includes("e") ?? false;
        pipefail ||= words[1] === "pipefail";
        return { type: nullType, min: 0, max: 0, encoded: true };
      }
      block("Shell option combination is not yet analyzed", spanOf(node));
      return undefined;
    }
    if (name === "git" || name === "gh") {
      if (
        prefixes.length ||
        redirects.length ||
        piped ||
        expectsReturn ||
        inPipeline ||
        conditional ||
        !errexit ||
        contract.stdout
      ) {
        block(
          `${name} command context or stdout effect is not yet analyzed`,
          spanOf(node),
        );
        return undefined;
      }
      const words = args.map((part) => part.text);
      let operation: string | undefined;
      if (name === "git") {
        if (
          args.length === 3 &&
          words[0] === "config" &&
          ["user.name", "user.email"].includes(words[1] ?? "") &&
          quotedCommandArgument(args[2])
        )
          operation = "git config identity";
        else if (
          args.length === 3 &&
          words[0] === "checkout" &&
          words[1] === "-b" &&
          quotedCommandArgument(args[2])
        ) {
          operation = "git checkout branch";
          checkedOutBranch = bashValue(args[2] as BashSyntaxNode);
        } else if (
          args.length === 3 &&
          words[0] === "add" &&
          words[1] === "--" &&
          quotedCommandArgument(args[2])
        )
          operation = "git stage path";
        else if (
          args.length === 3 &&
          words[0] === "commit" &&
          words[1] === "-m" &&
          quotedCommandArgument(args[2])
        )
          operation = "git commit";
        else if (
          args.length === 3 &&
          words[0] === "push" &&
          words[1] === "origin" &&
          quotedCommandArgument(args[2]) &&
          checkedOutBranch &&
          sameCommandArgument(
            checkedOutBranch,
            bashValue(args[2] as BashSyntaxNode) as Value,
          )
        )
          operation = "git push origin";
      } else if (
        args.length === 12 &&
        words[0] === "pr" &&
        words[1] === "create" &&
        words[2] === "--title" &&
        words[4] === "--body" &&
        words[6] === "--base" &&
        words[7] === "main" &&
        words[8] === "--head" &&
        words[10] === "--repo" &&
        [args[3], args[5], args[9], args[11]].every((part) =>
          part ? quotedCommandArgument(part) : false,
        ) &&
        ["GH_TOKEN", "GH_REPO"].every(
          (key) => exported.has(key) && variables.has(key),
        )
      )
        operation = "gh pr create";
      if (!operation) {
        block(
          `${name} command arguments or required env are not verified`,
          spanOf(node),
        );
        return undefined;
      }
      externalMayRun.add(operation);
      return { type: nullType, min: 0, max: 0, encoded: true };
    }
    if (localCommand) {
      if (args.length > 0) {
        report(
          "PIPE104",
          "Business positional arguments are not supported",
          spanOf(node),
        );
        return undefined;
      }
      const summary = options.resolveLocalScript?.(name);
      if (!summary) {
        blocked = true;
        report(
          "PIPE204",
          `Local script dependency is unavailable: ${name}`,
          spanOf(node),
          "blocked",
        );
        return undefined;
      }
      if (summary.contract.issues.length) {
        block(`Local script ${name} has an invalid contract`, spanOf(node));
        return undefined;
      }
      for (const [key, required] of Object.entries(summary.contract.env)) {
        if (
          !scopedEnv.has(key) &&
          exported.has(key) &&
          (invalidatedVariables.has(key) || maybeVariables.has(key))
        ) {
          block(
            `Local script ${name} env ${key} has an unverified value`,
            spanOf(node),
          );
          return undefined;
        }
        const value =
          scopedEnv.get(key) ??
          (exported.has(key) ? variables.get(key) : undefined);
        if (!value) {
          report(
            "PIPE104",
            `Local script ${name} requires exported env ${key}`,
            spanOf(node),
          );
          return undefined;
        }
        if (!value.encoded) {
          report(
            "PIPE101",
            `Local script ${name} env ${key} is not JSON encoded`,
            spanOf(node),
          );
          return undefined;
        }
        if (!isAssignable(value.type, required)) {
          report(
            "PIPE102",
            `Local script ${name} env ${key} does not match its contract`,
            spanOf(node),
          );
          return undefined;
        }
      }
      if (summary.contract.stdin) {
        let input = supplied;
        if (!input) {
          if (!contract.stdin) {
            report(
              "PIPE104",
              `Local script ${name} requires stdin`,
              spanOf(node),
            );
            return undefined;
          }
          input = {
            type: contract.stdin,
            min: consumed === "no" ? 1 : 0,
            max: consumed === "yes" ? 0 : 1,
            encoded: true,
          };
          consumed = "yes";
        }
        if (input.min !== 1 || input.max !== 1) {
          report(
            "PIPE103",
            `Local script ${name} requires exactly one stdin JSON value`,
            spanOf(node),
          );
          return undefined;
        }
        if (!input.encoded) {
          report(
            "PIPE101",
            `Local script ${name} stdin is not JSON encoded`,
            spanOf(node),
          );
          return undefined;
        }
        if (!isAssignable(input.type, summary.contract.stdin)) {
          const missing = missingRequiredFields(
            input.type,
            summary.contract.stdin,
          );
          report(
            missing.length ? "PIPE104" : "PIPE102",
            missing.length
              ? `Local script ${name} stdin is missing required field(s): ${missing.join(", ")}`
              : `Local script ${name} stdin does not match its contract`,
            spanOf(node),
          );
          return undefined;
        }
      } else if (supplied) {
        report(
          "PIPE104",
          `Local script ${name} has no stdin interface`,
          spanOf(node),
        );
        return undefined;
      }
      if (!summary.contract.stdout && expectsReturn) {
        report(
          "PIPE104",
          `Local script ${name} has no stdout return interface`,
          spanOf(node),
        );
        return undefined;
      }
      for (const path of summary.effects?.filesMayWrite ?? [])
        filesMayWrite.add(path);
      for (const effect of summary.effects?.externalMayRun ?? [])
        externalMayRun.add(effect);
      if (!summary.complete) {
        block(`Local script ${name} has not passed analysis`, spanOf(node));
        return undefined;
      }
      if (!summary.contract.stdout)
        return { type: nullType, min: 0, max: 0, encoded: true };
      return one(summary.contract.stdout);
    }
    if (
      name &&
      [
        "set",
        "read",
        "echo",
        "export",
        "local",
        "source",
        "eval",
        "cd",
        "exit",
        "return",
      ].includes(name)
    )
      block(`Bash builtin ${name} is not yet analyzed`, spanOf(node));
    else {
      blocked = true;
      report(
        "PIPE201",
        `Command ${name ?? "?"} has no contract`,
        spanOf(node),
        "blocked",
      );
    }
    return undefined;
  }

  function evalPipeline(
    node: BashSyntaxNode,
    expectsReturn = false,
    conditional = false,
  ): Value | undefined {
    if (conditional && !pipefail && node.namedChildren.length > 1) {
      block("Guarded pipeline needs proven pipefail", spanOf(node));
      return undefined;
    }
    let current: Value | undefined;
    for (const [index, part] of node.namedChildren.entries()) {
      if (part.type !== "command") {
        block("Pipeline component is not yet analyzed", spanOf(part));
        return undefined;
      }
      current = evalCommand(
        part,
        current,
        expectsReturn || index < node.namedChildren.length - 1,
        true,
        conditional && index === node.namedChildren.length - 1,
      );
      if (!current) {
        const next = node.namedChildren[index + 1];
        if (
          next?.type === "command" &&
          part.childForFieldName("name")?.text === "jq"
        ) {
          const calleeName = next.childForFieldName("name")?.text;
          const filter = part.namedChildren.at(-1);
          if (
            calleeName &&
            (calleeName.startsWith("./") ||
              calleeName.startsWith(".github/")) &&
            calleeName.endsWith(".sh") &&
            filter?.type === "raw_string"
          ) {
            const summary = options.resolveLocalScript?.(calleeName);
            if (
              summary?.contract.stdin?.kind === "object" &&
              !summary.contract.issues.length
            ) {
              try {
                const syntax = parseJq(filter.text.slice(1, -1));
                if (syntax.kind === "object") {
                  const names = new Set(
                    syntax.children.map((property) =>
                      property.value?.startsWith('"')
                        ? (JSON.parse(property.value) as string)
                        : (property.value ?? ""),
                    ),
                  );
                  const missing = Object.keys(
                    summary.contract.stdin.fields,
                  ).filter((key) => !names.has(key));
                  if (missing.length)
                    report(
                      "PIPE104",
                      `Local script ${calleeName} stdin is missing required field(s): ${missing.join(", ")}`,
                      spanOf(next),
                    );
                }
              } catch (error) {
                if (
                  !(
                    error instanceof JqSyntaxError ||
                    error instanceof JqUnsupportedSyntaxError
                  )
                )
                  throw error;
              }
            }
          }
        }
        return undefined;
      }
      if (
        !current.encoded &&
        part !== node.namedChildren[node.namedChildren.length - 1]
      ) {
        report(
          "PIPE101",
          "Pipeline passes non-JSON bytes to the next command",
          spanOf(part),
        );
        return undefined;
      }
    }
    return current;
  }

  function evalSubstitution(
    node: BashSyntaxNode,
    conditional = false,
  ): Value | undefined {
    const body = node.namedChildren.filter((part) => part.type !== "comment");
    if (body.length !== 1) {
      block("Multi-command substitution is not yet analyzed", spanOf(node));
      return undefined;
    }
    const part = body[0];
    if (part?.type === "list") {
      const [change, print] = part.namedChildren;
      const operator =
        change && print
          ? part.text
              .slice(
                change.endIndex - part.startIndex,
                print.startIndex - part.startIndex,
              )
              .trim()
          : "";
      if (
        part.namedChildren.length === 2 &&
        change?.type === "command" &&
        print?.type === "command" &&
        operator === "&&" &&
        change.childForFieldName("name")?.text === "cd" &&
        print.childForFieldName("name")?.text === "pwd" &&
        print.namedChildren.length === 1
      ) {
        const args = change.namedChildren.slice(1);
        const targetNode =
          args.length === 2 && args[0]?.text === "--" ? args[1] : undefined;
        const target = targetNode ? bashValue(targetNode) : undefined;
        if (target?.text === undefined) {
          block("cd target is not statically known", spanOf(change));
          return undefined;
        }
        const resolved = options.resolveDirectory?.(target.text);
        if (!resolved) {
          block("No verified project directory context for cd", spanOf(change));
          return undefined;
        }
        if (resolved.kind === "unavailable") {
          blocked = true;
          report(
            "PIPE204",
            `Local directory dependency is unavailable: ${resolved.reason}`,
            spanOf(change),
            "blocked",
          );
          return undefined;
        }
        return literalBytes(resolved.path.replace(/\n+$/u, ""));
      }
    }
    if (part?.type === "command" || part?.type === "pipeline") {
      const value =
        part.type === "command"
          ? evalCommand(part, undefined, true, false, conditional)
          : evalPipeline(part, true, conditional);
      if (!value) return undefined;
      if (value.text?.endsWith("\n") && value.min === 1 && value.max === 1)
        return literalBytes(value.text.replace(/\n+$/u, ""));
      return value;
    }
    block("Command substitution body is not yet analyzed", spanOf(node));
    return undefined;
  }

  function isExitCheckedJqSubstitution(node: BashSyntaxNode): boolean {
    const body = node.namedChildren.filter((part) => part.type !== "comment");
    const command = body.length === 1 ? body[0] : undefined;
    return Boolean(
      command?.type === "command" &&
        command.childForFieldName("name")?.text === "jq" &&
        command.namedChildren
          .slice(1)
          .some(
            (part) =>
              part.type === "word" &&
              /^-[cnre]+$/u.test(part.text) &&
              part.text.includes("e"),
          ),
    );
  }

  interface BranchState {
    readonly variables: Map<string, Value>;
    readonly arrays: Map<string, ShellArray>;
    readonly exported: Set<string>;
    readonly failedVariables: Set<string>;
    readonly maybeVariables: Set<string>;
    readonly invalidatedVariables: Set<string>;
    readonly consumed: "no" | "yes" | "maybe";
    readonly errexit: boolean;
    readonly pipefail: boolean;
    readonly output: Value | undefined;
    readonly lastOutputSpan: Span | undefined;
    readonly blocked: boolean;
    readonly dead: boolean;
    readonly functions: Map<string, "fatal" | "unsupported">;
    readonly githubEnv: Map<string, Value>;
    readonly githubOutput: Map<string, Value>;
    readonly checkedOutBranch: Value | undefined;
  }
  function saveState(): BranchState {
    return {
      variables: new Map(variables),
      arrays: new Map(arrays),
      exported: new Set(exported),
      failedVariables: new Set(failedVariables),
      maybeVariables: new Set(maybeVariables),
      invalidatedVariables: new Set(invalidatedVariables),
      consumed,
      errexit,
      pipefail,
      output,
      lastOutputSpan,
      blocked,
      dead,
      functions: new Map(functions),
      githubEnv: new Map(githubEnv),
      githubOutput: new Map(githubOutput),
      checkedOutBranch,
    };
  }
  function restoreState(state: BranchState): void {
    variables = new Map(state.variables);
    arrays = new Map(state.arrays);
    exported = new Set(state.exported);
    failedVariables = new Set(state.failedVariables);
    maybeVariables = new Set(state.maybeVariables);
    invalidatedVariables = new Set(state.invalidatedVariables);
    consumed = state.consumed;
    errexit = state.errexit;
    pipefail = state.pipefail;
    output = state.output;
    lastOutputSpan = state.lastOutputSpan;
    blocked = state.blocked;
    dead = state.dead;
    functions = new Map(state.functions);
    githubEnv = new Map(state.githubEnv);
    githubOutput = new Map(state.githubOutput);
    checkedOutBranch = state.checkedOutBranch;
  }
  function joinValue(a: Value, b: Value): Value {
    const flattened = (type: Template): readonly Template[] =>
      type.kind === "union" ? type.options.flatMap(flattened) : [type];
    const types = new Map<string, Template>();
    for (const type of [...flattened(a.type), ...flattened(b.type)])
      types.set(JSON.stringify(type), type);
    const aBytes = finiteBytes(a);
    const bBytes = finiteBytes(b);
    const alternatives =
      aBytes && bBytes ? [...new Set([...aBytes, ...bBytes])] : undefined;
    return {
      type: union([...types.values()]),
      min: Math.min(a.min, b.min),
      max: Math.max(a.max, b.max),
      encoded: a.encoded && b.encoded,
      singleLine: a.singleLine === true && b.singleLine === true,
      ...(a.delimited !== undefined && b.delimited !== undefined
        ? { delimited: a.delimited && b.delimited }
        : {}),
      ...(alternatives && alternatives.length <= MAX_FINITE_TEXTS
        ? alternatives.length === 1
          ? { text: alternatives[0] as string }
          : { texts: alternatives }
        : {}),
    };
  }
  function joinState(a: BranchState, b: BranchState, span: Span): BranchState {
    if (a.dead) return b;
    if (b.dead) return a;
    const joinedFunctions = new Map<string, "fatal" | "unsupported">();
    for (const name of new Set([
      ...a.functions.keys(),
      ...b.functions.keys(),
    ])) {
      const left = a.functions.get(name);
      const right = b.functions.get(name);
      joinedFunctions.set(name, left && left === right ? left : "unsupported");
    }
    const joined = new Map<string, Value>();
    const joinedArrays = new Map<string, ShellArray>();
    for (const name of new Set([...a.arrays.keys(), ...b.arrays.keys()])) {
      const left = a.arrays.get(name);
      const right = b.arrays.get(name);
      if (left && right)
        joinedArrays.set(name, {
          element: joinValue(left.element, right.element),
          min: Math.min(left.min, right.min),
          max: Math.max(left.max, right.max),
          ...(left.elements &&
          right.elements &&
          JSON.stringify(left.elements) === JSON.stringify(right.elements)
            ? { elements: left.elements }
            : {}),
        });
      else block(`Bash array ${name} is not defined on every branch`, span);
    }
    const failed = new Set([...a.failedVariables, ...b.failedVariables]);
    const maybe = new Set([...a.maybeVariables, ...b.maybeVariables]);
    const invalidated = new Set([
      ...a.invalidatedVariables,
      ...b.invalidatedVariables,
    ]);
    for (const name of new Set([
      ...a.variables.keys(),
      ...b.variables.keys(),
    ])) {
      const left = a.variables.get(name);
      const right = b.variables.get(name);
      if (left && right)
        joined.set(name, left === right ? left : joinValue(left, right));
      else maybe.add(name);
    }
    const mergedOutput =
      a.output && b.output
        ? joinValue(a.output, b.output)
        : a.output
          ? { ...a.output, min: 0 }
          : b.output
            ? { ...b.output, min: 0 }
            : undefined;
    const joinedEffects = (
      left: ReadonlyMap<string, Value>,
      right: ReadonlyMap<string, Value>,
    ): Map<string, Value> => {
      const result = new Map<string, Value>();
      for (const [name, value] of left) {
        const other = right.get(name);
        if (other) result.set(name, joinValue(value, other));
      }
      return result;
    };
    return {
      variables: joined,
      arrays: joinedArrays,
      exported: new Set([...a.exported].filter((key) => b.exported.has(key))),
      failedVariables: failed,
      maybeVariables: maybe,
      invalidatedVariables: invalidated,
      consumed: a.consumed === b.consumed ? a.consumed : "maybe",
      errexit: a.errexit && b.errexit,
      pipefail: a.pipefail && b.pipefail,
      output: mergedOutput,
      lastOutputSpan: a.lastOutputSpan ?? b.lastOutputSpan,
      blocked: blocked || a.blocked || b.blocked,
      dead: false,
      functions: joinedFunctions,
      githubEnv: joinedEffects(a.githubEnv, b.githubEnv),
      githubOutput: joinedEffects(a.githubOutput, b.githubOutput),
      checkedOutBranch:
        a.checkedOutBranch &&
        b.checkedOutBranch &&
        sameCommandArgument(a.checkedOutBranch, b.checkedOutBranch)
          ? a.checkedOutBranch
          : undefined,
    };
  }
  function stateSignature(state: BranchState): string {
    const entries = <T>(map: ReadonlyMap<string, T>): readonly [string, T][] =>
      [...map.entries()].sort(([a], [b]) => a.localeCompare(b));
    return JSON.stringify({
      variables: entries(state.variables),
      arrays: entries(state.arrays),
      exported: [...state.exported].sort(),
      failedVariables: [...state.failedVariables].sort(),
      maybeVariables: [...state.maybeVariables].sort(),
      invalidatedVariables: [...state.invalidatedVariables].sort(),
      consumed: state.consumed,
      errexit: state.errexit,
      pipefail: state.pipefail,
      output: state.output,
      blocked: state.blocked,
      dead: state.dead,
      functions: entries(state.functions),
      githubEnv: entries(state.githubEnv),
      githubOutput: entries(state.githubOutput),
      checkedOutBranch: state.checkedOutBranch,
    });
  }
  function testStatus(node: BashSyntaxNode): boolean | undefined {
    if (node.type === "unary_expression") {
      const [operator, operand] = node.namedChildren;
      if (!operator || !operand) {
        block("Bash unary test is incomplete", spanOf(node));
        return undefined;
      }
      if (operator.text === "-d" || operator.text === "-f") {
        const value = bashValue(operand);
        const paths = value && finiteBytes(value);
        const resolvePath =
          operator.text === "-d"
            ? options.resolveDirectory
            : options.readLocalFile;
        if (!paths || !resolvePath) {
          block(
            `Bash ${operator.text === "-d" ? "directory" : "file"} test has no finite verified paths`,
            spanOf(node),
          );
          return undefined;
        }
        let found = 0;
        for (const path of paths) {
          const result = resolvePath(path);
          if (result.kind !== "unavailable") found++;
          else {
            blocked = true;
            report(
              "PIPE204",
              `Local ${operator.text === "-d" ? "directory" : "file"} dependency is unavailable: ${path}: ${result.reason}`,
              spanOf(node),
              "blocked",
            );
          }
        }
        return found === paths.length ? true : found === 0 ? false : undefined;
      }
      if (!["-z", "-n"].includes(operator.text)) {
        block("Bash unary test is not yet analyzed", spanOf(node));
        return undefined;
      }
      const value = bashValue(operand);
      if (!value || value.text === undefined) return undefined;
      return operator.text === "-z"
        ? value.text.length === 0
        : value.text.length > 0;
    }
    if (node.type === "binary_expression") {
      const [left, right] = node.namedChildren;
      if (!left || !right) {
        block("Bash binary test is incomplete", spanOf(node));
        return undefined;
      }
      const operator = node.text
        .slice(
          left.endIndex - node.startIndex,
          right.startIndex - node.startIndex,
        )
        .trim();
      if (operator === "&&" || operator === "||") {
        const a = testStatus(left);
        if (
          (operator === "&&" && a === false) ||
          (operator === "||" && a === true)
        )
          return a;
        const b = testStatus(right);
        if (a === undefined || b === undefined)
          return operator === "&&" && b === false
            ? false
            : operator === "||" && b === true
              ? true
              : undefined;
        return operator === "&&" ? a && b : a || b;
      }
      if (!["==", "=", "!=", "=~"].includes(operator)) {
        block(
          `Bash test operator ${operator} is not yet analyzed`,
          spanOf(node),
        );
        return undefined;
      }
      const a = bashValue(left);
      if (!a) return undefined;
      if (operator === "=~") {
        if (
          !["regex", "word", "extglob_pattern"].includes(right.type) ||
          right.namedChildren.length > 0
        )
          block("Dynamic Bash regex is not yet analyzed", spanOf(right));
        else if (a.text !== undefined)
          block("Finite Bash regex result is not yet analyzed", spanOf(node));
        return undefined;
      }
      const staticPattern =
        ["word", "extglob_pattern"].includes(right.type) &&
        right.namedChildren.length === 0;
      const b = staticPattern ? literalBytes(right.text) : bashValue(right);
      if (!b) return undefined;
      if (staticPattern && /[*?[]/u.test(right.text)) return undefined;
      if (a.text === undefined || b.text === undefined) return undefined;
      return operator === "!=" ? a.text !== b.text : a.text === b.text;
    }
    block(`Bash ${node.type} test is not yet analyzed`, spanOf(node));
    return undefined;
  }
  function conditionStatus(
    node: BashSyntaxNode,
    stdoutDiscarded = false,
  ): boolean | undefined {
    if (node.type === "redirected_statement") {
      const [inner, redirect] = node.namedChildren;
      if (
        node.namedChildren.length === 2 &&
        inner &&
        redirect?.type === "file_redirect" &&
        /^(?:1)?>(?:[ \t]*)\/dev\/null$/u.test(redirect.text)
      )
        return conditionStatus(inner, true);
      block("Bash condition redirection is not yet analyzed", spanOf(node));
      return undefined;
    }
    if (node.type === "negated_command") {
      const inner = node.namedChildren[0];
      const status = inner
        ? conditionStatus(inner, stdoutDiscarded)
        : undefined;
      return status === undefined ? undefined : !status;
    }
    if (node.type === "command") {
      const name = node.childForFieldName("name")?.text;
      if ((name === "jq" || name === "yq") && stdoutDiscarded) {
        const result = evalCommand(node, undefined, false, false, true);
        if (!result) return undefined;
        if (result.alwaysFails) return false;
        if (name === "yq")
          return result.type.kind === "literal" && result.type.value === true
            ? true
            : undefined;
        const exitCheck = node.namedChildren.some(
          (part) =>
            part.type === "word" &&
            /^-[cnre]+$/u.test(part.text) &&
            part.text.includes("e"),
        );
        if (exitCheck && (result.max === 0 || !truthyPart(result.type)))
          return false;
        // A filter may raise an error on a subset of inputs. Unless its
        // status is provably nonzero, keep both Bash branches reachable.
        return undefined;
      }
      if (node.namedChildren.length === 1 && name === "true") return true;
      if (node.namedChildren.length === 1 && name === "false") return false;
      const arithmetic =
        /^\(\(\s*([A-Za-z_][A-Za-z_0-9]*)\s*(==|!=)\s*(0|[1-9][0-9]*)\s*\)\)$/u.exec(
          node.text,
        );
      if (arithmetic) {
        const expected = Number(arithmetic[3]);
        if (!Number.isSafeInteger(expected)) {
          block(
            "Bash arithmetic literal exceeds safe integer precision",
            spanOf(node),
          );
          return undefined;
        }
        const variable = arithmetic[1] ?? "";
        const value =
          maybeVariables.has(variable) || invalidatedVariables.has(variable)
            ? undefined
            : variables.get(variable);
        const numbers = value && finiteBytes(value);
        if (!numbers) {
          block(
            "Bash arithmetic condition has an unverified input",
            spanOf(node),
          );
          return undefined;
        }
        const outcomes = new Set<boolean>();
        for (const bytes of numbers) {
          if (
            !/^(?:0|[1-9][0-9]*)$/u.test(bytes) ||
            !Number.isSafeInteger(Number(bytes))
          ) {
            block(
              "Bash arithmetic condition is not a bounded integer",
              spanOf(node),
            );
            return undefined;
          }
          const equal = Number(bytes) === expected;
          outcomes.add(arithmetic[2] === "==" ? equal : !equal);
        }
        return outcomes.size === 1 ? outcomes.has(true) : undefined;
      }
    }
    if (node.type === "test_command") {
      const expression = node.namedChildren[0];
      if (!expression || /\$\(|`|<\(|>\(/u.test(node.text)) {
        block("Bash test expansion effect is not yet analyzed", spanOf(node));
        return undefined;
      }
      return testStatus(expression);
    }
    block("Bash condition is not yet analyzed", spanOf(node));
    return undefined;
  }
  function presenceGuard(
    node: BashSyntaxNode,
    negated = false,
  ):
    | {
        readonly test: NonNullable<Value["presenceTest"]>;
        readonly presentOnTrue: boolean;
      }
    | undefined {
    if (node.type === "negated_command" && node.namedChildren[0])
      return presenceGuard(node.namedChildren[0], !negated);
    if (node.type !== "test_command") return undefined;
    const expression = node.namedChildren[0];
    if (expression?.type !== "binary_expression") return undefined;
    const [left, right] = expression.namedChildren;
    if (!left || !right || !["true", "false"].includes(right.text))
      return undefined;
    const flagName = /^"\$([A-Za-z_][A-Za-z_0-9]*)"$/u.exec(left.text)?.[1];
    const test = flagName && variables.get(flagName)?.presenceTest;
    if (!test || variables.get(test.sourceName) !== test.sourceValue)
      return undefined;
    const operator = expression.text
      .slice(
        left.endIndex - expression.startIndex,
        right.startIndex - expression.startIndex,
      )
      .trim();
    if (!["==", "=", "!="].includes(operator)) return undefined;
    const presentOnTrue =
      ((right.text === "true") === (operator !== "!=")) !== negated;
    return { test, presentOnTrue };
  }
  function applyPresenceGuard(
    guard: NonNullable<ReturnType<typeof presenceGuard>>,
    conditionTrue: boolean,
  ): boolean {
    const current = variables.get(guard.test.sourceName);
    if (!current || current !== guard.test.sourceValue) return true;
    const narrowed = narrowObjectPresence(
      current.type,
      guard.test.key,
      conditionTrue ? guard.presentOnTrue : !guard.presentOnTrue,
    );
    if (!narrowed) return false;
    variables.set(guard.test.sourceName, { ...current, type: narrowed });
    return true;
  }
  function visitConditional(
    children: readonly BashSyntaxNode[],
    span: Span,
  ): void {
    const condition = children[0];
    if (!condition) {
      block("Empty Bash conditional", span);
      return;
    }
    const marker = children.findIndex(
      (part) => part.type === "elif_clause" || part.type === "else_clause",
    );
    const body = children.slice(1, marker < 0 ? undefined : marker);
    const status = conditionStatus(condition);
    const guard = presenceGuard(condition);
    const base = saveState();
    let whenTrue: BranchState | undefined;
    let whenFalse: BranchState | undefined;
    if (status !== false && (!guard || applyPresenceGuard(guard, true))) {
      for (const item of body) visit(item);
      whenTrue = saveState();
    }
    if (status !== true) {
      restoreState(base);
      const alternative = marker < 0 ? undefined : children[marker];
      if (!guard || applyPresenceGuard(guard, false)) {
        if (alternative?.type === "elif_clause")
          visitConditional(
            [...alternative.namedChildren, ...children.slice(marker + 1)],
            spanOf(alternative),
          );
        else if (alternative?.type === "else_clause")
          for (const item of alternative.namedChildren) visit(item);
        whenFalse = saveState();
      }
    }
    if (whenTrue && whenFalse)
      restoreState(joinState(whenTrue, whenFalse, span));
    else if (whenTrue || whenFalse)
      restoreState((whenTrue ?? whenFalse) as BranchState);
    else block("Bash condition has no reachable branch", span);
  }
  function visitCase(node: BashSyntaxNode): void {
    const [scrutinee, ...items] = node.namedChildren;
    if (!scrutinee || items.length > 32) {
      block(
        "Bash case is missing a subject or exceeds its branch budget",
        spanOf(node),
      );
      return;
    }
    const subject = bashValue(scrutinee);
    if (!subject) return;
    const subjectName =
      /^"\$(?:([A-Za-z_][A-Za-z_0-9]*)|\{([A-Za-z_][A-Za-z_0-9]*)\})"$/u
        .exec(scrutinee.text)
        ?.slice(1)
        .find(Boolean);
    const subjectBytes = finiteBytes(subject);
    const base = saveState();
    const reachable: BranchState[] = [];
    let hasDefault = false;
    const seen = new Set<string>();
    for (const item of items) {
      if (item.type !== "case_item") {
        block("Bash case clause is not yet analyzed", spanOf(item));
        return;
      }
      if (/;(?:;&|&)$|;&$/u.test(item.text.trimEnd())) {
        block("Bash case fallthrough is not yet analyzed", spanOf(item));
        return;
      }
      const close = item.text.indexOf(")");
      const pattern = close < 0 ? "" : item.text.slice(0, close).trim();
      if (!/^(?:\*|[A-Za-z0-9_.-]+(?:\|[A-Za-z0-9_.-]+)*)$/u.test(pattern)) {
        block("Bash case pattern is not yet analyzed", spanOf(item));
        return;
      }
      const alternatives = pattern.split("|");
      const wildcard = pattern === "*";
      const possible = wildcard
        ? subjectBytes?.filter((value) => !seen.has(value))
        : alternatives.filter(
            (value) =>
              !seen.has(value) &&
              (!subjectBytes || subjectBytes.includes(value)),
          );
      const matches = possible === undefined || possible.length > 0;
      if (matches) {
        restoreState(base);
        if (subjectName && possible?.length) {
          const original = variables.get(subjectName);
          if (original)
            variables.set(subjectName, withFiniteBytes(original, possible));
        }
        const bodyStart = item.startIndex + close + 1;
        for (const part of item.namedChildren) {
          if (part.startIndex >= bodyStart) visit(part);
        }
        reachable.push(saveState());
      }
      if (wildcard) {
        hasDefault = true;
        break;
      }
      for (const name of alternatives) seen.add(name);
      if (subjectBytes?.length === 1 && matches) {
        hasDefault = true;
        break;
      }
    }
    if (
      !hasDefault &&
      (!subjectBytes || subjectBytes.some((value) => !seen.has(value)))
    )
      reachable.push(base);
    if (reachable.length === 0) reachable.push(base);
    let merged = reachable[0] as BranchState;
    for (const branch of reachable.slice(1))
      merged = joinState(merged, branch, spanOf(node));
    restoreState(merged);
  }
  function isNonzeroExit(node: BashSyntaxNode | undefined): boolean {
    if (node?.type !== "command") return false;
    const match = /^exit\s+([1-9][0-9]*)$/u.exec(node.text.trim());
    return Boolean(match && Number(match[1]) <= 255);
  }

  function isFatalExitGroup(node: BashSyntaxNode): boolean {
    if (
      node.type !== "compound_statement" ||
      functions.has("printf") ||
      functions.has("exit")
    )
      return false;
    const statements = node.namedChildren.filter(
      (part) => part.type !== "comment",
    );
    if (!isNonzeroExit(statements.at(-1))) return false;
    return statements.slice(0, -1).every((part) => {
      if (part.type !== "redirected_statement") return false;
      const [command, redirect] = part.namedChildren;
      return (
        part.namedChildren.length === 2 &&
        command?.type === "command" &&
        command.childForFieldName("name")?.text === "printf" &&
        command.namedChildren.length === 2 &&
        command.namedChildren[1]?.type === "raw_string" &&
        redirect?.type === "file_redirect" &&
        /^(?:1)?>(?:&2|\/dev\/null)$/u.test(redirect.text)
      );
    });
  }

  function hasRegexTest(node: BashSyntaxNode): boolean {
    const pending = [node];
    let visited = 0;
    while (pending.length && visited++ < 128) {
      const current = pending.pop() as BashSyntaxNode;
      if (current.type === "regex") return true;
      pending.push(...current.namedChildren);
    }
    return false;
  }

  function visitList(node: BashSyntaxNode): void {
    const [left, right] = node.namedChildren;
    if (!left || !right || node.namedChildren.length !== 2) {
      block("Bash list structure is not yet analyzed", spanOf(node));
      return;
    }
    const operator = node.text
      .slice(
        left.endIndex - node.startIndex,
        right.startIndex - node.startIndex,
      )
      .replace(/\\\r?\n[ \t]*/gu, "")
      .trim();
    if (operator !== "&&" && operator !== "||") {
      block("Bash list operator is not yet analyzed", spanOf(node));
      return;
    }
    if (
      operator === "||" &&
      provenGitStatusLists.has(node.startIndex) &&
      left.type === "command" &&
      right.type === "variable_assignment" &&
      right.namedChildren[0]?.text === "status" &&
      right.namedChildren[1]?.text === "$?" &&
      gitDiffArguments(left)
    ) {
      const old = variables.get("status");
      if (
        !errexit ||
        !old ||
        maybeVariables.has("status") ||
        invalidatedVariables.has("status") ||
        JSON.stringify(finiteBytes(old)) !== JSON.stringify(["0"])
      ) {
        block("git diff status initializer is not verified", spanOf(node));
        return;
      }
      externalMayRun.add("git diff --quiet");
      variables.set(
        "status",
        joinValue(joinValue(old, literalBytes("1")), literalBytes("2")),
      );
      return;
    }
    const rightName =
      right.type === "command"
        ? right.childForFieldName("name")?.text
        : undefined;
    const fatalRight =
      (rightName && functions.get(rightName) === "fatal") ||
      isNonzeroExit(right) ||
      isFatalExitGroup(right);
    if (
      operator === "||" &&
      fatalRight &&
      (left.type === "test_command" || left.type === "negated_command") &&
      hasRegexTest(left)
    ) {
      const beforeCondition = diagnostics.length;
      const status = conditionStatus(left);
      if (diagnostics.length !== beforeCondition) return;
      if (status === false) dead = true;
      return;
    }
    if (
      operator === "||" &&
      fatalRight &&
      left.type === "variable_assignment"
    ) {
      const name = left.namedChildren.find(
        (part) => part.type === "variable_name",
      )?.text;
      const valueNode = left.namedChildren.find(
        (part) => part.type !== "variable_name",
      );
      const substitution =
        valueNode?.type === "string" &&
        valueNode.namedChildren.length === 1 &&
        valueNode.namedChildren[0]?.type === "command_substitution" &&
        valueNode.text === `"${valueNode.namedChildren[0].text}"`
          ? valueNode.namedChildren[0]
          : undefined;
      if (name && substitution) {
        const captured = evalSubstitution(substitution, true);
        if (!captured) {
          variables.delete(name);
          failedVariables.add(name);
          return;
        }
        if (captured.alwaysFails || captured.max === 0) {
          dead = true;
          return;
        }
        if (captured.max !== 1) {
          block("Guarded substitution may emit multiple values", spanOf(left));
          return;
        }
        variables.set(name, { ...captured, min: 1, max: 1 });
        failedVariables.delete(name);
        maybeVariables.delete(name);
        invalidatedVariables.delete(name);
        return;
      }
    }
    let status: boolean | undefined;
    if (
      left.type === "test_command" ||
      left.type === "negated_command" ||
      (left.type === "redirected_statement" &&
        left.namedChildren[0]?.type === "command" &&
        left.namedChildren[0].childForFieldName("name")?.text === "yq") ||
      (left.type === "command" &&
        ["true", "false"].includes(left.childForFieldName("name")?.text ?? ""))
    )
      status = conditionStatus(left);
    else {
      visit(left);
      if (dead) return;
      block(
        "Bash command exit status in &&/|| is not yet analyzed",
        spanOf(left),
      );
    }
    if (status !== undefined) {
      if ((status && operator === "&&") || (!status && operator === "||"))
        visit(right);
      return;
    }
    const skip = saveState();
    visit(right);
    restoreState(joinState(skip, saveState(), spanOf(node)));
  }
  function visitFor(node: BashSyntaxNode): void {
    const children = node.namedChildren;
    const variable = children[0];
    const group = children.at(-1);
    if (
      variable?.type !== "variable_name" ||
      group?.type !== "do_group" ||
      children.length < 3 ||
      arrays.has(variable.text)
    ) {
      block("Bash for header or target is not yet analyzed", spanOf(node));
      return;
    }
    const sources = children.slice(1, -1);
    let elements: readonly Value[] | undefined;
    let abstractArray: ShellArray | undefined;
    if (sources.length === 1) {
      const arrayName = /^"\$\{([A-Za-z_][A-Za-z_0-9]*)\[@\]\}"$/u.exec(
        sources[0]?.text ?? "",
      )?.[1];
      if (arrayName) {
        abstractArray = arrays.get(arrayName);
        elements = abstractArray?.elements;
      }
    }
    if (!elements && sources.every((part) => part.type === "word")) {
      const values = sources.map(bashValue);
      if (values.every((value) => value?.text !== undefined))
        elements = values as Value[];
    }
    if (!elements && abstractArray) {
      const base = saveState();
      let invariant = base;
      for (let iteration = 0; iteration < 8; iteration++) {
        restoreState(invariant);
        variables.set(variable.text, abstractArray.element);
        failedVariables.delete(variable.text);
        maybeVariables.delete(variable.text);
        invalidatedVariables.delete(variable.text);
        for (const part of group.namedChildren) visit(part);
        const next = joinState(base, saveState(), spanOf(node));
        if (stateSignature(next) === stateSignature(invariant)) {
          restoreState(next);
          return;
        }
        invariant = next;
      }
      restoreState(invariant);
      block("Bash for loop fixed point exceeded its budget", spanOf(node));
      return;
    }
    if (!elements || elements.length > 16) {
      block(
        "Unbounded or dynamic Bash for loop needs a fixed point",
        spanOf(node),
      );
      return;
    }
    for (const element of elements) {
      variables.set(variable.text, element);
      failedVariables.delete(variable.text);
      maybeVariables.delete(variable.text);
      invalidatedVariables.delete(variable.text);
      for (const part of group.namedChildren) visit(part);
      if (dead) break;
    }
  }

  function invalidateWrites(root: BashSyntaxNode): void {
    const pending = [root];
    let inspected = 0;
    const invalidate = (name: string): void => {
      variables.delete(name);
      arrays.delete(name);
      maybeVariables.delete(name);
      invalidatedVariables.add(name);
    };
    while (pending.length) {
      const node = pending.pop();
      if (!node) continue;
      if (++inspected > 100_000) {
        block("Bash write inspection budget exceeded", spanOf(root));
        return;
      }
      if (node.type === "variable_assignment") {
        const name = node.namedChildren.find(
          (child) => child.type === "variable_name",
        )?.text;
        if (name) invalidate(name);
      }
      if (
        node.type === "command" &&
        node.childForFieldName("name")?.text === "read"
      ) {
        const nameNode = node.childForFieldName("name");
        for (const argument of node.namedChildren) {
          if (
            nameNode &&
            argument.startIndex > nameNode.endIndex &&
            argument.type === "word" &&
            /^[A-Za-z_][A-Za-z_0-9]*$/u.test(argument.text)
          )
            invalidate(argument.text);
        }
      }
      if (node.type === "function_definition") {
        const name = node.namedChildren[0]?.text;
        if (name) functions.set(name, "unsupported");
      }
      for (const child of node.namedChildren) pending.push(child);
    }
  }

  function visitTsvReadLoop(loop: BashSyntaxNode, source: string): boolean {
    const [condition, group] = loop.namedChildren;
    if (
      loop.namedChildren.length !== 2 ||
      condition?.type !== "command" ||
      group?.type !== "do_group" ||
      condition.childForFieldName("name")?.text !== "read" ||
      condition.namedChildren[0]?.text !== "IFS=$'\\t'"
    ) {
      block("TSV while/read header is not yet analyzed", spanOf(loop));
      return false;
    }
    const argumentsAfterName = condition.namedChildren.slice(2);
    const targets = argumentsAfterName.slice(1).map((part) => part.text);
    if (
      argumentsAfterName[0]?.text !== "-r" ||
      targets.length === 0 ||
      targets.length > 16 ||
      targets.some((name) => !/^[A-Za-z_][A-Za-z_0-9]*$/u.test(name))
    ) {
      block(
        "TSV read options or target count are not yet analyzed",
        spanOf(condition),
      );
      return false;
    }
    const first = targets[0] as string;
    const guard = group.namedChildren[0];
    const guardText = `[[ -n "$${first}" && "$${first}" != \\#* ]] || continue`;
    const hasGuard = guard?.text.replace(/\s+/gu, " ").trim() === guardText;
    const body = group.namedChildren.slice(hasGuard ? 1 : 0);
    if (
      source.includes("\0") ||
      source.includes("\r") ||
      (source && !source.endsWith("\n"))
    ) {
      block(
        "TSV source contains unsupported bytes or an unterminated row",
        spanOf(loop),
      );
      return false;
    }
    const lines = source ? source.slice(0, -1).split("\n") : [];
    if (lines.length > 256) {
      block("TSV row budget exceeded", spanOf(loop));
      return false;
    }
    const rows: string[][] = [];
    for (const line of lines) {
      if (hasGuard && (line === "" || line.startsWith("#"))) continue;
      const fields = line.split("\t");
      if (
        fields.length !== targets.length ||
        fields.some((field) => field.length === 0)
      ) {
        block("TSV row shape is not analyzed for this read", spanOf(loop));
        return false;
      }
      rows.push(fields);
    }
    for (const fields of rows) {
      for (const [index, name] of targets.entries()) {
        variables.set(name, literalBytes(fields[index] as string));
        failedVariables.delete(name);
        maybeVariables.delete(name);
        invalidatedVariables.delete(name);
      }
      for (const part of body) visit(part);
      if (dead) break;
    }
    for (const name of targets) {
      variables.delete(name);
      invalidatedVariables.add(name);
    }
    return !diagnostics.some(
      (item) =>
        item.span.start >= group.startIndex && item.span.end <= group.endIndex,
    );
  }

  function validatedPlatformCase(
    group: BashSyntaxNode,
    itemName: string,
    sourceName: string,
  ): readonly string[] | undefined {
    const children = group.namedChildren;
    const caseIndex = children.findIndex(
      (part) => part.type === "case_statement",
    );
    if (caseIndex < 0) return undefined;
    const caseNode = children[caseIndex];
    const [subject, accepted, rejected] = caseNode?.namedChildren ?? [];
    if (
      subject?.text !== '"$platform"' ||
      accepted?.type !== "case_item" ||
      rejected?.type !== "case_item" ||
      caseNode?.namedChildren.length !== 3 ||
      children
        .slice(0, caseIndex)
        .some(
          (part) =>
            part.type !== "variable_assignment" && part.type !== "comment",
        ) ||
      children
        .slice(0, caseIndex)
        .some(
          (part) =>
            part.type === "variable_assignment" &&
            part.namedChildren[0]?.text === sourceName,
        )
    )
      return undefined;
    const assignment = children
      .slice(0, caseIndex)
      .find(
        (part) =>
          part.type === "variable_assignment" &&
          part.namedChildren[0]?.text === "platform",
      );
    const substitution = assignment?.namedChildren[1]?.namedChildren[0];
    const reader = substitution?.namedChildren[0];
    const readSource = reader?.namedChildren.find(
      (part) => part.type === "herestring_redirect",
    )?.namedChildren[0];
    if (
      substitution?.type !== "command_substitution" ||
      reader?.type !== "command" ||
      reader.childForFieldName("name")?.text !== "jq" ||
      !reader.namedChildren.some(
        (part) => part.type === "raw_string" && part.text === "'.platform'",
      ) ||
      !reader.namedChildren.some(
        (part) =>
          part.type === "word" &&
          /^-[cner]+$/u.test(part.text) &&
          part.text.includes("r"),
      ) ||
      readSource?.text !== `"$${itemName}"`
    )
      return undefined;
    const close = accepted.text.indexOf(")");
    const pattern = close < 0 ? "" : accepted.text.slice(0, close).trim();
    const choices = pattern.split("|");
    const failureCommand = rejected.namedChildren.find(
      (part) => part.type === "command",
    );
    if (
      choices.length === 0 ||
      choices.length > 16 ||
      choices.some((choice) => !/^[A-Za-z0-9_.-]+$/u.test(choice)) ||
      accepted.namedChildren.some((part) => part.type === "command") ||
      !/^\*\s*\)/u.test(rejected.text) ||
      !failureCommand ||
      functions.get(failureCommand.childForFieldName("name")?.text ?? "") !==
        "fatal" ||
      rejected.namedChildren.filter((part) => part.type === "command")
        .length !== 1
    )
      return undefined;
    const pending = [...group.namedChildren];
    while (pending.length) {
      const node = pending.pop();
      if (!node) continue;
      if (
        node.type === "variable_assignment" &&
        node.namedChildren[0]?.text === sourceName
      )
        return undefined;
      for (const child of node.namedChildren) pending.push(child);
    }
    return choices;
  }

  function refineArrayPlatforms(
    type: Template,
    arrayField: string,
    allowed: readonly string[],
  ): Template | undefined {
    const results: Template[] = [];
    for (const member of members(type)) {
      if (member.kind !== "object") return undefined;
      const array = member.fields[arrayField];
      if (array?.kind !== "array") return undefined;
      if (array.element === null) {
        results.push(member);
        continue;
      }
      const elements: Template[] = [];
      for (const element of members(array.element)) {
        if (element.kind !== "object") return undefined;
        const original = element.fields.platform;
        if (!original) return undefined;
        const platforms = allowed
          .map((value) => ({ kind: "literal" as const, value }))
          .filter((value) => isAssignable(value, original));
        if (platforms.length)
          elements.push({
            kind: "object",
            fields: { ...element.fields, platform: union(platforms) },
          });
      }
      if (elements.length === 0) return undefined;
      results.push({
        kind: "object",
        fields: {
          ...member.fields,
          [arrayField]: { kind: "array", element: union(elements) },
        },
      });
    }
    return results.length ? union(results) : undefined;
  }

  function verifiedNamespaceAccumulator(group: BashSyntaxNode): boolean {
    const children = group.namedChildren;
    const assignments = children.filter(
      (part) =>
        part.type === "variable_assignment" &&
        part.namedChildren[0]?.text === "platform_namespaces",
    );
    const assignment = assignments[0];
    const caseIndex = children.findIndex(
      (part) => part.type === "case_statement",
    );
    if (
      assignments.length !== 1 ||
      !assignment ||
      caseIndex < 0 ||
      children.indexOf(assignment) <= caseIndex
    )
      return false;
    const substitution = assignment.namedChildren[1]?.namedChildren[0];
    const command = substitution?.namedChildren[0];
    const normalized = command?.text
      .replace(/\\\r?\n[ \t]*/gu, "")
      .replace(/\s+/gu, " ")
      .trim();
    if (
      substitution?.type !== "command_substitution" ||
      command?.type !== "command" ||
      normalized !==
        `jq -c --arg platform "$platform" --arg namespace "$deployment_namespace" '.[$platform] = $namespace' <<< "$platform_namespaces"`
    )
      return false;
    const pending = [...group.namedChildren];
    while (pending.length) {
      const part = pending.pop();
      if (!part) continue;
      if (
        part.type === "command" &&
        ["continue", "break", "return"].includes(
          part.childForFieldName("name")?.text ?? "",
        )
      )
        return false;
      for (const child of part.namedChildren) pending.push(child);
    }
    return true;
  }

  function visitProcessReadLoop(
    loop: BashSyntaxNode,
    redirect: BashSyntaxNode,
  ): boolean {
    const [condition, group] = loop.namedChildren;
    const process = redirect.namedChildren[0];
    const producer = process?.namedChildren[0];
    const target = condition?.namedChildren[3]?.text;
    const filter = producer?.namedChildren.find(
      (part) => part.type === "raw_string",
    );
    if (
      loop.namedChildren.length !== 2 ||
      condition?.type !== "command" ||
      group?.type !== "do_group" ||
      condition.namedChildren.length !== 4 ||
      condition.namedChildren[0]?.text !== "IFS=" ||
      condition.childForFieldName("name")?.text !== "read" ||
      condition.namedChildren[2]?.text !== "-r" ||
      !target ||
      !/^[A-Za-z_][A-Za-z_0-9]*$/u.test(target) ||
      !/^<\s*<\(/u.test(redirect.text) ||
      process?.type !== "process_substitution" ||
      process.namedChildren.length !== 1 ||
      producer?.type !== "command" ||
      producer.childForFieldName("name")?.text !== "jq" ||
      producer.namedChildren.filter(
        (part) => part.type === "herestring_redirect",
      ).length !== 1 ||
      !filter ||
      !/^'\.[A-Za-z_][A-Za-z_0-9]*\[\]'$/u.test(filter.text) ||
      !producer.namedChildren.some(
        (part) =>
          part.type === "word" &&
          /^-[cne]+$/u.test(part.text) &&
          part.text.includes("c"),
      ) ||
      producer.namedChildren.some(
        (part) =>
          part.type === "word" &&
          /^-[cnre]+$/u.test(part.text) &&
          part.text.includes("r"),
      )
    ) {
      block("Bash while/read process source is not yet analyzed", spanOf(loop));
      return false;
    }
    const stream = evalCommand(producer);
    if (!stream) return false;
    if (!stream.encoded || !stream.delimited) {
      block("Bash read source is not compact JSON lines", spanOf(redirect));
      return false;
    }
    const base = saveState();
    let invariant = base;
    for (let iteration = 0; iteration < 8; iteration++) {
      restoreState(invariant);
      variables.set(target, one(stream.type));
      arrays.delete(target);
      failedVariables.delete(target);
      maybeVariables.delete(target);
      invalidatedVariables.delete(target);
      const before = diagnostics.length;
      for (const part of group.namedChildren) visit(part);
      if (diagnostics.length !== before) {
        invalidateWrites(loop);
        return false;
      }
      const next = joinState(base, saveState(), spanOf(loop));
      if (stateSignature(next) === stateSignature(invariant)) {
        restoreState(next);
        const readSource = producer.namedChildren.find(
          (part) => part.type === "herestring_redirect",
        )?.namedChildren[0];
        const sourceName =
          readSource &&
          /^"\$([A-Za-z_][A-Za-z_0-9]*)"$/u.exec(readSource.text)?.[1];
        const arrayField =
          filter &&
          /^'\.([A-Za-z_][A-Za-z_0-9]*)\[\]'$/u.exec(filter.text)?.[1];
        if (sourceName && arrayField) {
          const allowed = validatedPlatformCase(group, target, sourceName);
          const current = variables.get(sourceName);
          if (allowed && current && !finiteBytes(current)) {
            const refined = refineArrayPlatforms(
              current.type,
              arrayField,
              allowed,
            );
            if (!refined) {
              block(
                "Bash platform validation has no proven successful values",
                spanOf(loop),
              );
              return false;
            }
            const refinedSource: Value = { ...current, type: refined };
            variables.set(sourceName, refinedSource);
            const namespaceMap = variables.get("platform_namespaces");
            const mapMembers = namespaceMap ? members(namespaceMap.type) : [];
            const mapValues = mapMembers.flatMap((member) =>
              member.kind === "object" ? Object.values(member.fields) : [],
            );
            if (
              arrayField === "images" &&
              namespaceMap &&
              verifiedNamespaceAccumulator(group) &&
              mapMembers.every((member) => member.kind === "object") &&
              mapValues.length > 0 &&
              mapValues.every((value) => members(value).every(couldBeString)) &&
              !maybeVariables.has("platform_namespaces") &&
              !invalidatedVariables.has("platform_namespaces")
            )
              variables.set("platform_namespaces", {
                ...namespaceMap,
                coversArrayKeys: {
                  sourceValue: refinedSource,
                  arrayField,
                  keyField: "platform",
                  valueType: union(mapValues),
                },
              });
          }
        }
        variables.delete(target);
        invalidatedVariables.add(target);
        return true;
      }
      invariant = next;
    }
    restoreState(invariant);
    block(
      "Bash while/read process fixed point exceeded its budget",
      spanOf(loop),
    );
    invalidateWrites(loop);
    return false;
  }

  function recordGithubWrite(value: Value, span: Span): void {
    const exact = value.text?.match(
      /^([A-Za-z_][A-Za-z_0-9]*)=([^\r\n\0]*)\n$/u,
    );
    const name = value.githubAssignment?.name ?? exact?.[1];
    const payload =
      value.githubAssignment?.payload ??
      (exact ? literalBytes(exact[2] ?? "") : undefined);
    if (
      !name ||
      !payload ||
      payload.min !== 1 ||
      payload.max !== 1 ||
      payload.singleLine !== true
    ) {
      block("GitHub file write is not a proven single-line name=value", span);
      return;
    }
    (githubRedirectTarget === "env" ? githubEnv : githubOutput).set(
      name,
      payload,
    );
  }

  function visitGithubEnvFileFilter(command: BashSyntaxNode): void {
    const parts = command.namedChildren;
    const path = parts[3];
    if (
      parts.length !== 4 ||
      parts[1]?.text !== "-E" ||
      parts[2]?.text !== "'/^[[:space:]]*(#|$)/d'" ||
      path?.type !== "word" ||
      !/^[A-Za-z0-9_./-]+$/u.test(path.text) ||
      path.text.startsWith("-") ||
      !options.readLocalFile
    ) {
      block(
        "GitHub env file filter or source path is not verified",
        spanOf(command),
      );
      return;
    }
    const result = options.readLocalFile(path.text);
    if (result.kind === "unavailable") {
      blocked = true;
      report(
        "PIPE204",
        `Local file dependency is unavailable: ${path.text}: ${result.reason}`,
        spanOf(path),
        "blocked",
      );
      return;
    }
    const source = result.source;
    if (source.length > 1024 * 1024 || /[\r\0]/u.test(source)) {
      block(
        "GitHub env source exceeds budget or contains CR/NUL",
        spanOf(path),
      );
      return;
    }
    for (const line of source.split("\n")) {
      if (/^[ \t]*(?:#|$)/u.test(line)) continue;
      const assignment = /^([A-Za-z_][A-Za-z_0-9]*)=(.*)$/u.exec(line);
      if (!assignment) {
        block(
          "GitHub env source is not a single-line name=value file",
          spanOf(path),
        );
        return;
      }
      githubEnv.set(assignment[1] as string, literalBytes(assignment[2] ?? ""));
    }
  }

  function visit(node: BashSyntaxNode): void {
    if (dead) return;
    if (node.type === "comment") return;
    if (node.type === "function_definition") {
      const [name, body] = node.namedChildren;
      if (!name || !body || !/^[A-Za-z_][A-Za-z_0-9]*$/u.test(name.text)) {
        block("Bash function declaration is not yet analyzed", spanOf(node));
        return;
      }
      const statements = body.namedChildren.filter(
        (part) => part.type !== "comment",
      );
      const last = statements.at(-1);
      const endsWithFailure = isNonzeroExit(last);
      const stderrOnly = statements.slice(0, -1).every((part) => {
        if (part.type !== "redirected_statement") return false;
        const command = part.namedChildren.find(
          (child) => child.type === "command",
        );
        const redirect = part.namedChildren.find(
          (child) => child.type === "file_redirect",
        );
        return (
          command?.childForFieldName("name")?.text === "printf" &&
          /^(?:1)?>(?:&2|\/dev\/null)$/u.test(redirect?.text ?? "") &&
          !command.text.includes("$(") &&
          !command.text.includes("<(") &&
          !command.text.includes(">(") &&
          !command.text.includes("`")
        );
      });
      functions.set(
        name.text,
        endsWithFailure && stderrOnly ? "fatal" : "unsupported",
      );
      return;
    }
    if (node.type === "if_statement") {
      visitConditional(node.namedChildren, spanOf(node));
      return;
    }
    if (node.type === "case_statement") {
      visitCase(node);
      return;
    }
    if (node.type === "list") {
      visitList(node);
      return;
    }
    if (node.type === "for_statement") {
      visitFor(node);
      return;
    }
    if (
      node.type === "declaration_command" &&
      node.text.startsWith("export ")
    ) {
      if (
        node.namedChildren.length === 0 ||
        node.namedChildren.some(
          (part) =>
            part.type !== "variable_assignment" &&
            part.type !== "variable_name",
        )
      ) {
        block("Export declaration is not yet analyzed", spanOf(node));
        return;
      }
      for (const part of node.namedChildren) {
        if (part.type === "variable_assignment") {
          visit(part);
          const name = part.namedChildren.find(
            (child) => child.type === "variable_name",
          )?.text;
          if (name && variables.has(name)) exported.add(name);
        } else if (variables.has(part.text)) exported.add(part.text);
        else block(`Cannot export unknown variable ${part.text}`, spanOf(part));
      }
      return;
    }
    if (node.type === "command") {
      const name = node.childForFieldName("name")?.text;
      if (name === "exit") {
        const argument = node.namedChildren[1];
        const value = argument ? bashValue(argument) : undefined;
        const statuses = value && finiteBytes(value);
        if (
          node.namedChildren.length === 2 &&
          statuses?.length &&
          statuses.every(
            (status) => /^[1-9][0-9]*$/u.test(status) && Number(status) <= 255,
          )
        )
          dead = true;
        else block("Bash exit status is not yet analyzed", spanOf(node));
        return;
      }
      if (githubRedirectTarget) {
        if (name === "echo") {
          const args = node.namedChildren.slice(1);
          const content =
            args.length === 1 && args[0] ? bashValue(args[0]) : undefined;
          if (
            !content ||
            content.text === undefined ||
            content.text.startsWith("-") ||
            /[\\\r\n\0]/u.test(content.text)
          ) {
            block(
              "GitHub echo file write is not a fixed safe line",
              spanOf(node),
            );
            return;
          }
          recordGithubWrite(
            { ...literalBytes(`${content.text}\n`), delimited: true },
            spanOf(node),
          );
          return;
        }
        if (name !== "printf") {
          block("GitHub file writer is not yet analyzed", spanOf(node));
          return;
        }
        const value = evalCommand(node);
        if (value) recordGithubWrite(value, spanOf(node));
        return;
      }
      if (name && functions.has(name)) {
        if (functions.get(name) === "fatal") dead = true;
        else block(`Function ${name} is not yet analyzed`, spanOf(node));
        return;
      }
      const value = evalCommand(node);
      if (value) emit(value, spanOf(node));
      return;
    }
    if (node.type === "pipeline") {
      const value = evalPipeline(node);
      if (value) emit(value, spanOf(node));
      return;
    }
    if (node.type === "variable_assignment") {
      const name = node.namedChildren.find(
        (part) => part.type === "variable_name",
      )?.text;
      const valueNode = node.namedChildren.find(
        (part) => part.type !== "variable_name",
      );
      if (name && valueNode) {
        const substitution =
          valueNode.type === "command_substitution"
            ? valueNode
            : valueNode.type === "string" &&
                valueNode.namedChildren.length === 1 &&
                valueNode.namedChildren[0]?.type === "command_substitution" &&
                valueNode.text === `"${valueNode.namedChildren[0].text}"`
              ? valueNode.namedChildren[0]
              : undefined;
        const exitsOnFailure =
          errexit &&
          substitution !== undefined &&
          isExitCheckedJqSubstitution(substitution);
        const value = substitution
          ? evalSubstitution(substitution, exitsOnFailure)
          : bashValue(valueNode);
        if (value) {
          if (exitsOnFailure) {
            const successful = truthyPart(value.type);
            if (value.alwaysFails || value.max === 0 || !successful) {
              dead = true;
              return;
            }
            if (value.max !== 1) {
              block("jq -e assignment may emit multiple values", spanOf(node));
              return;
            }
            const narrowed: Value = isAssignable(value.type, successful)
              ? { ...value, type: successful, min: 1, max: 1 }
              : {
                  type: successful,
                  min: 1,
                  max: 1,
                  encoded: value.encoded,
                  ...(value.singleLine !== undefined
                    ? { singleLine: value.singleLine }
                    : {}),
                  ...(value.delimited !== undefined
                    ? { delimited: value.delimited }
                    : {}),
                };
            variables.set(name, narrowed);
          } else variables.set(name, value);
          failedVariables.delete(name);
          maybeVariables.delete(name);
          invalidatedVariables.delete(name);
        } else {
          variables.delete(name);
          failedVariables.add(name);
        }
        return;
      }
      block("Bash assignment is not yet analyzed", spanOf(node));
      return;
    }
    if (node.type === "redirected_statement") {
      const special =
        options.githubFiles && node.namedChildren.length === 2
          ? node.namedChildren[1]?.text === '>> "$GITHUB_ENV"'
            ? "env"
            : node.namedChildren[1]?.text === '>> "$GITHUB_OUTPUT"'
              ? "output"
              : undefined
          : undefined;
      if (special) {
        const reserved = special === "env" ? "GITHUB_ENV" : "GITHUB_OUTPUT";
        if (
          githubRedirectTarget ||
          variables.has(reserved) ||
          maybeVariables.has(reserved) ||
          invalidatedVariables.has(reserved)
        ) {
          block(
            "GitHub special file path has an unverified override",
            spanOf(node),
          );
          return;
        }
        const inner = node.namedChildren[0];
        if (
          special === "env" &&
          inner?.type === "command" &&
          inner.childForFieldName("name")?.text === "sed"
        ) {
          visitGithubEnvFileFilter(inner);
          return;
        }
        const statements =
          inner?.type === "compound_statement"
            ? inner.namedChildren.filter((part) => part.type !== "comment")
            : inner
              ? [inner]
              : [];
        if (
          statements.length === 0 ||
          statements.some(
            (part) => part.type !== "command" && part.type !== "case_statement",
          )
        ) {
          block(
            "GitHub redirected statement is not yet analyzed",
            spanOf(node),
          );
          return;
        }
        githubRedirectTarget = special;
        try {
          for (const statement of statements) visit(statement);
        } finally {
          githubRedirectTarget = undefined;
        }
        return;
      }
      const command = node.namedChildren.find(
        (part) => part.type === "command",
      );
      const loop = node.namedChildren.find(
        (part) => part.type === "while_statement",
      );
      const redirect = node.namedChildren.find(
        (part) => part.type === "file_redirect",
      );
      if (
        loop &&
        redirect &&
        (node.namedChildren.length !== 2 ||
          node.namedChildren[0] !== loop ||
          node.namedChildren[1] !== redirect)
      ) {
        block("Bash while/read has multiple redirections", spanOf(node));
        invalidateWrites(loop);
        return;
      }
      if (loop && redirect?.namedChildren[0]?.type === "process_substitution") {
        visitProcessReadLoop(loop, redirect);
        return;
      }
      if (loop && redirect?.text.trimStart().startsWith("<")) {
        const condition = loop.namedChildren[0];
        const operand = redirect.namedChildren[0];
        const value = operand ? bashValue(operand) : undefined;
        const paths = value && finiteBytes(value);
        if (
          condition?.type !== "command" ||
          condition.childForFieldName("name")?.text !== "read" ||
          !paths ||
          !options.readLocalFile
        ) {
          block(
            "Bash while/read file source is not yet analyzed",
            spanOf(node),
          );
          return;
        }
        let singleSource: string | undefined;
        for (const path of paths) {
          const result = options.readLocalFile(path);
          if (result.kind === "unavailable") {
            blocked = true;
            report(
              "PIPE204",
              `Local file dependency is unavailable: ${path}: ${result.reason}`,
              spanOf(redirect),
              "blocked",
            );
          } else if (paths.length === 1) singleSource = result.source;
        }
        if (singleSource !== undefined && visitTsvReadLoop(loop, singleSource))
          return;
        if (paths.length > 1)
          block(
            "Multiple TSV file alternatives are not yet analyzed",
            spanOf(loop),
          );
        else if (singleSource === undefined)
          block("TSV source is unavailable", spanOf(loop));
        else block("TSV loop body remains unverified", spanOf(loop));
        invalidateWrites(loop);
        return;
      }
      if (
        command &&
        /^(?:1)?>(?:[ \t]*)(?:\/dev\/null|&2)$/u.test(redirect?.text ?? "")
      ) {
        evalCommand(command);
        return;
      }
      block("Redirection effect is not yet analyzed", spanOf(node));
      return;
    }
    block(`Bash ${node.type} is not yet analyzed`, spanOf(node));
  }

  function checkNestedLocalArguments(root: BashSyntaxNode): void {
    const pending = [root];
    let visited = 0;
    while (pending.length) {
      const node = pending.pop();
      if (!node) continue;
      if (++visited > 100_000) {
        block("Bash structural inspection budget exceeded", spanOf(root));
        return;
      }
      if (node.type === "command") {
        const name = node.childForFieldName("name");
        if (
          name &&
          (name.text.startsWith("./") || name.text.startsWith(".github/")) &&
          name.text.endsWith(".sh") &&
          node.namedChildren.some(
            (part) =>
              part.startIndex >= name.endIndex &&
              part.type !== "herestring_redirect" &&
              !part.type.endsWith("_redirect"),
          )
        )
          report(
            "PIPE104",
            "Business positional arguments are not supported",
            spanOf(node),
          );
      }
      for (const child of node.namedChildren) pending.push(child);
    }
  }

  try {
    if (tree.rootNode.hasError)
      report("PIPE001", "Invalid Bash syntax", spanOf(tree.rootNode));
    else {
      const statements = tree.rootNode.namedChildren.filter(
        (item) => item.type !== "comment",
      );
      const last = statements.at(-1);
      const penultimate = statements.at(-2);
      const caseNode = last?.namedChildren[0];
      const clauses = caseNode?.namedChildren ?? [];
      if (
        penultimate?.type === "list" &&
        last?.type === "redirected_statement" &&
        last.namedChildren.length === 2 &&
        last.namedChildren[1]?.text === '>> "$GITHUB_OUTPUT"' &&
        caseNode?.type === "case_statement" &&
        clauses.length === 4 &&
        clauses[0]?.text === '"$status"' &&
        /^0\)/u.test(clauses[1]?.text ?? "") &&
        /^1\)/u.test(clauses[2]?.text ?? "") &&
        /^\*\)/u.test(clauses[3]?.text ?? "") &&
        clauses[3]?.namedChildren.at(-1)?.text === 'exit "$status"'
      )
        provenGitStatusLists.add(penultimate.startIndex);
      checkNestedLocalArguments(tree.rootNode);
      for (const item of tree.rootNode.namedChildren) visit(item);
    }
  } finally {
    tree.delete();
  }
  if (!blocked && diagnostics.length === 0 && dead)
    block(
      "No successful Bash path remains",
      createSpan(source.length, source.length),
    );
  if (!blocked && diagnostics.length === 0 && contract.stdout) {
    if (output?.min !== 1 || output.max !== 1)
      report(
        "PIPE103",
        "Declared stdout requires exactly one JSON value",
        lastOutputSpan ?? createSpan(source.length, source.length),
      );
    else if (!output.encoded)
      report(
        "PIPE101",
        "stdout is not guaranteed to be JSON encoded",
        lastOutputSpan ?? createSpan(source.length, source.length),
      );
    else if (!isAssignable(output.type, contract.stdout))
      report(
        "PIPE102",
        "stdout does not match declared JSON shape",
        lastOutputSpan ?? createSpan(source.length, source.length),
      );
  }
  const complete = !blocked && diagnostics.length === 0;
  const githubValues = (
    values: ReadonlyMap<string, Value>,
  ): Readonly<Record<string, GithubFileValue>> =>
    Object.fromEntries(
      [...values].map(([name, value]) => [
        name,
        {
          type: value.type,
          encoded: value.encoded,
          ...(value.text === undefined ? {} : { text: value.text }),
        },
      ]),
    );
  return {
    diagnostics,
    complete,
    effects: {
      filesMayWrite: [...filesMayWrite].sort(),
      githubEnv: complete ? githubValues(githubEnv) : {},
      githubOutput: complete ? githubValues(githubOutput) : {},
      externalMayRun: [...externalMayRun].sort(),
    },
  };
}
