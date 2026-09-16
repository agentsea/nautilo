/**
 * M210 Phase 6 — read-only pool lifecycle verification (pure runner).
 *
 * Collects before/after pg_stat snapshots, exercises direct postgres.js wire
 * connections with parameterized `SELECT 1`, and emits a concise pass/fail
 * summary. Never logs connection strings, auth headers, or raw errors that
 * may embed secrets.
 */

const DEFAULT_TARGET_ALIASES = new Set(["default", "(default)"]);

export const POOL_LIFECYCLE_SEQUENTIAL_COUNT = 1_000;
export const POOL_LIFECYCLE_PARALLEL_COUNT = 50;
export const POOL_LIFECYCLE_APPLICATION_ROLES = ["nautilo", "nautilo_agent"] as const;
export const UNEXPECTED_SESSION_CEILING = 20;
/** Sessions outside known direct pool application names while warming up. */
export const SESSION_WARM_UP_ALLOWANCE = 10;
const MATERIAL_ABANDONED_DELTA_THRESHOLD = 10;

/** Known long-lived direct pool application names (not proxy-originated). */
const DIRECT_POOL_APPLICATION_NAMES = new Set([
  "nautilo.direct",
  "nautilo.agent-direct",
  "nautilo.checkpoint",
  "nautilo.pool-lifecycle-verify",
]);

export const SQL_STAT_DATABASE = `SELECT datname, sessions, sessions_abandoned
FROM pg_stat_database WHERE datname = 'nautilo'`;

export const SQL_STAT_ACTIVITY_GROUPED = `SELECT COALESCE(client_addr::text, 'local') AS client_addr,
       usename, application_name, state, count(*) AS n
FROM pg_stat_activity WHERE datname = 'nautilo'
GROUP BY 1, 2, 3, 4 ORDER BY n DESC`;

export interface PoolStatDatabaseRow {
  datname: string;
  sessions: number;
  sessionsAbandoned: number;
}

export interface PoolActivityGroupRow {
  clientAddr: string;
  usename: string;
  applicationName: string;
  state: string;
  count: number;
}

export interface PoolMetricsSnapshot {
  database: PoolStatDatabaseRow;
  activityGroups: PoolActivityGroupRow[];
}

export interface BurstLoadResult {
  requested: number;
  succeeded: number;
  failed: number;
}

export type PoolLifecycleApplicationRole =
  (typeof POOL_LIFECYCLE_APPLICATION_ROLES)[number];

export interface PoolLifecycleWorkload {
  sequential: Record<PoolLifecycleApplicationRole, number>;
  parallel: Record<PoolLifecycleApplicationRole, number>;
}

export interface PoolLifecycleFlag {
  code:
    | "severe-session-growth"
    | "failed-parallel-burst"
    | "idle-in-transaction"
    | "unexpected-sessions-over-ceiling"
    | "material-abandoned-increase";
  detail: string;
}

export interface PoolLifecycleVerdict {
  passed: boolean;
  flags: PoolLifecycleFlag[];
  sessionsDelta: number;
  sessionsAbandonedDelta: number;
  unexpectedLiveSessions: number;
}

export type PoolLifecycleTargetKind = "instance" | "profile";

export interface PoolLifecycleTarget {
  kind: PoolLifecycleTargetKind;
  name: string;
}

export interface MetadataReader {
  queryRows(sql: string): Promise<Record<string, string | number | null>[]>;
  close(): Promise<void>;
}

export interface VerifyPoolLifecycleArgs {
  target: PoolLifecycleTarget;
  sequentialCount?: number;
  parallelCount?: number;
}

export interface VerifyPoolLifecycleDeps {
  collectMetrics: () => Promise<PoolMetricsSnapshot>;
  runSequentialSelect1: (
    applicationRole: PoolLifecycleApplicationRole,
    count: number,
  ) => Promise<void>;
  runParallelBurst: (
    applicationRole: PoolLifecycleApplicationRole,
    count: number,
  ) => Promise<BurstLoadResult>;
  log?: (msg: string) => void;
  logClose?: (msg: string) => void;
}

const SECRET_PATTERNS: RegExp[] = [
  /postgresql:\/\/\S+/gi,
  /postgres:\/\/\S+/gi,
  /Neon-Connection-String/gi,
  /password=\S+/gi,
];

