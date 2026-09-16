CREATE TABLE "tasks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"requestor_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"prompt" text NOT NULL,
	"expected_output" text,
	"preset" text DEFAULT 'task' NOT NULL,
	"schedule_kind" text DEFAULT 'now' NOT NULL,
	"run_at" timestamp with time zone,
	"cron" text,
	"timezone" text DEFAULT 'UTC' NOT NULL,
	"catchup" text DEFAULT 'run_once' NOT NULL,
	"calling_room_id" uuid,
	"target_chat" text DEFAULT 'orphan' NOT NULL,
	"target_chat_handle" text,
	"target_room_id" uuid,
	"result_delivery" text DEFAULT 'wake' NOT NULL,
	"target_user_ids" uuid[] DEFAULT '{}' NOT NULL,
	"use_scope" boolean DEFAULT false NOT NULL,
	"scope_id" uuid,
	"tools_mode" text DEFAULT 'auto' NOT NULL,
	"tools_whitelist" text[] DEFAULT '{}' NOT NULL,
	"await_response" boolean DEFAULT false NOT NULL,
	"privacy_mode" boolean DEFAULT false NOT NULL,
	"time_limit_seconds" integer,
	"parent_task_id" uuid,
	"depth" integer DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"next_fire_at" timestamp with time zone,
	"last_fired_at" timestamp with time zone,
	"fire_lock_id" uuid,
	"fire_locked_at" timestamp with time zone,
	"last_error" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"cancelled_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "task_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"task_id" uuid NOT NULL,
	"job_id" uuid,
	"graph_thread_id" text NOT NULL,
	"status" text DEFAULT 'running' NOT NULL,
	"model_id" text,
	"privacy_warning" text,
	"result_text" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	"last_error" text
);
--> statement-breakpoint
ALTER TABLE "session_messages" ADD COLUMN "metadata" jsonb;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_requestor_id_users_id_fk" FOREIGN KEY ("requestor_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_calling_room_id_rooms_id_fk" FOREIGN KEY ("calling_room_id") REFERENCES "public"."rooms"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_target_room_id_rooms_id_fk" FOREIGN KEY ("target_room_id") REFERENCES "public"."rooms"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_scope_id_agent_scopes_id_fk" FOREIGN KEY ("scope_id") REFERENCES "public"."agent_scopes"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_runs" ADD CONSTRAINT "task_runs_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_runs" ADD CONSTRAINT "task_runs_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "tasks_due_idx" ON "tasks" USING btree ("status","next_fire_at");--> statement-breakpoint
CREATE INDEX "tasks_owner_idx" ON "tasks" USING btree ("owner_id","status");--> statement-breakpoint
CREATE INDEX "tasks_calling_room_idx" ON "tasks" USING btree ("calling_room_id");--> statement-breakpoint
CREATE INDEX "task_runs_task_idx" ON "task_runs" USING btree ("task_id","started_at");--> statement-breakpoint
-- M141 hand-augmentation (drizzle-kit cannot emit these):
--   1. tasks.parent_task_id self-FK (no .references() in schema to avoid a
--      definition-ordering issue; added by hand here). ON DELETE SET NULL so
--      deleting a parent task nulls the child's parent_task_id.
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_parent_task_id_fkey" FOREIGN KEY ("parent_task_id") REFERENCES "public"."tasks"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
--   2. rooms.kind CHECK widen to admit 'task' (rooms.kind is a plain text
--      column whose allowed values are enforced by the hand-maintained
--      rooms_kind_check; Drizzle's text({enum}) is TS-only. Mirror 0064.)
ALTER TABLE "rooms" DROP CONSTRAINT IF EXISTS "rooms_kind_check";--> statement-breakpoint
ALTER TABLE "rooms" ADD CONSTRAINT "rooms_kind_check" CHECK ("rooms"."kind" IN ('private','group','multi_agent','subthread','open','task'));