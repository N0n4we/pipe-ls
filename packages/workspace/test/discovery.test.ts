import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  discoverProjectRoot,
  discoverTargets,
  MAX_DISCOVERY_DEPTH,
  MAX_DISCOVERY_ENTRIES,
  ProjectDiscoveryError,
} from "../src/index.js";

describe(".github-only project discovery", () => {
  it("finds the nearest root and does not mix nested projects", () => {
    const root = mkdtempSync(join(tmpdir(), "pipe-ls-discovery-"));
    try {
      mkdirSync(join(root, ".github", "workflows"), { recursive: true });
      mkdirSync(join(root, "sub", ".github"), { recursive: true });
      mkdirSync(join(root, "node_modules"));
      writeFileSync(join(root, "a.sh"), "");
      writeFileSync(join(root, "sub", "b.sh"), "");
      writeFileSync(join(root, "node_modules", "ignore.sh"), "");
      writeFileSync(
        join(root, ".github", "workflows", "main.yml"),
        "jobs: {}\n",
      );
      expect(discoverProjectRoot(join(root, "sub", "b.sh"))).toBe(
        realpathSync(join(root, "sub")),
      );
      expect(discoverTargets(root).map((target) => target.path)).toEqual([
        realpathSync(join(root, ".github", "workflows", "main.yml")),
        realpathSync(join(root, "a.sh")),
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not infer a project from package or VCS metadata", () => {
    const root = mkdtempSync(join(tmpdir(), "pipe-ls-no-root-"));
    try {
      writeFileSync(join(root, "package.json"), "{}");
      expect(() => discoverProjectRoot(root)).toThrow(ProjectDiscoveryError);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("stops directory traversal at the depth budget", () => {
    const root = mkdtempSync(join(tmpdir(), "pipe-ls-discovery-budget-"));
    try {
      mkdirSync(join(root, ".github"));
      let cursor = root;
      for (let i = 0; i <= MAX_DISCOVERY_DEPTH; i++) {
        cursor = join(cursor, "d");
        mkdirSync(cursor);
      }
      expect(() => discoverTargets(root)).toThrow(
        "Project discovery budget exceeded",
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("stops streaming directory entries at the item budget", () => {
    const root = mkdtempSync(join(tmpdir(), "pipe-ls-discovery-items-"));
    try {
      mkdirSync(join(root, ".github"));
      for (let i = 0; i < MAX_DISCOVERY_ENTRIES; i++)
        writeFileSync(join(root, `entry-${i}`), "");
      expect(() => discoverTargets(root)).toThrow(
        "Project discovery budget exceeded",
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);
});
