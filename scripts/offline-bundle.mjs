import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const OFFLINE_ARCHIVES = [
  "pipe-ls-core-0.1.0.tgz",
  "pipe-ls-hosts-0.1.0.tgz",
  "pipe-ls-workspace-0.1.0.tgz",
  "pipe-ls-cli-0.1.0.tgz",
  "vscode-tree-sitter-wasm-0.3.1.tgz",
  "web-tree-sitter-0.27.0.tgz",
  "yaml-2.9.1.tgz",
];

const runPack = (directory, destination) =>
  execFileSync("pnpm", ["pack", "--pack-destination", destination], {
    cwd: directory,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 60_000,
  });

/** Builds a local, self-contained offline bundle without running upstream scripts. */
export function createOfflineBundle(root, destination) {
  if (existsSync(destination) && readdirSync(destination).length > 0)
    throw new Error(`Offline bundle destination is not empty: ${destination}`);
  mkdirSync(destination, { recursive: true });
  for (const name of ["core", "hosts", "workspace", "cli"])
    runPack(join(root, "packages", name), destination);

  const staging = mkdtempSync(join(tmpdir(), "pipe-ls-offline-deps-"));
  try {
    for (const [dependency, folder, expectedName, version] of [
      [
        "packages/cli/node_modules/@vscode/tree-sitter-wasm",
        "vscode-tree-sitter-wasm",
        "@vscode/tree-sitter-wasm",
        "0.3.1",
      ],
      [
        "packages/core/node_modules/web-tree-sitter",
        "web-tree-sitter",
        "web-tree-sitter",
        "0.27.0",
      ],
      ["packages/core/node_modules/yaml", "yaml", "yaml", "2.9.1"],
    ]) {
      const source = realpathSync(join(root, dependency));
      const stage = join(staging, folder);
      cpSync(source, stage, { recursive: true });
      const manifest = join(stage, "package.json");
      const metadata = JSON.parse(readFileSync(manifest, "utf8"));
      if (metadata.name !== expectedName || metadata.version !== version)
        throw new Error(`Unexpected runtime dependency at ${dependency}`);
      if (!existsSync(join(stage, "LICENSE")))
        throw new Error(`Runtime dependency ${expectedName} has no LICENSE`);
      // Installed packages can contain prepack/postpack scripts intended for
      // their source monorepos. Never run them while repacking this bundle.
      delete metadata.scripts;
      writeFileSync(manifest, `${JSON.stringify(metadata)}\n`);
      runPack(stage, destination);
    }
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }

  const hashes = OFFLINE_ARCHIVES.map((name) => {
    const archive = readFileSync(join(destination, name));
    return `${createHash("sha256").update(archive).digest("hex")}  ${name}`;
  });
  writeFileSync(join(destination, "SHA256SUMS"), `${hashes.join("\n")}\n`);
  copyFileSync(
    new URL("./offline-install.md", import.meta.url),
    join(destination, "INSTALL.md"),
  );
}
