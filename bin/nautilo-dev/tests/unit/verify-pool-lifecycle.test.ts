/**
 * M210 Phase 6 — `verify-pool-lifecycle` guard, verdict, and output tests.
 *
 * Uses injected fetch/metadata deps only; no live DB, Docker, or server.
 */
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { __resetResolvedInstanceForTests, writeInstanceJson } from "@nautilo/config";
import { resolveDirectDatabaseConnectionString, resolveAgentDatabaseConnectionString, resolveAppDatabaseConnectionString } from "@nautilo/db";
import {
  evaluatePoolLifecycleVerdict,
  formatVerdictSummary,
  formatMetricsSnapshotLines,
  hasIdleInTransaction,
  countUnexpectedLiveSessions,
  directPostgresSelect1,
  parsePoolLifecycleTarget,
  parseVerifyPoolLifecycleArgs,
  POOL_LIFECYCLE_PARALLEL_COUNT,
  POOL_LIFECYCLE_SEQUENTIAL_COUNT,
  UNEXPECTED_SESSION_CEILING,
  runVerifyPoolLifecycle,
  SESSION_WARM_UP_ALLOWANCE,
  sanitizePoolLifecycleError,
  type BurstLoadResult,
  type MetadataReader,
  type PoolMetricsSnapshot,
} from "../../src/lib/pool-lifecycle-verify";

function captureLog() {
  const lines: string[] = [];
  return {
    log: (msg: string) => {
      lines.push(msg);
    },
    output: () => lines.join("\n"),
  };
}

function baseSnapshot(overrides?: Partial<PoolMetricsSnapshot>): PoolMetricsSnapshot {
  return {
    database: {
      datname: "nautilo",
      sessions: 12,
      sessionsAbandoned: 0,
    },
    activityGroups: [
      {
        clientAddr: "127.0.0.1",
        usename: "postgres",
        applicationName: "",
        state: "idle",
        count: 2,
      },
      {
        clientAddr: "127.0.0.1",
        usename: "nautilo",
        applicationName: "nautilo.direct",
        state: "idle",
        count: 3,
      },
    ],
    ...overrides,
  };
}

function okBurst(): BurstLoadResult {
  return {
    requested: POOL_LIFECYCLE_PARALLEL_COUNT,
    succeeded: POOL_LIFECYCLE_PARALLEL_COUNT,
    failed: 0,
  };
}

describe("parsePoolLifecycleTarget / parseVerifyPoolLifecycleArgs — guards", () => {
  test("missing instance and profile → exit 2", () => {
    const r = parseVerifyPoolLifecycleArgs([]);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.exitCode).toBe(2);
      expect(r.message).toContain("--instance");
      expect(r.message).toContain("--profile");
    }
  });

  test("default --instance rejected", () => {
    const r = parsePoolLifecycleTarget({ explicitInstance: "default" });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.exitCode).toBe(2);
      expect(r.message).toContain("Refusing default");
    }
  });

  test("empty --instance rejected", () => {
    const r = parsePoolLifecycleTarget({ explicitInstance: "   " });
    expect(r.ok).toBe(false);
  });

  test("both --instance and --profile rejected", () => {
    const r = parseVerifyPoolLifecycleArgs(["--instance", "pool-qa", "--profile", "omega-qa"]);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.message).toContain("only one");
    }
  });

  test("explicit non-default --instance accepted", () => {
    const r = parseVerifyPoolLifecycleArgs([], { explicitInstance: "pool-qa" });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.target).toEqual({ kind: "instance", name: "pool-qa" });
    }
  });

  test("explicit non-default --profile accepted", () => {
    const r = parseVerifyPoolLifecycleArgs(["--profile", "omega-qa"]);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.target).toEqual({ kind: "profile", name: "omega-qa" });
    }
  });

  test("default --profile rejected", () => {
    const r = parseVerifyPoolLifecycleArgs(["--profile", "(default)"]);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.message).toContain("Refusing default");
    }
  });
});

describe("sanitizePoolLifecycleError", () => {
  test("redacts connection strings and auth header names", () => {
    const msg = sanitizePoolLifecycleError(
      new Error(
        "failed postgresql://user:secret@host:5432/nautilo Neon-Connection-String leak",
      ),
    );
    expect(msg).not.toContain("postgresql://user:secret");
    expect(msg).not.toContain("Neon-Connection-String");
    expect(msg).toContain("[redacted]");
  });
});

