import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

export const M295_HUMAN_PEER_SHADOW_AUTHORITY_MARKER =
  "-- M295_HUMAN_PEER_SHADOW_AUTHORITY";

const OPERATION_TABLE = "conversation_human_peer_shadow_operations";
const OPERATION_SEQUENCE = `${OPERATION_TABLE}_sequence_seq`;
const ACK_TABLE = "conversation_human_peer_shadow_acknowledgements";
const ACK_SEQUENCE = `${ACK_TABLE}_sequence_seq`;
const ATTEMPT_TABLE = "conversation_human_peer_shadow_plan_attempts";
const ATTEMPT_SEQUENCE = `${ATTEMPT_TABLE}_sequence_seq`;

function authoritySql(): string {
  return `${M295_HUMAN_PEER_SHADOW_AUTHORITY_MARKER}
ALTER TABLE "${OPERATION_TABLE}" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL PRIVILEGES ON TABLE "${OPERATION_TABLE}"
  FROM PUBLIC, "nautilo_agent", "nautilo_crypto";--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON TABLE "${OPERATION_TABLE}"
  TO "nautilo";--> statement-breakpoint
REVOKE ALL PRIVILEGES ON SEQUENCE "${OPERATION_SEQUENCE}"
  FROM PUBLIC, "nautilo_agent", "nautilo_crypto";--> statement-breakpoint
GRANT USAGE ON SEQUENCE "${OPERATION_SEQUENCE}" TO "nautilo";--> statement-breakpoint

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

CREATE OR REPLACE FUNCTION "public"."validate_conversation_human_peer_shadow_operation"()
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
    RAISE EXCEPTION 'Human-peer Shadow Session/Room mismatch'
      USING ERRCODE = '23503';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION "public"."validate_conversation_human_peer_shadow_operation"()
  FROM PUBLIC, "nautilo_agent", "nautilo_crypto";--> statement-breakpoint
CREATE TRIGGER "conversation_human_peer_shadow_operations_product_valid"
BEFORE INSERT ON "${OPERATION_TABLE}"
FOR EACH ROW EXECUTE FUNCTION "public"."validate_conversation_human_peer_shadow_operation"();--> statement-breakpoint

CREATE OR REPLACE FUNCTION "public"."protect_conversation_human_peer_shadow_operation"()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog
AS $$
BEGIN
  IF ROW(
    NEW.sequence, NEW.operation_id, NEW.client_idempotency_key,
    NEW.policy_revision, NEW.session_id, NEW.room_id, NEW.human_message_id,
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
    OLD.policy_revision, OLD.session_id, OLD.room_id, OLD.human_message_id,
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
    RAISE EXCEPTION 'Human-peer Shadow operation identity is immutable'
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
  THEN
    RAISE EXCEPTION 'Human-peer Shadow receipt is immutable after publication'
      USING ERRCODE = '23514';
  END IF;

  IF NOT (
    NEW.state = OLD.state
    OR (OLD.state = 'planned'
      AND NEW.state IN ('human_verified', 'fallback', 'failed'))
    OR (OLD.state = 'human_verified'
      AND NEW.state IN ('published', 'fallback', 'failed'))
  ) THEN
    RAISE EXCEPTION 'Human-peer Shadow state transition is invalid'
      USING ERRCODE = '23514';
  END IF;
  IF NEW.reconciliation_attempt_count < OLD.reconciliation_attempt_count
    OR NEW.updated_at < OLD.updated_at
  THEN
    RAISE EXCEPTION 'Human-peer Shadow counters and time are monotonic'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION "public"."protect_conversation_human_peer_shadow_operation"()
  FROM PUBLIC, "nautilo_agent", "nautilo_crypto";--> statement-breakpoint
CREATE TRIGGER "conversation_human_peer_shadow_operations_protected"
BEFORE UPDATE ON "${OPERATION_TABLE}"
FOR EACH ROW EXECUTE FUNCTION "public"."protect_conversation_human_peer_shadow_operation"();--> statement-breakpoint

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
    NEW.human_peer_shadow_operation_id, NEW.shadow_transcript_ordinal,
    NEW.shadow_reserved_created_at, NEW.payload_version, NEW.key_class,
    NEW.author_role, NEW.subthread_reply_classification,
    NEW.append_idempotency_key, NEW.allocation_request_digest, NEW.created_at
  ) IS DISTINCT FROM ROW(
    OLD.sequence, OLD.session_id, OLD.message_id, OLD.edit_revision,
    OLD.room_id, OLD.namespace_id_at_allocation, OLD.crypto_object_id,
    OLD.object_id_scheme, OLD.shadow_operation_id,
    OLD.human_peer_shadow_operation_id, OLD.shadow_transcript_ordinal,
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

export function finalizeM295HumanPeerShadowEncryptionMigration(
  migration: string,
): string {
  const required = [
    `CREATE TABLE "${OPERATION_TABLE}"`,
    `CREATE TABLE "${ACK_TABLE}"`,
    `CREATE TABLE "${ATTEMPT_TABLE}"`,
    'ADD COLUMN "human_peer_shadow_operation_id"',
  ];
  const found = required.filter((needle) => migration.includes(needle));
  if (found.length === 0) return migration;
  if (found.length !== required.length) {
    throw new Error("M295 Human-peer Shadow generation is incomplete");
  }
  if (migration.includes(M295_HUMAN_PEER_SHADOW_AUTHORITY_MARKER)) {
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
  const finalized = finalizeM295HumanPeerShadowEncryptionMigration(migration);
  if (finalized !== migration) writeFileSync(migrationPath, finalized, "utf8");
}

if (import.meta.main) run();
