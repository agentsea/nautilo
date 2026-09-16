ALTER TABLE "session_message_crypto_revisions" ADD COLUMN "subthread_reply_classification" text DEFAULT 'excluded' NOT NULL;--> statement-breakpoint
ALTER TABLE "session_message_crypto_revisions" ADD CONSTRAINT "session_message_crypto_revisions_subthread_reply_classification" CHECK ("session_message_crypto_revisions"."subthread_reply_classification" in ('counted', 'excluded'));--> statement-breakpoint
ALTER POLICY "session_message_crypto_revisions_agent_select" ON "session_message_crypto_revisions" TO nautilo_agent USING (app_current_user_id() is not null
    and exists (
      select 1
        from "sessions"
       where "sessions"."id" = "session_message_crypto_revisions"."session_id"
         and "sessions"."room_id" = "session_message_crypto_revisions"."room_id"
         and "sessions"."agent_id" = app_current_agent_id()
    )
    and app_agent_in_room("session_message_crypto_revisions"."room_id"));--> statement-breakpoint
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
    and "session_message_crypto_revisions"."author_role" <> 'user'
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
    and "session_message_crypto_revisions"."author_role" <> 'user'
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
    and "session_message_crypto_revisions"."author_role" <> 'user'
    and "session_message_crypto_revisions"."parity_status" <> 'client_verified');
--> statement-breakpoint
-- M237_MESSAGE_STRUCTURAL_PROJECTION_AUTHORITY
CREATE OR REPLACE FUNCTION "public"."reject_session_message_crypto_revision_identity_update"()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog
AS $$
BEGIN
  IF OLD.disposition IN ('superseded', 'hard_delete')
     AND NEW IS DISTINCT FROM OLD THEN
    RAISE EXCEPTION 'terminal session message crypto revision is immutable'
      USING ERRCODE = '23514';
  END IF;
  IF ROW(
    NEW.sequence,
    NEW.session_id,
    NEW.message_id,
    NEW.edit_revision,
    NEW.room_id,
    NEW.namespace_id_at_allocation,
    NEW.crypto_object_id,
    NEW.payload_version,
    NEW.key_class,
    NEW.author_role,
    NEW.subthread_reply_classification,
    NEW.append_idempotency_key,
    NEW.allocation_request_digest,
    NEW.created_at
  ) IS DISTINCT FROM ROW(
    OLD.sequence,
    OLD.session_id,
    OLD.message_id,
    OLD.edit_revision,
    OLD.room_id,
    OLD.namespace_id_at_allocation,
    OLD.crypto_object_id,
    OLD.payload_version,
    OLD.key_class,
    OLD.author_role,
    OLD.subthread_reply_classification,
    OLD.append_idempotency_key,
    OLD.allocation_request_digest,
    OLD.created_at
  ) THEN
    RAISE EXCEPTION 'session message crypto revision identity is immutable'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION "public"."reject_session_message_crypto_revision_identity_update"()
  FROM PUBLIC, "nautilo_agent", "nautilo_crypto";
