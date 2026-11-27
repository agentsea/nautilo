ALTER TABLE "room_journal_model_recoveries" ADD COLUMN "source_changed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "room_journal_model_recoveries" ADD COLUMN "replacement_input_digest" text;--> statement-breakpoint
ALTER TABLE "room_journal_model_recoveries" ADD COLUMN "authorized_input_digest" text;--> statement-breakpoint
ALTER TABLE "room_journal_model_recoveries" ADD CONSTRAINT "room_journal_model_recovery_source_change" CHECK (("room_journal_model_recoveries"."source_changed_at" IS NULL) = ("room_journal_model_recoveries"."replacement_input_digest" IS NULL)
        AND ("room_journal_model_recoveries"."replacement_input_digest" IS NULL OR (
          "room_journal_model_recoveries"."work_kind" = 'compaction' AND "room_journal_model_recoveries"."spent_at" IS NULL
          AND "room_journal_model_recoveries"."replacement_input_digest" ~ '^[0-9a-f]{64}$'
        ))
        AND ("room_journal_model_recoveries"."authorized_input_digest" IS NULL OR (
          "room_journal_model_recoveries"."work_kind" = 'compaction' AND "room_journal_model_recoveries"."authorized_input_digest" ~ '^[0-9a-f]{64}$'
        )));