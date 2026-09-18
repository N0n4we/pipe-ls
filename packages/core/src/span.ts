/** UTF-16 code unit offsets, with an inclusive start and exclusive end. */
export interface Span {
  readonly start: number;
  readonly end: number;
}

export function createSpan(start: number, end: number): Span {
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    start < 0 ||
    end < start
  ) {
    throw new RangeError(
      "Span requires integer offsets with 0 <= start <= end",
    );
  }

  return { start, end };
}
