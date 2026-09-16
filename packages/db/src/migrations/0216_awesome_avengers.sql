CREATE TABLE "domain_key_envelope_acknowledgements" (
	"acknowledgement_id" text PRIMARY KEY NOT NULL,
	"domain_id" text NOT NULL,
	"key_class" text NOT NULL,
	"domain_key_generation" bigint NOT NULL,
	"authorization_revision" bigint NOT NULL,
	"recipient_kind" text NOT NULL,
	"recipient_key_id" text NOT NULL,
	"recipient_key_generation" bigint NOT NULL,
	"recipient_device_id" text NOT NULL,
	"recipient_device_revision" bigint NOT NULL,
	"request_digest" "bytea",
	"envelope_digest" "bytea" NOT NULL,
	"acknowledgement_digest" "bytea" NOT NULL,
	"acknowledgement_bytes" "bytea" NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "uq_domain_key_acks_digest" UNIQUE("acknowledgement_digest"),
	CONSTRAINT "uq_domain_key_acks_envelope_device_revision" UNIQUE("envelope_digest","recipient_device_id","recipient_device_revision"),
	CONSTRAINT "domain_key_acks_class" CHECK ("domain_key_envelope_acknowledgements"."key_class" in ('human', 'ai')),
	CONSTRAINT "domain_key_acks_request_digest" CHECK (octet_length("domain_key_envelope_acknowledgements"."request_digest") = 32),
	CONSTRAINT "domain_key_acks_envelope_digest" CHECK (octet_length("domain_key_envelope_acknowledgements"."envelope_digest") = 32),
	CONSTRAINT "domain_key_acks_digest" CHECK (octet_length("domain_key_envelope_acknowledgements"."acknowledgement_digest") = 32),
	CONSTRAINT "domain_key_acks_bytes" CHECK (octet_length("domain_key_envelope_acknowledgements"."acknowledgement_bytes") between 1 and 8192)
);
--> statement-breakpoint
ALTER TABLE "domain_key_envelope_acknowledgements" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "domain_key_heads" (
	"domain_id" text NOT NULL,
	"key_class" text NOT NULL,
	"participant_digest" "bytea" NOT NULL,
	"participant_count" bigint NOT NULL,
	"domain_key_generation" bigint NOT NULL,
	"authorization_revision" bigint NOT NULL,
	"head_digest" "bytea" NOT NULL,
	"previous_head_digest" "bytea",
	"head_bytes" "bytea" NOT NULL,
	"publication_operation_id" text NOT NULL,
	"issuer_human_id" text NOT NULL,
	"issuer_device_id" text NOT NULL,
	"issuer_device_signing_generation" bigint NOT NULL,
	"activated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "domain_key_heads_domain_id_key_class_pk" PRIMARY KEY("domain_id","key_class"),
	CONSTRAINT "uq_domain_key_heads_digest" UNIQUE("head_digest"),
	CONSTRAINT "domain_key_heads_domain_portable" CHECK (octet_length("domain_key_heads"."domain_id") between 1 and 128
      and "domain_key_heads"."domain_id" ~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]*$'),
	CONSTRAINT "domain_key_heads_class" CHECK ("domain_key_heads"."key_class" in ('human', 'ai')),
	CONSTRAINT "domain_key_heads_participant_digest" CHECK (octet_length("domain_key_heads"."participant_digest") = 32),
	CONSTRAINT "domain_key_heads_participant_count" CHECK ("domain_key_heads"."participant_count" between 1
      and 9007199254740991),
	CONSTRAINT "domain_key_heads_generation" CHECK ("domain_key_heads"."domain_key_generation" between 1
      and 9007199254740991),
	CONSTRAINT "domain_key_heads_authorization_revision" CHECK ("domain_key_heads"."authorization_revision" between 0
      and 9007199254740991),
	CONSTRAINT "domain_key_heads_head_digest" CHECK (octet_length("domain_key_heads"."head_digest") = 32),
	CONSTRAINT "domain_key_heads_previous_digest" CHECK (octet_length("domain_key_heads"."previous_head_digest") = 32),
	CONSTRAINT "domain_key_heads_head_bytes" CHECK (octet_length("domain_key_heads"."head_bytes") between 1 and 8192)
);
--> statement-breakpoint
ALTER TABLE "domain_key_heads" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "domain_key_publication_operations" (
	"operation_id" text PRIMARY KEY NOT NULL,
	"idempotency_key" text NOT NULL,
	"domain_id" text NOT NULL,
	"key_class" text NOT NULL,
	"participant_digest" "bytea" NOT NULL,
	"participant_count" bigint NOT NULL,
	"domain_key_generation" bigint NOT NULL,
	"authorization_revision" bigint NOT NULL,
	"expected_previous_head_digest" "bytea",
	"head_digest" "bytea" NOT NULL,
	"head_bytes" "bytea" NOT NULL,
	"issuer_human_id" text NOT NULL,
	"issuer_device_id" text NOT NULL,
	"issuer_device_signing_generation" bigint NOT NULL,
	"state" text NOT NULL,
	"failure_code" text,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"deadline_at" timestamp with time zone NOT NULL,
	"activated_at" timestamp with time zone,
	"terminal_at" timestamp with time zone,
	CONSTRAINT "uq_domain_key_pub_idempotency" UNIQUE("idempotency_key"),
	CONSTRAINT "uq_domain_key_pub_head_digest" UNIQUE("head_digest"),
	CONSTRAINT "domain_key_pub_operation_portable" CHECK (octet_length("domain_key_publication_operations"."operation_id") between 1 and 128
      and "domain_key_publication_operations"."operation_id" ~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]*$'),
	CONSTRAINT "domain_key_pub_idempotency_portable" CHECK (octet_length("domain_key_publication_operations"."idempotency_key") between 1 and 128
      and "domain_key_publication_operations"."idempotency_key" ~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]*$'),
	CONSTRAINT "domain_key_pub_domain_portable" CHECK (octet_length("domain_key_publication_operations"."domain_id") between 1 and 128
      and "domain_key_publication_operations"."domain_id" ~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]*$'),
	CONSTRAINT "domain_key_pub_issuer_human_portable" CHECK (octet_length("domain_key_publication_operations"."issuer_human_id") between 1 and 128
      and "domain_key_publication_operations"."issuer_human_id" ~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]*$'),
	CONSTRAINT "domain_key_pub_issuer_device_portable" CHECK (octet_length("domain_key_publication_operations"."issuer_device_id") between 1 and 128
      and "domain_key_publication_operations"."issuer_device_id" ~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]*$'),
	CONSTRAINT "domain_key_pub_class" CHECK ("domain_key_publication_operations"."key_class" in ('human', 'ai')),
	CONSTRAINT "domain_key_pub_participant_digest" CHECK (octet_length("domain_key_publication_operations"."participant_digest") = 32),
	CONSTRAINT "domain_key_pub_participant_count" CHECK ("domain_key_publication_operations"."participant_count" between 1
      and 9007199254740991),
	CONSTRAINT "domain_key_pub_generation" CHECK ("domain_key_publication_operations"."domain_key_generation" between 1
      and 9007199254740991),
	CONSTRAINT "domain_key_pub_authorization_revision" CHECK ("domain_key_publication_operations"."authorization_revision" between 0
      and 9007199254740991),
	CONSTRAINT "domain_key_pub_previous_head_digest" CHECK (octet_length("domain_key_publication_operations"."expected_previous_head_digest") = 32),
	CONSTRAINT "domain_key_pub_head_digest" CHECK (octet_length("domain_key_publication_operations"."head_digest") = 32),
	CONSTRAINT "domain_key_pub_head_bytes" CHECK (octet_length("domain_key_publication_operations"."head_bytes") between 1 and 8192),
	CONSTRAINT "domain_key_pub_issuer_signing_generation" CHECK ("domain_key_publication_operations"."issuer_device_signing_generation" between 1
      and 9007199254740991),
	CONSTRAINT "domain_key_pub_state" CHECK ("domain_key_publication_operations"."state" in ('reserved', 'active', 'stale', 'expired', 'failed')),
	CONSTRAINT "domain_key_pub_failure_portable" CHECK (octet_length("domain_key_publication_operations"."failure_code") between 1 and 128
      and "domain_key_publication_operations"."failure_code" ~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]*$'),
	CONSTRAINT "domain_key_pub_predecessor_shape" CHECK (("domain_key_publication_operations"."domain_key_generation" = 1 and "domain_key_publication_operations"."expected_previous_head_digest" is null) or ("domain_key_publication_operations"."domain_key_generation" > 1 and "domain_key_publication_operations"."expected_previous_head_digest" is not null))
);
--> statement-breakpoint
ALTER TABLE "domain_key_publication_operations" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "domain_key_recipient_envelopes" (
	"domain_id" text NOT NULL,
	"key_class" text NOT NULL,
	"domain_key_generation" bigint NOT NULL,
	"authorization_revision" bigint NOT NULL,
	"head_digest" "bytea" NOT NULL,
	"recipient_human_id" text NOT NULL,
	"recipient_kind" text NOT NULL,
	"recipient_key_id" text NOT NULL,
	"recipient_key_generation" bigint NOT NULL,
	"recipient_public_key_digest" "bytea" NOT NULL,
	"envelope_digest" "bytea" NOT NULL,
	"envelope_bytes" "bytea" NOT NULL,
	"authorization_digest" "bytea" NOT NULL,
	"authorization_bytes" "bytea" NOT NULL,
	"source_request_id" text,
	"issuer_human_id" text NOT NULL,
	"issuer_device_id" text NOT NULL,
	"issuer_device_signing_generation" bigint NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "domain_key_recipient_envelopes_domain_id_key_class_domain_key_generation_authorization_revision_recipient_kind_recipient_key_id_recipient_key_generation_pk" PRIMARY KEY("domain_id","key_class","domain_key_generation","authorization_revision","recipient_kind","recipient_key_id","recipient_key_generation"),
	CONSTRAINT "uq_domain_key_envelopes_digest" UNIQUE("envelope_digest"),
	CONSTRAINT "domain_key_envelopes_class" CHECK ("domain_key_recipient_envelopes"."key_class" in ('human', 'ai')),
	CONSTRAINT "domain_key_envelopes_kind" CHECK ("domain_key_recipient_envelopes"."recipient_kind" in ('device', 'recovery')),
	CONSTRAINT "domain_key_envelopes_head_digest" CHECK (octet_length("domain_key_recipient_envelopes"."head_digest") = 32),
	CONSTRAINT "domain_key_envelopes_recipient_digest" CHECK (octet_length("domain_key_recipient_envelopes"."recipient_public_key_digest") = 32),
	CONSTRAINT "domain_key_envelopes_digest" CHECK (octet_length("domain_key_recipient_envelopes"."envelope_digest") = 32),
	CONSTRAINT "domain_key_envelopes_authorization_digest" CHECK (octet_length("domain_key_recipient_envelopes"."authorization_digest") = 32),
	CONSTRAINT "domain_key_envelopes_bytes" CHECK (octet_length("domain_key_recipient_envelopes"."envelope_bytes") between 1 and 16384),
	CONSTRAINT "domain_key_envelopes_authorization_bytes" CHECK (octet_length("domain_key_recipient_envelopes"."authorization_bytes") between 1 and 32768)
);
--> statement-breakpoint
ALTER TABLE "domain_key_recipient_envelopes" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "domain_key_recipient_requests" (
	"request_id" text PRIMARY KEY NOT NULL,
	"idempotency_key" text NOT NULL,
	"domain_id" text NOT NULL,
	"key_class" text NOT NULL,
	"domain_key_generation" bigint NOT NULL,
	"authorization_revision" bigint NOT NULL,
	"head_digest" "bytea" NOT NULL,
	"recipient_human_id" text NOT NULL,
	"recipient_kind" text NOT NULL,
	"recipient_key_id" text NOT NULL,
	"recipient_key_generation" bigint NOT NULL,
	"recipient_public_key_digest" "bytea" NOT NULL,
	"request_digest" "bytea" NOT NULL,
	"request_bytes" "bytea" NOT NULL,
	"state" text NOT NULL,
	"fulfillment_authorization_digest" "bytea",
	"fulfillment_envelope_digest" "bytea",
	"failure_code" text,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"deadline_at" timestamp with time zone NOT NULL,
	"fulfilled_at" timestamp with time zone,
	"terminal_at" timestamp with time zone,
	CONSTRAINT "uq_domain_key_requests_idempotency" UNIQUE("idempotency_key"),
	CONSTRAINT "uq_domain_key_requests_digest" UNIQUE("request_digest"),
	CONSTRAINT "domain_key_requests_request_portable" CHECK (octet_length("domain_key_recipient_requests"."request_id") between 1 and 128
      and "domain_key_recipient_requests"."request_id" ~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]*$'),
	CONSTRAINT "domain_key_requests_idempotency_portable" CHECK (octet_length("domain_key_recipient_requests"."idempotency_key") between 1 and 128
      and "domain_key_recipient_requests"."idempotency_key" ~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]*$'),
	CONSTRAINT "domain_key_requests_domain_portable" CHECK (octet_length("domain_key_recipient_requests"."domain_id") between 1 and 128
      and "domain_key_recipient_requests"."domain_id" ~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]*$'),
	CONSTRAINT "domain_key_requests_human_portable" CHECK (octet_length("domain_key_recipient_requests"."recipient_human_id") between 1 and 128
      and "domain_key_recipient_requests"."recipient_human_id" ~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]*$'),
	CONSTRAINT "domain_key_requests_key_portable" CHECK (octet_length("domain_key_recipient_requests"."recipient_key_id") between 1 and 128
      and "domain_key_recipient_requests"."recipient_key_id" ~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]*$'),
	CONSTRAINT "domain_key_requests_class" CHECK ("domain_key_recipient_requests"."key_class" in ('human', 'ai')),
	CONSTRAINT "domain_key_requests_kind" CHECK ("domain_key_recipient_requests"."recipient_kind" in ('device', 'recovery')),
	CONSTRAINT "domain_key_requests_generation" CHECK ("domain_key_recipient_requests"."domain_key_generation" between 1
      and 9007199254740991),
	CONSTRAINT "domain_key_requests_authorization_revision" CHECK ("domain_key_recipient_requests"."authorization_revision" between 0
      and 9007199254740991),
	CONSTRAINT "domain_key_requests_recipient_generation" CHECK ("domain_key_recipient_requests"."recipient_key_generation" between 1
      and 9007199254740991),
	CONSTRAINT "domain_key_requests_head_digest" CHECK (octet_length("domain_key_recipient_requests"."head_digest") = 32),
	CONSTRAINT "domain_key_requests_recipient_digest" CHECK (octet_length("domain_key_recipient_requests"."recipient_public_key_digest") = 32),
	CONSTRAINT "domain_key_requests_request_digest" CHECK (octet_length("domain_key_recipient_requests"."request_digest") = 32),
	CONSTRAINT "domain_key_requests_fulfillment_auth_digest" CHECK (octet_length("domain_key_recipient_requests"."fulfillment_authorization_digest") = 32),
	CONSTRAINT "domain_key_requests_fulfillment_envelope_digest" CHECK (octet_length("domain_key_recipient_requests"."fulfillment_envelope_digest") = 32),
	CONSTRAINT "domain_key_requests_request_bytes" CHECK (octet_length("domain_key_recipient_requests"."request_bytes") between 1 and 8192),
	CONSTRAINT "domain_key_requests_state" CHECK ("domain_key_recipient_requests"."state" in ('pending', 'fulfilled', 'stale', 'expired', 'unrecoverable')),
	CONSTRAINT "domain_key_requests_failure_portable" CHECK (octet_length("domain_key_recipient_requests"."failure_code") between 1 and 128
      and "domain_key_recipient_requests"."failure_code" ~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]*$')
);
--> statement-breakpoint
ALTER TABLE "domain_key_recipient_requests" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "namespace_domain_key_bindings" (
	"operation_id" text PRIMARY KEY NOT NULL,
	"idempotency_key" text NOT NULL,
	"namespace_id" uuid NOT NULL,
	"domain_id" text NOT NULL,
	"key_class" text NOT NULL,
	"domain_key_generation" bigint NOT NULL,
	"domain_authorization_revision" bigint NOT NULL,
	"domain_head_digest" "bytea" NOT NULL,
	"namespace_access_revision" bigint NOT NULL,
	"namespace_current_generation" bigint NOT NULL,
	"bundle_revision" bigint NOT NULL,
	"retained_generation_count" integer NOT NULL,
	"retained_authority_set_digest" "bytea" NOT NULL,
	"previous_binding_digest" "bytea",
	"binding_digest" "bytea" NOT NULL,
	"plaintext_digest" "bytea" NOT NULL,
	"ciphertext_digest" "bytea" NOT NULL,
	"binding_bytes" "bytea" NOT NULL,
	"issuer_human_id" text NOT NULL,
	"issuer_device_id" text NOT NULL,
	"issuer_device_signing_generation" bigint NOT NULL,
	"state" text NOT NULL,
	"failure_code" text,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"deadline_at" timestamp with time zone NOT NULL,
	"activated_at" timestamp with time zone,
	"terminal_at" timestamp with time zone,
	CONSTRAINT "uq_namespace_domain_key_bindings_idempotency" UNIQUE("idempotency_key"),
	CONSTRAINT "uq_namespace_domain_key_bindings_digest" UNIQUE("binding_digest"),
	CONSTRAINT "namespace_domain_key_bindings_class" CHECK ("namespace_domain_key_bindings"."key_class" in ('human', 'ai')),
	CONSTRAINT "namespace_domain_key_bindings_head_digest" CHECK (octet_length("namespace_domain_key_bindings"."domain_head_digest") = 32),
	CONSTRAINT "namespace_domain_key_bindings_retained_digest" CHECK (octet_length("namespace_domain_key_bindings"."retained_authority_set_digest") = 32),
	CONSTRAINT "namespace_domain_key_bindings_previous_digest" CHECK (octet_length("namespace_domain_key_bindings"."previous_binding_digest") = 32),
	CONSTRAINT "namespace_domain_key_bindings_digest" CHECK (octet_length("namespace_domain_key_bindings"."binding_digest") = 32),
	CONSTRAINT "namespace_domain_key_bindings_plaintext_digest" CHECK (octet_length("namespace_domain_key_bindings"."plaintext_digest") = 32),
	CONSTRAINT "namespace_domain_key_bindings_ciphertext_digest" CHECK (octet_length("namespace_domain_key_bindings"."ciphertext_digest") = 32),
	CONSTRAINT "namespace_domain_key_bindings_bytes" CHECK (octet_length("namespace_domain_key_bindings"."binding_bytes") between 1 and 524288),
	CONSTRAINT "namespace_domain_key_bindings_state" CHECK ("namespace_domain_key_bindings"."state" in ('reserved', 'active', 'stale', 'expired', 'failed'))
);
--> statement-breakpoint
ALTER TABLE "namespace_domain_key_bindings" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "namespace_domain_key_heads" (
	"namespace_id" uuid NOT NULL,
	"key_class" text NOT NULL,
	"domain_id" text NOT NULL,
	"domain_key_generation" bigint NOT NULL,
	"domain_authorization_revision" bigint NOT NULL,
	"domain_head_digest" "bytea" NOT NULL,
	"namespace_access_revision" bigint NOT NULL,
	"namespace_current_generation" bigint NOT NULL,
	"bundle_revision" bigint NOT NULL,
	"retained_generation_count" integer NOT NULL,
	"retained_authority_set_digest" "bytea" NOT NULL,
	"binding_digest" "bytea" NOT NULL,
	"binding_operation_id" text NOT NULL,
	"activated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "namespace_domain_key_heads_namespace_id_key_class_pk" PRIMARY KEY("namespace_id","key_class"),
	CONSTRAINT "uq_namespace_domain_key_heads_binding" UNIQUE("binding_digest"),
	CONSTRAINT "namespace_domain_key_heads_class" CHECK ("namespace_domain_key_heads"."key_class" in ('human', 'ai')),
	CONSTRAINT "namespace_domain_key_heads_domain_digest" CHECK (octet_length("namespace_domain_key_heads"."domain_head_digest") = 32),
	CONSTRAINT "namespace_domain_key_heads_retained_digest" CHECK (octet_length("namespace_domain_key_heads"."retained_authority_set_digest") = 32),
	CONSTRAINT "namespace_domain_key_heads_binding_digest" CHECK (octet_length("namespace_domain_key_heads"."binding_digest") = 32)
);
--> statement-breakpoint
ALTER TABLE "namespace_domain_key_heads" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "crypto_domains" DROP CONSTRAINT "crypto_domains_participants_count";--> statement-breakpoint
ALTER TABLE "crypto_human_membership_transitions" DROP CONSTRAINT "crypto_human_membership_transitions_old_count";--> statement-breakpoint
ALTER TABLE "crypto_human_membership_transitions" DROP CONSTRAINT "crypto_human_membership_transitions_new_count";--> statement-breakpoint
ALTER TABLE "domain_key_envelope_acknowledgements" ADD CONSTRAINT "domain_key_acks_envelope_fk" FOREIGN KEY ("domain_id","key_class","domain_key_generation","authorization_revision","recipient_kind","recipient_key_id","recipient_key_generation") REFERENCES "public"."domain_key_recipient_envelopes"("domain_id","key_class","domain_key_generation","authorization_revision","recipient_kind","recipient_key_id","recipient_key_generation") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "domain_key_envelope_acknowledgements" ADD CONSTRAINT "domain_key_acks_device_fk" FOREIGN KEY ("recipient_device_id") REFERENCES "public"."human_crypto_devices"("device_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "domain_key_heads" ADD CONSTRAINT "domain_key_heads_domain_fk" FOREIGN KEY ("domain_id") REFERENCES "public"."crypto_domains"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "domain_key_heads" ADD CONSTRAINT "domain_key_heads_publication_fk" FOREIGN KEY ("publication_operation_id") REFERENCES "public"."domain_key_publication_operations"("operation_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "domain_key_heads" ADD CONSTRAINT "domain_key_heads_issuer_human_fk" FOREIGN KEY ("issuer_human_id") REFERENCES "public"."human_crypto_custodies"("human_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "domain_key_heads" ADD CONSTRAINT "domain_key_heads_issuer_device_fk" FOREIGN KEY ("issuer_device_id") REFERENCES "public"."human_crypto_devices"("device_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "domain_key_publication_operations" ADD CONSTRAINT "domain_key_pub_domain_fk" FOREIGN KEY ("domain_id") REFERENCES "public"."crypto_domains"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "domain_key_publication_operations" ADD CONSTRAINT "domain_key_pub_issuer_human_fk" FOREIGN KEY ("issuer_human_id") REFERENCES "public"."human_crypto_custodies"("human_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "domain_key_publication_operations" ADD CONSTRAINT "domain_key_pub_issuer_device_fk" FOREIGN KEY ("issuer_device_id") REFERENCES "public"."human_crypto_devices"("device_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "domain_key_recipient_envelopes" ADD CONSTRAINT "domain_key_envelopes_head_fk" FOREIGN KEY ("domain_id","key_class") REFERENCES "public"."domain_key_heads"("domain_id","key_class") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "domain_key_recipient_envelopes" ADD CONSTRAINT "domain_key_envelopes_recipient_fk" FOREIGN KEY ("recipient_human_id") REFERENCES "public"."human_crypto_custodies"("human_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "domain_key_recipient_envelopes" ADD CONSTRAINT "domain_key_envelopes_request_fk" FOREIGN KEY ("source_request_id") REFERENCES "public"."domain_key_recipient_requests"("request_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "domain_key_recipient_envelopes" ADD CONSTRAINT "domain_key_envelopes_issuer_human_fk" FOREIGN KEY ("issuer_human_id") REFERENCES "public"."human_crypto_custodies"("human_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "domain_key_recipient_envelopes" ADD CONSTRAINT "domain_key_envelopes_issuer_device_fk" FOREIGN KEY ("issuer_device_id") REFERENCES "public"."human_crypto_devices"("device_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "domain_key_recipient_requests" ADD CONSTRAINT "domain_key_requests_head_fk" FOREIGN KEY ("domain_id","key_class") REFERENCES "public"."domain_key_heads"("domain_id","key_class") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "domain_key_recipient_requests" ADD CONSTRAINT "domain_key_requests_human_fk" FOREIGN KEY ("recipient_human_id") REFERENCES "public"."human_crypto_custodies"("human_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "namespace_domain_key_bindings" ADD CONSTRAINT "namespace_domain_key_bindings_namespace_fk" FOREIGN KEY ("namespace_id") REFERENCES "public"."namespaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "namespace_domain_key_bindings" ADD CONSTRAINT "namespace_domain_key_bindings_head_fk" FOREIGN KEY ("domain_id","key_class") REFERENCES "public"."domain_key_heads"("domain_id","key_class") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "namespace_domain_key_bindings" ADD CONSTRAINT "namespace_domain_key_bindings_issuer_human_fk" FOREIGN KEY ("issuer_human_id") REFERENCES "public"."human_crypto_custodies"("human_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "namespace_domain_key_bindings" ADD CONSTRAINT "namespace_domain_key_bindings_issuer_device_fk" FOREIGN KEY ("issuer_device_id") REFERENCES "public"."human_crypto_devices"("device_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "namespace_domain_key_heads" ADD CONSTRAINT "namespace_domain_key_heads_namespace_fk" FOREIGN KEY ("namespace_id") REFERENCES "public"."namespaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "namespace_domain_key_heads" ADD CONSTRAINT "namespace_domain_key_heads_domain_fk" FOREIGN KEY ("domain_id","key_class") REFERENCES "public"."domain_key_heads"("domain_id","key_class") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "namespace_domain_key_heads" ADD CONSTRAINT "namespace_domain_key_heads_binding_fk" FOREIGN KEY ("binding_operation_id") REFERENCES "public"."namespace_domain_key_bindings"("operation_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_domain_key_acks_device" ON "domain_key_envelope_acknowledgements" USING btree ("recipient_device_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_domain_key_heads_participants" ON "domain_key_heads" USING btree ("participant_digest","key_class");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_domain_key_pub_live_head" ON "domain_key_publication_operations" USING btree ("domain_id","key_class") WHERE "domain_key_publication_operations"."state" = 'reserved';--> statement-breakpoint
CREATE INDEX "idx_domain_key_pub_reconcile" ON "domain_key_publication_operations" USING btree ("state","deadline_at");--> statement-breakpoint
CREATE INDEX "idx_domain_key_envelopes_device_fetch" ON "domain_key_recipient_envelopes" USING btree ("recipient_key_id","domain_id","key_class");--> statement-breakpoint
CREATE INDEX "idx_domain_key_envelopes_human_fetch" ON "domain_key_recipient_envelopes" USING btree ("recipient_human_id","domain_id","key_class");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_domain_key_requests_live_target" ON "domain_key_recipient_requests" USING btree ("domain_id","key_class","domain_key_generation","authorization_revision","recipient_kind","recipient_key_id","recipient_key_generation") WHERE "domain_key_recipient_requests"."state" = 'pending';--> statement-breakpoint
CREATE INDEX "idx_domain_key_requests_pending" ON "domain_key_recipient_requests" USING btree ("state","deadline_at");--> statement-breakpoint
CREATE INDEX "idx_domain_key_requests_human" ON "domain_key_recipient_requests" USING btree ("recipient_human_id","state");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_namespace_domain_key_bindings_live" ON "namespace_domain_key_bindings" USING btree ("namespace_id","key_class") WHERE "namespace_domain_key_bindings"."state" = 'reserved';--> statement-breakpoint
CREATE INDEX "idx_namespace_domain_key_bindings_domain" ON "namespace_domain_key_bindings" USING btree ("domain_id","key_class","namespace_id");--> statement-breakpoint
CREATE INDEX "idx_namespace_domain_key_heads_domain" ON "namespace_domain_key_heads" USING btree ("domain_id","key_class","namespace_id");--> statement-breakpoint
ALTER TABLE "crypto_domains" ADD CONSTRAINT "crypto_domains_participants_count" CHECK (cardinality("crypto_domains"."participants") >= 1);--> statement-breakpoint
ALTER TABLE "crypto_human_membership_transitions" ADD CONSTRAINT "crypto_human_membership_transitions_old_count" CHECK (cardinality("crypto_human_membership_transitions"."old_participants") >= 1);--> statement-breakpoint
ALTER TABLE "crypto_human_membership_transitions" ADD CONSTRAINT "crypto_human_membership_transitions_new_count" CHECK (cardinality("crypto_human_membership_transitions"."new_participants") >= 1);--> statement-breakpoint
CREATE POLICY "domain_key_acks_crypto_sel" ON "domain_key_envelope_acknowledgements" AS PERMISSIVE FOR SELECT TO "nautilo_crypto" USING (true);--> statement-breakpoint
CREATE POLICY "domain_key_acks_crypto_ins" ON "domain_key_envelope_acknowledgements" AS PERMISSIVE FOR INSERT TO "nautilo_crypto" WITH CHECK (true);--> statement-breakpoint
CREATE POLICY "domain_key_heads_crypto_sel" ON "domain_key_heads" AS PERMISSIVE FOR SELECT TO "nautilo_crypto" USING (true);--> statement-breakpoint
CREATE POLICY "domain_key_heads_crypto_ins" ON "domain_key_heads" AS PERMISSIVE FOR INSERT TO "nautilo_crypto" WITH CHECK (true);--> statement-breakpoint
CREATE POLICY "domain_key_heads_crypto_upd" ON "domain_key_heads" AS PERMISSIVE FOR UPDATE TO "nautilo_crypto" USING (true) WITH CHECK (true);--> statement-breakpoint
CREATE POLICY "domain_key_pub_crypto_sel" ON "domain_key_publication_operations" AS PERMISSIVE FOR SELECT TO "nautilo_crypto" USING (true);--> statement-breakpoint
CREATE POLICY "domain_key_pub_crypto_ins" ON "domain_key_publication_operations" AS PERMISSIVE FOR INSERT TO "nautilo_crypto" WITH CHECK (true);--> statement-breakpoint
CREATE POLICY "domain_key_pub_crypto_upd" ON "domain_key_publication_operations" AS PERMISSIVE FOR UPDATE TO "nautilo_crypto" USING (true) WITH CHECK (true);--> statement-breakpoint
CREATE POLICY "domain_key_envelopes_crypto_sel" ON "domain_key_recipient_envelopes" AS PERMISSIVE FOR SELECT TO "nautilo_crypto" USING (true);--> statement-breakpoint
CREATE POLICY "domain_key_envelopes_crypto_ins" ON "domain_key_recipient_envelopes" AS PERMISSIVE FOR INSERT TO "nautilo_crypto" WITH CHECK (true);--> statement-breakpoint
CREATE POLICY "domain_key_requests_crypto_sel" ON "domain_key_recipient_requests" AS PERMISSIVE FOR SELECT TO "nautilo_crypto" USING (true);--> statement-breakpoint
CREATE POLICY "domain_key_requests_crypto_ins" ON "domain_key_recipient_requests" AS PERMISSIVE FOR INSERT TO "nautilo_crypto" WITH CHECK (true);--> statement-breakpoint
CREATE POLICY "domain_key_requests_crypto_upd" ON "domain_key_recipient_requests" AS PERMISSIVE FOR UPDATE TO "nautilo_crypto" USING (true) WITH CHECK (true);--> statement-breakpoint
CREATE POLICY "namespace_domain_key_bindings_crypto_sel" ON "namespace_domain_key_bindings" AS PERMISSIVE FOR SELECT TO "nautilo_crypto" USING (true);--> statement-breakpoint
CREATE POLICY "namespace_domain_key_bindings_crypto_ins" ON "namespace_domain_key_bindings" AS PERMISSIVE FOR INSERT TO "nautilo_crypto" WITH CHECK (true);--> statement-breakpoint
CREATE POLICY "namespace_domain_key_bindings_crypto_upd" ON "namespace_domain_key_bindings" AS PERMISSIVE FOR UPDATE TO "nautilo_crypto" USING (true) WITH CHECK (true);--> statement-breakpoint
CREATE POLICY "namespace_domain_key_heads_crypto_sel" ON "namespace_domain_key_heads" AS PERMISSIVE FOR SELECT TO "nautilo_crypto" USING (true);--> statement-breakpoint
CREATE POLICY "namespace_domain_key_heads_crypto_ins" ON "namespace_domain_key_heads" AS PERMISSIVE FOR INSERT TO "nautilo_crypto" WITH CHECK (true);--> statement-breakpoint
CREATE POLICY "namespace_domain_key_heads_crypto_upd" ON "namespace_domain_key_heads" AS PERMISSIVE FOR UPDATE TO "nautilo_crypto" USING (true) WITH CHECK (true);
--> statement-breakpoint
-- M301_DOMAIN_KEY_AUTHORITY
ALTER TABLE "domain_key_publication_operations" FORCE ROW LEVEL SECURITY;
ALTER TABLE "domain_key_heads" FORCE ROW LEVEL SECURITY;
ALTER TABLE "domain_key_recipient_requests" FORCE ROW LEVEL SECURITY;
ALTER TABLE "domain_key_recipient_envelopes" FORCE ROW LEVEL SECURITY;
ALTER TABLE "domain_key_envelope_acknowledgements" FORCE ROW LEVEL SECURITY;
ALTER TABLE "namespace_domain_key_bindings" FORCE ROW LEVEL SECURITY;
ALTER TABLE "namespace_domain_key_heads" FORCE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION "public"."protect_domain_key_lifecycle"()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog
AS $$
BEGIN
  IF (to_jsonb(NEW) - ARRAY[
        'state', 'failure_code', 'updated_at', 'activated_at', 'terminal_at'
      ]) IS DISTINCT FROM (to_jsonb(OLD) - ARRAY[
        'state', 'failure_code', 'updated_at', 'activated_at', 'terminal_at'
      ])
  THEN
    RAISE EXCEPTION 'Domain key operation identity is immutable'
      USING ERRCODE = '23514';
  END IF;
  IF NOT (
    NEW.state = OLD.state
    OR (OLD.state = 'reserved' AND NEW.state IN ('active', 'stale', 'expired', 'failed'))
  ) OR NEW.updated_at < OLD.updated_at
    OR (OLD.failure_code IS NOT NULL AND NEW.failure_code IS DISTINCT FROM OLD.failure_code)
    OR (OLD.activated_at IS NOT NULL AND NEW.activated_at IS DISTINCT FROM OLD.activated_at)
    OR (OLD.terminal_at IS NOT NULL AND NEW.terminal_at IS DISTINCT FROM OLD.terminal_at)
  THEN
    RAISE EXCEPTION 'Domain key operation lifecycle is not monotonic'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION "public"."protect_domain_key_lifecycle"()
  FROM PUBLIC, "nautilo", "nautilo_agent", "nautilo_crypto";
GRANT EXECUTE ON FUNCTION "public"."protect_domain_key_lifecycle"()
  TO "nautilo_crypto", "nautilo";
CREATE TRIGGER "domain_key_publications_protected"
BEFORE UPDATE ON "domain_key_publication_operations"
FOR EACH ROW EXECUTE FUNCTION "public"."protect_domain_key_lifecycle"();
CREATE TRIGGER "namespace_domain_key_bindings_protected"
BEFORE UPDATE ON "namespace_domain_key_bindings"
FOR EACH ROW EXECUTE FUNCTION "public"."protect_domain_key_lifecycle"();

CREATE OR REPLACE FUNCTION "public"."protect_domain_key_request"()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog
AS $$
BEGIN
  IF (to_jsonb(NEW) - ARRAY[
        'state', 'fulfillment_authorization_digest',
        'fulfillment_envelope_digest', 'failure_code', 'updated_at',
        'fulfilled_at', 'terminal_at'
      ]) IS DISTINCT FROM (to_jsonb(OLD) - ARRAY[
        'state', 'fulfillment_authorization_digest',
        'fulfillment_envelope_digest', 'failure_code', 'updated_at',
        'fulfilled_at', 'terminal_at'
      ])
  THEN
    RAISE EXCEPTION 'Domain key access request identity is immutable'
      USING ERRCODE = '23514';
  END IF;
  IF NOT (
    NEW.state = OLD.state
    OR (OLD.state = 'pending' AND NEW.state IN ('fulfilled', 'stale', 'expired', 'unrecoverable'))
  ) OR NEW.updated_at < OLD.updated_at
    OR (OLD.state <> 'pending' AND NEW IS DISTINCT FROM OLD)
    OR (NEW.state = 'fulfilled' AND (
      NEW.fulfillment_authorization_digest IS NULL
      OR NEW.fulfillment_envelope_digest IS NULL
      OR NEW.fulfilled_at IS NULL
      OR NEW.terminal_at IS NULL
    ))
  THEN
    RAISE EXCEPTION 'Domain key access request winner is not monotonic'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION "public"."protect_domain_key_request"()
  FROM PUBLIC, "nautilo", "nautilo_agent", "nautilo_crypto";
GRANT EXECUTE ON FUNCTION "public"."protect_domain_key_request"()
  TO "nautilo_crypto", "nautilo";
CREATE TRIGGER "domain_key_requests_protected"
BEFORE UPDATE ON "domain_key_recipient_requests"
FOR EACH ROW EXECUTE FUNCTION "public"."protect_domain_key_request"();

CREATE OR REPLACE FUNCTION "public"."validate_domain_key_head"()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog
AS $$
BEGIN
  PERFORM 1
    FROM "public"."crypto_domains" AS domain_row
   WHERE domain_row.id = NEW.domain_id
     AND domain_row.participant_digest = NEW.participant_digest
     AND cardinality(domain_row.participants) = NEW.participant_count;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Domain key head disagrees with canonical Domain participants'
      USING ERRCODE = '23514';
  END IF;
  PERFORM 1
    FROM "public"."domain_key_publication_operations" AS operation_row
   WHERE operation_row.operation_id = NEW.publication_operation_id
     AND operation_row.state = 'active'
     AND operation_row.domain_id = NEW.domain_id
     AND operation_row.key_class = NEW.key_class
     AND operation_row.participant_digest = NEW.participant_digest
     AND operation_row.participant_count = NEW.participant_count
     AND operation_row.domain_key_generation = NEW.domain_key_generation
     AND operation_row.authorization_revision = NEW.authorization_revision
     AND operation_row.head_digest = NEW.head_digest
     AND operation_row.head_bytes = NEW.head_bytes;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Domain key head lacks exact active publication evidence'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION "public"."validate_domain_key_head"()
  FROM PUBLIC, "nautilo", "nautilo_agent", "nautilo_crypto";
GRANT EXECUTE ON FUNCTION "public"."validate_domain_key_head"()
  TO "nautilo_crypto", "nautilo";
CREATE CONSTRAINT TRIGGER "domain_key_heads_authorized"
AFTER INSERT OR UPDATE ON "domain_key_heads"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "public"."validate_domain_key_head"();

CREATE OR REPLACE FUNCTION "public"."protect_domain_key_head"()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog
AS $$
BEGIN
  IF NEW.domain_id IS DISTINCT FROM OLD.domain_id
    OR NEW.key_class IS DISTINCT FROM OLD.key_class
    OR NEW.domain_key_generation <> OLD.domain_key_generation + 1
    OR NEW.previous_head_digest IS DISTINCT FROM OLD.head_digest
    OR NEW.authorization_revision <= OLD.authorization_revision
    OR NEW.activated_at < OLD.activated_at
  THEN
    RAISE EXCEPTION 'Domain key head must advance from its exact predecessor'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION "public"."protect_domain_key_head"()
  FROM PUBLIC, "nautilo", "nautilo_agent", "nautilo_crypto";
GRANT EXECUTE ON FUNCTION "public"."protect_domain_key_head"()
  TO "nautilo_crypto", "nautilo";
CREATE TRIGGER "domain_key_heads_monotonic"
BEFORE UPDATE ON "domain_key_heads"
FOR EACH ROW EXECUTE FUNCTION "public"."protect_domain_key_head"();

CREATE OR REPLACE FUNCTION "public"."validate_domain_key_request"()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog
AS $$
BEGIN
  PERFORM 1 FROM "public"."domain_key_heads" AS head_row
   WHERE head_row.domain_id = NEW.domain_id
     AND head_row.key_class = NEW.key_class
     AND head_row.domain_key_generation = NEW.domain_key_generation
     AND head_row.authorization_revision = NEW.authorization_revision
     AND head_row.head_digest = NEW.head_digest;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Domain key request targets stale or mismatched authority'
      USING ERRCODE = '23514';
  END IF;
  IF NEW.state = 'fulfilled' THEN
    PERFORM 1 FROM "public"."domain_key_recipient_envelopes" AS envelope_row
     WHERE envelope_row.source_request_id = NEW.request_id
       AND envelope_row.domain_id = NEW.domain_id
       AND envelope_row.key_class = NEW.key_class
       AND envelope_row.domain_key_generation = NEW.domain_key_generation
       AND envelope_row.authorization_revision = NEW.authorization_revision
       AND envelope_row.recipient_human_id = NEW.recipient_human_id
       AND envelope_row.recipient_kind = NEW.recipient_kind
       AND envelope_row.recipient_key_id = NEW.recipient_key_id
       AND envelope_row.recipient_key_generation = NEW.recipient_key_generation
       AND envelope_row.recipient_public_key_digest = NEW.recipient_public_key_digest
       AND envelope_row.authorization_digest = NEW.fulfillment_authorization_digest
       AND envelope_row.envelope_digest = NEW.fulfillment_envelope_digest;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'fulfilled Domain key request lacks its exact envelope'
        USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION "public"."validate_domain_key_request"()
  FROM PUBLIC, "nautilo", "nautilo_agent", "nautilo_crypto";
GRANT EXECUTE ON FUNCTION "public"."validate_domain_key_request"()
  TO "nautilo_crypto", "nautilo";
CREATE CONSTRAINT TRIGGER "domain_key_requests_authorized"
AFTER INSERT OR UPDATE ON "domain_key_recipient_requests"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "public"."validate_domain_key_request"();

CREATE OR REPLACE FUNCTION "public"."validate_domain_key_envelope"()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog
AS $$
BEGIN
  PERFORM 1 FROM "public"."domain_key_heads" AS head_row
   WHERE head_row.domain_id = NEW.domain_id
     AND head_row.key_class = NEW.key_class
     AND head_row.domain_key_generation = NEW.domain_key_generation
     AND head_row.authorization_revision = NEW.authorization_revision
     AND head_row.head_digest = NEW.head_digest;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Domain key envelope targets stale or mismatched authority'
      USING ERRCODE = '23514';
  END IF;
  IF NEW.source_request_id IS NOT NULL THEN
    PERFORM 1 FROM "public"."domain_key_recipient_requests" AS request_row
     WHERE request_row.request_id = NEW.source_request_id
       AND request_row.domain_id = NEW.domain_id
       AND request_row.key_class = NEW.key_class
       AND request_row.recipient_human_id = NEW.recipient_human_id
       AND request_row.recipient_kind = NEW.recipient_kind
       AND request_row.recipient_key_id = NEW.recipient_key_id
       AND request_row.recipient_key_generation = NEW.recipient_key_generation
       AND request_row.recipient_public_key_digest = NEW.recipient_public_key_digest;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Domain key envelope disagrees with its exact request'
        USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION "public"."validate_domain_key_envelope"()
  FROM PUBLIC, "nautilo", "nautilo_agent", "nautilo_crypto";
GRANT EXECUTE ON FUNCTION "public"."validate_domain_key_envelope"()
  TO "nautilo_crypto", "nautilo";
CREATE CONSTRAINT TRIGGER "domain_key_envelopes_authorized"
AFTER INSERT ON "domain_key_recipient_envelopes"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "public"."validate_domain_key_envelope"();

CREATE OR REPLACE FUNCTION "public"."protect_namespace_domain_key_head"()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog
AS $$
BEGIN
  IF NEW.namespace_id IS DISTINCT FROM OLD.namespace_id
    OR NEW.key_class IS DISTINCT FROM OLD.key_class
    OR NEW.bundle_revision <> OLD.bundle_revision + 1
    OR NEW.activated_at < OLD.activated_at
  THEN
    RAISE EXCEPTION 'Namespace Domain-key head must advance one bundle revision'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION "public"."protect_namespace_domain_key_head"()
  FROM PUBLIC, "nautilo", "nautilo_agent", "nautilo_crypto";
GRANT EXECUTE ON FUNCTION "public"."protect_namespace_domain_key_head"()
  TO "nautilo_crypto", "nautilo";
CREATE TRIGGER "namespace_domain_key_heads_monotonic"
BEFORE UPDATE ON "namespace_domain_key_heads"
FOR EACH ROW EXECUTE FUNCTION "public"."protect_namespace_domain_key_head"();

CREATE OR REPLACE FUNCTION "public"."validate_namespace_domain_key_head"()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog
AS $$
BEGIN
  PERFORM 1 FROM "public"."namespace_domain_key_bindings" AS binding_row
   WHERE binding_row.operation_id = NEW.binding_operation_id
     AND binding_row.state = 'active'
     AND binding_row.namespace_id = NEW.namespace_id
     AND binding_row.key_class = NEW.key_class
     AND binding_row.domain_id = NEW.domain_id
     AND binding_row.domain_key_generation = NEW.domain_key_generation
     AND binding_row.domain_authorization_revision = NEW.domain_authorization_revision
     AND binding_row.domain_head_digest = NEW.domain_head_digest
     AND binding_row.namespace_access_revision = NEW.namespace_access_revision
     AND binding_row.namespace_current_generation = NEW.namespace_current_generation
     AND binding_row.bundle_revision = NEW.bundle_revision
     AND binding_row.retained_generation_count = NEW.retained_generation_count
     AND binding_row.retained_authority_set_digest = NEW.retained_authority_set_digest
     AND binding_row.binding_digest = NEW.binding_digest;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Namespace Domain-key head lacks exact active binding evidence'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION "public"."validate_namespace_domain_key_head"()
  FROM PUBLIC, "nautilo", "nautilo_agent", "nautilo_crypto";
GRANT EXECUTE ON FUNCTION "public"."validate_namespace_domain_key_head"()
  TO "nautilo_crypto", "nautilo";
CREATE CONSTRAINT TRIGGER "namespace_domain_key_heads_authorized"
AFTER INSERT OR UPDATE ON "namespace_domain_key_heads"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "public"."validate_namespace_domain_key_head"();

REVOKE ALL PRIVILEGES ON TABLE
  "domain_key_publication_operations",
  "domain_key_heads",
  "domain_key_recipient_requests",
  "domain_key_recipient_envelopes",
  "domain_key_envelope_acknowledgements",
  "namespace_domain_key_bindings",
  "namespace_domain_key_heads"
FROM PUBLIC, "nautilo", "nautilo_agent", "nautilo_crypto";
GRANT SELECT, INSERT, UPDATE ON TABLE "domain_key_publication_operations" TO "nautilo_crypto";
GRANT SELECT, INSERT, UPDATE ON TABLE "domain_key_heads" TO "nautilo_crypto";
GRANT SELECT, INSERT, UPDATE ON TABLE "domain_key_recipient_requests" TO "nautilo_crypto";
GRANT SELECT, INSERT ON TABLE "domain_key_recipient_envelopes" TO "nautilo_crypto";
GRANT SELECT, INSERT ON TABLE "domain_key_envelope_acknowledgements" TO "nautilo_crypto";
GRANT SELECT, INSERT, UPDATE ON TABLE "namespace_domain_key_bindings" TO "nautilo_crypto";
GRANT SELECT, INSERT, UPDATE ON TABLE "namespace_domain_key_heads" TO "nautilo_crypto";
