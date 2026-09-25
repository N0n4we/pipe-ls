import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";

export const MAX_SOURCE_BYTES = 1024 * 1024;

export type SnapshotRead =
  | { readonly kind: "file"; readonly source: string }
  | { readonly kind: "unavailable"; readonly reason: string };
export type DirectoryRead =
  | { readonly kind: "directory"; readonly path: string }
  | { readonly kind: "unavailable"; readonly reason: string };

/** One CLI check keeps each local source (including failed reads) immutable. */
export class ProjectSnapshot {
  readonly root: string;
  private readonly files = new Map<string, SnapshotRead>();
  private readonly directories = new Map<string, DirectoryRead>();
  private readonly outgoing = new Map<string, Set<string>>();
  private readonly incoming = new Map<string, Set<string>>();

  constructor(root: string) {
    this.root = realpathSync(root);
  }

  private inside(path: string): boolean {
    const nested = relative(this.root, path);
    return (
      nested === "" ||
      (nested !== ".." && !nested.startsWith(`..${sep}`) && !isAbsolute(nested))
    );
  }

  private safeRealpath(absolute: string): string {
    let cursor = this.root;
    for (const component of relative(this.root, absolute).split(sep)) {
      if (!component) continue;
      cursor = resolve(cursor, component);
      if (lstatSync(cursor).isSymbolicLink())
        throw new Error("Symbolic link is not analyzed");
    }
    const real = realpathSync(absolute);
    if (!this.inside(real))
      throw new Error("Resolved path escapes the project");
    return real;
  }

  directory(path: string): DirectoryRead {
    if (!isAbsolute(path))
      return {
        kind: "unavailable",
        reason: "Relative directory has no proven cwd",
      };
    const absolute = resolve(path);
    const cached = this.directories.get(absolute);
    if (cached) return cached;
    let result: DirectoryRead;
    if (!this.inside(absolute))
      result = { kind: "unavailable", reason: "Path escapes the project" };
    else {
      try {
        const real = this.safeRealpath(absolute);
        if (!lstatSync(real).isDirectory())
          throw new Error("Path is not a directory");
        result = { kind: "directory", path: real };
      } catch (error) {
        result = {
          kind: "unavailable",
          reason: error instanceof Error ? error.message : String(error),
        };
      }
    }
    const frozen = Object.freeze(result);
    this.directories.set(absolute, frozen);
    return frozen;
  }

  read(path: string): SnapshotRead {
    if (!isAbsolute(path))
      return { kind: "unavailable", reason: "Relative file has no proven cwd" };
    const absolute = resolve(path);
    const cached = this.files.get(absolute);
    if (cached) return cached;
    let result: SnapshotRead;
    if (!this.inside(absolute))
      result = { kind: "unavailable", reason: "Path escapes the project" };
    else {
      try {
        this.safeRealpath(absolute);
        const info = lstatSync(absolute);
        if (!info.isFile()) throw new Error("Path is not a regular file");
        if (info.size > MAX_SOURCE_BYTES)
          throw new Error(`Source exceeds ${MAX_SOURCE_BYTES} byte budget`);
        const source = readFileSync(absolute, "utf8");
        if (Buffer.byteLength(source, "utf8") > MAX_SOURCE_BYTES)
          throw new Error(`Source exceeds ${MAX_SOURCE_BYTES} byte budget`);
        result = { kind: "file", source };
      } catch (error) {
        result = {
          kind: "unavailable",
          reason: error instanceof Error ? error.message : String(error),
        };
      }
    }
    const frozen = Object.freeze(result);
    this.files.set(absolute, frozen);
    return frozen;
  }

  recordDependency(from: string, to: string): void {
    if (!isAbsolute(from) || !isAbsolute(to)) return;
    const source = resolve(from);
    const target = resolve(to);
    if (!this.inside(source) || !this.inside(target)) return;
    const outgoing = this.outgoing.get(source) ?? new Set<string>();
    outgoing.add(target);
    this.outgoing.set(source, outgoing);
    const incoming = this.incoming.get(target) ?? new Set<string>();
    incoming.add(source);
    this.incoming.set(target, incoming);
  }

  dependenciesOf(path: string): readonly string[] {
    return [...(this.outgoing.get(resolve(path)) ?? [])].sort();
  }

  dependentsOf(path: string): readonly string[] {
    return [...(this.incoming.get(resolve(path)) ?? [])].sort();
  }

  /** Changed paths and all transitive dependents; a changed directory covers descendants. */
  affectedByChanges(changedPaths: readonly string[]): readonly string[] {
    const changed = changedPaths
      .filter((path) => isAbsolute(path))
      .map((path) => resolve(path))
      .filter((path) => this.inside(path));
    const affected = new Set<string>(changed);
    const known = new Set([
      ...this.files.keys(),
      ...this.directories.keys(),
      ...this.outgoing.keys(),
      ...this.incoming.keys(),
    ]);
    for (const path of known)
      if (changed.some((item) => path.startsWith(`${item}${sep}`)))
        affected.add(path);
    const pending = [...affected];
    while (pending.length) {
      const path = pending.pop() as string;
      for (const dependent of this.incoming.get(path) ?? [])
        if (!affected.has(dependent)) {
          affected.add(dependent);
          pending.push(dependent);
        }
    }
    return [...affected].sort();
  }

  /** Fork rather than mutating the immutable read view used by one CLI check. */
  forkAfterChanges(changedPaths: readonly string[]): {
    readonly snapshot: ProjectSnapshot;
    readonly affected: readonly string[];
  } {
    const affected = this.affectedByChanges(changedPaths);
    const invalidated = new Set(affected);
    const snapshot = new ProjectSnapshot(this.root);
    for (const [path, read] of this.files)
      if (!invalidated.has(path)) snapshot.files.set(path, read);
    for (const [path, read] of this.directories)
      if (!invalidated.has(path)) snapshot.directories.set(path, read);
    for (const [source, targets] of this.outgoing) {
      if (invalidated.has(source)) continue;
      for (const target of targets) {
        if (invalidated.has(target)) continue;
        snapshot.recordDependency(source, target);
      }
    }
    return { snapshot, affected };
  }
}
