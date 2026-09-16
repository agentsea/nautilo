DROP INDEX "uq_room_journal_batches_range";--> statement-breakpoint
ALTER TABLE "room_journal_batches" ADD COLUMN "lane" text DEFAULT 'live' NOT NULL;--> statement-breakpoint
ALTER TABLE "server_model_config" ADD COLUMN "stenographer_model" text;--> statement-breakpoint
ALTER TABLE "server_context_config" ADD COLUMN "stenographer_prior_conversation_limit" integer DEFAULT 10 NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_room_journal_batches_range" ON "room_journal_batches" USING btree ("room_id","from_message_id_exclusive","through_message_id_inclusive","extractor_version","lane");--> statement-breakpoint
ALTER TABLE "room_journal_batches" ADD CONSTRAINT "room_journal_batches_lane" CHECK ("room_journal_batches"."lane" IN ('live', 'historical'));--> statement-breakpoint
ALTER TABLE "server_context_config" ADD CONSTRAINT "server_context_config_stenographer_prior_conversation_limit_range" CHECK ("server_context_config"."stenographer_prior_conversation_limit" BETWEEN 0 AND 50);