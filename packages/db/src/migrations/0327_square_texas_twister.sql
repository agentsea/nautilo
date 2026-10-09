CREATE TABLE "protected_task_execution_segment_receipts" (
	"task_run_id" uuid NOT NULL,
	"execution_segment" integer NOT NULL,
	"job_id" uuid NOT NULL,
	"route" text NOT NULL,
	"transcript_contract" text NOT NULL,
	"expected_transcript_association_count" integer NOT NULL,
	"transcript_association_digest" "bytea",
	"checkpoint_contract" text NOT NULL,
	"expected_checkpoint_count" integer NOT NULL,
	"checkpoint_digest" "bytea",
	"expected_checkpoint_blob_count" integer NOT NULL,
	"checkpoint_blob_digest" "bytea",
	"expected_pending_write_count" integer NOT NULL,
	"pending_write_digest" "bytea",
	"sealed_at" timestamp with time zone NOT NULL,
	CONSTRAINT "protected_task_execution_segment_receipts_pkey" PRIMARY KEY("task_run_id","execution_segment"),
	CONSTRAINT "uq_protected_task_execution_segment_receipts_job" UNIQUE("job_id"),
	CONSTRAINT "uq_protected_task_execution_segment_receipts_identity" UNIQUE("task_run_id","execution_segment","job_id"),
	CONSTRAINT "protected_task_execution_segment_receipts_segment_positive" CHECK ("protected_task_execution_segment_receipts"."execution_segment" > 0),
	CONSTRAINT "protected_task_execution_segment_receipts_counts_nonnegative" CHECK ("protected_task_execution_segment_receipts"."expected_transcript_association_count" >= 0
        and "protected_task_execution_segment_receipts"."expected_checkpoint_count" >= 0
        and "protected_task_execution_segment_receipts"."expected_checkpoint_blob_count" >= 0
        and "protected_task_execution_segment_receipts"."expected_pending_write_count" >= 0),
	CONSTRAINT "protected_task_execution_segment_receipts_transcript_coherent" CHECK ((
        "protected_task_execution_segment_receipts"."transcript_contract" = 'none_v1'
        and "protected_task_execution_segment_receipts"."expected_transcript_association_count" = 0
        and "protected_task_execution_segment_receipts"."transcript_association_digest" is null
      ) or (
        "protected_task_execution_segment_receipts"."transcript_contract" = 'protected_message_associations_v1'
        and "protected_task_execution_segment_receipts"."transcript_association_digest" is not null
        and octet_length("protected_task_execution_segment_receipts"."transcript_association_digest") = 32
      )),
	CONSTRAINT "protected_task_execution_segment_receipts_checkpoint_coherent" CHECK ((
        "protected_task_execution_segment_receipts"."checkpoint_contract" = 'none_v1'
        and "protected_task_execution_segment_receipts"."expected_checkpoint_count" = 0
        and "protected_task_execution_segment_receipts"."expected_checkpoint_blob_count" = 0
        and "protected_task_execution_segment_receipts"."expected_pending_write_count" = 0
        and "protected_task_execution_segment_receipts"."checkpoint_digest" is null
        and "protected_task_execution_segment_receipts"."checkpoint_blob_digest" is null
        and "protected_task_execution_segment_receipts"."pending_write_digest" is null
      ) or (
        "protected_task_execution_segment_receipts"."checkpoint_contract" = 'encrypted_langgraph_v1'
        and "protected_task_execution_segment_receipts"."checkpoint_digest" is not null
        and octet_length("protected_task_execution_segment_receipts"."checkpoint_digest") = 32
        and "protected_task_execution_segment_receipts"."checkpoint_blob_digest" is not null
        and octet_length("protected_task_execution_segment_receipts"."checkpoint_blob_digest") = 32
        and "protected_task_execution_segment_receipts"."pending_write_digest" is not null
        and octet_length("protected_task_execution_segment_receipts"."pending_write_digest") = 32
      )),
	CONSTRAINT "protected_task_execution_segment_receipts_route_coherent" CHECK ((
        "protected_task_execution_segment_receipts"."route" = 'native_langgraph_v1'
        and "protected_task_execution_segment_receipts"."transcript_contract"
          = 'protected_message_associations_v1'
        and "protected_task_execution_segment_receipts"."checkpoint_contract" = 'encrypted_langgraph_v1'
      ) or (
        "protected_task_execution_segment_receipts"."route" in (
          'hermes_acp_v1', 'opencode_acp_v1', 'codex_acp_v1',
          'claude_code_acp_v1'
        )
        and "protected_task_execution_segment_receipts"."transcript_contract" = 'none_v1'
        and "protected_task_execution_segment_receipts"."checkpoint_contract" = 'none_v1'
      ))
);
--> statement-breakpoint
ALTER TABLE "protected_task_execution_segment_receipts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "protected_task_continuation_receipts" (
	"task_run_id" uuid NOT NULL,
	"execution_segment" integer NOT NULL,
	"job_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"reason" text NOT NULL,
	"effect_disposition" text NOT NULL,
	"interrupt_id" text,
	"operation_id" text,
	"request_digest" "bytea",
	"required_authority_digest" "bytea",
	"sealed_at" timestamp with time zone NOT NULL,
	CONSTRAINT "protected_task_continuation_receipts_pkey" PRIMARY KEY("task_run_id","execution_segment"),
	CONSTRAINT "uq_protected_task_continuation_receipts_job" UNIQUE("job_id"),
	CONSTRAINT "protected_task_continuation_receipts_segment_resumable" CHECK ("protected_task_continuation_receipts"."execution_segment" between 1 and 2147483646),
	CONSTRAINT "protected_task_continuation_receipts_shape_coherent" CHECK ((
        "protected_task_continuation_receipts"."kind" = 'checkpoint_safe_v1'
        and "protected_task_continuation_receipts"."reason" in ('manual_pause', 'time_limit', 'grant_refresh')
        and "protected_task_continuation_receipts"."effect_disposition" = 'none_v1'
        and "protected_task_continuation_receipts"."interrupt_id" is null
        and "protected_task_continuation_receipts"."operation_id" is null
        and "protected_task_continuation_receipts"."request_digest" is null
        and "protected_task_continuation_receipts"."required_authority_digest" is null
      ) or (
        "protected_task_continuation_receipts"."kind" = 'pre_effect_interrupt_v1'
        and "protected_task_continuation_receipts"."reason" in ('grant_refresh', 'additional_authority')
        and "protected_task_continuation_receipts"."effect_disposition" = 'not_started_v1'
        and "protected_task_continuation_receipts"."interrupt_id" is not null
        and "protected_task_continuation_receipts"."interrupt_id" ~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]*$'
        and "protected_task_continuation_receipts"."operation_id" is not null
        and "protected_task_continuation_receipts"."operation_id" ~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]*$'
        and "protected_task_continuation_receipts"."request_digest" is not null
        and octet_length("protected_task_continuation_receipts"."request_digest") = 32
        and "protected_task_continuation_receipts"."required_authority_digest" is not null
        and octet_length("protected_task_continuation_receipts"."required_authority_digest") = 32
      ))
);
--> statement-breakpoint
ALTER TABLE "protected_task_continuation_receipts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "protected_task_execution_segment_receipts" ADD CONSTRAINT "protected_task_execution_segment_receipts_task_run_id_task_runs_id_fk" FOREIGN KEY ("task_run_id") REFERENCES "public"."task_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "protected_task_continuation_receipts" ADD CONSTRAINT "protected_task_continuation_receipts_segment_fk" FOREIGN KEY ("task_run_id","execution_segment","job_id") REFERENCES "public"."protected_task_execution_segment_receipts"("task_run_id","execution_segment","job_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE POLICY "protected_task_execution_segment_receipts_product_select" ON "protected_task_execution_segment_receipts" AS PERMISSIVE FOR SELECT TO "nautilo" USING (true);--> statement-breakpoint
CREATE POLICY "protected_task_execution_segment_receipts_product_insert" ON "protected_task_execution_segment_receipts" AS PERMISSIVE FOR INSERT TO "nautilo" WITH CHECK (true);--> statement-breakpoint
CREATE POLICY "protected_task_continuation_receipts_product_select" ON "protected_task_continuation_receipts" AS PERMISSIVE FOR SELECT TO "nautilo" USING (true);--> statement-breakpoint
CREATE POLICY "protected_task_continuation_receipts_product_insert" ON "protected_task_continuation_receipts" AS PERMISSIVE FOR INSERT TO "nautilo" WITH CHECK (true);
--> statement-breakpoint
-- TASK_EXECUTION_EVIDENCE_AUTHORITY
ALTER TABLE "protected_task_execution_segment_receipts" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL PRIVILEGES ON TABLE "protected_task_execution_segment_receipts" FROM PUBLIC, "nautilo", "nautilo_agent", "nautilo_crypto";--> statement-breakpoint
GRANT SELECT, INSERT ON TABLE "protected_task_execution_segment_receipts" TO "nautilo";
--> statement-breakpoint
ALTER TABLE "protected_task_continuation_receipts" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL PRIVILEGES ON TABLE "protected_task_continuation_receipts" FROM PUBLIC, "nautilo", "nautilo_agent", "nautilo_crypto";--> statement-breakpoint
GRANT SELECT, INSERT ON TABLE "protected_task_continuation_receipts" TO "nautilo";
