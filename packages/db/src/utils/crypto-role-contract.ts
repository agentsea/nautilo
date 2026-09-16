import { CRYPTO_STORAGE_TABLE_PRIVILEGES } from "../schema/crypto-storage";
import { DOMAIN_KEY_AUTHORITY_TABLE_PRIVILEGES } from "../schema/domain-key-authority";

/**
 * M231 — declarative database identity for the dormant lattice bridge.
 *
 * The password is read by psql from the app-postgres container environment,
 * then sent through an extended-query bind. It is never interpolated into the
 * returned SQL text or a host-side command line.
 */
export const CRYPTO_DB_ROLE = "nautilo_crypto" as const;
export const CRYPTO_DB_PASSWORD_ENV_KEY =
  "NAUTILO_CRYPTO_DB_PASSWORD" as const;
export const CRYPTO_DB_ROLE_ATTRIBUTES = [
  "NOSUPERUSER",
  "NOCREATEDB",
  "NOCREATEROLE",
  "NOINHERIT",
  "NOREPLICATION",
  "NOBYPASSRLS",
] as const;

const ROLE_ATTRIBUTES_SQL = CRYPTO_DB_ROLE_ATTRIBUTES.join(" ");
const TABLE_PRIVILEGE_ORDER = [
  "SELECT",
  "INSERT",
  "UPDATE",
  "DELETE",
] as const;
const CRYPTO_APP_DENIED_TABLES = new Set([
  "background_crypto_authorization_requests",
  "background_crypto_authorization_domain_requirements",
  "background_crypto_authorization_namespace_requirements",
  "processor_crypto_signer_authorizations",
]);
export type CryptoTablePrivilege = (typeof TABLE_PRIVILEGE_ORDER)[number];
export const CRYPTO_IDENTITY_READ_COLUMNS = Object.freeze({
  users: Object.freeze(["id"]),
  actors: Object.freeze(["id", "owner_id", "kind"]),
  nautilo_instance_identity: Object.freeze(["id", "server_instance_id"]),
} as const);

/** Complete direct-login privilege inventory for the current crypto store. */
export const CRYPTO_TABLE_PRIVILEGES = Object.freeze({
  ...CRYPTO_STORAGE_TABLE_PRIVILEGES,
  ...DOMAIN_KEY_AUTHORITY_TABLE_PRIVILEGES,
});

/**
 * Full, idempotent role reconciliation and verification script.
 *
 * This deliberately owns only the cluster role and database-level boundary.
 * Wave-6 table grants/policies are migration-owned because they must name the
 * exact generated schema objects. The migration/repair path may append those
 * exact grants to this script once the schema symbols exist.
 */
export function buildCryptoRoleReconcilePsqlScript(options?: {
  password?: string;
}): string {
  const passwordSource = (() => {
    if (options?.password === undefined) {
      return String.raw`\getenv crypto_password ${CRYPTO_DB_PASSWORD_ENV_KEY}`;
    }
    if (options.password.trim() === "" || /[\r\n]/.test(options.password)) {
      throw new Error(
        "crypto-role reconciliation received an empty or multiline credential",
      );
    }
    return String.raw`\set crypto_password '${options.password.replace(/'/g, "''")}'`;
  })();
  return String.raw`${passwordSource}
\if :{?crypto_password}
\else
\echo 'missing required internal crypto database credential'
\quit 3
\endif
BEGIN;
SELECT length($1) > 0 AS crypto_password_present
\bind :crypto_password
\gset
\if :crypto_password_present
\else
\echo 'empty required internal crypto database credential'
\quit 3
\endif
SELECT set_config('nautilo.crypto_role_password', $1, true)
\bind :crypto_password
\g
DO $do$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${CRYPTO_DB_ROLE}') THEN
    EXECUTE format(
      'CREATE ROLE ${CRYPTO_DB_ROLE} LOGIN ${ROLE_ATTRIBUTES_SQL} PASSWORD %L',
      current_setting('nautilo.crypto_role_password')
    );
  ELSE
    EXECUTE format(
      'ALTER ROLE ${CRYPTO_DB_ROLE} WITH LOGIN ${ROLE_ATTRIBUTES_SQL} PASSWORD %L',
      current_setting('nautilo.crypto_role_password')
    );
  END IF;
END
$do$;
DO $memberships$
DECLARE
  granted_role record;
BEGIN
  FOR granted_role IN
    SELECT parent.rolname
      FROM pg_auth_members membership
      JOIN pg_roles parent ON parent.oid = membership.roleid
      JOIN pg_roles member ON member.oid = membership.member
     WHERE member.rolname = '${CRYPTO_DB_ROLE}'
  LOOP
    EXECUTE format(
      'REVOKE %I FROM ${CRYPTO_DB_ROLE}',
      granted_role.rolname
    );
  END LOOP;
END
$memberships$;
REVOKE ALL ON DATABASE nautilo FROM ${CRYPTO_DB_ROLE};
GRANT CONNECT ON DATABASE nautilo TO ${CRYPTO_DB_ROLE};
REVOKE ALL ON DATABASE logto_nautilo FROM ${CRYPTO_DB_ROLE};
DO $verify$
DECLARE
  attrs record;
BEGIN
  SELECT rolsuper, rolcreatedb, rolcreaterole, rolinherit, rolreplication,
         rolbypassrls, rolcanlogin
    INTO attrs
    FROM pg_roles
   WHERE rolname = '${CRYPTO_DB_ROLE}';
  IF NOT FOUND
     OR attrs.rolsuper
     OR attrs.rolcreatedb
     OR attrs.rolcreaterole
     OR attrs.rolinherit
     OR attrs.rolreplication
     OR attrs.rolbypassrls
     OR NOT attrs.rolcanlogin THEN
    RAISE EXCEPTION 'nautilo_crypto role attributes do not match the M231 contract';
  END IF;
  IF EXISTS (
    SELECT 1
      FROM pg_auth_members membership
      JOIN pg_roles member ON member.oid = membership.member
     WHERE member.rolname = '${CRYPTO_DB_ROLE}'
  ) THEN
    RAISE EXCEPTION 'nautilo_crypto role membership does not match the M231 contract';
  END IF;
  IF NOT has_database_privilege('${CRYPTO_DB_ROLE}', 'nautilo', 'CONNECT')
     OR has_database_privilege('${CRYPTO_DB_ROLE}', 'nautilo', 'CREATE')
     OR has_database_privilege('${CRYPTO_DB_ROLE}', 'nautilo', 'TEMP') THEN
    RAISE EXCEPTION 'nautilo_crypto database privileges do not match the M231 contract';
  END IF;
END
$verify$;
COMMIT;`;
}

