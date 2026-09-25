// web-tree-sitter@0.27.0 refers to this global without shipping its declaration.
export {};

declare global {
  type EmscriptenModule = Record<string, unknown>;
}
