ALTER TABLE "provider_cost_events" DROP CONSTRAINT "provider_cost_events_nonnegative_check";--> statement-breakpoint
ALTER TABLE "provider_cost_events" ADD COLUMN "task_id" uuid;--> statement-breakpoint
ALTER TABLE "provider_cost_events" ADD COLUMN "run_id" uuid;--> statement-breakpoint
ALTER TABLE "provider_cost_events" ADD COLUMN "job_id" uuid;--> statement-breakpoint
ALTER TABLE "provider_cost_events" ADD COLUMN "workload" text;--> statement-breakpoint
ALTER TABLE "provider_cost_events" ADD COLUMN "attempt_outcome" varchar(16);--> statement-breakpoint
ALTER TABLE "provider_cost_events" ADD COLUMN "failure_code" text;--> statement-breakpoint
ALTER TABLE "provider_cost_events" ADD COLUMN "pricing_version" text;--> statement-breakpoint
ALTER TABLE "provider_cost_events" ADD COLUMN "measured_units" numeric(20, 8);--> statement-breakpoint
ALTER TABLE "provider_cost_events" ADD COLUMN "unit_type" text;--> statement-breakpoint
ALTER TABLE "provider_cost_events" ADD CONSTRAINT "provider_cost_events_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_cost_events" ADD CONSTRAINT "provider_cost_events_run_id_task_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."task_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_cost_events" ADD CONSTRAINT "provider_cost_events_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_provider_cost_events_task_id" ON "provider_cost_events" USING btree ("task_id");--> statement-breakpoint
CREATE INDEX "idx_provider_cost_events_run_id" ON "provider_cost_events" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "idx_provider_cost_events_job_id" ON "provider_cost_events" USING btree ("job_id");--> statement-breakpoint
ALTER TABLE "provider_cost_events" ADD CONSTRAINT "provider_cost_events_nonnegative_check" CHECK (COALESCE("provider_cost_events"."estimated_cost_usd", 0) >= 0 AND COALESCE("provider_cost_events"."actual_cost_usd", 0) >= 0 AND COALESCE("provider_cost_events"."measured_units", 0) >= 0);