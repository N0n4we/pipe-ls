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

async function inProject(
  check: (root: string, path: string) => Promise<void>,
): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "pipe-ls-onepassword-"));
  try {
    const folder = join(root, ".github", "workflows");
    mkdirSync(folder, { recursive: true });
    await check(root, join(folder, "flow.yml"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const loadStep = `      - uses: 1password/load-secrets-action@v2
        id: load
        with:
          export-env: false
        env:
          BASH_ENV: ''
          VALUE: op://synthetic/item/value
`;

describe("1Password static Action envelopes", () => {
  it("models configure/load may-effects without authentication, installation, secret values or definite outputs", async () => {
    await inProject(async (root, path) => {
      const marker = join(root, "MUST-NOT-CREATE");
      const source = `jobs:
  test:
    defaults:
      run:
        shell: bash
    steps:
      - uses: 1password/load-secrets-action/configure@v2
        env:
          BASH_ENV: ''
        with:
          service-account-token: "SECRET_MARKER_NEVER_REPORT\\nBASH_ENV=${marker}"
${loadStep}`;
      writeFileSync(path, source);
      const report = await checkPaths([path]);
      expect(report.complete).toBe(true);
      expect(report.checkedUnits).toBe(2);
      expect(report.diagnostics).toEqual([]);
      expect(report.externalEffects).toEqual([
        "github onepassword configure",
        "github onepassword load-secrets",
      ]);
      expect(report.fileEffectsUnknown).toBe(true);
      expect(JSON.stringify(report)).not.toContain(
        "SECRET_MARKER_NEVER_REPORT",
      );
      expect(existsSync(marker)).toBe(false);
      writeFileSync(
        path,
        `${source}      - env:
          BASH_ENV: ''
        run: |
          # @pipe env OP_SERVICE_ACCOUNT_TOKEN: string
          jq -c '.' <<< "$OP_SERVICE_ACCOUNT_TOKEN"
`,
      );
      const missing = await checkPaths([path]);
      expect(missing.complete).toBe(false);
      expect(
        missing.diagnostics.some((issue) =>
          issue.message.includes(
            "OP_SERVICE_ACCOUNT_TOKEN has no statically proven injection",
          ),
        ),
      ).toBe(true);
      expect(JSON.stringify(missing)).not.toContain(
        "SECRET_MARKER_NEVER_REPORT",
      );
    });
  });

  it("renders optional secret outputs as raw strings, but toJSON as string-or-null rather than guaranteed string", async () => {
    await inProject(async (_root, path) => {
      const source = `jobs:
  test:
    defaults:
      run:
        shell: bash
    steps:
${loadStep}      - env:
          BASH_ENV: ''
          RAW: \${{ steps.load.outputs.INHERITED_REFERENCE }}
          SERIAL: \${{ toJSON(steps.load.outputs.VALUE) }}
        run: |
          # @pipe env SERIAL: string | null
          printf '%s' "$RAW" >/dev/null
          jq -c '.' <<< "$SERIAL" >/dev/null
`;
      writeFileSync(path, source);
      const report = await checkPaths([path]);
      expect(report.complete).toBe(true);
      expect(report.diagnostics).toEqual([]);
      expect(report.checkedUnits).toBe(2);
      writeFileSync(
        path,
        source.replace(
          "# @pipe env SERIAL: string | null",
          "# @pipe env SERIAL: string",
        ),
      );
      const notRequired = await checkPaths([path]);
      expect(
        notRequired.diagnostics.some((issue) => issue.code === "PIPE102"),
      ).toBe(true);
      writeFileSync(
        path,
        source.replace(
          "# @pipe env SERIAL: string | null",
          "# @pipe env RAW: string\n          # @pipe env SERIAL: string | null",
        ),
      );
      const notJson = await checkPaths([path]);
      expect(
        notJson.diagnostics.some((issue) => issue.code === "PIPE101"),
      ).toBe(true);
      writeFileSync(
        path,
        source.replace("export-env: false", "export-env: true"),
      );
      const noOutputs = await checkPaths([path]);
      expect(
        noOutputs.diagnostics.filter((issue) => issue.code === "PIPE104"),
      ).toHaveLength(2);
      writeFileSync(
        path,
        source
          .replace(
            "        run: |",
            `        if: \${{ steps.load.outputs.VALUE != '' }}\n        run: |`,
          )
          .replace(
            "# @pipe env SERIAL: string | null",
            "# @pipe env SERIAL: string",
          ),
      );
      expect(
        (await checkPaths([path])).diagnostics.some(
          (issue) => issue.code === "PIPE102",
        ),
      ).toBe(true);
    });
  });

  it("retains environment, startup and repository barriers, including env-only and unset-previous modes", async () => {
    await inProject(async (root, path) => {
      writeFileSync(join(root, ".github", "pins.env"), 'NAME="Alice"\n');
      const source = `jobs:
  test:
    defaults:
      run:
        shell: bash
    steps:
      - uses: actions/checkout@v4
      - run: printf 'NAME=%s\\n' '"Alice"' >> "$GITHUB_ENV"
${loadStep}      - env:
          BASH_ENV: ''
        run: |
          # @pipe env NAME: string
          jq -c '.' <<< "$NAME"
      - env:
          BASH_ENV: ''
        run: sed -E '/^[[:space:]]*(#|$)/d' .github/pins.env >> "$GITHUB_ENV"
      - run: jq -n '1'
`;
      for (const options of [
        "export-env: false",
        "export-env: true",
        "export-env: false\n          unset-previous: true",
      ]) {
        writeFileSync(path, source.replace("export-env: false", options));
        const report = await checkPaths([path]);
        expect(report.complete).toBe(false);
        expect(
          report.diagnostics.some((issue) =>
            issue.message.includes("NAME has no statically proven injection"),
          ),
        ).toBe(true);
        expect(
          report.diagnostics.some(
            (issue) =>
              issue.code === "PIPE204" &&
              issue.message.includes("Repository contents may have changed"),
          ),
        ).toBe(true);
        expect(
          report.diagnostics.some(
            (issue) =>
              issue.message === "Bash startup environment is not yet analyzed",
          ),
        ).toBe(true);
      }
      // Removing the load Action's own explicit reset must not run a potential
      // installer under startup code introduced by an earlier configure.
      const configureFirst = `jobs:
  test:
    steps:
      - uses: 1password/load-secrets-action/configure@v2
        with:
          service-account-token: \${{ secrets.TOKEN }}
${loadStep.replace("          BASH_ENV: ''\n", "")}`;
      writeFileSync(path, configureFirst);
      expect(
        (await checkPaths([path])).diagnostics.some(
          (issue) =>
            issue.message === "Action Bash startup context is not verified",
        ),
      ).toBe(true);
    });
  });

  it("uses optional outputs in a real reusable caller context without creating required job outputs", async () => {
    await inProject(async (root, path) => {
      const callee = join(root, ".github", "workflows", "callee.yml");
      const source = `on:
  workflow_call:
    inputs:
      label:
        type: string
        required: true
jobs:
  test:
    defaults:
      run:
        shell: bash
    steps:
${loadStep}      - env:
          BASH_ENV: ''
          LABEL: \${{ inputs.label }}
          SECRET_JSON: \${{ toJSON(steps.load.outputs.VALUE) }}
        run: |
          # @pipe env LABEL: string
          # @pipe env SECRET_JSON: string | null
          jq -c '.' <<< "$LABEL" >/dev/null
          jq -c '.' <<< "$SECRET_JSON" >/dev/null
`;
      writeFileSync(callee, source);
      const caller = `jobs:
  call:
    uses: ./.github/workflows/callee.yml
    with:
      label: \${{ toJSON('synthetic') }}
`;
      writeFileSync(path, caller);
      const report = await checkPaths([path]);
      expect(report.complete).toBe(true);
      expect(report.diagnostics).toEqual([]);
      writeFileSync(
        callee,
        source.replace(
          "# @pipe env SECRET_JSON: string | null",
          "# @pipe env SECRET_JSON: string",
        ),
      );
      const invalid = await checkPaths([path]);
      expect(
        invalid.diagnostics.some((issue) => issue.code === "PIPE102"),
      ).toBe(true);
      expect(
        invalid.diagnostics.some((issue) => issue.code === "PIPE202"),
      ).toBe(true);
      writeFileSync(
        path,
        `jobs:
  test:
    outputs:
      required: \${{ steps.load.outputs.VALUE }}
    steps:
${loadStep}`,
      );
      const optional = await checkPaths([path]);
      expect(optional.complete).toBe(false);
      expect(
        optional.diagnostics.some(
          (issue) =>
            issue.code === "PIPE203" &&
            issue.message.includes("no verified producing step"),
        ),
      ).toBe(true);
    });
  });
});
