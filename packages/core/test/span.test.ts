import { describe, expect, it } from "vitest";
import { createSpan } from "../src/index.js";

describe("createSpan", () => {
  it("uses UTF-16 half-open offsets, including Chinese, emoji and CRLF", () => {
    const source = "中😀\r\n文";
    const span = createSpan(1, 3);

    expect(source.slice(span.start, span.end)).toBe("😀");
    expect(source.slice(3, 5)).toBe("\r\n");
    expect(createSpan(0, source.length)).toEqual({ start: 0, end: 6 });
  });

  it("allows empty spans", () => {
    expect(createSpan(0, 0)).toEqual({ start: 0, end: 0 });
    expect(createSpan(3, 3)).toEqual({ start: 3, end: 3 });
  });

  it.each([
    [-1, 0],
    [2, 1],
    [0.5, 1],
    [0, 1.5],
    [Number.NaN, 1],
    [0, Number.POSITIVE_INFINITY],
    [0, Number.MAX_SAFE_INTEGER + 1],
  ])("rejects invalid offsets (%s, %s)", (start, end) => {
    expect(() => createSpan(start, end)).toThrow(RangeError);
  });
});
