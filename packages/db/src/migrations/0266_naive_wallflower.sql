ALTER TABLE "session_message_crypto_revisions" ADD COLUMN "repair_source_revision" integer;--> statement-breakpoint
ALTER TABLE "session_message_crypto_revisions" ADD COLUMN "repair_source_digest" "bytea";--> statement-breakpoint
ALTER TABLE "session_message_crypto_revisions" ADD CONSTRAINT "session_message_crypto_revisions_repair_source_coherent" CHECK (
        ("session_message_crypto_revisions"."repair_source_revision" is null and "session_message_crypto_revisions"."repair_source_digest" is null)
        or ("session_message_crypto_revisions"."repair_source_revision" >= 0 and octet_length("session_message_crypto_revisions"."repair_source_digest") = 32
          and "session_message_crypto_revisions"."author_role" = 'tool' and "session_message_crypto_revisions"."repair_identity_digest" is not null)
      );