/** Strip connection material from operator-facing error text. */
export function sanitizePoolLifecycleError(err: unknown): string {
  const raw =
    err instanceof Error
      ? err.message
      : typeof err === "string"
        ? err
        : "operation failed";
  let msg = raw;
  for (const pattern of SECRET_PATTERNS) {
    msg = msg.replace(pattern, "[redacted]");
  }
  return msg.trim() || "operation failed";
}

function isNonDefaultTargetName(name: string): boolean {
  const trimmed = name.trim();
  if (trimmed === "") return false;
  return !DEFAULT_TARGET_ALIASES.has(trimmed.toLowerCase());
}

export function parsePoolLifecycleTarget(input: {
  explicitInstance?: string | undefined;
  profileFromArgs?: string | undefined;
}): { ok: true; target: PoolLifecycleTarget } | { ok: false; exitCode: number; message: string } {
  const profile = input.profileFromArgs?.trim();
  const instance = input.explicitInstance?.trim();

  if (profile !== undefined && profile !== "" && instance !== undefined && instance !== "") {
    return {
      ok: false,
      exitCode: 2,
      message:
        "Pass only one of --instance <name> or --profile <name>.\n\nRun `bun run dev:verify-pool-lifecycle --help` for usage.",
    };
  }

  if (profile !== undefined && profile !== "") {
    if (!isNonDefaultTargetName(profile)) {
      return {
        ok: false,
        exitCode: 2,
        message:
          "Refusing default or empty --profile. Use an explicit non-default profile name.\n\nRun `bun run dev:verify-pool-lifecycle --help` for usage.",
      };
    }
    return { ok: true, target: { kind: "profile", name: profile } };
  }

  if (instance !== undefined && instance !== "") {
    if (!isNonDefaultTargetName(instance)) {
      return {
        ok: false,
        exitCode: 2,
        message:
          "Refusing default or empty --instance. Use an explicit non-default instance name.\n\nRun `bun run dev:verify-pool-lifecycle --help` for usage.",
      };
    }
    return { ok: true, target: { kind: "instance", name: instance } };
  }

  return {
    ok: false,
    exitCode: 2,
    message:
      "--instance <name> or --profile <name> is REQUIRED (non-default).\n\nRun `bun run dev:verify-pool-lifecycle --help` for usage.",
  };
}

export function parseVerifyPoolLifecycleArgs(
  argv: string[],
  opts?: { explicitInstance?: string | undefined },
): ReturnType<typeof parsePoolLifecycleTarget> {
  let profile: string | undefined;
  let instance = opts?.explicitInstance;

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--profile") {
      i++;
      const v = argv[i];
      if (v === undefined) {
        return { ok: false, exitCode: 2, message: "--profile requires a value" };
      }
      profile = v.trim();
    } else if (a === "--instance") {
      i++;
      const v = argv[i];
      if (v === undefined) {
        return { ok: false, exitCode: 2, message: "--instance requires a value" };
      }
      instance = v.trim();
    } else if (a === "--help" || a === "-h") {
      continue;
    } else if (a !== undefined && a.startsWith("-")) {
      return {
        ok: false,
        exitCode: 2,
        message: `Unknown flag: ${a}\n\nRun \`bun run dev:verify-pool-lifecycle --help\` for usage.`,
      };
    }
  }

  return parsePoolLifecycleTarget({ explicitInstance: instance, profileFromArgs: profile });
}

function mapDatabaseRow(
  rows: Record<string, string | number | null>[],
): PoolStatDatabaseRow {
  const row = rows[0];
  if (!row) {
    throw new Error("pg_stat_database row missing for datname=nautilo");
  }
  return {
    datname: String(row["datname"] ?? "nautilo"),
    sessions: Number(row["sessions"] ?? 0),
    sessionsAbandoned: Number(row["sessions_abandoned"] ?? 0),
  };
}

function mapActivityRows(
  rows: Record<string, string | number | null>[],
): PoolActivityGroupRow[] {
  return rows.map((row) => ({
    clientAddr: String(row["client_addr"] ?? "local"),
    usename: String(row["usename"] ?? ""),
    applicationName: String(row["application_name"] ?? ""),
    state: String(row["state"] ?? ""),
    count: Number(row["n"] ?? 0),
  }));
}

export function countUnexpectedLiveSessions(groups: PoolActivityGroupRow[]): number {
  let total = 0;
  for (const g of groups) {
    if (g.state !== "active" && g.state !== "idle") continue;
    if (DIRECT_POOL_APPLICATION_NAMES.has(g.applicationName)) continue;
    total += g.count;
  }
  return total;
}

