import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createWorkspaceGuard,
} from "../../src/workspace-guard";

function makeRoot(): string {
  const path = join(
    tmpdir(),
    `wg-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(path, { recursive: true });
  return path;
}

describe("createWorkspaceGuard", () => {
  let root: string;

  beforeEach(() => {
    root = makeRoot();
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  test("no roots configured → refuses everything with a helpful message", () => {
    const guard = createWorkspaceGuard({});
    const r = guard.check("/tmp/whatever.txt");
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toMatch(/no workspace configured/);
      expect(r.error).toMatch(/explicit Workspace root/);
    }
  });

  test("accepts the workspace root itself and children", () => {
    const guard = createWorkspaceGuard({ workspaceRoot: root });
    expect(guard.check(root).ok).toBe(true);
    expect(guard.check(join(root, "sub", "file.txt")).ok).toBe(true);
  });

  test("refuses siblings and traversal", () => {
    const guard = createWorkspaceGuard({ workspaceRoot: root });
    expect(guard.check("/etc/passwd").ok).toBe(false);
    expect(guard.check(join(root, "..", "outside.txt")).ok).toBe(false);
  });

  test("refuses null bytes", () => {
    const guard = createWorkspaceGuard({ workspaceRoot: root });
    const r = guard.check("/tmp/evil\0.txt");
    expect(r.ok).toBe(false);
  });

  test("refuses sibling-prefix attacks", () => {
    const sibling = makeRoot();
    try {
      const guard = createWorkspaceGuard({ workspaceRoot: root });
      const r = guard.check(join(sibling, "file.txt"));
      expect(r.ok).toBe(false);
    } finally {
      rmSync(sibling, { recursive: true, force: true });
    }
  });

  test("allowedRoots augment workspaceRoot", () => {
    const extra = makeRoot();
    try {
      const guard = createWorkspaceGuard({
        workspaceRoot: root,
        allowedRoots: [extra],
      });
      expect(guard.check(join(root, "a.txt")).ok).toBe(true);
      expect(guard.check(join(extra, "b.txt")).ok).toBe(true);
      expect(guard.roots.length).toBe(2);
    } finally {
      rmSync(extra, { recursive: true, force: true });
    }
  });

  test("canonicalises symlinked roots", () => {
    const realDir = makeRoot();
    const linkDir = join(tmpdir(), `wg-link-${Date.now()}`);
    try {
      symlinkSync(realDir, linkDir);
      const guard = createWorkspaceGuard({ workspaceRoot: linkDir });
      writeFileSync(join(realDir, "x.txt"), "x");
      // Caller supplies the real path — resolves to the same canonical
      // root as the symlink, must be accepted.
      expect(guard.check(join(realDir, "x.txt")).ok).toBe(true);
    } finally {
      rmSync(linkDir, { force: true });
      rmSync(realDir, { recursive: true, force: true });
    }
  });

  test("returns resolved absolute path on success", () => {
    const guard = createWorkspaceGuard({ workspaceRoot: root });
    const r = guard.check(join(root, "sub", "..", "sub", "file.txt"));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.resolved).toMatch(/sub\/file\.txt$/);
    }
  });
});
