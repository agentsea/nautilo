import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const repositoryRoot = join(import.meta.dir, "../../..");
const cleanEnv = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("GIT_")));

test("publication fixtures preserve the caller repository when launched from a Git hook", () => {
  const sentinel = mkdtempSync(join(tmpdir(), "nautilo-hook-caller-"));
  const git = (...args: string[]) => {
    const result = spawnSync("git", args, { cwd: sentinel, encoding: "utf8", env: cleanEnv });
    expect(result.status, result.stderr).toBe(0);
    return result.stdout.trim();
  };
  try {
    git("init", "-q");
    git("config", "user.name", "Sentinel Maintainer");
    git("config", "user.email", "sentinel@example.test");
    writeFileSync(join(sentinel, "sentinel.txt"), "must remain unchanged\n");
    git("add", ".");
    git("commit", "-qm", "sentinel baseline");
    const head = git("rev-parse", "HEAD");
    const config = readFileSync(join(sentinel, ".git/config"));
    const index = readFileSync(join(sentinel, ".git/index"));
    const result = spawnSync(process.execPath, ["test", "--timeout", "60000",
      "dev/tests/repo-invariants/migration-hook.test.ts",
      "apps/desktop/tests/unit-isolated/computer-use-host-publisher.test.ts"], {
      cwd: repositoryRoot, encoding: "utf8",
      env: { ...cleanEnv, GIT_DIR: join(sentinel, ".git"), GIT_WORK_TREE: sentinel,
        GIT_INDEX_FILE: join(sentinel, ".git/index"), GIT_PREFIX: "nested/" },
    });
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(git("rev-parse", "HEAD")).toBe(head);
    expect(readFileSync(join(sentinel, ".git/config"))).toEqual(config);
    expect(readFileSync(join(sentinel, ".git/index"))).toEqual(index);
    expect(git("status", "--porcelain")).toBe("");
    expect(readFileSync(join(sentinel, "sentinel.txt"), "utf8")).toBe("must remain unchanged\n");
  } finally { rmSync(sentinel, { recursive: true, force: true }); }
}, 60_000);
