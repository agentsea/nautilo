import { execSync } from "node:child_process";
import { resolve, dirname } from "node:path";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import * as schema from "../schema/index";
import { resolveInstance, resolvedInstanceChildEnv } from "@nautilo/config";
import {
  resolveDirectDatabaseConnectionString,
  resolveAppDatabaseConnectionString,
} from "../config/direct-database";
import { resolveDirectAgentDatabaseConnectionString } from "../config/agent-database";
import { buildFullLegacyRoleRepairSql } from "./legacy-role-repair";
import { buildAgentRoleGrantsSql } from "./agent-role-grants";
import {
  RECOMMENDED_SCRATCH_INSTANCE,
  TEST_DB_AUTOHEAL_ENV,
} from "../testing/instance-guard";
import {
  assertConnectedDbMarkerMatches,
  assertDirectConnectionMatchesInstance,
  ensureConnectedDbIdentity,
  listDbConnectionOverrides,
} from "./db-identity-guard";

const DOCKER_COMPOSE_FILE = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../docker/docker-compose.yml"
);

const MIGRATIONS_FOLDER = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../migrations"
);

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function tryConnect(connectionString: string): Promise<boolean> {
  return new Promise((resolve) => {
    const sql = postgres(connectionString, {
      connect_timeout: 2,
      max: 1,
    });
    sql`SELECT 1`
      .then(() => {
        void sql.end().then(() => resolve(true));
      })
      .catch(() => {
        void sql.end({ timeout: 0 }).then(
          () => resolve(false),
          () => resolve(false)
        );
      });
  });
}

