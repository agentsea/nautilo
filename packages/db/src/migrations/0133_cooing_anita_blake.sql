ALTER TABLE "session_message_crypto_revisions" ADD COLUMN "delete_was_unread" boolean;--> statement-breakpoint
ALTER TABLE "session_message_crypto_revisions" ADD COLUMN "delete_orphaned_turn_id" text;--> statement-breakpoint
ALTER TABLE "session_message_crypto_revisions" ADD COLUMN "delete_root_parent_room_id" uuid;--> statement-breakpoint
ALTER TABLE "session_message_crypto_revisions" ADD COLUMN "delete_root_anchor_message_id" integer;--> statement-breakpoint
ALTER TABLE "session_message_crypto_revisions" ADD COLUMN "delete_root_reply_count" integer;--> statement-breakpoint
ALTER TABLE "session_message_crypto_revisions" ADD COLUMN "delete_root_last_reply_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "session_message_crypto_revisions" ADD COLUMN "delete_root_summary_revision" integer;--> statement-breakpoint
ALTER TABLE "session_message_crypto_revisions" ADD CONSTRAINT "session_message_crypto_revisions_delete_effects_coherent" CHECK ((
          "session_message_crypto_revisions"."disposition" = 'hard_delete'
          and "session_message_crypto_revisions"."delete_was_unread" is not null
        ) or (
          "session_message_crypto_revisions"."disposition" <> 'hard_delete'
          and "session_message_crypto_revisions"."delete_was_unread" is null
          and "session_message_crypto_revisions"."delete_orphaned_turn_id" is null
          and "session_message_crypto_revisions"."delete_root_parent_room_id" is null
          and "session_message_crypto_revisions"."delete_root_anchor_message_id" is null
          and "session_message_crypto_revisions"."delete_root_reply_count" is null
          and "session_message_crypto_revisions"."delete_root_last_reply_at" is null
          and "session_message_crypto_revisions"."delete_root_summary_revision" is null
        ));--> statement-breakpoint
ALTER TABLE "session_message_crypto_revisions" ADD CONSTRAINT "session_message_crypto_revisions_delete_root_summary_coherent" CHECK ((
          "session_message_crypto_revisions"."delete_root_parent_room_id" is null
          and "session_message_crypto_revisions"."delete_root_anchor_message_id" is null
          and "session_message_crypto_revisions"."delete_root_reply_count" is null
          and "session_message_crypto_revisions"."delete_root_last_reply_at" is null
          and "session_message_crypto_revisions"."delete_root_summary_revision" is null
        ) or (
          "session_message_crypto_revisions"."delete_root_parent_room_id" is not null
          and "session_message_crypto_revisions"."delete_root_anchor_message_id" is not null
          and "session_message_crypto_revisions"."delete_root_reply_count" is not null
          and "session_message_crypto_revisions"."delete_root_summary_revision" is not null
        ));--> statement-breakpoint
ALTER TABLE "session_message_crypto_revisions" ADD CONSTRAINT "session_message_crypto_revisions_delete_root_anchor_positive" CHECK ("session_message_crypto_revisions"."delete_root_anchor_message_id" is null
          or "session_message_crypto_revisions"."delete_root_anchor_message_id" > 0);--> statement-breakpoint
ALTER TABLE "session_message_crypto_revisions" ADD CONSTRAINT "session_message_crypto_revisions_delete_root_reply_count_nonnegative" CHECK ("session_message_crypto_revisions"."delete_root_reply_count" is null
          or "session_message_crypto_revisions"."delete_root_reply_count" >= 0);--> statement-breakpoint
ALTER TABLE "session_message_crypto_revisions" ADD CONSTRAINT "session_message_crypto_revisions_delete_root_revision_nonnegative" CHECK ("session_message_crypto_revisions"."delete_root_summary_revision" is null
          or "session_message_crypto_revisions"."delete_root_summary_revision" >= 0);--> statement-breakpoint
ALTER TABLE "session_message_crypto_revisions" ADD CONSTRAINT "session_message_crypto_revisions_delete_orphaned_turn_id_portable" CHECK ("session_message_crypto_revisions"."delete_orphaned_turn_id" is null or (
      octet_length("session_message_crypto_revisions"."delete_orphaned_turn_id") between 1 and 128
      and "session_message_crypto_revisions"."delete_orphaned_turn_id" ~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]*$'
    ));
--> statement-breakpoint
-- M237_MESSAGE_DELETE_EFFECTS_AUTHORITY
GRANT UPDATE (
  "delete_was_unread",
  "delete_orphaned_turn_id",
  "delete_root_parent_room_id",
  "delete_root_anchor_message_id",
  "delete_root_reply_count",
  "delete_root_last_reply_at",
  "delete_root_summary_revision"
) ON TABLE "session_message_crypto_revisions"
  TO "nautilo_agent";
