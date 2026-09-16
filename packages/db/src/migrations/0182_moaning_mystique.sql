ALTER TABLE "session_message_crypto_revisions" DROP CONSTRAINT "session_message_crypto_revisions_parity_author_coherent";--> statement-breakpoint
ALTER TABLE "session_message_crypto_revisions" ADD CONSTRAINT "session_message_crypto_revisions_parity_author_coherent" CHECK ("session_message_crypto_revisions"."parity_status" = 'pending'
          or (
            "session_message_crypto_revisions"."completion" = 'complete'
            and (
              (
                "session_message_crypto_revisions"."parity_status" = 'client_verified'
              )
              or (
                "session_message_crypto_revisions"."parity_status" = 'server_verified'
                and "session_message_crypto_revisions"."author_role" <> 'user'
                and "session_message_crypto_revisions"."key_class" = 'ai'
              )
            )
          ));