export function hasIdleInTransaction(groups: PoolActivityGroupRow[]): boolean {
  return groups.some((g) => g.state === "idle in transaction" && g.count > 0);
}

export function evaluatePoolLifecycleVerdict(input: {
  before: PoolMetricsSnapshot;
  after: PoolMetricsSnapshot;
  burst: BurstLoadResult;
  sequentialCount: number;
}): PoolLifecycleVerdict {
  const sessionsDelta = input.after.database.sessions - input.before.database.sessions;
  const sessionsAbandonedDelta =
    input.after.database.sessionsAbandoned - input.before.database.sessionsAbandoned;
  const unexpectedLiveSessions = countUnexpectedLiveSessions(input.after.activityGroups);
  const flags: PoolLifecycleFlag[] = [];

  if (sessionsDelta > SESSION_WARM_UP_ALLOWANCE) {
    flags.push({
      code: "severe-session-growth",
      detail: `sessions delta ${sessionsDelta} exceeds warm-up allowance ${SESSION_WARM_UP_ALLOWANCE}`,
    });
  }

  if (input.burst.failed > 0) {
    flags.push({
      code: "failed-parallel-burst",
      detail: `${input.burst.failed}/${input.burst.requested} parallel SELECT 1 failed`,
    });
  }

  if (hasIdleInTransaction(input.after.activityGroups)) {
    flags.push({
      code: "idle-in-transaction",
      detail: "pg_stat_activity shows idle in transaction rows for datname=nautilo",
    });
  }

  if (unexpectedLiveSessions > UNEXPECTED_SESSION_CEILING) {
    flags.push({
      code: "unexpected-sessions-over-ceiling",
      detail: `unexpected live sessions ${unexpectedLiveSessions} (ceiling ${UNEXPECTED_SESSION_CEILING})`,
    });
  }

  if (sessionsAbandonedDelta >= MATERIAL_ABANDONED_DELTA_THRESHOLD) {
    flags.push({
      code: "material-abandoned-increase",
      detail: `sessions_abandoned delta ${sessionsAbandonedDelta}`,
    });
  }

  return {
    passed: flags.length === 0,
    flags,
    sessionsDelta,
    sessionsAbandonedDelta,
    unexpectedLiveSessions,
  };
}

function formatMetricsPhaseLabel(phase: "before" | "after"): string {
  return phase === "before" ? "BEFORE" : "AFTER";
}

export function formatMetricsSnapshotLines(
  phase: "before" | "after",
  snapshot: PoolMetricsSnapshot,
): string[] {
  const lines: string[] = [];
  const label = formatMetricsPhaseLabel(phase);
  const db = snapshot.database;
  lines.push(
    `[${label}] pg_stat_database: sessions=${db.sessions} sessions_abandoned=${db.sessionsAbandoned}`,
  );
  if (snapshot.activityGroups.length === 0) {
    lines.push(`[${label}] pg_stat_activity: (no grouped rows)`);
    return lines;
  }
  lines.push(`[${label}] pg_stat_activity (grouped):`);
  for (const g of snapshot.activityGroups) {
    lines.push(
      `  ${g.clientAddr} | ${g.usename} | ${g.applicationName || "(none)"} | ${g.state} | n=${g.count}`,
    );
  }
  return lines;
}

export function formatVerdictSummary(
  target: PoolLifecycleTarget,
  verdict: PoolLifecycleVerdict,
  workload?: PoolLifecycleWorkload,
): string[] {
  const targetLabel = `${target.kind}=${target.name}`;
  const lines: string[] = [
    "",
    `=== verify-pool-lifecycle (${targetLabel}) ===`,
    `sessions Δ ${verdict.sessionsDelta}, sessions_abandoned Δ ${verdict.sessionsAbandonedDelta}, unexpected live ${verdict.unexpectedLiveSessions}`,
  ];
  if (workload) {
    lines.push(
      `workload: sequential nautilo=${workload.sequential.nautilo}, nautilo_agent=${workload.sequential.nautilo_agent}; parallel nautilo=${workload.parallel.nautilo}, nautilo_agent=${workload.parallel.nautilo_agent}`,
    );
  }
  if (verdict.passed) {
    lines.push("RESULT: PASS");
    return lines;
  }
  lines.push("RESULT: FAIL");
  for (const flag of verdict.flags) {
    lines.push(`  ✗ ${flag.code}: ${flag.detail}`);
  }
  return lines;
}

