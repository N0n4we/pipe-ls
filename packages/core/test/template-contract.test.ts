import { describe, expect, it } from "vitest";
import {
  isAssignable,
  MAX_TEMPLATE_LENGTH,
  MAX_TEMPLATE_NODES,
  parseScriptContract,
  parseTemplate,
  TemplateSyntaxError,
} from "../src/index.js";

describe("JSON interface templates", () => {
  it("accepts closed objects, unions and JSON literals", () => {
    expect(
      isAssignable(
        parseTemplate('{"id": 3, "name": "ok"}'),
        parseTemplate('{"id": number, "name": string}'),
      ),
    ).toBe(true);
    expect(
      isAssignable(
        parseTemplate('{"id": number}'),
        parseTemplate('{"id": number, "name": string | null}'),
      ),
    ).toBe(false);
    expect(
      isAssignable(
        parseTemplate('{"id": number, "extra": true}'),
        parseTemplate('{"id": number}'),
      ),
    ).toBe(false);
    expect(isAssignable(parseTemplate("[]"), parseTemplate("[number]"))).toBe(
      true,
    );
    expect(isAssignable(parseTemplate("[number]"), parseTemplate("[]"))).toBe(
      false,
    );
    expect(
      isAssignable(
        parseTemplate("number | string"),
        parseTemplate("string | number | null"),
      ),
    ).toBe(true);
    expect(
      isAssignable(parseTemplate("number | boolean"), parseTemplate("number")),
    ).toBe(false);
  });

  it("rejects non-JSON types, malformed strings and duplicate keys", () => {
    for (const source of [
      "unknown",
      "any",
      "text",
      "json<number>[1]",
      '{"x": number, "x": string}',
      "{'x': number}",
      "1e9999",
      '"bad\\q"',
    ]) {
      expect(() => parseTemplate(source), source).toThrow(TemplateSyntaxError);
    }
  });

  it("rejects oversized or combinatorial interface declarations", () => {
    expect(() => parseTemplate(" ".repeat(MAX_TEMPLATE_LENGTH + 1))).toThrow(
      "Template length budget exceeded",
    );
    expect(() =>
      parseTemplate(
        Array.from({ length: MAX_TEMPLATE_NODES + 1 }, () => "string").join(
          " | ",
        ),
      ),
    ).toThrow("Template node budget exceeded");
  });

  it("allows absent stdin/stdout but rejects duplicate or late declarations", () => {
    expect(
      parseScriptContract(
        "#!/usr/bin/env bash\n# @pipe env X: string\nprintf '%s\\n' 'log'",
      ).issues,
    ).toEqual([]);
    const result = parseScriptContract(
      "# @pipe stdin: null\n# @pipe stdin: string\n# @pipe\nprintf '%s\\n' 'null'\n# @pipe stdout: null\n",
    );
    expect(result.issues).toHaveLength(3);
    expect(result.issues.every((issue) => issue.code === "PIPE104")).toBe(true);
  });
});
