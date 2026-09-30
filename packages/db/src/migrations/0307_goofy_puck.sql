ALTER TABLE "llm_usage_events" ADD COLUMN "funding_kind" varchar(16);--> statement-breakpoint
ALTER TABLE "llm_usage_events" ADD COLUMN "payer_human_id" uuid;--> statement-breakpoint
ALTER TABLE "llm_usage_events" ADD COLUMN "provider_route" text;--> statement-breakpoint
ALTER TABLE "llm_usage_events" ADD COLUMN "credential_id" uuid;--> statement-breakpoint
ALTER TABLE "llm_usage_events" ADD COLUMN "credential_revision" integer;--> statement-breakpoint
CREATE INDEX "idx_llm_usage_funding_kind" ON "llm_usage_events" USING btree ("funding_kind");--> statement-breakpoint
CREATE INDEX "idx_llm_usage_payer_human_id" ON "llm_usage_events" USING btree ("payer_human_id");--> statement-breakpoint
ALTER TABLE "llm_usage_events" ADD CONSTRAINT "llm_usage_events_funding_provenance_check" CHECK ((
        ("llm_usage_events"."funding_kind" IS NULL AND "llm_usage_events"."payer_human_id" IS NULL AND "llm_usage_events"."provider_route" IS NULL AND "llm_usage_events"."credential_id" IS NULL AND "llm_usage_events"."credential_revision" IS NULL)
        OR
        ("llm_usage_events"."funding_kind" IS NOT NULL AND (
          ("llm_usage_events"."funding_kind" = 'personal' AND "llm_usage_events"."payer_human_id" IS NOT NULL AND "llm_usage_events"."provider_route" IS NOT NULL AND length("llm_usage_events"."provider_route") > 0 AND "llm_usage_events"."credential_id" IS NOT NULL AND "llm_usage_events"."credential_revision" IS NOT NULL AND "llm_usage_events"."credential_revision" >= 1)
          OR
          ("llm_usage_events"."funding_kind" IN ('server', 'service') AND "llm_usage_events"."payer_human_id" IS NULL AND "llm_usage_events"."provider_route" IS NOT NULL AND length("llm_usage_events"."provider_route") > 0 AND "llm_usage_events"."credential_id" IS NULL AND "llm_usage_events"."credential_revision" IS NULL)
        ))
      ));