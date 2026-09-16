import { spawn } from "node:child_process";
import {
  buildCryptoRoleReconcilePsqlScript,
  buildFullCryptoTablePrivilegeReconcileSql,
} from "@nautilo/db";

export interface ServiceRoleReconcileRequest {
  container: string;
  database?: string;
  roles: ReadonlyArray<{ name: string; password: string }>;
}

export type ServiceRoleSqlExec = (args: {
  container: string;
  database: string;
  script: string;
}) => Promise<void>;

function psqlBindLiteral(value: string): string {
  if (/[\r\n]/.test(value)) {
    throw new Error("internal service-role credential contains an unsupported line break");
  }
  return "'" + value.replace(/'/g, "''") + "'";
}

/**
 * psql's extended-query `\bind` keeps password values out of SQL statement
 * text. The DO block only reads a transaction-local setting and refuses to
 * synthesize a partially privileged role when expected bootstrap state is
 * absent.
 */
export function buildServiceRoleReconcileScript(
  roles: ReadonlyArray<{ name: string; password: string }>,
): string {
  if (roles.length === 0) return "";
  const statements = ["BEGIN;"];
  for (const role of roles) {
    if (!/^[a-z_][a-z0-9_]*$/.test(role.name)) {
      throw new Error("internal service-role reconciliation received an invalid role name");
    }
    if (role.password.trim() === "") {
      throw new Error("internal service-role reconciliation received an empty credential");
    }
    statements.push(
      "SELECT set_config('nautilo.internal_role_password', $1, true)",
      `\\bind ${psqlBindLiteral(role.password)}`,
      "\\g",
      `DO $do$ DECLARE v_role text := '${role.name}'; BEGIN ` +
        "IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = v_role) THEN " +
        "RAISE EXCEPTION 'required internal service role % is missing', v_role; END IF; " +
        "EXECUTE format('ALTER ROLE %I WITH LOGIN PASSWORD %L', v_role, " +
        "current_setting('nautilo.internal_role_password')); END $do$;",
    );
  }
  statements.push("COMMIT;");
  return statements.join("\n");
}

/**
 * Pipe role repair SQL over stdin to the selected container's local operator
 * socket. Passwords never appear in argv, process listings, or diagnostics.
 */
async function dockerServiceRoleSqlExec(args: {
  container: string;
  database: string;
  script: string;
}): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const proc = spawn(
      "docker",
      [
        "exec",
        "-i",
        args.container,
        "psql",
        "-X",
        "-q",
        "-U",
        "postgres",
        "-d",
        args.database,
        "-v",
        "ON_ERROR_STOP=1",
      ],
      { stdio: ["pipe", "ignore", "pipe"] },
    );
    // Drain stderr but never include it in the thrown error: psql can echo
    // statement context, and the repair SQL intentionally contains secrets.
    proc.stderr.resume();
    proc.on("error", reject);
    proc.on("close", (code) => {
      if (code === 0) resolve();
      else {
        reject(
          new Error(
            `internal service-role reconciliation failed in ${args.container} (exit ${code ?? 1}); credential values were redacted`,
          ),
        );
      }
    });
    proc.stdin.end(args.script);
  });
}

export async function reconcileServiceRoles(
  request: ServiceRoleReconcileRequest,
  exec: ServiceRoleSqlExec = dockerServiceRoleSqlExec,
): Promise<void> {
  const script = buildServiceRoleReconcileScript(request.roles);
  if (script === "") {
    throw new Error("internal service-role reconciliation received no credentials");
  }
  try {
    await exec({
      container: request.container,
      database: request.database ?? "postgres",
      script,
    });
  } catch {
    throw new Error(
      `internal service-role reconciliation failed in ${request.container}; credential values were redacted`,
    );
  }
}

/**
 * Create/repair the dormant bridge role from the app-postgres container's
 * own narrowly scoped bootstrap environment. No crypto password is accepted
 * by this API, copied into argv, or interpolated into SQL.
 */
export async function reconcileCryptoServiceRole(
  container: string,
  exec: ServiceRoleSqlExec = dockerServiceRoleSqlExec,
): Promise<void> {
  try {
    await exec({
      container,
      database: "postgres",
      script: buildCryptoRoleReconcilePsqlScript(),
    });
  } catch {
    throw new Error(
      `internal crypto service-role reconciliation failed in ${container}; credential values were redacted`,
    );
  }
}

/** Reapply the exact post-migration crypto table grants and agent/PUBLIC revokes. */
export async function reconcileCryptoStoragePrivileges(
  container: string,
  exec: ServiceRoleSqlExec = dockerServiceRoleSqlExec,
): Promise<void> {
  try {
    await exec({
      container,
      database: "nautilo",
      script: buildFullCryptoTablePrivilegeReconcileSql(),
    });
  } catch {
    throw new Error(
      `internal crypto table-privilege reconciliation failed in ${container}`,
    );
  }
}
