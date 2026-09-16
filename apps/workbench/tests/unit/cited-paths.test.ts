/**
 * Unit tests for the pure path-containment helpers used by the Files
 * tab's cited-file glyph (D057 2a.1.9).
 *
 * These helpers underpin the review-flagged security-adjacent property
 * that the glyph only surfaces paths actually under the workspace root —
 * a naive `startsWith` was flagged for sibling-token leakage (e.g.
 * workspace `/home/user/proj` wrongly matches `/home/user/proj-evil`).
 *
 * This is the first bun:test suite for @nautilo/workbench. It runs only
 * against pure modules — no React, no DOM — so the absence of
 * jsdom/Vitest scaffolding in this app doesn't matter here.
 */

import { describe, test, expect } from "bun:test";
import {
  isUnderRoot,
  joinPath,
  relativeFromWorkspace,
  derivedCitedPaths,
  separatorFor,
} from "../../src/components/browser-column/cited-paths";

// The ToolActivityEvent shape expected by derivedCitedPaths. We
// construct plain objects rather than importing the type to avoid
// coupling the test to the adapter module's React imports.
type ToolEvent = {
  id: string;
  toolName: string;
  status: "running" | "ok" | "error";
  timestamp: number;
  args: Record<string, unknown>;
};

function evt(args: Record<string, unknown>): ToolEvent {
  return { id: "t", toolName: "file", status: "ok", timestamp: 0, args };
}

describe("separatorFor", () => {
  test("POSIX path → /", () => {
    expect(separatorFor("/Users/me/proj")).toBe("/");
  });

  test("Windows path → \\", () => {
    expect(separatorFor("C:\\Users\\me\\proj")).toBe("\\");
  });

  test("mixed path → /", () => {
    expect(separatorFor("/mnt/c/Users/me")).toBe("/");
  });

  test("empty string → /", () => {
    expect(separatorFor("")).toBe("/");
  });
});

describe("isUnderRoot — equals-or-boundary rule", () => {
  test("exact match → under", () => {
    expect(isUnderRoot("/Users/me/proj", "/Users/me/proj")).toBe(true);
  });

  test("direct child → under", () => {
    expect(isUnderRoot("/Users/me/proj", "/Users/me/proj/file.ts")).toBe(true);
  });

  test("deep descendant → under", () => {
    expect(isUnderRoot("/Users/me/proj", "/Users/me/proj/a/b/c/d.ts")).toBe(true);
  });

  test("SIBLING-TOKEN LEAK (the bug): /proj vs /proj-evil → NOT under", () => {
    expect(isUnderRoot("/Users/me/proj", "/Users/me/proj-evil/secret.txt")).toBe(false);
  });

  test("SIBLING-TOKEN LEAK: /home/user/proj vs /home/user/project → NOT under", () => {
    expect(isUnderRoot("/home/user/proj", "/home/user/project/x")).toBe(false);
  });

  test("trailing slash on root does not cause false-positive", () => {
    expect(isUnderRoot("/Users/me/proj/", "/Users/me/proj-evil/secret")).toBe(false);
  });

  test("trailing slash on root still matches real children", () => {
    expect(isUnderRoot("/Users/me/proj/", "/Users/me/proj/file.ts")).toBe(true);
  });

  test("parent directory → NOT under", () => {
    expect(isUnderRoot("/Users/me/proj", "/Users/me")).toBe(false);
  });

  test("unrelated path → NOT under", () => {
    expect(isUnderRoot("/Users/me/proj", "/etc/passwd")).toBe(false);
  });

  test("empty root → NOT under (fail-closed)", () => {
    expect(isUnderRoot("", "/anywhere")).toBe(false);
  });

  test("empty candidate → NOT under", () => {
    expect(isUnderRoot("/Users/me/proj", "")).toBe(false);
  });

  test("Windows: exact match", () => {
    expect(isUnderRoot("C:\\Users\\me\\proj", "C:\\Users\\me\\proj")).toBe(true);
  });

  test("Windows: direct child", () => {
    expect(isUnderRoot("C:\\Users\\me\\proj", "C:\\Users\\me\\proj\\file.ts")).toBe(true);
  });

  test("Windows: SIBLING-TOKEN LEAK → NOT under", () => {
    expect(isUnderRoot("C:\\Users\\me\\proj", "C:\\Users\\me\\proj-evil\\x")).toBe(false);
  });
});

describe("joinPath", () => {
  test("POSIX", () => {
    expect(joinPath("/Users/me", "proj")).toBe("/Users/me/proj");
  });

  test("POSIX with trailing slash on parent", () => {
    expect(joinPath("/Users/me/", "proj")).toBe("/Users/me/proj");
  });

  test("Windows", () => {
    expect(joinPath("C:\\Users\\me", "proj")).toBe("C:\\Users\\me\\proj");
  });
});

