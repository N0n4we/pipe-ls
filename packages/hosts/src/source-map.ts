import { createSpan, type Span } from "@pipe-ls/core";
import type { Scalar } from "yaml";

export type MappingPrecision = "exact" | "decoded";

interface Cell {
  readonly span: Span;
  readonly precision: MappingPrecision;
}

export interface MappedRange {
  /** Smallest enclosing source range. It may contain stripped indentation. */
  readonly span: Span;
  /** Contiguous contributing source ranges, in source order. */
  readonly pieces: readonly Span[];
  readonly precision: MappingPrecision;
}

/** UTF-16 mapping for a decoded unit; non-exact ranges are diagnostic-only. */
export class MappedText {
  constructor(
    readonly text: string,
    private readonly cells: readonly Cell[],
  ) {
    if (text.length !== cells.length)
      throw new RangeError("Each UTF-16 code unit needs a source cell");
  }

  static identity(text: string): MappedText {
    return new MappedText(
      text,
      Array.from({ length: text.length }, (_, i) => exact(i)),
    );
  }

  slice(start: number, end: number): MappedText {
    createSpan(start, end);
    if (end > this.text.length)
      throw new RangeError("Slice exceeds mapped text");
    return new MappedText(
      this.text.slice(start, end),
      this.cells.slice(start, end),
    );
  }

  mapSpan(span: Span): MappedRange {
    createSpan(span.start, span.end);
    if (span.end > this.text.length)
      throw new RangeError("Span exceeds mapped text");
    if (span.start === span.end) {
      const boundary =
        this.cells[span.start]?.span.start ??
        this.cells[span.start - 1]?.span.end ??
        0;
      const zero = createSpan(boundary, boundary);
      return { span: zero, pieces: [zero], precision: "exact" };
    }
    const cells = this.cells.slice(span.start, span.end);
    const first = cells[0];
    if (!first) throw new Error("Non-empty span has no source cells");
    const pieces: Span[] = [];
    let start = first.span.start;
    let end = first.span.end;
    let precision: MappingPrecision = first.precision;
    for (const cell of cells.slice(1)) {
      if (cell.precision === "decoded") precision = "decoded";
      if (cell.span.start === end) {
        end = cell.span.end;
      } else {
        pieces.push(createSpan(start, end));
        start = cell.span.start;
        end = cell.span.end;
        precision = "decoded";
      }
    }
    pieces.push(createSpan(start, end));
    return {
      span: createSpan(
        pieces[0]?.start ?? 0,
        pieces[pieces.length - 1]?.end ?? 0,
      ),
      pieces,
      precision,
    };
  }
}

function exact(start: number): Cell {
  return { span: createSpan(start, start + 1), precision: "exact" };
}

function decoded(start: number, end: number): Cell {
  return { span: createSpan(start, end), precision: "decoded" };
}

function fallback(value: string, span: Span): MappedText {
  return new MappedText(
    value,
    Array.from({ length: value.length }, () => ({
      span,
      precision: "decoded" as const,
    })),
  );
}

/** Map YAML 1.2 scalar content. Unsupported decoding retains a conservative whole-scalar location. */
export function mapYamlScalar(source: string, scalar: Scalar): MappedText {
  if (typeof scalar.value !== "string")
    throw new TypeError("Expected a YAML string scalar");
  const value = scalar.value;
  const token = scalar.srcToken;
  const range = createSpan(scalar.range?.[0] ?? 0, scalar.range?.[1] ?? 0);
  if (!token) return fallback(value, range);
  if (token.type === "scalar" && token.source === value) {
    return new MappedText(
      value,
      Array.from({ length: value.length }, (_, i) => exact(token.offset + i)),
    );
  }
  if (token.type === "block-scalar") {
    const headerLength = token.props.reduce(
      (sum, prop) => sum + ("source" in prop ? prop.source.length : 0),
      0,
    );
    const folded = token.props.some(
      (prop) =>
        prop.type === "block-scalar-header" && prop.source.startsWith(">"),
    );
    return mapBlockScalar(
      value,
      token.offset + headerLength,
      token.source,
      folded,
      range,
    );
  }
  if (token.type === "single-quoted-scalar") {
    return mapSingleQuoted(value, token.offset, token.source, range);
  }
  if (token.type === "double-quoted-scalar") {
    return mapDoubleQuoted(value, token.offset, token.source, range);
  }
  // Do not claim exact mapping for YAML constructs not yet modeled.
  return fallback(
    value,
    createSpan(range.start, Math.min(source.length, range.end)),
  );
}

