CREATE TABLE "task_historical_content_crypto_staging_receipts" (
	"crypto_object_id" text PRIMARY KEY NOT NULL,
	"operation_id" text NOT NULL,
	"signed_publication_request_bytes" "bytea" NOT NULL,
	"signed_request_digest" "bytea" NOT NULL,
	"authority_fingerprint" "bytea" NOT NULL,
	"genesis_manifest_hash" "bytea" NOT NULL,
	"staged_at" timestamp with time zone NOT NULL,
	CONSTRAINT "uq_task_historical_staging_operation" UNIQUE("operation_id"),
	CONSTRAINT "task_historical_staging_operation_portable" CHECK (octet_length("task_historical_content_crypto_staging_receipts"."operation_id") between 1
      and 128
      and "task_historical_content_crypto_staging_receipts"."operation_id" ~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]*$'),
	CONSTRAINT "task_historical_staging_object_portable" CHECK (octet_length("task_historical_content_crypto_staging_receipts"."crypto_object_id") between 1
      and 128
      and "task_historical_content_crypto_staging_receipts"."crypto_object_id" ~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]*$'),
	CONSTRAINT "task_historical_staging_object_shape" CHECK ("task_historical_content_crypto_staging_receipts"."crypto_object_id" ~ '^task-historical:v1:[0-9a-f]{64}$'),
	CONSTRAINT "task_historical_staging_signed_request_size" CHECK (octet_length("task_historical_content_crypto_staging_receipts"."signed_publication_request_bytes") between 1
      and 1048576),
	CONSTRAINT "task_historical_staging_signed_request_digest_size" CHECK (octet_length("task_historical_content_crypto_staging_receipts"."signed_request_digest") = 32),
	CONSTRAINT "task_historical_staging_authority_fingerprint_size" CHECK (octet_length("task_historical_content_crypto_staging_receipts"."authority_fingerprint") = 32),
	CONSTRAINT "task_historical_staging_genesis_manifest_hash_size" CHECK (octet_length("task_historical_content_crypto_staging_receipts"."genesis_manifest_hash") = 32)
);
--> statement-breakpoint
ALTER TABLE "task_historical_content_crypto_staging_receipts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "task_definition_crypto_revisions" DROP CONSTRAINT "task_definition_crypto_revisions_historical_repair";--> statement-breakpoint
ALTER TABLE "task_definition_crypto_revisions" DROP CONSTRAINT "task_definition_crypto_revisions_object_shape";--> statement-breakpoint
ALTER TABLE "task_run_result_crypto_revisions" DROP CONSTRAINT "task_run_result_crypto_revisions_historical_repair";--> statement-breakpoint
ALTER TABLE "task_run_result_crypto_revisions" DROP CONSTRAINT "task_run_result_crypto_revisions_object_shape";--> statement-breakpoint
ALTER TABLE "task_historical_content_crypto_staging_receipts" ADD CONSTRAINT "task_historical_staging_object_fk" FOREIGN KEY ("crypto_object_id") REFERENCES "public"."crypto_objects"("object_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_definition_crypto_revisions" ADD CONSTRAINT "task_definition_crypto_revisions_historical_repair" CHECK ("task_definition_crypto_revisions"."historical_repair" is null or ((
      "task_definition_crypto_revisions"."representation" = 'dual' and "task_definition_crypto_revisions"."content_revision" = 1
      and jsonb_typeof("task_definition_crypto_revisions"."historical_repair") = 'object'
      and "task_definition_crypto_revisions"."historical_repair" ?& ARRAY['version','claimId','publisherDeviceId','signedRequestDigest','sourceDigest','sourcePayloadHash','sourceRevision']
      and (
        ("task_definition_crypto_revisions"."historical_repair"->'version' = '1'::jsonb
          and ("task_definition_crypto_revisions"."historical_repair" - ARRAY['version','claimId','publisherDeviceId','signedRequestDigest','sourceDigest','sourcePayloadHash','sourceRevision']) = '{}'::jsonb)
        or ("task_definition_crypto_revisions"."historical_repair"->'version' = '2'::jsonb
          and "task_definition_crypto_revisions"."historical_repair" ? 'genesisManifestHash'
          and ("task_definition_crypto_revisions"."historical_repair" - ARRAY['version','claimId','publisherDeviceId','signedRequestDigest','sourceDigest','sourcePayloadHash','sourceRevision','genesisManifestHash']) = '{}'::jsonb
          and jsonb_typeof("task_definition_crypto_revisions"."historical_repair"->'genesisManifestHash') = 'string'
          and "task_definition_crypto_revisions"."historical_repair"->>'genesisManifestHash' ~ '^[0-9a-f]{64}$')
      )
      and "task_definition_crypto_revisions"."historical_repair"->'sourceRevision' = '0'::jsonb
      and jsonb_typeof("task_definition_crypto_revisions"."historical_repair"->'claimId') = 'string'
      and "task_definition_crypto_revisions"."historical_repair"->>'claimId' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
      and octet_length("task_definition_crypto_revisions"."historical_repair"->>'publisherDeviceId') between 1 and 128
      and jsonb_typeof("task_definition_crypto_revisions"."historical_repair"->'publisherDeviceId') = 'string'
      and "task_definition_crypto_revisions"."historical_repair"->>'publisherDeviceId' ~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]*$'
      and jsonb_typeof("task_definition_crypto_revisions"."historical_repair"->'signedRequestDigest') = 'string'
      and "task_definition_crypto_revisions"."historical_repair"->>'signedRequestDigest' ~ '^[0-9a-f]{64}$'
      and jsonb_typeof("task_definition_crypto_revisions"."historical_repair"->'sourceDigest') = 'string'
      and "task_definition_crypto_revisions"."historical_repair"->>'sourceDigest' ~ '^[0-9a-f]{64}$'
      and jsonb_typeof("task_definition_crypto_revisions"."historical_repair"->'sourcePayloadHash') = 'string'
      and "task_definition_crypto_revisions"."historical_repair"->>'sourcePayloadHash' ~ '^[0-9a-f]{64}$'
    ) is true));--> statement-breakpoint
