/**
 * M212-adjacent preflight SQL: idempotently resync cluster-level Logto
 * tenant role passwords to match `public.tenants.db_user_password`.
 * No-ops when `public.tenants` is absent. Used before auth-profile up on
 * every managed deploy path and again after full restore re-grants when
 * `pg_dump` carries tenant passwords in the table but not cluster role
 * hashes (otherwise Logto OIDC discovery 500s on password auth errors).
 */
export function buildLogtoTenantPasswordResyncSql(): string {
  return (
    "DO $do$ " +
    "DECLARE r record; " +
    "BEGIN " +
    "IF to_regclass('public.tenants') IS NOT NULL THEN " +
    "FOR r IN SELECT db_user, db_user_password FROM public.tenants LOOP " +
    "IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r.db_user) THEN " +
    "EXECUTE format('ALTER ROLE %I WITH LOGIN PASSWORD %L', r.db_user, r.db_user_password); " +
    "ELSE " +
    "EXECUTE format('CREATE ROLE %I WITH LOGIN PASSWORD %L', r.db_user, r.db_user_password); " +
    "END IF; " +
    "END LOOP; " +
    "END IF; " +
    "END $do$;"
  );
}
