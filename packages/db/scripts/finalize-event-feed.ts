import { buildEventFeedReaderRoleSql } from "../src/utils/event-feed-role";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const marker = "-- EVENT_FEED_AUTHORITY";
/** Drizzle generates tables/policies; FORCE RLS and role grants require SQL. */
export function finalizeEventFeedMigration(migration: string): string {
  if (!migration.includes('CREATE TABLE "feed_events"') || migration.includes(marker)) return migration;
  const roleSetup = `${buildEventFeedReaderRoleSql()}--> statement-breakpoint\n`;
  return `${roleSetup}${migration}\n--> statement-breakpoint\n${marker}
ALTER TABLE "feed_events" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "feed_recipients" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL ON TABLE "feed_events", "feed_recipients" FROM PUBLIC, "nautilo_agent", "nautilo_crypto";--> statement-breakpoint
GRANT SELECT, INSERT ON TABLE "feed_events" TO "nautilo";--> statement-breakpoint
GRANT SELECT, INSERT ON TABLE "feed_recipients" TO "nautilo";--> statement-breakpoint
GRANT USAGE ON SCHEMA "public" TO "nautilo_feed_reader";--> statement-breakpoint
GRANT SELECT ON TABLE "feed_events", "feed_recipients" TO "nautilo_feed_reader";--> statement-breakpoint
GRANT UPDATE ("read_at") ON TABLE "feed_recipients" TO "nautilo_feed_reader";\n`;
}

if (import.meta.main) {
  const root = resolve(import.meta.dir, "../src/migrations");
  const journal = JSON.parse(readFileSync(resolve(root, "meta/_journal.json"), "utf8")) as { entries: { tag: string }[] };
  const latest = journal.entries.at(-1);
  if (!latest) throw new Error("Migration journal is empty");
  const path = resolve(root, `${latest.tag}.sql`);
  const source = readFileSync(path, "utf8");
  const result = finalizeEventFeedMigration(source);
  if (result !== source) writeFileSync(path, result);
}
