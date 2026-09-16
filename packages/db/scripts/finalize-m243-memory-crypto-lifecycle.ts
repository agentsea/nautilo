import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

export const M243_MEMORY_CRYPTO_LIFECYCLE_MARKER =
  "-- M243_MEMORY_CRYPTO_LIFECYCLE_AUTHORITY";

const REVISION_TABLE = "memory_crypto_revisions";
const OPERATION_TABLE = "memory_crypto_operations";

function renderAuthoritySql(): string {
  return `${M243_MEMORY_CRYPTO_LIFECYCLE_MARKER}
CREATE FUNCTION "public"."reject_memory_crypto_revision_identity_update"()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog
AS $$
BEGIN
  IF OLD.disposition IN ('superseded', 'hard_delete')
     AND NEW IS DISTINCT FROM OLD THEN
    RAISE EXCEPTION 'terminal memory crypto revision is immutable'
      USING ERRCODE = '23514';
  END IF;
  IF ROW(
    NEW.sequence,
    NEW.memory_id,
    NEW.content_revision,
    NEW.anchor_namespace_id,
    NEW.crypto_object_id,
    NEW.payload_version,
    NEW.allocation_request_digest,
    NEW.required_namespace_fingerprint,
    NEW.created_at
  ) IS DISTINCT FROM ROW(
    OLD.sequence,
    OLD.memory_id,
    OLD.content_revision,
    OLD.anchor_namespace_id,
    OLD.crypto_object_id,
    OLD.payload_version,
    OLD.allocation_request_digest,
    OLD.required_namespace_fingerprint,
    OLD.created_at
  ) THEN
    RAISE EXCEPTION 'memory crypto revision identity is immutable'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION "public"."reject_memory_crypto_revision_identity_update"()
  FROM PUBLIC, "nautilo_agent", "nautilo_crypto";--> statement-breakpoint
CREATE TRIGGER "memory_crypto_revisions_identity_immutable"
BEFORE UPDATE ON "${REVISION_TABLE}"
FOR EACH ROW
EXECUTE FUNCTION "public"."reject_memory_crypto_revision_identity_update"();--> statement-breakpoint
CREATE FUNCTION "public"."reject_memory_crypto_operation_identity_update"()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog
AS $$
BEGIN
  IF OLD.disposition = 'complete' AND NEW IS DISTINCT FROM OLD THEN
    RAISE EXCEPTION 'completed memory crypto operation is immutable'
      USING ERRCODE = '23514';
  END IF;
  IF ROW(
    NEW.sequence,
    NEW.operation_id,
    NEW.memory_id,
    NEW.anchor_namespace_id,
    NEW.operation_type,
    NEW.expected_content_revision,
    NEW.result_content_revision,
    NEW.expected_access_revision,
    NEW.result_access_revision,
    NEW.request_digest,
    NEW.target_required_namespace_fingerprint,
    NEW.created_at
  ) IS DISTINCT FROM ROW(
    OLD.sequence,
    OLD.operation_id,
    OLD.memory_id,
    OLD.anchor_namespace_id,
    OLD.operation_type,
    OLD.expected_content_revision,
    OLD.result_content_revision,
    OLD.expected_access_revision,
    OLD.result_access_revision,
    OLD.request_digest,
    OLD.target_required_namespace_fingerprint,
    OLD.created_at
  ) THEN
    RAISE EXCEPTION 'memory crypto operation identity is immutable'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION "public"."reject_memory_crypto_operation_identity_update"()
  FROM PUBLIC, "nautilo_agent", "nautilo_crypto";--> statement-breakpoint
CREATE TRIGGER "memory_crypto_operations_identity_immutable"
BEFORE UPDATE ON "${OPERATION_TABLE}"
FOR EACH ROW
EXECUTE FUNCTION "public"."reject_memory_crypto_operation_identity_update"();--> statement-breakpoint
ALTER TABLE "${REVISION_TABLE}" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "${OPERATION_TABLE}" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL PRIVILEGES ON TABLE "${REVISION_TABLE}", "${OPERATION_TABLE}"
  FROM PUBLIC, "nautilo_agent", "nautilo_crypto";--> statement-breakpoint
GRANT SELECT, INSERT ON TABLE "${REVISION_TABLE}", "${OPERATION_TABLE}"
  TO "nautilo_agent";--> statement-breakpoint
GRANT UPDATE (
  "completion",
  "disposition",
  "attempt_count",
  "next_attempt_at",
  "lease_token",
  "lease_expires_at",
  "failure_code",
  "crypto_completed_at",
  "updated_at"
) ON TABLE "${REVISION_TABLE}"
  TO "nautilo_agent";--> statement-breakpoint
GRANT UPDATE (
  "completion",
  "disposition",
  "attempt_count",
  "next_attempt_at",
  "lease_token",
  "lease_expires_at",
  "failure_code",
  "crypto_completed_at",
  "semantic_change_kind",
  "updated_at"
) ON TABLE "${OPERATION_TABLE}"
  TO "nautilo_agent";--> statement-breakpoint
REVOKE ALL PRIVILEGES ON SEQUENCE
  "memory_crypto_revisions_sequence_seq",
  "memory_crypto_operations_sequence_seq"
  FROM PUBLIC, "nautilo_agent", "nautilo_crypto";--> statement-breakpoint
GRANT USAGE ON SEQUENCE
  "memory_crypto_revisions_sequence_seq",
  "memory_crypto_operations_sequence_seq"
  TO "nautilo_agent";`;
}

export function finalizeM243MemoryCryptoLifecycleMigration(
  migration: string,
): string {
  const hasRevision = migration.includes(`CREATE TABLE "${REVISION_TABLE}"`);
  const hasOperation = migration.includes(
    `CREATE TABLE "${OPERATION_TABLE}"`,
  );
  if (!hasRevision && !hasOperation) return migration;
  if (!hasRevision || !hasOperation) {
    throw new Error("M243 Memory lifecycle generation is incomplete");
  }
  if (migration.includes(M243_MEMORY_CRYPTO_LIFECYCLE_MARKER)) {
    return migration;
  }
  const separator = migration.endsWith("\n") ? "" : "\n";
  return `${migration}${separator}--> statement-breakpoint
${renderAuthoritySql()}
`;
}

function run(): void {
  const migrationsDir = resolve(import.meta.dir, "../src/migrations");
  const journal = JSON.parse(
    readFileSync(resolve(migrationsDir, "meta/_journal.json"), "utf8"),
  ) as { entries: readonly { idx: number; tag: string }[] };
  const latest = journal.entries.at(-1);
  if (latest === undefined) throw new Error("Migration journal is empty");
  const migrationPath = resolve(migrationsDir, `${latest.tag}.sql`);
  const migration = readFileSync(migrationPath, "utf8");
  const finalized = finalizeM243MemoryCryptoLifecycleMigration(migration);
  if (finalized === migration) return;
  writeFileSync(migrationPath, finalized, {
    encoding: "utf8",
    flag: "w",
    mode: 0o600,
  });
}

if (import.meta.main) run();
