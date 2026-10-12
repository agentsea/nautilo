CREATE TABLE "bolter_explicit_shares" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"binding_id" uuid NOT NULL,
	"binding_revision" integer NOT NULL,
	"connection_generation" integer NOT NULL,
	"request_id" uuid NOT NULL,
	"session_message_id" integer NOT NULL,
	"fingerprint" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "bolter_shares_owner_binding_id" UNIQUE("user_id","binding_id","id"),
	CONSTRAINT "bolter_shares_request" UNIQUE("user_id","request_id"),
	CONSTRAINT "bolter_shares_identity" CHECK ("bolter_explicit_shares"."fingerprint" ~ '^[0-9a-f]{64}$' AND "bolter_explicit_shares"."binding_revision" >= 0 AND "bolter_explicit_shares"."connection_generation" > 0)
);
--> statement-breakpoint
ALTER TABLE "bolter_explicit_shares" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "bolter_explicit_shares" ADD CONSTRAINT "bolter_explicit_shares_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bolter_explicit_shares" ADD CONSTRAINT "bolter_explicit_shares_session_message_id_session_messages_id_fk" FOREIGN KEY ("session_message_id") REFERENCES "public"."session_messages"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bolter_explicit_shares" ADD CONSTRAINT "bolter_shares_binding_owner" FOREIGN KEY ("user_id","binding_id") REFERENCES "public"."bolter_room_bindings"("user_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bolter_outbox" ADD CONSTRAINT "bolter_outbox_share_owner" FOREIGN KEY ("user_id","binding_id","explicit_share_id") REFERENCES "public"."bolter_explicit_shares"("user_id","binding_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "bolter_outbox_explicit_share" ON "bolter_outbox" USING btree ("explicit_share_id") WHERE "bolter_outbox"."explicit_share_id" IS NOT NULL;--> statement-breakpoint
CREATE POLICY "bolter_shares_owner" ON "bolter_explicit_shares" AS PERMISSIVE FOR ALL TO "nautilo_agent" USING ("bolter_explicit_shares"."user_id" = nullif(current_setting('app.current_user_id', true), '')::uuid) WITH CHECK ("bolter_explicit_shares"."user_id" = nullif(current_setting('app.current_user_id', true), '')::uuid);
--> statement-breakpoint
-- BOLTER_REVIEWED_HUMAN_SHARE
ALTER TABLE public.bolter_explicit_shares FORCE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL ON TABLE public.bolter_explicit_shares FROM PUBLIC, nautilo, nautilo_agent, nautilo_crypto;--> statement-breakpoint
GRANT SELECT, INSERT ON TABLE public.bolter_explicit_shares TO nautilo_agent;--> statement-breakpoint
GRANT SELECT(id,user_id,binding_id,session_message_id), UPDATE(id), DELETE ON TABLE public.bolter_explicit_shares TO nautilo;--> statement-breakpoint
GRANT SELECT(explicit_share_id) ON TABLE public.bolter_outbox TO nautilo;--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.guard_bolter_reviewed_share()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF TG_OP <> 'INSERT' OR NEW.user_id IS DISTINCT FROM nullif(current_setting('app.current_user_id',true),'')::uuid THEN
    RAISE EXCEPTION 'Bolter reviewed share is immutable' USING ERRCODE = '23514';
  END IF;
  PERFORM public.bolter_assert_current_binding(NEW.user_id,NEW.binding_id,NEW.binding_revision,NEW.connection_generation);
  RETURN NEW;
END; $$;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.guard_bolter_reviewed_share() FROM PUBLIC, nautilo_agent, nautilo_crypto;--> statement-breakpoint
CREATE TRIGGER bolter_reviewed_share_authority BEFORE INSERT OR UPDATE ON public.bolter_explicit_shares
FOR EACH ROW EXECUTE FUNCTION public.guard_bolter_reviewed_share();--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.guard_bolter_final_reply()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE b public.bolter_room_bindings%ROWTYPE; i public.bolter_inbox_receipts%ROWTYPE;
  j public.jobs%ROWTYPE; a public.work_acceptances%ROWTYPE;
