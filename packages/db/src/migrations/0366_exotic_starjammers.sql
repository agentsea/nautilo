CREATE TABLE "task_terminal_message_crypto_staging_receipts" (
	"request_id" text PRIMARY KEY NOT NULL,
	"recipient_generation" bigint NOT NULL,
	"claim_id" text NOT NULL,
	"authorization_digest" "bytea" NOT NULL,
	"delivery_intent_hash" "bytea" NOT NULL,
	"accepted_policy_revision" bigint NOT NULL,
	"publication_policy_revision" bigint NOT NULL,
	"authority_fingerprint" "bytea" NOT NULL,
	"crypto_object_id" text NOT NULL,
	"genesis_manifest_hash" "bytea" NOT NULL,
	"staged_at" timestamp with time zone NOT NULL,
	CONSTRAINT "uq_task_terminal_message_staging_object" UNIQUE("crypto_object_id"),
	CONSTRAINT "task_terminal_message_staging_request_id_portable" CHECK (octet_length("task_terminal_message_crypto_staging_receipts"."request_id") between 1
      and 128
      and "task_terminal_message_crypto_staging_receipts"."request_id" ~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]*$'),
	CONSTRAINT "task_terminal_message_staging_generation_safe" CHECK ("task_terminal_message_crypto_staging_receipts"."recipient_generation" between 0 and 9007199254740991),
	CONSTRAINT "task_terminal_message_staging_claim_id_portable" CHECK (octet_length("task_terminal_message_crypto_staging_receipts"."claim_id") between 1
      and 128
      and "task_terminal_message_crypto_staging_receipts"."claim_id" ~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]*$'),
	CONSTRAINT "task_terminal_message_staging_authorization_digest_size" CHECK (octet_length("task_terminal_message_crypto_staging_receipts"."authorization_digest") = 32),
	CONSTRAINT "task_terminal_message_staging_delivery_intent_hash_size" CHECK (octet_length("task_terminal_message_crypto_staging_receipts"."delivery_intent_hash") = 32),
	CONSTRAINT "task_terminal_message_staging_policy_revision_positive" CHECK ("task_terminal_message_crypto_staging_receipts"."accepted_policy_revision" >= 1 and "task_terminal_message_crypto_staging_receipts"."publication_policy_revision" >= "task_terminal_message_crypto_staging_receipts"."accepted_policy_revision"),
	CONSTRAINT "task_terminal_message_staging_accepted_policy_safe" CHECK ("task_terminal_message_crypto_staging_receipts"."accepted_policy_revision" between 0 and 9007199254740991),
	CONSTRAINT "task_terminal_message_staging_publication_policy_safe" CHECK ("task_terminal_message_crypto_staging_receipts"."publication_policy_revision" between 0 and 9007199254740991),
	CONSTRAINT "task_terminal_message_staging_authority_fingerprint_size" CHECK (octet_length("task_terminal_message_crypto_staging_receipts"."authority_fingerprint") = 32),
	CONSTRAINT "task_terminal_message_staging_object_id_portable" CHECK (octet_length("task_terminal_message_crypto_staging_receipts"."crypto_object_id") between 1
      and 128
      and "task_terminal_message_crypto_staging_receipts"."crypto_object_id" ~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]*$'),
	CONSTRAINT "task_terminal_message_staging_object_shape" CHECK ("task_terminal_message_crypto_staging_receipts"."crypto_object_id" ~ '^message:v2:[0-9a-f]{64}$'),
	CONSTRAINT "task_terminal_message_staging_genesis_manifest_hash_size" CHECK (octet_length("task_terminal_message_crypto_staging_receipts"."genesis_manifest_hash") = 32)
);
--> statement-breakpoint
ALTER TABLE "task_terminal_message_crypto_staging_receipts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "background_crypto_authorization_requests" DROP CONSTRAINT "background_crypto_authorization_requests_work_kind";--> statement-breakpoint
ALTER TABLE "background_crypto_authorization_requests" DROP CONSTRAINT "background_crypto_authorization_requests_purpose";--> statement-breakpoint
ALTER TABLE "background_crypto_authorization_requests" DROP CONSTRAINT "background_crypto_authorization_requests_work_subject_coherent";--> statement-breakpoint
ALTER TABLE "task_terminal_message_crypto_staging_receipts" ADD CONSTRAINT "task_terminal_message_staging_object_fk" FOREIGN KEY ("crypto_object_id") REFERENCES "public"."crypto_objects"("object_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "background_crypto_authorization_requests" ADD CONSTRAINT "background_crypto_authorization_requests_work_kind" CHECK ("background_crypto_authorization_requests"."work_kind" in (
        'stenographer.extraction',
        'stenographer.historical',
        'stenographer.compaction',
        'stenographer.rebuild',
        'stenographer.publication_reconcile',
        'stenographer.output_repair',
        'reflection.authority_reproject',
        'reflection.publication_reconcile',
        'reflection.search_projection',
        'reflection.organization',
        'reflection.dependency_rewrite',
        'memory.review',
        'memory.exit_flush',
        'task.dispatch',
        'task.execute',
        'task.await_reply_resume',
        'task.approval_resume',
        'task.cancel_result',
        'task.deliver_message'
      ));--> statement-breakpoint
