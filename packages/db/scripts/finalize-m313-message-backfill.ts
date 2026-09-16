import {readFileSync, writeFileSync} from "node:fs";
import {resolve} from "node:path";

const marker = "-- M313_MESSAGE_BACKFILL_AUTHORITY";
/** Drizzle does not model FORCE RLS or table grants. Keep them with generated schema. */
export function finalizeM313MessageBackfillMigration(migration: string): string {
  if (migration.includes(marker) || !migration.includes('CREATE TABLE "message_backfill_scans"')) return migration;
  const authority = ["message_backfill_scans", "message_backfill_failures"].map((table) => `
ALTER TABLE "${table}" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL PRIVILEGES ON TABLE "${table}" FROM PUBLIC, "nautilo_agent", "nautilo_crypto";--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "${table}" TO "nautilo";`).join("\n--> statement-breakpoint\n");
  return `${migration}\n--> statement-breakpoint\n${marker}\n${authority}\n`;
}

if (import.meta.main) {
  const directory = resolve(import.meta.dir, "../src/migrations");
  const journal = JSON.parse(readFileSync(resolve(directory, "meta/_journal.json"), "utf8")) as {entries: {tag: string}[]};
  const last = journal.entries.at(-1);
  if (last === undefined) throw new Error("Migration journal is empty");
  const path = resolve(directory, `${last.tag}.sql`);
  const original = readFileSync(path, "utf8");
  const finalized = finalizeM313MessageBackfillMigration(original);
  if (finalized !== original) writeFileSync(path, finalized);
}
