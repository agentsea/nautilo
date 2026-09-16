CREATE TABLE "reflection_record_dependency_change_repairs" (
	"change_commitment" "bytea" PRIMARY KEY NOT NULL,
	"changed_record_id" text NOT NULL,
	"continuation" text,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "reflection_record_dependency_change_repair_commitment_size" CHECK (octet_length("reflection_record_dependency_change_repairs"."change_commitment") = 32),
	CONSTRAINT "reflection_record_dependency_change_repair_continuation_bound" CHECK ("reflection_record_dependency_change_repairs"."continuation" is null or (
        octet_length("reflection_record_dependency_change_repairs"."continuation") between 1 and 128
        and "reflection_record_dependency_change_repairs"."continuation" ~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]*$'
      )),
	CONSTRAINT "reflection_record_dependency_change_repair_completion_coherent" CHECK ("reflection_record_dependency_change_repairs"."completed_at" is null or "reflection_record_dependency_change_repairs"."updated_at" = "reflection_record_dependency_change_repairs"."completed_at")
);
--> statement-breakpoint
ALTER TABLE "reflection_record_dependency_change_repairs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "reflection_record_dependency_change_repairs" ADD CONSTRAINT "reflection_record_dependency_change_repairs_changed_record_id_reflection_records_record_id_fk" FOREIGN KEY ("changed_record_id") REFERENCES "public"."reflection_records"("record_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_reflection_record_dependency_change_repairs_due" ON "reflection_record_dependency_change_repairs" USING btree ("completed_at","created_at","change_commitment");--> statement-breakpoint
CREATE INDEX "idx_reflection_record_dependency_change_repairs_record" ON "reflection_record_dependency_change_repairs" USING btree ("changed_record_id","completed_at");--> statement-breakpoint
CREATE POLICY "reflection_record_dependency_change_repairs_product_all" ON "reflection_record_dependency_change_repairs" AS PERMISSIVE FOR ALL TO "nautilo" USING (true) WITH CHECK (true);
--> statement-breakpoint
-- M287 RECORD DEPENDENCY REPAIR SECURITY FINALIZER
ALTER TABLE "reflection_record_dependency_change_repairs" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL ON TABLE "reflection_record_dependency_change_repairs" FROM PUBLIC, "nautilo_agent", "nautilo_crypto";--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON TABLE "reflection_record_dependency_change_repairs" TO "nautilo";--> statement-breakpoint
CREATE FUNCTION "public"."reflection_record_dependency_repair_guard_update"()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog AS $$
BEGIN
  IF NEW.change_commitment IS DISTINCT FROM OLD.change_commitment
     OR NEW.changed_record_id IS DISTINCT FROM OLD.changed_record_id
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR NEW.updated_at < OLD.updated_at
     OR OLD.completed_at IS NOT NULL
     OR (NEW.completed_at IS NULL AND OLD.continuation IS NOT NULL AND (
       NEW.continuation IS NULL OR NEW.continuation <= OLD.continuation
     )) THEN
    RAISE EXCEPTION 'Reflection Record dependency repair identity and cursor are monotonic'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION "public"."reflection_record_dependency_repair_guard_update"()
  FROM PUBLIC, "nautilo_agent", "nautilo_crypto";--> statement-breakpoint
GRANT EXECUTE ON FUNCTION "public"."reflection_record_dependency_repair_guard_update"()
  TO "nautilo";--> statement-breakpoint
CREATE TRIGGER "reflection_record_dependency_change_repairs_update_guard"
BEFORE UPDATE ON "reflection_record_dependency_change_repairs" FOR EACH ROW
EXECUTE FUNCTION "public"."reflection_record_dependency_repair_guard_update"();
