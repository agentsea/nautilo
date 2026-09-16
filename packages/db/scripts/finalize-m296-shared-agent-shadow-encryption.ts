import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

export const M296_SHARED_AGENT_SHADOW_AUTHORITY_MARKER =
  "-- M296_SHARED_AGENT_SHADOW_AUTHORITY";

const OPERATION_TABLE = "conversation_shared_agent_shadow_operations";
const OPERATION_SEQUENCE = `${OPERATION_TABLE}_sequence_seq`;
const EXECUTION_TABLE = "conversation_shared_agent_shadow_executions";
const EXECUTION_SEQUENCE = `${EXECUTION_TABLE}_sequence_seq`;
const INPUT_TABLE = "conversation_shared_agent_shadow_execution_inputs";
const INPUT_SEQUENCE = `${INPUT_TABLE}_sequence_seq`;
const ACK_TABLE = "conversation_shared_agent_shadow_acknowledgements";
const ACK_SEQUENCE = `${ACK_TABLE}_sequence_seq`;
const ATTEMPT_TABLE = "conversation_shared_agent_shadow_plan_attempts";
const ATTEMPT_SEQUENCE = `${ATTEMPT_TABLE}_sequence_seq`;

function authoritySql(): string {
  return `${M296_SHARED_AGENT_SHADOW_AUTHORITY_MARKER}
ALTER TABLE "${OPERATION_TABLE}" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL PRIVILEGES ON TABLE "${OPERATION_TABLE}"
  FROM PUBLIC, "nautilo_agent", "nautilo_crypto";--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON TABLE "${OPERATION_TABLE}"
  TO "nautilo";--> statement-breakpoint
REVOKE ALL PRIVILEGES ON SEQUENCE "${OPERATION_SEQUENCE}"
  FROM PUBLIC, "nautilo_agent", "nautilo_crypto";--> statement-breakpoint
GRANT USAGE ON SEQUENCE "${OPERATION_SEQUENCE}" TO "nautilo";--> statement-breakpoint

ALTER TABLE "${EXECUTION_TABLE}" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL PRIVILEGES ON TABLE "${EXECUTION_TABLE}"
  FROM PUBLIC, "nautilo_agent", "nautilo_crypto";--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON TABLE "${EXECUTION_TABLE}"
  TO "nautilo";--> statement-breakpoint
REVOKE ALL PRIVILEGES ON SEQUENCE "${EXECUTION_SEQUENCE}"
  FROM PUBLIC, "nautilo_agent", "nautilo_crypto";--> statement-breakpoint
GRANT USAGE ON SEQUENCE "${EXECUTION_SEQUENCE}" TO "nautilo";--> statement-breakpoint

ALTER TABLE "${INPUT_TABLE}" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL PRIVILEGES ON TABLE "${INPUT_TABLE}"
  FROM PUBLIC, "nautilo_agent", "nautilo_crypto";--> statement-breakpoint
GRANT SELECT, INSERT ON TABLE "${INPUT_TABLE}" TO "nautilo";--> statement-breakpoint
REVOKE ALL PRIVILEGES ON SEQUENCE "${INPUT_SEQUENCE}"
  FROM PUBLIC, "nautilo_agent", "nautilo_crypto";--> statement-breakpoint
GRANT USAGE ON SEQUENCE "${INPUT_SEQUENCE}" TO "nautilo";--> statement-breakpoint

ALTER TABLE "${ACK_TABLE}" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL PRIVILEGES ON TABLE "${ACK_TABLE}"
  FROM PUBLIC, "nautilo_agent", "nautilo_crypto";--> statement-breakpoint
GRANT SELECT, INSERT ON TABLE "${ACK_TABLE}" TO "nautilo";--> statement-breakpoint
REVOKE ALL PRIVILEGES ON SEQUENCE "${ACK_SEQUENCE}"
  FROM PUBLIC, "nautilo_agent", "nautilo_crypto";--> statement-breakpoint
GRANT USAGE ON SEQUENCE "${ACK_SEQUENCE}" TO "nautilo";--> statement-breakpoint

ALTER TABLE "${ATTEMPT_TABLE}" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL PRIVILEGES ON TABLE "${ATTEMPT_TABLE}"
  FROM PUBLIC, "nautilo_agent", "nautilo_crypto";--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON TABLE "${ATTEMPT_TABLE}"
  TO "nautilo";--> statement-breakpoint
REVOKE ALL PRIVILEGES ON SEQUENCE "${ATTEMPT_SEQUENCE}"
  FROM PUBLIC, "nautilo_agent", "nautilo_crypto";--> statement-breakpoint
GRANT USAGE ON SEQUENCE "${ATTEMPT_SEQUENCE}" TO "nautilo";--> statement-breakpoint

CREATE OR REPLACE FUNCTION "public"."validate_conversation_shared_agent_shadow_operation"()
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
    RAISE EXCEPTION 'Shared-Agent Shadow Session/Room mismatch'
      USING ERRCODE = '23503';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION "public"."validate_conversation_shared_agent_shadow_operation"()
  FROM PUBLIC, "nautilo_agent", "nautilo_crypto";--> statement-breakpoint
CREATE TRIGGER "conversation_shared_agent_shadow_operations_product_valid"
BEFORE INSERT ON "${OPERATION_TABLE}"
FOR EACH ROW EXECUTE FUNCTION "public"."validate_conversation_shared_agent_shadow_operation"();--> statement-breakpoint

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
        AND NEW.conductor_reason IS DISTINCT FROM OLD.conductor_reason)
    OR (OLD.conductor_resolved_at IS NOT NULL
        AND NEW.conductor_resolved_at IS DISTINCT FROM OLD.conductor_resolved_at)
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
  FROM PUBLIC, "nautilo_agent", "nautilo_crypto";--> statement-breakpoint
CREATE TRIGGER "conversation_shared_agent_shadow_operations_protected"
BEFORE UPDATE ON "${OPERATION_TABLE}"
FOR EACH ROW EXECUTE FUNCTION "public"."protect_conversation_shared_agent_shadow_operation"();--> statement-breakpoint

CREATE OR REPLACE FUNCTION "public"."protect_conversation_shared_agent_shadow_execution"()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog
AS $$
BEGIN
  IF ROW(
    NEW.sequence, NEW.execution_id, NEW.policy_revision,
    NEW.session_id, NEW.room_id,
    NEW.agent_id, NEW.invoking_human_id, NEW.invoking_device_id,
    NEW.client_action_session_id,
    NEW.input_count, NEW.input_set_digest, NEW.deadline_at, NEW.created_at
  ) IS DISTINCT FROM ROW(
    OLD.sequence, OLD.execution_id, OLD.policy_revision,
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
CREATE TRIGGER "conversation_shared_agent_shadow_executions_protected"
BEFORE UPDATE ON "${EXECUTION_TABLE}"
FOR EACH ROW EXECUTE FUNCTION "public"."protect_conversation_shared_agent_shadow_execution"();--> statement-breakpoint

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
     AND operation.agent_id = execution.agent_id
     AND operation.subject_human_id = execution.invoking_human_id
     AND operation.committer_device_id = execution.invoking_device_id
     AND operation.human_message_id = NEW.message_id
     AND operation.state = 'published'
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
CREATE TRIGGER "conversation_shared_agent_shadow_execution_inputs_product_valid"
BEFORE INSERT ON "${INPUT_TABLE}"
FOR EACH ROW EXECUTE FUNCTION "public"."validate_conversation_shared_agent_shadow_execution_input"();--> statement-breakpoint

CREATE OR REPLACE FUNCTION "public"."validate_conversation_shared_agent_shadow_acknowledgement"()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog
AS $$
BEGIN
  IF NEW.operation_kind = 'human_message' THEN
    PERFORM 1
      FROM "public"."conversation_shared_agent_shadow_operations" AS operation
      JOIN "public"."session_message_crypto_revisions" AS revision
        ON revision.shared_agent_shadow_operation_id = operation.operation_id
       AND revision.message_id = operation.human_message_id
       AND revision.edit_revision = 0
     WHERE operation.operation_id = NEW.operation_id
       AND operation.human_message_id = NEW.message_id
       AND operation.state = 'published'
     FOR SHARE OF operation, revision;
  ELSE
    PERFORM 1
      FROM "public"."conversation_shared_agent_shadow_executions" AS execution
      JOIN "public"."session_message_crypto_revisions" AS revision
        ON revision.shared_agent_shadow_execution_id = execution.execution_id
       AND revision.message_id = NEW.message_id
       AND revision.edit_revision = NEW.edit_revision
     WHERE execution.execution_id = NEW.operation_id
       AND execution.state IN ('running', 'completed', 'fallback')
       AND revision.author_role = NEW.author_role
     FOR SHARE OF execution, revision;
  END IF;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Shared-Agent acknowledgement parent mismatch'
      USING ERRCODE = '23503';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION "public"."validate_conversation_shared_agent_shadow_acknowledgement"()
  FROM PUBLIC, "nautilo_agent", "nautilo_crypto";--> statement-breakpoint
CREATE TRIGGER "conversation_shared_agent_shadow_acknowledgements_product_valid"
BEFORE INSERT ON "${ACK_TABLE}"
FOR EACH ROW EXECUTE FUNCTION "public"."validate_conversation_shared_agent_shadow_acknowledgement"();--> statement-breakpoint

CREATE OR REPLACE FUNCTION "public"."reject_session_message_crypto_revision_identity_update"()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog
AS $$
BEGIN
  IF OLD.disposition IN ('superseded', 'hard_delete')
     AND NEW IS DISTINCT FROM OLD THEN
    RAISE EXCEPTION 'terminal session message crypto revision is immutable'
      USING ERRCODE = '23514';
  END IF;
  IF ROW(
    NEW.sequence, NEW.session_id, NEW.message_id, NEW.edit_revision,
    NEW.room_id, NEW.namespace_id_at_allocation, NEW.crypto_object_id,
    NEW.object_id_scheme, NEW.shadow_operation_id,
    NEW.human_peer_shadow_operation_id,
    NEW.shared_agent_shadow_operation_id,
    NEW.shared_agent_shadow_execution_id, NEW.shadow_transcript_ordinal,
    NEW.shadow_reserved_created_at, NEW.payload_version, NEW.key_class,
    NEW.author_role, NEW.subthread_reply_classification,
    NEW.append_idempotency_key, NEW.allocation_request_digest, NEW.created_at
  ) IS DISTINCT FROM ROW(
    OLD.sequence, OLD.session_id, OLD.message_id, OLD.edit_revision,
    OLD.room_id, OLD.namespace_id_at_allocation, OLD.crypto_object_id,
    OLD.object_id_scheme, OLD.shadow_operation_id,
    OLD.human_peer_shadow_operation_id,
    OLD.shared_agent_shadow_operation_id,
    OLD.shared_agent_shadow_execution_id, OLD.shadow_transcript_ordinal,
    OLD.shadow_reserved_created_at, OLD.payload_version, OLD.key_class,
    OLD.author_role, OLD.subthread_reply_classification,
    OLD.append_idempotency_key, OLD.allocation_request_digest, OLD.created_at
  ) THEN
    RAISE EXCEPTION 'session message crypto revision identity is immutable'
      USING ERRCODE = '23514';
  END IF;
  IF (OLD.shadow_stream_id IS NOT NULL
        AND NEW.shadow_stream_id IS DISTINCT FROM OLD.shadow_stream_id)
    OR (OLD.shadow_stream_start_digest IS NOT NULL
        AND NEW.shadow_stream_start_digest IS DISTINCT FROM OLD.shadow_stream_start_digest)
    OR (OLD.shadow_stream_terminal_digest IS NOT NULL
        AND NEW.shadow_stream_terminal_digest IS DISTINCT FROM OLD.shadow_stream_terminal_digest)
    OR (OLD.shadow_streamed_text_digest IS NOT NULL
        AND NEW.shadow_streamed_text_digest IS DISTINCT FROM OLD.shadow_streamed_text_digest)
    OR (OLD.shadow_durable_event_digest IS NOT NULL
        AND NEW.shadow_durable_event_digest IS DISTINCT FROM OLD.shadow_durable_event_digest)
  THEN
    RAISE EXCEPTION 'session message live Shadow evidence is immutable after publication'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION "public"."reject_session_message_crypto_revision_identity_update"()
  FROM PUBLIC, "nautilo_agent", "nautilo_crypto";`;
}

