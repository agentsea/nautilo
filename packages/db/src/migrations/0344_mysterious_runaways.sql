ALTER TABLE "bolter_room_bindings" ADD COLUMN "model_sponsorship_accepted_at" timestamp with time zone;--> statement-breakpoint
CREATE UNIQUE INDEX "bolter_outbox_final_reply" ON "bolter_outbox" USING btree ("source_inbox_id") WHERE "bolter_outbox"."source_inbox_id" IS NOT NULL;
--> statement-breakpoint
-- BOLTER_ATOMIC_EXTERNAL_EXECUTION
-- NULL sponsorship is deliberately not grandfathered. Canonical content stays
-- in session_messages; durable work carries only exact immutable coordinates.
CREATE OR REPLACE FUNCTION public.guard_bolter_binding()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE c public.bolter_connections%ROWTYPE; r public.rooms%ROWTYPE;
BEGIN
  IF nullif(current_setting('app.current_user_id', true), '')::uuid IS DISTINCT FROM NEW.user_id THEN
    RAISE EXCEPTION 'Bolter owner context unavailable' USING ERRCODE = '42501';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF (to_jsonb(OLD) - ARRAY['state','revision','updated_at','model_sponsorship_accepted_at']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['state','revision','updated_at','model_sponsorship_accepted_at'])
      OR (OLD.model_sponsorship_accepted_at IS NOT NULL AND OLD.model_sponsorship_accepted_at IS DISTINCT FROM NEW.model_sponsorship_accepted_at)
      OR (OLD.model_sponsorship_accepted_at IS DISTINCT FROM NEW.model_sponsorship_accepted_at AND (OLD.state <> 'active' OR NEW.state <> 'active'))
      OR OLD.state = 'revoked' OR NEW.revision <> OLD.revision + 1 THEN
      RAISE EXCEPTION 'Bolter binding routing coordinates are immutable' USING ERRCODE = '23514';
    END IF;
  ELSE
    IF NEW.revision <> 0 OR NEW.state <> 'active' THEN
      RAISE EXCEPTION 'Invalid initial Bolter binding' USING ERRCODE = '23514';
    END IF;
  END IF;
  SELECT * INTO c FROM public.bolter_connections WHERE id = NEW.connection_id AND user_id = NEW.user_id FOR UPDATE;
  IF TG_OP = 'INSERT' THEN
    SELECT * INTO r FROM public.rooms WHERE id = NEW.room_id AND namespace_id = NEW.namespace_id FOR UPDATE;
    IF r.id IS NULL OR r.owner_id <> NEW.user_id OR NOT r.external_context OR r.kind <> 'private'
      OR r.archived_at IS NOT NULL
      OR EXISTS (SELECT 1 FROM public.sessions s JOIN public.session_messages m ON m.session_id = s.id WHERE s.room_id = r.id)
      OR EXISTS (SELECT 1 FROM public.room_events WHERE room_id = r.id)
      OR EXISTS (SELECT 1 FROM public.room_event_rollups WHERE room_id = r.id)
      OR EXISTS (SELECT 1 FROM public.room_journal_batches WHERE room_id = r.id)
      OR EXISTS (SELECT 1 FROM public.room_journal_state WHERE room_id = r.id AND last_processed_message_id <> 0) THEN
      RAISE EXCEPTION 'Bolter binding requires a factory-created empty external Room and namespace' USING ERRCODE = '23514';
    END IF;
  END IF;
  IF NEW.state = 'active' THEN
    IF c.id IS NULL OR NOT c.enabled OR c.revoked_at IS NOT NULL OR c.origin <> NEW.origin OR c.provider_agent_id <> NEW.provider_agent_id
      OR NOT coalesce(public.bolter_room_admission(NEW.user_id, NEW.room_id, NEW.namespace_id, NEW.agent_id), false) THEN
      RAISE EXCEPTION 'Bolter sponsor or Genie membership unavailable' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END; $$;--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.bolter_assert_current_binding(p_user uuid, p_binding uuid, p_revision integer, p_generation integer)
RETURNS void LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE b public.bolter_room_bindings%ROWTYPE; c public.bolter_connections%ROWTYPE;
BEGIN
  IF nullif(current_setting('app.current_user_id', true), '')::uuid IS DISTINCT FROM p_user THEN
    RAISE EXCEPTION 'Bolter owner context unavailable' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO b FROM public.bolter_room_bindings WHERE id = p_binding AND user_id = p_user;
  SELECT * INTO c FROM public.bolter_connections WHERE id = b.connection_id AND user_id = p_user FOR UPDATE;
  SELECT * INTO b FROM public.bolter_room_bindings WHERE id = p_binding AND user_id = p_user FOR UPDATE;
  IF c.id IS NULL OR b.id IS NULL OR NOT c.enabled OR c.revoked_at IS NOT NULL
    OR c.generation <> p_generation OR b.revision <> p_revision OR b.state <> 'active' OR b.model_sponsorship_accepted_at IS NULL
    OR NOT coalesce(public.bolter_room_admission(p_user, b.room_id, b.namespace_id, b.agent_id), false)
    THEN RAISE EXCEPTION 'Bolter binding authority unavailable' USING ERRCODE = '23514'; END IF;
