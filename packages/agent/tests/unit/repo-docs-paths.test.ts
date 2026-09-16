import { describe, test, expect } from "bun:test";
import {
  normalizeRepoPath,
  isExcludedPath,
  globToRegExp,
  RepoPathError,
} from "../../src/subagents/repo-docs/paths";
import { ALLOWED_GIT_SUBCOMMANDS } from "../../src/subagents/repo-docs/constants";

describe("repo-docs path normalization (traversal guard)", () => {
  test("strips leading slash + dot segments, normalizes separators", () => {
    expect(normalizeRepoPath("/README.md")).toBe("README.md");
    expect(normalizeRepoPath("./a/./b")).toBe("a/b");
    expect(normalizeRepoPath("")).toBe("");
    expect(normalizeRepoPath(".")).toBe("");
    expect(normalizeRepoPath("/")).toBe("");
    expect(normalizeRepoPath("a\\b\\c")).toBe("a/b/c");
    // A host-absolute path is treated as repo-relative (leading slash stripped),
    // NOT as traversal — this is the documented virtual-root convenience.
    expect(normalizeRepoPath("/Users/foo/bar")).toBe("Users/foo/bar");
  });

  test("rejects `..` escapes and drive-absolute paths", () => {
    expect(() => normalizeRepoPath("../etc/passwd")).toThrow(RepoPathError);
    expect(() => normalizeRepoPath("a/../../b")).toThrow(RepoPathError);
    expect(() => normalizeRepoPath("openwiki/../../secret")).toThrow(RepoPathError);
    expect(() => normalizeRepoPath("C:/Windows")).toThrow(RepoPathError);
  });
});

describe("repo-docs excluded dirs", () => {
  test("excludes VCS/build dirs at any depth", () => {
    expect(isExcludedPath("node_modules/x")).toBe(true);
    expect(isExcludedPath("a/.git/b")).toBe(true);
    expect(isExcludedPath("packages/agent/dist/index.js")).toBe(true);
    expect(isExcludedPath("src/index.ts")).toBe(false);
    expect(isExcludedPath("")).toBe(false);
  });
});

describe("repo-docs glob→regexp", () => {
  test("single star does not cross path separators", () => {
    expect(globToRegExp("packages/*/package.json").test("packages/agent/package.json")).toBe(true);
    expect(globToRegExp("packages/*/package.json").test("packages/a/b/package.json")).toBe(false);
    expect(globToRegExp("*.md").test("README.md")).toBe(true);
    expect(globToRegExp("*.md").test("docs/README.md")).toBe(false);
  });

  test("double star crosses separators; braces alternate", () => {
    expect(globToRegExp("src/**/*.ts").test("src/a/b/c.ts")).toBe(true);
    expect(globToRegExp("src/**/*.ts").test("src/c.ts")).toBe(true);
    expect(globToRegExp("{a,b}.txt").test("b.txt")).toBe(true);
    expect(globToRegExp("{a,b}.txt").test("c.txt")).toBe(false);
  });
});

describe("repo-docs git allowlist (LLM run_git is read-only)", () => {
  test("read-only subcommands are allowed", () => {
    for (const s of ["log", "show", "status", "diff", "rev-parse", "blame", "ls-files", "shortlog"]) {
      expect(ALLOWED_GIT_SUBCOMMANDS).toContain(s);
    }
  });
  test("mutating/network subcommands are NOT allowed", () => {
    for (const s of ["push", "commit", "clone", "fetch", "reset", "checkout", "rm", "init", "add", "worktree", "config"]) {
      expect(ALLOWED_GIT_SUBCOMMANDS).not.toContain(s);
    }
  });
});
