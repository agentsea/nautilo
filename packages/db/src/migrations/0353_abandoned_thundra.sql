CREATE TABLE "protected_task_wake_continuation_receipts" (
	"wake_job_id" uuid NOT NULL,
	"segment" integer NOT NULL,
	"task_id" uuid NOT NULL,
	"task_run_id" uuid NOT NULL,
	"binding_id" text NOT NULL,
	"wake_operation_id" text NOT NULL,
	"prior_recipient_generation" integer NOT NULL,
	"wake_authorization_request_id" text NOT NULL,
	"additional_authorization_request_id" text NOT NULL,
	"interrupt_id" text NOT NULL,
	"operation_id" text NOT NULL,
	"request_digest" "bytea" NOT NULL,
	"required_authority_digest" "bytea" NOT NULL,
	"semantic_authority_requirements" jsonb NOT NULL,
	"retained_source_namespace_ids" uuid[] NOT NULL,
	"source_envelope_digest" "bytea" NOT NULL,
	"initial_policy_revision" integer NOT NULL,
	"initial_agent_authorization_revision" integer NOT NULL,
	"destination_room_id" uuid NOT NULL,
	"destination_namespace_id" uuid NOT NULL,
	"destination_authority_digest" "bytea" NOT NULL,
	"checkpoint_thread_id" text NOT NULL,
	"checkpoint_contract" text NOT NULL,
	"expected_checkpoint_count" integer NOT NULL,
	"checkpoint_ordered_digest" "bytea" NOT NULL,
	"expected_blob_count" integer NOT NULL,
	"blob_ordered_digest" "bytea" NOT NULL,
	"expected_pending_write_count" integer NOT NULL,
	"pending_write_ordered_digest" "bytea" NOT NULL,
	"sealed_at" timestamp with time zone NOT NULL,
	CONSTRAINT "protected_task_wake_continuation_receipts_pkey" PRIMARY KEY("wake_job_id","segment"),
	CONSTRAINT "uq_protected_task_wake_continuation_authorization_generation" UNIQUE("wake_authorization_request_id","prior_recipient_generation"),
	CONSTRAINT "uq_protected_task_wake_continuation_interrupt" UNIQUE("wake_job_id","interrupt_id"),
	CONSTRAINT "protected_task_wake_continuation_receipts_segment_positive" CHECK ("protected_task_wake_continuation_receipts"."segment" between 1 and 2147483647),
	CONSTRAINT "protected_task_wake_continuation_receipts_generation_safe" CHECK ("protected_task_wake_continuation_receipts"."prior_recipient_generation" between 0 and 2147483646
        and "protected_task_wake_continuation_receipts"."segment" = "protected_task_wake_continuation_receipts"."prior_recipient_generation" + 1),
	CONSTRAINT "protected_task_wake_continuation_receipts_identity_shape" CHECK ("protected_task_wake_continuation_receipts"."binding_id" = 'task-run-output:' || "protected_task_wake_continuation_receipts"."task_run_id"::text
        and "protected_task_wake_continuation_receipts"."wake_operation_id" = 'task-run-delivery-wake:' || "protected_task_wake_continuation_receipts"."task_run_id"::text
        and "protected_task_wake_continuation_receipts"."wake_authorization_request_id" = 'task-wake-authorization:' || "protected_task_wake_continuation_receipts"."wake_job_id"::text),
	CONSTRAINT "protected_task_wake_continuation_receipts_interrupt_shape" CHECK ("protected_task_wake_continuation_receipts"."additional_authorization_request_id" ~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]*$'
        and "protected_task_wake_continuation_receipts"."interrupt_id" ~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]*$'
        and "protected_task_wake_continuation_receipts"."operation_id" ~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]*$'
        and "protected_task_wake_continuation_receipts"."checkpoint_thread_id" ~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]*$'),
	CONSTRAINT "protected_task_wake_continuation_receipts_digest_sizes" CHECK (octet_length("protected_task_wake_continuation_receipts"."request_digest") = 32
        and octet_length("protected_task_wake_continuation_receipts"."required_authority_digest") = 32
        and octet_length("protected_task_wake_continuation_receipts"."source_envelope_digest") = 32
        and octet_length("protected_task_wake_continuation_receipts"."destination_authority_digest") = 32
        and octet_length("protected_task_wake_continuation_receipts"."checkpoint_ordered_digest") = 32
        and octet_length("protected_task_wake_continuation_receipts"."blob_ordered_digest") = 32
        and octet_length("protected_task_wake_continuation_receipts"."pending_write_ordered_digest") = 32),
	CONSTRAINT "protected_task_wake_continuation_receipts_public_revision_positive" CHECK ("protected_task_wake_continuation_receipts"."initial_policy_revision" > 0
        and "protected_task_wake_continuation_receipts"."initial_agent_authorization_revision" > 0),
	CONSTRAINT "protected_task_wake_continuation_receipts_manifest_counts_safe" CHECK ("protected_task_wake_continuation_receipts"."expected_checkpoint_count" between 1 and 2147483647
        and "protected_task_wake_continuation_receipts"."expected_blob_count" between 0 and 2147483647
        and "protected_task_wake_continuation_receipts"."expected_pending_write_count" between 0 and 2147483647),
	CONSTRAINT "protected_task_wake_continuation_receipts_authority_shape" CHECK (jsonb_typeof("protected_task_wake_continuation_receipts"."semantic_authority_requirements") = 'array'
        and cardinality("protected_task_wake_continuation_receipts"."retained_source_namespace_ids") > 0
        and array_position("protected_task_wake_continuation_receipts"."retained_source_namespace_ids", null) is null)
);
--> statement-breakpoint
ALTER TABLE "protected_task_wake_continuation_receipts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "protected_task_wake_continuation_receipts" ADD CONSTRAINT "protected_task_wake_continuation_receipts_wake_job_id_jobs_id_fk" FOREIGN KEY ("wake_job_id") REFERENCES "public"."jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "protected_task_wake_continuation_receipts" ADD CONSTRAINT "protected_task_wake_continuation_receipts_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "protected_task_wake_continuation_receipts" ADD CONSTRAINT "protected_task_wake_continuation_receipts_task_run_id_task_runs_id_fk" FOREIGN KEY ("task_run_id") REFERENCES "public"."task_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "protected_task_wake_continuation_receipts" ADD CONSTRAINT "protected_task_wake_continuation_binding_fk" FOREIGN KEY ("task_run_id") REFERENCES "public"."protected_task_run_output_bindings"("task_run_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "protected_task_wake_continuation_receipts" ADD CONSTRAINT "protected_task_wake_continuation_destination_fk" FOREIGN KEY ("destination_room_id","destination_namespace_id") REFERENCES "public"."rooms"("id","namespace_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE POLICY "protected_task_wake_continuation_receipts_product_select" ON "protected_task_wake_continuation_receipts" AS PERMISSIVE FOR SELECT TO "nautilo" USING (true);--> statement-breakpoint
CREATE POLICY "protected_task_wake_continuation_receipts_product_insert" ON "protected_task_wake_continuation_receipts" AS PERMISSIVE FOR INSERT TO "nautilo" WITH CHECK (true);
--> statement-breakpoint
-- TASK_WAKE_CONTINUATION_AUTHORITY
ALTER TABLE "protected_task_wake_continuation_receipts" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL PRIVILEGES ON TABLE "protected_task_wake_continuation_receipts" FROM PUBLIC, "nautilo", "nautilo_agent", "nautilo_crypto";--> statement-breakpoint
GRANT SELECT, INSERT ON TABLE "protected_task_wake_continuation_receipts" TO "nautilo";--> statement-breakpoint
CREATE FUNCTION "public"."reject_task_wake_continuation_update"()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog AS $$
BEGIN
  IF NEW IS DISTINCT FROM OLD THEN
    RAISE EXCEPTION 'Protected Task wake continuation is immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION "public"."reject_task_wake_continuation_update"() FROM PUBLIC, "nautilo_agent", "nautilo_crypto";--> statement-breakpoint
CREATE TRIGGER "task_wake_continuation_immutable" BEFORE UPDATE ON "protected_task_wake_continuation_receipts" FOR EACH ROW
EXECUTE FUNCTION "public"."reject_task_wake_continuation_update"();
