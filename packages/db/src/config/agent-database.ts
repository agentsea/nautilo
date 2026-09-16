/**
 * Agent-role database factories (D129 P3, Stack 11.5).
 *
 * The `nautilo_agent` Postgres role is provisioned by
 * `infra/postgres-init.sh`. Its grants:
 *   - SELECT/INSERT/UPDATE/DELETE on the public schema's normal tables
 *     (memories, artifacts, memory_namespaces, etc.)
 *   - SELECT on `users_public` (a view exposing safe identity columns)
 *   - NO GRANT on `credentials`, `recovery_codes`,
 *     `logto_account_security`, `channel_identities`, or the raw
 *     `users` table (REVOKE at bootstrap; parse-time 42501).
 *   - `sessions` IS grant-allowed (conversational transcript metadata;
 *     RLS-gated via Path C when queried as nautilo_agent).
 *
 * Postgres enforces these grants at parse time. Even a prompt-injected
 * agent that drives a hypothetical broad-SELECT tool will get
 * `permission denied for table credentials` rather than rows back.
 *
 * Two factories mirror the existing app-database shape:
 *
 *   - `createAgentDatabase()` — postgres-js runtime pool (max 5).
 *     Reads `resolveAgentDatabaseConnectionString()`. Use this in agent
 *     runtime code paths.
 *
 *   - `createDirectAgentDb()` — postgres-js direct factory (migrations,
 *     integration tests, anything needing transactions that survive
 *     across statements). Reads `DB_AGENT_DIRECT_CONNECTION` env var.
 *
 * Both connection strings point to the same `nautilo` database; only
 * the role + password differ from the full-privilege `DB_CONNECTION_STRING`
 * / `DB_DIRECT_CONNECTION`. See `packages/db/README.md` for role-specific
 * connection variables and the resolver functions below for precedence.
 */

import { drizzle as drizzleDirect } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { resolveInstance } from "@nautilo/config";
import { registerPoolForShutdown } from "./pool-shutdown-registry";
import { createRuntimeStatementDebugHandler } from "./runtime-statement-observer";
import * as schema from "../schema/index";

/**
 * Connection string for the nautilo_agent role (runtime pool).
 *
 * Precedence:
 *   1. **`DB_AGENT_CONNECTION_STRING`** env var (explicit operator override).
 *   2. Derived from **`DB_CONNECTION_STRING`** when present — same
 *      protocol/host/port/path/query, with the username swapped to
 *      `nautilo_agent` and the password taken from
 *      `NAUTILO_AGENT_DB_PASSWORD` (default `nautilo_agent`). This is the
 *      correct path in the deployed container topology, where
 *      `DB_CONNECTION_STRING` explicitly targets the in-cluster Postgres
 *      service at `app-postgres:5432`.
 *      Deriving from it keeps the agent postgres.js connection string on
 *      the same in-network PostgreSQL endpoint the server uses, instead of
 *      the host publish port from `resolveInstance().db.postgresHostPort`,
 *      which is unreachable from inside the deploy-net and caused the D420
 *      live-dev split before agent URLs were derived from the app string.
 *   3. Constructed default using the resolved Postgres host port + the
 *      `NAUTILO_AGENT_DB_PASSWORD` env var (default `nautilo_agent`).
 *      Retained for environments that set neither agent nor app
 *      connection string (e.g. host-dev without `DB_CONNECTION_STRING`).
 *
 * Local default: `postgres://nautilo_agent:<pw>@db.localtest.me:<port>/nautilo`
 * Production: operator supplies `DB_AGENT_CONNECTION_STRING` directly, or
 * `DB_CONNECTION_STRING` is present and the agent URL is derived from it.
 */
export function resolveAgentDatabaseConnectionString(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const raw = env["DB_AGENT_CONNECTION_STRING"]?.trim();
  if (raw) return raw;

  const password = env["NAUTILO_AGENT_DB_PASSWORD"] ?? "nautilo_agent";

  const appConnectionString = env["DB_CONNECTION_STRING"]?.trim();
  if (appConnectionString) {
    return deriveAgentConnectionStringFromApp(appConnectionString, password);
  }

  const inst = resolveInstance(env);
  return `postgres://nautilo_agent:${password}@db.localtest.me:${inst.db.postgresHostPort}/nautilo`;
}

/**
 * Derive the `nautilo_agent` postgres.js connection string from the
 * full-privilege app connection string (`DB_CONNECTION_STRING`):
 * preserve protocol, host, port, path, and query, but swap the
 * username to `nautilo_agent` and the password to the agent password.
 *
 * Using `URL` (rather than string interpolation) guarantees the host
 * port — especially the deployed `5432` — is preserved verbatim and
 * only the credentials change, so the agent runtime pool targets the
 * same PostgreSQL endpoint the server already uses.
 */
