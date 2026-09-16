import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

export const M237_LIFECYCLE_AUTHORITY_MARKER =
  "-- M237_MESSAGE_CRYPTO_LIFECYCLE_AUTHORITY";
export const M237_DELETE_EFFECTS_AUTHORITY_MARKER =
  "-- M237_MESSAGE_DELETE_EFFECTS_AUTHORITY";
export const M237_GROUP_RECEIPTS_AUTHORITY_MARKER =
  "-- M237_MESSAGE_GROUP_RECEIPTS_AUTHORITY";
export const M237_STRUCTURAL_PROJECTION_AUTHORITY_MARKER =
  "-- M237_MESSAGE_STRUCTURAL_PROJECTION_AUTHORITY";
export const M237_RUNTIME_SIGNER_AUTHORITY_MARKER =
  "-- M237_AGENT_RUNTIME_SIGNER_AUTHORITY";
export const M318_ORDINARY_REPAIR_AUTHORITY_MARKER =
  "-- M318_MESSAGE_ORDINARY_REPAIR_AUTHORITY";

const TABLE = "session_message_crypto_revisions";
const SEQUENCE = "session_message_crypto_revisions_sequence_seq";
const RUNTIME_SIGNER_TABLE = "agent_crypto_runtime_signers";
const ORDINARY_REPAIR_TABLE = "session_message_ordinary_repairs";

function renderM237LifecycleAuthoritySql(): string {
  return `${M237_LIFECYCLE_AUTHORITY_MARKER}
CREATE FUNCTION "public"."reject_room_namespace_id_update"()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog
AS $$
BEGIN
  IF NEW.namespace_id IS DISTINCT FROM OLD.namespace_id THEN
    RAISE EXCEPTION 'rooms.namespace_id is immutable after Room creation'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION "public"."reject_room_namespace_id_update"()
  FROM PUBLIC, "nautilo_agent", "nautilo_crypto";--> statement-breakpoint
CREATE TRIGGER "rooms_namespace_id_immutable"
BEFORE UPDATE OF "namespace_id" ON "rooms"
FOR EACH ROW
EXECUTE FUNCTION "public"."reject_room_namespace_id_update"();--> statement-breakpoint
CREATE FUNCTION "public"."reject_session_message_crypto_revision_identity_update"()
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
    NEW.sequence,
    NEW.session_id,
    NEW.message_id,
    NEW.edit_revision,
    NEW.room_id,
    NEW.namespace_id_at_allocation,
    NEW.crypto_object_id,
    NEW.payload_version,
    NEW.key_class,
    NEW.author_role,
    NEW.subthread_reply_classification,
    NEW.append_idempotency_key,
    NEW.allocation_request_digest,
    NEW.created_at
  ) IS DISTINCT FROM ROW(
    OLD.sequence,
    OLD.session_id,
    OLD.message_id,
    OLD.edit_revision,
    OLD.room_id,
    OLD.namespace_id_at_allocation,
    OLD.crypto_object_id,
    OLD.payload_version,
    OLD.key_class,
    OLD.author_role,
    OLD.subthread_reply_classification,
    OLD.append_idempotency_key,
    OLD.allocation_request_digest,
    OLD.created_at
  ) THEN
    RAISE EXCEPTION 'session message crypto revision identity is immutable'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION "public"."reject_session_message_crypto_revision_identity_update"()
  FROM PUBLIC, "nautilo_agent", "nautilo_crypto";--> statement-breakpoint
CREATE TRIGGER "session_message_crypto_revisions_identity_immutable"
BEFORE UPDATE ON "${TABLE}"
FOR EACH ROW
EXECUTE FUNCTION "public"."reject_session_message_crypto_revision_identity_update"();--> statement-breakpoint
CREATE FUNCTION "public"."validate_session_message_crypto_revision_session_room"()
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
    RAISE EXCEPTION 'session message crypto revision Session/Room mismatch'
      USING ERRCODE = '23503';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION "public"."validate_session_message_crypto_revision_session_room"()
  FROM PUBLIC, "nautilo_agent", "nautilo_crypto";--> statement-breakpoint
CREATE TRIGGER "session_message_crypto_revisions_session_room_valid"
BEFORE INSERT ON "${TABLE}"
FOR EACH ROW
EXECUTE FUNCTION "public"."validate_session_message_crypto_revision_session_room"();--> statement-breakpoint
ALTER TABLE "${TABLE}" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL PRIVILEGES ON TABLE "${TABLE}"
  FROM PUBLIC, "nautilo_agent", "nautilo_crypto";--> statement-breakpoint
GRANT SELECT, INSERT ON TABLE "${TABLE}"
  TO "nautilo_agent";--> statement-breakpoint
GRANT UPDATE (
  "completion",
  "disposition",
  "parity_status",
  "attempt_count",
  "next_attempt_at",
  "lease_token",
  "lease_expires_at",
  "failure_code",
  "terminal_operation_id",
  "terminal_operation_type",
  "terminal_expected_revision",
  "terminal_request_digest",
  "crypto_completed_at",
  "updated_at"
) ON TABLE "${TABLE}"
  TO "nautilo_agent";--> statement-breakpoint
REVOKE ALL PRIVILEGES ON SEQUENCE "${SEQUENCE}"
  FROM PUBLIC, "nautilo_agent", "nautilo_crypto";--> statement-breakpoint
GRANT USAGE ON SEQUENCE "${SEQUENCE}"
  TO "nautilo_agent";`;
}

