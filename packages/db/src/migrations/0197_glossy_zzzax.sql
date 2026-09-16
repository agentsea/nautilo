CREATE TABLE "namespace_key_recipient_authorization_operations" (
	"operation_id" text PRIMARY KEY NOT NULL,
	"idempotency_key" text NOT NULL,
	"namespace_id" uuid NOT NULL,
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
	"current_access_revision" bigint NOT NULL,
	"current_audience_fingerprint" "bytea" NOT NULL,
	"authorization_digest" "bytea" NOT NULL,
	"authorization_bytes" "bytea" NOT NULL,
	"entry_count" integer NOT NULL,
	"aggregate_envelope_bytes" bigint NOT NULL,
	"state" text NOT NULL,
	"failure_code" text,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"deadline_at" timestamp with time zone NOT NULL,
	"activated_at" timestamp with time zone,
	"terminal_at" timestamp with time zone,
	CONSTRAINT "uq_ns_key_recipient_auth_idempotency" UNIQUE("idempotency_key"),
	CONSTRAINT "uq_ns_key_recipient_auth_digest" UNIQUE("authorization_digest"),
	CONSTRAINT "ns_key_recipient_auth_operation_portable" CHECK (octet_length("namespace_key_recipient_authorization_operations"."operation_id") between 1
      and 128
      and "namespace_key_recipient_authorization_operations"."operation_id" ~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]*$'),
	CONSTRAINT "ns_key_recipient_auth_idempotency_portable" CHECK (octet_length("namespace_key_recipient_authorization_operations"."idempotency_key") between 1
      and 128
      and "namespace_key_recipient_authorization_operations"."idempotency_key" ~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]*$'),
	CONSTRAINT "ns_key_recipient_auth_issuer_human_portable" CHECK (octet_length("namespace_key_recipient_authorization_operations"."issuer_human_id") between 1
      and 128
      and "namespace_key_recipient_authorization_operations"."issuer_human_id" ~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]*$'),
	CONSTRAINT "ns_key_recipient_auth_issuer_device_portable" CHECK (octet_length("namespace_key_recipient_authorization_operations"."issuer_device_id") between 1
      and 128
      and "namespace_key_recipient_authorization_operations"."issuer_device_id" ~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]*$'),
	CONSTRAINT "ns_key_recipient_auth_human_portable" CHECK (octet_length("namespace_key_recipient_authorization_operations"."recipient_human_id") between 1
      and 128
      and "namespace_key_recipient_authorization_operations"."recipient_human_id" ~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]*$'),
	CONSTRAINT "ns_key_recipient_auth_key_portable" CHECK (octet_length("namespace_key_recipient_authorization_operations"."recipient_key_id") between 1
      and 128
      and "namespace_key_recipient_authorization_operations"."recipient_key_id" ~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]*$'),
	CONSTRAINT "ns_key_recipient_auth_device_portable" CHECK (octet_length("namespace_key_recipient_authorization_operations"."recipient_device_id") between 1
      and 128
      and "namespace_key_recipient_authorization_operations"."recipient_device_id" ~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]*$'),
	CONSTRAINT "ns_key_recipient_auth_recovery_portable" CHECK (octet_length("namespace_key_recipient_authorization_operations"."recipient_recovery_key_id") between 1
      and 128
      and "namespace_key_recipient_authorization_operations"."recipient_recovery_key_id" ~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]*$'),
	CONSTRAINT "ns_key_recipient_auth_issuer_generation_safe" CHECK ("namespace_key_recipient_authorization_operations"."issuer_device_generation" between 0 and 9007199254740991),
	CONSTRAINT "ns_key_recipient_auth_recipient_generation_safe" CHECK ("namespace_key_recipient_authorization_operations"."recipient_key_generation" between 0 and 9007199254740991),
	CONSTRAINT "ns_key_recipient_auth_recovery_generation_safe" CHECK ("namespace_key_recipient_authorization_operations"."recipient_recovery_generation" between 0 and 9007199254740991),
	CONSTRAINT "ns_key_recipient_auth_access_revision_safe" CHECK ("namespace_key_recipient_authorization_operations"."current_access_revision" between 0 and 9007199254740991),
	CONSTRAINT "ns_key_recipient_auth_recipient_shape" CHECK ((
        "namespace_key_recipient_authorization_operations"."recipient_kind" = 'device'
        and "namespace_key_recipient_authorization_operations"."recipient_device_id" is not null
        and "namespace_key_recipient_authorization_operations"."recipient_key_id" = "namespace_key_recipient_authorization_operations"."recipient_device_id"
        and "namespace_key_recipient_authorization_operations"."recipient_recovery_key_id" is null
        and "namespace_key_recipient_authorization_operations"."recipient_recovery_generation" is null
      ) or (
        "namespace_key_recipient_authorization_operations"."recipient_kind" = 'recovery'
        and "namespace_key_recipient_authorization_operations"."recipient_device_id" is null
        and "namespace_key_recipient_authorization_operations"."recipient_recovery_key_id" is not null
        and "namespace_key_recipient_authorization_operations"."recipient_key_id" = "namespace_key_recipient_authorization_operations"."recipient_recovery_key_id"
        and "namespace_key_recipient_authorization_operations"."recipient_recovery_generation"
          = "namespace_key_recipient_authorization_operations"."recipient_key_generation"
      )),
	CONSTRAINT "ns_key_recipient_auth_public_key_size" CHECK (octet_length("namespace_key_recipient_authorization_operations"."recipient_public_key_digest") = 32),
	CONSTRAINT "ns_key_recipient_auth_audience_size" CHECK (octet_length("namespace_key_recipient_authorization_operations"."current_audience_fingerprint") = 32),
	CONSTRAINT "ns_key_recipient_auth_digest_size" CHECK (octet_length("namespace_key_recipient_authorization_operations"."authorization_digest") = 32),
	CONSTRAINT "ns_key_recipient_auth_bytes_size" CHECK (octet_length("namespace_key_recipient_authorization_operations"."authorization_bytes") between 1
      and 2097152),
	CONSTRAINT "ns_key_recipient_auth_entry_count" CHECK ("namespace_key_recipient_authorization_operations"."entry_count" between 1 and 128),
	CONSTRAINT "ns_key_recipient_auth_aggregate_size" CHECK ("namespace_key_recipient_authorization_operations"."aggregate_envelope_bytes" between "namespace_key_recipient_authorization_operations"."entry_count"
        and 2097152),
	CONSTRAINT "ns_key_recipient_auth_state" CHECK ("namespace_key_recipient_authorization_operations"."state" in ('reserved', 'active', 'stale', 'expired', 'failed')),
	CONSTRAINT "ns_key_recipient_auth_failure_portable" CHECK (octet_length("namespace_key_recipient_authorization_operations"."failure_code") between 1
      and 128
      and "namespace_key_recipient_authorization_operations"."failure_code" ~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]*$'),
	CONSTRAINT "ns_key_recipient_auth_lifecycle_coherent" CHECK ((
        "namespace_key_recipient_authorization_operations"."state" = 'reserved'
        and "namespace_key_recipient_authorization_operations"."failure_code" is null
        and "namespace_key_recipient_authorization_operations"."activated_at" is null
        and "namespace_key_recipient_authorization_operations"."terminal_at" is null
      ) or (
        "namespace_key_recipient_authorization_operations"."state" = 'active'
        and "namespace_key_recipient_authorization_operations"."failure_code" is null
        and "namespace_key_recipient_authorization_operations"."activated_at" is not null
        and "namespace_key_recipient_authorization_operations"."terminal_at" is not null
      ) or (
        "namespace_key_recipient_authorization_operations"."state" in ('stale', 'expired', 'failed')
        and "namespace_key_recipient_authorization_operations"."failure_code" is not null
        and "namespace_key_recipient_authorization_operations"."activated_at" is null
        and "namespace_key_recipient_authorization_operations"."terminal_at" is not null
      )),
	CONSTRAINT "ns_key_recipient_auth_time_order" CHECK ("namespace_key_recipient_authorization_operations"."updated_at" >= "namespace_key_recipient_authorization_operations"."created_at"
        and "namespace_key_recipient_authorization_operations"."deadline_at" > "namespace_key_recipient_authorization_operations"."created_at"
        and "namespace_key_recipient_authorization_operations"."deadline_at"
          <= "namespace_key_recipient_authorization_operations"."created_at" + interval '30 seconds'
        and ("namespace_key_recipient_authorization_operations"."activated_at" is null
          or "namespace_key_recipient_authorization_operations"."activated_at" >= "namespace_key_recipient_authorization_operations"."created_at")
        and ("namespace_key_recipient_authorization_operations"."terminal_at" is null
          or "namespace_key_recipient_authorization_operations"."terminal_at" >= "namespace_key_recipient_authorization_operations"."created_at"))
);
--> statement-breakpoint
ALTER TABLE "namespace_key_recipient_authorization_operations" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "namespace_key_recipient_sync_campaigns" (
	"campaign_id" text PRIMARY KEY NOT NULL,
	"namespace_id" uuid NOT NULL,
	"recipient_kind" text NOT NULL,
	"recipient_human_id" text NOT NULL,
	"recipient_key_id" text NOT NULL,
	"recipient_key_generation" bigint NOT NULL,
	"recipient_device_id" text,
	"recipient_recovery_key_id" text,
	"recipient_recovery_generation" bigint,
	"recipient_public_key_digest" "bytea" NOT NULL,
	"current_access_revision" bigint NOT NULL,
	"current_audience_fingerprint" "bytea" NOT NULL,
	"required_generation_count" integer NOT NULL,
	"covered_generation_count" integer NOT NULL,
	"state" text NOT NULL,
	"reason" text,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"terminal_at" timestamp with time zone,
	CONSTRAINT "uq_ns_key_recipient_sync_target" UNIQUE("namespace_id","recipient_kind","recipient_human_id","recipient_key_id","recipient_key_generation"),
	CONSTRAINT "ns_key_recipient_sync_campaign_portable" CHECK (octet_length("namespace_key_recipient_sync_campaigns"."campaign_id") between 1
      and 128
      and "namespace_key_recipient_sync_campaigns"."campaign_id" ~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]*$'),
	CONSTRAINT "ns_key_recipient_sync_human_portable" CHECK (octet_length("namespace_key_recipient_sync_campaigns"."recipient_human_id") between 1
      and 128
      and "namespace_key_recipient_sync_campaigns"."recipient_human_id" ~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]*$'),
	CONSTRAINT "ns_key_recipient_sync_key_portable" CHECK (octet_length("namespace_key_recipient_sync_campaigns"."recipient_key_id") between 1
      and 128
      and "namespace_key_recipient_sync_campaigns"."recipient_key_id" ~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]*$'),
	CONSTRAINT "ns_key_recipient_sync_device_portable" CHECK (octet_length("namespace_key_recipient_sync_campaigns"."recipient_device_id") between 1
      and 128
      and "namespace_key_recipient_sync_campaigns"."recipient_device_id" ~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]*$'),
	CONSTRAINT "ns_key_recipient_sync_recovery_portable" CHECK (octet_length("namespace_key_recipient_sync_campaigns"."recipient_recovery_key_id") between 1
      and 128
      and "namespace_key_recipient_sync_campaigns"."recipient_recovery_key_id" ~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]*$'),
	CONSTRAINT "ns_key_recipient_sync_key_generation_safe" CHECK ("namespace_key_recipient_sync_campaigns"."recipient_key_generation" between 0 and 9007199254740991),
	CONSTRAINT "ns_key_recipient_sync_recovery_generation_safe" CHECK ("namespace_key_recipient_sync_campaigns"."recipient_recovery_generation" between 0 and 9007199254740991),
	CONSTRAINT "ns_key_recipient_sync_access_revision_safe" CHECK ("namespace_key_recipient_sync_campaigns"."current_access_revision" between 0 and 9007199254740991),
	CONSTRAINT "ns_key_recipient_sync_public_key_size" CHECK (octet_length("namespace_key_recipient_sync_campaigns"."recipient_public_key_digest") = 32),
	CONSTRAINT "ns_key_recipient_sync_audience_size" CHECK (octet_length("namespace_key_recipient_sync_campaigns"."current_audience_fingerprint") = 32),
	CONSTRAINT "ns_key_recipient_sync_recipient_shape" CHECK ((
        "namespace_key_recipient_sync_campaigns"."recipient_kind" = 'device'
        and "namespace_key_recipient_sync_campaigns"."recipient_device_id" is not null
        and "namespace_key_recipient_sync_campaigns"."recipient_key_id" = "namespace_key_recipient_sync_campaigns"."recipient_device_id"
        and "namespace_key_recipient_sync_campaigns"."recipient_recovery_key_id" is null
        and "namespace_key_recipient_sync_campaigns"."recipient_recovery_generation" is null
      ) or (
        "namespace_key_recipient_sync_campaigns"."recipient_kind" = 'recovery'
        and "namespace_key_recipient_sync_campaigns"."recipient_device_id" is null
        and "namespace_key_recipient_sync_campaigns"."recipient_recovery_key_id" is not null
        and "namespace_key_recipient_sync_campaigns"."recipient_key_id" = "namespace_key_recipient_sync_campaigns"."recipient_recovery_key_id"
        and "namespace_key_recipient_sync_campaigns"."recipient_recovery_generation"
          = "namespace_key_recipient_sync_campaigns"."recipient_key_generation"
      )),
	CONSTRAINT "ns_key_recipient_sync_coverage" CHECK ("namespace_key_recipient_sync_campaigns"."required_generation_count" between 0 and 9007199254740991
        and "namespace_key_recipient_sync_campaigns"."covered_generation_count" between 0
          and "namespace_key_recipient_sync_campaigns"."required_generation_count"),
	CONSTRAINT "ns_key_recipient_sync_state" CHECK ("namespace_key_recipient_sync_campaigns"."state" in (
        'syncing', 'ready', 'waiting_for_authorized_device',
        'recovery_required', 'unrecoverable', 'stale'
      )),
	CONSTRAINT "ns_key_recipient_sync_reason_portable" CHECK (octet_length("namespace_key_recipient_sync_campaigns"."reason") between 1
      and 128
      and "namespace_key_recipient_sync_campaigns"."reason" ~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]*$'),
	CONSTRAINT "ns_key_recipient_sync_lifecycle" CHECK ((
        "namespace_key_recipient_sync_campaigns"."state" = 'ready'
        and "namespace_key_recipient_sync_campaigns"."covered_generation_count" = "namespace_key_recipient_sync_campaigns"."required_generation_count"
        and "namespace_key_recipient_sync_campaigns"."reason" is null
        and "namespace_key_recipient_sync_campaigns"."terminal_at" is not null
      ) or (
        "namespace_key_recipient_sync_campaigns"."state" in ('unrecoverable', 'stale')
        and "namespace_key_recipient_sync_campaigns"."covered_generation_count" < "namespace_key_recipient_sync_campaigns"."required_generation_count"
        and "namespace_key_recipient_sync_campaigns"."reason" is not null
        and "namespace_key_recipient_sync_campaigns"."terminal_at" is not null
      ) or (
        "namespace_key_recipient_sync_campaigns"."state" not in ('ready', 'unrecoverable', 'stale')
        and "namespace_key_recipient_sync_campaigns"."reason" is not null
        and "namespace_key_recipient_sync_campaigns"."terminal_at" is null
      )),
	CONSTRAINT "ns_key_recipient_sync_time_order" CHECK ("namespace_key_recipient_sync_campaigns"."updated_at" >= "namespace_key_recipient_sync_campaigns"."created_at"
        and ("namespace_key_recipient_sync_campaigns"."terminal_at" is null
          or "namespace_key_recipient_sync_campaigns"."terminal_at" >= "namespace_key_recipient_sync_campaigns"."created_at"))
);
--> statement-breakpoint
ALTER TABLE "namespace_key_recipient_sync_campaigns" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "namespace_key_recipient_envelopes" DROP CONSTRAINT "ns_key_recipient_envelopes_operation_id_portable";--> statement-breakpoint
ALTER TABLE "namespace_key_recipient_envelopes" ALTER COLUMN "publication_operation_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "namespace_key_generation_heads" ADD COLUMN "generation_key_commitment" "bytea";--> statement-breakpoint
ALTER TABLE "namespace_key_recipient_envelopes" ADD COLUMN "generation_key_commitment" "bytea";--> statement-breakpoint
ALTER TABLE "namespace_key_recipient_envelopes" ADD COLUMN "source_publication_digest" "bytea";--> statement-breakpoint
ALTER TABLE "namespace_key_recipient_envelopes" ADD COLUMN "source_publication_set_digest" "bytea";--> statement-breakpoint
ALTER TABLE "namespace_key_recipient_envelopes" ADD COLUMN "recipient_authorization_operation_id" text;--> statement-breakpoint
ALTER TABLE "namespace_key_recipient_authorization_operations" ADD CONSTRAINT "ns_key_recipient_auth_namespace_fk" FOREIGN KEY ("namespace_id") REFERENCES "public"."namespaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "namespace_key_recipient_authorization_operations" ADD CONSTRAINT "ns_key_recipient_auth_issuer_human_fk" FOREIGN KEY ("issuer_human_id") REFERENCES "public"."human_crypto_custodies"("human_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "namespace_key_recipient_authorization_operations" ADD CONSTRAINT "ns_key_recipient_auth_issuer_device_fk" FOREIGN KEY ("issuer_device_id") REFERENCES "public"."human_crypto_devices"("device_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "namespace_key_recipient_authorization_operations" ADD CONSTRAINT "ns_key_recipient_auth_human_fk" FOREIGN KEY ("recipient_human_id") REFERENCES "public"."human_crypto_custodies"("human_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "namespace_key_recipient_authorization_operations" ADD CONSTRAINT "ns_key_recipient_auth_device_fk" FOREIGN KEY ("recipient_device_id") REFERENCES "public"."human_crypto_devices"("device_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "namespace_key_recipient_authorization_operations" ADD CONSTRAINT "ns_key_recipient_auth_recovery_key_fk" FOREIGN KEY ("recipient_recovery_key_id") REFERENCES "public"."human_crypto_recovery_keys"("recovery_key_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "namespace_key_recipient_authorization_operations" ADD CONSTRAINT "ns_key_recipient_auth_recovery_generation_fk" FOREIGN KEY ("recipient_human_id","recipient_recovery_generation") REFERENCES "public"."human_crypto_recovery_keys"("human_id","generation") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "namespace_key_recipient_sync_campaigns" ADD CONSTRAINT "ns_key_recipient_sync_namespace_fk" FOREIGN KEY ("namespace_id") REFERENCES "public"."namespaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "namespace_key_recipient_sync_campaigns" ADD CONSTRAINT "ns_key_recipient_sync_human_fk" FOREIGN KEY ("recipient_human_id") REFERENCES "public"."human_crypto_custodies"("human_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "namespace_key_recipient_sync_campaigns" ADD CONSTRAINT "ns_key_recipient_sync_device_fk" FOREIGN KEY ("recipient_device_id") REFERENCES "public"."human_crypto_devices"("device_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "namespace_key_recipient_sync_campaigns" ADD CONSTRAINT "ns_key_recipient_sync_recovery_key_fk" FOREIGN KEY ("recipient_recovery_key_id") REFERENCES "public"."human_crypto_recovery_keys"("recovery_key_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "namespace_key_recipient_sync_campaigns" ADD CONSTRAINT "ns_key_recipient_sync_recovery_generation_fk" FOREIGN KEY ("recipient_human_id","recipient_recovery_generation") REFERENCES "public"."human_crypto_recovery_keys"("human_id","generation") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_ns_key_recipient_auth_reconcile" ON "namespace_key_recipient_authorization_operations" USING btree ("state","deadline_at","created_at");--> statement-breakpoint
CREATE INDEX "idx_ns_key_recipient_auth_target" ON "namespace_key_recipient_authorization_operations" USING btree ("namespace_id","recipient_human_id","recipient_kind","recipient_key_id","recipient_key_generation","created_at");--> statement-breakpoint
CREATE INDEX "idx_ns_key_recipient_sync_status" ON "namespace_key_recipient_sync_campaigns" USING btree ("recipient_human_id","state","updated_at");--> statement-breakpoint
CREATE INDEX "idx_ns_key_recipient_sync_namespace" ON "namespace_key_recipient_sync_campaigns" USING btree ("namespace_id","state","updated_at");--> statement-breakpoint
ALTER TABLE "namespace_key_recipient_envelopes" ADD CONSTRAINT "ns_key_recipient_envelopes_authorization_operation_fk" FOREIGN KEY ("recipient_authorization_operation_id") REFERENCES "public"."namespace_key_recipient_authorization_operations"("operation_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_ns_key_recipient_envelopes_authorization" ON "namespace_key_recipient_envelopes" USING btree ("recipient_authorization_operation_id");--> statement-breakpoint
ALTER TABLE "namespace_key_generation_heads" ADD CONSTRAINT "ns_key_generation_heads_commitment_size" CHECK (octet_length("namespace_key_generation_heads"."generation_key_commitment") = 32);--> statement-breakpoint
ALTER TABLE "namespace_key_recipient_envelopes" ADD CONSTRAINT "ns_key_recipient_envelopes_commitment_size" CHECK (octet_length("namespace_key_recipient_envelopes"."generation_key_commitment") = 32);--> statement-breakpoint
ALTER TABLE "namespace_key_recipient_envelopes" ADD CONSTRAINT "ns_key_recipient_envelopes_source_publication_size" CHECK (octet_length("namespace_key_recipient_envelopes"."source_publication_digest") = 32);--> statement-breakpoint
ALTER TABLE "namespace_key_recipient_envelopes" ADD CONSTRAINT "ns_key_recipient_envelopes_source_set_size" CHECK (octet_length("namespace_key_recipient_envelopes"."source_publication_set_digest") = 32);--> statement-breakpoint
ALTER TABLE "namespace_key_recipient_envelopes" ADD CONSTRAINT "ns_key_recipient_envelopes_commitment_shape" CHECK (("namespace_key_recipient_envelopes"."generation_key_commitment" is null
          and "namespace_key_recipient_envelopes"."source_publication_digest" is null
          and "namespace_key_recipient_envelopes"."source_publication_set_digest" is null)
        or ("namespace_key_recipient_envelopes"."generation_key_commitment" is not null
          and "namespace_key_recipient_envelopes"."source_publication_digest" is not null
          and "namespace_key_recipient_envelopes"."source_publication_set_digest" is not null));--> statement-breakpoint
ALTER TABLE "namespace_key_recipient_envelopes" ADD CONSTRAINT "ns_key_recipient_envelopes_publication_operation_portable" CHECK (octet_length("namespace_key_recipient_envelopes"."publication_operation_id") between 1
      and 128
      and "namespace_key_recipient_envelopes"."publication_operation_id" ~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]*$');--> statement-breakpoint
ALTER TABLE "namespace_key_recipient_envelopes" ADD CONSTRAINT "ns_key_recipient_envelopes_authorization_operation_portable" CHECK (octet_length("namespace_key_recipient_envelopes"."recipient_authorization_operation_id") between 1
      and 128
      and "namespace_key_recipient_envelopes"."recipient_authorization_operation_id" ~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]*$');--> statement-breakpoint
ALTER TABLE "namespace_key_recipient_envelopes" ADD CONSTRAINT "ns_key_recipient_envelopes_origin_shape" CHECK (("namespace_key_recipient_envelopes"."publication_operation_id" is null)
        <> ("namespace_key_recipient_envelopes"."recipient_authorization_operation_id" is null));--> statement-breakpoint
CREATE POLICY "namespace_key_recipient_authorization_operations_crypto_sel" ON "namespace_key_recipient_authorization_operations" AS PERMISSIVE FOR SELECT TO "nautilo_crypto" USING (true);--> statement-breakpoint
CREATE POLICY "namespace_key_recipient_authorization_operations_crypto_ins" ON "namespace_key_recipient_authorization_operations" AS PERMISSIVE FOR INSERT TO "nautilo_crypto" WITH CHECK (true);--> statement-breakpoint
CREATE POLICY "namespace_key_recipient_authorization_operations_crypto_upd" ON "namespace_key_recipient_authorization_operations" AS PERMISSIVE FOR UPDATE TO "nautilo_crypto" USING (true) WITH CHECK (true);--> statement-breakpoint
CREATE POLICY "namespace_key_recipient_sync_campaigns_crypto_sel" ON "namespace_key_recipient_sync_campaigns" AS PERMISSIVE FOR SELECT TO "nautilo_crypto" USING (true);--> statement-breakpoint
CREATE POLICY "namespace_key_recipient_sync_campaigns_crypto_ins" ON "namespace_key_recipient_sync_campaigns" AS PERMISSIVE FOR INSERT TO "nautilo_crypto" WITH CHECK (true);--> statement-breakpoint
CREATE POLICY "namespace_key_recipient_sync_campaigns_crypto_upd" ON "namespace_key_recipient_sync_campaigns" AS PERMISSIVE FOR UPDATE TO "nautilo_crypto" USING (true) WITH CHECK (true);
--> statement-breakpoint
-- M290_NAMESPACE_RECIPIENT_SYNCHRONIZATION
ALTER TABLE "namespace_key_recipient_authorization_operations" FORCE ROW LEVEL SECURITY;
ALTER TABLE "namespace_key_recipient_sync_campaigns" FORCE ROW LEVEL SECURITY;
REVOKE ALL PRIVILEGES ON TABLE
  "namespace_key_recipient_authorization_operations",
  "namespace_key_recipient_sync_campaigns"
  FROM PUBLIC, "nautilo_agent", "nautilo_crypto";
GRANT SELECT, INSERT, UPDATE ON TABLE "namespace_key_recipient_authorization_operations"
  TO "nautilo_crypto";
GRANT SELECT, INSERT, UPDATE ON TABLE "namespace_key_recipient_sync_campaigns"
  TO "nautilo_crypto";
CREATE OR REPLACE FUNCTION "public"."validate_namespace_key_recipient_envelope_commitment"()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog
AS $$
BEGIN
  IF NEW.generation_key_commitment IS NULL
    OR NEW.source_publication_digest IS NULL
    OR NEW.source_publication_set_digest IS NULL
  THEN
    RAISE EXCEPTION 'new Namespace recipient envelope lacks committed key authority'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION "public"."validate_namespace_key_recipient_envelope_commitment"()
  FROM PUBLIC, "nautilo_agent", "nautilo_crypto";
GRANT EXECUTE ON FUNCTION "public"."validate_namespace_key_recipient_envelope_commitment"()
  TO "nautilo_crypto";
CREATE TRIGGER "namespace_key_recipient_envelopes_committed"
BEFORE INSERT ON "namespace_key_recipient_envelopes"
FOR EACH ROW EXECUTE FUNCTION "public"."validate_namespace_key_recipient_envelope_commitment"();

CREATE OR REPLACE FUNCTION "public"."validate_namespace_key_generation_head_commitment"()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog
AS $$
BEGIN
  IF NEW.generation_key_commitment IS NULL THEN
    RAISE EXCEPTION 'Namespace key head lacks committed key authority'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION "public"."validate_namespace_key_generation_head_commitment"()
  FROM PUBLIC, "nautilo_agent", "nautilo_crypto";
GRANT EXECUTE ON FUNCTION "public"."validate_namespace_key_generation_head_commitment"()
  TO "nautilo_crypto";
CREATE TRIGGER "namespace_key_generation_heads_committed"
BEFORE INSERT OR UPDATE ON "namespace_key_generation_heads"
FOR EACH ROW EXECUTE FUNCTION "public"."validate_namespace_key_generation_head_commitment"();

CREATE OR REPLACE FUNCTION "public"."protect_namespace_key_recipient_authorization_operation"()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog
AS $$
BEGIN
  IF ROW(
    NEW.operation_id, NEW.idempotency_key, NEW.namespace_id,
    NEW.issuer_human_id, NEW.issuer_device_id, NEW.issuer_device_generation,
    NEW.recipient_kind, NEW.recipient_human_id, NEW.recipient_key_id,
    NEW.recipient_key_generation, NEW.recipient_device_id,
    NEW.recipient_recovery_key_id, NEW.recipient_recovery_generation,
    NEW.recipient_public_key_digest, NEW.current_access_revision,
    NEW.current_audience_fingerprint, NEW.authorization_digest,
    NEW.authorization_bytes, NEW.entry_count, NEW.aggregate_envelope_bytes,
    NEW.created_at, NEW.deadline_at
  ) IS DISTINCT FROM ROW(
    OLD.operation_id, OLD.idempotency_key, OLD.namespace_id,
    OLD.issuer_human_id, OLD.issuer_device_id, OLD.issuer_device_generation,
    OLD.recipient_kind, OLD.recipient_human_id, OLD.recipient_key_id,
    OLD.recipient_key_generation, OLD.recipient_device_id,
    OLD.recipient_recovery_key_id, OLD.recipient_recovery_generation,
    OLD.recipient_public_key_digest, OLD.current_access_revision,
    OLD.current_audience_fingerprint, OLD.authorization_digest,
    OLD.authorization_bytes, OLD.entry_count, OLD.aggregate_envelope_bytes,
    OLD.created_at, OLD.deadline_at
  ) THEN
    RAISE EXCEPTION 'Namespace recipient authorization identity is immutable'
      USING ERRCODE = '23514';
  END IF;
  IF OLD.state <> 'reserved' AND NEW IS DISTINCT FROM OLD THEN
    RAISE EXCEPTION 'terminal Namespace recipient authorization is immutable'
      USING ERRCODE = '23514';
  END IF;
  IF NOT (NEW.state = OLD.state
    OR (OLD.state = 'reserved'
      AND NEW.state IN ('active', 'stale', 'expired', 'failed'))) THEN
    RAISE EXCEPTION 'Namespace recipient authorization state transition is invalid'
      USING ERRCODE = '23514';
  END IF;
  IF NEW.updated_at < OLD.updated_at THEN
    RAISE EXCEPTION 'Namespace recipient authorization time is monotonic'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION "public"."protect_namespace_key_recipient_authorization_operation"()
  FROM PUBLIC, "nautilo_agent", "nautilo_crypto";
GRANT EXECUTE ON FUNCTION "public"."protect_namespace_key_recipient_authorization_operation"()
  TO "nautilo_crypto";
CREATE TRIGGER "namespace_key_recipient_authorizations_protected"
BEFORE UPDATE ON "namespace_key_recipient_authorization_operations"
FOR EACH ROW EXECUTE FUNCTION "public"."protect_namespace_key_recipient_authorization_operation"();

CREATE OR REPLACE FUNCTION "public"."validate_namespace_key_recipient_authorization_issuer"()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog
AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.state IN ('stale', 'expired', 'failed') THEN
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
    RAISE EXCEPTION 'Namespace recipient authorization issuer is not current'
      USING ERRCODE = '23503';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION "public"."validate_namespace_key_recipient_authorization_issuer"()
  FROM PUBLIC, "nautilo_agent", "nautilo_crypto";
GRANT EXECUTE ON FUNCTION "public"."validate_namespace_key_recipient_authorization_issuer"()
  TO "nautilo_crypto";
CREATE TRIGGER "namespace_key_recipient_authorizations_current_issuer"
BEFORE INSERT OR UPDATE ON "namespace_key_recipient_authorization_operations"
FOR EACH ROW EXECUTE FUNCTION "public"."validate_namespace_key_recipient_authorization_issuer"();

CREATE OR REPLACE FUNCTION "public"."validate_active_namespace_key_recipient_authorization"()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog
AS $$
DECLARE
  envelope_count bigint;
  envelope_bytes bigint;
BEGIN
  IF NEW.state <> 'active' THEN
    RETURN NEW;
  END IF;
  SELECT count(*), coalesce(sum(octet_length(envelope_row.envelope_bytes)), 0)
    INTO envelope_count, envelope_bytes
    FROM "public"."namespace_key_recipient_envelopes" AS envelope_row
   WHERE envelope_row.recipient_authorization_operation_id = NEW.operation_id
     AND envelope_row.namespace_id = NEW.namespace_id
     AND envelope_row.recipient_kind = NEW.recipient_kind
     AND envelope_row.recipient_human_id = NEW.recipient_human_id
     AND envelope_row.recipient_key_id = NEW.recipient_key_id
     AND envelope_row.recipient_key_generation = NEW.recipient_key_generation
     AND envelope_row.recipient_public_key_digest = NEW.recipient_public_key_digest
     AND envelope_row.issuer_device_id = NEW.issuer_device_id
     AND envelope_row.issuer_device_generation = NEW.issuer_device_generation;
  IF envelope_count <> NEW.entry_count
    OR envelope_bytes <> NEW.aggregate_envelope_bytes
  THEN
    RAISE EXCEPTION 'active Namespace recipient authorization is incomplete'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION "public"."validate_active_namespace_key_recipient_authorization"()
  FROM PUBLIC, "nautilo_agent", "nautilo_crypto";
GRANT EXECUTE ON FUNCTION "public"."validate_active_namespace_key_recipient_authorization"()
  TO "nautilo_crypto";
CREATE CONSTRAINT TRIGGER "namespace_key_recipient_authorizations_complete"
AFTER INSERT OR UPDATE ON "namespace_key_recipient_authorization_operations"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "public"."validate_active_namespace_key_recipient_authorization"();

CREATE OR REPLACE FUNCTION "public"."protect_namespace_key_recipient_sync_campaign"()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog
AS $$
BEGIN
  IF ROW(
    NEW.campaign_id, NEW.namespace_id, NEW.recipient_kind,
    NEW.recipient_human_id, NEW.recipient_key_id,
    NEW.recipient_key_generation, NEW.recipient_device_id,
    NEW.recipient_recovery_key_id, NEW.recipient_recovery_generation,
    NEW.created_at
  ) IS DISTINCT FROM ROW(
    OLD.campaign_id, OLD.namespace_id, OLD.recipient_kind,
    OLD.recipient_human_id, OLD.recipient_key_id,
    OLD.recipient_key_generation, OLD.recipient_device_id,
    OLD.recipient_recovery_key_id, OLD.recipient_recovery_generation,
    OLD.created_at
  ) THEN
    RAISE EXCEPTION 'Namespace recipient sync campaign identity is immutable'
      USING ERRCODE = '23514';
  END IF;
  IF NEW.current_access_revision < OLD.current_access_revision
    OR NEW.required_generation_count < OLD.required_generation_count
    OR NEW.covered_generation_count < OLD.covered_generation_count
    OR NEW.updated_at < OLD.updated_at
  THEN
    RAISE EXCEPTION 'Namespace recipient sync campaign progress is monotonic'
      USING ERRCODE = '23514';
  END IF;
  IF OLD.state = 'unrecoverable' AND NEW IS DISTINCT FROM OLD THEN
    RAISE EXCEPTION 'unrecoverable Namespace recipient sync campaign is terminal'
      USING ERRCODE = '23514';
  END IF;
  IF OLD.state = 'stale' AND NEW IS DISTINCT FROM OLD THEN
    RAISE EXCEPTION 'stale Namespace recipient sync campaign is terminal'
      USING ERRCODE = '23514';
  END IF;
  IF OLD.state = 'ready' AND NEW.state NOT IN ('ready', 'stale') THEN
    RAISE EXCEPTION 'ready Namespace recipient sync campaign cannot reopen'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION "public"."protect_namespace_key_recipient_sync_campaign"()
  FROM PUBLIC, "nautilo_agent", "nautilo_crypto";
GRANT EXECUTE ON FUNCTION "public"."protect_namespace_key_recipient_sync_campaign"()
  TO "nautilo_crypto";
CREATE TRIGGER "namespace_key_recipient_sync_campaigns_protected"
BEFORE UPDATE ON "namespace_key_recipient_sync_campaigns"
FOR EACH ROW EXECUTE FUNCTION "public"."protect_namespace_key_recipient_sync_campaign"();


