ALTER TABLE "background_crypto_authorization_domain_requirements" DROP CONSTRAINT "bg_crypto_auth_domain_req_ordinal_range";--> statement-breakpoint
ALTER TABLE "background_crypto_authorization_namespace_requirements" DROP CONSTRAINT "bg_crypto_auth_ns_req_ordinal_range";--> statement-breakpoint
ALTER TABLE "background_crypto_authorization_requests" DROP CONSTRAINT "background_crypto_authorization_requests_format_version";--> statement-breakpoint
ALTER TABLE "background_crypto_authorization_requests" DROP CONSTRAINT "background_crypto_authorization_requests_subject_coherent";--> statement-breakpoint
ALTER TABLE "background_crypto_authorization_requests" DROP CONSTRAINT "background_crypto_authorization_requests_work_subject_coherent";--> statement-breakpoint
ALTER TABLE "background_crypto_authorization_requests" DROP CONSTRAINT "background_crypto_authorization_requests_domain_epoch_coherent";--> statement-breakpoint
ALTER TABLE "background_crypto_authorization_requests" DROP CONSTRAINT "background_crypto_authorization_requests_legacy_carrier_bounds";--> statement-breakpoint
ALTER TABLE "background_crypto_authorization_requests" DROP CONSTRAINT "background_crypto_authorization_requests_response_coherent";--> statement-breakpoint
ALTER TABLE "background_crypto_authorization_domain_requirements" ALTER COLUMN "expected_agent_authorization_revision" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "background_crypto_authorization_domain_requirements" ADD COLUMN "expected_authorization_revision" bigint;--> statement-breakpoint
ALTER TABLE "background_crypto_authorization_requests" ADD COLUMN "runtime_kind" text;--> statement-breakpoint
ALTER TABLE "background_crypto_authorization_requests" ADD COLUMN "runtime_version" smallint;--> statement-breakpoint
ALTER TABLE "background_crypto_authorization_domain_requirements" ADD CONSTRAINT "bg_crypto_auth_domain_req_revision_safe" CHECK ("background_crypto_authorization_domain_requirements"."expected_authorization_revision" between 0 and 9007199254740991);--> statement-breakpoint
ALTER TABLE "background_crypto_authorization_domain_requirements" ADD CONSTRAINT "bg_crypto_auth_domain_req_revision_coherent" CHECK (("background_crypto_authorization_domain_requirements"."expected_agent_authorization_revision" is null)
        <> ("background_crypto_authorization_domain_requirements"."expected_authorization_revision" is null));--> statement-breakpoint
ALTER TABLE "background_crypto_authorization_domain_requirements" ADD CONSTRAINT "bg_crypto_auth_domain_req_ordinal_range" CHECK ("background_crypto_authorization_domain_requirements"."ordinal" between 0
      and 16383);--> statement-breakpoint
ALTER TABLE "background_crypto_authorization_namespace_requirements" ADD CONSTRAINT "bg_crypto_auth_ns_req_ordinal_range" CHECK ("background_crypto_authorization_namespace_requirements"."ordinal" between 0
      and 16383);--> statement-breakpoint
ALTER TABLE "background_crypto_authorization_requests" ADD CONSTRAINT "background_crypto_authorization_requests_runtime_kind_portable" CHECK (octet_length("background_crypto_authorization_requests"."runtime_kind") between 1
      and 128
      and "background_crypto_authorization_requests"."runtime_kind" ~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]*$');--> statement-breakpoint
ALTER TABLE "background_crypto_authorization_requests" ADD CONSTRAINT "background_crypto_authorization_requests_format_version" CHECK ("background_crypto_authorization_requests"."format_version" = 1 or (
        "background_crypto_authorization_requests"."format_version" = 2
        and "background_crypto_authorization_requests"."credential_subject_kind" in ('agent', 'processor')
      ) or (
        "background_crypto_authorization_requests"."format_version" in (2, 3)
        and "background_crypto_authorization_requests"."credential_subject_kind" = 'processor'
      ) or (
        "background_crypto_authorization_requests"."format_version" = 3
        and "background_crypto_authorization_requests"."credential_subject_kind" = 'runtime'
      ));--> statement-breakpoint
