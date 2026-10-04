import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type BashSyntaxNode,
  createBashParser,
  createSpan,
  lexJq,
  parseJq,
} from "@pipe-ls/core";
import { describe, expect, it } from "vitest";
import { isMap, isScalar, isSeq, parseDocument, type Scalar } from "yaml";
import {
  MappedText,
  mapBashSingleQuoted,
  mapYamlScalar,
} from "../src/index.js";

const caseRoot = fileURLToPath(
  new URL("../../../tests/cases/1/", import.meta.url),
);
const require = createRequire(import.meta.url);
const grammarFile = resolve(
  dirname(require.resolve("@vscode/tree-sitter-wasm/package.json")),
  "wasm/tree-sitter-bash.wasm",
);
const runtimeFile = fileURLToPath(
  new URL(
    "../../core/node_modules/web-tree-sitter/web-tree-sitter.wasm",
    import.meta.url,
  ),
);
const grammar = readFileSync(grammarFile);
const runtime = readFileSync(runtimeFile);
const grammarSha256 =
  "a14e9ed880b2c3f16cd00c796c38d237a3e9b028bdec5b4315c76976e67b01ca";
const runtimeSha256 =
  "c03bccdc3b448a32848f5ae327e209c982bbb0840d43eec8bc2d5759544a1ed3";

function fixture(path: string): string {
  return readFileSync(resolve(caseRoot, path), "utf8");
}

function walk(node: BashSyntaxNode): BashSyntaxNode[] {
  return [node, ...node.namedChildren.flatMap(walk)];
}

function jqRawStrings(root: BashSyntaxNode): BashSyntaxNode[] {
  return walk(root)
    .filter(
      (node) =>
        node.type === "command" &&
        node.childForFieldName("name")?.text === "jq",
    )
    .flatMap((node) =>
      node.namedChildren.filter((child) => child.type === "raw_string"),
    );
}

function workflowRuns(source: string): Scalar[] {
  const document = parseDocument(source, {
    keepSourceTokens: true,
    uniqueKeys: true,
  });
  expect(document.errors).toEqual([]);
  const jobs = document.get("jobs", true);
  if (!isMap(jobs)) throw new Error("Workflow jobs must be a map");
  const runs: Scalar[] = [];
  for (const pair of jobs.items) {
    const job = pair.value;
    if (!isMap(job)) continue;
    const steps = job.get("steps", true);
    if (!isSeq(steps)) continue;
    for (const step of steps.items) {
      if (!isMap(step)) continue;
      const run = step.get("run", true);
      if (isScalar(run) && typeof run.value === "string") runs.push(run);
    }
  }
  return runs;
}

