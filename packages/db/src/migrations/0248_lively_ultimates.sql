ALTER TABLE "session_message_crypto_revisions" DROP CONSTRAINT "session_message_crypto_revisions_object_id_scheme";--> statement-breakpoint
ALTER TABLE "session_message_crypto_revisions" ADD CONSTRAINT "session_message_crypto_revisions_object_id_scheme" CHECK ((
          "session_message_crypto_revisions"."object_id_scheme" = 'message_v2'
          and "session_message_crypto_revisions"."shadow_operation_id" is null
          and "session_message_crypto_revisions"."human_peer_shadow_operation_id" is null
          and "session_message_crypto_revisions"."shared_agent_shadow_operation_id" is null
          and "session_message_crypto_revisions"."shared_agent_shadow_execution_id" is null
          and "session_message_crypto_revisions"."shadow_transcript_ordinal" is null
          and "session_message_crypto_revisions"."shadow_reserved_created_at" is null
          and "session_message_crypto_revisions"."shadow_stream_id" is null
          and "session_message_crypto_revisions"."shadow_stream_start_digest" is null
          and "session_message_crypto_revisions"."shadow_stream_terminal_digest" is null
          and "session_message_crypto_revisions"."shadow_streamed_text_digest" is null
          and "session_message_crypto_revisions"."shadow_durable_event_digest" is null
        ) or (
          "session_message_crypto_revisions"."object_id_scheme" = 'human_message_edit_v1'
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
            or ("session_message_crypto_revisions"."shadow_operation_id" is null
              and "session_message_crypto_revisions"."human_peer_shadow_operation_id" is null
              and "session_message_crypto_revisions"."shared_agent_shadow_operation_id" is null
              and "session_message_crypto_revisions"."shared_agent_shadow_execution_id" is not null)
          )
          and "session_message_crypto_revisions"."shadow_transcript_ordinal" > 0
          and "session_message_crypto_revisions"."shadow_reserved_created_at" is not null
        ));