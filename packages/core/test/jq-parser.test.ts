import { describe, expect, it } from "vitest";
import {
  type JqNode,
  JqSyntaxError,
  JqUnsupportedSyntaxError,
  lexJq,
  parseJq,
} from "../src/index.js";

function collect(node: JqNode, kind: JqNode["kind"]): JqNode[] {
  return [
    ...(node.kind === kind ? [node] : []),
    ...node.children.flatMap((child) => collect(child, kind)),
  ];
}

describe("jq syntax prototype", () => {
  it("parses case 1 reduce, dynamic updates and closed object construction", () => {
    const source =
      "reduce .images[] as $image ({}; .[$image.platform] //= {deployments: []} | .[$image.platform].deployments += $image.deployment_names)";
    const root = parseJq(source);
    expect(root.kind).toBe("reduce");
    expect(collect(root, "index")).toHaveLength(2);
    expect(collect(root, "binary").map((node) => node.value)).toEqual(
      expect.arrayContaining(["//=", "|", "+="]),
    );
    expect(collect(root, "property").map((node) => node.value)).toContain(
      "deployments",
    );
  });

  it("keeps UTF-16 spans for Unicode and comments", () => {
    const source = '# 中文😀\r\n{"名": .image_name}';
    const tokens = lexJq(source);
    const key = tokens.find((token) => token.value === '"名"');
    expect(key?.span).toEqual({ start: 9, end: 12 });
    expect(source.slice(key?.span.start, key?.span.end)).toBe('"名"');
    const property = collect(parseJq(source), "property")[0];
    expect(property?.value).toBe('"名"');
  });

  it("reports syntax and unsupported characters at original offsets", () => {
    expect(() => parseJq(".images | ")).toThrow(JqSyntaxError);
    try {
      parseJq('"😀" | ~');
      throw new Error("Expected syntax failure");
    } catch (error) {
      expect(error).toBeInstanceOf(JqUnsupportedSyntaxError);
      expect((error as JqUnsupportedSyntaxError).span).toEqual({
        start: 7,
        end: 8,
      });
    }
    expect(() => parseJq('"\\(.name)"')).toThrow(JqUnsupportedSyntaxError);
  });
});
