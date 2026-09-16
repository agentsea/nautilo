/**
 * M059 — counterpart to `lib/docker-db.ts` for the Logto Postgres
 * instance.
 *
 * The legacy `nautilo-postgres` container (lib/docker-db.ts) holds the
 * `nautilo` DB. The Logto compose stack runs a SEPARATE container —
 * `{composeProject}-postgres-1` (see `deriveComposeContainerBundle`) —
 * that hosts `logto_nautilo`. They MUST not be
 * conflated; running `pg_dump` against `nautilo-postgres` for
 * `logto_nautilo` returns "database does not exist".
 *
 * Helpers here are minimal on purpose:
 *   - presence check (does the DB exist on this cluster?)
 *   - `pg_dump | gzip` of `logto_nautilo`
 *   - `psql -d logto_nautilo -f <gzipped>` for restore
 *   - drop + recreate (used by `clean`)
 *   - `getLogtoDbUrl()` for the `npx @logto/cli db alteration deploy`
 *     env var
 *
 * Container name is overridable via the `LOGTO_DB_CONTAINER` env var
 * for installs that use a non-default compose project name.
 */
import { resolveInstance } from "@nautilo/config";
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";

function envForResolveInstance(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return env === process.env ? process.env : { ...process.env, ...env };
}

const DB_NAME = "logto_nautilo";
const DB_USER = "postgres";

/**
 * SQL that drops every Logto-per-tenant role left behind after a
 * `DROP DATABASE logto_nautilo`. Exported for unit-test inspection;
 * see `dropAndCreateLogtoDb` for context on why this is needed.
 */
export const DROP_LOGTO_TENANT_ROLES_SQL = `DO $do$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT rolname FROM pg_roles WHERE rolname LIKE 'logto_tenant_${DB_NAME}%'
  LOOP
    EXECUTE format('DROP ROLE IF EXISTS %I', r.rolname);
  END LOOP;
END
$do$;`;

export function resolveLogtoContainer(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env["LOGTO_DB_CONTAINER"]?.trim();
  if (explicit) return explicit;
  const inst = resolveInstance(envForResolveInstance(env));
  return inst.compose.containers.logtoPostgres;
}

function exec(cmd: string): Buffer {
  return execSync(cmd, { maxBuffer: 512 * 1024 * 1024 });
}

export function isLogtoContainerRunning(container = resolveLogtoContainer()): boolean {
  try {
    const out = exec(
      `docker inspect -f '{{.State.Running}}' ${container} 2>/dev/null`,
    )
      .toString()
      .trim();
    return out === "true";
  } catch {
    return false;
  }
}

/**
 * Returns true iff the named DB exists on the running cluster. False
 * if the container is not running OR the DB is absent. Never throws.
 */
export function logtoDatabaseExists(container = resolveLogtoContainer()): boolean {
  if (!isLogtoContainerRunning(container)) return false;
  try {
    const out = exec(
      `docker exec ${container} psql -U ${DB_USER} -t -A -c "SELECT 1 FROM pg_database WHERE datname='${DB_NAME}'" postgres`,
    )
      .toString()
      .trim();
    return out === "1";
  } catch {
    return false;
  }
}

/**
 * Restore a gzipped pg_dump of `logto_nautilo` into the running
 * cluster. Strategy: drop + recreate the database (Logto regenerates
 * its own schema on next boot from the dumped objects + data), then
 * pipe the gunzipped dump into `psql`.
 *
 * Unlike `lib/docker-db.ts`'s nautilo restore, we do NOT run
 * drizzle-kit or any post-COPY migration: Logto's schema lives inside
 * its own dump, the dump is a self-contained `pg_dump` of the DB
 * (schema + data), and Logto OSS does its own migration on next boot
 * via `npx @logto/cli db alteration deploy`. Plain `psql -f` is
 * correct + complete.
 */