export function finalizeM296SharedAgentShadowEncryptionMigration(
  migration: string,
): string {
  const required = [
    `CREATE TABLE "${OPERATION_TABLE}"`,
    `CREATE TABLE "${EXECUTION_TABLE}"`,
    `CREATE TABLE "${INPUT_TABLE}"`,
    `CREATE TABLE "${ACK_TABLE}"`,
    `CREATE TABLE "${ATTEMPT_TABLE}"`,
    'ADD COLUMN "shared_agent_shadow_operation_id"',
    'ADD COLUMN "shared_agent_shadow_execution_id"',
  ];
  const found = required.filter((needle) => migration.includes(needle));
  if (found.length === 0) return migration;
  if (found.length !== required.length) {
    throw new Error("M296 Shared-Agent Shadow generation is incomplete");
  }
  if (migration.includes(M296_SHARED_AGENT_SHADOW_AUTHORITY_MARKER)) {
    return migration;
  }
  return `${migration}${migration.endsWith("\n") ? "" : "\n"}--> statement-breakpoint
${authoritySql()}
`;
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
  const finalized = finalizeM296SharedAgentShadowEncryptionMigration(migration);
  if (finalized !== migration) writeFileSync(migrationPath, finalized, "utf8");
}

if (import.meta.main) run();
