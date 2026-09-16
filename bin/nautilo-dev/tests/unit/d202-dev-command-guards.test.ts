/**
 * ISSUE-D202 Wave 2 — guarded dev commands refuse default DB mutation
 * unless dry-run/read-only or explicit opt-in.
 */
import { basename, join } from "node:path";
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { describe, expect, mock, test } from "bun:test";
import { cleanupTestCruft } from "../../src/commands/cleanup-test-cruft";
import {
  devStackCmd,
  evaluateDevStackDefaultTargetGuard,
} from "../../src/commands/dev-stack";
import { migrateAddAgentRole, type ClusterExec } from "../../src/commands/migrate-add-agent-role";
import { resolveAndEvaluateDefaultInstanceMutationGuard } from "../../src/lib/default-instance-guard";

/** Synthetic nautilo-* worktree — do not derive from repo root (CI checkout basename is `nautilo`). */
const FEATURE_WORKTREE_CWD = join(tmpdir(), "nautilo-d202-protect-default-db");
mkdirSync(FEATURE_WORKTREE_CWD, { recursive: true });

function makeClusterExec(): ClusterExec {
  return {
    query: () => "",
    containerRunning: () => false,
  };
}

describe("cleanup-test-cruft default guard", () => {
  const keep = { keepUserHandles: "operator" };
  const defaultEnv = { NAUTILO_INSTANCE_ID: "default" } as NodeJS.ProcessEnv;

  test("dry-run against default is allowed by guard", () => {
    const decision = resolveAndEvaluateDefaultInstanceMutationGuard({
      commandName: "dev:cleanup-test-cruft",
      cwd: FEATURE_WORKTREE_CWD,
      env: defaultEnv,
      isDryRunOrReadOnly: true,
    });
    expect(decision.allowed).toBe(true);
  });

  test("--apply against default is refused without opt-in", async () => {
    const code = await cleanupTestCruft({
      ...keep,
      apply: true,
      cwd: FEATURE_WORKTREE_CWD,
      env: defaultEnv,
    });
    expect(code).toBe(2);
  });

  test("--apply against named instance is allowed by guard", () => {
    const decision = resolveAndEvaluateDefaultInstanceMutationGuard({
      commandName: "dev:cleanup-test-cruft",
      cwd: FEATURE_WORKTREE_CWD,
      env: { NAUTILO_INSTANCE_ID: "test-cruft" },
      isDryRunOrReadOnly: false,
    });
    expect(decision.allowed).toBe(true);
  });
});

describe("migrate-add-agent-role default guard", () => {
  test("dry-run probe against default is allowed (not exit 2)", async () => {
    const prev = process.env["NAUTILO_INSTANCE_ID"];
    const prevCwd = process.cwd();
    process.env["NAUTILO_INSTANCE_ID"] = "default";
    try {
      process.chdir(FEATURE_WORKTREE_CWD);
      const code = await migrateAddAgentRole({ apply: false }, makeClusterExec());
      expect(code).not.toBe(2);
    } finally {
      process.chdir(prevCwd);
      if (prev === undefined) delete process.env["NAUTILO_INSTANCE_ID"];
      else process.env["NAUTILO_INSTANCE_ID"] = prev;
    }
  });

  test("--apply against default is refused without opt-in", async () => {
    const prev = process.env["NAUTILO_INSTANCE_ID"];
    const prevCwd = process.cwd();
    process.env["NAUTILO_INSTANCE_ID"] = "default";
    try {
      process.chdir(FEATURE_WORKTREE_CWD);
      const code = await migrateAddAgentRole({ apply: true }, makeClusterExec());
      expect(code).toBe(2);
    } finally {
      process.chdir(prevCwd);
      if (prev === undefined) delete process.env["NAUTILO_INSTANCE_ID"];
      else process.env["NAUTILO_INSTANCE_ID"] = prev;
    }
  });
});

describe("dev-stack default targeting guard", () => {
  const canonicalCwd = "/repos/nautilo";
  const worktreeBase = basename(FEATURE_WORKTREE_CWD);

  test("canonical checkout + default allowed without opt-in", () => {
    const decision = evaluateDevStackDefaultTargetGuard("", canonicalCwd, {});
    expect(decision.allowed).toBe(true);
  });

  test("feature worktree explicit default refused without opt-in", () => {
    const decision = evaluateDevStackDefaultTargetGuard("", FEATURE_WORKTREE_CWD, {});
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) {
      expect(decision.message).toContain(worktreeBase);
    }
  });

  test("feature worktree explicit default allowed with opt-in", () => {
    const decision = evaluateDevStackDefaultTargetGuard("", FEATURE_WORKTREE_CWD, {
      iKnowWhatIAmDoing: true,
    });
    expect(decision.allowed).toBe(true);
  });

  test("devStackCmd refuses feature worktree --instance default before spawn", async () => {
    const spawnMock = mock(() => {
      throw new Error("dev-stack should not spawn when default guard refuses");
    });
    const code = await devStackCmd(
      ["--instance", "default", "--no-infra", "--no-build"],
      {
        cwd: FEATURE_WORKTREE_CWD,
        env: {},
        spawn: spawnMock as unknown as typeof Bun.spawn,
      },
    );
    expect(code).toBe(2);
    expect(spawnMock).not.toHaveBeenCalled();
  });
});
