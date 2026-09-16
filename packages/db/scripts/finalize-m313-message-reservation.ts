import {readFileSync, writeFileSync} from "node:fs";
import {resolve} from "node:path";
const marker = "-- M313_PENDING_MESSAGE_RESERVATION_AUTHORITY";

export function finalizeM313MessageReservationMigration(migration: string): string {
  if (migration.includes(marker) || !migration.includes('DROP CONSTRAINT "session_message_crypto_revisions_repair_evidence_coherent"')) return migration;
  return `${migration}\n--> statement-breakpoint\n${marker}
CREATE OR REPLACE FUNCTION public.protect_message_repair_publisher_human()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog AS $$
BEGIN
  IF current_user = 'nautilo_agent' AND (
    NEW.repair_publisher_human_id IS NOT NULL
    OR (OLD.repair_publisher_human_id IS NOT NULL AND (
      OLD.completion <> 'pending' OR NEW.repair_publisher_kind IS DISTINCT FROM 'foreground_runtime'
    ))
  ) THEN
    RAISE EXCEPTION 'Agent cannot create or rewrite Human Message publisher evidence' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.protect_message_repair_publisher_human() FROM PUBLIC, nautilo_crypto;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.protect_message_repair_publisher_human() TO nautilo, nautilo_agent;--> statement-breakpoint
CREATE TRIGGER message_repair_publisher_human_protected
BEFORE UPDATE OF repair_publisher_human_id ON session_message_crypto_revisions
FOR EACH ROW EXECUTE FUNCTION public.protect_message_repair_publisher_human();--> statement-breakpoint
GRANT UPDATE (repair_publisher_human_id) ON session_message_crypto_revisions TO nautilo_agent;
`;
}

if (import.meta.main) {
  const directory = resolve(import.meta.dir, "../src/migrations");
  const journal = JSON.parse(readFileSync(resolve(directory, "meta/_journal.json"), "utf8")) as {entries: {tag: string}[]};
  const last = journal.entries.at(-1);
  if (last === undefined) throw new Error("Migration journal is empty");
  const path = resolve(directory, `${last.tag}.sql`), original = readFileSync(path, "utf8");
  const finalized = finalizeM313MessageReservationMigration(original);
  if (finalized !== original) writeFileSync(path, finalized);
}
