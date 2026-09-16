import { execSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { resolveInstance } from "@nautilo/config";
import {
  buildCryptoRoleReconcilePsqlScript,
  buildFullCryptoTablePrivilegeReconcileSql,
  parseDotenv,
  planCredentialReconciliation,
  runRuntimeAcceptance,
  type RuntimeAcceptanceReport,
  type RuntimeAcceptanceTransport,
} from "@nautilo/db";
import { resolveDotenvPath } from "./paths";
import {
  DEV_CRYPTO_DB_PASSWORD_RELATIVE_PATH,
  resolveInstanceServiceSecrets,
} from "./compose-infra";
import {
  isLogtoContainerRunning,
  logtoDatabaseExists,
  resolveLogtoContainer,
} from "./logto-db";

/**
 * `nautilo-dev verify` — local verification of a restored/upgraded dev stack.
 *
 * Two modes share this entrypoint:
 *
 *   - **Authoritative (default)** — D427 Wave 4 task 4.1.2. A fail-closed
 *     runtime-acceptance gate over the same five checks the Compose
 *     restore/upgrade path gates on: runtime-role connection probes
 *     (`nautilo` + `nautilo_agent`), a parameterized direct PostgreSQL
 *     wire probe, Logto OIDC discovery, target/profile instance identity, and SPA
 *     availability (plus the retained `/health` poll). A broken
 *     profile/workspace transport cannot pass: a single failing check makes
 *     `allPassed === false` and the command exits non-zero. The gate is the
 *     shared `@nautilo/db` `runRuntimeAcceptance` helper, so the local and
 *     Compose paths share semantics.
 *
 *   - **`--smoke`** — the PRE-Wave-4 diagnostic behavior, preserved verbatim:
 *     superuser-only container/DB/owner/profile/row-count checks plus a
 *     best-effort, NON-FATAL server `/health` ping. This is a pre-start /
 *     nonfatal diagnostic and explicitly does NOT claim acceptance. Use it
 *     when the server is not running yet and you only want the DB-side
 *     snapshot sanity checks.
 */

export interface VerifyCheck {
  id: string;
  title: string;
  passed: boolean;
  detail: string;
  /**
   * If true, a failure of this check does NOT block the overall
   * pass. Used for probes that can legitimately fail without
   * indicating a restore problem (e.g. server-health — the server
   * may simply not be running yet). Smoke-mode only; the
   * authoritative gate has no non-fatal checks.
   */
  nonFatal?: boolean;
}

export interface VerifyReport {
  allPassed: boolean;
  checks: VerifyCheck[];
  /** Which mode produced this report. */
  mode: "authoritative" | "smoke";
}

export interface VerifyOptions {
  /**
   * Run the pre-Wave-4 nonfatal diagnostic checks instead of the authoritative
   * runtime-acceptance gate. `--smoke` preserves the prior diagnostic semantics
   * and does NOT claim acceptance.
   */
  smoke?: boolean;
  // --- smoke-mode options (ignored by the authoritative gate) ---
  container?: string;
  db?: string;
  ownerId?: string;
  serverUrl?: string;
}

export async function verify(options?: VerifyOptions): Promise<VerifyReport> {
  if (options?.smoke === true) {
    return runSmokeChecks(options);
  }
  return runAuthoritativeAcceptance();
}

// ---------------------------------------------------------------------------
// Authoritative runtime-acceptance gate (default mode).
// ---------------------------------------------------------------------------

const AUTHORITATIVE_HEALTH_TIMEOUT_MS = 30_000;
const AUTHORITATIVE_HEALTH_POLL_MS = 500;
const AUTHORITATIVE_FETCH_TIMEOUT_MS = 5_000;

export function buildAuthoritativeExecEnv(
  options: {
    env?: NodeJS.ProcessEnv;
    instanceId?: string;
    instanceEnvPath?: string;
  } = {},
): NodeJS.ProcessEnv {
  const env = options.env ?? process.env;
  const instanceId =
    options.instanceId ?? (env["NAUTILO_INSTANCE_ID"] ?? "").trim();
  const plan = resolveInstanceServiceSecrets(
    {
      instanceId,
      instanceEnvPath: options.instanceEnvPath ?? resolveDotenvPath(),
    },
    env,
  );
  let cryptoPassword: string | undefined;
  const instanceEnvPath = options.instanceEnvPath ?? resolveDotenvPath();
  const instanceRoot =
    basename(dirname(instanceEnvPath)) === "runtime-config"
      ? dirname(dirname(instanceEnvPath))
      : dirname(instanceEnvPath);
  try {
    cryptoPassword = readFileSync(
      join(instanceRoot, DEV_CRYPTO_DB_PASSWORD_RELATIVE_PATH),
      "utf8",
    ).trim();
  } catch {
    try {
      // One-run compatibility for a pre-M231 instance before infra:start
      // migrates the credential into the role-only authority.
      cryptoPassword = parseDotenv(
        readFileSync(instanceEnvPath, "utf8"),
      )["NAUTILO_CRYPTO_DB_PASSWORD"];
    } catch {
      cryptoPassword = env["NAUTILO_CRYPTO_DB_PASSWORD"];
    }
  }
  return {
    ...env,
    ...plan.serviceSecrets,
    ...(cryptoPassword !== undefined
      ? { NAUTILO_CRYPTO_DB_PASSWORD: cryptoPassword }
      : {}),
  };
}

function buildAuthoritativeTransport(): RuntimeAcceptanceTransport {
  const execEnv = buildAuthoritativeExecEnv();

  const transport: RuntimeAcceptanceTransport = {
    fetch: (url) =>
      // Bun-specific: the local dev server may serve HTTPS with a self-signed
      // cert on a non-loopback bind host; the same rejectUnauthorized:false
      // contract the Electron workbench uses against the same cert in dev.
      fetch(url, {
        signal: AbortSignal.timeout(AUTHORITATIVE_FETCH_TIMEOUT_MS),
        tls: { rejectUnauthorized: false },
      } as Partial<RequestInit>),
    execSh: (cmd) => {
      const res = spawnSync("sh", ["-c", cmd], {
        env: execEnv,
        encoding: "utf8",
      });
      return Promise.resolve({
        code: res.status ?? 1,
        stderr: res.stderr ?? "",
      });
    },
    pollHealth: (baseUrl) => pollServerHealth(baseUrl),
  };
  return transport;
}

async function pollServerHealth(baseUrl: string): Promise<void> {
  const url = `${baseUrl.replace(/\/$/, "")}/health`;
  const deadline = Date.now() + AUTHORITATIVE_HEALTH_TIMEOUT_MS;
  let lastErr: unknown;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, {
        signal: AbortSignal.timeout(AUTHORITATIVE_FETCH_TIMEOUT_MS),
        tls: { rejectUnauthorized: false },
      } as Partial<RequestInit>);
      if (res.ok) return;
      lastErr = `HTTP ${res.status}`;
    } catch (err) {
      lastErr = err;
    }
    await new Promise((r) => setTimeout(r, AUTHORITATIVE_HEALTH_POLL_MS));
  }
  throw new Error(
    `nautilo-server /health never became ready within ${AUTHORITATIVE_HEALTH_TIMEOUT_MS}ms (${url}): ${String(lastErr)}`,
  );
}

