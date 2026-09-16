CREATE TABLE "room_journal_crypto_publications" (
	"publication_id" text PRIMARY KEY NOT NULL,
	"request_id" text NOT NULL,
	"room_id" uuid NOT NULL,
	"namespace_id_at_allocation" uuid NOT NULL,
	"work_id" text NOT NULL,
	"source_batch_id" uuid,
	"rebuild_generation" integer NOT NULL,
	"work_identity_hash" "bytea" NOT NULL,
	"descriptor_hash" "bytea" NOT NULL,
	"attachment_plan_version" smallint NOT NULL,
	"attachment_plan_hash" "bytea" NOT NULL,
	"attachment_plan_bytes" "bytea" NOT NULL,
	"output_object_count" smallint NOT NULL,
	"state" text NOT NULL,
	"lease_token" uuid,
	"lease_expires_at" timestamp with time zone,
	"retry_count" smallint NOT NULL,
	"maximum_attempts" smallint NOT NULL,
	"failure_code" text,
	"last_failure_at" timestamp with time zone,
	"crypto_committed_at" timestamp with time zone,
	"attached_at" timestamp with time zone,
	"tombstone_requested_at" timestamp with time zone,
	"tombstoned_at" timestamp with time zone,
	"last_audited_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "uq_room_journal_crypto_publications_request" UNIQUE("request_id"),
	CONSTRAINT "uq_room_journal_crypto_publications_work" UNIQUE("work_id"),
	CONSTRAINT "uq_room_journal_crypto_publications_work_identity" UNIQUE("work_identity_hash"),
	CONSTRAINT "room_journal_crypto_publications_id_portable" CHECK (octet_length("room_journal_crypto_publications"."publication_id") between 1 and 128
      and "room_journal_crypto_publications"."publication_id" ~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]*$'),
	CONSTRAINT "room_journal_crypto_publications_request_id_portable" CHECK (octet_length("room_journal_crypto_publications"."request_id") between 1 and 128
      and "room_journal_crypto_publications"."request_id" ~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]*$'),
	CONSTRAINT "room_journal_crypto_publications_work_id_portable" CHECK (octet_length("room_journal_crypto_publications"."work_id") between 1 and 128
      and "room_journal_crypto_publications"."work_id" ~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]*$'),
	CONSTRAINT "room_journal_crypto_publications_rebuild_generation" CHECK ("room_journal_crypto_publications"."rebuild_generation" >= 0),
	CONSTRAINT "room_journal_crypto_publications_work_identity_hash_size" CHECK (octet_length("room_journal_crypto_publications"."work_identity_hash") = 32),
	CONSTRAINT "room_journal_crypto_publications_descriptor_hash_size" CHECK (octet_length("room_journal_crypto_publications"."descriptor_hash") = 32),
	CONSTRAINT "room_journal_crypto_publications_attachment_plan" CHECK ("room_journal_crypto_publications"."attachment_plan_version" = 1
        and octet_length("room_journal_crypto_publications"."attachment_plan_hash") = 32
        and octet_length("room_journal_crypto_publications"."attachment_plan_bytes") between 1
          and 131072),
	CONSTRAINT "room_journal_crypto_publications_output_count" CHECK ("room_journal_crypto_publications"."output_object_count" between 0
        and 5),
	CONSTRAINT "room_journal_crypto_publications_state" CHECK ("room_journal_crypto_publications"."state" in (
        'reserved',
        'crypto_committed',
        'attached',
        'quarantined',
        'superseded',
        'tombstone_pending',
        'tombstoned'
      )),
	CONSTRAINT "room_journal_crypto_publications_lease_coherent" CHECK ((
        "room_journal_crypto_publications"."lease_token" is null
        and "room_journal_crypto_publications"."lease_expires_at" is null
      ) or (
        "room_journal_crypto_publications"."state" in (
          'reserved',
          'crypto_committed',
          'tombstone_pending'
        )
        and "room_journal_crypto_publications"."lease_token" is not null
        and "room_journal_crypto_publications"."lease_expires_at" is not null
        and "room_journal_crypto_publications"."updated_at" < "room_journal_crypto_publications"."lease_expires_at"
        and "room_journal_crypto_publications"."lease_expires_at"
          <= "room_journal_crypto_publications"."updated_at" + interval '120 seconds'
      )),
	CONSTRAINT "room_journal_crypto_publications_retry_bounds" CHECK ("room_journal_crypto_publications"."retry_count" between 0 and "room_journal_crypto_publications"."maximum_attempts"
        and "room_journal_crypto_publications"."maximum_attempts" = 8),
	CONSTRAINT "room_journal_crypto_publications_failure_code" CHECK ("room_journal_crypto_publications"."failure_code" is null or "room_journal_crypto_publications"."failure_code" in (
        'stale_authority',
        'crypto_publication_failed',
        'mapping_conflict',
        'attachment_failed',
        'integrity_failure',
        'rebuild_superseded',
        'lease_lost',
        'tombstone_failed'
      )),
	CONSTRAINT "room_journal_crypto_publications_failure_coherent" CHECK ((
        "room_journal_crypto_publications"."failure_code" is null
        and "room_journal_crypto_publications"."last_failure_at" is null
        and "room_journal_crypto_publications"."state" <> 'quarantined'
      ) or (
        "room_journal_crypto_publications"."failure_code" is not null
        and "room_journal_crypto_publications"."last_failure_at" is not null
      )),
	CONSTRAINT "room_journal_crypto_publications_publication_coherent" CHECK ((
        "room_journal_crypto_publications"."state" = 'reserved'
        and "room_journal_crypto_publications"."crypto_committed_at" is null
        and "room_journal_crypto_publications"."attached_at" is null
        and "room_journal_crypto_publications"."tombstone_requested_at" is null
        and "room_journal_crypto_publications"."tombstoned_at" is null
      ) or (
        "room_journal_crypto_publications"."state" = 'crypto_committed'
        and "room_journal_crypto_publications"."crypto_committed_at" is not null
        and "room_journal_crypto_publications"."attached_at" is null
        and "room_journal_crypto_publications"."tombstone_requested_at" is null
        and "room_journal_crypto_publications"."tombstoned_at" is null
      ) or (
        "room_journal_crypto_publications"."state" = 'attached'
        and "room_journal_crypto_publications"."crypto_committed_at" is not null
        and "room_journal_crypto_publications"."attached_at" is not null
        and "room_journal_crypto_publications"."tombstone_requested_at" is null
        and "room_journal_crypto_publications"."tombstoned_at" is null
      ) or (
        "room_journal_crypto_publications"."state" = 'tombstone_pending'
        and "room_journal_crypto_publications"."crypto_committed_at" is not null
        and (
          "room_journal_crypto_publications"."attached_at" is null
          or "room_journal_crypto_publications"."crypto_committed_at" <= "room_journal_crypto_publications"."attached_at"
        )
        and "room_journal_crypto_publications"."tombstone_requested_at" is not null
        and "room_journal_crypto_publications"."tombstoned_at" is null
      ) or (
        "room_journal_crypto_publications"."state" = 'tombstoned'
        and "room_journal_crypto_publications"."crypto_committed_at" is not null
        and (
          "room_journal_crypto_publications"."attached_at" is null
          or "room_journal_crypto_publications"."crypto_committed_at" <= "room_journal_crypto_publications"."attached_at"
        )
        and "room_journal_crypto_publications"."tombstone_requested_at" is not null
        and "room_journal_crypto_publications"."tombstoned_at" is not null
      ) or (
        "room_journal_crypto_publications"."state" = 'quarantined'
        and "room_journal_crypto_publications"."attached_at" is null
        and "room_journal_crypto_publications"."tombstone_requested_at" is null
        and "room_journal_crypto_publications"."tombstoned_at" is null
      ) or (
        "room_journal_crypto_publications"."state" = 'superseded'
        and "room_journal_crypto_publications"."crypto_committed_at" is null
        and "room_journal_crypto_publications"."attached_at" is null
        and "room_journal_crypto_publications"."tombstone_requested_at" is null
        and "room_journal_crypto_publications"."tombstoned_at" is null
      )),
	CONSTRAINT "room_journal_crypto_publications_time_order" CHECK ("room_journal_crypto_publications"."created_at" <= "room_journal_crypto_publications"."updated_at"
        and (
          "room_journal_crypto_publications"."crypto_committed_at" is null
          or "room_journal_crypto_publications"."created_at" <= "room_journal_crypto_publications"."crypto_committed_at"
        )
        and (
          "room_journal_crypto_publications"."attached_at" is null
          or (
            "room_journal_crypto_publications"."crypto_committed_at" is not null
            and "room_journal_crypto_publications"."crypto_committed_at" <= "room_journal_crypto_publications"."attached_at"
          )
        )
        and (
          "room_journal_crypto_publications"."tombstone_requested_at" is null
          or (
            "room_journal_crypto_publications"."crypto_committed_at" is not null
            and "room_journal_crypto_publications"."crypto_committed_at" <= "room_journal_crypto_publications"."tombstone_requested_at"
            and (
              "room_journal_crypto_publications"."attached_at" is null
              or "room_journal_crypto_publications"."attached_at" <= "room_journal_crypto_publications"."tombstone_requested_at"
            )
          )
        )
        and (
          "room_journal_crypto_publications"."tombstoned_at" is null
          or (
            "room_journal_crypto_publications"."tombstone_requested_at" is not null
            and "room_journal_crypto_publications"."tombstone_requested_at" <= "room_journal_crypto_publications"."tombstoned_at"
          )
        )
        and (
          "room_journal_crypto_publications"."last_failure_at" is null
          or "room_journal_crypto_publications"."created_at" <= "room_journal_crypto_publications"."last_failure_at"
        )
        and (
          "room_journal_crypto_publications"."last_audited_at" is null
          or "room_journal_crypto_publications"."created_at" <= "room_journal_crypto_publications"."last_audited_at"
        ))
);
--> statement-breakpoint
CREATE TABLE "background_crypto_authorization_requests" (
	"request_id" text PRIMARY KEY NOT NULL,
	"format_version" smallint NOT NULL,
	"work_identity_hash" "bytea" NOT NULL,
	"idempotency_key" text NOT NULL,
	"work_id" text NOT NULL,
	"work_kind" text NOT NULL,
	"purpose" text NOT NULL,
	"namespace_id" text NOT NULL,
	"domain_id" text NOT NULL,
	"credential_subject_kind" text NOT NULL,
	"processor_kind" text,
	"processor_version" smallint,
	"processor_authorization_revision" bigint,
	"agent_id" text,
	"agent_runtime_generation" bigint,
	"agent_authorization_revision" bigint,
	"expected_domain_epoch" bigint NOT NULL,
	"expected_namespace_access_revision" bigint NOT NULL,
	"expected_policy_revision" bigint NOT NULL,
	"recipient_generation" bigint NOT NULL,
	"descriptor_hash" "bytea",
	"descriptor_bytes" "bytea",
	"recipient_key_id" text,
	"recipient_public_key" "bytea",
	"recipient_expires_at" timestamp with time zone,
	"accepted_response_kind" text,
	"accepted_response_hash" "bytea",
	"accepted_response_bytes" "bytea",
	"credential_id" text,
	"credential_hash" "bytea",
	"issuing_human_id" text,
	"issuing_device_id" text,
	"issuing_device_authorization_revision" bigint,
	"issuer_signing_public_key_hash" "bytea",
	"accepted_at" timestamp with time zone,
	"authorization_expires_at" timestamp with time zone,
	"request_revision" bigint NOT NULL,
	"state" text NOT NULL,
	"claim_id" text,
	"claim_expires_at" timestamp with time zone,
	"retry_count" smallint NOT NULL,
	"maximum_attempts" smallint NOT NULL,
	"last_retry_reason" text,
	"next_attempt_at" timestamp with time zone,
	"terminal_reason" text,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "uq_background_crypto_authorization_requests_work_identity" UNIQUE("work_identity_hash"),
	CONSTRAINT "uq_background_crypto_authorization_requests_idempotency" UNIQUE("idempotency_key"),
	CONSTRAINT "uq_background_crypto_authorization_requests_recipient_key" UNIQUE("recipient_key_id"),
	CONSTRAINT "uq_background_crypto_authorization_requests_response_hash" UNIQUE("accepted_response_hash"),
	CONSTRAINT "uq_background_crypto_authorization_requests_credential_id" UNIQUE("credential_id"),
	CONSTRAINT "uq_background_crypto_authorization_requests_credential_hash" UNIQUE("credential_hash"),
	CONSTRAINT "uq_background_crypto_authorization_requests_claim" UNIQUE("claim_id"),
	CONSTRAINT "background_crypto_authorization_requests_request_id_portable" CHECK (octet_length("background_crypto_authorization_requests"."request_id") between 1
      and 128
      and "background_crypto_authorization_requests"."request_id" ~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]*$'),
	CONSTRAINT "background_crypto_authorization_requests_format_version" CHECK ("background_crypto_authorization_requests"."format_version" = 1),
	CONSTRAINT "background_crypto_authorization_requests_work_identity_hash_size" CHECK (octet_length("background_crypto_authorization_requests"."work_identity_hash") = 32),
	CONSTRAINT "background_crypto_authorization_requests_idempotency_key_portable" CHECK (octet_length("background_crypto_authorization_requests"."idempotency_key") between 1
      and 128
      and "background_crypto_authorization_requests"."idempotency_key" ~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]*$'),
	CONSTRAINT "background_crypto_authorization_requests_work_id_portable" CHECK (octet_length("background_crypto_authorization_requests"."work_id") between 1
      and 128
      and "background_crypto_authorization_requests"."work_id" ~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]*$'),
	CONSTRAINT "background_crypto_authorization_requests_work_kind" CHECK ("background_crypto_authorization_requests"."work_kind" in (
        'stenographer.extraction',
        'stenographer.historical',
        'stenographer.compaction',
        'stenographer.rebuild',
        'memory.review',
        'memory.exit_flush',
        'task.dispatch',
        'task.execute',
        'task.approval_resume'
      )),
	CONSTRAINT "background_crypto_authorization_requests_purpose" CHECK ("background_crypto_authorization_requests"."purpose" in (
        'journal.extract',
        'journal.compact',
        'journal.rebuild',
        'memory.review',
        'memory.exit_flush',
        'task.dispatch',
        'task.execute',
        'task.approval_resume'
      )),
	CONSTRAINT "background_crypto_authorization_requests_work_purpose_coherent" CHECK ((
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
      ) or "background_crypto_authorization_requests"."work_kind" = "background_crypto_authorization_requests"."purpose"),
	CONSTRAINT "background_crypto_authorization_requests_namespace_id_portable" CHECK (octet_length("background_crypto_authorization_requests"."namespace_id") between 1
      and 128
      and "background_crypto_authorization_requests"."namespace_id" ~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]*$'),
	CONSTRAINT "background_crypto_authorization_requests_domain_id_portable" CHECK (octet_length("background_crypto_authorization_requests"."domain_id") between 1
      and 128
      and "background_crypto_authorization_requests"."domain_id" ~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]*$'),
	CONSTRAINT "background_crypto_authorization_requests_subject_coherent" CHECK ((
        "background_crypto_authorization_requests"."credential_subject_kind" = 'processor'
        and "background_crypto_authorization_requests"."processor_kind" = 'stenographer'
        and "background_crypto_authorization_requests"."processor_version" = 1
        and "background_crypto_authorization_requests"."processor_authorization_revision" is not null
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
      )),
	CONSTRAINT "background_crypto_authorization_requests_work_subject_coherent" CHECK ((
        "background_crypto_authorization_requests"."work_kind" like 'stenographer.%'
        and "background_crypto_authorization_requests"."credential_subject_kind" = 'processor'
      ) or (
        "background_crypto_authorization_requests"."work_kind" not like 'stenographer.%'
        and "background_crypto_authorization_requests"."credential_subject_kind" = 'agent'
      )),
	CONSTRAINT "background_crypto_authorization_requests_processor_kind_portable" CHECK (octet_length("background_crypto_authorization_requests"."processor_kind") between 1
      and 128
      and "background_crypto_authorization_requests"."processor_kind" ~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]*$'),
	CONSTRAINT "background_crypto_authorization_requests_processor_revision_safe" CHECK ("background_crypto_authorization_requests"."processor_authorization_revision" between 0 and 9007199254740991),
	CONSTRAINT "background_crypto_authorization_requests_agent_id_portable" CHECK (octet_length("background_crypto_authorization_requests"."agent_id") between 1
      and 128
      and "background_crypto_authorization_requests"."agent_id" ~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]*$'),
	CONSTRAINT "background_crypto_authorization_requests_agent_generation_safe" CHECK ("background_crypto_authorization_requests"."agent_runtime_generation" between 0 and 9007199254740991),
	CONSTRAINT "background_crypto_authorization_requests_agent_revision_safe" CHECK ("background_crypto_authorization_requests"."agent_authorization_revision" between 0 and 9007199254740991),
	CONSTRAINT "background_crypto_authorization_requests_domain_epoch_safe" CHECK ("background_crypto_authorization_requests"."expected_domain_epoch" between 0 and 9007199254740991),
	CONSTRAINT "background_crypto_authorization_requests_namespace_revision_safe" CHECK ("background_crypto_authorization_requests"."expected_namespace_access_revision" between 0 and 9007199254740991),
	CONSTRAINT "background_crypto_authorization_requests_policy_revision_safe" CHECK ("background_crypto_authorization_requests"."expected_policy_revision" between 0 and 9007199254740991),
	CONSTRAINT "background_crypto_authorization_requests_recipient_generation_safe" CHECK ("background_crypto_authorization_requests"."recipient_generation" between 0 and 4294967295),
	CONSTRAINT "background_crypto_authorization_requests_descriptor_coherent" CHECK ((
        "background_crypto_authorization_requests"."descriptor_hash" is null
        and "background_crypto_authorization_requests"."descriptor_bytes" is null
      ) or (
        "background_crypto_authorization_requests"."descriptor_hash" is not null
        and "background_crypto_authorization_requests"."descriptor_bytes" is not null
        and octet_length("background_crypto_authorization_requests"."descriptor_hash")
          = 32
        and octet_length("background_crypto_authorization_requests"."descriptor_bytes") between 1
          and 131072
      )),
	CONSTRAINT "background_crypto_authorization_requests_recipient_coherent" CHECK ((
        "background_crypto_authorization_requests"."recipient_key_id" is null
        and "background_crypto_authorization_requests"."recipient_public_key" is null
        and "background_crypto_authorization_requests"."recipient_expires_at" is null
      ) or (
        "background_crypto_authorization_requests"."recipient_key_id" is not null
        and "background_crypto_authorization_requests"."recipient_public_key" is not null
        and octet_length("background_crypto_authorization_requests"."recipient_public_key")
          = 65
        and "background_crypto_authorization_requests"."recipient_expires_at" is not null
        and "background_crypto_authorization_requests"."descriptor_hash" is not null
      )),
	CONSTRAINT "background_crypto_authorization_requests_recipient_ttl" CHECK ("background_crypto_authorization_requests"."recipient_expires_at" is null or (
        "background_crypto_authorization_requests"."updated_at" < "background_crypto_authorization_requests"."recipient_expires_at"
        and "background_crypto_authorization_requests"."recipient_expires_at"
          <= "background_crypto_authorization_requests"."updated_at" + interval '300 seconds'
      )),
	CONSTRAINT "background_crypto_authorization_requests_recipient_key_id_portable" CHECK (octet_length("background_crypto_authorization_requests"."recipient_key_id") between 1
      and 128
      and "background_crypto_authorization_requests"."recipient_key_id" ~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]*$'),
	CONSTRAINT "background_crypto_authorization_requests_response_coherent" CHECK ((
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
              and 200704
          ) or (
            "background_crypto_authorization_requests"."accepted_response_kind" = 'agent'
            and octet_length("background_crypto_authorization_requests"."accepted_response_bytes") between 1
              and 2101248
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
      )),
	CONSTRAINT "background_crypto_authorization_requests_authorization_ttl" CHECK ("background_crypto_authorization_requests"."authorization_expires_at" is null or (
        "background_crypto_authorization_requests"."accepted_at" < "background_crypto_authorization_requests"."authorization_expires_at"
        and "background_crypto_authorization_requests"."authorization_expires_at"
          <= "background_crypto_authorization_requests"."accepted_at" + interval '300 seconds'
      )),
	CONSTRAINT "background_crypto_authorization_requests_credential_id_portable" CHECK (octet_length("background_crypto_authorization_requests"."credential_id") between 1
      and 128
      and "background_crypto_authorization_requests"."credential_id" ~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]*$'),
	CONSTRAINT "background_crypto_authorization_requests_issuing_human_id_portable" CHECK (octet_length("background_crypto_authorization_requests"."issuing_human_id") between 1
      and 128
      and "background_crypto_authorization_requests"."issuing_human_id" ~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]*$'),
	CONSTRAINT "background_crypto_authorization_requests_issuing_device_id_portable" CHECK (octet_length("background_crypto_authorization_requests"."issuing_device_id") between 1
      and 128
      and "background_crypto_authorization_requests"."issuing_device_id" ~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]*$'),
	CONSTRAINT "background_crypto_authorization_requests_device_revision_safe" CHECK ("background_crypto_authorization_requests"."issuing_device_authorization_revision" between 0 and 9007199254740991),
	CONSTRAINT "background_crypto_authorization_requests_request_revision_safe" CHECK ("background_crypto_authorization_requests"."request_revision" between 0 and 9007199254740991),
	CONSTRAINT "background_crypto_authorization_requests_state" CHECK ("background_crypto_authorization_requests"."state" in (
        'awaiting_recipient',
        'awaiting_device',
        'grant_ready',
        'claimed',
        'running',
        'publication_reconciliation',
        'completed',
        'cancelled',
        'terminal_failure'
      )),
	CONSTRAINT "background_crypto_authorization_requests_state_material_coherent" CHECK ((
        "background_crypto_authorization_requests"."state" = 'awaiting_recipient'
        and "background_crypto_authorization_requests"."descriptor_hash" is null
        and "background_crypto_authorization_requests"."recipient_key_id" is null
        and "background_crypto_authorization_requests"."accepted_response_hash" is null
      ) or (
        "background_crypto_authorization_requests"."state" = 'awaiting_device'
        and "background_crypto_authorization_requests"."descriptor_hash" is not null
        and "background_crypto_authorization_requests"."recipient_key_id" is not null
        and "background_crypto_authorization_requests"."accepted_response_hash" is null
      ) or (
        "background_crypto_authorization_requests"."state" in ('grant_ready', 'claimed', 'running')
        and "background_crypto_authorization_requests"."descriptor_hash" is not null
        and "background_crypto_authorization_requests"."recipient_key_id" is not null
        and "background_crypto_authorization_requests"."accepted_response_hash" is not null
      ) or (
        "background_crypto_authorization_requests"."state" in ('publication_reconciliation', 'completed')
        and "background_crypto_authorization_requests"."descriptor_hash" is not null
        and "background_crypto_authorization_requests"."recipient_key_id" is null
        and "background_crypto_authorization_requests"."accepted_response_hash" is not null
      ) or "background_crypto_authorization_requests"."state" in ('cancelled', 'terminal_failure')),
	CONSTRAINT "background_crypto_authorization_requests_claim_id_portable" CHECK (octet_length("background_crypto_authorization_requests"."claim_id") between 1
      and 128
      and "background_crypto_authorization_requests"."claim_id" ~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]*$'),
	CONSTRAINT "background_crypto_authorization_requests_claim_coherent" CHECK ((
        "background_crypto_authorization_requests"."state" in ('claimed', 'running')
        and "background_crypto_authorization_requests"."claim_id" is not null
        and "background_crypto_authorization_requests"."claim_expires_at" is not null
      ) or (
        "background_crypto_authorization_requests"."state" not in ('claimed', 'running')
        and "background_crypto_authorization_requests"."claim_id" is null
        and "background_crypto_authorization_requests"."claim_expires_at" is null
      )),
	CONSTRAINT "background_crypto_authorization_requests_retry_reason" CHECK ("background_crypto_authorization_requests"."last_retry_reason" is null or "background_crypto_authorization_requests"."last_retry_reason" in (
        'attempt_expired',
        'claim_expired',
        'recipient_lost',
        'stale_authority',
        'key_unavailable',
        'provider_transient_failure',
        'publication_pending'
      )),
	CONSTRAINT "background_crypto_authorization_requests_retry_bounds" CHECK ("background_crypto_authorization_requests"."retry_count" between 0 and "background_crypto_authorization_requests"."maximum_attempts"
        and "background_crypto_authorization_requests"."maximum_attempts" = 8
        and (
          ("background_crypto_authorization_requests"."retry_count" = 0 and "background_crypto_authorization_requests"."last_retry_reason" is null)
          or ("background_crypto_authorization_requests"."retry_count" > 0 and "background_crypto_authorization_requests"."last_retry_reason" is not null)
        )),
	CONSTRAINT "background_crypto_authorization_requests_next_attempt_coherent" CHECK ("background_crypto_authorization_requests"."next_attempt_at" is null
        or "background_crypto_authorization_requests"."state" in (
          'awaiting_recipient',
          'publication_reconciliation'
        )),
	CONSTRAINT "background_crypto_authorization_requests_terminal_reason" CHECK ("background_crypto_authorization_requests"."terminal_reason" is null or "background_crypto_authorization_requests"."terminal_reason" in (
        'malformed_request',
        'integrity_failure',
        'policy_rejected',
        'unsupported_subject',
        'retry_limit_exhausted',
        'recipient_generation_exhausted',
        'cancelled',
        'superseded'
      )),
	CONSTRAINT "background_crypto_authorization_requests_terminal_coherent" CHECK ((
        "background_crypto_authorization_requests"."state" = 'cancelled'
        and "background_crypto_authorization_requests"."terminal_reason" in ('cancelled', 'superseded')
        and "background_crypto_authorization_requests"."finished_at" is not null
      ) or (
        "background_crypto_authorization_requests"."state" = 'terminal_failure'
        and "background_crypto_authorization_requests"."terminal_reason" in (
          'malformed_request',
          'integrity_failure',
          'policy_rejected',
          'unsupported_subject',
          'retry_limit_exhausted',
          'recipient_generation_exhausted'
        )
        and "background_crypto_authorization_requests"."finished_at" is not null
      ) or (
        "background_crypto_authorization_requests"."state" = 'completed'
        and "background_crypto_authorization_requests"."terminal_reason" is null
        and "background_crypto_authorization_requests"."finished_at" is not null
      ) or (
        "background_crypto_authorization_requests"."state" not in (
          'completed',
          'cancelled',
          'terminal_failure'
        )
        and "background_crypto_authorization_requests"."terminal_reason" is null
        and "background_crypto_authorization_requests"."finished_at" is null
      )),
	CONSTRAINT "background_crypto_authorization_requests_time_order" CHECK ("background_crypto_authorization_requests"."created_at" <= "background_crypto_authorization_requests"."updated_at"
        and (
          "background_crypto_authorization_requests"."accepted_at" is null
          or (
            "background_crypto_authorization_requests"."created_at" <= "background_crypto_authorization_requests"."accepted_at"
            and "background_crypto_authorization_requests"."accepted_at" <= "background_crypto_authorization_requests"."updated_at"
            and "background_crypto_authorization_requests"."accepted_at" < "background_crypto_authorization_requests"."authorization_expires_at"
          )
        )
        and (
          "background_crypto_authorization_requests"."finished_at" is null
          or "background_crypto_authorization_requests"."updated_at" <= "background_crypto_authorization_requests"."finished_at"
        ))
);
--> statement-breakpoint
ALTER TABLE "background_crypto_authorization_requests" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "processor_crypto_signer_authorizations" (
	"authorization_id" text PRIMARY KEY NOT NULL,
	"request_id" text NOT NULL,
	"recipient_generation" bigint NOT NULL,
	"processor_kind" text NOT NULL,
	"processor_version" smallint NOT NULL,
	"work_id" text NOT NULL,
	"namespace_id" text NOT NULL,
	"domain_id" text NOT NULL,
	"domain_epoch" bigint NOT NULL,
	"namespace_access_revision" bigint NOT NULL,
	"policy_revision" bigint NOT NULL,
	"processor_authorization_revision" bigint NOT NULL,
	"issuing_human_id" text NOT NULL,
	"issuing_device_id" text NOT NULL,
	"issuing_device_authorization_revision" bigint NOT NULL,
	"issuer_signing_public_key_hash" "bytea" NOT NULL,
	"signer_key_id" text NOT NULL,
	"signer_public_key" "bytea" NOT NULL,
	"work_descriptor_hash" "bytea" NOT NULL,
	"work_descriptor_bytes" "bytea" NOT NULL,
	"authorization_hash" "bytea" NOT NULL,
	"credential_hash" "bytea" NOT NULL,
	"authorization_bytes" "bytea" NOT NULL,
	"issued_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "uq_processor_crypto_signer_authorizations_request_generation" UNIQUE("request_id","recipient_generation"),
	CONSTRAINT "uq_processor_crypto_signer_authorizations_signer_key" UNIQUE("signer_key_id"),
	CONSTRAINT "uq_processor_crypto_signer_authorizations_authorization_hash" UNIQUE("authorization_hash"),
	CONSTRAINT "uq_processor_crypto_signer_authorizations_credential_hash" UNIQUE("credential_hash"),
	CONSTRAINT "processor_crypto_signer_authorizations_id_portable" CHECK (octet_length("processor_crypto_signer_authorizations"."authorization_id") between 1
      and 128
      and "processor_crypto_signer_authorizations"."authorization_id" ~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]*$'),
	CONSTRAINT "processor_crypto_signer_authorizations_request_id_portable" CHECK (octet_length("processor_crypto_signer_authorizations"."request_id") between 1
      and 128
      and "processor_crypto_signer_authorizations"."request_id" ~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]*$'),
	CONSTRAINT "processor_crypto_signer_authorizations_generation_safe" CHECK ("processor_crypto_signer_authorizations"."recipient_generation" between 0 and 4294967295),
	CONSTRAINT "processor_crypto_signer_authorizations_processor" CHECK ("processor_crypto_signer_authorizations"."processor_kind" = 'stenographer'
        and "processor_crypto_signer_authorizations"."processor_version" = 1),
	CONSTRAINT "processor_crypto_signer_authorizations_work_id_portable" CHECK (octet_length("processor_crypto_signer_authorizations"."work_id") between 1
      and 128
      and "processor_crypto_signer_authorizations"."work_id" ~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]*$'),
	CONSTRAINT "processor_crypto_signer_authorizations_namespace_id_portable" CHECK (octet_length("processor_crypto_signer_authorizations"."namespace_id") between 1
      and 128
      and "processor_crypto_signer_authorizations"."namespace_id" ~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]*$'),
	CONSTRAINT "processor_crypto_signer_authorizations_domain_id_portable" CHECK (octet_length("processor_crypto_signer_authorizations"."domain_id") between 1
      and 128
      and "processor_crypto_signer_authorizations"."domain_id" ~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]*$'),
	CONSTRAINT "processor_crypto_signer_authorizations_domain_epoch_safe" CHECK ("processor_crypto_signer_authorizations"."domain_epoch" between 0 and 9007199254740991),
	CONSTRAINT "processor_crypto_signer_authorizations_namespace_revision_safe" CHECK ("processor_crypto_signer_authorizations"."namespace_access_revision" between 0 and 9007199254740991),
	CONSTRAINT "processor_crypto_signer_authorizations_policy_revision_safe" CHECK ("processor_crypto_signer_authorizations"."policy_revision" between 0 and 9007199254740991),
	CONSTRAINT "processor_crypto_signer_authorizations_processor_revision_safe" CHECK ("processor_crypto_signer_authorizations"."processor_authorization_revision" between 0 and 9007199254740991),
	CONSTRAINT "processor_crypto_signer_authorizations_human_id_portable" CHECK (octet_length("processor_crypto_signer_authorizations"."issuing_human_id") between 1
      and 128
      and "processor_crypto_signer_authorizations"."issuing_human_id" ~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]*$'),
	CONSTRAINT "processor_crypto_signer_authorizations_device_id_portable" CHECK (octet_length("processor_crypto_signer_authorizations"."issuing_device_id") between 1
      and 128
      and "processor_crypto_signer_authorizations"."issuing_device_id" ~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]*$'),
	CONSTRAINT "processor_crypto_signer_authorizations_device_revision_safe" CHECK ("processor_crypto_signer_authorizations"."issuing_device_authorization_revision" between 0 and 9007199254740991),
	CONSTRAINT "processor_crypto_signer_authorizations_issuer_key_hash_size" CHECK (octet_length("processor_crypto_signer_authorizations"."issuer_signing_public_key_hash") = 32),
	CONSTRAINT "processor_crypto_signer_authorizations_signer_key_id_portable" CHECK (octet_length("processor_crypto_signer_authorizations"."signer_key_id") between 1
      and 128
      and "processor_crypto_signer_authorizations"."signer_key_id" ~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]*$'),
	CONSTRAINT "processor_crypto_signer_authorizations_public_key_size" CHECK (octet_length("processor_crypto_signer_authorizations"."signer_public_key") = 32),
	CONSTRAINT "processor_crypto_signer_authorizations_descriptor_hash_size" CHECK (octet_length("processor_crypto_signer_authorizations"."work_descriptor_hash") = 32),
	CONSTRAINT "processor_crypto_signer_authorizations_descriptor_size" CHECK (octet_length("processor_crypto_signer_authorizations"."work_descriptor_bytes") between 1
      and 131072),
	CONSTRAINT "processor_crypto_signer_authorizations_authorization_hash_size" CHECK (octet_length("processor_crypto_signer_authorizations"."authorization_hash") = 32),
	CONSTRAINT "processor_crypto_signer_authorizations_credential_hash_size" CHECK (octet_length("processor_crypto_signer_authorizations"."credential_hash") = 32),
	CONSTRAINT "processor_crypto_signer_authorizations_authorization_size" CHECK (octet_length("processor_crypto_signer_authorizations"."authorization_bytes") between 1
      and 65536),
	CONSTRAINT "processor_crypto_signer_authorizations_time_order" CHECK ("processor_crypto_signer_authorizations"."issued_at" <= "processor_crypto_signer_authorizations"."created_at"
        and "processor_crypto_signer_authorizations"."created_at" < "processor_crypto_signer_authorizations"."expires_at"
        and "processor_crypto_signer_authorizations"."expires_at"
          <= "processor_crypto_signer_authorizations"."issued_at" + interval '300 seconds')
);
--> statement-breakpoint
ALTER TABLE "processor_crypto_signer_authorizations" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "room_event_rollups" ADD COLUMN "crypto_object_id" text;--> statement-breakpoint
ALTER TABLE "room_events" ADD COLUMN "crypto_object_id" text;--> statement-breakpoint
ALTER TABLE "room_journal_crypto_publications" ADD CONSTRAINT "room_journal_crypto_publications_source_batch_id_room_journal_batches_id_fk" FOREIGN KEY ("source_batch_id") REFERENCES "public"."room_journal_batches"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "room_journal_crypto_publications" ADD CONSTRAINT "room_journal_crypto_publications_room_namespace_fk" FOREIGN KEY ("room_id","namespace_id_at_allocation") REFERENCES "public"."rooms"("id","namespace_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_room_journal_crypto_publications_reconciliation" ON "room_journal_crypto_publications" USING btree ("state","updated_at");--> statement-breakpoint
CREATE INDEX "idx_room_journal_crypto_publications_lease" ON "room_journal_crypto_publications" USING btree ("state","lease_expires_at");--> statement-breakpoint
CREATE INDEX "idx_room_journal_crypto_publications_audit" ON "room_journal_crypto_publications" USING btree ("last_audited_at");--> statement-breakpoint
CREATE INDEX "idx_background_crypto_authorization_requests_eligible" ON "background_crypto_authorization_requests" USING btree ("state","next_attempt_at","created_at");--> statement-breakpoint
CREATE INDEX "idx_background_crypto_authorization_requests_recipient_expiry" ON "background_crypto_authorization_requests" USING btree ("state","recipient_expires_at");--> statement-breakpoint
CREATE INDEX "idx_background_crypto_authorization_requests_claim_expiry" ON "background_crypto_authorization_requests" USING btree ("state","claim_expires_at");--> statement-breakpoint
CREATE INDEX "idx_background_crypto_authorization_requests_terminal_cleanup" ON "background_crypto_authorization_requests" USING btree ("finished_at");--> statement-breakpoint
CREATE INDEX "idx_processor_crypto_signer_authorizations_work" ON "processor_crypto_signer_authorizations" USING btree ("processor_kind","work_id");--> statement-breakpoint
CREATE INDEX "idx_processor_crypto_signer_authorizations_expiry" ON "processor_crypto_signer_authorizations" USING btree ("expires_at");--> statement-breakpoint
ALTER TABLE "room_event_rollups" ADD CONSTRAINT "room_event_rollups_crypto_object_id_crypto_objects_object_id_fk" FOREIGN KEY ("crypto_object_id") REFERENCES "public"."crypto_objects"("object_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "room_events" ADD CONSTRAINT "room_events_crypto_object_id_crypto_objects_object_id_fk" FOREIGN KEY ("crypto_object_id") REFERENCES "public"."crypto_objects"("object_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "room_event_rollups" ADD CONSTRAINT "uq_room_event_rollups_crypto_object_id" UNIQUE("crypto_object_id");--> statement-breakpoint
ALTER TABLE "room_events" ADD CONSTRAINT "uq_room_events_crypto_object_id" UNIQUE("crypto_object_id");--> statement-breakpoint
CREATE POLICY "background_crypto_authorization_requests_crypto_sel" ON "background_crypto_authorization_requests" AS PERMISSIVE FOR SELECT TO "nautilo_crypto" USING (true);--> statement-breakpoint
CREATE POLICY "background_crypto_authorization_requests_crypto_ins" ON "background_crypto_authorization_requests" AS PERMISSIVE FOR INSERT TO "nautilo_crypto" WITH CHECK (true);--> statement-breakpoint
CREATE POLICY "background_crypto_authorization_requests_crypto_upd" ON "background_crypto_authorization_requests" AS PERMISSIVE FOR UPDATE TO "nautilo_crypto" USING (true) WITH CHECK (true);--> statement-breakpoint
CREATE POLICY "background_crypto_authorization_requests_crypto_del" ON "background_crypto_authorization_requests" AS PERMISSIVE FOR DELETE TO "nautilo_crypto" USING (true);--> statement-breakpoint
CREATE POLICY "processor_crypto_signer_authorizations_crypto_sel" ON "processor_crypto_signer_authorizations" AS PERMISSIVE FOR SELECT TO "nautilo_crypto" USING (true);--> statement-breakpoint
CREATE POLICY "processor_crypto_signer_authorizations_crypto_ins" ON "processor_crypto_signer_authorizations" AS PERMISSIVE FOR INSERT TO "nautilo_crypto" WITH CHECK (true);
--> statement-breakpoint
-- M241_BACKGROUND_AUTHORIZATION_AUTHORITY
ALTER TABLE "background_crypto_authorization_requests"
  FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "processor_crypto_signer_authorizations"
  FORCE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL PRIVILEGES ON TABLE
  "background_crypto_authorization_requests",
  "processor_crypto_signer_authorizations"
FROM PUBLIC, "nautilo", "nautilo_agent", "nautilo_crypto";--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE
  "background_crypto_authorization_requests"
TO "nautilo_crypto";--> statement-breakpoint
GRANT SELECT, INSERT ON TABLE
  "processor_crypto_signer_authorizations"
TO "nautilo_crypto";
--> statement-breakpoint
-- M241_JOURNAL_CRYPTO_PUBLICATION_AUTHORITY
REVOKE ALL PRIVILEGES ON TABLE "room_journal_crypto_publications"
FROM PUBLIC, "nautilo_agent", "nautilo_crypto";
