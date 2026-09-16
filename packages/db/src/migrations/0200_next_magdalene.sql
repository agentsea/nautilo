ALTER TABLE "conversation_shadow_turn_operations" DROP CONSTRAINT "conversation_shadow_turn_operations_ids_portable";--> statement-breakpoint
ALTER TABLE "conversation_shadow_turn_operations" DROP CONSTRAINT "conversation_shadow_turn_operations_coordinate_shape";--> statement-breakpoint
ALTER TABLE "conversation_shadow_turn_operations" DROP CONSTRAINT "conversation_shadow_turn_operations_authority_scheme";--> statement-breakpoint
ALTER TABLE "conversation_shadow_turn_operations" DROP CONSTRAINT "conversation_shadow_turn_operations_digest_shape";--> statement-breakpoint
ALTER TABLE "conversation_shadow_turn_operations" ADD COLUMN "grant_domain_id" text;--> statement-breakpoint
ALTER TABLE "conversation_shadow_turn_operations" ADD COLUMN "grant_domain_participant_digest" "bytea";--> statement-breakpoint
ALTER TABLE "conversation_shadow_turn_operations" ADD COLUMN "grant_domain_key_generation" bigint;--> statement-breakpoint
ALTER TABLE "conversation_shadow_turn_operations" ADD COLUMN "grant_domain_head_digest" "bytea";--> statement-breakpoint
ALTER TABLE "conversation_shadow_turn_operations" ADD COLUMN "grant_domain_publication_digest" "bytea";--> statement-breakpoint
ALTER TABLE "conversation_shadow_turn_operations" ADD COLUMN "grant_domain_authorization_revision" bigint;--> statement-breakpoint
ALTER TABLE "conversation_shadow_turn_operations" ADD COLUMN "namespace_bundle_revision" bigint;--> statement-breakpoint
ALTER TABLE "conversation_shadow_turn_operations" ADD COLUMN "namespace_bundle_digest" "bytea";--> statement-breakpoint
ALTER TABLE "conversation_shadow_turn_operations" ADD CONSTRAINT "conversation_shadow_turn_operations_ids_portable" CHECK (octet_length("conversation_shadow_turn_operations"."operation_id") between 1 and 128
        and "conversation_shadow_turn_operations"."operation_id" ~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]*$'
        and octet_length("conversation_shadow_turn_operations"."client_idempotency_key") between 1 and 128
        and "conversation_shadow_turn_operations"."client_idempotency_key" ~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]*$'
        and octet_length("conversation_shadow_turn_operations"."subject_human_id") between 1 and 128
        and "conversation_shadow_turn_operations"."subject_human_id" ~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]*$'
        and octet_length("conversation_shadow_turn_operations"."committer_device_id") between 1 and 128
        and "conversation_shadow_turn_operations"."committer_device_id" ~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]*$'
        and octet_length("conversation_shadow_turn_operations"."domain_id") between 1 and 128
        and "conversation_shadow_turn_operations"."domain_id" ~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]*$'
        and octet_length("conversation_shadow_turn_operations"."grant_domain_id") between 1 and 128
        and "conversation_shadow_turn_operations"."grant_domain_id" ~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]*$'
        and octet_length("conversation_shadow_turn_operations"."recipient_id") between 1 and 128
        and "conversation_shadow_turn_operations"."recipient_id" ~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]*$'
        and octet_length("conversation_shadow_turn_operations"."recipient_key_id") between 1 and 128
        and "conversation_shadow_turn_operations"."recipient_key_id" ~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]*$'
        and octet_length("conversation_shadow_turn_operations"."attempt_coordinate") between 1 and 128
        and "conversation_shadow_turn_operations"."attempt_coordinate" ~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]*$');--> statement-breakpoint
ALTER TABLE "conversation_shadow_turn_operations" ADD CONSTRAINT "conversation_shadow_turn_operations_coordinate_shape" CHECK ("conversation_shadow_turn_operations"."policy_revision" > 0
        and "conversation_shadow_turn_operations"."human_message_id" > 0
        and "conversation_shadow_turn_operations"."host_authorization_revision" >= 0
        and "conversation_shadow_turn_operations"."agent_authorization_revision" >= 0
        and "conversation_shadow_turn_operations"."namespace_access_revision" >= 0
        and "conversation_shadow_turn_operations"."namespace_key_generation" >= 0
        and ("conversation_shadow_turn_operations"."committer_device_signing_key_generation" is null
          or "conversation_shadow_turn_operations"."committer_device_signing_key_generation" >= 0)
        and ("conversation_shadow_turn_operations"."binding_revision_at_wrap" is null
          or "conversation_shadow_turn_operations"."binding_revision_at_wrap" >= 0)
        and ("conversation_shadow_turn_operations"."domain_epoch" is null or "conversation_shadow_turn_operations"."domain_epoch" >= 0)
        and ("conversation_shadow_turn_operations"."grant_domain_key_generation" is null
          or "conversation_shadow_turn_operations"."grant_domain_key_generation" >= 1)
        and ("conversation_shadow_turn_operations"."grant_domain_authorization_revision" is null
          or "conversation_shadow_turn_operations"."grant_domain_authorization_revision" >= 0)
        and ("conversation_shadow_turn_operations"."namespace_bundle_revision" is null
          or "conversation_shadow_turn_operations"."namespace_bundle_revision" >= 1));--> statement-breakpoint
