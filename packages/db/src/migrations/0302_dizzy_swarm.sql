ALTER TABLE "rooms" ADD COLUMN "deleted_thread_root_message_id" integer;--> statement-breakpoint
ALTER TABLE "rooms" ADD COLUMN "deleted_thread_reply_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "rooms" ADD COLUMN "deleted_thread_last_reply_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "rooms" ADD COLUMN "deleted_thread_summary_revision" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "rooms" ADD CONSTRAINT "rooms_thread_anchor_shape" CHECK (("rooms"."kind" = 'subthread') = ("rooms"."parent_room_id" IS NOT NULL AND ("rooms"."thread_root_message_id" IS NOT NULL OR "rooms"."deleted_thread_root_message_id" IS NOT NULL)) AND ("rooms"."deleted_thread_root_message_id" IS NULL OR ("rooms"."kind" = 'subthread' AND ("rooms"."thread_root_message_id" IS NULL OR "rooms"."thread_root_message_id" = "rooms"."deleted_thread_root_message_id"))));
--> statement-breakpoint
-- MODERATION_THREAD_ANCHOR
ALTER TABLE rooms DROP CONSTRAINT IF EXISTS rooms_subthread_invariant;