function assertSqlIdentifier(value: string): void {
  if (!/^[a-z_][a-z0-9_]*$/.test(value)) {
    throw new Error(`invalid crypto database object identifier: ${value}`);
  }
}

/**
 * Exact, schema-owned grants/revokes for the generated Wave-6 tables.
 *
 * Callers must pass the canonical enumerated table/sequence lists; broad
 * ALL-TABLE defaults are intentionally impossible through this API.
 */
export function buildCryptoTablePrivilegeReconcileSql(input: {
  /**
   * Every table must declare its exact runtime operations. Requiring a
   * per-table map keeps immutable history rows from accidentally inheriting
   * UPDATE or DELETE merely because a mutable head table needs them.
   */
  tablePrivileges: Readonly<
    Record<string, readonly CryptoTablePrivilege[]>
  >;
  /**
   * Exact non-crypto identity columns needed to validate the immutable
   * User/Human/Actor tuple inside the crypto transaction. Full-table product
   * reads are intentionally impossible through this API.
   */
  readColumns?: Readonly<Record<string, readonly string[]>>;
  sequences?: readonly string[];
}): string {
  const entries = Object.entries(input.tablePrivileges);
  const readColumnEntries = Object.entries(input.readColumns ?? {});
  if (entries.length === 0) {
    throw new Error("crypto table privilege map must not be empty");
  }
  for (const [name, privileges] of entries) {
    assertSqlIdentifier(name);
    if (privileges.length === 0) {
      throw new Error(`crypto table privilege list must not be empty: ${name}`);
    }
    const unique = new Set(privileges);
    if (unique.size !== privileges.length) {
      throw new Error(`duplicate crypto table privilege: ${name}`);
    }
    for (const privilege of privileges) {
      if (!TABLE_PRIVILEGE_ORDER.includes(privilege)) {
        throw new Error(`invalid crypto table privilege: ${name}.${privilege}`);
      }
    }
    if (!unique.has("SELECT")) {
      throw new Error(`crypto table privilege map must grant SELECT: ${name}`);
    }
  }
  for (const [table, columns] of readColumnEntries) {
    assertSqlIdentifier(table);
    if (columns.length === 0) {
      throw new Error(`crypto column read list must not be empty: ${table}`);
    }
    const unique = new Set(columns);
    if (unique.size !== columns.length) {
      throw new Error(`duplicate crypto column read: ${table}`);
    }
    for (const column of columns) assertSqlIdentifier(column);
  }
  for (const name of input.sequences ?? []) assertSqlIdentifier(name);
  const allowedTables = entries
    .map(([name]) => `'${name}'`)
    .join(", ");
  const statements = [
    `DO $schemas$
DECLARE
  schema_record record;
BEGIN
  FOR schema_record IN
    SELECT nspname
      FROM pg_namespace
     WHERE nspname NOT IN ('pg_catalog', 'information_schema')
       AND nspname NOT LIKE 'pg_toast%'
  LOOP
    EXECUTE format(
      'REVOKE ALL ON SCHEMA %I FROM ${CRYPTO_DB_ROLE}',
      schema_record.nspname
    );
  END LOOP;
END
$schemas$;`,
    `DO $unexpected_table_privileges$
DECLARE
  privilege_record record;
BEGIN
  FOR privilege_record IN
    SELECT DISTINCT table_schema, table_name
      FROM information_schema.role_table_grants
     WHERE grantee = '${CRYPTO_DB_ROLE}'
       AND (
         table_schema <> 'public'
         OR table_name NOT IN (${allowedTables})
       )
  LOOP
    RAISE NOTICE 'removing unexpected direct table privilege from %.%',
      privilege_record.table_schema,
      privilege_record.table_name;
    EXECUTE format(
      'REVOKE ALL PRIVILEGES ON TABLE %I.%I FROM ${CRYPTO_DB_ROLE}',
      privilege_record.table_schema,
      privilege_record.table_name
    );
  END LOOP;
END
$unexpected_table_privileges$;`,
    `DO $column_privileges$
DECLARE
  privilege_record record;
BEGIN
  FOR privilege_record IN
    SELECT table_schema, table_name, column_name, privilege_type
      FROM information_schema.role_column_grants
     WHERE grantee = '${CRYPTO_DB_ROLE}'
  LOOP
    EXECUTE format(
      'REVOKE %s (%I) ON TABLE %I.%I FROM ${CRYPTO_DB_ROLE}',
      privilege_record.privilege_type,
      privilege_record.column_name,
      privilege_record.table_schema,
      privilege_record.table_name
    );
  END LOOP;
END
$column_privileges$;`,
    `REVOKE ALL ON SCHEMA public FROM ${CRYPTO_DB_ROLE};`,
    `GRANT USAGE ON SCHEMA public TO ${CRYPTO_DB_ROLE};`,
  ];
  const guardedPrivilegeStatements = [
    "DO $crypto_object_privileges$",
    "BEGIN",
  ];
  for (const [table, requestedPrivileges] of entries) {
    const privileges = TABLE_PRIVILEGE_ORDER.filter((privilege) =>
      requestedPrivileges.includes(privilege),
    );
    const deniedRoles = CRYPTO_APP_DENIED_TABLES.has(table)
      ? "PUBLIC, nautilo, nautilo_agent"
      : "PUBLIC, nautilo_agent";
    guardedPrivilegeStatements.push(
      `  IF to_regclass('public.${table}') IS NOT NULL THEN`,
      `    EXECUTE 'REVOKE ALL ON TABLE public.${table} FROM ${deniedRoles}';`,
      `    EXECUTE 'REVOKE ALL ON TABLE public.${table} FROM ${CRYPTO_DB_ROLE}';`,
      `    EXECUTE 'GRANT ${privileges.join(", ")} ON TABLE public.${table} TO ${CRYPTO_DB_ROLE}';`,
      "  END IF;",
    );
  }
  for (const sequence of input.sequences ?? []) {
    guardedPrivilegeStatements.push(
      `  IF to_regclass('public.${sequence}') IS NOT NULL THEN`,
      `    EXECUTE 'REVOKE ALL ON SEQUENCE public.${sequence} FROM PUBLIC, nautilo_agent';`,
      `    EXECUTE 'REVOKE ALL ON SEQUENCE public.${sequence} FROM ${CRYPTO_DB_ROLE}';`,
      `    EXECUTE 'GRANT USAGE, SELECT ON SEQUENCE public.${sequence} TO ${CRYPTO_DB_ROLE}';`,
      "  END IF;",
    );
  }
  for (const [table, columns] of readColumnEntries) {
    guardedPrivilegeStatements.push(
      `  IF to_regclass('public.${table}') IS NOT NULL THEN`,
      `    EXECUTE 'GRANT SELECT (${columns.join(", ")}) ON TABLE public.${table} TO ${CRYPTO_DB_ROLE}';`,
      "  END IF;",
    );
  }
  guardedPrivilegeStatements.push("END", "$crypto_object_privileges$;");
  statements.push(guardedPrivilegeStatements.join("\n"));
  return statements.join("\n");
}

/** Canonical no-argument operator repair for the complete Wave-6 table set. */
export function buildFullCryptoTablePrivilegeReconcileSql(): string {
  return buildCryptoTablePrivilegeReconcileSql({
    tablePrivileges: CRYPTO_TABLE_PRIVILEGES,
    readColumns: CRYPTO_IDENTITY_READ_COLUMNS,
  });
}
