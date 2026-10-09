CREATE TABLE "conversion_operations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"operation_key" varchar(64) NOT NULL,
	"recovery_handle" varchar(36) NOT NULL,
	"causal_human_user_id" uuid NOT NULL,
	"room_id" uuid,
	"agent_id" uuid,
	"task_id" uuid,
	"run_id" uuid,
	"job_id" uuid,
	"funding_kind" varchar(16) NOT NULL,
	"provider_route" text NOT NULL,
	"credential_id" uuid,
	"credential_revision" integer,
	"credential_fingerprint" varchar(64) NOT NULL,
	"source_kind" varchar(16) NOT NULL,
	"source_artifact_id" uuid,
	"source_artifact_revision" integer,
	"source_sha256" varchar(64) NOT NULL,
	"source_authority_digest" varchar(64) NOT NULL,
	"destination_artifact_id" uuid,
	"destination_artifact_revision" integer,
	"destination_namespace_id" uuid NOT NULL,
	"destination_path_digest" varchar(64) NOT NULL,
	"destination_authority_digest" varchar(64) NOT NULL,
	"input_format" varchar(32) NOT NULL,
	"output_format" varchar(32) NOT NULL,
	"provider_tag" varchar(64) NOT NULL,
	"provider_job_id" text,
	"status" varchar(32) DEFAULT 'prepared' NOT NULL,
	"provider_credits" numeric(20, 8),
	"output_sha256" varchar(64),
	"output_bytes" bigint,
	"publication_revision_id" uuid,
	"publication_artifact_id" text,
	"failure_code" text,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"submitted_at" timestamp with time zone,
	"terminal_at" timestamp with time zone,
	"published_at" timestamp with time zone,
	CONSTRAINT "conversion_operations_operation_key_digest" CHECK ("conversion_operations"."operation_key" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "conversion_operations_recovery_handle_shape" CHECK ("conversion_operations"."recovery_handle" ~ '^cvr_[0-9a-f]{32}$'),
	CONSTRAINT "conversion_operations_credential_fingerprint_digest" CHECK ("conversion_operations"."credential_fingerprint" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "conversion_operations_source_sha_digest" CHECK ("conversion_operations"."source_sha256" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "conversion_operations_source_authority_digest" CHECK ("conversion_operations"."source_authority_digest" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "conversion_operations_destination_path_digest" CHECK ("conversion_operations"."destination_path_digest" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "conversion_operations_destination_authority_digest" CHECK ("conversion_operations"."destination_authority_digest" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "conversion_operations_output_sha_digest" CHECK ("conversion_operations"."output_sha256" IS NULL OR "conversion_operations"."output_sha256" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "conversion_operations_version_positive" CHECK ("conversion_operations"."version" > 0),
	CONSTRAINT "conversion_operations_output_bytes_nonnegative" CHECK ("conversion_operations"."output_bytes" IS NULL OR "conversion_operations"."output_bytes" >= 0),
	CONSTRAINT "conversion_operations_provider_credits_nonnegative" CHECK ("conversion_operations"."provider_credits" IS NULL OR "conversion_operations"."provider_credits" >= 0),
	CONSTRAINT "conversion_operations_funding_binding" CHECK ((
        ("conversion_operations"."funding_kind" = 'personal' AND "conversion_operations"."credential_id" IS NOT NULL AND "conversion_operations"."credential_revision" >= 1)
        OR ("conversion_operations"."funding_kind" = 'server' AND "conversion_operations"."credential_id" IS NULL AND "conversion_operations"."credential_revision" IS NULL)
      )),
	CONSTRAINT "conversion_operations_source_binding" CHECK ((
        ("conversion_operations"."source_kind" = 'inline' AND "conversion_operations"."source_artifact_id" IS NULL AND "conversion_operations"."source_artifact_revision" IS NULL)
        OR ("conversion_operations"."source_kind" = 'artifact' AND "conversion_operations"."source_artifact_id" IS NOT NULL AND "conversion_operations"."source_artifact_revision" >= 1)
      )),
	CONSTRAINT "conversion_operations_provider_job_phase" CHECK ((
        ("conversion_operations"."status" IN ('prepared', 'submitting', 'submission_unknown', 'recovery_ambiguous') AND "conversion_operations"."provider_job_id" IS NULL)
        OR ("conversion_operations"."status" NOT IN ('prepared', 'submitting', 'submission_unknown', 'recovery_ambiguous') AND "conversion_operations"."provider_job_id" IS NOT NULL)
      )),
	CONSTRAINT "conversion_operations_publication_receipt" CHECK ((
        ("conversion_operations"."status" = 'published' AND "conversion_operations"."publication_revision_id" IS NOT NULL AND "conversion_operations"."publication_artifact_id" IS NOT NULL AND "conversion_operations"."published_at" IS NOT NULL)
        OR ("conversion_operations"."status" <> 'published' AND "conversion_operations"."publication_revision_id" IS NULL AND "conversion_operations"."publication_artifact_id" IS NULL AND "conversion_operations"."published_at" IS NULL)
      ))
);
--> statement-breakpoint
ALTER TABLE "connected_web_accounts" ADD COLUMN "profile_funding_binding" jsonb;--> statement-breakpoint
ALTER TABLE "connected_web_action_operations" ADD COLUMN "funding_binding" jsonb;--> statement-breakpoint
ALTER TABLE "connected_web_operations" ADD COLUMN "funding_binding" jsonb;--> statement-breakpoint
ALTER TABLE "conversion_operations" ADD CONSTRAINT "conversion_operations_causal_human_user_id_users_id_fk" FOREIGN KEY ("causal_human_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversion_operations" ADD CONSTRAINT "conversion_operations_room_id_rooms_id_fk" FOREIGN KEY ("room_id") REFERENCES "public"."rooms"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversion_operations" ADD CONSTRAINT "conversion_operations_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversion_operations" ADD CONSTRAINT "conversion_operations_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversion_operations" ADD CONSTRAINT "conversion_operations_run_id_task_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."task_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversion_operations" ADD CONSTRAINT "conversion_operations_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_conversion_operations_operation_key" ON "conversion_operations" USING btree ("operation_key");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_conversion_operations_recovery_handle" ON "conversion_operations" USING btree ("recovery_handle");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_conversion_operations_provider_tag" ON "conversion_operations" USING btree ("provider_tag");--> statement-breakpoint
CREATE INDEX "idx_conversion_operations_provider_job" ON "conversion_operations" USING btree ("provider_job_id");--> statement-breakpoint
CREATE INDEX "idx_conversion_operations_recovery" ON "conversion_operations" USING btree ("status","updated_at");--> statement-breakpoint
CREATE INDEX "idx_conversion_operations_human" ON "conversion_operations" USING btree ("causal_human_user_id","created_at");