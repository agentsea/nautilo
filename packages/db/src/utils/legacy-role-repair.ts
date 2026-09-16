import { buildEventFeedReaderRoleSql } from "./event-feed-role";
import { buildAgentRoleGrantsSql } from "./agent-role-grants";
import { buildFullCryptoTablePrivilegeReconcileSql } from "./crypto-role-contract";

/** Full-privilege runtime/migration role (M212 direct-transport contract). */
export const NAUTILO_APP_ROLE = "nautilo";

/**
 * Representative table used to verify the app role can read the schema.
 * Matches post-restore integrity checks in dev restore tooling.
 */
export const NAUTILO_ESSENTIAL_SELECT_TABLE = "profiles";

const PUBLIC_RELKINDS = ["r", "p", "S", "v", "m", "f"] as const;
const PUBLIC_RELKINDS_SQL = PUBLIC_RELKINDS.map((k) => `'${k}'`).join(", ");

/**
 * Probe: count of existing `public` relations not owned by {@link NAUTILO_APP_ROLE}.
 * Superuser-safe; read-only. Returns a single integer as text.
 */
export const PROBE_PUBLIC_OBJECTS_NOT_OWNED_SQL = `
SELECT count(*)::text
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
  AND c.relkind IN (${PUBLIC_RELKINDS_SQL})
  AND pg_catalog.pg_get_userbyid(c.relowner) <> '${NAUTILO_APP_ROLE}';
`.trim();

/**
 * Probe: whether {@link NAUTILO_APP_ROLE} has SELECT on the essential table.
 * Returns `ok`, `missing`, or `skip` (when the table does not exist yet).
 */
export const PROBE_NAUTILO_ESSENTIAL_SELECT_SQL = `
SELECT CASE
  WHEN NOT EXISTS (
    SELECT 1 FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relname = '${NAUTILO_ESSENTIAL_SELECT_TABLE}'
      AND n.nspname = 'public'
      AND c.relkind = 'r'
  ) THEN 'skip'
  WHEN has_table_privilege(
    '${NAUTILO_APP_ROLE}',
    'public.${NAUTILO_ESSENTIAL_SELECT_TABLE}',
    'SELECT'
  ) THEN 'ok'
  ELSE 'missing'
END;
`.trim();

/**
 * Idempotent pgvector install for the app-postgres cluster (`nautilo` DB).
 *
 * Runs as superuser during deploy/restore repair (see
 * {@link buildFullLegacyRoleRepairSql}). Fresh volumes get vector from
 * `infra/postgres-init.sh` on first boot; existing volumes skip init, so
 * this repair path must install vector before migrations run as `nautilo`.
 *
 * App-postgres only — never run against logto-postgres (plain postgres:16).
 * Fails with a clear error when the image does not ship pgvector.
 */
export function buildVectorExtensionRepairSql(): string {
  return `
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_available_extensions WHERE name = 'vector') THEN
    RAISE EXCEPTION 'vector extension is not available on this Postgres image; app-postgres must use the pgvector image (e.g. pgvector/pgvector:pg17)';
  END IF;
END $$;

CREATE EXTENSION IF NOT EXISTS vector;
`.trim();
}

/**
 * Idempotent ownership + grant repair for legacy databases where `public`
 * objects were created under the `postgres` superuser. Safe for superuser
 * execution inside the `nautilo` database; does not alter schema or data.
 *
 * Covers tables, sequences, views, materialized views, foreign tables, and
 * non-extension routines. Routine ownership matters because PostgreSQL only
 * allows the owner (or a superuser) to run CREATE OR REPLACE during a later
 * application migration.
 */
export function buildAppRoleOwnershipRepairSql(): string {
  return `
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT c.relname AS name, c.relkind
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relkind IN (${PUBLIC_RELKINDS_SQL})
      AND pg_catalog.pg_get_userbyid(c.relowner) <> '${NAUTILO_APP_ROLE}'
      -- A serial/identity sequence follows its owning table automatically.
      -- PostgreSQL rejects changing that sequence owner independently.
      AND (
        c.relkind <> 'S'
        OR NOT EXISTS (
          SELECT 1
          FROM pg_depend d
          WHERE d.objid = c.oid
            AND d.deptype = 'a'
        )
      )
  LOOP
    CASE r.relkind
      WHEN 'S' THEN
        EXECUTE format('ALTER SEQUENCE public.%I OWNER TO ${NAUTILO_APP_ROLE}', r.name);
      WHEN 'v' THEN
        EXECUTE format('ALTER VIEW public.%I OWNER TO ${NAUTILO_APP_ROLE}', r.name);
      WHEN 'm' THEN
        EXECUTE format('ALTER MATERIALIZED VIEW public.%I OWNER TO ${NAUTILO_APP_ROLE}', r.name);
      WHEN 'f' THEN
        EXECUTE format('ALTER FOREIGN TABLE public.%I OWNER TO ${NAUTILO_APP_ROLE}', r.name);
      ELSE
        EXECUTE format('ALTER TABLE public.%I OWNER TO ${NAUTILO_APP_ROLE}', r.name);
    END CASE;
  END LOOP;
END $$;

DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT
      p.proname AS name,
      p.prokind,
      pg_get_function_identity_arguments(p.oid) AS identity_arguments
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND pg_catalog.pg_get_userbyid(p.proowner) <> '${NAUTILO_APP_ROLE}'
      -- Extension-owned routines follow the extension lifecycle and must not
      -- be adopted by the application migration role.
      AND NOT EXISTS (
        SELECT 1
        FROM pg_depend d
        WHERE d.classid = 'pg_proc'::regclass
          AND d.objid = p.oid
          AND d.deptype = 'e'
      )
  LOOP
    CASE r.prokind
      WHEN 'p' THEN
        EXECUTE format(
          'ALTER PROCEDURE public.%I(%s) OWNER TO ${NAUTILO_APP_ROLE}',
          r.name,
          r.identity_arguments
        );
      WHEN 'a' THEN
        EXECUTE format(
          'ALTER AGGREGATE public.%I(%s) OWNER TO ${NAUTILO_APP_ROLE}',
          r.name,
          r.identity_arguments
        );
      ELSE
        EXECUTE format(
          'ALTER FUNCTION public.%I(%s) OWNER TO ${NAUTILO_APP_ROLE}',
          r.name,
          r.identity_arguments
        );
    END CASE;
  END LOOP;
END $$;

GRANT USAGE ON SCHEMA public TO ${NAUTILO_APP_ROLE};
GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO ${NAUTILO_APP_ROLE};
GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public TO ${NAUTILO_APP_ROLE};

ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  GRANT ALL ON TABLES TO ${NAUTILO_APP_ROLE};
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  GRANT ALL ON SEQUENCES TO ${NAUTILO_APP_ROLE};
`.trim();
}

/**
 * Full legacy repair for an existing populated `nautilo` database:
 * pgvector install first, then app-role ownership/grants, then the
 * restricted `nautilo_agent` grant/revoke/view contract from
 * {@link buildAgentRoleGrantsSql}, and finally exact crypto-table privilege
 * reconciliation. The caller must provision `nautilo_crypto` first.
 */
export function buildFullLegacyRoleRepairSql(): string {
  return [
    buildVectorExtensionRepairSql(),
    buildEventFeedReaderRoleSql(),
    buildAppRoleOwnershipRepairSql(),
    buildAgentRoleGrantsSql().trim(),
    buildFullCryptoTablePrivilegeReconcileSql(),
  ].join("\n\n");
}
