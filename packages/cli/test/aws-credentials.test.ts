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
  const root = mkdtempSync(join(tmpdir(), "pipe-ls-aws-credentials-"));
  try {
    const folder = join(root, ".github", "workflows");
    mkdirSync(folder, { recursive: true });
    await check(root, join(folder, "flow.yml"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
const source = `jobs:
  test:
    defaults:
      run:
        shell: bash
    steps:
      - uses: aws-actions/configure-aws-credentials@v4
        id: aws
        env:
          AWS_PROFILE: ''
          ROLE_TO_ASSUME: ''
          HTTP_PROXY: ''
          HTTPS_PROXY: ''
        with:
          aws-access-key-id: SYNTHETIC_KEY_DO_NOT_REPORT
          aws-secret-access-key: SYNTHETIC_SECRET_DO_NOT_REPORT
          aws-region: us-west-2
          role-chaining: false
          use-existing-credentials: false
          output-env-credentials: true
          output-credentials: false
`;
describe("AWS IAM credentials Action envelope", () => {
  it("models main identity-query and end-of-job cleanup effects without running SDK, Actions or startup scripts", async () => {
    await inProject(async (root, path) => {
      const marker = join(root, "MUST-NOT-CREATE");
      const startup = join(root, "startup.sh");
      writeFileSync(startup, `printf executed > '${marker}'\n`);
      writeFileSync(
        path,
        source.replace(
          "          AWS_PROFILE:",
          `          BASH_ENV: '${startup}'\n          AWS_PROFILE:`,
        ),
      );
      const report = await checkPaths([path]);
      expect(report.diagnostics).toEqual([]);
      expect(report.complete).toBe(true);
      expect(report.checkedUnits).toBe(1);
      expect(report.externalEffects).toEqual([
        "aws sts GetCallerIdentity",
        "github aws credentials",
        "github aws credentials cleanup",
      ]);
      expect(report.fileEffectsUnknown).toBe(true);
      expect(JSON.stringify(report)).not.toContain(
        "SYNTHETIC_KEY_DO_NOT_REPORT",
      );
      expect(JSON.stringify(report)).not.toContain(
        "SYNTHETIC_SECRET_DO_NOT_REPORT",
      );
      expect(existsSync(marker)).toBe(false);
      writeFileSync(path, `${source}      - run: jq -n '1'\n`);
      const unsafeNext = await checkPaths([path]);
      expect(unsafeNext.complete).toBe(false);
      expect(
        unsafeNext.diagnostics.some(
          (issue) =>
            issue.message === "Bash startup environment is not yet analyzed",
        ),
      ).toBe(true);
    });
  });

  it("rejects missing, optional or whitespace-only key proofs rather than choosing default credentials", async () => {
    await inProject(async (_root, path) => {
      for (const key of [
        "''",
        "'  '",
        JSON.stringify("\t\uFEFF\n"),
        `\${{ secrets.KEY }}`,
      ] as const) {
        writeFileSync(path, source.replace("SYNTHETIC_KEY_DO_NOT_REPORT", key));
        const report = await checkPaths([path]);
        expect(report.complete).toBe(false);
        expect(
          report.diagnostics.some((issue) =>
            issue.message.includes("access key input is not proven nonblank"),
          ),
        ).toBe(true);
      }
      const load = `      - uses: 1password/load-secrets-action@v2
        id: load
        env:
          BASH_ENV: ''
        with:
          export-env: false
`;
      writeFileSync(
        path,
        source
          .replace(
            "      - uses: aws-actions/",
            `${load}      - uses: aws-actions/`,
          )
          .replace(
            "SYNTHETIC_KEY_DO_NOT_REPORT",
            `\${{ steps.load.outputs.KEY }}`,
          ),
      );
      const optional = await checkPaths([path]);
      expect(optional.complete).toBe(false);
      expect(
        optional.diagnostics.some((issue) =>
          issue.message.includes("access key input is not proven nonblank"),
        ),
      ).toBe(true);
      writeFileSync(
        path,
        source.replace("SYNTHETIC_SECRET_DO_NOT_REPORT", "''"),
      );
      expect(
        (await checkPaths([path])).diagnostics.some((issue) =>
          issue.message.includes("secret key input is not proven nonblank"),
        ),
      ).toBe(true);
    });
  });

  it("bounds ambient profile, proxy, role and early-return controls and honors raw INPUT precedence before trimming", async () => {
    await inProject(async (_root, path) => {
      for (const [oldValue, newValue] of [
        ["          AWS_PROFILE: ''\n", ""],
        ["AWS_PROFILE: ''", "AWS_PROFILE: '  '"],
        ["AWS_PROFILE: ''", "AWS_PROFILE: another-profile"],
        ["ROLE_TO_ASSUME: ''", "ROLE_TO_ASSUME: other-role"],
        ["HTTP_PROXY: ''", "HTTP_PROXY: 'https://static-test.invalid'"],
        ["HTTPS_PROXY: ''", "HTTPS_PROXY: ' '"],
        ["          role-chaining: false\n", ""],
        ["          use-existing-credentials: false\n", ""],
      ] as const) {
        writeFileSync(path, source.replace(oldValue, newValue));
        expect(
          (await checkPaths([path])).diagnostics.some((issue) =>
            issue.message.includes("AWS IAM envelope requires"),
          ),
        ).toBe(true);
      }
      const falseAmbient = source
        .replace(
          "          ROLE_TO_ASSUME: ''",
          "          ROLE_TO_ASSUME: ' '\n          ROLE_CHAINING: false\n          USE_EXISTING_CREDENTIALS: false",
        )
        .replace("          role-chaining: false\n", "")
        .replace("          use-existing-credentials: false\n", "");
      writeFileSync(path, falseAmbient);
      expect((await checkPaths([path])).complete).toBe(true);
      writeFileSync(
        path,
        falseAmbient.replace(
          "USE_EXISTING_CREDENTIALS: false",
          "USE_EXISTING_CREDENTIALS: true",
        ),
      );
      expect((await checkPaths([path])).complete).toBe(false);
      writeFileSync(
        path,
        source
          .replace("ROLE_TO_ASSUME: ''", "ROLE_TO_ASSUME: other-role")
          .replace(
            "          aws-region:",
            "          role-to-assume: ' '\n          aws-region:",
          ),
      );
      expect((await checkPaths([path])).complete).toBe(true);
      writeFileSync(
        path,
        source
          .replace("ROLE_TO_ASSUME: ''", "ROLE_TO_ASSUME: other-role")
          .replace(
            "          aws-region:",
            "          role-to-assume: ''\n          aws-region:",
          ),
      );
      expect((await checkPaths([path])).complete).toBe(false);
    });
  });

  it("keeps outputs optional, scopes credentials output activation, and never uses post cleanup as an earlier-step effect", async () => {
    await inProject(async (_root, path) => {
      const consumer = `      - env:
          BASH_ENV: ''
          ID: \${{ toJSON(steps.aws.outputs.aws-account-id) }}
          ARN: \${{ steps.aws.outputs.authenticated-arn }}
        run: |
          # @pipe env ID: string | null
          jq -c '.' <<< "$ID" >/dev/null
          printf '%s' "$ARN" >/dev/null
`;
      writeFileSync(path, source + consumer);
      const report = await checkPaths([path]);
      expect(report.diagnostics).toEqual([]);
      expect(report.complete).toBe(true);
      writeFileSync(path, source + consumer.replace("string | null", "string"));
      expect(
        (await checkPaths([path])).diagnostics.some(
          (issue) => issue.code === "PIPE102",
        ),
      ).toBe(true);
      const keyConsumer = consumer.replaceAll(
        "aws-account-id",
        "aws-access-key-id",
      );
      writeFileSync(path, source + keyConsumer);
      expect((await checkPaths([path])).complete).toBe(false);
      writeFileSync(
        path,
        source.replace(
          "output-credentials: false",
          "output-credentials: true",
        ) + keyConsumer,
      );
      expect((await checkPaths([path])).complete).toBe(true);
      writeFileSync(
        path,
        source
          .replace("          output-credentials: false\n", "")
          .replace(
            "          AWS_PROFILE:",
            "          OUTPUT_CREDENTIALS: true\n          AWS_PROFILE:",
          ) + keyConsumer,
      );
      expect((await checkPaths([path])).complete).toBe(true);
      writeFileSync(
        path,
        source.replace(
          "          AWS_PROFILE:",
          "          OUTPUT_CREDENTIALS: true\n          AWS_PROFILE:",
        ) + keyConsumer,
      );
      expect((await checkPaths([path])).complete).toBe(false);
      writeFileSync(
        path,
        source.replace(
          "    steps:",
          `    outputs:\n      required: \${{ steps.aws.outputs.aws-account-id }}\n    steps:`,
        ),
      );
      expect((await checkPaths([path])).complete).toBe(false);
    });
  });
});
