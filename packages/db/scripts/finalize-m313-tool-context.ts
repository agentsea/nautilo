import {readFileSync, writeFileSync} from "node:fs";
import {resolve} from "node:path";

const marker = "-- M313_BOUNDED_TOOL_CONTEXT_AUTHORITY";

export function finalizeM313ToolContextMigration(migration: string): string {
  if (migration.includes(marker) || !migration.includes('CREATE TABLE "message_backfill_tool_contexts"')) return migration;
  if (!migration.includes('CREATE TABLE "message_backfill_tool_pending_calls"')
    || !migration.includes('ADD COLUMN "message_source_revision"')) {
    throw new Error("M313 Tool continuation requires its paired structural state and Session revision");
  }
  return `${migration}\n--> statement-breakpoint\n${marker}
ALTER TABLE public.message_backfill_tool_contexts FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.message_backfill_tool_pending_calls FORCE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL ON public.message_backfill_tool_contexts, public.message_backfill_tool_pending_calls FROM PUBLIC, nautilo_agent, nautilo_crypto;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON public.message_backfill_tool_contexts, public.message_backfill_tool_pending_calls TO nautilo;--> statement-breakpoint
CREATE FUNCTION public.protect_message_source_revision()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog AS $$
BEGIN
  IF pg_trigger_depth() < 2 OR NEW.message_source_revision <> OLD.message_source_revision + 1 THEN
    RAISE EXCEPTION 'Message source revision is maintained by canonical Message changes' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.protect_message_source_revision() FROM PUBLIC, nautilo_agent, nautilo_crypto;--> statement-breakpoint
CREATE TRIGGER message_source_revision_protected
BEFORE UPDATE OF message_source_revision ON public.sessions
FOR EACH ROW WHEN (OLD.message_source_revision IS DISTINCT FROM NEW.message_source_revision)
EXECUTE FUNCTION public.protect_message_source_revision();--> statement-breakpoint
CREATE FUNCTION public.advance_message_source_revision()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE
  previous_session uuid;
  current_session uuid;
  affected_session uuid;
BEGIN
  IF TG_OP = 'INSERT' THEN
    -- Serialize even appends with source readers and other insertions. Otherwise
    -- an uncommitted backdated insert could miss a concurrently inserted target
    -- and later become visible without invalidating its prepared context.
    PERFORM 1 FROM public.sessions WHERE id = NEW.session_id FOR NO KEY UPDATE;
    -- Ordinary appends cannot alter any already selected Tool prefix. Imported
    -- or backdated rows can, and the transcript ordering index bounds this probe.
    IF NOT EXISTS (SELECT 1 FROM public.session_messages AS later
      WHERE later.session_id = NEW.session_id
        AND (later.created_at, later.id) > (NEW.created_at, NEW.id)) THEN
      RETURN NULL;
    END IF;
    current_session := NEW.session_id;
  ELSIF TG_OP = 'DELETE' THEN
    previous_session := OLD.session_id;
  ELSE
    IF ROW(OLD.session_id, OLD.role, OLD.content, OLD.tool_calls, OLD.tool_name, OLD.created_at, OLD.edit_revision)
      IS NOT DISTINCT FROM
      ROW(NEW.session_id, NEW.role, NEW.content, NEW.tool_calls, NEW.tool_name, NEW.created_at, NEW.edit_revision) THEN
      RETURN NULL;
    END IF;
    previous_session := OLD.session_id;
    current_session := NEW.session_id;
  END IF;
  FOR affected_session IN
    SELECT DISTINCT candidate FROM unnest(ARRAY[previous_session, current_session]) AS candidate
    WHERE candidate IS NOT NULL ORDER BY candidate
  LOOP
    UPDATE public.sessions SET message_source_revision = message_source_revision + 1
    WHERE id = affected_session;
  END LOOP;
  RETURN NULL;
END;
$$;--> statement-breakpoint
ALTER FUNCTION public.advance_message_source_revision() OWNER TO nautilo;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.advance_message_source_revision() FROM PUBLIC, nautilo_agent, nautilo_crypto;--> statement-breakpoint
CREATE TRIGGER message_source_revision_advanced
AFTER INSERT OR DELETE OR UPDATE OF session_id, role, content, tool_calls, tool_name, created_at, edit_revision
ON public.session_messages FOR EACH ROW EXECUTE FUNCTION public.advance_message_source_revision();
`;
}

if (import.meta.main) {
  const directory = resolve(import.meta.dir, "../src/migrations");
  const journal = JSON.parse(readFileSync(resolve(directory, "meta/_journal.json"), "utf8")) as {entries: {tag: string}[]};
  const last = journal.entries.at(-1);
  if (!last) throw new Error("Migration journal is empty");
  const path = resolve(directory, `${last.tag}.sql`), original = readFileSync(path, "utf8");
  const finalized = finalizeM313ToolContextMigration(original);
  if (finalized !== original) writeFileSync(path, finalized);
}
