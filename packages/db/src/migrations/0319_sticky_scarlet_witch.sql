ALTER TABLE "reflection_record_semantic_work" DROP CONSTRAINT "reflection_record_semantic_work_completion_coherent";--> statement-breakpoint
DROP TRIGGER IF EXISTS "reflection_record_semantic_work_update_guard" ON "public"."reflection_record_semantic_work";--> statement-breakpoint
ALTER TABLE "reflection_record_search_projections" ADD COLUMN "room_anchor_commitment" text;--> statement-breakpoint
ALTER TABLE "reflection_record_semantic_work" ADD COLUMN "recovery_policy_version" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "reflection_record_semantic_work" ADD COLUMN "projection_refresh_only" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "reflection_record_semantic_work" ADD COLUMN "failure_detail" text;--> statement-breakpoint
ALTER TABLE "reflection_record_semantic_work" ADD COLUMN "waiting_reason" text;--> statement-breakpoint
ALTER TABLE "reflection_record_semantic_work" ADD COLUMN "completion_outcome" text;--> statement-breakpoint
UPDATE "reflection_record_semantic_work"
   SET "completion_outcome" = 'completed'
 WHERE "state" = 'complete';--> statement-breakpoint
ALTER TABLE "reflection_record_search_projections" ADD CONSTRAINT "reflection_record_search_projections_room_anchor_commitment_portable" CHECK (octet_length("reflection_record_search_projections"."room_anchor_commitment") between 1 and 128
      and "reflection_record_search_projections"."room_anchor_commitment" ~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]*$');--> statement-breakpoint
ALTER TABLE "reflection_record_semantic_work" ADD CONSTRAINT "reflection_record_semantic_work_recovery_policy_version_bound" CHECK ("reflection_record_semantic_work"."recovery_policy_version" >= 0);--> statement-breakpoint
ALTER TABLE "reflection_record_semantic_work" ADD CONSTRAINT "reflection_record_semantic_work_failure_detail_coherent" CHECK ("reflection_record_semantic_work"."failure_detail" is null
        or (
          "reflection_record_semantic_work"."state" in ('deferred', 'quarantined')
          and "reflection_record_semantic_work"."failure_detail" in (
            'candidate_projection_stale', 'candidate_rank_timeout', 'candidate_rank_storage_unavailable', 'candidate_topology_timeout', 'candidate_topology_storage_unavailable', 'candidate_topology_capacity_exceeded', 'candidate_fence_stale', 'candidate_fence_timeout', 'candidate_fence_storage_unavailable', 'candidate_record_changed', 'candidate_selection_invalid', 'parent_conflict_capacity_exceeded', 'parent_conflict_storage_unavailable', 'publication_source_unavailable', 'publication_evidence_unavailable', 'publication_validation_unavailable', 'publication_budget_exhausted', 'publication_integrity_unavailable', 'publication_repository_rejected', 'publication_unexpected_exception', 'publication_record_already_exists', 'publication_invalid_record_shape', 'publication_child_unavailable', 'publication_child_parent_changed', 'publication_height_mismatch', 'publication_ancestor_cycle', 'publication_predecessor_changed', 'publication_successor_changed', 'publication_plan_stale', 'publication_authority_fence_stale', 'publication_plan_invalid', 'publication_memory_fence_unavailable', 'publication_access_audience_unavailable', 'publication_legacy_leaf_unavailable', 'publication_input_access_audience_unavailable', 'publication_output_access_audience_unavailable', 'publication_revalidation_access_audience_unavailable', 'publication_source_authority_unavailable', 'publication_incomplete', 'unexpected_authority_stage_failure', 'unexpected_search_projection_stage_failure', 'unexpected_dependency_loss_stage_failure', 'unexpected_candidate_stage_failure', 'unexpected_model_invocation_failure', 'unexpected_proposal_validation_failure', 'unexpected_publication_stage_failure', 'unexpected_work_mutation_failure'
          )
        ));--> statement-breakpoint
ALTER TABLE "reflection_record_semantic_work" ADD CONSTRAINT "reflection_record_semantic_work_waiting_reason_coherent" CHECK ("reflection_record_semantic_work"."waiting_reason" is null
        or (
          "reflection_record_semantic_work"."state" in ('due', 'checkpointed', 'deferred')
          and "reflection_record_semantic_work"."waiting_reason" in ('authority', 'search_projection', 'provider', 'capacity')
        ));--> statement-breakpoint
