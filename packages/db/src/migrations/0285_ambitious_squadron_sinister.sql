ALTER TABLE "background_crypto_authorization_requests" DROP CONSTRAINT "background_crypto_authorization_requests_work_kind";--> statement-breakpoint
ALTER TABLE "background_crypto_authorization_requests" DROP CONSTRAINT "background_crypto_authorization_requests_purpose";--> statement-breakpoint
ALTER TABLE "background_crypto_authorization_requests" DROP CONSTRAINT "background_crypto_authorization_requests_work_purpose_coherent";--> statement-breakpoint
ALTER TABLE "background_crypto_authorization_requests" DROP CONSTRAINT "background_crypto_authorization_requests_descriptor_coherent";--> statement-breakpoint
ALTER TABLE "background_crypto_authorization_requests" DROP CONSTRAINT "background_crypto_authorization_requests_response_coherent";--> statement-breakpoint
ALTER TABLE "processor_crypto_signer_authorizations" DROP CONSTRAINT "processor_crypto_signer_authorizations_descriptor_size";--> statement-breakpoint
ALTER TABLE "processor_crypto_signer_authorizations" DROP CONSTRAINT "processor_crypto_signer_authorizations_authorization_size";--> statement-breakpoint
ALTER TABLE "background_crypto_authorization_requests" ADD CONSTRAINT "background_crypto_authorization_requests_work_kind" CHECK ("background_crypto_authorization_requests"."work_kind" in (
        'stenographer.extraction',
        'stenographer.historical',
        'stenographer.compaction',
        'stenographer.rebuild',
        'stenographer.publication_reconcile',
        'stenographer.output_repair',
        'reflection.authority_reproject',
        'reflection.publication_reconcile',
        'reflection.search_projection',
        'reflection.organization',
        'reflection.dependency_rewrite',
        'memory.review',
        'memory.exit_flush',
        'task.dispatch',
        'task.execute',
        'task.approval_resume'
      ));--> statement-breakpoint
ALTER TABLE "background_crypto_authorization_requests" ADD CONSTRAINT "background_crypto_authorization_requests_purpose" CHECK ("background_crypto_authorization_requests"."purpose" in (
        'journal.extract',
        'journal.compact',
        'journal.rebuild',
        'journal.reconcile',
        'journal.repair',
        'record.reproject',
        'record.reconcile',
        'record.search_projection',
        'record.organize',
        'record.dependency_rewrite',
        'memory.review',
        'memory.exit_flush',
        'task.dispatch',
        'task.execute',
        'task.approval_resume'
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
      ) or (
        "background_crypto_authorization_requests"."work_kind" = 'reflection.authority_reproject'
        and "background_crypto_authorization_requests"."format_version" = 2
        and "background_crypto_authorization_requests"."purpose" = 'record.reproject'
      ) or (
        "background_crypto_authorization_requests"."work_kind" = 'reflection.publication_reconcile'
        and "background_crypto_authorization_requests"."format_version" = 2
        and "background_crypto_authorization_requests"."purpose" = 'record.reconcile'
      ) or (
        "background_crypto_authorization_requests"."work_kind" = 'reflection.search_projection'
        and "background_crypto_authorization_requests"."format_version" = 2
        and "background_crypto_authorization_requests"."purpose" = 'record.search_projection'
      ) or (
        "background_crypto_authorization_requests"."work_kind" = 'reflection.organization'
        and "background_crypto_authorization_requests"."format_version" = 2
        and "background_crypto_authorization_requests"."purpose" = 'record.organize'
      ) or (
        "background_crypto_authorization_requests"."work_kind" = 'reflection.dependency_rewrite'
        and "background_crypto_authorization_requests"."format_version" = 2
        and "background_crypto_authorization_requests"."purpose" = 'record.dependency_rewrite'
      ) or "background_crypto_authorization_requests"."work_kind" = "background_crypto_authorization_requests"."purpose");--> statement-breakpoint
