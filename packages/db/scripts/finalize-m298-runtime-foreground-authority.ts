import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

export const M298_RUNTIME_FOREGROUND_AUTHORITY_MARKER =
  "-- M298_RUNTIME_FOREGROUND_AUTHORITY";

const INVOCATION_TABLE = "conversation_shared_agent_shadow_invocations";
const INVOCATION_SEQUENCE = `${INVOCATION_TABLE}_sequence_seq`;
export const M298_RUNTIME_FOREGROUND_RESUME_AUTHORITY_MARKER =
  "-- M298_RUNTIME_FOREGROUND_RESUME_AUTHORITY";
export const M298_RUNTIME_HUMAN_AUDIENCE_REVISION_MARKER =
  "-- M298_RUNTIME_HUMAN_AUDIENCE_REVISION";
export const M298_RUNTIME_CONDUCTOR_LIFECYCLE_MARKER =
  "-- M298_RUNTIME_CONDUCTOR_LIFECYCLE";

function conductorLifecycleSql(): string {
  return `${M298_RUNTIME_CONDUCTOR_LIFECYCLE_MARKER}
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
  FROM PUBLIC, "nautilo_agent", "nautilo_crypto";`;
}

function authoritySql(): string {
  return `${M298_RUNTIME_FOREGROUND_AUTHORITY_MARKER}
ALTER TABLE "${INVOCATION_TABLE}" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL PRIVILEGES ON TABLE "${INVOCATION_TABLE}"
  FROM PUBLIC, "nautilo_agent", "nautilo_crypto";--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON TABLE "${INVOCATION_TABLE}"
  TO "nautilo";--> statement-breakpoint
REVOKE ALL PRIVILEGES ON SEQUENCE "${INVOCATION_SEQUENCE}"
  FROM PUBLIC, "nautilo_agent", "nautilo_crypto";--> statement-breakpoint
GRANT USAGE ON SEQUENCE "${INVOCATION_SEQUENCE}" TO "nautilo";--> statement-breakpoint

CREATE OR REPLACE FUNCTION "public"."validate_conversation_shared_agent_shadow_invocation"()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog
AS $$
BEGIN
  PERFORM 1
    FROM "public"."sessions" AS session_row
   WHERE session_row.id = NEW.session_id
     AND session_row.room_id = NEW.room_id
   FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Shared-Agent Runtime invocation Session/Room mismatch'
      USING ERRCODE = '23503';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION "public"."validate_conversation_shared_agent_shadow_invocation"()
  FROM PUBLIC, "nautilo_agent", "nautilo_crypto";--> statement-breakpoint
CREATE TRIGGER "conversation_shared_agent_shadow_invocations_product_valid"
BEFORE INSERT ON "${INVOCATION_TABLE}"
FOR EACH ROW EXECUTE FUNCTION "public"."validate_conversation_shared_agent_shadow_invocation"();--> statement-breakpoint

CREATE OR REPLACE FUNCTION "public"."validate_conversation_shared_agent_shadow_execution"()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog
AS $$
BEGIN
  PERFORM 1
    FROM "public"."sessions" AS session_row
    JOIN "public"."rooms" AS source_room
      ON source_room.id = NEW.room_id
    JOIN "public"."rooms" AS authority_room
      ON authority_room.id = COALESCE(source_room.parent_room_id, source_room.id)
    JOIN "public"."room_members" AS member
      ON member.room_id = authority_room.id
    JOIN "public"."actors" AS agent_actor
      ON agent_actor.id = member.actor_id
     AND agent_actor.kind = 'agent'
     AND agent_actor.agent_id = NEW.agent_id
   WHERE session_row.id = NEW.session_id
     AND session_row.room_id = NEW.room_id
     AND session_row.agent_id = NEW.agent_id
     AND (
       (source_room.parent_room_id IS NULL
         AND source_room.kind IN ('private', 'group'))
       OR (source_room.parent_room_id IS NOT NULL
         AND source_room.kind = 'subthread'
         AND authority_room.kind IN ('private', 'group'))
     )
   FOR SHARE OF session_row, source_room, authority_room, member, agent_actor;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Shared-Agent execution Session/Room/Agent mismatch'
      USING ERRCODE = '23503';
  END IF;
  IF NEW.invocation_id IS NOT NULL THEN
    PERFORM 1
      FROM "public"."conversation_shared_agent_shadow_invocations" AS invocation
     WHERE invocation.invocation_id = NEW.invocation_id
       AND invocation.room_id = NEW.room_id
       AND invocation.invoking_human_id = NEW.invoking_human_id
       AND invocation.invoking_device_id = NEW.invoking_device_id
       AND invocation.client_action_session_id = NEW.client_action_session_id
       AND invocation.policy_revision = NEW.policy_revision
       AND invocation.input_count = NEW.input_count
       AND invocation.input_set_digest = NEW.input_set_digest
     FOR SHARE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Shared-Agent execution Runtime invocation mismatch'
        USING ERRCODE = '23503';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION "public"."validate_conversation_shared_agent_shadow_execution"()
  FROM PUBLIC, "nautilo_agent", "nautilo_crypto";--> statement-breakpoint
CREATE TRIGGER "conversation_shared_agent_shadow_executions_product_valid"
BEFORE INSERT ON "conversation_shared_agent_shadow_executions"
FOR EACH ROW EXECUTE FUNCTION "public"."validate_conversation_shared_agent_shadow_execution"();--> statement-breakpoint

CREATE OR REPLACE FUNCTION "public"."protect_conversation_shared_agent_shadow_invocation"()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog
AS $$
BEGIN
  IF ROW(
    NEW.sequence, NEW.invocation_id, NEW.policy_revision,
    NEW.session_id, NEW.room_id, NEW.invoking_human_id,
    NEW.invoking_device_id, NEW.client_action_session_id,
    NEW.input_count, NEW.input_set_digest, NEW.deadline_at, NEW.created_at
  ) IS DISTINCT FROM ROW(
    OLD.sequence, OLD.invocation_id, OLD.policy_revision,
    OLD.session_id, OLD.room_id, OLD.invoking_human_id,
    OLD.invoking_device_id, OLD.client_action_session_id,
    OLD.input_count, OLD.input_set_digest, OLD.deadline_at, OLD.created_at
  ) THEN
    RAISE EXCEPTION 'Shared-Agent Runtime invocation identity is immutable'
      USING ERRCODE = '23514';
  END IF;
  IF NOT (
    NEW.state = OLD.state
    OR (OLD.state = 'awaiting_authorization'
      AND NEW.state IN ('authorized', 'fallback', 'failed'))
    OR (OLD.state = 'authorized'
      AND NEW.state IN ('running', 'completed', 'fallback', 'failed'))
    OR (OLD.state = 'running'
      AND NEW.state IN ('completed', 'fallback', 'failed'))
  ) THEN
    RAISE EXCEPTION 'Shared-Agent Runtime invocation transition is invalid'
      USING ERRCODE = '23514';
  END IF;
  IF (OLD.authorization_plan_bytes IS NOT NULL
        AND NEW.authorization_plan_bytes IS DISTINCT FROM OLD.authorization_plan_bytes)
    OR (OLD.authorization_plan_digest IS NOT NULL
        AND NEW.authorization_plan_digest IS DISTINCT FROM OLD.authorization_plan_digest)
    OR (OLD.recipient_key_id IS NOT NULL
        AND NEW.recipient_key_id IS DISTINCT FROM OLD.recipient_key_id)
    OR (OLD.authorization_disposition IS NOT NULL
        AND NEW.authorization_disposition IS DISTINCT FROM OLD.authorization_disposition)
    OR (OLD.authorization_digest IS NOT NULL
        AND NEW.authorization_digest IS DISTINCT FROM OLD.authorization_digest)
    OR (OLD.authorization_session_reference IS NOT NULL
        AND NEW.authorization_session_reference IS DISTINCT FROM OLD.authorization_session_reference)
    OR (OLD.authorized_at IS NOT NULL
        AND NEW.authorized_at IS DISTINCT FROM OLD.authorized_at)
    OR (OLD.terminal_at IS NOT NULL
        AND NEW.terminal_at IS DISTINCT FROM OLD.terminal_at)
    OR (OLD.terminal_reason IS NOT NULL
        AND NEW.terminal_reason IS DISTINCT FROM OLD.terminal_reason)
    OR NEW.updated_at < OLD.updated_at
  THEN
    RAISE EXCEPTION 'Shared-Agent Runtime invocation receipts are immutable and monotonic'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION "public"."protect_conversation_shared_agent_shadow_invocation"()
  FROM PUBLIC, "nautilo_agent", "nautilo_crypto";--> statement-breakpoint
CREATE TRIGGER "conversation_shared_agent_shadow_invocations_protected"
BEFORE UPDATE ON "${INVOCATION_TABLE}"
FOR EACH ROW EXECUTE FUNCTION "public"."protect_conversation_shared_agent_shadow_invocation"();--> statement-breakpoint

CREATE OR REPLACE FUNCTION "public"."protect_conversation_shared_agent_shadow_execution"()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog
AS $$
BEGIN
  IF ROW(
    NEW.sequence, NEW.execution_id, NEW.invocation_id, NEW.policy_revision,
    NEW.session_id, NEW.room_id,
    NEW.agent_id, NEW.invoking_human_id, NEW.invoking_device_id,
    NEW.client_action_session_id,
    NEW.input_count, NEW.input_set_digest, NEW.deadline_at, NEW.created_at
  ) IS DISTINCT FROM ROW(
    OLD.sequence, OLD.execution_id, OLD.invocation_id, OLD.policy_revision,
    OLD.session_id, OLD.room_id,
    OLD.agent_id, OLD.invoking_human_id, OLD.invoking_device_id,
    OLD.client_action_session_id,
    OLD.input_count, OLD.input_set_digest, OLD.deadline_at, OLD.created_at
  ) THEN
    RAISE EXCEPTION 'Shared-Agent execution identity is immutable'
      USING ERRCODE = '23514';
  END IF;
  IF NOT (
    NEW.state = OLD.state
    OR (OLD.state = 'awaiting_authorization'
      AND NEW.state IN ('authorized', 'fallback', 'failed'))
    OR (OLD.state = 'authorized'
      AND NEW.state IN ('running', 'fallback', 'failed'))
    OR (OLD.state = 'running'
      AND NEW.state IN ('completed', 'fallback', 'failed'))
  ) THEN
    RAISE EXCEPTION 'Shared-Agent execution transition is invalid'
      USING ERRCODE = '23514';
  END IF;
  IF (OLD.plan_bytes IS NOT NULL
        AND NEW.plan_bytes IS DISTINCT FROM OLD.plan_bytes)
    OR (OLD.plan_digest IS NOT NULL
        AND NEW.plan_digest IS DISTINCT FROM OLD.plan_digest)
    OR (OLD.authorization_plan_bytes IS NOT NULL
        AND NEW.authorization_plan_bytes IS DISTINCT FROM OLD.authorization_plan_bytes)
    OR (OLD.authorization_plan_digest IS NOT NULL
        AND NEW.authorization_plan_digest IS DISTINCT FROM OLD.authorization_plan_digest)
    OR (OLD.recipient_key_id IS NOT NULL
        AND NEW.recipient_key_id IS DISTINCT FROM OLD.recipient_key_id)
    OR (OLD.agent_runtime_generation IS NOT NULL
        AND NEW.agent_runtime_generation IS DISTINCT FROM OLD.agent_runtime_generation)
    OR (OLD.agent_signer_key_id IS NOT NULL
        AND NEW.agent_signer_key_id IS DISTINCT FROM OLD.agent_signer_key_id)
    OR (OLD.agent_signer_public_key IS NOT NULL
        AND NEW.agent_signer_public_key IS DISTINCT FROM OLD.agent_signer_public_key)
    OR (OLD.authorization_disposition IS NOT NULL
        AND NEW.authorization_disposition IS DISTINCT FROM OLD.authorization_disposition)
    OR (OLD.authorization_digest IS NOT NULL
        AND NEW.authorization_digest IS DISTINCT FROM OLD.authorization_digest)
    OR (OLD.authorization_session_reference IS NOT NULL
        AND NEW.authorization_session_reference IS DISTINCT FROM OLD.authorization_session_reference)
    OR (OLD.authorized_at IS NOT NULL
        AND NEW.authorized_at IS DISTINCT FROM OLD.authorized_at)
    OR (OLD.terminal_at IS NOT NULL
        AND NEW.terminal_at IS DISTINCT FROM OLD.terminal_at)
    OR (OLD.terminal_reason IS NOT NULL
        AND NEW.terminal_reason IS DISTINCT FROM OLD.terminal_reason)
    OR (OLD.final_causal_event_digest IS NOT NULL
        AND NEW.final_causal_event_digest IS DISTINCT FROM OLD.final_causal_event_digest)
    OR NEW.updated_at < OLD.updated_at
  THEN
    RAISE EXCEPTION 'Shared-Agent execution receipts are immutable and monotonic'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION "public"."protect_conversation_shared_agent_shadow_execution"()
  FROM PUBLIC, "nautilo_agent", "nautilo_crypto";--> statement-breakpoint

CREATE OR REPLACE FUNCTION "public"."validate_conversation_shared_agent_shadow_execution_input"()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog
AS $$
BEGIN
  PERFORM 1
    FROM "public"."conversation_shared_agent_shadow_executions" AS execution
    JOIN "public"."conversation_shared_agent_shadow_operations" AS operation
      ON operation.operation_id = NEW.human_operation_id
   WHERE execution.execution_id = NEW.execution_id
     AND operation.room_id = execution.room_id
     AND operation.subject_human_id = execution.invoking_human_id
     AND operation.committer_device_id = execution.invoking_device_id
     AND operation.human_message_id = NEW.message_id
     AND operation.state = 'published'
     AND ((execution.invocation_id IS NULL
            AND operation.agent_id = execution.agent_id)
       OR (execution.invocation_id IS NOT NULL
            AND operation.agent_id IS NULL
            AND EXISTS (
              SELECT 1
                FROM "public"."conversation_shared_agent_shadow_invocations" AS invocation
               WHERE invocation.invocation_id = execution.invocation_id
                 AND invocation.room_id = execution.room_id
                 AND invocation.invoking_human_id = execution.invoking_human_id
                 AND invocation.invoking_device_id = execution.invoking_device_id
                 AND invocation.client_action_session_id
                   = execution.client_action_session_id
                 AND invocation.policy_revision = execution.policy_revision
                 AND invocation.input_count = execution.input_count
                 AND invocation.input_set_digest = execution.input_set_digest)))
   FOR SHARE OF execution, operation;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Shared-Agent execution input authority mismatch'
      USING ERRCODE = '23503';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION "public"."validate_conversation_shared_agent_shadow_execution_input"()
  FROM PUBLIC, "nautilo_agent", "nautilo_crypto";--> statement-breakpoint

${M298_RUNTIME_HUMAN_AUDIENCE_REVISION_MARKER}
CREATE OR REPLACE FUNCTION "public"."advance_room_namespace_access_revision"()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog
AS $$
DECLARE
  old_is_human boolean := false;
  new_is_human boolean := false;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    SELECT EXISTS (
      SELECT 1 FROM "public"."actors"
       WHERE id = OLD.actor_id AND kind = 'user'
    ) INTO old_is_human;
  END IF;
  IF TG_OP <> 'DELETE' THEN
    SELECT EXISTS (
      SELECT 1 FROM "public"."actors"
       WHERE id = NEW.actor_id AND kind = 'user'
    ) INTO new_is_human;
  END IF;

  IF TG_OP = 'DELETE' THEN
    IF old_is_human THEN
      UPDATE "public"."rooms"
         SET namespace_access_revision = namespace_access_revision + 1
       WHERE id = OLD.room_id;
    END IF;
  ELSIF TG_OP = 'INSERT' THEN
    IF new_is_human THEN
      UPDATE "public"."rooms"
         SET namespace_access_revision = namespace_access_revision + 1
       WHERE id = NEW.room_id;
    END IF;
  ELSIF NEW.room_id IS DISTINCT FROM OLD.room_id THEN
    UPDATE "public"."rooms"
       SET namespace_access_revision = namespace_access_revision + 1
     WHERE (old_is_human AND id = OLD.room_id)
        OR (new_is_human AND id = NEW.room_id);
  ELSIF NEW.actor_id IS DISTINCT FROM OLD.actor_id
      AND (old_is_human OR new_is_human) THEN
    UPDATE "public"."rooms"
       SET namespace_access_revision = namespace_access_revision + 1
     WHERE id = NEW.room_id;
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION "public"."advance_room_namespace_access_revision"()
  FROM PUBLIC, "nautilo_agent", "nautilo_crypto";--> statement-breakpoint
GRANT EXECUTE ON FUNCTION "public"."advance_room_namespace_access_revision"()
  TO "nautilo";`;
}

