CREATE TABLE "provider_cost_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"user_id" uuid,
	"room_id" uuid,
	"agent_id" uuid,
	"provider" text NOT NULL,
	"operation" text NOT NULL,
	"estimated_cost_usd" numeric(14, 8),
	"actual_cost_usd" numeric(14, 8),
	"evidence_state" text NOT NULL,
	"idempotency_key" varchar(64) NOT NULL,
	CONSTRAINT "provider_cost_events_evidence_check" CHECK ((
        ("provider_cost_events"."evidence_state" = 'actual' AND "provider_cost_events"."actual_cost_usd" IS NOT NULL)
        OR ("provider_cost_events"."evidence_state" = 'estimated' AND "provider_cost_events"."actual_cost_usd" IS NULL AND "provider_cost_events"."estimated_cost_usd" IS NOT NULL)
        OR ("provider_cost_events"."evidence_state" = 'unknown' AND "provider_cost_events"."actual_cost_usd" IS NULL AND "provider_cost_events"."estimated_cost_usd" IS NULL)
      )),
	CONSTRAINT "provider_cost_events_nonnegative_check" CHECK (COALESCE("provider_cost_events"."estimated_cost_usd", 0) >= 0 AND COALESCE("provider_cost_events"."actual_cost_usd", 0) >= 0),
	CONSTRAINT "provider_cost_events_idempotency_digest_check" CHECK ("provider_cost_events"."idempotency_key" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
ALTER TABLE "provider_cost_events" ADD CONSTRAINT "provider_cost_events_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_cost_events" ADD CONSTRAINT "provider_cost_events_room_id_rooms_id_fk" FOREIGN KEY ("room_id") REFERENCES "public"."rooms"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_cost_events" ADD CONSTRAINT "provider_cost_events_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_provider_cost_events_idempotency_key" ON "provider_cost_events" USING btree ("idempotency_key");--> statement-breakpoint
CREATE INDEX "idx_provider_cost_events_occurred_at" ON "provider_cost_events" USING btree ("occurred_at");--> statement-breakpoint
CREATE INDEX "idx_provider_cost_events_user_id" ON "provider_cost_events" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_provider_cost_events_provider_operation" ON "provider_cost_events" USING btree ("provider","operation");