ALTER TABLE "background_crypto_authorization_requests" ADD CONSTRAINT "background_crypto_authorization_requests_descriptor_coherent" CHECK ((
        "background_crypto_authorization_requests"."descriptor_hash" is null
        and "background_crypto_authorization_requests"."descriptor_bytes" is null
      ) or (
        "background_crypto_authorization_requests"."descriptor_hash" is not null
        and "background_crypto_authorization_requests"."descriptor_bytes" is not null
        and octet_length("background_crypto_authorization_requests"."descriptor_hash")
          = 32
        and octet_length("background_crypto_authorization_requests"."descriptor_bytes") between 1
          and 16457643
      ));--> statement-breakpoint
ALTER TABLE "background_crypto_authorization_requests" ADD CONSTRAINT "background_crypto_authorization_requests_response_coherent" CHECK ((
        "background_crypto_authorization_requests"."accepted_response_kind" is null
        and "background_crypto_authorization_requests"."accepted_response_hash" is null
        and "background_crypto_authorization_requests"."accepted_response_bytes" is null
        and "background_crypto_authorization_requests"."credential_id" is null
        and "background_crypto_authorization_requests"."credential_hash" is null
        and "background_crypto_authorization_requests"."issuing_human_id" is null
        and "background_crypto_authorization_requests"."issuing_device_id" is null
        and "background_crypto_authorization_requests"."issuing_device_authorization_revision" is null
        and "background_crypto_authorization_requests"."issuer_signing_public_key_hash" is null
        and "background_crypto_authorization_requests"."accepted_at" is null
        and "background_crypto_authorization_requests"."authorization_expires_at" is null
      ) or (
        "background_crypto_authorization_requests"."accepted_response_kind" = "background_crypto_authorization_requests"."credential_subject_kind"
        and "background_crypto_authorization_requests"."accepted_response_hash" is not null
        and "background_crypto_authorization_requests"."accepted_response_bytes" is not null
        and octet_length("background_crypto_authorization_requests"."accepted_response_hash")
          = 32
        and (
          (
            "background_crypto_authorization_requests"."accepted_response_kind" = 'processor'
            and octet_length("background_crypto_authorization_requests"."accepted_response_bytes") between 1
              and 35669931
          ) or (
            "background_crypto_authorization_requests"."accepted_response_kind" = 'agent'
            and octet_length("background_crypto_authorization_requests"."accepted_response_bytes") between 1
              and 16912384
          )
        )
        and "background_crypto_authorization_requests"."credential_id" is not null
        and "background_crypto_authorization_requests"."credential_hash" is not null
        and octet_length("background_crypto_authorization_requests"."credential_hash")
          = 32
        and "background_crypto_authorization_requests"."issuing_human_id" is not null
        and "background_crypto_authorization_requests"."issuing_device_id" is not null
        and "background_crypto_authorization_requests"."issuing_device_authorization_revision" is not null
        and "background_crypto_authorization_requests"."issuer_signing_public_key_hash" is not null
        and octet_length("background_crypto_authorization_requests"."issuer_signing_public_key_hash")
          = 32
        and "background_crypto_authorization_requests"."accepted_at" is not null
        and "background_crypto_authorization_requests"."authorization_expires_at" is not null
      ));--> statement-breakpoint
ALTER TABLE "processor_crypto_signer_authorizations" ADD CONSTRAINT "processor_crypto_signer_authorizations_descriptor_size" CHECK (octet_length("processor_crypto_signer_authorizations"."work_descriptor_bytes") between 1
      and 16457643);--> statement-breakpoint
ALTER TABLE "processor_crypto_signer_authorizations" ADD CONSTRAINT "processor_crypto_signer_authorizations_authorization_size" CHECK (octet_length("processor_crypto_signer_authorizations"."authorization_bytes") between 1
      and 16458519);