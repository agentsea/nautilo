ALTER TABLE "conversation_shadow_turn_operations" DROP CONSTRAINT "conversation_shadow_turn_operations_digest_shape";--> statement-breakpoint
ALTER TABLE "conversation_shadow_turn_operations" DROP CONSTRAINT "conversation_shadow_turn_operations_receipt_coherent";--> statement-breakpoint
ALTER TABLE "conversation_shadow_turn_operations" ADD COLUMN "plan_bytes" "bytea";--> statement-breakpoint
ALTER TABLE "conversation_shadow_turn_operations" ADD COLUMN "human_request_bytes" "bytea";--> statement-breakpoint
ALTER TABLE "conversation_shadow_turn_operations" ADD CONSTRAINT "conversation_shadow_turn_operations_digest_shape" CHECK (("conversation_shadow_turn_operations"."namespace_binding_hash" is null or octet_length("conversation_shadow_turn_operations"."namespace_binding_hash") = 32)
        and ("conversation_shadow_turn_operations"."namespace_head_digest" is null or octet_length("conversation_shadow_turn_operations"."namespace_head_digest") = 32)
        and ("conversation_shadow_turn_operations"."namespace_publication_digest" is null or octet_length("conversation_shadow_turn_operations"."namespace_publication_digest") = 32)
        and ("conversation_shadow_turn_operations"."namespace_publication_set_digest" is null or octet_length("conversation_shadow_turn_operations"."namespace_publication_set_digest") = 32)
        and ("conversation_shadow_turn_operations"."namespace_audience_fingerprint" is null or octet_length("conversation_shadow_turn_operations"."namespace_audience_fingerprint") = 32)
        and ("conversation_shadow_turn_operations"."grant_domain_participant_digest" is null or octet_length("conversation_shadow_turn_operations"."grant_domain_participant_digest") = 32)
        and ("conversation_shadow_turn_operations"."grant_domain_head_digest" is null or octet_length("conversation_shadow_turn_operations"."grant_domain_head_digest") = 32)
        and ("conversation_shadow_turn_operations"."grant_domain_publication_digest" is null or octet_length("conversation_shadow_turn_operations"."grant_domain_publication_digest") = 32)
        and ("conversation_shadow_turn_operations"."namespace_bundle_digest" is null or octet_length("conversation_shadow_turn_operations"."namespace_bundle_digest") = 32)
        and ("conversation_shadow_turn_operations"."agent_grant_plan_digest" is null or octet_length("conversation_shadow_turn_operations"."agent_grant_plan_digest") = 32)
        and ("conversation_shadow_turn_operations"."agent_grant_plan_bytes" is null or octet_length("conversation_shadow_turn_operations"."agent_grant_plan_bytes") between 1 and 1048576)
        and octet_length("conversation_shadow_turn_operations"."plan_digest") = 32
        and ("conversation_shadow_turn_operations"."plan_bytes" is null or octet_length("conversation_shadow_turn_operations"."plan_bytes") between 1 and 262144)
        and ("conversation_shadow_turn_operations"."human_request_digest" is null or octet_length("conversation_shadow_turn_operations"."human_request_digest") = 32)
        and ("conversation_shadow_turn_operations"."human_request_bytes" is null or octet_length("conversation_shadow_turn_operations"."human_request_bytes") between 1 and 16384)
        and ("conversation_shadow_turn_operations"."grant_digest" is null or octet_length("conversation_shadow_turn_operations"."grant_digest") = 32)
        and ("conversation_shadow_turn_operations"."final_causal_event_digest" is null or octet_length("conversation_shadow_turn_operations"."final_causal_event_digest") = 32)
        and ("conversation_shadow_turn_operations"."client_verification_digest" is null or octet_length("conversation_shadow_turn_operations"."client_verification_digest") = 32));--> statement-breakpoint
ALTER TABLE "conversation_shadow_turn_operations" ADD CONSTRAINT "conversation_shadow_turn_operations_receipt_coherent" CHECK ((("conversation_shadow_turn_operations"."plan_bytes" is null and "conversation_shadow_turn_operations"."human_request_bytes" is null)
          or ("conversation_shadow_turn_operations"."plan_bytes" is not null
            and "conversation_shadow_turn_operations"."human_request_bytes" is not null
            and "conversation_shadow_turn_operations"."human_request_digest" is not null))
        and ("conversation_shadow_turn_operations"."human_request_digest" is null) = ("conversation_shadow_turn_operations"."grant_digest" is null)
        and ("conversation_shadow_turn_operations"."state" not in ('human_verified', 'running', 'completed', 'client_verified')
          or "conversation_shadow_turn_operations"."human_request_digest" is not null)
        and ("conversation_shadow_turn_operations"."client_verification_digest" is null
          or "conversation_shadow_turn_operations"."state" in ('client_verified', 'failed'))
        and ("conversation_shadow_turn_operations"."final_causal_event_digest" is null
          or "conversation_shadow_turn_operations"."state" in ('completed', 'client_verified')));
