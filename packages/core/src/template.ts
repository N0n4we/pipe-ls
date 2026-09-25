import { createSpan, type Span } from "./span.js";

/** JSON value shapes. Absence of an interface is represented outside this model. */
export type Template =
  | {
      readonly kind: "primitive";
      readonly name: "string" | "number" | "boolean" | "null";
    }
  | { readonly kind: "literal"; readonly value: string | number | boolean }
  | {
      readonly kind: "object";
      readonly fields: Readonly<Record<string, Template>>;
    }
  | { readonly kind: "array"; readonly element: Template | null }
  | { readonly kind: "union"; readonly options: readonly Template[] };

export class TemplateSyntaxError extends Error {
  constructor(
    message: string,
    readonly span: Span,
  ) {
    super(message);
    this.name = "TemplateSyntaxError";
  }
}

export const MAX_TEMPLATE_LENGTH = 65_536;
export const MAX_TEMPLATE_NODES = 4_096;

/** Parse the intentionally small, closed JSON template language. */
export function parseTemplate(source: string): Template {
  if (source.length > MAX_TEMPLATE_LENGTH)
    throw new TemplateSyntaxError(
      "Template length budget exceeded",
      createSpan(0, source.length),
    );
  const parser = new Parser(source);
  const result = parser.union();
  parser.space();
  if (!parser.done) parser.fail("Unexpected token");
  return result;
}

class Parser {
  private position = 0;
  private depth = 0;
  private nodes = 0;
  constructor(private readonly source: string) {}

  get done(): boolean {
    return this.position >= this.source.length;
  }
  space(): void {
    while (/\s/u.test(this.source[this.position] ?? "")) this.position++;
  }
  fail(message: string, start = this.position): never {
    throw new TemplateSyntaxError(
      message,
      createSpan(
        start,
        Math.min(this.source.length, Math.max(start + 1, this.position)),
      ),
    );
  }
  private take(token: string): boolean {
    this.space();
    if (!this.source.startsWith(token, this.position)) return false;
    this.position += token.length;
    return true;
  }
  private expect(token: string): void {
    if (!this.take(token)) this.fail(`Expected ${token}`);
  }
  union(): Template {
    if (++this.depth > 128) this.fail("Template nesting limit exceeded");
    try {
      const options = [this.atom()];
      while (this.take("|")) options.push(this.atom());
      return options.length === 1
        ? (options[0] as Template)
        : { kind: "union", options };
    } finally {
      this.depth--;
    }
  }
  private atom(): Template {
    this.space();
    if (++this.nodes > MAX_TEMPLATE_NODES)
      this.fail("Template node budget exceeded");
    if (this.take("(")) {
      const value = this.union();
      this.expect(")");
      return value;
    }
    if (this.take("{")) {
      const fields: Record<string, Template> = Object.create(null);
      if (!this.take("}")) {
        do {
          this.space();
          const key = this.jsonString();
          if (Object.hasOwn(fields, key))
            this.fail(`Duplicate key ${JSON.stringify(key)}`);
          this.expect(":");
          fields[key] = this.union();
        } while (this.take(","));
        this.expect("}");
      }
      return { kind: "object", fields };
    }
    if (this.take("[")) {
      if (this.take("]")) return { kind: "array", element: null };
      const element = this.union();
      this.expect("]");
      return { kind: "array", element };
    }
    if (this.source[this.position] === '"')
      return { kind: "literal", value: this.jsonString() };
    const rest = this.source.slice(this.position);
    const number = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/u.exec(
      rest,
    )?.[0];
    if (number) {
      this.position += number.length;
      const value = Number(number);
      if (!Number.isFinite(value)) this.fail("JSON number is not finite");
      return { kind: "literal", value };
    }
    const word = /^[A-Za-z_][A-Za-z_0-9]*/u.exec(rest)?.[0];
    if (word) {
      this.position += word.length;
      if (word === "true" || word === "false")
        return { kind: "literal", value: word === "true" };
      if (["string", "number", "boolean", "null"].includes(word))
        return {
          kind: "primitive",
          name: word as "string" | "number" | "boolean" | "null",
        };
      this.fail(
        `Unsupported template type ${word}`,
        this.position - word.length,
      );
    }
    this.fail("Expected JSON template");
  }
  private jsonString(): string {
    this.space();
    const start = this.position;
    if (this.source[this.position] !== '"')
      this.fail("Expected double-quoted JSON key");
    this.position++;
    while (this.position < this.source.length) {
      if (this.source[this.position] === "\\") {
        this.position += 2;
        continue;
      }
      if (this.source[this.position] === '"') {
        this.position++;
        try {
          return JSON.parse(this.source.slice(start, this.position)) as string;
        } catch {
          this.fail("Invalid JSON string", start);
        }
      }
      this.position++;
    }
    this.fail("Unterminated JSON string", start);
  }
}

/** True only when every JSON value admitted by actual also satisfies expected. */
export function isAssignable(actual: Template, expected: Template): boolean {
  if (actual.kind === "union")
    return actual.options.every((option) => isAssignable(option, expected));
  if (expected.kind === "union")
    return expected.options.some((option) => isAssignable(actual, option));
  if (expected.kind === "primitive") {
    if (actual.kind === "primitive") return actual.name === expected.name;
    return actual.kind === "literal" && typeof actual.value === expected.name;
  }
  if (expected.kind === "literal")
    return actual.kind === "literal" && Object.is(actual.value, expected.value);
  if (expected.kind === "array") {
    if (actual.kind !== "array") return false;
    if (actual.element === null) return true;
    return (
      expected.element !== null &&
      isAssignable(actual.element, expected.element)
    );
  }
  if (actual.kind !== "object") return false;
  const a = Object.keys(actual.fields).sort();
  const e = Object.keys(expected.fields).sort();
  return (
    a.length === e.length &&
    a.every(
      (key, i) =>
        key === e[i] &&
        isAssignable(
          actual.fields[key] as Template,
          expected.fields[key] as Template,
        ),
    )
  );
}

export function templateOfJson(value: unknown): Template {
  if (value === null) return { kind: "primitive", name: "null" };
  if (typeof value === "string" || typeof value === "boolean")
    return { kind: "literal", value };
  if (typeof value === "number" && Number.isFinite(value))
    return { kind: "literal", value };
  if (Array.isArray(value)) {
    if (value.length === 0) return { kind: "array", element: null };
    return { kind: "array", element: union(value.map(templateOfJson)) };
  }
  if (typeof value === "object") {
    const fields: Record<string, Template> = Object.create(null);
    for (const [key, entry] of Object.entries(value))
      fields[key] = templateOfJson(entry);
    return { kind: "object", fields };
  }
  throw new TypeError("Not a finite JSON value");
}

export function union(options: readonly Template[]): Template {
  if (options.length === 0) throw new RangeError("Empty template union");
  const pending = [...options].reverse();
  const unique = new Map<string, Template>();
  while (pending.length) {
    const option = pending.pop();
    if (!option) continue;
    if (option.kind === "union")
      for (let i = option.options.length - 1; i >= 0; i--) {
        const member = option.options[i];
        if (member) pending.push(member);
      }
    else unique.set(JSON.stringify(option), option);
  }
  const flattened = [...unique.values()];
  return flattened.length === 1
    ? (flattened[0] as Template)
    : { kind: "union", options: flattened };
}