ALTER TABLE "task_definition_crypto_revisions" ADD CONSTRAINT "task_definition_crypto_revisions_object_shape" CHECK (((
      ("task_definition_crypto_revisions"."historical_repair" is null or "task_definition_crypto_revisions"."historical_repair"->'version' = '1'::jsonb)
      and "task_definition_crypto_revisions"."crypto_object_id" ~ '^task-definition:v1:[0-9a-f]{64}$'
    ) or (
      "task_definition_crypto_revisions"."historical_repair"->'version' = '2'::jsonb
      and "task_definition_crypto_revisions"."crypto_object_id" ~ '^task-historical:v1:[0-9a-f]{64}$'
    )) is true);--> statement-breakpoint
ALTER TABLE "task_run_result_crypto_revisions" ADD CONSTRAINT "task_run_result_crypto_revisions_historical_repair" CHECK ("task_run_result_crypto_revisions"."historical_repair" is null or ((
      "task_run_result_crypto_revisions"."representation" = 'dual' and "task_run_result_crypto_revisions"."result_revision" = 1
      and jsonb_typeof("task_run_result_crypto_revisions"."historical_repair") = 'object'
      and "task_run_result_crypto_revisions"."historical_repair" ?& ARRAY['version','claimId','publisherDeviceId','signedRequestDigest','sourceDigest','sourcePayloadHash','sourceRevision']
      and (
        ("task_run_result_crypto_revisions"."historical_repair"->'version' = '1'::jsonb
          and ("task_run_result_crypto_revisions"."historical_repair" - ARRAY['version','claimId','publisherDeviceId','signedRequestDigest','sourceDigest','sourcePayloadHash','sourceRevision']) = '{}'::jsonb)
        or ("task_run_result_crypto_revisions"."historical_repair"->'version' = '2'::jsonb
          and "task_run_result_crypto_revisions"."historical_repair" ? 'genesisManifestHash'
          and ("task_run_result_crypto_revisions"."historical_repair" - ARRAY['version','claimId','publisherDeviceId','signedRequestDigest','sourceDigest','sourcePayloadHash','sourceRevision','genesisManifestHash']) = '{}'::jsonb
          and jsonb_typeof("task_run_result_crypto_revisions"."historical_repair"->'genesisManifestHash') = 'string'
          and "task_run_result_crypto_revisions"."historical_repair"->>'genesisManifestHash' ~ '^[0-9a-f]{64}$')
      )
      and "task_run_result_crypto_revisions"."historical_repair"->'sourceRevision' = '0'::jsonb
      and jsonb_typeof("task_run_result_crypto_revisions"."historical_repair"->'claimId') = 'string'
      and "task_run_result_crypto_revisions"."historical_repair"->>'claimId' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
      and octet_length("task_run_result_crypto_revisions"."historical_repair"->>'publisherDeviceId') between 1 and 128
      and jsonb_typeof("task_run_result_crypto_revisions"."historical_repair"->'publisherDeviceId') = 'string'
      and "task_run_result_crypto_revisions"."historical_repair"->>'publisherDeviceId' ~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]*$'
      and jsonb_typeof("task_run_result_crypto_revisions"."historical_repair"->'signedRequestDigest') = 'string'
      and "task_run_result_crypto_revisions"."historical_repair"->>'signedRequestDigest' ~ '^[0-9a-f]{64}$'
      and jsonb_typeof("task_run_result_crypto_revisions"."historical_repair"->'sourceDigest') = 'string'
      and "task_run_result_crypto_revisions"."historical_repair"->>'sourceDigest' ~ '^[0-9a-f]{64}$'
      and jsonb_typeof("task_run_result_crypto_revisions"."historical_repair"->'sourcePayloadHash') = 'string'
      and "task_run_result_crypto_revisions"."historical_repair"->>'sourcePayloadHash' ~ '^[0-9a-f]{64}$'
    ) is true));--> statement-breakpoint
