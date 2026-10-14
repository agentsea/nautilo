ALTER TABLE "room_journal_state" ADD COLUMN "compaction_accepted_plan" jsonb;--> statement-breakpoint
ALTER TABLE "room_journal_state" ADD CONSTRAINT "room_journal_state_compaction_acceptance_coherent" CHECK (("room_journal_state"."compaction_accepted_model_binding" IS NULL)
        = ("room_journal_state"."compaction_accepted_plan" IS NULL));