describe("P0 Bash/jq/YAML parser and source-map prototype", () => {
  it("pins and loads the MIT Bash WASM asset from caller-supplied bytes", async () => {
    expect(createHash("sha256").update(grammar).digest("hex")).toBe(
      grammarSha256,
    );
    expect(createHash("sha256").update(runtime).digest("hex")).toBe(
      runtimeSha256,
    );
    expect(fixture(".github/scripts/parse-cloud-images.sh")).toContain(
      "# @pipe stdin: string",
    );
    const parser = await createBashParser(runtime, grammar);
    expect(parser.language?.name).toBe("bash");
    parser.delete();
  });

  it("parses both real Bash scripts and every workflow run; parses all 46 static jq filters", async () => {
    const parser = await createBashParser(runtime, grammar);
    try {
      const sources = [
        fixture(".github/scripts/parse-cloud-images.sh"),
        fixture(".github/scripts/update-cloud-images.sh"),
      ];
      const yaml = fixture(".github/workflows/cloud.yaml");
      const runs = workflowRuns(yaml);
      expect(runs).toHaveLength(5);
      sources.push(...runs.map((run) => String(run.value)));
      let filters = 0;
      for (const source of sources) {
        const tree = parser.parse(source);
        expect(tree?.rootNode.hasError).toBe(false);
        if (!tree) throw new Error("Bash parser did not return a tree");
        for (const raw of jqRawStrings(tree.rootNode)) {
          const filter = raw.text.slice(1, -1);
          const syntax = parseJq(filter);
          expect(filter.slice(syntax.span.start, syntax.span.end)).toBe(
            filter.trim(),
          );
          filters++;
        }
        tree.delete();
      }
      expect(filters).toBe(46);
    } finally {
      parser.delete();
    }
  });

  it("recovers Bash errors and uses UTF-16 offsets across emoji and CRLF", async () => {
    const parser = await createBashParser(runtime, grammar);
    try {
      const source = 'echo "中😀"\r\nprintf "%s" hi\n';
      const tree = parser.parse(source);
      expect(tree?.rootNode.hasError).toBe(false);
      expect(tree?.rootNode.namedChildren[1]?.startIndex).toBe(
        source.indexOf("printf"),
      );
      expect(
        source.slice(
          tree?.rootNode.namedChildren[0]?.startIndex,
          tree?.rootNode.namedChildren[0]?.endIndex,
        ),
      ).toBe('echo "中😀"');
      tree?.delete();
      const invalid = parser.parse("if ; then echo x; fi");
      expect(invalid?.rootNode.hasError).toBe(true);
      expect(
        invalid && walk(invalid.rootNode).some((node) => node.type === "ERROR"),
      ).toBe(true);
      invalid?.delete();
    } finally {
      parser.delete();
    }
  });

  it("maps a jq field through Bash quoting and YAML block indentation to the original workflow", async () => {
    const yaml = fixture(".github/workflows/cloud.yaml");
    const run = workflowRuns(yaml)[1];
    if (!run) throw new Error("Missing setup run");
    const mappedRun = mapYamlScalar(yaml, run);
    const parser = await createBashParser(runtime, grammar);
    try {
      const tree = parser.parse(mappedRun.text);
      if (!tree) throw new Error("Missing Bash tree");
      const raw = jqRawStrings(tree.rootNode).find((candidate) =>
        candidate.text.includes(".restart_targets"),
      );
      if (!raw) throw new Error("Missing restart_targets jq filter");
      const mappedFilter = mapBashSingleQuoted(
        mappedRun,
        createSpan(raw.startIndex, raw.endIndex),
      );
      if (!mappedFilter) throw new Error("Expected Bash single-quoted filter");
      const field = lexJq(mappedFilter.text).find(
        (token) => token.value === "restart_targets",
      );
      if (!field) throw new Error("Missing jq field token");
      const origin = mappedFilter.mapSpan(field.span);
      expect(origin.precision).toBe("exact");
      expect(yaml.slice(origin.span.start, origin.span.end)).toBe(
        "restart_targets",
      );
      expect(yaml.slice(0, origin.span.start).split("\n")).toHaveLength(79);
      tree.delete();
    } finally {
      parser.delete();
    }
  });

  it("marks folded, escaped and CRLF-derived ranges non-exact while preserving exact subspans", () => {
    for (const [source, expected, fragment, precision] of [
      ["v: 'it''s ok'\n", "it's ok", "'", "decoded"],
      ['v: "hi\\n😀"\n', "hi\n😀", "\n", "decoded"],
      ["v: >-\n  hello\n  world\n", "hello world", " ", "decoded"],
      ["v: |\r\n  中😀\r\n  next\r\n", "中😀\nnext\n", "\n", "decoded"],
    ] as const) {
      const scalar = parseDocument(source, { keepSourceTokens: true }).get(
        "v",
        true,
      );
      if (!isScalar(scalar)) throw new Error("Expected YAML scalar");
      const mapped = mapYamlScalar(source, scalar);
      expect(mapped.text).toBe(expected);
      const at = mapped.text.indexOf(fragment);
      expect(
        mapped.mapSpan(createSpan(at, at + fragment.length)).precision,
      ).toBe(precision);
    }
    const source = "v: |\r\n  中😀\r\n  next\r\n";
    const scalar = parseDocument(source, { keepSourceTokens: true }).get(
      "v",
      true,
    );
    if (!isScalar(scalar)) throw new Error("Expected YAML scalar");
    const mapped = mapYamlScalar(source, scalar);
    const emoji = mapped.text.indexOf("😀");
    const exact = mapped.mapSpan(createSpan(emoji, emoji + 2));
    expect(exact.precision).toBe("exact");
    expect(source.slice(exact.span.start, exact.span.end)).toBe("😀");
    expect(mapped.mapSpan(createSpan(0, mapped.text.length)).precision).toBe(
      "decoded",
    );
    expect(MappedText.identity("😀").mapSpan(createSpan(0, 2)).span).toEqual({
      start: 0,
      end: 2,
    });
  });

  it("maps the real folded condition and a plain GitHub expression without pretending folds are editable", () => {
    const source = fixture(".github/workflows/cloud.yaml");
    const document = parseDocument(source, { keepSourceTokens: true });
    const folded = document.getIn(["jobs", "restart_huaweicloud", "if"], true);
    const plain = document.getIn(["concurrency", "group"], true);
    if (!isScalar(folded) || !isScalar(plain))
      throw new Error("Expected workflow scalar values");
    const foldedMap = mapYamlScalar(source, folded);
    const name = "needs.update.outputs.restart_targets";
    const start = foldedMap.text.indexOf(name);
    const field = foldedMap.mapSpan(createSpan(start, start + name.length));
    expect(field.precision).toBe("exact");
    expect(source.slice(field.span.start, field.span.end)).toBe(name);
    expect(
      foldedMap.mapSpan(createSpan(0, foldedMap.text.length)).precision,
    ).toBe("decoded");
    const plainMap = mapYamlScalar(source, plain);
    const expression = `\${{ github.workflow }}`;
    const at = plainMap.text.indexOf(expression);
    const origin = plainMap.mapSpan(createSpan(at, at + expression.length));
    expect(origin.precision).toBe("exact");
    expect(source.slice(origin.span.start, origin.span.end)).toBe(expression);
  });
});

