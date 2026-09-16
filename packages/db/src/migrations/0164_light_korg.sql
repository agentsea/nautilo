CREATE TABLE "artifact_crypto_blobs" (
	"sequence" serial PRIMARY KEY NOT NULL,
	"artifact_row_id" uuid NOT NULL,
	"artifact_id" text NOT NULL,
	"blob_id" text NOT NULL,
	"blob_generation" integer NOT NULL,
	"publication_operation_id" text NOT NULL,
	"storage_ref" text NOT NULL,
	"ciphertext_length" bigint NOT NULL,
	"ciphertext_sha256" "bytea" NOT NULL,
	"state" text DEFAULT 'staging' NOT NULL,
	"failure_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"published_at" timestamp with time zone,
	"terminal_at" timestamp with time zone,
	CONSTRAINT "uq_artifact_crypto_blobs_id" UNIQUE("blob_id"),
	CONSTRAINT "uq_artifact_crypto_blobs_publication_operation" UNIQUE("publication_operation_id"),
	CONSTRAINT "uq_artifact_crypto_blobs_generation" UNIQUE("artifact_row_id","artifact_id","blob_generation"),
	CONSTRAINT "uq_artifact_crypto_blobs_exact_reference" UNIQUE("blob_id","artifact_row_id","artifact_id","blob_generation"),
	CONSTRAINT "artifact_crypto_blobs_ids_portable" CHECK ("artifact_crypto_blobs"."artifact_id" ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
        and "artifact_crypto_blobs"."blob_id" ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
        and octet_length("artifact_crypto_blobs"."publication_operation_id") between 1 and 128
        and "artifact_crypto_blobs"."publication_operation_id" ~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]*$'),
	CONSTRAINT "artifact_crypto_blobs_generation_positive" CHECK ("artifact_crypto_blobs"."blob_generation" > 0),
	CONSTRAINT "artifact_crypto_blobs_storage_ref_safe" CHECK (octet_length("artifact_crypto_blobs"."storage_ref") between 1 and 512
        and "artifact_crypto_blobs"."storage_ref" ~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]*$'
        and "artifact_crypto_blobs"."storage_ref" !~ '(^|/)\.\.(/|$)'
        and "artifact_crypto_blobs"."storage_ref" !~ '^file:'),
	CONSTRAINT "artifact_crypto_blobs_ciphertext_bounded" CHECK ("artifact_crypto_blobs"."ciphertext_length" > 0
        and "artifact_crypto_blobs"."ciphertext_length" <= 110100480
        and octet_length("artifact_crypto_blobs"."ciphertext_sha256") = 32),
	CONSTRAINT "artifact_crypto_blobs_lifecycle_coherent" CHECK ((
        "artifact_crypto_blobs"."state" = 'staging'
        and "artifact_crypto_blobs"."failure_code" is null
        and "artifact_crypto_blobs"."published_at" is null
        and "artifact_crypto_blobs"."terminal_at" is null
      ) or (
        "artifact_crypto_blobs"."state" = 'published'
        and "artifact_crypto_blobs"."failure_code" is null
        and "artifact_crypto_blobs"."published_at" is not null
        and "artifact_crypto_blobs"."terminal_at" is null
      ) or (
        "artifact_crypto_blobs"."state" in ('orphaned', 'quarantined')
        and "artifact_crypto_blobs"."failure_code" is not null
        and "artifact_crypto_blobs"."terminal_at" is not null
      )),
	CONSTRAINT "artifact_crypto_blobs_failure_code_check" CHECK ("artifact_crypto_blobs"."failure_code" is null or "artifact_crypto_blobs"."failure_code" in (
        'storage_transient', 'publication_conflict', 'ciphertext_mismatch',
        'orphan_expired', 'retry_exhausted'
      ))
);
--> statement-breakpoint
ALTER TABLE "artifact_crypto_blobs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "artifact_crypto_revisions" (
	"sequence" serial PRIMARY KEY NOT NULL,
	"artifact_row_id" uuid NOT NULL,
	"artifact_id" text NOT NULL,
	"artifact_revision" integer NOT NULL,
	"anchor_namespace_id" uuid NOT NULL,
	"crypto_object_id" text NOT NULL,
	"payload_version" smallint DEFAULT 1 NOT NULL,
	"allocation_request_digest" "bytea" NOT NULL,
	"required_namespace_fingerprint" "bytea" NOT NULL,
	"blob_id" text NOT NULL,
	"blob_generation" integer NOT NULL,
	"mime_class" text NOT NULL,
	"size_bucket" text NOT NULL,
	"blob_reference_state" text DEFAULT 'retained' NOT NULL,
	"completion" text DEFAULT 'pending' NOT NULL,
	"disposition" text DEFAULT 'active' NOT NULL,
	"attempt_count" smallint DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now(),
	"lease_token" uuid,
	"lease_expires_at" timestamp with time zone,
	"failure_code" text,
	"crypto_completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uq_artifact_crypto_revisions_internal_coordinate" UNIQUE("artifact_row_id","artifact_revision"),
	CONSTRAINT "uq_artifact_crypto_revisions_stable_coordinate" UNIQUE("artifact_id","artifact_revision"),
	CONSTRAINT "uq_artifact_crypto_revisions_object" UNIQUE("crypto_object_id"),
	CONSTRAINT "artifact_crypto_revisions_identity_shape" CHECK ("artifact_crypto_revisions"."artifact_revision" > 0
        and "artifact_crypto_revisions"."blob_generation" > 0
        and "artifact_crypto_revisions"."payload_version" = 1
        and "artifact_crypto_revisions"."artifact_id" ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
        and "artifact_crypto_revisions"."crypto_object_id" ~ '^artifact:v1:[0-9a-f]{64}$'
        and "artifact_crypto_revisions"."blob_id" ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
        and "artifact_crypto_revisions"."mime_class" in ('text', 'image', 'audio', 'video', 'document', 'archive', 'binary')
        and "artifact_crypto_revisions"."size_bucket" in ('empty', 'le_64_kib', 'le_1_mib', 'le_10_mib', 'le_100_mib')),
	CONSTRAINT "artifact_crypto_revisions_digest_sizes" CHECK (octet_length("artifact_crypto_revisions"."allocation_request_digest") = 32
        and octet_length("artifact_crypto_revisions"."required_namespace_fingerprint") = 32),
	CONSTRAINT "artifact_crypto_revisions_lifecycle_coherent" CHECK ((
        "artifact_crypto_revisions"."completion" = 'pending'
        and "artifact_crypto_revisions"."crypto_completed_at" is null
        and "artifact_crypto_revisions"."disposition" in ('active', 'blocked', 'quarantined')
      ) or (
        "artifact_crypto_revisions"."completion" = 'complete'
        and "artifact_crypto_revisions"."crypto_completed_at" is not null
        and "artifact_crypto_revisions"."disposition" in ('active', 'mapped', 'quarantined', 'superseded', 'stale_mapping')
      )),
	CONSTRAINT "artifact_crypto_revisions_reference_coherent" CHECK ("artifact_crypto_revisions"."blob_reference_state" = 'retained'
        or ("artifact_crypto_revisions"."blob_reference_state" = 'released'
          and "artifact_crypto_revisions"."disposition" in ('quarantined', 'superseded', 'stale_mapping'))),
	CONSTRAINT "artifact_crypto_revisions_retry_coherent" CHECK ("artifact_crypto_revisions"."attempt_count" between 0 and 8
        and ("artifact_crypto_revisions"."lease_token" is null) = ("artifact_crypto_revisions"."lease_expires_at" is null)),
	CONSTRAINT "artifact_crypto_revisions_failure_code_check" CHECK ((
        "artifact_crypto_revisions"."disposition" in ('active', 'mapped', 'superseded')
        and "artifact_crypto_revisions"."failure_code" is null
      ) or (
        "artifact_crypto_revisions"."disposition" in ('blocked', 'quarantined', 'stale_mapping')
        and "artifact_crypto_revisions"."failure_code" in (
        'namespace_unresolved', 'crypto_absent', 'crypto_incomplete',
        'crypto_mismatch', 'authorization_unavailable', 'recipient_unavailable',
        'target_encryption_not_ready', 'blob_unavailable', 'blob_mismatch',
        'storage_transient', 'mapping_conflict', 'retry_exhausted'
        )
      ))
);
--> statement-breakpoint
ALTER TABLE "artifact_crypto_revisions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "artifact_crypto_operations" (
	"sequence" serial PRIMARY KEY NOT NULL,
	"operation_id" text NOT NULL,
	"artifact_row_id" uuid NOT NULL,
	"artifact_id" text NOT NULL,
	"anchor_namespace_id" uuid NOT NULL,
	"operation_type" text NOT NULL,
	"expected_artifact_revision" integer NOT NULL,
	"result_artifact_revision" integer NOT NULL,
	"expected_access_revision" integer NOT NULL,
	"result_access_revision" integer NOT NULL,
	"expected_blob_generation" integer NOT NULL,
	"result_blob_generation" integer NOT NULL,
	"expected_blob_id" text,
	"result_blob_id" text NOT NULL,
	"request_digest" "bytea" NOT NULL,
	"expected_required_namespace_fingerprint" "bytea",
	"target_required_namespace_fingerprint" "bytea" NOT NULL,
	"completion" text DEFAULT 'pending' NOT NULL,
	"disposition" text DEFAULT 'active' NOT NULL,
	"attempt_count" smallint DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now(),
	"lease_token" uuid,
	"lease_expires_at" timestamp with time zone,
	"failure_code" text,
	"crypto_completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uq_artifact_crypto_operations_id" UNIQUE("operation_id"),
	CONSTRAINT "artifact_crypto_operations_ids_portable" CHECK (octet_length("artifact_crypto_operations"."operation_id") between 1 and 128
        and "artifact_crypto_operations"."operation_id" ~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]*$'
        and "artifact_crypto_operations"."artifact_id" ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
        and ("artifact_crypto_operations"."expected_blob_id" is null or "artifact_crypto_operations"."expected_blob_id" ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$')
        and "artifact_crypto_operations"."result_blob_id" ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
	CONSTRAINT "artifact_crypto_operations_shape" CHECK ((
        "artifact_crypto_operations"."operation_type" = 'create'
        and "artifact_crypto_operations"."expected_artifact_revision" = 0
        and "artifact_crypto_operations"."result_artifact_revision" = 1
        and "artifact_crypto_operations"."expected_access_revision" = 0
        and "artifact_crypto_operations"."result_access_revision" = 0
        and "artifact_crypto_operations"."expected_blob_generation" = 0
        and "artifact_crypto_operations"."result_blob_generation" = 1
        and "artifact_crypto_operations"."expected_blob_id" is null
        and "artifact_crypto_operations"."expected_required_namespace_fingerprint" is null
      ) or (
        "artifact_crypto_operations"."operation_type" = 'content'
        and "artifact_crypto_operations"."expected_artifact_revision" > 0
        and "artifact_crypto_operations"."result_artifact_revision" = "artifact_crypto_operations"."expected_artifact_revision" + 1
        and "artifact_crypto_operations"."expected_access_revision" >= 0
        and "artifact_crypto_operations"."result_access_revision" = 0
        and "artifact_crypto_operations"."expected_blob_generation" > 0
        and "artifact_crypto_operations"."result_blob_generation" = "artifact_crypto_operations"."expected_blob_generation" + 1
        and "artifact_crypto_operations"."expected_blob_id" is not null
        and "artifact_crypto_operations"."result_blob_id" <> "artifact_crypto_operations"."expected_blob_id"
        and "artifact_crypto_operations"."expected_required_namespace_fingerprint" is not null
      ) or (
        "artifact_crypto_operations"."operation_type" = 'control'
        and "artifact_crypto_operations"."expected_artifact_revision" > 0
        and "artifact_crypto_operations"."result_artifact_revision" = "artifact_crypto_operations"."expected_artifact_revision" + 1
        and "artifact_crypto_operations"."expected_access_revision" >= 0
        and "artifact_crypto_operations"."result_access_revision" = 0
        and "artifact_crypto_operations"."expected_blob_generation" > 0
        and "artifact_crypto_operations"."result_blob_generation" = "artifact_crypto_operations"."expected_blob_generation"
        and "artifact_crypto_operations"."expected_blob_id" is not null
        and "artifact_crypto_operations"."result_blob_id" = "artifact_crypto_operations"."expected_blob_id"
        and "artifact_crypto_operations"."expected_required_namespace_fingerprint" is not null
      )),
	CONSTRAINT "artifact_crypto_operations_digest_sizes" CHECK (octet_length("artifact_crypto_operations"."request_digest") = 32
        and ("artifact_crypto_operations"."expected_required_namespace_fingerprint" is null
          or octet_length("artifact_crypto_operations"."expected_required_namespace_fingerprint") = 32)
        and octet_length("artifact_crypto_operations"."target_required_namespace_fingerprint") = 32),
	CONSTRAINT "artifact_crypto_operations_completion_coherent" CHECK ((
        "artifact_crypto_operations"."completion" = 'pending'
        and "artifact_crypto_operations"."crypto_completed_at" is null
        and "artifact_crypto_operations"."disposition" in ('active', 'blocked', 'quarantined')
      ) or (
        "artifact_crypto_operations"."completion" = 'complete'
        and "artifact_crypto_operations"."crypto_completed_at" is not null
        and "artifact_crypto_operations"."disposition" = 'complete'
      )),
	CONSTRAINT "artifact_crypto_operations_retry_coherent" CHECK ("artifact_crypto_operations"."attempt_count" between 0 and 8
        and ("artifact_crypto_operations"."lease_token" is null) = ("artifact_crypto_operations"."lease_expires_at" is null)),
	CONSTRAINT "artifact_crypto_operations_failure_code_check" CHECK ((
        "artifact_crypto_operations"."disposition" in ('active', 'complete')
        and "artifact_crypto_operations"."failure_code" is null
      ) or (
        "artifact_crypto_operations"."disposition" in ('blocked', 'quarantined')
        and "artifact_crypto_operations"."failure_code" in (
        'namespace_unresolved', 'crypto_absent', 'crypto_incomplete',
        'crypto_mismatch', 'authorization_unavailable', 'recipient_unavailable',
        'target_encryption_not_ready', 'blob_unavailable', 'blob_mismatch',
        'storage_transient', 'mapping_conflict', 'retry_exhausted'
        )
      ))
);
--> statement-breakpoint
ALTER TABLE "artifact_crypto_operations" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "artifacts" ALTER COLUMN "path" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "artifacts" ALTER COLUMN "mime_type" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "artifacts" ALTER COLUMN "size" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "artifacts" ALTER COLUMN "storage_uri" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "artifacts" ADD COLUMN "crypto_object_id" text;--> statement-breakpoint
ALTER TABLE "artifacts" ADD COLUMN "crypto_access_revision" integer;--> statement-breakpoint
ALTER TABLE "artifacts" ADD COLUMN "crypto_required_namespace_fingerprint" "bytea";--> statement-breakpoint
ALTER TABLE "artifacts" ADD COLUMN "blob_id" text;--> statement-breakpoint
ALTER TABLE "artifacts" ADD COLUMN "blob_generation" integer;--> statement-breakpoint
ALTER TABLE "artifacts" ADD COLUMN "ciphertext_length" bigint;--> statement-breakpoint
ALTER TABLE "artifacts" ADD COLUMN "ciphertext_sha256" "bytea";--> statement-breakpoint
ALTER TABLE "artifacts" ADD COLUMN "mime_class" text;--> statement-breakpoint
ALTER TABLE "artifacts" ADD COLUMN "size_bucket" text;--> statement-breakpoint
ALTER TABLE "artifacts" ADD COLUMN "crypto_lifecycle_state" text;--> statement-breakpoint
ALTER TABLE "artifact_crypto_revisions" ADD CONSTRAINT "artifact_crypto_revisions_exact_blob_fk" FOREIGN KEY ("blob_id","artifact_row_id","artifact_id","blob_generation") REFERENCES "public"."artifact_crypto_blobs"("blob_id","artifact_row_id","artifact_id","blob_generation") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_artifact_crypto_blobs_state" ON "artifact_crypto_blobs" USING btree ("state","sequence");--> statement-breakpoint
CREATE INDEX "idx_artifact_crypto_revisions_due" ON "artifact_crypto_revisions" USING btree ("disposition","next_attempt_at","sequence","completion") WHERE "artifact_crypto_revisions"."disposition" = 'active';--> statement-breakpoint
CREATE INDEX "idx_artifact_crypto_operations_artifact" ON "artifact_crypto_operations" USING btree ("artifact_row_id","sequence");--> statement-breakpoint
CREATE INDEX "idx_artifact_crypto_operations_due" ON "artifact_crypto_operations" USING btree ("disposition","next_attempt_at","sequence","completion") WHERE "artifact_crypto_operations"."disposition" = 'active';--> statement-breakpoint
ALTER TABLE "artifacts" ADD CONSTRAINT "artifacts_crypto_object_id_crypto_objects_object_id_fk" FOREIGN KEY ("crypto_object_id") REFERENCES "public"."crypto_objects"("object_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "artifacts" ADD CONSTRAINT "uq_artifacts_crypto_object_id" UNIQUE("crypto_object_id");--> statement-breakpoint
ALTER TABLE "artifacts" ADD CONSTRAINT "artifacts_revision_positive" CHECK ("artifacts"."revision" > 0);--> statement-breakpoint
ALTER TABLE "artifacts" ADD CONSTRAINT "artifacts_crypto_mapping_coherent" CHECK ((
        "artifacts"."crypto_object_id" is null
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
        and "artifacts"."path" is null
        and "artifacts"."mime_type" is null
        and "artifacts"."size" is null
        and "artifacts"."storage_uri" is null
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
        and (
          ("artifacts"."crypto_lifecycle_state" = 'active' and "artifacts"."deleted_at" is null)
          or ("artifacts"."crypto_lifecycle_state" = 'archived' and "artifacts"."deleted_at" is not null)
          or "artifacts"."crypto_lifecycle_state" = 'quarantined'
        )
      ));--> statement-breakpoint
CREATE POLICY "artifact_crypto_blobs_product_all" ON "artifact_crypto_blobs" AS PERMISSIVE FOR ALL TO "nautilo" USING (true) WITH CHECK (true);--> statement-breakpoint
CREATE POLICY "artifact_crypto_revisions_product_all" ON "artifact_crypto_revisions" AS PERMISSIVE FOR ALL TO "nautilo" USING (true) WITH CHECK (true);--> statement-breakpoint
CREATE POLICY "artifact_crypto_operations_product_all" ON "artifact_crypto_operations" AS PERMISSIVE FOR ALL TO "nautilo" USING (true) WITH CHECK (true);
--> statement-breakpoint
-- M261_ARTIFACT_CRYPTO_LIFECYCLE_AUTHORITY
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
  TO "nautilo";
