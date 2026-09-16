CREATE TABLE "reflection_record_authority_alternatives" (
	"record_id" text NOT NULL,
	"projection_generation" integer NOT NULL,
	"alternative_ordinal" smallint NOT NULL,
	"access_namespace_id" uuid NOT NULL,
	"includes_public_boundary" boolean DEFAULT false NOT NULL,
	"alternative_commitment" "bytea" NOT NULL,
	CONSTRAINT "reflection_record_authority_alternatives_record_id_projection_generation_alternative_ordinal_pk" PRIMARY KEY("record_id","projection_generation","alternative_ordinal"),
	CONSTRAINT "uq_reflection_record_authority_alternative_namespace_public" UNIQUE("record_id","projection_generation","access_namespace_id","includes_public_boundary"),
	CONSTRAINT "reflection_record_authority_alternative_ordinal_bound" CHECK ("reflection_record_authority_alternatives"."alternative_ordinal" between 0 and 255),
	CONSTRAINT "reflection_record_authority_alternative_commitment_size" CHECK (octet_length("reflection_record_authority_alternatives"."alternative_commitment") = 32)
);
--> statement-breakpoint
ALTER TABLE "reflection_record_authority_alternatives" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "reflection_record_authority_blocks" (
	"block_id" text PRIMARY KEY NOT NULL,
	"record_id" text,
	"terminal_leaf_handle" text,
	"disposition" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "reflection_record_authority_blocks_id_portable" CHECK (octet_length("reflection_record_authority_blocks"."block_id") between 1 and 128
      and "reflection_record_authority_blocks"."block_id" ~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]*$'),
	CONSTRAINT "reflection_record_authority_blocks_leaf_portable" CHECK (octet_length("reflection_record_authority_blocks"."terminal_leaf_handle") between 1 and 128
      and "reflection_record_authority_blocks"."terminal_leaf_handle" ~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]*$'),
	CONSTRAINT "reflection_record_authority_blocks_exact_target" CHECK (("reflection_record_authority_blocks"."record_id" is null) <> ("reflection_record_authority_blocks"."terminal_leaf_handle" is null)),
	CONSTRAINT "reflection_record_authority_blocks_disposition_closed" CHECK ("reflection_record_authority_blocks"."disposition" in ('blocked', 'purged'))
);
--> statement-breakpoint
ALTER TABLE "reflection_record_authority_blocks" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "reflection_record_authority_changes" (
	"change_id" text PRIMARY KEY NOT NULL,
	"terminal_leaf_handle" text NOT NULL,
	"source_change_generation" integer NOT NULL,
	"admitted_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uq_reflection_record_authority_change_leaf_generation" UNIQUE("terminal_leaf_handle","source_change_generation"),
	CONSTRAINT "reflection_record_authority_changes_id_portable" CHECK (octet_length("reflection_record_authority_changes"."change_id") between 1 and 128
      and "reflection_record_authority_changes"."change_id" ~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]*$'),
	CONSTRAINT "reflection_record_authority_changes_leaf_portable" CHECK (octet_length("reflection_record_authority_changes"."terminal_leaf_handle") between 1 and 128
      and "reflection_record_authority_changes"."terminal_leaf_handle" ~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]*$'),
	CONSTRAINT "reflection_record_authority_change_generation_positive" CHECK ("reflection_record_authority_changes"."source_change_generation" > 0)
);
--> statement-breakpoint
ALTER TABLE "reflection_record_authority_changes" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "reflection_record_authority_closure" (
	"record_id" text NOT NULL,
	"terminal_leaf_handle" text NOT NULL,
	"closure_generation" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "reflection_record_authority_closure_record_id_closure_generation_terminal_leaf_handle_pk" PRIMARY KEY("record_id","closure_generation","terminal_leaf_handle"),
	CONSTRAINT "reflection_record_authority_closure_leaf_portable" CHECK (octet_length("reflection_record_authority_closure"."terminal_leaf_handle") between 1 and 128
      and "reflection_record_authority_closure"."terminal_leaf_handle" ~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]*$'),
	CONSTRAINT "reflection_record_authority_closure_generation_positive" CHECK ("reflection_record_authority_closure"."closure_generation" > 0)
);
--> statement-breakpoint
ALTER TABLE "reflection_record_authority_closure" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "reflection_record_authority_projections" (
	"record_id" text NOT NULL,
	"projection_generation" integer NOT NULL,
	"source_change_generation" integer NOT NULL,
	"processing_state" text NOT NULL,
	"unavailable_reason" text,
	"audience_set_commitment" "bytea",
	"current" boolean DEFAULT false NOT NULL,
	"computed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"dirty_since" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "reflection_record_authority_projections_record_id_projection_generation_pk" PRIMARY KEY("record_id","projection_generation"),
	CONSTRAINT "reflection_record_authority_projection_generation_positive" CHECK ("reflection_record_authority_projections"."projection_generation" > 0 and "reflection_record_authority_projections"."source_change_generation" > 0),
	CONSTRAINT "reflection_record_authority_projection_state_closed" CHECK ("reflection_record_authority_projections"."processing_state" in ('current', 'dirty', 'reconciling', 'unavailable', 'purged')),
	CONSTRAINT "reflection_record_authority_projection_unavailable_coherent" CHECK ((
        "reflection_record_authority_projections"."processing_state" = 'unavailable'
        and "reflection_record_authority_projections"."unavailable_reason" is not null
      ) or (
        "reflection_record_authority_projections"."processing_state" <> 'unavailable'
        and "reflection_record_authority_projections"."unavailable_reason" is null
      )),
	CONSTRAINT "reflection_record_authority_projection_commitment_size" CHECK ("reflection_record_authority_projections"."audience_set_commitment" is null or octet_length("reflection_record_authority_projections"."audience_set_commitment") = 32),
	CONSTRAINT "reflection_record_authority_projection_dirty_time_coherent" CHECK (("reflection_record_authority_projections"."processing_state" in ('dirty', 'reconciling')) = ("reflection_record_authority_projections"."dirty_since" is not null))
);
--> statement-breakpoint
ALTER TABLE "reflection_record_authority_projections" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "reflection_record_authority_reconciliations" (
	"reconciliation_id" text PRIMARY KEY NOT NULL,
	"record_id" text NOT NULL,
	"expected_projection_generation" integer NOT NULL,
	"source_change_generation" integer NOT NULL,
	"state" text NOT NULL,
	"sealed_checkpoint" "bytea",
	"attempt_count" smallint DEFAULT 0 NOT NULL,
	"lease_token" uuid,
	"lease_expires_at" timestamp with time zone,
	"next_attempt_at" timestamp with time zone,
	"failure_code" text,
	"target_representation_generation" integer,
	"target_crypto_object_id" text,
	"former_crypto_object_id" text,
	"former_crypto_retired_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	CONSTRAINT "uq_reflection_record_authority_reconciliation_generation" UNIQUE("record_id","source_change_generation"),
	CONSTRAINT "reflection_record_authority_reconciliations_id_portable" CHECK (octet_length("reflection_record_authority_reconciliations"."reconciliation_id") between 1 and 128
      and "reflection_record_authority_reconciliations"."reconciliation_id" ~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]*$'),
	CONSTRAINT "reflection_record_authority_reconciliations_crypto_object_portable" CHECK (octet_length("reflection_record_authority_reconciliations"."target_crypto_object_id") between 1 and 128
      and "reflection_record_authority_reconciliations"."target_crypto_object_id" ~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]*$'),
	CONSTRAINT "reflection_record_authority_reconciliations_former_crypto_object_portable" CHECK (octet_length("reflection_record_authority_reconciliations"."former_crypto_object_id") between 1 and 128
      and "reflection_record_authority_reconciliations"."former_crypto_object_id" ~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]*$'),
	CONSTRAINT "reflection_record_authority_reconciliation_generations_positive" CHECK ("reflection_record_authority_reconciliations"."expected_projection_generation" >= 0 and "reflection_record_authority_reconciliations"."source_change_generation" > 0
        and ("reflection_record_authority_reconciliations"."target_representation_generation" is null or "reflection_record_authority_reconciliations"."target_representation_generation" > 0)),
	CONSTRAINT "reflection_record_authority_reconciliation_state_closed" CHECK ("reflection_record_authority_reconciliations"."state" in ('pending', 'leased', 'crypto_complete', 'attached', 'complete', 'quarantined')),
	CONSTRAINT "reflection_record_authority_reconciliation_attempt_bound" CHECK ("reflection_record_authority_reconciliations"."attempt_count" between 0 and 8),
	CONSTRAINT "reflection_record_authority_reconciliation_lease_coherent" CHECK (("reflection_record_authority_reconciliations"."lease_token" is null) = ("reflection_record_authority_reconciliations"."lease_expires_at" is null)
        and ("reflection_record_authority_reconciliations"."state" = 'leased') = ("reflection_record_authority_reconciliations"."lease_token" is not null)),
	CONSTRAINT "reflection_record_authority_reconciliation_checkpoint_bound" CHECK ("reflection_record_authority_reconciliations"."sealed_checkpoint" is null or octet_length("reflection_record_authority_reconciliations"."sealed_checkpoint") between 1 and 262144),
	CONSTRAINT "reflection_record_authority_reconciliation_failure_code_closed" CHECK ("reflection_record_authority_reconciliations"."failure_code" is null or (
        octet_length("reflection_record_authority_reconciliations"."failure_code") between 1 and 64
        and "reflection_record_authority_reconciliations"."failure_code" in (
          'authorization_unavailable', 'integrity_failure', 'mapping_conflict',
          'source_unavailable', 'storage_transient'
        )
      )),
	CONSTRAINT "reflection_record_authority_reconciliation_completion_coherent" CHECK (("reflection_record_authority_reconciliations"."state" = 'complete') = ("reflection_record_authority_reconciliations"."completed_at" is not null)),
	CONSTRAINT "reflection_record_authority_reconciliation_crypto_coherent" CHECK ((
        "reflection_record_authority_reconciliations"."target_crypto_object_id" is null
        and "reflection_record_authority_reconciliations"."target_representation_generation" is null
      ) or (
        "reflection_record_authority_reconciliations"."target_crypto_object_id" is not null
        and "reflection_record_authority_reconciliations"."target_representation_generation" is not null
      )),
	CONSTRAINT "reflection_record_authority_reconciliation_retirement_coherent" CHECK ("reflection_record_authority_reconciliations"."former_crypto_retired_at" is null or "reflection_record_authority_reconciliations"."former_crypto_object_id" is not null)
);
--> statement-breakpoint
ALTER TABLE "reflection_record_authority_reconciliations" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "reflection_record_authority_alternatives" ADD CONSTRAINT "reflection_record_authority_alternatives_projection_fk" FOREIGN KEY ("record_id","projection_generation") REFERENCES "public"."reflection_record_authority_projections"("record_id","projection_generation") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reflection_record_authority_blocks" ADD CONSTRAINT "reflection_record_authority_blocks_record_id_reflection_records_record_id_fk" FOREIGN KEY ("record_id") REFERENCES "public"."reflection_records"("record_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reflection_record_authority_closure" ADD CONSTRAINT "reflection_record_authority_closure_record_id_reflection_records_record_id_fk" FOREIGN KEY ("record_id") REFERENCES "public"."reflection_records"("record_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reflection_record_authority_projections" ADD CONSTRAINT "reflection_record_authority_projections_record_id_reflection_records_record_id_fk" FOREIGN KEY ("record_id") REFERENCES "public"."reflection_records"("record_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reflection_record_authority_reconciliations" ADD CONSTRAINT "reflection_record_authority_reconciliations_record_id_reflection_records_record_id_fk" FOREIGN KEY ("record_id") REFERENCES "public"."reflection_records"("record_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_reflection_record_authority_alternative_eligibility" ON "reflection_record_authority_alternatives" USING btree ("access_namespace_id","includes_public_boundary","record_id","projection_generation","alternative_ordinal");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_reflection_record_authority_blocks_record" ON "reflection_record_authority_blocks" USING btree ("record_id") WHERE "reflection_record_authority_blocks"."record_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_reflection_record_authority_blocks_leaf" ON "reflection_record_authority_blocks" USING btree ("terminal_leaf_handle") WHERE "reflection_record_authority_blocks"."terminal_leaf_handle" is not null;--> statement-breakpoint
CREATE INDEX "idx_reflection_record_authority_blocks_leaf_lookup" ON "reflection_record_authority_blocks" USING btree ("terminal_leaf_handle","disposition");--> statement-breakpoint
CREATE INDEX "idx_reflection_record_authority_changes_leaf" ON "reflection_record_authority_changes" USING btree ("terminal_leaf_handle","source_change_generation");--> statement-breakpoint
CREATE INDEX "idx_reflection_record_authority_closure_reverse" ON "reflection_record_authority_closure" USING btree ("terminal_leaf_handle","record_id","closure_generation");--> statement-breakpoint
CREATE INDEX "idx_reflection_record_authority_closure_record" ON "reflection_record_authority_closure" USING btree ("record_id","closure_generation","terminal_leaf_handle");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_reflection_record_authority_projection_current" ON "reflection_record_authority_projections" USING btree ("record_id") WHERE "reflection_record_authority_projections"."current" = true;--> statement-breakpoint
CREATE INDEX "idx_reflection_record_authority_projection_health" ON "reflection_record_authority_projections" USING btree ("current","processing_state","dirty_since","record_id");--> statement-breakpoint
CREATE INDEX "idx_reflection_record_authority_reconciliation_due" ON "reflection_record_authority_reconciliations" USING btree ("state","next_attempt_at","created_at","reconciliation_id");--> statement-breakpoint
CREATE INDEX "idx_reflection_record_authority_reconciliation_record" ON "reflection_record_authority_reconciliations" USING btree ("record_id","source_change_generation");--> statement-breakpoint
CREATE POLICY "reflection_record_authority_alternatives_product_all" ON "reflection_record_authority_alternatives" AS PERMISSIVE FOR ALL TO "nautilo" USING (true) WITH CHECK (true);--> statement-breakpoint
CREATE POLICY "reflection_record_authority_blocks_product_all" ON "reflection_record_authority_blocks" AS PERMISSIVE FOR ALL TO "nautilo" USING (true) WITH CHECK (true);--> statement-breakpoint
CREATE POLICY "reflection_record_authority_changes_product_all" ON "reflection_record_authority_changes" AS PERMISSIVE FOR ALL TO "nautilo" USING (true) WITH CHECK (true);--> statement-breakpoint
CREATE POLICY "reflection_record_authority_closure_product_all" ON "reflection_record_authority_closure" AS PERMISSIVE FOR ALL TO "nautilo" USING (true) WITH CHECK (true);--> statement-breakpoint
CREATE POLICY "reflection_record_authority_projections_product_all" ON "reflection_record_authority_projections" AS PERMISSIVE FOR ALL TO "nautilo" USING (true) WITH CHECK (true);--> statement-breakpoint
CREATE POLICY "reflection_record_authority_reconciliations_product_all" ON "reflection_record_authority_reconciliations" AS PERMISSIVE FOR ALL TO "nautilo" USING (true) WITH CHECK (true);
--> statement-breakpoint
-- M258 REFLECTION AUTHORITY SECURITY FINALIZER
ALTER TABLE "reflection_record_authority_closure" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
REVOKE ALL ON TABLE "reflection_record_authority_closure" FROM PUBLIC, "nautilo_agent", "nautilo_crypto";
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "reflection_record_authority_closure" TO "nautilo";
--> statement-breakpoint
ALTER TABLE "reflection_record_authority_projections" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
REVOKE ALL ON TABLE "reflection_record_authority_projections" FROM PUBLIC, "nautilo_agent", "nautilo_crypto";
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "reflection_record_authority_projections" TO "nautilo";
--> statement-breakpoint
ALTER TABLE "reflection_record_authority_alternatives" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
REVOKE ALL ON TABLE "reflection_record_authority_alternatives" FROM PUBLIC, "nautilo_agent", "nautilo_crypto";
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "reflection_record_authority_alternatives" TO "nautilo";
--> statement-breakpoint
ALTER TABLE "reflection_record_authority_changes" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
REVOKE ALL ON TABLE "reflection_record_authority_changes" FROM PUBLIC, "nautilo_agent", "nautilo_crypto";
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "reflection_record_authority_changes" TO "nautilo";
--> statement-breakpoint
ALTER TABLE "reflection_record_authority_reconciliations" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
REVOKE ALL ON TABLE "reflection_record_authority_reconciliations" FROM PUBLIC, "nautilo_agent", "nautilo_crypto";
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "reflection_record_authority_reconciliations" TO "nautilo";
--> statement-breakpoint
ALTER TABLE "reflection_record_authority_blocks" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
REVOKE ALL ON TABLE "reflection_record_authority_blocks" FROM PUBLIC, "nautilo_agent", "nautilo_crypto";
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "reflection_record_authority_blocks" TO "nautilo";
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "public"."reflection_authority_reject_immutable_change"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'Reflection authority immutable fact cannot change';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "reflection_record_authority_closure_immutable"
BEFORE UPDATE OR DELETE ON "reflection_record_authority_closure"
FOR EACH ROW EXECUTE FUNCTION "public"."reflection_authority_reject_immutable_change"();
--> statement-breakpoint
CREATE TRIGGER "reflection_record_authority_alternatives_immutable"
BEFORE UPDATE OR DELETE ON "reflection_record_authority_alternatives"
FOR EACH ROW EXECUTE FUNCTION "public"."reflection_authority_reject_immutable_change"();
--> statement-breakpoint
CREATE TRIGGER "reflection_record_authority_changes_immutable"
BEFORE UPDATE OR DELETE ON "reflection_record_authority_changes"
FOR EACH ROW EXECUTE FUNCTION "public"."reflection_authority_reject_immutable_change"();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "public"."reflection_authority_guard_block_mutation"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Reflection authority blocks cannot be deleted';
  END IF;
  IF OLD.block_id IS DISTINCT FROM NEW.block_id
     OR OLD.record_id IS DISTINCT FROM NEW.record_id
     OR OLD.terminal_leaf_handle IS DISTINCT FROM NEW.terminal_leaf_handle
     OR OLD.created_at IS DISTINCT FROM NEW.created_at
     OR (OLD.disposition, NEW.disposition) IS DISTINCT FROM ('blocked', 'purged') THEN
    RAISE EXCEPTION 'Invalid Reflection authority block transition';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "reflection_record_authority_blocks_mutation_guard"