function deriveAgentConnectionStringFromApp(
  appConnectionString: string,
  agentPassword: string,
): string {
  const u = new URL(appConnectionString);
  u.username = "nautilo_agent";
  u.password = agentPassword;
  return u.toString();
}

/**
 * Connection string for the nautilo_agent role via direct postgres-js.
 *
 * Precedence: **`DB_AGENT_DIRECT_CONNECTION`** env → default constructed
 * from `resolveInstance().db.directConnection` with the user/password
 * swapped to nautilo_agent.
 */
export function resolveDirectAgentDatabaseConnectionString(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const raw = env["DB_AGENT_DIRECT_CONNECTION"]?.trim();
  if (raw) return raw;

  const baseDirect = resolveInstance(env).db.directConnection;
  const password = env["NAUTILO_AGENT_DB_PASSWORD"] ?? "nautilo_agent";
  const u = new URL(baseDirect);
  u.username = "nautilo_agent";
  u.password = password;
  return u.toString();
}

/** Append a stable Postgres application_name without logging connection details. */
function withApplicationName(connectionString: string, applicationName: string): string {
  const url = new URL(connectionString);
  url.searchParams.set("application_name", applicationName);
  return url.toString();
}

function createRuntimeAgentDb() {
  const conn = withApplicationName(
    resolveAgentDatabaseConnectionString(),
    SHARED_AGENT_DIRECT_APP_NAME,
  );
  const sql = postgres(conn, {
    max: 5,
    debug: createRuntimeStatementDebugHandler("agent"),
  });
  const db = drizzleDirect(sql, { schema });
  return Object.assign(db, {
    end: (options?: { timeout?: number }) => sql.end(options),
  });
}

export type AgentDatabase = ReturnType<typeof createRuntimeAgentDb>;
export type DirectAgentDatabase = ReturnType<typeof createDirectAgentDb>;

const SHARED_AGENT_DIRECT_POOL_NAME = "direct:nautilo-agent";
const SHARED_AGENT_DIRECT_APP_NAME = "nautilo.agent-direct";
const TEST_POOL_CLOSE_TIMEOUT_SECONDS = 1;

let _runtimeAgentDb: AgentDatabase | null = null;
let _unregisterRuntimeAgent: (() => void) | null = null;

function getRuntimeAgentDb(): AgentDatabase {
  if (!_runtimeAgentDb) {
    _runtimeAgentDb = createRuntimeAgentDb();
    _unregisterRuntimeAgent = registerPoolForShutdown({
      name: SHARED_AGENT_DIRECT_POOL_NAME,
      close: async (timeoutMs) => {
        const active = _runtimeAgentDb;
        if (!active) return;
        await active.end({ timeout: Math.max(1, Math.ceil(timeoutMs / 1_000)) });
        _runtimeAgentDb = null;
      },
    });
  }
  return _runtimeAgentDb;
}

/**
 * Postgres-js runtime factory for the restricted agent role.
 *
 * Returns the same lazy pool as `agentDb` and `getSharedDirectAgentDb()`.
 */
export function createAgentDatabase(): AgentDatabase {
  return getRuntimeAgentDb();
}

/**
 * Singleton handle for the agent role, mirroring the `db` singleton
 * from `./database.ts`. Use this in any module that previously did
 * `import { db } from "@nautilo/db"` and lives in
 * `packages/agent/src/`.
 */
export const agentDb = new Proxy({} as AgentDatabase, {
  get(_target, prop) {
    return getRuntimeAgentDb()[prop as keyof AgentDatabase];
  },
});

/**
 * Process-wide shared postgres-js handle for the `nautilo_agent` role.
 * Alias of the runtime owner used by `agentDb` / `createAgentDatabase()`.
 */
export function getSharedDirectAgentDb(): AgentDatabase {
  return getRuntimeAgentDb();
}

/**
 * Direct postgres-js factory for migrations / integration tests /
 * any code path needing transactions that survive across statements.
 *
 * Mirrors `createDirectDb()` in `./direct-database.ts` but uses the
 * `nautilo_agent` role.
 */
export function createDirectAgentDb(maxConnections = 5) {
  const conn = resolveDirectAgentDatabaseConnectionString();
  const sql = postgres(conn, { max: maxConnections });
  const db = drizzleDirect(sql, { schema });
  return Object.assign(db, {
    end: (options?: { timeout?: number }) => sql.end(options),
  });
}

/**
 * @internal test seam — force-close the agent-role runtime pool before reset.
 * Rejects on close failure so a live handle is never silently discarded.
 */
export async function __resetSharedDirectAgentDbForTests(): Promise<void> {
  if (_runtimeAgentDb) {
    await _runtimeAgentDb.end({
      timeout: TEST_POOL_CLOSE_TIMEOUT_SECONDS,
    });
    _runtimeAgentDb = null;
  }
  _unregisterRuntimeAgent?.();
  _unregisterRuntimeAgent = null;
}
