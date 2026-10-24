ALTER TABLE "bolter_inbox_receipts" DROP CONSTRAINT "bolter_inbox_state";--> statement-breakpoint
ALTER TABLE "bolter_outbox" ALTER COLUMN "session_message_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "bolter_inbox_receipts" ADD COLUMN "control_input" jsonb;--> statement-breakpoint
ALTER TABLE "bolter_outbox" ADD COLUMN "control_result" text;--> statement-breakpoint
ALTER TABLE "bolter_inbox_receipts" ADD CONSTRAINT "external_inbox_control" CHECK ("bolter_inbox_receipts"."control_input" IS NULL OR coalesce(("bolter_inbox_receipts"."session_message_id" IS NULL AND "bolter_inbox_receipts"."control_input"->>'kind' = 'operator_control_v1' AND jsonb_typeof("bolter_inbox_receipts"."control_input"->'content') = 'string' AND length("bolter_inbox_receipts"."control_input"->>'content') > 0 AND jsonb_typeof("bolter_inbox_receipts"."control_input"->'origin') = 'object'), false));--> statement-breakpoint
ALTER TABLE "bolter_inbox_receipts" ADD CONSTRAINT "bolter_inbox_state" CHECK ("bolter_inbox_receipts"."state" IN ('pending', 'accepted', 'quarantined', 'cancelled') AND ("bolter_inbox_receipts"."state" <> 'accepted' OR (("bolter_inbox_receipts"."session_message_id" IS NOT NULL OR "bolter_inbox_receipts"."control_input" IS NOT NULL) AND "bolter_inbox_receipts"."turn_id" IS NOT NULL)));--> statement-breakpoint
ALTER TABLE "bolter_outbox" ADD CONSTRAINT "external_outbox_content" CHECK (("bolter_outbox"."session_message_id" IS NOT NULL AND "bolter_outbox"."control_result" IS NULL) OR ("bolter_outbox"."session_message_id" IS NULL AND "bolter_outbox"."control_result" IS NOT NULL AND length(btrim("bolter_outbox"."control_result")) > 0 AND "bolter_outbox"."source_inbox_id" IS NOT NULL AND "bolter_outbox"."explicit_share_id" IS NULL));
--> statement-breakpoint
-- EXTERNAL_OPERATOR_CONTROL_STORAGE
CREATE OR REPLACE FUNCTION public.guard_bolter_inbox()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE b public.bolter_room_bindings%ROWTYPE; j public.jobs%ROWTYPE; a public.work_acceptances%ROWTYPE;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.control_input IS NOT NULL OR NEW.state <> 'pending' OR NEW.session_message_id IS NOT NULL OR NEW.turn_id IS NOT NULL OR NEW.job_id IS NOT NULL THEN
      RAISE EXCEPTION 'Bolter receipt requires canonical acceptance' USING ERRCODE = '23514';
    END IF;
    PERFORM public.bolter_assert_current_binding(NEW.user_id, NEW.binding_id, NEW.binding_revision, NEW.connection_generation);
  ELSE
    IF (to_jsonb(OLD) - ARRAY['session_message_id','control_input','turn_id','job_id','state','updated_at']) IS DISTINCT FROM
       (to_jsonb(NEW) - ARRAY['session_message_id','control_input','turn_id','job_id','state','updated_at'])
      OR (OLD.session_message_id IS NOT NULL AND OLD.session_message_id IS DISTINCT FROM NEW.session_message_id)
      OR (OLD.control_input IS NOT NULL AND OLD.control_input IS DISTINCT FROM NEW.control_input)
      OR (OLD.state <> 'pending' AND OLD.control_input IS DISTINCT FROM NEW.control_input)
      OR (OLD.turn_id IS NOT NULL AND OLD.turn_id IS DISTINCT FROM NEW.turn_id)
      OR (OLD.job_id IS NOT NULL AND OLD.job_id IS DISTINCT FROM NEW.job_id)
      OR (OLD.state IN ('quarantined','cancelled') AND NEW.state NOT IN (OLD.state,'quarantined'))
      OR (OLD.state = 'accepted' AND NEW.state = 'pending') THEN
      RAISE EXCEPTION 'Bolter receipt identity or lifecycle is immutable' USING ERRCODE = '23514';
    END IF;
    IF NEW.state = 'accepted' THEN
      PERFORM public.bolter_assert_current_binding(NEW.user_id, NEW.binding_id, NEW.binding_revision, NEW.connection_generation);
    END IF;
  END IF;
  SELECT * INTO b FROM public.bolter_room_bindings WHERE id = NEW.binding_id AND user_id = NEW.user_id;
  IF NEW.control_input IS NOT NULL AND (b.provider <> 'magent' OR NEW.session_message_id IS NOT NULL
    OR NEW.control_input->>'kind' IS DISTINCT FROM 'operator_control_v1'
    OR NEW.control_input->'origin'->>'provider' IS DISTINCT FROM 'magent'
    OR NEW.control_input->'origin'->>'bindingId' IS DISTINCT FROM b.id::text
    OR NEW.control_input->'origin'->>'connectionId' IS DISTINCT FROM b.connection_id::text
    OR NEW.control_input->'origin'->>'origin' IS DISTINCT FROM b.origin
    OR NEW.control_input->'origin'->>'providerAgentId' IS DISTINCT FROM b.provider_agent_id
    OR NEW.control_input->'origin'->>'chatId' IS DISTINCT FROM b.chat_id
    OR coalesce(NEW.control_input->'origin'->>'threadRootId','') IS DISTINCT FROM b.thread_id
    OR NEW.control_input->'origin'->>'messageId' IS DISTINCT FROM NEW.provider_message_id
    OR NEW.control_input->'origin'->>'senderId' IS DISTINCT FROM NEW.external_sender_id
    OR NEW.control_input->'origin'->>'senderType' IS DISTINCT FROM 'anima') THEN
    RAISE EXCEPTION 'Operator control provenance mismatch' USING ERRCODE = '23514';
  END IF;
  IF NEW.session_message_id IS NOT NULL AND (TG_OP = 'INSERT' OR OLD.session_message_id IS DISTINCT FROM NEW.session_message_id OR OLD.turn_id IS DISTINCT FROM NEW.turn_id) AND NOT EXISTS (
    SELECT 1 FROM public.session_messages m JOIN public.sessions s ON s.id = m.session_id
    WHERE m.id = NEW.session_message_id AND s.owner_id = NEW.user_id AND s.room_id = b.room_id
      AND s.agent_id = b.agent_id AND m.role = 'user' AND m.human_turn_id = NEW.turn_id
  ) THEN RAISE EXCEPTION 'Bolter receipt canonical message mismatch' USING ERRCODE = '23514'; END IF;
  IF NEW.job_id IS NOT NULL AND (TG_OP = 'INSERT' OR OLD.job_id IS DISTINCT FROM NEW.job_id) AND NOT EXISTS (SELECT 1 FROM public.jobs canonical_job WHERE canonical_job.id = NEW.job_id
    AND canonical_job.owner_id = NEW.user_id AND canonical_job.requestor_id = NEW.user_id AND canonical_job.room_id = b.room_id) THEN
    RAISE EXCEPTION 'Bolter receipt job ownership mismatch' USING ERRCODE = '23514';
  END IF;
  IF NEW.state = 'accepted' THEN
    IF NEW.job_id IS NULL THEN RAISE EXCEPTION 'Bolter acceptance requires atomic durable work' USING ERRCODE = '23514'; END IF;
    IF OLD.state <> 'accepted' OR OLD.job_id IS DISTINCT FROM NEW.job_id THEN
      SELECT * INTO j FROM public.jobs WHERE id = NEW.job_id AND owner_id = NEW.user_id AND requestor_id = NEW.user_id;
      SELECT * INTO a FROM public.work_acceptances WHERE id::text = j.input->>'acceptanceId' FOR UPDATE;
      IF j.id IS NULL OR a.id IS NULL OR j.type <> 'foreground' OR j.room_id IS DISTINCT FROM b.room_id
        OR j.lane_key IS DISTINCT FROM 'room:' || b.room_id::text OR j.status <> 'queued'
        OR j.started_at IS NOT NULL OR j.completed_at IS NOT NULL OR j.result IS NOT NULL OR j.message IS NOT NULL
        OR a.kind <> 'foreground' OR a.status <> 'accepted' OR a.job_id IS NOT NULL
        OR a.dispatched_at IS NOT NULL OR a.cancelled_at IS NOT NULL
        OR j.input IS DISTINCT FROM jsonb_build_object('kind','external_room_turn_v1',
          'receiptId',NEW.id::text,'bindingId',b.id::text,'bindingRevision',NEW.binding_revision,
          'connectionGeneration',NEW.connection_generation,'acceptanceId',a.id::text,
          'roomId',b.room_id::text,'agentId',b.agent_id::text,'turnId',NEW.turn_id)
        OR NOT ((b.provider = 'magent' AND NEW.control_input IS NOT NULL AND NEW.session_message_id IS NULL)
          OR (b.provider = 'bolter' AND NEW.control_input IS NULL AND EXISTS (SELECT 1 FROM public.session_messages m WHERE m.id = NEW.session_message_id
            AND m.metadata->>'externalReceiptId' = NEW.id::text AND m.transcript_origin = 'main' AND m.external_authorship)))
        OR EXISTS (SELECT 1 FROM public.jobs other WHERE other.id <> j.id
          AND other.input->>'kind' = 'external_room_turn_v1' AND other.input->>'acceptanceId' = a.id::text) THEN
        RAISE EXCEPTION 'Bolter acceptance canonical work mismatch' USING ERRCODE = '23514';
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END; $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.guard_bolter_outbox()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE b public.bolter_room_bindings%ROWTYPE;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.state <> 'pending' OR NEW.claim_token IS NOT NULL OR NEW.provider_message_id IS NOT NULL THEN
      RAISE EXCEPTION 'Invalid initial Bolter publication' USING ERRCODE = '23514';
    END IF;
  ELSE
    IF (to_jsonb(OLD) - ARRAY['state','claim_token','provider_message_id','updated_at']) IS DISTINCT FROM
       (to_jsonb(NEW) - ARRAY['state','claim_token','provider_message_id','updated_at'])
      OR (OLD.claim_token IS NOT NULL AND OLD.claim_token IS DISTINCT FROM NEW.claim_token)
      OR NOT ((OLD.state = 'pending' AND NEW.state IN ('publishing','cancelled'))
        OR (OLD.state = 'publishing' AND NEW.state IN ('published','uncertain','cancelled'))) THEN
      RAISE EXCEPTION 'Bolter publication is terminal or immutable' USING ERRCODE = '23514';
    END IF;
  END IF;
  IF NEW.state IN ('pending','publishing','published') THEN
    PERFORM public.bolter_assert_current_binding(NEW.user_id, NEW.binding_id, NEW.binding_revision, NEW.connection_generation);
    IF NEW.source_inbox_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.bolter_inbox_receipts i
      WHERE i.id = NEW.source_inbox_id AND i.user_id = NEW.user_id AND i.binding_id = NEW.binding_id
        AND i.state = 'accepted' AND i.binding_revision = NEW.binding_revision AND i.connection_generation = NEW.connection_generation) THEN
      RAISE EXCEPTION 'Bolter reply receipt unavailable' USING ERRCODE = '23514';
    END IF;
  END IF;
  SELECT * INTO b FROM public.bolter_room_bindings WHERE id = NEW.binding_id AND user_id = NEW.user_id;
  IF NEW.control_result IS NOT NULL AND (b.provider <> 'magent' OR NEW.session_message_id IS NOT NULL
    OR NEW.explicit_share_id IS NOT NULL OR NOT EXISTS (SELECT 1 FROM public.bolter_inbox_receipts i
      WHERE i.id = NEW.source_inbox_id AND i.binding_id = b.id AND i.user_id = NEW.user_id AND i.control_input IS NOT NULL)) THEN
    RAISE EXCEPTION 'Operator result provenance mismatch' USING ERRCODE = '23514';
  END IF;
  IF NEW.control_result IS NULL AND NEW.state IN ('pending','publishing','published') AND NOT EXISTS (SELECT 1 FROM public.session_messages m JOIN public.sessions s ON s.id = m.session_id
    WHERE m.id = NEW.session_message_id AND s.owner_id = NEW.user_id AND s.room_id = b.room_id AND s.agent_id = b.agent_id
      AND (NEW.explicit_share_id IS NOT NULL OR m.role = 'assistant')) THEN
    RAISE EXCEPTION 'Bolter publication canonical message mismatch' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END; $$;
--> statement-breakpoint
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
      OR NOT ((b.provider = 'magent' AND i.control_input IS NOT NULL AND NEW.control_result IS NOT NULL
        AND NEW.session_message_id IS NULL AND i.session_message_id IS NULL)
        OR (NEW.control_result IS NULL AND i.control_input IS NULL AND EXISTS (SELECT 1 FROM public.session_messages m
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
            'receiptId',i.id::text,'jobId',j.id::text,'turnId',i.turn_id,'acceptanceId',a.id::text)))) THEN
      RAISE EXCEPTION 'Bolter final reply causality mismatch' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END; $$;