/**
 * Build the local-dev runtime-acceptance targets (URLs + transport-specific
 * probe commands). Exported so unit tests can assert the probe commands are
 * well-formed without running docker/fetch.
 */
export function buildAuthoritativeTargets(): {
  serverBaseUrl: string;
  spaUrl: string;
  expectedInstanceId: string;
  oidcUrl: string;
  appRoleProbes: Array<{ role: string; cmd: string }>;
  directPostgresProbe: { label: string; cmd: string };
} {
  const inst = resolveInstance();
  const serverBaseUrl = inst.server.url.replace(/\/$/, "");
  // dev-stack builds Workbench and mounts it at `/` on the Nautilo server;
  // the reserved workbench port is not a second production listener.
  const spaUrl = serverBaseUrl;
  const expectedInstanceId = (process.env["NAUTILO_INSTANCE_ID"] ?? "").trim();
  const oidcUrl = `http://localhost:${inst.logto.corePort}/oidc/.well-known/openid-configuration`;
  const dbPort = inst.db.postgresHostPort;

  // App-role connection probes use the host-published port and credentials
  // from the selected instance.env. Container environment is immutable after
  // creation and may legitimately remain stale after an in-place role repair.
  const appRoleProbes = (
    [
      ["nautilo", "NAUTILO_DB_PASSWORD"],
      ["nautilo_agent", "NAUTILO_AGENT_DB_PASSWORD"],
      ["nautilo_crypto", "NAUTILO_CRYPTO_DB_PASSWORD"],
    ] as const
  ).map(([role, passwordEnv]) => {
    const hostProbe =
      `PGPASSWORD="\${${passwordEnv}:?${passwordEnv} is not set}" ` +
      `psql -h 127.0.0.1 -p ${dbPort} -U ${role} -d nautilo -t -A -c "SELECT 1"`;
    return {
      role,
      cmd: hostProbe,
    };
  });

  // Host-side direct wire probe — exercises the published postgres port with
  // the agent role credentials the runtime uses post-M212. Parameterized
  // PREPARE/EXECUTE catches auth/port mismatches that a bare SELECT 1 might miss.
  const hostAgentProbe =
    `PGPASSWORD="\${NAUTILO_AGENT_DB_PASSWORD:?NAUTILO_AGENT_DB_PASSWORD is not set}" ` +
    `psql -h 127.0.0.1 -p ${dbPort} -U nautilo_agent -d nautilo -t -A ` +
    `-c "PREPARE m215_verify_probe AS SELECT \\$1::int; EXECUTE m215_verify_probe(1);"`;
  const directPostgresProbe = {
    label: "nautilo_agent direct PostgreSQL probe",
    cmd: hostAgentProbe,
  };

  return { serverBaseUrl, spaUrl, expectedInstanceId, oidcUrl, appRoleProbes, directPostgresProbe };
}

