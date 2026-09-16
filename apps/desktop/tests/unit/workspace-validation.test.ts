/**
 * Unit tests for `validateWorkspacePath` (D057 2a.7).
 *
 * The validator is the shape-check gate for the `workspace:setPath` IPC.
 * It's the load-bearing piece that prevents a compromised renderer from
 * persisting an obviously-malformed path to `workspace.json` — empty
 * strings, relative paths, non-existent targets, files instead of
 * directories, paths with NUL bytes. Normalized output via
 * `path.resolve` removes `..` / `.` segments before commit.
 *
 * These tests intentionally use an injected `deps` object rather than
 * the real fs/path modules so the assertions are deterministic and run
 * without touching disk.
 *
 * NOT tested here (out of scope — belongs to integration):
 *   - Whether the IPC handler throws with the error message
 *   - Whether `commitWorkspacePath` is called with the normalized value
 *   - Symlink resolution (deliberately follows symlinks; see module
 *     doc for rationale)
 */

import { describe, test, expect } from "bun:test";
import { validateWorkspacePath, type ValidatorDeps } from "../../electron/workspace-validation";

function makeDeps(overrides: Partial<ValidatorDeps> = {}): ValidatorDeps {
  return {
    isAbsolute: (p) => p.startsWith("/"),
    resolve: (p) => p.replace(/\/+/g, "/").replace(/\/$/, "") || "/",
    statSync: () => ({ isDirectory: () => true }),
    ...overrides,
  };
}

describe("validateWorkspacePath — rejections", () => {
  test("null args", () => {
    const r = validateWorkspacePath(null, makeDeps());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("requires { path: string }");
  });

  test("undefined args", () => {
    const r = validateWorkspacePath(undefined, makeDeps());
    expect(r.ok).toBe(false);
  });

  test("non-object args (string)", () => {
    const r = validateWorkspacePath("not-an-object" as unknown as { path: string }, makeDeps());
    expect(r.ok).toBe(false);
  });

  test("missing path field", () => {
    const r = validateWorkspacePath({} as { path: string }, makeDeps());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("non-empty path string");
  });

  test("path is non-string (number)", () => {
    const r = validateWorkspacePath({ path: 42 } as unknown as { path: string }, makeDeps());
    expect(r.ok).toBe(false);
  });

  test("path is empty string", () => {
    const r = validateWorkspacePath({ path: "" }, makeDeps());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("non-empty path string");
  });

  test("path contains NUL byte", () => {
    const r = validateWorkspacePath({ path: "/Users/me/project\0/evil" }, makeDeps());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("NUL bytes");
  });

  test("relative path rejected", () => {
    const r = validateWorkspacePath({ path: "relative/subdir" }, makeDeps());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("absolute path");
  });

  test("dot-prefixed relative path rejected", () => {
    const r = validateWorkspacePath({ path: "./subdir" }, makeDeps());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("absolute path");
  });

  test("stat throws (path doesn't exist) → rejected with message", () => {
    const deps = makeDeps({
      statSync: () => {
        throw new Error("ENOENT: no such file or directory, stat '/Users/me/missing'");
      },
    });
    const r = validateWorkspacePath({ path: "/Users/me/missing" }, deps);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toContain("not accessible");
      expect(r.error).toContain("ENOENT");
    }
  });

  test("path exists but is a file, not a directory", () => {
    const deps = makeDeps({ statSync: () => ({ isDirectory: () => false }) });
    const r = validateWorkspacePath({ path: "/Users/me/readme.txt" }, deps);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("not a directory");
  });
});

describe("validateWorkspacePath — acceptances + normalization", () => {
  test("valid absolute directory path accepted", () => {
    const r = validateWorkspacePath({ path: "/Users/me/project" }, makeDeps());
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.resolved).toBe("/Users/me/project");
  });

  test("normalizes `..` segments via deps.resolve", () => {
    const deps = makeDeps({
      resolve: (p) => {
        // Minimal `..` collapser: `/a/b/../c` → `/a/c`
        const parts = p.split("/").filter((s) => s.length > 0);
        const stack: string[] = [];
        for (const part of parts) {
          if (part === "..") stack.pop();
          else if (part !== ".") stack.push(part);
        }
        return "/" + stack.join("/");
      },
    });
    const r = validateWorkspacePath({ path: "/Users/me/project/../other" }, deps);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.resolved).toBe("/Users/me/other");
  });

  test("normalizes trailing slash", () => {
    const r = validateWorkspacePath({ path: "/Users/me/project/" }, makeDeps());
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.resolved).toBe("/Users/me/project");
  });

  test("normalizes duplicate slashes", () => {
    const r = validateWorkspacePath({ path: "/Users//me///project" }, makeDeps());
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.resolved).toBe("/Users/me/project");
  });

  test("deps.statSync is called with the NORMALIZED path (not the raw input)", () => {
    // Regression guard — if statSync were called with the raw input,
    // the normalization would be cosmetic and attackers could leverage
    // the `..` difference between validated and stored paths.
    let statedWith = "";
    const deps = makeDeps({
      resolve: (p) => p.replace(/\/\.\./g, "").replace(/\/\//g, "/"),
      statSync: (p) => {
        statedWith = p;
        return { isDirectory: () => true };
      },
    });
    validateWorkspacePath({ path: "/a/b/../project" }, deps);
    expect(statedWith).toBe("/a/b/project");
  });
});
