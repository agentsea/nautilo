import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

export const M274_ENCRYPTION_TRANSITION_MARKER =
  "-- M274_ENCRYPTION_TRANSITION_AUTHORITY";

const CORE_TABLES = [
  "encryption_transition_policy",
  "encryption_transition_observation_buckets",
  "encryption_transition_outcome_totals",
  "encryption_transition_observation_admissions",
] as const;

function insertBackfill(
  migration: string,
  table: "memories" | "artifacts",
  constraint: string,
): string {
  const anchor = `ALTER TABLE "${table}" ADD CONSTRAINT "${constraint}"`;
  if (!migration.includes(anchor)) {
    throw new Error(`M274 generation is missing ${constraint}`);
  }
  return migration.replace(
    anchor,
    `UPDATE "${table}"
SET "crypto_mapping_state" = 'verified'
WHERE "crypto_object_id" IS NOT NULL;--> statement-breakpoint
${anchor}`,
  );
}

function authoritySql(): string {
  return `${M274_ENCRYPTION_TRANSITION_MARKER}
ALTER TABLE "encryption_transition_policy" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "encryption_transition_observation_buckets" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "encryption_transition_outcome_totals" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "encryption_transition_observation_admissions" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL PRIVILEGES ON TABLE
  "encryption_transition_policy", "encryption_transition_observation_buckets",
  "encryption_transition_outcome_totals", "encryption_transition_observation_admissions"
  FROM PUBLIC, "nautilo_agent", "nautilo_crypto";--> statement-breakpoint
GRANT SELECT, UPDATE ON TABLE "encryption_transition_policy"
  TO "nautilo";--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE
  "encryption_transition_observation_buckets",
  "encryption_transition_outcome_totals",
  "encryption_transition_observation_admissions" TO "nautilo";--> statement-breakpoint
INSERT INTO "encryption_transition_policy" DEFAULT VALUES
ON CONFLICT ("id") DO NOTHING;`;
}