ALTER TABLE "conversation_shadow_turn_operations" ADD CONSTRAINT "conversation_shadow_turn_operations_authority_scheme" CHECK ((
        "conversation_shadow_turn_operations"."namespace_authority_scheme" = 'domain_root_v1'
        and "conversation_shadow_turn_operations"."committer_device_signing_key_generation" is null
        and "conversation_shadow_turn_operations"."namespace_binding_hash" is not null
        and "conversation_shadow_turn_operations"."binding_revision_at_wrap" is not null
        and "conversation_shadow_turn_operations"."domain_id" is not null
        and "conversation_shadow_turn_operations"."domain_epoch" is not null
        and "conversation_shadow_turn_operations"."namespace_head_digest" is null
        and "conversation_shadow_turn_operations"."namespace_publication_digest" is null
        and "conversation_shadow_turn_operations"."namespace_publication_set_digest" is null
        and "conversation_shadow_turn_operations"."namespace_audience_fingerprint" is null
        and "conversation_shadow_turn_operations"."grant_domain_id" is null
        and "conversation_shadow_turn_operations"."grant_domain_participant_digest" is null
        and "conversation_shadow_turn_operations"."grant_domain_key_generation" is null
        and "conversation_shadow_turn_operations"."grant_domain_head_digest" is null
        and "conversation_shadow_turn_operations"."grant_domain_publication_digest" is null
        and "conversation_shadow_turn_operations"."grant_domain_authorization_revision" is null
        and "conversation_shadow_turn_operations"."namespace_bundle_revision" is null
        and "conversation_shadow_turn_operations"."namespace_bundle_digest" is null
        and "conversation_shadow_turn_operations"."agent_grant_plan_bytes" is null
        and "conversation_shadow_turn_operations"."agent_grant_plan_digest" is null
      ) or (
        "conversation_shadow_turn_operations"."namespace_authority_scheme" = 'device_wrapped_v1'
        and "conversation_shadow_turn_operations"."committer_device_signing_key_generation" is not null
        and "conversation_shadow_turn_operations"."namespace_binding_hash" is null
        and "conversation_shadow_turn_operations"."binding_revision_at_wrap" is null
        and "conversation_shadow_turn_operations"."domain_id" is null
        and "conversation_shadow_turn_operations"."domain_epoch" is null
        and "conversation_shadow_turn_operations"."namespace_head_digest" is not null
        and "conversation_shadow_turn_operations"."namespace_publication_digest" is not null
        and "conversation_shadow_turn_operations"."namespace_publication_set_digest" is not null
        and "conversation_shadow_turn_operations"."namespace_audience_fingerprint" is not null
        and "conversation_shadow_turn_operations"."grant_domain_id" is null
        and "conversation_shadow_turn_operations"."grant_domain_participant_digest" is null
        and "conversation_shadow_turn_operations"."grant_domain_key_generation" is null
        and "conversation_shadow_turn_operations"."grant_domain_head_digest" is null
        and "conversation_shadow_turn_operations"."grant_domain_publication_digest" is null
        and "conversation_shadow_turn_operations"."grant_domain_authorization_revision" is null
        and "conversation_shadow_turn_operations"."namespace_bundle_revision" is null
        and "conversation_shadow_turn_operations"."namespace_bundle_digest" is null
        and "conversation_shadow_turn_operations"."agent_grant_plan_bytes" is not null
        and "conversation_shadow_turn_operations"."agent_grant_plan_digest" is not null
      ) or (
        "conversation_shadow_turn_operations"."namespace_authority_scheme" = 'grant_domain_v1'
        and "conversation_shadow_turn_operations"."committer_device_signing_key_generation" is not null
        and "conversation_shadow_turn_operations"."namespace_binding_hash" is null
        and "conversation_shadow_turn_operations"."binding_revision_at_wrap" is null
        and "conversation_shadow_turn_operations"."domain_id" is null
        and "conversation_shadow_turn_operations"."domain_epoch" is null
        and "conversation_shadow_turn_operations"."namespace_head_digest" is not null
        and "conversation_shadow_turn_operations"."namespace_publication_digest" is not null
        and "conversation_shadow_turn_operations"."namespace_publication_set_digest" is not null
        and "conversation_shadow_turn_operations"."namespace_audience_fingerprint" is not null
        and "conversation_shadow_turn_operations"."grant_domain_id" is not null
        and "conversation_shadow_turn_operations"."grant_domain_participant_digest" is not null
        and "conversation_shadow_turn_operations"."grant_domain_key_generation" is not null
        and "conversation_shadow_turn_operations"."grant_domain_head_digest" is not null
        and "conversation_shadow_turn_operations"."grant_domain_publication_digest" is not null
        and "conversation_shadow_turn_operations"."grant_domain_authorization_revision" is not null
        and "conversation_shadow_turn_operations"."namespace_bundle_revision" is not null
        and "conversation_shadow_turn_operations"."namespace_bundle_digest" is not null
        and "conversation_shadow_turn_operations"."agent_grant_plan_bytes" is not null
        and "conversation_shadow_turn_operations"."agent_grant_plan_digest" is not null
      ));--> statement-breakpoint
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
        and ("conversation_shadow_turn_operations"."human_request_digest" is null or octet_length("conversation_shadow_turn_operations"."human_request_digest") = 32)
        and ("conversation_shadow_turn_operations"."grant_digest" is null or octet_length("conversation_shadow_turn_operations"."grant_digest") = 32)
        and ("conversation_shadow_turn_operations"."final_causal_event_digest" is null or octet_length("conversation_shadow_turn_operations"."final_causal_event_digest") = 32)
        and ("conversation_shadow_turn_operations"."client_verification_digest" is null or octet_length("conversation_shadow_turn_operations"."client_verification_digest") = 32));
