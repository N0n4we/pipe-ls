import { CLI_VERSION, checkPaths } from "./check.js";

export {
  type CheckReport,
  CLI_VERSION,
  checkPaths,
  type ReportDiagnostic,
} from "./check.js";

export async function runCli(
  args: readonly string[],
  write: (text: string) => void = (text) => process.stdout.write(text),
  error: (text: string) => void = (text) => process.stderr.write(text),
): Promise<number> {
  const flags = new Set(args.filter((arg) => arg.startsWith("-")));
  if (flags.has("--help") || flags.has("-h")) {
    write(
      "Usage: pipe-ls check [--json] [paths...]\n       pipe-ls --version\n",
    );
    return 0;
  }
  if (args.length === 1 && args[0] === "--version") {
    write(`${CLI_VERSION}\n`);
    return 0;
  }
  if ([...flags].some((flag) => flag !== "--json")) {
    error(`Unknown option: ${[...flags].join(", ")}\n`);
    return 2;
  }
  const positional = args.filter((arg) => !arg.startsWith("-"));
  if (positional[0] !== "check") {
    error("Usage: pipe-ls check [--json] [paths...]\n");
    return 2;
  }
  try {
    const report = await checkPaths(positional.slice(1));
    if (flags.has("--json")) write(`${JSON.stringify(report)}\n`);
    else {
      for (const item of report.diagnostics)
        write(
          `${item.uri}:${item.range.start.line + 1}:${item.range.start.character + 1} ${item.code} ${item.status}: ${item.message}\n`,
        );
      write(
        `${report.checkedUnits} unit(s) checked; ${report.diagnostics.length} diagnostic(s).\n`,
      );
    }
    return report.complete ? 0 : 1;
  } catch (cause) {
    error(`${cause instanceof Error ? cause.message : String(cause)}\n`);
    return 2;
  }
}
