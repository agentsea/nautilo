ALTER TABLE "session_messages" ADD COLUMN "external_authorship" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "session_messages" ADD CONSTRAINT "session_messages_external_authorship_role_check" CHECK (NOT "session_messages"."external_authorship" OR "session_messages"."role" = 'user');
--> statement-breakpoint
-- EXTERNAL_AUTHORSHIP_RESTRICTIVE_PROVENANCE
-- Metadata assertions confer no authorship authority; they can only demand
-- distrust. Existing canonical receipt joins supply the same restriction.
UPDATE public.session_messages m SET external_authorship = true
WHERE m.role = 'user' AND (coalesce(m.metadata ? 'externalOrigin', false)
  OR coalesce(m.metadata ? 'externalReceiptId', false)
  OR EXISTS (SELECT 1 FROM public.bolter_inbox_receipts i WHERE i.session_message_id = m.id));--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.guard_external_authorship()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND OLD.external_authorship AND NOT NEW.external_authorship THEN
    RAISE EXCEPTION 'External authorship restriction is immutable' USING ERRCODE = '23514';
  END IF;
  IF NEW.role = 'user' AND (coalesce(NEW.metadata ? 'externalOrigin', false)
    OR coalesce(NEW.metadata ? 'externalReceiptId', false)) THEN NEW.external_authorship := true; END IF;
  RETURN NEW;
END; $$;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.guard_external_authorship() FROM PUBLIC, nautilo_agent, nautilo_crypto;--> statement-breakpoint
CREATE TRIGGER session_message_external_authorship BEFORE INSERT OR UPDATE ON public.session_messages
FOR EACH ROW EXECUTE FUNCTION public.guard_external_authorship();--> statement-breakpoint
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
        OR NOT EXISTS (SELECT 1 FROM public.session_messages m WHERE m.id = NEW.session_message_id
          AND m.metadata->>'externalReceiptId' = NEW.id::text AND m.transcript_origin = 'main' AND m.external_authorship)
        OR EXISTS (SELECT 1 FROM public.jobs other WHERE other.id <> j.id
          AND other.input->>'kind' = 'external_room_turn_v1' AND other.input->>'acceptanceId' = a.id::text) THEN
        RAISE EXCEPTION 'Bolter acceptance canonical work mismatch' USING ERRCODE = '23514';
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END; $$;
