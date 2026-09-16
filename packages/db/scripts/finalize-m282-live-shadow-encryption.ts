import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

export const M282_LIVE_SHADOW_AUTHORITY_MARKER =
  "-- M282_LIVE_SHADOW_TURN_AUTHORITY";
export const M282_LIVE_SHADOW_POLICY_RESET_MARKER =
  "-- M282_LIVE_SHADOW_POLICY_RESET";
export const M282_LIVE_SHADOW_FOLLOWUP_AUTHORITY_MARKER =
  "-- M282_LIVE_SHADOW_FOLLOWUP_AUTHORITY";
export const M275_LIVE_SHADOW_READ_EVIDENCE_MARKER =
  "-- M275_LIVE_SHADOW_READ_EVIDENCE";

const TURN_TABLE = "conversation_shadow_turn_operations";
const TURN_SEQUENCE = "conversation_shadow_turn_operations_sequence_seq";
const TURN_SIGNER_TABLE = "conversation_shadow_turn_agent_signers";
const TURN_ATTEMPT_TABLE = "conversation_shadow_turn_plan_attempts";
const TURN_ATTEMPT_SEQUENCE =
  "conversation_shadow_turn_plan_attempts_sequence_seq";

function followupAuthoritySql(): string {
  return `${M282_LIVE_SHADOW_FOLLOWUP_AUTHORITY_MARKER}
ALTER TABLE "${TURN_SIGNER_TABLE}" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL PRIVILEGES ON TABLE "${TURN_SIGNER_TABLE}"
  FROM PUBLIC, "nautilo_agent", "nautilo_crypto";--> statement-breakpoint
GRANT SELECT, INSERT ON TABLE "${TURN_SIGNER_TABLE}"
  TO "nautilo";--> statement-breakpoint
ALTER TABLE "${TURN_ATTEMPT_TABLE}" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL PRIVILEGES ON TABLE "${TURN_ATTEMPT_TABLE}"
  FROM PUBLIC, "nautilo_agent", "nautilo_crypto";--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON TABLE "${TURN_ATTEMPT_TABLE}"
  TO "nautilo";--> statement-breakpoint
REVOKE ALL PRIVILEGES ON SEQUENCE "${TURN_ATTEMPT_SEQUENCE}"
  FROM PUBLIC, "nautilo_agent", "nautilo_crypto";--> statement-breakpoint
GRANT USAGE ON SEQUENCE "${TURN_ATTEMPT_SEQUENCE}" TO "nautilo";`;
}

function policyResetSql(): string {
  return `${M282_LIVE_SHADOW_POLICY_RESET_MARKER}
UPDATE "encryption_transition_policy"
SET "mode" = 'plaintext_only',
    "shadow_encryption_started_at" = NULL,
    "revision" = "revision" + 1,
    "updated_at" = CURRENT_TIMESTAMP
WHERE "mode" IN ('shadow_writes', 'shadow_reads', 'encrypted_only');`;
}

