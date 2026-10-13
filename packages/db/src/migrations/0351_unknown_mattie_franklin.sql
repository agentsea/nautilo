ALTER TABLE "session_message_crypto_revisions" DROP CONSTRAINT "session_message_crypto_revisions_object_id_scheme";--> statement-breakpoint
ALTER TABLE "session_message_crypto_revisions" ADD COLUMN "task_wake_operation_id" text;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_session_message_crypto_revisions_task_wake_ordinal" ON "session_message_crypto_revisions" USING btree ("task_wake_operation_id","shadow_transcript_ordinal") WHERE "session_message_crypto_revisions"."task_wake_operation_id" is not null;--> statement-breakpoint
ALTER TABLE "session_message_crypto_revisions" ADD CONSTRAINT "session_message_crypto_revisions_task_wake_shape" CHECK ("session_message_crypto_revisions"."task_wake_operation_id" is null or (
          "session_message_crypto_revisions"."object_id_scheme" = 'live_shadow_v1'
          and "session_message_crypto_revisions"."key_class" = 'ai'
          and "session_message_crypto_revisions"."author_role" in ('assistant', 'tool')
          and "session_message_crypto_revisions"."edit_revision" = 0
          and "session_message_crypto_revisions"."shadow_transcript_ordinal" is not null
          and "session_message_crypto_revisions"."shadow_transcript_ordinal" >= 2
          and "session_message_crypto_revisions"."task_wake_operation_id" ~ '^task-run-delivery-wake:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
        ));--> statement-breakpoint
ALTER TABLE "session_message_crypto_revisions" ADD CONSTRAINT "session_message_crypto_revisions_object_id_scheme" CHECK ((
          "session_message_crypto_revisions"."object_id_scheme" = 'message_v2'
          and "session_message_crypto_revisions"."shadow_operation_id" is null
          and "session_message_crypto_revisions"."human_peer_shadow_operation_id" is null
          and "session_message_crypto_revisions"."shared_agent_shadow_operation_id" is null
          and "session_message_crypto_revisions"."shared_agent_shadow_execution_id" is null
          and "session_message_crypto_revisions"."task_wake_operation_id" is null
          and "session_message_crypto_revisions"."shadow_transcript_ordinal" is null
          and "session_message_crypto_revisions"."shadow_reserved_created_at" is null
          and "session_message_crypto_revisions"."shadow_stream_id" is null
          and "session_message_crypto_revisions"."shadow_stream_start_digest" is null
          and "session_message_crypto_revisions"."shadow_stream_terminal_digest" is null
          and "session_message_crypto_revisions"."shadow_streamed_text_digest" is null
          and "session_message_crypto_revisions"."shadow_durable_event_digest" is null
        ) or (
          "session_message_crypto_revisions"."object_id_scheme" = 'human_message_edit_v1'
          and "session_message_crypto_revisions"."task_wake_operation_id" is null
          and "session_message_crypto_revisions"."author_role" = 'user'
          and "session_message_crypto_revisions"."edit_revision" > 0
          and "session_message_crypto_revisions"."crypto_object_id" ~ '^message-edit:v1:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}:[0-9a-f]{64}$'
          and (
            ("session_message_crypto_revisions"."shadow_operation_id" is not null
              and "session_message_crypto_revisions"."human_peer_shadow_operation_id" is null
              and "session_message_crypto_revisions"."shared_agent_shadow_operation_id" is null
              and "session_message_crypto_revisions"."shared_agent_shadow_execution_id" is null)
            or ("session_message_crypto_revisions"."shadow_operation_id" is null
              and "session_message_crypto_revisions"."human_peer_shadow_operation_id" is not null
              and "session_message_crypto_revisions"."shared_agent_shadow_operation_id" is null
              and "session_message_crypto_revisions"."shared_agent_shadow_execution_id" is null)
            or ("session_message_crypto_revisions"."shadow_operation_id" is null
              and "session_message_crypto_revisions"."human_peer_shadow_operation_id" is null
              and "session_message_crypto_revisions"."shared_agent_shadow_operation_id" is not null
              and "session_message_crypto_revisions"."shared_agent_shadow_execution_id" is null)
          )
        ) or (
          "session_message_crypto_revisions"."object_id_scheme" = 'live_shadow_v1'
          and (
            ("session_message_crypto_revisions"."task_wake_operation_id" is null
              and "session_message_crypto_revisions"."shadow_operation_id" is not null
              and "session_message_crypto_revisions"."human_peer_shadow_operation_id" is null
              and "session_message_crypto_revisions"."shared_agent_shadow_operation_id" is null
              and "session_message_crypto_revisions"."shared_agent_shadow_execution_id" is null)
            or ("session_message_crypto_revisions"."task_wake_operation_id" is null
              and "session_message_crypto_revisions"."shadow_operation_id" is null
              and "session_message_crypto_revisions"."human_peer_shadow_operation_id" is not null
              and "session_message_crypto_revisions"."shared_agent_shadow_operation_id" is null
              and "session_message_crypto_revisions"."shared_agent_shadow_execution_id" is null)
            or ("session_message_crypto_revisions"."task_wake_operation_id" is null
              and "session_message_crypto_revisions"."shadow_operation_id" is null
              and "session_message_crypto_revisions"."human_peer_shadow_operation_id" is null
              and "session_message_crypto_revisions"."shared_agent_shadow_operation_id" is not null
              and "session_message_crypto_revisions"."shared_agent_shadow_execution_id" is null)
            or ("session_message_crypto_revisions"."task_wake_operation_id" is null
              and "session_message_crypto_revisions"."shadow_operation_id" is null
              and "session_message_crypto_revisions"."human_peer_shadow_operation_id" is null
              and "session_message_crypto_revisions"."shared_agent_shadow_operation_id" is null
              and "session_message_crypto_revisions"."shared_agent_shadow_execution_id" is not null)
            or ("session_message_crypto_revisions"."task_wake_operation_id" is not null
              and "session_message_crypto_revisions"."shadow_operation_id" is null
              and "session_message_crypto_revisions"."human_peer_shadow_operation_id" is null
              and "session_message_crypto_revisions"."shared_agent_shadow_operation_id" is null
              and "session_message_crypto_revisions"."shared_agent_shadow_execution_id" is null)
          )
          and "session_message_crypto_revisions"."shadow_transcript_ordinal" > 0
          and "session_message_crypto_revisions"."shadow_reserved_created_at" is not null
        ));
