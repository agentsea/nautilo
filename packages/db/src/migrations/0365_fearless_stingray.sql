CREATE TABLE "task_cancellation_crypto_staging_receipts" (
	"request_id" text PRIMARY KEY NOT NULL,
	"recipient_generation" bigint NOT NULL,
	"claim_id" text NOT NULL,
	"authorization_digest" "bytea" NOT NULL,
	"stopped_intent_hash" "bytea" NOT NULL,
	"policy_revision" bigint NOT NULL,
	"authority_fingerprint" "bytea" NOT NULL,
	"crypto_object_id" text NOT NULL,
	"genesis_manifest_hash" "bytea" NOT NULL,
	"staged_at" timestamp with time zone NOT NULL,
	CONSTRAINT "uq_task_cancel_staging_object" UNIQUE("crypto_object_id"),
	CONSTRAINT "task_cancel_staging_request_id_portable" CHECK (octet_length("task_cancellation_crypto_staging_receipts"."request_id") between 1
      and 128
      and "task_cancellation_crypto_staging_receipts"."request_id" ~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]*$'),
	CONSTRAINT "task_cancel_staging_generation_safe" CHECK ("task_cancellation_crypto_staging_receipts"."recipient_generation" between 0 and 9007199254740991),
	CONSTRAINT "task_cancel_staging_claim_id_portable" CHECK (octet_length("task_cancellation_crypto_staging_receipts"."claim_id") between 1
      and 128
      and "task_cancellation_crypto_staging_receipts"."claim_id" ~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]*$'),
	CONSTRAINT "task_cancel_staging_authorization_digest_size" CHECK (octet_length("task_cancellation_crypto_staging_receipts"."authorization_digest") = 32),
	CONSTRAINT "task_cancel_staging_stopped_intent_hash_size" CHECK (octet_length("task_cancellation_crypto_staging_receipts"."stopped_intent_hash") = 32),
	CONSTRAINT "task_cancel_staging_policy_revision_positive" CHECK ("task_cancellation_crypto_staging_receipts"."policy_revision" >= 1),
	CONSTRAINT "task_cancel_staging_authority_fingerprint_size" CHECK (octet_length("task_cancellation_crypto_staging_receipts"."authority_fingerprint") = 32),
	CONSTRAINT "task_cancel_staging_object_id_portable" CHECK (octet_length("task_cancellation_crypto_staging_receipts"."crypto_object_id") between 1
      and 128
      and "task_cancellation_crypto_staging_receipts"."crypto_object_id" ~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]*$'),
	CONSTRAINT "task_cancel_staging_object_shape" CHECK ("task_cancellation_crypto_staging_receipts"."crypto_object_id" ~ '^task-run-result:v1:[0-9a-f]{64}$'),
	CONSTRAINT "task_cancel_staging_genesis_manifest_hash_size" CHECK (octet_length("task_cancellation_crypto_staging_receipts"."genesis_manifest_hash") = 32)
);
--> statement-breakpoint
ALTER TABLE "task_cancellation_crypto_staging_receipts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "task_cancellation_crypto_staging_receipts" ADD CONSTRAINT "task_cancel_staging_object_fk" FOREIGN KEY ("crypto_object_id") REFERENCES "public"."crypto_objects"("object_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE POLICY "task_cancel_staging_crypto_sel" ON "task_cancellation_crypto_staging_receipts" AS PERMISSIVE FOR SELECT TO "nautilo_crypto" USING (true);--> statement-breakpoint
CREATE POLICY "task_cancel_staging_crypto_ins" ON "task_cancellation_crypto_staging_receipts" AS PERMISSIVE FOR INSERT TO "nautilo_crypto" WITH CHECK (true);
--> statement-breakpoint
-- TASK_CANCELLATION_CRYPTO_STAGING_AUTHORITY
ALTER TABLE "task_cancellation_crypto_staging_receipts" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL PRIVILEGES ON TABLE "task_cancellation_crypto_staging_receipts" FROM PUBLIC, "nautilo", "nautilo_agent", "nautilo_crypto";--> statement-breakpoint
GRANT SELECT, INSERT ON TABLE "task_cancellation_crypto_staging_receipts" TO "nautilo_crypto";