ALTER TABLE "background_crypto_authorization_requests" ADD CONSTRAINT "background_crypto_authorization_requests_subject_coherent" CHECK ((
        "background_crypto_authorization_requests"."credential_subject_kind" = 'processor'
        and ("background_crypto_authorization_requests"."processor_kind" = 'stenographer'
          or ("background_crypto_authorization_requests"."processor_kind" = 'reflection' and "background_crypto_authorization_requests"."format_version" = 2))
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
        and "background_crypto_authorization_requests"."runtime_kind" is null
        and "background_crypto_authorization_requests"."runtime_version" is null
      ) or (
        "background_crypto_authorization_requests"."credential_subject_kind" = 'agent'
        and "background_crypto_authorization_requests"."format_version" in (1, 2)
        and "background_crypto_authorization_requests"."processor_kind" is null
        and "background_crypto_authorization_requests"."processor_version" is null
        and "background_crypto_authorization_requests"."processor_authorization_revision" is null
        and "background_crypto_authorization_requests"."agent_id" is not null
        and "background_crypto_authorization_requests"."agent_runtime_generation" is not null
        and "background_crypto_authorization_requests"."agent_authorization_revision" is not null
        and "background_crypto_authorization_requests"."runtime_kind" is null
        and "background_crypto_authorization_requests"."runtime_version" is null
      ) or (
        "background_crypto_authorization_requests"."format_version" = 3
        and "background_crypto_authorization_requests"."credential_subject_kind" = 'runtime'
        and "background_crypto_authorization_requests"."runtime_kind" = 'task'
        and "background_crypto_authorization_requests"."runtime_version" = 1
        and "background_crypto_authorization_requests"."processor_kind" is null
        and "background_crypto_authorization_requests"."processor_version" is null
        and "background_crypto_authorization_requests"."processor_authorization_revision" is null
        and "background_crypto_authorization_requests"."agent_id" is null
        and "background_crypto_authorization_requests"."agent_runtime_generation" is null
        and "background_crypto_authorization_requests"."agent_authorization_revision" is null
      ));--> statement-breakpoint
ALTER TABLE "background_crypto_authorization_requests" ADD CONSTRAINT "background_crypto_authorization_requests_work_subject_coherent" CHECK ((
        ("background_crypto_authorization_requests"."work_kind" like 'stenographer.%' and "background_crypto_authorization_requests"."processor_kind" = 'stenographer'
          or "background_crypto_authorization_requests"."work_kind" like 'reflection.%' and "background_crypto_authorization_requests"."processor_kind" = 'reflection')
        and "background_crypto_authorization_requests"."credential_subject_kind" = 'processor'
      ) or (
        "background_crypto_authorization_requests"."work_kind" not like 'stenographer.%'
        and "background_crypto_authorization_requests"."work_kind" not like 'reflection.%'
        and ("background_crypto_authorization_requests"."work_kind" not like 'task.%'
          or "background_crypto_authorization_requests"."format_version" in (1, 2))
        and "background_crypto_authorization_requests"."credential_subject_kind" = 'agent'
      ) or (
        "background_crypto_authorization_requests"."work_kind" in ('task.dispatch', 'task.execute')
        and "background_crypto_authorization_requests"."purpose" = "background_crypto_authorization_requests"."work_kind"
        and "background_crypto_authorization_requests"."format_version" = 3
        and "background_crypto_authorization_requests"."credential_subject_kind" = 'runtime'
      ));--> statement-breakpoint
ALTER TABLE "background_crypto_authorization_requests" ADD CONSTRAINT "background_crypto_authorization_requests_domain_epoch_coherent" CHECK ((
        ("background_crypto_authorization_requests"."format_version" = 1 or ("background_crypto_authorization_requests"."format_version" = 2 and "background_crypto_authorization_requests"."credential_subject_kind" = 'agent'))
        and "background_crypto_authorization_requests"."expected_domain_epoch" is not null
      ) or (
        "background_crypto_authorization_requests"."format_version" in (2, 3)
        and "background_crypto_authorization_requests"."credential_subject_kind" = 'processor'
        and "background_crypto_authorization_requests"."expected_domain_epoch" is null
      ) or (
        "background_crypto_authorization_requests"."format_version" = 3
        and "background_crypto_authorization_requests"."credential_subject_kind" = 'runtime'
        and "background_crypto_authorization_requests"."expected_domain_epoch" is not null
      ));--> statement-breakpoint
ALTER TABLE "background_crypto_authorization_requests" ADD CONSTRAINT "background_crypto_authorization_requests_legacy_carrier_bounds" CHECK ("background_crypto_authorization_requests"."processor_kind" is not distinct from 'reflection'
        or "background_crypto_authorization_requests"."credential_subject_kind" = 'runtime' or (
        ("background_crypto_authorization_requests"."descriptor_bytes" is null or octet_length("background_crypto_authorization_requests"."descriptor_bytes") <= 131072)
        and ("background_crypto_authorization_requests"."accepted_response_kind" is distinct from 'processor'
          or "background_crypto_authorization_requests"."accepted_response_bytes" is null
          or octet_length("background_crypto_authorization_requests"."accepted_response_bytes") <= 200704)
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
          ) or (
            "background_crypto_authorization_requests"."accepted_response_kind" = 'runtime'
            and octet_length("background_crypto_authorization_requests"."accepted_response_bytes") between 1
              and 16777216
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
      ));