function isDockerAvailable(): boolean {
  try {
    execSync("docker info", { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function startContainer(env: NodeJS.ProcessEnv = process.env) {
  const inst = resolveInstance(env);
  execSync(`docker compose -f "${DOCKER_COMPOSE_FILE}" up -d`, {
    stdio: "ignore",
    env: { ...env, ...resolvedInstanceChildEnv(inst) },
  });
}

async function waitForPostgres(
  connectionString: string,
  maxAttempts: number,
  delayMs: number
): Promise<boolean> {
  for (let i = 0; i < maxAttempts; i++) {
    if (await tryConnect(connectionString)) return true;
    await sleep(delayMs);
  }
  return false;
}

export interface EnsureDatabaseResult {
  connectionString: string;
  containerStarted: boolean;
  migrationsRan: boolean;
}

async function applyRuntimeRoleContract(
  directConnection: string,
  print: (message: string) => void,
  mode: "host" | "container",
): Promise<void> {
  print("Applying runtime app/agent role ownership and grants...");
  const grantsConn = postgres(directConnection, { max: 1, onnotice: () => {} });
  try {
    await grantsConn.unsafe(runtimeRoleContractSql(mode));
  } finally {
    await grantsConn.end({ timeout: 5 });
  }
  print("Runtime role contract applied.");
}

function sqlStringLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

/** Keep disposable scratch roles aligned with the credentials this test process resolves. */
async function reconcileScratchRuntimeCredentials(
  directConnection: string,
  appConnection: string,
): Promise<void> {
  if (!shouldAutoHealScratchDb()) return;

  const appPassword = decodeURIComponent(new URL(appConnection).password);
  const agentPassword = decodeURIComponent(
    new URL(resolveDirectAgentDatabaseConnectionString()).password,
  );
  if (!appPassword || !agentPassword) {
    throw new Error("Scratch runtime-role credentials must not be empty");
  }

  const sql = postgres(directConnection, { onnotice: () => {} });
  try {
    await sql`SELECT pg_advisory_lock(hashtext('nautilo:test-runtime-role-credentials'))`;
    try {
      await sql.unsafe(`ALTER ROLE nautilo LOGIN PASSWORD ${sqlStringLiteral(appPassword)}`);
      await sql.unsafe(`ALTER ROLE nautilo_agent LOGIN PASSWORD ${sqlStringLiteral(agentPassword)}`);
    } finally {
      await sql`SELECT pg_advisory_unlock(hashtext('nautilo:test-runtime-role-credentials'))`;
    }
  } finally {
    await sql.end();
  }
}

/**
 * Host/dev connections may still target the postgres administrator and need
 * the legacy ownership repair. Container deployments already run that repair
 * through ComposeDriver as postgres before server start; their direct
 * connection is the least-privilege database owner and must only reconcile
 * its own agent grants/default privileges.
 */
export function runtimeRoleContractSql(mode: "host" | "container"): string {
  return mode === "container"
    ? buildAgentRoleGrantsSql()
    : buildFullLegacyRoleRepairSql();
}

/**
 * M114 container branch — when `NAUTILO_DB_BOOTSTRAP=container` we are
 * running inside the deploy-stack image: Postgres lives at `postgres:5432`
 * inside the compose network, there is no host Docker socket to manage,
 * and there is no Neon HTTP proxy. We just wait briefly for Postgres
 * (compose depends_on:service_healthy should make it instant), run
 * migrations, leave `DB_CONNECTION_STRING` as the caller provided, and
 * return. Host-dev behavior (unset env) is unchanged.
 */
async function ensureDatabaseContainer(
  print: (message: string) => void
): Promise<EnsureDatabaseResult> {
  const direct = process.env["DB_DIRECT_CONNECTION"];
  if (!direct) {
    throw new Error(
      "NAUTILO_DB_BOOTSTRAP=container requires DB_DIRECT_CONNECTION to be set."
    );
  }
  // App driver also needs a connection string; default to the direct URL
  // when the operator hasn't provided a separate one (typical inside the
  // compose stack — no Neon proxy, same URL works for both).
  if (!process.env["DB_CONNECTION_STRING"]) {
    process.env["DB_CONNECTION_STRING"] = direct;
  }
  const appConnection = process.env["DB_CONNECTION_STRING"] ?? direct;

  const migrationsFolder =
    process.env["NAUTILO_MIGRATIONS_DIR"] ?? "/srv/migrations";

  print("Waiting for Postgres (container mode)...");
  const ready = await waitForPostgres(direct, 30, 1000);
  if (!ready) {
    throw new Error(
      "Postgres did not become reachable within 30 seconds " +
        "(NAUTILO_DB_BOOTSTRAP=container). Check the postgres service health."
    );
  }
  print("Postgres is ready.");

  print(`Running migrations from ${migrationsFolder}...`);
  const migrationSql = postgres(direct, { max: 1, onnotice: () => {} });
  const migrationDb = drizzle(migrationSql, { schema });
  await migrate(migrationDb, { migrationsFolder });
  await migrationSql.end();
  print("Migrations complete.");

  await applyRuntimeRoleContract(direct, print, "container");

  // D374 — stamp the connected-DB identity marker in deploy/container
  // mode too. Here `DB_DIRECT_CONNECTION` is the operator-configured
  // truth, so trust it (host path derives + verifies against instance.json
  // instead). A present marker naming a different instance still throws.
  await ensureConnectedDbIdentity(direct, process.env, { trustConnection: true });
  print("Instance identity marker verified.");

  return {
    connectionString: appConnection,
    containerStarted: false,
    migrationsRan: true,
  };
}

/**
 * D202 — should ensureDatabase() auto-heal a corrupted scratch DB?
 *
 * True only when BOTH hold:
 *   1. The test harness opted in via `TEST_DB_AUTOHEAL_ENV` (set by
 *      `bootstrapTestDbInstance`), AND
 *   2. The explicitly-set `NAUTILO_INSTANCE_ID` is the disposable scratch
 *      instance (`test-cruft`).
 *
 * This double gate guarantees the destructive DROP SCHEMA path can NEVER
 * run against the protected `(default)` instance or any named instance.
 */
export function shouldAutoHealScratchDb(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (env[TEST_DB_AUTOHEAL_ENV] !== "1") return false;
  if (listDbConnectionOverrides(env).length > 0) return false;
  return (env["NAUTILO_INSTANCE_ID"] ?? "").trim() === RECOMMENDED_SCRATCH_INSTANCE;
}

/** Number of migrations drizzle expects from the journal on disk. */
function expectedMigrationCount(): number {
  const journalPath = resolve(MIGRATIONS_FOLDER, "meta", "_journal.json");
  const journal = JSON.parse(readFileSync(journalPath, "utf8")) as {
    entries?: unknown[];
  };
  return Array.isArray(journal.entries) ? journal.entries.length : 0;
}

/** Migrations actually recorded as applied; -1 when the journal table is absent. */
async function appliedMigrationCount(directConnection: string): Promise<number> {
  const sql = postgres(directConnection, { max: 1, onnotice: () => {} });
  try {
    const rows = (await sql`
      SELECT count(*)::int AS c FROM drizzle.__drizzle_migrations
    `) as unknown as Array<{ c: number }>;
    return rows[0]?.c ?? 0;
  } catch {
    return -1;
  } finally {
    await sql.end({ timeout: 5 });
  }
}

async function runMigrations(directConnection: string): Promise<void> {
  const migrationSql = postgres(directConnection, { max: 1, onnotice: () => {} });
  const migrationDb = drizzle(migrationSql, { schema });
  try {
    await migrate(migrationDb, { migrationsFolder: MIGRATIONS_FOLDER });
  } finally {
    await migrationSql.end();
  }
}

/**
 * D202 (A) — loud assertion: after migrate, the applied-migration count
 * must equal the journal length. A mismatch means a conflicting/partial
 * migration or a hand-edited schema — the exact "haunted scratch DB"
 * failure mode. Throws an actionable message.
 */
async function assertMigrationsConsistent(directConnection: string): Promise<void> {
  const expected = expectedMigrationCount();
  const applied = await appliedMigrationCount(directConnection);
  if (applied !== expected) {
    throw new Error(
      `[ensureDatabase] migration state inconsistent: applied=${applied}, expected=${expected}. ` +
        `The scratch DB is likely corrupted (conflicting/partial migration or a manual schema edit). ` +
        `Run \`bun bin/nautilo-dev reset-test-cruft --yes\`, or set ${TEST_DB_AUTOHEAL_ENV}=1 to auto-heal test-cruft.`,
    );
  }
}

/**
 * D202 (C) — destructive heal of the disposable scratch DB. Drops the
 * `public` and `drizzle` schemas (wiping the migration journal so drizzle
 * re-applies everything from scratch), then re-migrates. The caller applies
 * the complete runtime role contract after this returns. Caller MUST have
 * verified `shouldAutoHealScratchDb()`.
 */
async function healScratchDatabase(
  directConnection: string,
  print: (message: string) => void,
): Promise<void> {
  assertDirectConnectionMatchesInstance(directConnection);
  await assertConnectedDbMarkerMatches(directConnection);
  print("[ensureDatabase] auto-heal: dropping public + drizzle schemas on scratch DB...");
  const dropSql = postgres(directConnection, { max: 1, onnotice: () => {} });
  try {
    await dropSql.unsafe(
      "DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public; DROP SCHEMA IF EXISTS drizzle CASCADE;",
    );
  } finally {
    await dropSql.end({ timeout: 5 });
  }
  print("[ensureDatabase] auto-heal: re-running migrations from scratch...");
  await runMigrations(directConnection);
}

/**
 * Run migrations with the D202 test-harness safety net: assert journal
 * consistency, and (scratch instance only) auto-heal a corrupted DB once.
 * In non-test contexts (`TEST_DB_AUTOHEAL_ENV` unset) this is a plain
 * `runMigrations` with identical behavior to the pre-D202 code path.
 */
async function runMigrationsGuarded(
  directConnection: string,
  print: (message: string) => void,
): Promise<void> {
  if (process.env[TEST_DB_AUTOHEAL_ENV] !== "1") {
    await runMigrations(directConnection);
    return;
  }

  try {
    await runMigrations(directConnection);
    await assertMigrationsConsistent(directConnection);
  } catch (err) {
    if (!shouldAutoHealScratchDb()) throw err;
    print(
      `[ensureDatabase] migration health check failed on scratch instance; auto-healing. ` +
        `Cause: ${err instanceof Error ? err.message : String(err)}`,
    );
    await healScratchDatabase(directConnection, print);
    await assertMigrationsConsistent(directConnection);
  }
}

/**
 * Ensures Postgres is running and schema is current.
 *
 * 1. Probes Postgres via direct connection.
 * 2. If unreachable, starts the Docker container (legacy-postgres only).
 * 3. Runs Drizzle migrations via direct connection.
 * 4. Sets DB_CONNECTION_STRING to the direct app-role URL for runtime code.
 *
 * D202: under a test harness (`bootstrapTestDbInstance` set
 * `NAUTILO_TEST_DB_AUTOHEAL=1`) a corrupted *scratch* DB is auto-healed;
 * `(default)` and named instances are never touched destructively.
 *
 * M114: when `NAUTILO_DB_BOOTSTRAP=container` is set, takes the container
 * branch above (no host docker, no Neon proxy).
 */
export async function ensureDatabase(
  log?: (message: string) => void
): Promise<EnsureDatabaseResult> {
  const print = log ?? (() => {});

  if (process.env["NAUTILO_DB_BOOTSTRAP"] === "container") {
    return ensureDatabaseContainer(print);
  }

  const directConnection = resolveDirectDatabaseConnectionString();
  const appConnection = resolveAppDatabaseConnectionString();

  let containerStarted = false;

  const alreadyUp = await tryConnect(directConnection);

  if (!alreadyUp) {
    if (!isDockerAvailable()) {
      throw new Error(
        "Cannot connect to Postgres and Docker is not available. " +
          "Either start Postgres manually or install Docker."
      );
    }

    print("Starting Postgres...");
    startContainer();
    containerStarted = true;

    const ready = await waitForPostgres(directConnection, 30, 1000);
    if (!ready) {
      throw new Error(
        "Postgres container started but did not become ready within 30 seconds."
      );
    }
    print("Postgres is ready.");
  }

  await assertConnectedDbMarkerMatches(directConnection);
  print("Running migrations...");
  await runMigrationsGuarded(directConnection, print);
  await applyRuntimeRoleContract(directConnection, print, "host");
  await reconcileScratchRuntimeCredentials(directConnection, appConnection);
  await ensureConnectedDbIdentity(directConnection);
  print("Migrations complete.");

  process.env["DB_CONNECTION_STRING"] = appConnection;

  return {
    connectionString: appConnection,
    containerStarted,
    migrationsRan: true,
  };
}
