import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const version = spawnSync("jq", ["--version"], {
  encoding: "utf8",
  timeout: 1000,
}).stdout?.trim();
const reference = version === "jq-1.8.2" ? it : it.skip;

describe("pinned jq 1.8.2 semantic reference", () => {
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