interface MatrixCase {
  id: string;
  kind: "positive" | "negative" | "blocked";
  entry: string;
  input?: { environment: string; images: string; distinct_id?: string };
  requires?: string[];
  mutation?: {
    target: string;
    search?: string;
    replace?: string;
    removeLineStarting?: string;
  };
  snippet?: string;
  missingDependency?: string;
  expectedCodes?: string[];
  expectedFacts: string[];
}

function materializeMutation(scenario: MatrixCase): {
  target: string;
  source: string;
} {
  const mutation = scenario.mutation;
  if (!mutation) throw new Error(`Missing mutation for ${scenario.id}`);
  const original = fixture(mutation.target);
  if (mutation.removeLineStarting) {
    const lines = original.split("\n");
    const matching = lines.filter((line) =>
      line.startsWith(mutation.removeLineStarting ?? ""),
    );
    expect(matching, scenario.id).toHaveLength(1);
    return {
      target: mutation.target,
      source: lines
        .filter((line) => !line.startsWith(mutation.removeLineStarting ?? ""))
        .join("\n"),
    };
  }
  if (!mutation.search || mutation.replace === undefined)
    throw new Error(`Incomplete mutation for ${scenario.id}`);
  expect(original.split(mutation.search), scenario.id).toHaveLength(2);
  return {
    target: mutation.target,
    source: original.replace(mutation.search, mutation.replace),
  };
}

