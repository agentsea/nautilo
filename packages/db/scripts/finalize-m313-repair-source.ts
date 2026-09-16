import {readFileSync, writeFileSync} from "node:fs";
import {resolve} from "node:path";

const marker = "-- M313_PENDING_TOOL_SOURCE_AUTHORITY";
/** SQL-only protection for mutable pending evidence; final publication freezes it. */
export function finalizeM313RepairSourceMigration(migration: string): string {
  if (migration.includes(marker) || !migration.includes('"repair_source_digest"')) return migration;
  return `${migration}\n--> statement-breakpoint\n${marker}
CREATE OR REPLACE FUNCTION public.protect_pending_tool_repair_source()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog AS $$
BEGIN
  IF ROW(NEW.repair_source_revision, NEW.repair_source_digest)
    IS DISTINCT FROM ROW(OLD.repair_source_revision, OLD.repair_source_digest)
    AND (current_user <> 'nautilo' OR OLD.completion <> 'pending'
      OR OLD.disposition <> 'active' OR OLD.author_role <> 'tool'
      OR NEW.repair_source_revision IS NULL OR NEW.repair_source_digest IS NULL
      OR (OLD.repair_source_revision IS NOT NULL
        AND NEW.repair_source_revision <= OLD.repair_source_revision)) THEN
    RAISE EXCEPTION 'Only current pending Tool source can change' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.protect_pending_tool_repair_source() FROM PUBLIC, nautilo_agent, nautilo_crypto;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.protect_pending_tool_repair_source() TO nautilo;--> statement-breakpoint
CREATE TRIGGER pending_tool_repair_source_protected
BEFORE UPDATE OF repair_source_revision, repair_source_digest ON session_message_crypto_revisions
FOR EACH ROW EXECUTE FUNCTION public.protect_pending_tool_repair_source();
`;
}

if (import.meta.main) {
  const directory = resolve(import.meta.dir, "../src/migrations");
  const journal = JSON.parse(readFileSync(resolve(directory, "meta/_journal.json"), "utf8")) as {entries: {tag: string}[]};
  const last = journal.entries.at(-1);
  if (last === undefined) throw new Error("Migration journal is empty");
  const path = resolve(directory, `${last.tag}.sql`);
  const original = readFileSync(path, "utf8");
  const finalized = finalizeM313RepairSourceMigration(original);
  if (finalized !== original) writeFileSync(path, finalized);
}