BEGIN
  IF TG_OP = 'INSERT' OR NEW.state IN ('pending','publishing','published') THEN

    IF NEW.explicit_share_id IS NOT NULL THEN
      IF NEW.source_inbox_id IS NOT NULL OR NOT EXISTS (
        SELECT 1 FROM public.bolter_explicit_shares g
        JOIN public.bolter_room_bindings b ON b.id = g.binding_id AND b.user_id = g.user_id
        JOIN public.session_messages m ON m.id = g.session_message_id
        JOIN public.sessions s ON s.id = m.session_id
        WHERE g.id = NEW.explicit_share_id AND g.user_id = NEW.user_id AND g.binding_id = NEW.binding_id
          AND g.binding_revision = NEW.binding_revision AND g.connection_generation = NEW.connection_generation
          AND g.session_message_id = NEW.session_message_id AND g.fingerprint = NEW.fingerprint
          AND s.owner_id = g.user_id AND s.room_id = b.room_id AND s.agent_id = b.agent_id
          AND m.role = 'user' AND NOT m.external_authorship AND m.transcript_origin = 'main'
          AND m.content IS NOT NULL AND btrim(m.content) <> '' AND m.tool_calls IS NULL AND m.tool_name IS NULL
          AND m.fingerprint = g.fingerprint AND m.human_turn_id IS NOT NULL
          AND NOT (coalesce(m.metadata, '{}'::jsonb) ?| ARRAY['externalOrigin','externalReceiptId'])
          AND m.metadata->'bolterReviewedShare' = jsonb_build_object('shareId',g.id::text,'requestId',g.request_id::text)
      ) THEN RAISE EXCEPTION 'Bolter reviewed share mismatch' USING ERRCODE = '23514'; END IF;
      RETURN NEW;
    END IF;
    IF NEW.source_inbox_id IS NULL THEN
      RAISE EXCEPTION 'Bolter explicit sharing authority is unavailable' USING ERRCODE = '23514';
    END IF;
    SELECT * INTO b FROM public.bolter_room_bindings WHERE id = NEW.binding_id AND user_id = NEW.user_id;
    SELECT * INTO i FROM public.bolter_inbox_receipts WHERE id = NEW.source_inbox_id AND binding_id = b.id AND user_id = NEW.user_id;
    SELECT * INTO j FROM public.jobs WHERE id = i.job_id AND owner_id = NEW.user_id AND requestor_id = NEW.user_id;
    SELECT * INTO a FROM public.work_acceptances WHERE id::text = j.input->>'acceptanceId';
    IF b.id IS NULL OR i.id IS NULL OR j.id IS NULL OR a.id IS NULL
      OR b.model_sponsorship_accepted_at IS NULL OR i.state <> 'accepted'
      OR i.binding_revision <> NEW.binding_revision OR i.connection_generation <> NEW.connection_generation
      OR j.type <> 'foreground' OR j.room_id IS DISTINCT FROM b.room_id OR j.lane_key IS DISTINCT FROM 'room:' || b.room_id::text
      OR j.status <> 'completed' OR j.started_at IS NULL OR j.completed_at IS NULL
      OR a.kind <> 'foreground' OR a.status <> 'dispatched' OR a.job_id IS DISTINCT FROM j.id
      OR a.dispatched_at IS NULL OR a.cancelled_at IS NOT NULL
      OR j.input IS DISTINCT FROM jsonb_build_object('kind','external_room_turn_v1',
        'receiptId',i.id::text,'bindingId',b.id::text,'bindingRevision',i.binding_revision,
        'connectionGeneration',i.connection_generation,'acceptanceId',a.id::text,
        'roomId',b.room_id::text,'agentId',b.agent_id::text,'turnId',i.turn_id)
      OR NOT EXISTS (SELECT 1 FROM public.session_messages m
        JOIN public.session_messages source ON source.id = i.session_message_id
        JOIN public.sessions s ON s.id = m.session_id
        WHERE m.id = NEW.session_message_id AND m.session_id = source.session_id
          AND s.owner_id = NEW.user_id AND s.room_id = b.room_id AND s.agent_id = b.agent_id
          AND source.role = 'user' AND source.human_turn_id = i.turn_id
          AND source.metadata->>'externalReceiptId' = i.id::text
          AND m.role = 'assistant' AND m.transcript_origin = 'main' AND m.content IS NOT NULL
          AND btrim(m.content) <> '' AND m.human_turn_id IS NULL
          AND m.tool_calls IS NULL AND m.tool_name IS NULL
          AND m.reply_to_message_id = i.session_message_id AND m.fingerprint = NEW.fingerprint
          AND m.metadata->'externalFinalReply' = jsonb_build_object('kind','bolter_final_reply_v1',
            'receiptId',i.id::text,'jobId',j.id::text,'turnId',i.turn_id,'acceptanceId',a.id::text)) THEN
      RAISE EXCEPTION 'Bolter final reply causality mismatch' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END; $$;