--> statement-breakpoint
-- M290_DEVICE_WRAPPED_TURN_AUTHORITY
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
    NEW.committer_device_id, NEW.committer_device_signing_key_generation,
    NEW.host_authorization_revision, NEW.agent_id,
    NEW.agent_authorization_revision, NEW.namespace_id,
    NEW.namespace_authority_scheme, NEW.namespace_binding_hash,
    NEW.namespace_access_revision, NEW.namespace_key_generation,
    NEW.binding_revision_at_wrap, NEW.domain_id, NEW.domain_epoch,
    NEW.namespace_head_digest, NEW.namespace_publication_digest,
    NEW.namespace_publication_set_digest,
    NEW.namespace_audience_fingerprint, NEW.grant_domain_id,
    NEW.grant_domain_participant_digest, NEW.grant_domain_key_generation,
    NEW.grant_domain_head_digest, NEW.grant_domain_publication_digest,
    NEW.grant_domain_authorization_revision, NEW.namespace_bundle_revision,
    NEW.namespace_bundle_digest, NEW.agent_grant_plan_bytes,
    NEW.agent_grant_plan_digest, NEW.recipient_id, NEW.recipient_key_id,
    NEW.recipient_public_key, NEW.attempt_coordinate, NEW.plan_digest,
    NEW.deadline_at, NEW.created_at
  ) IS DISTINCT FROM ROW(
    OLD.sequence, OLD.operation_id, OLD.client_idempotency_key,
    OLD.policy_revision, OLD.session_id, OLD.room_id, OLD.human_message_id,
    OLD.human_message_created_at, OLD.subject_human_id,
    OLD.committer_device_id, OLD.committer_device_signing_key_generation,
    OLD.host_authorization_revision, OLD.agent_id,
    OLD.agent_authorization_revision, OLD.namespace_id,
    OLD.namespace_authority_scheme, OLD.namespace_binding_hash,
    OLD.namespace_access_revision, OLD.namespace_key_generation,
    OLD.binding_revision_at_wrap, OLD.domain_id, OLD.domain_epoch,
    OLD.namespace_head_digest, OLD.namespace_publication_digest,
    OLD.namespace_publication_set_digest,
    OLD.namespace_audience_fingerprint, OLD.grant_domain_id,
    OLD.grant_domain_participant_digest, OLD.grant_domain_key_generation,
    OLD.grant_domain_head_digest, OLD.grant_domain_publication_digest,
    OLD.grant_domain_authorization_revision, OLD.namespace_bundle_revision,
    OLD.namespace_bundle_digest, OLD.agent_grant_plan_bytes,
    OLD.agent_grant_plan_digest, OLD.recipient_id, OLD.recipient_key_id,
    OLD.recipient_public_key, OLD.attempt_coordinate, OLD.plan_digest,
    OLD.deadline_at, OLD.created_at
  ) THEN
    RAISE EXCEPTION 'conversation Shadow turn identity is immutable'
      USING ERRCODE = '23514';
  END IF;

  IF (OLD.human_request_digest IS NOT NULL
        AND NEW.human_request_digest IS DISTINCT FROM OLD.human_request_digest)
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
$$;
REVOKE ALL ON FUNCTION "public"."protect_conversation_shadow_turn_operation"()
  FROM PUBLIC, "nautilo_agent", "nautilo_crypto";
