import { createSpan, type Span } from "./span.js";

export interface JqToken {
  readonly kind: "name" | "variable" | "number" | "string" | "symbol" | "eof";
  readonly value: string;
  readonly span: Span;
}

export interface JqNode {
  readonly kind:
    | "literal"
    | "name"
    | "variable"
    | "identity"
    | "field"
    | "index"
    | "iterate"
    | "call"
    | "array"
    | "object"
    | "property"
    | "binary"
    | "unary"
    | "if"
    | "reduce"
    | "group";
  readonly span: Span;
  readonly value?: string;
  readonly children: readonly JqNode[];
}

export class JqSyntaxError extends Error {
  constructor(
    message: string,
    readonly span: Span,
  ) {
    super(message);
    this.name = "JqSyntaxError";
  }
}

export class JqUnsupportedSyntaxError extends Error {
  constructor(
    message: string,
    readonly span: Span,
  ) {
    super(message);
    this.name = "JqUnsupportedSyntaxError";
  }
}

const operators = ["//=", "|=", "+=", "==", "!=", ">=", "<=", "//"];
const symbols = new Set(".[]{}():;,|+-*/=<>?".split(""));

/** A deliberately bounded jq lexer. Offsets are UTF-16 code units, not bytes. */
export function lexJq(source: string): JqToken[] {
  const tokens: JqToken[] = [];
  let offset = 0;
  while (offset < source.length) {
    const start = offset;
    const char = source[offset];
    if (char === undefined) break;
    if (/\s/u.test(char)) {
      offset++;
      continue;
    }
    if (char === "#") {
      while (offset < source.length && source[offset] !== "\n") offset++;
      continue;
    }
    if (char === '"') {
      offset++;
      let closed = false;
      while (offset < source.length) {
        if (source[offset] === "\\") {
          offset += 2;
        } else if (source[offset] === '"') {
          offset++;
          closed = true;
          break;
        } else {
          offset++;
        }
      }
      const raw = source.slice(start, offset);
      if (raw.includes("\\(")) {
        throw new JqUnsupportedSyntaxError(
          "jq string interpolation is not supported by the P0 parser",
          createSpan(start, offset),
        );
      }
      if (!closed || !isJsonString(raw)) {
        throw new JqSyntaxError(
          "Invalid jq string literal",
          createSpan(start, offset),
        );
      }
      tokens.push({
        kind: "string",
        value: raw,
        span: createSpan(start, offset),
      });
      continue;
    }
    if (char === "$" && /[A-Za-z_]/u.test(source[offset + 1] ?? "")) {
      offset += 2;
      while (/[A-Za-z0-9_]/u.test(source[offset] ?? "")) offset++;
      tokens.push({
        kind: "variable",
        value: source.slice(start, offset),
        span: createSpan(start, offset),
      });
      continue;
    }
    if (/[A-Za-z_]/u.test(char)) {
      offset++;
      while (/[A-Za-z0-9_]/u.test(source[offset] ?? "")) offset++;
      tokens.push({
        kind: "name",
        value: source.slice(start, offset),
        span: createSpan(start, offset),
      });
      continue;
    }
    if (/[0-9]/u.test(char)) {
      const match = /^(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/u.exec(
        source.slice(offset),
      );
      if (!match)
        throw new JqSyntaxError(
          "Invalid jq number",
          createSpan(start, start + 1),
        );
      offset += match[0].length;
      tokens.push({
        kind: "number",
        value: match[0],
        span: createSpan(start, offset),
      });
      continue;
    }
    const operator = operators.find((candidate) =>
      source.startsWith(candidate, offset),
    );
    if (operator) {
      offset += operator.length;
      tokens.push({
        kind: "symbol",
        value: operator,
        span: createSpan(start, offset),
      });
      continue;
    }
    if (symbols.has(char)) {
      offset++;
      tokens.push({
        kind: "symbol",
        value: char,
        span: createSpan(start, offset),
      });
      continue;
    }
    throw new JqUnsupportedSyntaxError(
      "Unsupported jq character",
      createSpan(start, start + 1),
    );
  }
  tokens.push({
    kind: "eof",
    value: "",
    span: createSpan(source.length, source.length),
  });
  return tokens;
}

function isJsonString(raw: string): boolean {
  try {
    return typeof JSON.parse(raw) === "string";
  } catch {
    return false;
  }
}

const precedence: Readonly<Record<string, number>> = {
  ",": 1,
  "|": 2,
  "//=": 3,
  "|=": 3,
  "+=": 3,
  "=": 3,
  "//": 4,
  or: 5,
  and: 6,
  "==": 7,
  "!=": 7,
  ">": 7,
  "<": 7,
  ">=": 7,
  "<=": 7,
  "+": 8,
  "-": 8,
  "*": 9,
  "/": 9,
};

function node(
  kind: JqNode["kind"],
  span: Span,
  children: readonly JqNode[] = [],
  value?: string,
): JqNode {
  return value === undefined
    ? { kind, span, children }
    : { kind, span, children, value };
}

/** Syntax-only prototype; it intentionally does not infer jq types or cardinality. */
export function parseJq(source: string): JqNode {
  const parser = new JqParser(lexJq(source));
  return parser.parse();
}

class JqParser {
  private index = 0;
  private depth = 0;

  constructor(private readonly tokens: readonly JqToken[]) {}

  parse(): JqNode {
    const result = this.expression(0);
    this.expect("eof");
    return result;
  }

  private get current(): JqToken {
    const token = this.tokens[this.index];
    if (!token) throw new Error("jq parser cursor exceeded token stream");
    return token;
  }

  private take(): JqToken {
    const token = this.current;
    this.index++;
    return token;
  }

  private match(value: string): boolean {
    if (this.current.value !== value) return false;
    this.take();
    return true;
  }

  private expect(value: string): JqToken {
    if (this.current.value !== value && this.current.kind !== value) {
      throw new JqSyntaxError(`Expected ${value}`, this.current.span);
    }
    return this.take();
  }

  private expression(minimum: number): JqNode {
    if (++this.depth > 128)
      throw new JqSyntaxError(
        "jq expression nesting limit exceeded",
        this.current.span,
      );
    try {
      let left = this.postfix(this.prefix());
      while (true) {
        const token = this.current;
        if (token.value === "as" && minimum <= 3) {
          this.take();
          const variable = this.expect("variable");
          left = node(
            "binary",
            createSpan(left.span.start, variable.span.end),
            [left, node("variable", variable.span, [], variable.value)],
            "as",
          );
          continue;
        }
        const binding = precedence[token.value];
        if (binding === undefined || binding < minimum) break;
        this.take();
        const right = this.expression(binding + (binding === 3 ? 0 : 1));
        left = node(
          "binary",
          createSpan(left.span.start, right.span.end),
          [left, right],
          token.value,
        );
      }
      return left;
    } finally {
      this.depth--;
    }
  }

  private prefix(): JqNode {
    const token = this.take();
    switch (token.value) {
      case ".":
        return node("identity", token.span);
      case "(": {
        const child = this.expression(0);
        const end = this.expect(")");
        return node("group", createSpan(token.span.start, end.span.end), [
          child,
        ]);
      }
      case "[": {
        const children = this.current.value === "]" ? [] : [this.expression(0)];
        const end = this.expect("]");
        return node(
          "array",
          createSpan(token.span.start, end.span.end),
          children,
        );
      }
      case "{":
        return this.object(token);
      case "if": {
        const condition = this.expression(0);
        this.expect("then");
        const yes = this.expression(0);
        this.expect("else");
        const no = this.expression(0);
        const end = this.expect("end");
        return node("if", createSpan(token.span.start, end.span.end), [
          condition,
          yes,
          no,
        ]);
      }
      case "reduce": {
        const source = this.expression(4);
        this.expect("as");
        const variable = this.expect("variable");
        this.expect("(");
        const initial = this.expression(0);
        this.expect(";");
        const update = this.expression(0);
        const end = this.expect(")");
        return node("reduce", createSpan(token.span.start, end.span.end), [
          source,
          node("variable", variable.span, [], variable.value),
          initial,
          update,
        ]);
      }
      case "-": {
        const value = this.expression(10);
        return node(
          "unary",
          createSpan(token.span.start, value.span.end),
          [value],
          "-",
        );
      }
      default:
        break;
    }
    if (token.kind === "variable")
      return node("variable", token.span, [], token.value);
    if (
      token.kind === "string" ||
      token.kind === "number" ||
      ["true", "false", "null"].includes(token.value)
    ) {
      return node("literal", token.span, [], token.value);
    }
    if (
      token.kind === "name" &&
      !["then", "else", "end", "as"].includes(token.value)
    ) {
      return node("name", token.span, [], token.value);
    }
    throw new JqSyntaxError("Expected jq expression", token.span);
  }

  private object(start: JqToken): JqNode {
    const values: JqNode[] = [];
    if (this.current.value !== "}") {
      do {
        const key = this.take();
        if (key.kind !== "name" && key.kind !== "string") {
          throw new JqSyntaxError("Expected jq object key", key.span);
        }
        this.expect(":");
        const value = this.expression(2);
        values.push(
          node(
            "property",
            createSpan(key.span.start, value.span.end),
            [value],
            key.value,
          ),
        );
      } while (this.match(","));
    }
    const end = this.expect("}");
    return node("object", createSpan(start.span.start, end.span.end), values);
  }

  private postfix(initial: JqNode): JqNode {
    let left = initial;
    while (true) {
      if (this.match(".")) {
        const property = this.current;
        if (
          property.kind !== "name" &&
          property.kind !== "string" &&
          property.kind !== "variable"
        ) {
          throw new JqSyntaxError("Expected jq field after dot", property.span);
        }
        this.take();
        left = node(
          "field",
          createSpan(left.span.start, property.span.end),
          [left],
          property.value,
        );
      } else if (
        left.kind === "identity" &&
        left.span.end === this.current.span.start &&
        ["name", "string", "variable"].includes(this.current.kind)
      ) {
        const property = this.take();
        left = node(
          "field",
          createSpan(left.span.start, property.span.end),
          [left],
          property.value,
        );
      } else if (this.match("[")) {
        if (this.current.value === "]") {
          const end = this.take();
          left = node("iterate", createSpan(left.span.start, end.span.end), [
            left,
          ]);
        } else {
          const index = this.expression(0);
          const end = this.expect("]");
          left = node("index", createSpan(left.span.start, end.span.end), [
            left,
            index,
          ]);
        }
      } else if (left.kind === "name" && this.match("(")) {
        const args: JqNode[] = [];
        if (this.current.value !== ")") {
          do {
            args.push(this.expression(0));
          } while (this.match(";"));
        }
        const end = this.expect(")");
        left = node(
          "call",
          createSpan(left.span.start, end.span.end),
          args,
          left.value,
        );
      } else {
        return left;
      }
    }
  }
}