describe("evaluatePoolLifecycleVerdict", () => {
  test("clean run passes", () => {
    const before = baseSnapshot();
    const after = baseSnapshot({
      database: { datname: "nautilo", sessions: 14, sessionsAbandoned: 0 },
    });
    const verdict = evaluatePoolLifecycleVerdict({
      before,
      after,
      burst: okBurst(),
      sequentialCount: POOL_LIFECYCLE_SEQUENTIAL_COUNT,
    });
    expect(verdict.passed).toBe(true);
    expect(verdict.flags).toHaveLength(0);
  });

  test("flags severe session growth", () => {
    const before = baseSnapshot({
      database: { datname: "nautilo", sessions: 10, sessionsAbandoned: 0 },
    });
    const after = baseSnapshot({
      database: { datname: "nautilo", sessions: 1_010, sessionsAbandoned: 0 },
    });
    const verdict = evaluatePoolLifecycleVerdict({
      before,
      after,
      burst: okBurst(),
      sequentialCount: POOL_LIFECYCLE_SEQUENTIAL_COUNT,
    });
    expect(verdict.passed).toBe(false);
    expect(verdict.flags.some((f) => f.code === "severe-session-growth")).toBe(true);
  });

  test("allows only a small session warm-up", () => {
    const before = baseSnapshot({
      database: { datname: "nautilo", sessions: 10, sessionsAbandoned: 0 },
    });
    const withinAllowance = evaluatePoolLifecycleVerdict({
      before,
      after: baseSnapshot({
        database: {
          datname: "nautilo",
          sessions: 10 + SESSION_WARM_UP_ALLOWANCE,
          sessionsAbandoned: 0,
        },
      }),
      burst: okBurst(),
      sequentialCount: POOL_LIFECYCLE_SEQUENTIAL_COUNT,
    });
    const beyondAllowance = evaluatePoolLifecycleVerdict({
      before,
      after: baseSnapshot({
        database: {
          datname: "nautilo",
          sessions: 11 + SESSION_WARM_UP_ALLOWANCE,
          sessionsAbandoned: 0,
        },
      }),
      burst: okBurst(),
      sequentialCount: POOL_LIFECYCLE_SEQUENTIAL_COUNT,
    });

    expect(withinAllowance.flags).toHaveLength(0);
    expect(beyondAllowance.flags.some((f) => f.code === "severe-session-growth")).toBe(
      true,
    );
  });

  test("flags failed parallel burst", () => {
    const verdict = evaluatePoolLifecycleVerdict({
      before: baseSnapshot(),
      after: baseSnapshot(),
      burst: { requested: 50, succeeded: 49, failed: 1 },
      sequentialCount: POOL_LIFECYCLE_SEQUENTIAL_COUNT,
    });
    expect(verdict.flags.some((f) => f.code === "failed-parallel-burst")).toBe(true);
  });

  test("flags idle in transaction", () => {
    const after = baseSnapshot({
      activityGroups: [
        {
          clientAddr: "127.0.0.1",
          usename: "nautilo",
          applicationName: "nautilo.direct",
          state: "idle in transaction",
          count: 1,
        },
      ],
    });
    expect(hasIdleInTransaction(after.activityGroups)).toBe(true);
    const verdict = evaluatePoolLifecycleVerdict({
      before: baseSnapshot(),
      after,
      burst: okBurst(),
      sequentialCount: POOL_LIFECYCLE_SEQUENTIAL_COUNT,
    });
    expect(verdict.flags.some((f) => f.code === "idle-in-transaction")).toBe(true);
  });

  test("flags unexpected sessions over ceiling", () => {
    const groups = Array.from({ length: UNEXPECTED_SESSION_CEILING + 5 }, (_, i) => ({
      clientAddr: "127.0.0.1",
      usename: "nautilo",
      applicationName: `neon-client-${i}`,
      state: "idle" as const,
      count: 1,
    }));
    expect(countUnexpectedLiveSessions(groups)).toBe(UNEXPECTED_SESSION_CEILING + 5);
    const verdict = evaluatePoolLifecycleVerdict({
      before: baseSnapshot(),
      after: baseSnapshot({ activityGroups: groups }),
      burst: okBurst(),
      sequentialCount: POOL_LIFECYCLE_SEQUENTIAL_COUNT,
    });
    expect(verdict.flags.some((f) => f.code === "unexpected-sessions-over-ceiling")).toBe(true);
  });

  test("excludes the checkpoint pool from unexpected session counts", () => {
    expect(
      countUnexpectedLiveSessions([
        {
          clientAddr: "127.0.0.1",
          usename: "nautilo",
          applicationName: "nautilo.checkpoint",
          state: "idle",
          count: 10,
        },
      ]),
    ).toBe(0);
  });

  test("flags material abandoned-session increase", () => {
    const before = baseSnapshot({
      database: { datname: "nautilo", sessions: 10, sessionsAbandoned: 0 },
    });
    const after = baseSnapshot({
      database: { datname: "nautilo", sessions: 12, sessionsAbandoned: 25 },
    });
    const verdict = evaluatePoolLifecycleVerdict({
      before,
      after,
      burst: okBurst(),
      sequentialCount: POOL_LIFECYCLE_SEQUENTIAL_COUNT,
    });
    expect(verdict.flags.some((f) => f.code === "material-abandoned-increase")).toBe(
      true,
    );
  });
});

