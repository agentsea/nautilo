/**
 * M059 — `nautilo-dev upgrade` runner.
 *
 * Covers every branch with injected deps so we never touch docker /
 * Postgres / npx:
 *   - dry-run skips snapshot AND skips both shell-outs
 *   - snapshot failure is a hard stop (no migrations run)
 *   - drizzle failure is a hard stop (Logto migration NOT run)
 *   - Logto migration skipped when logto_nautilo is absent
 *   - Logto migration runs with DB_URL override
 *   - Both migrators run in lock-step on the happy path
 */
import { join } from "node:path";
import { mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { describe, expect, test } from "bun:test";
import { runUpgrade, type UpgradeDeps } from "../../src/commands/upgrade";
import { DEPENDENCY_PINS } from "../../../../deploy/dependency-pins";

/** Synthetic nautilo-* worktree — do not derive from repo root (CI checkout basename is `nautilo`). */
const FEATURE_WORKTREE_CWD = join(tmpdir(), "nautilo-d202-protect-default-db");
mkdirSync(FEATURE_WORKTREE_CWD, { recursive: true });

interface ShellInvocation {
  cmd: string;
  args: string[];
  cwd?: string | undefined;
  env?: NodeJS.ProcessEnv | undefined;
}

function makeDeps(overrides: {
  snapshotFails?: boolean;
  hasLogtoDb?: boolean;
  drizzleFails?: boolean;
  logtoFails?: boolean;
} = {}): {
  deps: UpgradeDeps;
  snapshotCalls: string[];
  shellCalls: ShellInvocation[];
  logCalls: string[];
} {
  const snapshotCalls: string[] = [];
  const shellCalls: ShellInvocation[] = [];
  const logCalls: string[] = [];

  const deps: UpgradeDeps = {
    snapshot: async (name) => {
      snapshotCalls.push(name);
      if (overrides.snapshotFails) throw new Error("disk full");
    },
    hasLogtoDb: () => overrides.hasLogtoDb ?? true,
    runShell: async (cmd, args, opts) => {
      shellCalls.push({ cmd, args, cwd: opts?.cwd, env: opts?.env });
      if (cmd === "bun" && args[1] === "db:migrate") {
        return { ok: !overrides.drizzleFails, code: overrides.drizzleFails ? 2 : 0 };
      }
      if (cmd === "bun" && args[0] === "x" && args[1]?.startsWith("@logto/cli")) {
        return { ok: !overrides.logtoFails, code: overrides.logtoFails ? 3 : 0 };
      }
      return { ok: true, code: 0 };
    },
    logtoDbUrl: () => "postgres://logto:logto@localhost:5432/logto_nautilo",
    log: (msg) => {
      logCalls.push(msg);
    },
    isoStamp: () => "2026-04-29T18-00-00-000Z",
  };

  return { deps, snapshotCalls, shellCalls, logCalls };
}

describe("upgrade default guard", () => {
  test("dry-run against default is allowed by guard", async () => {
    const prev = process.env["NAUTILO_INSTANCE_ID"];
    const prevCwd = process.cwd();
    process.env["NAUTILO_INSTANCE_ID"] = "default";
    try {
      process.chdir(FEATURE_WORKTREE_CWD);
      const { upgrade } = await import("../../src/commands/upgrade");
      const code = await upgrade({ dryRun: true });
      expect(code).not.toBe(2);
    } finally {
      process.chdir(prevCwd);
      if (prev === undefined) delete process.env["NAUTILO_INSTANCE_ID"];
      else process.env["NAUTILO_INSTANCE_ID"] = prev;
    }
  });
});

describe("runUpgrade — happy path", () => {
  test("snapshots, runs drizzle, runs Logto migrate; exits 0", async () => {
    const { deps, snapshotCalls, shellCalls } = makeDeps();
    const code = await runUpgrade({}, deps);
    expect(code).toBe(0);
    expect(snapshotCalls).toEqual(["auto-pre-upgrade-2026-04-29T18-00-00-000Z"]);
    expect(shellCalls).toHaveLength(2);
    expect(shellCalls[0]?.cmd).toBe("bun");
    expect(shellCalls[0]?.args).toEqual(["run", "db:migrate"]);
    expect(shellCalls[0]?.cwd).toBe(join(import.meta.dir, "../../../../packages/db"));
    expect(shellCalls[1]?.cmd).toBe("bun");
    // Logto CLI + deploy target derive from the deployed server image tag
    // (deploy/dependency-pins.ts) — the single source of truth.
    const v = DEPENDENCY_PINS.logtoImageTag;
    expect(shellCalls[1]?.args).toEqual([
      "x",
      `@logto/cli@${v}`,
      "db",
      "alteration",
      "deploy",
      v,
    ]);
    expect(shellCalls[1]?.env?.["DB_URL"]).toBe(
      "postgres://logto:logto@localhost:5432/logto_nautilo",
    );
  });

  test("prepares database roles before Drizzle and reconciles again afterward", async () => {
    const { deps } = makeDeps();
    const events: string[] = [];
    deps.prepareDbRoles = async () => {
      events.push("roles-before");
      return 0;
    };
    const originalRunShell = deps.runShell;
    deps.runShell = async (cmd, args, opts) => {
      if (cmd === "bun" && args[1] === "db:migrate") {
        events.push("drizzle");
      }
      return originalRunShell(cmd, args, opts);
    };
    deps.reconcile = async () => {
      events.push("roles-after");
      return 0;
    };

    expect(await runUpgrade({}, deps)).toBe(0);
    expect(events).toEqual(["roles-before", "drizzle", "roles-after"]);
  });

  test("drizzle runs BEFORE Logto (order is load-bearing — failure rollback)", async () => {
    const { deps, shellCalls } = makeDeps();
    await runUpgrade({}, deps);
    const drizzleIdx = shellCalls.findIndex((c) => c.args[1] === "db:migrate");
    const logtoIdx = shellCalls.findIndex(
      (c) => c.cmd === "bun" && c.args[0] === "x",
    );
    expect(drizzleIdx).toBeGreaterThan(-1);
    expect(logtoIdx).toBeGreaterThan(drizzleIdx);
  });
});

describe("runUpgrade — dry-run", () => {
  test("does NOT snapshot, does NOT run any shell command, exits 0", async () => {
    const { deps, snapshotCalls, shellCalls } = makeDeps();
    const code = await runUpgrade({ dryRun: true }, deps);
    expect(code).toBe(0);
    expect(snapshotCalls).toEqual([]);
    expect(shellCalls).toEqual([]);
  });
});

describe("runUpgrade — failure branches", () => {
  test("snapshot failure aborts before any migration runs", async () => {
    const { deps, shellCalls } = makeDeps({ snapshotFails: true });
    const code = await runUpgrade({}, deps);
    expect(code).toBe(1);
    expect(shellCalls).toEqual([]);
  });

  test("drizzle failure aborts before Logto migration runs", async () => {
    const { deps, shellCalls } = makeDeps({ drizzleFails: true });
    const code = await runUpgrade({}, deps);
    expect(code).toBe(2);
    // Only drizzle ran; Logto's npx call must not have fired.
    expect(shellCalls).toHaveLength(1);
    expect(shellCalls[0]?.args).toEqual(["run", "db:migrate"]);
  });

  test("Logto failure surfaces its exit code", async () => {
    const { deps } = makeDeps({ logtoFails: true });
    const code = await runUpgrade({}, deps);
    expect(code).toBe(3);
  });
});

describe("Logto version pin — single source of truth", () => {
  test("dependency-pins image string carries its own tag (internal consistency)", () => {
    expect(DEPENDENCY_PINS.logto).toBe(
      `ghcr.io/logto-io/logto:${DEPENDENCY_PINS.logtoImageTag}`,
    );
  });

  test("@logto/cli devDependency matches the deployed server image tag", () => {
    // The devDep is the only remaining second copy of the version; this
    // test turns "keep in sync" from a comment into an enforced invariant.
    const pkg = JSON.parse(
      readFileSync(join(import.meta.dir, "../../package.json"), "utf8"),
    ) as { devDependencies?: Record<string, string> };
    expect(pkg.devDependencies?.["@logto/cli"]).toBe(
      DEPENDENCY_PINS.logtoImageTag,
    );
  });
});

describe("runUpgrade — Logto absent", () => {
  test("skips Logto migration cleanly when logto_nautilo is not present", async () => {
    const { deps, shellCalls, logCalls } = makeDeps({ hasLogtoDb: false });
    const code = await runUpgrade({}, deps);
    expect(code).toBe(0);
    // drizzle ran but the npx call did NOT.
    expect(shellCalls).toHaveLength(1);
    expect(shellCalls[0]?.args).toEqual(["run", "db:migrate"]);
    expect(
      logCalls.some((m) => m.includes("No logto_nautilo on the running cluster")),
    ).toBe(true);
  });
});
