ALTER TABLE "llm_usage_events" DROP CONSTRAINT "llm_usage_events_attempt_state_check";--> statement-breakpoint
ALTER TABLE "llm_usage_events" DROP CONSTRAINT "llm_usage_events_attempt_owner_check";--> statement-breakpoint
ALTER TABLE "room_event_rollups" ADD COLUMN "model_exposure_dependencies" jsonb;--> statement-breakpoint
ALTER TABLE "memory_review_turns" ADD COLUMN "accepted_model_binding" jsonb;--> statement-breakpoint
ALTER TABLE "llm_usage_events" ADD CONSTRAINT "llm_usage_events_attempt_state_check" CHECK ((
        ("llm_usage_events"."attempt_outcome" IS NULL AND "llm_usage_events"."cost_state" IS NULL AND "llm_usage_events"."recovery_state" IS NULL)
        OR
        ("llm_usage_events"."attempt_outcome" IS NOT NULL AND "llm_usage_events"."cost_state" IS NOT NULL AND "llm_usage_events"."endpoint" IS NOT NULL AND length("llm_usage_events"."endpoint") > 0
          AND ("llm_usage_events"."provider_route" = 'surplus' OR ("llm_usage_events"."funding_kind" IN ('personal', 'server', 'service') AND "llm_usage_events"."recovery_state" IS NULL)))
      ));--> statement-breakpoint
ALTER TABLE "llm_usage_events" ADD CONSTRAINT "llm_usage_events_attempt_owner_check" CHECK ((
        ("llm_usage_events"."attempt_owner_token" IS NULL AND "llm_usage_events"."attempt_lease_expires_at" IS NULL)
        OR
        ("llm_usage_events"."attempt_owner_token" IS NOT NULL AND "llm_usage_events"."attempt_lease_expires_at" IS NOT NULL
          AND "llm_usage_events"."funding_kind" IN ('personal', 'server', 'service') AND "llm_usage_events"."provider_route" <> 'surplus'
          AND "llm_usage_events"."attempt_outcome" IS NOT NULL AND "llm_usage_events"."cost_state" IS NOT NULL)
      ));--> statement-breakpoint
ALTER TABLE "room_event_rollups" ADD CONSTRAINT "room_event_rollups_exposure_representation" CHECK ("room_event_rollups"."content" IS NOT NULL OR "room_event_rollups"."model_exposure_dependencies" IS NULL);