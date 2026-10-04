import { createSpan, type Span } from "./span.js";
import {
  parseTemplate,
  type Template,
  TemplateSyntaxError,
} from "./template.js";

export interface ContractIssue {
  readonly code: "PIPE104";
  readonly message: string;
  readonly span: Span;
}
export interface ScriptContract {
  readonly stdin?: Template;
  readonly stdout?: Template;
  readonly env: Readonly<Record<string, Template>>;
  readonly issues: readonly ContractIssue[];
}

/** Only the leading comment/blank region may declare a script interface. */
export function parseScriptContract(source: string): ScriptContract {
  const env: Record<string, Template> = Object.create(null);
  const issues: ContractIssue[] = [];
  let stdin: Template | undefined;
  let stdout: Template | undefined;
  let offset = 0;
  let header = true;
  for (const line of source.split(/(?<=\n)/u)) {
    const raw = line.replace(/\r?\n$/u, "");
    const declaration = /^\s*#\s*@pipe(?:\s+(.*))?$/u.exec(raw);
    if (declaration) {
      const span = createSpan(offset, offset + raw.length);
      if (!header) {
        issues.push({
          code: "PIPE104",
          message: "Interface declaration must be in the header",
          span,
        });
      } else {
        const body = declaration[1] ?? "";
        const match =
          /^(stdin|stdout|env\s+[A-Za-z_][A-Za-z_0-9]*)\s*:\s*(.+)$/u.exec(
            body,
          );
        if (!match)
          issues.push({
            code: "PIPE104",
            message: "Invalid interface declaration",
            span,
          });
        else {
          const key = match[1] as string;
          const rawTemplate = match[2] as string;
          try {
            const value = parseTemplate(rawTemplate);
            if (key === "stdin") {
              if (stdin)
                issues.push({
                  code: "PIPE104",
                  message: "Duplicate stdin declaration",
                  span,
                });
              else stdin = value;
            } else if (key === "stdout") {
              if (stdout)
                issues.push({
                  code: "PIPE104",
                  message: "Duplicate stdout declaration",
                  span,
                });
              else stdout = value;
            } else {
              const name = key.slice(4).trim();
              if (Object.hasOwn(env, name))
                issues.push({
                  code: "PIPE104",
                  message: `Duplicate env ${name} declaration`,
                  span,
                });
              else env[name] = value;
            }
          } catch (error) {
            if (!(error instanceof TemplateSyntaxError)) throw error;
            issues.push({ code: "PIPE104", message: error.message, span });
          }
        }
      }
    } else if (raw.trim() !== "" && !/^\s*#/u.test(raw)) header = false;
    offset += line.length;
  }
  return {
    ...(stdin ? { stdin } : {}),
    ...(stdout ? { stdout } : {}),
    env,
    issues,
  };
}
