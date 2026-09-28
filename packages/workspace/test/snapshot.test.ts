import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MAX_SOURCE_BYTES, ProjectSnapshot } from "../src/index.js";

describe("read-only project snapshot", () => {
  it("forks a fresh view for changed dependencies without invalidating unrelated reads", () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "pipe-ls-fork-")));
    try {
      const entry = join(root, "entry.sh");
      const middle = join(root, "middle.sh");
      const leaf = join(root, "leaf.sh");
      const independent = join(root, "independent.sh");
      const missing = join(root, "new.env");
      const directory = join(root, "assets");
      const config = join(directory, "config.yaml");
      mkdirSync(directory);
      for (const path of [entry, middle, leaf, independent, config])
        writeFileSync(path, "original");
      const snapshot = new ProjectSnapshot(root);
      for (const path of [entry, middle, leaf, independent, config])
        expect(snapshot.read(path)).toEqual({
          kind: "file",
          source: "original",
        });
      expect(snapshot.read(missing).kind).toBe("unavailable");
      expect(snapshot.directory(directory).kind).toBe("directory");
      snapshot.recordDependency(entry, middle);
      snapshot.recordDependency(middle, leaf);
      snapshot.recordDependency(entry, config);
      snapshot.recordDependency(entry, missing);

      writeFileSync(leaf, "changed leaf");
      writeFileSync(independent, "changed independent");
      const changedLeaf = snapshot.forkAfterChanges([leaf]);
      expect(changedLeaf.affected).toEqual([entry, leaf, middle].sort());
      expect(snapshot.read(leaf)).toEqual({ kind: "file", source: "original" });
      expect(changedLeaf.snapshot.read(leaf)).toEqual({
        kind: "file",
        source: "changed leaf",
      });
      expect(changedLeaf.snapshot.read(independent)).toEqual({
        kind: "file",
        source: "original",
      });
      expect(changedLeaf.snapshot.dependenciesOf(entry)).toEqual([]);
      expect(snapshot.dependenciesOf(entry)).toEqual(
        [config, middle, missing].sort(),
      );

      const changedDirectory = snapshot.forkAfterChanges([directory]);
      expect(changedDirectory.affected).toEqual(
        [directory, config, entry].sort(),
      );
      expect(changedDirectory.snapshot.dependenciesOf(middle)).toEqual([leaf]);

      writeFileSync(missing, "created");
      const created = snapshot.forkAfterChanges([missing]);
      expect(created.affected).toEqual([entry, missing].sort());
      expect(created.snapshot.read(missing)).toEqual({
        kind: "file",
        source: "created",
      });
      expect(snapshot.read(missing).kind).toBe("unavailable");
      expect(
        snapshot.affectedByChanges(["relative", join(root, "..", "outside")]),
      ).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("freezes reads, tracks reverse edges and rejects unsafe or oversized paths", () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "pipe-ls-snapshot-")));
    const outside = realpathSync(
      mkdtempSync(join(tmpdir(), "pipe-ls-outside-")),
    );
    try {
      mkdirSync(join(root, ".github"));
      const source = join(root, "a.sh");
      const dependency = join(root, "b.sh");
      writeFileSync(source, "first");
      writeFileSync(dependency, "second");
      const snapshot = new ProjectSnapshot(root);
      expect(snapshot.read("relative.sh")).toMatchObject({
        kind: "unavailable",
      });
      expect(snapshot.directory(root)).toEqual({
        kind: "directory",
        path: root,
      });
      expect(snapshot.read(source)).toEqual({ kind: "file", source: "first" });
      writeFileSync(source, "changed");
      expect(snapshot.read(source)).toEqual({ kind: "file", source: "first" });
      snapshot.recordDependency(source, dependency);
      expect(snapshot.dependenciesOf(source)).toEqual([dependency]);
      expect(snapshot.dependentsOf(dependency)).toEqual([source]);
      const link = join(root, "link.sh");
      symlinkSync(dependency, link);
      expect(snapshot.read(link)).toMatchObject({ kind: "unavailable" });
      const nested = join(root, "nested");
      mkdirSync(nested);
      expect(snapshot.directory(nested)).toEqual({
        kind: "directory",
        path: nested,
      });
      writeFileSync(join(nested, "child.sh"), "data");
      const alias = join(root, "alias");
      symlinkSync(nested, alias);
      expect(snapshot.read(join(alias, "child.sh"))).toMatchObject({
        kind: "unavailable",
      });
      expect(snapshot.directory(alias)).toMatchObject({ kind: "unavailable" });
      expect(snapshot.directory(join(root, "missing"))).toMatchObject({
        kind: "unavailable",
      });
      expect(snapshot.directory(join(outside, "missing"))).toMatchObject({
        kind: "unavailable",
        reason: "Path escapes the project",
      });
      expect(snapshot.read(join(outside, "x.sh"))).toMatchObject({
        kind: "unavailable",
        reason: "Path escapes the project",
      });
      const huge = join(root, "huge.sh");
      writeFileSync(huge, "x".repeat(MAX_SOURCE_BYTES + 1));
      expect(snapshot.read(huge)).toMatchObject({ kind: "unavailable" });
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });
});
