/**
 * M051 (Logto cluster): upgrade-path counterpart to `infra/postgres-init.sh`.
 *
 * `postgres-init.sh` only runs on FIRST boot of a Postgres data volume.
 * Operators upgrading a pre-M051 install have an existing volume where
 * the script never fired — they're missing `logto_nautilo` + the `logto`
 * role. This command detects that state and (with `--fix`) repairs it.
 *
 * Idempotent: re-runs against an already-correct cluster exit 0 with "OK".
 *
 * Default target is the Logto compose Postgres container
 * (`{project}-postgres-1`); override with `--container <name>` when needed.
 */
import { execSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { resolveLogtoContainer } from "../lib/logto-db";

const DB_USER_DEFAULT = "postgres";
const TARGET_DB = "logto_nautilo";
const TARGET_ROLE = "logto";

export interface VerifyOptions {
  container?: string | undefined;
  superuser?: string | undefined;
  fix?: boolean | undefined;
}

/**
 * What the command found in the cluster. `status` drives `--fix`'s decision
 * to act; the boolean fields are exposed for callers (and tests) that want
 * a finer-grained view.
 */
export interface ProbeResult {
  status: "ok" | "missing-db" | "missing-role" | "missing-both" | "no-container";
  dbPresent: boolean;
  rolePresent: boolean;
  containerRunning: boolean;
}

/**
 * Function-shaped abstraction over `docker exec ... psql ...`. Real callers
 * use the default `containerExec` below (shells out to docker). Tests
 * inject their own implementation to drive the command without docker.
 *
 * `query` runs SQL and returns trimmed stdout.
 * `containerRunning` returns whether the named container is up.
 */
export interface ClusterExec {
  query: (
    sql: string,
    opts: { container: string; superuser: string; db?: string },
  ) => string;
  containerRunning: (container: string) => boolean;
}

function defaultClusterExec(): ClusterExec {
  return {
    query: (sql, { container, superuser, db }) => {
      const target = db ?? "postgres";
      const cmd = `docker exec ${container} psql -U ${superuser} -t -A -c ${JSON.stringify(sql)} ${target}`;
      return execSync(cmd, { stdio: ["ignore", "pipe", "pipe"] })
        .toString()
        .trim();
    },
    containerRunning: (container) => {
      try {
        const out = execSync(
          `docker inspect -f '{{.State.Running}}' ${container} 2>/dev/null`,
        )
          .toString()
          .trim();
        return out === "true";
      } catch {
        return false;
      }
    },
  };
}

/** Pure probe. Returns the observed state without making any changes. */
export function probe(
  exec: ClusterExec,
  container: string,
  superuser: string,
): ProbeResult {
  if (!exec.containerRunning(container)) {
    return {
      status: "no-container",
      dbPresent: false,
      rolePresent: false,
      containerRunning: false,
    };
  }
  const dbRow = exec.query(
    `SELECT 1 FROM pg_database WHERE datname='${TARGET_DB}'`,
    { container, superuser },
  );
  const roleRow = exec.query(
    `SELECT 1 FROM pg_roles WHERE rolname='${TARGET_ROLE}'`,
    { container, superuser },
  );
  const dbPresent = dbRow === "1";
  const rolePresent = roleRow === "1";

  let status: ProbeResult["status"];
  if (dbPresent && rolePresent) status = "ok";
  else if (!dbPresent && !rolePresent) status = "missing-both";
  else if (!dbPresent) status = "missing-db";
  else status = "missing-role";

  return { status, dbPresent, rolePresent, containerRunning: true };
}

/**
 * Apply the same SQL `postgres-init.sh` would have run on first boot,
 * conditionally on what's missing. `--fix`-only path; never called when
 * status is "ok" or "no-container".
 *
 * Generates a fresh password for the role when `LOGTO_DB_PASSWORD` isn't
 * already set in the env, prints it to stdout so the operator captures
 * it. Idempotent guards (`IF NOT EXISTS` + role re-creation skip) make
 * partial-state recovery safe.
 */
export function applyFix(
  exec: ClusterExec,
  container: string,
  superuser: string,
  result: ProbeResult,
): { generatedPassword: string | null } {
  const envPassword = process.env["LOGTO_DB_PASSWORD"];
  const password = envPassword ?? randomBytes(24).toString("hex");

  if (!result.rolePresent) {
    // CREATEROLE matches infra/postgres-init.sh — Logto's `cli db seed`
    // needs role-creation rights to mint m-admin and friends.
    exec.query(
      `CREATE ROLE ${TARGET_ROLE} LOGIN CREATEROLE PASSWORD '${password}'`,
      { container, superuser },
    );
  }
  if (!result.dbPresent) {
    exec.query(
      `CREATE DATABASE ${TARGET_DB} OWNER ${TARGET_ROLE}`,
      { container, superuser },
    );
  }
  // Mirror postgres-init.sh: GRANT ALL to the logto role, but DO NOT
  // revoke PUBLIC from the database. Logto's per-tenant roles inherit
  // CONNECT from PUBLIC during `cli db seed`; revoking PUBLIC breaks
  // the core's multi-tenant init. Cross-DB isolation between `nautilo`
  // and `logto_nautilo` is preserved by the role-to-role revoke that
  // postgres-init.sh applies on the other database (the one this
  // command doesn't touch).
  exec.query(
    `GRANT ALL ON DATABASE ${TARGET_DB} TO ${TARGET_ROLE}`,
    { container, superuser },
  );

  return { generatedPassword: envPassword ? null : password };
}

/**
 * Public command entry point. Returns the final exit code so the CLI
 * dispatcher can pass it to `process.exit()`.
 *
 * Without `--fix`: probe + report. Exits 0 when "ok"; exits 1 otherwise
 * so CI scripts can assert.
 *
 * With `--fix`: probe, apply, re-probe to confirm. Exits 0 on success.
 *
 * The function is `async` even though every caller today is synchronous:
 * future versions will likely poll OIDC discovery / Logto health when
 * verifying compose-managed clusters, and forcing every consumer to
 * adopt `await` later would be churn. Lint allowance below is for that
 * forward-compat shape.
 */
// eslint-disable-next-line @typescript-eslint/require-await -- async kept for forward-compat (live probes)
export async function verifyPostgresDatabases(
  options: VerifyOptions = {},
  exec: ClusterExec = defaultClusterExec(),
  log: (msg: string) => void = console.log,
): Promise<number> {
  const container = options.container ?? resolveLogtoContainer();
  const superuser = options.superuser ?? DB_USER_DEFAULT;

  const result = probe(exec, container, superuser);

  if (result.status === "no-container") {
    log(
      `[verify-postgres-databases] container "${container}" is not running.`,
    );
    log(
      `Start it with \`bun run db:dev\` (existing dev cluster) or via \`bin/nautilo-local --with-logto\` (compose stack).`,
    );
    return 1;
  }

  if (result.status === "ok") {
    log(`[verify-postgres-databases] OK — ${TARGET_DB} + ${TARGET_ROLE} present.`);
    return 0;
  }

  log(
    `[verify-postgres-databases] state: ${result.status}` +
      ` (db=${result.dbPresent}, role=${result.rolePresent})`,
  );

  if (!options.fix) {
    log("");
    log("Run with --fix to repair, or apply this SQL manually:");
    if (!result.rolePresent) {
      log(`  CREATE ROLE ${TARGET_ROLE} LOGIN PASSWORD '<your-password>';`);
    }
    if (!result.dbPresent) {
      log(`  CREATE DATABASE ${TARGET_DB} OWNER ${TARGET_ROLE};`);
    }
    log(`  REVOKE ALL ON DATABASE ${TARGET_DB} FROM PUBLIC;`);
    log(`  GRANT  ALL ON DATABASE ${TARGET_DB} TO ${TARGET_ROLE};`);
    return 1;
  }

  log("[verify-postgres-databases] --fix: applying repair...");
  const { generatedPassword } = applyFix(exec, container, superuser, result);

  // Re-probe to confirm.
  const after = probe(exec, container, superuser);
  if (after.status !== "ok") {
    log(`[verify-postgres-databases] FAILED — post-fix state: ${after.status}`);
    return 1;
  }
  log("[verify-postgres-databases] OK — repair applied.");
  if (generatedPassword) {
    log("");
    log("=========================================================");
    log("Generated password for `logto` role (SAVE THIS):");
    log(`  ${generatedPassword}`);
    log("");
    log("Add to ~/.nautilo/config.env or compose env:");
    log(`  LOGTO_DB_PASSWORD=${generatedPassword}`);
    log("=========================================================");
  }
  return 0;
}
