import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

export const M241_BACKGROUND_AUTHORITY_MARKER =
  "-- M241_BACKGROUND_AUTHORIZATION_AUTHORITY";
export const M241_JOURNAL_PUBLICATION_AUTHORITY_MARKER =
  "-- M241_JOURNAL_CRYPTO_PUBLICATION_AUTHORITY";

const CRYPTO_TABLES = [
  "background_crypto_authorization_requests",
  "processor_crypto_signer_authorizations",
] as const;
const JOURNAL_PUBLICATION_TABLE = "room_journal_crypto_publications";

function renderBackgroundAuthoritySql(): string {
  return `${M241_BACKGROUND_AUTHORITY_MARKER}
ALTER TABLE "background_crypto_authorization_requests"
  FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "processor_crypto_signer_authorizations"
  FORCE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL PRIVILEGES ON TABLE
  "background_crypto_authorization_requests",
  "processor_crypto_signer_authorizations"
FROM PUBLIC, "nautilo", "nautilo_agent", "nautilo_crypto";--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE
  "background_crypto_authorization_requests"
TO "nautilo_crypto";--> statement-breakpoint
GRANT SELECT, INSERT ON TABLE
  "processor_crypto_signer_authorizations"
TO "nautilo_crypto";`;
}

function renderJournalPublicationAuthoritySql(): string {
  return `${M241_JOURNAL_PUBLICATION_AUTHORITY_MARKER}
REVOKE ALL PRIVILEGES ON TABLE "room_journal_crypto_publications"
FROM PUBLIC, "nautilo_agent", "nautilo_crypto";`;
}

export function finalizeM241BackgroundAuthorizationMigration(
  migration: string,
): string {
  const createdCryptoTables = CRYPTO_TABLES.filter((table) =>
    migration.includes(`CREATE TABLE "${table}"`)
  );
  if (
    createdCryptoTables.length > 0
    && createdCryptoTables.length !== CRYPTO_TABLES.length
  ) {
    throw new Error(
      `Refusing partial M241 crypto authority finalization: found ${
        createdCryptoTables.length
      }/${CRYPTO_TABLES.length} tables`,
    );
  }

  const additions: string[] = [];
  if (
    createdCryptoTables.length === CRYPTO_TABLES.length
    && !migration.includes(M241_BACKGROUND_AUTHORITY_MARKER)
  ) {
    additions.push(renderBackgroundAuthoritySql());
  }
  if (
    migration.includes(`CREATE TABLE "${JOURNAL_PUBLICATION_TABLE}"`)
    && !migration.includes(M241_JOURNAL_PUBLICATION_AUTHORITY_MARKER)
  ) {
    additions.push(renderJournalPublicationAuthoritySql());
  }
  if (additions.length === 0) return migration;

  const separator = migration.endsWith("\n") ? "" : "\n";
  return `${migration}${separator}--> statement-breakpoint
${additions.join("\n--> statement-breakpoint\n")}
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
  if (latest === undefined) {
    throw new Error("Migration journal is empty");
  }
  const migrationPath = resolve(migrationsDir, `${latest.tag}.sql`);
  const migration = readFileSync(migrationPath, "utf8");
  const finalized = finalizeM241BackgroundAuthorizationMigration(migration);
  if (finalized === migration) return;
  writeFileSync(migrationPath, finalized, {
    encoding: "utf8",
    flag: "w",
    mode: 0o600,
  });
}

if (import.meta.main) run();
