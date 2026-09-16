import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

export const M244_BACKGROUND_AUTHORITY_SETS_MARKER =
  "-- M244_BACKGROUND_AUTHORITY_SETS";

const AUTHORITY_SET_TABLES = [
  "background_crypto_authorization_domain_requirements",
  "background_crypto_authorization_namespace_requirements",
] as const;

function renderAuthoritySql(): string {
  const quotedTables = AUTHORITY_SET_TABLES.map((table) => `"${table}"`);
  return `${M244_BACKGROUND_AUTHORITY_SETS_MARKER}
ALTER TABLE ${quotedTables[0]}
  FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE ${quotedTables[1]}
  FORCE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL PRIVILEGES ON TABLE
  ${quotedTables.join(",\n  ")}
FROM PUBLIC, "nautilo", "nautilo_agent", "nautilo_crypto";--> statement-breakpoint
GRANT SELECT, INSERT, DELETE ON TABLE
  ${quotedTables.join(",\n  ")}
TO "nautilo_crypto";`;
}

export function finalizeM244BackgroundAuthoritySetsMigration(
  migration: string,
): string {
  const createdTables = AUTHORITY_SET_TABLES.filter((table) =>
    migration.includes(`CREATE TABLE "${table}"`)
  );
  if (
    createdTables.length > 0
    && createdTables.length !== AUTHORITY_SET_TABLES.length
  ) {
    throw new Error(
      `Refusing partial M244 authority-set finalization: found ${
        createdTables.length
      }/${AUTHORITY_SET_TABLES.length} tables`,
    );
  }
  if (createdTables.length === 0) return migration;

  if (migration.includes(M244_BACKGROUND_AUTHORITY_SETS_MARKER)) {
    return migration;
  }

  const separator = migration.endsWith("\n") ? "" : "\n";
  return `${migration}${separator}--> statement-breakpoint
${renderAuthoritySql()}
`;
}

function run(): void {
  const migrationsDir = resolve(import.meta.dir, "../src/migrations");
  const journal = JSON.parse(
    readFileSync(resolve(migrationsDir, "meta/_journal.json"), "utf8"),
  ) as {
    entries: readonly { idx: number; tag: string }[];
  };
  const latest = journal.entries.at(-1);
  if (latest === undefined) throw new Error("Migration journal is empty");

  const migrationPath = resolve(migrationsDir, `${latest.tag}.sql`);
  const migration = readFileSync(migrationPath, "utf8");
  const finalized = finalizeM244BackgroundAuthoritySetsMigration(migration);
  if (finalized === migration) return;
  writeFileSync(migrationPath, finalized, {
    encoding: "utf8",
    flag: "w",
    mode: 0o600,
  });
}

if (import.meta.main) run();
