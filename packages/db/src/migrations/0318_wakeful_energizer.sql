ALTER TABLE "llm_usage_events" DROP CONSTRAINT "llm_usage_events_attempt_state_check";--> statement-breakpoint
ALTER TABLE "personal_provider_credentials" DROP CONSTRAINT "personal_provider_credentials_provider_check";--> statement-breakpoint
DROP INDEX "uq_llm_usage_provider_request";--> statement-breakpoint
ALTER TABLE "llm_usage_events" ADD COLUMN "recovery_state" varchar(24);--> statement-breakpoint
ALTER TABLE "provider_cost_events" ADD COLUMN "funding_kind" varchar(16);--> statement-breakpoint
ALTER TABLE "provider_cost_events" ADD COLUMN "payer_human_id" uuid;--> statement-breakpoint
ALTER TABLE "provider_cost_events" ADD COLUMN "provider_route" text;--> statement-breakpoint
ALTER TABLE "provider_cost_events" ADD COLUMN "credential_id" uuid;--> statement-breakpoint
ALTER TABLE "provider_cost_events" ADD COLUMN "credential_revision" integer;--> statement-breakpoint
ALTER TABLE "personal_provider_credentials" ADD COLUMN "destination" text;--> statement-breakpoint
ALTER TABLE "personal_provider_credentials" ADD COLUMN "receipt_read_status" varchar(16) DEFAULT 'unknown' NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_llm_usage_nonpersonal_provider_request" ON "llm_usage_events" USING btree ("provider_route","provider_request_id") WHERE "llm_usage_events"."provider_request_id" IS NOT NULL AND "llm_usage_events"."funding_kind" IS DISTINCT FROM 'personal';--> statement-breakpoint
CREATE UNIQUE INDEX "uq_llm_usage_personal_provider_request" ON "llm_usage_events" USING btree ("payer_human_id","provider_route","provider_request_id") WHERE "llm_usage_events"."provider_request_id" IS NOT NULL AND "llm_usage_events"."funding_kind" = 'personal';--> statement-breakpoint
CREATE INDEX "idx_provider_cost_events_payer_human_id" ON "provider_cost_events" USING btree ("payer_human_id");--> statement-breakpoint
ALTER TABLE "llm_usage_events" ADD CONSTRAINT "llm_usage_events_recovery_state_check" CHECK ((
        "llm_usage_events"."recovery_state" IS NULL
        OR ("llm_usage_events"."provider_route" = 'surplus' AND "llm_usage_events"."cost_state" IN ('pending', 'unknown'))
      ));--> statement-breakpoint
ALTER TABLE "llm_usage_events" ADD CONSTRAINT "llm_usage_events_attempt_state_check" CHECK ((
        ("llm_usage_events"."attempt_outcome" IS NULL AND "llm_usage_events"."cost_state" IS NULL AND "llm_usage_events"."recovery_state" IS NULL)
        OR
        ("llm_usage_events"."attempt_outcome" IS NOT NULL AND "llm_usage_events"."cost_state" IS NOT NULL AND "llm_usage_events"."endpoint" IS NOT NULL AND length("llm_usage_events"."endpoint") > 0
          AND ("llm_usage_events"."provider_route" = 'surplus' OR ("llm_usage_events"."funding_kind" = 'personal' AND "llm_usage_events"."recovery_state" IS NULL)))
      ));--> statement-breakpoint
ALTER TABLE "provider_cost_events" ADD CONSTRAINT "provider_cost_events_funding_provenance_check" CHECK ((
        ("provider_cost_events"."funding_kind" IS NULL AND "provider_cost_events"."payer_human_id" IS NULL AND "provider_cost_events"."provider_route" IS NULL AND "provider_cost_events"."credential_id" IS NULL AND "provider_cost_events"."credential_revision" IS NULL)
        OR ("provider_cost_events"."funding_kind" = 'personal' AND "provider_cost_events"."payer_human_id" IS NOT NULL AND "provider_cost_events"."provider_route" IS NOT NULL AND length("provider_cost_events"."provider_route") > 0 AND "provider_cost_events"."credential_id" IS NOT NULL AND "provider_cost_events"."credential_revision" IS NOT NULL AND "provider_cost_events"."credential_revision" >= 1)
        OR ("provider_cost_events"."funding_kind" IN ('server', 'service') AND "provider_cost_events"."payer_human_id" IS NULL AND "provider_cost_events"."provider_route" IS NOT NULL AND length("provider_cost_events"."provider_route") > 0 AND "provider_cost_events"."credential_id" IS NULL AND "provider_cost_events"."credential_revision" IS NULL)
      ));--> statement-breakpoint
ALTER TABLE "personal_provider_credentials" ADD CONSTRAINT "personal_provider_credentials_destination_check" CHECK ("personal_provider_credentials"."destination" is null or "personal_provider_credentials"."provider" = 'gateway');--> statement-breakpoint
ALTER TABLE "personal_provider_credentials" ADD CONSTRAINT "personal_provider_credentials_receipt_read_status_check" CHECK ("personal_provider_credentials"."receipt_read_status" in ('available', 'unavailable', 'unknown'));--> statement-breakpoint
ALTER TABLE "personal_provider_credentials" ADD CONSTRAINT "personal_provider_credentials_receipt_read_provider_check" CHECK ("personal_provider_credentials"."receipt_read_status" = 'unknown' or "personal_provider_credentials"."provider" = 'surplus');--> statement-breakpoint
ALTER TABLE "personal_provider_credentials" ADD CONSTRAINT "personal_provider_credentials_provider_check" CHECK ("personal_provider_credentials"."provider" in ('typesafe', 'anthropic', 'openai', 'openrouter', 'nautilo-gateway', 'gateway', 'google', 'xai', 'fireworks', 'together', 'venice', 'elevenlabs', 'groq', 'tavily', 'browser-use', 'cloudconvert', 'surplus'));