import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

/** Mirror personal-key custody: only the trusted product role sees envelopes. */
export function finalizeChatGPTRegistrations(source: string): string {
  const marker = "-- ChatGPT registration custody permissions";
  if (!source.includes('CREATE TABLE "chatgpt_registrations"') || source.includes(marker)) return source;
  return `${source}\n--> statement-breakpoint\n${marker}
REVOKE ALL PRIVILEGES ON TABLE "chatgpt_registrations"
  FROM PUBLIC, "nautilo_agent", "nautilo_crypto";--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "chatgpt_registrations"
  TO "nautilo";\n`;
}
if (import.meta.main) {
  const directory = resolve(import.meta.dir, "../src/migrations");
  const journal = JSON.parse(readFileSync(resolve(directory, "meta/_journal.json"), "utf8")) as { entries: { tag: string }[] };
  const latest = journal.entries.at(-1);
  if (!latest) throw new Error("Migration journal is empty");
  const path = resolve(directory, `${latest.tag}.sql`);
  const source = readFileSync(path, "utf8");
  const output = finalizeChatGPTRegistrations(source);
  if (output !== source) writeFileSync(path, output);
}
