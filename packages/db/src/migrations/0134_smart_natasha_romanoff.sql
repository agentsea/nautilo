ALTER TABLE "session_message_crypto_revisions" DROP CONSTRAINT "session_message_crypto_revisions_terminal_operation_coherent";--> statement-breakpoint
ALTER TABLE "session_message_crypto_revisions" ADD COLUMN "terminal_operation_group_id" text;--> statement-breakpoint
ALTER TABLE "session_message_crypto_revisions" ADD COLUMN "quarantine_lease_token" uuid;--> statement-breakpoint
ALTER TABLE "session_message_crypto_revisions" ADD CONSTRAINT "session_message_crypto_revisions_quarantine_receipt_coherent" CHECK ("session_message_crypto_revisions"."quarantine_lease_token" is null
          or (
            "session_message_crypto_revisions"."disposition" = 'quarantined'
            and "session_message_crypto_revisions"."lease_token" is null
            and "session_message_crypto_revisions"."lease_expires_at" is null
          ));--> statement-breakpoint
ALTER TABLE "session_message_crypto_revisions" ADD CONSTRAINT "session_message_crypto_revisions_delete_root_time_coherent" CHECK ("session_message_crypto_revisions"."delete_root_reply_count" is null
          or (
            "session_message_crypto_revisions"."delete_root_reply_count" = 0
            and "session_message_crypto_revisions"."delete_root_last_reply_at" is null
          )
          or (
            "session_message_crypto_revisions"."delete_root_reply_count" > 0
            and "session_message_crypto_revisions"."delete_root_last_reply_at" is not null
          ));--> statement-breakpoint
ALTER TABLE "session_message_crypto_revisions" ADD CONSTRAINT "session_message_crypto_revisions_operation_group_id_portable" CHECK ("session_message_crypto_revisions"."terminal_operation_group_id" is null or (
      octet_length("session_message_crypto_revisions"."terminal_operation_group_id") between 1 and 128
      and "session_message_crypto_revisions"."terminal_operation_group_id" ~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]*$'
    ));--> statement-breakpoint
ALTER TABLE "session_message_crypto_revisions" ADD CONSTRAINT "session_message_crypto_revisions_terminal_operation_coherent" CHECK ((
          "session_message_crypto_revisions"."disposition" = 'superseded'
          and "session_message_crypto_revisions"."terminal_operation_id" is not null
          and "session_message_crypto_revisions"."terminal_operation_group_id" is not null
          and "session_message_crypto_revisions"."terminal_operation_type" = 'edit'
          and "session_message_crypto_revisions"."terminal_expected_revision" = "session_message_crypto_revisions"."edit_revision"
          and "session_message_crypto_revisions"."terminal_request_digest" is not null
        ) or (
          "session_message_crypto_revisions"."disposition" = 'hard_delete'
          and "session_message_crypto_revisions"."terminal_operation_id" is not null
          and "session_message_crypto_revisions"."terminal_operation_group_id" is null
          and "session_message_crypto_revisions"."terminal_operation_type" = 'delete'
          and "session_message_crypto_revisions"."terminal_expected_revision" = "session_message_crypto_revisions"."edit_revision"
          and "session_message_crypto_revisions"."terminal_request_digest" is not null
        ) or (
          "session_message_crypto_revisions"."disposition" not in ('superseded', 'hard_delete')
          and "session_message_crypto_revisions"."terminal_operation_id" is null
          and "session_message_crypto_revisions"."terminal_operation_group_id" is null
          and "session_message_crypto_revisions"."terminal_operation_type" is null
          and "session_message_crypto_revisions"."terminal_expected_revision" is null
          and "session_message_crypto_revisions"."terminal_request_digest" is null
        ));--> statement-breakpoint
ALTER POLICY "session_message_crypto_revisions_agent_select" ON "session_message_crypto_revisions" TO nautilo_agent USING (app_current_user_id() is not null
    and exists (
      select 1
        from "sessions"
       where "sessions"."id" = "session_message_crypto_revisions"."session_id"
         and "sessions"."room_id" = "session_message_crypto_revisions"."room_id"
    )
    and app_agent_in_room("session_message_crypto_revisions"."room_id"));--> statement-breakpoint
ALTER POLICY "session_message_crypto_revisions_agent_insert" ON "session_message_crypto_revisions" TO nautilo_agent WITH CHECK (app_current_user_id() is not null
    and exists (
      select 1
        from "sessions"
       where "sessions"."id" = "session_message_crypto_revisions"."session_id"
         and "sessions"."room_id" = "session_message_crypto_revisions"."room_id"
    )
    and app_agent_in_room("session_message_crypto_revisions"."room_id")
    and "session_message_crypto_revisions"."key_class" = 'ai'
    and "session_message_crypto_revisions"."author_role" <> 'user'
    and "session_message_crypto_revisions"."parity_status" <> 'client_verified');--> statement-breakpoint
ALTER POLICY "session_message_crypto_revisions_agent_update" ON "session_message_crypto_revisions" TO nautilo_agent USING (app_current_user_id() is not null
    and exists (
      select 1
        from "sessions"
       where "sessions"."id" = "session_message_crypto_revisions"."session_id"
         and "sessions"."room_id" = "session_message_crypto_revisions"."room_id"
    )
    and app_agent_in_room("session_message_crypto_revisions"."room_id")
    and "session_message_crypto_revisions"."key_class" = 'ai'
    and "session_message_crypto_revisions"."author_role" <> 'user'
    and "session_message_crypto_revisions"."parity_status" <> 'client_verified') WITH CHECK (app_current_user_id() is not null
    and exists (
      select 1
        from "sessions"
       where "sessions"."id" = "session_message_crypto_revisions"."session_id"
         and "sessions"."room_id" = "session_message_crypto_revisions"."room_id"
    )
    and app_agent_in_room("session_message_crypto_revisions"."room_id")
    and "session_message_crypto_revisions"."key_class" = 'ai'
    and "session_message_crypto_revisions"."author_role" <> 'user'
    and "session_message_crypto_revisions"."parity_status" <> 'client_verified');
--> statement-breakpoint
-- M237_MESSAGE_GROUP_RECEIPTS_AUTHORITY
GRANT UPDATE (
  "terminal_operation_group_id",
  "quarantine_lease_token"
) ON TABLE "session_message_crypto_revisions"
  TO "nautilo_agent";
