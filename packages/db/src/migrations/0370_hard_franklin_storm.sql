ALTER TABLE "tasks" ADD COLUMN "pause_request_id" uuid;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "pause_requested_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "pause_reason" text;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_protected_pause_intent_coherent" CHECK ((
      "tasks"."pause_request_id" is null and "tasks"."pause_requested_at" is null and "tasks"."pause_reason" is null
    ) or (
      "tasks"."content_representation" in ('dual', 'protected')
      and "tasks"."pause_request_id" is not null and "tasks"."pause_requested_at" is not null
      and "tasks"."pause_reason" in ('manual_pause', 'time_limit')
    ));