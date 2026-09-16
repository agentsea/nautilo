ALTER TABLE "session_message_crypto_revisions" DROP CONSTRAINT "session_message_crypto_revisions_parity_author_coherent";--> statement-breakpoint
ALTER TABLE "session_message_crypto_revisions" ADD COLUMN "repair_identity_digest" "bytea";--> statement-breakpoint
ALTER TABLE "session_message_crypto_revisions" ADD COLUMN "repair_publisher_kind" text;--> statement-breakpoint
ALTER TABLE "session_message_crypto_revisions" ADD COLUMN "repair_publisher_id" text;--> statement-breakpoint
ALTER TABLE "session_message_crypto_revisions" ADD COLUMN "repair_attestation_digest" "bytea";--> statement-breakpoint
ALTER TABLE "session_message_crypto_revisions" ADD CONSTRAINT "session_message_crypto_revisions_repair_evidence_coherent" CHECK ((
          "session_message_crypto_revisions"."repair_identity_digest" is null
          and "session_message_crypto_revisions"."repair_publisher_kind" is null
          and "session_message_crypto_revisions"."repair_publisher_id" is null
          and "session_message_crypto_revisions"."repair_attestation_digest" is null
        ) or (
          octet_length("session_message_crypto_revisions"."repair_identity_digest") = 32
          and (
            ("session_message_crypto_revisions"."repair_publisher_kind" is null
              and "session_message_crypto_revisions"."repair_publisher_id" is null
              and "session_message_crypto_revisions"."repair_attestation_digest" is null
              and "session_message_crypto_revisions"."completion" = 'pending')
            or ("session_message_crypto_revisions"."repair_publisher_kind" in ('foreground_runtime', 'human_device')
              and octet_length("session_message_crypto_revisions"."repair_publisher_id") between 1 and 128
              and "session_message_crypto_revisions"."repair_publisher_id" ~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]*$'
              and octet_length("session_message_crypto_revisions"."repair_attestation_digest") = 32
              and "session_message_crypto_revisions"."completion" = 'complete')
          )
        ));--> statement-breakpoint
ALTER TABLE "session_message_crypto_revisions" ADD CONSTRAINT "session_message_crypto_revisions_parity_author_coherent" CHECK ("session_message_crypto_revisions"."parity_status" = 'pending'
          or (
            "session_message_crypto_revisions"."completion" = 'complete'
            and (
              (
                "session_message_crypto_revisions"."parity_status" = 'client_verified'
              )
              or (
                "session_message_crypto_revisions"."parity_status" = 'server_verified'
                and "session_message_crypto_revisions"."key_class" = 'ai'
                and (
                  "session_message_crypto_revisions"."author_role" <> 'user'
                  or "session_message_crypto_revisions"."repair_publisher_kind" = 'foreground_runtime'
                )
              )
            )
          ));--> statement-breakpoint
ALTER POLICY "session_message_crypto_revisions_agent_insert" ON "session_message_crypto_revisions" TO nautilo_agent WITH CHECK (app_current_user_id() is not null
    and exists (
      select 1
        from "sessions"
       where "sessions"."id" = "session_message_crypto_revisions"."session_id"
         and "sessions"."room_id" = "session_message_crypto_revisions"."room_id"
         and "sessions"."agent_id" = app_current_agent_id()
    )
    and app_agent_in_room("session_message_crypto_revisions"."room_id")
    and "session_message_crypto_revisions"."key_class" = 'ai'
    and (
      "session_message_crypto_revisions"."author_role" <> 'user'
      or "session_message_crypto_revisions"."repair_identity_digest" is not null
    )
    and "session_message_crypto_revisions"."parity_status" <> 'client_verified');--> statement-breakpoint
ALTER POLICY "session_message_crypto_revisions_agent_update" ON "session_message_crypto_revisions" TO nautilo_agent USING (app_current_user_id() is not null
    and exists (
      select 1
        from "sessions"
       where "sessions"."id" = "session_message_crypto_revisions"."session_id"
         and "sessions"."room_id" = "session_message_crypto_revisions"."room_id"
         and "sessions"."agent_id" = app_current_agent_id()
    )
    and app_agent_in_room("session_message_crypto_revisions"."room_id")
    and "session_message_crypto_revisions"."key_class" = 'ai'
    and (
      "session_message_crypto_revisions"."author_role" <> 'user'
      or "session_message_crypto_revisions"."repair_identity_digest" is not null
    )
    and "session_message_crypto_revisions"."parity_status" <> 'client_verified') WITH CHECK (app_current_user_id() is not null
    and exists (
      select 1
        from "sessions"
       where "sessions"."id" = "session_message_crypto_revisions"."session_id"
         and "sessions"."room_id" = "session_message_crypto_revisions"."room_id"
         and "sessions"."agent_id" = app_current_agent_id()
    )
    and app_agent_in_room("session_message_crypto_revisions"."room_id")
    and "session_message_crypto_revisions"."key_class" = 'ai'
    and (
      "session_message_crypto_revisions"."author_role" <> 'user'
      or "session_message_crypto_revisions"."repair_identity_digest" is not null
    )
    and "session_message_crypto_revisions"."parity_status" <> 'client_verified');--> statement-breakpoint
GRANT UPDATE (
  "repair_publisher_kind",
  "repair_publisher_id",
  "repair_attestation_digest"
) ON TABLE "session_message_crypto_revisions" TO "nautilo_agent";