BEFORE UPDATE OR DELETE ON "reflection_record_authority_blocks"
FOR EACH ROW EXECUTE FUNCTION "public"."reflection_authority_guard_block_mutation"();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "public"."reflection_authority_guard_projection_mutation"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Reflection authority projection generations cannot be deleted';
  END IF;
  IF OLD.record_id IS DISTINCT FROM NEW.record_id
     OR OLD.projection_generation IS DISTINCT FROM NEW.projection_generation
     OR OLD.source_change_generation IS DISTINCT FROM NEW.source_change_generation
     OR OLD.audience_set_commitment IS DISTINCT FROM NEW.audience_set_commitment
     OR OLD.computed_at IS DISTINCT FROM NEW.computed_at THEN
    RAISE EXCEPTION 'Reflection authority projection identity is immutable';
  END IF;
  IF OLD.current = false AND NEW.current = true THEN
    RAISE EXCEPTION 'Retired Reflection authority projection cannot become current';
  END IF;
  IF NEW.updated_at < OLD.updated_at THEN
    RAISE EXCEPTION 'Reflection authority projection time cannot move backward';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "reflection_record_authority_projections_mutation_guard"
BEFORE UPDATE OR DELETE ON "reflection_record_authority_projections"
FOR EACH ROW EXECUTE FUNCTION "public"."reflection_authority_guard_projection_mutation"();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "public"."reflection_authority_guard_reconciliation_mutation"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Reflection authority reconciliation receipts cannot be deleted';
  END IF;
  IF OLD.reconciliation_id IS DISTINCT FROM NEW.reconciliation_id
     OR OLD.record_id IS DISTINCT FROM NEW.record_id
     OR OLD.expected_projection_generation IS DISTINCT FROM NEW.expected_projection_generation
     OR OLD.source_change_generation IS DISTINCT FROM NEW.source_change_generation
     OR OLD.created_at IS DISTINCT FROM NEW.created_at THEN
    RAISE EXCEPTION 'Reflection authority reconciliation identity is immutable';
  END IF;
  IF OLD.state = 'complete' AND NOT (
    NEW.state = 'complete'
    AND OLD.former_crypto_object_id IS NOT NULL
    AND OLD.former_crypto_retired_at IS NULL
    AND NEW.former_crypto_retired_at IS NOT NULL
    AND OLD.sealed_checkpoint IS NOT DISTINCT FROM NEW.sealed_checkpoint
    AND OLD.attempt_count IS NOT DISTINCT FROM NEW.attempt_count
    AND OLD.lease_token IS NOT DISTINCT FROM NEW.lease_token
    AND OLD.lease_expires_at IS NOT DISTINCT FROM NEW.lease_expires_at
    AND OLD.next_attempt_at IS NOT DISTINCT FROM NEW.next_attempt_at
    AND OLD.failure_code IS NOT DISTINCT FROM NEW.failure_code
    AND OLD.target_representation_generation IS NOT DISTINCT FROM NEW.target_representation_generation
    AND OLD.target_crypto_object_id IS NOT DISTINCT FROM NEW.target_crypto_object_id
    AND OLD.former_crypto_object_id IS NOT DISTINCT FROM NEW.former_crypto_object_id
    AND OLD.completed_at IS NOT DISTINCT FROM NEW.completed_at
  ) THEN
    RAISE EXCEPTION 'Completed Reflection authority reconciliation is immutable except retirement acknowledgement';
  END IF;
  IF OLD.state IS DISTINCT FROM NEW.state AND NOT (
    (OLD.state = 'pending' AND NEW.state IN ('leased', 'crypto_complete', 'complete', 'quarantined'))
    OR (OLD.state = 'leased' AND NEW.state IN ('pending', 'crypto_complete', 'complete', 'quarantined'))
    OR (OLD.state = 'crypto_complete' AND NEW.state IN ('attached', 'complete', 'quarantined'))
    OR (OLD.state = 'attached' AND NEW.state IN ('complete', 'quarantined'))
    OR (OLD.state = 'quarantined' AND NEW.state = 'pending')
  ) THEN
    RAISE EXCEPTION 'Invalid Reflection authority reconciliation state transition';
  END IF;
  IF NEW.attempt_count < OLD.attempt_count
     OR NEW.attempt_count > OLD.attempt_count + 1 THEN
    RAISE EXCEPTION 'Invalid Reflection authority reconciliation attempt transition';
  END IF;
  IF OLD.target_crypto_object_id IS NOT NULL
     AND OLD.target_crypto_object_id IS DISTINCT FROM NEW.target_crypto_object_id THEN
    RAISE EXCEPTION 'Reflection authority target crypto identity is immutable';
  END IF;
  IF OLD.former_crypto_object_id IS NOT NULL
     AND OLD.former_crypto_object_id IS DISTINCT FROM NEW.former_crypto_object_id THEN
    RAISE EXCEPTION 'Reflection authority former crypto identity is immutable';
  END IF;
  IF OLD.former_crypto_retired_at IS NOT NULL
     AND OLD.former_crypto_retired_at IS DISTINCT FROM NEW.former_crypto_retired_at THEN
    RAISE EXCEPTION 'Reflection authority former crypto retirement is immutable';
  END IF;
  IF NEW.updated_at < OLD.updated_at THEN
    RAISE EXCEPTION 'Reflection authority reconciliation time cannot move backward';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "reflection_record_authority_reconciliations_mutation_guard"
BEFORE UPDATE OR DELETE ON "reflection_record_authority_reconciliations"
FOR EACH ROW EXECUTE FUNCTION "public"."reflection_authority_guard_reconciliation_mutation"();
