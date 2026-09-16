CREATE TABLE "grant_domain_envelope_acknowledgements" (
	"grant_domain_id" text NOT NULL,
	"domain_key_generation" bigint NOT NULL,
	"recipient_human_id" text NOT NULL,
	"recipient_key_id" text NOT NULL,
	"recipient_key_generation" bigint NOT NULL,
	"device_id" text NOT NULL,
	"device_revision" bigint NOT NULL,
	"envelope_digest" "bytea" NOT NULL,
	"head_digest" "bytea" NOT NULL,
	"acknowledgement_digest" "bytea" NOT NULL,
	"acknowledged_at" timestamp with time zone NOT NULL,
	CONSTRAINT "grant_domain_envelope_acknowledgements_grant_domain_id_domain_key_generation_device_id_pk" PRIMARY KEY("grant_domain_id","domain_key_generation","device_id"),
	CONSTRAINT "grant_domain_ack_device_shape" CHECK ("grant_domain_envelope_acknowledgements"."device_id" = "grant_domain_envelope_acknowledgements"."recipient_key_id"),
	CONSTRAINT "grant_domain_ack_domain" CHECK (octet_length("grant_domain_envelope_acknowledgements"."grant_domain_id") between 1 and 128
      and "grant_domain_envelope_acknowledgements"."grant_domain_id" ~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]*$'),
	CONSTRAINT "grant_domain_ack_human" CHECK (octet_length("grant_domain_envelope_acknowledgements"."recipient_human_id") between 1 and 128
      and "grant_domain_envelope_acknowledgements"."recipient_human_id" ~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]*$'),
	CONSTRAINT "grant_domain_ack_key" CHECK (octet_length("grant_domain_envelope_acknowledgements"."recipient_key_id") between 1 and 128
      and "grant_domain_envelope_acknowledgements"."recipient_key_id" ~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]*$'),
	CONSTRAINT "grant_domain_ack_device" CHECK (octet_length("grant_domain_envelope_acknowledgements"."device_id") between 1 and 128
      and "grant_domain_envelope_acknowledgements"."device_id" ~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]*$'),
	CONSTRAINT "grant_domain_ack_key_generation" CHECK ("grant_domain_envelope_acknowledgements"."recipient_key_generation" between 0 and 9007199254740991),
	CONSTRAINT "grant_domain_ack_domain_generation" CHECK ("grant_domain_envelope_acknowledgements"."domain_key_generation" between 0 and 9007199254740991),
	CONSTRAINT "grant_domain_ack_device_revision" CHECK ("grant_domain_envelope_acknowledgements"."device_revision" between 0 and 9007199254740991),
	CONSTRAINT "grant_domain_ack_envelope" CHECK (octet_length("grant_domain_envelope_acknowledgements"."envelope_digest") = 32),
	CONSTRAINT "grant_domain_ack_head" CHECK (octet_length("grant_domain_envelope_acknowledgements"."head_digest") = 32),
	CONSTRAINT "grant_domain_ack_digest" CHECK (octet_length("grant_domain_envelope_acknowledgements"."acknowledgement_digest") = 32)
);
--> statement-breakpoint
ALTER TABLE "grant_domain_envelope_acknowledgements" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "grant_domain_heads" (
	"participant_digest" "bytea" PRIMARY KEY NOT NULL,
	"participant_count" integer NOT NULL,
	"participant_set_bytes" "bytea" NOT NULL,
	"grant_domain_id" text NOT NULL,
	"domain_key_generation" bigint NOT NULL,
	"publication_authorization_revision" bigint NOT NULL,
	"authorization_revision" bigint NOT NULL,
	"head_digest" "bytea" NOT NULL,
	"previous_head_digest" "bytea",
	"publication_digest" "bytea" NOT NULL,
	"publication_operation_id" text NOT NULL,
	"recipient_set_digest" "bytea" NOT NULL,
	"recipient_count" integer NOT NULL,
	"binding_set_digest" "bytea" NOT NULL,
	"binding_count" integer NOT NULL,
	"issuer_device_id" text NOT NULL,
	"issuer_device_generation" bigint NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"activated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "uq_grant_domain_heads_domain" UNIQUE("grant_domain_id"),
	CONSTRAINT "uq_grant_domain_heads_digest" UNIQUE("head_digest"),
	CONSTRAINT "grant_domain_heads_participant_digest" CHECK (octet_length("grant_domain_heads"."participant_digest") = 32),
	CONSTRAINT "grant_domain_heads_participant_count" CHECK ("grant_domain_heads"."participant_count" between 1 and 64),
	CONSTRAINT "grant_domain_heads_participant_bytes" CHECK (octet_length("grant_domain_heads"."participant_set_bytes") between 1 and 16384),
	CONSTRAINT "grant_domain_heads_domain_portable" CHECK (octet_length("grant_domain_heads"."grant_domain_id") between 1 and 128
      and "grant_domain_heads"."grant_domain_id" ~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]*$'),
	CONSTRAINT "grant_domain_heads_key_generation" CHECK ("grant_domain_heads"."domain_key_generation" between 0 and 9007199254740991),
	CONSTRAINT "grant_domain_heads_publication_authorization_revision" CHECK ("grant_domain_heads"."publication_authorization_revision" between 0 and 9007199254740991),
	CONSTRAINT "grant_domain_heads_authorization_revision" CHECK ("grant_domain_heads"."authorization_revision" between 0 and 9007199254740991),
	CONSTRAINT "grant_domain_heads_authorization_order" CHECK ("grant_domain_heads"."authorization_revision" >= "grant_domain_heads"."publication_authorization_revision"),
	CONSTRAINT "grant_domain_heads_head_digest" CHECK (octet_length("grant_domain_heads"."head_digest") = 32),
	CONSTRAINT "grant_domain_heads_previous_digest" CHECK (octet_length("grant_domain_heads"."previous_head_digest") = 32),
	CONSTRAINT "grant_domain_heads_predecessor_shape" CHECK (("grant_domain_heads"."domain_key_generation" = 1 and "grant_domain_heads"."previous_head_digest" is null)
        or ("grant_domain_heads"."domain_key_generation" > 1 and "grant_domain_heads"."previous_head_digest" is not null)),
	CONSTRAINT "grant_domain_heads_publication_digest" CHECK (octet_length("grant_domain_heads"."publication_digest") = 32),
	CONSTRAINT "grant_domain_heads_operation_portable" CHECK (octet_length("grant_domain_heads"."publication_operation_id") between 1 and 128
      and "grant_domain_heads"."publication_operation_id" ~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]*$'),
	CONSTRAINT "grant_domain_heads_recipient_set_digest" CHECK (octet_length("grant_domain_heads"."recipient_set_digest") = 32),
	CONSTRAINT "grant_domain_heads_recipient_count" CHECK ("grant_domain_heads"."recipient_count" between 1 and 320),
	CONSTRAINT "grant_domain_heads_binding_set_digest" CHECK (octet_length("grant_domain_heads"."binding_set_digest") = 32),
	CONSTRAINT "grant_domain_heads_binding_count" CHECK ("grant_domain_heads"."binding_count" between 0 and 9007199254740991),
	CONSTRAINT "grant_domain_heads_issuer_portable" CHECK (octet_length("grant_domain_heads"."issuer_device_id") between 1 and 128
      and "grant_domain_heads"."issuer_device_id" ~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]*$'),
	CONSTRAINT "grant_domain_heads_issuer_generation" CHECK ("grant_domain_heads"."issuer_device_generation" between 0 and 9007199254740991),
	CONSTRAINT "grant_domain_heads_time_order" CHECK ("grant_domain_heads"."activated_at" >= "grant_domain_heads"."created_at")
);
--> statement-breakpoint
ALTER TABLE "grant_domain_heads" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "grant_domain_publication_operations" (
	"operation_id" text PRIMARY KEY NOT NULL,
	"idempotency_key" text NOT NULL,
	"grant_domain_id" text NOT NULL,
	"participant_count" integer NOT NULL,
	"participant_set_bytes" "bytea" NOT NULL,
	"participant_digest" "bytea" NOT NULL,
	"domain_key_generation" bigint NOT NULL,
	"authorization_revision" bigint NOT NULL,
	"expected_previous_head_digest" "bytea",
	"head_digest" "bytea" NOT NULL,
	"recipient_set_digest" "bytea" NOT NULL,
	"recipient_count" integer NOT NULL,
	"publication_digest" "bytea" NOT NULL,
	"publication_bytes" "bytea" NOT NULL,
	"envelope_set_digest" "bytea" NOT NULL,
	"aggregate_envelope_bytes" bigint NOT NULL,
	"issuer_human_id" text NOT NULL,
	"issuer_device_id" text NOT NULL,
	"issuer_device_generation" bigint NOT NULL,
	"state" text NOT NULL,
	"failure_code" text,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"deadline_at" timestamp with time zone NOT NULL,
	"activated_at" timestamp with time zone,
	"terminal_at" timestamp with time zone,
	CONSTRAINT "uq_grant_domain_pub_idempotency" UNIQUE("idempotency_key"),
	CONSTRAINT "uq_grant_domain_pub_digest" UNIQUE("publication_digest"),
	CONSTRAINT "grant_domain_pub_operation_portable" CHECK (octet_length("grant_domain_publication_operations"."operation_id") between 1 and 128
      and "grant_domain_publication_operations"."operation_id" ~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]*$'),
	CONSTRAINT "grant_domain_pub_idempotency_portable" CHECK (octet_length("grant_domain_publication_operations"."idempotency_key") between 1 and 128
      and "grant_domain_publication_operations"."idempotency_key" ~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]*$'),
	CONSTRAINT "grant_domain_pub_domain_portable" CHECK (octet_length("grant_domain_publication_operations"."grant_domain_id") between 1 and 128
      and "grant_domain_publication_operations"."grant_domain_id" ~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]*$'),
	CONSTRAINT "grant_domain_pub_issuer_human_portable" CHECK (octet_length("grant_domain_publication_operations"."issuer_human_id") between 1 and 128
      and "grant_domain_publication_operations"."issuer_human_id" ~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]*$'),
	CONSTRAINT "grant_domain_pub_issuer_device_portable" CHECK (octet_length("grant_domain_publication_operations"."issuer_device_id") between 1 and 128
      and "grant_domain_publication_operations"."issuer_device_id" ~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]*$'),
	CONSTRAINT "grant_domain_pub_participant_count" CHECK ("grant_domain_publication_operations"."participant_count" between 1 and 64),
	CONSTRAINT "grant_domain_pub_participant_bytes" CHECK (octet_length("grant_domain_publication_operations"."participant_set_bytes") between 1 and 16384),
	CONSTRAINT "grant_domain_pub_participant_digest" CHECK (octet_length("grant_domain_publication_operations"."participant_digest") = 32),
	CONSTRAINT "grant_domain_pub_key_generation" CHECK ("grant_domain_publication_operations"."domain_key_generation" between 0 and 9007199254740991),
	CONSTRAINT "grant_domain_pub_authorization_revision" CHECK ("grant_domain_publication_operations"."authorization_revision" between 0 and 9007199254740991),
	CONSTRAINT "grant_domain_pub_previous_head_digest" CHECK (octet_length("grant_domain_publication_operations"."expected_previous_head_digest") = 32),
	CONSTRAINT "grant_domain_pub_head_digest" CHECK (octet_length("grant_domain_publication_operations"."head_digest") = 32),
	CONSTRAINT "grant_domain_pub_predecessor_shape" CHECK (("grant_domain_publication_operations"."domain_key_generation" = 1 and "grant_domain_publication_operations"."expected_previous_head_digest" is null)
        or ("grant_domain_publication_operations"."domain_key_generation" > 1 and "grant_domain_publication_operations"."expected_previous_head_digest" is not null)),
	CONSTRAINT "grant_domain_pub_recipient_set_digest" CHECK (octet_length("grant_domain_publication_operations"."recipient_set_digest") = 32),
	CONSTRAINT "grant_domain_pub_recipient_count" CHECK ("grant_domain_publication_operations"."recipient_count" between 1 and 320),
	CONSTRAINT "grant_domain_pub_publication_digest" CHECK (octet_length("grant_domain_publication_operations"."publication_digest") = 32),
	CONSTRAINT "grant_domain_pub_publication_bytes" CHECK (octet_length("grant_domain_publication_operations"."publication_bytes") between 1 and 524288),
	CONSTRAINT "grant_domain_pub_envelope_set_digest" CHECK (octet_length("grant_domain_publication_operations"."envelope_set_digest") = 32),
	CONSTRAINT "grant_domain_pub_aggregate_envelopes" CHECK ("grant_domain_publication_operations"."aggregate_envelope_bytes" between "grant_domain_publication_operations"."recipient_count" and 67108864),
	CONSTRAINT "grant_domain_pub_issuer_generation" CHECK ("grant_domain_publication_operations"."issuer_device_generation" between 0 and 9007199254740991),
	CONSTRAINT "grant_domain_pub_state" CHECK ("grant_domain_publication_operations"."state" in ('reserved', 'active', 'stale', 'expired', 'failed')),
	CONSTRAINT "grant_domain_pub_failure_portable" CHECK (octet_length("grant_domain_publication_operations"."failure_code") between 1 and 128
      and "grant_domain_publication_operations"."failure_code" ~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]*$'),
	CONSTRAINT "grant_domain_pub_lifecycle" CHECK (("grant_domain_publication_operations"."state" = 'reserved' and "grant_domain_publication_operations"."failure_code" is null and "grant_domain_publication_operations"."activated_at" is null and "grant_domain_publication_operations"."terminal_at" is null)
        or ("grant_domain_publication_operations"."state" = 'active' and "grant_domain_publication_operations"."failure_code" is null and "grant_domain_publication_operations"."activated_at" is not null and "grant_domain_publication_operations"."terminal_at" is not null)
        or ("grant_domain_publication_operations"."state" in ('stale', 'expired', 'failed') and "grant_domain_publication_operations"."failure_code" is not null and "grant_domain_publication_operations"."activated_at" is null and "grant_domain_publication_operations"."terminal_at" is not null)),
	CONSTRAINT "grant_domain_pub_time_order" CHECK ("grant_domain_publication_operations"."updated_at" >= "grant_domain_publication_operations"."created_at"
        and "grant_domain_publication_operations"."deadline_at" > "grant_domain_publication_operations"."created_at"
        and "grant_domain_publication_operations"."deadline_at" <= "grant_domain_publication_operations"."created_at" + interval '30 seconds'
        and ("grant_domain_publication_operations"."terminal_at" is null or "grant_domain_publication_operations"."terminal_at" >= "grant_domain_publication_operations"."created_at"))
);
--> statement-breakpoint
ALTER TABLE "grant_domain_publication_operations" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "grant_domain_recipient_authorization_operations" (
	"operation_id" text PRIMARY KEY NOT NULL,
	"idempotency_key" text NOT NULL,
	"grant_domain_id" text NOT NULL,
	"participant_digest" "bytea" NOT NULL,
	"domain_key_generation" bigint NOT NULL,
	"authorization_revision" bigint NOT NULL,
	"head_digest" "bytea" NOT NULL,
	"issuer_human_id" text NOT NULL,
	"issuer_device_id" text NOT NULL,
	"issuer_device_generation" bigint NOT NULL,
	"recipient_kind" text NOT NULL,
	"recipient_human_id" text NOT NULL,
	"recipient_key_id" text NOT NULL,
	"recipient_key_generation" bigint NOT NULL,
	"recipient_device_id" text,
	"recipient_recovery_key_id" text,
	"recipient_recovery_generation" bigint,
	"recipient_public_key_digest" "bytea" NOT NULL,
	"authorization_digest" "bytea" NOT NULL,
	"authorization_bytes" "bytea" NOT NULL,
	"envelope_digest" "bytea" NOT NULL,
	"state" text NOT NULL,
	"failure_code" text,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"deadline_at" timestamp with time zone NOT NULL,
	"activated_at" timestamp with time zone,
	"terminal_at" timestamp with time zone,
	CONSTRAINT "uq_grant_domain_recipient_auth_idempotency" UNIQUE("idempotency_key"),
	CONSTRAINT "grant_domain_recipient_auth_operation" CHECK (octet_length("grant_domain_recipient_authorization_operations"."operation_id") between 1 and 128
      and "grant_domain_recipient_authorization_operations"."operation_id" ~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]*$'),
	CONSTRAINT "grant_domain_recipient_auth_idempotency" CHECK (octet_length("grant_domain_recipient_authorization_operations"."idempotency_key") between 1 and 128
      and "grant_domain_recipient_authorization_operations"."idempotency_key" ~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]*$'),
	CONSTRAINT "grant_domain_recipient_auth_domain" CHECK (octet_length("grant_domain_recipient_authorization_operations"."grant_domain_id") between 1 and 128
      and "grant_domain_recipient_authorization_operations"."grant_domain_id" ~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]*$'),
	CONSTRAINT "grant_domain_recipient_auth_participants" CHECK (octet_length("grant_domain_recipient_authorization_operations"."participant_digest") = 32),
	CONSTRAINT "grant_domain_recipient_auth_key_generation" CHECK ("grant_domain_recipient_authorization_operations"."domain_key_generation" between 0 and 9007199254740991),
	CONSTRAINT "grant_domain_recipient_auth_authorization_revision" CHECK ("grant_domain_recipient_authorization_operations"."authorization_revision" between 0 and 9007199254740991),
	CONSTRAINT "grant_domain_recipient_auth_head" CHECK (octet_length("grant_domain_recipient_authorization_operations"."head_digest") = 32),
	CONSTRAINT "grant_domain_recipient_auth_issuer_human" CHECK (octet_length("grant_domain_recipient_authorization_operations"."issuer_human_id") between 1 and 128
      and "grant_domain_recipient_authorization_operations"."issuer_human_id" ~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]*$'),
	CONSTRAINT "grant_domain_recipient_auth_issuer_device" CHECK (octet_length("grant_domain_recipient_authorization_operations"."issuer_device_id") between 1 and 128
      and "grant_domain_recipient_authorization_operations"."issuer_device_id" ~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]*$'),
	CONSTRAINT "grant_domain_recipient_auth_issuer_generation" CHECK ("grant_domain_recipient_authorization_operations"."issuer_device_generation" between 0 and 9007199254740991),
	CONSTRAINT "grant_domain_recipient_auth_kind" CHECK (("grant_domain_recipient_authorization_operations"."recipient_kind" = 'device' and "grant_domain_recipient_authorization_operations"."recipient_device_id" is not null
          and "grant_domain_recipient_authorization_operations"."recipient_key_id" = "grant_domain_recipient_authorization_operations"."recipient_device_id"
          and "grant_domain_recipient_authorization_operations"."recipient_recovery_key_id" is null and "grant_domain_recipient_authorization_operations"."recipient_recovery_generation" is null)
        or ("grant_domain_recipient_authorization_operations"."recipient_kind" = 'recovery' and "grant_domain_recipient_authorization_operations"."recipient_device_id" is null
          and "grant_domain_recipient_authorization_operations"."recipient_recovery_key_id" is not null
          and "grant_domain_recipient_authorization_operations"."recipient_key_id" = "grant_domain_recipient_authorization_operations"."recipient_recovery_key_id"
          and "grant_domain_recipient_authorization_operations"."recipient_recovery_generation" = "grant_domain_recipient_authorization_operations"."recipient_key_generation")),
	CONSTRAINT "grant_domain_recipient_auth_human" CHECK (octet_length("grant_domain_recipient_authorization_operations"."recipient_human_id") between 1 and 128
      and "grant_domain_recipient_authorization_operations"."recipient_human_id" ~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]*$'),
	CONSTRAINT "grant_domain_recipient_auth_key" CHECK (octet_length("grant_domain_recipient_authorization_operations"."recipient_key_id") between 1 and 128
      and "grant_domain_recipient_authorization_operations"."recipient_key_id" ~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]*$'),
	CONSTRAINT "grant_domain_recipient_auth_recipient_generation" CHECK ("grant_domain_recipient_authorization_operations"."recipient_key_generation" between 0 and 9007199254740991),
	CONSTRAINT "grant_domain_recipient_auth_device" CHECK (octet_length("grant_domain_recipient_authorization_operations"."recipient_device_id") between 1 and 128
      and "grant_domain_recipient_authorization_operations"."recipient_device_id" ~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]*$'),
	CONSTRAINT "grant_domain_recipient_auth_recovery" CHECK (octet_length("grant_domain_recipient_authorization_operations"."recipient_recovery_key_id") between 1 and 128
      and "grant_domain_recipient_authorization_operations"."recipient_recovery_key_id" ~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]*$'),
	CONSTRAINT "grant_domain_recipient_auth_recovery_generation" CHECK ("grant_domain_recipient_authorization_operations"."recipient_recovery_generation" between 0 and 9007199254740991),
	CONSTRAINT "grant_domain_recipient_auth_public_key" CHECK (octet_length("grant_domain_recipient_authorization_operations"."recipient_public_key_digest") = 32),
	CONSTRAINT "grant_domain_recipient_auth_digest" CHECK (octet_length("grant_domain_recipient_authorization_operations"."authorization_digest") = 32),
	CONSTRAINT "grant_domain_recipient_auth_bytes" CHECK (octet_length("grant_domain_recipient_authorization_operations"."authorization_bytes") between 1 and 2097152),
	CONSTRAINT "grant_domain_recipient_auth_envelope" CHECK (octet_length("grant_domain_recipient_authorization_operations"."envelope_digest") = 32),
	CONSTRAINT "grant_domain_recipient_auth_state" CHECK ("grant_domain_recipient_authorization_operations"."state" in ('reserved', 'active', 'stale', 'expired', 'failed')),
	CONSTRAINT "grant_domain_recipient_auth_failure" CHECK (octet_length("grant_domain_recipient_authorization_operations"."failure_code") between 1 and 128
      and "grant_domain_recipient_authorization_operations"."failure_code" ~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]*$'),
	CONSTRAINT "grant_domain_recipient_auth_lifecycle" CHECK (("grant_domain_recipient_authorization_operations"."state" = 'reserved' and "grant_domain_recipient_authorization_operations"."failure_code" is null and "grant_domain_recipient_authorization_operations"."activated_at" is null and "grant_domain_recipient_authorization_operations"."terminal_at" is null)
        or ("grant_domain_recipient_authorization_operations"."state" = 'active' and "grant_domain_recipient_authorization_operations"."failure_code" is null and "grant_domain_recipient_authorization_operations"."activated_at" is not null and "grant_domain_recipient_authorization_operations"."terminal_at" is not null)
        or ("grant_domain_recipient_authorization_operations"."state" in ('stale', 'expired', 'failed') and "grant_domain_recipient_authorization_operations"."failure_code" is not null and "grant_domain_recipient_authorization_operations"."activated_at" is null and "grant_domain_recipient_authorization_operations"."terminal_at" is not null)),
	CONSTRAINT "grant_domain_recipient_auth_time_order" CHECK ("grant_domain_recipient_authorization_operations"."updated_at" >= "grant_domain_recipient_authorization_operations"."created_at"
        and "grant_domain_recipient_authorization_operations"."deadline_at" > "grant_domain_recipient_authorization_operations"."created_at"
        and "grant_domain_recipient_authorization_operations"."deadline_at" <= "grant_domain_recipient_authorization_operations"."created_at" + interval '30 seconds')
);
--> statement-breakpoint
ALTER TABLE "grant_domain_recipient_authorization_operations" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "grant_domain_recipient_envelopes" (
	"grant_domain_id" text NOT NULL,
	"participant_digest" "bytea" NOT NULL,
	"domain_key_generation" bigint NOT NULL,
	"authorization_revision" bigint NOT NULL,
	"recipient_kind" text NOT NULL,
	"recipient_human_id" text NOT NULL,
	"recipient_key_id" text NOT NULL,
	"recipient_key_generation" bigint NOT NULL,
	"recipient_device_id" text,
	"recipient_recovery_key_id" text,
	"recipient_recovery_generation" bigint,
	"recipient_public_key_digest" "bytea" NOT NULL,
	"head_digest" "bytea" NOT NULL,
	"envelope_digest" "bytea" NOT NULL,
	"envelope_bytes" "bytea" NOT NULL,
	"issuer_device_id" text NOT NULL,
	"issuer_device_generation" bigint NOT NULL,
	"issuer_signature" "bytea" NOT NULL,
	"publication_operation_id" text,
	"recipient_authorization_operation_id" text,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "grant_domain_recipient_envelopes_grant_domain_id_domain_key_generation_recipient_kind_recipient_human_id_recipient_key_id_recipient_key_generation_pk" PRIMARY KEY("grant_domain_id","domain_key_generation","recipient_kind","recipient_human_id","recipient_key_id","recipient_key_generation"),
	CONSTRAINT "uq_grant_domain_envelopes_ack_target" UNIQUE("grant_domain_id","domain_key_generation","recipient_human_id","recipient_key_id","recipient_key_generation","envelope_digest","head_digest"),
	CONSTRAINT "grant_domain_envelopes_domain_portable" CHECK (octet_length("grant_domain_recipient_envelopes"."grant_domain_id") between 1 and 128
      and "grant_domain_recipient_envelopes"."grant_domain_id" ~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]*$'),
	CONSTRAINT "grant_domain_envelopes_participant_digest" CHECK (octet_length("grant_domain_recipient_envelopes"."participant_digest") = 32),
	CONSTRAINT "grant_domain_envelopes_key_generation" CHECK ("grant_domain_recipient_envelopes"."domain_key_generation" between 0 and 9007199254740991),
	CONSTRAINT "grant_domain_envelopes_authorization_revision" CHECK ("grant_domain_recipient_envelopes"."authorization_revision" between 0 and 9007199254740991),
	CONSTRAINT "grant_domain_envelopes_recipient_shape" CHECK (("grant_domain_recipient_envelopes"."recipient_kind" = 'device' and "grant_domain_recipient_envelopes"."recipient_device_id" is not null
          and "grant_domain_recipient_envelopes"."recipient_key_id" = "grant_domain_recipient_envelopes"."recipient_device_id"
          and "grant_domain_recipient_envelopes"."recipient_recovery_key_id" is null and "grant_domain_recipient_envelopes"."recipient_recovery_generation" is null)
        or ("grant_domain_recipient_envelopes"."recipient_kind" = 'recovery' and "grant_domain_recipient_envelopes"."recipient_device_id" is null
          and "grant_domain_recipient_envelopes"."recipient_recovery_key_id" is not null
          and "grant_domain_recipient_envelopes"."recipient_key_id" = "grant_domain_recipient_envelopes"."recipient_recovery_key_id"
          and "grant_domain_recipient_envelopes"."recipient_recovery_generation" = "grant_domain_recipient_envelopes"."recipient_key_generation")),
	CONSTRAINT "grant_domain_envelopes_human_portable" CHECK (octet_length("grant_domain_recipient_envelopes"."recipient_human_id") between 1 and 128
      and "grant_domain_recipient_envelopes"."recipient_human_id" ~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]*$'),
	CONSTRAINT "grant_domain_envelopes_key_portable" CHECK (octet_length("grant_domain_recipient_envelopes"."recipient_key_id") between 1 and 128
      and "grant_domain_recipient_envelopes"."recipient_key_id" ~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]*$'),
	CONSTRAINT "grant_domain_envelopes_recipient_generation" CHECK ("grant_domain_recipient_envelopes"."recipient_key_generation" between 0 and 9007199254740991),
	CONSTRAINT "grant_domain_envelopes_device_portable" CHECK (octet_length("grant_domain_recipient_envelopes"."recipient_device_id") between 1 and 128
      and "grant_domain_recipient_envelopes"."recipient_device_id" ~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]*$'),
	CONSTRAINT "grant_domain_envelopes_recovery_portable" CHECK (octet_length("grant_domain_recipient_envelopes"."recipient_recovery_key_id") between 1 and 128
      and "grant_domain_recipient_envelopes"."recipient_recovery_key_id" ~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]*$'),
	CONSTRAINT "grant_domain_envelopes_recovery_generation" CHECK ("grant_domain_recipient_envelopes"."recipient_recovery_generation" between 0 and 9007199254740991),
	CONSTRAINT "grant_domain_envelopes_public_key_digest" CHECK (octet_length("grant_domain_recipient_envelopes"."recipient_public_key_digest") = 32),
	CONSTRAINT "grant_domain_envelopes_head_digest" CHECK (octet_length("grant_domain_recipient_envelopes"."head_digest") = 32),
	CONSTRAINT "grant_domain_envelopes_envelope_digest" CHECK (octet_length("grant_domain_recipient_envelopes"."envelope_digest") = 32),
	CONSTRAINT "grant_domain_envelopes_bytes" CHECK (octet_length("grant_domain_recipient_envelopes"."envelope_bytes") between 1 and 1048616),
	CONSTRAINT "grant_domain_envelopes_issuer_portable" CHECK (octet_length("grant_domain_recipient_envelopes"."issuer_device_id") between 1 and 128
      and "grant_domain_recipient_envelopes"."issuer_device_id" ~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]*$'),
	CONSTRAINT "grant_domain_envelopes_issuer_generation" CHECK ("grant_domain_recipient_envelopes"."issuer_device_generation" between 0 and 9007199254740991),
	CONSTRAINT "grant_domain_envelopes_signature" CHECK (octet_length("grant_domain_recipient_envelopes"."issuer_signature") = 64),
	CONSTRAINT "grant_domain_envelopes_origin_shape" CHECK (("grant_domain_recipient_envelopes"."publication_operation_id" is not null and "grant_domain_recipient_envelopes"."recipient_authorization_operation_id" is null)
        or ("grant_domain_recipient_envelopes"."publication_operation_id" is null and "grant_domain_recipient_envelopes"."recipient_authorization_operation_id" is not null))
);
--> statement-breakpoint
ALTER TABLE "grant_domain_recipient_envelopes" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "grant_domain_recipient_sync_campaigns" (
	"campaign_id" text PRIMARY KEY NOT NULL,
	"participant_digest" "bytea" NOT NULL,
	"grant_domain_id" text NOT NULL,
	"domain_key_generation" bigint NOT NULL,
	"recipient_kind" text NOT NULL,
	"recipient_human_id" text NOT NULL,
	"recipient_key_id" text NOT NULL,
	"recipient_key_generation" bigint NOT NULL,
	"recipient_device_id" text,
	"recipient_recovery_key_id" text,
	"recipient_recovery_generation" bigint,
	"recipient_public_key_digest" "bytea" NOT NULL,
	"required_envelope_count" integer NOT NULL,
	"covered_envelope_count" integer NOT NULL,
	"state" text NOT NULL,
	"reason" text,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"terminal_at" timestamp with time zone,
	CONSTRAINT "uq_grant_domain_sync_target" UNIQUE("grant_domain_id","domain_key_generation","recipient_human_id","recipient_kind","recipient_key_id","recipient_key_generation"),
	CONSTRAINT "grant_domain_sync_campaign" CHECK (octet_length("grant_domain_recipient_sync_campaigns"."campaign_id") between 1 and 128
      and "grant_domain_recipient_sync_campaigns"."campaign_id" ~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]*$'),
	CONSTRAINT "grant_domain_sync_participants" CHECK (octet_length("grant_domain_recipient_sync_campaigns"."participant_digest") = 32),
	CONSTRAINT "grant_domain_sync_domain" CHECK (octet_length("grant_domain_recipient_sync_campaigns"."grant_domain_id") between 1 and 128
      and "grant_domain_recipient_sync_campaigns"."grant_domain_id" ~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]*$'),
	CONSTRAINT "grant_domain_sync_key_generation" CHECK ("grant_domain_recipient_sync_campaigns"."domain_key_generation" between 0 and 9007199254740991),
	CONSTRAINT "grant_domain_sync_kind" CHECK (("grant_domain_recipient_sync_campaigns"."recipient_kind" = 'device' and "grant_domain_recipient_sync_campaigns"."recipient_device_id" is not null
          and "grant_domain_recipient_sync_campaigns"."recipient_key_id" = "grant_domain_recipient_sync_campaigns"."recipient_device_id"
          and "grant_domain_recipient_sync_campaigns"."recipient_recovery_key_id" is null and "grant_domain_recipient_sync_campaigns"."recipient_recovery_generation" is null)
        or ("grant_domain_recipient_sync_campaigns"."recipient_kind" = 'recovery' and "grant_domain_recipient_sync_campaigns"."recipient_device_id" is null
          and "grant_domain_recipient_sync_campaigns"."recipient_recovery_key_id" is not null
          and "grant_domain_recipient_sync_campaigns"."recipient_key_id" = "grant_domain_recipient_sync_campaigns"."recipient_recovery_key_id"
          and "grant_domain_recipient_sync_campaigns"."recipient_recovery_generation" = "grant_domain_recipient_sync_campaigns"."recipient_key_generation")),
	CONSTRAINT "grant_domain_sync_human" CHECK (octet_length("grant_domain_recipient_sync_campaigns"."recipient_human_id") between 1 and 128
      and "grant_domain_recipient_sync_campaigns"."recipient_human_id" ~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]*$'),
	CONSTRAINT "grant_domain_sync_key" CHECK (octet_length("grant_domain_recipient_sync_campaigns"."recipient_key_id") between 1 and 128
      and "grant_domain_recipient_sync_campaigns"."recipient_key_id" ~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]*$'),
	CONSTRAINT "grant_domain_sync_recipient_generation" CHECK ("grant_domain_recipient_sync_campaigns"."recipient_key_generation" between 0 and 9007199254740991),
	CONSTRAINT "grant_domain_sync_device" CHECK (octet_length("grant_domain_recipient_sync_campaigns"."recipient_device_id") between 1 and 128
      and "grant_domain_recipient_sync_campaigns"."recipient_device_id" ~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]*$'),
	CONSTRAINT "grant_domain_sync_recovery" CHECK (octet_length("grant_domain_recipient_sync_campaigns"."recipient_recovery_key_id") between 1 and 128
      and "grant_domain_recipient_sync_campaigns"."recipient_recovery_key_id" ~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]*$'),
	CONSTRAINT "grant_domain_sync_recovery_generation" CHECK ("grant_domain_recipient_sync_campaigns"."recipient_recovery_generation" between 0 and 9007199254740991),
	CONSTRAINT "grant_domain_sync_public_key" CHECK (octet_length("grant_domain_recipient_sync_campaigns"."recipient_public_key_digest") = 32),
	CONSTRAINT "grant_domain_sync_coverage" CHECK ("grant_domain_recipient_sync_campaigns"."required_envelope_count" between 1 and 9007199254740991
        and "grant_domain_recipient_sync_campaigns"."covered_envelope_count" between 0 and "grant_domain_recipient_sync_campaigns"."required_envelope_count"),
	CONSTRAINT "grant_domain_sync_state" CHECK ("grant_domain_recipient_sync_campaigns"."state" in ('syncing', 'ready', 'waiting_for_authorized_device', 'recovery_required', 'unrecoverable', 'stale')),
	CONSTRAINT "grant_domain_sync_reason" CHECK (octet_length("grant_domain_recipient_sync_campaigns"."reason") between 1 and 128
      and "grant_domain_recipient_sync_campaigns"."reason" ~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]*$'),
	CONSTRAINT "grant_domain_sync_lifecycle" CHECK (("grant_domain_recipient_sync_campaigns"."state" = 'ready' and "grant_domain_recipient_sync_campaigns"."covered_envelope_count" = "grant_domain_recipient_sync_campaigns"."required_envelope_count" and "grant_domain_recipient_sync_campaigns"."reason" is null and "grant_domain_recipient_sync_campaigns"."terminal_at" is not null)
        or ("grant_domain_recipient_sync_campaigns"."state" in ('unrecoverable', 'stale') and "grant_domain_recipient_sync_campaigns"."covered_envelope_count" < "grant_domain_recipient_sync_campaigns"."required_envelope_count" and "grant_domain_recipient_sync_campaigns"."reason" is not null and "grant_domain_recipient_sync_campaigns"."terminal_at" is not null)
        or ("grant_domain_recipient_sync_campaigns"."state" not in ('ready', 'unrecoverable', 'stale') and "grant_domain_recipient_sync_campaigns"."reason" is not null and "grant_domain_recipient_sync_campaigns"."terminal_at" is null))
);
--> statement-breakpoint
ALTER TABLE "grant_domain_recipient_sync_campaigns" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "namespace_grant_domain_bindings" (
	"operation_id" text PRIMARY KEY NOT NULL,
	"idempotency_key" text NOT NULL,
	"namespace_id" uuid NOT NULL,
	"source_grant_domain_id" text,
	"target_grant_domain_id" text NOT NULL,
	"target_participant_digest" "bytea" NOT NULL,
	"target_domain_key_generation" bigint NOT NULL,
	"target_domain_authorization_revision" bigint NOT NULL,
	"target_domain_head_digest" "bytea" NOT NULL,
	"namespace_access_revision" bigint NOT NULL,
	"namespace_audience_fingerprint" "bytea" NOT NULL,
	"namespace_ai_generation" bigint NOT NULL,
	"namespace_ai_head_digest" "bytea" NOT NULL,
	"bundle_revision" bigint NOT NULL,
	"retained_generation_count" integer NOT NULL,
	"previous_binding_digest" "bytea",
	"binding_digest" "bytea" NOT NULL,
	"bundle_plaintext_digest" "bytea" NOT NULL,
	"bundle_ciphertext_digest" "bytea" NOT NULL,
	"bundle_bytes" "bytea" NOT NULL,
	"issuer_human_id" text NOT NULL,
	"issuer_device_id" text NOT NULL,
	"issuer_device_generation" bigint NOT NULL,
	"state" text NOT NULL,
	"failure_code" text,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"deadline_at" timestamp with time zone NOT NULL,
	"activated_at" timestamp with time zone,
	"terminal_at" timestamp with time zone,
	CONSTRAINT "uq_namespace_grant_domain_bindings_idempotency" UNIQUE("idempotency_key"),
	CONSTRAINT "uq_namespace_grant_domain_bindings_revision" UNIQUE("namespace_id","bundle_revision"),
	CONSTRAINT "uq_namespace_grant_domain_bindings_digest" UNIQUE("binding_digest"),
	CONSTRAINT "namespace_grant_domain_bindings_operation" CHECK (octet_length("namespace_grant_domain_bindings"."operation_id") between 1 and 128
      and "namespace_grant_domain_bindings"."operation_id" ~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]*$'),
	CONSTRAINT "namespace_grant_domain_bindings_idempotency" CHECK (octet_length("namespace_grant_domain_bindings"."idempotency_key") between 1 and 128
      and "namespace_grant_domain_bindings"."idempotency_key" ~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]*$'),
	CONSTRAINT "namespace_grant_domain_bindings_source" CHECK (octet_length("namespace_grant_domain_bindings"."source_grant_domain_id") between 1 and 128
      and "namespace_grant_domain_bindings"."source_grant_domain_id" ~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]*$'),
	CONSTRAINT "namespace_grant_domain_bindings_target" CHECK (octet_length("namespace_grant_domain_bindings"."target_grant_domain_id") between 1 and 128
      and "namespace_grant_domain_bindings"."target_grant_domain_id" ~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]*$'),
	CONSTRAINT "namespace_grant_domain_bindings_participants" CHECK (octet_length("namespace_grant_domain_bindings"."target_participant_digest") = 32),
	CONSTRAINT "namespace_grant_domain_bindings_domain_generation" CHECK ("namespace_grant_domain_bindings"."target_domain_key_generation" between 0 and 9007199254740991),
	CONSTRAINT "namespace_grant_domain_bindings_domain_authorization" CHECK ("namespace_grant_domain_bindings"."target_domain_authorization_revision" between 0 and 9007199254740991),
	CONSTRAINT "namespace_grant_domain_bindings_domain_head" CHECK (octet_length("namespace_grant_domain_bindings"."target_domain_head_digest") = 32),
	CONSTRAINT "namespace_grant_domain_bindings_access_revision" CHECK ("namespace_grant_domain_bindings"."namespace_access_revision" between 0 and 9007199254740991),
	CONSTRAINT "namespace_grant_domain_bindings_audience" CHECK (octet_length("namespace_grant_domain_bindings"."namespace_audience_fingerprint") = 32),
	CONSTRAINT "namespace_grant_domain_bindings_ai_generation" CHECK ("namespace_grant_domain_bindings"."namespace_ai_generation" between 0 and 9007199254740991),
	CONSTRAINT "namespace_grant_domain_bindings_ai_head" CHECK (octet_length("namespace_grant_domain_bindings"."namespace_ai_head_digest") = 32),
	CONSTRAINT "namespace_grant_domain_bindings_revision" CHECK ("namespace_grant_domain_bindings"."bundle_revision" between 0 and 9007199254740991),
	CONSTRAINT "namespace_grant_domain_bindings_retained_count" CHECK ("namespace_grant_domain_bindings"."retained_generation_count" between 1 and 4096),
	CONSTRAINT "namespace_grant_domain_bindings_previous" CHECK (octet_length("namespace_grant_domain_bindings"."previous_binding_digest") = 32),
	CONSTRAINT "namespace_grant_domain_bindings_predecessor" CHECK (("namespace_grant_domain_bindings"."bundle_revision" = 1 and "namespace_grant_domain_bindings"."previous_binding_digest" is null) or ("namespace_grant_domain_bindings"."bundle_revision" > 1 and "namespace_grant_domain_bindings"."previous_binding_digest" is not null)),
	CONSTRAINT "namespace_grant_domain_bindings_digest" CHECK (octet_length("namespace_grant_domain_bindings"."binding_digest") = 32),
	CONSTRAINT "namespace_grant_domain_bindings_plaintext" CHECK (octet_length("namespace_grant_domain_bindings"."bundle_plaintext_digest") = 32),
	CONSTRAINT "namespace_grant_domain_bindings_ciphertext" CHECK (octet_length("namespace_grant_domain_bindings"."bundle_ciphertext_digest") = 32),
	CONSTRAINT "namespace_grant_domain_bindings_bytes" CHECK (octet_length("namespace_grant_domain_bindings"."bundle_bytes") between 1 and 2097152),
	CONSTRAINT "namespace_grant_domain_bindings_issuer_human" CHECK (octet_length("namespace_grant_domain_bindings"."issuer_human_id") between 1 and 128
      and "namespace_grant_domain_bindings"."issuer_human_id" ~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]*$'),
	CONSTRAINT "namespace_grant_domain_bindings_issuer_device" CHECK (octet_length("namespace_grant_domain_bindings"."issuer_device_id") between 1 and 128
      and "namespace_grant_domain_bindings"."issuer_device_id" ~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]*$'),
	CONSTRAINT "namespace_grant_domain_bindings_issuer_generation" CHECK ("namespace_grant_domain_bindings"."issuer_device_generation" between 0 and 9007199254740991),
	CONSTRAINT "namespace_grant_domain_bindings_state" CHECK ("namespace_grant_domain_bindings"."state" in ('reserved', 'active', 'stale', 'expired', 'failed')),
	CONSTRAINT "namespace_grant_domain_bindings_failure" CHECK (octet_length("namespace_grant_domain_bindings"."failure_code") between 1 and 128
      and "namespace_grant_domain_bindings"."failure_code" ~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]*$'),
	CONSTRAINT "namespace_grant_domain_bindings_lifecycle" CHECK (("namespace_grant_domain_bindings"."state" = 'reserved' and "namespace_grant_domain_bindings"."failure_code" is null and "namespace_grant_domain_bindings"."activated_at" is null and "namespace_grant_domain_bindings"."terminal_at" is null)
        or ("namespace_grant_domain_bindings"."state" = 'active' and "namespace_grant_domain_bindings"."failure_code" is null and "namespace_grant_domain_bindings"."activated_at" is not null and "namespace_grant_domain_bindings"."terminal_at" is not null)
        or ("namespace_grant_domain_bindings"."state" in ('stale', 'expired', 'failed') and "namespace_grant_domain_bindings"."failure_code" is not null and "namespace_grant_domain_bindings"."activated_at" is null and "namespace_grant_domain_bindings"."terminal_at" is not null)),
	CONSTRAINT "namespace_grant_domain_bindings_time" CHECK ("namespace_grant_domain_bindings"."updated_at" >= "namespace_grant_domain_bindings"."created_at" and "namespace_grant_domain_bindings"."deadline_at" > "namespace_grant_domain_bindings"."created_at" and "namespace_grant_domain_bindings"."deadline_at" <= "namespace_grant_domain_bindings"."created_at" + interval '30 seconds')
);
--> statement-breakpoint
ALTER TABLE "namespace_grant_domain_bindings" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "namespace_grant_domain_heads" (
	"namespace_id" uuid PRIMARY KEY NOT NULL,
	"grant_domain_id" text NOT NULL,
	"participant_digest" "bytea" NOT NULL,
	"domain_key_generation" bigint NOT NULL,
	"domain_authorization_revision" bigint NOT NULL,
	"domain_head_digest" "bytea" NOT NULL,
	"namespace_access_revision" bigint NOT NULL,
	"namespace_audience_fingerprint" "bytea" NOT NULL,
	"bundle_revision" bigint NOT NULL,
	"binding_digest" "bytea" NOT NULL,
	"binding_operation_id" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"activated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "namespace_grant_domain_heads_domain" CHECK (octet_length("namespace_grant_domain_heads"."grant_domain_id") between 1 and 128
      and "namespace_grant_domain_heads"."grant_domain_id" ~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]*$'),
	CONSTRAINT "namespace_grant_domain_heads_participants" CHECK (octet_length("namespace_grant_domain_heads"."participant_digest") = 32),
	CONSTRAINT "namespace_grant_domain_heads_domain_generation" CHECK ("namespace_grant_domain_heads"."domain_key_generation" between 0 and 9007199254740991),
	CONSTRAINT "namespace_grant_domain_heads_domain_authorization" CHECK ("namespace_grant_domain_heads"."domain_authorization_revision" between 0 and 9007199254740991),
	CONSTRAINT "namespace_grant_domain_heads_domain_head" CHECK (octet_length("namespace_grant_domain_heads"."domain_head_digest") = 32),
	CONSTRAINT "namespace_grant_domain_heads_access_revision" CHECK ("namespace_grant_domain_heads"."namespace_access_revision" between 0 and 9007199254740991),
	CONSTRAINT "namespace_grant_domain_heads_audience" CHECK (octet_length("namespace_grant_domain_heads"."namespace_audience_fingerprint") = 32),
	CONSTRAINT "namespace_grant_domain_heads_bundle_revision" CHECK ("namespace_grant_domain_heads"."bundle_revision" between 0 and 9007199254740991),
	CONSTRAINT "namespace_grant_domain_heads_binding" CHECK (octet_length("namespace_grant_domain_heads"."binding_digest") = 32),
	CONSTRAINT "namespace_grant_domain_heads_operation" CHECK (octet_length("namespace_grant_domain_heads"."binding_operation_id") between 1 and 128
      and "namespace_grant_domain_heads"."binding_operation_id" ~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]*$'),
	CONSTRAINT "namespace_grant_domain_heads_time" CHECK ("namespace_grant_domain_heads"."activated_at" >= "namespace_grant_domain_heads"."created_at")
);
--> statement-breakpoint
ALTER TABLE "namespace_grant_domain_heads" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "grant_domain_envelope_acknowledgements" ADD CONSTRAINT "grant_domain_ack_envelope_fk" FOREIGN KEY ("grant_domain_id","domain_key_generation","recipient_human_id","recipient_key_id","recipient_key_generation","envelope_digest","head_digest") REFERENCES "public"."grant_domain_recipient_envelopes"("grant_domain_id","domain_key_generation","recipient_human_id","recipient_key_id","recipient_key_generation","envelope_digest","head_digest") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "grant_domain_envelope_acknowledgements" ADD CONSTRAINT "grant_domain_ack_device_fk" FOREIGN KEY ("device_id") REFERENCES "public"."human_crypto_devices"("device_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "grant_domain_heads" ADD CONSTRAINT "grant_domain_heads_publication_fk" FOREIGN KEY ("publication_operation_id") REFERENCES "public"."grant_domain_publication_operations"("operation_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "grant_domain_heads" ADD CONSTRAINT "grant_domain_heads_issuer_fk" FOREIGN KEY ("issuer_device_id") REFERENCES "public"."human_crypto_devices"("device_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "grant_domain_publication_operations" ADD CONSTRAINT "grant_domain_pub_issuer_human_fk" FOREIGN KEY ("issuer_human_id") REFERENCES "public"."human_crypto_custodies"("human_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "grant_domain_publication_operations" ADD CONSTRAINT "grant_domain_pub_issuer_device_fk" FOREIGN KEY ("issuer_device_id") REFERENCES "public"."human_crypto_devices"("device_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "grant_domain_recipient_authorization_operations" ADD CONSTRAINT "grant_domain_recipient_auth_issuer_human_fk" FOREIGN KEY ("issuer_human_id") REFERENCES "public"."human_crypto_custodies"("human_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "grant_domain_recipient_authorization_operations" ADD CONSTRAINT "grant_domain_recipient_auth_issuer_device_fk" FOREIGN KEY ("issuer_device_id") REFERENCES "public"."human_crypto_devices"("device_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "grant_domain_recipient_authorization_operations" ADD CONSTRAINT "grant_domain_recipient_auth_human_fk" FOREIGN KEY ("recipient_human_id") REFERENCES "public"."human_crypto_custodies"("human_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "grant_domain_recipient_authorization_operations" ADD CONSTRAINT "grant_domain_recipient_auth_device_fk" FOREIGN KEY ("recipient_device_id") REFERENCES "public"."human_crypto_devices"("device_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "grant_domain_recipient_authorization_operations" ADD CONSTRAINT "grant_domain_recipient_auth_recovery_key_fk" FOREIGN KEY ("recipient_recovery_key_id") REFERENCES "public"."human_crypto_recovery_keys"("recovery_key_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "grant_domain_recipient_authorization_operations" ADD CONSTRAINT "grant_domain_recipient_auth_recovery_generation_fk" FOREIGN KEY ("recipient_human_id","recipient_recovery_generation") REFERENCES "public"."human_crypto_recovery_keys"("human_id","generation") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "grant_domain_recipient_envelopes" ADD CONSTRAINT "grant_domain_envelopes_human_fk" FOREIGN KEY ("recipient_human_id") REFERENCES "public"."human_crypto_custodies"("human_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "grant_domain_recipient_envelopes" ADD CONSTRAINT "grant_domain_envelopes_device_fk" FOREIGN KEY ("recipient_device_id") REFERENCES "public"."human_crypto_devices"("device_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "grant_domain_recipient_envelopes" ADD CONSTRAINT "grant_domain_envelopes_recovery_key_fk" FOREIGN KEY ("recipient_recovery_key_id") REFERENCES "public"."human_crypto_recovery_keys"("recovery_key_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "grant_domain_recipient_envelopes" ADD CONSTRAINT "grant_domain_envelopes_recovery_generation_fk" FOREIGN KEY ("recipient_human_id","recipient_recovery_generation") REFERENCES "public"."human_crypto_recovery_keys"("human_id","generation") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "grant_domain_recipient_envelopes" ADD CONSTRAINT "grant_domain_envelopes_issuer_fk" FOREIGN KEY ("issuer_device_id") REFERENCES "public"."human_crypto_devices"("device_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "grant_domain_recipient_envelopes" ADD CONSTRAINT "grant_domain_envelopes_publication_fk" FOREIGN KEY ("publication_operation_id") REFERENCES "public"."grant_domain_publication_operations"("operation_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "grant_domain_recipient_sync_campaigns" ADD CONSTRAINT "grant_domain_sync_human_fk" FOREIGN KEY ("recipient_human_id") REFERENCES "public"."human_crypto_custodies"("human_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "grant_domain_recipient_sync_campaigns" ADD CONSTRAINT "grant_domain_sync_device_fk" FOREIGN KEY ("recipient_device_id") REFERENCES "public"."human_crypto_devices"("device_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "grant_domain_recipient_sync_campaigns" ADD CONSTRAINT "grant_domain_sync_recovery_key_fk" FOREIGN KEY ("recipient_recovery_key_id") REFERENCES "public"."human_crypto_recovery_keys"("recovery_key_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "grant_domain_recipient_sync_campaigns" ADD CONSTRAINT "grant_domain_sync_recovery_generation_fk" FOREIGN KEY ("recipient_human_id","recipient_recovery_generation") REFERENCES "public"."human_crypto_recovery_keys"("human_id","generation") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "namespace_grant_domain_bindings" ADD CONSTRAINT "namespace_grant_domain_bindings_namespace_fk" FOREIGN KEY ("namespace_id") REFERENCES "public"."namespaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "namespace_grant_domain_bindings" ADD CONSTRAINT "namespace_grant_domain_bindings_domain_fk" FOREIGN KEY ("target_participant_digest") REFERENCES "public"."grant_domain_heads"("participant_digest") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "namespace_grant_domain_bindings" ADD CONSTRAINT "namespace_grant_domain_bindings_issuer_human_fk" FOREIGN KEY ("issuer_human_id") REFERENCES "public"."human_crypto_custodies"("human_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "namespace_grant_domain_bindings" ADD CONSTRAINT "namespace_grant_domain_bindings_issuer_device_fk" FOREIGN KEY ("issuer_device_id") REFERENCES "public"."human_crypto_devices"("device_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "namespace_grant_domain_heads" ADD CONSTRAINT "namespace_grant_domain_heads_namespace_fk" FOREIGN KEY ("namespace_id") REFERENCES "public"."namespaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "namespace_grant_domain_heads" ADD CONSTRAINT "namespace_grant_domain_heads_domain_fk" FOREIGN KEY ("participant_digest") REFERENCES "public"."grant_domain_heads"("participant_digest") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "namespace_grant_domain_heads" ADD CONSTRAINT "namespace_grant_domain_heads_binding_fk" FOREIGN KEY ("binding_operation_id") REFERENCES "public"."namespace_grant_domain_bindings"("operation_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_grant_domain_ack_device" ON "grant_domain_envelope_acknowledgements" USING btree ("device_id","acknowledged_at");--> statement-breakpoint
CREATE INDEX "idx_grant_domain_heads_publication" ON "grant_domain_heads" USING btree ("publication_operation_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_grant_domain_pub_live_participants" ON "grant_domain_publication_operations" USING btree ("participant_digest") WHERE "grant_domain_publication_operations"."state" = 'reserved';--> statement-breakpoint
CREATE INDEX "idx_grant_domain_pub_reconcile" ON "grant_domain_publication_operations" USING btree ("state","deadline_at");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_grant_domain_recipient_auth_live_target" ON "grant_domain_recipient_authorization_operations" USING btree ("grant_domain_id","domain_key_generation","recipient_human_id","recipient_kind","recipient_key_id","recipient_key_generation") WHERE "grant_domain_recipient_authorization_operations"."state" = 'reserved';--> statement-breakpoint
CREATE INDEX "idx_grant_domain_recipient_auth_reconcile" ON "grant_domain_recipient_authorization_operations" USING btree ("state","deadline_at");--> statement-breakpoint
CREATE INDEX "idx_grant_domain_envelopes_device_fetch" ON "grant_domain_recipient_envelopes" USING btree ("recipient_device_id","grant_domain_id","domain_key_generation");--> statement-breakpoint
CREATE INDEX "idx_grant_domain_envelopes_recovery_fetch" ON "grant_domain_recipient_envelopes" USING btree ("recipient_recovery_key_id","grant_domain_id","domain_key_generation");--> statement-breakpoint
CREATE INDEX "idx_grant_domain_sync_status" ON "grant_domain_recipient_sync_campaigns" USING btree ("recipient_human_id","state","updated_at");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_namespace_grant_domain_bindings_live" ON "namespace_grant_domain_bindings" USING btree ("namespace_id") WHERE "namespace_grant_domain_bindings"."state" = 'reserved';--> statement-breakpoint
CREATE INDEX "idx_namespace_grant_domain_bindings_reconcile" ON "namespace_grant_domain_bindings" USING btree ("state","deadline_at");--> statement-breakpoint
CREATE INDEX "idx_namespace_grant_domain_heads_domain" ON "namespace_grant_domain_heads" USING btree ("grant_domain_id","namespace_id");--> statement-breakpoint
CREATE POLICY "grant_domain_ack_crypto_sel" ON "grant_domain_envelope_acknowledgements" AS PERMISSIVE FOR SELECT TO "nautilo_crypto" USING (true);--> statement-breakpoint
CREATE POLICY "grant_domain_ack_crypto_ins" ON "grant_domain_envelope_acknowledgements" AS PERMISSIVE FOR INSERT TO "nautilo_crypto" WITH CHECK (true);--> statement-breakpoint
CREATE POLICY "grant_domain_heads_crypto_sel" ON "grant_domain_heads" AS PERMISSIVE FOR SELECT TO "nautilo_crypto" USING (true);--> statement-breakpoint
CREATE POLICY "grant_domain_heads_crypto_ins" ON "grant_domain_heads" AS PERMISSIVE FOR INSERT TO "nautilo_crypto" WITH CHECK (true);--> statement-breakpoint
CREATE POLICY "grant_domain_heads_crypto_upd" ON "grant_domain_heads" AS PERMISSIVE FOR UPDATE TO "nautilo_crypto" USING (true) WITH CHECK (true);--> statement-breakpoint
CREATE POLICY "grant_domain_pub_crypto_sel" ON "grant_domain_publication_operations" AS PERMISSIVE FOR SELECT TO "nautilo_crypto" USING (true);--> statement-breakpoint
CREATE POLICY "grant_domain_pub_crypto_ins" ON "grant_domain_publication_operations" AS PERMISSIVE FOR INSERT TO "nautilo_crypto" WITH CHECK (true);--> statement-breakpoint
CREATE POLICY "grant_domain_pub_crypto_upd" ON "grant_domain_publication_operations" AS PERMISSIVE FOR UPDATE TO "nautilo_crypto" USING (true) WITH CHECK (true);--> statement-breakpoint
CREATE POLICY "grant_domain_recipient_auth_crypto_sel" ON "grant_domain_recipient_authorization_operations" AS PERMISSIVE FOR SELECT TO "nautilo_crypto" USING (true);--> statement-breakpoint
CREATE POLICY "grant_domain_recipient_auth_crypto_ins" ON "grant_domain_recipient_authorization_operations" AS PERMISSIVE FOR INSERT TO "nautilo_crypto" WITH CHECK (true);--> statement-breakpoint
CREATE POLICY "grant_domain_recipient_auth_crypto_upd" ON "grant_domain_recipient_authorization_operations" AS PERMISSIVE FOR UPDATE TO "nautilo_crypto" USING (true) WITH CHECK (true);--> statement-breakpoint
CREATE POLICY "grant_domain_envelopes_crypto_sel" ON "grant_domain_recipient_envelopes" AS PERMISSIVE FOR SELECT TO "nautilo_crypto" USING (true);--> statement-breakpoint
CREATE POLICY "grant_domain_envelopes_crypto_ins" ON "grant_domain_recipient_envelopes" AS PERMISSIVE FOR INSERT TO "nautilo_crypto" WITH CHECK (true);--> statement-breakpoint
CREATE POLICY "grant_domain_sync_crypto_sel" ON "grant_domain_recipient_sync_campaigns" AS PERMISSIVE FOR SELECT TO "nautilo_crypto" USING (true);--> statement-breakpoint
CREATE POLICY "grant_domain_sync_crypto_ins" ON "grant_domain_recipient_sync_campaigns" AS PERMISSIVE FOR INSERT TO "nautilo_crypto" WITH CHECK (true);--> statement-breakpoint
CREATE POLICY "grant_domain_sync_crypto_upd" ON "grant_domain_recipient_sync_campaigns" AS PERMISSIVE FOR UPDATE TO "nautilo_crypto" USING (true) WITH CHECK (true);--> statement-breakpoint
CREATE POLICY "namespace_grant_domain_bindings_crypto_sel" ON "namespace_grant_domain_bindings" AS PERMISSIVE FOR SELECT TO "nautilo_crypto" USING (true);--> statement-breakpoint
CREATE POLICY "namespace_grant_domain_bindings_crypto_ins" ON "namespace_grant_domain_bindings" AS PERMISSIVE FOR INSERT TO "nautilo_crypto" WITH CHECK (true);--> statement-breakpoint
CREATE POLICY "namespace_grant_domain_bindings_crypto_upd" ON "namespace_grant_domain_bindings" AS PERMISSIVE FOR UPDATE TO "nautilo_crypto" USING (true) WITH CHECK (true);--> statement-breakpoint
CREATE POLICY "namespace_grant_domain_heads_crypto_sel" ON "namespace_grant_domain_heads" AS PERMISSIVE FOR SELECT TO "nautilo_crypto" USING (true);--> statement-breakpoint
CREATE POLICY "namespace_grant_domain_heads_crypto_ins" ON "namespace_grant_domain_heads" AS PERMISSIVE FOR INSERT TO "nautilo_crypto" WITH CHECK (true);--> statement-breakpoint
CREATE POLICY "namespace_grant_domain_heads_crypto_upd" ON "namespace_grant_domain_heads" AS PERMISSIVE FOR UPDATE TO "nautilo_crypto" USING (true) WITH CHECK (true);
--> statement-breakpoint
-- M291_GRANT_DOMAIN_AUTHORITY
ALTER TABLE "grant_domain_publication_operations" FORCE ROW LEVEL SECURITY;
ALTER TABLE "grant_domain_recipient_authorization_operations" FORCE ROW LEVEL SECURITY;
ALTER TABLE "grant_domain_recipient_sync_campaigns" FORCE ROW LEVEL SECURITY;
ALTER TABLE "grant_domain_heads" FORCE ROW LEVEL SECURITY;
ALTER TABLE "grant_domain_recipient_envelopes" FORCE ROW LEVEL SECURITY;
ALTER TABLE "grant_domain_envelope_acknowledgements" FORCE ROW LEVEL SECURITY;
ALTER TABLE "namespace_grant_domain_bindings" FORCE ROW LEVEL SECURITY;
ALTER TABLE "namespace_grant_domain_heads" FORCE ROW LEVEL SECURITY;
CREATE OR REPLACE FUNCTION "public"."protect_grant_domain_lifecycle_operation"()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog
AS $$
DECLARE
  old_identity jsonb;
  new_identity jsonb;
BEGIN
  old_identity := to_jsonb(OLD) - ARRAY[
    'state', 'failure_code', 'updated_at', 'activated_at', 'terminal_at'
  ];
  new_identity := to_jsonb(NEW) - ARRAY[
    'state', 'failure_code', 'updated_at', 'activated_at', 'terminal_at'
  ];
  IF new_identity IS DISTINCT FROM old_identity THEN
    RAISE EXCEPTION 'Grant Domain operation identity is immutable'
      USING ERRCODE = '23514';
  END IF;
  IF NOT (
    NEW.state = OLD.state
    OR (OLD.state = 'reserved' AND NEW.state IN ('active', 'stale', 'expired', 'failed'))
  ) THEN
    RAISE EXCEPTION 'Grant Domain operation state transition is invalid'
      USING ERRCODE = '23514';
  END IF;
  IF NEW.updated_at < OLD.updated_at
    OR (OLD.failure_code IS NOT NULL AND NEW.failure_code IS DISTINCT FROM OLD.failure_code)
    OR (OLD.activated_at IS NOT NULL AND NEW.activated_at IS DISTINCT FROM OLD.activated_at)
    OR (OLD.terminal_at IS NOT NULL AND NEW.terminal_at IS DISTINCT FROM OLD.terminal_at)
  THEN
    RAISE EXCEPTION 'Grant Domain operation receipts and time are monotonic'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION "public"."protect_grant_domain_lifecycle_operation"()
  FROM PUBLIC, "nautilo", "nautilo_agent", "nautilo_crypto";
GRANT EXECUTE ON FUNCTION "public"."protect_grant_domain_lifecycle_operation"()
  TO "nautilo_crypto", "nautilo";
CREATE TRIGGER "grant_domain_publications_protected"
BEFORE UPDATE ON "grant_domain_publication_operations"
FOR EACH ROW EXECUTE FUNCTION "public"."protect_grant_domain_lifecycle_operation"();
CREATE TRIGGER "grant_domain_recipient_authorizations_protected"
BEFORE UPDATE ON "grant_domain_recipient_authorization_operations"
FOR EACH ROW EXECUTE FUNCTION "public"."protect_grant_domain_lifecycle_operation"();
CREATE TRIGGER "namespace_grant_domain_bindings_protected"
BEFORE UPDATE ON "namespace_grant_domain_bindings"
FOR EACH ROW EXECUTE FUNCTION "public"."protect_grant_domain_lifecycle_operation"();

CREATE OR REPLACE FUNCTION "public"."protect_grant_domain_sync_campaign"()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog
AS $$
BEGIN
  IF (to_jsonb(NEW) - ARRAY[
        'covered_envelope_count', 'state', 'reason', 'updated_at', 'terminal_at'
      ]) IS DISTINCT FROM (to_jsonb(OLD) - ARRAY[
        'covered_envelope_count', 'state', 'reason', 'updated_at', 'terminal_at'
      ])
  THEN
    RAISE EXCEPTION 'Grant Domain sync campaign identity is immutable'
      USING ERRCODE = '23514';
  END IF;
  IF NEW.covered_envelope_count < OLD.covered_envelope_count
    OR NEW.updated_at < OLD.updated_at
    OR (OLD.terminal_at IS NOT NULL AND NEW IS DISTINCT FROM OLD)
  THEN
    RAISE EXCEPTION 'Grant Domain sync campaign progress is monotonic'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION "public"."protect_grant_domain_sync_campaign"()
  FROM PUBLIC, "nautilo", "nautilo_agent", "nautilo_crypto";
GRANT EXECUTE ON FUNCTION "public"."protect_grant_domain_sync_campaign"()
  TO "nautilo_crypto", "nautilo";
CREATE TRIGGER "grant_domain_sync_campaigns_protected"
BEFORE UPDATE ON "grant_domain_recipient_sync_campaigns"
FOR EACH ROW EXECUTE FUNCTION "public"."protect_grant_domain_sync_campaign"();

CREATE OR REPLACE FUNCTION "public"."protect_grant_domain_head"()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog
AS $$
BEGIN
  IF NEW.participant_digest IS DISTINCT FROM OLD.participant_digest
    OR NEW.participant_count IS DISTINCT FROM OLD.participant_count
    OR NEW.participant_set_bytes IS DISTINCT FROM OLD.participant_set_bytes
    OR NEW.grant_domain_id IS DISTINCT FROM OLD.grant_domain_id
    OR NEW.created_at IS DISTINCT FROM OLD.created_at
  THEN
    RAISE EXCEPTION 'Grant Domain identity is immutable'
      USING ERRCODE = '23514';
  END IF;
  IF NEW.domain_key_generation < OLD.domain_key_generation
    OR NEW.authorization_revision < OLD.authorization_revision
    OR NEW.binding_count < 0
    OR NEW.activated_at < OLD.activated_at
  THEN
    RAISE EXCEPTION 'Grant Domain head counters are monotonic'
      USING ERRCODE = '23514';
  END IF;
  IF NEW.domain_key_generation = OLD.domain_key_generation THEN
    IF NEW.head_digest IS DISTINCT FROM OLD.head_digest
      OR NEW.previous_head_digest IS DISTINCT FROM OLD.previous_head_digest
      OR NEW.publication_digest IS DISTINCT FROM OLD.publication_digest
      OR NEW.publication_operation_id IS DISTINCT FROM OLD.publication_operation_id
      OR NEW.publication_authorization_revision IS DISTINCT FROM OLD.publication_authorization_revision
      OR NEW.recipient_set_digest IS DISTINCT FROM OLD.recipient_set_digest
      OR NEW.recipient_count IS DISTINCT FROM OLD.recipient_count
      OR NEW.issuer_device_id IS DISTINCT FROM OLD.issuer_device_id
      OR NEW.issuer_device_generation IS DISTINCT FROM OLD.issuer_device_generation
    THEN
      RAISE EXCEPTION 'Grant Domain generation evidence is immutable'
        USING ERRCODE = '23514';
    END IF;
    IF NEW.authorization_revision = OLD.authorization_revision
      AND (NEW.binding_set_digest IS DISTINCT FROM OLD.binding_set_digest
        OR NEW.binding_count IS DISTINCT FROM OLD.binding_count)
    THEN
      RAISE EXCEPTION 'Grant Domain binding-set change requires authorization revision advance'
        USING ERRCODE = '23514';
    END IF;
  ELSIF NEW.domain_key_generation <> OLD.domain_key_generation + 1
    OR NEW.previous_head_digest IS DISTINCT FROM OLD.head_digest
    OR NEW.authorization_revision <= OLD.authorization_revision
  THEN
    RAISE EXCEPTION 'Grant Domain key rotation must advance one generation from the exact predecessor'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION "public"."protect_grant_domain_head"()
  FROM PUBLIC, "nautilo", "nautilo_agent", "nautilo_crypto";
GRANT EXECUTE ON FUNCTION "public"."protect_grant_domain_head"()
  TO "nautilo_crypto", "nautilo";
CREATE TRIGGER "grant_domain_heads_monotonic"
BEFORE UPDATE ON "grant_domain_heads"
FOR EACH ROW EXECUTE FUNCTION "public"."protect_grant_domain_head"();

CREATE OR REPLACE FUNCTION "public"."validate_grant_domain_publication"()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog
AS $$
DECLARE
  envelope_count bigint;
  envelope_bytes numeric;
BEGIN
  IF NEW.state <> 'active' THEN RETURN NEW; END IF;
  SELECT count(*), coalesce(sum(octet_length(envelope_row.envelope_bytes)), 0)
    INTO envelope_count, envelope_bytes
    FROM "public"."grant_domain_recipient_envelopes" AS envelope_row
   WHERE envelope_row.publication_operation_id = NEW.operation_id
     AND envelope_row.grant_domain_id = NEW.grant_domain_id
     AND envelope_row.participant_digest = NEW.participant_digest
     AND envelope_row.domain_key_generation = NEW.domain_key_generation
     AND envelope_row.authorization_revision = NEW.authorization_revision;
  IF envelope_count <> NEW.recipient_count
    OR envelope_bytes <> NEW.aggregate_envelope_bytes
  THEN
    RAISE EXCEPTION 'active Grant Domain publication lacks its complete envelope set'
      USING ERRCODE = '23514';
  END IF;
  PERFORM 1 FROM "public"."grant_domain_heads" AS head_row
   WHERE head_row.participant_digest = NEW.participant_digest
     AND head_row.grant_domain_id = NEW.grant_domain_id
     AND head_row.domain_key_generation = NEW.domain_key_generation
     AND head_row.publication_authorization_revision = NEW.authorization_revision
     AND head_row.head_digest = NEW.head_digest
     AND head_row.publication_digest = NEW.publication_digest
     AND head_row.publication_operation_id = NEW.operation_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'active Grant Domain publication lacks its exact current head'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION "public"."validate_grant_domain_publication"()
  FROM PUBLIC, "nautilo", "nautilo_agent", "nautilo_crypto";
GRANT EXECUTE ON FUNCTION "public"."validate_grant_domain_publication"()
  TO "nautilo_crypto", "nautilo";
CREATE CONSTRAINT TRIGGER "grant_domain_publications_complete"
AFTER INSERT OR UPDATE ON "grant_domain_publication_operations"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "public"."validate_grant_domain_publication"();

CREATE OR REPLACE FUNCTION "public"."validate_grant_domain_head_publication"()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog
AS $$
BEGIN
  PERFORM 1 FROM "public"."grant_domain_publication_operations" AS operation_row
   WHERE operation_row.operation_id = NEW.publication_operation_id
     AND operation_row.state = 'active'
     AND operation_row.grant_domain_id = NEW.grant_domain_id
     AND operation_row.participant_digest = NEW.participant_digest
     AND operation_row.domain_key_generation = NEW.domain_key_generation
     AND operation_row.authorization_revision = NEW.publication_authorization_revision
     AND operation_row.head_digest = NEW.head_digest
     AND operation_row.publication_digest = NEW.publication_digest;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Grant Domain head points to inactive or mismatched publication evidence'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION "public"."validate_grant_domain_head_publication"()
  FROM PUBLIC, "nautilo", "nautilo_agent", "nautilo_crypto";
GRANT EXECUTE ON FUNCTION "public"."validate_grant_domain_head_publication"()
  TO "nautilo_crypto", "nautilo";
CREATE CONSTRAINT TRIGGER "grant_domain_heads_active_publication"
AFTER INSERT OR UPDATE ON "grant_domain_heads"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "public"."validate_grant_domain_head_publication"();

CREATE OR REPLACE FUNCTION "public"."validate_grant_domain_envelope_origin"()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog
AS $$
BEGIN
  IF NEW.publication_operation_id IS NOT NULL THEN
    PERFORM 1 FROM "public"."grant_domain_publication_operations" AS operation_row
     WHERE operation_row.operation_id = NEW.publication_operation_id
       AND operation_row.state = 'active'
       AND operation_row.grant_domain_id = NEW.grant_domain_id
       AND operation_row.participant_digest = NEW.participant_digest
       AND operation_row.domain_key_generation = NEW.domain_key_generation
       AND operation_row.authorization_revision = NEW.authorization_revision;
  ELSE
    PERFORM 1 FROM "public"."grant_domain_recipient_authorization_operations" AS operation_row
     WHERE operation_row.operation_id = NEW.recipient_authorization_operation_id
       AND operation_row.state = 'active'
       AND operation_row.grant_domain_id = NEW.grant_domain_id
       AND operation_row.participant_digest = NEW.participant_digest
       AND operation_row.domain_key_generation = NEW.domain_key_generation
       AND operation_row.authorization_revision = NEW.authorization_revision
       AND operation_row.recipient_human_id = NEW.recipient_human_id
       AND operation_row.recipient_key_id = NEW.recipient_key_id
       AND operation_row.recipient_key_generation = NEW.recipient_key_generation
       AND operation_row.envelope_digest = NEW.envelope_digest;
  END IF;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Grant Domain envelope lacks active exact authority'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION "public"."validate_grant_domain_envelope_origin"()
  FROM PUBLIC, "nautilo", "nautilo_agent", "nautilo_crypto";
GRANT EXECUTE ON FUNCTION "public"."validate_grant_domain_envelope_origin"()
  TO "nautilo_crypto", "nautilo";
CREATE CONSTRAINT TRIGGER "grant_domain_envelopes_authorized"
AFTER INSERT ON "grant_domain_recipient_envelopes"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "public"."validate_grant_domain_envelope_origin"();

CREATE OR REPLACE FUNCTION "public"."validate_grant_domain_recipient_authorization"()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog
AS $$
BEGIN
  IF NEW.state <> 'active' THEN RETURN NEW; END IF;
  PERFORM 1 FROM "public"."grant_domain_recipient_envelopes" AS envelope_row
   WHERE envelope_row.recipient_authorization_operation_id = NEW.operation_id
     AND envelope_row.grant_domain_id = NEW.grant_domain_id
     AND envelope_row.participant_digest = NEW.participant_digest
     AND envelope_row.domain_key_generation = NEW.domain_key_generation
     AND envelope_row.authorization_revision = NEW.authorization_revision
     AND envelope_row.recipient_kind = NEW.recipient_kind
     AND envelope_row.recipient_human_id = NEW.recipient_human_id
     AND envelope_row.recipient_key_id = NEW.recipient_key_id
     AND envelope_row.recipient_key_generation = NEW.recipient_key_generation
     AND envelope_row.recipient_public_key_digest = NEW.recipient_public_key_digest
     AND envelope_row.envelope_digest = NEW.envelope_digest;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'active Grant Domain recipient authorization lacks its exact envelope'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION "public"."validate_grant_domain_recipient_authorization"()
  FROM PUBLIC, "nautilo", "nautilo_agent", "nautilo_crypto";
GRANT EXECUTE ON FUNCTION "public"."validate_grant_domain_recipient_authorization"()
  TO "nautilo_crypto", "nautilo";
CREATE CONSTRAINT TRIGGER "grant_domain_recipient_authorizations_complete"
AFTER INSERT OR UPDATE ON "grant_domain_recipient_authorization_operations"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "public"."validate_grant_domain_recipient_authorization"();

CREATE OR REPLACE FUNCTION "public"."validate_namespace_grant_domain_binding"()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog
AS $$
BEGIN
  IF NEW.state <> 'active' THEN RETURN NEW; END IF;
  PERFORM 1 FROM "public"."namespace_key_generation_heads" AS namespace_head
   WHERE namespace_head.namespace_id = NEW.namespace_id
     AND namespace_head.key_class = 'ai'
     AND namespace_head.generation = NEW.namespace_ai_generation
     AND namespace_head.access_revision = NEW.namespace_access_revision
     AND namespace_head.audience_fingerprint = NEW.namespace_audience_fingerprint
     AND namespace_head.head_digest = NEW.namespace_ai_head_digest
     AND namespace_head.generation_key_commitment IS NOT NULL;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'active Namespace Grant Domain binding lacks current M290 AI authority'
      USING ERRCODE = '23514';
  END IF;
  PERFORM 1 FROM "public"."grant_domain_heads" AS domain_head
   WHERE domain_head.participant_digest = NEW.target_participant_digest
     AND domain_head.grant_domain_id = NEW.target_grant_domain_id
     AND domain_head.domain_key_generation = NEW.target_domain_key_generation
     AND domain_head.authorization_revision = NEW.target_domain_authorization_revision
     AND domain_head.head_digest = NEW.target_domain_head_digest;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'active Namespace Grant Domain binding lacks current Domain authority'
      USING ERRCODE = '23514';
  END IF;
  PERFORM 1 FROM "public"."namespace_grant_domain_heads" AS binding_head
   WHERE binding_head.namespace_id = NEW.namespace_id
     AND binding_head.binding_operation_id = NEW.operation_id
     AND binding_head.binding_digest = NEW.binding_digest
     AND binding_head.bundle_revision = NEW.bundle_revision;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'active Namespace Grant Domain binding lacks its exact current pointer'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION "public"."validate_namespace_grant_domain_binding"()
  FROM PUBLIC, "nautilo", "nautilo_agent", "nautilo_crypto";
GRANT EXECUTE ON FUNCTION "public"."validate_namespace_grant_domain_binding"()
  TO "nautilo_crypto", "nautilo";
CREATE CONSTRAINT TRIGGER "namespace_grant_domain_bindings_complete"
AFTER INSERT OR UPDATE ON "namespace_grant_domain_bindings"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "public"."validate_namespace_grant_domain_binding"();

CREATE OR REPLACE FUNCTION "public"."protect_namespace_grant_domain_head"()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog
AS $$
BEGIN
  IF NEW.namespace_id IS DISTINCT FROM OLD.namespace_id
    OR NEW.bundle_revision <> OLD.bundle_revision + 1
    OR NEW.activated_at < OLD.activated_at
  THEN
    RAISE EXCEPTION 'Namespace Grant Domain head must advance exactly one immutable bundle revision'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION "public"."protect_namespace_grant_domain_head"()
  FROM PUBLIC, "nautilo", "nautilo_agent", "nautilo_crypto";
GRANT EXECUTE ON FUNCTION "public"."protect_namespace_grant_domain_head"()
  TO "nautilo_crypto", "nautilo";
CREATE TRIGGER "namespace_grant_domain_heads_monotonic"
BEFORE UPDATE ON "namespace_grant_domain_heads"
FOR EACH ROW EXECUTE FUNCTION "public"."protect_namespace_grant_domain_head"();

CREATE OR REPLACE FUNCTION "public"."validate_namespace_grant_domain_head"()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog
AS $$
BEGIN
  PERFORM 1 FROM "public"."namespace_grant_domain_bindings" AS binding_row
   WHERE binding_row.operation_id = NEW.binding_operation_id
     AND binding_row.state = 'active'
     AND binding_row.namespace_id = NEW.namespace_id
     AND binding_row.target_grant_domain_id = NEW.grant_domain_id
     AND binding_row.target_participant_digest = NEW.participant_digest
     AND binding_row.target_domain_key_generation = NEW.domain_key_generation
     AND binding_row.target_domain_authorization_revision = NEW.domain_authorization_revision
     AND binding_row.target_domain_head_digest = NEW.domain_head_digest
     AND binding_row.namespace_access_revision = NEW.namespace_access_revision
     AND binding_row.namespace_audience_fingerprint = NEW.namespace_audience_fingerprint
     AND binding_row.bundle_revision = NEW.bundle_revision
     AND binding_row.binding_digest = NEW.binding_digest;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Namespace Grant Domain head points to inactive or mismatched binding evidence'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION "public"."validate_namespace_grant_domain_head"()
  FROM PUBLIC, "nautilo", "nautilo_agent", "nautilo_crypto";
GRANT EXECUTE ON FUNCTION "public"."validate_namespace_grant_domain_head"()
  TO "nautilo_crypto", "nautilo";
CREATE CONSTRAINT TRIGGER "namespace_grant_domain_heads_active_binding"
AFTER INSERT OR UPDATE ON "namespace_grant_domain_heads"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "public"."validate_namespace_grant_domain_head"();

REVOKE ALL PRIVILEGES ON TABLE
  "grant_domain_publication_operations",
  "grant_domain_recipient_authorization_operations",
  "grant_domain_recipient_sync_campaigns",
  "grant_domain_heads",
  "grant_domain_recipient_envelopes",
  "grant_domain_envelope_acknowledgements",
  "namespace_grant_domain_bindings",
  "namespace_grant_domain_heads"
FROM PUBLIC, "nautilo_agent", "nautilo_crypto";
GRANT SELECT, INSERT, UPDATE ON TABLE "grant_domain_publication_operations" TO "nautilo_crypto";
GRANT SELECT, INSERT, UPDATE ON TABLE "grant_domain_recipient_authorization_operations" TO "nautilo_crypto";
GRANT SELECT, INSERT, UPDATE ON TABLE "grant_domain_recipient_sync_campaigns" TO "nautilo_crypto";
GRANT SELECT, INSERT, UPDATE ON TABLE "grant_domain_heads" TO "nautilo_crypto";
GRANT SELECT, INSERT ON TABLE "grant_domain_recipient_envelopes" TO "nautilo_crypto";
GRANT SELECT, INSERT ON TABLE "grant_domain_envelope_acknowledgements" TO "nautilo_crypto";
GRANT SELECT, INSERT, UPDATE ON TABLE "namespace_grant_domain_bindings" TO "nautilo_crypto";
GRANT SELECT, INSERT, UPDATE ON TABLE "namespace_grant_domain_heads" TO "nautilo_crypto";
REVOKE ALL ON FUNCTION "public"."protect_grant_domain_lifecycle_operation"() FROM PUBLIC, "nautilo", "nautilo_agent", "nautilo_crypto";
GRANT EXECUTE ON FUNCTION "public"."protect_grant_domain_lifecycle_operation"() TO "nautilo_crypto";
REVOKE ALL ON FUNCTION "public"."protect_grant_domain_sync_campaign"() FROM PUBLIC, "nautilo", "nautilo_agent", "nautilo_crypto";
GRANT EXECUTE ON FUNCTION "public"."protect_grant_domain_sync_campaign"() TO "nautilo_crypto";
REVOKE ALL ON FUNCTION "public"."protect_grant_domain_head"() FROM PUBLIC, "nautilo", "nautilo_agent", "nautilo_crypto";
GRANT EXECUTE ON FUNCTION "public"."protect_grant_domain_head"() TO "nautilo_crypto";
REVOKE ALL ON FUNCTION "public"."validate_grant_domain_publication"() FROM PUBLIC, "nautilo", "nautilo_agent", "nautilo_crypto";
GRANT EXECUTE ON FUNCTION "public"."validate_grant_domain_publication"() TO "nautilo_crypto";
REVOKE ALL ON FUNCTION "public"."validate_grant_domain_head_publication"() FROM PUBLIC, "nautilo", "nautilo_agent", "nautilo_crypto";
GRANT EXECUTE ON FUNCTION "public"."validate_grant_domain_head_publication"() TO "nautilo_crypto";
REVOKE ALL ON FUNCTION "public"."validate_grant_domain_envelope_origin"() FROM PUBLIC, "nautilo", "nautilo_agent", "nautilo_crypto";
GRANT EXECUTE ON FUNCTION "public"."validate_grant_domain_envelope_origin"() TO "nautilo_crypto";
REVOKE ALL ON FUNCTION "public"."validate_grant_domain_recipient_authorization"() FROM PUBLIC, "nautilo", "nautilo_agent", "nautilo_crypto";
GRANT EXECUTE ON FUNCTION "public"."validate_grant_domain_recipient_authorization"() TO "nautilo_crypto";
REVOKE ALL ON FUNCTION "public"."validate_namespace_grant_domain_binding"() FROM PUBLIC, "nautilo", "nautilo_agent", "nautilo_crypto";
GRANT EXECUTE ON FUNCTION "public"."validate_namespace_grant_domain_binding"() TO "nautilo_crypto";
REVOKE ALL ON FUNCTION "public"."protect_namespace_grant_domain_head"() FROM PUBLIC, "nautilo", "nautilo_agent", "nautilo_crypto";
GRANT EXECUTE ON FUNCTION "public"."protect_namespace_grant_domain_head"() TO "nautilo_crypto";
REVOKE ALL ON FUNCTION "public"."validate_namespace_grant_domain_head"() FROM PUBLIC, "nautilo", "nautilo_agent", "nautilo_crypto";
GRANT EXECUTE ON FUNCTION "public"."validate_namespace_grant_domain_head"() TO "nautilo_crypto";
