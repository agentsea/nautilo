import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const TABLE = "task_cancellation_crypto_staging_receipts";
export const TASK_CANCELLATION_STAGING_AUTHORITY_MARKER =
  "-- TASK_CANCELLATION_CRYPTO_STAGING_AUTHORITY";

/** Drizzle owns the table and policies; role privileges and forced RLS need SQL. */
export function finalizeTaskCancellationStagingMigration(
  migration: string,
): string {
  if (
    !migration.includes(`CREATE TABLE "${TABLE}"`)
    || migration.includes(TASK_CANCELLATION_STAGING_AUTHORITY_MARKER)
  ) {
    return migration;
  }
  return `${migration}${migration.endsWith("\n") ? "" : "\n"}--> statement-breakpoint
${TASK_CANCELLATION_STAGING_AUTHORITY_MARKER}
ALTER TABLE "${TABLE}" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL PRIVILEGES ON TABLE "${TABLE}" FROM PUBLIC, "nautilo", "nautilo_agent", "nautilo_crypto";--> statement-breakpoint
GRANT SELECT, INSERT ON TABLE "${TABLE}" TO "nautilo_crypto";
`;
}

function run(): void {
  const directory = resolve(import.meta.dir, "../src/migrations");
  const journal = JSON.parse(
    readFileSync(resolve(directory, "meta/_journal.json"), "utf8"),
  ) as { entries: readonly { tag: string }[] };
  const latest = journal.entries.at(-1);
  if (latest === undefined) throw new Error("Migration journal is empty");
  const path = resolve(directory, `${latest.tag}.sql`);
  const source = readFileSync(path, "utf8");
  const finalized = finalizeTaskCancellationStagingMigration(source);
  if (finalized !== source) writeFileSync(path, finalized, "utf8");
}

if (import.meta.main) run();
