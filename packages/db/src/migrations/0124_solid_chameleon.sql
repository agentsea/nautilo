ALTER TABLE "session_messages" ADD COLUMN "edited_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "session_messages" ADD COLUMN "edit_revision" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "room_journal_state" ADD COLUMN "rebuild_generation" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "room_journal_state" ADD COLUMN "rebuild_requested_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "room_journal_state" ADD COLUMN "rebuild_target_message_id" integer;--> statement-breakpoint
ALTER TABLE "session_messages" ADD CONSTRAINT "session_messages_edit_revision_nonnegative" CHECK ("session_messages"."edit_revision" >= 0);--> statement-breakpoint
ALTER TABLE "room_journal_state" ADD CONSTRAINT "room_journal_state_rebuild_generation_nonnegative" CHECK ("room_journal_state"."rebuild_generation" >= 0);--> statement-breakpoint
ALTER TABLE "room_journal_state" ADD CONSTRAINT "room_journal_state_rebuild_target_nonnegative" CHECK ("room_journal_state"."rebuild_target_message_id" IS NULL OR "room_journal_state"."rebuild_target_message_id" >= 0);