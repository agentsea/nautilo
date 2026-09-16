import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

export const M261_ARTIFACT_CRYPTO_LIFECYCLE_MARKER =
  "-- M261_ARTIFACT_CRYPTO_LIFECYCLE_AUTHORITY";

const TABLES = [
  "artifact_crypto_operations",
  "artifact_crypto_revisions",
  "artifact_crypto_blobs",
] as const;

function renderAuthoritySql(): string {
  return `${M261_ARTIFACT_CRYPTO_LIFECYCLE_MARKER}
CREATE FUNCTION "public"."reject_artifact_crypto_operation_identity_update"()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog AS $$
BEGIN
  IF OLD.disposition = 'complete' AND NEW IS DISTINCT FROM OLD THEN
    RAISE EXCEPTION 'completed Artifact crypto operation is immutable' USING ERRCODE = '23514';
  END IF;
  IF ROW(NEW.sequence, NEW.operation_id, NEW.artifact_row_id, NEW.artifact_id,
    NEW.anchor_namespace_id, NEW.operation_type, NEW.expected_artifact_revision,
    NEW.result_artifact_revision, NEW.expected_access_revision,
    NEW.result_access_revision, NEW.expected_blob_generation,
    NEW.result_blob_generation, NEW.expected_blob_id, NEW.result_blob_id, NEW.request_digest,
    NEW.expected_required_namespace_fingerprint,
    NEW.target_required_namespace_fingerprint, NEW.created_at)
    IS DISTINCT FROM
    ROW(OLD.sequence, OLD.operation_id, OLD.artifact_row_id, OLD.artifact_id,
    OLD.anchor_namespace_id, OLD.operation_type, OLD.expected_artifact_revision,
    OLD.result_artifact_revision, OLD.expected_access_revision,
    OLD.result_access_revision, OLD.expected_blob_generation,
    OLD.result_blob_generation, OLD.expected_blob_id, OLD.result_blob_id, OLD.request_digest,
    OLD.expected_required_namespace_fingerprint,
    OLD.target_required_namespace_fingerprint, OLD.created_at) THEN
    RAISE EXCEPTION 'Artifact crypto operation identity is immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION "public"."reject_artifact_crypto_operation_identity_update"()
  FROM PUBLIC, "nautilo_agent", "nautilo_crypto";--> statement-breakpoint
CREATE TRIGGER "artifact_crypto_operations_identity_immutable"
BEFORE UPDATE ON "artifact_crypto_operations" FOR EACH ROW
EXECUTE FUNCTION "public"."reject_artifact_crypto_operation_identity_update"();--> statement-breakpoint
CREATE FUNCTION "public"."reject_artifact_crypto_revision_identity_update"()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog AS $$
BEGIN
  IF OLD.blob_reference_state = 'released' AND NEW IS DISTINCT FROM OLD THEN
    RAISE EXCEPTION 'released Artifact blob reference is immutable' USING ERRCODE = '23514';
  END IF;
  IF ROW(NEW.sequence, NEW.artifact_row_id, NEW.artifact_id,
    NEW.artifact_revision, NEW.anchor_namespace_id, NEW.crypto_object_id,
    NEW.payload_version, NEW.allocation_request_digest,
    NEW.required_namespace_fingerprint, NEW.blob_id, NEW.blob_generation,
    NEW.mime_class, NEW.size_bucket, NEW.created_at)
    IS DISTINCT FROM
    ROW(OLD.sequence, OLD.artifact_row_id, OLD.artifact_id,
    OLD.artifact_revision, OLD.anchor_namespace_id, OLD.crypto_object_id,
    OLD.payload_version, OLD.allocation_request_digest,
    OLD.required_namespace_fingerprint, OLD.blob_id, OLD.blob_generation,
    OLD.mime_class, OLD.size_bucket, OLD.created_at) THEN
    RAISE EXCEPTION 'Artifact crypto revision identity is immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION "public"."reject_artifact_crypto_revision_identity_update"()
  FROM PUBLIC, "nautilo_agent", "nautilo_crypto";--> statement-breakpoint
CREATE TRIGGER "artifact_crypto_revisions_identity_immutable"
BEFORE UPDATE ON "artifact_crypto_revisions" FOR EACH ROW
EXECUTE FUNCTION "public"."reject_artifact_crypto_revision_identity_update"();--> statement-breakpoint
CREATE FUNCTION "public"."reject_artifact_crypto_blob_identity_update"()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog AS $$
BEGIN
  IF OLD.state IN ('orphaned', 'quarantined') AND NEW IS DISTINCT FROM OLD THEN
    RAISE EXCEPTION 'terminal Artifact crypto blob is immutable' USING ERRCODE = '23514';
  END IF;
  IF ROW(NEW.sequence, NEW.artifact_row_id, NEW.artifact_id, NEW.blob_id,
    NEW.blob_generation, NEW.publication_operation_id, NEW.storage_ref,
    NEW.ciphertext_length, NEW.ciphertext_sha256, NEW.created_at)
    IS DISTINCT FROM
    ROW(OLD.sequence, OLD.artifact_row_id, OLD.artifact_id, OLD.blob_id,
    OLD.blob_generation, OLD.publication_operation_id, OLD.storage_ref,
    OLD.ciphertext_length, OLD.ciphertext_sha256, OLD.created_at) THEN
    RAISE EXCEPTION 'Artifact crypto blob identity is immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION "public"."reject_artifact_crypto_blob_identity_update"()
  FROM PUBLIC, "nautilo_agent", "nautilo_crypto";--> statement-breakpoint
CREATE TRIGGER "artifact_crypto_blobs_identity_immutable"
BEFORE UPDATE ON "artifact_crypto_blobs" FOR EACH ROW
EXECUTE FUNCTION "public"."reject_artifact_crypto_blob_identity_update"();--> statement-breakpoint
ALTER TABLE "artifact_crypto_operations" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "artifact_crypto_revisions" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "artifact_crypto_blobs" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL PRIVILEGES ON TABLE
  "artifact_crypto_operations", "artifact_crypto_revisions", "artifact_crypto_blobs"
  FROM PUBLIC, "nautilo_agent", "nautilo_crypto";--> statement-breakpoint
GRANT SELECT, INSERT ON TABLE
  "artifact_crypto_operations", "artifact_crypto_revisions", "artifact_crypto_blobs"
  TO "nautilo";--> statement-breakpoint
GRANT UPDATE ("completion", "disposition", "attempt_count", "next_attempt_at",
  "lease_token", "lease_expires_at", "failure_code", "crypto_completed_at", "updated_at")
  ON TABLE "artifact_crypto_operations" TO "nautilo";--> statement-breakpoint
GRANT UPDATE ("blob_reference_state", "completion", "disposition", "attempt_count",
  "next_attempt_at", "lease_token", "lease_expires_at", "failure_code",
  "crypto_completed_at", "updated_at")
  ON TABLE "artifact_crypto_revisions" TO "nautilo";--> statement-breakpoint
GRANT UPDATE ("state", "failure_code", "updated_at", "published_at", "terminal_at")
  ON TABLE "artifact_crypto_blobs" TO "nautilo";--> statement-breakpoint
REVOKE ALL PRIVILEGES ON SEQUENCE
  "artifact_crypto_operations_sequence_seq",
  "artifact_crypto_revisions_sequence_seq",
  "artifact_crypto_blobs_sequence_seq"
  FROM PUBLIC, "nautilo_agent", "nautilo_crypto";--> statement-breakpoint
GRANT USAGE ON SEQUENCE
  "artifact_crypto_operations_sequence_seq",
  "artifact_crypto_revisions_sequence_seq",
  "artifact_crypto_blobs_sequence_seq"
  TO "nautilo";`;
}

