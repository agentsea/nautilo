CREATE TABLE "encryption_transition_observation_admissions" (
	"token_digest" "bytea" PRIMARY KEY NOT NULL,
	"policy_revision" integer NOT NULL,
	"family" text NOT NULL,
	"operation" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "encryption_transition_observation_admissions_digest_shape" CHECK (octet_length("encryption_transition_observation_admissions"."token_digest") = 32),
	CONSTRAINT "encryption_transition_observation_admissions_epoch_check" CHECK ("encryption_transition_observation_admissions"."policy_revision" > 0),
	CONSTRAINT "encryption_transition_observation_admissions_vocabulary_check" CHECK ("encryption_transition_observation_admissions"."family" in ('message', 'memory', 'artifact', 'record')
        and "encryption_transition_observation_admissions"."operation" in ('create', 'update', 'access_update', 'read_repair', 'unsupported')),
	CONSTRAINT "encryption_transition_observation_admissions_expiry_check" CHECK ("encryption_transition_observation_admissions"."expires_at" > "encryption_transition_observation_admissions"."created_at")
);
--> statement-breakpoint
ALTER TABLE "encryption_transition_observation_admissions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "encryption_transition_observation_buckets" (
	"policy_revision" integer NOT NULL,
	"bucket_started_at" timestamp with time zone NOT NULL,
	"bounds_revision" integer NOT NULL,
	"bucket_width_ms" bigint NOT NULL,
	"family" text NOT NULL,
	"operation" text NOT NULL,
	"outcome" text NOT NULL,
	"reason" text NOT NULL,
	"latency_bucket" integer NOT NULL,
	"attempt_count" bigint DEFAULT 1 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "encryption_transition_observation_buckets_pk" PRIMARY KEY("policy_revision","bucket_started_at","bounds_revision","bucket_width_ms","family","operation","outcome","reason","latency_bucket"),
	CONSTRAINT "encryption_transition_observations_family_check" CHECK ("encryption_transition_observation_buckets"."family" in ('message', 'memory', 'artifact', 'record')),
	CONSTRAINT "encryption_transition_observations_operation_check" CHECK ("encryption_transition_observation_buckets"."operation" in ('create', 'update', 'access_update', 'read_repair', 'unsupported')),
	CONSTRAINT "encryption_transition_observations_outcome_reason_coherent" CHECK ((
        ("encryption_transition_observation_buckets"."outcome" in ('verified', 'pending') and "encryption_transition_observation_buckets"."reason" = 'none')
        or ("encryption_transition_observation_buckets"."outcome" = 'reconciling' and "encryption_transition_observation_buckets"."reason" = 'response_lost')
        or ("encryption_transition_observation_buckets"."outcome" = 'unavailable' and "encryption_transition_observation_buckets"."reason" in (
          'unmigrated', 'unsupported_operation', 'client_crypto_unavailable',
          'client_crypto_preparation_failed', 'client_custody_unavailable',
          'namespace_encryption_not_ready', 'stale_authority_product',
          'client_observation_expired'
        ))
        or ("encryption_transition_observation_buckets"."outcome" = 'failed' and "encryption_transition_observation_buckets"."reason" in (
          'parity_mismatch', 'integrity_failure', 'publication_failure'
        ))
      ) and (
        ("encryption_transition_observation_buckets"."operation" = 'unsupported' and "encryption_transition_observation_buckets"."reason" = 'unsupported_operation')
        or ("encryption_transition_observation_buckets"."operation" <> 'unsupported' and "encryption_transition_observation_buckets"."reason" <> 'unsupported_operation')
      )),
	CONSTRAINT "encryption_transition_observations_bucket_shape" CHECK ("encryption_transition_observation_buckets"."policy_revision" > 0
        and "encryption_transition_observation_buckets"."bounds_revision" > 0
        and "encryption_transition_observation_buckets"."bucket_width_ms" > 0
        and "encryption_transition_observation_buckets"."latency_bucket" >= 0),
	CONSTRAINT "encryption_transition_observations_count_positive" CHECK ("encryption_transition_observation_buckets"."attempt_count" > 0)
);
--> statement-breakpoint
ALTER TABLE "encryption_transition_observation_buckets" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "encryption_transition_outcome_totals" (
	"policy_revision" integer NOT NULL,
	"family" text NOT NULL,
	"operation" text NOT NULL,
	"outcome" text NOT NULL,
	"reason" text NOT NULL,
	"attempt_count" bigint DEFAULT 1 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "encryption_transition_outcome_totals_pk" PRIMARY KEY("policy_revision","family","operation","outcome","reason"),
	CONSTRAINT "encryption_transition_outcome_totals_epoch_check" CHECK ("encryption_transition_outcome_totals"."policy_revision" > 0),
	CONSTRAINT "encryption_transition_outcome_totals_count_positive" CHECK ("encryption_transition_outcome_totals"."attempt_count" > 0),
	CONSTRAINT "encryption_transition_outcome_totals_vocabulary_check" CHECK ("encryption_transition_outcome_totals"."family" in ('message', 'memory', 'artifact', 'record')
        and "encryption_transition_outcome_totals"."operation" in ('create', 'update', 'access_update', 'read_repair', 'unsupported')
        and (
          ("encryption_transition_outcome_totals"."outcome" in ('verified', 'pending') and "encryption_transition_outcome_totals"."reason" = 'none')
          or ("encryption_transition_outcome_totals"."outcome" = 'reconciling' and "encryption_transition_outcome_totals"."reason" = 'response_lost')
          or ("encryption_transition_outcome_totals"."outcome" = 'unavailable' and "encryption_transition_outcome_totals"."reason" in (
            'unmigrated', 'unsupported_operation', 'client_crypto_unavailable',
            'client_crypto_preparation_failed', 'client_custody_unavailable',
            'namespace_encryption_not_ready', 'stale_authority_product',
            'client_observation_expired'
          ))
          or ("encryption_transition_outcome_totals"."outcome" = 'failed' and "encryption_transition_outcome_totals"."reason" in (
            'parity_mismatch', 'integrity_failure', 'publication_failure'
          ))
        )
        and (
          ("encryption_transition_outcome_totals"."operation" = 'unsupported' and "encryption_transition_outcome_totals"."reason" = 'unsupported_operation')
          or ("encryption_transition_outcome_totals"."operation" <> 'unsupported' and "encryption_transition_outcome_totals"."reason" <> 'unsupported_operation')
        ))
);
--> statement-breakpoint
ALTER TABLE "encryption_transition_outcome_totals" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "encryption_transition_policy" (
	"id" text PRIMARY KEY DEFAULT 'server' NOT NULL,
	"mode" text DEFAULT 'plaintext_only' NOT NULL,
	"revision" integer DEFAULT 0 NOT NULL,
	"shadow_writes_started_at" timestamp with time zone,
	"observation_bounds_revision" integer DEFAULT 1 NOT NULL,
	"observation_bucket_width_ms" bigint DEFAULT 3600000 NOT NULL,
	"observation_retention_ms" bigint DEFAULT 2592000000 NOT NULL,
	"observation_storage_limit_rows" integer DEFAULT 10000 NOT NULL,
	"observation_latency_upper_bounds_ms" integer[] DEFAULT ARRAY[
      50, 100, 250, 500, 1000, 2500, 5000, 10000, 30000
    ]::integer[] NOT NULL,
	"observation_bounds_configured_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "encryption_transition_policy_singleton" CHECK ("encryption_transition_policy"."id" = 'server'),
	CONSTRAINT "encryption_transition_policy_mode_check" CHECK ("encryption_transition_policy"."mode" in ('plaintext_only', 'shadow_writes', 'shadow_reads', 'encrypted_only')),
	CONSTRAINT "encryption_transition_policy_revision_nonnegative" CHECK ("encryption_transition_policy"."revision" >= 0),
	CONSTRAINT "encryption_transition_policy_shadow_epoch_coherent" CHECK (("encryption_transition_policy"."mode" = 'plaintext_only' and "encryption_transition_policy"."shadow_writes_started_at" is null)
        or ("encryption_transition_policy"."mode" <> 'plaintext_only' and "encryption_transition_policy"."shadow_writes_started_at" is not null)),
	CONSTRAINT "encryption_transition_policy_observation_bounds_coherent" CHECK ("encryption_transition_policy"."observation_bounds_revision" = 1
        and "encryption_transition_policy"."observation_bucket_width_ms" = 3600000
        and "encryption_transition_policy"."observation_retention_ms" = 2592000000
        and "encryption_transition_policy"."observation_storage_limit_rows" = 10000
        and "encryption_transition_policy"."observation_latency_upper_bounds_ms" = ARRAY[
          50, 100, 250, 500, 1000, 2500, 5000, 10000, 30000
        ]::integer[]
        and "encryption_transition_policy"."observation_bounds_configured_at" is not null)
);
--> statement-breakpoint
ALTER TABLE "encryption_transition_policy" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "memories" DROP CONSTRAINT "memories_crypto_mapping_revision_coherent";--> statement-breakpoint
ALTER TABLE "artifacts" DROP CONSTRAINT "artifacts_crypto_mapping_coherent";--> statement-breakpoint
ALTER TABLE "memories" ADD COLUMN "crypto_mapping_state" text DEFAULT 'unmapped' NOT NULL;--> statement-breakpoint
ALTER TABLE "artifacts" ADD COLUMN "crypto_mapping_state" text DEFAULT 'unmapped' NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_encryption_transition_observation_admissions_expiry" ON "encryption_transition_observation_admissions" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "idx_encryption_transition_observations_prune" ON "encryption_transition_observation_buckets" USING btree ("bucket_started_at");--> statement-breakpoint
UPDATE "memories"
SET "crypto_mapping_state" = 'verified'
WHERE "crypto_object_id" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "memories" ADD CONSTRAINT "memories_crypto_mapping_revision_coherent" CHECK ((
        "memories"."crypto_object_id" is null
        and "memories"."crypto_required_namespace_fingerprint" is null
        and "memories"."crypto_mapping_state" = 'unmapped'
      ) or (
        "memories"."crypto_object_id" is not null
        and "memories"."crypto_mapping_state" in ('verified', 'stale')
        and "memories"."content_revision" > 0
        and "memories"."crypto_access_revision" >= 0
        and octet_length("memories"."crypto_required_namespace_fingerprint") = 32
      ));--> statement-breakpoint