--> statement-breakpoint
-- TASK_WAKE_TRANSCRIPT_IDENTITY
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
    NEW.sequence, NEW.session_id, NEW.message_id, NEW.edit_revision,
    NEW.room_id, NEW.namespace_id_at_allocation, NEW.crypto_object_id,
    NEW.object_id_scheme, NEW.shadow_operation_id,
    NEW.human_peer_shadow_operation_id,
    NEW.shared_agent_shadow_operation_id,
    NEW.shared_agent_shadow_execution_id, NEW.task_wake_operation_id, NEW.shadow_transcript_ordinal,
    NEW.shadow_reserved_created_at, NEW.payload_version, NEW.key_class,
    NEW.author_role, NEW.subthread_reply_classification,
    NEW.append_idempotency_key, NEW.allocation_request_digest, NEW.created_at
  ) IS DISTINCT FROM ROW(
    OLD.sequence, OLD.session_id, OLD.message_id, OLD.edit_revision,
    OLD.room_id, OLD.namespace_id_at_allocation, OLD.crypto_object_id,
    OLD.object_id_scheme, OLD.shadow_operation_id,
    OLD.human_peer_shadow_operation_id,
    OLD.shared_agent_shadow_operation_id,
    OLD.shared_agent_shadow_execution_id, OLD.task_wake_operation_id, OLD.shadow_transcript_ordinal,
    OLD.shadow_reserved_created_at, OLD.payload_version, OLD.key_class,
    OLD.author_role, OLD.subthread_reply_classification,
    OLD.append_idempotency_key, OLD.allocation_request_digest, OLD.created_at
  ) THEN
    RAISE EXCEPTION 'session message crypto revision identity is immutable'
      USING ERRCODE = '23514';
  END IF;
  IF (OLD.shadow_stream_id IS NOT NULL
        AND NEW.shadow_stream_id IS DISTINCT FROM OLD.shadow_stream_id)
    OR (OLD.shadow_stream_start_digest IS NOT NULL
        AND NEW.shadow_stream_start_digest IS DISTINCT FROM OLD.shadow_stream_start_digest)
    OR (OLD.shadow_stream_terminal_digest IS NOT NULL
        AND NEW.shadow_stream_terminal_digest IS DISTINCT FROM OLD.shadow_stream_terminal_digest)
    OR (OLD.shadow_streamed_text_digest IS NOT NULL
        AND NEW.shadow_streamed_text_digest IS DISTINCT FROM OLD.shadow_streamed_text_digest)
    OR (OLD.shadow_durable_event_digest IS NOT NULL
        AND NEW.shadow_durable_event_digest IS DISTINCT FROM OLD.shadow_durable_event_digest)
  THEN
    RAISE EXCEPTION 'session message live Shadow evidence is immutable after publication'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION "public"."reject_session_message_crypto_revision_identity_update"()
  FROM PUBLIC, "nautilo_agent", "nautilo_crypto";
