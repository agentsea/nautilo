CREATE TABLE "server_maintenance" (
	"singleton_key" text PRIMARY KEY DEFAULT 'upgrade' NOT NULL,
	"state" varchar(16) DEFAULT 'normal' NOT NULL,
	"operation_id" uuid,
	"lease_expires_at" timestamp with time zone,
	"hard_expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "server_maintenance_state_check" CHECK ("server_maintenance"."state" IN ('normal', 'draining', 'applying'))
);
--> statement-breakpoint
CREATE TABLE "work_acceptances" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" varchar(32) NOT NULL,
	"status" varchar(32) DEFAULT 'accepted' NOT NULL,
	"job_id" uuid,
	"accepted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"dispatched_at" timestamp with time zone,
	"cancelled_at" timestamp with time zone,
	"cancellation_reason" text,
	CONSTRAINT "work_acceptances_kind_check" CHECK ("work_acceptances"."kind" IN ('foreground', 'system_report_back')),
	CONSTRAINT "work_acceptances_status_check" CHECK ("work_acceptances"."status" IN ('accepted', 'dispatched', 'maintenance_cancelled'))
);
--> statement-breakpoint
ALTER TABLE "work_acceptances" ADD CONSTRAINT "work_acceptances_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_work_acceptances_status" ON "work_acceptances" USING btree ("status");--> statement-breakpoint
CREATE INDEX "idx_work_acceptances_job" ON "work_acceptances" USING btree ("job_id");