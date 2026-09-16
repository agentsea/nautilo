CREATE TABLE "message_backfill_tool_contexts" (
	"human_actor_id" uuid PRIMARY KEY NOT NULL,
	"session_id" uuid NOT NULL,
	"target_message_id" integer NOT NULL,
	"target_revision" integer NOT NULL,
	"source_revision" integer NOT NULL,
	"phase" text NOT NULL,
	"after_created_at" timestamp with time zone,
	"after_message_id" integer DEFAULT 0 NOT NULL,
	"current_message_id" integer,
	"call_ordinal" integer DEFAULT 0 NOT NULL,
	"comparison_sequence" bigint DEFAULT 0 NOT NULL,
	"next_sequence" bigint DEFAULT 0 NOT NULL,
	"selected_message_id" integer,
	"selected_revision" integer,
	"selected_call_ordinal" integer,
	CONSTRAINT "message_backfill_tool_context_coordinates" CHECK ("message_backfill_tool_contexts"."target_message_id" > 0 and "message_backfill_tool_contexts"."target_revision" >= 0 and "message_backfill_tool_contexts"."source_revision" >= 0 and "message_backfill_tool_contexts"."after_message_id" >= 0 and "message_backfill_tool_contexts"."call_ordinal" >= 0 and "message_backfill_tool_contexts"."comparison_sequence" >= 0 and "message_backfill_tool_contexts"."next_sequence" >= 0),
	CONSTRAINT "message_backfill_tool_context_phase" CHECK ("message_backfill_tool_contexts"."phase" in ('scan', 'clear', 'ready', 'invalid'))
);
--> statement-breakpoint
ALTER TABLE "message_backfill_tool_contexts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "message_backfill_tool_pending_calls" (
	"human_actor_id" uuid NOT NULL,
	"sequence" bigint NOT NULL,
	"source_message_id" integer NOT NULL,
	"source_revision" integer NOT NULL,
	"call_ordinal" integer NOT NULL,
	CONSTRAINT "message_backfill_tool_pending_calls_human_actor_id_sequence_pk" PRIMARY KEY("human_actor_id","sequence"),
	CONSTRAINT "message_backfill_tool_pending_coordinates" CHECK ("message_backfill_tool_pending_calls"."sequence" > 0 and "message_backfill_tool_pending_calls"."source_message_id" > 0 and "message_backfill_tool_pending_calls"."source_revision" >= 0 and "message_backfill_tool_pending_calls"."call_ordinal" >= 0)
);
--> statement-breakpoint
ALTER TABLE "message_backfill_tool_pending_calls" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "message_source_revision" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "message_backfill_tool_contexts" ADD CONSTRAINT "message_backfill_tool_contexts_human_actor_id_actors_id_fk" FOREIGN KEY ("human_actor_id") REFERENCES "public"."actors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_backfill_tool_contexts" ADD CONSTRAINT "message_backfill_tool_contexts_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_backfill_tool_pending_calls" ADD CONSTRAINT "message_backfill_tool_pending_calls_human_actor_id_actors_id_fk" FOREIGN KEY ("human_actor_id") REFERENCES "public"."actors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_session_messages_session_created_id" ON "session_messages" USING btree ("session_id","created_at","id");--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_message_source_revision" CHECK ("sessions"."message_source_revision" >= 0);--> statement-breakpoint
CREATE POLICY "message_backfill_tool_context_product" ON "message_backfill_tool_contexts" AS PERMISSIVE FOR ALL TO "nautilo" USING (true) WITH CHECK (true);--> statement-breakpoint
CREATE POLICY "message_backfill_tool_pending_product" ON "message_backfill_tool_pending_calls" AS PERMISSIVE FOR ALL TO "nautilo" USING (true) WITH CHECK (true);
--> statement-breakpoint
-- M313_BOUNDED_TOOL_CONTEXT_AUTHORITY
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
