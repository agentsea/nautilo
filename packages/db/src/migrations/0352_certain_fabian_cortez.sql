ALTER TABLE "llm_usage_events" ADD COLUMN "attempt_owner_token" uuid;--> statement-breakpoint
ALTER TABLE "llm_usage_events" ADD COLUMN "attempt_lease_expires_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "idx_llm_usage_personal_attempt_lease" ON "llm_usage_events" USING btree ("attempt_lease_expires_at","id") WHERE "llm_usage_events"."attempt_owner_token" IS NOT NULL AND "llm_usage_events"."attempt_outcome" = 'in_progress';--> statement-breakpoint
ALTER TABLE "llm_usage_events" ADD CONSTRAINT "llm_usage_events_attempt_owner_check" CHECK ((
        ("llm_usage_events"."attempt_owner_token" IS NULL AND "llm_usage_events"."attempt_lease_expires_at" IS NULL)
        OR
        ("llm_usage_events"."attempt_owner_token" IS NOT NULL AND "llm_usage_events"."attempt_lease_expires_at" IS NOT NULL
          AND "llm_usage_events"."funding_kind" = 'personal' AND "llm_usage_events"."provider_route" <> 'surplus'
          AND "llm_usage_events"."attempt_outcome" IS NOT NULL AND "llm_usage_events"."cost_state" IS NOT NULL)
      ));