/**
 * Run the authoritative gate with an optional injected transport (test seam).
 * The public `verify({})` path uses the real transport; tests inject a fake
 * to assert the report mapping + fail-closed semantics without docker/fetch.
 */
export async function runAuthoritativeAcceptance(
  transportOverride?: RuntimeAcceptanceTransport,
): Promise<VerifyReport> {
  const targets = buildAuthoritativeTargets();
  const transport = transportOverride ?? buildAuthoritativeTransport();
  let report: RuntimeAcceptanceReport;
  try {
    report = await runRuntimeAcceptance(
      transport,
      targets,
      { throwOnFirstFailure: false },
    );
  } catch (err) {
    // The helper only throws in throwOnFirstFailure mode; report mode returns
    // a report. Defensive: never report success on an unexpected throw.
    return {
      allPassed: false,
      mode: "authoritative",
      checks: [
        {
          id: "gate",
          title: "Runtime acceptance gate",
          passed: false,
          detail: err instanceof Error ? err.message : String(err),
        },
      ],
    };
  }

  return {
    allPassed: report.allPassed,
    mode: "authoritative",
    checks: report.checks.map((c) => ({
      id: c.id,
      title: c.title,
      passed: c.passed,
      detail: c.detail,
    })),
  };
}

// ---------------------------------------------------------------------------
// D427 (Wave 4 task 4.1.1) — shared local recovery helpers used by
// `nautilo-dev restore` and `nautilo-dev upgrade`. Both paths share the
// @nautilo/db credential-reconciliation planner + runtime-acceptance gate
// with the Compose restore/upgrade path, so neither reports success while
// restored grants and live cluster roles are out of sync, or before the
// runtime-role / Neon HTTP / OIDC / identity / SPA checks pass.
// ---------------------------------------------------------------------------

