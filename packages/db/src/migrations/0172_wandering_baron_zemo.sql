CREATE TABLE "reflection_record_semantic_work" (
	"record_id" text PRIMARY KEY NOT NULL,
	"generation" integer NOT NULL,
	"completed_generation" integer DEFAULT 0 NOT NULL,
	"change_reason" text NOT NULL,
	"stage" text NOT NULL,
	"state" text NOT NULL,
	"claim_generation" integer,
	"attempt_count" smallint DEFAULT 0 NOT NULL,
	"lease_token" uuid,
	"lease_expires_at" timestamp with time zone,
	"next_attempt_at" timestamp with time zone,
	"failure_code" text,
	"due_since" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "reflection_record_semantic_work_generations_coherent" CHECK ("reflection_record_semantic_work"."generation" > 0
        and "reflection_record_semantic_work"."completed_generation" >= 0
        and "reflection_record_semantic_work"."completed_generation" <= "reflection_record_semantic_work"."generation"
        and ("reflection_record_semantic_work"."claim_generation" is null or "reflection_record_semantic_work"."claim_generation" > 0)),
	CONSTRAINT "reflection_record_semantic_work_reason_closed" CHECK ("reflection_record_semantic_work"."change_reason" in ('created', 'revised', 'dependency_lost')),
	CONSTRAINT "reflection_record_semantic_work_stage_closed" CHECK ("reflection_record_semantic_work"."stage" in ('authority_projection', 'search_projection', 'organization')),
	CONSTRAINT "reflection_record_semantic_work_state_closed" CHECK ("reflection_record_semantic_work"."state" in (
        'due', 'claimed', 'checkpointed', 'deferred', 'complete', 'quarantined'
      )),
	CONSTRAINT "reflection_record_semantic_work_attempt_bound" CHECK ("reflection_record_semantic_work"."attempt_count" between 0 and 8),
	CONSTRAINT "reflection_record_semantic_work_claim_coherent" CHECK ((
        "reflection_record_semantic_work"."state" = 'claimed'
        and "reflection_record_semantic_work"."claim_generation" = "reflection_record_semantic_work"."generation"
        and "reflection_record_semantic_work"."lease_token" is not null
        and "reflection_record_semantic_work"."lease_expires_at" is not null
      ) or (
        "reflection_record_semantic_work"."state" <> 'claimed'
        and "reflection_record_semantic_work"."claim_generation" is null
        and "reflection_record_semantic_work"."lease_token" is null
        and "reflection_record_semantic_work"."lease_expires_at" is null
      )),
	CONSTRAINT "reflection_record_semantic_work_schedule_coherent" CHECK (("reflection_record_semantic_work"."state" in ('due', 'checkpointed', 'deferred'))
        = ("reflection_record_semantic_work"."next_attempt_at" is not null)),
	CONSTRAINT "reflection_record_semantic_work_failure_coherent" CHECK (("reflection_record_semantic_work"."state" in ('deferred', 'quarantined'))
        = ("reflection_record_semantic_work"."failure_code" is not null)),
	CONSTRAINT "reflection_record_semantic_work_failure_code_bound" CHECK ("reflection_record_semantic_work"."failure_code" is null or (
        octet_length("reflection_record_semantic_work"."failure_code") between 1 and 64
        and "reflection_record_semantic_work"."failure_code" in (
          'authority_unavailable', 'record_unavailable',
          'embedding_unavailable', 'projection_unavailable',
          'candidate_unavailable', 'invalid_model_output',
          'publication_unavailable', 'unexpected_failure',
          'retry_exhausted'
        )
      )),
	CONSTRAINT "reflection_record_semantic_work_completion_coherent" CHECK ((
        "reflection_record_semantic_work"."state" = 'complete'
        and "reflection_record_semantic_work"."stage" = 'organization'
        and "reflection_record_semantic_work"."completed_generation" = "reflection_record_semantic_work"."generation"
        and "reflection_record_semantic_work"."completed_at" is not null
      ) or (
        "reflection_record_semantic_work"."state" <> 'complete'
        and "reflection_record_semantic_work"."completed_at" is null
      )),
	CONSTRAINT "reflection_record_semantic_work_checkpoint_coherent" CHECK ("reflection_record_semantic_work"."state" <> 'checkpointed'
        or "reflection_record_semantic_work"."stage" in ('search_projection', 'organization')),
	CONSTRAINT "reflection_record_semantic_work_due_starts_authority" CHECK ("reflection_record_semantic_work"."state" <> 'due' or "reflection_record_semantic_work"."stage" = 'authority_projection')
);
--> statement-breakpoint
ALTER TABLE "reflection_record_semantic_work" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "reflection_record_semantic_work_admissions" (
	"record_id" text NOT NULL,
	"admission_commitment" "bytea" NOT NULL,
	"assigned_generation" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "reflection_record_semantic_work_admissions_record_id_admission_commitment_pk" PRIMARY KEY("record_id","admission_commitment"),
	CONSTRAINT "uq_reflection_semantic_work_admission_generation" UNIQUE("record_id","assigned_generation"),
	CONSTRAINT "reflection_semantic_work_admission_commitment_size" CHECK (octet_length("reflection_record_semantic_work_admissions"."admission_commitment") = 32),
	CONSTRAINT "reflection_semantic_work_admission_generation_positive" CHECK ("reflection_record_semantic_work_admissions"."assigned_generation" > 0)
);
--> statement-breakpoint
ALTER TABLE "reflection_record_semantic_work_admissions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "reflection_record_source_change_repairs" (
	"source_change_commitment" "bytea" PRIMARY KEY NOT NULL,
	"source_dependency_commitment" "bytea" NOT NULL,
	"continuation" text,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "reflection_source_change_repair_commitment_sizes" CHECK (octet_length("reflection_record_source_change_repairs"."source_change_commitment") = 32
        and octet_length("reflection_record_source_change_repairs"."source_dependency_commitment") = 32),
	CONSTRAINT "reflection_source_change_repair_continuation_bound" CHECK ("reflection_record_source_change_repairs"."continuation" is null or (
        octet_length("reflection_record_source_change_repairs"."continuation") between 1 and 128
        and "reflection_record_source_change_repairs"."continuation" ~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]*$'
      )),
	CONSTRAINT "reflection_source_change_repair_completion_coherent" CHECK ("reflection_record_source_change_repairs"."completed_at" is null or "reflection_record_source_change_repairs"."updated_at" = "reflection_record_source_change_repairs"."completed_at")
);
--> statement-breakpoint
ALTER TABLE "reflection_record_source_change_repairs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "reflection_record_source_dependency_index" (
	"source_dependency_commitment" "bytea" NOT NULL,
	"record_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "reflection_record_source_dependency_index_source_dependency_commitment_record_id_pk" PRIMARY KEY("source_dependency_commitment","record_id"),
	CONSTRAINT "reflection_record_source_dependency_commitment_size" CHECK (octet_length("reflection_record_source_dependency_index"."source_dependency_commitment") = 32)
);
--> statement-breakpoint
ALTER TABLE "reflection_record_source_dependency_index" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "reflection_record_semantic_work" ADD CONSTRAINT "reflection_record_semantic_work_record_id_reflection_records_record_id_fk" FOREIGN KEY ("record_id") REFERENCES "public"."reflection_records"("record_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reflection_record_semantic_work_admissions" ADD CONSTRAINT "reflection_record_semantic_work_admissions_record_id_reflection_records_record_id_fk" FOREIGN KEY ("record_id") REFERENCES "public"."reflection_records"("record_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reflection_record_source_dependency_index" ADD CONSTRAINT "reflection_record_source_dependency_index_record_id_reflection_records_record_id_fk" FOREIGN KEY ("record_id") REFERENCES "public"."reflection_records"("record_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_reflection_record_semantic_work_due" ON "reflection_record_semantic_work" USING btree ("state","next_attempt_at","due_since","record_id");--> statement-breakpoint
CREATE INDEX "idx_reflection_record_semantic_work_lease" ON "reflection_record_semantic_work" USING btree ("state","lease_expires_at","record_id");--> statement-breakpoint
CREATE INDEX "idx_reflection_record_semantic_work_health" ON "reflection_record_semantic_work" USING btree ("state","attempt_count","due_since");--> statement-breakpoint
CREATE INDEX "idx_reflection_source_change_repairs_due" ON "reflection_record_source_change_repairs" USING btree ("completed_at","created_at","source_change_commitment");--> statement-breakpoint
CREATE INDEX "idx_reflection_record_source_dependency_record" ON "reflection_record_source_dependency_index" USING btree ("record_id","source_dependency_commitment");--> statement-breakpoint
CREATE POLICY "reflection_record_semantic_work_product_all" ON "reflection_record_semantic_work" AS PERMISSIVE FOR ALL TO "nautilo" USING (true) WITH CHECK (true);--> statement-breakpoint
CREATE POLICY "reflection_record_semantic_work_admissions_product_all" ON "reflection_record_semantic_work_admissions" AS PERMISSIVE FOR ALL TO "nautilo" USING (true) WITH CHECK (true);--> statement-breakpoint
CREATE POLICY "reflection_record_source_change_repairs_product_all" ON "reflection_record_source_change_repairs" AS PERMISSIVE FOR ALL TO "nautilo" USING (true) WITH CHECK (true);--> statement-breakpoint
CREATE POLICY "reflection_record_source_dependency_index_product_all" ON "reflection_record_source_dependency_index" AS PERMISSIVE FOR ALL TO "nautilo" USING (true) WITH CHECK (true);
--> statement-breakpoint
-- M271 REFLECTION SEMANTIC WORK SECURITY FINALIZER
ALTER TABLE "reflection_record_source_dependency_index" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "reflection_record_semantic_work_admissions" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "reflection_record_source_change_repairs" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "reflection_record_semantic_work" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
REVOKE ALL ON TABLE "reflection_record_source_dependency_index" FROM PUBLIC, "nautilo_agent", "nautilo_crypto";
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "reflection_record_source_dependency_index" TO "nautilo";
--> statement-breakpoint
REVOKE ALL ON TABLE "reflection_record_semantic_work_admissions" FROM PUBLIC, "nautilo_agent", "nautilo_crypto";
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "reflection_record_semantic_work_admissions" TO "nautilo";
--> statement-breakpoint
REVOKE ALL ON TABLE "reflection_record_source_change_repairs" FROM PUBLIC, "nautilo_agent", "nautilo_crypto";
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON TABLE "reflection_record_source_change_repairs" TO "nautilo";
--> statement-breakpoint
REVOKE ALL ON TABLE "reflection_record_semantic_work" FROM PUBLIC, "nautilo_agent", "nautilo_crypto";
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "reflection_record_semantic_work" TO "nautilo";
--> statement-breakpoint
CREATE FUNCTION "public"."reflection_semantic_receipt_reject_change"()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog AS $$
BEGIN
  RAISE EXCEPTION 'Reflection semantic index and admission receipts are immutable'
    USING ERRCODE = '23514';
END;
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION "public"."reflection_semantic_receipt_reject_change"()
  FROM PUBLIC, "nautilo_agent", "nautilo_crypto";--> statement-breakpoint
GRANT EXECUTE ON FUNCTION "public"."reflection_semantic_receipt_reject_change"()
  TO "nautilo";--> statement-breakpoint
CREATE TRIGGER "reflection_record_source_dependency_index_immutable"
BEFORE UPDATE OR DELETE ON "reflection_record_source_dependency_index"
FOR EACH ROW EXECUTE FUNCTION "public"."reflection_semantic_receipt_reject_change"();--> statement-breakpoint
CREATE TRIGGER "reflection_record_semantic_work_admissions_immutable"
BEFORE UPDATE OR DELETE ON "reflection_record_semantic_work_admissions"
FOR EACH ROW EXECUTE FUNCTION "public"."reflection_semantic_receipt_reject_change"();--> statement-breakpoint
CREATE FUNCTION "public"."reflection_source_change_repair_guard_update"()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog AS $$
BEGIN
  IF NEW.source_change_commitment IS DISTINCT FROM OLD.source_change_commitment
     OR NEW.source_dependency_commitment IS DISTINCT FROM OLD.source_dependency_commitment
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR NEW.updated_at < OLD.updated_at
     OR OLD.completed_at IS NOT NULL
     OR (NEW.completed_at IS NULL AND OLD.continuation IS NOT NULL AND (
       NEW.continuation IS NULL OR NEW.continuation <= OLD.continuation
     )) THEN
    RAISE EXCEPTION 'Reflection source repair identity and cursor are monotonic'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION "public"."reflection_source_change_repair_guard_update"()
  FROM PUBLIC, "nautilo_agent", "nautilo_crypto";--> statement-breakpoint
GRANT EXECUTE ON FUNCTION "public"."reflection_source_change_repair_guard_update"()
  TO "nautilo";--> statement-breakpoint
CREATE TRIGGER "reflection_record_source_change_repairs_update_guard"
BEFORE UPDATE ON "reflection_record_source_change_repairs" FOR EACH ROW
EXECUTE FUNCTION "public"."reflection_source_change_repair_guard_update"();--> statement-breakpoint
CREATE FUNCTION "public"."reflection_semantic_work_guard_update"()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog AS $$
BEGIN
  IF NEW.record_id IS DISTINCT FROM OLD.record_id
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR NEW.generation < OLD.generation
     OR NEW.completed_generation < OLD.completed_generation
     OR NEW.updated_at < OLD.updated_at THEN
    RAISE EXCEPTION 'Reflection semantic work identity and generations are monotonic'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.generation > OLD.generation THEN
    IF NEW.generation <> OLD.generation + 1
       OR NEW.stage <> 'authority_projection'
       OR NEW.state <> 'due'
       OR NEW.completed_generation <> OLD.completed_generation
       OR NEW.attempt_count <> 0
       OR NEW.claim_generation IS NOT NULL
       OR NEW.lease_token IS NOT NULL
       OR NEW.lease_expires_at IS NOT NULL
       OR NEW.next_attempt_at IS NULL
       OR NEW.failure_code IS NOT NULL
       OR NEW.completed_at IS NOT NULL
       OR NEW.due_since < OLD.due_since THEN
      RAISE EXCEPTION 'New Reflection semantic work generation must advance exactly once and reset to due authority projection'
        USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;

  IF (CASE NEW.change_reason
       WHEN 'created' THEN 1
       WHEN 'revised' THEN 2
       WHEN 'dependency_lost' THEN 3
     END) < (CASE OLD.change_reason
       WHEN 'created' THEN 1
       WHEN 'revised' THEN 2
       WHEN 'dependency_lost' THEN 3
     END) THEN
    RAISE EXCEPTION 'Reflection semantic work reason cannot weaken within a generation'
      USING ERRCODE = '23514';
  END IF;

  IF OLD.state IN ('complete', 'quarantined') AND NEW IS DISTINCT FROM OLD THEN
    RAISE EXCEPTION 'Terminal Reflection semantic work requires a newer generation'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.stage IS DISTINCT FROM OLD.stage AND NOT (
    OLD.state = 'claimed'
    AND NEW.state = 'checkpointed'
    AND (
      (OLD.stage = 'authority_projection' AND NEW.stage = 'search_projection')
      OR (OLD.stage = 'search_projection' AND NEW.stage = 'organization')
    )
  ) THEN
    RAISE EXCEPTION 'Invalid Reflection semantic work stage checkpoint'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.state IS DISTINCT FROM OLD.state AND NOT (
    (OLD.state IN ('due', 'checkpointed', 'deferred', 'claimed')
      AND NEW.state = 'claimed')
    OR (OLD.state = 'claimed'
      AND NEW.state IN ('due', 'checkpointed', 'deferred', 'complete', 'quarantined'))
    OR (OLD.state IN ('due', 'checkpointed', 'deferred')
      AND NEW.state = 'quarantined')
  ) THEN
    RAISE EXCEPTION 'Invalid Reflection semantic work state transition'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION "public"."reflection_semantic_work_guard_update"()
  FROM PUBLIC, "nautilo_agent", "nautilo_crypto";--> statement-breakpoint
GRANT EXECUTE ON FUNCTION "public"."reflection_semantic_work_guard_update"()
  TO "nautilo";--> statement-breakpoint
CREATE TRIGGER "reflection_record_semantic_work_update_guard"
BEFORE UPDATE ON "reflection_record_semantic_work" FOR EACH ROW
EXECUTE FUNCTION "public"."reflection_semantic_work_guard_update"();