describe("formatMetricsSnapshotLines / formatVerdictSummary", () => {
  test("snapshot lines omit secrets and show grouped rows", () => {
    const lines = formatMetricsSnapshotLines("before", baseSnapshot());
    const joined = lines.join("\n");
    expect(joined).toContain("BEFORE");
    expect(joined).toContain("sessions=12");
    expect(joined).toContain("nautilo.direct");
    expect(joined).not.toContain("postgresql://");
  });

  test("verdict summary shows PASS/FAIL without secrets", () => {
    const pass = formatVerdictSummary(
      { kind: "instance", name: "pool-qa" },
      {
        passed: true,
        flags: [],
        sessionsDelta: 2,
        sessionsAbandonedDelta: 0,
        unexpectedLiveSessions: 2,
      },
    );
    expect(pass.join("\n")).toContain("RESULT: PASS");
    expect(pass.join("\n")).toContain("instance=pool-qa");

    const fail = formatVerdictSummary(
      { kind: "instance", name: "pool-qa" },
      {
        passed: false,
        flags: [{ code: "failed-parallel-burst", detail: "1/50 failed" }],
        sessionsDelta: 0,
        sessionsAbandonedDelta: 0,
        unexpectedLiveSessions: 0,
      },
    );
    expect(fail.join("\n")).toContain("RESULT: FAIL");
    expect(fail.join("\n")).toContain("failed-parallel-burst");
  });
});

describe("directPostgresSelect1", () => {
  test("issues parameterized SELECT 1 via postgres.js", async () => {
    let seenValue: number | undefined;
    const query = async (value: number) => {
      seenValue = value;
      return [{ ok: 1 }];
    };

    await directPostgresSelect1({ query });

    expect(seenValue).toBe(1);
  });
});