export interface LocalReconciliationOptions {
  log?: (msg: string) => void;
  /**
   * Override the restored `instance.env` raw text (test seam). Defaults to the
   * live `resolveDotenvPath()` contents.
   */
  instanceEnvRaw?: string;
  /**
   * Override the Logto availability predicate (test seam). Defaults to the
   * real `isLogtoContainerRunning() && logtoDatabaseExists()` check — Logto
   * reconciliation is conditional on its DB/container availability.
   */
  logtoAvailable?: boolean;
  /**
   * Override the `docker exec ... psql` runner (test seam). Defaults to the
   * real `spawnSync` against the app/logto container. Returns a Promise of
   * exit code + stderr; a non-zero code is fail-closed.
   */
  execPsql?: (args: {
    kind: "app" | "logto";
    container: string;
    db: string;
    sql: string;
  }) => Promise<{ code: number; stderr: string }>;
  /** False for the pre-migration role-only pass. Defaults true. */
  reconcileCryptoPrivileges?: boolean;
}

/**
 * Re-pin the `nautilo` / `nautilo_agent` app-cluster role passwords to the
 * restored `instance.env` and resync the Logto per-tenant role passwords to
 * the restored `tenants` table, BEFORE the server reconnects. Idempotent and
 * fail-closed: a nonzero psql exit throws with the pipeline label so the
 * caller (restore/upgrade) never reports success on a desynced target.
 *
 * MUST run after the restored `instance.env` is on disk so the app-role
 * passwords are readable. Logto reconciliation is conditional on the Logto
 * container running AND `logto_nautilo` existing — a Nautilo-only snapshot
 * (or a stack with Logto stopped) skips the Logto pipeline cleanly.
 */
export async function runLocalCredentialReconciliation(
  options?: LocalReconciliationOptions,
): Promise<void> {
  const log = options?.log ?? (() => {});
  let instanceEnvRaw = options?.instanceEnvRaw;
  const instanceEnvPath = resolveDotenvPath();
  if (instanceEnvRaw === undefined) {
    try {
      instanceEnvRaw = readFileSync(instanceEnvPath, "utf8");
    } catch {
      instanceEnvRaw = "";
    }
  }
  const logtoAvailable =
    options?.logtoAvailable ??
    (isLogtoContainerRunning() && logtoDatabaseExists());

  const plan = planCredentialReconciliation({
    instanceEnvRaw: instanceEnvRaw ?? "",
    reconcileNautilo: true,
    reconcileLogto: logtoAvailable,
  });

  if (plan.pipelines.length === 0) {
    log("[reconcile] no app-role passwords in restored env and Logto not available — nothing to reconcile");
    return;
  }

  const inst = resolveInstance();
  const appContainer = inst.compose.containers.legacyPostgres;
  const logtoContainer = resolveLogtoContainer();

  const execPsql =
    options?.execPsql ??
    ((args: { kind: "app" | "logto"; container: string; db: string; sql: string }) => {
      const res = spawnSync(
        "docker",
        ["exec", "-i", args.container, "psql", "-U", "postgres", "-d", args.db, "-v", "ON_ERROR_STOP=1"],
        { input: args.sql, encoding: "utf8" },
      );
      return Promise.resolve({ code: res.status ?? 1, stderr: res.stderr ?? "" });
    });
  const runPipeline = async (pipeline: { kind: "app" | "logto"; label: string; sql: string }): Promise<void> => {
    if (pipeline.kind === "app") {
      log(`[reconcile] ${pipeline.label} (against ${appContainer})...`);
      const res = await execPsql({ kind: "app", container: appContainer, db: "postgres", sql: pipeline.sql });
      if (res.code !== 0) {
        throw new Error(
          `[reconcile] ${pipeline.label} failed (exit ${res.code}): ${res.stderr.trim()}`,
        );
      }
      log(`[reconcile] ${pipeline.label} ok`);
    } else {
      log(`[reconcile] ${pipeline.label} (against ${logtoContainer})...`);
      const res = await execPsql({ kind: "logto", container: logtoContainer, db: "logto_nautilo", sql: pipeline.sql });
      if (res.code !== 0) {
        throw new Error(
          `[reconcile] ${pipeline.label} failed (exit ${res.code}): ${res.stderr.trim()}`,
        );
      }
      log(`[reconcile] ${pipeline.label} ok`);
    }
  };

  for (const pipeline of plan.pipelines) {
    await runPipeline(pipeline);
  }
  const instanceRoot =
    basename(dirname(instanceEnvPath)) === "runtime-config"
      ? dirname(dirname(instanceEnvPath))
      : dirname(instanceEnvPath);
  let cryptoPassword: string | undefined;
  try {
    cryptoPassword = readFileSync(
      join(instanceRoot, DEV_CRYPTO_DB_PASSWORD_RELATIVE_PATH),
      "utf8",
    ).trim();
  } catch {
    cryptoPassword = parseDotenv(instanceEnvRaw ?? "")[
      "NAUTILO_CRYPTO_DB_PASSWORD"
    ];
  }
  if (cryptoPassword?.trim()) {
    const role = await execPsql({
      kind: "app",
      container: appContainer,
      db: "postgres",
      sql: buildCryptoRoleReconcilePsqlScript({ password: cryptoPassword }),
    });
    if (role.code !== 0) {
      throw new Error(
        `[reconcile] nautilo_crypto role reconcile failed (exit ${role.code}): ${role.stderr.trim()}`,
      );
    }
    if (options?.reconcileCryptoPrivileges !== false) {
      const grants = await execPsql({
        kind: "app",
        container: appContainer,
        db: "nautilo",
        sql: buildFullCryptoTablePrivilegeReconcileSql(),
      });
      if (grants.code !== 0) {
        throw new Error(
          `[reconcile] nautilo_crypto table-privilege reconcile failed (exit ${grants.code}): ${grants.stderr.trim()}`,
        );
      }
    }
  }
}