END; $$;--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.guard_bolter_inbox()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE b public.bolter_room_bindings%ROWTYPE; j public.jobs%ROWTYPE; a public.work_acceptances%ROWTYPE;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.state <> 'pending' OR NEW.session_message_id IS NOT NULL OR NEW.turn_id IS NOT NULL OR NEW.job_id IS NOT NULL THEN
      RAISE EXCEPTION 'Bolter receipt requires canonical acceptance' USING ERRCODE = '23514';
    END IF;
    PERFORM public.bolter_assert_current_binding(NEW.user_id, NEW.binding_id, NEW.binding_revision, NEW.connection_generation);
  ELSE
    IF (to_jsonb(OLD) - ARRAY['session_message_id','turn_id','job_id','state','updated_at']) IS DISTINCT FROM
       (to_jsonb(NEW) - ARRAY['session_message_id','turn_id','job_id','state','updated_at'])
      OR (OLD.session_message_id IS NOT NULL AND OLD.session_message_id IS DISTINCT FROM NEW.session_message_id)
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
  IF NEW.session_message_id IS NOT NULL AND (TG_OP = 'INSERT' OR OLD.session_message_id IS DISTINCT FROM NEW.session_message_id OR OLD.turn_id IS DISTINCT FROM NEW.turn_id) AND NOT EXISTS (
    SELECT 1 FROM public.session_messages m JOIN public.sessions s ON s.id = m.session_id
    WHERE m.id = NEW.session_message_id AND s.owner_id = NEW.user_id AND s.room_id = b.room_id
      AND s.agent_id = b.agent_id AND m.role = 'user' AND m.human_turn_id = NEW.turn_id
  ) THEN RAISE EXCEPTION 'Bolter receipt canonical message mismatch' USING ERRCODE = '23514'; END IF;
  IF NEW.job_id IS NOT NULL AND (TG_OP = 'INSERT' OR OLD.job_id IS DISTINCT FROM NEW.job_id) AND NOT EXISTS (SELECT 1 FROM public.jobs j WHERE j.id = NEW.job_id
    AND j.owner_id = NEW.user_id AND j.requestor_id = NEW.user_id AND j.room_id = b.room_id) THEN
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
        OR NOT EXISTS (SELECT 1 FROM public.session_messages m WHERE m.id = NEW.session_message_id
          AND m.metadata->>'externalReceiptId' = NEW.id::text AND m.transcript_origin = 'main')
        OR EXISTS (SELECT 1 FROM public.jobs other WHERE other.id <> j.id
          AND other.input->>'kind' = 'external_room_turn_v1' AND other.input->>'acceptanceId' = a.id::text) THEN
        RAISE EXCEPTION 'Bolter acceptance canonical work mismatch' USING ERRCODE = '23514';
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END; $$;--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.guard_bolter_final_reply()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE b public.bolter_room_bindings%ROWTYPE; i public.bolter_inbox_receipts%ROWTYPE;
  j public.jobs%ROWTYPE; a public.work_acceptances%ROWTYPE;
BEGIN
  IF TG_OP = 'INSERT' OR NEW.state IN ('pending','publishing','published') THEN
    IF NEW.source_inbox_id IS NULL OR NEW.explicit_share_id IS NOT NULL THEN
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
          AND btrim(m.content) <> '' AND m.human_turn_id = i.turn_id
          AND m.tool_calls IS NULL AND m.tool_name IS NULL
          AND m.reply_to_message_id = i.session_message_id AND m.fingerprint = NEW.fingerprint
          AND m.metadata->'externalFinalReply' = jsonb_build_object('kind','bolter_final_reply_v1',
            'receiptId',i.id::text,'jobId',j.id::text,'turnId',i.turn_id,'acceptanceId',a.id::text)) THEN
      RAISE EXCEPTION 'Bolter final reply causality mismatch' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END; $$;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.guard_bolter_final_reply() FROM PUBLIC, nautilo_agent, nautilo_crypto;--> statement-breakpoint
CREATE TRIGGER bolter_final_reply_authority BEFORE INSERT OR UPDATE ON public.bolter_outbox
FOR EACH ROW EXECUTE FUNCTION public.guard_bolter_final_reply();
