ALTER TABLE "background_crypto_authorization_requests" DROP CONSTRAINT "background_crypto_authorization_requests_format_version";--> statement-breakpoint
ALTER TABLE "background_crypto_authorization_requests" DROP CONSTRAINT "background_crypto_authorization_requests_work_purpose_coherent";--> statement-breakpoint
ALTER TABLE "background_crypto_authorization_requests" DROP CONSTRAINT "background_crypto_authorization_requests_subject_coherent";--> statement-breakpoint
ALTER TABLE "background_crypto_authorization_requests" DROP CONSTRAINT "background_crypto_authorization_requests_domain_epoch_coherent";--> statement-breakpoint
ALTER TABLE "processor_crypto_signer_authorizations" DROP CONSTRAINT "processor_crypto_signer_authorizations_format_version";--> statement-breakpoint
ALTER TABLE "processor_crypto_signer_authorizations" DROP CONSTRAINT "processor_crypto_signer_authorizations_legacy_authority_coherent";--> statement-breakpoint
ALTER TABLE "processor_crypto_signer_authorizations" DROP CONSTRAINT "processor_crypto_signer_authorizations_authorization_size";--> statement-breakpoint
ALTER TABLE "background_crypto_authorization_requests" ADD CONSTRAINT "background_crypto_authorization_requests_format_version" CHECK ("background_crypto_authorization_requests"."format_version" = 1 or (
        "background_crypto_authorization_requests"."format_version" = 2
        and "background_crypto_authorization_requests"."credential_subject_kind" in ('agent', 'processor')
      ) or (
        "background_crypto_authorization_requests"."format_version" in (2, 3)
        and "background_crypto_authorization_requests"."credential_subject_kind" = 'processor'
      ));--> statement-breakpoint
ALTER TABLE "background_crypto_authorization_requests" ADD CONSTRAINT "background_crypto_authorization_requests_work_purpose_coherent" CHECK ((
        "background_crypto_authorization_requests"."work_kind" in (
          'stenographer.extraction',
          'stenographer.historical'
        ) and "background_crypto_authorization_requests"."purpose" = 'journal.extract'
      ) or (
        "background_crypto_authorization_requests"."work_kind" = 'stenographer.compaction'
        and "background_crypto_authorization_requests"."purpose" = 'journal.compact'
      ) or (
        "background_crypto_authorization_requests"."work_kind" = 'stenographer.rebuild'
        and "background_crypto_authorization_requests"."purpose" = 'journal.rebuild'
      ) or (
        "background_crypto_authorization_requests"."work_kind" = 'stenographer.publication_reconcile'
        and "background_crypto_authorization_requests"."format_version" in (2, 3)
        and "background_crypto_authorization_requests"."purpose" = 'journal.reconcile'
      ) or (
        "background_crypto_authorization_requests"."work_kind" = 'stenographer.output_repair'
        and "background_crypto_authorization_requests"."format_version" in (2, 3)
        and "background_crypto_authorization_requests"."purpose" = 'journal.repair'
      ) or "background_crypto_authorization_requests"."work_kind" = "background_crypto_authorization_requests"."purpose");--> statement-breakpoint
ALTER TABLE "background_crypto_authorization_requests" ADD CONSTRAINT "background_crypto_authorization_requests_subject_coherent" CHECK ((
        "background_crypto_authorization_requests"."credential_subject_kind" = 'processor'
        and "background_crypto_authorization_requests"."processor_kind" = 'stenographer'
        and "background_crypto_authorization_requests"."processor_version" = 1
        and (
          ("background_crypto_authorization_requests"."format_version" = 1
            and "background_crypto_authorization_requests"."processor_authorization_revision" is not null)
          or ("background_crypto_authorization_requests"."format_version" in (2, 3)
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
ALTER TABLE "background_crypto_authorization_requests" ADD CONSTRAINT "background_crypto_authorization_requests_domain_epoch_coherent" CHECK ((
        ("background_crypto_authorization_requests"."format_version" = 1 or ("background_crypto_authorization_requests"."format_version" = 2 and "background_crypto_authorization_requests"."credential_subject_kind" = 'agent'))
        and "background_crypto_authorization_requests"."expected_domain_epoch" is not null
      ) or (
        "background_crypto_authorization_requests"."format_version" in (2, 3)
        and "background_crypto_authorization_requests"."credential_subject_kind" = 'processor'
        and "background_crypto_authorization_requests"."expected_domain_epoch" is null
      ));--> statement-breakpoint
ALTER TABLE "processor_crypto_signer_authorizations" ADD CONSTRAINT "processor_crypto_signer_authorizations_format_version" CHECK ("processor_crypto_signer_authorizations"."format_version" in (1, 2, 3));--> statement-breakpoint
ALTER TABLE "processor_crypto_signer_authorizations" ADD CONSTRAINT "processor_crypto_signer_authorizations_legacy_authority_coherent" CHECK ((
        "processor_crypto_signer_authorizations"."format_version" = 1
        and "processor_crypto_signer_authorizations"."domain_epoch" is not null
        and "processor_crypto_signer_authorizations"."processor_authorization_revision" is not null
      ) or (
        "processor_crypto_signer_authorizations"."format_version" in (2, 3)
        and "processor_crypto_signer_authorizations"."domain_epoch" is null
        and "processor_crypto_signer_authorizations"."processor_authorization_revision" is null
      ));--> statement-breakpoint
ALTER TABLE "processor_crypto_signer_authorizations" ADD CONSTRAINT "processor_crypto_signer_authorizations_authorization_size" CHECK (octet_length("processor_crypto_signer_authorizations"."authorization_bytes") between 1
      and 131072);