/**
 * Unit tests for the Git broker preflight.
 *
 * Pure-filesystem preflight: identity canonicalization, alternates,
 * submodules, escaping symlinks, pathspec magic/escape, live `.env`,
 * and local config audit. No subprocess; no sandbox-exec required.
 */

import { describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
  realpathSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import {
  auditLocalConfig,
  canonicalizeRepositoryIdentity,
  GitPreflightError,
  isUnderRoot,
  normalizePathspec,
  rejectAlternates,
  rejectEscapingSymlinks,
  rejectLiveEnvPath,
  rejectSubmodules,
  validateWorktreeTarget,
  validateCloneChild,
  pinGitDirectory,
  sameGitDirectory,
} from "../../src/git-broker/preflight";

function mkTmp(prefix: string): string {
  return realpathSync(mkdtempSync(join(tmpdir(), prefix)));
}

function initRepo(root: string): void {
  mkdirSync(resolve(root, ".git"), { recursive: true });
  mkdirSync(resolve(root, ".git", "objects"), { recursive: true });
  mkdirSync(resolve(root, ".git", "objects", "info"), { recursive: true });
  mkdirSync(resolve(root, ".git", "refs"), { recursive: true });
  writeFileSync(resolve(root, ".git", "HEAD"), "ref: refs/heads/main\n");
  writeFileSync(resolve(root, ".git", "config"), "[core]\n\trepositoryformatversion = 0\n");
}

test("clone accepts only one absent child of current granted canonical Folder", () => {
  const root = mkTmp("clone-preflight-");
  try {
    const candidate = validateCloneChild(root, "project", [root]);
    expect(candidate.target).toBe(join(root, "project"));
    expect(sameGitDirectory(candidate.root)).toBe(true);
    expect(() => validateCloneChild(root, "../escape", [root])).toThrow();
    expect(() => validateCloneChild(root, "project", [])).toThrow();
    symlinkSync(join(root, "missing"), join(root, "project"));
    expect(() => validateCloneChild(root, "project", [root])).toThrow();
    expect(() => validateCloneChild(root, "private", [root], [join(root, "private")])).toThrow();
    expect(() => pinGitDirectory(join(root, "project"))).toThrow();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

describe("canonicalizeRepositoryIdentity", () => {
  test("regular repo: git-dir == common-dir, not linked", () => {
    const root = mkTmp("git-preflight-ident-regular-");
    initRepo(root);
    const id = canonicalizeRepositoryIdentity(root);
    expect(id.workTree).toBe(root);
    expect(id.gitDir).toBe(resolve(root, ".git"));
    expect(id.commonDir).toBe(resolve(root, ".git"));
    expect(id.isLinkedWorktree).toBe(false);
    rmSync(root, { recursive: true, force: true });
  });

  test("linked worktree: .git file -> gitdir under <common>/worktrees/<name>", () => {
    const root = mkTmp("git-preflight-ident-linked-");
    const mainRepo = resolve(root, "main");
    const wt = resolve(root, "wt");
    const commonDir = resolve(mainRepo, ".git");
    const wtMeta = resolve(commonDir, "worktrees", "feature");
    mkdirSync(wtMeta, { recursive: true });
    initRepo(mainRepo);
    mkdirSync(wt, { recursive: true });
    writeFileSync(resolve(wt, ".git"), `gitdir: ${wtMeta}\n`);
    writeFileSync(resolve(wtMeta, "gitdir"), resolve(wt, ".git"));
    writeFileSync(resolve(wtMeta, "HEAD"), "ref: refs/heads/main\n");
    const id = canonicalizeRepositoryIdentity(wt);
    expect(id.workTree).toBe(wt);
    expect(id.gitDir).toBe(wtMeta);
    expect(id.commonDir).toBe(commonDir);
    expect(id.isLinkedWorktree).toBe(true);
    rmSync(root, { recursive: true, force: true });
  });

  test("linked worktree: rejects a forged common-dir pointer without an exact backlink", () => {
    const root = mkTmp("git-preflight-ident-linked-forged-");
    const mainRepo = resolve(root, "main");
    const wt = resolve(root, "wt");
    const other = resolve(root, "other");
    const commonDir = resolve(mainRepo, ".git");
    const wtMeta = resolve(commonDir, "worktrees", "feature");
    mkdirSync(wtMeta, { recursive: true });
    initRepo(mainRepo);
    mkdirSync(wt, { recursive: true });
    mkdirSync(other, { recursive: true });
    writeFileSync(resolve(wt, ".git"), `gitdir: ${wtMeta}\n`);
    writeFileSync(resolve(wtMeta, "gitdir"), resolve(other, ".git"));
    expect(() => canonicalizeRepositoryIdentity(wt)).toThrow(
      /backlink does not match the selected worktree/,
    );
    rmSync(root, { recursive: true, force: true });
  });

  test("missing .git -> deny-repo-identity-mismatch", () => {
    const root = mkTmp("git-preflight-ident-missing-");
    expect(() => canonicalizeRepositoryIdentity(root)).toThrow(
      GitPreflightError,
    );
    expect(() => canonicalizeRepositoryIdentity(root)).toThrow(
      /no \.git entry/,
    );
    rmSync(root, { recursive: true, force: true });
  });
});

describe("rejectAlternates", () => {
  test("no alternates file -> ok", () => {
    const root = mkTmp("git-preflight-alt-none-");
    initRepo(root);
    const id = canonicalizeRepositoryIdentity(root);
    expect(() => rejectAlternates(id, [root])).not.toThrow();
    rmSync(root, { recursive: true, force: true });
  });

  test("alternate inside granted root -> ok", () => {
    const root = mkTmp("git-preflight-alt-granted-");
    initRepo(root);
    const altDir = resolve(root, "alt-objects");
    mkdirSync(altDir, { recursive: true });
    writeFileSync(resolve(root, ".git", "objects", "info", "alternates"), altDir + "\n");
    const id = canonicalizeRepositoryIdentity(root);
    expect(() => rejectAlternates(id, [root])).not.toThrow();
    rmSync(root, { recursive: true, force: true });
  });

  test("alternate outside granted roots -> deny-alternates", () => {
    const root = mkTmp("git-preflight-alt-escape-");
    const outside = mkTmp("git-preflight-alt-outside-");
    initRepo(root);
    mkdirSync(outside, { recursive: true });
    writeFileSync(resolve(root, ".git", "objects", "info", "alternates"), outside + "\n");
    const id = canonicalizeRepositoryIdentity(root);
    expect(() => rejectAlternates(id, [root])).toThrow(GitPreflightError);
    expect(() => rejectAlternates(id, [root])).toThrow(/ungranted path/);
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  });
});

describe("rejectSubmodules", () => {
  test("no .gitmodules -> ok", () => {
    const root = mkTmp("git-preflight-sub-none-");
    initRepo(root);
    const id = canonicalizeRepositoryIdentity(root);
    expect(() => rejectSubmodules(id)).not.toThrow();
    rmSync(root, { recursive: true, force: true });
  });

  test(".gitmodules with [submodule] section -> deny-submodules", () => {
    const root = mkTmp("git-preflight-sub-active-");
    initRepo(root);
    writeFileSync(
      resolve(root, ".gitmodules"),
      '[submodule "vendor"]\n\tpath = vendor\n\turl = https://example.invalid/vendor\n',
    );
    const id = canonicalizeRepositoryIdentity(root);
    expect(() => rejectSubmodules(id)).toThrow(GitPreflightError);
    expect(() => rejectSubmodules(id)).toThrow(/active submodules/);
    rmSync(root, { recursive: true, force: true });
  });
});

describe("rejectEscapingSymlinks", () => {
  test("in-root symlink -> ok", () => {
    const root = mkTmp("git-preflight-sym-in-");
    initRepo(root);
    const target = resolve(root, "link-target");
    mkdirSync(target, { recursive: true });
    symlinkSync(target, resolve(root, "link"));
    expect(() => rejectEscapingSymlinks(root, [root])).not.toThrow();
    rmSync(root, { recursive: true, force: true });
  });

  test("symlink escaping granted roots -> deny-escaping-symlink", () => {
    const root = mkTmp("git-preflight-sym-escape-");
    const outside = mkTmp("git-preflight-sym-out-");
    initRepo(root);
    symlinkSync(outside, resolve(root, "escape"));
    expect(() => rejectEscapingSymlinks(root, [root])).toThrow(GitPreflightError);
    expect(() => rejectEscapingSymlinks(root, [root])).toThrow(/escapes granted roots/);
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  });
});

describe("normalizePathspec", () => {
  test("plain in-target relative path -> normalized absolute", () => {
    const root = mkTmp("git-preflight-ps-plain-");
    const out = normalizePathspec("src/file.ts", root);
    expect(out).toBe(resolve(root, "src", "file.ts"));
    rmSync(root, { recursive: true, force: true });
  });

  test("pathspec magic `:(...)` -> deny-pathspec-magic", () => {
    const root = mkTmp("git-preflight-ps-magic-");
    expect(() => normalizePathspec(":(top)src/file.ts", root)).toThrow(GitPreflightError);
    rmSync(root, { recursive: true, force: true });
  });

  test("absolute pathspec -> deny-pathspec-outside-target", () => {
    const root = mkTmp("git-preflight-ps-abs-");
    expect(() => normalizePathspec("/etc/passwd", root)).toThrow(GitPreflightError);
    rmSync(root, { recursive: true, force: true });
  });

  test("parent traversal -> deny-pathspec-outside-target", () => {
    const root = mkTmp("git-preflight-ps-parent-");
    expect(() => normalizePathspec("../escape", root)).toThrow(GitPreflightError);
    rmSync(root, { recursive: true, force: true });
  });

  test("glob `**` -> deny-pathspec-magic", () => {
    const root = mkTmp("git-preflight-ps-glob-");
    expect(() => normalizePathspec("src/**", root)).toThrow(GitPreflightError);
    rmSync(root, { recursive: true, force: true });
  });
});

describe("rejectLiveEnvPath", () => {
  test(".env -> deny-live-env", () => {
    expect(() => rejectLiveEnvPath("/repo/.env")).toThrow(GitPreflightError);
  });
  test(".env.local -> deny-live-env", () => {
    expect(() => rejectLiveEnvPath("/repo/.env.local")).toThrow(GitPreflightError);
  });
  test(".env.example -> ok (public template)", () => {
    expect(() => rejectLiveEnvPath("/repo/.env.example")).not.toThrow();
  });
  test(".env.production.sample -> ok (public template)", () => {
    expect(() => rejectLiveEnvPath("/repo/.env.production.sample")).not.toThrow();
  });
  test("plain file -> ok", () => {
    expect(() => rejectLiveEnvPath("/repo/src/file.ts")).not.toThrow();
  });
});

describe("validateWorktreeTarget", () => {
  test("empty dir inside granted root -> ok", () => {
    const root = mkTmp("git-preflight-wt-ok-");
    const target = resolve(root, "target");
    mkdirSync(target, { recursive: true });
    const out = validateWorktreeTarget(target, [root]);
    expect(out.target).toBe(target);
    rmSync(root, { recursive: true, force: true });
  });

  test("non-empty target -> deny-target-not-empty", () => {
    const root = mkTmp("git-preflight-wt-nonempty-");
    const target = resolve(root, "target");
    mkdirSync(target, { recursive: true });
    writeFileSync(resolve(target, "file"), "x");
    expect(() => validateWorktreeTarget(target, [root])).toThrow(GitPreflightError);
    rmSync(root, { recursive: true, force: true });
  });

  test("symlink target -> deny-target-symlink", () => {
    const root = mkTmp("git-preflight-wt-sym-");
    const real = resolve(root, "real");
    mkdirSync(real, { recursive: true });
    const link = resolve(root, "link");
    symlinkSync(real, link);
    expect(() => validateWorktreeTarget(link, [root])).toThrow(GitPreflightError);
    rmSync(root, { recursive: true, force: true });
  });

  test("target outside granted roots -> deny-target-outside-grant", () => {
    const root = mkTmp("git-preflight-wt-out-");
    const outside = mkTmp("git-preflight-wt-outside-");
    const target = resolve(outside, "target");
    mkdirSync(target, { recursive: true });
    expect(() => validateWorktreeTarget(target, [root])).toThrow(GitPreflightError);
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  });
});

describe("auditLocalConfig", () => {
  test("clean config -> ok", () => {
    const root = mkTmp("git-preflight-cfg-clean-");
    initRepo(root);
    const id = canonicalizeRepositoryIdentity(root);
    expect(() => auditLocalConfig(id)).not.toThrow();
    rmSync(root, { recursive: true, force: true });
  });

  test("core.hooksPath -> deny-config-unsafe", () => {
    const root = mkTmp("git-preflight-cfg-hooks-");
    initRepo(root);
    writeFileSync(
      resolve(root, ".git", "config"),
      "[core]\n\trepositoryformatversion = 0\n\thooksPath = /tmp/hooks\n",
    );
    const id = canonicalizeRepositoryIdentity(root);
    expect(() => auditLocalConfig(id)).toThrow(GitPreflightError);
    expect(() => auditLocalConfig(id)).toThrow(/core.hooksPath/);
    rmSync(root, { recursive: true, force: true });
  });

  test("filter driver -> deny-config-unsafe", () => {
    const root = mkTmp("git-preflight-cfg-filter-");
    initRepo(root);
    writeFileSync(
      resolve(root, ".git", "config"),
      '[core]\n\trepositoryformatversion = 0\n[filter "lfs"]\n\tclean = git-lfs clean -- %f\n',
    );
    const id = canonicalizeRepositoryIdentity(root);
    expect(() => auditLocalConfig(id)).toThrow(GitPreflightError);
    expect(() => auditLocalConfig(id)).toThrow(/filter\/diff\/merge driver/);
    rmSync(root, { recursive: true, force: true });
  });

  test("alias -> deny-alias", () => {
    const root = mkTmp("git-preflight-cfg-alias-");
    initRepo(root);
    writeFileSync(
      resolve(root, ".git", "config"),
      "[core]\n\trepositoryformatversion = 0\n[alias]\n\tst = status\n",
    );
    const id = canonicalizeRepositoryIdentity(root);
    expect(() => auditLocalConfig(id)).toThrow(GitPreflightError);
    expect(() => auditLocalConfig(id)).toThrow(/aliases/);
    rmSync(root, { recursive: true, force: true });
  });
});

describe("isUnderRoot", () => {
  test("token boundary: /foo does not match /foobar", () => {
    expect(isUnderRoot("/foobar/baz", "/foo")).toBe(false);
    expect(isUnderRoot("/foo/baz", "/foo")).toBe(true);
    expect(isUnderRoot("/foo", "/foo")).toBe(true);
  });
});

// Silence unused-import for dirname (kept for future fixtures).
void dirname;
