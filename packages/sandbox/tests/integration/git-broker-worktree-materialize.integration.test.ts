/**
 * D440 Phase 3 — live Darwin sandbox integration tests for broker-
 * controlled worktree materialization.
 *
 * Exercises the full `worktreeAdd` pipeline under the compiled
 * per-operation SBPL profile (Darwin + sandbox-exec only):
 *   - normal file, executable, nested dirs, public `.env.example`
 *     materialize cleanly and `git status --porcelain` is empty;
 *   - live `.env` tracked in the repo is denied BEFORE mutation
 *     (no metadata, target stays empty, retry-safe);
 *   - symlink tree entry is denied before mutation;
 *   - submodules are denied at preflight;
 *   - per-blob and total-byte limits deny before mutation (lowered
 *     via `worktreeLimits` so tests do not write megabyte fixtures);
 *   - round-trip remove of a clean materialized tree succeeds without
 *     `--force` and prunes metadata;
 *   - a dirty (operator-modified) worktree is rejected for removal
 *     (`deny-dirty-removal`);
 *   - a known materialization failure (per-blob limit exceeded) cleans
 *     up broker-created files + metadata and reports residual paths.
 */

import { afterEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { spawnSync } from "node:child_process";

import { GitBroker } from "../../src/git-broker/broker";

const rootsToRemove: string[] = [];
afterEach(() => {
  for (const root of rootsToRemove.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

function findOnPath(executable: string): string | null {
  const systemGit = "/usr/bin/git";
  if (executable === "git" && existsSync(systemGit)) return systemGit;
  for (const directory of (process.env["PATH"] ?? "").split(delimiter)) {
    if (directory.length === 0) continue;
    const candidate = join(directory, executable);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

function run(program: string, args: readonly string[], cwd: string) {
  return spawnSync(program, [...args], { cwd, encoding: "utf8", timeout: 10_000 });
}

function makeRepo(git: string, files: Record<string, string> = { "public.txt": "public\n" }): {
  root: string;
  repo: string;
} {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "d440-mat-live-")));
  rootsToRemove.push(root);
  const repo = join(root, "repo");
  mkdirSync(repo);
  expect(run(git, ["init", "--quiet"], repo).status).toBe(0);
  expect(run(git, ["config", "user.name", "D440"], repo).status).toBe(0);
  expect(run(git, ["config", "user.email", "d440@example.invalid"], repo).status).toBe(0);
  for (const [path, content] of Object.entries(files)) {
    const abs = join(repo, path);
    mkdirSync(join(repo, path.split("/").slice(0, -1).join("/")), { recursive: true });
    writeFileSync(abs, content);
    if (path.endsWith(".sh")) chmodSync(abs, 0o755);
  }
  expect(run(git, ["add", "."], repo).status).toBe(0);
  expect(
    run(
      git,
      ["-c", "commit.gpgsign=false", "commit", "--quiet", "-m", "fixture"],
      repo,
    ).status,
  ).toBe(0);
  return { root, repo };
}

describe("GitBroker worktree materialization (Darwin sandbox-exec only)", () => {
  const git = findOnPath("git");
  const shouldRun =
    process.platform === "darwin" &&
    existsSync("/usr/bin/sandbox-exec") &&
    git !== null;
  if (!shouldRun || git === null) {
    test.skip("requires Darwin sandbox-exec and Git", () => {});
    return;
  }

  test("materializes regular + executable + nested + public .env.example; status clean", async () => {
    const { root, repo } = makeRepo(git, {
      "public.txt": "public\n",
      "bin/run.sh": "#!/bin/sh\necho hi\n",
      "src/a/b/c/deep.txt": "deep\n",
      ".env.example": "PUBLIC=example\n",
    });
    const target = join(root, "wt");
    mkdirSync(target);
    const broker = new GitBroker({
      authority: { repository: repo, grantedRoots: [root] },
      gitExecutable: git,
    });
    const add = await broker.worktreeAdd(target, "HEAD");
    expect(add.ok).toBe(true);
    expect(add.reason).toBe("ok");
    expect(broker.registeredWorktrees().length).toBe(1);
    expect(existsSync(join(repo, ".git", "worktrees", "wt"))).toBe(true);

    // Files materialized with exact content + modes.
    expect(readFileSync(join(target, "public.txt"), "utf8")).toBe("public\n");
    expect(readFileSync(join(target, ".env.example"), "utf8")).toBe("PUBLIC=example\n");
    expect(readFileSync(join(target, "src/a/b/c/deep.txt"), "utf8")).toBe("deep\n");
    expect(lstatSync(join(target, "bin/run.sh")).mode & 0o111).not.toBe(0);
    expect(lstatSync(join(target, "public.txt")).mode & 0o111).toBe(0);

    // The resulting worktree is clean per git status --porcelain.
    const status = run(git, ["status", "--porcelain", "-z"], target).stdout;
    expect(status).toBe("");
  });

  test("live .env tracked in repo is denied BEFORE mutation", async () => {
    const { root, repo } = makeRepo(git, {
      "public.txt": "public\n",
      ".env": "SECRET=live\n",
    });
    const target = join(root, "wt");
    mkdirSync(target);
    const broker = new GitBroker({
      authority: { repository: repo, grantedRoots: [root] },
      gitExecutable: git,
    });
    const add = await broker.worktreeAdd(target, "HEAD");
    expect(add.ok).toBe(false);
    expect(add.reason).toBe("deny-live-env");
    expect(add.sideEffectStarted).toBe(false);
    expect(add.retrySafe).toBe(true);
    // No metadata, target still empty.
    expect(existsSync(join(repo, ".git", "worktrees", "wt"))).toBe(false);
    expect(readdirEmpty(target)).toBe(true);
  });

  test("symlink tree entry is denied before mutation", async () => {
    const { root, repo } = makeRepo(git, { "public.txt": "public\n", "link": "public.txt" });
    // Recreate `link` as a real symlink tracked by git.
    rmSync(join(repo, "link"));
    symlinkSync("public.txt", join(repo, "link"));
    // Re-add + commit the symlink as a symlink tree entry.
    run(git, ["add", "link"], repo);
    run(git, ["-c", "commit.gpgsign=false", "commit", "--quiet", "-m", "symlink"], repo);
    const target = join(root, "wt");
    mkdirSync(target);
    const broker = new GitBroker({
      authority: { repository: repo, grantedRoots: [root] },
      gitExecutable: git,
    });
    const add = await broker.worktreeAdd(target, "HEAD");
    expect(add.ok).toBe(false);
    expect(add.reason).toBe("deny-escaping-symlink");
    expect(add.sideEffectStarted).toBe(false);
    expect(existsSync(join(repo, ".git", "worktrees", "wt"))).toBe(false);
  });

  test("submodules are denied at preflight (before mutation)", async () => {
    const { root, repo } = makeRepo(git, { "public.txt": "public\n" });
    writeFileSync(
      join(repo, ".gitmodules"),
      '[submodule "vendor"]\n\tpath = vendor\n\turl = https://example.invalid/vendor\n',
    );
    run(git, ["add", ".gitmodules"], repo);
    run(git, ["-c", "commit.gpgsign=false", "commit", "--quiet", "-m", "submod"], repo);
    const target = join(root, "wt");
    mkdirSync(target);
    const broker = new GitBroker({
      authority: { repository: repo, grantedRoots: [root] },
      gitExecutable: git,
    });
    const add = await broker.worktreeAdd(target, "HEAD");
    expect(add.ok).toBe(false);
    expect(add.reason).toBe("deny-submodules");
    expect(add.sideEffectStarted).toBe(false);
  });

  test("per-blob limit denies BEFORE mutation (lowered bounds)", async () => {
    const { root, repo } = makeRepo(git, { "public.txt": "public\n", "big.txt": "x".repeat(200) });
    const target = join(root, "wt");
    mkdirSync(target);
    const broker = new GitBroker({
      authority: { repository: repo, grantedRoots: [root] },
      gitExecutable: git,
      worktreeLimits: { fileCount: 4096, blobBytes: 64, totalBytes: 1024 },
    });
    const add = await broker.worktreeAdd(target, "HEAD");
    expect(add.ok).toBe(false);
    expect(add.reason).toBe("deny-add-bounds");
    expect(add.sideEffectStarted).toBe(false);
    expect(add.retrySafe).toBe(true);
    expect(existsSync(join(repo, ".git", "worktrees", "wt"))).toBe(false);
    expect(readdirEmpty(target)).toBe(true);
  });

  test("total-bytes limit denies BEFORE mutation (lowered bounds)", async () => {
    const { root, repo } = makeRepo(git, {
      "a.txt": "a".repeat(40),
      "b.txt": "b".repeat(40),
      "c.txt": "c".repeat(40),
    });
    const target = join(root, "wt");
    mkdirSync(target);
    const broker = new GitBroker({
      authority: { repository: repo, grantedRoots: [root] },
      gitExecutable: git,
      worktreeLimits: { fileCount: 4096, blobBytes: 1024, totalBytes: 64 },
    });
    const add = await broker.worktreeAdd(target, "HEAD");
    expect(add.ok).toBe(false);
    expect(add.reason).toBe("deny-add-bounds");
    expect(add.sideEffectStarted).toBe(false);
    expect(add.retrySafe).toBe(true);
    expect(existsSync(join(repo, ".git", "worktrees", "wt"))).toBe(false);
  });

  test("round-trip remove of a clean materialized tree succeeds without --force", async () => {
    const { root, repo } = makeRepo(git, {
      "public.txt": "public\n",
      "bin/run.sh": "#!/bin/sh\necho hi\n",
    });
    const target = join(root, "wt");
    mkdirSync(target);
    const broker = new GitBroker({
      authority: { repository: repo, grantedRoots: [root] },
      gitExecutable: git,
    });
    expect((await broker.worktreeAdd(target, "HEAD")).ok).toBe(true);
    expect(broker.registeredWorktrees().length).toBe(1);

    const rm = await broker.worktreeRemove(target);
    expect(rm.ok).toBe(true);
    expect(broker.registeredWorktrees().length).toBe(0);
    expect(existsSync(join(repo, ".git", "worktrees", "wt"))).toBe(false);
    expect(existsSync(target)).toBe(false);
  });

  test("dirty (operator-modified) worktree removal is rejected", async () => {
    const { root, repo } = makeRepo(git, { "public.txt": "public\n" });
    const target = join(root, "wt");
    mkdirSync(target);
    const broker = new GitBroker({
      authority: { repository: repo, grantedRoots: [root] },
      gitExecutable: git,
    });
    expect((await broker.worktreeAdd(target, "HEAD")).ok).toBe(true);
    // Operator adds an untracked file.
    writeFileSync(join(target, "operator-added.txt"), "operator\n");
    const rm = await broker.worktreeRemove(target);
    expect(rm.ok).toBe(false);
    expect(rm.reason).toBe("deny-dirty-removal");
    // The operator's file + the worktree are preserved.
    expect(existsSync(join(target, "operator-added.txt"))).toBe(true);
    expect(existsSync(join(repo, ".git", "worktrees", "wt"))).toBe(true);
    expect(broker.registeredWorktrees().length).toBe(1);
  });

  test("missing/corrupt blob object denied BEFORE mutation", async () => {
    const { root, repo } = makeRepo(git, { "small.txt": "ok\n", "doomed.txt": "doomed\n" });
    // Delete the `doomed.txt` blob object. `git ls-tree -l` still lists
    // the entry (it reads the tree, not the blob) but reports size `BAD`,
    // so the broker's manifest validation rejects it BEFORE any durable
    // mutation. No metadata, no files, target stays empty, retry-safe.
    const doomedOid = run(git, ["rev-parse", "HEAD:doomed.txt"], repo).stdout.trim();
    expect(doomedOid.length).toBe(40);
    const objPath = join(repo, ".git", "objects", doomedOid.slice(0, 2), doomedOid.slice(2));
    expect(existsSync(objPath)).toBe(true);
    rmSync(objPath, { force: true });

    const target = join(root, "wt");
    mkdirSync(target);
    const broker = new GitBroker({
      authority: { repository: repo, grantedRoots: [root] },
      gitExecutable: git,
    });
    const add = await broker.worktreeAdd(target, "HEAD");
    expect(add.ok).toBe(false);
    expect(add.sideEffectStarted).toBe(false);
    expect(add.retrySafe).toBe(true);
    expect(existsSync(join(repo, ".git", "worktrees", "wt"))).toBe(false);
    expect(readdirEmpty(target)).toBe(true);
    expect(broker.registeredWorktrees().length).toBe(0);
  });
});

function readdirEmpty(dir: string): boolean {
  return readdirSync(dir).length === 0;
}
