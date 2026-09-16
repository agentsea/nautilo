/**
 * D440 Phase 2 — unit tests for the per-operation SBPL profile
 * compiler.
 *
 * Asserts the operation-aware defense-in-depth invariants:
 *   - status/diff emit NO `.git` write carve-out (the base
 *     `buildSbplProfile` governance `.git` write deny stands);
 *   - worktree-add/remove emit a NARROW
 *     `<common>/worktrees/<name>/` write carve-out AFTER the base
 *     governance `.git` write deny (Seatbelt later-wins re-opens
 *     only that subdir);
 *   - live `.env*` read+write deny is anchored to repo + target;
 *   - public template read/write carve-out is present;
 *   - a dataDir deny is present (defensive);
 *   - NO broad `.git/**` write exemption appears anywhere.
 *
 * No subprocess; pure string assertions on the compiled profile.
 */

import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { compileGitBrokerProfile } from "../../src/git-broker/profile";
import type { GitRepositoryIdentity } from "../../src/git-broker/types";

function mkTmp(prefix: string): string {
  return realpathSync(mkdtempSync(join(tmpdir(), prefix)));
}

function makeIdentity(workTree: string): GitRepositoryIdentity {
  return {
    workTree,
    gitDir: `${workTree}/.git`,
    commonDir: `${workTree}/.git`,
    isLinkedWorktree: false,
  };
}

const GIT = "/usr/local/bin/git";

describe("compileGitBrokerProfile — read-only ops (status/diff)", () => {
  test("status: no .git write carve-out; governance .git write deny present", () => {
    const root = mkTmp("d440-prof-status-");
    const id = makeIdentity(root);
    const profile = compileGitBrokerProfile({
      operation: "status",
      identity: id,
      gitExecutable: GIT,
    });
    // No narrow worktree write carve-out.
    expect(profile).not.toContain("worktrees/");
    // Governance .git write deny present (from buildSbplProfile).
    expect(profile).toContain(`(deny file-write* (subpath "${id.gitDir}"))`);
    // Repo read present.
    expect(profile).toContain(`(allow file-read* (subpath "${root}"))`);
    rmSync(root, { recursive: true, force: true });
  });

  test("diff: same read-only .git shape as status", () => {
    const root = mkTmp("d440-prof-diff-");
    const id = makeIdentity(root);
    const profile = compileGitBrokerProfile({
      operation: "diff",
      identity: id,
      gitExecutable: GIT,
    });
    expect(profile).not.toContain("worktrees/");
    expect(profile).toContain(`(deny file-write* (subpath "${id.gitDir}"))`);
    rmSync(root, { recursive: true, force: true });
  });

  test("linked status reads only the registered common Git metadata outside the worktree", () => {
    const root = mkTmp("d498-prof-linked-status-");
    const workTree = `${root}/linked`;
    const primary = `${root}/primary`;
    const commonDir = `${primary}/.git`;
    const gitDir = `${commonDir}/worktrees/linked`;
    mkdirSync(workTree, { recursive: true });
    mkdirSync(gitDir, { recursive: true });
    const profile = compileGitBrokerProfile({
      operation: "status",
      identity: {
        workTree,
        gitDir,
        commonDir,
        isLinkedWorktree: true,
      },
      gitExecutable: GIT,
    });
    expect(profile).toContain(
      `(allow file-read* (subpath "${commonDir}"))`,
    );
    expect(profile).not.toContain(
      `(allow file-read* (subpath "${primary}"))`,
    );
    expect(profile).not.toContain(
      `(allow file-write* (subpath "${commonDir}"))`,
    );
    expect(profile).toContain(
      `(allow file-read-metadata (literal "${primary}"))`,
    );
    expect(profile).toContain(
      `(deny file-write* (subpath "${commonDir}"))`,
    );
    rmSync(root, { recursive: true, force: true });
  });
});

describe("compileGitBrokerProfile — worktree ops", () => {
  test("worktree-add: narrow <common>/worktrees/ registry write carve-out AFTER governance .git deny", () => {
    const root = mkTmp("d440-prof-wtadd-");
    const id = makeIdentity(root);
    const target = `${root}/wt-target`;
    // buildSbplProfile only emits writable allows for paths that
    // exist on disk; in production preflight guarantees the target
    // exists (empty dir), so create it here too.
    mkdirSync(target, { recursive: true });
    const name = "wt-target";
    const profile = compileGitBrokerProfile({
      operation: "worktree-add",
      identity: id,
      target,
      worktreeName: name,
      gitExecutable: GIT,
    });
    const registry = `${id.commonDir}/worktrees`;
    expect(profile).toContain(`(allow file-read* file-write* (subpath "${registry}"))`);
    // Target writable (via buildSbplProfile writablePaths — write-only;
    // read is covered by the workspace read allow since the target
    // sits under the repo root).
    expect(profile).toContain(`(allow file-write* (subpath "${target}"))`);
    // Governance .git deny still present and BEFORE the narrow carve-out
    // (the carve-out is appended after so later-wins re-opens only the
    // narrow registry subdir).
    const denyIdx = profile.indexOf(`(deny file-write* (subpath "${id.gitDir}"))`);
    const carveIdx = profile.indexOf(registry);
    expect(denyIdx).toBeGreaterThan(-1);
    expect(carveIdx).toBeGreaterThan(denyIdx);
    rmSync(root, { recursive: true, force: true });
  });

  test("worktree-remove: same registry carve-out shape", () => {
    const root = mkTmp("d440-prof-wtrm-");
    const id = makeIdentity(root);
    const target = `${root}/wt-rm`;
    const profile = compileGitBrokerProfile({
      operation: "worktree-remove",
      identity: id,
      target,
      worktreeName: "wt-rm",
      gitExecutable: GIT,
    });
    expect(profile).toContain(`(allow file-read* file-write* (subpath "${id.commonDir}/worktrees"))`);
    expect(profile).toContain(`(deny file-write* (subpath "${id.gitDir}"))`);
    rmSync(root, { recursive: true, force: true });
  });

  test("worktree-add with no name: no .git write carve-out (fails safe)", () => {
    const root = mkTmp("d440-prof-wtnoname-");
    const id = makeIdentity(root);
    const profile = compileGitBrokerProfile({
      operation: "worktree-add",
      identity: id,
      target: `${root}/wt`,
      gitExecutable: GIT,
    });
    expect(profile).not.toContain("worktrees");
    expect(profile).toContain(`(deny file-write* (subpath "${id.gitDir}"))`);
    rmSync(root, { recursive: true, force: true });
  });
});