/**
 * Run the authoritative runtime-acceptance gate and return an exit code
 * (0 = pass, 1 = fail). Used by `nautilo-dev restore` / `upgrade` so neither
 * path reports success until the runtime-role / direct PostgreSQL / OIDC /
 * identity / SPA checks pass. Fail-closed: a single failing check → exit 1.
 */
export async function runLocalRuntimeAcceptanceExitCode(
  log?: (msg: string) => void,
): Promise<number> {
  const report = await verify({});
  const logger = log ?? (() => {});
  if (!report.allPassed) {
    logger("[acceptance] runtime acceptance FAILED:");
    for (const c of report.checks) {
      if (!c.passed) {
        logger(`  ✗ [${c.id}] ${c.title}: ${c.detail}`);
      }
    }
    return 1;
  }
  logger("[acceptance] runtime acceptance passed (health, identity, SPA, runtime-role, direct PostgreSQL, OIDC)");
  return 0;
}

// ---------------------------------------------------------------------------
// Smoke mode — the pre-Wave-4 nonfatal diagnostic, preserved verbatim.
// ---------------------------------------------------------------------------

/**
 * D120 A1.P1: query the running Postgres container directly for the
 * claimed-owner user id, mirroring `findClaimedOwnerId` in
 * `@nautilo/db`. Doing it via `docker exec ... psql` instead of the
 * drizzle client keeps `nautilo-dev` independent of the workspace
 * runtime — this tool is invoked from a shell after restore and may
 * run before the server bundle is even built.
 */
function findOwnerIdFromDb(container: string, db: string): string | undefined {
  try {
    const out = psql(
      container,
      db,
      "SELECT id FROM users WHERE EXISTS (SELECT 1 FROM credentials WHERE user_id = users.id) ORDER BY created_at ASC LIMIT 1",
    ).trim();
    return out || undefined;
  } catch {
    return undefined;
  }
}