describe("runVerifyPoolLifecycle — orchestration with fake deps", () => {
  test("splits the default 1,000 sequential and 50-parallel workload across both roles", async () => {
    const sequential: Array<[string, number]> = [];
    const parallel: Array<[string, number]> = [];
    const code = await runVerifyPoolLifecycle(
      { target: { kind: "instance", name: "pool-qa" } },
      {
        async collectMetrics() {
          return baseSnapshot();
        },
        async runSequentialSelect1(applicationRole, count) {
          sequential.push([applicationRole, count]);
        },
        async runParallelBurst(applicationRole, count) {
          parallel.push([applicationRole, count]);
          return { requested: count, succeeded: count, failed: 0 };
        },
      },
    );

    expect(code).toBe(0);
    expect(sequential).toEqual([
      ["nautilo", 500],
      ["nautilo_agent", 500],
    ]);
    expect(parallel).toEqual([
      ["nautilo", 25],
      ["nautilo_agent", 25],
    ]);
  });

  test("exit 0 on pass with before/after snapshots and load counts", async () => {
    const cap = captureLog();
    let metadataOpens = 0;
    let metadataCloses = 0;
    const sequential: Array<[string, number]> = [];
    const parallel: Array<[string, number]> = [];

    const reader: MetadataReader = {
      async queryRows(sql) {
        if (sql.includes("pg_stat_database")) {
          return [{ datname: "nautilo", sessions: 10, sessions_abandoned: 0 }];
        }
        return [
          {
            client_addr: "127.0.0.1",
            usename: "nautilo",
            application_name: "nautilo.direct",
            state: "idle",
            n: 2,
          },
        ];
      },
      async close() {
        metadataCloses++;
      },
    };

    const code = await runVerifyPoolLifecycle(
      {
        target: { kind: "instance", name: "pool-qa" },
        sequentialCount: 5,
        parallelCount: 3,
      },
      {
        log: cap.log,
        async collectMetrics() {
          metadataOpens++;
          try {
            const dbRows = await reader.queryRows("pg_stat_database");
            const activityRows = await reader.queryRows("pg_stat_activity");
            return {
              database: {
                datname: String(dbRows[0]?.["datname"] ?? "nautilo"),
                sessions: Number(dbRows[0]?.["sessions"] ?? 0),
                sessionsAbandoned: Number(dbRows[0]?.["sessions_abandoned"] ?? 0),
              },
              activityGroups: [
                {
                  clientAddr: String(activityRows[0]?.["client_addr"] ?? "local"),
                  usename: String(activityRows[0]?.["usename"] ?? ""),
                  applicationName: String(activityRows[0]?.["application_name"] ?? ""),
                  state: String(activityRows[0]?.["state"] ?? ""),
                  count: Number(activityRows[0]?.["n"] ?? 0),
                },
              ],
            };
          } finally {
            await reader.close();
            cap.log("[verify-pool-lifecycle] metadata handle closed");
          }
        },
        async runSequentialSelect1(applicationRole, count) {
          sequential.push([applicationRole, count]);
        },
        async runParallelBurst(applicationRole, count) {
          parallel.push([applicationRole, count]);
          return { requested: count, succeeded: count, failed: 0 };
        },
      },
    );

    expect(code).toBe(0);
    expect(sequential).toEqual([
      ["nautilo", 3],
      ["nautilo_agent", 2],
    ]);
    expect(parallel).toEqual([
      ["nautilo", 2],
      ["nautilo_agent", 1],
    ]);
    expect(metadataOpens).toBe(2);
    expect(metadataCloses).toBe(2);
    const out = cap.output();
    expect(out).toContain("BEFORE");
    expect(out).toContain("AFTER");
    expect(out).toContain("metadata handle closed");
    expect(out).toContain("RESULT: PASS");
    expect(out).toContain("nautilo=3, nautilo_agent=2");
    expect(out).toContain("nautilo=2, nautilo_agent=1");
    expect(out).not.toContain("postgresql://");
  });

  test("exit 1 when verdict fails", async () => {
    const cap = captureLog();
    const code = await runVerifyPoolLifecycle(
      {
        target: { kind: "instance", name: "pool-qa" },
        sequentialCount: 10,
        parallelCount: 2,
      },
      {
        log: cap.log,
        async collectMetrics() {
          return baseSnapshot({
            database: { datname: "nautilo", sessions: 1_000, sessionsAbandoned: 0 },
          });
        },
        async runSequentialSelect1() {},
        async runParallelBurst(_applicationRole, count) {
          return { requested: count, succeeded: 0, failed: count };
        },
      },
    );
    expect(code).toBe(1);
    expect(cap.output()).toContain("RESULT: FAIL");
    expect(cap.output()).toContain("failed-parallel-burst");
  });
});