ALTER TABLE "background_crypto_authorization_requests" ADD CONSTRAINT "background_crypto_authorization_requests_purpose" CHECK ("background_crypto_authorization_requests"."purpose" in (
        'journal.extract',
        'journal.compact',
        'journal.rebuild',
        'journal.reconcile',
        'journal.repair',
        'record.reproject',
        'record.reconcile',
        'record.search_projection',
        'record.organize',
        'record.dependency_rewrite',
        'memory.review',
        'memory.exit_flush',
        'task.dispatch',
        'task.execute',
        'task.await_reply_resume',
        'task.approval_resume',
        'task.cancel_result',
        'task.deliver_message'
      ));--> statement-breakpoint
ALTER TABLE "background_crypto_authorization_requests" ADD CONSTRAINT "background_crypto_authorization_requests_work_subject_coherent" CHECK ((
        ("background_crypto_authorization_requests"."work_kind" like 'stenographer.%' and "background_crypto_authorization_requests"."processor_kind" = 'stenographer'
          or "background_crypto_authorization_requests"."work_kind" like 'reflection.%' and "background_crypto_authorization_requests"."processor_kind" = 'reflection')
        and "background_crypto_authorization_requests"."credential_subject_kind" = 'processor'
      ) or (
        "background_crypto_authorization_requests"."work_kind" not like 'stenographer.%'
        and "background_crypto_authorization_requests"."work_kind" not like 'reflection.%'
        and "background_crypto_authorization_requests"."work_kind" not in ('task.cancel_result', 'task.deliver_message')
        and ("background_crypto_authorization_requests"."work_kind" not like 'task.%'
          or "background_crypto_authorization_requests"."format_version" in (1, 2))
        and "background_crypto_authorization_requests"."credential_subject_kind" = 'agent'
      ) or (
        "background_crypto_authorization_requests"."work_kind" in (
          'task.dispatch',
          'task.execute',
          'task.await_reply_resume',
          'task.approval_resume',
        'task.cancel_result',
        'task.deliver_message'
        )
        and "background_crypto_authorization_requests"."purpose" = "background_crypto_authorization_requests"."work_kind"
        and "background_crypto_authorization_requests"."format_version" = 3
        and "background_crypto_authorization_requests"."credential_subject_kind" = 'runtime'
      ));--> statement-breakpoint
CREATE POLICY "task_terminal_message_staging_crypto_sel" ON "task_terminal_message_crypto_staging_receipts" AS PERMISSIVE FOR SELECT TO "nautilo_crypto" USING (true);--> statement-breakpoint
CREATE POLICY "task_terminal_message_staging_crypto_ins" ON "task_terminal_message_crypto_staging_receipts" AS PERMISSIVE FOR INSERT TO "nautilo_crypto" WITH CHECK (true);
--> statement-breakpoint
-- TASK_TERMINAL_MESSAGE_CRYPTO_STAGING_AUTHORITY
ALTER TABLE "task_terminal_message_crypto_staging_receipts" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL PRIVILEGES ON TABLE "task_terminal_message_crypto_staging_receipts" FROM PUBLIC, "nautilo", "nautilo_agent", "nautilo_crypto";--> statement-breakpoint
GRANT SELECT, INSERT ON TABLE "task_terminal_message_crypto_staging_receipts" TO "nautilo_crypto";
