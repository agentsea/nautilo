ALTER TABLE "room_journal_state" DROP CONSTRAINT "room_journal_state_compaction_known_nonusable";--> statement-breakpoint
ALTER TABLE "room_journal_state" ADD CONSTRAINT "room_journal_state_compaction_known_nonusable" CHECK (NOT "room_journal_state"."compaction_last_attempt_known_nonusable" OR (
        "room_journal_state"."compaction_lease_token" IS NULL
        AND "room_journal_state"."compaction_lease_expires_at" IS NULL
        AND "room_journal_state"."last_compaction_error_code" IS NOT NULL
        AND "room_journal_state"."last_compaction_error_code" = 'invalid_output'
        AND "room_journal_state"."compaction_accepted_model_binding" IS NOT NULL
        AND "room_journal_state"."compaction_accepted_plan" IS NOT NULL
      ));