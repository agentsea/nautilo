ALTER TABLE "conversation_shared_agent_shadow_operations" DROP CONSTRAINT "conversation_shared_agent_shadow_operations_time_order";--> statement-breakpoint
ALTER TABLE "conversation_shared_agent_shadow_operations" ADD CONSTRAINT "conversation_shared_agent_shadow_operations_time_order" CHECK ("conversation_shared_agent_shadow_operations"."deadline_at" > "conversation_shared_agent_shadow_operations"."created_at"
        and "conversation_shared_agent_shadow_operations"."updated_at" >= "conversation_shared_agent_shadow_operations"."created_at"
        and ("conversation_shared_agent_shadow_operations"."human_verified_at" is null
          or "conversation_shared_agent_shadow_operations"."human_verified_at" >= "conversation_shared_agent_shadow_operations"."created_at")
        and ("conversation_shared_agent_shadow_operations"."conductor_resolved_at" is null
          or "conversation_shared_agent_shadow_operations"."conductor_resolved_at" >= "conversation_shared_agent_shadow_operations"."created_at")
        and ("conversation_shared_agent_shadow_operations"."terminal_at" is null
          or "conversation_shared_agent_shadow_operations"."terminal_at" >= "conversation_shared_agent_shadow_operations"."created_at"));
--> statement-breakpoint
-- M298_RUNTIME_CONDUCTOR_LIFECYCLE
CREATE OR REPLACE FUNCTION "public"."protect_conversation_shared_agent_shadow_operation"()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog
AS $$
BEGIN
  IF ROW(
    NEW.sequence, NEW.operation_id, NEW.client_idempotency_key,
    NEW.policy_revision, NEW.session_id, NEW.room_id, NEW.agent_id,
    NEW.human_message_id,
    NEW.human_message_created_at, NEW.transcript_ordinal,
    NEW.subject_human_id, NEW.committer_device_id,
    NEW.committer_device_signing_key_generation,
    NEW.host_authorization_revision, NEW.namespace_id,
    NEW.namespace_access_revision, NEW.namespace_key_generation,
    NEW.namespace_head_digest, NEW.namespace_publication_digest,
    NEW.namespace_publication_set_digest,
    NEW.namespace_audience_fingerprint, NEW.crypto_object_id,
    NEW.attempt_coordinate, NEW.plan_digest, NEW.plan_bytes,
    NEW.deadline_at, NEW.created_at
  ) IS DISTINCT FROM ROW(
    OLD.sequence, OLD.operation_id, OLD.client_idempotency_key,
    OLD.policy_revision, OLD.session_id, OLD.room_id, OLD.agent_id,
    OLD.human_message_id,
    OLD.human_message_created_at, OLD.transcript_ordinal,
    OLD.subject_human_id, OLD.committer_device_id,
    OLD.committer_device_signing_key_generation,
    OLD.host_authorization_revision, OLD.namespace_id,
    OLD.namespace_access_revision, OLD.namespace_key_generation,
    OLD.namespace_head_digest, OLD.namespace_publication_digest,
    OLD.namespace_publication_set_digest,
    OLD.namespace_audience_fingerprint, OLD.crypto_object_id,
    OLD.attempt_coordinate, OLD.plan_digest, OLD.plan_bytes,
    OLD.deadline_at, OLD.created_at
  ) THEN
    RAISE EXCEPTION 'Shared-Agent Shadow operation identity is immutable'
      USING ERRCODE = '23514';
  END IF;

  IF (OLD.human_request_digest IS NOT NULL
        AND NEW.human_request_digest IS DISTINCT FROM OLD.human_request_digest)
    OR (OLD.human_request_bytes IS NOT NULL
        AND NEW.human_request_bytes IS DISTINCT FROM OLD.human_request_bytes)
    OR (OLD.protected_message_digest IS NOT NULL
        AND NEW.protected_message_digest IS DISTINCT FROM OLD.protected_message_digest)
    OR (OLD.final_event_digest IS NOT NULL
        AND NEW.final_event_digest IS DISTINCT FROM OLD.final_event_digest)
    OR (OLD.human_verified_at IS NOT NULL
        AND NEW.human_verified_at IS DISTINCT FROM OLD.human_verified_at)
    OR (OLD.terminal_at IS NOT NULL
        AND NEW.terminal_at IS DISTINCT FROM OLD.terminal_at)
    OR (OLD.terminal_stage IS NOT NULL
        AND NEW.terminal_stage IS DISTINCT FROM OLD.terminal_stage)
    OR (OLD.terminal_reason IS NOT NULL
        AND NEW.terminal_reason IS DISTINCT FROM OLD.terminal_reason)
    OR (OLD.conductor_reason IS NOT NULL
        AND NEW.conductor_reason IS DISTINCT FROM OLD.conductor_reason
        AND NOT (
          OLD.conductor_state = 'awaiting_user'
          AND NEW.conductor_state IN ('selected', 'unavailable')
        ))
    OR (OLD.conductor_resolved_at IS NOT NULL
        AND NEW.conductor_resolved_at IS DISTINCT FROM OLD.conductor_resolved_at
        AND NOT (
          OLD.conductor_state = 'awaiting_user'
          AND NEW.conductor_state IN ('selected', 'unavailable')
        ))
  THEN
    RAISE EXCEPTION 'Shared-Agent Shadow receipt is immutable after publication'
      USING ERRCODE = '23514';
  END IF;

  IF NOT (
    NEW.state = OLD.state
    OR (OLD.state = 'planned'
      AND NEW.state IN ('human_verified', 'fallback', 'failed'))
    OR (OLD.state = 'human_verified'
      AND NEW.state IN ('published', 'fallback', 'failed'))
  ) THEN
    RAISE EXCEPTION 'Shared-Agent Shadow state transition is invalid'
      USING ERRCODE = '23514';
  END IF;
  IF NEW.reconciliation_attempt_count < OLD.reconciliation_attempt_count
    OR NEW.updated_at < OLD.updated_at
  THEN
    RAISE EXCEPTION 'Shared-Agent Shadow counters and time are monotonic'
      USING ERRCODE = '23514';
  END IF;
  IF NOT (
    NEW.conductor_state = OLD.conductor_state
    OR (OLD.conductor_state = 'pending'
      AND NEW.conductor_state IN ('awaiting_user', 'not_selected', 'selected', 'unavailable'))
    OR (OLD.conductor_state = 'awaiting_user'
      AND NEW.conductor_state IN ('selected', 'unavailable'))
  ) THEN
    RAISE EXCEPTION 'Shared-Agent Conductor transition is invalid'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION "public"."protect_conversation_shared_agent_shadow_operation"()
  FROM PUBLIC, "nautilo_agent", "nautilo_crypto";
