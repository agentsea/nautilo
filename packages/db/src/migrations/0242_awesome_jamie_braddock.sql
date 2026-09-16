ALTER TABLE "session_message_crypto_revisions" DROP CONSTRAINT "session_message_crypto_revisions_parity_status";--> statement-breakpoint
ALTER TABLE "session_message_crypto_revisions" DROP CONSTRAINT "session_message_crypto_revisions_parity_author_coherent";--> statement-breakpoint
ALTER TABLE "session_message_crypto_revisions" ADD CONSTRAINT "session_message_crypto_revisions_parity_status" CHECK ("session_message_crypto_revisions"."parity_status" in (
          'pending', 'server_verified', 'client_verified',
          'server_authenticated', 'client_authenticated'
        ));--> statement-breakpoint
ALTER TABLE "session_message_crypto_revisions" ADD CONSTRAINT "session_message_crypto_revisions_parity_author_coherent" CHECK ("session_message_crypto_revisions"."parity_status" = 'pending'
          or (
            "session_message_crypto_revisions"."completion" = 'complete'
            and (
              (
                "session_message_crypto_revisions"."parity_status" in ('client_verified', 'client_authenticated')
              )
              or (
                "session_message_crypto_revisions"."parity_status" in ('server_verified', 'server_authenticated')
                and "session_message_crypto_revisions"."key_class" = 'ai'
                and (
                  "session_message_crypto_revisions"."author_role" <> 'user'
                  or "session_message_crypto_revisions"."repair_publisher_kind" = 'foreground_runtime'
                )
              )
            )
          ));--> statement-breakpoint
ALTER POLICY "session_message_crypto_revisions_agent_insert" ON "session_message_crypto_revisions" TO nautilo_agent WITH CHECK (app_current_user_id() is not null
    and app_agent_in_room("session_message_crypto_revisions"."room_id")
    and exists (
      select 1
        from "sessions"
       where "sessions"."id" = "session_message_crypto_revisions"."session_id"
         and "sessions"."room_id" = "session_message_crypto_revisions"."room_id"
    )
    and "session_message_crypto_revisions"."key_class" = 'ai'
    and (
      (
        "session_message_crypto_revisions"."author_role" <> 'user'
        and exists (
          select 1
            from "sessions"
           where "sessions"."id" = "session_message_crypto_revisions"."session_id"
             and "sessions"."room_id" = "session_message_crypto_revisions"."room_id"
             and "sessions"."agent_id" = app_current_agent_id()
        )
      )
      or "session_message_crypto_revisions"."repair_identity_digest" is not null
    )
    and "session_message_crypto_revisions"."parity_status" not in ('client_verified', 'client_authenticated'));--> statement-breakpoint
ALTER POLICY "session_message_crypto_revisions_agent_update" ON "session_message_crypto_revisions" TO nautilo_agent USING (app_current_user_id() is not null
    and app_agent_in_room("session_message_crypto_revisions"."room_id")
    and exists (
      select 1
        from "sessions"
       where "sessions"."id" = "session_message_crypto_revisions"."session_id"
         and "sessions"."room_id" = "session_message_crypto_revisions"."room_id"
    )
    and "session_message_crypto_revisions"."key_class" = 'ai'
    and (
      (
        "session_message_crypto_revisions"."author_role" <> 'user'
        and exists (
          select 1
            from "sessions"
           where "sessions"."id" = "session_message_crypto_revisions"."session_id"
             and "sessions"."room_id" = "session_message_crypto_revisions"."room_id"
             and "sessions"."agent_id" = app_current_agent_id()
        )
      )
      or "session_message_crypto_revisions"."repair_identity_digest" is not null
    )
    and "session_message_crypto_revisions"."parity_status" not in ('client_verified', 'client_authenticated')) WITH CHECK (app_current_user_id() is not null
    and app_agent_in_room("session_message_crypto_revisions"."room_id")
    and exists (
      select 1
        from "sessions"
       where "sessions"."id" = "session_message_crypto_revisions"."session_id"
         and "sessions"."room_id" = "session_message_crypto_revisions"."room_id"
    )
    and "session_message_crypto_revisions"."key_class" = 'ai'
    and (
      (
        "session_message_crypto_revisions"."author_role" <> 'user'
        and exists (
          select 1
            from "sessions"
           where "sessions"."id" = "session_message_crypto_revisions"."session_id"
             and "sessions"."room_id" = "session_message_crypto_revisions"."room_id"
             and "sessions"."agent_id" = app_current_agent_id()
        )
      )
      or "session_message_crypto_revisions"."repair_identity_digest" is not null
    )
    and "session_message_crypto_revisions"."parity_status" not in ('client_verified', 'client_authenticated'));