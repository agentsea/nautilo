import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";

import { buildSandboxExec } from "../../src/seatbelt";
import type { SandboxConfig, SpawnArgs } from "../../src/types";

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

function run(
  program: string,
  args: readonly string[],
  options: { cwd: string; env?: Record<string, string> },
) {
  return spawnSync(program, [...args], {
    cwd: options.cwd,
    encoding: "utf8",
    env: options.env,
    timeout: 10_000,
  });
}

function makeRepository(git: string): {
  root: string;
  repository: string;
  worktreeTarget: string;
} {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "d440-git-baseline-")));
  rootsToRemove.push(root);
  const repository = join(root, "repository");
  const worktreeTarget = join(root, "linked-worktree");
  mkdirSync(repository);

  expect(run(git, ["init", "--quiet"], { cwd: repository }).status).toBe(0);
  writeFileSync(join(repository, "public.txt"), "public\n");
  writeFileSync(join(repository, ".env.example"), "PUBLIC_NAME=example\n");
  expect(run(git, ["add", "public.txt", ".env.example"], { cwd: repository }).status).toBe(0);
  expect(
    run(
      git,
      [
        "-c",
        "user.name=D440 Fixture",
        "-c",
        "user.email=d440@example.invalid",
        "-c",
        "commit.gpgsign=false",
        "commit",
        "--quiet",
        "-m",
        "fixture",
      ],
      { cwd: repository },
    ).status,
  ).toBe(0);

  return { root, repository, worktreeTarget };
}

function baselineConfig(): SandboxConfig {
  return {
    mode: "enabled",
    writablePaths: [],
    projectPaths: [],
    passthroughEnv: [],
  };
}

function wrapGitShell(
  git: string,
  repository: string,
  command: string,
): SpawnArgs {
  const dataDir = `${repository}-sandbox-data`;
  mkdirSync(dataDir);
  return buildSandboxExec({
    workspace: repository,
    dataDir,
    toolsBin: dirname(git),
    config: baselineConfig(),
    cwd: repository,
    commandEnv: {},
    program: "/bin/sh",
    args: ["-c", command],
  });
}

function executeWrapped(wrapped: SpawnArgs) {
  return run(wrapped.program, wrapped.args, {
    cwd: wrapped.cwd,
    ...(wrapped.env === null ? {} : { env: wrapped.env }),
  });
}

describe("D440 baseline Git denials (Darwin sandbox-exec only)", () => {
  const git = findOnPath("git");
  const shouldRun =
    process.platform === "darwin" &&
    existsSync("/usr/bin/sandbox-exec") &&
    git !== null;

  if (!shouldRun || git === null) {
    test.skip("requires Darwin sandbox-exec and Git", () => {});
    return;
  }

  test("pwd and status succeed but worktree common-dir creation is denied", () => {
    const fixture = makeRepository(git);
    const command = [
      "pwd",
      `${JSON.stringify(git)} status --short`,
      `${JSON.stringify(git)} worktree add --detach ${JSON.stringify(fixture.worktreeTarget)} HEAD`,
    ].join(" && ");
    const wrapped = wrapGitShell(git, fixture.repository, command);
    const profile = wrapped.args[1] ?? "";
    const deniedPath = join(fixture.repository, ".git");

    expect(profile).toContain(`(deny file-write* (subpath "${deniedPath}"))`);

    const result = executeWrapped(wrapped);
    expect(result.error).toBeUndefined();
    expect(result.status).not.toBe(0);
    expect(result.stdout.split("\n")[0]).toBe(fixture.repository);
    expect(result.stderr).toMatch(/Operation not permitted|Permission denied/);
    expect(result.stderr).toContain(".git/worktrees/linked-worktree");
    expect(existsSync(join(deniedPath, "worktrees"))).toBe(false);
    expect(existsSync(fixture.worktreeTarget)).toBe(false);
  });

  test("tracked public template can be materialized while live env stays unreadable", () => {
    const fixture = makeRepository(git);
    rmSync(join(fixture.repository, ".env.example"));
    writeFileSync(join(fixture.repository, ".env"), "SECRET=live\n");

    const command = [
      `${JSON.stringify(git)} show HEAD:.env.example > .env.example`,
      "test ! -r .env",
    ].join(" && ");
    const wrapped = wrapGitShell(git, fixture.repository, command);
    const profile = wrapped.args[1] ?? "";
    const escapedRepository = fixture.repository.replaceAll(".", "\\.");
    const publicTemplateRule =
      `^${escapedRepository}/(.*/)?[^/]+\\.(example|sample|template|dist)$`;
    const liveEnvRule = `^${escapedRepository}/(.*/)?\\.env[^/]*$`;

    expect(profile).toContain(
      `(allow file-read* file-write* (regex #"${publicTemplateRule}"))`,
    );
    expect(profile).toContain(
      `(deny file-read* file-write* (regex #"${liveEnvRule}"))`,
    );

    const result = executeWrapped(wrapped);
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(existsSync(join(fixture.repository, ".env.example"))).toBe(true);
  });
});