function staleInvalidationSql(): string {
  return `-- Any ordinary Memory content mutation invalidates a verified shadow.
-- A protected publication may keep the row verified only by changing the
-- exact mapping coordinates in the same UPDATE. Audience edge triggers below
-- deliberately run first; protected access publication must update the parent
-- mapping/fingerprint last in the same transaction.
CREATE OR REPLACE FUNCTION "nautilo_m274_stale_memory_crypto_mapping"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD."crypto_mapping_state" = 'verified'
    AND (
      NEW."content" IS DISTINCT FROM OLD."content"
      OR NEW."type" IS DISTINCT FROM OLD."type"
      OR NEW."scope_origin_namespace_id" IS DISTINCT FROM OLD."scope_origin_namespace_id"
      OR NEW."embedding" IS DISTINCT FROM OLD."embedding"
      OR NEW."embedding_revision" IS DISTINCT FROM OLD."embedding_revision"
      OR NEW."embedding_provider" IS DISTINCT FROM OLD."embedding_provider"
      OR NEW."embedding_model" IS DISTINCT FROM OLD."embedding_model"
      OR NEW."embedding_dimensions" IS DISTINCT FROM OLD."embedding_dimensions"
      OR NEW."embedding_contract_version" IS DISTINCT FROM OLD."embedding_contract_version"
    )
    AND NOT (
      (NEW."crypto_mapping_state" = 'unmapped'
        AND NEW."crypto_object_id" IS NULL
        AND NEW."crypto_required_namespace_fingerprint" IS NULL)
      OR (NEW."crypto_mapping_state" = 'stale')
      OR (NEW."crypto_mapping_state" = 'verified'
        AND NEW."crypto_object_id" IS DISTINCT FROM OLD."crypto_object_id"
        AND NEW."content_revision" IS DISTINCT FROM OLD."content_revision"
        AND NEW."crypto_required_namespace_fingerprint" IS NOT NULL
        AND NEW."embedding_revision" = NEW."content_revision"
        AND NEW."embedding_provider" IS NOT NULL
        AND NEW."embedding_model" IS NOT NULL
        AND NEW."embedding_dimensions" = 1536
        AND NEW."embedding_contract_version" = 1)
    )
  THEN
    NEW."crypto_mapping_state" := 'stale';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
DROP TRIGGER IF EXISTS "trg_m274_stale_memory_crypto_mapping" ON "memories";--> statement-breakpoint
CREATE TRIGGER "trg_m274_stale_memory_crypto_mapping"
BEFORE UPDATE ON "memories"
FOR EACH ROW EXECUTE FUNCTION "nautilo_m274_stale_memory_crypto_mapping"();--> statement-breakpoint

CREATE OR REPLACE FUNCTION "nautilo_m274_stale_artifact_crypto_mapping"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD."crypto_mapping_state" = 'verified'
    AND (
      NEW."path" IS DISTINCT FROM OLD."path"
      OR NEW."mime_type" IS DISTINCT FROM OLD."mime_type"
      OR NEW."size" IS DISTINCT FROM OLD."size"
      OR NEW."storage_uri" IS DISTINCT FROM OLD."storage_uri"
    )
    AND NOT (
      (NEW."crypto_mapping_state" = 'stale')
      OR (NEW."crypto_mapping_state" = 'verified'
        AND NEW."crypto_object_id" IS DISTINCT FROM OLD."crypto_object_id"
        AND NEW."revision" IS DISTINCT FROM OLD."revision"
        AND NEW."crypto_required_namespace_fingerprint" IS NOT NULL
        AND NEW."blob_id" IS DISTINCT FROM OLD."blob_id"
        AND NEW."blob_generation" IS DISTINCT FROM OLD."blob_generation"
        AND NEW."ciphertext_sha256" IS DISTINCT FROM OLD."ciphertext_sha256")
    )
  THEN
    NEW."crypto_mapping_state" := 'stale';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
DROP TRIGGER IF EXISTS "trg_m274_stale_artifact_crypto_mapping" ON "artifacts";--> statement-breakpoint
CREATE TRIGGER "trg_m274_stale_artifact_crypto_mapping"
BEFORE UPDATE ON "artifacts"
FOR EACH ROW EXECUTE FUNCTION "nautilo_m274_stale_artifact_crypto_mapping"();--> statement-breakpoint

CREATE OR REPLACE FUNCTION "nautilo_m274_stale_memory_crypto_mapping_edge"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    UPDATE "memories"
    SET "crypto_mapping_state" = 'stale'
    WHERE "id" = OLD."memory_id"
      AND "crypto_mapping_state" = 'verified';
    RETURN OLD;
  END IF;
  UPDATE "memories"
  SET "crypto_mapping_state" = 'stale'
  WHERE "id" = NEW."memory_id"
    AND "crypto_mapping_state" = 'verified';
  RETURN NEW;
END;
$$;--> statement-breakpoint
DROP TRIGGER IF EXISTS "trg_m274_stale_memory_crypto_mapping_edge" ON "memory_namespaces";--> statement-breakpoint
CREATE TRIGGER "trg_m274_stale_memory_crypto_mapping_edge"
AFTER INSERT OR DELETE ON "memory_namespaces"
FOR EACH ROW EXECUTE FUNCTION "nautilo_m274_stale_memory_crypto_mapping_edge"();--> statement-breakpoint

CREATE OR REPLACE FUNCTION "nautilo_m274_stale_artifact_crypto_mapping_edge"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    UPDATE "artifacts"
    SET "crypto_mapping_state" = 'stale'
    WHERE "id" = OLD."artifact_id"
      AND "crypto_mapping_state" = 'verified';
    RETURN OLD;
  END IF;
  UPDATE "artifacts"
  SET "crypto_mapping_state" = 'stale'
  WHERE "id" = NEW."artifact_id"
    AND "crypto_mapping_state" = 'verified';
  RETURN NEW;
END;
$$;--> statement-breakpoint
DROP TRIGGER IF EXISTS "trg_m274_stale_artifact_crypto_mapping_edge" ON "artifact_namespaces";--> statement-breakpoint
CREATE TRIGGER "trg_m274_stale_artifact_crypto_mapping_edge"
AFTER INSERT OR DELETE ON "artifact_namespaces"
FOR EACH ROW EXECUTE FUNCTION "nautilo_m274_stale_artifact_crypto_mapping_edge"();--> statement-breakpoint
REVOKE ALL ON FUNCTION "nautilo_m274_stale_memory_crypto_mapping"()
  FROM PUBLIC, "nautilo_agent", "nautilo_crypto";--> statement-breakpoint
REVOKE ALL ON FUNCTION "nautilo_m274_stale_artifact_crypto_mapping"()
  FROM PUBLIC, "nautilo_agent", "nautilo_crypto";--> statement-breakpoint
REVOKE ALL ON FUNCTION "nautilo_m274_stale_memory_crypto_mapping_edge"()
  FROM PUBLIC, "nautilo_agent", "nautilo_crypto";--> statement-breakpoint
REVOKE ALL ON FUNCTION "nautilo_m274_stale_artifact_crypto_mapping_edge"()
  FROM PUBLIC, "nautilo_agent", "nautilo_crypto";`;
}

export function finalizeM274EncryptionTransitionMigration(
  migration: string,
): string {
  const hasAuthority = migration.includes(M274_ENCRYPTION_TRANSITION_MARKER);
  const presentCore = CORE_TABLES.filter((table) =>
    migration.includes(`CREATE TABLE "${table}"`)
  );
  if (presentCore.length === 0 || hasAuthority) return migration;
  if (presentCore.length !== CORE_TABLES.length) {
    throw new Error("M274 encryption transition generation is incomplete");
  }

  let finalized = insertBackfill(
    migration,
    "memories",
    "memories_crypto_mapping_revision_coherent",
  );
  finalized = insertBackfill(
    finalized,
    "artifacts",
    "artifacts_crypto_mapping_coherent",
  );
  return `${finalized}${finalized.endsWith("\n") ? "" : "\n"}--> statement-breakpoint
${authoritySql()}--> statement-breakpoint
${staleInvalidationSql()}
`;
}

function run(): void {
  const migrationsDir = resolve(import.meta.dir, "../src/migrations");
  const journal = JSON.parse(
    readFileSync(resolve(migrationsDir, "meta/_journal.json"), "utf8"),
  ) as { entries: readonly { tag: string }[] };
  const latest = journal.entries.at(-1);
  if (!latest) throw new Error("Migration journal is empty");
  const migrationPath = resolve(migrationsDir, `${latest.tag}.sql`);
  const migration = readFileSync(migrationPath, "utf8");
  const finalized = finalizeM274EncryptionTransitionMigration(migration);
  if (finalized !== migration) writeFileSync(migrationPath, finalized, "utf8");
}

if (import.meta.main) run();
