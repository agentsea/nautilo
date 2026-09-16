ALTER TABLE "reflection_record_semantic_work" DROP CONSTRAINT "reflection_record_semantic_work_reason_closed";--> statement-breakpoint
ALTER TABLE "reflection_record_semantic_work" ADD CONSTRAINT "reflection_record_semantic_work_reason_closed" CHECK ("reflection_record_semantic_work"."change_reason" in (
        'scheduled_review', 'created', 'revised', 'dependency_lost'
      ));
--> statement-breakpoint
-- M279 REFLECTION CONVERGENCE FINALIZER
CREATE OR REPLACE FUNCTION "public"."reflection_semantic_work_guard_update"()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog AS $$
BEGIN
  IF NEW.record_id IS DISTINCT FROM OLD.record_id
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR NEW.generation < OLD.generation
     OR NEW.completed_generation < OLD.completed_generation
     OR NEW.updated_at < OLD.updated_at THEN
    RAISE EXCEPTION 'Reflection semantic work identity and generations are monotonic'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.generation > OLD.generation THEN
    IF NEW.generation <> OLD.generation + 1
       OR NEW.stage <> 'authority_projection'
       OR NEW.state <> 'due'
       OR NEW.completed_generation <> OLD.completed_generation
       OR NEW.attempt_count <> 0
       OR NEW.quarantine_round <> 0
       OR NEW.claim_generation IS NOT NULL
       OR NEW.lease_token IS NOT NULL
       OR NEW.lease_expires_at IS NOT NULL
       OR NEW.next_attempt_at IS NULL
       OR NEW.recover_after IS NOT NULL
       OR NEW.failure_code IS NOT NULL
       OR NEW.completed_at IS NOT NULL
       OR NEW.due_since < OLD.due_since THEN
      RAISE EXCEPTION 'New Reflection semantic work generation must advance exactly once and reset to due authority projection'
        USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;

  IF (CASE NEW.change_reason
       WHEN 'scheduled_review' THEN 0
       WHEN 'created' THEN 1
       WHEN 'revised' THEN 2
       WHEN 'dependency_lost' THEN 3
     END) < (CASE OLD.change_reason
       WHEN 'scheduled_review' THEN 0
       WHEN 'created' THEN 1
       WHEN 'revised' THEN 2
       WHEN 'dependency_lost' THEN 3
     END) THEN
    RAISE EXCEPTION 'Reflection semantic work reason cannot weaken within a generation'
      USING ERRCODE = '23514';
  END IF;

  IF OLD.state = 'complete' AND NEW IS DISTINCT FROM OLD THEN
    RAISE EXCEPTION 'Completed Reflection semantic work requires a newer generation'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.stage IS DISTINCT FROM OLD.stage AND NOT (
    OLD.state = 'claimed'
    AND NEW.state = 'checkpointed'
    AND (
      (OLD.stage = 'authority_projection' AND NEW.stage = 'search_projection')
      OR (OLD.stage = 'search_projection' AND NEW.stage = 'organization')
    )
  ) THEN
    RAISE EXCEPTION 'Invalid Reflection semantic work stage checkpoint'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.state IS DISTINCT FROM OLD.state AND NOT (
    (OLD.state IN ('due', 'checkpointed', 'deferred', 'claimed', 'quarantined')
      AND NEW.state = 'claimed')
    OR (OLD.state = 'claimed'
      AND NEW.state IN ('due', 'checkpointed', 'deferred', 'complete', 'quarantined'))
    OR (OLD.state IN ('due', 'checkpointed', 'deferred')
      AND NEW.state = 'quarantined')
  ) THEN
    RAISE EXCEPTION 'Invalid Reflection semantic work state transition'
      USING ERRCODE = '23514';
  END IF;

  IF OLD.state = 'quarantined' AND NEW.state = 'claimed' AND (
    NEW.quarantine_round <> OLD.quarantine_round
    OR NEW.attempt_count <> 1
    OR NEW.claim_generation <> NEW.generation
    OR NEW.lease_token IS NULL
    OR NEW.lease_expires_at IS NULL
    OR NEW.next_attempt_at IS NOT NULL
    OR NEW.recover_after IS NOT NULL
    OR NEW.failure_code IS NOT NULL
    OR NEW.completed_at IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'Quarantined Reflection semantic work recovery must preserve its generation and recovery round'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.state = 'quarantined' AND OLD.state <> 'quarantined' AND (
    NEW.quarantine_round <> OLD.quarantine_round + 1
    OR NEW.recover_after IS NULL
    OR NEW.next_attempt_at IS NOT NULL
    OR NEW.failure_code IS NULL
  ) THEN
    RAISE EXCEPTION 'Reflection semantic work quarantine must advance its recovery round and retain its failure'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.state = 'complete' AND (
    NEW.quarantine_round <> 0 OR NEW.recover_after IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'Completed Reflection semantic work must clear recovery state'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.state NOT IN ('complete', 'quarantined')
     AND NOT (OLD.state = 'quarantined' AND NEW.state = 'claimed')
     AND NEW.quarantine_round <> OLD.quarantine_round THEN
    RAISE EXCEPTION 'Reflection semantic work recovery round changes only at quarantine or completion'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;
