import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const TABLES = ["task_cancellation_crypto_staging_receipts", "task_terminal_message_crypto_staging_receipts",
  "task_historical_content_crypto_staging_receipts", "foreground_memory_crypto_publication_receipts"] as const;
export const TASK_CANCELLATION_STAGING_AUTHORITY_MARKER =
  "-- TASK_CANCELLATION_CRYPTO_STAGING_AUTHORITY";

/** Drizzle owns the table and policies; role privileges and forced RLS need SQL. */
export function finalizeTaskCancellationStagingMigration(
  migration: string,
): string {
  let result = migration;
  for (const table of TABLES) {
    const marker = table === "task_cancellation_crypto_staging_receipts"
      ? TASK_CANCELLATION_STAGING_AUTHORITY_MARKER
      : table === "task_terminal_message_crypto_staging_receipts"
      ? "-- TASK_TERMINAL_MESSAGE_CRYPTO_STAGING_AUTHORITY"
      : table === "task_historical_content_crypto_staging_receipts"
      ? "-- TASK_HISTORICAL_CONTENT_CRYPTO_STAGING_AUTHORITY"
      : "-- FOREGROUND_MEMORY_CRYPTO_PUBLICATION_AUTHORITY";
    if (!result.includes(`CREATE TABLE "${table}"`) || result.includes(marker)) continue;
    result = `${result}${result.endsWith("\n") ? "" : "\n"}--> statement-breakpoint
${marker}
ALTER TABLE "${table}" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL PRIVILEGES ON TABLE "${table}" FROM PUBLIC, "nautilo", "nautilo_agent", "nautilo_crypto";--> statement-breakpoint
GRANT SELECT, INSERT ON TABLE "${table}" TO "nautilo_crypto";
`;
    if (table === "foreground_memory_crypto_publication_receipts") {
      result += `--> statement-breakpoint
CREATE FUNCTION "public"."reject_foreground_memory_publication_update"()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog AS $$
BEGIN
  IF NEW IS DISTINCT FROM OLD THEN
    RAISE EXCEPTION 'Foreground Memory publication receipt is immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION "public"."reject_foreground_memory_publication_update"() FROM PUBLIC, "nautilo", "nautilo_agent", "nautilo_crypto";--> statement-breakpoint
CREATE TRIGGER "foreground_memory_publication_immutable" BEFORE UPDATE ON "${table}" FOR EACH ROW
EXECUTE FUNCTION "public"."reject_foreground_memory_publication_update"();
`;
    }
  }
  return result;
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