function resumeAuthoritySql(): string {
  return `${M298_RUNTIME_FOREGROUND_RESUME_AUTHORITY_MARKER}
CREATE OR REPLACE FUNCTION "public"."validate_conversation_shared_agent_shadow_execution"()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog
AS $$
BEGIN
  PERFORM 1
    FROM "public"."sessions" AS session_row
    JOIN "public"."rooms" AS source_room ON source_room.id = NEW.room_id
    JOIN "public"."rooms" AS authority_room
      ON authority_room.id = COALESCE(source_room.parent_room_id, source_room.id)
    JOIN "public"."room_members" AS member ON member.room_id = authority_room.id
    JOIN "public"."actors" AS agent_actor
      ON agent_actor.id = member.actor_id
     AND agent_actor.kind = 'agent'
     AND agent_actor.agent_id = NEW.agent_id
   WHERE session_row.id = NEW.session_id
     AND session_row.room_id = NEW.room_id
     AND session_row.agent_id = NEW.agent_id
     AND ((source_room.parent_room_id IS NULL
            AND source_room.kind IN ('private', 'group'))
       OR (source_room.parent_room_id IS NOT NULL
            AND source_room.kind = 'subthread'
            AND authority_room.kind IN ('private', 'group')))
   FOR SHARE OF session_row, source_room, authority_room, member, agent_actor;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Shared-Agent execution Session/Room/Agent mismatch'
      USING ERRCODE = '23503';
  END IF;
  IF NEW.invocation_id IS NOT NULL THEN
    PERFORM 1
      FROM "public"."conversation_shared_agent_shadow_invocations" AS invocation
     WHERE invocation.invocation_id = NEW.invocation_id
       AND invocation.room_id = NEW.room_id
       AND invocation.invoking_human_id = NEW.invoking_human_id
       AND invocation.invoking_device_id = NEW.invoking_device_id
       AND invocation.authorization_device_id = NEW.authorization_device_id
       AND invocation.client_action_session_id = NEW.client_action_session_id
       AND invocation.policy_revision = NEW.policy_revision
       AND invocation.input_count = NEW.input_count
       AND invocation.input_set_digest = NEW.input_set_digest
     FOR SHARE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Shared-Agent execution Runtime invocation mismatch'
        USING ERRCODE = '23503';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint

CREATE OR REPLACE FUNCTION "public"."protect_conversation_shared_agent_shadow_invocation"()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog AS $$
BEGIN
  IF ROW(NEW.sequence, NEW.invocation_id, NEW.policy_revision, NEW.session_id,
    NEW.room_id, NEW.invoking_human_id, NEW.invoking_device_id,
    NEW.authorization_device_id, NEW.client_action_session_id, NEW.input_count,
    NEW.input_set_digest, NEW.deadline_at, NEW.created_at)
  IS DISTINCT FROM
  ROW(OLD.sequence, OLD.invocation_id, OLD.policy_revision, OLD.session_id,
    OLD.room_id, OLD.invoking_human_id, OLD.invoking_device_id,
    OLD.authorization_device_id, OLD.client_action_session_id, OLD.input_count,
    OLD.input_set_digest, OLD.deadline_at, OLD.created_at) THEN
    RAISE EXCEPTION 'Shared-Agent Runtime invocation identity is immutable'
      USING ERRCODE = '23514';
  END IF;
  IF NOT (NEW.state = OLD.state
    OR (OLD.state = 'awaiting_authorization' AND NEW.state IN ('authorized', 'fallback', 'failed'))
    OR (OLD.state = 'authorized' AND NEW.state IN ('running', 'completed', 'fallback', 'failed'))
    OR (OLD.state = 'running' AND NEW.state IN ('completed', 'fallback', 'failed'))) THEN
    RAISE EXCEPTION 'Shared-Agent Runtime invocation transition is invalid'
      USING ERRCODE = '23514';
  END IF;
  IF (OLD.authorization_plan_bytes IS NOT NULL AND NEW.authorization_plan_bytes IS DISTINCT FROM OLD.authorization_plan_bytes)
    OR (OLD.authorization_plan_digest IS NOT NULL AND NEW.authorization_plan_digest IS DISTINCT FROM OLD.authorization_plan_digest)
    OR (OLD.recipient_key_id IS NOT NULL AND NEW.recipient_key_id IS DISTINCT FROM OLD.recipient_key_id)
    OR (OLD.authorization_disposition IS NOT NULL AND NEW.authorization_disposition IS DISTINCT FROM OLD.authorization_disposition)
    OR (OLD.authorization_digest IS NOT NULL AND NEW.authorization_digest IS DISTINCT FROM OLD.authorization_digest)
    OR (OLD.authorization_session_reference IS NOT NULL AND NEW.authorization_session_reference IS DISTINCT FROM OLD.authorization_session_reference)
    OR (OLD.authorized_at IS NOT NULL AND NEW.authorized_at IS DISTINCT FROM OLD.authorized_at)
    OR (OLD.terminal_at IS NOT NULL AND NEW.terminal_at IS DISTINCT FROM OLD.terminal_at)
    OR (OLD.terminal_reason IS NOT NULL AND NEW.terminal_reason IS DISTINCT FROM OLD.terminal_reason)
    OR NEW.updated_at < OLD.updated_at THEN
    RAISE EXCEPTION 'Shared-Agent Runtime invocation receipts are immutable and monotonic'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint

CREATE OR REPLACE FUNCTION "public"."protect_conversation_shared_agent_shadow_execution"()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog AS $$
BEGIN
  IF ROW(NEW.sequence, NEW.execution_id, NEW.invocation_id, NEW.policy_revision,
    NEW.session_id, NEW.room_id, NEW.agent_id, NEW.invoking_human_id,
    NEW.invoking_device_id, NEW.authorization_device_id, NEW.execution_kind,
    NEW.client_action_session_id, NEW.input_count, NEW.input_set_digest,
    NEW.deadline_at, NEW.created_at)
  IS DISTINCT FROM
  ROW(OLD.sequence, OLD.execution_id, OLD.invocation_id, OLD.policy_revision,
    OLD.session_id, OLD.room_id, OLD.agent_id, OLD.invoking_human_id,
    OLD.invoking_device_id, OLD.authorization_device_id, OLD.execution_kind,
    OLD.client_action_session_id, OLD.input_count, OLD.input_set_digest,
    OLD.deadline_at, OLD.created_at) THEN
    RAISE EXCEPTION 'Shared-Agent execution identity is immutable'
      USING ERRCODE = '23514';
  END IF;
  IF NOT (NEW.state = OLD.state
    OR (OLD.state = 'awaiting_authorization' AND NEW.state IN ('authorized', 'fallback', 'failed'))
    OR (OLD.state = 'authorized' AND NEW.state IN ('running', 'completed', 'fallback', 'failed'))
    OR (OLD.state = 'running' AND NEW.state IN ('completed', 'fallback', 'failed'))) THEN
    RAISE EXCEPTION 'Shared-Agent execution transition is invalid'
      USING ERRCODE = '23514';
  END IF;
  IF (OLD.plan_bytes IS NOT NULL AND NEW.plan_bytes IS DISTINCT FROM OLD.plan_bytes)
    OR (OLD.plan_digest IS NOT NULL AND NEW.plan_digest IS DISTINCT FROM OLD.plan_digest)
    OR (OLD.authorization_plan_bytes IS NOT NULL AND NEW.authorization_plan_bytes IS DISTINCT FROM OLD.authorization_plan_bytes)
    OR (OLD.authorization_plan_digest IS NOT NULL AND NEW.authorization_plan_digest IS DISTINCT FROM OLD.authorization_plan_digest)
    OR (OLD.recipient_key_id IS NOT NULL AND NEW.recipient_key_id IS DISTINCT FROM OLD.recipient_key_id)
    OR (OLD.agent_runtime_generation IS NOT NULL AND NEW.agent_runtime_generation IS DISTINCT FROM OLD.agent_runtime_generation)
    OR (OLD.agent_signer_key_id IS NOT NULL AND NEW.agent_signer_key_id IS DISTINCT FROM OLD.agent_signer_key_id)
    OR (OLD.agent_signer_public_key IS NOT NULL AND NEW.agent_signer_public_key IS DISTINCT FROM OLD.agent_signer_public_key)
    OR (OLD.authorization_disposition IS NOT NULL AND NEW.authorization_disposition IS DISTINCT FROM OLD.authorization_disposition)
    OR (OLD.authorization_digest IS NOT NULL AND NEW.authorization_digest IS DISTINCT FROM OLD.authorization_digest)
    OR (OLD.authorization_session_reference IS NOT NULL AND NEW.authorization_session_reference IS DISTINCT FROM OLD.authorization_session_reference)
    OR (OLD.authorized_at IS NOT NULL AND NEW.authorized_at IS DISTINCT FROM OLD.authorized_at)
    OR (OLD.terminal_at IS NOT NULL AND NEW.terminal_at IS DISTINCT FROM OLD.terminal_at)
    OR (OLD.terminal_reason IS NOT NULL AND NEW.terminal_reason IS DISTINCT FROM OLD.terminal_reason)
    OR (OLD.final_causal_event_digest IS NOT NULL AND NEW.final_causal_event_digest IS DISTINCT FROM OLD.final_causal_event_digest)
    OR NEW.updated_at < OLD.updated_at THEN
    RAISE EXCEPTION 'Shared-Agent execution receipts are immutable and monotonic'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;`;
}