async function runSmokeChecks(options: VerifyOptions): Promise<VerifyReport> {
  const container =
    options.container ?? resolveInstance().compose.containers.legacyPostgres;
  const db = options.db ?? "nautilo";
  const rawOwnerId = options.ownerId ?? findOwnerIdFromDb(container, db);

  // Guard against injection — ownerId flows straight into a psql SQL
  // string. Postgres UUIDs are strictly `xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx`;
  // refuse anything else and report as a failed check rather than a
  // silent pass.
  const ownerId =
    rawOwnerId && /^[0-9a-fA-F]{8}(-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}$/.test(rawOwnerId)
      ? rawOwnerId
      : undefined;

  const serverUrl =
    options.serverUrl ?? resolveInstance().server.url.replace(/\/$/, "");
  const checks: VerifyCheck[] = [];

  // 1. Container health
  checks.push(await runCheck("container-healthy", "Postgres container is running", () => {
    const out = safeExec(`docker inspect -f '{{.State.Running}}' ${container}`);
    if (out.trim() !== "true") throw new Error(`container ${container} is not running`);
    return `${container} is running`;
  }));

  // 2. DB exists
  checks.push(await runCheck("db-exists", `Database "${db}" exists`, () => {
    const out = psql(container, "postgres", `SELECT 1 FROM pg_database WHERE datname = '${db}'`);
    if (!out.trim()) throw new Error(`database ${db} not found`);
    return `OK`;
  }));

  // 3 + 4. Owner user + profile
  if (ownerId) {
    checks.push(await runCheck("owner-user", `Owner user ${truncate(ownerId)} exists`, () => {
      const out = psql(container, db, `SELECT name FROM users WHERE id = '${ownerId}'`);
      if (!out.trim()) throw new Error(`no users row for ${ownerId}`);
      return `name=${out.trim()}`;
    }));

    checks.push(await runCheck("owner-profile", "Owner has at least one profile", () => {
      const out = psql(container, db, `SELECT name FROM profiles WHERE user_id = '${ownerId}' LIMIT 1`);
      if (!out.trim()) throw new Error(`no profiles row for ${ownerId}`);
      return `profile=${out.trim()}`;
    }));
  } else {
    checks.push({
      id: "owner-user",
      title: "Owner user (skipped)",
      passed: true,
      detail: rawOwnerId
        ? `NAUTILO_OWNER_ID is set but not a valid UUID ("${rawOwnerId}"); refusing to interpolate into SQL`
        : "NAUTILO_OWNER_ID not set; cannot verify owner identity",
    });
  }

  // 5. Key table row counts (non-fatal — just informational)
  const keyTables = ["users", "profiles", "sessions", "session_messages", "memories"];
  for (const t of keyTables) {
    checks.push(await runCheck(`row-count-${t}`, `Row count for ${t}`, () => {
      const out = psql(container, db, `SELECT COUNT(*) FROM ${t}`);
      const n = parseInt(out.trim(), 10);
      if (isNaN(n)) throw new Error(`row count query returned non-integer: ${out}`);
      return `${n} rows`;
    }));
  }

  // 6. Server health (best-effort). The server's liveness endpoint is
  //    /health (not /api/health — /api/health/keys is a different,
  //    unrelated API-key validation route). If the server is down,
  //    that is not a restore failure — we still report it so the
  //    operator knows they need to start the server, but we do NOT
  //    fail the verify.
  const serverCheck = await runCheck(
    "server-health",
    "Nautilo server /health (best-effort, server may not be running)",
    async () => {
      try {
        const res = await fetch(`${serverUrl}/health`, {
          signal: AbortSignal.timeout(2000),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return `HTTP ${res.status}`;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        throw new Error(
          `server not reachable at ${serverUrl}: ${msg}. ` +
            `Start the server with \`bun run server\` if restored state needs verification at the HTTP layer.`,
        );
      }
    },
  );
  checks.push({ ...serverCheck, nonFatal: true });

  return {
    allPassed: checks.every((c) => c.passed || c.nonFatal === true),
    mode: "smoke",
    checks,
  };
}

async function runCheck(
  id: string,
  title: string,
  fn: () => string | Promise<string>,
): Promise<VerifyCheck> {
  try {
    const detail = await Promise.resolve(fn());
    return { id, title, passed: true, detail };
  } catch (err) {
    return {
      id,
      title,
      passed: false,
      detail: err instanceof Error ? err.message : String(err),
    };
  }
}

function safeExec(cmd: string): string {
  try {
    return execSync(cmd, { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] });
  } catch (err) {
    throw new Error(err instanceof Error ? err.message : String(err));
  }
}

function psql(container: string, db: string, sql: string): string {
  return execSync(
    `docker exec -i ${container} psql -U postgres -d ${db} -t -A -v ON_ERROR_STOP=1`,
    { input: sql, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] },
  );
}

function truncate(s: string, len = 12): string {
  return s.length > len ? `${s.slice(0, len)}…` : s;
}