describe("verifyPoolLifecycleCmd — command-facing target policy", () => {
  test("uses the target instance env for both application pools without mutating the caller", async () => {
    const {
      prepareInstanceVerificationEnv,
    } = await import("../../src/commands/verify-pool-lifecycle");
    const home = mkdtempSync(join(tmpdir(), "nautilo-pool-lifecycle-"));
    const root = join(home, ".nautilo-pool-qa");
    writeInstanceJson(root, {
      schemaVersion: 1,
      instanceId: "pool-qa",
      server: { host: "127.0.0.1", port: 7650, url: "http://127.0.0.1:7650" },
      workbench: { port: 7651, url: "http://127.0.0.1:7651" },
      db: {
        directConnection: "postgres://target-direct:pw@localhost:7652/nautilo",
        postgresHostPort: 7652,
      },
      logto: { dbPort: 7654, corePort: 7655, adminPort: 7656 },
      compose: { projectName: "nautilo-pool-qa" },
      hostname: {
        federated: "pool-qa.localtest.me",
        mdns: "pool-qa.local",
        tlsSan: "pool-qa.localtest.me",
        caddyAuthHost: "auth.pool-qa.localtest.me",
        caddyAuthAdminHost: "auth-admin.pool-qa.localtest.me",
      },
      deploymentMode: "dev-multi-instance",
    });
    writeFileSync(
      join(root, "instance.env"),
      [
        "DB_CONNECTION_STRING=postgres://target-full:pw@db.localtest.me:7652/nautilo",
        "DB_AGENT_CONNECTION_STRING=postgres://target-agent:pw@db.localtest.me:7652/nautilo",
        "DB_DIRECT_CONNECTION=postgres://target-direct:pw@localhost:7652/nautilo",
      ].join("\n"),
      "utf8",
    );
    const baseEnv: NodeJS.ProcessEnv = {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      NAUTILO_INSTANCE_ID: "stale-instance",
      DB_CONNECTION_STRING: "postgres://stale:stale@db.localtest.me:6432/nautilo",
      DB_DIRECT_CONNECTION: "postgresql://stale:stale@localhost:6432/nautilo",
      DB_AGENT_CONNECTION_STRING: "postgres://agent:stale@db.localtest.me:6432/nautilo",
      DB_AGENT_DIRECT_CONNECTION: "postgresql://agent:stale@localhost:6432/nautilo",
    };
    const originalProcessEnv = Object.fromEntries(
      [
        "NAUTILO_INSTANCE_ID",
        "DB_CONNECTION_STRING",
        "DB_DIRECT_CONNECTION",
        "DB_AGENT_CONNECTION_STRING",
        "DB_AGENT_DIRECT_CONNECTION",
      ].map((key) => [key, process.env[key]]),
    );

    try {
      const targetEnv = prepareInstanceVerificationEnv(baseEnv, "pool-qa");
      expect(baseEnv["NAUTILO_INSTANCE_ID"]).toBe("stale-instance");
      expect(targetEnv["NAUTILO_INSTANCE_ID"]).toBe("pool-qa");
      expect(baseEnv["DB_CONNECTION_STRING"]).toContain(":6432/");
      expect(baseEnv["DB_DIRECT_CONNECTION"]).toContain(":6432/");
      expect(targetEnv["DB_CONNECTION_STRING"]).toContain("target-full");
      expect(targetEnv["DB_DIRECT_CONNECTION"]).toContain("target-direct");
      expect(targetEnv["DB_AGENT_CONNECTION_STRING"]).toContain("target-agent");
      expect(targetEnv["DB_AGENT_DIRECT_CONNECTION"]).toBeUndefined();
      expect(resolveDirectDatabaseConnectionString(targetEnv)).toContain("target-direct");
      expect(resolveAppDatabaseConnectionString(targetEnv)).toContain("target-full");
      expect(resolveAgentDatabaseConnectionString(targetEnv)).toContain("target-agent");
      for (const [key, value] of Object.entries(originalProcessEnv)) {
        expect(process.env[key]).toBe(value);
      }
    } finally {
      __resetResolvedInstanceForTests();
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("rejects absent target files without creating state or exposing ambient URLs", async () => {
    const { prepareInstanceVerificationEnv } = await import(
      "../../src/commands/verify-pool-lifecycle"
    );
    const home = mkdtempSync(join(tmpdir(), "nautilo-pool-lifecycle-missing-"));
    const root = join(home, ".nautilo-missing-qa");
    const baseEnv: NodeJS.ProcessEnv = {
      HOME: home,
      USERPROFILE: home,
      DB_CONNECTION_STRING: "postgres://ambient:secret@db.localtest.me:6432/nautilo",
    };

    try {
      let failure: unknown;
      try {
        prepareInstanceVerificationEnv(baseEnv, "missing-qa");
      } catch (err) {
        failure = err;
      }
      expect(failure).toBeInstanceOf(Error);
      expect((failure as Error).message).toContain("instance.json");
      expect((failure as Error).message).toContain("instance.env");
      expect((failure as Error).message).not.toContain("postgres://ambient");
      expect(existsSync(root)).toBe(false);
      expect(baseEnv["NAUTILO_INSTANCE_ID"]).toBeUndefined();
      expect(baseEnv["DB_CONNECTION_STRING"]).toContain("ambient:secret");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("--help advertises only a non-default local instance", async () => {
    const { verifyPoolLifecycleCmd } = await import(
      "../../src/commands/verify-pool-lifecycle"
    );
    const lines: string[] = [];
    const orig = console.log;
    console.log = (msg: string) => {
      lines.push(msg);
    };
    try {
      const code = await verifyPoolLifecycleCmd(["--help"]);
      expect(code).toBe(0);
      const help = lines.join("\n");
      expect(help).toContain("verify-pool-lifecycle --instance <non-default-name>");
      expect(help).toContain("Remote --profile QA is a manual SSH-host workflow");
      expect(help).not.toContain("verify-pool-lifecycle --profile");
      expect(help).not.toContain("unless --profile");
    } finally {
      console.log = orig;
    }
  });

  test("--profile refuses local execution", async () => {
    const { verifyPoolLifecycleCmd } = await import(
      "../../src/commands/verify-pool-lifecycle"
    );
    const errLines: string[] = [];
    const orig = console.error;
    console.error = (msg: string) => {
      errLines.push(msg);
    };
    try {
      const code = await verifyPoolLifecycleCmd(["--profile", "omega-qa"]);
      expect(code).toBe(2);
      expect(errLines.join("\n")).toContain("Refusing --profile");
    } finally {
      console.error = orig;
    }
  });
});
