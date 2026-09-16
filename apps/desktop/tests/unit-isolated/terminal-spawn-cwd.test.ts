import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { resolveTerminalSpawnCwd } from "../../electron/terminal-spawn-cwd";

const roots: string[] = [];

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "nautilo-terminal-cwd-"));
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("terminal spawn cwd authority", () => {
  test("accepts a repository beneath the exact sandbox Current Folder", () => {
    const currentFolder = tempRoot();
    const repo = join(currentFolder, "code", "worktrees", "nautilo-main");
    mkdirSync(repo, { recursive: true });

    expect(
      resolveTerminalSpawnCwd({
        requestedCwd: repo,
        sandboxWorkspace: currentFolder,
        fallbackWorkspace: "/unrelated/workspace",
      }),
    ).toEqual({ ok: true, cwd: realpathSync(repo) });
  });

  test("refuses a cwd outside the sandbox root before process creation", () => {
    const currentFolder = tempRoot();
    const outside = tempRoot();

    const result = resolveTerminalSpawnCwd({
      requestedCwd: outside,
      sandboxWorkspace: currentFolder,
      fallbackWorkspace: outside,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("outside the sandbox Current Folder");
      expect(result.error).toContain("process was not started");
    }
  });

  test("defaults to the sandbox Current Folder rather than an unrelated fallback", () => {
    const currentFolder = tempRoot();
    const unrelatedWorkspace = tempRoot();

    expect(
      resolveTerminalSpawnCwd({
        requestedCwd: undefined,
        sandboxWorkspace: currentFolder,
        fallbackWorkspace: unrelatedWorkspace,
      }),
    ).toEqual({ ok: true, cwd: realpathSync(currentFolder) });
  });
});