describe("relativeFromWorkspace", () => {
  test("child path → relative", () => {
    expect(relativeFromWorkspace("/Users/me/proj", "/Users/me/proj/file.ts")).toBe("file.ts");
  });

  test("deep descendant → relative", () => {
    expect(relativeFromWorkspace("/Users/me/proj", "/Users/me/proj/a/b.ts")).toBe("a/b.ts");
  });

  test("exact root → empty string", () => {
    expect(relativeFromWorkspace("/Users/me/proj", "/Users/me/proj")).toBe("");
  });

  test("SIBLING-TOKEN LEAK: /proj-evil/x is NOT under /proj, returned unchanged", () => {
    expect(
      relativeFromWorkspace("/Users/me/proj", "/Users/me/proj-evil/secret"),
    ).toBe("/Users/me/proj-evil/secret");
  });

  test("unrelated path → unchanged", () => {
    expect(relativeFromWorkspace("/Users/me/proj", "/etc/passwd")).toBe("/etc/passwd");
  });

  test("trailing slash on root handled", () => {
    expect(relativeFromWorkspace("/Users/me/proj/", "/Users/me/proj/file.ts")).toBe("file.ts");
  });
});

describe("derivedCitedPaths", () => {
  test("empty events → empty set", () => {
    expect(derivedCitedPaths([], "/Users/me/proj").size).toBe(0);
  });

  test("empty workspace → empty set (fail-closed)", () => {
    const events = [evt({ path: "/Users/me/proj/a.ts" })];
    expect(derivedCitedPaths(events, "").size).toBe(0);
  });

  test("absolute path under workspace → included", () => {
    const events = [evt({ path: "/Users/me/proj/file.ts" })];
    const set = derivedCitedPaths(events, "/Users/me/proj");
    expect(set.has("/Users/me/proj/file.ts")).toBe(true);
    expect(set.size).toBe(1);
  });

  test("relative path → resolved against workspace", () => {
    const events = [evt({ path: "src/file.ts" })];
    const set = derivedCitedPaths(events, "/Users/me/proj");
    expect(set.has("/Users/me/proj/src/file.ts")).toBe(true);
  });

  test("SIBLING-TOKEN LEAK REGRESSION: /proj-evil absolute path NOT included", () => {
    const events = [evt({ path: "/Users/me/proj-evil/secret.txt" })];
    const set = derivedCitedPaths(events, "/Users/me/proj");
    expect(set.size).toBe(0);
  });

  test("absolute path OUTSIDE workspace NOT included", () => {
    const events = [evt({ path: "/etc/passwd" })];
    const set = derivedCitedPaths(events, "/Users/me/proj");
    expect(set.size).toBe(0);
  });

  test("fallback arg names: file, target, filename", () => {
    const events = [
      evt({ file: "/Users/me/proj/a.ts" }),
      evt({ target: "/Users/me/proj/b.ts" }),
      evt({ filename: "/Users/me/proj/c.ts" }),
    ];
    const set = derivedCitedPaths(events, "/Users/me/proj");
    expect(set.has("/Users/me/proj/a.ts")).toBe(true);
    expect(set.has("/Users/me/proj/b.ts")).toBe(true);
    expect(set.has("/Users/me/proj/c.ts")).toBe(true);
  });

  test("non-string args ignored (defensive)", () => {
    const events = [
      evt({ path: 42 }),
      evt({ path: null }),
      evt({ path: undefined }),
      evt({ path: { nested: "/Users/me/proj/a.ts" } }),
      evt({}),
    ];
    const set = derivedCitedPaths(events, "/Users/me/proj");
    expect(set.size).toBe(0);
  });

  test("empty string arg ignored", () => {
    const events = [evt({ path: "" })];
    const set = derivedCitedPaths(events, "/Users/me/proj");
    expect(set.size).toBe(0);
  });

  test("duplicate paths deduped via Set semantics", () => {
    const events = [
      evt({ path: "/Users/me/proj/a.ts" }),
      evt({ path: "/Users/me/proj/a.ts" }),
      evt({ file: "/Users/me/proj/a.ts" }),
    ];
    const set = derivedCitedPaths(events, "/Users/me/proj");
    expect(set.size).toBe(1);
  });

  test("mixed inclusion: under + sibling-leak + outside → only under survives", () => {
    const events = [
      evt({ path: "/Users/me/proj/good.ts" }),
      evt({ path: "/Users/me/proj-evil/bad.ts" }),
      evt({ path: "/etc/passwd" }),
      evt({ path: "relative-under.ts" }),
    ];
    const set = derivedCitedPaths(events, "/Users/me/proj");
    expect(set.has("/Users/me/proj/good.ts")).toBe(true);
    expect(set.has("/Users/me/proj/relative-under.ts")).toBe(true);
    expect(set.size).toBe(2);
  });
});