function renderM237DeleteEffectsAuthoritySql(): string {
  return `${M237_DELETE_EFFECTS_AUTHORITY_MARKER}
GRANT UPDATE (
  "delete_was_unread",
  "delete_orphaned_turn_id",
  "delete_root_parent_room_id",
  "delete_root_anchor_message_id",
  "delete_root_reply_count",
  "delete_root_last_reply_at",
  "delete_root_summary_revision"
) ON TABLE "${TABLE}"
  TO "nautilo_agent";`;
}

function renderM237GroupReceiptsAuthoritySql(): string {
  return `${M237_GROUP_RECEIPTS_AUTHORITY_MARKER}
GRANT UPDATE (
  "terminal_operation_group_id",
  "quarantine_lease_token"
) ON TABLE "${TABLE}"
  TO "nautilo_agent";`;
}

function renderM237StructuralProjectionAuthoritySql(): string {
  return `${M237_STRUCTURAL_PROJECTION_AUTHORITY_MARKER}
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
    NEW.sequence,
    NEW.session_id,
    NEW.message_id,
    NEW.edit_revision,
    NEW.room_id,
    NEW.namespace_id_at_allocation,
    NEW.crypto_object_id,
    NEW.payload_version,
    NEW.key_class,
    NEW.author_role,
    NEW.subthread_reply_classification,
    NEW.append_idempotency_key,
    NEW.allocation_request_digest,
    NEW.created_at
  ) IS DISTINCT FROM ROW(
    OLD.sequence,
    OLD.session_id,
    OLD.message_id,
    OLD.edit_revision,
    OLD.room_id,
    OLD.namespace_id_at_allocation,
    OLD.crypto_object_id,
    OLD.payload_version,
    OLD.key_class,
    OLD.author_role,
    OLD.subthread_reply_classification,
    OLD.append_idempotency_key,
    OLD.allocation_request_digest,
    OLD.created_at
  ) THEN
    RAISE EXCEPTION 'session message crypto revision identity is immutable'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION "public"."reject_session_message_crypto_revision_identity_update"()
  FROM PUBLIC, "nautilo_agent", "nautilo_crypto";`;
}

function renderM237RuntimeSignerAuthoritySql(): string {
  return `${M237_RUNTIME_SIGNER_AUTHORITY_MARKER}
ALTER TABLE "${RUNTIME_SIGNER_TABLE}" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL PRIVILEGES ON TABLE "${RUNTIME_SIGNER_TABLE}"
  FROM PUBLIC, "nautilo", "nautilo_agent", "nautilo_crypto";--> statement-breakpoint
GRANT SELECT, INSERT ON TABLE "${RUNTIME_SIGNER_TABLE}"
  TO "nautilo_crypto";`;
}