describe("case 1 scenario matrix", () => {
  const matrix = JSON.parse(fixture("matrix.json")) as {
    schemaVersion: number;
    cases: MatrixCase[];
  };

  it("has distinct positive, negative and blocked oracles tied to real fixture paths", () => {
    expect(matrix.schemaVersion).toBe(1);
    expect(new Set(matrix.cases.map((scenario) => scenario.id)).size).toBe(
      matrix.cases.length,
    );
    expect(
      matrix.cases.filter((scenario) => scenario.kind === "positive"),
    ).toHaveLength(5);
    expect(
      matrix.cases.filter((scenario) => scenario.kind === "negative"),
    ).toHaveLength(15);
    expect(
      matrix.cases.filter((scenario) => scenario.kind === "blocked"),
    ).toHaveLength(5);
    for (const scenario of matrix.cases) {
      expect(scenario.id).toMatch(/^[a-z][a-z0-9-]+$/u);
      expect(scenario.entry.startsWith(".github/")).toBe(true);
      expect(fixture(scenario.entry).length).toBeGreaterThan(0);
      expect(scenario.expectedFacts.length).toBeGreaterThan(0);
      if (scenario.kind !== "positive")
        expect(
          scenario.expectedCodes?.every((code) => /^PIPE\d{3}$/u.test(code)),
        ).toBe(true);
    }
  });

  it("keeps positive references allowlisted and JSON environment examples lossless", () => {
    const rows = fixture(".github/scripts/cloud-image-allowlist.tsv")
      .split("\n")
      .filter((line) => line && !line.startsWith("#"))
      .map((line) => line.split("\t"));
    for (const scenario of matrix.cases.filter(
      (item) => item.kind === "positive",
    )) {
      const input = scenario.input;
      if (!input) throw new Error(`Missing input for ${scenario.id}`);
      expect(scenario.requires, scenario.id).toEqual([
        "synthetic-overlays",
        "real-reusable-workflow",
        "synthetic-tool-pins",
      ]);
      expect(JSON.parse(JSON.stringify(input))).toEqual(input);
      for (const reference of input.images.split(",")) {
        const at = reference.indexOf("@sha256:");
        const repository =
          at >= 0
            ? reference.slice(0, at)
            : reference.slice(0, reference.lastIndexOf(":"));
        expect(
          rows.filter((row) => row[2] === repository),
          scenario.id,
        ).toHaveLength(1);
      }
    }
    expect(
      matrix.cases.find((item) => item.id === "special-chars-env")?.input
        ?.distinct_id,
    ).toContain("😀");
  });

  it("materializes every mutation or snippet without accidentally introducing syntax errors", async () => {
    const parser = await createBashParser(runtime, grammar);
    try {
      for (const scenario of matrix.cases.filter(
        (item) => item.kind !== "positive",
      )) {
        const missingDependency = scenario.missingDependency;
        if (missingDependency) {
          expect(() => fixture(missingDependency), scenario.id).toThrow();
          if (!scenario.mutation) continue;
        }
        const target = scenario.mutation?.target ?? scenario.entry;
        const source = scenario.mutation
          ? materializeMutation(scenario).source
          : scenario.snippet;
        if (!source) throw new Error(`No scenario source for ${scenario.id}`);
        if (target.endsWith(".yaml")) {
          const doc = parseDocument(source, { keepSourceTokens: true });
          expect(doc.errors, scenario.id).toEqual([]);
          if (scenario.mutation) {
            for (const run of workflowRuns(source)) {
              const tree = parser.parse(String(run.value));
              expect(tree?.rootNode.hasError, scenario.id).toBe(false);
              tree?.delete();
            }
          }
        } else {
          const tree = parser.parse(source);
          expect(tree?.rootNode.hasError, scenario.id).toBe(false);
          if (tree) {
            for (const raw of jqRawStrings(tree.rootNode)) {
              expect(
                () => parseJq(raw.text.slice(1, -1)),
                scenario.id,
              ).not.toThrow();
            }
          }
          tree?.delete();
        }
      }
    } finally {
      parser.delete();
    }
  });
});
