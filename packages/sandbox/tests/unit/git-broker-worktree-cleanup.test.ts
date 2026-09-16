/**
 * D440 Phase 3 — broker mid-flight materialization cleanup test.
 *
 * Platform-independent (no sandbox-exec): uses `disableSandboxForTests` and a
 * small wrapper script that delegates every git call to the real git EXCEPT
 * `cat-file blob <doomed-oid>`, which it exits 1 on. This deterministically
 * triggers a KNOWN failure AFTER the worktree metadata is created and the
 * first blob is materialized, exercising the broker's abort path:
 *   - broker-created files + the `.git` pointer + metadata are removed;
 *   - the target is left empty;
 *   - the worktree is not registered;
 *   - the disposition is not retry-safe (side effect began).
 */

import { describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { spawnSync } from "node:child_process";
import { GitBroker } from "../../src/git-broker/broker";

function findOnPath(executable: string): string | null {
  const systemGit = "/usr/bin/git";
  if (executable === "git" && existsSync(systemGit)) return systemGit;
  for (const d of (process.env["PATH"] ?? "").split(delimiter)) {
    if (d.length === 0) continue;
    const c = join(d, executable);
    if (existsSync(c)) return c;
  }
  return null;
}

function run(program: string, args: readonly string[], cwd: string) {
  return spawnSync(program, [...args], { cwd, encoding: "utf8", timeout: 10_000 });
}

describe("GitBroker mid-flight materialization cleanup (no sandbox-exec)", () => {
  const realGit = findOnPath("git");
  if (realGit === null) {
    test.skip("requires git on PATH", () => {});
    return;
  }

  test("known cat-file failure mid-flight removes broker artifacts", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "d440-clean-")));
    const repo = join(root, "repo");
    mkdirSync(repo);
    run(realGit, ["init", "--quiet"], repo);
    run(realGit, ["config", "user.name", "D440"], repo);
    run(realGit, ["config", "user.email", "d440@example.invalid"], repo);
    writeFileSync(join(repo, "small.txt"), "ok\n");
    writeFileSync(join(repo, "doomed.txt"), "doomed\n");
    run(realGit, ["add", "."], repo);
    run(realGit, ["-c", "commit.gpgsign=false", "commit", "--quiet", "-m", "m"], repo);
    const doomedOid = run(realGit, ["rev-parse", "HEAD:doomed.txt"], repo).stdout.trim();
    expect(doomedOid.length).toBe(40);

    // Wrapper script: delegate everything to real git, except fail on
    // `cat-file blob <doomedOid>`. The broker prepends `-c` config
    // overrides, so scan the full argv for the pattern rather than $1.
    const wrapper = join(root, "git-wrapper.sh");
    writeFileSync(
      wrapper,
      `#!/bin/sh
for i in "$@"; do
  if [ "$i" = "${doomedOid}" ]; then
    echo "fatal: simulated corrupt blob" >&2
    exit 1
  fi
done
exec "${realGit}" "$@"
`,
    );
    chmodSync(wrapper, 0o755);

    const target = join(root, "wt");
    mkdirSync(target);
    const broker = new GitBroker({
      authority: { repository: repo, grantedRoots: [root] },
      gitExecutable: wrapper,
      disableSandboxForTests: true,
    });
    const add = await broker.worktreeAdd(target, "HEAD");
    expect(add.ok).toBe(false);
    expect(add.sideEffectStarted).toBe(true);
    // Known failure: broker cleaned up its artifacts, so a retry is safe.
    expect(add.retrySafe).toBe(true);
    // Broker cleaned up its own files + the .git pointer + metadata.
    expect(existsSync(join(repo, ".git", "worktrees", "wt"))).toBe(false);
    expect(existsSync(join(target, "small.txt"))).toBe(false);
    expect(existsSync(join(target, ".git"))).toBe(false);
    expect(broker.registeredWorktrees().length).toBe(0);
    rmSync(root, { recursive: true, force: true });
  });
});
