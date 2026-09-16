import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { resolveInstance } from "@nautilo/config";
import { registerPoolForShutdown } from "./pool-shutdown-registry";
import { createRuntimeStatementDebugHandler } from "./runtime-statement-observer";
import * as schema from "../schema/index";

/**
 * Runtime app connection string (full `postgres` / `nautilo` role).
 *
 * Precedence: **`DB_CONNECTION_STRING`** env → default built from
 * `resolveInstance().db.postgresHostPort`.
 */
export function resolveAppDatabaseConnectionString(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const raw = env["DB_CONNECTION_STRING"]?.trim();
  if (raw) return raw;
  const password = env["NAUTILO_DB_PASSWORD"] ?? "nautilo";
  const inst = resolveInstance(env);
  return `postgres://nautilo:${password}@localhost:${inst.db.postgresHostPort}/nautilo`;
}

/** Append a stable Postgres application_name without logging connection details. */
function withApplicationName(connectionString: string, applicationName: string): string {
  const url = new URL(connectionString);
  url.searchParams.set("application_name", applicationName);
  return url.toString();
}

function createRuntimeFullDb() {
  const conn = withApplicationName(
    resolveAppDatabaseConnectionString(),
    SHARED_FULL_APP_NAME,
  );
  const sql = postgres(conn, {
    max: 5,
    debug: createRuntimeStatementDebugHandler("full"),
  });
  const db = drizzle(sql, { schema });
  return Object.assign(db, {
    end: (options?: { timeout?: number }) => sql.end(options),
  });
}

export type Database = ReturnType<typeof createRuntimeFullDb>;

const SHARED_FULL_POOL_NAME = "direct:nautilo";
const SHARED_FULL_APP_NAME = "nautilo.direct";
const TEST_POOL_CLOSE_TIMEOUT_SECONDS = 1;

let _runtimeFullDb: Database | null = null;
let _unregisterRuntimeFull: (() => void) | null = null;

function getRuntimeFullDb(): Database {
  if (!_runtimeFullDb) {
    _runtimeFullDb = createRuntimeFullDb();
    _unregisterRuntimeFull = registerPoolForShutdown({
      name: SHARED_FULL_POOL_NAME,
      close: async (timeoutMs) => {
        const active = _runtimeFullDb;
        if (!active) return;
        await active.end({ timeout: Math.max(1, Math.ceil(timeoutMs / 1_000)) });
        _runtimeFullDb = null;
      },
    });
  }
  return _runtimeFullDb;
}

/**
 * Create the process-wide full-role runtime database handle.
 *
 * Returns the same lazy postgres-js pool as `db` and `getSharedDirectDb()`.
 */
export function createDatabase(): Database {
  return getRuntimeFullDb();
}

/**
 * Process-wide shared postgres-js handle for the full `nautilo` role.
 * Alias of the runtime owner used by `db` / `createDatabase()`.
 */
export function getSharedDirectDb(): Database {
  return getRuntimeFullDb();
}

export const db = new Proxy({} as Database, {
  get(_target, prop) {
    return getRuntimeFullDb()[prop as keyof Database];
  },
});

/**
 * @internal test seam — force-close the full-role runtime pool before reset.
 * Rejects on close failure so a live handle is never silently discarded.
 */
export async function __resetSharedDirectDbForTests(): Promise<void> {
  if (_runtimeFullDb) {
    await _runtimeFullDb.end({ timeout: TEST_POOL_CLOSE_TIMEOUT_SECONDS });
    _runtimeFullDb = null;
  }
  _unregisterRuntimeFull?.();
  _unregisterRuntimeFull = null;
}
