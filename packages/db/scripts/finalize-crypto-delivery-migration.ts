import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  CRYPTO_DELIVERY_TABLE_NAMES,
  CRYPTO_STORAGE_TABLE_PRIVILEGES,
  type CryptoStorageTableName,
} from "../src/schema/crypto-storage.ts";
import { CRYPTO_IDENTITY_READ_COLUMNS } from "../src/utils/crypto-role-contract.ts";

const MARKER = "-- M232_CRYPTO_DELIVERY_AUTHORITY";
const IDENTITY_READ_MARKER = "-- M232_CRYPTO_IDENTITY_READ_AUTHORITY";
const migrationsDir = resolve(import.meta.dir, "../src/migrations");
const journalPath = resolve(migrationsDir, "meta/_journal.json");

interface Journal {
  readonly entries: readonly {
    readonly idx: number;
    readonly tag: string;
  }[];
}

function quoteIdentifier(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}

function renderAuthoritySql(
  tableNames: readonly CryptoStorageTableName[],
): string {
  const tables = tableNames.map(quoteIdentifier);
  const statements = [
    MARKER,
    ...tables.map(
      (table) => `ALTER TABLE ${table} FORCE ROW LEVEL SECURITY;`,
    ),
    [
      "REVOKE ALL PRIVILEGES ON TABLE",
      `  ${tables.join(",\n  ")}`,
      'FROM PUBLIC, "nautilo_agent", "nautilo_crypto";',
    ].join("\n"),
  ];

  const grouped = new Map<string, string[]>();
  for (const table of tableNames) {
    const privileges = CRYPTO_STORAGE_TABLE_PRIVILEGES[table].join(", ");
    const group = grouped.get(privileges) ?? [];
    group.push(quoteIdentifier(table));
    grouped.set(privileges, group);
  }
  for (const [privileges, group] of grouped) {
    statements.push(
      [
        `GRANT ${privileges} ON TABLE`,
        `  ${group.join(",\n  ")}`,
        'TO "nautilo_crypto";',
      ].join("\n"),
    );
  }

  return statements.join("--> statement-breakpoint\n");
}

function renderIdentityReadAuthoritySql(): string {
  const tableNames = Object.keys(CRYPTO_IDENTITY_READ_COLUMNS);
  const quotedTables = tableNames.map(quoteIdentifier);
  const statements = [
    IDENTITY_READ_MARKER,
    [
      "REVOKE ALL PRIVILEGES ON TABLE",
      `  ${quotedTables.join(",\n  ")}`,
      'FROM "nautilo_crypto";',
    ].join("\n"),
    [
      "DO $crypto_identity_column_privileges$",
      "DECLARE",
      "  privilege_record record;",
      "BEGIN",
      "  FOR privilege_record IN",
      "    SELECT table_name, column_name, privilege_type",
      "      FROM information_schema.role_column_grants",
      `     WHERE grantee = 'nautilo_crypto'`,
      `       AND table_schema = 'public'`,
      `       AND table_name IN (${tableNames.map((name) => `'${name}'`).join(", ")})`,
      "  LOOP",
      "    EXECUTE format(",
      `      'REVOKE %s (%I) ON TABLE public.%I FROM nautilo_crypto',`,
      "      privilege_record.privilege_type,",
      "      privilege_record.column_name,",
      "      privilege_record.table_name",
      "    );",
      "  END LOOP;",
      "END",
      "$crypto_identity_column_privileges$;",
    ].join("\n"),
    ...Object.entries(CRYPTO_IDENTITY_READ_COLUMNS).map(
      ([table, columns]) =>
        `GRANT SELECT (${columns.map(quoteIdentifier).join(", ")}) ON TABLE ${
          quoteIdentifier(table)
        } TO "nautilo_crypto";`,
    ),
  ];
  return statements.join("--> statement-breakpoint\n");
}

const journal = JSON.parse(readFileSync(journalPath, "utf8")) as Journal;
const latest = journal.entries.at(-1);
if (!latest) {
  throw new Error("Migration journal is empty");
}

const migrationPath = resolve(migrationsDir, `${latest.tag}.sql`);
const migration = readFileSync(migrationPath, "utf8");
const createdDeliveryTables = CRYPTO_DELIVERY_TABLE_NAMES.filter((table) =>
  migration.includes(`CREATE TABLE "${table}"`)
);
const changesDeliveryAuthority = migration.includes(
  'CREATE POLICY "crypto_delivery_operations_crypto_del"',
);

if (createdDeliveryTables.length === 0 && !changesDeliveryAuthority) {
  process.exit(0);
}
const additions = [];
if (!migration.includes(MARKER)) {
  additions.push(renderAuthoritySql(
    createdDeliveryTables.length > 0
      ? createdDeliveryTables
      : CRYPTO_DELIVERY_TABLE_NAMES,
  ));
}
if (
  createdDeliveryTables.includes("human_crypto_custodies")
  && !migration.includes(IDENTITY_READ_MARKER)
) {
  additions.push(renderIdentityReadAuthoritySql());
}
if (additions.length === 0) {
  process.exit(0);
}

const separator = migration.endsWith("\n") ? "" : "\n";
writeFileSync(
  migrationPath,
  `${migration}${separator}--> statement-breakpoint\n${
    additions.join("\n--> statement-breakpoint\n")
  }\n`,
  { encoding: "utf8", flag: "w", mode: 0o600 },
);
