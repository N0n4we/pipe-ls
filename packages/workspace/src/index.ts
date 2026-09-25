import { lstatSync, opendirSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";

export {
  MAX_SOURCE_BYTES,
  ProjectSnapshot,
  type SnapshotRead,
} from "./snapshot.js";

export class ProjectDiscoveryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProjectDiscoveryError";
  }
}

function directory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function within(root: string, path: string): boolean {
  return path === root || path.startsWith(`${root}${sep}`);
}

/** Find the nearest real .github directory; no VCS or package fallback. */
export function discoverProjectRoot(entry: string): string {
  const absolute = resolve(entry);
  let cursor: string;
  try {
    const info = lstatSync(absolute);
    if (info.isSymbolicLink())
      throw new ProjectDiscoveryError(
        `Symbolic-link entry is not allowed: ${absolute}`,
      );
    cursor = info.isDirectory() ? absolute : dirname(absolute);
  } catch (error) {
    if (error instanceof ProjectDiscoveryError) throw error;
    throw new ProjectDiscoveryError(`Entry is not readable: ${absolute}`);
  }
  for (;;) {
    const marker = join(cursor, ".github");
    try {
      const info = lstatSync(marker);
      if (
        info.isDirectory() &&
        !info.isSymbolicLink() &&
        within(realpathSync(cursor), realpathSync(marker))
      )
        return realpathSync(cursor);
    } catch {
      /* continue to parent */
    }
    const parent = dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  throw new ProjectDiscoveryError(
    `No .github project root found for ${absolute}`,
  );
}

export type TargetKind = "script" | "workflow";
export const MAX_DISCOVERY_ENTRIES = 10_000;
export const MAX_DISCOVERY_DEPTH = 64;
export interface Target {
  readonly path: string;
  readonly kind: TargetKind;
  readonly root: string;
}

/** Discover only first-version targets without following links or nested projects. */
export function discoverTargets(
  root: string,
  explicit?: string,
): readonly Target[] {
  const realRoot = realpathSync(root);
  const targets: Target[] = [];
  let visited = 0;
  const inspect = (path: string, depth: number): void => {
    if (++visited > MAX_DISCOVERY_ENTRIES || depth > MAX_DISCOVERY_DEPTH)
      throw new ProjectDiscoveryError("Project discovery budget exceeded");
    const info = lstatSync(path);
    if (info.isSymbolicLink())
      throw new ProjectDiscoveryError(`Symbolic link is not analyzed: ${path}`);
    const real = realpathSync(path);
    if (!within(realRoot, real))
      throw new ProjectDiscoveryError(`Path escapes project: ${path}`);
    if (info.isDirectory()) {
      if ([".git", ".jj", "node_modules"].includes(basename(path))) return;
      if (path !== realRoot && directory(join(path, ".github"))) return;
      const entries = opendirSync(path);
      try {
        for (let entry = entries.readSync(); entry; entry = entries.readSync())
          inspect(join(path, entry.name), depth + 1);
      } finally {
        entries.closeSync();
      }
      return;
    }
    if (!info.isFile()) return;
    if (path.endsWith(".sh"))
      targets.push({ path: real, kind: "script", root: realRoot });
    else if (
      /\.github\/workflows\/[^/]+\.ya?ml$/u.test(
        real.slice(realRoot.length).replaceAll(sep, "/"),
      )
    )
      targets.push({ path: real, kind: "workflow", root: realRoot });
  };
  const lexicalStart = explicit ? resolve(explicit) : realRoot;
  if (lstatSync(lexicalStart).isSymbolicLink())
    throw new ProjectDiscoveryError(
      `Symbolic link is not analyzed: ${lexicalStart}`,
    );
  const start = realpathSync(lexicalStart);
  if (!within(realRoot, start))
    throw new ProjectDiscoveryError(`Entry escapes project: ${start}`);
  inspect(start, 0);
  return targets.sort((a, b) =>
    a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
  );
}
