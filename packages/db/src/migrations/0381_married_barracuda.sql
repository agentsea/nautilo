ALTER TABLE "bolter_connections" ALTER COLUMN "relay_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "bolter_connections" ALTER COLUMN "desktop_session_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "bolter_connections" ALTER COLUMN "pairing_generation_ref" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "bolter_connections" ALTER COLUMN "home_handle" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "bolter_connections" ADD COLUMN "provider" text DEFAULT 'bolter' NOT NULL;--> statement-breakpoint
ALTER TABLE "bolter_connections" ADD COLUMN "transport_kind" text DEFAULT 'desktop-relay' NOT NULL;--> statement-breakpoint
ALTER TABLE "bolter_connections" ADD COLUMN "operator_binding_id" uuid;--> statement-breakpoint
ALTER TABLE "bolter_room_bindings" ADD COLUMN "provider" text DEFAULT 'bolter' NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "external_connections_operator" ON "bolter_connections" USING btree ("user_id","operator_binding_id") WHERE "bolter_connections"."operator_binding_id" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "bolter_connections" ADD CONSTRAINT "external_connections_transport" CHECK (("bolter_connections"."provider" = 'bolter' AND "bolter_connections"."origin" = 'https://bolter.chat' AND "bolter_connections"."transport_kind" = 'desktop-relay' AND "bolter_connections"."operator_binding_id" IS NULL AND "bolter_connections"."relay_id" IS NOT NULL AND "bolter_connections"."desktop_session_id" IS NOT NULL AND "bolter_connections"."pairing_generation_ref" IS NOT NULL AND "bolter_connections"."home_handle" IS NOT NULL) OR ("bolter_connections"."provider" = 'magent' AND "bolter_connections"."transport_kind" = 'operator-unix' AND "bolter_connections"."operator_binding_id" IS NOT NULL AND "bolter_connections"."relay_id" IS NULL AND "bolter_connections"."desktop_session_id" IS NULL AND "bolter_connections"."pairing_generation_ref" IS NULL AND "bolter_connections"."home_handle" IS NULL));
--> statement-breakpoint
-- EXTERNAL_OPERATOR_TRANSPORT_IDENTITY
CREATE OR REPLACE FUNCTION public.guard_external_binding_provider()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.bolter_connections c WHERE c.id = NEW.connection_id
    AND c.user_id = NEW.user_id AND c.provider = NEW.provider) THEN
    RAISE EXCEPTION 'External provider identity mismatch' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END; $$;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.guard_external_binding_provider() FROM PUBLIC, nautilo_agent, nautilo_crypto;--> statement-breakpoint
GRANT TRIGGER ON TABLE public.bolter_room_bindings TO nautilo;--> statement-breakpoint
CREATE TRIGGER external_binding_provider BEFORE INSERT OR UPDATE ON public.bolter_room_bindings
FOR EACH ROW EXECUTE FUNCTION public.guard_external_binding_provider();--> statement-breakpoint
REVOKE TRIGGER ON TABLE public.bolter_room_bindings FROM nautilo;--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.guard_bolter_final_reply()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE b public.bolter_room_bindings%ROWTYPE; i public.bolter_inbox_receipts%ROWTYPE;
  j public.jobs%ROWTYPE; a public.work_acceptances%ROWTYPE;
BEGIN
  IF TG_OP = 'INSERT' OR NEW.state IN ('pending','publishing','published') THEN

    IF NEW.explicit_share_id IS NOT NULL THEN
      IF NEW.source_inbox_id IS NOT NULL OR NOT EXISTS (
        SELECT 1 FROM public.bolter_explicit_shares g
        JOIN public.bolter_room_bindings share_binding ON share_binding.id = g.binding_id AND share_binding.user_id = g.user_id
        JOIN public.session_messages m ON m.id = g.session_message_id
        JOIN public.sessions s ON s.id = m.session_id
        WHERE g.id = NEW.explicit_share_id AND g.user_id = NEW.user_id AND g.binding_id = NEW.binding_id
          AND g.binding_revision = NEW.binding_revision AND g.connection_generation = NEW.connection_generation
          AND g.session_message_id = NEW.session_message_id AND g.fingerprint = NEW.fingerprint
          AND s.owner_id = g.user_id AND s.room_id = share_binding.room_id AND s.agent_id = share_binding.agent_id
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
          AND m.metadata->'externalFinalReply' = jsonb_build_object('kind',CASE WHEN b.provider = 'bolter' THEN 'bolter_final_reply_v1' ELSE 'external_room_final_reply_v1' END,
            'receiptId',i.id::text,'jobId',j.id::text,'turnId',i.turn_id,'acceptanceId',a.id::text)) THEN
      RAISE EXCEPTION 'Bolter final reply causality mismatch' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END; $$;
