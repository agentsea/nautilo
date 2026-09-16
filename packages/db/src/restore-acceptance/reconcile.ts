// D427 (Wave 4 task 4.1.1) — shared credential-reconciliation helpers.
//
// A `pg_dump` of `nautilo` or `logto_nautilo` carries grants for the
// `nautilo` / `nautilo_agent` (app cluster) and `logto_tenant_*` (logto
// cluster) roles, but NOT the cluster-level role passwords — those stay
// whatever they were at restore time. A restored target can therefore boot
// with correct grants yet an OLD role password, so the server's runtime
// credentials (read from the restored `instance.env`) no longer match the
// live cluster roles and every connection fails with `password
// authentication failed`. The LAN restore rehearsal proved `/health` is
// green through this desync.
//
// These pure builders emit idempotent `ALTER ROLE`/`CREATE ROLE` DO blocks
// that re-pin each role's password to what the restored `instance.env` (app
// roles) or the restored `tenants` table (logto tenant roles) already
// expects. They are shared by the Compose restore/upgrade path and the
// `nautilo-dev` restore/upgrade path so neither reports success while the
// restored grants and the live cluster roles are out of sync. The caller
// runs the emitted SQL BEFORE application startup with `ON_ERROR_STOP=1`
// so a reconcile failure is fail-closed.
//
// This module is deliberately dependency-free (no drizzle, no postgres, no
// fetch) so it can be imported by lightweight operator tooling without
// pulling the full @nautilo/db runtime.

/** Escape a string as a SQL string literal: `o'brien` → `'o''brien'`. */
export function sqlLiteral(s: string): string {
  return "'" + s.replace(/'/g, "''") + "'";
}

/**
 * Parse a `.env`-style string into a key→value map. Mirrors the parser used
 * by the Compose restore path so both paths read the restored `instance.env`
 * identically. Strips surrounding single/double quotes; skips blanks and
 * `#` comments. Returns an empty map for an empty/unset env.
 */
export function parseDotenv(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of raw.split(/\r?\n/)) {
    const t = line.trim();
    if (t === "" || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq === -1) continue;
    const key = t.slice(0, eq).trim();
    let value = t.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (key) out[key] = value;
  }
  return out;
}

/**
 * Build the SQL that re-pins the `nautilo` and `nautilo_agent` app-cluster
 * role passwords to the values restored into `instance.env`. Emits one
 * idempotent DO block per role whose password is present (no-op for roles
 * absent from the env, so a bundle without those keys skips cleanly).
 * Returns `""` when neither password is present so the caller can short-
 * circuit without emitting empty SQL.
 */
export function buildAppRolePasswordReconcileSql(
  nautiloPassword: string | undefined,
  nautiloAgentPassword: string | undefined,
): string {
  const roles: Array<{ name: string; password: string }> = [];
  if (nautiloPassword && nautiloPassword.trim() !== "") {
    roles.push({ name: "nautilo", password: nautiloPassword });
  }
  if (nautiloAgentPassword && nautiloAgentPassword.trim() !== "") {
    roles.push({ name: "nautilo_agent", password: nautiloAgentPassword });
  }
  if (roles.length === 0) return "";
  return roles
    .map((r) => {
      const role = sqlLiteral(r.name);
      const pw = sqlLiteral(r.password);
      return (
        `DO $do$ DECLARE v_role text := ${role}; v_pw text := ${pw}; BEGIN ` +
        `IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = v_role) THEN ` +
        `EXECUTE format('ALTER ROLE %I WITH LOGIN PASSWORD %L', v_role, v_pw); ` +
        `ELSE EXECUTE format('CREATE ROLE %I WITH LOGIN PASSWORD %L', v_role, v_pw); END IF; ` +
        `END $do$;`
      );
    })
    .join("\n");
}

