/** Cluster-level Logto tenant roles for the `logto_nautilo` database. */
export const LOGTO_TENANT_ROLE_PREFIX = "logto_tenant_logto_nautilo" as const;

/**
 * M212-adjacent recovery SQL: drop orphaned `logto_tenant_logto_nautilo%`
 * cluster roles only when `public.tenants` is absent in `logto_nautilo`.
 * Safe to run repeatedly; never drops databases, schemas, tables, or volumes.
 */
export function buildLogtoPreSeedRecoverySql(): string {
  return (
    "DO $do$\n" +
    "DECLARE\n" +
    "  r record;\n" +
    "BEGIN\n" +
    "  IF to_regclass('public.tenants') IS NULL THEN\n" +
    "    FOR r IN\n" +
    `      SELECT rolname FROM pg_roles WHERE rolname LIKE '${LOGTO_TENANT_ROLE_PREFIX}%'\n` +
    "    LOOP\n" +
    "      EXECUTE format('REVOKE ALL PRIVILEGES ON SCHEMA public FROM %I', r.rolname);\n" +
    "      EXECUTE format('DROP ROLE IF EXISTS %I', r.rolname);\n" +
    "    END LOOP;\n" +
    "  END IF;\n" +
    "END\n" +
    "$do$;"
  );
}
