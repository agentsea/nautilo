ALTER TABLE "background_crypto_authorization_requests" ADD COLUMN "transform_commit_claim_id" text;--> statement-breakpoint
ALTER TABLE "background_crypto_authorization_requests" ADD COLUMN "transform_commit_descriptor_hash" "bytea";--> statement-breakpoint
ALTER TABLE "background_crypto_authorization_requests" ADD COLUMN "transform_commit_recipient_generation" bigint;--> statement-breakpoint
ALTER TABLE "background_crypto_authorization_requests" ADD COLUMN "transform_commit_output_count" smallint;--> statement-breakpoint
ALTER TABLE "background_crypto_authorization_requests" ADD COLUMN "transform_committed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "background_crypto_authorization_requests" ADD CONSTRAINT "background_crypto_authorization_requests_transform_commit_claim_id_portable" CHECK (octet_length("background_crypto_authorization_requests"."transform_commit_claim_id") between 1
      and 128
      and "background_crypto_authorization_requests"."transform_commit_claim_id" ~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]*$');--> statement-breakpoint
ALTER TABLE "background_crypto_authorization_requests" ADD CONSTRAINT "background_crypto_authorization_requests_transform_commit_coherent" CHECK ((
        "background_crypto_authorization_requests"."transform_commit_claim_id" is null
        and "background_crypto_authorization_requests"."transform_commit_descriptor_hash" is null
        and "background_crypto_authorization_requests"."transform_commit_recipient_generation" is null
        and "background_crypto_authorization_requests"."transform_commit_output_count" is null
        and "background_crypto_authorization_requests"."transform_committed_at" is null
      ) or (
        "background_crypto_authorization_requests"."transform_commit_claim_id" is not null
        and "background_crypto_authorization_requests"."transform_commit_descriptor_hash" is not null
        and octet_length("background_crypto_authorization_requests"."transform_commit_descriptor_hash")
          = 32
        and "background_crypto_authorization_requests"."transform_commit_recipient_generation"
          = "background_crypto_authorization_requests"."recipient_generation"
        and "background_crypto_authorization_requests"."transform_commit_descriptor_hash" = "background_crypto_authorization_requests"."descriptor_hash"
        and "background_crypto_authorization_requests"."transform_commit_output_count" between 0
          and 256
        and "background_crypto_authorization_requests"."transform_committed_at" is not null
        and "background_crypto_authorization_requests"."transform_committed_at" >= "background_crypto_authorization_requests"."accepted_at"
        and "background_crypto_authorization_requests"."transform_committed_at" < "background_crypto_authorization_requests"."authorization_expires_at"
        and "background_crypto_authorization_requests"."state" in (
          'running',
          'publication_reconciliation',
          'completed',
          'cancelled',
          'terminal_failure'
        )
        and (
          "background_crypto_authorization_requests"."state" <> 'running'
          or "background_crypto_authorization_requests"."transform_commit_claim_id" = "background_crypto_authorization_requests"."claim_id"
        )
      ));