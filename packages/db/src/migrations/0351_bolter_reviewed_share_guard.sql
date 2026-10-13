-- Custom SQL migration file, put your code below! --
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