export function restoreLogtoFromGzip(
  gzipPath: string,
  container = resolveLogtoContainer(),
  log: (msg: string) => void = console.log,
): void {
  if (!isLogtoContainerRunning(container)) {
    throw new Error(
      `Docker container "${container}" is not running. Start with: bun run infra:start`,
    );
  }
  log(`  Dropping and recreating ${DB_NAME}...`);
  // Terminate other connections (Logto core may be holding open
  // connections; this is the same pattern docker-db.ts uses for the
  // legacy DB drop).
  exec(
    `docker exec ${container} psql -U ${DB_USER} -c "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname='${DB_NAME}' AND pid <> pg_backend_pid();" postgres`,
  );
  exec(
    `docker exec ${container} psql -U ${DB_USER} -c "DROP DATABASE IF EXISTS ${DB_NAME};" postgres`,
  );
  exec(
    `docker exec ${container} psql -U ${DB_USER} -c "CREATE DATABASE ${DB_NAME};" postgres`,
  );

  log(`  Importing ${DB_NAME} from snapshot...`);
  const dumpText = gunzipSync(readFileSync(gzipPath)).toString("utf8");
  execSync(`docker exec -i ${container} psql -U ${DB_USER} ${DB_NAME}`, {
    input: dumpText,
    stdio: ["pipe", "pipe", "pipe"],
    maxBuffer: 512 * 1024 * 1024,
  });
  log(`  ${DB_NAME} restored.`);

  // Stack 132 — resync tenant role passwords after the import.
  // `pg_dump` of `logto_nautilo` carries the `tenants.db_user_password`
  // values from the snapshot, but does NOT include the cluster-level
  // postgres roles (`logto_tenant_logto_nautilo_default`, `_admin`).
  // Those roles keep whatever passwords they had at restore time, so
  // the restored `tenants` rows and the live postgres roles can be
  // out of sync — which surfaces as `password authentication failed`
  // when Logto core opens its tenant pool on next boot. The resync
  // is idempotent (no-op when passwords already match) and safe to
  // run unconditionally: it touches only the two tenant role password
  // hashes, aligning them to what Logto already expects.
  log(`  Resyncing Logto tenant role passwords...`);
  try {
    const resync = resyncLogtoTenantRoles({ container, log });
    if (resync.rowCount > 0 && !resync.dryRun) {
      log(`  ${resync.rowCount} tenant role(s) resynced.`);
    }
  } catch (err) {
    // Defensive: a resync failure post-restore is not fatal — the
    // operator can still run the manual resync. Surface and continue.
    log(
      `  WARNING: tenant role resync failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    log(`  The restore itself completed; see the operator playbook for the manual resync step.`);
  }
}

/**
 * Drop + recreate `logto_nautilo` (used by `clean`). Logto core will
 * re-seed the schema on its next boot via `logto-seed` + Logto's own
 * alteration mechanism. After this, the operator should re-run
 * `bun run infra:start` (or `bootstrap-logto.ts`) to repopulate
 * applications, resources, and roles.
 *
 * `DROP DATABASE` removes everything **inside** the DB but does NOT
 * drop the cluster-level per-tenant roles Logto creates on first
 * seed (`logto_tenant_<dbname>`, `_admin`, `_default`). Those roles
 * are pinned to the cluster, not the DB, so they survive every
 * subsequent `DROP DATABASE`. The next `logto db seed --swe` then
 * fails with `role "logto_tenant_logto_nautilo" already exists`
 * (Postgres error code 42710). To prevent the "I just ran dev:clean
 * but infra:start still won't seed" trap, we drop every
 * `logto_tenant_<dbname>%` role here too. They're guaranteed-empty
 * by the preceding DROP DATABASE (their privileges referenced
 * DB-scoped objects), so `DROP ROLE` is safe.
 */
export function dropAndCreateLogtoDb(container = resolveLogtoContainer()): void {
  if (!isLogtoContainerRunning(container)) {
    throw new Error(
      `Docker container "${container}" is not running. Start with: bun run infra:start`,
    );
  }
  exec(
    `docker exec ${container} psql -U ${DB_USER} -c "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname='${DB_NAME}' AND pid <> pg_backend_pid();" postgres`,
  );
  exec(
    `docker exec ${container} psql -U ${DB_USER} -c "DROP DATABASE IF EXISTS ${DB_NAME};" postgres`,
  );
  // Logto's per-tenant roles are `logto_tenant_<dbname>` plus
  // `_admin` and `_default` siblings. Pattern-match and drop all
  // matches via a DO block so missing roles (i.e. a fresh cluster
  // that never seeded) are a no-op rather than an error.
  //
  // The SQL uses `$do$ ... $do$` dollar-quoting. We MUST pipe it over
  // stdin (`docker exec -i ... psql postgres`) rather than embed it
  // in `-c "..."`: the outer shell's double-quoted form parses `$d`,
  // `$o`, `$d` as parameter expansions and silently strips the
  // dollar-quoted delimiters, leaving `DO $ ... $` which Postgres
  // rejects with `syntax error at or near "$"`. stdin sidesteps the
  // shell entirely.
  execSync(`docker exec -i ${container} psql -U ${DB_USER} postgres`, {
    input: DROP_LOGTO_TENANT_ROLES_SQL,
    maxBuffer: 512 * 1024 * 1024,
    stdio: ["pipe", "pipe", "pipe"],
  });
  // Mirror `infra/postgres-init.sh`'s `CREATE DATABASE logto_nautilo
  // OWNER logto` + cross-DB isolation REVOKEs. The init script is
  // the canonical setup but only runs once per Postgres data volume;
  // re-creating `logto_nautilo` from inside `dev:clean` has to
  // replicate it or `logto-seed` fails with "permission denied for
  // schema public" (Postgres 15+ — the `logto` role can't CREATE
  // TABLE in public unless it owns the DB). The cross-DB REVOKEs
  // are best-effort via `DO ... IF EXISTS (SELECT 1 FROM pg_roles
  // ...)`: the `nautilo` / `nautilo_agent` roles exist on a fully
  // initialized cluster but not on bare images, so guard each
  // REVOKE behind a presence check.
  const recreateDbSql = `CREATE DATABASE ${DB_NAME} OWNER logto;
DO $do$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nautilo') THEN
    EXECUTE 'REVOKE ALL ON DATABASE ${DB_NAME} FROM nautilo';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nautilo_agent') THEN
    EXECUTE 'REVOKE ALL ON DATABASE ${DB_NAME} FROM nautilo_agent';
  END IF;
END
$do$;
GRANT ALL ON DATABASE ${DB_NAME} TO logto;`;
  execSync(`docker exec -i ${container} psql -U ${DB_USER} postgres`, {
    input: recreateDbSql,
    maxBuffer: 512 * 1024 * 1024,
    stdio: ["pipe", "pipe", "pipe"],
  });
}

/**
 * Postgres URL for the `logto_nautilo` DB on the running compose
 * stack. Matches the `DB_URL` Logto core uses inside the container
 * (via `infra/compose/nautilo.yml`), except the host is `localhost`
 * (we shell into the container from the dev box) and the password is
 * read from the env / falls back to the compose default.
 *
 * Used by `nautilo-dev upgrade` to point `npx @logto/cli db alteration
 * deploy` at the right cluster.
 */
export function getLogtoDbUrl(env: NodeJS.ProcessEnv = process.env): string {
  const merged = envForResolveInstance(env);
  const password = merged["LOGTO_DB_PASSWORD"]?.trim() || "logto";
  const host = merged["LOGTO_DB_HOST"]?.trim() || "localhost";
  const explicitPort = merged["LOGTO_DB_PORT"]?.trim();
  const port =
    explicitPort ?? String(resolveInstance(merged).logto.dbPort);
  return `postgres://logto:${encodeURIComponent(password)}@${host}:${port}/${DB_NAME}`;
}

// ---------------------------------------------------------------------------
// Stack 132 — Logto tenant role password resync
//
// After a `nautilo-dev restore` from a `pg_dump` snapshot, the
// `tenants` table inside `logto_nautilo` holds the `db_user_password`
// values from the dump, but the cluster-level postgres roles
// (`logto_tenant_logto_nautilo_default`, `_admin`) keep whatever
// passwords they had at restore time — `pg_dump` of a single DB does
// not include cluster-level roles. The mismatch surfaces as
// `password authentication failed for user "logto_tenant_..._default"`
// when Logto core tries to open its tenant connection pool, which
// presents as a 500 on `http://localhost:3301/oidc/.well-known/openid-configuration`
// and blocks `infra:start`'s OIDC discovery wait.
//
// `resyncLogtoTenantRoles` reads each tenant row's `db_user_password`
// and runs `ALTER ROLE` (or `CREATE ROLE` if the role is missing) so
// the postgres role hash matches what Logto already expects.
// Idempotent: a no-op when the passwords already match. Honored as
// an idempotent step in both `restoreLogtoFromGzip` (targeted fix at
// the desync source) and `infra:start` (defensive layer before the
// OIDC discovery wait, catches any desync path).
//
// `LOGTO_RESYNC_DRY_RUN=1` prints the SQL it would run with
// passwords redacted as `***` and executes nothing — operator
// eyeballs the resync before applying it on a stack they're nervous
// about.
// ---------------------------------------------------------------------------

/** A tenant row from Logto's `tenants` table — what the resync reads. */
export interface LogtoTenantRow {
  id: string;
  dbUser: string;
  dbUserPassword: string;
}

/** Escape a string as a SQL string literal: `'foo'` → `'foo'`, `o'brien` → `'o''brien'`. */
function sqlLiteral(s: string): string {
  return "'" + s.replace(/'/g, "''") + "'";
}

/**
 * Build the SQL that resyncs each tenant's postgres role password to
 * match what Logto's `tenants.db_user_password` already expects.
 *
 * Per tenant, emits a `DO` block that:
 *   - if the role exists: `ALTER ROLE <db_user> WITH LOGIN PASSWORD <pw>`
 *   - else: `CREATE ROLE <db_user> WITH LOGIN PASSWORD <pw>`
 *
 * The `format(%I, %L)` inside `EXECUTE` SQL-identifier- and
 * literal-quotes the values for the dynamic statement. The outer
 * string literals (in `DECLARE`) are single-quote-escaped by
 * `sqlLiteral`. Returns `""` for an empty tenant list so callers can
 * short-circuit without emitting empty SQL.
 *
 * Exported for unit tests; the runtime path is `resyncLogtoTenantRoles()`.
 */
export function buildLogtoTenantResyncSql(
  rows: readonly LogtoTenantRow[],
): string {
  if (rows.length === 0) return "";
  return rows
    .map((r) => {
      const role = sqlLiteral(r.dbUser);
      const pw = sqlLiteral(r.dbUserPassword);
      return `DO $do$
DECLARE
  v_role text := ${role};
  v_pw text := ${pw};
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = v_role) THEN
    EXECUTE format('ALTER ROLE %I WITH LOGIN PASSWORD %L', v_role, v_pw);
  ELSE
    EXECUTE format('CREATE ROLE %I WITH LOGIN PASSWORD %L', v_role, v_pw);
  END IF;
END
$do$;`;
    })
    .join("\n");
}

/** Replace each tenant row's password with `***` for dry-run logging. */
export function redactTenantRowPasswords(
  rows: readonly LogtoTenantRow[],
): LogtoTenantRow[] {
  return rows.map((r) => ({ ...r, dbUserPassword: "***" }));
}

/** `LOGTO_RESYNC_DRY_RUN=1` → dry-run. Any other value (or unset) → execute. */
export function isLogtoResyncDryRunEnv(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return env["LOGTO_RESYNC_DRY_RUN"]?.trim() === "1";
}

export interface ResyncLogtoTenantRolesOptions {
  /** Override the Logto postgres container (defaults to `resolveLogtoContainer()`). */
  container?: string;
  /** Force dry-run on/off; defaults to `LOGTO_RESYNC_DRY_RUN=1` env. */
  dryRun?: boolean;
  /** Logger; default `console.log`. */
  log?: (msg: string) => void;
}

export interface ResyncLogtoTenantRolesDeps {
  /** Reads tenant rows from `logto_nautilo.tenants`. Real impl shells `docker exec psql`. */
  readTenantRows: () => LogtoTenantRow[];
  /** Pipes SQL to `psql -U postgres -d logto_nautilo` in the container via stdin. */
  execPsql: (sql: string) => void;
  /** Logger; default `console.log`. */
  log?: (msg: string) => void;
}

export interface ResyncResult {
  /** True iff SQL was actually executed against postgres (false in dry-run or empty-rows case). */
  executed: boolean;
  /** The SQL that was (or would have been) executed, with real passwords. */
  sql: string;
  /** Number of tenant rows read. */
  rowCount: number;
  /** Whether dry-run was active. */
  dryRun: boolean;
}

/**
 * Pure runner — exit + result, no `process.env` reads, no `docker exec`.
 * Takes injectable deps so unit tests cover every branch without docker.
 *
 * Behavior:
 *   - empty tenant rows → log + return `{ executed: false, sql: "", rowCount: 0 }`
 *   - dry-run → log redacted SQL (passwords → `***`) to stderr + return
 *     `{ executed: false, sql, rowCount, dryRun: true }`
 *   - otherwise → execPsql(sql) + return `{ executed: true, sql, rowCount, dryRun: false }`
 */
export function runResyncLogtoTenantRoles(
  options: ResyncLogtoTenantRolesOptions,
  deps: ResyncLogtoTenantRolesDeps,
): ResyncResult {
  const log = deps.log ?? options.log ?? console.log;
  const dryRun = options.dryRun ?? isLogtoResyncDryRunEnv();
  const rows = deps.readTenantRows();
  if (rows.length === 0) {
    log("[logto-resync] no tenant rows; nothing to resync");
    return { executed: false, sql: "", rowCount: 0, dryRun };
  }
  const sql = buildLogtoTenantResyncSql(rows);
  if (dryRun) {
    const redacted = buildLogtoTenantResyncSql(redactTenantRowPasswords(rows));
    log("[logto-resync] DRY-RUN — would execute the following SQL (passwords redacted as ***):");
    log(redacted);
    return { executed: false, sql, rowCount: rows.length, dryRun: true };
  }
  deps.execPsql(sql);
  log(`[logto-resync] resynced ${rows.length} tenant role password(s)`);
  return { executed: true, sql, rowCount: rows.length, dryRun: false };
}

/**
 * Read tenant rows from `logto_nautilo.tenants` via `docker exec psql`.
 * Output format is `id|db_user|db_user_password` per line (psql `-t -A`
 * with `|` field separator). Returns `[]` if the container is not
 * running or the query fails — never throws (the resync is a defensive
 * step; a query failure should not abort `infra:start`).
 */
function readTenantRowsFromContainer(container: string): LogtoTenantRow[] {
  if (!isLogtoContainerRunning(container)) return [];
  try {
    const out = exec(
      `docker exec ${container} psql -U ${DB_USER} -t -A -F "|" -c "SELECT id, db_user, db_user_password FROM tenants" ${DB_NAME}`,
    )
      .toString()
      .trim();
    if (!out) return [];
    // `noUncheckedIndexedAccess` forces us to guard the split parts;
    // malformed lines (e.g. psql emitting a stray empty row) are
    // filtered out so a partial parse never reaches the SQL builder.
    return out
      .split("\n")
      .map((line) => {
        const parts = line.split("|");
        const id = parts[0] ?? "";
        const dbUser = parts[1] ?? "";
        const dbUserPassword = parts[2] ?? "";
        return { id, dbUser, dbUserPassword };
      })
      .filter((r) => r.id && r.dbUser && r.dbUserPassword);
  } catch {
    return [];
  }
}

/**
 * Resync Logto tenant role passwords against the running compose
 * stack. Reads `tenants.db_user_password` for each tenant and runs
 * `ALTER ROLE` (or `CREATE ROLE` if missing) so the postgres role
 * hash matches what Logto already expects.
 *
 * Idempotent no-op when passwords already match. Honors
 * `LOGTO_RESYNC_DRY_RUN=1` to print redacted SQL without executing.
 *
 * Designed to be safe to call from `infra:start` on every boot: the
 * read is non-throwing, the SQL is idempotent, and the dry-run path
 * executes nothing.
 */
export function resyncLogtoTenantRoles(
  options: ResyncLogtoTenantRolesOptions = {},
): ResyncResult {
  const container = options.container?.trim() || resolveLogtoContainer();
  const dryRun = options.dryRun ?? isLogtoResyncDryRunEnv();
  if (!isLogtoContainerRunning(container)) {
    // Defensive: don't throw from the `infra:start` call site. The
    // OIDC discovery wait will surface the real Logto boot failure.
    return { executed: false, sql: "", rowCount: 0, dryRun };
  }
  // Build deps without an explicit `log: undefined` so
  // `exactOptionalPropertyTypes` is satisfied; the runner falls back
  // to `console.log` when `log` is absent from the deps object.
  const deps: ResyncLogtoTenantRolesDeps = {
    readTenantRows: () => readTenantRowsFromContainer(container),
    execPsql: (sql) => {
      execSync(`docker exec -i ${container} psql -U ${DB_USER} ${DB_NAME}`, {
        input: sql,
        maxBuffer: 512 * 1024 * 1024,
        stdio: ["pipe", "pipe", "pipe"],
      });
    },
  };
  if (options.log) deps.log = options.log;
  return runResyncLogtoTenantRoles(options, deps);
}
