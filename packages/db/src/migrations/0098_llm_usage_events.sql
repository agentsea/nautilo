CREATE TABLE "llm_usage_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"user_id" uuid,
	"room_id" uuid,
	"call_type" text DEFAULT 'chat' NOT NULL,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"input_tokens" integer DEFAULT 0 NOT NULL,
	"output_tokens" integer DEFAULT 0 NOT NULL,
	"reasoning_tokens" integer DEFAULT 0 NOT NULL,
	"cached_input_tokens" integer DEFAULT 0 NOT NULL,
	"total_tokens" integer DEFAULT 0 NOT NULL,
	"estimated_cost_usd" numeric(14, 8) DEFAULT '0' NOT NULL,
	"actual_cost_usd" numeric(14, 8),
	"pricing_version" text,
	"metadata" jsonb
);
--> statement-breakpoint
ALTER TABLE "llm_usage_events" ADD CONSTRAINT "llm_usage_events_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "llm_usage_events" ADD CONSTRAINT "llm_usage_events_room_id_rooms_id_fk" FOREIGN KEY ("room_id") REFERENCES "public"."rooms"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_llm_usage_occurred_at" ON "llm_usage_events" USING btree ("occurred_at");--> statement-breakpoint
CREATE INDEX "idx_llm_usage_user_id" ON "llm_usage_events" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_llm_usage_model" ON "llm_usage_events" USING btree ("model");--> statement-breakpoint
CREATE INDEX "idx_llm_usage_call_type" ON "llm_usage_events" USING btree ("call_type");--> statement-breakpoint
CREATE INDEX "idx_llm_usage_provider" ON "llm_usage_events" USING btree ("provider");