function renderM318OrdinaryRepairAuthoritySql(): string {
  return `${M318_ORDINARY_REPAIR_AUTHORITY_MARKER}
ALTER TABLE "${ORDINARY_REPAIR_TABLE}" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL PRIVILEGES ON TABLE "${ORDINARY_REPAIR_TABLE}"
  FROM PUBLIC, "nautilo_agent", "nautilo_crypto";--> statement-breakpoint
GRANT SELECT, INSERT ON TABLE "${ORDINARY_REPAIR_TABLE}"
  TO "nautilo_agent";`;
}

export function finalizeM237LifecycleMigration(migration: string): string {
  let finalized = migration;
  if (
    finalized.includes(`CREATE TABLE "${TABLE}"`)
    && !finalized.includes(M237_LIFECYCLE_AUTHORITY_MARKER)
  ) {
    const separator = finalized.endsWith("\n") ? "" : "\n";
    finalized = `${finalized}${separator}--> statement-breakpoint
${renderM237LifecycleAuthoritySql()}
`;
  }
  if (
    finalized.includes('ADD COLUMN "delete_was_unread"')
    && !finalized.includes(M237_DELETE_EFFECTS_AUTHORITY_MARKER)
  ) {
    const separator = finalized.endsWith("\n") ? "" : "\n";
    finalized = `${finalized}${separator}--> statement-breakpoint
${renderM237DeleteEffectsAuthoritySql()}
`;
  }
  if (
    finalized.includes('ADD COLUMN "terminal_operation_group_id"')
    && !finalized.includes(M237_GROUP_RECEIPTS_AUTHORITY_MARKER)
  ) {
    const separator = finalized.endsWith("\n") ? "" : "\n";
    finalized = `${finalized}${separator}--> statement-breakpoint
${renderM237GroupReceiptsAuthoritySql()}
`;
  }
  if (
    finalized.includes('ADD COLUMN "subthread_reply_classification"')
    && !finalized.includes(M237_STRUCTURAL_PROJECTION_AUTHORITY_MARKER)
  ) {
    const separator = finalized.endsWith("\n") ? "" : "\n";
    finalized = `${finalized}${separator}--> statement-breakpoint
${renderM237StructuralProjectionAuthoritySql()}
`;
  }
  if (
    finalized.includes(`CREATE TABLE "${RUNTIME_SIGNER_TABLE}"`)
    && !finalized.includes(M237_RUNTIME_SIGNER_AUTHORITY_MARKER)
  ) {
    const separator = finalized.endsWith("\n") ? "" : "\n";
    finalized = `${finalized}${separator}--> statement-breakpoint
${renderM237RuntimeSignerAuthoritySql()}
`;
  }
  if (
    finalized.includes(`CREATE TABLE "${ORDINARY_REPAIR_TABLE}"`)
    && !finalized.includes(M318_ORDINARY_REPAIR_AUTHORITY_MARKER)
  ) {
    const separator = finalized.endsWith("\n") ? "" : "\n";
    finalized = `${finalized}${separator}--> statement-breakpoint
${renderM318OrdinaryRepairAuthoritySql()}
`;
  }
  return finalized;
}

function run(): void {
  const migrationsDir = resolve(import.meta.dir, "../src/migrations");
  const journal = JSON.parse(
    readFileSync(resolve(migrationsDir, "meta/_journal.json"), "utf8"),
  ) as {
    entries: readonly { idx: number; tag: string }[];
  };
  const latest = journal.entries.at(-1);
  if (latest === undefined) {
    throw new Error("Migration journal is empty");
  }
  const migrationPath = resolve(migrationsDir, `${latest.tag}.sql`);
  const migration = readFileSync(migrationPath, "utf8");
  const finalized = finalizeM237LifecycleMigration(migration);
  if (finalized === migration) return;
  writeFileSync(migrationPath, finalized, {
    encoding: "utf8",
    flag: "w",
    mode: 0o600,
  });
}

if (import.meta.main) run();
