ALTER TABLE "tasks" ADD COLUMN "funding_mode" text DEFAULT 'legacy_server' NOT NULL;--> statement-breakpoint
ALTER TABLE "task_runs" ADD COLUMN "funding_binding" jsonb;