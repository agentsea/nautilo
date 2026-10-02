ALTER TABLE "llm_usage_events" ADD COLUMN "task_id" uuid;--> statement-breakpoint
ALTER TABLE "llm_usage_events" ADD COLUMN "provider_request_id" text;--> statement-breakpoint
ALTER TABLE "llm_usage_events" ADD COLUMN "endpoint" text;--> statement-breakpoint
ALTER TABLE "llm_usage_events" ADD COLUMN "serving_provider" text;--> statement-breakpoint
ALTER TABLE "llm_usage_events" ADD COLUMN "attempt_outcome" varchar(16);--> statement-breakpoint
ALTER TABLE "llm_usage_events" ADD COLUMN "cost_state" varchar(16);--> statement-breakpoint
ALTER TABLE "llm_usage_events" ADD COLUMN "failure_code" text;--> statement-breakpoint
ALTER TABLE "llm_usage_events" ADD COLUMN "settled_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "llm_usage_events" ADD COLUMN "updated_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "server_model_config" ADD COLUMN "prefer_surplus" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "llm_usage_events" ADD CONSTRAINT "llm_usage_events_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_llm_usage_task_id" ON "llm_usage_events" USING btree ("task_id");--> statement-breakpoint
CREATE INDEX "idx_llm_usage_surplus_pending" ON "llm_usage_events" USING btree ("provider_route","cost_state","updated_at");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_llm_usage_provider_request" ON "llm_usage_events" USING btree ("provider_route","provider_request_id") WHERE "llm_usage_events"."provider_request_id" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "llm_usage_events" ADD CONSTRAINT "llm_usage_events_attempt_state_check" CHECK ((
        ("llm_usage_events"."attempt_outcome" IS NULL AND "llm_usage_events"."cost_state" IS NULL)
        OR
        ("llm_usage_events"."provider_route" = 'surplus' AND "llm_usage_events"."attempt_outcome" IS NOT NULL AND "llm_usage_events"."cost_state" IS NOT NULL AND "llm_usage_events"."endpoint" IS NOT NULL AND length("llm_usage_events"."endpoint") > 0)
      ));--> statement-breakpoint
ALTER TABLE "llm_usage_events" ADD CONSTRAINT "llm_usage_events_cost_state_check" CHECK ((
        "llm_usage_events"."cost_state" IS NULL
        OR ("llm_usage_events"."cost_state" = 'actual' AND "llm_usage_events"."actual_cost_usd" IS NOT NULL)
        OR ("llm_usage_events"."cost_state" = 'estimated' AND "llm_usage_events"."actual_cost_usd" IS NULL)
        OR ("llm_usage_events"."cost_state" IN ('pending', 'unknown') AND "llm_usage_events"."actual_cost_usd" IS NULL)
      ));