--> statement-breakpoint
-- M275_LIVE_SHADOW_READ_EVIDENCE
CREATE OR REPLACE FUNCTION "public"."protect_conversation_shadow_turn_operation"()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog
AS $$
BEGIN
  IF ROW(
    NEW.sequence, NEW.operation_id, NEW.client_idempotency_key,
    NEW.policy_revision, NEW.session_id, NEW.room_id, NEW.human_message_id,
    NEW.human_message_created_at, NEW.subject_human_id,
    NEW.committer_device_id, NEW.host_authorization_revision,
    NEW.agent_id, NEW.agent_authorization_revision, NEW.namespace_id,
    NEW.namespace_binding_hash, NEW.namespace_access_revision,
    NEW.namespace_key_generation, NEW.binding_revision_at_wrap,
    NEW.domain_id, NEW.domain_epoch, NEW.recipient_id, NEW.recipient_key_id,
    NEW.recipient_public_key, NEW.attempt_coordinate, NEW.plan_digest,
    NEW.deadline_at, NEW.created_at
  ) IS DISTINCT FROM ROW(
    OLD.sequence, OLD.operation_id, OLD.client_idempotency_key,
    OLD.policy_revision, OLD.session_id, OLD.room_id, OLD.human_message_id,
    OLD.human_message_created_at, OLD.subject_human_id,
    OLD.committer_device_id, OLD.host_authorization_revision,
    OLD.agent_id, OLD.agent_authorization_revision, OLD.namespace_id,
    OLD.namespace_binding_hash, OLD.namespace_access_revision,
    OLD.namespace_key_generation, OLD.binding_revision_at_wrap,
    OLD.domain_id, OLD.domain_epoch, OLD.recipient_id, OLD.recipient_key_id,
    OLD.recipient_public_key, OLD.attempt_coordinate, OLD.plan_digest,
    OLD.deadline_at, OLD.created_at
  ) THEN
    RAISE EXCEPTION 'conversation Shadow turn identity is immutable'
      USING ERRCODE = '23514';
  END IF;

  IF (OLD.plan_bytes IS NOT NULL
        AND NEW.plan_bytes IS DISTINCT FROM OLD.plan_bytes)
    OR (OLD.human_request_digest IS NOT NULL
        AND NEW.human_request_digest IS DISTINCT FROM OLD.human_request_digest)
    OR (OLD.human_request_bytes IS NOT NULL
        AND NEW.human_request_bytes IS DISTINCT FROM OLD.human_request_bytes)
    OR (OLD.grant_digest IS NOT NULL
        AND NEW.grant_digest IS DISTINCT FROM OLD.grant_digest)
    OR (OLD.final_causal_event_digest IS NOT NULL
        AND NEW.final_causal_event_digest IS DISTINCT FROM OLD.final_causal_event_digest)
    OR (OLD.client_verification_digest IS NOT NULL
        AND NEW.client_verification_digest IS DISTINCT FROM OLD.client_verification_digest)
    OR (OLD.job_id IS NOT NULL AND NEW.job_id IS DISTINCT FROM OLD.job_id)
    OR (OLD.started_at IS NOT NULL AND NEW.started_at IS DISTINCT FROM OLD.started_at)
    OR (OLD.terminal_at IS NOT NULL AND NEW.terminal_at IS DISTINCT FROM OLD.terminal_at)
  THEN
    RAISE EXCEPTION 'conversation Shadow turn receipt is immutable after publication'
      USING ERRCODE = '23514';
  END IF;

  IF NOT (
    NEW.state = OLD.state
    OR (OLD.state = 'planned' AND NEW.state IN ('human_verified', 'fallback', 'failed'))
    OR (OLD.state = 'human_verified' AND NEW.state IN ('running', 'fallback', 'failed'))
    OR (OLD.state = 'running' AND NEW.state IN ('fallback', 'completed', 'failed'))
    OR (OLD.state = 'completed' AND NEW.state IN ('client_verified', 'failed'))
  ) THEN
    RAISE EXCEPTION 'conversation Shadow turn state transition is invalid'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.reconciliation_attempt_count < OLD.reconciliation_attempt_count
    OR NEW.updated_at < OLD.updated_at
  THEN
    RAISE EXCEPTION 'conversation Shadow turn counters and time are monotonic'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION "public"."protect_conversation_shadow_turn_operation"()
  FROM PUBLIC, "nautilo_agent", "nautilo_crypto";--> statement-breakpoint
