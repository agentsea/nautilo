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
    and "session_message_crypto_revisions"."parity_status" <> 'client_verified');--> statement-breakpoint
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
    and "session_message_crypto_revisions"."parity_status" <> 'client_verified') WITH CHECK (app_current_user_id() is not null
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
    and "session_message_crypto_revisions"."parity_status" <> 'client_verified');