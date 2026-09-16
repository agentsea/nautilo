ALTER TABLE "tasks" ADD COLUMN "selection_profile" text DEFAULT 'balanced' NOT NULL;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "selection_spec" jsonb;--> statement-breakpoint
ALTER TABLE "tasks" DROP COLUMN "privacy_mode";--> statement-breakpoint
ALTER TABLE "task_runs" DROP COLUMN "privacy_warning";