ALTER TABLE "task_run_result_crypto_revisions" ADD CONSTRAINT "task_run_result_crypto_revisions_object_shape" CHECK (((
      ("task_run_result_crypto_revisions"."historical_repair" is null or "task_run_result_crypto_revisions"."historical_repair"->'version' = '1'::jsonb)
      and "task_run_result_crypto_revisions"."crypto_object_id" ~ '^task-run-result:v1:[0-9a-f]{64}$'
    ) or (
      "task_run_result_crypto_revisions"."historical_repair"->'version' = '2'::jsonb
      and "task_run_result_crypto_revisions"."crypto_object_id" ~ '^task-historical:v1:[0-9a-f]{64}$'
    )) is true);--> statement-breakpoint
CREATE POLICY "task_historical_staging_crypto_sel" ON "task_historical_content_crypto_staging_receipts" AS PERMISSIVE FOR SELECT TO "nautilo_crypto" USING (true);--> statement-breakpoint
CREATE POLICY "task_historical_staging_crypto_ins" ON "task_historical_content_crypto_staging_receipts" AS PERMISSIVE FOR INSERT TO "nautilo_crypto" WITH CHECK (true);
--> statement-breakpoint
-- TASK_HISTORICAL_CONTENT_CRYPTO_STAGING_AUTHORITY
ALTER TABLE "task_historical_content_crypto_staging_receipts" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL PRIVILEGES ON TABLE "task_historical_content_crypto_staging_receipts" FROM PUBLIC, "nautilo", "nautilo_agent", "nautilo_crypto";--> statement-breakpoint
GRANT SELECT, INSERT ON TABLE "task_historical_content_crypto_staging_receipts" TO "nautilo_crypto";
