import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { createOfflineBundle, OFFLINE_ARCHIVES } from "./offline-bundle.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const temp = mkdtempSync(join(tmpdir(), "pipe-ls-package-"));
const inside = (parent, child) => {
  const path = relative(parent, child);
  return path === "" || (path !== ".." && !path.startsWith(`..${sep}`));
};
const run = (program, args, cwd) =>
  execFileSync(program, args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 60_000,
  });

try {
  createOfflineBundle(root, temp);
  const expectedHashes = readFileSync(join(temp, "SHA256SUMS"), "utf8")
    .trim()
    .split("\n");
  if (expectedHashes.length !== OFFLINE_ARCHIVES.length)
    throw new Error("Offline bundle archive list is incomplete");
  for (const [index, name] of OFFLINE_ARCHIVES.entries()) {
    const archive = readFileSync(join(temp, name));
    const actual = `${createHash("sha256").update(archive).digest("hex")}  ${name}`;
    if (expectedHashes[index] !== actual)
      throw new Error(`Offline bundle checksum is invalid for ${name}`);
  }

  mkdirSync(join(temp, "consumer"));
  const consumer = realpathSync(join(temp, "consumer"));
  const guide = readFileSync(join(temp, "INSTALL.md"), "utf8");
  const examplePackage = /```json\n([\s\S]*?)\n```/u.exec(guide)?.[1];
  const exampleWorkspace = /```yaml\n([\s\S]*?)\n```/u.exec(guide)?.[1];
  if (!examplePackage || !exampleWorkspace)
    throw new Error("Offline bundle installation guide is incomplete");
  writeFileSync(join(consumer, "package.json"), `${examplePackage}\n`);
  writeFileSync(join(consumer, "pnpm-workspace.yaml"), `${exampleWorkspace}\n`);
  run(
    "pnpm",
    ["install", "--offline", "--store-dir", join(temp, "empty-store")],
    consumer,
  );

  // A legacy deploy can pass this smoke test while linking straight back into
  // the source workspace. The packed installation must be self-contained.
  const pending = [join(consumer, "node_modules")];
  while (pending.length) {
    const directory = pending.pop();
    if (!directory) continue;
    for (const entry of readdirSync(directory)) {
      const path = join(directory, entry);
      const info = lstatSync(path);
      if (info.isSymbolicLink()) {
        const target = realpathSync(path);
        if (!inside(consumer, target))
          throw new Error(
            `Package link escapes isolated installation: ${path}`,
          );
      } else if (info.isDirectory()) pending.push(path);
    }
  }

  const project = join(temp, "project");
  mkdirSync(join(project, ".github"), { recursive: true });
  const script = join(project, "good.sh");
  writeFileSync(
    script,
    "#!/usr/bin/env bash\n# @pipe stdout: number\njq -n '42'\n",
  );
  const bin = join(
    consumer,
    "node_modules",
    "@pipe-ls",
    "cli",
    "dist",
    "bin.js",
  );
  const report = JSON.parse(
    run(process.execPath, [bin, "check", "--json", script], consumer),
  );
  if (
    !report.complete ||
    report.checkedUnits !== 1 ||
    report.diagnostics.length
  )
    throw new Error(`Packed CLI smoke check failed: ${JSON.stringify(report)}`);
  const installed = JSON.parse(
    readFileSync(
      join(consumer, "node_modules", "@pipe-ls", "cli", "package.json"),
      "utf8",
    ),
  );
  if (installed.version !== "0.1.0")
    throw new Error("Packed CLI version is missing");
  if (run(process.execPath, [bin, "--version"], consumer) !== "0.1.0\n")
    throw new Error(
      "Packed CLI version command disagrees with package version",
    );
  const packedCliPackage = realpathSync(
    join(consumer, "node_modules", "@pipe-ls", "cli", "package.json"),
  );
  const projectLicense = readFileSync(join(root, "LICENSE"), "utf8");
  for (const name of ["core", "hosts", "workspace", "cli"]) {
    const manifestPath = realpathSync(
      join(dirname(packedCliPackage), "..", name, "package.json"),
    );
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    if (
      manifest.version !== "0.1.0" ||
      manifest.private ||
      manifest.license !== "MIT" ||
      manifest.publishConfig?.access !== "public"
    )
      throw new Error(`Packed ${name} release metadata is invalid`);
    for (const [dependency, version] of Object.entries(
      manifest.dependencies ?? {},
    ))
      if (dependency.startsWith("@pipe-ls/") && version !== "0.1.0")
        throw new Error(`Packed ${name} has an invalid workspace dependency`);
    if (
      readFileSync(join(dirname(manifestPath), "LICENSE"), "utf8") !==
      projectLicense
    )
      throw new Error(`Packed ${name} MIT LICENSE is missing or stale`);
  }
  if (
    !readFileSync(
      join(consumer, "node_modules", "@pipe-ls", "cli", "README.md"),
      "utf8",
    ).includes("pipe-ls check")
  )
    throw new Error("Packed CLI README is missing or invalid");
  const notices = readFileSync(
    join(consumer, "node_modules", "@pipe-ls", "cli", "THIRD_PARTY_NOTICES.md"),
    "utf8",
  );
  const packedCorePackage = realpathSync(
    join(dirname(packedCliPackage), "..", "core", "package.json"),
  );
  for (const [name, version, owner] of [
    ["@vscode/tree-sitter-wasm", "0.3.1", packedCliPackage],
    ["web-tree-sitter", "0.27.0", packedCorePackage],
    ["yaml", "2.9.1", packedCorePackage],
  ]) {
    const packagePath = realpathSync(
      join(dirname(owner), "..", "..", name, "package.json"),
    );
    const metadata = JSON.parse(readFileSync(packagePath, "utf8"));
    const license = readFileSync(join(dirname(packagePath), "LICENSE"), "utf8");
    if (
      metadata.version !== version ||
      !notices.includes(`${name} ${version}`) ||
      !notices.includes(license.trim())
    )
      throw new Error(`Packed CLI third-party notice is invalid for ${name}`);
  }
  process.stdout.write(
    "Empty-store offline tarball installation, notices and isolated CLI/WASM check passed.\n",
  );
} finally {
  rmSync(temp, { recursive: true, force: true });
}
