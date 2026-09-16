CREATE TABLE "reflection_record_dependencies" (
	"parent_record_id" text NOT NULL,
	"child_record_id" text NOT NULL,
	CONSTRAINT "reflection_record_dependencies_parent_record_id_child_record_id_pk" PRIMARY KEY("parent_record_id","child_record_id"),
	CONSTRAINT "reflection_record_dependencies_no_self" CHECK ("reflection_record_dependencies"."parent_record_id" <> "reflection_record_dependencies"."child_record_id")
);
--> statement-breakpoint
ALTER TABLE "reflection_record_dependencies" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "reflection_record_payload_representation_heads" (
	"record_id" text NOT NULL,
	"representation" text NOT NULL,
	"current_representation_generation" integer NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "reflection_record_payload_representation_heads_record_id_representation_pk" PRIMARY KEY("record_id","representation"),
	CONSTRAINT "reflection_record_payload_heads_generation_positive" CHECK ("reflection_record_payload_representation_heads"."current_representation_generation" > 0),
	CONSTRAINT "reflection_record_payload_heads_representation_closed" CHECK ("reflection_record_payload_representation_heads"."representation" in ('ordinary', 'protected'))
);
--> statement-breakpoint
ALTER TABLE "reflection_record_payload_representation_heads" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "reflection_record_payload_representations" (
	"record_id" text NOT NULL,
	"representation" text NOT NULL,
	"representation_generation" integer NOT NULL,
	"payload_version" smallint DEFAULT 1 NOT NULL,
	"plaintext_payload_bytes" "bytea",
	"crypto_object_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "reflection_record_payload_representations_record_id_representation_representation_generation_pk" PRIMARY KEY("record_id","representation","representation_generation"),
	CONSTRAINT "reflection_record_payload_generation_positive" CHECK ("reflection_record_payload_representations"."representation_generation" > 0),
	CONSTRAINT "reflection_record_payload_representation_closed" CHECK ("reflection_record_payload_representations"."representation" in ('ordinary', 'protected')),
	CONSTRAINT "reflection_record_payload_version_v1" CHECK ("reflection_record_payload_representations"."payload_version" = 1),
	CONSTRAINT "reflection_record_payload_shape" CHECK ((
        "reflection_record_payload_representations"."representation" = 'ordinary'
        and octet_length("reflection_record_payload_representations"."plaintext_payload_bytes") between 1 and 262144
        and "reflection_record_payload_representations"."crypto_object_id" is null
      ) or (
        "reflection_record_payload_representations"."representation" = 'protected'
        and "reflection_record_payload_representations"."plaintext_payload_bytes" is null
        and "reflection_record_payload_representations"."crypto_object_id" is not null
      )),
	CONSTRAINT "reflection_record_payload_crypto_object_portable" CHECK (octet_length("reflection_record_payload_representations"."crypto_object_id") between 1 and 128
      and "reflection_record_payload_representations"."crypto_object_id" ~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]*$')
);
--> statement-breakpoint
ALTER TABLE "reflection_record_payload_representations" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "reflection_record_publications" (
	"publication_id" text PRIMARY KEY NOT NULL,
	"record_id" text NOT NULL,
	"representation" text NOT NULL,
	"representation_generation" integer NOT NULL,
	"payload_version" smallint DEFAULT 1 NOT NULL,
	"request_commitment" "bytea" NOT NULL,
	"publication_binding_ref" text NOT NULL,
	"crypto_object_id" text,
	"state" text NOT NULL,
	"attempt_count" smallint DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone,
	"lease_token" uuid,
	"lease_expires_at" timestamp with time zone,
	"failure_code" text,
	"crypto_completed_at" timestamp with time zone,
	"product_attached_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uq_reflection_record_publications_coordinate" UNIQUE("record_id","representation","representation_generation"),
	CONSTRAINT "reflection_record_publications_id_portable" CHECK (octet_length("reflection_record_publications"."publication_id") between 1 and 128
      and "reflection_record_publications"."publication_id" ~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]*$'),
	CONSTRAINT "reflection_record_publications_record_id_portable" CHECK (octet_length("reflection_record_publications"."record_id") between 1 and 128
      and "reflection_record_publications"."record_id" ~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]*$'),
	CONSTRAINT "reflection_record_publications_binding_portable" CHECK (octet_length("reflection_record_publications"."publication_binding_ref") between 1 and 128
      and "reflection_record_publications"."publication_binding_ref" ~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]*$'),
	CONSTRAINT "reflection_record_publications_crypto_object_portable" CHECK (octet_length("reflection_record_publications"."crypto_object_id") between 1 and 128
      and "reflection_record_publications"."crypto_object_id" ~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]*$'),
	CONSTRAINT "reflection_record_publications_generation_positive" CHECK ("reflection_record_publications"."representation_generation" > 0),
	CONSTRAINT "reflection_record_publications_representation_closed" CHECK ("reflection_record_publications"."representation" in ('ordinary', 'protected')),
	CONSTRAINT "reflection_record_publications_state_closed" CHECK ("reflection_record_publications"."state" in (
        'reserved', 'crypto_complete', 'product_attached', 'complete',
        'blocked', 'quarantined', 'retry_exhausted'
      )),
	CONSTRAINT "reflection_record_publications_payload_version_v1" CHECK ("reflection_record_publications"."payload_version" = 1),
	CONSTRAINT "reflection_record_publications_commitment_size" CHECK (octet_length("reflection_record_publications"."request_commitment") = 32),
	CONSTRAINT "reflection_record_publications_representation_shape" CHECK ((
        "reflection_record_publications"."representation" = 'ordinary'
        and "reflection_record_publications"."crypto_object_id" is null
      ) or (
        "reflection_record_publications"."representation" = 'protected'
      )),
	CONSTRAINT "reflection_record_publications_attempt_bound" CHECK ("reflection_record_publications"."attempt_count" between 0 and 8),
	CONSTRAINT "reflection_record_publications_lease_coherent" CHECK (("reflection_record_publications"."lease_token" is null) = ("reflection_record_publications"."lease_expires_at" is null)),
	CONSTRAINT "reflection_record_publications_crypto_state_coherent" CHECK ((
        "reflection_record_publications"."representation" = 'ordinary'
        and "reflection_record_publications"."crypto_completed_at" is null
      ) or (
        "reflection_record_publications"."representation" = 'protected'
        and (
          "reflection_record_publications"."state" in ('reserved', 'blocked', 'quarantined', 'retry_exhausted')
          or ("reflection_record_publications"."crypto_object_id" is not null and "reflection_record_publications"."crypto_completed_at" is not null)
        )
      )),
	CONSTRAINT "reflection_record_publications_attachment_coherent" CHECK ((
        "reflection_record_publications"."state" in ('reserved', 'crypto_complete')
        and "reflection_record_publications"."product_attached_at" is null
        and "reflection_record_publications"."completed_at" is null
      ) or (
        "reflection_record_publications"."state" = 'product_attached'
        and "reflection_record_publications"."product_attached_at" is not null
        and "reflection_record_publications"."completed_at" is null
      ) or (
        "reflection_record_publications"."state" = 'complete'
        and "reflection_record_publications"."product_attached_at" is not null
        and "reflection_record_publications"."completed_at" is not null
      ) or (
        "reflection_record_publications"."state" in ('blocked', 'quarantined', 'retry_exhausted')
        and "reflection_record_publications"."completed_at" is null
      )),
	CONSTRAINT "reflection_record_publications_failure_coherent" CHECK ((
        "reflection_record_publications"."state" in ('blocked', 'quarantined', 'retry_exhausted')
        and "reflection_record_publications"."failure_code" is not null
      ) or (
        "reflection_record_publications"."state" not in ('blocked', 'quarantined', 'retry_exhausted')
        and "reflection_record_publications"."failure_code" is null
      )),
	CONSTRAINT "reflection_record_publications_failure_code_closed" CHECK ("reflection_record_publications"."failure_code" is null or "reflection_record_publications"."failure_code" in (
        'authorization_unavailable', 'crypto_absent', 'crypto_incomplete',
        'crypto_mismatch', 'integrity_failure', 'mapping_conflict',
        'storage_transient', 'retry_exhausted', 'blocked', 'purged'
      )),
	CONSTRAINT "reflection_record_publications_failure_code_bound" CHECK ("reflection_record_publications"."failure_code" is null or octet_length("reflection_record_publications"."failure_code") <= 64)
);
--> statement-breakpoint
ALTER TABLE "reflection_record_publications" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "reflection_record_successors" (
	"predecessor_record_id" text PRIMARY KEY NOT NULL,
	"successor_record_id" text NOT NULL,
	"relation" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uq_reflection_record_successors_successor" UNIQUE("successor_record_id"),
	CONSTRAINT "reflection_record_successors_no_self" CHECK ("reflection_record_successors"."predecessor_record_id" <> "reflection_record_successors"."successor_record_id"),
	CONSTRAINT "reflection_record_successors_relation_closed" CHECK ("reflection_record_successors"."relation" in ('supersedes', 'resolves'))
);
--> statement-breakpoint
ALTER TABLE "reflection_record_successors" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "reflection_records" (
	"record_id" text PRIMARY KEY NOT NULL,
	"lifecycle" text NOT NULL,
	"structural_height" integer NOT NULL,
	"producer_policy_version" text NOT NULL,
	"processing_generation" integer NOT NULL,
	"payload_version" smallint DEFAULT 1 NOT NULL,
	"disposition" text DEFAULT 'available' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "reflection_records_id_portable" CHECK (octet_length("reflection_records"."record_id") between 1 and 128
      and "reflection_records"."record_id" ~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]*$'),
	CONSTRAINT "reflection_records_policy_version_portable" CHECK (octet_length("reflection_records"."producer_policy_version") between 1 and 128
      and "reflection_records"."producer_policy_version" ~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]*$'),
	CONSTRAINT "reflection_records_height_nonnegative" CHECK ("reflection_records"."structural_height" >= 0),
	CONSTRAINT "reflection_records_lifecycle_closed" CHECK ("reflection_records"."lifecycle" in ('current', 'stale', 'superseded', 'resolved', 'sunset')),
	CONSTRAINT "reflection_records_disposition_closed" CHECK ("reflection_records"."disposition" in ('available', 'blocked', 'purged')),
	CONSTRAINT "reflection_records_processing_generation_positive" CHECK ("reflection_records"."processing_generation" > 0),
	CONSTRAINT "reflection_records_payload_version_v1" CHECK ("reflection_records"."payload_version" = 1)
);
--> statement-breakpoint
ALTER TABLE "reflection_records" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "reflection_record_dependencies" ADD CONSTRAINT "reflection_record_dependencies_parent_record_id_reflection_records_record_id_fk" FOREIGN KEY ("parent_record_id") REFERENCES "public"."reflection_records"("record_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reflection_record_dependencies" ADD CONSTRAINT "reflection_record_dependencies_child_record_id_reflection_records_record_id_fk" FOREIGN KEY ("child_record_id") REFERENCES "public"."reflection_records"("record_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reflection_record_payload_representation_heads" ADD CONSTRAINT "reflection_record_payload_heads_representation_fk" FOREIGN KEY ("record_id","representation","current_representation_generation") REFERENCES "public"."reflection_record_payload_representations"("record_id","representation","representation_generation") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reflection_record_payload_representations" ADD CONSTRAINT "reflection_record_payload_representations_record_id_reflection_records_record_id_fk" FOREIGN KEY ("record_id") REFERENCES "public"."reflection_records"("record_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reflection_record_successors" ADD CONSTRAINT "reflection_record_successors_predecessor_record_id_reflection_records_record_id_fk" FOREIGN KEY ("predecessor_record_id") REFERENCES "public"."reflection_records"("record_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reflection_record_successors" ADD CONSTRAINT "reflection_record_successors_successor_record_id_reflection_records_record_id_fk" FOREIGN KEY ("successor_record_id") REFERENCES "public"."reflection_records"("record_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_reflection_record_dependencies_child" ON "reflection_record_dependencies" USING btree ("child_record_id","parent_record_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_reflection_record_payload_crypto_object" ON "reflection_record_payload_representations" USING btree ("crypto_object_id") WHERE "reflection_record_payload_representations"."crypto_object_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_reflection_record_publications_crypto_object" ON "reflection_record_publications" USING btree ("crypto_object_id") WHERE "reflection_record_publications"."crypto_object_id" is not null;--> statement-breakpoint
CREATE INDEX "idx_reflection_record_publications_reconcile" ON "reflection_record_publications" USING btree ("state","next_attempt_at","created_at");--> statement-breakpoint
CREATE INDEX "idx_reflection_record_publications_record" ON "reflection_record_publications" USING btree ("record_id","representation","representation_generation");--> statement-breakpoint
CREATE INDEX "idx_reflection_record_successors_successor" ON "reflection_record_successors" USING btree ("successor_record_id","predecessor_record_id");--> statement-breakpoint
CREATE INDEX "idx_reflection_records_lifecycle" ON "reflection_records" USING btree ("disposition","lifecycle","record_id");--> statement-breakpoint
CREATE POLICY "reflection_record_dependencies_product_all" ON "reflection_record_dependencies" AS PERMISSIVE FOR ALL TO "nautilo" USING (true) WITH CHECK (true);--> statement-breakpoint
CREATE POLICY "reflection_record_payload_representation_heads_product_all" ON "reflection_record_payload_representation_heads" AS PERMISSIVE FOR ALL TO "nautilo" USING (true) WITH CHECK (true);--> statement-breakpoint
CREATE POLICY "reflection_record_payload_representations_product_all" ON "reflection_record_payload_representations" AS PERMISSIVE FOR ALL TO "nautilo" USING (true) WITH CHECK (true);--> statement-breakpoint
CREATE POLICY "reflection_record_publications_product_all" ON "reflection_record_publications" AS PERMISSIVE FOR ALL TO "nautilo" USING (true) WITH CHECK (true);--> statement-breakpoint
CREATE POLICY "reflection_record_successors_product_all" ON "reflection_record_successors" AS PERMISSIVE FOR ALL TO "nautilo" USING (true) WITH CHECK (true);--> statement-breakpoint
CREATE POLICY "reflection_records_product_all" ON "reflection_records" AS PERMISSIVE FOR ALL TO "nautilo" USING (true) WITH CHECK (true);
--> statement-breakpoint
-- M257 REFLECTION RECORD SECURITY FINALIZER
ALTER TABLE "reflection_records" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "reflection_record_dependencies" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "reflection_record_successors" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "reflection_record_payload_representations" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "reflection_record_payload_representation_heads" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "reflection_record_publications" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
REVOKE ALL ON TABLE "reflection_records" FROM PUBLIC, "nautilo_agent", "nautilo_crypto";
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "reflection_records" TO "nautilo";
--> statement-breakpoint
REVOKE ALL ON TABLE "reflection_record_dependencies" FROM PUBLIC, "nautilo_agent", "nautilo_crypto";
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "reflection_record_dependencies" TO "nautilo";
--> statement-breakpoint
REVOKE ALL ON TABLE "reflection_record_successors" FROM PUBLIC, "nautilo_agent", "nautilo_crypto";
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "reflection_record_successors" TO "nautilo";
--> statement-breakpoint
REVOKE ALL ON TABLE "reflection_record_payload_representations" FROM PUBLIC, "nautilo_agent", "nautilo_crypto";
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "reflection_record_payload_representations" TO "nautilo";
--> statement-breakpoint
REVOKE ALL ON TABLE "reflection_record_payload_representation_heads" FROM PUBLIC, "nautilo_agent", "nautilo_crypto";
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "reflection_record_payload_representation_heads" TO "nautilo";
--> statement-breakpoint
REVOKE ALL ON TABLE "reflection_record_publications" FROM PUBLIC, "nautilo_agent", "nautilo_crypto";
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "reflection_record_publications" TO "nautilo";
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "public"."reflection_record_reject_immutable_change"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'Reflection Record graph/history rows are immutable';
END;
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "public"."reflection_record_guard_record_mutation"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Reflection Record identities cannot be deleted';
  END IF;

  IF OLD.record_id IS DISTINCT FROM NEW.record_id
     OR OLD.structural_height IS DISTINCT FROM NEW.structural_height
     OR OLD.producer_policy_version IS DISTINCT FROM NEW.producer_policy_version
     OR OLD.processing_generation IS DISTINCT FROM NEW.processing_generation
     OR OLD.payload_version IS DISTINCT FROM NEW.payload_version
     OR OLD.created_at IS DISTINCT FROM NEW.created_at THEN
    RAISE EXCEPTION 'Reflection Record semantic identity is immutable';
  END IF;

  IF OLD.lifecycle IS DISTINCT FROM NEW.lifecycle AND NOT (
    (OLD.lifecycle = 'current' AND NEW.lifecycle IN ('stale', 'superseded', 'resolved', 'sunset'))
    OR (OLD.lifecycle = 'stale' AND NEW.lifecycle IN ('current', 'superseded', 'resolved', 'sunset'))
  ) THEN
    RAISE EXCEPTION 'Invalid Reflection Record lifecycle transition';
  END IF;

  IF OLD.disposition IS DISTINCT FROM NEW.disposition AND NOT (
    (OLD.disposition = 'available' AND NEW.disposition IN ('blocked', 'purged'))
    OR (OLD.disposition = 'blocked' AND NEW.disposition = 'purged')
  ) THEN
    RAISE EXCEPTION 'Invalid Reflection Record disposition transition';
  END IF;

  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "reflection_records_mutation_guard"
BEFORE UPDATE OR DELETE ON "reflection_records"
FOR EACH ROW EXECUTE FUNCTION "public"."reflection_record_guard_record_mutation"();
--> statement-breakpoint
CREATE TRIGGER "reflection_record_dependencies_immutable"
BEFORE UPDATE OR DELETE ON "reflection_record_dependencies"
FOR EACH ROW EXECUTE FUNCTION "public"."reflection_record_reject_immutable_change"();
--> statement-breakpoint
CREATE TRIGGER "reflection_record_successors_immutable"
BEFORE UPDATE OR DELETE ON "reflection_record_successors"
FOR EACH ROW EXECUTE FUNCTION "public"."reflection_record_reject_immutable_change"();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "public"."reflection_record_guard_representation_mutation"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  current_disposition text;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'Reflection Record payload generations are immutable';
  END IF;
  SELECT disposition INTO current_disposition
    FROM reflection_records
   WHERE record_id = OLD.record_id;
  IF current_disposition IS DISTINCT FROM 'purged' THEN
    RAISE EXCEPTION 'Reflection Record payload can be removed only after purge';
  END IF;
  RETURN OLD;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "reflection_record_payload_representations_mutation_guard"
BEFORE UPDATE OR DELETE ON "reflection_record_payload_representations"
FOR EACH ROW EXECUTE FUNCTION "public"."reflection_record_guard_representation_mutation"();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "public"."reflection_record_guard_head_mutation"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  current_disposition text;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF OLD.record_id IS DISTINCT FROM NEW.record_id
       OR OLD.representation IS DISTINCT FROM NEW.representation
       OR OLD.current_representation_generation >= NEW.current_representation_generation THEN
      RAISE EXCEPTION 'Reflection Record representation head must advance by CAS';
    END IF;
    RETURN NEW;
  END IF;
  SELECT disposition INTO current_disposition
    FROM reflection_records
   WHERE record_id = OLD.record_id;
  IF current_disposition IS DISTINCT FROM 'purged' THEN
    RAISE EXCEPTION 'Reflection Record representation head can be removed only after purge';
  END IF;
  RETURN OLD;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "reflection_record_payload_heads_mutation_guard"
BEFORE UPDATE OR DELETE ON "reflection_record_payload_representation_heads"
FOR EACH ROW EXECUTE FUNCTION "public"."reflection_record_guard_head_mutation"();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "public"."reflection_record_guard_publication_mutation"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Reflection Record publication receipts cannot be deleted';
  END IF;
  IF OLD.publication_id IS DISTINCT FROM NEW.publication_id
     OR OLD.record_id IS DISTINCT FROM NEW.record_id
     OR OLD.representation IS DISTINCT FROM NEW.representation
     OR OLD.representation_generation IS DISTINCT FROM NEW.representation_generation
     OR OLD.payload_version IS DISTINCT FROM NEW.payload_version
     OR OLD.request_commitment IS DISTINCT FROM NEW.request_commitment
     OR OLD.publication_binding_ref IS DISTINCT FROM NEW.publication_binding_ref
     OR OLD.created_at IS DISTINCT FROM NEW.created_at THEN
    RAISE EXCEPTION 'Reflection Record publication identity is immutable';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "reflection_record_publications_mutation_guard"
BEFORE UPDATE OR DELETE ON "reflection_record_publications"
FOR EACH ROW EXECUTE FUNCTION "public"."reflection_record_guard_publication_mutation"();
