ALTER TABLE "session_message_crypto_revisions" DROP CONSTRAINT "session_message_crypto_revisions_ordinary_repair_shape";--> statement-breakpoint
ALTER TABLE "session_message_crypto_revisions" ADD CONSTRAINT "session_message_crypto_revisions_ordinary_repair_shape" CHECK ((
          "session_message_crypto_revisions"."ordinary_repair_identity_digest" is null
          and "session_message_crypto_revisions"."ordinary_repair_attestation_digest" is null
          and "session_message_crypto_revisions"."ordinary_repair_publisher_kind" is null
          and "session_message_crypto_revisions"."ordinary_repair_publisher_id" is null
          and "session_message_crypto_revisions"."ordinary_repair_policy_revision" is null
          and "session_message_crypto_revisions"."ordinary_repaired_at" is null
        ) or (
          "session_message_crypto_revisions"."ordinary_repair_identity_digest" is not null
          and octet_length("session_message_crypto_revisions"."ordinary_repair_identity_digest") = 32
          and "session_message_crypto_revisions"."ordinary_repair_attestation_digest" is not null
          and octet_length("session_message_crypto_revisions"."ordinary_repair_attestation_digest") = 32
          and "session_message_crypto_revisions"."ordinary_repair_publisher_kind" is not null
          and "session_message_crypto_revisions"."ordinary_repair_publisher_kind" in (
            'authenticated_runtime', 'device_attested'
          )
          and "session_message_crypto_revisions"."ordinary_repair_publisher_id" is not null
          and length("session_message_crypto_revisions"."ordinary_repair_publisher_id") between 1 and 255
          and "session_message_crypto_revisions"."ordinary_repair_policy_revision" is not null
          and "session_message_crypto_revisions"."ordinary_repair_policy_revision" > 0
          and "session_message_crypto_revisions"."ordinary_repaired_at" is not null
        ));