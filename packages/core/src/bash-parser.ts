import { Language, Parser } from "web-tree-sitter";

let runtime: Promise<void> | undefined;

/** Minimal syntax surface; the WASM implementation stays behind the core boundary. */
export interface BashSyntaxNode {
  readonly type: string;
  readonly text: string;
  readonly startIndex: number;
  readonly endIndex: number;
  readonly hasError: boolean;
  readonly namedChildren: readonly BashSyntaxNode[];
  childForFieldName(name: string): BashSyntaxNode | null;
}

export interface BashSyntaxTree {
  readonly rootNode: BashSyntaxNode;
  delete(): void;
}

export interface BashParser {
  readonly language: { readonly name: string | null } | null;
  parse(source: string): BashSyntaxTree | null;
  delete(): void;
}

/** Initialize the in-memory Bash parser; the caller supplies and verifies both WASM assets. */
export async function createBashParser(
  runtimeWasm: Uint8Array,
  grammarWasm: Uint8Array,
): Promise<BashParser> {
  runtime ??= Parser.init({ wasmBinary: runtimeWasm });
  await runtime;
  const language = await Language.load(grammarWasm);
  return new Parser().setLanguage(language);
}