/**
 * SQL that re-pins every Logto per-tenant postgres role password to the
 * `db_user_password` already stored in the restored `tenants` table. The
 * loop is server-side so no tenant-row round-trip is needed; it is a no-op
 * when the `tenants` table is absent (pre-seed) or empty. Mirrors the
 * idempotent resync semantics in `bin/nautilo-dev/src/lib/logto-db.ts`
 * (`buildLogtoTenantResyncSql`) without invoking broad `authReconcile()`.
 */
export const LOGTO_TENANT_PASSWORD_RESYNC_SQL =
  "DO $do$ DECLARE r record; BEGIN " +
  "IF NOT EXISTS (SELECT 1 FROM information_schema.tables " +
  "WHERE table_schema = 'public' AND table_name = 'tenants') THEN RETURN; END IF; " +
  "FOR r IN SELECT db_user, db_user_password FROM tenants " +
  "WHERE db_user IS NOT NULL AND db_user_password IS NOT NULL LOOP " +
  "IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r.db_user) THEN " +
  "EXECUTE format('ALTER ROLE %I WITH LOGIN PASSWORD %L', r.db_user, r.db_user_password); " +
  "ELSE EXECUTE format('CREATE ROLE %I WITH LOGIN PASSWORD %L', r.db_user, r.db_user_password); END IF; " +
  "END LOOP; END $do$;";

/** Which cluster a reconciliation pipeline targets. */
export type CredentialReconcileKind = "app" | "logto";

/** A single fail-closed reconciliation pipeline the caller must run. */
export interface CredentialReconcilePipeline {
  id: "app-role-password-reconcile" | "logto-tenant-role-resync";
  /** Human label used in operator logs and fail-closed error messages. */
  label: string;
  kind: CredentialReconcileKind;
  /** The SQL to run with `ON_ERROR_STOP=1`. Empty pipelines are NOT emitted. */
  sql: string;
}

export interface CredentialReconcilePlan {
  pipelines: CredentialReconcilePipeline[];
  /** Sensitive parsed app-role passwords; never log these or include them in dry-run output. */
  appRolePasswords: { nautilo: string | undefined; nautiloAgent: string | undefined };
}

/**
 * Pure planner: given the restored `instance.env` raw text and which
 * reconciliations are in scope, return the ordered list of fail-closed SQL
 * pipelines to run. The app-role pipeline is emitted only when the restored
 * env carries at least one app-role password (so a data-only restore without
 * `instance.env` skips cleanly). The Logto pipeline is emitted only when the
 * caller confirms Logto is in scope — the CALLER is responsible for gating
 * it on Logto DB/container availability, so this helper stays free of
 * runtime probes.
 *
 * Both Compose restore and `nautilo-dev` restore call this so the two paths
 * share the exact reconciliation SQL and fail-closed contract.
 */
export function planCredentialReconciliation(args: {
  instanceEnvRaw: string;
  reconcileNautilo: boolean;
  reconcileLogto: boolean;
}): CredentialReconcilePlan {
  const parsed = parseDotenv(args.instanceEnvRaw);
  const nautiloPassword = parsed["NAUTILO_DB_PASSWORD"];
  const nautiloAgentPassword = parsed["NAUTILO_AGENT_DB_PASSWORD"];
  const pipelines: CredentialReconcilePipeline[] = [];
  if (args.reconcileNautilo) {
    const appSql = buildAppRolePasswordReconcileSql(
      nautiloPassword,
      nautiloAgentPassword,
    );
    if (appSql !== "") {
      pipelines.push({
        id: "app-role-password-reconcile",
        label: "nautilo app-role password reconcile",
        kind: "app",
        sql: appSql,
      });
    }
  }
  if (args.reconcileLogto) {
    pipelines.push({
      id: "logto-tenant-role-resync",
      label: "logto tenant-role password resync",
      kind: "logto",
      sql: LOGTO_TENANT_PASSWORD_RESYNC_SQL,
    });
  }
  return {
    pipelines,
    appRolePasswords: { nautilo: nautiloPassword, nautiloAgent: nautiloAgentPassword },
  };
}