function authoritySql(): string {
  return `${M282_LIVE_SHADOW_AUTHORITY_MARKER}
ALTER TABLE "${TURN_TABLE}" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL PRIVILEGES ON TABLE "${TURN_TABLE}"
  FROM PUBLIC, "nautilo_agent", "nautilo_crypto";--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON TABLE "${TURN_TABLE}"
  TO "nautilo";--> statement-breakpoint
REVOKE ALL PRIVILEGES ON SEQUENCE "${TURN_SEQUENCE}"
  FROM PUBLIC, "nautilo_agent", "nautilo_crypto";--> statement-breakpoint
GRANT USAGE ON SEQUENCE "${TURN_SEQUENCE}" TO "nautilo";--> statement-breakpoint

CREATE OR REPLACE FUNCTION "public"."validate_conversation_shadow_turn_operation"()
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
     AND session_row.agent_id = NEW.agent_id
   FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'conversation Shadow turn Session/Room/Agent mismatch'
      USING ERRCODE = '23503';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION "public"."validate_conversation_shadow_turn_operation"()
  FROM PUBLIC, "nautilo_agent", "nautilo_crypto";--> statement-breakpoint
CREATE TRIGGER "conversation_shadow_turn_operations_product_valid"
BEFORE INSERT ON "${TURN_TABLE}"
FOR EACH ROW EXECUTE FUNCTION "public"."validate_conversation_shadow_turn_operation"();--> statement-breakpoint

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
CREATE TRIGGER "conversation_shadow_turn_operations_protected"
BEFORE UPDATE ON "${TURN_TABLE}"
FOR EACH ROW EXECUTE FUNCTION "public"."protect_conversation_shadow_turn_operation"();--> statement-breakpoint

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
    NEW.shadow_transcript_ordinal, NEW.shadow_reserved_created_at,
    NEW.payload_version, NEW.key_class,
    NEW.author_role, NEW.subthread_reply_classification,
    NEW.append_idempotency_key, NEW.allocation_request_digest, NEW.created_at
  ) IS DISTINCT FROM ROW(
    OLD.sequence, OLD.session_id, OLD.message_id, OLD.edit_revision,
    OLD.room_id, OLD.namespace_id_at_allocation, OLD.crypto_object_id,
    OLD.object_id_scheme, OLD.shadow_operation_id,
    OLD.shadow_transcript_ordinal, OLD.shadow_reserved_created_at,
    OLD.payload_version, OLD.key_class,
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

function readEvidenceSql(): string {
  const authority = authoritySql();
  const start = authority.indexOf(
    'CREATE OR REPLACE FUNCTION "public"."protect_conversation_shadow_turn_operation"()',
  );
  const end = authority.indexOf(
    'CREATE TRIGGER "conversation_shadow_turn_operations_protected"',
    start,
  );
  if (start < 0 || end < 0) {
    throw new Error("M275 read evidence finalizer source is incomplete");
  }
  return `${M275_LIVE_SHADOW_READ_EVIDENCE_MARKER}\n${
    authority.slice(start, end).trimEnd()
  }`;
}

export function finalizeM282LiveShadowEncryptionMigration(
  migration: string,
): string {
  let finalized = migration;
  const hasReadEvidenceColumns = finalized.includes(
    'ADD COLUMN "plan_bytes"',
  ) && finalized.includes('ADD COLUMN "human_request_bytes"');
  if (
    hasReadEvidenceColumns
    && !finalized.includes(M275_LIVE_SHADOW_READ_EVIDENCE_MARKER)
  ) {
    finalized = `${finalized}${finalized.endsWith("\n") ? "" : "\n"}--> statement-breakpoint
${readEvidenceSql()}
`;
  }
  const hasFollowupTables = finalized.includes(
    `CREATE TABLE "${TURN_SIGNER_TABLE}"`,
  ) && finalized.includes(`CREATE TABLE "${TURN_ATTEMPT_TABLE}"`);
  if (
    hasFollowupTables
    && !finalized.includes(M282_LIVE_SHADOW_FOLLOWUP_AUTHORITY_MARKER)
  ) {
    finalized = `${finalized}${finalized.endsWith("\n") ? "" : "\n"}--> statement-breakpoint
${followupAuthoritySql()}
`;
  }
  const hasTurnTable = finalized.includes(`CREATE TABLE "${TURN_TABLE}"`);
  const hasRevisionLink = finalized.includes('ADD COLUMN "object_id_scheme"');
  if (!hasTurnTable && !hasRevisionLink) return finalized;
  if (!hasTurnTable || !hasRevisionLink) {
    throw new Error("M282 live Shadow generation is incomplete");
  }

  const modeConstraint =
    'ALTER TABLE "encryption_transition_policy" ADD CONSTRAINT "encryption_transition_policy_mode_check"';
  if (
    finalized.includes(modeConstraint)
    && !finalized.includes(M282_LIVE_SHADOW_POLICY_RESET_MARKER)
  ) {
    finalized = finalized.replace(
      modeConstraint,
      `${policyResetSql()}--> statement-breakpoint\n${modeConstraint}`,
    );
  }
  if (!finalized.includes(M282_LIVE_SHADOW_AUTHORITY_MARKER)) {
    finalized = `${finalized}${finalized.endsWith("\n") ? "" : "\n"}--> statement-breakpoint
${authoritySql()}
`;
  }
  return finalized;
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
  const finalized = finalizeM282LiveShadowEncryptionMigration(migration);
  if (finalized !== migration) writeFileSync(migrationPath, finalized, "utf8");
}

if (import.meta.main) run();