describe("compileGitBrokerProfile — plumbing add/commit", () => {
  test("add opens only broker transaction root, never .git writes", () => {
    const root = mkTmp("d440-prof-add-");
    const id = makeIdentity(root);
    const transactionRoot = `${root}/broker-transaction`;
    mkdirSync(transactionRoot, { recursive: true });
    const profile = compileGitBrokerProfile({
      operation: "add",
      identity: id,
      transactionRoot,
      gitExecutable: GIT,
    });
    expect(profile).toContain(`(allow file-write* (subpath "${transactionRoot}"))`);
    expect(profile).toContain(`(deny file-write* (subpath "${id.gitDir}"))`);
    expect(profile).not.toMatch(/allow file-read\* file-write\* \(subpath "[^"]*\.git/);
    rmSync(root, { recursive: true, force: true });
  });

  test("commit opens captured ref/HEAD locks but not objects or broad .git", () => {
    const root = mkTmp("d440-prof-commit-");
    const id = makeIdentity(root);
    const transactionRoot = `${root}/broker-transaction`;
    mkdirSync(transactionRoot, { recursive: true });
    const profile = compileGitBrokerProfile({
      operation: "commit",
      identity: id,
      transactionRoot,
      refName: "refs/heads/main",
      gitExecutable: GIT,
    });
    expect(profile).toContain(`(allow file-read* file-write* (literal "${id.gitDir}/refs/heads/main.lock"))`);
    expect(profile).toContain(`(allow file-read* file-write* (literal "${id.gitDir}/HEAD.lock"))`);
    expect(profile).not.toContain(`(allow file-read* file-write* (subpath "${id.gitDir}/objects"))`);
    expect(profile).toContain(`(deny file-write* (subpath "${id.gitDir}"))`);
    rmSync(root, { recursive: true, force: true });
  });
});

describe("compileGitBrokerProfile — secret + dataDir denies", () => {
  test("live .env* read+write deny anchored to repo + target", () => {
    const root = mkTmp("d440-prof-env-");
    const id = makeIdentity(root);
    const target = `${root}/wt`;
    const profile = compileGitBrokerProfile({
      operation: "worktree-add",
      identity: id,
      target,
      worktreeName: "wt",
      gitExecutable: GIT,
    });
    // .env deny anchored to repo (workspace) and target (writablePath).
    const matches = profile.match(/\\\.env\[\^\/\]\*/g) ?? [];
    expect(matches.length).toBeGreaterThanOrEqual(2);
    // Public template carve-out present.
    expect(profile).toMatch(/allow file-read\* file-write\* \(regex #"[^"]*\(example\|sample\|template\|dist\)\$"\)/);
    rmSync(root, { recursive: true, force: true });
  });

  test("dataDir read+write deny present (defensive)", () => {
    const root = mkTmp("d440-prof-data-");
    const id = makeIdentity(root);
    const profile = compileGitBrokerProfile({
      operation: "status",
      identity: id,
      gitExecutable: GIT,
    });
    expect(profile).toMatch(/deny file-read\* file-write\* \(subpath "[^"]*nautilo-git-broker-deny"\)/);
    rmSync(root, { recursive: true, force: true });
  });

  test("NEVER emits a broad .git write allow exemption", () => {
    const root = mkTmp("d440-prof-noegit-");
    const id = makeIdentity(root);
    for (const op of ["status", "diff", "add", "commit", "worktree-add", "worktree-remove"] as const) {
      const profile = compileGitBrokerProfile({
        operation: op,
        identity: id,
        target: `${root}/wt`,
        worktreeName: "wt",
        gitExecutable: GIT,
      });
      // The only file-write* allows on a .git path must be the
      // narrow worktrees registry carve-out (worktree ops only).
      const writeAllows = profile.match(/allow file-read\* file-write\* \(subpath "[^"]*\.git[^"]*"\)/g) ?? [];
      if (op === "worktree-add" || op === "worktree-remove") {
        for (const a of writeAllows) {
          expect(a).toContain("worktrees");
        }
      } else {
        expect(writeAllows.length).toBe(0);
      }
    }
    rmSync(root, { recursive: true, force: true });
  });
});