/** Issue one parameterized `SELECT 1` via direct postgres.js wire protocol. */
export async function directPostgresSelect1(input: {
  query: (value: number) => PromiseLike<unknown>;
}): Promise<void> {
  await input.query(1);
}

export async function collectMetricsViaReader(
  reader: MetadataReader,
): Promise<PoolMetricsSnapshot> {
  const dbRows = await reader.queryRows(SQL_STAT_DATABASE);
  const activityRows = await reader.queryRows(SQL_STAT_ACTIVITY_GROUPED);
  return {
    database: mapDatabaseRow(dbRows),
    activityGroups: mapActivityRows(activityRows),
  };
}

function splitWorkload(
  sequentialCount: number,
  parallelCount: number,
): PoolLifecycleWorkload {
  if (sequentialCount < POOL_LIFECYCLE_APPLICATION_ROLES.length) {
    throw new Error("sequential workload must include both application roles");
  }
  if (parallelCount < POOL_LIFECYCLE_APPLICATION_ROLES.length) {
    throw new Error("parallel workload must include both application roles");
  }

  const splitEvenly = (
    count: number,
  ): Record<PoolLifecycleApplicationRole, number> => {
    const nautilo = Math.ceil(count / POOL_LIFECYCLE_APPLICATION_ROLES.length);
    return { nautilo, nautilo_agent: count - nautilo };
  };

  return {
    sequential: splitEvenly(sequentialCount),
    parallel: splitEvenly(parallelCount),
  };
}

/**
 * Pure orchestrator. Returns exit code 0 on pass, 1 on fail, throws only when
 * deps fail before a verdict (caller maps to exit 2 with sanitized message).
 */
export async function runVerifyPoolLifecycle(
  args: VerifyPoolLifecycleArgs,
  deps: VerifyPoolLifecycleDeps,
): Promise<number> {
  const log = deps.log ?? (() => {});
  const sequentialCount = args.sequentialCount ?? POOL_LIFECYCLE_SEQUENTIAL_COUNT;
  const parallelCount = args.parallelCount ?? POOL_LIFECYCLE_PARALLEL_COUNT;
  const workload = splitWorkload(sequentialCount, parallelCount);
  const targetLabel = `${args.target.kind}=${args.target.name}`;

  log(`[verify-pool-lifecycle] target ${targetLabel}`);
  log(`[verify-pool-lifecycle] collecting BEFORE metrics`);

  const before = await deps.collectMetrics();
  for (const line of formatMetricsSnapshotLines("before", before)) {
    log(line);
  }

  log(
    `[verify-pool-lifecycle] load: ${sequentialCount} sequential SELECT 1 via direct postgres.js: nautilo=${workload.sequential.nautilo}, nautilo_agent=${workload.sequential.nautilo_agent}`,
  );
  for (const applicationRole of POOL_LIFECYCLE_APPLICATION_ROLES) {
    await deps.runSequentialSelect1(applicationRole, workload.sequential[applicationRole]);
  }

  log(
    `[verify-pool-lifecycle] load: ${parallelCount} parallel SELECT 1 burst via direct postgres.js: nautilo=${workload.parallel.nautilo}, nautilo_agent=${workload.parallel.nautilo_agent}`,
  );
  const bursts = await Promise.all(
    POOL_LIFECYCLE_APPLICATION_ROLES.map((applicationRole) =>
      deps.runParallelBurst(applicationRole, workload.parallel[applicationRole]),
    ),
  );
  const burst = bursts.reduce<BurstLoadResult>(
    (total, result) => ({
      requested: total.requested + result.requested,
      succeeded: total.succeeded + result.succeeded,
      failed: total.failed + result.failed,
    }),
    { requested: 0, succeeded: 0, failed: 0 },
  );

  log(`[verify-pool-lifecycle] collecting AFTER metrics`);
  const after = await deps.collectMetrics();
  for (const line of formatMetricsSnapshotLines("after", after)) {
    log(line);
  }

  const verdict = evaluatePoolLifecycleVerdict({
    before,
    after,
    burst,
    sequentialCount,
  });

  for (const line of formatVerdictSummary(args.target, verdict, workload)) {
    log(line);
  }

  return verdict.passed ? 0 : 1;
}
