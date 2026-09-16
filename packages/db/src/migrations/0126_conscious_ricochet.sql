CREATE TABLE "crypto_delivery_acknowledgements" (
	"message_id" text NOT NULL,
	"device_id" text NOT NULL,
	"processed_revision" bigint NOT NULL,
	"acknowledgement_digest" "bytea" NOT NULL,
	"acknowledged_at" timestamp with time zone NOT NULL,
	CONSTRAINT "crypto_delivery_acknowledgements_message_id_device_id_pk" PRIMARY KEY("message_id","device_id"),
	CONSTRAINT "crypto_delivery_acknowledgements_message_id_portable" CHECK (octet_length("crypto_delivery_acknowledgements"."message_id") between 1
      and 128
      and "crypto_delivery_acknowledgements"."message_id" ~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]*$'),
	CONSTRAINT "crypto_delivery_acknowledgements_device_id_portable" CHECK (octet_length("crypto_delivery_acknowledgements"."device_id") between 1
      and 128
      and "crypto_delivery_acknowledgements"."device_id" ~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]*$'),
	CONSTRAINT "crypto_delivery_acknowledgements_revision_safe" CHECK ("crypto_delivery_acknowledgements"."processed_revision" between 0 and 9007199254740991),
	CONSTRAINT "crypto_delivery_acknowledgements_digest_size" CHECK (octet_length("crypto_delivery_acknowledgements"."acknowledgement_digest") = 32)
);
--> statement-breakpoint
ALTER TABLE "crypto_delivery_acknowledgements" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "crypto_delivery_messages" (
	"message_id" text PRIMARY KEY NOT NULL,
	"operation_id" text NOT NULL,
	"domain_id" text,
	"domain_sequence" bigint,
	"recipient_sequence" bigint NOT NULL,
	"kind" text NOT NULL,
	"recipient_device_id" text NOT NULL,
	"format_version" smallint NOT NULL,
	"payload_hash" "bytea" NOT NULL,
	"payload_bytes" "bytea" NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "uq_crypto_delivery_messages_recipient" UNIQUE("message_id","recipient_device_id"),
	CONSTRAINT "uq_crypto_delivery_messages_recipient_sequence" UNIQUE("recipient_device_id","recipient_sequence"),
	CONSTRAINT "uq_crypto_delivery_messages_payload" UNIQUE("operation_id","payload_hash","recipient_device_id"),
	CONSTRAINT "crypto_delivery_messages_id_portable" CHECK (octet_length("crypto_delivery_messages"."message_id") between 1
      and 128
      and "crypto_delivery_messages"."message_id" ~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]*$'),
	CONSTRAINT "crypto_delivery_messages_operation_id_portable" CHECK (octet_length("crypto_delivery_messages"."operation_id") between 1
      and 128
      and "crypto_delivery_messages"."operation_id" ~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]*$'),
	CONSTRAINT "crypto_delivery_messages_domain_id_portable" CHECK (octet_length("crypto_delivery_messages"."domain_id") between 1
      and 128
      and "crypto_delivery_messages"."domain_id" ~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]*$'),
	CONSTRAINT "crypto_delivery_messages_domain_sequence_safe" CHECK ("crypto_delivery_messages"."domain_sequence" between 0 and 9007199254740991),
	CONSTRAINT "crypto_delivery_messages_recipient_sequence_positive" CHECK ("crypto_delivery_messages"."recipient_sequence" >= 1),
	CONSTRAINT "crypto_delivery_messages_domain_sequence_coherent" CHECK ((
        "crypto_delivery_messages"."domain_id" is null and "crypto_delivery_messages"."domain_sequence" is null
      ) or (
        "crypto_delivery_messages"."domain_id" is not null and "crypto_delivery_messages"."domain_sequence" is not null
      )),
	CONSTRAINT "crypto_delivery_messages_kind" CHECK ("crypto_delivery_messages"."kind" in (
        'key_package', 'proposal', 'commit', 'welcome', 'public_state',
        'binding_candidate', 'recovery_archive', 'operation_receipt',
        'device_transfer', 'recovery_challenge'
      )),
	CONSTRAINT "crypto_delivery_messages_recipient_device_id_portable" CHECK (octet_length("crypto_delivery_messages"."recipient_device_id") between 1
      and 128
      and "crypto_delivery_messages"."recipient_device_id" ~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]*$'),
	CONSTRAINT "crypto_delivery_messages_format_version" CHECK ("crypto_delivery_messages"."format_version" >= 1),
	CONSTRAINT "crypto_delivery_messages_payload_hash_size" CHECK (octet_length("crypto_delivery_messages"."payload_hash") = 32),
	CONSTRAINT "crypto_delivery_messages_payload_size" CHECK (octet_length("crypto_delivery_messages"."payload_bytes") between 1
      and 1048616),
	CONSTRAINT "crypto_delivery_messages_expiry" CHECK ("crypto_delivery_messages"."expires_at" > "crypto_delivery_messages"."created_at")
);
--> statement-breakpoint
ALTER TABLE "crypto_delivery_messages" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "crypto_delivery_operations" (
	"operation_id" text PRIMARY KEY NOT NULL,
	"idempotency_key" text NOT NULL,
	"kind" text NOT NULL,
	"state" text NOT NULL,
	"human_id" text,
	"target_human_id" text,
	"target_device_id" text,
	"expected_custody_revision" bigint,
	"expected_recovery_generation" bigint,
	"expected_device_revision" bigint,
	"expected_participant_digest" "bytea",
	"aggregate_payload_bytes" bigint NOT NULL,
	"fanout_row_count" integer NOT NULL,
	"lease_owner" text,
	"lease_expires_at" timestamp with time zone,
	"retry_count" smallint NOT NULL,
	"maximum_attempts" smallint NOT NULL,
	"failure_code" text,
	"audit_ref" text,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"deadline_at" timestamp with time zone NOT NULL,
	"terminal_at" timestamp with time zone,
	CONSTRAINT "uq_crypto_delivery_operations_idempotency" UNIQUE("idempotency_key"),
	CONSTRAINT "crypto_delivery_operations_id_portable" CHECK (octet_length("crypto_delivery_operations"."operation_id") between 1
      and 128
      and "crypto_delivery_operations"."operation_id" ~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]*$'),
	CONSTRAINT "crypto_delivery_operations_idempotency_portable" CHECK (octet_length("crypto_delivery_operations"."idempotency_key") between 1
      and 128
      and "crypto_delivery_operations"."idempotency_key" ~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]*$'),
	CONSTRAINT "crypto_delivery_operations_kind" CHECK ("crypto_delivery_operations"."kind" in (
        'first_device_bootstrap', 'device_add', 'device_recovery',
        'device_revoke', 'recovery_rotate', 'human_add', 'human_remove',
        'domain_rebootstrap'
      )),
	CONSTRAINT "crypto_delivery_operations_state" CHECK ("crypto_delivery_operations"."state" in (
        'requested', 'awaiting_target_device', 'awaiting_committer',
        'preparing_domain', 'awaiting_delivery', 'ready_to_activate',
        'activating', 'active', 'failed', 'cancelled'
      )),
	CONSTRAINT "crypto_delivery_operations_human_id_portable" CHECK (octet_length("crypto_delivery_operations"."human_id") between 1
      and 128
      and "crypto_delivery_operations"."human_id" ~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]*$'),
	CONSTRAINT "crypto_delivery_operations_target_human_id_portable" CHECK (octet_length("crypto_delivery_operations"."target_human_id") between 1
      and 128
      and "crypto_delivery_operations"."target_human_id" ~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]*$'),
	CONSTRAINT "crypto_delivery_operations_target_device_id_portable" CHECK (octet_length("crypto_delivery_operations"."target_device_id") between 1
      and 128
      and "crypto_delivery_operations"."target_device_id" ~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]*$'),
	CONSTRAINT "crypto_delivery_operations_custody_revision_safe" CHECK ("crypto_delivery_operations"."expected_custody_revision" between 0 and 9007199254740991),
	CONSTRAINT "crypto_delivery_operations_recovery_generation_safe" CHECK ("crypto_delivery_operations"."expected_recovery_generation" between 0 and 9007199254740991),
	CONSTRAINT "crypto_delivery_operations_device_revision_safe" CHECK ("crypto_delivery_operations"."expected_device_revision" between 0 and 9007199254740991),
	CONSTRAINT "crypto_delivery_operations_participant_digest_size" CHECK (octet_length("crypto_delivery_operations"."expected_participant_digest") = 32),
	CONSTRAINT "crypto_delivery_operations_aggregate_payload_bound" CHECK ("crypto_delivery_operations"."aggregate_payload_bytes" between 0 and 67108864),
	CONSTRAINT "crypto_delivery_operations_fanout_bound" CHECK ("crypto_delivery_operations"."fanout_row_count" between 0 and 4096),
	CONSTRAINT "crypto_delivery_operations_lease_coherent" CHECK ((
        "crypto_delivery_operations"."lease_owner" is null and "crypto_delivery_operations"."lease_expires_at" is null
      ) or (
        "crypto_delivery_operations"."lease_owner" is not null
        and "crypto_delivery_operations"."lease_expires_at" is not null
      )),
	CONSTRAINT "crypto_delivery_operations_lease_owner_portable" CHECK (octet_length("crypto_delivery_operations"."lease_owner") between 1
      and 128
      and "crypto_delivery_operations"."lease_owner" ~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]*$'),
	CONSTRAINT "crypto_delivery_operations_retry_bound" CHECK ("crypto_delivery_operations"."retry_count" between 0 and "crypto_delivery_operations"."maximum_attempts"
        and "crypto_delivery_operations"."maximum_attempts" = 8),
	CONSTRAINT "crypto_delivery_operations_terminal_coherent" CHECK ((
        "crypto_delivery_operations"."state" in ('active', 'failed', 'cancelled')
        and "crypto_delivery_operations"."terminal_at" is not null
      ) or (
        "crypto_delivery_operations"."state" not in ('active', 'failed', 'cancelled')
        and "crypto_delivery_operations"."terminal_at" is null
      )),
	CONSTRAINT "crypto_delivery_operations_failure_code_portable" CHECK (octet_length("crypto_delivery_operations"."failure_code") between 1
      and 128
      and "crypto_delivery_operations"."failure_code" ~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]*$'),
	CONSTRAINT "crypto_delivery_operations_audit_ref_portable" CHECK (octet_length("crypto_delivery_operations"."audit_ref") between 1
      and 128
      and "crypto_delivery_operations"."audit_ref" ~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]*$'),
	CONSTRAINT "crypto_delivery_operations_time_order" CHECK ("crypto_delivery_operations"."updated_at" >= "crypto_delivery_operations"."created_at"
        and "crypto_delivery_operations"."deadline_at" > "crypto_delivery_operations"."created_at")
);
--> statement-breakpoint
ALTER TABLE "crypto_delivery_operations" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "crypto_device_epoch_operations" (
	"operation_id" text PRIMARY KEY NOT NULL,
	"target_device_id" text NOT NULL,
	"owner_human_id" text NOT NULL,
	"source_device_id" text,
	"expected_device_revision" bigint NOT NULL,
	"expected_inventory_revision" bigint NOT NULL,
	"expected_inventory_count" integer NOT NULL,
	"expected_inventory_digest" "bytea" NOT NULL,
	"authorization_artifact_hash" "bytea" NOT NULL,
	"recovery_readiness_digest" "bytea",
	CONSTRAINT "crypto_device_epoch_operations_operation_id_portable" CHECK (octet_length("crypto_device_epoch_operations"."operation_id") between 1
      and 128
      and "crypto_device_epoch_operations"."operation_id" ~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]*$'),
	CONSTRAINT "crypto_device_epoch_operations_target_device_id_portable" CHECK (octet_length("crypto_device_epoch_operations"."target_device_id") between 1
      and 128
      and "crypto_device_epoch_operations"."target_device_id" ~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]*$'),
	CONSTRAINT "crypto_device_epoch_operations_owner_human_id_portable" CHECK (octet_length("crypto_device_epoch_operations"."owner_human_id") between 1
      and 128
      and "crypto_device_epoch_operations"."owner_human_id" ~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]*$'),
	CONSTRAINT "crypto_device_epoch_operations_source_device_id_portable" CHECK (octet_length("crypto_device_epoch_operations"."source_device_id") between 1
      and 128
      and "crypto_device_epoch_operations"."source_device_id" ~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]*$'),
	CONSTRAINT "crypto_device_epoch_operations_device_revision_safe" CHECK ("crypto_device_epoch_operations"."expected_device_revision" between 0 and 9007199254740991),
	CONSTRAINT "crypto_device_epoch_operations_inventory_revision_safe" CHECK ("crypto_device_epoch_operations"."expected_inventory_revision" between 0 and 9007199254740991),
	CONSTRAINT "crypto_device_epoch_operations_inventory_count" CHECK ("crypto_device_epoch_operations"."expected_inventory_count" between 0 and 4096),
	CONSTRAINT "crypto_device_epoch_operations_inventory_digest_size" CHECK (octet_length("crypto_device_epoch_operations"."expected_inventory_digest") = 32),
	CONSTRAINT "crypto_device_epoch_operations_artifact_hash_size" CHECK (octet_length("crypto_device_epoch_operations"."authorization_artifact_hash") = 32),
	CONSTRAINT "crypto_device_epoch_operations_readiness_digest_size" CHECK (octet_length("crypto_device_epoch_operations"."recovery_readiness_digest") = 32)
);
--> statement-breakpoint
ALTER TABLE "crypto_device_epoch_operations" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "crypto_domain_devices" (
	"domain_id" text NOT NULL,
	"device_id" text NOT NULL,
	"human_id" text NOT NULL,
	"leaf_index" smallint NOT NULL,
	"joined_epoch" bigint NOT NULL,
	"removed_epoch" bigint,
	"removed_at" timestamp with time zone,
	CONSTRAINT "crypto_domain_devices_domain_id_device_id_pk" PRIMARY KEY("domain_id","device_id"),
	CONSTRAINT "crypto_domain_devices_domain_id_portable" CHECK (octet_length("crypto_domain_devices"."domain_id") between 1
      and 128
      and "crypto_domain_devices"."domain_id" ~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]*$'),
	CONSTRAINT "crypto_domain_devices_device_id_portable" CHECK (octet_length("crypto_domain_devices"."device_id") between 1
      and 128
      and "crypto_domain_devices"."device_id" ~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]*$'),
	CONSTRAINT "crypto_domain_devices_human_id_portable" CHECK (octet_length("crypto_domain_devices"."human_id") between 1
      and 128
      and "crypto_domain_devices"."human_id" ~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]*$'),
	CONSTRAINT "crypto_domain_devices_leaf_index" CHECK ("crypto_domain_devices"."leaf_index" between 0 and 255),
	CONSTRAINT "crypto_domain_devices_joined_epoch_safe" CHECK ("crypto_domain_devices"."joined_epoch" between 0 and 9007199254740991),
	CONSTRAINT "crypto_domain_devices_removed_epoch_safe" CHECK ("crypto_domain_devices"."removed_epoch" between 0 and 9007199254740991),
	CONSTRAINT "crypto_domain_devices_removal_coherent" CHECK ((
        "crypto_domain_devices"."removed_epoch" is null and "crypto_domain_devices"."removed_at" is null
      ) or (
        "crypto_domain_devices"."removed_epoch" is not null
        and "crypto_domain_devices"."removed_epoch" > "crypto_domain_devices"."joined_epoch"
        and "crypto_domain_devices"."removed_at" is not null
      ))
);
--> statement-breakpoint
ALTER TABLE "crypto_domain_devices" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "crypto_domain_transition_namespaces" (
	"operation_id" text NOT NULL,
	"domain_id" text NOT NULL,
	"namespace_id" text NOT NULL,
	"expected_access_revision" bigint NOT NULL,
	"expected_binding_hash" "bytea" NOT NULL,
	"candidate_binding_hash" "bytea",
	"candidate_signed_binding_bytes" "bytea",
	"candidate_human_keyring_envelope_bytes" "bytea",
	"candidate_ai_keyring_envelope_bytes" "bytea",
	"state" text NOT NULL,
	"failure_code" text,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "crypto_domain_transition_namespaces_operation_id_domain_id_namespace_id_pk" PRIMARY KEY("operation_id","domain_id","namespace_id"),
	CONSTRAINT "crypto_domain_transition_namespaces_operation_id_portable" CHECK (octet_length("crypto_domain_transition_namespaces"."operation_id") between 1
      and 128
      and "crypto_domain_transition_namespaces"."operation_id" ~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]*$'),
	CONSTRAINT "crypto_domain_transition_namespaces_domain_id_portable" CHECK (octet_length("crypto_domain_transition_namespaces"."domain_id") between 1
      and 128
      and "crypto_domain_transition_namespaces"."domain_id" ~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]*$'),
	CONSTRAINT "crypto_domain_transition_namespaces_namespace_id_portable" CHECK (octet_length("crypto_domain_transition_namespaces"."namespace_id") between 1
      and 128
      and "crypto_domain_transition_namespaces"."namespace_id" ~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]*$'),
	CONSTRAINT "crypto_domain_transition_namespaces_access_revision_safe" CHECK ("crypto_domain_transition_namespaces"."expected_access_revision" between 0 and 9007199254740991),
	CONSTRAINT "crypto_domain_transition_namespaces_expected_hash_size" CHECK (octet_length("crypto_domain_transition_namespaces"."expected_binding_hash") = 32),
	CONSTRAINT "crypto_domain_transition_namespaces_candidate_hash_size" CHECK (octet_length("crypto_domain_transition_namespaces"."candidate_binding_hash") = 32),
	CONSTRAINT "crypto_domain_transition_namespaces_candidate_signed_size" CHECK (octet_length("crypto_domain_transition_namespaces"."candidate_signed_binding_bytes") between 1
      and 1048616),
	CONSTRAINT "crypto_domain_transition_namespaces_candidate_human_keyring_size" CHECK (octet_length("crypto_domain_transition_namespaces"."candidate_human_keyring_envelope_bytes") between 1
      and 262144),
	CONSTRAINT "crypto_domain_transition_namespaces_candidate_ai_keyring_size" CHECK (octet_length("crypto_domain_transition_namespaces"."candidate_ai_keyring_envelope_bytes") between 1
      and 262144),
	CONSTRAINT "crypto_domain_transition_namespaces_state" CHECK ("crypto_domain_transition_namespaces"."state" in ('pending', 'prepared', 'active', 'failed')),
	CONSTRAINT "crypto_domain_transition_namespaces_candidate_coherent" CHECK ((
        "crypto_domain_transition_namespaces"."state" = 'pending'
        and "crypto_domain_transition_namespaces"."candidate_binding_hash" is null
        and "crypto_domain_transition_namespaces"."candidate_signed_binding_bytes" is null
        and "crypto_domain_transition_namespaces"."candidate_human_keyring_envelope_bytes" is null
        and "crypto_domain_transition_namespaces"."candidate_ai_keyring_envelope_bytes" is null
      ) or (
        "crypto_domain_transition_namespaces"."state" in ('prepared', 'active')
        and "crypto_domain_transition_namespaces"."candidate_binding_hash" is not null
        and "crypto_domain_transition_namespaces"."candidate_signed_binding_bytes" is not null
        and "crypto_domain_transition_namespaces"."candidate_human_keyring_envelope_bytes" is not null
        and "crypto_domain_transition_namespaces"."candidate_ai_keyring_envelope_bytes" is not null
      ) or (
        "crypto_domain_transition_namespaces"."state" = 'failed'
        and (
          (
            "crypto_domain_transition_namespaces"."candidate_binding_hash" is null
            and "crypto_domain_transition_namespaces"."candidate_signed_binding_bytes" is null
            and "crypto_domain_transition_namespaces"."candidate_human_keyring_envelope_bytes" is null
            and "crypto_domain_transition_namespaces"."candidate_ai_keyring_envelope_bytes" is null
          ) or (
            "crypto_domain_transition_namespaces"."candidate_binding_hash" is not null
            and "crypto_domain_transition_namespaces"."candidate_signed_binding_bytes" is not null
            and "crypto_domain_transition_namespaces"."candidate_human_keyring_envelope_bytes" is not null
            and "crypto_domain_transition_namespaces"."candidate_ai_keyring_envelope_bytes" is not null
          )
        )
      )),
	CONSTRAINT "crypto_domain_transition_namespaces_failure_code_portable" CHECK (octet_length("crypto_domain_transition_namespaces"."failure_code") between 1
      and 128
      and "crypto_domain_transition_namespaces"."failure_code" ~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]*$'),
	CONSTRAINT "crypto_domain_transition_namespaces_time_order" CHECK ("crypto_domain_transition_namespaces"."updated_at" >= "crypto_domain_transition_namespaces"."created_at")
);
--> statement-breakpoint
ALTER TABLE "crypto_domain_transition_namespaces" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "crypto_domain_transition_steps" (
	"operation_id" text NOT NULL,
	"domain_id" text NOT NULL,
	"expected_epoch" bigint NOT NULL,
	"expected_authorization_revision" bigint NOT NULL,
	"expected_participant_digest" "bytea" NOT NULL,
	"target_epoch" bigint NOT NULL,
	"committer_device_id" text,
	"expected_provider_state_hash" "bytea",
	"candidate_provider_id" text,
	"candidate_provider_state_hash" "bytea",
	"candidate_roster_bytes" "bytea",
	"candidate_transition_digest" "bytea",
	"candidate_target_leaf_index" smallint,
	"state" text NOT NULL,
	"lease_owner" text,
	"lease_expires_at" timestamp with time zone,
	"retry_count" smallint NOT NULL,
	"failure_code" text,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "crypto_domain_transition_steps_operation_id_domain_id_pk" PRIMARY KEY("operation_id","domain_id"),
	CONSTRAINT "crypto_domain_transition_steps_operation_id_portable" CHECK (octet_length("crypto_domain_transition_steps"."operation_id") between 1
      and 128
      and "crypto_domain_transition_steps"."operation_id" ~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]*$'),
	CONSTRAINT "crypto_domain_transition_steps_domain_id_portable" CHECK (octet_length("crypto_domain_transition_steps"."domain_id") between 1
      and 128
      and "crypto_domain_transition_steps"."domain_id" ~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]*$'),
	CONSTRAINT "crypto_domain_transition_steps_expected_epoch_safe" CHECK ("crypto_domain_transition_steps"."expected_epoch" between 0 and 9007199254740991),
	CONSTRAINT "crypto_domain_transition_steps_authorization_revision_safe" CHECK ("crypto_domain_transition_steps"."expected_authorization_revision" between 0 and 9007199254740991),
	CONSTRAINT "crypto_domain_transition_steps_participant_digest_size" CHECK (octet_length("crypto_domain_transition_steps"."expected_participant_digest") = 32),
	CONSTRAINT "crypto_domain_transition_steps_target_epoch_safe" CHECK ("crypto_domain_transition_steps"."target_epoch" between 0 and 9007199254740991),
	CONSTRAINT "crypto_domain_transition_steps_epoch_advances" CHECK ("crypto_domain_transition_steps"."target_epoch" = "crypto_domain_transition_steps"."expected_epoch" + 1),
	CONSTRAINT "crypto_domain_transition_steps_committer_device_id_portable" CHECK (octet_length("crypto_domain_transition_steps"."committer_device_id") between 1
      and 128
      and "crypto_domain_transition_steps"."committer_device_id" ~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]*$'),
	CONSTRAINT "crypto_domain_transition_steps_candidate_provider_id_portable" CHECK (octet_length("crypto_domain_transition_steps"."candidate_provider_id") between 1
      and 128
      and "crypto_domain_transition_steps"."candidate_provider_id" ~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]*$'),
	CONSTRAINT "crypto_domain_transition_steps_expected_provider_state_hash_size" CHECK (octet_length("crypto_domain_transition_steps"."expected_provider_state_hash") = 32),
	CONSTRAINT "crypto_domain_transition_steps_candidate_state_hash_size" CHECK (octet_length("crypto_domain_transition_steps"."candidate_provider_state_hash") = 32),
	CONSTRAINT "crypto_domain_transition_steps_candidate_roster_size" CHECK (octet_length("crypto_domain_transition_steps"."candidate_roster_bytes") between 1
      and 1048616),
	CONSTRAINT "crypto_domain_transition_steps_candidate_transition_digest_size" CHECK (octet_length("crypto_domain_transition_steps"."candidate_transition_digest") = 32),
	CONSTRAINT "crypto_domain_transition_steps_candidate_leaf_range" CHECK ("crypto_domain_transition_steps"."candidate_target_leaf_index" between 0 and 255),
	CONSTRAINT "crypto_domain_transition_steps_candidate_coherent" CHECK ((
        "crypto_domain_transition_steps"."state" in ('awaiting_committer', 'preparing')
        and "crypto_domain_transition_steps"."expected_provider_state_hash" is null
        and "crypto_domain_transition_steps"."candidate_provider_id" is null
        and "crypto_domain_transition_steps"."candidate_provider_state_hash" is null
        and "crypto_domain_transition_steps"."candidate_roster_bytes" is null
        and "crypto_domain_transition_steps"."candidate_transition_digest" is null
        and "crypto_domain_transition_steps"."candidate_target_leaf_index" is null
      ) or (
        "crypto_domain_transition_steps"."state" in (
          'awaiting_delivery', 'ready_to_activate', 'active'
        )
        and "crypto_domain_transition_steps"."expected_provider_state_hash" is not null
        and "crypto_domain_transition_steps"."candidate_provider_id" is not null
        and "crypto_domain_transition_steps"."candidate_provider_state_hash" is not null
        and "crypto_domain_transition_steps"."candidate_roster_bytes" is not null
        and "crypto_domain_transition_steps"."candidate_transition_digest" is not null
        and "crypto_domain_transition_steps"."candidate_target_leaf_index" is not null
      ) or (
        "crypto_domain_transition_steps"."state" = 'failed'
        and (
          (
            "crypto_domain_transition_steps"."expected_provider_state_hash" is null
            and "crypto_domain_transition_steps"."candidate_provider_id" is null
            and "crypto_domain_transition_steps"."candidate_provider_state_hash" is null
            and "crypto_domain_transition_steps"."candidate_roster_bytes" is null
            and "crypto_domain_transition_steps"."candidate_transition_digest" is null
            and "crypto_domain_transition_steps"."candidate_target_leaf_index" is null
          ) or (
            "crypto_domain_transition_steps"."expected_provider_state_hash" is not null
            and "crypto_domain_transition_steps"."candidate_provider_id" is not null
            and "crypto_domain_transition_steps"."candidate_provider_state_hash" is not null
            and "crypto_domain_transition_steps"."candidate_roster_bytes" is not null
            and "crypto_domain_transition_steps"."candidate_transition_digest" is not null
            and "crypto_domain_transition_steps"."candidate_target_leaf_index" is not null
          )
        )
      )),
	CONSTRAINT "crypto_domain_transition_steps_state" CHECK ("crypto_domain_transition_steps"."state" in (
        'awaiting_committer', 'preparing', 'awaiting_delivery',
        'ready_to_activate', 'active', 'failed'
      )),
	CONSTRAINT "crypto_domain_transition_steps_lease_coherent" CHECK ((
        "crypto_domain_transition_steps"."lease_owner" is null and "crypto_domain_transition_steps"."lease_expires_at" is null
      ) or (
        "crypto_domain_transition_steps"."lease_owner" is not null
        and "crypto_domain_transition_steps"."lease_expires_at" is not null
      )),
	CONSTRAINT "crypto_domain_transition_steps_lease_owner_portable" CHECK (octet_length("crypto_domain_transition_steps"."lease_owner") between 1
      and 128
      and "crypto_domain_transition_steps"."lease_owner" ~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]*$'),
	CONSTRAINT "crypto_domain_transition_steps_retry_bound" CHECK ("crypto_domain_transition_steps"."retry_count" between 0 and 8),
	CONSTRAINT "crypto_domain_transition_steps_failure_code_portable" CHECK (octet_length("crypto_domain_transition_steps"."failure_code") between 1
      and 128
      and "crypto_domain_transition_steps"."failure_code" ~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]*$'),
	CONSTRAINT "crypto_domain_transition_steps_time_order" CHECK ("crypto_domain_transition_steps"."updated_at" >= "crypto_domain_transition_steps"."created_at")
);
--> statement-breakpoint
ALTER TABLE "crypto_domain_transition_steps" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "crypto_human_membership_transitions" (
	"operation_id" text PRIMARY KEY NOT NULL,
	"namespace_id" text NOT NULL,
	"room_id" text NOT NULL,
	"target_human_actor_id" uuid NOT NULL,
	"admitted_bootstrap_device_id" text,
	"bootstrap_device_id" text,
	"old_participants" text[] NOT NULL,
	"old_participant_digest" "bytea" NOT NULL,
	"new_participants" text[] NOT NULL,
	"new_participant_digest" "bytea" NOT NULL,
	"old_domain_id" text NOT NULL,
	"admitted_target_domain_id" text,
	"target_domain_id" text,
	"target_room_role" text,
	"expected_access_revision" bigint NOT NULL,
	"expected_binding_hash" "bytea" NOT NULL,
	"committer_device_id" text,
	"target_domain_epoch" bigint,
	"candidate_binding_hash" "bytea",
	"candidate_digest" "bytea",
	"candidate_signed_binding_bytes" "bytea",
	"candidate_human_keyring_envelope_bytes" "bytea",
	"candidate_ai_keyring_envelope_bytes" "bytea",
	"candidate_submitted_at" timestamp with time zone,
	"activated_at" timestamp with time zone,
	"released_at" timestamp with time zone,
	CONSTRAINT "crypto_human_membership_transitions_operation_id_portable" CHECK (octet_length("crypto_human_membership_transitions"."operation_id") between 1
      and 128
      and "crypto_human_membership_transitions"."operation_id" ~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]*$'),
	CONSTRAINT "crypto_human_membership_transitions_namespace_id_portable" CHECK (octet_length("crypto_human_membership_transitions"."namespace_id") between 1
      and 128
      and "crypto_human_membership_transitions"."namespace_id" ~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]*$'),
	CONSTRAINT "crypto_human_membership_transitions_room_id_portable" CHECK (octet_length("crypto_human_membership_transitions"."room_id") between 1
      and 128
      and "crypto_human_membership_transitions"."room_id" ~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]*$'),
	CONSTRAINT "crypto_human_membership_transitions_admitted_bootstrap_device_id_portable" CHECK (octet_length("crypto_human_membership_transitions"."admitted_bootstrap_device_id") between 1
      and 128
      and "crypto_human_membership_transitions"."admitted_bootstrap_device_id" ~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]*$'),
	CONSTRAINT "crypto_human_membership_transitions_bootstrap_device_id_portable" CHECK (octet_length("crypto_human_membership_transitions"."bootstrap_device_id") between 1
      and 128
      and "crypto_human_membership_transitions"."bootstrap_device_id" ~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]*$'),
	CONSTRAINT "crypto_human_membership_transitions_old_count" CHECK (cardinality("crypto_human_membership_transitions"."old_participants") between 1 and 64),
	CONSTRAINT "crypto_human_membership_transitions_old_canonical" CHECK (crypto_participants_are_canonical("crypto_human_membership_transitions"."old_participants")),
	CONSTRAINT "crypto_human_membership_transitions_old_digest_size" CHECK (octet_length("crypto_human_membership_transitions"."old_participant_digest") = 32),
	CONSTRAINT "crypto_human_membership_transitions_new_count" CHECK (cardinality("crypto_human_membership_transitions"."new_participants") between 1 and 64),
	CONSTRAINT "crypto_human_membership_transitions_new_canonical" CHECK (crypto_participants_are_canonical("crypto_human_membership_transitions"."new_participants")),
	CONSTRAINT "crypto_human_membership_transitions_new_digest_size" CHECK (octet_length("crypto_human_membership_transitions"."new_participant_digest") = 32),
	CONSTRAINT "crypto_human_membership_transitions_old_domain_id_portable" CHECK (octet_length("crypto_human_membership_transitions"."old_domain_id") between 1
      and 128
      and "crypto_human_membership_transitions"."old_domain_id" ~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]*$'),
	CONSTRAINT "crypto_human_membership_transitions_admitted_target_domain_id_portable" CHECK (octet_length("crypto_human_membership_transitions"."admitted_target_domain_id") between 1
      and 128
      and "crypto_human_membership_transitions"."admitted_target_domain_id" ~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]*$'),
	CONSTRAINT "crypto_human_membership_transitions_target_domain_id_portable" CHECK (octet_length("crypto_human_membership_transitions"."target_domain_id") between 1
      and 128
      and "crypto_human_membership_transitions"."target_domain_id" ~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]*$'),
	CONSTRAINT "crypto_human_membership_transitions_target_room_role" CHECK ("crypto_human_membership_transitions"."target_room_role" is null
        or "crypto_human_membership_transitions"."target_room_role" in ('admin', 'member')),
	CONSTRAINT "crypto_human_membership_transitions_resolution_coherent" CHECK ((
        "crypto_human_membership_transitions"."admitted_bootstrap_device_id" is null
        or "crypto_human_membership_transitions"."bootstrap_device_id" = "crypto_human_membership_transitions"."admitted_bootstrap_device_id"
      ) and (
        "crypto_human_membership_transitions"."admitted_target_domain_id" is null
        or "crypto_human_membership_transitions"."target_domain_id" = "crypto_human_membership_transitions"."admitted_target_domain_id"
      )),
	CONSTRAINT "crypto_human_membership_transitions_access_revision_safe" CHECK ("crypto_human_membership_transitions"."expected_access_revision" between 0 and 9007199254740991),
	CONSTRAINT "crypto_human_membership_transitions_binding_hash_size" CHECK (octet_length("crypto_human_membership_transitions"."expected_binding_hash") = 32),
	CONSTRAINT "crypto_human_membership_transitions_committer_device_id_portable" CHECK (octet_length("crypto_human_membership_transitions"."committer_device_id") between 1
      and 128
      and "crypto_human_membership_transitions"."committer_device_id" ~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]*$'),
	CONSTRAINT "crypto_human_membership_transitions_target_epoch_safe" CHECK ("crypto_human_membership_transitions"."target_domain_epoch" between 0 and 9007199254740991),
	CONSTRAINT "crypto_human_membership_transitions_candidate_binding_hash_size" CHECK (octet_length("crypto_human_membership_transitions"."candidate_binding_hash") = 32),
	CONSTRAINT "crypto_human_membership_transitions_candidate_digest_size" CHECK (octet_length("crypto_human_membership_transitions"."candidate_digest") = 32),
	CONSTRAINT "crypto_human_membership_transitions_candidate_signed_size" CHECK (octet_length("crypto_human_membership_transitions"."candidate_signed_binding_bytes") between 1
      and 1048616),
	CONSTRAINT "crypto_human_membership_transitions_candidate_human_keyring_size" CHECK (octet_length("crypto_human_membership_transitions"."candidate_human_keyring_envelope_bytes") between 1
      and 262144),
	CONSTRAINT "crypto_human_membership_transitions_candidate_ai_keyring_size" CHECK (octet_length("crypto_human_membership_transitions"."candidate_ai_keyring_envelope_bytes") between 1
      and 262144),
	CONSTRAINT "crypto_human_membership_transitions_candidate_coherent" CHECK ((
        "crypto_human_membership_transitions"."committer_device_id" is null
        and "crypto_human_membership_transitions"."target_domain_epoch" is null
        and "crypto_human_membership_transitions"."candidate_binding_hash" is null
        and "crypto_human_membership_transitions"."candidate_digest" is null
        and "crypto_human_membership_transitions"."candidate_signed_binding_bytes" is null
        and "crypto_human_membership_transitions"."candidate_human_keyring_envelope_bytes" is null
        and "crypto_human_membership_transitions"."candidate_ai_keyring_envelope_bytes" is null
        and "crypto_human_membership_transitions"."candidate_submitted_at" is null
      ) or (
        "crypto_human_membership_transitions"."committer_device_id" is not null
        and "crypto_human_membership_transitions"."target_domain_id" is not null
        and "crypto_human_membership_transitions"."target_domain_epoch" is not null
        and "crypto_human_membership_transitions"."candidate_binding_hash" is not null
        and "crypto_human_membership_transitions"."candidate_digest" is not null
        and "crypto_human_membership_transitions"."candidate_signed_binding_bytes" is not null
        and "crypto_human_membership_transitions"."candidate_human_keyring_envelope_bytes" is not null
        and "crypto_human_membership_transitions"."candidate_ai_keyring_envelope_bytes" is not null
        and "crypto_human_membership_transitions"."candidate_submitted_at" is not null
      )),
	CONSTRAINT "crypto_human_membership_transitions_terminal_coherent" CHECK ((
        "crypto_human_membership_transitions"."activated_at" is null
      ) or (
        "crypto_human_membership_transitions"."released_at" = "crypto_human_membership_transitions"."activated_at"
      ))
);
--> statement-breakpoint
ALTER TABLE "crypto_human_membership_transitions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "crypto_operation_outbox" (
	"outbox_id" text PRIMARY KEY NOT NULL,
	"operation_id" text NOT NULL,
	"sequence" bigint NOT NULL,
	"event_type" text NOT NULL,
	"payload_bytes" "bytea" NOT NULL,
	"idempotency_key" text NOT NULL,
	"claimed_by" text,
	"claim_expires_at" timestamp with time zone,
	"attempts" smallint NOT NULL,
	"maximum_attempts" smallint NOT NULL,
	"delivered_at" timestamp with time zone,
	"terminal_at" timestamp with time zone,
	"failure_code" text,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "uq_crypto_operation_outbox_idempotency" UNIQUE("idempotency_key"),
	CONSTRAINT "uq_crypto_operation_outbox_sequence" UNIQUE("operation_id","sequence"),
	CONSTRAINT "crypto_operation_outbox_id_portable" CHECK (octet_length("crypto_operation_outbox"."outbox_id") between 1
      and 128
      and "crypto_operation_outbox"."outbox_id" ~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]*$'),
	CONSTRAINT "crypto_operation_outbox_operation_id_portable" CHECK (octet_length("crypto_operation_outbox"."operation_id") between 1
      and 128
      and "crypto_operation_outbox"."operation_id" ~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]*$'),
	CONSTRAINT "crypto_operation_outbox_sequence_safe" CHECK ("crypto_operation_outbox"."sequence" between 0 and 9007199254740991),
	CONSTRAINT "crypto_operation_outbox_event_type_portable" CHECK (octet_length("crypto_operation_outbox"."event_type") between 1
      and 128
      and "crypto_operation_outbox"."event_type" ~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]*$'),
	CONSTRAINT "crypto_operation_outbox_payload_size" CHECK (octet_length("crypto_operation_outbox"."payload_bytes") between 1
      and 4096),
	CONSTRAINT "crypto_operation_outbox_idempotency_portable" CHECK (octet_length("crypto_operation_outbox"."idempotency_key") between 1
      and 128
      and "crypto_operation_outbox"."idempotency_key" ~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]*$'),
	CONSTRAINT "crypto_operation_outbox_claim_coherent" CHECK ((
        "crypto_operation_outbox"."claimed_by" is null and "crypto_operation_outbox"."claim_expires_at" is null
      ) or (
        "crypto_operation_outbox"."claimed_by" is not null
        and "crypto_operation_outbox"."claim_expires_at" is not null
      )),
	CONSTRAINT "crypto_operation_outbox_claimed_by_portable" CHECK (octet_length("crypto_operation_outbox"."claimed_by") between 1
      and 128
      and "crypto_operation_outbox"."claimed_by" ~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]*$'),
	CONSTRAINT "crypto_operation_outbox_attempts_bound" CHECK ("crypto_operation_outbox"."attempts" between 0 and "crypto_operation_outbox"."maximum_attempts"
        and "crypto_operation_outbox"."maximum_attempts" = 8),
	CONSTRAINT "crypto_operation_outbox_terminal_coherent" CHECK (not (
        "crypto_operation_outbox"."delivered_at" is not null and "crypto_operation_outbox"."terminal_at" is not null
      )),
	CONSTRAINT "crypto_operation_outbox_failure_code_portable" CHECK (octet_length("crypto_operation_outbox"."failure_code") between 1
      and 128
      and "crypto_operation_outbox"."failure_code" ~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]*$')
);
--> statement-breakpoint
ALTER TABLE "crypto_operation_outbox" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "human_crypto_custodies" (
	"human_id" text PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"human_actor_id" uuid NOT NULL,
	"initial_installation_lineage_digest" "bytea" NOT NULL,
	"state" text NOT NULL,
	"ever_initialized_at" timestamp with time zone,
	"first_device_id" text,
	"current_recovery_generation" bigint,
	"current_recovery_public_key_digest" "bytea",
	"current_inventory_revision" bigint,
	"current_inventory_count" integer,
	"current_inventory_digest" "bytea",
	"revision" bigint NOT NULL,
	"last_transition_audit_ref" text,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "uq_human_crypto_custodies_user" UNIQUE("user_id"),
	CONSTRAINT "uq_human_crypto_custodies_actor" UNIQUE("human_actor_id"),
	CONSTRAINT "human_crypto_custodies_human_id_portable" CHECK (octet_length("human_crypto_custodies"."human_id") between 1
      and 128
      and "human_crypto_custodies"."human_id" ~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]*$'),
	CONSTRAINT "human_crypto_custodies_lineage_digest_size" CHECK (octet_length("human_crypto_custodies"."initial_installation_lineage_digest") = 32),
	CONSTRAINT "human_crypto_custodies_state" CHECK ("human_crypto_custodies"."state" in ('initializing', 'active', 'recovery_required')),
	CONSTRAINT "human_crypto_custodies_initialization_coherent" CHECK ((
        "human_crypto_custodies"."ever_initialized_at" is null
        and "human_crypto_custodies"."state" = 'initializing'
        and "human_crypto_custodies"."first_device_id" is null
        and "human_crypto_custodies"."current_recovery_generation" is null
        and "human_crypto_custodies"."current_recovery_public_key_digest" is null
      ) or (
        "human_crypto_custodies"."ever_initialized_at" is not null
        and "human_crypto_custodies"."state" in ('active', 'recovery_required')
        and "human_crypto_custodies"."first_device_id" is not null
        and "human_crypto_custodies"."current_recovery_generation" >= 1
        and octet_length("human_crypto_custodies"."current_recovery_public_key_digest")
          = 32
      )),
	CONSTRAINT "human_crypto_custodies_first_device_id_portable" CHECK (octet_length("human_crypto_custodies"."first_device_id") between 1
      and 128
      and "human_crypto_custodies"."first_device_id" ~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]*$'),
	CONSTRAINT "human_crypto_custodies_recovery_generation_safe" CHECK ("human_crypto_custodies"."current_recovery_generation" between 0 and 9007199254740991),
	CONSTRAINT "human_crypto_custodies_recovery_digest_size" CHECK (octet_length("human_crypto_custodies"."current_recovery_public_key_digest") = 32),
	CONSTRAINT "human_crypto_custodies_inventory_coherent" CHECK ((
        "human_crypto_custodies"."current_inventory_revision" is null
        and "human_crypto_custodies"."current_inventory_count" is null
        and "human_crypto_custodies"."current_inventory_digest" is null
      ) or (
        "human_crypto_custodies"."current_inventory_revision" >= 0
        and "human_crypto_custodies"."current_inventory_count" between 1 and 4096
        and octet_length("human_crypto_custodies"."current_inventory_digest") = 32
      )),
	CONSTRAINT "human_crypto_custodies_inventory_revision_safe" CHECK ("human_crypto_custodies"."current_inventory_revision" between 0 and 9007199254740991),
	CONSTRAINT "human_crypto_custodies_inventory_digest_size" CHECK (octet_length("human_crypto_custodies"."current_inventory_digest") = 32),
	CONSTRAINT "human_crypto_custodies_revision_safe" CHECK ("human_crypto_custodies"."revision" between 0 and 9007199254740991),
	CONSTRAINT "human_crypto_custodies_audit_ref_portable" CHECK (octet_length("human_crypto_custodies"."last_transition_audit_ref") between 1
      and 128
      and "human_crypto_custodies"."last_transition_audit_ref" ~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]*$')
);
--> statement-breakpoint
ALTER TABLE "human_crypto_custodies" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "human_crypto_device_challenges" (
	"challenge_id" text PRIMARY KEY NOT NULL,
	"challenge_hash" "bytea" NOT NULL,
	"kind" text NOT NULL,
	"bootstrap_context" text,
	"bootstrap_authority_id" text,
	"human_id" text NOT NULL,
	"user_id" uuid NOT NULL,
	"human_actor_id" uuid NOT NULL,
	"installation_lineage_digest" "bytea" NOT NULL,
	"authorization_digest" "bytea" NOT NULL,
	"pending_device_id" text NOT NULL,
	"signing_public_key_digest" "bytea" NOT NULL,
	"encryption_public_key_digest" "bytea" NOT NULL,
	"recovery_public_key_digest" "bytea",
	"expected_response_digest" "bytea",
	"expected_custody_revision" bigint NOT NULL,
	"expected_recovery_generation" bigint,
	"idempotency_key" text NOT NULL,
	"issued_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"invalidated_at" timestamp with time zone,
	"terminal_result_code" text,
	"receipt_audit_ref" text,
	"revision" bigint NOT NULL,
	CONSTRAINT "uq_human_crypto_device_challenges_hash" UNIQUE("challenge_hash"),
	CONSTRAINT "uq_human_crypto_device_challenges_idempotency" UNIQUE("human_id","kind","idempotency_key"),
	CONSTRAINT "human_crypto_device_challenges_id_portable" CHECK (octet_length("human_crypto_device_challenges"."challenge_id") between 1
      and 128
      and "human_crypto_device_challenges"."challenge_id" ~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]*$'),
	CONSTRAINT "human_crypto_device_challenges_hash_size" CHECK (octet_length("human_crypto_device_challenges"."challenge_hash") = 32),
	CONSTRAINT "human_crypto_device_challenges_kind" CHECK ("human_crypto_device_challenges"."kind" in (
        'initial_bootstrap', 'device_approval', 'device_recovery'
      )),
	CONSTRAINT "human_crypto_device_challenges_context" CHECK ((
        "human_crypto_device_challenges"."kind" = 'initial_bootstrap'
        and "human_crypto_device_challenges"."bootstrap_context" in (
          'preparation', 'greenfield_initial_owner',
          'pending_encrypted_invite'
        )
      ) or (
        "human_crypto_device_challenges"."kind" <> 'initial_bootstrap'
        and "human_crypto_device_challenges"."bootstrap_context" is null
      )),
	CONSTRAINT "human_crypto_device_challenges_bootstrap_authority" CHECK ((
        "human_crypto_device_challenges"."bootstrap_context" = 'pending_encrypted_invite'
        and "human_crypto_device_challenges"."bootstrap_authority_id" is not null
      ) or (
        "human_crypto_device_challenges"."bootstrap_context" <> 'pending_encrypted_invite'
        or "human_crypto_device_challenges"."bootstrap_context" is null
      )),
	CONSTRAINT "human_crypto_device_challenges_bootstrap_authority_portable" CHECK (octet_length("human_crypto_device_challenges"."bootstrap_authority_id") between 1
      and 128
      and "human_crypto_device_challenges"."bootstrap_authority_id" ~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]*$'),
	CONSTRAINT "human_crypto_device_challenges_human_id_portable" CHECK (octet_length("human_crypto_device_challenges"."human_id") between 1
      and 128
      and "human_crypto_device_challenges"."human_id" ~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]*$'),
	CONSTRAINT "human_crypto_device_challenges_lineage_size" CHECK (octet_length("human_crypto_device_challenges"."installation_lineage_digest") = 32),
	CONSTRAINT "human_crypto_device_challenges_authorization_size" CHECK (octet_length("human_crypto_device_challenges"."authorization_digest") = 32),
	CONSTRAINT "human_crypto_device_challenges_device_id_portable" CHECK (octet_length("human_crypto_device_challenges"."pending_device_id") between 1
      and 128
      and "human_crypto_device_challenges"."pending_device_id" ~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]*$'),
	CONSTRAINT "human_crypto_device_challenges_signing_digest_size" CHECK (octet_length("human_crypto_device_challenges"."signing_public_key_digest") = 32),
	CONSTRAINT "human_crypto_device_challenges_encryption_digest_size" CHECK (octet_length("human_crypto_device_challenges"."encryption_public_key_digest") = 32),
	CONSTRAINT "human_crypto_device_challenges_recovery_digest_size" CHECK (octet_length("human_crypto_device_challenges"."recovery_public_key_digest") = 32),
	CONSTRAINT "human_crypto_device_challenges_recovery_coherent" CHECK ((
        "human_crypto_device_challenges"."kind" = 'initial_bootstrap'
        and "human_crypto_device_challenges"."recovery_public_key_digest" is not null
        and "human_crypto_device_challenges"."expected_recovery_generation" is null
      ) or (
        "human_crypto_device_challenges"."kind" in ('device_approval', 'device_recovery')
        and "human_crypto_device_challenges"."recovery_public_key_digest" is null
        and "human_crypto_device_challenges"."expected_recovery_generation" >= 1
      )),
	CONSTRAINT "human_crypto_device_challenges_response_digest_coherent" CHECK ("human_crypto_device_challenges"."expected_response_digest" is null
        or "human_crypto_device_challenges"."kind" = 'device_recovery'),
	CONSTRAINT "human_crypto_device_challenges_response_digest_size" CHECK (octet_length("human_crypto_device_challenges"."expected_response_digest") = 32),
	CONSTRAINT "human_crypto_device_challenges_custody_revision_safe" CHECK ("human_crypto_device_challenges"."expected_custody_revision" between 0 and 9007199254740991),
	CONSTRAINT "human_crypto_device_challenges_recovery_generation_safe" CHECK ("human_crypto_device_challenges"."expected_recovery_generation" between 0 and 9007199254740991),
	CONSTRAINT "human_crypto_device_challenges_idempotency_portable" CHECK (octet_length("human_crypto_device_challenges"."idempotency_key") between 1
      and 128
      and "human_crypto_device_challenges"."idempotency_key" ~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]*$'),
	CONSTRAINT "human_crypto_device_challenges_expiry" CHECK ("human_crypto_device_challenges"."expires_at" > "human_crypto_device_challenges"."issued_at"
        and "human_crypto_device_challenges"."expires_at"
          <= "human_crypto_device_challenges"."issued_at"
            + interval '300 seconds'),
	CONSTRAINT "human_crypto_device_challenges_terminal_coherent" CHECK (not (
        "human_crypto_device_challenges"."consumed_at" is not null
        and "human_crypto_device_challenges"."invalidated_at" is not null
      )
      and (
        "human_crypto_device_challenges"."consumed_at" is null
        or "human_crypto_device_challenges"."consumed_at" >= "human_crypto_device_challenges"."issued_at"
      )
      and (
        "human_crypto_device_challenges"."invalidated_at" is null
        or "human_crypto_device_challenges"."invalidated_at" >= "human_crypto_device_challenges"."issued_at"
      )),
	CONSTRAINT "human_crypto_device_challenges_terminal_result_coherent" CHECK ((
        "human_crypto_device_challenges"."consumed_at" is null
        and "human_crypto_device_challenges"."invalidated_at" is null
        and "human_crypto_device_challenges"."terminal_result_code" is null
        and "human_crypto_device_challenges"."receipt_audit_ref" is null
      ) or (
        "human_crypto_device_challenges"."consumed_at" is not null
        and "human_crypto_device_challenges"."terminal_result_code" is not null
        and "human_crypto_device_challenges"."receipt_audit_ref" is not null
      ) or (
        "human_crypto_device_challenges"."invalidated_at" is not null
        and "human_crypto_device_challenges"."terminal_result_code" is not null
      )),
	CONSTRAINT "human_crypto_device_challenges_result_code_portable" CHECK (octet_length("human_crypto_device_challenges"."terminal_result_code") between 1
      and 128
      and "human_crypto_device_challenges"."terminal_result_code" ~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]*$'),
	CONSTRAINT "human_crypto_device_challenges_receipt_ref_portable" CHECK (octet_length("human_crypto_device_challenges"."receipt_audit_ref") between 1
      and 128
      and "human_crypto_device_challenges"."receipt_audit_ref" ~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]*$'),
	CONSTRAINT "human_crypto_device_challenges_revision_safe" CHECK ("human_crypto_device_challenges"."revision" between 0 and 9007199254740991)
);
--> statement-breakpoint
ALTER TABLE "human_crypto_device_challenges" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "human_crypto_device_key_packages" (
	"device_id" text NOT NULL,
	"domain_id" text NOT NULL,
	"expected_provider_head_hash" "bytea" NOT NULL,
	"generation" bigint NOT NULL,
	"package_id" text NOT NULL,
	"package_hash" "bytea" NOT NULL,
	"format_version" smallint NOT NULL,
	"package_bytes" "bytea" NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"consuming_operation_id" text,
	CONSTRAINT "human_crypto_device_key_packages_device_id_generation_package_id_pk" PRIMARY KEY("device_id","generation","package_id"),
	CONSTRAINT "uq_human_crypto_device_key_packages_hash" UNIQUE("package_hash"),
	CONSTRAINT "human_crypto_device_key_packages_device_id_portable" CHECK (octet_length("human_crypto_device_key_packages"."device_id") between 1
      and 128
      and "human_crypto_device_key_packages"."device_id" ~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]*$'),
	CONSTRAINT "human_crypto_device_key_packages_domain_id_portable" CHECK (octet_length("human_crypto_device_key_packages"."domain_id") between 1
      and 128
      and "human_crypto_device_key_packages"."domain_id" ~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]*$'),
	CONSTRAINT "human_crypto_device_key_packages_provider_head_hash_size" CHECK (octet_length("human_crypto_device_key_packages"."expected_provider_head_hash") = 32),
	CONSTRAINT "human_crypto_device_key_packages_generation_safe" CHECK ("human_crypto_device_key_packages"."generation" between 0 and 9007199254740991),
	CONSTRAINT "human_crypto_device_key_packages_package_id_portable" CHECK (octet_length("human_crypto_device_key_packages"."package_id") between 1
      and 128
      and "human_crypto_device_key_packages"."package_id" ~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]*$'),
	CONSTRAINT "human_crypto_device_key_packages_hash_size" CHECK (octet_length("human_crypto_device_key_packages"."package_hash") = 32),
	CONSTRAINT "human_crypto_device_key_packages_format_version" CHECK ("human_crypto_device_key_packages"."format_version" = 1),
	CONSTRAINT "human_crypto_device_key_packages_bytes_size" CHECK (octet_length("human_crypto_device_key_packages"."package_bytes") between 1
      and 1048616),
	CONSTRAINT "human_crypto_device_key_packages_expiry" CHECK ("human_crypto_device_key_packages"."expires_at" > "human_crypto_device_key_packages"."created_at"),
	CONSTRAINT "human_crypto_device_key_packages_consumption_coherent" CHECK ((
        "human_crypto_device_key_packages"."consumed_at" is null
        and "human_crypto_device_key_packages"."consuming_operation_id" is null
      ) or (
        "human_crypto_device_key_packages"."consumed_at" is not null
        and "human_crypto_device_key_packages"."consuming_operation_id" is not null
      )),
	CONSTRAINT "human_crypto_device_key_packages_operation_id_portable" CHECK (octet_length("human_crypto_device_key_packages"."consuming_operation_id") between 1
      and 128
      and "human_crypto_device_key_packages"."consuming_operation_id" ~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]*$')
);
--> statement-breakpoint
ALTER TABLE "human_crypto_device_key_packages" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "human_crypto_devices" (
	"device_id" text PRIMARY KEY NOT NULL,
	"human_id" text NOT NULL,
	"user_id" uuid NOT NULL,
	"human_actor_id" uuid NOT NULL,
	"client_kind" text NOT NULL,
	"installation_lineage_digest" "bytea" NOT NULL,
	"device_generation" bigint NOT NULL,
	"signing_public_key" "bytea" NOT NULL,
	"encryption_public_key" "bytea" NOT NULL,
	"public_fingerprint" "bytea" NOT NULL,
	"state" text NOT NULL,
	"authorization_kind" text NOT NULL,
	"approval_generation" bigint,
	"recovery_generation" bigint,
	"authorization_evidence_digest" "bytea" NOT NULL,
	"key_package_generation" bigint NOT NULL,
	"key_package_count" integer NOT NULL,
	"delivery_sequence_high_watermark" bigint DEFAULT 0 NOT NULL,
	"delivery_acknowledged_sequence" bigint DEFAULT 0 NOT NULL,
	"delivery_blocked_sequence" bigint,
	"delivery_blocked_operation_id" text,
	"delivery_blocked_at" timestamp with time zone,
	"delivery_blocked_reason" text,
	"revision" bigint NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"activated_at" timestamp with time zone,
	"last_seen_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"rejected_at" timestamp with time zone,
	CONSTRAINT "uq_human_crypto_devices_fingerprint" UNIQUE("public_fingerprint"),
	CONSTRAINT "human_crypto_devices_device_id_portable" CHECK (octet_length("human_crypto_devices"."device_id") between 1
      and 128
      and "human_crypto_devices"."device_id" ~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]*$'),
	CONSTRAINT "human_crypto_devices_human_id_portable" CHECK (octet_length("human_crypto_devices"."human_id") between 1
      and 128
      and "human_crypto_devices"."human_id" ~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]*$'),
	CONSTRAINT "human_crypto_devices_client_kind" CHECK ("human_crypto_devices"."client_kind" in ('browser', 'electron', 'tui')),
	CONSTRAINT "human_crypto_devices_lineage_digest_size" CHECK (octet_length("human_crypto_devices"."installation_lineage_digest") = 32),
	CONSTRAINT "human_crypto_devices_generation_safe" CHECK ("human_crypto_devices"."device_generation" between 0 and 9007199254740991),
	CONSTRAINT "human_crypto_devices_signing_key_size" CHECK (octet_length("human_crypto_devices"."signing_public_key") = 32),
	CONSTRAINT "human_crypto_devices_encryption_key_size" CHECK (octet_length("human_crypto_devices"."encryption_public_key") = 65),
	CONSTRAINT "human_crypto_devices_fingerprint_size" CHECK (octet_length("human_crypto_devices"."public_fingerprint") = 32),
	CONSTRAINT "human_crypto_devices_state" CHECK ("human_crypto_devices"."state" in ('pending', 'active', 'revoked', 'rejected')),
	CONSTRAINT "human_crypto_devices_authorization_kind" CHECK ("human_crypto_devices"."authorization_kind" in (
        'first_bootstrap', 'device_approval', 'recovery'
      )),
	CONSTRAINT "human_crypto_devices_authorization_coherent" CHECK ((
        "human_crypto_devices"."authorization_kind" = 'first_bootstrap'
        and "human_crypto_devices"."approval_generation" is null
        and "human_crypto_devices"."recovery_generation" = 1
      ) or (
        "human_crypto_devices"."authorization_kind" = 'device_approval'
        and "human_crypto_devices"."approval_generation" >= 1
        and "human_crypto_devices"."recovery_generation" is null
      ) or (
        "human_crypto_devices"."authorization_kind" = 'recovery'
        and "human_crypto_devices"."approval_generation" is null
        and "human_crypto_devices"."recovery_generation" >= 1
      )),
	CONSTRAINT "human_crypto_devices_approval_generation_safe" CHECK ("human_crypto_devices"."approval_generation" between 0 and 9007199254740991),
	CONSTRAINT "human_crypto_devices_recovery_generation_safe" CHECK ("human_crypto_devices"."recovery_generation" between 0 and 9007199254740991),
	CONSTRAINT "human_crypto_devices_evidence_digest_size" CHECK (octet_length("human_crypto_devices"."authorization_evidence_digest") = 32),
	CONSTRAINT "human_crypto_devices_key_package_generation_safe" CHECK ("human_crypto_devices"."key_package_generation" between 0 and 9007199254740991),
	CONSTRAINT "human_crypto_devices_key_package_count" CHECK ("human_crypto_devices"."key_package_count" between 0 and 16),
	CONSTRAINT "human_crypto_devices_delivery_high_watermark_safe" CHECK ("human_crypto_devices"."delivery_sequence_high_watermark" between 0 and 9007199254740991),
	CONSTRAINT "human_crypto_devices_delivery_acknowledged_safe" CHECK ("human_crypto_devices"."delivery_acknowledged_sequence" between 0 and 9007199254740991),
	CONSTRAINT "human_crypto_devices_delivery_cursor_coherent" CHECK ("human_crypto_devices"."delivery_acknowledged_sequence"
        <= "human_crypto_devices"."delivery_sequence_high_watermark"),
	CONSTRAINT "human_crypto_devices_delivery_blocked_sequence_safe" CHECK ("human_crypto_devices"."delivery_blocked_sequence" between 0 and 9007199254740991),
	CONSTRAINT "human_crypto_devices_delivery_blocked_operation_id_portable" CHECK (octet_length("human_crypto_devices"."delivery_blocked_operation_id") between 1
      and 128
      and "human_crypto_devices"."delivery_blocked_operation_id" ~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]*$'),
	CONSTRAINT "human_crypto_devices_delivery_blocked_reason_portable" CHECK (octet_length("human_crypto_devices"."delivery_blocked_reason") between 1
      and 128
      and "human_crypto_devices"."delivery_blocked_reason" ~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]*$'),
	CONSTRAINT "human_crypto_devices_delivery_blocked_coherent" CHECK ((
        "human_crypto_devices"."delivery_blocked_sequence" is null
        and "human_crypto_devices"."delivery_blocked_operation_id" is null
        and "human_crypto_devices"."delivery_blocked_at" is null
        and "human_crypto_devices"."delivery_blocked_reason" is null
      ) or (
        "human_crypto_devices"."delivery_blocked_sequence"
          = "human_crypto_devices"."delivery_acknowledged_sequence" + 1
        and "human_crypto_devices"."delivery_blocked_sequence"
          <= "human_crypto_devices"."delivery_sequence_high_watermark"
        and "human_crypto_devices"."delivery_blocked_operation_id" is not null
        and "human_crypto_devices"."delivery_blocked_at" is not null
        and "human_crypto_devices"."delivery_blocked_at" >= "human_crypto_devices"."created_at"
        and "human_crypto_devices"."delivery_blocked_reason" = 'delivery_expired'
      )),
	CONSTRAINT "human_crypto_devices_revision_safe" CHECK ("human_crypto_devices"."revision" between 0 and 9007199254740991),
	CONSTRAINT "human_crypto_devices_lifecycle_coherent" CHECK ((
        "human_crypto_devices"."state" = 'pending'
        and "human_crypto_devices"."activated_at" is null
        and "human_crypto_devices"."revoked_at" is null
        and "human_crypto_devices"."rejected_at" is null
      ) or (
        "human_crypto_devices"."state" = 'active'
        and "human_crypto_devices"."activated_at" is not null
        and "human_crypto_devices"."revoked_at" is null
        and "human_crypto_devices"."rejected_at" is null
      ) or (
        "human_crypto_devices"."state" = 'revoked'
        and "human_crypto_devices"."activated_at" is not null
        and "human_crypto_devices"."revoked_at" is not null
        and "human_crypto_devices"."rejected_at" is null
      ) or (
        "human_crypto_devices"."state" = 'rejected'
        and "human_crypto_devices"."activated_at" is null
        and "human_crypto_devices"."revoked_at" is null
        and "human_crypto_devices"."rejected_at" is not null
      )),
	CONSTRAINT "human_crypto_devices_time_order" CHECK (("human_crypto_devices"."activated_at" is null or "human_crypto_devices"."activated_at" >= "human_crypto_devices"."created_at")
        and ("human_crypto_devices"."last_seen_at" is null or "human_crypto_devices"."last_seen_at" >= "human_crypto_devices"."created_at")
        and ("human_crypto_devices"."revoked_at" is null or "human_crypto_devices"."revoked_at" >= "human_crypto_devices"."activated_at")
        and ("human_crypto_devices"."rejected_at" is null or "human_crypto_devices"."rejected_at" >= "human_crypto_devices"."created_at"))
);
--> statement-breakpoint
ALTER TABLE "human_crypto_devices" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "human_crypto_recovery_keys" (
	"human_id" text NOT NULL,
	"generation" bigint NOT NULL,
	"recovery_key_id" text NOT NULL,
	"format_version" smallint NOT NULL,
	"public_key" "bytea" NOT NULL,
	"public_key_digest" "bytea" NOT NULL,
	"archive_hash" "bytea" NOT NULL,
	"issuer_device_id" text NOT NULL,
	"state" text NOT NULL,
	"activated_at" timestamp with time zone NOT NULL,
	"retired_at" timestamp with time zone,
	"revision" bigint NOT NULL,
	CONSTRAINT "human_crypto_recovery_keys_human_id_generation_pk" PRIMARY KEY("human_id","generation"),
	CONSTRAINT "uq_human_crypto_recovery_keys_key_id" UNIQUE("recovery_key_id"),
	CONSTRAINT "uq_human_crypto_recovery_keys_digest" UNIQUE("human_id","public_key_digest"),
	CONSTRAINT "human_crypto_recovery_keys_human_id_portable" CHECK (octet_length("human_crypto_recovery_keys"."human_id") between 1
      and 128
      and "human_crypto_recovery_keys"."human_id" ~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]*$'),
	CONSTRAINT "human_crypto_recovery_keys_generation_safe" CHECK ("human_crypto_recovery_keys"."generation" between 0 and 9007199254740991),
	CONSTRAINT "human_crypto_recovery_keys_key_id_portable" CHECK (octet_length("human_crypto_recovery_keys"."recovery_key_id") between 1
      and 128
      and "human_crypto_recovery_keys"."recovery_key_id" ~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]*$'),
	CONSTRAINT "human_crypto_recovery_keys_format_version" CHECK ("human_crypto_recovery_keys"."format_version" = 1),
	CONSTRAINT "human_crypto_recovery_keys_public_key_size" CHECK (octet_length("human_crypto_recovery_keys"."public_key") = 65),
	CONSTRAINT "human_crypto_recovery_keys_public_digest_size" CHECK (octet_length("human_crypto_recovery_keys"."public_key_digest") = 32),
	CONSTRAINT "human_crypto_recovery_keys_archive_hash_size" CHECK (octet_length("human_crypto_recovery_keys"."archive_hash") = 32),
	CONSTRAINT "human_crypto_recovery_keys_issuer_id_portable" CHECK (octet_length("human_crypto_recovery_keys"."issuer_device_id") between 1
      and 128
      and "human_crypto_recovery_keys"."issuer_device_id" ~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]*$'),
	CONSTRAINT "human_crypto_recovery_keys_state" CHECK ("human_crypto_recovery_keys"."state" in ('current', 'retired')),
	CONSTRAINT "human_crypto_recovery_keys_retirement_coherent" CHECK ((
        "human_crypto_recovery_keys"."state" = 'current' and "human_crypto_recovery_keys"."retired_at" is null
      ) or (
        "human_crypto_recovery_keys"."state" = 'retired' and "human_crypto_recovery_keys"."retired_at" is not null
      )),
	CONSTRAINT "human_crypto_recovery_keys_revision_safe" CHECK ("human_crypto_recovery_keys"."revision" between 0 and 9007199254740991)
);
--> statement-breakpoint
ALTER TABLE "human_crypto_recovery_keys" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "crypto_domains" ADD COLUMN "writes_paused" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "crypto_domains" ADD COLUMN "pause_operation_id" text;--> statement-breakpoint
ALTER TABLE "namespace_crypto_heads" ADD COLUMN "writes_paused" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "namespace_crypto_heads" ADD COLUMN "pause_operation_id" text;--> statement-breakpoint
ALTER TABLE "crypto_delivery_acknowledgements" ADD CONSTRAINT "crypto_delivery_acknowledgements_recipient_fk" FOREIGN KEY ("message_id","device_id") REFERENCES "public"."crypto_delivery_messages"("message_id","recipient_device_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crypto_delivery_messages" ADD CONSTRAINT "crypto_delivery_messages_operation_fk" FOREIGN KEY ("operation_id") REFERENCES "public"."crypto_delivery_operations"("operation_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crypto_delivery_messages" ADD CONSTRAINT "crypto_delivery_messages_domain_fk" FOREIGN KEY ("domain_id") REFERENCES "public"."crypto_domains"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crypto_delivery_messages" ADD CONSTRAINT "crypto_delivery_messages_recipient_fk" FOREIGN KEY ("recipient_device_id") REFERENCES "public"."human_crypto_devices"("device_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crypto_delivery_operations" ADD CONSTRAINT "crypto_delivery_operations_human_fk" FOREIGN KEY ("human_id") REFERENCES "public"."human_crypto_custodies"("human_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crypto_delivery_operations" ADD CONSTRAINT "crypto_delivery_operations_target_human_fk" FOREIGN KEY ("target_human_id") REFERENCES "public"."human_crypto_custodies"("human_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crypto_delivery_operations" ADD CONSTRAINT "crypto_delivery_operations_target_device_fk" FOREIGN KEY ("target_device_id") REFERENCES "public"."human_crypto_devices"("device_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crypto_device_epoch_operations" ADD CONSTRAINT "crypto_device_epoch_operations_operation_fk" FOREIGN KEY ("operation_id") REFERENCES "public"."crypto_delivery_operations"("operation_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crypto_device_epoch_operations" ADD CONSTRAINT "crypto_device_epoch_operations_target_device_fk" FOREIGN KEY ("target_device_id") REFERENCES "public"."human_crypto_devices"("device_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crypto_device_epoch_operations" ADD CONSTRAINT "crypto_device_epoch_operations_custody_fk" FOREIGN KEY ("owner_human_id") REFERENCES "public"."human_crypto_custodies"("human_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crypto_device_epoch_operations" ADD CONSTRAINT "crypto_device_epoch_operations_source_device_fk" FOREIGN KEY ("source_device_id") REFERENCES "public"."human_crypto_devices"("device_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crypto_domain_devices" ADD CONSTRAINT "crypto_domain_devices_domain_fk" FOREIGN KEY ("domain_id") REFERENCES "public"."crypto_domains"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crypto_domain_devices" ADD CONSTRAINT "crypto_domain_devices_device_fk" FOREIGN KEY ("device_id") REFERENCES "public"."human_crypto_devices"("device_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crypto_domain_devices" ADD CONSTRAINT "crypto_domain_devices_custody_fk" FOREIGN KEY ("human_id") REFERENCES "public"."human_crypto_custodies"("human_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crypto_domain_transition_namespaces" ADD CONSTRAINT "crypto_domain_transition_namespaces_domain_step_fk" FOREIGN KEY ("operation_id","domain_id") REFERENCES "public"."crypto_domain_transition_steps"("operation_id","domain_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crypto_domain_transition_steps" ADD CONSTRAINT "crypto_domain_transition_steps_operation_fk" FOREIGN KEY ("operation_id") REFERENCES "public"."crypto_delivery_operations"("operation_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crypto_domain_transition_steps" ADD CONSTRAINT "crypto_domain_transition_steps_domain_fk" FOREIGN KEY ("domain_id") REFERENCES "public"."crypto_domains"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crypto_domain_transition_steps" ADD CONSTRAINT "crypto_domain_transition_steps_committer_fk" FOREIGN KEY ("committer_device_id") REFERENCES "public"."human_crypto_devices"("device_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crypto_human_membership_transitions" ADD CONSTRAINT "crypto_human_membership_transitions_operation_fk" FOREIGN KEY ("operation_id") REFERENCES "public"."crypto_delivery_operations"("operation_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crypto_human_membership_transitions" ADD CONSTRAINT "crypto_human_membership_transitions_target_actor_fk" FOREIGN KEY ("target_human_actor_id") REFERENCES "public"."actors"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crypto_human_membership_transitions" ADD CONSTRAINT "crypto_human_membership_transitions_admitted_bootstrap_device_fk" FOREIGN KEY ("admitted_bootstrap_device_id") REFERENCES "public"."human_crypto_devices"("device_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crypto_human_membership_transitions" ADD CONSTRAINT "crypto_human_membership_transitions_bootstrap_device_fk" FOREIGN KEY ("bootstrap_device_id") REFERENCES "public"."human_crypto_devices"("device_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crypto_human_membership_transitions" ADD CONSTRAINT "crypto_human_membership_transitions_old_domain_fk" FOREIGN KEY ("old_domain_id") REFERENCES "public"."crypto_domains"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crypto_human_membership_transitions" ADD CONSTRAINT "crypto_human_membership_transitions_admitted_target_domain_fk" FOREIGN KEY ("admitted_target_domain_id") REFERENCES "public"."crypto_domains"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crypto_human_membership_transitions" ADD CONSTRAINT "crypto_human_membership_transitions_target_domain_fk" FOREIGN KEY ("target_domain_id") REFERENCES "public"."crypto_domains"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crypto_human_membership_transitions" ADD CONSTRAINT "crypto_human_membership_transitions_committer_device_fk" FOREIGN KEY ("committer_device_id") REFERENCES "public"."human_crypto_devices"("device_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crypto_operation_outbox" ADD CONSTRAINT "crypto_operation_outbox_operation_fk" FOREIGN KEY ("operation_id") REFERENCES "public"."crypto_delivery_operations"("operation_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "human_crypto_custodies" ADD CONSTRAINT "human_crypto_custodies_user_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "human_crypto_custodies" ADD CONSTRAINT "human_crypto_custodies_actor_fk" FOREIGN KEY ("human_actor_id") REFERENCES "public"."actors"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "human_crypto_device_challenges" ADD CONSTRAINT "human_crypto_device_challenges_custody_fk" FOREIGN KEY ("human_id") REFERENCES "public"."human_crypto_custodies"("human_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "human_crypto_device_challenges" ADD CONSTRAINT "human_crypto_device_challenges_device_fk" FOREIGN KEY ("pending_device_id") REFERENCES "public"."human_crypto_devices"("device_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "human_crypto_device_key_packages" ADD CONSTRAINT "human_crypto_device_key_packages_device_fk" FOREIGN KEY ("device_id") REFERENCES "public"."human_crypto_devices"("device_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "human_crypto_device_key_packages" ADD CONSTRAINT "human_crypto_device_key_packages_domain_fk" FOREIGN KEY ("domain_id") REFERENCES "public"."crypto_domains"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "human_crypto_devices" ADD CONSTRAINT "human_crypto_devices_custody_fk" FOREIGN KEY ("human_id") REFERENCES "public"."human_crypto_custodies"("human_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "human_crypto_devices" ADD CONSTRAINT "human_crypto_devices_user_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "human_crypto_devices" ADD CONSTRAINT "human_crypto_devices_actor_fk" FOREIGN KEY ("human_actor_id") REFERENCES "public"."actors"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "human_crypto_recovery_keys" ADD CONSTRAINT "human_crypto_recovery_keys_custody_fk" FOREIGN KEY ("human_id") REFERENCES "public"."human_crypto_custodies"("human_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "human_crypto_recovery_keys" ADD CONSTRAINT "human_crypto_recovery_keys_issuer_fk" FOREIGN KEY ("issuer_device_id") REFERENCES "public"."human_crypto_devices"("device_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_crypto_delivery_messages_domain_sequence" ON "crypto_delivery_messages" USING btree ("domain_id","domain_sequence") WHERE "crypto_delivery_messages"."domain_id" is not null;--> statement-breakpoint
CREATE INDEX "idx_crypto_delivery_messages_recipient_expiry" ON "crypto_delivery_messages" USING btree ("recipient_device_id","expires_at");--> statement-breakpoint
CREATE INDEX "idx_crypto_delivery_messages_global_expiry" ON "crypto_delivery_messages" USING btree ("expires_at","recipient_device_id","recipient_sequence");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_crypto_delivery_operations_live_device_roster" ON "crypto_delivery_operations" USING btree ("human_id") WHERE "crypto_delivery_operations"."human_id" is not null
        and "crypto_delivery_operations"."kind" in (
          'device_add', 'device_recovery', 'device_revoke',
          'recovery_rotate'
        )
        and "crypto_delivery_operations"."state" not in ('active', 'failed', 'cancelled');--> statement-breakpoint
CREATE INDEX "idx_crypto_delivery_operations_human_state" ON "crypto_delivery_operations" USING btree ("human_id","state");--> statement-breakpoint
CREATE INDEX "idx_crypto_delivery_operations_lease" ON "crypto_delivery_operations" USING btree ("state","lease_expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_crypto_domain_devices_active_leaf" ON "crypto_domain_devices" USING btree ("domain_id","leaf_index") WHERE "crypto_domain_devices"."removed_at" is null;--> statement-breakpoint
CREATE INDEX "idx_crypto_domain_devices_current_human" ON "crypto_domain_devices" USING btree ("human_id","domain_id");--> statement-breakpoint
CREATE INDEX "idx_crypto_domain_transition_namespaces_state" ON "crypto_domain_transition_namespaces" USING btree ("state","namespace_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_crypto_domain_transition_namespaces_live_namespace" ON "crypto_domain_transition_namespaces" USING btree ("namespace_id") WHERE "crypto_domain_transition_namespaces"."state" not in ('active', 'failed');--> statement-breakpoint
CREATE INDEX "idx_crypto_domain_transition_steps_state" ON "crypto_domain_transition_steps" USING btree ("state","lease_expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_crypto_domain_transition_steps_live_domain" ON "crypto_domain_transition_steps" USING btree ("domain_id") WHERE "crypto_domain_transition_steps"."state" not in ('active', 'failed');--> statement-breakpoint
CREATE UNIQUE INDEX "uq_crypto_human_membership_transitions_live_namespace" ON "crypto_human_membership_transitions" USING btree ("namespace_id") WHERE "crypto_human_membership_transitions"."released_at" is null;--> statement-breakpoint
CREATE INDEX "idx_crypto_operation_outbox_claimable" ON "crypto_operation_outbox" USING btree ("delivered_at","terminal_at","claim_expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_human_crypto_device_challenges_live_initial" ON "human_crypto_device_challenges" USING btree ("human_id") WHERE "human_crypto_device_challenges"."kind" = 'initial_bootstrap'
        and "human_crypto_device_challenges"."consumed_at" is null
        and "human_crypto_device_challenges"."invalidated_at" is null;--> statement-breakpoint
CREATE INDEX "idx_human_crypto_device_challenges_expiry" ON "human_crypto_device_challenges" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "idx_human_crypto_device_key_packages_claimable" ON "human_crypto_device_key_packages" USING btree ("device_id","domain_id","generation","expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_human_crypto_devices_live_identity" ON "human_crypto_devices" USING btree ("human_id","installation_lineage_digest","device_generation") WHERE "human_crypto_devices"."state" in ('pending', 'active');--> statement-breakpoint
CREATE INDEX "idx_human_crypto_devices_human_state" ON "human_crypto_devices" USING btree ("human_id","state");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_human_crypto_recovery_keys_current" ON "human_crypto_recovery_keys" USING btree ("human_id") WHERE "human_crypto_recovery_keys"."state" = 'current';--> statement-breakpoint
ALTER TABLE "crypto_domains" ADD CONSTRAINT "crypto_domains_pause_operation_id_portable" CHECK (octet_length("crypto_domains"."pause_operation_id") between 1
      and 128
      and "crypto_domains"."pause_operation_id" ~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]*$');--> statement-breakpoint
ALTER TABLE "crypto_domains" ADD CONSTRAINT "crypto_domains_pause_coherent" CHECK (("crypto_domains"."writes_paused" and "crypto_domains"."pause_operation_id" is not null)
        or (not "crypto_domains"."writes_paused" and "crypto_domains"."pause_operation_id" is null));--> statement-breakpoint
ALTER TABLE "namespace_crypto_heads" ADD CONSTRAINT "namespace_crypto_heads_pause_operation_id_portable" CHECK (octet_length("namespace_crypto_heads"."pause_operation_id") between 1
      and 128
      and "namespace_crypto_heads"."pause_operation_id" ~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]*$');--> statement-breakpoint
ALTER TABLE "namespace_crypto_heads" ADD CONSTRAINT "namespace_crypto_heads_pause_coherent" CHECK (("namespace_crypto_heads"."writes_paused" and "namespace_crypto_heads"."pause_operation_id" is not null)
        or (not "namespace_crypto_heads"."writes_paused" and "namespace_crypto_heads"."pause_operation_id" is null));--> statement-breakpoint
CREATE POLICY "crypto_delivery_acknowledgements_crypto_sel" ON "crypto_delivery_acknowledgements" AS PERMISSIVE FOR SELECT TO "nautilo_crypto" USING (true);--> statement-breakpoint
CREATE POLICY "crypto_delivery_acknowledgements_crypto_ins" ON "crypto_delivery_acknowledgements" AS PERMISSIVE FOR INSERT TO "nautilo_crypto" WITH CHECK (true);--> statement-breakpoint
CREATE POLICY "crypto_delivery_acknowledgements_crypto_del" ON "crypto_delivery_acknowledgements" AS PERMISSIVE FOR DELETE TO "nautilo_crypto" USING (true);--> statement-breakpoint
CREATE POLICY "crypto_delivery_messages_crypto_sel" ON "crypto_delivery_messages" AS PERMISSIVE FOR SELECT TO "nautilo_crypto" USING (true);--> statement-breakpoint
CREATE POLICY "crypto_delivery_messages_crypto_ins" ON "crypto_delivery_messages" AS PERMISSIVE FOR INSERT TO "nautilo_crypto" WITH CHECK (true);--> statement-breakpoint
CREATE POLICY "crypto_delivery_messages_crypto_del" ON "crypto_delivery_messages" AS PERMISSIVE FOR DELETE TO "nautilo_crypto" USING (true);--> statement-breakpoint
CREATE POLICY "crypto_delivery_operations_crypto_sel" ON "crypto_delivery_operations" AS PERMISSIVE FOR SELECT TO "nautilo_crypto" USING (true);--> statement-breakpoint
CREATE POLICY "crypto_delivery_operations_crypto_ins" ON "crypto_delivery_operations" AS PERMISSIVE FOR INSERT TO "nautilo_crypto" WITH CHECK (true);--> statement-breakpoint
CREATE POLICY "crypto_delivery_operations_crypto_upd" ON "crypto_delivery_operations" AS PERMISSIVE FOR UPDATE TO "nautilo_crypto" USING (true) WITH CHECK (true);--> statement-breakpoint
CREATE POLICY "crypto_delivery_operations_crypto_del" ON "crypto_delivery_operations" AS PERMISSIVE FOR DELETE TO "nautilo_crypto" USING (true);--> statement-breakpoint
CREATE POLICY "crypto_device_epoch_operations_crypto_sel" ON "crypto_device_epoch_operations" AS PERMISSIVE FOR SELECT TO "nautilo_crypto" USING (true);--> statement-breakpoint
CREATE POLICY "crypto_device_epoch_operations_crypto_ins" ON "crypto_device_epoch_operations" AS PERMISSIVE FOR INSERT TO "nautilo_crypto" WITH CHECK (true);--> statement-breakpoint
CREATE POLICY "crypto_device_epoch_operations_crypto_upd" ON "crypto_device_epoch_operations" AS PERMISSIVE FOR UPDATE TO "nautilo_crypto" USING (true) WITH CHECK (true);--> statement-breakpoint
CREATE POLICY "crypto_device_epoch_operations_crypto_del" ON "crypto_device_epoch_operations" AS PERMISSIVE FOR DELETE TO "nautilo_crypto" USING (true);--> statement-breakpoint
CREATE POLICY "crypto_domain_devices_crypto_sel" ON "crypto_domain_devices" AS PERMISSIVE FOR SELECT TO "nautilo_crypto" USING (true);--> statement-breakpoint
CREATE POLICY "crypto_domain_devices_crypto_ins" ON "crypto_domain_devices" AS PERMISSIVE FOR INSERT TO "nautilo_crypto" WITH CHECK (true);--> statement-breakpoint
CREATE POLICY "crypto_domain_devices_crypto_upd" ON "crypto_domain_devices" AS PERMISSIVE FOR UPDATE TO "nautilo_crypto" USING (true) WITH CHECK (true);--> statement-breakpoint
CREATE POLICY "crypto_domain_transition_namespaces_crypto_sel" ON "crypto_domain_transition_namespaces" AS PERMISSIVE FOR SELECT TO "nautilo_crypto" USING (true);--> statement-breakpoint
CREATE POLICY "crypto_domain_transition_namespaces_crypto_ins" ON "crypto_domain_transition_namespaces" AS PERMISSIVE FOR INSERT TO "nautilo_crypto" WITH CHECK (true);--> statement-breakpoint
CREATE POLICY "crypto_domain_transition_namespaces_crypto_upd" ON "crypto_domain_transition_namespaces" AS PERMISSIVE FOR UPDATE TO "nautilo_crypto" USING (true) WITH CHECK (true);--> statement-breakpoint
CREATE POLICY "crypto_domain_transition_namespaces_crypto_del" ON "crypto_domain_transition_namespaces" AS PERMISSIVE FOR DELETE TO "nautilo_crypto" USING (true);--> statement-breakpoint
CREATE POLICY "crypto_domain_transition_steps_crypto_sel" ON "crypto_domain_transition_steps" AS PERMISSIVE FOR SELECT TO "nautilo_crypto" USING (true);--> statement-breakpoint
CREATE POLICY "crypto_domain_transition_steps_crypto_ins" ON "crypto_domain_transition_steps" AS PERMISSIVE FOR INSERT TO "nautilo_crypto" WITH CHECK (true);--> statement-breakpoint
CREATE POLICY "crypto_domain_transition_steps_crypto_upd" ON "crypto_domain_transition_steps" AS PERMISSIVE FOR UPDATE TO "nautilo_crypto" USING (true) WITH CHECK (true);--> statement-breakpoint
CREATE POLICY "crypto_domain_transition_steps_crypto_del" ON "crypto_domain_transition_steps" AS PERMISSIVE FOR DELETE TO "nautilo_crypto" USING (true);--> statement-breakpoint
CREATE POLICY "crypto_human_membership_transitions_crypto_sel" ON "crypto_human_membership_transitions" AS PERMISSIVE FOR SELECT TO "nautilo_crypto" USING (true);--> statement-breakpoint
CREATE POLICY "crypto_human_membership_transitions_crypto_ins" ON "crypto_human_membership_transitions" AS PERMISSIVE FOR INSERT TO "nautilo_crypto" WITH CHECK (true);--> statement-breakpoint
CREATE POLICY "crypto_human_membership_transitions_crypto_upd" ON "crypto_human_membership_transitions" AS PERMISSIVE FOR UPDATE TO "nautilo_crypto" USING (true) WITH CHECK (true);--> statement-breakpoint
CREATE POLICY "crypto_human_membership_transitions_crypto_del" ON "crypto_human_membership_transitions" AS PERMISSIVE FOR DELETE TO "nautilo_crypto" USING (true);--> statement-breakpoint
CREATE POLICY "crypto_operation_outbox_crypto_sel" ON "crypto_operation_outbox" AS PERMISSIVE FOR SELECT TO "nautilo_crypto" USING (true);--> statement-breakpoint
CREATE POLICY "crypto_operation_outbox_crypto_ins" ON "crypto_operation_outbox" AS PERMISSIVE FOR INSERT TO "nautilo_crypto" WITH CHECK (true);--> statement-breakpoint
CREATE POLICY "crypto_operation_outbox_crypto_upd" ON "crypto_operation_outbox" AS PERMISSIVE FOR UPDATE TO "nautilo_crypto" USING (true) WITH CHECK (true);--> statement-breakpoint
CREATE POLICY "crypto_operation_outbox_crypto_del" ON "crypto_operation_outbox" AS PERMISSIVE FOR DELETE TO "nautilo_crypto" USING (true);--> statement-breakpoint
CREATE POLICY "human_crypto_custodies_crypto_sel" ON "human_crypto_custodies" AS PERMISSIVE FOR SELECT TO "nautilo_crypto" USING (true);--> statement-breakpoint
CREATE POLICY "human_crypto_custodies_crypto_ins" ON "human_crypto_custodies" AS PERMISSIVE FOR INSERT TO "nautilo_crypto" WITH CHECK (true);--> statement-breakpoint
CREATE POLICY "human_crypto_custodies_crypto_upd" ON "human_crypto_custodies" AS PERMISSIVE FOR UPDATE TO "nautilo_crypto" USING (true) WITH CHECK (true);--> statement-breakpoint
CREATE POLICY "human_crypto_device_challenges_crypto_sel" ON "human_crypto_device_challenges" AS PERMISSIVE FOR SELECT TO "nautilo_crypto" USING (true);--> statement-breakpoint
CREATE POLICY "human_crypto_device_challenges_crypto_ins" ON "human_crypto_device_challenges" AS PERMISSIVE FOR INSERT TO "nautilo_crypto" WITH CHECK (true);--> statement-breakpoint
CREATE POLICY "human_crypto_device_challenges_crypto_upd" ON "human_crypto_device_challenges" AS PERMISSIVE FOR UPDATE TO "nautilo_crypto" USING (true) WITH CHECK (true);--> statement-breakpoint
CREATE POLICY "human_crypto_device_challenges_crypto_del" ON "human_crypto_device_challenges" AS PERMISSIVE FOR DELETE TO "nautilo_crypto" USING (true);--> statement-breakpoint
CREATE POLICY "human_crypto_device_key_packages_crypto_sel" ON "human_crypto_device_key_packages" AS PERMISSIVE FOR SELECT TO "nautilo_crypto" USING (true);--> statement-breakpoint
CREATE POLICY "human_crypto_device_key_packages_crypto_ins" ON "human_crypto_device_key_packages" AS PERMISSIVE FOR INSERT TO "nautilo_crypto" WITH CHECK (true);--> statement-breakpoint
CREATE POLICY "human_crypto_device_key_packages_crypto_upd" ON "human_crypto_device_key_packages" AS PERMISSIVE FOR UPDATE TO "nautilo_crypto" USING (true) WITH CHECK (true);--> statement-breakpoint
CREATE POLICY "human_crypto_device_key_packages_crypto_del" ON "human_crypto_device_key_packages" AS PERMISSIVE FOR DELETE TO "nautilo_crypto" USING (true);--> statement-breakpoint
CREATE POLICY "human_crypto_devices_crypto_sel" ON "human_crypto_devices" AS PERMISSIVE FOR SELECT TO "nautilo_crypto" USING (true);--> statement-breakpoint
CREATE POLICY "human_crypto_devices_crypto_ins" ON "human_crypto_devices" AS PERMISSIVE FOR INSERT TO "nautilo_crypto" WITH CHECK (true);--> statement-breakpoint
CREATE POLICY "human_crypto_devices_crypto_upd" ON "human_crypto_devices" AS PERMISSIVE FOR UPDATE TO "nautilo_crypto" USING (true) WITH CHECK (true);--> statement-breakpoint
CREATE POLICY "human_crypto_recovery_keys_crypto_sel" ON "human_crypto_recovery_keys" AS PERMISSIVE FOR SELECT TO "nautilo_crypto" USING (true);--> statement-breakpoint
CREATE POLICY "human_crypto_recovery_keys_crypto_ins" ON "human_crypto_recovery_keys" AS PERMISSIVE FOR INSERT TO "nautilo_crypto" WITH CHECK (true);--> statement-breakpoint
CREATE POLICY "human_crypto_recovery_keys_crypto_upd" ON "human_crypto_recovery_keys" AS PERMISSIVE FOR UPDATE TO "nautilo_crypto" USING (true) WITH CHECK (true);
--> statement-breakpoint
-- M232_CRYPTO_DELIVERY_AUTHORITY--> statement-breakpoint
ALTER TABLE "human_crypto_custodies" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "human_crypto_devices" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "human_crypto_device_challenges" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "human_crypto_recovery_keys" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "human_crypto_device_key_packages" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "crypto_domain_devices" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "crypto_delivery_operations" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "crypto_human_membership_transitions" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "crypto_device_epoch_operations" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "crypto_domain_transition_steps" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "crypto_domain_transition_namespaces" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "crypto_delivery_messages" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "crypto_delivery_acknowledgements" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "crypto_operation_outbox" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL PRIVILEGES ON TABLE
  "human_crypto_custodies",
  "human_crypto_devices",
  "human_crypto_device_challenges",
  "human_crypto_recovery_keys",
  "human_crypto_device_key_packages",
  "crypto_domain_devices",
  "crypto_delivery_operations",
  "crypto_human_membership_transitions",
  "crypto_device_epoch_operations",
  "crypto_domain_transition_steps",
  "crypto_domain_transition_namespaces",
  "crypto_delivery_messages",
  "crypto_delivery_acknowledgements",
  "crypto_operation_outbox"
FROM PUBLIC, "nautilo_agent", "nautilo_crypto";--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON TABLE
  "human_crypto_custodies",
  "human_crypto_devices",
  "human_crypto_recovery_keys",
  "crypto_domain_devices"
TO "nautilo_crypto";--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE
  "human_crypto_device_challenges",
  "human_crypto_device_key_packages",
  "crypto_delivery_operations",
  "crypto_human_membership_transitions",
  "crypto_device_epoch_operations",
  "crypto_domain_transition_steps",
  "crypto_domain_transition_namespaces",
  "crypto_operation_outbox"
TO "nautilo_crypto";--> statement-breakpoint
GRANT SELECT, INSERT, DELETE ON TABLE
  "crypto_delivery_messages",
  "crypto_delivery_acknowledgements"
TO "nautilo_crypto";
--> statement-breakpoint
-- M232_CRYPTO_IDENTITY_READ_AUTHORITY--> statement-breakpoint
REVOKE ALL PRIVILEGES ON TABLE
  "users",
  "actors"
FROM "nautilo_crypto";--> statement-breakpoint
DO $crypto_identity_column_privileges$
DECLARE
  privilege_record record;
BEGIN
  FOR privilege_record IN
    SELECT table_name, column_name, privilege_type
      FROM information_schema.role_column_grants
     WHERE grantee = 'nautilo_crypto'
       AND table_schema = 'public'
       AND table_name IN ('users', 'actors')
  LOOP
    EXECUTE format(
      'REVOKE %s (%I) ON TABLE public.%I FROM nautilo_crypto',
      privilege_record.privilege_type,
      privilege_record.column_name,
      privilege_record.table_name
    );
  END LOOP;
END
$crypto_identity_column_privileges$;--> statement-breakpoint
GRANT SELECT ("id") ON TABLE "users" TO "nautilo_crypto";--> statement-breakpoint
GRANT SELECT ("id", "owner_id", "kind") ON TABLE "actors" TO "nautilo_crypto";