UPDATE "artifacts"
SET "crypto_mapping_state" = 'verified'
WHERE "crypto_object_id" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "artifacts" ADD CONSTRAINT "artifacts_crypto_mapping_coherent" CHECK ((
        "artifacts"."crypto_object_id" is null
        and "artifacts"."crypto_mapping_state" = 'unmapped'
        and "artifacts"."path" is not null
        and "artifacts"."mime_type" is not null
        and "artifacts"."size" is not null
        and "artifacts"."storage_uri" is not null
        and "artifacts"."crypto_access_revision" is null
        and "artifacts"."crypto_required_namespace_fingerprint" is null
        and "artifacts"."blob_id" is null
        and "artifacts"."blob_generation" is null
        and "artifacts"."ciphertext_length" is null
        and "artifacts"."ciphertext_sha256" is null
        and "artifacts"."mime_class" is null
        and "artifacts"."size_bucket" is null
        and "artifacts"."crypto_lifecycle_state" is null
      ) or (
        "artifacts"."crypto_object_id" is not null
        and "artifacts"."crypto_mapping_state" in ('verified', 'stale')
        and (
          (
            "artifacts"."path" is not null
            and "artifacts"."mime_type" is not null
            and "artifacts"."size" is not null
            and "artifacts"."storage_uri" is not null
          ) or (
            "artifacts"."path" is null
            and "artifacts"."mime_type" is null
            and "artifacts"."size" is null
            and "artifacts"."storage_uri" is null
          )
        )
        and "artifacts"."artifact_id" ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
        and "artifacts"."crypto_object_id" ~ '^artifact:v1:[0-9a-f]{64}$'
        and "artifacts"."crypto_access_revision" >= 0
        and octet_length("artifacts"."crypto_required_namespace_fingerprint") = 32
        and "artifacts"."blob_id" ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
        and "artifacts"."blob_generation" > 0
        and "artifacts"."ciphertext_length" > 0
        and "artifacts"."ciphertext_length" <= 110100480
        and octet_length("artifacts"."ciphertext_sha256") = 32
        and "artifacts"."mime_class" in ('text', 'image', 'audio', 'video', 'document', 'archive', 'binary')
        and "artifacts"."size_bucket" in ('empty', 'le_64_kib', 'le_1_mib', 'le_10_mib', 'le_100_mib')
        and "artifacts"."crypto_lifecycle_state" in ('active', 'archived', 'quarantined')
      ));--> statement-breakpoint
CREATE POLICY "encryption_transition_observation_admissions_product_all" ON "encryption_transition_observation_admissions" AS PERMISSIVE FOR ALL TO "nautilo" USING (true) WITH CHECK (true);--> statement-breakpoint
CREATE POLICY "encryption_transition_observations_product_all" ON "encryption_transition_observation_buckets" AS PERMISSIVE FOR ALL TO "nautilo" USING (true) WITH CHECK (true);--> statement-breakpoint
CREATE POLICY "encryption_transition_outcome_totals_product_all" ON "encryption_transition_outcome_totals" AS PERMISSIVE FOR ALL TO "nautilo" USING (true) WITH CHECK (true);--> statement-breakpoint
CREATE POLICY "encryption_transition_policy_product_all" ON "encryption_transition_policy" AS PERMISSIVE FOR ALL TO "nautilo" USING (true) WITH CHECK (true);
--> statement-breakpoint
-- M274_ENCRYPTION_TRANSITION_AUTHORITY
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
ON CONFLICT ("id") DO NOTHING;--> statement-breakpoint
-- Any ordinary Memory content mutation invalidates a verified shadow.
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
  FROM PUBLIC, "nautilo_agent", "nautilo_crypto";
