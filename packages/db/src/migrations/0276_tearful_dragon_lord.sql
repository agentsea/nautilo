ALTER TABLE "background_crypto_authorization_requests" DROP CONSTRAINT "background_crypto_authorization_requests_format_version";--> statement-breakpoint
ALTER TABLE "background_crypto_authorization_requests" DROP CONSTRAINT "background_crypto_authorization_requests_subject_coherent";--> statement-breakpoint
ALTER TABLE "background_crypto_authorization_requests" ALTER COLUMN "expected_domain_epoch" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "processor_crypto_signer_authorizations" ALTER COLUMN "domain_epoch" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "processor_crypto_signer_authorizations" ALTER COLUMN "processor_authorization_revision" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "processor_crypto_signer_authorizations" ADD COLUMN "format_version" smallint DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "background_crypto_authorization_requests" ADD CONSTRAINT "background_crypto_authorization_requests_domain_epoch_coherent" CHECK ((
        "background_crypto_authorization_requests"."format_version" in (1, 2)
        and "background_crypto_authorization_requests"."expected_domain_epoch" is not null
      ) or (
        "background_crypto_authorization_requests"."format_version" = 3
        and "background_crypto_authorization_requests"."expected_domain_epoch" is null
      ));--> statement-breakpoint
ALTER TABLE "background_crypto_authorization_requests" ADD CONSTRAINT "background_crypto_authorization_requests_format_version" CHECK ("background_crypto_authorization_requests"."format_version" = 1 or (
        "background_crypto_authorization_requests"."format_version" = 2
        and "background_crypto_authorization_requests"."credential_subject_kind" = 'agent'
      ) or (
        "background_crypto_authorization_requests"."format_version" = 3
        and "background_crypto_authorization_requests"."credential_subject_kind" = 'processor'
      ));--> statement-breakpoint
ALTER TABLE "background_crypto_authorization_requests" ADD CONSTRAINT "background_crypto_authorization_requests_subject_coherent" CHECK ((
        "background_crypto_authorization_requests"."credential_subject_kind" = 'processor'
        and "background_crypto_authorization_requests"."processor_kind" = 'stenographer'
        and "background_crypto_authorization_requests"."processor_version" = 1
        and (
          ("background_crypto_authorization_requests"."format_version" = 1
            and "background_crypto_authorization_requests"."processor_authorization_revision" is not null)
          or ("background_crypto_authorization_requests"."format_version" = 3
            and "background_crypto_authorization_requests"."processor_authorization_revision" is null)
        )
        and "background_crypto_authorization_requests"."agent_id" is null
        and "background_crypto_authorization_requests"."agent_runtime_generation" is null
        and "background_crypto_authorization_requests"."agent_authorization_revision" is null
      ) or (
        "background_crypto_authorization_requests"."credential_subject_kind" = 'agent'
        and "background_crypto_authorization_requests"."processor_kind" is null
        and "background_crypto_authorization_requests"."processor_version" is null
        and "background_crypto_authorization_requests"."processor_authorization_revision" is null
        and "background_crypto_authorization_requests"."agent_id" is not null
        and "background_crypto_authorization_requests"."agent_runtime_generation" is not null
        and "background_crypto_authorization_requests"."agent_authorization_revision" is not null
      ));--> statement-breakpoint
ALTER TABLE "processor_crypto_signer_authorizations" ADD CONSTRAINT "processor_crypto_signer_authorizations_format_version" CHECK ("processor_crypto_signer_authorizations"."format_version" in (1, 3));--> statement-breakpoint
ALTER TABLE "processor_crypto_signer_authorizations" ADD CONSTRAINT "processor_crypto_signer_authorizations_legacy_authority_coherent" CHECK ((
        "processor_crypto_signer_authorizations"."format_version" = 1
        and "processor_crypto_signer_authorizations"."domain_epoch" is not null
        and "processor_crypto_signer_authorizations"."processor_authorization_revision" is not null
      ) or (
        "processor_crypto_signer_authorizations"."format_version" = 3
        and "processor_crypto_signer_authorizations"."domain_epoch" is null
        and "processor_crypto_signer_authorizations"."processor_authorization_revision" is null
      ));