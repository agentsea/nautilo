/**
 * D079 Phase 4 / G3 commit 5 — `resolveZone` unit tests.
 *
 * Pure-function tests; no fs access. Covers:
 *   - Each zone (workspace / current / absolute / home-alias /
 *     scratch-alias) with valid inputs.
 *   - Path-traversal rejection (`..` escaping the zone root).
 *   - Null currentFolder → clear "open a folder" error for
 *     zone="current".
 *   - Missing workspace root → error (boot-order bug indicator).
 *   - Control-char rejection at the resolver layer (defense in
 *     depth — chat route already sanitizes, but defense in depth
 *     is cheap).
 *   - Absolute-path-with-relative-zone rejection (intent mismatch
 *     surfaced instead of silently ignoring the zone).
 *   - Unknown zone → error.
 */

import { describe, test, expect } from "bun:test";
import { resolveZone, type ZoneContext } from "../../src/tools/file/zones";

const CTX_FULL: ZoneContext = {
  workspaceRoot: "/Users/john-user/Documents/Nautilo",
  currentFolder: "/Users/john-user/code/my-project",
};

const CTX_NO_CURRENT: ZoneContext = {
  workspaceRoot: "/Users/john-user/Documents/Nautilo",
  currentFolder: null,
};

describe("resolveZone — happy paths", () => {
  test("workspace + relative path joins under root", () => {
    const r = resolveZone({ path: "drafts/q3.md", zone: "workspace" }, CTX_FULL);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.resolved).toBe("/Users/john-user/Documents/Nautilo/drafts/q3.md");
      expect(r.resolvedZone).toBe("workspace");
    }
  });

  test("current + relative path joins under root", () => {
    const r = resolveZone({ path: "src/app.ts", zone: "current" }, CTX_FULL);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.resolved).toBe("/Users/john-user/code/my-project/src/app.ts");
      expect(r.resolvedZone).toBe("current");
    }
  });

  test("absolute passes through with normalization", () => {
    const r = resolveZone({ path: "/tmp/log.txt", zone: "absolute" }, CTX_FULL);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.resolved).toBe("/tmp/log.txt");
      expect(r.resolvedZone).toBe("absolute");
    }
  });

  test("home alias → workspace (legacy compat)", () => {
    const r = resolveZone({ path: "research/notes.md", zone: "home" }, CTX_FULL);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.resolved).toBe("/Users/john-user/Documents/Nautilo/research/notes.md");
      expect(r.resolvedZone).toBe("workspace");
    }
  });

  test("scratch alias → workspace/scratch/ (legacy compat)", () => {
    const r = resolveZone({ path: "temp.txt", zone: "scratch" }, CTX_FULL);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.resolved).toBe("/Users/john-user/Documents/Nautilo/scratch/temp.txt");
      expect(r.resolvedZone).toBe("workspace");
    }
  });

  test("normalizes . and .. within zone bounds", () => {
    const r = resolveZone({ path: "./drafts/./q3.md", zone: "workspace" }, CTX_FULL);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.resolved).toBe("/Users/john-user/Documents/Nautilo/drafts/q3.md");
    }
  });

  test("zone root itself accessible (path='.')", () => {
    const r = resolveZone({ path: ".", zone: "workspace" }, CTX_FULL);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.resolved).toBe("/Users/john-user/Documents/Nautilo");
    }
  });
});

describe("resolveZone — error paths", () => {
  test("empty path rejects", () => {
    const r = resolveZone({ path: "", zone: "workspace" }, CTX_FULL);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/path is required/);
  });

  test("non-string path rejects", () => {
    const r = resolveZone(
      { path: 123 as unknown as string, zone: "workspace" },
      CTX_FULL,
    );
    expect(r.ok).toBe(false);
  });

  test("control chars in path reject", () => {
    const r = resolveZone(
      { path: "drafts/q\n3.md", zone: "workspace" },
      CTX_FULL,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/control characters/);
  });

  test("null byte in path rejects", () => {
    const r = resolveZone(
      { path: "drafts/q\u00003.md", zone: "workspace" },
      CTX_FULL,
    );
    expect(r.ok).toBe(false);
  });

  test("path-traversal escape attempt rejects (.. cancelling out)", () => {
    const r = resolveZone(
      { path: "../../../etc/passwd", zone: "workspace" },
      CTX_FULL,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/escapes zone root/);
  });

  test("path-traversal escape attempt via nested .. rejects", () => {
    const r = resolveZone(
      { path: "drafts/../../secret.txt", zone: "workspace" },
      CTX_FULL,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/escapes zone root/);
  });

  test("current zone with null currentFolder → prompt-able error", () => {
    const r = resolveZone(
      { path: "src/app.ts", zone: "current" },
      CTX_NO_CURRENT,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toMatch(/No folder is open/);
      expect(r.reason).toMatch(/open one/);
    }
  });

  test("workspace zone with empty workspaceRoot → boot-order error", () => {
    const r = resolveZone(
      { path: "drafts/x.md", zone: "workspace" },
      { workspaceRoot: "", currentFolder: null },
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/boot-order bug/);
  });

  test("absolute zone with relative path rejects", () => {
    const r = resolveZone({ path: "relative.txt", zone: "absolute" }, CTX_FULL);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/requires an absolute path/);
  });

  test("workspace zone with absolute path rejects (intent mismatch)", () => {
    const r = resolveZone(
      { path: "/tmp/log.txt", zone: "workspace" },
      CTX_FULL,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/expects a relative path/);
  });

  test("unknown zone rejects", () => {
    const r = resolveZone(
      { path: "x", zone: "bogus" as "workspace" },
      CTX_FULL,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/unknown zone/);
  });
});

describe("resolveZone — edge cases", () => {
  test("workspace with trailing slash in root normalizes correctly", () => {
    const r = resolveZone(
      { path: "drafts/x.md", zone: "workspace" },
      { workspaceRoot: "/Users/john-user/Documents/Nautilo/", currentFolder: null },
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.resolved).toBe("/Users/john-user/Documents/Nautilo/drafts/x.md");
    }
  });

  test("path with multiple slashes collapses to single", () => {
    const r = resolveZone(
      { path: "drafts//x.md", zone: "workspace" },
      CTX_FULL,
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.resolved).toBe("/Users/john-user/Documents/Nautilo/drafts/x.md");
    }
  });

  test("resolution works for deep paths", () => {
    const r = resolveZone(
      { path: "a/b/c/d/e/f.txt", zone: "workspace" },
      CTX_FULL,
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.resolved).toBe("/Users/john-user/Documents/Nautilo/a/b/c/d/e/f.txt");
    }
  });
});
