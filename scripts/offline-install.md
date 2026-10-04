# Local, offline pipe-ls CLI bundle

These seven tarballs contain the CLI, its three workspace dependencies and its
three pinned external runtime dependencies. This is a local distribution bundle,
not a registry publication. pipe-ls is MIT licensed; each pipe-ls tarball
contains `LICENSE`. The CLI tarball also contains `THIRD_PARTY_NOTICES.md`;
upstream dependency tarballs contain their own `LICENSE`.

In an empty `consumer/` directory next to these tarballs, create `package.json`:

```json
{"private":true,"type":"module","dependencies":{"@pipe-ls/cli":"file:../pipe-ls-cli-0.1.0.tgz"}}
```

Create `pnpm-workspace.yaml`:

```yaml
packages: []
overrides:
  '@pipe-ls/core': file:../pipe-ls-core-0.1.0.tgz
  '@pipe-ls/hosts': file:../pipe-ls-hosts-0.1.0.tgz
  '@pipe-ls/workspace': file:../pipe-ls-workspace-0.1.0.tgz
  '@vscode/tree-sitter-wasm': file:../vscode-tree-sitter-wasm-0.3.1.tgz
  'web-tree-sitter': file:../web-tree-sitter-0.27.0.tgz
  'yaml': file:../yaml-2.9.1.tgz
```

Run `pnpm install --offline --store-dir ./empty-store`, then
`node node_modules/@pipe-ls/cli/dist/bin.js check --json <project-path>`.
The project needs a `.github` directory. Never run its scripts or workflows as
part of static checking. Verify the archive hashes in `SHA256SUMS` before moving
the bundle to another machine.