export function finalizeM298RuntimeForegroundAuthorityMigration(
  migration: string,
): string {
  const includesConductorLifecycleSchema = migration.includes(
    'conversation_shared_agent_shadow_operations_time_order',
  ) && migration.includes('conductor_resolved_at');
  const finalizeConductorLifecycle = (value: string): string => {
    if (
      !includesConductorLifecycleSchema
      || value.includes(M298_RUNTIME_CONDUCTOR_LIFECYCLE_MARKER)
    ) {
      return value;
    }
    return `${value}${value.endsWith("\n") ? "" : "\n"}--> statement-breakpoint\n${conductorLifecycleSql()}\n`;
  };
  if (migration.includes(M298_RUNTIME_FOREGROUND_RESUME_AUTHORITY_MARKER)) {
    return finalizeConductorLifecycle(migration);
  }
  const executionAuthorizationDeviceAdd =
    'ALTER TABLE "conversation_shared_agent_shadow_executions" ADD COLUMN "authorization_device_id" text NOT NULL;';
  const invocationAuthorizationDeviceAdd =
    'ALTER TABLE "conversation_shared_agent_shadow_invocations" ADD COLUMN "authorization_device_id" text NOT NULL;';
  const invocationCreateHasAuthorizationDevice = migration.includes(
    `CREATE TABLE "${INVOCATION_TABLE}"`,
  ) && /CREATE TABLE "conversation_shared_agent_shadow_invocations"[\s\S]*?"authorization_device_id" text NOT NULL/.test(
    migration,
  );
  const hasExecutionAuthorizationDevice = migration.includes(
    executionAuthorizationDeviceAdd,
  );
  const hasInvocationAuthorizationDevice = invocationCreateHasAuthorizationDevice
    || migration.includes(invocationAuthorizationDeviceAdd);
  const includesResumeSchema = hasExecutionAuthorizationDevice
    || hasInvocationAuthorizationDevice;
  if (
    includesResumeSchema
    && (!hasExecutionAuthorizationDevice || !hasInvocationAuthorizationDevice)
  ) {
    throw new Error("M298 Runtime resume authority generation is incomplete");
  }
  const makeResumeColumnsSafe = (value: string): string => value
    .replace(
      executionAuthorizationDeviceAdd,
      'ALTER TABLE "conversation_shared_agent_shadow_executions" ADD COLUMN "authorization_device_id" text;--> statement-breakpoint\nUPDATE "conversation_shared_agent_shadow_executions" SET "authorization_device_id" = "invoking_device_id" WHERE "authorization_device_id" IS NULL;--> statement-breakpoint\nALTER TABLE "conversation_shared_agent_shadow_executions" ALTER COLUMN "authorization_device_id" SET NOT NULL;',
    )
    .replace(
      invocationAuthorizationDeviceAdd,
      'ALTER TABLE "conversation_shared_agent_shadow_invocations" ADD COLUMN "authorization_device_id" text;--> statement-breakpoint\nUPDATE "conversation_shared_agent_shadow_invocations" SET "authorization_device_id" = "invoking_device_id" WHERE "authorization_device_id" IS NULL;--> statement-breakpoint\nALTER TABLE "conversation_shared_agent_shadow_invocations" ALTER COLUMN "authorization_device_id" SET NOT NULL;',
    );
  const required = [
    `CREATE TABLE "${INVOCATION_TABLE}"`,
    'ALTER TABLE "conversation_shared_agent_shadow_operations" ALTER COLUMN "agent_id" DROP NOT NULL',
    'ADD COLUMN "invocation_id" text',
    'DROP INDEX "uq_conversation_shared_agent_shadow_execution_inputs_operation"',
  ];
  const found = required.filter((needle) => migration.includes(needle));
  if (found.length === 0) {
    if (!includesResumeSchema) {
      return finalizeConductorLifecycle(migration);
    }
    if (migration.includes(M298_RUNTIME_FOREGROUND_RESUME_AUTHORITY_MARKER)) {
      return finalizeConductorLifecycle(migration);
    }
    const safe = makeResumeColumnsSafe(migration);
    return finalizeConductorLifecycle(
      `${safe}${safe.endsWith("\n") ? "" : "\n"}--> statement-breakpoint\n${resumeAuthoritySql()}\n`,
    );
  }
  if (found.length !== required.length) {
    throw new Error("M298 Runtime foreground authority generation is incomplete");
  }
  let finalized = migration;
  if (!finalized.includes(M298_RUNTIME_FOREGROUND_AUTHORITY_MARKER)) {
    finalized = `${finalized}${finalized.endsWith("\n") ? "" : "\n"}--> statement-breakpoint
${authoritySql()}
`;
  }
  if (
    includesResumeSchema
    && !finalized.includes(M298_RUNTIME_FOREGROUND_RESUME_AUTHORITY_MARKER)
  ) {
    finalized = makeResumeColumnsSafe(finalized);
    finalized = `${finalized}${finalized.endsWith("\n") ? "" : "\n"}--> statement-breakpoint\n${resumeAuthoritySql()}\n`;
  }
  return finalizeConductorLifecycle(finalized);
}

function run(): void {
  const migrationsDirectory = resolve(import.meta.dir, "../src/migrations");
  const journal = JSON.parse(
    readFileSync(resolve(migrationsDirectory, "meta/_journal.json"), "utf8"),
  ) as { entries: readonly { tag: string }[] };
  const latest = journal.entries.at(-1);
  if (latest === undefined) throw new Error("Migration journal is empty");
  const migrationPath = resolve(migrationsDirectory, `${latest.tag}.sql`);
  const migration = readFileSync(migrationPath, "utf8");
  const finalized = finalizeM298RuntimeForegroundAuthorityMigration(migration);
  if (finalized !== migration) writeFileSync(migrationPath, finalized, "utf8");
}

if (import.meta.main) run();
