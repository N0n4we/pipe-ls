import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, posix, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  analyzeScript,
  createBashParser,
  parseScriptContract,
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

describe("conservative Bash/jq vertical slice", () => {
  it("models only the shared ASCII graphic jq test and keeps known blank values unreachable", async () => {
    const parser = await createBashParser(runtime, grammar);
    try {
      for (const [value, expected] of [
        ["", false],
        [" \t\n\uFEFF", false],
        ["中文", false],
        [" + ", true],
        ["key", true],
      ] as const) {
        const script = `# @pipe stdout: ${expected}\njq -n '${JSON.stringify(value)} | test("[!-~]")'\n`;
        expect(analyzeScript(script, parser).diagnostics).toEqual([]);
      }
      for (const filter of [
        'test(".+")',
        'test("[!-~]"; "i")',
        "test($pattern)",
        'test("[!-~]")?',
      ]) {
        const result = analyzeScript(
          `# @pipe stdin: string\njq '${filter}'\n`,
          parser,
        );
        expect(result.complete).toBe(false);
      }
      const knownBlank = analyzeScript(
        `set -e\nkey="$(jq -ner --arg key '  ' '$key | select(test("[!-~]"))')"\nprintf '%s' "$key"\n`,
        parser,
      );
      expect(knownBlank.complete).toBe(false);
      expect(
        knownBlank.diagnostics.some(
          (issue) => issue.message === "No successful Bash path remains",
        ),
      ).toBe(true);
    } finally {
      parser.delete();
    }
  });

  it("exports nonblank payload facts only from direct checked guards, not OR, other bindings, mutations or one-sided branches", async () => {
    const parser = await createBashParser(runtime, grammar);
    try {
      const excluded =
        'index("\\n") == null and index("\\r") == null and index("\\u0000") == null';
      const source = (predicate: string, tail = "") =>
        `# @pipe env KEY: string\nset -euo pipefail\nkey="$(jq -er --arg other 'OTHER' 'select(${predicate} and ${excluded})' <<< "$KEY")"\n${tail}printf 'KEY=%s\\n' "$key" >> "$GITHUB_OUTPUT"\n`;
      const result = analyzeScript(source('test("[!-~]")'), parser, {
        githubFiles: true,
      });
      expect(result.diagnostics).toEqual([]);
      expect(result.effects.githubOutput.KEY).toMatchObject({
        encoded: false,
        singleLine: true,
        nonBlank: true,
      });
      for (const [predicate, tail] of [
        ['(test("[!-~]") or true)', ""],
        ['($other | test("[!-~]"))', ""],
        ["true", ""],
        ['test("[!-~]")', "key='  '\n"],
        ['test("[!-~]")', 'if [[ "$KEY" == "alternate" ]]; then key=" "; fi\n'],
      ] as const) {
        const checked = analyzeScript(source(predicate, tail), parser, {
          githubFiles: true,
        });
        expect(checked.effects.githubOutput.KEY?.nonBlank).toBeUndefined();
      }
      const unChecked = analyzeScript(
        source('test("[!-~]")').replace("set -euo pipefail\n", ""),
        parser,
        { githubFiles: true },
      );
      expect(unChecked.complete).toBe(false);
      expect(unChecked.effects.githubOutput.KEY).toBeUndefined();
      // JSON wire nonblank bytes do not imply its decoded string is nonblank.
      const wire = analyzeScript(
        `# @pipe env KEY: string\nset -e\nkey="$(jq -er '.' <<< "$KEY")"\nprintf 'KEY=%s\\n' "$key" >> "$GITHUB_OUTPUT"\n`,
        parser,
        {
          githubFiles: true,
          environment: {
            KEY: {
              type: { kind: "primitive", name: "string" },
              encoded: true,
              nonBlank: true,
            },
          },
        },
      );
      expect(wire.effects.githubOutput.KEY?.nonBlank).toBeUndefined();
    } finally {
      parser.delete();
    }
  });

  it("models fixed Huawei configuration and version families without exposing credentials or returning logs as JSON", async () => {
    const parser = await createBashParser(runtime, grammar);
    try {
      const configure = `hcloud configure set --cli-access-key="$AK" --cli-secret-key="$SK" --cli-region=cn-east-3 --cli-project-id=synthetic --cli-warning=false --cli-agree-privacy-statement=true`;
      const source = `set -e\nAK='STATIC-ONLY key 中文'\nSK='STATIC-ONLY secret --not-an-option'\n${configure}\nhcloud version\n`;
      const result = analyzeScript(source, parser);
      expect(result.diagnostics).toEqual([]);
      expect(result.effects.externalMayRun).toEqual([
        "hcloud configure set",
        "hcloud version",
      ]);
      expect(result.effects.filesMayWriteUnknown).toBe(true);
      expect(JSON.stringify(result)).not.toContain("STATIC-ONLY secret");
      for (const invalid of [
        source.replace("set -e\n", ""),
        source.replace('--cli-access-key="$AK"', "--cli-access-key=$AK"),
        source.replace(
          '--cli-secret-key="$SK"',
          '--cli-secret-key="$(DO_NOT_EXECUTE)"',
        ),
        source.replace(
          '--cli-secret-key="$SK"',
          `--cli-secret-key="\${SK:-fallback}"`,
        ),
        source.replace(
          '--cli-secret-key="$SK"',
          `--cli-secret-key="\${SK[@]}"`,
        ),
        source.replace('--cli-secret-key="$SK"', "--cli-secret-key=*.txt"),
        source.replace('--cli-secret-key="$SK"', '--cli-secret-key="$MISSING"'),
        source.replace('--cli-secret-key="$SK" ', ""),
        source.replace("--cli-warning=false", "--cli-warning=true"),
        source.replace(
          "--cli-agree-privacy-statement=true",
          "--cli-agree-privacy-statement=false",
        ),
        source.replace(
          "--cli-warning=false",
          "--cli-warning=false --cli-warning=false",
        ),
        source.replace("--cli-warning=false", "--cli-debug=true"),
        source.replace("hcloud configure set", "hcloud configure init"),
        `${source}value=$(hcloud version)\n`,
        `${source}hcloud version | jq '.'\n`,
        `${source}hcloud version --help\n`,
        `${source}hcloud update\n`,
        `# @pipe stdout: string\n${source}`,
      ]) {
        const checked = analyzeScript(invalid, parser);
        expect(checked.complete, invalid).toBe(false);
        expect(
          checked.diagnostics.map((issue) => issue.code),
          invalid,
        ).toContain("PIPE202");
        expect(JSON.stringify(checked), invalid).not.toContain(
          "STATIC-ONLY secret",
        );
      }
      expect(analyzeScript("set -e\nhcloud version\n", parser).complete).toBe(
        true,
      );
    } finally {
      parser.delete();
    }
  });

  it("models a verified Huawei CCE projection without dropping clusters with missing UIDs or inferring a closed API response", async () => {
    const parser = await createBashParser(runtime, grammar);
    try {
      const setup =
        "hcloud configure set --cli-warning=false --cli-agree-privacy-statement=true > /dev/null";
      const query =
        "hcloud cce ListClusters/v3 --cli-region=cn-east-3 --project_id=synthetic --cli-output=json --cli-query='{items: items[*].{uid: metadata.uid}}'";
      const source = `# @pipe stdout: {"items": [{"uid": string | null}] | null}\nset -euo pipefail\n${setup}\n${query}\n`;
      const direct = analyzeScript(source, parser);
      expect(direct.diagnostics).toEqual([]);
      expect(direct.effects.externalMayRun).toEqual([
        "hcloud cce ListClusters",
        "hcloud configure set",
      ]);
      expect(direct.effects.filesMayWriteUnknown).toBe(true);
      const selected = `# @pipe stdout: string\nset -euo pipefail\n${setup}\nclusters=$(${query})\nid=$(printf '%s\\n' "$clusters" | jq -er '(.items // []) as $items | if ($items | type) == "array" and ($items | length) == 1 then $items[0].uid | select(type == "string" and length > 0) else error("expected one") end')\njq -n --arg id "$id" '$id'\n`;
      expect(analyzeScript(selected, parser).diagnostics).toEqual([]);
      expect(
        analyzeScript(
          selected.replace("# @pipe stdout: string", "# @pipe stdout: number"),
          parser,
        ).diagnostics.map((issue) => issue.code),
      ).toContain("PIPE102");
      expect(
        analyzeScript(
          source.replace('"uid": string | null', '"uid": string'),
          parser,
        ).diagnostics.map((issue) => issue.code),
      ).toContain("PIPE102");
      expect(
        analyzeScript(
          selected.replace("$items[0].uid", "$items[0].metadata.uid"),
          parser,
        ).diagnostics.map((issue) => issue.code),
      ).toContain("PIPE102");
      for (const invalid of [
        source.replace(`${setup}\n`, ""),
        source.replace("set -euo pipefail\n", ""),
        source.replace(" > /dev/null", ""),
        source.replace("ListClusters/v3", "ListClusters"),
        source.replace("ListClusters/v3", "ListClusters/v2"),
        source.replace("--cli-output=json", "--cli-output=table"),
        source.replace("--cli-output=json ", ""),
        source.replace("--project_id=synthetic ", ""),
        source.replace(
          "--cli-query='{items: items[*].{uid: metadata.uid}}'",
          "--cli-query='items[*].metadata.uid'",
        ),
        source.replace(
          "--cli-query='{items: items[*].{uid: metadata.uid}}'",
          '--cli-query="$QUERY"',
        ),
        source.replace("--cli-region=cn-east-3", "--cli-region=$REGION"),
        source.replace(`${query}\n`, `${query} --cli-warning=false\n`),
        source.replace(`${query}\n`, `${query} --cli-output=json\n`),
        source.replace(`${query}\n`, `HCLOUD_TEST=1 ${query}\n`),
        source.replace(`${query}\n`, `${query} <<< 'null'\n`),
        source.replace(`${query}\n`, `${query} || true\n`),
        selected.replace("set -euo pipefail", "set -e"),
        selected.replace("clusters=$(", "export clusters=$("),
        `set -e\n${setup}\nprintf '%s\\n' "$(${query})"\n`,
      ]) {
        const result = analyzeScript(invalid, parser);
        expect(result.complete, invalid).toBe(false);
        expect(
          result.diagnostics.map((issue) => issue.code),
          invalid,
        ).toContain("PIPE202");
      }
    } finally {
      parser.delete();
    }
  });

  it("does not retain Huawei warning/privacy settings across unverified writes, changed exported environments or missing branches", async () => {
    const parser = await createBashParser(runtime, grammar);
    try {
      const setup =
        "hcloud configure set --cli-warning=false --cli-agree-privacy-statement=true > /dev/null";
      const query =
        "hcloud CCE ListClusters/v3 --cli-region=cn-east-3 --project_id=synthetic --cli-output=json --cli-query='{items: items[*].{uid: metadata.uid}}'";
      for (const middle of [
        "mkdir -p -- '/tmp/synthetic'\n",
        "printf 'synthetic' > '/tmp/synthetic'\n",
        "export HOME='/different-home'\n",
        "export HCLOUD_TEST='different-env'\n",
      ]) {
        const result = analyzeScript(
          `set -e\n${setup}\n${middle}${query}\n`,
          parser,
        );
        expect(result.complete, middle).toBe(false);
        expect(
          result.diagnostics.some((issue) =>
            issue.message.includes("warning/privacy"),
          ),
          middle,
        ).toBe(true);
        expect(
          analyzeScript(
            `set -e\n${setup}\n${middle}${setup}\n${query}\n`,
            parser,
          ).complete,
          middle,
        ).toBe(true);
      }
      const branch = `# @pipe env CONDITION: boolean\nset -e\nif [[ "$CONDITION" == true ]]; then\n${setup}\nfi\n${query}\n`;
      expect(analyzeScript(branch, parser).complete).toBe(false);
      expect(
        analyzeScript(branch.replace("fi\n", `else\n${setup}\nfi\n`), parser)
          .complete,
      ).toBe(true);
      expect(
        analyzeScript(
          `set -e\n${setup}\nhcloud() { exit 1; }\n${query}\n`,
          parser,
        ).complete,
      ).toBe(false);
      const unread = analyzeScript(
        `# @pipe stdin: number\n# @pipe stdout: number\nset -e\n${setup}\nclusters=$(${query})\njq '.'\n`,
        parser,
      );
      expect(unread.complete).toBe(false);
      expect(unread.diagnostics.map((issue) => issue.code)).toContain(
        "PIPE103",
      );
    } finally {
      parser.delete();
    }
  });

  it("summarizes opaque Huawei certificate output and native file writes without proving kubeconfig contents", async () => {
    const parser = await createBashParser(runtime, grammar);
    try {
      const command =
        'hcloud cce CreateKubernetesClusterCert/v3 --cli-region=cn-east-3 --project_id=synthetic --cli-output=json --cluster_id="$ID" --duration=1825';
      const source = `set -e\nID='synthetic id 中文 --not-an-option'\n${command} > '/tmp/SYNTHETIC-CERT-NEVER-WRITE'\n`;
      const result = analyzeScript(source, parser);
      expect(result.diagnostics).toEqual([]);
      expect(result.effects.externalMayRun).toEqual([
        "hcloud cce CreateKubernetesClusterCert",
      ]);
      expect(result.effects.filesMayWrite).toEqual([
        "/tmp/SYNTHETIC-CERT-NEVER-WRITE",
      ]);
      expect(result.effects.filesMayWriteUnknown).toBe(true);
      for (const invalid of [
        source.replace("set -e\n", ""),
        source.replace('--cluster_id="$ID"', "--cluster_id=$ID"),
        source.replace(
          '--cluster_id="$ID"',
          '--cluster_id="$(DO_NOT_EXECUTE)"',
        ),
        source.replace("--duration=1825", "--duration=0"),
        source.replace("--duration=1825", "--duration=1828"),
        source.replace("--duration=1825", "--duration=-2"),
        source.replace("--duration=1825", "--duration=unknown"),
        source.replace(
          "--duration=1825",
          "--duration=1825 --cli-warning=false",
        ),
        source.replace(
          "CreateKubernetesClusterCert/v3",
          "CreateKubernetesClusterCert",
        ),
        `# @pipe stdout: string\nset -e\nID=synthetic\n${command}\n`,
        `set -e\nID=synthetic\ncert=$(${command})\n`,
        `set -euo pipefail\nID=synthetic\n${command} | jq '.'\n`,
      ])
        expect(analyzeScript(invalid, parser).complete, invalid).toBe(false);
      for (const duration of ["1", "1827", "-1"])
        expect(
          analyzeScript(
            source.replace("--duration=1825", `--duration=${duration}`),
            parser,
          ).complete,
        ).toBe(true);
    } finally {
      parser.delete();
    }
  });

  it("refines jq root type guards without borrowing facts from fields, constants, OR or a later predicate", async () => {
    const parser = await createBashParser(runtime, grammar);
    try {
      for (const filter of [
        'select(type == "string" and length > 0)',
        'select("string" == type and length > 0)',
        'select(type != "null" and length > 0)',
        'select((type == "string") and length > 0)',
      ])
        expect(
          analyzeScript(
            `# @pipe stdin: string | null\n# @pipe stdout: string\nset -e\nvalue=$(jq -e '${filter}')\njq '.' <<< "$value"\n`,
            parser,
          ).diagnostics,
          filter,
        ).toEqual([]);
      for (const filter of [
        'select(type == "string" or length == 0)',
        'select("string" == "string")',
        'select(type != "number")',
        'select(.value | type == "string")',
      ]) {
        const object = filter.includes(".value")
          ? '{"value": string}'
          : "string | null";
        const result = analyzeScript(
          `# @pipe stdin: ${object}\n# @pipe stdout: string\njq '${filter} | ascii_upcase'\n`,
          parser,
        );
        expect(result.complete, filter).toBe(false);
        expect(
          result.diagnostics.map((issue) => issue.code),
          filter,
        ).toContain("PIPE102");
      }
      expect(
        analyzeScript(
          `# @pipe stdin: string | boolean\njq 'select(type == "string" and ascii_upcase == "X")'\n`,
          parser,
        ).complete,
      ).toBe(true);
      expect(
        analyzeScript(
          `# @pipe stdin: string | boolean\njq 'select(ascii_upcase == "X" and type == "string")'\n`,
          parser,
        ).complete,
      ).toBe(false);
    } finally {
      parser.delete();
    }
  });

  it("models checked mktemp paths without creating files or guessing random bytes", async () => {
    const parser = await createBashParser(runtime, grammar);
    try {
      for (const source of [
        `set -e\nfile="$(mktemp -- "\${RUNNER_TEMP}/file.XXXXXX")"\n`,
        `set -e\ndir="$(mktemp -d -- "\${RUNNER_TEMP}/dir.XXXXXX")"\n`,
        'set -e\ntemplate=\'space 中文\\path.XXXXXX\'\nfile="$(mktemp -- "$template")"\n',
        "# @pipe stdout: string\nset -e\nfile=\"$(mktemp -- 'file.XXXXXX')\"\njq -cn --arg file \"$file\" '$file'\n",
      ]) {
        const result = analyzeScript(source, parser, { githubFiles: true });
        expect(result.diagnostics, source).toEqual([]);
        expect(result.effects.filesMayWrite).toEqual([]);
        expect(result.effects.filesMayWriteUnknown).toBe(true);
        expect(result.effects.externalMayRun).toHaveLength(1);
      }
      for (const source of [
        "file=$(mktemp -- 'file.XXXXXX')\n",
        "set -e\nexport file=$(mktemp -- 'file.XXXXXX')\n",
        "set -e\nfile=$(mktemp -u -- 'file.XXXXXX')\n",
        "set -e\nfile=$(mktemp 'file.XXXXXX')\n",
        "set -e\nfile=$(mktemp -- 'file.XXX')\n",
        `set -e\nfile=$(mktemp -- "\${RUNNER_TEMP}/$XXXXXX")\n`,
        "set -e\nmktemp -- 'file.XXXXXX' | jq '.'\n",
      ]) {
        expect(
          analyzeScript(source, parser, { githubFiles: true }).complete,
          source,
        ).toBe(false);
      }
    } finally {
      parser.delete();
    }
  });

  it("models the hardened filesystem installation chain as may-effects, not trusted archive contents", async () => {
    const parser = await createBashParser(runtime, grammar);
    try {
      const source = `set -euo pipefail
archive="\${RUNNER_TEMP}/archive.tar.gz"
dir="$(mktemp -d -- "\${RUNNER_TEMP}/directory.XXXXXX")"
trap 'rm -rf -- "$dir"' EXIT
export TAR_OPTIONS=''
tar --extract --gzip --file "$archive" --directory "$dir" --no-same-owner --no-same-permissions
sudo -n -- install -m 0755 -- "$dir/hcloud" /usr/local/bin/hcloud
`;
      const result = analyzeScript(source, parser, {
        githubFiles: true,
        readLocalFile: () => {
          throw new Error(
            "Filesystem signature must not read real archive contents",
          );
        },
      });
      expect(result.diagnostics).toEqual([]);
      expect(result.effects.filesMayWrite).toEqual(["/usr/local/bin/hcloud"]);
      expect(result.effects.filesMayWriteUnknown).toBe(true);
      expect(result.effects.externalMayRun).toEqual([
        "mktemp directory",
        "rm directory",
        "sudo install file",
        "tar extract",
      ]);
      for (const invalid of [
        source.replace("set -euo pipefail\n", ""),
        source.replace("export TAR_OPTIONS=''\n", ""),
        source.replace("export TAR_OPTIONS=''", "TAR_OPTIONS=''"),
        source.replace(
          "export TAR_OPTIONS=''",
          "export TAR_OPTIONS='--checkpoint-action=exec=DO_NOT_RUN'",
        ),
        source.replace('--file "$archive"', "--file '-'"),
        source.replace(
          '"$dir" --no-same-owner',
          "'/guessed-directory' --no-same-owner",
        ),
        source.replace("--no-same-owner", "--checkpoint=1"),
        source.replace("sudo -n --", "sudo --"),
        source.replace("install -m 0755 --", "install -m 0777 --"),
        source.replace('"$dir/hcloud"', "$dir/hcloud"),
        source.replace(
          "trap 'rm -rf -- \"$dir\"' EXIT",
          "trap 'rm -rf -- \"$dir\"; unknown-command' EXIT",
        ),
        `${source}dir='/guessed-directory'\n`,
        `${source}for dir in other; do printf 'ignored\\n'; done\n`,
        `${source}rm() { exit 1; }\n`,
        `${source}yq eval -o=json '.namespace' project.yaml\n`,
      ]) {
        const rejected = analyzeScript(invalid, parser, { githubFiles: true });
        expect(rejected.complete, invalid).toBe(false);
        expect(
          rejected.diagnostics.map((item) => item.code),
          invalid,
        ).toContain("PIPE202");
      }
      const directInstall = analyzeScript(
        "set -e\ninstall -m 0755 -- '/tmp/synthetic' '/tmp/destination'\n",
        parser,
      );
      expect(directInstall.diagnostics).toEqual([]);
      expect(directInstall.effects.filesMayWrite).toEqual(["/tmp/destination"]);
      expect(directInstall.effects.filesMayWriteUnknown).toBe(true);
    } finally {
      parser.delete();
    }
  });

  it("models file staging, size guards and deferred cleanup without promising a valid kubeconfig or definite deletion", async () => {
    const parser = await createBashParser(runtime, grammar);
    try {
      const source = `set -euo pipefail
mkdir -p -- "$HOME/.kube"
file="$(mktemp -- "$HOME/.kube/config.XXXXXX")"
trap 'rm -f -- "$file"' EXIT
printf 'SYNTHETIC CONFIG\\n' > "$file"
test -s "$file"
mv -f -- "$file" "$HOME/.kube/config"
`;
      const result = analyzeScript(source, parser, { githubFiles: true });
      expect(result.diagnostics).toEqual([]);
      expect(result.effects.filesMayWrite).toEqual([]);
      expect(result.effects.filesMayWriteUnknown).toBe(true);
      expect(result.effects.externalMayRun).toEqual([
        "mkdir directory",
        "mktemp file",
        "mv file",
        "rm file",
        "test file size",
      ]);
      for (const invalid of [
        source.replace("mkdir -p --", "mkdir -p"),
        source.replace("mv -f --", "mv --"),
        source.replace("test -s", "test -e"),
        source.replace("trap 'rm -f --", "trap 'rm -rf --"),
        source.replace(" EXIT", " INT"),
        `${source}file='/different-file'\n`,
        `${source}logs=$(mkdir -p -- '/tmp/synthetic')\n`,
        `${source}mkdir -p -- '/tmp/synthetic' || printf 'swallowed\\n'\n`,
        `${source}rm -rf -- '/guessed-directory'\n`,
      ]) {
        expect(
          analyzeScript(invalid, parser, { githubFiles: true }).complete,
          invalid,
        ).toBe(false);
      }
      const branch = `# @pipe env FLAG: boolean\nset -e\nif [[ "$FLAG" == 'true' ]]; then file=$(mktemp -- 'a.XXXXXX'); else file=$(mktemp -- 'b.XXXXXX'); fi\ntrap 'rm -f -- "$file"' EXIT\n`;
      expect(analyzeScript(branch, parser).diagnostics).toEqual([]);
      expect(
        analyzeScript(
          branch.replace("file=$(mktemp -- 'b.XXXXXX')", "file='guessed'"),
          parser,
        ).complete,
      ).toBe(false);
    } finally {
      parser.delete();
    }
  });

  it("models checked stdout file redirection before invocation without converting file data into an output contract", async () => {
    const parser = await createBashParser(runtime, grammar);
    try {
      const source =
        "set -e\nprintf 'PRIVATE FILE BYTES\\n' > '/tmp/synthetic-file'\n";
      const result = analyzeScript(source, parser);
      expect(result.diagnostics).toEqual([]);
      expect(result.effects.filesMayWrite).toEqual(["/tmp/synthetic-file"]);
      expect(result.effects.filesMayWriteUnknown).toBe(true);
      const unknown = analyzeScript(
        source.replace("printf 'PRIVATE FILE BYTES\\n'", "unknown-writer"),
        parser,
      );
      expect(unknown.diagnostics.map((issue) => issue.code)).toContain(
        "PIPE201",
      );
      expect(unknown.effects.filesMayWrite).toEqual(["/tmp/synthetic-file"]);
      for (const invalid of [
        source.replace("set -e\n", ""),
        source.replace(" > ", " >> "),
        source.replace(" > ", " 2> "),
        `${source.trimEnd()} 2>&1\n`,
      ])
        expect(analyzeScript(invalid, parser).complete, invalid).toBe(false);
      const noStdout = analyzeScript(
        `# @pipe stdout: string\n${source}`,
        parser,
      );
      expect(noStdout.diagnostics.map((issue) => issue.code)).toContain(
        "PIPE103",
      );
      expect(JSON.stringify(noStdout.diagnostics)).not.toContain(
        "PRIVATE FILE BYTES",
      );
      const remainingInput = analyzeScript(
        `# @pipe stdin: number\n# @pipe stdout: number\n${source}jq '.'\n`,
        parser,
      );
      expect(remainingInput.complete).toBe(false);
      expect(remainingInput.diagnostics.map((issue) => issue.code)).toContain(
        "PIPE103",
      );
      const captured = analyzeScript(
        `# @pipe stdin: number\n# @pipe stdout: number\nset -e\ninput="$(jq '.')"\nprintf 'PRIVATE FILE BYTES\\n' > '/tmp/synthetic-file'\nprintf '%s\\n' "$input"\n`,
        parser,
      );
      expect(captured.diagnostics).toEqual([]);
    } finally {
      parser.delete();
    }
  });

  it("models checked checksum records without claiming artifact contents or consuming native logs", async () => {
    const parser = await createBashParser(runtime, grammar);
    try {
      const hash = "aB".repeat(32);
      for (const filename of [
        "archive",
        "/tmp/space name",
        "中文\\artifact",
        "line\u2028separator",
        "paragraph\u2029separator",
        " -",
        "./-",
      ]) {
        const result = analyzeScript(
          `set -euo pipefail\nprintf '%s  %s\\n' '${hash}' '${filename}' | sha256sum --check -\n`,
          parser,
          {
            readLocalFile: () => {
              throw new Error("Checksum analysis must not read artifact bytes");
            },
          },
        );
        expect(result.diagnostics, filename).toEqual([]);
        expect(result.complete).toBe(true);
        expect(result.effects.externalMayRun).toEqual(["sha256sum check"]);
        expect(result.effects.filesMayWrite).toEqual([]);
        expect(result.effects.filesMayWriteUnknown).toBe(false);
      }
      const literal = analyzeScript(
        `set -euo pipefail\nprintf '${hash}  archive\\n' | sha256sum --check -\n`,
        parser,
      );
      expect(literal.diagnostics).toEqual([]);
    } finally {
      parser.delete();
    }
  });

  it("rejects malformed or injected checksum records and stdin filename sentinels", async () => {
    const parser = await createBashParser(runtime, grammar);
    try {
      const hash = "a".repeat(64);
      const rejected = [
        ...["a".repeat(63), "a".repeat(65), "g".repeat(64), `${hash}\n`].map(
          (digest) => `printf '%s  %s\\n' '${digest}' 'archive'`,
        ),
        ...["", "-", "bad\rname", `archive\n${hash}  other`].map(
          (filename) => `printf '%s  %s\\n' '${hash}' '${filename}'`,
        ),
        `printf '${hash}  archive\\n${hash}  other\\n'`,
        `printf '${hash}  archive\\n\\n'`,
        `printf 'malformed\\n${hash}  archive\\n'`,
        `printf '%s\\n' 'native logs'`,
      ];
      for (const producer of rejected) {
        const result = analyzeScript(
          `set -euo pipefail\n${producer} | sha256sum --check -\n`,
          parser,
        );
        expect(result.complete, producer).toBe(false);
        expect(
          result.diagnostics.map((item) => item.code),
          producer,
        ).toContain("PIPE202");
        expect(result.effects.externalMayRun, producer).not.toContain(
          "sha256sum check",
        );
      }
      // NUL in Bash source is rejected before any command model runs.
      const nul = analyzeScript(
        `set -euo pipefail\nprintf '%s  %s\\n' '${hash}' 'bad\0name' | sha256sum --check -\n`,
        parser,
      );
      expect(nul.complete).toBe(false);
      expect(nul.diagnostics.map((item) => item.code)).toContain("PIPE001");
      expect(nul.effects.externalMayRun).toEqual([]);
    } finally {
      parser.delete();
    }
  });

  it("requires checked pipeline failure and keeps checksum stdout outside business interfaces", async () => {
    const parser = await createBashParser(runtime, grammar);
    try {
      const command = `printf '%s  %s\\n' '${"0".repeat(64)}' 'archive' | sha256sum --check -`;
      for (const source of [
        `${command}\n`,
        `set -e\n${command}\n`,
        `set -o pipefail\n${command}\n`,
        `set -euo pipefail\n${command} || printf 'ignored\\n'\n`,
        `set -euo pipefail\nif ${command}; then printf 'yes\\n'; fi\n`,
        `set -euo pipefail\nlogs="$(${command})"\n`,
        `set -euo pipefail\nexport logs="$(${command})"\n`,
        `# @pipe stdout: string\nset -euo pipefail\n${command}\n`,
        `set -euo pipefail\n${command} --ignore-missing\n`,
        `set -euo pipefail\n${command.replace("--check -", "-c -")}\n`,
        "set -euo pipefail\nsha256sum --check -\n",
      ]) {
        const result = analyzeScript(source, parser);
        expect(result.complete, source).toBe(false);
        expect(
          result.diagnostics.map((item) => item.code),
          source,
        ).toContain("PIPE202");
      }
    } finally {
      parser.delete();
    }
  });

  it("carries only decoded string guarantees from an identity-preserving jq guard", async () => {
    const parser = await createBashParser(runtime, grammar);
    try {
      const environment = {
        ROOT: {
          type: { kind: "primitive", name: "string" } as const,
          encoded: false,
        },
      };
      const guard =
        '$path | select(index("\\n") == null and index("\\r") == null and index("\\u0000") == null)';
      const assignment = `path="$(jq -ner --arg path "$path" '${guard}')"`;
      const check = `printf '%s  %s\\n' '${"0".repeat(64)}' "$path" | sha256sum --check -`;
      const source = `set -euo pipefail\npath="\${ROOT}/archive"\n${assignment}\n${check}\n`;
      const result = analyzeScript(source, parser, { environment });
      expect(result.diagnostics).toEqual([]);
      expect(result.effects.externalMayRun).toEqual(["sha256sum check"]);
      for (const invalid of [
        source.replace(`${assignment}\n`, ""),
        source.replace("jq -ner", "jq -nr"),
        source.replace(`\${ROOT}/archive`, `\${ROOT}`),
        source.replace(' and index("\\r") == null', ""),
        source.replace(' and index("\\u0000") == null', ""),
        source.replace('select(index("\\n")', 'select(("safe" | index("\\n"))'),
        source.replace('select(index("\\n")', 'select($path | index("\\n")'),
        source.replace(" == null)", " == null or true)"),
        source.replace(guard, `${guard} + "\\n"`),
        source.replace('path="$(jq -ner', 'export path="$(jq -ner'),
        source.replace(
          assignment,
          `encoded="$(jq -cn --arg path "$path" '$path')"\npath="$(jq -r '.' <<< "$encoded")"`,
        ),
        source.replace(`${check}\n`, `path="$path\nextra"\n${check}\n`),
        source.replace(
          check,
          `record="$(printf '%s  %s\\n' '${"0".repeat(64)}' "$path")"\nprintf '%s\\n%s\\n' "$record" 'ignored' | sha256sum --check -`,
        ),
        source.replace(
          assignment,
          `if [[ "$ROOT" == 'one' ]]; then ${assignment}; fi`,
        ),
      ]) {
        const rejected = analyzeScript(invalid, parser, { environment });
        expect(rejected.complete, invalid).toBe(false);
        expect(
          rejected.diagnostics.map((item) => item.code),
          invalid,
        ).toContain("PIPE202");
      }
      const joined = source.replace(
        assignment,
        `if [[ "$ROOT" == 'one' ]]; then ${assignment}; else ${assignment}; fi`,
      );
      expect(
        analyzeScript(joined, parser, { environment }).diagnostics,
      ).toEqual([]);
    } finally {
      parser.delete();
    }
  });

  it("uses only caller-supplied native env facts without changing declared JSON premises", async () => {
    const parser = await createBashParser(runtime, grammar);
    try {
      const environment = {
        VERSION: {
          type: { kind: "primitive", name: "string" } as const,
          encoded: false,
          text: "synthetic",
        },
      };
      const source = `# @pipe stdout: "synthetic"\njq -cn --arg version "$VERSION" '$version'\n`;
      expect(analyzeScript(source, parser, { environment }).complete).toBe(
        true,
      );
      expect(analyzeScript(source, parser).complete).toBe(false);
      expect(
        analyzeScript(`jq '.' <<< "$VERSION"\n`, parser, {
          environment,
        }).diagnostics.map((issue) => issue.code),
      ).toContain("PIPE101");
      const declared = `# @pipe env VERSION: number\n# @pipe stdout: number\njq '.' <<< "$VERSION"\n`;
      expect(
        analyzeScript(declared, parser, { environment }).diagnostics.map(
          (issue) => issue.code,
        ),
      ).toContain("PIPE101");
      expect(
        analyzeScript(declared, parser, {
          environment: {
            VERSION: {
              type: { kind: "literal", value: 42 },
              encoded: true,
              text: "42",
            },
          },
        }).complete,
      ).toBe(true);
      expect(
        analyzeScript(declared, parser, {
          environment: {
            VERSION: {
              type: { kind: "literal", value: "synthetic" },
              encoded: true,
              text: '"synthetic"',
            },
          },
        }).diagnostics.map((issue) => issue.code),
      ).toContain("PIPE102");
      const encoded = {
        VALUE: {
          type: { kind: "literal", value: 42 } as const,
          encoded: true,
          text: "42",
        },
      };
      expect(
        analyzeScript(`# @pipe stdout: 42\njq '.' <<< "$VALUE"\n`, parser, {
          environment: encoded,
        }).complete,
      ).toBe(true);
      const writer = analyzeScript(
        `printf 'VALUE=%s\\n' "$(jq -cn --arg version "$VERSION" '$version')" >> "$GITHUB_ENV"\n`,
        parser,
        { environment, githubFiles: true },
      );
      expect(writer.effects.githubEnv.VALUE?.singleLine).toBe(true);
    } finally {
      parser.delete();
    }
  });

  it("blocks invalid native env and unverified Bash startup without leaking its contents", async () => {
    const parser = await createBashParser(runtime, grammar);
    try {
      for (const [name, text] of [
        ["BASH_ENV", "SECRET_MARKER/startup.sh"],
        ["BAD-NAME", "SECRET_MARKER"],
        ["VALUE", "SECRET_MARKER\0"],
      ] as const) {
        const report = analyzeScript(`jq -n '1'\n`, parser, {
          environment: {
            [name as string]: {
              type: { kind: "primitive", name: "string" },
              encoded: false,
              text,
            },
          },
        });
        expect(report.complete).toBe(false);
        expect(JSON.stringify(report.diagnostics)).not.toContain(
          "SECRET_MARKER",
        );
      }
      expect(
        analyzeScript(`jq -n '1'\n`, parser, {
          environment: {
            BASH_ENV: {
              type: { kind: "primitive", name: "string" },
              encoded: false,
              text: "",
            },
          },
        }).complete,
      ).toBe(true);
      expect(
        analyzeScript(`# @pipe env BASH_ENV: string\njq -n '1'\n`, parser)
          .complete,
      ).toBe(false);
    } finally {
      parser.delete();
    }
  });

  it("models a constrained curl download and unknown auxiliary writes without executing it", async () => {
    const parser = await createBashParser(runtime, grammar);
    try {
      const command = `curl --disable --globoff --proto '=https' --proto-redir '=https' --fail --silent --show-error --location --retry 3 --url "$URL" --output "$archive"`;
      const environment = {
        URL: {
          type: { kind: "primitive", name: "string" } as const,
          encoded: false,
          text: "https://static-test.invalid/archive.tar.gz",
        },
      };
      for (const path of [
        "'/tmp/synthetic-download.tar.gz'",
        `"\${RUNNER_TEMP}/synthetic-download.tar.gz"`,
      ]) {
        const result = analyzeScript(
          `set -e\narchive=${path}\n${command}\n`,
          parser,
          { environment, githubFiles: true },
        );
        expect(result.diagnostics).toEqual([]);
        expect(result.effects.externalMayRun).toEqual(["curl download"]);
        expect(result.effects.filesMayWriteUnknown).toBe(true);
        expect(result.effects.filesMayWrite).toEqual(
          path.startsWith("'") ? ["/tmp/synthetic-download.tar.gz"] : [],
        );
      }
      const source = `set -e\narchive='artifact.tar.gz'\n${command}\n`;
      for (const invalid of [
        source.replace("--disable ", ""),
        source.replace("--globoff ", ""),
        source.replace("--proto '=https'", "--proto '=http,https'"),
        source.replace("--proto-redir '=https'", "--proto-redir '=all'"),
        source.replace(' --url "$URL"', ' "$URL"'),
        source.replace("--retry 3", "--retry 'bad'"),
        source.replace("--retry 3", "--retry 3 --fail"),
        source.replace("'artifact.tar.gz'", "'-'"),
        source.replace("'artifact.tar.gz'", "''"),
        source.replace('--output "$archive"', "--output $archive"),
        source.replace("set -e\n", ""),
        source.replace(command, `value="$(${command})"`),
        source.replace(command, `${command} | jq '.'`),
        `# @pipe stdout: number\n${source}`,
      ]) {
        const result = analyzeScript(invalid, parser, {
          environment,
          githubFiles: true,
        });
        expect(result.complete, invalid).toBe(false);
        expect(result.effects.externalMayRun, invalid).toEqual([]);
      }
      const discarded = analyzeScript(
        source.replace(command, `${command} > /dev/null`),
        parser,
        { environment },
      );
      expect(discarded.complete).toBe(true);
      expect(discarded.effects.externalMayRun).toEqual(["curl download"]);
      expect(discarded.effects.filesMayWriteUnknown).toBe(true);
      const redirected = analyzeScript(
        source.replace(command, `${command} > '/tmp/synthetic-curl-log'`),
        parser,
        { environment },
      );
      expect(redirected.diagnostics).toEqual([]);
      expect(redirected.effects.filesMayWrite).toEqual([
        "/tmp/synthetic-curl-log",
      ]);
      expect(redirected.effects.filesMayWriteUnknown).toBe(true);
      const unknownPath = {
        ...environment,
        archive: {
          type: { kind: "primitive", name: "string" } as const,
          encoded: false,
        },
      };
      expect(
        analyzeScript(`set -e\n${command}\n`, parser, {
          environment: unknownPath,
        }).complete,
      ).toBe(false);
      expect(
        analyzeScript(`set -e\narchive="-$URL"\n${command}\n`, parser, {
          environment: {
            URL: {
              type: { kind: "primitive", name: "string" },
              encoded: false,
            },
          },
        }).complete,
      ).toBe(false);
    } finally {
      parser.delete();
    }
  });

  it("revokes file and GitHub producer proofs after a modeled curl download", async () => {
    const parser = await createBashParser(runtime, grammar);
    try {
      const source = `set -e\nprintf 'NAME=%s\\n' '"before"' >> "$GITHUB_ENV"\ncurl --disable --globoff --proto '=https' --proto-redir '=https' --fail --silent --show-error --location --retry 3 --url 'https://static-test.invalid/archive' --output 'archive'\nprintf 'value=%s\\n' '42' >> "$GITHUB_OUTPUT"\n`;
      const report = analyzeScript(source, parser, { githubFiles: true });
      expect(report.complete).toBe(true);
      expect(report.effects.filesMayWriteUnknown).toBe(true);
      expect(report.effects.githubEnv).toEqual({});
      expect(report.effects.githubOutput).toEqual({});
      let calls = 0;
      const stale = analyzeScript(`${source}./child.sh\n`, parser, {
        githubFiles: true,
        resolveLocalScript: () => {
          calls++;
          return { contract: parseScriptContract(""), complete: true };
        },
      });
      expect(stale.complete).toBe(false);
      expect(calls).toBe(0);
      expect(
        stale.diagnostics.some((issue) =>
          issue.message.includes("unresolved file write"),
        ),
      ).toBe(true);
    } finally {
      parser.delete();
    }
  });

  it("summarizes only proven single-line GitHub environment and output writes", async () => {
    const parser = await createBashParser(runtime, grammar);
    try {
      const source = `# @pipe env NAME: string
set -e
{ printf 'A=%s\\n' "$(jq -cn --arg value "$NAME" '$value')"; printf 'B=%s\\n' '"fixed"'; } >> "$GITHUB_ENV"
printf 'target=%s\\n' "$(jq -cn '{aws: {namespace: "prod"}}')" >> "$GITHUB_OUTPUT"
printf 'GITHUB_TOKEN=%s\\n' '"output-name-only"' >> "$GITHUB_OUTPUT"
`;
      const result = analyzeScript(source, parser, { githubFiles: true });
      expect(result.diagnostics).toEqual([]);
      expect(result.effects.githubEnv.A).toMatchObject({
        type: { kind: "primitive", name: "string" },
        encoded: true,
      });
      expect(result.effects.githubEnv.B).toMatchObject({
        encoded: true,
        text: '"fixed"',
      });
      expect(result.effects.githubOutput.target).toMatchObject({
        encoded: true,
        type: { kind: "object" },
      });
      expect(result.effects.githubOutput.GITHUB_TOKEN).toMatchObject({
        encoded: true,
        text: '"output-name-only"',
      });
      expect(
        analyzeScript(source, parser).diagnostics.map((d) => d.code),
      ).toContain("PIPE202");
    } finally {
      parser.delete();
    }
  });

  it("reads a fixed sed-filtered GitHub env source without executing sed", async () => {
    const parser = await createBashParser(runtime, grammar);
    try {
      const script =
        "sed -E '/^[[:space:]]*(#|$)/d' .github/tool-versions.env >> \"$GITHUB_ENV\"\n";
      const valid = analyzeScript(script, parser, {
        githubFiles: true,
        readLocalFile: (path) => {
          expect(path).toBe(".github/tool-versions.env");
          return {
            kind: "file",
            source:
              '# pinned versions\n  # comment\n\nVERSION=1.2.3\nNAME_JSON="tool"\n',
          };
        },
      });
      expect(valid.diagnostics).toEqual([]);
      expect(valid.effects.githubEnv.VERSION).toMatchObject({
        encoded: false,
        text: "1.2.3",
      });
      expect(valid.effects.githubEnv.NAME_JSON).toMatchObject({
        encoded: true,
        text: '"tool"',
      });
      const missing = analyzeScript(script, parser, {
        githubFiles: true,
        readLocalFile: () => ({ kind: "unavailable", reason: "missing" }),
      });
      expect(missing.diagnostics.map((d) => d.code)).toContain("PIPE204");
      for (const content of [
        "NOT-AN-ASSIGNMENT\n",
        " NAME=value\n",
        "NAME=value\r\n",
        "NAME=ok\0bad\n",
        "NAME=ok\nNODE_OPTIONS=--require=evil\n",
        "NAME=ok\nGITHUB_TOKEN=spoofed\n",
        "NAME=ok\nRUNNER_TEMP=/tmp/spoofed\n",
      ]) {
        const result = analyzeScript(script, parser, {
          githubFiles: true,
          readLocalFile: () => ({ kind: "file", source: content }),
        });
        expect(result.complete, content).toBe(false);
        expect(result.effects.githubEnv, content).toEqual({});
      }
      const changedFilter = analyzeScript(
        script.replace("(#|$)/d", "(#|$)/p"),
        parser,
        {
          githubFiles: true,
          readLocalFile: () => ({ kind: "file", source: "A=1\n" }),
        },
      );
      expect(changedFilter.complete).toBe(false);
    } finally {
      parser.delete();
    }
  });

  it("reads the same bounded assignment file into immutable step outputs without applying env-only protection rules", async () => {
    const parser = await createBashParser(runtime, grammar);
    try {
      const source =
        "sed -E '/^[[:space:]]*(#|$)/d' .github/pins.env >> \"$GITHUB_OUTPUT\"\n";
      const check = (content: string, script = source) =>
        analyzeScript(script, parser, {
          githubFiles: true,
          readLocalFile: () => ({ kind: "file", source: content }),
        });
      const result = check(
        '# static test data\nVERSION=1.2.3\nVERSION=2.0.0\nNAME_JSON="tool"\nNODE_OPTIONS=output-only\n',
      );
      expect(result.diagnostics).toEqual([]);
      expect(result.effects.githubEnv).toEqual({});
      expect(result.effects.githubEnvMayWrite).toEqual([]);
      expect(result.effects.githubOutput.VERSION).toMatchObject({
        encoded: false,
        text: "2.0.0",
      });
      expect(result.effects.githubOutput.NAME_JSON).toMatchObject({
        encoded: true,
        text: '"tool"',
      });
      expect(result.effects.githubOutput.NODE_OPTIONS).toMatchObject({
        encoded: false,
        text: "output-only",
      });
      for (const invalid of [
        "NAME<<EOF\nvalue\nEOF\n",
        "NAME=bad\r\n",
        "NAME=bad\0\n",
        "not-an-assignment\n",
        " NAME=bad\n",
      ])
        expect(check(invalid).effects.githubOutput).toEqual({});
      expect(
        check("VERSION=ok\n", source.replace("(#|$)/d", "(#|$)/p")).complete,
      ).toBe(false);
      const overridden = check(
        "VERSION=ok\n",
        `GITHUB_OUTPUT='/not-the-runner-file'\n${source}`,
      );
      expect(overridden.complete).toBe(false);
      expect(overridden.effects.githubOutput).toEqual({});
      const stale = check(
        "VERSION=ok\n",
        `set -e\nmkdir -p -- '/tmp/static-only'\n${source}`,
      );
      expect(stale.complete).toBe(false);
      expect(stale.effects.githubOutput).toEqual({});
    } finally {
      parser.delete();
    }
  });

  it("treats GitHub HOME and RUNNER_TEMP as existing but unlocated runner paths", async () => {
    const parser = await createBashParser(runtime, grammar);
    try {
      for (const name of ["HOME", "RUNNER_TEMP"]) {
        const source = `# @pipe stdout: string\njq -n --arg path "$${name}" '$path'\n`;
        expect(
          analyzeScript(source, parser, { githubFiles: true }).diagnostics,
        ).toEqual([]);
        expect(
          analyzeScript(source, parser).diagnostics.map((item) => item.code),
        ).toContain("PIPE202");
        const unknownFile = `[[ -f "$${name}/pins.env" ]]\n`;
        expect(
          analyzeScript(unknownFile, parser, {
            githubFiles: true,
            readLocalFile: () => {
              throw new Error("Unknown runner path must not be read");
            },
          }).diagnostics.map((item) => item.code),
        ).toContain("PIPE202");
      }
      const child = {
        contract: parseScriptContract("# @pipe env RUNNER_TEMP: string\n"),
        complete: true,
      };
      expect(
        analyzeScript("./child.sh\n", parser, {
          githubFiles: true,
          resolveLocalScript: () => child,
        }).diagnostics.map((item) => item.code),
      ).toContain("PIPE101");
    } finally {
      parser.delete();
    }
  });

  it("keeps git diff error exits out of a verified GITHUB_OUTPUT status map", async () => {
    const parser = await createBashParser(runtime, grammar);
    try {
      const source = `set -e
path=overlay.yaml
status=0
git diff --quiet -- "$path" || status=$?
case "$status" in
  0) echo "need_commit=false" ;;
  1) echo "need_commit=true" ;;
  *) exit "$status" ;;
esac >> "$GITHUB_OUTPUT"
`;
      const result = analyzeScript(source, parser, { githubFiles: true });
      expect(result.diagnostics).toEqual([]);
      expect(result.effects.githubOutput.need_commit).toBeDefined();
      expect(result.effects.externalMayRun).toContain("git diff --quiet");
      const unsafe = source.replace(
        '*) exit "$status" ;;',
        '*) echo "need_commit=unknown" ;;',
      );
      expect(
        analyzeScript(unsafe, parser, { githubFiles: true }).complete,
      ).toBe(false);
    } finally {
      parser.delete();
    }
  });

  it("requires git push to use the branch checked out on every Bash path", async () => {
    const parser = await createBashParser(runtime, grammar);
    try {
      const source = `set -e
branch=feature
git checkout -b "$branch"
git push origin "$branch"
`;
      const valid = analyzeScript(source, parser);
      expect(valid.diagnostics).toEqual([]);
      expect(valid.effects.externalMayRun).toEqual([
        "git checkout branch",
        "git push origin",
      ]);
      for (const changed of [
        source.replace('git push origin "$branch"', 'git push origin "main"'),
        source.replace(
          'git push origin "$branch"',
          'branch=other\ngit push origin "$branch"',
        ),
        source.replace('git checkout -b "$branch"\n', ""),
        source.replace(
          'git push origin "$branch"',
          'git push origin "$(date +%s)"',
        ),
        `# @pipe env FLAG: string
${source.replace(
  'git checkout -b "$branch"',
  'if [[ "$FLAG" == yes ]]; then git checkout -b "$branch"; fi',
)}`,
      ]) {
        const result = analyzeScript(changed, parser);
        expect(result.complete, changed).toBe(false);
        expect(
          result.diagnostics.map((issue) => issue.code),
          changed,
        ).toContain("PIPE202");
      }
    } finally {
      parser.delete();
    }
  });

  it("keeps GitHub writes only when every successful Bash branch writes them", async () => {
    const parser = await createBashParser(runtime, grammar);
    try {
      const both = `# @pipe env FLAG: string
if [[ "$FLAG" == yes ]]; then printf 'READY=%s\\n' '"yes"' >> "$GITHUB_ENV"; else printf 'READY=%s\\n' '"no"' >> "$GITHUB_ENV"; fi
`;
      const result = analyzeScript(both, parser, { githubFiles: true });
      expect(result.diagnostics).toEqual([]);
      expect(result.effects.githubEnv.READY).toBeDefined();
      const maybe = both.replace(
        "else printf 'READY=%s\\n' '\"no\"' >> \"$GITHUB_ENV\";",
        "else x=1;",
      );
      const changed = analyzeScript(maybe, parser, { githubFiles: true });
      expect(changed.diagnostics).toEqual([]);
      expect(changed.effects.githubEnv.READY).toBeUndefined();
      expect(changed.effects.githubEnvMayWrite).toContain("READY");
      const caseWrite = `# @pipe env FLAG: string
case "$FLAG" in a) echo "need_commit=false";; *) echo "need_commit=true";; esac >> "$GITHUB_OUTPUT"
`;
      const resultCase = analyzeScript(caseWrite, parser, {
        githubFiles: true,
      });
      expect(resultCase.diagnostics).toEqual([]);
      expect(resultCase.effects.githubOutput.need_commit).toBeDefined();
    } finally {
      parser.delete();
    }
  });

  it("blocks unverified GitHub file formats, multiline values and path overrides", async () => {
    const parser = await createBashParser(runtime, grammar);
    try {
      for (const source of [
        `# @pipe env RAW: string\nprintf 'X=%s\\n' "$RAW" >> "$GITHUB_ENV"\n`,
        `printf 'X=%s\\n' "$(jq -n '{x: 1}')" >> "$GITHUB_OUTPUT"\n`,
        `GITHUB_ENV=local\nprintf 'X=%s\\n' '"x"' >> "$GITHUB_ENV"\n`,
        `printf 'X=%s' '"x"' >> "$GITHUB_ENV"\n`,
        `printf 'GITHUB_TOKEN=%s\\n' 'spoofed' >> "$GITHUB_ENV"\n`,
        `printf 'RUNNER_TEMP=%s\\n' '/tmp/spoofed' >> "$GITHUB_ENV"\n`,
        `printf 'NODE_OPTIONS=%s\\n' '--require=evil' >> "$GITHUB_ENV"\n`,
      ]) {
        const result = analyzeScript(source, parser, { githubFiles: true });
        expect(result.complete, source).toBe(false);
        expect(
          result.diagnostics.map((d) => d.code),
          source,
        ).toContain("PIPE202");
        expect(result.effects.githubEnv, source).toEqual({});
      }
    } finally {
      parser.delete();
    }
  });
  it("forks Bash if paths and joins values, output counts and stdin consumption", async () => {
    const parser = await createBashParser(runtime, grammar);
    try {
      const valid = [
        "# @pipe stdout: 1\nif true; then jq -n '1'; else unknown-business-command; fi\n",
        "# @pipe stdout: 3\nif false; then unknown-business-command; elif true; then jq -n '3'; else jq -n '4'; fi\n",
        `# @pipe env FLAG: string\n# @pipe stdout: number\nif [[ "$FLAG" == yes ]]; then x=1; else x=2; fi\njq '.' <<< "$x"\n`,
        `# @pipe env FLAG: string\n# @pipe stdout: number\nif [[ "$FLAG" == yes ]]; then jq -n '1'; else jq -n '2'; fi\n`,
      ];
      for (const source of valid)
        expect(analyzeScript(source, parser).diagnostics, source).toEqual([]);
      const maybeRead = `# @pipe env FLAG: string\n# @pipe stdin: number\n# @pipe stdout: number\nif [[ "$FLAG" == yes ]]; then jq '.' >/dev/null; fi\njq '.'\n`;
      expect(
        analyzeScript(maybeRead, parser).diagnostics.map((item) => item.code),
      ).toContain("PIPE103");
      const maybeEmit = `# @pipe env FLAG: string\n# @pipe stdout: number\nif [[ "$FLAG" == yes ]]; then jq -n '1'; fi\n`;
      expect(
        analyzeScript(maybeEmit, parser).diagnostics.map((item) => item.code),
      ).toContain("PIPE103");
      const missingVariable = `# @pipe env FLAG: string\nif [[ "$FLAG" == yes ]]; then x=1; fi\njq -n --argjson v "$x" '$v'\n`;
      expect(analyzeScript(missingVariable, parser).complete).toBe(false);
      const exhaustive = `# @pipe env FLAG: string\n# @pipe stdout: number\nif [[ "$FLAG" == a ]]; then x=1; elif [[ "$FLAG" == b ]]; then x=2; else exit 1; fi\njq -n --argjson v "$x" '$v'\n`;
      expect(analyzeScript(exhaustive, parser).diagnostics).toEqual([]);
      const noSuccess = `# @pipe stdout: number\nif false; then jq -n '1'; elif false; then jq -n '2'; else exit 1; fi\njq -n '3'\n`;
      expect(
        analyzeScript(noSuccess, parser).diagnostics.map((item) => item.code),
      ).toContain("PIPE202");
      expect(
        analyzeScript(
          '# @pipe env FLAG: string\nif [[ "$FLAG" == yes ]]; then unused=1; fi\n',
          parser,
        ).diagnostics,
      ).toEqual([]);
    } finally {
      parser.delete();
    }
  });

  it("analyzes finite Bash case patterns without assuming an unmatched branch", async () => {
    const parser = await createBashParser(runtime, grammar);
    try {
      const valid = [
        `# @pipe stdout: 1\nx=aws\ncase "$x" in aws|huaweicloud) jq -n '1';; *) unknown-business-command;; esac\n`,
        `# @pipe env PLATFORM: string\n# @pipe stdout: number\ncase "$PLATFORM" in aws) jq -n '1';; huaweicloud) jq -n '2';; *) jq -n '3';; esac\n`,
      ];
      for (const source of valid)
        expect(analyzeScript(source, parser).diagnostics, source).toEqual([]);
      expect(
        analyzeScript(
          `# @pipe env PLATFORM: string\n# @pipe stdout: number\ncase "$PLATFORM" in aws) jq -n '1';; esac\n`,
          parser,
        ).diagnostics.map((item) => item.code),
      ).toContain("PIPE103");
      expect(
        analyzeScript(
          `case x in x) jq -n '1';& y) jq -n '2';; esac\n`,
          parser,
        ).diagnostics.map((item) => item.code),
      ).toContain("PIPE202");
    } finally {
      parser.delete();
    }
  });

  it("excludes proven nonzero exits from successful Bash paths", async () => {
    const parser = await createBashParser(runtime, grammar);
    try {
      const valid = `# @pipe env FLAG: string\n# @pipe stdout: number\nfail() { printf 'ERROR: %s\\n' "$1" >&2; exit 1; }\nif [[ "$FLAG" == yes ]]; then fail bad; else jq -n '1'; fi\n`;
      expect(analyzeScript(valid, parser).diagnostics).toEqual([]);
      const noSuccess = `# @pipe stdout: number\nexit 1\njq -n '1'\n`;
      expect(
        analyzeScript(noSuccess, parser).diagnostics.map((item) => item.code),
      ).toEqual(["PIPE202"]);
      const unsupported = `f() { jq -n '1'; }\nf\n`;
      expect(
        analyzeScript(unsupported, parser).diagnostics.map((item) => item.code),
      ).toEqual(["PIPE202"]);
      const branchLocal = `# @pipe env FLAG: string\nif [[ "$FLAG" == yes ]]; then f() { exit 1; }; fi\nf\n`;
      expect(
        analyzeScript(branchLocal, parser).diagnostics.map((item) => item.code),
      ).toContain("PIPE202");
    } finally {
      parser.delete();
    }
  });

  it("checks redirected jq -e conditions without treating known failures as success", async () => {
    const parser = await createBashParser(runtime, grammar);
    try {
      const valid = `# @pipe stdin: {"value": boolean}\n# @pipe stdout: 1\nset -e\ndoc="$(jq -c '.')"\nif ! jq -e '.value' <<< "$doc" >/dev/null; then exit 1; fi\njq -n '1'\n`;
      expect(analyzeScript(valid, parser).diagnostics).toEqual([]);
      for (const filter of ["false", 'error("bad")']) {
        const source = `# @pipe stdout: 1\nset -e\nif ! jq -ne '${filter}' >/dev/null; then exit 1; fi\njq -n '1'\n`;
        expect(
          analyzeScript(source, parser).diagnostics.map((item) => item.code),
          source,
        ).toContain("PIPE202");
      }
      const unsafeRedirect = `# @pipe stdout: 1\nif ! jq -ne 'true' >result.json; then exit 1; fi\njq -n '1'\n`;
      expect(
        analyzeScript(unsafeRedirect, parser).diagnostics.map(
          (item) => item.code,
        ),
      ).toContain("PIPE202");
      const leakedOutput = `# @pipe stdout: 1\nif ! jq -ne 'true'; then exit 1; fi\njq -n '1'\n`;
      expect(
        analyzeScript(leakedOutput, parser).diagnostics.map(
          (item) => item.code,
        ),
      ).toContain("PIPE202");
    } finally {
      parser.delete();
    }
  });

  it("keeps only successful guarded substitution values after a fatal fallback", async () => {
    const parser = await createBashParser(runtime, grammar);
    try {
      const guarded = `# @pipe stdin: string\n# @pipe stdout: string\nset -euo pipefail\nfail() { printf 'ERROR: %s\\n' "$1" >&2; exit 1; }\ndoc="$(jq -c '.')"\nvalue="$(jq -er 'select(length > 0)' <<< "$doc")" || fail bad\njq -n --arg value "$value" '$value'\n`;
      expect(analyzeScript(guarded, parser).diagnostics).toEqual([]);
      const unguarded = guarded.replace(" || fail bad", "");
      expect(analyzeScript(unguarded, parser).diagnostics).toEqual([]);
      const noErrexit = unguarded.replace("set -euo pipefail\n", "");
      expect(
        analyzeScript(noErrexit, parser).diagnostics.map((item) => item.code),
      ).toContain("PIPE202");
      const failedAssignment = `# @pipe stdout: number\nset -e\nvalue="$(jq -ne 'false')"\njq -n '1'\n`;
      expect(
        analyzeScript(failedAssignment, parser).diagnostics.map(
          (item) => item.code,
        ),
      ).toContain("PIPE202");
      const multipleValues = `# @pipe stdout: string\nset -e\nvalue="$(jq -ne 'false, true')"\njq -n --arg value "$value" '$value'\n`;
      expect(
        analyzeScript(multipleValues, parser).diagnostics.map(
          (item) => item.code,
        ),
      ).toContain("PIPE202");
      const maskedStatus = `set -e\nprintf '%s\\n' "$(jq -ne 'false')"\n`;
      expect(
        analyzeScript(maskedStatus, parser).diagnostics.map(
          (item) => item.code,
        ),
      ).toContain("PIPE202");
      const neverSucceeds = `# @pipe stdout: number\nfail() { printf 'ERROR: %s\\n' "$1" >&2; exit 1; }\nvalue="$(jq -ne 'false')" || fail bad\njq -n '1'\n`;
      expect(
        analyzeScript(neverSucceeds, parser).diagnostics.map(
          (item) => item.code,
        ),
      ).toContain("PIPE202");
    } finally {
      parser.delete();
    }
  });

  it("short-circuits jq boolean guards over closed object unions", async () => {
    const parser = await createBashParser(runtime, grammar);
    try {
      const guarded = `# @pipe stdin: [{"tag": string} | {"digest": string}]\n# @pipe stdout: boolean\njq 'all(.[]; (has("digest") and (.digest | type == "string")) or (has("tag") and (.tag | type == "string")))'\n`;
      expect(analyzeScript(guarded, parser).diagnostics).toEqual([]);
      const skipped = `# @pipe stdout: false\njq -n 'false and .missing'\n`;
      expect(analyzeScript(skipped, parser).diagnostics).toEqual([]);
      const unguarded = `# @pipe stdin: {"tag": string} | {"digest": string}\n# @pipe stdout: boolean\njq 'has("tag") and (.digest | type == "string")'\n`;
      expect(
        analyzeScript(unguarded, parser).diagnostics.map((item) => item.code),
      ).toContain("PIPE102");
    } finally {
      parser.delete();
    }
  });

  it("narrows a JSON union only while its jq has result refers to the same shell value", async () => {
    const parser = await createBashParser(runtime, grammar);
    try {
      const guarded = `# @pipe stdin: {"tag": string} | {"digest": string}\n# @pipe stdout: string\nimage="$(jq -c '.')"\nhas_digest="$(jq -r 'has("digest")' <<< "$image")"\nif [[ "$has_digest" == true ]]; then\n  version="$(jq -er '.digest' <<< "$image")"\nelse\n  version="$(jq -er '.tag' <<< "$image")"\nfi\njq -n --arg value "$version" '$value'\n`;
      expect(analyzeScript(guarded, parser).diagnostics).toEqual([]);
      const stale = guarded.replace(
        'if [[ "$has_digest" == true ]]; then',
        `image="$(jq -n '{tag: "other"}')"\nif [[ "$has_digest" == true ]]; then`,
      );
      expect(
        analyzeScript(stale, parser).diagnostics.map((item) => item.code),
      ).toContain("PIPE102");
      const wrongGuard = guarded.replace('has("digest")', 'has("tag")');
      expect(
        analyzeScript(wrongGuard, parser).diagnostics.map((item) => item.code),
      ).toContain("PIPE102");
    } finally {
      parser.delete();
    }
  });

  it("short-circuits known Bash && and || conditions", async () => {
    const parser = await createBashParser(runtime, grammar);
    try {
      const valid = [
        `# @pipe stdout: 1\ntrue && jq -n '1'\n`,
        `# @pipe stdout: 1\nfalse || jq -n '1'\n`,
        `# @pipe stdout: 1\nfalse && unknown-business-command\njq -n '1'\n`,
        `# @pipe stdout: 1\n[[ x == x ]] && jq -n '1'\n`,
      ];
      for (const source of valid)
        expect(analyzeScript(source, parser).diagnostics, source).toEqual([]);
      const conditional = `# @pipe env FLAG: string\n# @pipe stdout: number\n[[ "$FLAG" == yes ]] && jq -n '1'\n`;
      expect(
        analyzeScript(conditional, parser).diagnostics.map((item) => item.code),
      ).toContain("PIPE103");
    } finally {
      parser.delete();
    }
  });

  it("enumerates side-effect-free Bash string, glob and regex tests", async () => {
    const parser = await createBashParser(runtime, grammar);
    try {
      const known = `# @pipe stdout: 1\nx=''\nif [[ -z "$x" ]]; then jq -n '1'; else unknown-business-command; fi\n`;
      expect(analyzeScript(known, parser).diagnostics).toEqual([]);
      const guarded = `# @pipe env FLAG: string\n# @pipe stdout: number\nif [[ -z "$FLAG" ]]; then exit 1; fi\nif [[ "$FLAG" == x* ]]; then exit 1; fi\nif [[ "$FLAG" =~ ^x$ ]]; then exit 1; fi\njq -n '1'\n`;
      expect(analyzeScript(guarded, parser).diagnostics).toEqual([]);
      const resource = `# @pipe stdout: number\nif [[ -f missing.yaml ]]; then jq -n '1'; else jq -n '2'; fi\n`;
      expect(
        analyzeScript(resource, parser).diagnostics.map((item) => item.code),
      ).toContain("PIPE202");
      const effect = `# @pipe stdout: number\nif [[ "$(unknown-business-command)" == x ]]; then jq -n '1'; else jq -n '2'; fi\n`;
      expect(
        analyzeScript(effect, parser).diagnostics.map((item) => item.code),
      ).toContain("PIPE202");
    } finally {
      parser.delete();
    }
  });

  it("keeps only the success path of a test with a static fatal stderr group", async () => {
    const parser = await createBashParser(runtime, grammar);
    try {
      const guarded = `# @pipe env NAME: string\n# @pipe stdout: number\n[[ "$NAME" =~ ^[a-z]+$ ]] || { printf 'bad\\n' >&2; exit 1; }\njq -n '1'\n`;
      expect(analyzeScript(guarded, parser).diagnostics).toEqual([]);
      for (const source of [
        guarded.replace("exit 1", "exit 256"),
        guarded.replace("printf 'bad\\n' >&2", "unknown-business-command"),
        guarded.replace('"$NAME"', '"$(unknown-business-command)"'),
        guarded
          .replace("# @pipe env NAME: string\n", "x=abc\n")
          .replace('"$NAME"', '"$x"'),
      ]) {
        expect(
          analyzeScript(source, parser).diagnostics.map((item) => item.code),
          source,
        ).toContain("PIPE202");
      }
      const nonFatalFunction = `# @pipe env NAME: string\n# @pipe stdout: number\nfail() { printf 'bad\\n' >&2; exit 256; }\n[[ "$NAME" =~ ^[a-z]+$ ]] || fail\njq -n '1'\n`;
      expect(
        analyzeScript(nonFatalFunction, parser).diagnostics.map(
          (item) => item.code,
        ),
      ).toContain("PIPE202");
    } finally {
      parser.delete();
    }
  });

  it("keeps Bash quoted concatenation byte-aware", async () => {
    const parser = await createBashParser(runtime, grammar);
    try {
      const valid = [
        `# @pipe stdout: "pre-abc"\nx=abc\ny="pre-$x"\njq -n --arg value "$y" '$value'\n`,
        `# @pipe stdout: "abc"\nx=abc\ny="\\"${"$"}{x}\\""\njq '.' <<< "$y"\n`,
      ];
      for (const source of valid)
        expect(analyzeScript(source, parser).diagnostics, source).toEqual([]);
      const unknown = `# @pipe env NAME: string\n# @pipe stdout: string\ny="pre-$NAME"\njq -n --argjson value "$y" '$value'\n`;
      expect(
        analyzeScript(unknown, parser).diagnostics.map((item) => item.code),
      ).toContain("PIPE101");
      const complex = `# @pipe stdout: string\nx=abc\ny="${"$"}{x%a}"\njq -n --arg value "$y" '$value'\n`;
      expect(
        analyzeScript(complex, parser).diagnostics.map((item) => item.code),
      ).toContain("PIPE202");
    } finally {
      parser.delete();
    }
  });

  it("models verified dirname/cd/pwd substitutions without a shell", async () => {
    const parser = await createBashParser(runtime, grammar);
    try {
      const source = `# @pipe stdout: string\nscript_dir="$(cd -- "$(dirname -- "${"$"}{BASH_SOURCE[0]}")" && pwd)"\nrepo_root="$(cd -- "$script_dir/../.." && pwd)"\njq -n --arg value "$repo_root" '$value'\n`;
      const options = {
        scriptDirectory: "/project/.github/scripts",
        resolveDirectory: (path: string) => ({
          kind: "directory" as const,
          path: posix.normalize(path),
        }),
      };
      expect(analyzeScript(source, parser, options).diagnostics).toEqual([]);
      expect(
        analyzeScript(source, parser, {
          ...options,
          resolveDirectory: () => ({
            kind: "unavailable" as const,
            reason: "missing path",
          }),
        }).diagnostics.map((item) => item.code),
      ).toContain("PIPE204");
    } finally {
      parser.delete();
    }
  });

  it("checks finite file tests against the read-only project snapshot", async () => {
    const parser = await createBashParser(runtime, grammar);
    try {
      const source = `# @pipe stdout: 1\nif [[ -f "/project/manifest.yaml" ]]; then jq -n '1'; else exit 1; fi\n`;
      expect(
        analyzeScript(source, parser, {
          readLocalFile: () => ({ kind: "file", source: "kind: Deployment\n" }),
        }).diagnostics,
      ).toEqual([]);
      expect(
        analyzeScript(source, parser, {
          readLocalFile: () => ({
            kind: "unavailable",
            reason: "missing file",
          }),
        }).diagnostics.map((item) => item.code),
      ).toContain("PIPE204");
      expect(
        analyzeScript(source, parser).diagnostics.map((item) => item.code),
      ).toContain("PIPE202");
    } finally {
      parser.delete();
    }
  });

  it("reads yq namespace JSON only from verified local YAML", async () => {
    const parser = await createBashParser(runtime, grammar);
    try {
      const source = `# @pipe stdout: string\nyq eval -o=json '.namespace' "/project/manifest.yaml"\n`;
      expect(
        analyzeScript(source, parser, {
          readLocalFile: () => ({
            kind: "file",
            source: "namespace: synthetic\nimages: []\n",
          }),
        }).diagnostics,
      ).toEqual([]);
      expect(
        analyzeScript(source, parser, {
          readLocalFile: () => ({
            kind: "unavailable",
            reason: "missing file",
          }),
        }).diagnostics.map((item) => item.code),
      ).toContain("PIPE204");
      expect(
        analyzeScript(source, parser, {
          readLocalFile: () => ({ kind: "file", source: "namespace: 42\n" }),
        }).diagnostics.map((item) => item.code),
      ).toContain("PIPE102");
      const mutation = source.replace("-o=json", "-i");
      expect(
        analyzeScript(mutation, parser, {
          readLocalFile: () => ({ kind: "file", source: "namespace: x\n" }),
        }).diagnostics.map((item) => item.code),
      ).toContain("PIPE202");
    } finally {
      parser.delete();
    }
  });

  it("guards a local yq namespace pipeline with jq -e and a fatal fallback", async () => {
    const parser = await createBashParser(runtime, grammar);
    try {
      const source = `# @pipe stdout: string\nset -euo pipefail\nfail() { printf 'ERROR: %s\\n' "$1" >&2; exit 1; }\nnamespace="$(yq eval -o=json '.namespace' "/project/manifest.yaml" | jq -er 'select(type == "string" and length > 0)')" || fail bad\njq -n --arg value "$namespace" '$value'\n`;
      expect(
        analyzeScript(source, parser, {
          readLocalFile: () => ({ kind: "file", source: "namespace: demo\n" }),
        }).diagnostics,
      ).toEqual([]);
      expect(
        analyzeScript(source, parser, {
          readLocalFile: () => ({ kind: "file", source: "namespace: ''\n" }),
        }).diagnostics.map((item) => item.code),
      ).toContain("PIPE202");
      expect(
        analyzeScript(source.replace("set -euo pipefail", "set -e"), parser, {
          readLocalFile: () => ({ kind: "file", source: "namespace: demo\n" }),
        }).diagnostics.map((item) => item.code),
      ).toContain("PIPE202");
    } finally {
      parser.delete();
    }
  });

  it("checks yq image and portal count assertions against local YAML", async () => {
    const parser = await createBashParser(runtime, grammar);
    try {
      const imageSelector =
        ".images[] | select(.name == strenv(IMAGE_ORIGIN_NAME) or .newName == strenv(IMAGE_REPOSITORY))";
      const portalSelector =
        'select(.kind == "Deployment" and .metadata.name == "support-portal") | .spec.template.spec.containers[] | select(.name == "support-portal") | .image';
      const imageSource = `# @pipe stdout: 1\nfail() { printf 'ERROR: %s\\n' "$1" >&2; exit 1; }\nexport IMAGE_ORIGIN_NAME=frontend IMAGE_REPOSITORY=repo\nselector='${imageSelector}'\nyq eval -e "([$selector] | length) == 1" "/project/kustomization.yaml" >/dev/null || fail bad\njq -n '1'\n`;
      expect(
        analyzeScript(imageSource, parser, {
          readLocalFile: () => ({
            kind: "file",
            source: "images:\n  - name: frontend\n    newName: repo\n",
          }),
        }).diagnostics,
      ).toEqual([]);
      expect(
        analyzeScript(imageSource, parser, {
          readLocalFile: () => ({ kind: "file", source: "images: []\n" }),
        }).diagnostics.map((item) => item.code),
      ).toContain("PIPE202");
      const portalSource = `# @pipe stdout: 1\nfail() { printf 'ERROR: %s\\n' "$1" >&2; exit 1; }\nselector='${portalSelector}'\nyq eval-all -e "([$selector] | length) == 1" "/project/portal.yaml" >/dev/null || fail bad\njq -n '1'\n`;
      expect(
        analyzeScript(portalSource, parser, {
          readLocalFile: () => ({
            kind: "file",
            source:
              "kind: Deployment\nmetadata:\n  name: support-portal\nspec:\n  template:\n    spec:\n      containers:\n        - name: support-portal\n          image: repo:tag\n",
          }),
        }).diagnostics,
      ).toEqual([]);
      expect(
        analyzeScript(portalSource, parser, {
          readLocalFile: () => ({ kind: "file", source: "kind: Deployment\n" }),
        }).diagnostics.map((item) => item.code),
      ).toContain("PIPE202");
      const portalRead = `# @pipe stdout: string\nselector='${portalSelector}'\nvalue="$(yq eval -r "$selector" "/project/portal.yaml")"\njq -n --arg value "$value" '$value'\n`;
      expect(
        analyzeScript(portalRead, parser, {
          readLocalFile: () => ({
            kind: "file",
            source:
              "kind: Deployment\nmetadata:\n  name: support-portal\nspec:\n  template:\n    spec:\n      containers:\n        - name: support-portal\n          image: repo:tag\n",
          }),
        }).diagnostics,
      ).toEqual([]);
      expect(
        analyzeScript(portalRead, parser, {
          readLocalFile: () => ({
            kind: "file",
            source:
              "kind: Deployment\nmetadata:\n  name: support-portal\nspec:\n  template:\n    spec:\n      containers:\n        - name: support-portal\n",
          }),
        }).diagnostics.map((item) => item.code),
      ).toContain("PIPE202");
      const portalWrite = `# @pipe stdout: string\nselector='${portalSelector}'\nexport IMAGE_REFERENCE='repo:new'\nyq eval "($selector) = strenv(IMAGE_REFERENCE)" -i "/project/support-portal.yaml"\nvalue="$(yq eval -r "$selector" "/project/support-portal.yaml")"\njq -n --arg value "$value" '$value'\n`;
      const portalYaml =
        "kind: Deployment\nmetadata:\n  name: support-portal\nspec:\n  template:\n    spec:\n      containers:\n        - name: support-portal\n          image: repo:tag\n";
      const written = analyzeScript(portalWrite, parser, {
        readLocalFile: () => ({ kind: "file", source: portalYaml }),
      });
      expect(written.diagnostics).toEqual([]);
      expect(written.effects.filesMayWrite).toEqual([
        "/project/support-portal.yaml",
      ]);
      const encodedReference = portalWrite.replace(
        "IMAGE_REFERENCE='repo:new'",
        `IMAGE_REFERENCE='"repo:new"'`,
      );
      expect(
        analyzeScript(encodedReference, parser, {
          readLocalFile: () => ({ kind: "file", source: portalYaml }),
        }).diagnostics.map((item) => item.code),
      ).toContain("PIPE202");
    } finally {
      parser.delete();
    }
  });

  it("summarizes only structurally verified kustomization yq updates", async () => {
    const parser = await createBashParser(runtime, grammar);
    try {
      const selector =
        ".images[] | select(.name == strenv(IMAGE_ORIGIN_NAME) or .newName == strenv(IMAGE_REPOSITORY))";
      const source = `# @pipe stdout: 1\nimage_selector='${selector}'\nexport IMAGE_ORIGIN_NAME=frontend IMAGE_REPOSITORY=repo IMAGE_VERSION=v2\nhas_digest=true\nif [[ "$has_digest" == true ]]; then\n  version_field=digest\n  obsolete_field=newTag\nelse\n  version_field=newTag\n  obsolete_field=digest\nfi\nyq eval "($image_selector | .newName) = strenv(IMAGE_REPOSITORY) |\n ($image_selector | .$version_field) = strenv(IMAGE_VERSION) |\n del($image_selector | .$obsolete_field)" -i "/project/kustomization.yaml"\njq -n '1'\n`;
      const options = {
        readLocalFile: () => ({
          kind: "file" as const,
          source: "images:\n  - name: frontend\n    newName: repo\n",
        }),
      };
      const result = analyzeScript(source, parser, options);
      expect(result.diagnostics).toEqual([]);
      expect(result.effects.filesMayWrite).toEqual([
        "/project/kustomization.yaml",
      ]);
      const wrongPair = source.replace(
        "obsolete_field=digest\nfi",
        "obsolete_field=newTag\nfi",
      );
      expect(
        analyzeScript(wrongPair, parser, options).diagnostics.map(
          (item) => item.code,
        ),
      ).toContain("PIPE202");
    } finally {
      parser.delete();
    }
  });

  it("checks bounded case-derived directory paths rather than dropping dependencies", async () => {
    const parser = await createBashParser(runtime, grammar);
    try {
      const source = `# @pipe stdin: {"family": string, "environment": string}\n# @pipe stdout: number\ndoc="$(jq -c '.')"\nfamily="$(jq -r '.family' <<< "$doc")"\nenvironment="$(jq -r '.environment' <<< "$doc")"\ncase "$family" in alpha|beta) ;; *) exit 1;; esac\ncase "$environment" in dev|prod) ;; *) exit 1;; esac\npath="/project/resources/$family/overlays/$environment"\nif [[ -d "$path" ]]; then jq -n '1'; else exit 1; fi\n`;
      const expected = new Set([
        "/project/resources/alpha/overlays/dev",
        "/project/resources/alpha/overlays/prod",
        "/project/resources/beta/overlays/dev",
        "/project/resources/beta/overlays/prod",
      ]);
      const paths: string[] = [];
      const options = {
        resolveDirectory: (path: string) => {
          paths.push(path);
          return expected.has(path)
            ? { kind: "directory" as const, path }
            : { kind: "unavailable" as const, reason: "missing" };
        },
      };
      expect(analyzeScript(source, parser, options).diagnostics).toEqual([]);
      expect(new Set(paths)).toEqual(expected);
      expect(
        analyzeScript(source, parser, {
          resolveDirectory: (path) => ({
            kind: "unavailable",
            reason: `missing ${path}`,
          }),
        }).diagnostics.map((item) => item.code),
      ).toContain("PIPE204");
    } finally {
      parser.delete();
    }
  });

  it("tracks IFS read arrays through bounded for loops and blocks unbounded ones", async () => {
    const parser = await createBashParser(runtime, grammar);
    try {
      const valid = `# @pipe stdout: number\nIFS=',' read -r -a items <<< 'a,b'\nfor item in "${"$"}{items[@]}"; do case "$item" in a|b) ;; *) unknown-business-command;; esac; done\njq -n '1'\n`;
      expect(analyzeScript(valid, parser).diagnostics).toEqual([]);
      const multiple = `# @pipe stdout: string\nfor item in a b; do jq -n --arg v "$item" '$v'; done\n`;
      expect(
        analyzeScript(multiple, parser).diagnostics.map((item) => item.code),
      ).toContain("PIPE103");
      const convergent = `# @pipe stdin: string\n# @pipe stdout: number\ninput="$(jq -r '.')"\nIFS=',' read -r -a items <<< "$input"\nfor item in "${"$"}{items[@]}"; do unused=1; done\njq -n '1'\n`;
      expect(analyzeScript(convergent, parser).diagnostics).toEqual([]);
      const unbounded = `# @pipe stdin: string\n# @pipe stdout: number\ninput="$(jq -r '.')"\nIFS=',' read -r -a items <<< "$input"\nfor item in "${"$"}{items[@]}"; do jq -n '1'; done\njq -n '1'\n`;
      expect(
        analyzeScript(unbounded, parser).diagnostics.map((item) => item.code),
      ).toContain("PIPE202");
      const unsupported = `IFS=';' read -r -a items <<< 'a;b'\n`;
      expect(
        analyzeScript(unsupported, parser).diagnostics.map((item) => item.code),
      ).toContain("PIPE202");
    } finally {
      parser.delete();
    }
  });

  it("splits read -r -a on the default Bash IFS without assuming a custom IFS", async () => {
    const parser = await createBashParser(runtime, grammar);
    try {
      const finite = `# @pipe stdout: number\nread -r -a items <<< '  a\tb  '\nfor item in "${"$"}{items[@]}"; do case "$item" in a|b) ;; *) unknown-business-command;; esac; done\njq -n '1'\n`;
      expect(analyzeScript(finite, parser).diagnostics).toEqual([]);
      const empty = `# @pipe stdout: number\nread -r -a items <<< '   '\nfor item in "${"$"}{items[@]}"; do unknown-business-command; done\njq -n '1'\n`;
      expect(analyzeScript(empty, parser).diagnostics).toEqual([]);
      const comma = `# @pipe stdout: "a,b"\nread -r -a items <<< 'a,b'\nfor item in "${"$"}{items[@]}"; do jq -n --arg value "$item" '$value'; done\n`;
      expect(analyzeScript(comma, parser).diagnostics).toEqual([]);
      const dynamic = `# @pipe stdin: string\n# @pipe stdout: number\nname="$(jq -r '.')"\nread -r -a items <<< "$name"\nfor item in "${"$"}{items[@]}"; do unused=1; done\njq -n '1'\n`;
      expect(analyzeScript(dynamic, parser).diagnostics).toEqual([]);
      const custom = `IFS=';'\nread -r -a items <<< 'a;b'\n`;
      expect(
        analyzeScript(custom, parser).diagnostics.map((item) => item.code),
      ).toContain("PIPE202");
      const inherited = `# @pipe env IFS: string\nread -r -a items <<< 'a b'\n`;
      expect(
        analyzeScript(inherited, parser).diagnostics.map((item) => item.code),
      ).toContain("PIPE202");
    } finally {
      parser.delete();
    }
  });

  it("compares verified Bash string lengths without treating arbitrary strings as integers", async () => {
    const parser = await createBashParser(runtime, grammar);
    try {
      const finite = `# @pipe stdout: number\nname='abc'\n[[ ${"$"}{#name} -le 3 ]] || unknown-business-command\njq -n '1'\n`;
      expect(analyzeScript(finite, parser).diagnostics).toEqual([]);
      const dynamic = `# @pipe env NAME: string\n# @pipe stdout: number\n[[ ${"$"}{#NAME} -le 63 ]] || exit 1\njq -n '1'\n`;
      expect(analyzeScript(dynamic, parser).diagnostics).toEqual([]);
      const fatalGroup = `# @pipe env NAME: string\n# @pipe stdout: number\n[[ ${"$"}{#NAME} -le 63 ]] || { printf 'too long\\n' >&2; exit 1; }\njq -n '1'\n`;
      expect(analyzeScript(fatalGroup, parser).diagnostics).toEqual([]);
      const notInteger = `# @pipe env NAME: string\n[[ "$NAME" -le 63 ]]\n`;
      expect(
        analyzeScript(notInteger, parser).diagnostics.map((item) => item.code),
      ).toContain("PIPE202");
      const nonAscii = `# @pipe stdout: number\nname='😀'\n[[ ${"$"}{#name} -le 1 ]] || unknown-business-command\njq -n '1'\n`;
      expect(
        analyzeScript(nonAscii, parser).diagnostics.map((item) => item.code),
      ).toContain("PIPE201");
      const declaration =
        "pattern='^[a-z0-9]([-a-z0-9.]*[a-z0-9])?( [a-z0-9]([-a-z0-9.]*[a-z0-9])?)*$'";
      const fixedRegex = `# @pipe env NAME: string\n${declaration}\n[[ "$NAME" =~ $pattern ]] || { printf 'invalid\\n' >&2; exit 1; }\n`;
      expect(analyzeScript(fixedRegex, parser).diagnostics).toEqual([]);
      for (const source of [
        fixedRegex.replace(declaration, "# @pipe env pattern: string"),
        fixedRegex.replace(declaration, "pattern='[[:alpha:]]'"),
        fixedRegex.replace(declaration, "pattern='[z-a]'"),
        fixedRegex.replace("# @pipe env NAME: string\n", "NAME=abc\n"),
      ])
        expect(
          analyzeScript(source, parser).diagnostics.map((item) => item.code),
          source,
        ).toContain("PIPE202");
      const missingFile = `file='/missing'\n[[ -f "$file" ]] || { printf 'missing\\n' >&2; exit 1; }\nunknown-business-command\n`;
      const missingResult = analyzeScript(missingFile, parser, {
        readLocalFile: () => ({ kind: "unavailable", reason: "missing" }),
      });
      expect(missingResult.diagnostics.map((item) => item.code)).toContain(
        "PIPE204",
      );
      expect(missingResult.diagnostics.map((item) => item.code)).not.toContain(
        "PIPE201",
      );
    } finally {
      parser.delete();
    }
  });

  it("re-associates a Bash length guard and regex test without skipping either operand", async () => {
    const parser = await createBashParser(runtime, grammar);
    try {
      const source = `# @pipe env NAME: string\n# @pipe stdout: number\n[[ ${"$"}{#NAME} -le 63 && "$NAME" =~ ^[a-z0-9]([-a-z0-9]*[a-z0-9])?$ ]] || { printf 'invalid\\n' >&2; exit 1; }\njq -n '1'\n`;
      expect(analyzeScript(source, parser).diagnostics).toEqual([]);
      const badBound = source.replace("-le 63", "-le bad");
      expect(
        analyzeScript(badBound, parser).diagnostics.map((item) => item.code),
      ).toContain("PIPE202");
      const dynamicRegex = source.replace(
        "^[a-z0-9]([-a-z0-9]*[a-z0-9])?$",
        "$UNVERIFIED_PATTERN",
      );
      expect(
        analyzeScript(dynamicRegex, parser).diagnostics.map(
          (item) => item.code,
        ),
      ).toContain("PIPE202");
      const invalidRegex = source.replace(
        "^[a-z0-9]([-a-z0-9]*[a-z0-9])?$",
        "[z-a]",
      );
      expect(
        analyzeScript(invalidRegex, parser).diagnostics.map(
          (item) => item.code,
        ),
      ).toContain("PIPE202");
      const wrongOperator = source.replace(" -le 63 && ", " -le 63 || ");
      expect(
        analyzeScript(wrongOperator, parser).diagnostics.map(
          (item) => item.code,
        ),
      ).toContain("PIPE202");
    } finally {
      parser.delete();
    }
  });

  it("models finite Bash tag and digest parameter removal as raw bytes", async () => {
    const parser = await createBashParser(runtime, grammar);
    try {
      const valid = [
        `# @pipe stdout: {"repository": "registry/repo", "tag": "dev"}\nreference='registry/repo:dev'\nrepository="${"$"}{reference%:*}"\ntag="${"$"}{reference##*:}"\njq -n --arg repository "$repository" --arg tag "$tag" '{repository: $repository, tag: $tag}'\n`,
        `# @pipe stdout: {"repository": "registry/repo", "digest": "sha256:abc"}\nreference='registry/repo@sha256:abc'\nrepository="${"$"}{reference%@*}"\ndigest="${"$"}{reference#*@}"\njq -n --arg repository "$repository" --arg digest "$digest" '{repository: $repository, digest: $digest}'\n`,
        `# @pipe stdin: string\n# @pipe stdout: string\nreference="$(jq -r '.')"\nrepository="${"$"}{reference%:*}"\njq -n --arg value "$repository" '$value'\n`,
      ];
      for (const source of valid)
        expect(analyzeScript(source, parser).diagnostics, source).toEqual([]);
      const raw = `# @pipe stdin: string\n# @pipe stdout: string\nreference="$(jq -r '.')"\nrepository="${"$"}{reference%:*}"\njq -n --argjson value "$repository" '$value'\n`;
      expect(
        analyzeScript(raw, parser).diagnostics.map((item) => item.code),
      ).toContain("PIPE101");
    } finally {
      parser.delete();
    }
  });

  it("records local while/read file dependencies without pretending to analyze iterations", async () => {
    const parser = await createBashParser(runtime, grammar);
    try {
      const source = `# @pipe stdout: number\nfile='/project/allowlist.tsv'\nwhile IFS= read -r field; do jq -n '1'; done < "$file"\njq -n '1'\n`;
      const seen: string[] = [];
      const present = analyzeScript(source, parser, {
        readLocalFile: (path) => {
          seen.push(path);
          return { kind: "file", source: "cloud\taws\n" };
        },
      });
      expect(seen).toEqual(["/project/allowlist.tsv"]);
      expect(present.diagnostics.map((item) => item.code)).toContain("PIPE202");
      const missing = analyzeScript(source, parser, {
        readLocalFile: () => ({ kind: "unavailable", reason: "missing" }),
      });
      expect(missing.diagnostics.map((item) => item.code)).toContain("PIPE204");
      const overwritten = `file='/project/allowlist.tsv'\nx='1'\nwhile read -r field; do x='2'; done < "$file"\njq -n --argjson v "$x" '$v'\n`;
      expect(
        analyzeScript(overwritten, parser, {
          readLocalFile: () => ({ kind: "file", source: "row\n" }),
        }).diagnostics.some((item) =>
          item.message.includes("variable x has an unverified write"),
        ),
      ).toBe(true);
    } finally {
      parser.delete();
    }
  });

  it("analyzes bounded TSV read loops with a proven comment guard", async () => {
    const parser = await createBashParser(runtime, grammar);
    try {
      const source = `# @pipe stdout: "huaweicloud"\nfile='/project/allowlist.tsv'\nrepository='repo-b'\nmatched=''\nwhile IFS=$'\\t' read -r family platform allowlist_repository; do\n  [[ -n "$family" && "$family" != \\#* ]] || continue\n  if [[ "$repository" == "$allowlist_repository" ]]; then matched="$platform"; fi\ndone < "$file"\njq -n --arg value "$matched" '$value'\n`;
      const data =
        "# comment\ncloud\taws\trepo-a\ncloud\thuaweicloud\trepo-b\n";
      expect(
        analyzeScript(source, parser, {
          readLocalFile: () => ({ kind: "file", source: data }),
        }).diagnostics,
      ).toEqual([]);
      expect(
        analyzeScript(source, parser, {
          readLocalFile: () => ({ kind: "file", source: data.slice(0, -1) }),
        }).diagnostics.map((item) => item.code),
      ).toContain("PIPE202");
      expect(
        analyzeScript(source.replace(" || continue", ""), parser, {
          readLocalFile: () => ({ kind: "file", source: data }),
        }).diagnostics.map((item) => item.code),
      ).toContain("PIPE202");
    } finally {
      parser.delete();
    }
  });

  it("checks bounded Bash arithmetic increment and comparison", async () => {
    const parser = await createBashParser(runtime, grammar);
    try {
      const valid = `# @pipe stdout: number\nmatches=0\nmatches=$((matches + 1))\nif (( matches != 1 )); then exit 1; fi\njq -n '1'\n`;
      expect(analyzeScript(valid, parser).diagnostics).toEqual([]);
      const absent = `# @pipe stdout: number\nmatches=0\nif (( matches != 1 )); then exit 1; fi\njq -n '1'\n`;
      expect(
        analyzeScript(absent, parser).diagnostics.map((item) => item.code),
      ).toContain("PIPE202");
      const unsupported = `# @pipe stdout: number\nmatches='08'\nmatches=$((matches + 1))\njq -n '1'\n`;
      expect(
        analyzeScript(unsupported, parser).diagnostics.map((item) => item.code),
      ).toContain("PIPE202");
    } finally {
      parser.delete();
    }
  });

  it("removes a quoted literal suffix from a finite Bash path", async () => {
    const parser = await createBashParser(runtime, grammar);
    try {
      const source = `# @pipe stdout: "registry.example"\nrepository='registry.example/image'\nimage_name=image\nregistry="${"$"}{repository%/"$image_name"}"\njq -n --arg value "$registry" '$value'\n`;
      expect(analyzeScript(source, parser).diagnostics).toEqual([]);
      const unknown = `# @pipe stdin: string\n# @pipe stdout: string\nrepository="$(jq -r '.')"\nimage_name=image\nregistry="${"$"}{repository%/"$image_name"}"\njq -n --arg value "$registry" '$value'\n`;
      expect(analyzeScript(unknown, parser).diagnostics).toEqual([]);
    } finally {
      parser.delete();
    }
  });

  it("keeps jq error paths separate from successful output under errexit", async () => {
    const parser = await createBashParser(runtime, grammar);
    try {
      const filter = `jq 'if . then 1 else error("bad") end'`;
      const valid = `# @pipe stdin: boolean\n# @pipe stdout: number\nset -e\n${filter}\n`;
      expect(analyzeScript(valid, parser).diagnostics).toEqual([]);
      const unguarded = `# @pipe stdin: boolean\n# @pipe stdout: number\n${filter}\n`;
      expect(
        analyzeScript(unguarded, parser).diagnostics.map((item) => item.code),
      ).toContain("PIPE202");
      const noSuccess = `# @pipe stdout: number\nset -e\njq -n 'error("bad")'\n`;
      expect(
        analyzeScript(noSuccess, parser).diagnostics.map((item) => item.code),
      ).toContain("PIPE202");
      const noPipefail = `# @pipe stdin: boolean\n# @pipe stdout: number\nset -e\n${filter} | jq '.'\n`;
      expect(
        analyzeScript(noPipefail, parser).diagnostics.map((item) => item.code),
      ).toContain("PIPE202");
      const withPipefail = `# @pipe stdin: boolean\n# @pipe stdout: number\nset -euo pipefail\n${filter} | jq '.'\n`;
      expect(analyzeScript(withPipefail, parser).diagnostics).toEqual([]);
      const nested = `# @pipe stdout: {"v": [string]}\nset -e\njq -n --arg value x '{v: ([$value] | if length > 0 then . else error("empty") end)}'\n`;
      expect(analyzeScript(nested, parser).diagnostics).toEqual([]);
      const arrayFailure = `# @pipe stdout: []\nset -e\njq -n '[error("bad")]'\n`;
      expect(
        analyzeScript(arrayFailure, parser).diagnostics.map(
          (item) => item.code,
        ),
      ).toContain("PIPE202");
    } finally {
      parser.delete();
    }
  });

  it("checks a declared JSON return without executing the script", async () => {
    const parser = await createBashParser(runtime, grammar);
    try {
      const source =
        '# @pipe stdin: {"id": number}\n# @pipe stdout: {"id": number}\nresult=$(jq -c \'{id: .id}\')\nprintf \'%s\\n\' "$result"\n';
      expect(analyzeScript(source, parser).diagnostics).toEqual([]);
      expect(
        analyzeScript(
          "# @pipe stdin: {\"name\": string}\n# @pipe stdout: string\njq -r '.name'\n",
          parser,
        ).diagnostics.map((item) => item.code),
      ).toEqual(["PIPE101"]);
      expect(
        analyzeScript(
          "# @pipe stdout: [number]\njq -n '1, 2'\n",
          parser,
        ).diagnostics.map((item) => item.code),
      ).toEqual(["PIPE103"]);
      expect(
        analyzeScript("# @pipe stdout: number\njq -n 'empty, 1'\n", parser)
          .diagnostics,
      ).toEqual([]);
      expect(
        analyzeScript(
          "# @pipe stdin: number\n# @pipe stdout: number\njq '.'; jq '.'\n",
          parser,
        ).diagnostics,
      ).toEqual([]);
    } finally {
      parser.delete();
    }
  });

  it("models string contains without accepting unsupported containers or argument streams", async () => {
    const parser = await createBashParser(runtime, grammar);
    try {
      for (const [text, needle, expected] of [
        ["platform-manager-stack-example", "platform-manager-stack", true],
        ["other-cluster", "platform-manager-stack", false],
        ["中文😀", "😀", true],
        ["", "", true],
      ] as const) {
        const result = analyzeScript(
          `# @pipe stdout: ${expected}\njq -n '${JSON.stringify(text)} | contains(${JSON.stringify(needle)})'\n`,
          parser,
        );
        expect(result.diagnostics).toEqual([]);
      }
      expect(
        analyzeScript(
          "# @pipe stdin: string\n# @pipe stdout: boolean\njq 'contains(\"cluster\")'\n",
          parser,
        ).complete,
      ).toBe(true);
      for (const filter of ["[1] | contains([1])", '"x" | contains("x", "y")'])
        expect(
          analyzeScript(`jq -n '${filter}'\n`, parser).diagnostics.map(
            (issue) => issue.code,
          ),
        ).toContain("PIPE202");
      expect(
        analyzeScript(`jq -n '"x" | contains(1)'\n`, parser).diagnostics.map(
          (issue) => issue.code,
        ),
      ).toContain("PIPE102");
    } finally {
      parser.delete();
    }
  });

  it("models only an explicit AWS EKS JSON projection with checked command failures", async () => {
    const parser = await createBashParser(runtime, grammar);
    try {
      const query =
        "aws eks list-clusters --region us-west-2 --output json --no-cli-pager --no-cli-auto-prompt --query clusters";
      const direct = analyzeScript(
        `# @pipe stdout: [string] | null\nset -e\n${query}\n`,
        parser,
      );
      expect(direct.diagnostics).toEqual([]);
      expect(direct.effects.externalMayRun).toEqual(["aws eks list-clusters"]);
      expect(direct.effects.filesMayWriteUnknown).toBe(false);
      const captured = `# @pipe stdout: [string] | null\nset -euo pipefail\nclusters="$(${query})"\njq '.' <<< "$clusters"\n`;
      expect(analyzeScript(captured, parser).complete).toBe(true);
      const guarded = captured
        .replace("set -euo pipefail\n", "fail() { exit 1; }\n")
        .replace(`clusters="$(${query})"`, `clusters="$(${query})" || fail`);
      expect(analyzeScript(guarded, parser).complete).toBe(true);
      const selected = `# @pipe stdout: string\nset -euo pipefail\nname="$(${query} | jq -er '[ (. // [])[] | select(contains("manager")) ] | if length == 1 then .[0] else error("expected one") end')"\njq -n --arg name "$name" '$name'\n`;
      expect(analyzeScript(selected, parser).diagnostics).toEqual([]);
      expect(
        analyzeScript(selected.replace('"$name"', '"$MISSING"'), parser)
          .complete,
      ).toBe(false);
      expect(
        analyzeScript(
          selected.replace("# @pipe stdout: string", "# @pipe stdout: number"),
          parser,
        ).diagnostics.map((issue) => issue.code),
      ).toContain("PIPE102");
      for (const invalid of [
        `${query}\n`,
        captured.replace("set -euo pipefail\n", ""),
        selected.replace("set -euo pipefail", "set -e"),
        `set -euo pipefail\nprintf '%s\\n' "$(${query})"\n`,
        `set -euo pipefail\nprintf '%s\\n' "$(${query} | jq -er '.')"\n`,
        `set -euo pipefail\nexport clusters="$(${query})"\n`,
        `set -euo pipefail\nexport name="$(${query} | jq -er '.[0]')"\n`,
        `set -euo pipefail\n${query} | jq '.' || true\n`,
        `set -e\n${query} <<< 'null'\n`,
        `set -e\nAWS_DEFAULT_OUTPUT=text ${query}\n`,
        `set -e\n${query.replace("--output json", "--output text")}\n`,
        `set -e\n${query.replace(" --output json", "")}\n`,
        `set -e\n${query.replace(" --no-cli-pager", "")}\n`,
        `set -e\n${query.replace(" --no-cli-auto-prompt", "")}\n`,
        `set -e\n${query.replace("--query clusters", "--query '$DYNAMIC'")}\n`,
        `set -e\n${query} --no-paginate\n`,
        `set -e\n${query} --query clusters\n`,
        `set -e\n${query.replace("us-west-2", "$REGION")}\n`,
        `set -e\n${query.replace("us-west-2", '"$MISSING"')}\n`,
      ]) {
        const result = analyzeScript(invalid, parser);
        expect(result.complete, invalid).toBe(false);
        expect(
          result.diagnostics.map((issue) => issue.code),
          invalid,
        ).toContain("PIPE202");
      }
    } finally {
      parser.delete();
    }
  });

  it("does not use outer errexit to prove substitutions whose status is masked by export", async () => {
    const parser = await createBashParser(runtime, grammar);
    try {
      const capture = `# @pipe stdin: boolean\n# @pipe stdout: number\nset -e\nvalue="$(jq 'if . then 1 else error("bad") end')"\njq -n '1'\n`;
      expect(analyzeScript(capture, parser).diagnostics).toEqual([]);
      for (const invalid of [
        capture.replace('value="$(', 'export value="$('),
        `# @pipe stdout: number\nset -e\nexport value="$(jq -ne 'false')"\njq -n '1'\n`,
        capture.replace(
          'value="$(jq \'if . then 1 else error("bad") end\')"',
          "printf '%s\\n' \"$(jq 'if . then 1 else error(\"bad\") end')\"",
        ),
      ]) {
        const result = analyzeScript(invalid, parser);
        expect(result.complete).toBe(false);
        expect(result.diagnostics.map((issue) => issue.code)).toContain(
          "PIPE202",
        );
      }
      expect(
        analyzeScript(
          `# @pipe stdout: number\nset -e\nexport value="$(jq -n '1')"\njq '.' <<< "$value"\n`,
          parser,
        ).complete,
      ).toBe(true);
    } finally {
      parser.delete();
    }
  });

  it("summarizes AWS kubeconfig writes and revokes local snapshot trust without executing AWS", async () => {
    const parser = await createBashParser(runtime, grammar);
    try {
      const update =
        'aws eks --region us-west-2 update-kubeconfig --name "cluster" --no-cli-auto-prompt';
      const result = analyzeScript(`set -e\n${update}\n`, parser);
      expect(result.diagnostics).toEqual([]);
      expect(result.effects.filesMayWrite).toEqual([]);
      expect(result.effects.filesMayWriteUnknown).toBe(true);
      expect(result.effects.externalMayRun).toEqual([
        "aws eks update-kubeconfig",
      ]);
      const githubWrites = analyzeScript(
        `set -e\nprintf 'NAME=%s\\n' '"Alice"' >> "$GITHUB_ENV"\nprintf 'value=%s\\n' '"Alice"' >> "$GITHUB_OUTPUT"\n${update}\n`,
        parser,
        { githubFiles: true },
      );
      expect(githubWrites.complete).toBe(true);
      expect(githubWrites.effects.githubEnv).toEqual({});
      expect(githubWrites.effects.githubOutput).toEqual({});
      for (const invalid of [
        `${update}\n`,
        `set -e\nvalue=$(${update})\n`,
        `set -euo pipefail\n${update} | jq '.'\n`,
        `# @pipe stdout: number\nset -e\n${update}\njq -n '1'\n`,
        `set -e\n${update} --dry-run\n`,
        `set -e\n${update} --query clusters\n`,
        `set -e\n${update.replace(" --no-cli-auto-prompt", "")}\n`,
        `set -e\n${update.replace('"cluster"', "$CLUSTER")}\n`,
      ])
        expect(analyzeScript(invalid, parser).complete, invalid).toBe(false);
      for (const reader of [
        `yq eval -o=json '.namespace' '/project/manifest.yaml'`,
        `if [[ -f '/project/manifest.yaml' ]]; then jq -n '1'; fi`,
        `if [[ -d '/project' ]]; then jq -n '1'; fi`,
        `directory="$(cd -- '/project' && pwd)"`,
        `./child.sh`,
        `sed -E '/^[[:space:]]*(#|$)/d' .github/pins.env >> "$GITHUB_ENV"`,
      ]) {
        let reads = 0;
        const checked = analyzeScript(
          `set -e\n${update}\n${reader}\n`,
          parser,
          {
            githubFiles: true,
            readLocalFile: () => {
              reads++;
              return { kind: "file", source: "namespace: demo\n" };
            },
            resolveDirectory: () => {
              reads++;
              return { kind: "directory", path: "/project" };
            },
            resolveLocalScript: () => {
              reads++;
              return { contract: parseScriptContract(""), complete: true };
            },
          },
        );
        expect(checked.complete, reader).toBe(false);
        expect(
          checked.diagnostics.some((issue) =>
            issue.message.includes("unresolved file write"),
          ),
          reader,
        ).toBe(true);
        expect(reads, reader).toBe(0);
      }
      let resolves = 0;
      const propagated = analyzeScript("./writer.sh\n./reader.sh\n", parser, {
        resolveLocalScript: () => {
          resolves++;
          return {
            contract: parseScriptContract(""),
            complete: true,
            effects: result.effects,
          };
        },
      });
      expect(resolves).toBe(1);
      expect(propagated.complete).toBe(false);
      expect(propagated.effects.filesMayWriteUnknown).toBe(true);
    } finally {
      parser.delete();
    }
  });

  it("models kubectl rollout command families without treating tool logs as JSON returns", async () => {
    const parser = await createBashParser(runtime, grammar);
    try {
      const source = `set -euo pipefail
kind=deployment
namespace=staging
read -r -a targets <<< 'cloud cloud-admin'
for target in "\${targets[@]}"; do
  kubectl rollout restart "$kind/$target" --namespace "$namespace"
done
for target in "\${targets[@]}"; do
  kubectl rollout status "$kind/$target" --namespace "$namespace" --timeout=300s
done
`;
      const valid = analyzeScript(source, parser);
      expect(valid.complete).toBe(true);
      expect(valid.diagnostics).toEqual([]);
      expect(valid.effects.externalMayRun).toEqual([
        "kubectl rollout restart",
        "kubectl rollout status",
      ]);
      for (const command of [
        `kubectl rollout restart 'deployment/cloud' --namespace staging`,
        `kubectl rollout status deployment/cloud --namespace 'staging' --timeout=5m`,
      ])
        expect(
          analyzeScript(`set -e\n${command}\n`, parser).complete,
          command,
        ).toBe(true);

      const command = `kubectl rollout restart "deployment/cloud" --namespace "staging"`;
      for (const rejected of [
        `${command}\n`,
        `set -e\nvalue=$(${command})\n`,
        `# @pipe stdout: number\nset -e\n${command}\njq -n '1'\n`,
        `set -e\n${command} | jq '.'\n`,
        `set -e\n${command} <<< 'null'\n`,
        `set -e\n${command} || true\n`,
        `set -e\nKUBECONFIG=local ${command}\n`,
        `set -e\n${command} --all\n`,
        `set -e\n${command.replace('"deployment/cloud"', "$RESOURCE")}\n`,
        `set -e\n${command.replace('"staging"', '"$MISSING"')}\n`,
        `set -e\nkubectl rollout status "deployment/cloud" --namespace "staging" --timeout="$TIMEOUT"\n`,
      ]) {
        const result = analyzeScript(rejected, parser);
        expect(result.complete, rejected).toBe(false);
        expect(
          result.diagnostics.map((issue) => issue.code),
          rejected,
        ).toContain("PIPE202");
      }
      expect(
        analyzeScript(`set -e\nkubectl delete "deployment/cloud"\n`, parser)
          .complete,
      ).toBe(false);
    } finally {
      parser.delete();
    }
  });

  it("blocks unknown commands rather than borrowing the declared output type", async () => {
    const parser = await createBashParser(runtime, grammar);
    try {
      const result = analyzeScript(
        "# @pipe stdout: number\nbusiness-command\n",
        parser,
      );
      expect(result.complete).toBe(false);
      expect(result.diagnostics.map((item) => item.code)).toEqual(["PIPE201"]);
    } finally {
      parser.delete();
    }
  });

  it("reports direct argument variables even when the external command is unknown", async () => {
    const parser = await createBashParser(runtime, grammar);
    try {
      const source = `known=ok\nunknown-business-command "$MISSING" "$known" "\${DEFAULTED:-fallback}" '$LITERAL'\n`;
      const result = analyzeScript(source, parser);
      expect(result.complete).toBe(false);
      expect(result.diagnostics.map((item) => item.code)).toContain("PIPE201");
      expect(
        result.diagnostics.some(
          (item) =>
            item.code === "PIPE202" &&
            item.message === "Unknown Bash variable MISSING",
        ),
      ).toBe(true);
      expect(JSON.stringify(result.diagnostics)).not.toContain("LITERAL");
      expect(JSON.stringify(result.diagnostics)).not.toContain("DEFAULTED");
    } finally {
      parser.delete();
    }
  });

  it("still reports an independently unknown pipeline consumer after its producer blocks", async () => {
    const parser = await createBashParser(runtime, grammar);
    try {
      const source =
        "printf '%s\\n' \"$MISSING\" | unmodeled-checksum-tool --check -\n";
      const result = analyzeScript(source, parser);
      expect(result.complete).toBe(false);
      expect(result.diagnostics.map((item) => item.code)).toContain("PIPE202");
      expect(
        result.diagnostics.some(
          (item) =>
            item.code === "PIPE201" &&
            item.message ===
              "Command unmodeled-checksum-tool has no contract" &&
            source
              .slice(item.span.start, item.span.end)
              .startsWith("unmodeled-checksum-tool"),
        ),
      ).toBe(true);
      const known = analyzeScript("jq -n '1' | jq '.'\n", parser);
      expect(known.complete).toBe(true);
      expect(known.diagnostics).toEqual([]);
      const modeledTail = analyzeScript(
        "printf '%s\\n' \"$MISSING\" | sha256sum --check -\n",
        parser,
      );
      expect(modeledTail.complete).toBe(false);
      expect(modeledTail.diagnostics.map((item) => item.code)).not.toContain(
        "PIPE201",
      );
    } finally {
      parser.delete();
    }
  });

  it("keeps native text pipelines distinct from JSON script boundaries", async () => {
    const parser = await createBashParser(runtime, grammar);
    try {
      const native = analyzeScript(
        "printf '%s\\n' 'raw' | sha256sum --check -\n",
        parser,
      );
      expect(native.complete).toBe(false);
      expect(native.diagnostics.map((item) => item.code)).toContain("PIPE202");
      expect(native.diagnostics.map((item) => item.code)).not.toContain(
        "PIPE101",
      );
      const json = analyzeScript("printf '%s\\n' 'raw' | jq '.'\n", parser);
      expect(json.diagnostics.map((item) => item.code)).toContain("PIPE101");
      const child = analyzeScript(
        "printf '%s\\n' 'raw' | ./child.sh\n",
        parser,
        {
          resolveLocalScript: () => ({
            contract: parseScriptContract("# @pipe stdin: string\n"),
            complete: true,
          }),
        },
      );
      expect(child.diagnostics.map((item) => item.code)).toContain("PIPE101");
      const ignored = analyzeScript("jq -n '1' | printf '%s\\n' '2'\n", parser);
      expect(ignored.complete).toBe(false);
      expect(ignored.diagnostics.map((item) => item.code)).toContain("PIPE202");
      const noInput = analyzeScript(
        "printf '%s\\n' 'raw' | jq -n '1'\n",
        parser,
      );
      expect(noInput.complete).toBe(false);
      expect(noInput.diagnostics.map((item) => item.code)).toContain("PIPE202");
    } finally {
      parser.delete();
    }
  });

  it("tracks JSON through literal assignments, here-strings and pipelines", async () => {
    const parser = await createBashParser(runtime, grammar);
    try {
      const valid = [
        "# @pipe stdout: number\nset -euo pipefail\nexport LC_ALL=C\njq -n '42'\n",
        "# @pipe stdout: number\nx='42'\njq '.' <<< \"$x\"\n",
        "# @pipe stdout: number\njq -n '42' | jq '.'\n",
        "# @pipe stdin: number\n# @pipe stdout: number\nx=$(jq '.')\njq '.' <<< \"$x\"\n",
        "# @pipe stdout: {\"id\": number}\nx='7'\njq -n --argjson id \"$x\" '{id: $id}'\n",
        "# @pipe stdout: string\nx='Alice'\njq -n --arg name \"$x\" '$name'\n",
        '# @pipe stdout: "Alice"\nraw=$(jq -nr \'"Alice"\')\njq -n --arg value "$raw" \'$value\'\n',
        "# @pipe stdout: number\njq -nr '\"42\"'\n",
        '# @pipe env OPTIONS: {"region": string}\n# @pipe stdout: string\njq -c \'.region\' <<< "$OPTIONS"\n',
        '# @pipe env OPTIONS: {"region": string}\n# @pipe stdout: string\njq -n --argjson options "$OPTIONS" \'$options.region\'\n',
        "# @pipe env X: number\n# @pipe stdout: number\njq -c '.' <<< \"$" +
          '{X}"\n',
        '# @pipe stdin: {"x": number}\n# @pipe stdout: number\nx="$(jq -c \'.x\')"\njq -n --argjson v "$x" \'$v\'\n',
      ];
      for (const source of valid)
        expect(analyzeScript(source, parser).diagnostics, source).toEqual([]);
      expect(
        analyzeScript(
          "# @pipe stdout: string\nx='Alice'\njq -n --argjson name \"$x\" '$name'\n",
          parser,
        ).diagnostics.map((item) => item.code),
      ).toEqual(["PIPE101"]);
      expect(
        analyzeScript(
          "# @pipe stdout: number\njq -ne 'null'\n",
          parser,
        ).diagnostics.map((item) => item.code),
      ).toEqual(["PIPE202"]);
      expect(
        analyzeScript(
          "# @pipe stdout: number\nprintf '%s' '1'\nprintf '%s' '2'\n",
          parser,
        ).diagnostics.map((item) => item.code),
      ).toEqual(["PIPE202"]);
    } finally {
      parser.delete();
    }
  });

  it("uses jq // only where fallback cardinality is proved", async () => {
    const parser = await createBashParser(runtime, grammar);
    try {
      const valid = [
        '# @pipe stdin: {"name": string | null}\n# @pipe stdout: string\njq \'.name // "anonymous"\'\n',
        "# @pipe stdout: number\njq -n 'null // 2'\n",
        "# @pipe stdout: number\njq -n '1 // 2'\n",
      ];
      for (const source of valid)
        expect(analyzeScript(source, parser).diagnostics, source).toEqual([]);
      expect(
        analyzeScript(
          "# @pipe stdout: number\njq -n '(null, 1) // 2'\n",
          parser,
        ).diagnostics.map((item) => item.code),
      ).toEqual(["PIPE202"]);
    } finally {
      parser.delete();
    }
  });

  it("tracks jq collection, introspection and cardinality", async () => {
    const parser = await createBashParser(runtime, grammar);
    try {
      const valid = [
        "# @pipe stdin: [number]\n# @pipe stdout: []\njq 'map(empty)'\n",
        "# @pipe stdin: [number]\n# @pipe stdout: [number]\njq '[.[]]'\n",
        '# @pipe stdin: {"x": number}\n# @pipe stdout: true\njq \'has("x")\'\n',
        '# @pipe stdin: {"x": number}\n# @pipe stdout: "object"\njq \'type\'\n',
        "# @pipe stdin: null\n# @pipe stdout: 0\njq 'length'\n",
        '# @pipe stdin: {"x": string | null}\n# @pipe stdout: string\njq \'.x // "anon" | ascii_upcase\'\n',
      ];
      for (const source of valid)
        expect(analyzeScript(source, parser).diagnostics, source).toEqual([]);
      expect(
        analyzeScript(
          "# @pipe stdin: [number]\n# @pipe stdout: number\njq '.[]'\n",
          parser,
        ).diagnostics.map((item) => item.code),
      ).toEqual(["PIPE103"]);
      expect(
        analyzeScript(
          "# @pipe stdin: {\"x\": string | null}\n# @pipe stdout: string\njq '.x | ascii_upcase'\n",
          parser,
        ).diagnostics.map((item) => item.code),
      ).toEqual(["PIPE102"]);
    } finally {
      parser.delete();
    }
  });

  it("types jq split, unique, index and all without assuming dynamic results", async () => {
    const parser = await createBashParser(runtime, grammar);
    try {
      const valid = [
        '# @pipe stdout: [string]\njq -n \'"a,b" | split(",")\'\n',
        "# @pipe stdin: [number]\n# @pipe stdout: [number]\njq 'unique'\n",
        "# @pipe stdin: [string]\n# @pipe stdout: number | null\njq 'index(\"x\")'\n",
        "# @pipe stdin: [boolean]\n# @pipe stdout: boolean\njq 'all(.[]; .)'\n",
        "# @pipe stdout: true\njq -n '[] | all(.[]; .)'\n",
      ];
      for (const source of valid)
        expect(analyzeScript(source, parser).diagnostics, source).toEqual([]);
      const invalid = [
        "# @pipe stdout: [string]\njq -n '1 | split(\",\")'\n",
        "# @pipe stdout: [number]\njq -n '1 | unique'\n",
        "# @pipe stdout: number | null\njq -n '1 | index(2)'\n",
      ];
      for (const source of invalid)
        expect(
          analyzeScript(source, parser).diagnostics.map((item) => item.code),
          source,
        ).toEqual(["PIPE102"]);
    } finally {
      parser.delete();
    }
  });

  it("checks bounded jq comparisons, branches, bindings and concatenation", async () => {
    const parser = await createBashParser(runtime, grammar);
    try {
      const valid = [
        "# @pipe stdout: true\njq -n '1 == 1'\n",
        '# @pipe stdout: true\njq -n \'9 > 0 and "b" >= "a"\'\n',
        "# @pipe stdout: false\njq -n '1 > 2 or 2 < 1'\n",
        "# @pipe stdout: boolean\njq -n '1 == 1 and true'\n",
        '# @pipe stdout: "x"\njq -n \'if false then 1 else "x" end\'\n',
        '# @pipe stdin: {"x": number}\n# @pipe stdout: {"v": number}\njq \'.x as $v | {v: $v}\'\n',
        "# @pipe stdout: [number]\njq -n '[1] + [2]'\n",
        '# @pipe stdout: {"a": number, "b": string}\njq -n \'{a: 1} + {b: "x"}\'\n',
      ];
      for (const source of valid)
        expect(analyzeScript(source, parser).diagnostics, source).toEqual([]);
      expect(
        analyzeScript(
          "# @pipe stdout: number\njq -n '1 + []'\n",
          parser,
        ).diagnostics.map((item) => item.code),
      ).toEqual(["PIPE202"]);
    } finally {
      parser.delete();
    }
  });

  it("keeps chained jq as bindings scoped to their following pipeline", async () => {
    const parser = await createBashParser(runtime, grammar);
    try {
      const valid = `# @pipe stdin: {"images": [{"platform": string, "image_name": string}]}\n# @pipe stdout: boolean\njq '.images as $images | ($images | map([.platform, .image_name])) as $targets | ($targets | length) == ($targets | unique | length)'\n`;
      expect(analyzeScript(valid, parser).diagnostics).toEqual([]);
      const invalid = `# @pipe stdout: number\njq -n '1 as $first | $second as $third | $first'\n`;
      expect(
        analyzeScript(invalid, parser).diagnostics.map((item) => item.code),
      ).toContain("PIPE202");
    } finally {
      parser.delete();
    }
  });

  it("analyzes bounded jq JSON-lines process substitution without executing it", async () => {
    const parser = await createBashParser(runtime, grammar);
    try {
      const valid = `# @pipe stdin: {"items": [number]}\n# @pipe stdout: 1\ndoc="$(jq -c '.')"\nwhile IFS= read -r item; do\n  jq -n --argjson value "$item" '$value' >/dev/null\ndone < <(jq -c '.items[]' <<< "$doc")\njq -n '1'\n`;
      expect(analyzeScript(valid, parser).diagnostics).toEqual([]);
      const unverified = valid.replace("jq -c '.items[]'", "jq -r '.items[]'");
      expect(
        analyzeScript(unverified, parser).diagnostics.map((item) => item.code),
      ).toContain("PIPE202");
      const extraRedirect = valid.replace(
        '<<< "$doc")',
        '<<< "$doc") >output.json',
      );
      expect(
        analyzeScript(extraRedirect, parser).diagnostics.map(
          (item) => item.code,
        ),
      ).toContain("PIPE202");
      const badBody = valid.replace(
        "jq -n --argjson value \"$item\" '$value' >/dev/null",
        "unknown-business-command",
      );
      expect(
        analyzeScript(badBody, parser).diagnostics.map((item) => item.code),
      ).toContain("PIPE201");
    } finally {
      parser.delete();
    }
  });

  it("carries a fatal per-row platform validation into a later read of the same JSON array", async () => {
    const parser = await createBashParser(runtime, grammar);
    try {
      const source = `# @pipe stdin: {"images": [{"platform": string}]}\n# @pipe stdout: 1\nfail() { printf 'ERROR: %s\\n' "$1" >&2; exit 1; }\ndoc="$(jq -c '.')"\nwhile IFS= read -r image; do\n  platform="$(jq -r '.platform' <<< "$image")"\n  case "$platform" in aws|huaweicloud) ;; *) fail bad ;; esac\ndone < <(jq -c '.images[]' <<< "$doc")\nwhile IFS= read -r image; do\n  platform="$(jq -r '.platform' <<< "$image")"\n  path="/project/$platform"\n  [[ -d "$path" ]] || fail missing\ndone < <(jq -c '.images[]' <<< "$doc")\njq -n '1'\n`;
      const options = {
        resolveDirectory: (path: string) => ({
          kind: "directory" as const,
          path,
        }),
      };
      expect(analyzeScript(source, parser, options).diagnostics).toEqual([]);
      const noFatalGuard = source.replace("*) fail bad ;;", "*) ;; ");
      expect(
        analyzeScript(noFatalGuard, parser, options).diagnostics.map(
          (item) => item.code,
        ),
      ).toContain("PIPE202");
    } finally {
      parser.delete();
    }
  });

  it("finds a bounded jq reduce type fixed point", async () => {
    const parser = await createBashParser(runtime, grammar);
    try {
      const valid = [
        "# @pipe stdin: [number]\n# @pipe stdout: [number]\njq 'reduce .[] as $v ([]; . + [$v])'\n",
        "# @pipe stdin: [{\"platform\": string}]\n# @pipe stdout: [string]\njq 'reduce .[] as $v ([]; if index($v.platform) == null then . + [$v.platform] else . end)'\n",
        "# @pipe stdout: []\njq -n 'reduce ([] | .[]) as $v ([]; . + [$v])'\n",
      ];
      for (const source of valid)
        expect(analyzeScript(source, parser).diagnostics, source).toEqual([]);
      expect(
        analyzeScript(
          "# @pipe stdin: [number]\n# @pipe stdout: [number]\njq 'reduce .[] as $v ([]; ., .)'\n",
          parser,
        ).diagnostics.map((item) => item.code),
      ).toEqual(["PIPE202"]);
    } finally {
      parser.delete();
    }
  });

  it("resolves finite jq dynamic keys without accepting arbitrary keys", async () => {
    const parser = await createBashParser(runtime, grammar);
    try {
      const valid = [
        "# @pipe stdout: number\njq -n --arg key x '{x: 42} | .[$key]'\n",
        '# @pipe stdin: {"key": "x", "data": {"x": number}}\n# @pipe stdout: number\njq \'.data[.key]\'\n',
        '# @pipe stdin: {"key": "aws" | "huaweicloud", "data": {"aws": string, "huaweicloud": string}}\n# @pipe stdout: string\njq \'.data[.key]\'\n',
        '# @pipe stdin: {"key": "aws", "data": {} | {"aws": string}}\n# @pipe stdout: string | null\njq \'.data[.key]\'\n',
      ];
      for (const source of valid)
        expect(analyzeScript(source, parser).diagnostics, source).toEqual([]);
      expect(
        analyzeScript(
          "# @pipe stdout: number\njq -n --arg key y '{x: 42} | .[$key]'\n",
          parser,
        ).diagnostics.map((item) => item.code),
      ).toEqual(["PIPE102"]);
      expect(
        analyzeScript(
          '# @pipe stdin: {"key": string, "data": {"x": number}}\n# @pipe stdout: number\njq \'.data[.key]\'\n',
          parser,
        ).diagnostics.map((item) => item.code),
      ).toEqual(["PIPE202"]);
    } finally {
      parser.delete();
    }
  });

  it("updates closed jq objects only for finite assignment keys", async () => {
    const parser = await createBashParser(runtime, grammar);
    try {
      const valid = [
        `# @pipe stdout: {"aws": string}\njq -n --arg key aws --arg value west '{} | .[$key] = $value'\n`,
        `# @pipe env FLAG: string\n# @pipe stdout: {"aws": string} | {"huaweicloud": string}\nif [[ "$FLAG" == aws ]]; then key=aws; else key=huaweicloud; fi\njq -n --arg key "$key" --arg value west '{} | .[$key] = $value'\n`,
      ];
      for (const source of valid)
        expect(analyzeScript(source, parser).diagnostics, source).toEqual([]);
      const dynamic = `# @pipe env KEY: string\n# @pipe stdout: {"aws": string}\njq -n --arg key "$KEY" '{} | .[$key] = "west"'\n`;
      expect(
        analyzeScript(dynamic, parser).diagnostics.map((item) => item.code),
      ).toContain("PIPE202");
      const multiValue = `# @pipe stdout: {"aws": number}\njq -n '{} | .aws = (1, 2)'\n`;
      expect(
        analyzeScript(multiValue, parser).diagnostics.map((item) => item.code),
      ).toContain("PIPE202");
      const wrongBase = `# @pipe stdout: {"aws": number}\njq -n '1 | .aws = 2'\n`;
      expect(
        analyzeScript(wrongBase, parser).diagnostics.map((item) => item.code),
      ).toContain("PIPE202");
    } finally {
      parser.delete();
    }
  });

  it("models bounded jq //=, += and |= object path updates", async () => {
    const parser = await createBashParser(runtime, grammar);
    try {
      const valid = [
        `# @pipe stdout: {"x": number}\njq -n '{x: null} | .x //= 1'\n`,
        `# @pipe stdout: {"x": 2}\njq -n '{x: 2} | .x //= .missing'\n`,
        `# @pipe stdout: {"aws": {"deployments": [string]}}\njq -n '{aws: {deployments: ["a"]}} | .aws.deployments += ["b"]'\n`,
        `# @pipe stdout: {"aws": {"deployments": [string]}}\njq -n '{aws: {deployments: ["a", "a"]}} | .aws.deployments |= unique'\n`,
      ];
      for (const source of valid)
        expect(analyzeScript(source, parser).diagnostics, source).toEqual([]);
      const invalid = [
        `# @pipe stdout: {}\njq -n '{} | .aws.deployments |= unique'\n`,
        `# @pipe env KEY: string\n# @pipe stdout: {}\njq -n --arg key "$KEY" '{} | .[$key] //= []'\n`,
        `# @pipe stdout: {}\njq -n '{x: 1} | .x += []'\n`,
      ];
      for (const source of invalid)
        expect(
          analyzeScript(source, parser).diagnostics.map((item) => item.code),
          source,
        ).toContain("PIPE202");
    } finally {
      parser.delete();
    }
  });

  it("checks exported JSON env at a local script boundary", async () => {
    const parser = await createBashParser(runtime, grammar);
    try {
      const summary = {
        contract: parseScriptContract("# @pipe env X: string\n"),
        complete: true,
      };
      const options = { resolveLocalScript: () => summary };
      const checks: readonly [string, string[]][] = [
        ["# @pipe env X: string\n./child.sh\n", []],
        ["X='\"Alice\"'\n./child.sh\n", ["PIPE104"]],
        ["X='\"Alice\"'\nexport X\n./child.sh\n", []],
        ["export X='\"Alice\"'\n./child.sh\n", []],
        ["X='Alice'\nexport X\n./child.sh\n", ["PIPE101"]],
        ["X='42'\nexport X\n./child.sh\n", ["PIPE102"]],
      ];
      for (const [source, expected] of checks)
        expect(
          analyzeScript(source, parser, options).diagnostics.map(
            (item) => item.code,
          ),
          source,
        ).toEqual(expected);
      expect(
        analyzeScript("X='42' jq -n '42'\n", parser).diagnostics.map(
          (item) => item.code,
        ),
      ).toEqual(["PIPE202"]);
    } finally {
      parser.delete();
    }
  });

  it("propagates verified local script file effects without executing the callee", async () => {
    const parser = await createBashParser(runtime, grammar);
    try {
      const result = analyzeScript("./child.sh\n", parser, {
        resolveLocalScript: () => ({
          contract: parseScriptContract(""),
          complete: true,
          effects: {
            filesMayWrite: ["/project/resources/overlay.yaml"],
            filesMayWriteUnknown: false,
            githubEnv: {},
            githubEnvMayWrite: [],
            githubOutput: {},
            externalMayRun: [],
          },
        }),
      });
      expect(result.diagnostics).toEqual([]);
      expect(result.effects.filesMayWrite).toEqual([
        "/project/resources/overlay.yaml",
      ]);
    } finally {
      parser.delete();
    }
  });

  it("keeps command-prefixed env scoped to one local call", async () => {
    const parser = await createBashParser(runtime, grammar);
    try {
      const summary = {
        contract: parseScriptContract("# @pipe env X: number\n"),
        complete: true,
      };
      const options = { resolveLocalScript: () => summary };
      const checks: readonly [string, string[]][] = [
        ["X='42' ./child.sh\n", []],
        ["X='Alice' ./child.sh\n", ["PIPE101"]],
        ["X='\"Alice\"' ./child.sh\n", ["PIPE102"]],
        ["X='42' ./child.sh\n./child.sh\n", ["PIPE104"]],
        ["# @pipe env X: number\nX='\"bad\"' ./child.sh\n", ["PIPE102"]],
      ];
      for (const [source, expected] of checks)
        expect(
          analyzeScript(source, parser, options).diagnostics.map(
            (item) => item.code,
          ),
          source,
        ).toEqual(expected);
    } finally {
      parser.delete();
    }
  });

  it("does not capture a pipeline whose final callee has no return interface", async () => {
    const parser = await createBashParser(runtime, grammar);
    try {
      const summary = {
        contract: parseScriptContract("# @pipe stdin: number\n"),
        complete: true,
      };
      const options = { resolveLocalScript: () => summary };
      expect(
        analyzeScript("jq -n '42' | ./child.sh\n", parser, options).diagnostics,
      ).toEqual([]);
      expect(
        analyzeScript(
          "x=$(jq -n '42' | ./child.sh)\n",
          parser,
          options,
        ).diagnostics.map((item) => item.code),
      ).toContain("PIPE104");
    } finally {
      parser.delete();
    }
  });

  it("tracks bounded multi-argument printf bytes and substitution newlines", async () => {
    const parser = await createBashParser(runtime, grammar);
    try {
      const valid = [
        "# @pipe stdout: number\nprintf '%s%s' '1' '2'\n",
        "# @pipe stdout: \"hello-x\"\nx=\"$(printf 'hello-%s\\n' 'x')\"\njq -n --arg v \"$x\" '$v'\n",
        "# @pipe stdout: number\nx=\"$(printf '42\\n')\"\njq -n --argjson v \"$x\" '$v'\n",
        '# @pipe stdout: string\nstamp="$(date +"%Y%m%d-%H%M%S")"\nmessage="$(printf \'bump-%s\' "$stamp")"\njq -n --arg value "$message" \'$value\'\n',
      ];
      for (const source of valid)
        expect(analyzeScript(source, parser).diagnostics, source).toEqual([]);
      expect(
        analyzeScript(
          "# @pipe stdout: number\nprintf '%s%s' '1' 'a'\n",
          parser,
        ).diagnostics.map((item) => item.code),
      ).toEqual(["PIPE101"]);
      expect(
        analyzeScript("printf '%%s' 'x'\n", parser).diagnostics.map(
          (item) => item.code,
        ),
      ).toEqual(["PIPE202"]);
      expect(
        analyzeScript(
          '# @pipe stdout: string\ndate +"%Y%m%d-%H%M%S"\n',
          parser,
        ).diagnostics.map((item) => item.code),
      ).toEqual(["PIPE101"]);
    } finally {
      parser.delete();
    }
  });

  it("still finds certain --arg double encoding after an upstream block", async () => {
    const parser = await createBashParser(runtime, grammar);
    try {
      const summary = {
        contract: parseScriptContract(
          '# @pipe stdin: {"parsed_images": {"x": number}}\n',
        ),
        complete: true,
      };
      const source =
        "parsed_images_json=$(unknown-command)\njq -cn --arg parsed_images \"$parsed_images_json\" '{parsed_images: $parsed_images}' | ./child.sh\n";
      const result = analyzeScript(source, parser, {
        resolveLocalScript: () => summary,
      });
      expect(result.complete).toBe(false);
      expect(result.diagnostics.map((item) => item.code)).toContain("PIPE201");
      expect(result.diagnostics.map((item) => item.code)).toContain("PIPE102");
      const incomplete = analyzeScript(
        "jq -n '{parsed_images: \"text\"}' | ./child.sh\n",
        parser,
        {
          resolveLocalScript: () => ({ ...summary, complete: false }),
        },
      );
      expect(incomplete.diagnostics.map((item) => item.code)).toContain(
        "PIPE102",
      );
      expect(
        analyzeScript("jq -n '{}' | ./child.sh\n", parser, {
          resolveLocalScript: () => summary,
        }).diagnostics.map((item) => item.code),
      ).toEqual(["PIPE104"]);
      const missingDespiteBlock = analyzeScript(
        "value=$(unknown-command)\njq -n --argjson value \"$value\" '{}' | ./child.sh\n",
        parser,
        { resolveLocalScript: () => summary },
      );
      expect(missingDespiteBlock.complete).toBe(false);
      expect(
        missingDespiteBlock.diagnostics.map((item) => item.code),
      ).toContain("PIPE104");
    } finally {
      parser.delete();
    }
  });
});