ALTER TABLE "reflection_record_semantic_work" ADD CONSTRAINT "reflection_record_semantic_work_completion_outcome_coherent" CHECK (("reflection_record_semantic_work"."state" = 'complete') = ("reflection_record_semantic_work"."completion_outcome" is not null)
        and ("reflection_record_semantic_work"."completion_outcome" is null or "reflection_record_semantic_work"."completion_outcome" in (
          'record_lifecycle_obsolete', 'already_covered', 'publication_reconciled',
          'dependency_repaired', 'dependency_retired', 'completed',
          'provider_outcome_unknown'
        )));--> statement-breakpoint
ALTER TABLE "reflection_record_semantic_work" ADD CONSTRAINT "reflection_record_semantic_work_completion_coherent" CHECK ((
        "reflection_record_semantic_work"."state" = 'complete'
        and (
          "reflection_record_semantic_work"."stage" = 'organization'
          or "reflection_record_semantic_work"."change_reason" = 'parent_conflict'
          or ("reflection_record_semantic_work"."stage" = 'search_projection' and "reflection_record_semantic_work"."projection_refresh_only")
          or "reflection_record_semantic_work"."completion_outcome" in (
            'record_lifecycle_obsolete', 'already_covered',
            'publication_reconciled'
          )
        )
        and "reflection_record_semantic_work"."completed_generation" = "reflection_record_semantic_work"."generation"
        and "reflection_record_semantic_work"."completed_at" is not null
      ) or (
        "reflection_record_semantic_work"."state" <> 'complete'
        and "reflection_record_semantic_work"."completed_at" is null
      ));
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "public"."reflection_semantic_work_guard_update"()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog AS $$
BEGIN
  -- Rolling-upgrade compatibility: legacy writers do not know these additive
  -- diagnostics, so normalize them from the canonical transition they do set.
  IF NEW.generation > OLD.generation THEN
    NEW.projection_refresh_only := false;
    NEW.failure_detail := NULL;
    NEW.waiting_reason := NULL;
    NEW.completion_outcome := NULL;
  ELSE
    IF NEW.state = 'complete' THEN
      NEW.completion_outcome := coalesce(NEW.completion_outcome, 'completed');
    ELSE
      NEW.completion_outcome := NULL;
    END IF;
    IF NEW.state NOT IN ('deferred', 'quarantined') THEN
      NEW.failure_detail := NULL;
    END IF;
    IF NEW.state NOT IN ('due', 'checkpointed', 'deferred') THEN
      NEW.waiting_reason := NULL;
    END IF;
  END IF;

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
       OR NEW.failure_detail IS NOT NULL
       OR NEW.waiting_reason IS NOT NULL
       OR NEW.completion_outcome IS NOT NULL
       OR NEW.projection_refresh_only
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
       WHEN 'parent_conflict' THEN 4
     END) < (CASE OLD.change_reason
       WHEN 'scheduled_review' THEN 0
       WHEN 'created' THEN 1
       WHEN 'revised' THEN 2
       WHEN 'dependency_lost' THEN 3
       WHEN 'parent_conflict' THEN 4
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
  ) AND NOT (
    OLD.stage = 'organization'
    AND NEW.stage = 'search_projection'
    AND OLD.state <> 'claimed'
    AND NEW.state = OLD.state
    AND OLD.completed_generation < OLD.generation
    AND NEW.generation = OLD.generation
    AND OLD.claim_generation IS NULL
    AND NEW.claim_generation IS NULL
    AND OLD.lease_token IS NULL
    AND NEW.lease_token IS NULL
    AND OLD.lease_expires_at IS NULL
    AND NEW.lease_expires_at IS NULL
    AND NOT NEW.projection_refresh_only
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
--> statement-breakpoint
CREATE TRIGGER "reflection_record_semantic_work_update_guard"
BEFORE UPDATE ON "public"."reflection_record_semantic_work"
FOR EACH ROW EXECUTE FUNCTION "public"."reflection_semantic_work_guard_update"();
