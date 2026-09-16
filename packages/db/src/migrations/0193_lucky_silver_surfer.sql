CREATE TABLE "namespace_key_envelope_acknowledgements" (
	"namespace_id" uuid NOT NULL,
	"key_class" text NOT NULL,
	"generation" bigint NOT NULL,
	"recipient_kind" text NOT NULL,
	"recipient_human_id" text NOT NULL,
	"recipient_key_id" text NOT NULL,
	"recipient_key_generation" bigint NOT NULL,
	"device_id" text NOT NULL,
	"device_revision" bigint NOT NULL,
	"envelope_digest" "bytea" NOT NULL,
	"head_digest" "bytea" NOT NULL,
	"acknowledgement_digest" "bytea" NOT NULL,
	"acknowledged_at" timestamp with time zone NOT NULL,
	CONSTRAINT "namespace_key_envelope_acknowledgements_namespace_id_key_class_generation_recipient_kind_recipient_human_id_recipient_key_id_recipient_key_generation_pk" PRIMARY KEY("namespace_id","key_class","generation","recipient_kind","recipient_human_id","recipient_key_id","recipient_key_generation"),
	CONSTRAINT "ns_key_envelope_acknowledgements_device_shape" CHECK ("namespace_key_envelope_acknowledgements"."recipient_kind" = 'device'
        and "namespace_key_envelope_acknowledgements"."recipient_key_id" = "namespace_key_envelope_acknowledgements"."device_id"),
	CONSTRAINT "ns_key_envelope_acknowledgements_key_class" CHECK ("namespace_key_envelope_acknowledgements"."key_class" in ('human', 'ai')),
	CONSTRAINT "ns_key_envelope_acknowledgements_generation_positive" CHECK ("namespace_key_envelope_acknowledgements"."generation" between 1 and 9007199254740991),
	CONSTRAINT "ns_key_envelope_acknowledgements_human_id_portable" CHECK (octet_length("namespace_key_envelope_acknowledgements"."recipient_human_id") between 1
      and 128
      and "namespace_key_envelope_acknowledgements"."recipient_human_id" ~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]*$'),
	CONSTRAINT "ns_key_envelope_acknowledgements_key_id_portable" CHECK (octet_length("namespace_key_envelope_acknowledgements"."recipient_key_id") between 1
      and 128
      and "namespace_key_envelope_acknowledgements"."recipient_key_id" ~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]*$'),
	CONSTRAINT "ns_key_envelope_acknowledgements_device_id_portable" CHECK (octet_length("namespace_key_envelope_acknowledgements"."device_id") between 1
      and 128
      and "namespace_key_envelope_acknowledgements"."device_id" ~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]*$'),
	CONSTRAINT "ns_key_envelope_acknowledgements_key_generation_safe" CHECK ("namespace_key_envelope_acknowledgements"."recipient_key_generation" between 0 and 9007199254740991),
	CONSTRAINT "ns_key_envelope_acknowledgements_device_revision_safe" CHECK ("namespace_key_envelope_acknowledgements"."device_revision" between 0 and 9007199254740991),
	CONSTRAINT "ns_key_envelope_acknowledgements_envelope_size" CHECK (octet_length("namespace_key_envelope_acknowledgements"."envelope_digest") = 32),
	CONSTRAINT "ns_key_envelope_acknowledgements_head_size" CHECK (octet_length("namespace_key_envelope_acknowledgements"."head_digest") = 32),
	CONSTRAINT "ns_key_envelope_acknowledgements_digest_size" CHECK (octet_length("namespace_key_envelope_acknowledgements"."acknowledgement_digest") = 32)
);
--> statement-breakpoint
ALTER TABLE "namespace_key_envelope_acknowledgements" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "namespace_key_generation_heads" (
	"namespace_id" uuid NOT NULL,
	"key_class" text NOT NULL,
	"generation" bigint NOT NULL,
	"access_revision" bigint NOT NULL,
	"audience_fingerprint" "bytea" NOT NULL,
	"head_digest" "bytea" NOT NULL,
	"previous_head_digest" "bytea",
	"publication_digest" "bytea" NOT NULL,
	"publication_operation_id" text NOT NULL,
	"issuer_device_id" text NOT NULL,
	"issuer_device_generation" bigint NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"activated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "namespace_key_generation_heads_namespace_id_key_class_pk" PRIMARY KEY("namespace_id","key_class"),
	CONSTRAINT "uq_ns_key_generation_heads_digest" UNIQUE("namespace_id","key_class","head_digest"),
	CONSTRAINT "ns_key_generation_heads_key_class" CHECK ("namespace_key_generation_heads"."key_class" in ('human', 'ai')),
	CONSTRAINT "ns_key_generation_heads_generation_positive" CHECK ("namespace_key_generation_heads"."generation" between 1 and 9007199254740991),
	CONSTRAINT "ns_key_generation_heads_access_revision_safe" CHECK ("namespace_key_generation_heads"."access_revision" between 0 and 9007199254740991),
	CONSTRAINT "ns_key_generation_heads_audience_size" CHECK (octet_length("namespace_key_generation_heads"."audience_fingerprint") = 32),
	CONSTRAINT "ns_key_generation_heads_digest_size" CHECK (octet_length("namespace_key_generation_heads"."head_digest") = 32),
	CONSTRAINT "ns_key_generation_heads_previous_size" CHECK (octet_length("namespace_key_generation_heads"."previous_head_digest") = 32),
	CONSTRAINT "ns_key_generation_heads_publication_size" CHECK (octet_length("namespace_key_generation_heads"."publication_digest") = 32),
	CONSTRAINT "ns_key_generation_heads_predecessor_coherent" CHECK (("namespace_key_generation_heads"."generation" = 1 and "namespace_key_generation_heads"."previous_head_digest" is null)
        or ("namespace_key_generation_heads"."generation" > 1 and "namespace_key_generation_heads"."previous_head_digest" is not null)),
	CONSTRAINT "ns_key_generation_heads_operation_id_portable" CHECK (octet_length("namespace_key_generation_heads"."publication_operation_id") between 1
      and 128
      and "namespace_key_generation_heads"."publication_operation_id" ~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]*$'),
	CONSTRAINT "ns_key_generation_heads_issuer_id_portable" CHECK (octet_length("namespace_key_generation_heads"."issuer_device_id") between 1
      and 128
      and "namespace_key_generation_heads"."issuer_device_id" ~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]*$'),
	CONSTRAINT "ns_key_generation_heads_device_generation_safe" CHECK ("namespace_key_generation_heads"."issuer_device_generation" between 0 and 9007199254740991),
	CONSTRAINT "ns_key_generation_heads_time_order" CHECK ("namespace_key_generation_heads"."activated_at" >= "namespace_key_generation_heads"."created_at")
);
--> statement-breakpoint
ALTER TABLE "namespace_key_generation_heads" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "namespace_key_publication_operations" (
	"operation_id" text PRIMARY KEY NOT NULL,
	"idempotency_key" text NOT NULL,
	"namespace_id" uuid NOT NULL,
	"issuer_human_id" text NOT NULL,
	"issuer_device_id" text NOT NULL,
	"issuer_device_generation" bigint NOT NULL,
	"expected_access_revision" bigint NOT NULL,
	"expected_audience_fingerprint" "bytea" NOT NULL,
	"expected_human_predecessor_digest" "bytea",
	"expected_ai_predecessor_digest" "bytea",
	"publication_digest" "bytea" NOT NULL,
	"publication_bytes" "bytea" NOT NULL,
	"envelope_set_digest" "bytea" NOT NULL,
	"envelope_row_count" integer NOT NULL,
	"aggregate_envelope_bytes" bigint NOT NULL,
	"state" text NOT NULL,
	"failure_code" text,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"deadline_at" timestamp with time zone NOT NULL,
	"activated_at" timestamp with time zone,
	"terminal_at" timestamp with time zone,
	CONSTRAINT "uq_ns_key_pub_operations_idempotency" UNIQUE("idempotency_key"),
	CONSTRAINT "uq_ns_key_pub_operations_digest" UNIQUE("namespace_id","publication_digest"),
	CONSTRAINT "ns_key_pub_operations_id_portable" CHECK (octet_length("namespace_key_publication_operations"."operation_id") between 1
      and 128
      and "namespace_key_publication_operations"."operation_id" ~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]*$'),
	CONSTRAINT "ns_key_pub_operations_idempotency_portable" CHECK (octet_length("namespace_key_publication_operations"."idempotency_key") between 1
      and 128
      and "namespace_key_publication_operations"."idempotency_key" ~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]*$'),
	CONSTRAINT "ns_key_pub_operations_issuer_human_id_portable" CHECK (octet_length("namespace_key_publication_operations"."issuer_human_id") between 1
      and 128
      and "namespace_key_publication_operations"."issuer_human_id" ~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]*$'),
	CONSTRAINT "ns_key_pub_operations_issuer_id_portable" CHECK (octet_length("namespace_key_publication_operations"."issuer_device_id") between 1
      and 128
      and "namespace_key_publication_operations"."issuer_device_id" ~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]*$'),
	CONSTRAINT "ns_key_pub_operations_device_generation_safe" CHECK ("namespace_key_publication_operations"."issuer_device_generation" between 0 and 9007199254740991),
	CONSTRAINT "ns_key_pub_operations_access_revision_safe" CHECK ("namespace_key_publication_operations"."expected_access_revision" between 0 and 9007199254740991),
	CONSTRAINT "ns_key_pub_operations_audience_size" CHECK (octet_length("namespace_key_publication_operations"."expected_audience_fingerprint") = 32),
	CONSTRAINT "ns_key_pub_operations_human_predecessor_size" CHECK (octet_length("namespace_key_publication_operations"."expected_human_predecessor_digest") = 32),
	CONSTRAINT "ns_key_pub_operations_ai_predecessor_size" CHECK (octet_length("namespace_key_publication_operations"."expected_ai_predecessor_digest") = 32),
	CONSTRAINT "ns_key_pub_operations_publication_size" CHECK (octet_length("namespace_key_publication_operations"."publication_digest") = 32),
	CONSTRAINT "ns_key_pub_operations_publication_bytes_size" CHECK (octet_length("namespace_key_publication_operations"."publication_bytes") between 1
      and 67108864),
	CONSTRAINT "ns_key_pub_operations_envelope_set_size" CHECK (octet_length("namespace_key_publication_operations"."envelope_set_digest") = 32),
	CONSTRAINT "ns_key_pub_operations_predecessors_coherent" CHECK (("namespace_key_publication_operations"."expected_human_predecessor_digest" is null)
        = ("namespace_key_publication_operations"."expected_ai_predecessor_digest" is null)),
	CONSTRAINT "ns_key_pub_operations_envelope_count" CHECK ("namespace_key_publication_operations"."envelope_row_count" between 2 and 4096),
	CONSTRAINT "ns_key_pub_operations_aggregate_size" CHECK ("namespace_key_publication_operations"."aggregate_envelope_bytes" between "namespace_key_publication_operations"."envelope_row_count"
        and 67108864),
	CONSTRAINT "ns_key_pub_operations_state" CHECK ("namespace_key_publication_operations"."state" in ('reserved', 'active', 'stale', 'expired', 'failed')),
	CONSTRAINT "ns_key_pub_operations_lifecycle_coherent" CHECK ((
        "namespace_key_publication_operations"."state" = 'reserved'
        and "namespace_key_publication_operations"."failure_code" is null
        and "namespace_key_publication_operations"."activated_at" is null
        and "namespace_key_publication_operations"."terminal_at" is null
      ) or (
        "namespace_key_publication_operations"."state" = 'active'
        and "namespace_key_publication_operations"."failure_code" is null
        and "namespace_key_publication_operations"."activated_at" is not null
        and "namespace_key_publication_operations"."terminal_at" is not null
      ) or (
        "namespace_key_publication_operations"."state" in ('stale', 'expired', 'failed')
        and "namespace_key_publication_operations"."failure_code" is not null
        and "namespace_key_publication_operations"."activated_at" is null
        and "namespace_key_publication_operations"."terminal_at" is not null
      )),
	CONSTRAINT "ns_key_pub_operations_failure_code_portable" CHECK (octet_length("namespace_key_publication_operations"."failure_code") between 1
      and 128
      and "namespace_key_publication_operations"."failure_code" ~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]*$'),
	CONSTRAINT "ns_key_pub_operations_time_order" CHECK ("namespace_key_publication_operations"."updated_at" >= "namespace_key_publication_operations"."created_at"
        and "namespace_key_publication_operations"."deadline_at" > "namespace_key_publication_operations"."created_at"
        and "namespace_key_publication_operations"."deadline_at"
          <= "namespace_key_publication_operations"."created_at" + interval '300 seconds'
        and ("namespace_key_publication_operations"."activated_at" is null
          or "namespace_key_publication_operations"."activated_at" >= "namespace_key_publication_operations"."created_at")
        and ("namespace_key_publication_operations"."terminal_at" is null
          or "namespace_key_publication_operations"."terminal_at" >= "namespace_key_publication_operations"."created_at"))
);
--> statement-breakpoint
ALTER TABLE "namespace_key_publication_operations" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "namespace_key_recipient_envelopes" (
	"namespace_id" uuid NOT NULL,
	"key_class" text NOT NULL,
	"generation" bigint NOT NULL,
	"recipient_kind" text NOT NULL,
	"recipient_human_id" text NOT NULL,
	"recipient_key_id" text NOT NULL,
	"recipient_key_generation" bigint NOT NULL,
	"recipient_device_id" text,
	"recipient_recovery_key_id" text,
	"recipient_recovery_generation" bigint,
	"recipient_public_key_digest" "bytea" NOT NULL,
	"envelope_digest" "bytea" NOT NULL,
	"envelope_bytes" "bytea" NOT NULL,
	"head_digest" "bytea" NOT NULL,
	"issuer_device_id" text NOT NULL,
	"issuer_device_generation" bigint NOT NULL,
	"issuer_signature" "bytea" NOT NULL,
	"access_revision" bigint NOT NULL,
	"audience_fingerprint" "bytea" NOT NULL,
	"publication_operation_id" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "namespace_key_recipient_envelopes_namespace_id_key_class_generation_recipient_kind_recipient_human_id_recipient_key_id_recipient_key_generation_pk" PRIMARY KEY("namespace_id","key_class","generation","recipient_kind","recipient_human_id","recipient_key_id","recipient_key_generation"),
	CONSTRAINT "uq_ns_key_recipient_envelopes_digest" UNIQUE("namespace_id","key_class","generation","envelope_digest"),
	CONSTRAINT "uq_ns_key_recipient_envelopes_device_target" UNIQUE("namespace_id","key_class","generation","recipient_kind","recipient_human_id","recipient_key_id","recipient_key_generation","recipient_device_id"),
	CONSTRAINT "uq_ns_key_recipient_envelopes_ack_target" UNIQUE("namespace_id","key_class","generation","recipient_kind","recipient_human_id","recipient_key_id","recipient_key_generation","envelope_digest","head_digest"),
	CONSTRAINT "ns_key_recipient_envelopes_key_class" CHECK ("namespace_key_recipient_envelopes"."key_class" in ('human', 'ai')),
	CONSTRAINT "ns_key_recipient_envelopes_generation_positive" CHECK ("namespace_key_recipient_envelopes"."generation" between 1 and 9007199254740991),
	CONSTRAINT "ns_key_recipient_envelopes_recipient_shape" CHECK ((
        "namespace_key_recipient_envelopes"."recipient_kind" = 'device'
        and "namespace_key_recipient_envelopes"."recipient_device_id" is not null
        and "namespace_key_recipient_envelopes"."recipient_key_id" = "namespace_key_recipient_envelopes"."recipient_device_id"
        and "namespace_key_recipient_envelopes"."recipient_recovery_key_id" is null
        and "namespace_key_recipient_envelopes"."recipient_recovery_generation" is null
      ) or (
        "namespace_key_recipient_envelopes"."recipient_kind" = 'recovery'
        and "namespace_key_recipient_envelopes"."recipient_device_id" is null
        and "namespace_key_recipient_envelopes"."recipient_recovery_key_id" is not null
        and "namespace_key_recipient_envelopes"."recipient_key_id" = "namespace_key_recipient_envelopes"."recipient_recovery_key_id"
        and "namespace_key_recipient_envelopes"."recipient_recovery_generation"
          = "namespace_key_recipient_envelopes"."recipient_key_generation"
      )),
	CONSTRAINT "ns_key_recipient_envelopes_human_id_portable" CHECK (octet_length("namespace_key_recipient_envelopes"."recipient_human_id") between 1
      and 128
      and "namespace_key_recipient_envelopes"."recipient_human_id" ~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]*$'),
	CONSTRAINT "ns_key_recipient_envelopes_key_id_portable" CHECK (octet_length("namespace_key_recipient_envelopes"."recipient_key_id") between 1
      and 128
      and "namespace_key_recipient_envelopes"."recipient_key_id" ~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]*$'),
	CONSTRAINT "ns_key_recipient_envelopes_device_id_portable" CHECK (octet_length("namespace_key_recipient_envelopes"."recipient_device_id") between 1
      and 128
      and "namespace_key_recipient_envelopes"."recipient_device_id" ~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]*$'),
	CONSTRAINT "ns_key_recipient_envelopes_recovery_id_portable" CHECK (octet_length("namespace_key_recipient_envelopes"."recipient_recovery_key_id") between 1
      and 128
      and "namespace_key_recipient_envelopes"."recipient_recovery_key_id" ~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]*$'),
	CONSTRAINT "ns_key_recipient_envelopes_key_generation_safe" CHECK ("namespace_key_recipient_envelopes"."recipient_key_generation" between 0 and 9007199254740991),
	CONSTRAINT "ns_key_recipient_envelopes_recovery_generation_safe" CHECK ("namespace_key_recipient_envelopes"."recipient_recovery_generation" between 0 and 9007199254740991),
	CONSTRAINT "ns_key_recipient_envelopes_public_key_size" CHECK (octet_length("namespace_key_recipient_envelopes"."recipient_public_key_digest") = 32),
	CONSTRAINT "ns_key_recipient_envelopes_digest_size" CHECK (octet_length("namespace_key_recipient_envelopes"."envelope_digest") = 32),
	CONSTRAINT "ns_key_recipient_envelopes_bytes_size" CHECK (octet_length("namespace_key_recipient_envelopes"."envelope_bytes") between 1
      and 1048616),
	CONSTRAINT "ns_key_recipient_envelopes_head_size" CHECK (octet_length("namespace_key_recipient_envelopes"."head_digest") = 32),
	CONSTRAINT "ns_key_recipient_envelopes_issuer_id_portable" CHECK (octet_length("namespace_key_recipient_envelopes"."issuer_device_id") between 1
      and 128
      and "namespace_key_recipient_envelopes"."issuer_device_id" ~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]*$'),
	CONSTRAINT "ns_key_recipient_envelopes_issuer_generation_safe" CHECK ("namespace_key_recipient_envelopes"."issuer_device_generation" between 0 and 9007199254740991),
	CONSTRAINT "ns_key_recipient_envelopes_signature_size" CHECK (octet_length("namespace_key_recipient_envelopes"."issuer_signature") = 64),
	CONSTRAINT "ns_key_recipient_envelopes_access_revision_safe" CHECK ("namespace_key_recipient_envelopes"."access_revision" between 0 and 9007199254740991),
	CONSTRAINT "ns_key_recipient_envelopes_audience_size" CHECK (octet_length("namespace_key_recipient_envelopes"."audience_fingerprint") = 32),
	CONSTRAINT "ns_key_recipient_envelopes_operation_id_portable" CHECK (octet_length("namespace_key_recipient_envelopes"."publication_operation_id") between 1
      and 128
      and "namespace_key_recipient_envelopes"."publication_operation_id" ~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]*$')
);
--> statement-breakpoint
ALTER TABLE "namespace_key_recipient_envelopes" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "namespace_key_envelope_acknowledgements" ADD CONSTRAINT "ns_key_envelope_acknowledgements_envelope_fk" FOREIGN KEY ("namespace_id","key_class","generation","recipient_kind","recipient_human_id","recipient_key_id","recipient_key_generation","envelope_digest","head_digest") REFERENCES "public"."namespace_key_recipient_envelopes"("namespace_id","key_class","generation","recipient_kind","recipient_human_id","recipient_key_id","recipient_key_generation","envelope_digest","head_digest") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "namespace_key_envelope_acknowledgements" ADD CONSTRAINT "ns_key_envelope_acknowledgements_device_fk" FOREIGN KEY ("device_id") REFERENCES "public"."human_crypto_devices"("device_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "namespace_key_generation_heads" ADD CONSTRAINT "ns_key_generation_heads_namespace_fk" FOREIGN KEY ("namespace_id") REFERENCES "public"."namespaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "namespace_key_generation_heads" ADD CONSTRAINT "ns_key_generation_heads_operation_fk" FOREIGN KEY ("publication_operation_id") REFERENCES "public"."namespace_key_publication_operations"("operation_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "namespace_key_generation_heads" ADD CONSTRAINT "ns_key_generation_heads_issuer_fk" FOREIGN KEY ("issuer_device_id") REFERENCES "public"."human_crypto_devices"("device_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "namespace_key_publication_operations" ADD CONSTRAINT "ns_key_pub_operations_namespace_fk" FOREIGN KEY ("namespace_id") REFERENCES "public"."namespaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "namespace_key_publication_operations" ADD CONSTRAINT "ns_key_pub_operations_issuer_human_fk" FOREIGN KEY ("issuer_human_id") REFERENCES "public"."human_crypto_custodies"("human_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "namespace_key_publication_operations" ADD CONSTRAINT "ns_key_pub_operations_issuer_fk" FOREIGN KEY ("issuer_device_id") REFERENCES "public"."human_crypto_devices"("device_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "namespace_key_recipient_envelopes" ADD CONSTRAINT "ns_key_recipient_envelopes_namespace_fk" FOREIGN KEY ("namespace_id") REFERENCES "public"."namespaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "namespace_key_recipient_envelopes" ADD CONSTRAINT "ns_key_recipient_envelopes_human_fk" FOREIGN KEY ("recipient_human_id") REFERENCES "public"."human_crypto_custodies"("human_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "namespace_key_recipient_envelopes" ADD CONSTRAINT "ns_key_recipient_envelopes_device_fk" FOREIGN KEY ("recipient_device_id") REFERENCES "public"."human_crypto_devices"("device_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "namespace_key_recipient_envelopes" ADD CONSTRAINT "ns_key_recipient_envelopes_recovery_key_fk" FOREIGN KEY ("recipient_recovery_key_id") REFERENCES "public"."human_crypto_recovery_keys"("recovery_key_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "namespace_key_recipient_envelopes" ADD CONSTRAINT "ns_key_recipient_envelopes_recovery_generation_fk" FOREIGN KEY ("recipient_human_id","recipient_recovery_generation") REFERENCES "public"."human_crypto_recovery_keys"("human_id","generation") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "namespace_key_recipient_envelopes" ADD CONSTRAINT "ns_key_recipient_envelopes_issuer_fk" FOREIGN KEY ("issuer_device_id") REFERENCES "public"."human_crypto_devices"("device_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "namespace_key_recipient_envelopes" ADD CONSTRAINT "ns_key_recipient_envelopes_operation_fk" FOREIGN KEY ("publication_operation_id") REFERENCES "public"."namespace_key_publication_operations"("operation_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_ns_key_envelope_acknowledgements_device" ON "namespace_key_envelope_acknowledgements" USING btree ("device_id","acknowledged_at");--> statement-breakpoint
CREATE INDEX "idx_ns_key_generation_heads_publication" ON "namespace_key_generation_heads" USING btree ("publication_operation_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_ns_key_pub_operations_live_namespace" ON "namespace_key_publication_operations" USING btree ("namespace_id") WHERE "namespace_key_publication_operations"."state" = 'reserved';--> statement-breakpoint
CREATE INDEX "idx_ns_key_pub_operations_reconcile" ON "namespace_key_publication_operations" USING btree ("state","deadline_at","created_at");--> statement-breakpoint
CREATE INDEX "idx_ns_key_recipient_envelopes_device_fetch" ON "namespace_key_recipient_envelopes" USING btree ("recipient_device_id","namespace_id","key_class","generation");--> statement-breakpoint
CREATE INDEX "idx_ns_key_recipient_envelopes_recovery" ON "namespace_key_recipient_envelopes" USING btree ("recipient_recovery_key_id","namespace_id","key_class","generation");--> statement-breakpoint
CREATE INDEX "idx_ns_key_recipient_envelopes_publication" ON "namespace_key_recipient_envelopes" USING btree ("publication_operation_id");--> statement-breakpoint
CREATE POLICY "namespace_key_envelope_acknowledgements_crypto_sel" ON "namespace_key_envelope_acknowledgements" AS PERMISSIVE FOR SELECT TO "nautilo_crypto" USING (true);--> statement-breakpoint
CREATE POLICY "namespace_key_envelope_acknowledgements_crypto_ins" ON "namespace_key_envelope_acknowledgements" AS PERMISSIVE FOR INSERT TO "nautilo_crypto" WITH CHECK (true);--> statement-breakpoint
CREATE POLICY "namespace_key_generation_heads_crypto_sel" ON "namespace_key_generation_heads" AS PERMISSIVE FOR SELECT TO "nautilo_crypto" USING (true);--> statement-breakpoint
CREATE POLICY "namespace_key_generation_heads_crypto_ins" ON "namespace_key_generation_heads" AS PERMISSIVE FOR INSERT TO "nautilo_crypto" WITH CHECK (true);--> statement-breakpoint
CREATE POLICY "namespace_key_generation_heads_crypto_upd" ON "namespace_key_generation_heads" AS PERMISSIVE FOR UPDATE TO "nautilo_crypto" USING (true) WITH CHECK (true);--> statement-breakpoint
CREATE POLICY "namespace_key_publication_operations_crypto_sel" ON "namespace_key_publication_operations" AS PERMISSIVE FOR SELECT TO "nautilo_crypto" USING (true);--> statement-breakpoint
CREATE POLICY "namespace_key_publication_operations_crypto_ins" ON "namespace_key_publication_operations" AS PERMISSIVE FOR INSERT TO "nautilo_crypto" WITH CHECK (true);--> statement-breakpoint
CREATE POLICY "namespace_key_publication_operations_crypto_upd" ON "namespace_key_publication_operations" AS PERMISSIVE FOR UPDATE TO "nautilo_crypto" USING (true) WITH CHECK (true);--> statement-breakpoint
CREATE POLICY "namespace_key_recipient_envelopes_crypto_sel" ON "namespace_key_recipient_envelopes" AS PERMISSIVE FOR SELECT TO "nautilo_crypto" USING (true);--> statement-breakpoint
CREATE POLICY "namespace_key_recipient_envelopes_crypto_ins" ON "namespace_key_recipient_envelopes" AS PERMISSIVE FOR INSERT TO "nautilo_crypto" WITH CHECK (true);
--> statement-breakpoint
-- M290_NAMESPACE_KEY_AUTHORITY
ALTER TABLE "namespace_key_publication_operations" FORCE ROW LEVEL SECURITY;
ALTER TABLE "namespace_key_generation_heads" FORCE ROW LEVEL SECURITY;
ALTER TABLE "namespace_key_recipient_envelopes" FORCE ROW LEVEL SECURITY;
ALTER TABLE "namespace_key_envelope_acknowledgements" FORCE ROW LEVEL SECURITY;
REVOKE ALL PRIVILEGES ON TABLE
  "namespace_key_publication_operations",
  "namespace_key_generation_heads",
  "namespace_key_recipient_envelopes",
  "namespace_key_envelope_acknowledgements"
FROM PUBLIC, "nautilo_agent", "nautilo_crypto";
GRANT SELECT, INSERT, UPDATE ON TABLE "namespace_key_publication_operations" TO "nautilo_crypto";
GRANT SELECT, INSERT, UPDATE ON TABLE "namespace_key_generation_heads" TO "nautilo_crypto";
GRANT SELECT, INSERT ON TABLE "namespace_key_recipient_envelopes" TO "nautilo_crypto";
GRANT SELECT, INSERT ON TABLE "namespace_key_envelope_acknowledgements" TO "nautilo_crypto";

CREATE OR REPLACE FUNCTION "public"."protect_namespace_key_publication_operation"()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog
AS $$
BEGIN
  IF ROW(
    NEW.operation_id, NEW.idempotency_key, NEW.namespace_id,
    NEW.issuer_human_id, NEW.issuer_device_id, NEW.issuer_device_generation,
    NEW.expected_access_revision, NEW.expected_audience_fingerprint,
    NEW.expected_human_predecessor_digest, NEW.expected_ai_predecessor_digest,
    NEW.publication_digest, NEW.publication_bytes, NEW.envelope_set_digest,
    NEW.envelope_row_count, NEW.aggregate_envelope_bytes,
    NEW.created_at, NEW.deadline_at
  ) IS DISTINCT FROM ROW(
    OLD.operation_id, OLD.idempotency_key, OLD.namespace_id,
    OLD.issuer_human_id, OLD.issuer_device_id, OLD.issuer_device_generation,
    OLD.expected_access_revision, OLD.expected_audience_fingerprint,
    OLD.expected_human_predecessor_digest, OLD.expected_ai_predecessor_digest,
    OLD.publication_digest, OLD.publication_bytes, OLD.envelope_set_digest,
    OLD.envelope_row_count, OLD.aggregate_envelope_bytes,
    OLD.created_at, OLD.deadline_at
  ) THEN
    RAISE EXCEPTION 'Namespace key publication identity is immutable'
      USING ERRCODE = '23514';
  END IF;
  IF OLD.state <> 'reserved' AND NEW IS DISTINCT FROM OLD THEN
    RAISE EXCEPTION 'terminal Namespace key publication is immutable'
      USING ERRCODE = '23514';
  END IF;
  IF NOT (NEW.state = OLD.state
    OR (OLD.state = 'reserved'
      AND NEW.state IN ('active', 'stale', 'expired', 'failed'))) THEN
    RAISE EXCEPTION 'Namespace key publication state transition is invalid'
      USING ERRCODE = '23514';
  END IF;
  IF NEW.updated_at < OLD.updated_at THEN
    RAISE EXCEPTION 'Namespace key publication time is monotonic'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION "public"."protect_namespace_key_publication_operation"()
  FROM PUBLIC, "nautilo_agent", "nautilo_crypto";
GRANT EXECUTE ON FUNCTION "public"."protect_namespace_key_publication_operation"()
  TO "nautilo_crypto";
CREATE TRIGGER "namespace_key_publication_operations_protected"
BEFORE UPDATE ON "namespace_key_publication_operations"
FOR EACH ROW EXECUTE FUNCTION "public"."protect_namespace_key_publication_operation"();

CREATE OR REPLACE FUNCTION "public"."validate_namespace_key_publication_issuer"()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog
AS $$
BEGIN
  IF TG_OP = 'UPDATE'
    AND NEW.state IN ('stale', 'expired', 'failed')
  THEN
    RETURN NEW;
  END IF;
  PERFORM 1
    FROM "public"."human_crypto_devices" AS device_row
   WHERE device_row.device_id = NEW.issuer_device_id
     AND device_row.human_id = NEW.issuer_human_id
     AND device_row.device_generation = NEW.issuer_device_generation
     AND device_row.state = 'active'
   FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Namespace key publication issuer is not current'
      USING ERRCODE = '23503';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION "public"."validate_namespace_key_publication_issuer"()
  FROM PUBLIC, "nautilo_agent", "nautilo_crypto";
GRANT EXECUTE ON FUNCTION "public"."validate_namespace_key_publication_issuer"()
  TO "nautilo_crypto";
CREATE TRIGGER "namespace_key_publication_operations_current_issuer"
BEFORE INSERT OR UPDATE ON "namespace_key_publication_operations"
FOR EACH ROW EXECUTE FUNCTION "public"."validate_namespace_key_publication_issuer"();

CREATE OR REPLACE FUNCTION "public"."protect_namespace_key_generation_head"()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog
AS $$
BEGIN
  IF NEW.namespace_id IS DISTINCT FROM OLD.namespace_id
    OR NEW.key_class IS DISTINCT FROM OLD.key_class
    OR NEW.generation <> OLD.generation + 1
    OR NEW.previous_head_digest IS DISTINCT FROM OLD.head_digest
    OR NEW.access_revision < OLD.access_revision
    OR NEW.created_at < OLD.activated_at
    OR NEW.activated_at < NEW.created_at
  THEN
    RAISE EXCEPTION 'Namespace key head did not advance by exact predecessor CAS'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION "public"."protect_namespace_key_generation_head"()
  FROM PUBLIC, "nautilo_agent", "nautilo_crypto";
GRANT EXECUTE ON FUNCTION "public"."protect_namespace_key_generation_head"()
  TO "nautilo_crypto";
CREATE TRIGGER "namespace_key_generation_heads_monotonic"
BEFORE UPDATE ON "namespace_key_generation_heads"
FOR EACH ROW EXECUTE FUNCTION "public"."protect_namespace_key_generation_head"();

CREATE OR REPLACE FUNCTION "public"."validate_active_namespace_key_publication"()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog
AS $$
DECLARE
  head_count bigint;
  envelope_count bigint;
  envelope_bytes bigint;
BEGIN
  IF NEW.state <> 'active' THEN
    RETURN NEW;
  END IF;
  SELECT count(*) INTO head_count
    FROM "public"."namespace_key_generation_heads" AS head_row
   WHERE head_row.publication_operation_id = NEW.operation_id
     AND head_row.access_revision = NEW.expected_access_revision
     AND head_row.audience_fingerprint = NEW.expected_audience_fingerprint
     AND head_row.issuer_device_id = NEW.issuer_device_id
     AND head_row.issuer_device_generation = NEW.issuer_device_generation;
  SELECT count(*), coalesce(sum(octet_length(envelope_row.envelope_bytes)), 0)
    INTO envelope_count, envelope_bytes
    FROM "public"."namespace_key_recipient_envelopes" AS envelope_row
   WHERE envelope_row.publication_operation_id = NEW.operation_id
     AND envelope_row.access_revision = NEW.expected_access_revision
     AND envelope_row.audience_fingerprint = NEW.expected_audience_fingerprint
     AND envelope_row.issuer_device_id = NEW.issuer_device_id
     AND envelope_row.issuer_device_generation = NEW.issuer_device_generation;
  IF head_count <> 2
    OR envelope_count <> NEW.envelope_row_count
    OR envelope_bytes <> NEW.aggregate_envelope_bytes
  THEN
    RAISE EXCEPTION 'active Namespace key publication is incomplete'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION "public"."validate_active_namespace_key_publication"()
  FROM PUBLIC, "nautilo_agent", "nautilo_crypto";
GRANT EXECUTE ON FUNCTION "public"."validate_active_namespace_key_publication"()
  TO "nautilo_crypto";
CREATE CONSTRAINT TRIGGER "namespace_key_publication_operations_complete"
AFTER INSERT OR UPDATE ON "namespace_key_publication_operations"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "public"."validate_active_namespace_key_publication"();
--> statement-breakpoint
-- M290_NAMESPACE_KEY_HEAD_ACTIVATION
CREATE OR REPLACE FUNCTION "public"."validate_namespace_key_generation_head_activation"()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog
AS $$
BEGIN
  PERFORM 1
    FROM "public"."namespace_key_publication_operations" AS operation_row
   WHERE operation_row.operation_id = NEW.publication_operation_id
     AND operation_row.state = 'active';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Namespace key head points to an inactive publication'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION "public"."validate_namespace_key_generation_head_activation"()
  FROM PUBLIC, "nautilo_agent", "nautilo_crypto";
GRANT EXECUTE ON FUNCTION "public"."validate_namespace_key_generation_head_activation"()
  TO "nautilo_crypto";
CREATE CONSTRAINT TRIGGER "namespace_key_generation_heads_active_publication"
AFTER INSERT OR UPDATE ON "namespace_key_generation_heads"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "public"."validate_namespace_key_generation_head_activation"();