export function finalizeM261ArtifactCryptoLifecycleMigration(
  migration: string,
): string {
  const present = TABLES.filter((table) =>
    migration.includes(`CREATE TABLE "${table}"`)
  );
  if (present.length === 0) return migration;
  if (present.length !== TABLES.length) {
    throw new Error("M261 Artifact lifecycle generation is incomplete");
  }
  if (migration.includes(M261_ARTIFACT_CRYPTO_LIFECYCLE_MARKER)) return migration;
  return `${migration}${migration.endsWith("\n") ? "" : "\n"}--> statement-breakpoint
${renderAuthoritySql()}
`;
}

function run(): void {
  const migrationsDir = resolve(import.meta.dir, "../src/migrations");
  const journal = JSON.parse(
    readFileSync(resolve(migrationsDir, "meta/_journal.json"), "utf8"),
  ) as { entries: readonly { tag: string }[] };
  const latest = journal.entries.at(-1);
  if (latest === undefined) throw new Error("Migration journal is empty");
  const migrationPath = resolve(migrationsDir, `${latest.tag}.sql`);
  const migration = readFileSync(migrationPath, "utf8");
  const finalized = finalizeM261ArtifactCryptoLifecycleMigration(migration);
  if (finalized !== migration) writeFileSync(migrationPath, finalized, "utf8");
}

if (import.meta.main) run();
