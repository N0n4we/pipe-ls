import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  analyzeScript,
  createBashParser,
  isAssignable,
  parseTemplate,
  templateOfJson,
} from "../src/index.js";

const require = createRequire(import.meta.url);
const grammar = readFileSync(
  resolve(
    dirname(require.resolve("@vscode/tree-sitter-wasm/package.json")),
    "wasm/tree-sitter-bash.wasm",
  ),
);
const runtime = readFileSync(
  resolve(dirname(require.resolve("web-tree-sitter")), "web-tree-sitter.wasm"),
);

const version = spawnSync("jq", ["--version"], {
  encoding: "utf8",
  timeout: 1000,
}).stdout?.trim();
const reference = version === "jq-1.8.2" ? it : it.skip;

describe("pinned jq 1.8.2 semantic reference", () => {
  reference(
    "keeps bounded case 1 jq inferences sound against generated inputs",
    async () => {
      const parser = await createBashParser(runtime, grammar);
      let seed = 0x50495045;
      const next = (): number => {
        seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
        return seed;
      };
      const platforms = ["aws", "huaweicloud", "other"];
      const names = ["frontend", "backend", "portal"];
      const scenarios = [
        {
          stdin: '{"images":[{"platform":string}]}',
          stdout: "[string]",
          wrongStdout: "[number]",
          filter:
            "reduce .images[] as $v ([]; if index($v.platform) == null then . + [$v.platform] else . end)",
          input: () => ({
            images: Array.from({ length: next() % 7 }, () => ({
              platform: platforms[next() % platforms.length],
            })),
          }),
        },
        {
          stdin: '{"items":[{"n":number}]}',
          stdout: "[number]",
          wrongStdout: "string",
          filter: "[.items[] | .n]",
          input: () => ({
            items: Array.from({ length: next() % 7 }, () => ({
              n: (next() % 31) - 15,
            })),
          }),
        },
        {
          stdin: '{"flag":boolean,"a":number,"b":number}',
          stdout: "number",
          wrongStdout: "boolean",
          filter: "if .flag then .a else .b end",
          input: () => ({
            flag: next() % 2 === 0,
            a: (next() % 31) - 15,
            b: (next() % 31) - 15,
          }),
        },
        {
          stdin: '{"images":[{"platform":string,"image_name":string}]}',
          stdout: "boolean",
          wrongStdout: "number",
          filter:
            ".images as $images | ($images | map([.platform, .image_name])) as $targets | ($targets | length) == ($targets | unique | length)",
          input: () => ({
            images: Array.from({ length: next() % 7 }, () => ({
              platform: platforms[next() % platforms.length],
              image_name: names[next() % names.length],
            })),
          }),
        },
      ];
      try {
        for (const scenario of scenarios) {
          const source = `# @pipe stdin: ${scenario.stdin}\n# @pipe stdout: ${scenario.stdout}\njq -c '${scenario.filter}'\n`;
          const analysis = analyzeScript(source, parser);
          expect(analysis.complete, scenario.filter).toBe(true);
          expect(analysis.diagnostics, scenario.filter).toEqual([]);
          const mismatched = analyzeScript(
            source.replace(
              `# @pipe stdout: ${scenario.stdout}`,
              `# @pipe stdout: ${scenario.wrongStdout}`,
            ),
            parser,
          );
          expect(mismatched.complete, scenario.filter).toBe(false);
          const expected = parseTemplate(scenario.stdout);
          for (let sample = 0; sample < 32; sample++) {
            const input = scenario.input();
            const actual = spawnSync("jq", ["-c", scenario.filter], {
              input: `${JSON.stringify(input)}\n`,
              encoding: "utf8",
              timeout: 1000,
            });
            expect(
              actual.status,
              `${scenario.filter}: ${JSON.stringify(input)}`,
            ).toBe(0);
            const lines = actual.stdout.trimEnd().split("\n");
            expect(lines, scenario.filter).toHaveLength(1);
            expect(
              isAssignable(
                templateOfJson(JSON.parse(lines[0] ?? "")),
                expected,
              ),
              `${scenario.filter}: ${JSON.stringify(input)}`,
            ).toBe(true);
          }
        }
      } finally {
        parser.delete();
      }
    },
    15_000,
  );

  reference(
    "distinguishes empty streams, collections and raw string output",
    () => {
      const cases = [
        { args: ["-n", "empty"], output: "" },
        { args: ["-n", "[empty]"], output: "[]\n" },
        { args: ["-n", "1, 2"], output: "1\n2\n" },
        { args: ["-n", "[1, 2]"], output: "[\n  1,\n  2\n]\n" },
        { args: ["-n", "(null, 1) // 2"], output: "1\n" },
        { args: ["-n", "(false, null) // 2"], output: "2\n" },
        { args: ["-nc", "{id: (1, 2)}"], output: '{"id":1}\n{"id":2}\n' },
        { args: ["-n", "null | length"], output: "0\n" },
        { args: ["-n", "null | type"], output: '"null"\n' },
        { args: ["-nr", '"Alice"'], output: "Alice\n" },
        { args: ["-n", "--argjson", "v", "true", "$v"], output: "true\n" },
        { args: ["-n", "--arg", "v", "true", "$v"], output: '"true"\n' },
        { args: ["-nc", "[1] + [2]"], output: "[1,2]\n" },
        { args: ["-nc", '{a: 1} + {b: "x"}'], output: '{"a":1,"b":"x"}\n' },
        { args: ["-n", "1 == 1 and true"], output: "true\n" },
        { args: ["-n", 'if false then 1 else "x" end'], output: '"x"\n' },
        {
          args: ["-nc", '{"x":4} | .x as $v | {v: $v}'],
          output: '{"v":4}\n',
        },
      ];
      for (const item of cases) {
        const result = spawnSync("jq", item.args, {
          encoding: "utf8",
          timeout: 1000,
        });
        expect(result.status, item.args.join(" ")).toBe(0);
        expect(result.stdout, item.args.join(" ")).toBe(item.output);
      }
      const mapped = spawnSync("jq", ["map(empty)"], {
        input: "[1,2]\n",
        encoding: "utf8",
        timeout: 1000,
      });
      expect(mapped.status).toBe(0);
      expect(mapped.stdout).toBe("[]\n");
      const slurped = spawnSync("jq", ["-s", "."], {
        input: "",
        encoding: "utf8",
        timeout: 1000,
      });
      expect(slurped.status).toBe(0);
      expect(slurped.stdout).toBe("[]\n");
      const invalidArgjson = spawnSync(
        "jq",
        ["-n", "--argjson", "v", "1 2", "$v"],
        {
          encoding: "utf8",
          timeout: 1000,
        },
      );
      expect(invalidArgjson.status).not.toBe(0);
      const invalidBuiltin = spawnSync("jq", ["-n", "null | ascii_upcase"], {
        encoding: "utf8",
        timeout: 1000,
      });
      expect(invalidBuiltin.status).not.toBe(0);
      const reduced = spawnSync(
        "jq",
        [
          "-c",
          "reduce .[] as $v ([]; if index($v.platform) == null then . + [$v.platform] else . end)",
        ],
        {
          input: '[{"platform":"aws"},{"platform":"aws"}]\n',
          encoding: "utf8",
          timeout: 1000,
        },
      );
      expect(reduced.status).toBe(0);
      expect(reduced.stdout).toBe('["aws"]\n');
    },
  );
});