function mapBlockScalar(
  value: string,
  bodyOffset: number,
  body: string,
  folded: boolean,
  range: Span,
): MappedText {
  const lines: {
    text: string;
    start: number;
    newlineStart: number;
    newlineLength: number;
  }[] = [];
  let cursor = 0;
  while (cursor < body.length) {
    const start = cursor;
    while (
      cursor < body.length &&
      body[cursor] !== "\r" &&
      body[cursor] !== "\n"
    )
      cursor++;
    const text = body.slice(start, cursor);
    const newlineStart = cursor;
    if (body.startsWith("\r\n", cursor)) cursor += 2;
    else if (cursor < body.length) cursor++;
    lines.push({
      text,
      start,
      newlineStart,
      newlineLength: cursor - newlineStart,
    });
  }
  const indents = lines
    .filter((line) => line.text.trim().length > 0)
    .map((line) => /^ */u.exec(line.text)?.[0].length ?? 0);
  const indent = indents.reduce(
    (smallest, current) => Math.min(smallest, current),
    Number.POSITIVE_INFINITY,
  );
  const cooked: string[] = [];
  const cells: Cell[] = [];
  for (const line of lines) {
    const cut = Number.isFinite(indent)
      ? Math.min(indent, line.text.length)
      : line.text.length;
    const content = line.text.trim().length === 0 ? "" : line.text.slice(cut);
    for (let i = 0; i < content.length; i++) {
      cooked.push(content[i] ?? "");
      cells.push(exact(bodyOffset + line.start + cut + i));
    }
    if (line.newlineLength > 0) {
      cooked.push("\n");
      cells.push(
        line.newlineLength === 1
          ? exact(bodyOffset + line.newlineStart)
          : decoded(
              bodyOffset + line.newlineStart,
              bodyOffset + line.newlineStart + line.newlineLength,
            ),
      );
    }
  }
  const mapped: Cell[] = [];
  let mappedCursor = 0;
  for (let i = 0; i < value.length; i++) {
    const actual = value[i];
    const candidate = cooked[mappedCursor];
    const cell = cells[mappedCursor];
    if (
      !cell ||
      (actual !== candidate &&
        !(folded && actual === " " && candidate === "\n"))
    ) {
      return fallback(value, range);
    }
    mapped.push(
      actual === candidate ? cell : decoded(cell.span.start, cell.span.end),
    );
    mappedCursor++;
  }
  if (cooked.slice(mappedCursor).some((char) => char !== "\n"))
    return fallback(value, range);
  return new MappedText(value, mapped);
}

function mapSingleQuoted(
  value: string,
  offset: number,
  raw: string,
  range: Span,
): MappedText {
  if (!raw.startsWith("'") || !raw.endsWith("'")) return fallback(value, range);
  const chars: string[] = [];
  const cells: Cell[] = [];
  for (let i = 1; i < raw.length - 1; i++) {
    if (raw[i] === "\n" || raw[i] === "\r") return fallback(value, range);
    if (raw.startsWith("''", i)) {
      chars.push("'");
      cells.push(decoded(offset + i, offset + i + 2));
      i++;
    } else {
      chars.push(raw[i] ?? "");
      cells.push(exact(offset + i));
    }
  }
  return chars.join("") === value
    ? new MappedText(value, cells)
    : fallback(value, range);
}

const yamlEscapes: Readonly<Record<string, string>> = {
  "0": "\0",
  a: "\x07",
  b: "\b",
  t: "\t",
  n: "\n",
  v: "\v",
  f: "\f",
  r: "\r",
  e: "\x1b",
  " ": " ",
  '"': '"',
  "/": "/",
  "\\": "\\",
  N: "\u0085",
  _: "\u00a0",
  L: "\u2028",
  P: "\u2029",
};

function mapDoubleQuoted(
  value: string,
  offset: number,
  raw: string,
  range: Span,
): MappedText {
  if (!raw.startsWith('"') || !raw.endsWith('"')) return fallback(value, range);
  const chars: string[] = [];
  const cells: Cell[] = [];
  for (let i = 1; i < raw.length - 1; i++) {
    const char = raw[i];
    if (char === "\n" || char === "\r") return fallback(value, range);
    if (char !== "\\") {
      chars.push(char ?? "");
      cells.push(exact(offset + i));
      continue;
    }
    const escapeCode = raw[i + 1];
    if (!escapeCode) return fallback(value, range);
    let transformed = yamlEscapes[escapeCode];
    let width = 2;
    if (transformed === undefined && ["x", "u", "U"].includes(escapeCode)) {
      width = escapeCode === "x" ? 4 : escapeCode === "u" ? 6 : 10;
      const hex = raw.slice(i + 2, i + width);
      if (!/^[0-9a-fA-F]+$/u.test(hex) || hex.length !== width - 2)
        return fallback(value, range);
      try {
        transformed = String.fromCodePoint(Number.parseInt(hex, 16));
      } catch {
        return fallback(value, range);
      }
    }
    if (transformed === undefined) return fallback(value, range);
    for (let j = 0; j < transformed.length; j++) {
      chars.push(transformed[j] ?? "");
      cells.push(decoded(offset + i, offset + i + width));
    }
    i += width - 1;
  }
  return chars.join("") === value
    ? new MappedText(value, cells)
    : fallback(value, range);
}

/** Bash single-quoted raw_string node: no expansion, exact inner UTF-16 content. */
export function mapBashSingleQuoted(
  parent: MappedText,
  span: Span,
): MappedText | undefined {
  const raw = parent.text.slice(span.start, span.end);
  if (raw.length < 2 || !raw.startsWith("'") || !raw.endsWith("'"))
    return undefined;
  return parent.slice(span.start + 1, span.end - 1);
}
