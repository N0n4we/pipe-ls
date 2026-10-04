import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { checkPaths } from "../src/index.js";

describe("immutable GitHub step output dataflow", () => {
  it("does not treat JavaScript prototype names as produced values, but permits actually written outputs with those names", async () => {
    const root = mkdtempSync(join(tmpdir(), "pipe-ls-step-own-values-"));
    try {
      const folder = join(root, ".github", "workflows");
      mkdirSync(folder, { recursive: true });
      const path = join(folder, "flow.yml");
      const source = `jobs:
  test:
    outputs:
      value: \${{ steps.producer.outputs.constructor }}
    defaults:
      run:
        shell: bash
    steps:
      - id: producer
        run: printf '%s\\n' 'no named output'
      - env:
          VALUE: \${{ steps.producer.outputs.constructor }}
        run: |
          # @pipe env VALUE: string
          jq -c '.' <<< "$VALUE" >/dev/null
`;
      writeFileSync(path, source);
      const absent = await checkPaths([path]);
      expect(absent.complete).toBe(false);
      expect(
        absent.diagnostics.some(
          (issue) =>
            issue.code === "PIPE104" &&
            issue.message.includes("does not write GITHUB_OUTPUT constructor"),
        ),
      ).toBe(true);
      expect(absent.diagnostics.some((issue) => issue.code === "PIPE203")).toBe(
        true,
      );
      writeFileSync(
        path,
        source.replace(
          "printf '%s\\n' 'no named output'",
          `printf 'constructor=%s\\n' '"synthetic"' >> "$GITHUB_OUTPUT"`,
        ),
      );
      const present = await checkPaths([path]);
      expect(present.diagnostics).toEqual([]);
      expect(present.complete).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("retains literal metadata across Action/file barriers only under the same stable input guard", async () => {
    const root = mkdtempSync(join(tmpdir(), "pipe-ls-step-metadata-"));
    try {
      const folder = join(root, ".github", "workflows");
      mkdirSync(folder, { recursive: true });
      const path = join(folder, "flow.yml");
      const marker = join(root, "MUST-NOT-DOWNLOAD");
      writeFileSync(
        join(root, ".github", "pins.env"),
        `DIGEST=${"0".repeat(64)}\nURL=https://static-test.invalid/archive\n`,
      );
      const source = `on:
  workflow_dispatch:
    inputs:
      platform:
        type: string
jobs:
  test:
    defaults:
      run:
        shell: bash
    steps:
      - uses: actions/checkout@v4
      - id: pins
        if: \${{ inputs.platform == 'hw' }}
        run: sed -E '/^[[:space:]]*(#|$)/d' .github/pins.env >> "$GITHUB_OUTPUT"
      - uses: 1password/load-secrets-action@v2
        env:
          BASH_ENV: ''
      - if: \${{ inputs.platform == 'hw' }}
        env:
          BASH_ENV: ''
          DIGEST: \${{ steps.pins.outputs.DIGEST }}
          URL: \${{ steps.pins.outputs.URL }}
          DESTINATION: '${marker}'
        run: |
          set -euo pipefail
          curl --disable --globoff --proto '=https' --proto-redir '=https' --fail --silent --show-error --location --retry 3 --url "$URL" --output "$DESTINATION"
          printf '%s  %s\\n' "$DIGEST" "$DESTINATION" | sha256sum --check -
      - if: \${{ inputs.platform == 'hw' }}
        env:
          BASH_ENV: ''
          DIGEST: \${{ steps.pins.outputs.DIGEST }}
          DESTINATION: '${marker}'
        run: |
          set -euo pipefail
          printf '%s  %s\\n' "$DIGEST" "$DESTINATION" | sha256sum --check -
`;
      writeFileSync(path, source);
      const report = await checkPaths([path]);
      expect(report.diagnostics).toEqual([]);
      expect(report.complete).toBe(true);
      expect(report.externalEffects).toEqual([
        "curl download",
        "github onepassword load-secrets",
        "sha256sum check",
      ]);
      expect(report.fileEffectsUnknown).toBe(true);
      expect(existsSync(marker)).toBe(false);
      // Input equality guards are stable; no implication is guessed for
      // differing, absent, disjunctive or status-function-bearing consumers.
      for (const condition of [
        "",
        `      - if: \${{ inputs.platform == 'other' }}\n`,
        `      - if: \${{ inputs.platform == 'hw' || true }}\n`,
        `      - if: \${{ always() && inputs.platform == 'hw' }}\n`,
      ]) {
        writeFileSync(
          path,
          source.replace(
            `      - if: \${{ inputs.platform == 'hw' }}\n`,
            condition || "      -\n",
          ),
        );
        const invalid = await checkPaths([path]);
        expect(invalid.complete).toBe(false);
        expect(
          invalid.diagnostics.some(
            (issue) => issue.code === "PIPE202" || issue.code === "PIPE203",
          ),
        ).toBe(true);
      }
      writeFileSync(
        path,
        source.replace('>> "$GITHUB_OUTPUT"', '>> "$GITHUB_ENV"'),
      );
      const notOutput = await checkPaths([path]);
      expect(notOutput.complete).toBe(false);
      expect(
        notOutput.diagnostics.some((issue) => issue.message.includes("DIGEST")),
      ).toBe(true);
      expect(existsSync(marker)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("checks fromJSON input-guarded metadata through a real reusable caller and rejects a wrong wire", async () => {
    const root = mkdtempSync(join(tmpdir(), "pipe-ls-step-metadata-call-"));
    try {
      const folder = join(root, ".github", "workflows");
      mkdirSync(folder, { recursive: true });
      const caller = join(folder, "caller.yml");
      const callee = join(folder, "callee.yml");
      writeFileSync(
        join(root, ".github", "pins.env"),
        'NAME_JSON="synthetic"\n',
      );
      writeFileSync(
        callee,
        `on:
  workflow_call:
    inputs:
      platform:
        type: string
        required: true
jobs:
  test:
    defaults:
      run:
        shell: bash
    steps:
      - uses: actions/checkout@v4
      - id: pins
        if: \${{ fromJSON(inputs.platform) == 'hw' }}
        run: sed -E '/^[[:space:]]*(#|$)/d' .github/pins.env >> "$GITHUB_OUTPUT"
      - if: \${{ fromJSON(inputs.platform) == 'hw' }}
        env:
          NAME: \${{ steps.pins.outputs.NAME_JSON }}
        run: |
          # @pipe env NAME: string
          jq -c '.' <<< "$NAME" >/dev/null
`,
      );
      const source = `jobs:
  call:
    uses: ./.github/workflows/callee.yml
    with:
      platform: \${{ toJSON('hw') }}
`;
      writeFileSync(caller, source);
      const report = await checkPaths([caller]);
      expect(report.diagnostics).toEqual([]);
      expect(report.complete).toBe(true);
      writeFileSync(caller, source.replace(`\${{ toJSON('hw') }}`, "hw"));
      const invalid = await checkPaths([caller]);
      expect(invalid.complete).toBe(false);
      expect(
        invalid.diagnostics.some((issue) => issue.code === "PIPE203"),
      ).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
