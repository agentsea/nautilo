CREATE TABLE "reflection_record_search_projections" (
	"record_id" text PRIMARY KEY NOT NULL,
	"record_processing_generation" integer NOT NULL,
	"projection_version" smallint DEFAULT 1 NOT NULL,
	"projection_generation" integer NOT NULL,
	"embedding_provider" text NOT NULL,
	"embedding_canonical_model" text NOT NULL,
	"embedding_dimensions" smallint NOT NULL,
	"embedding_contract_version" smallint NOT NULL,
	"embedding" vector(1536) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "reflection_record_search_projections_record_id_portable" CHECK (octet_length("reflection_record_search_projections"."record_id") between 1 and 128
      and "reflection_record_search_projections"."record_id" ~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]*$'),
	CONSTRAINT "reflection_record_search_projections_generations_positive" CHECK ("reflection_record_search_projections"."record_processing_generation" > 0 and "reflection_record_search_projections"."projection_generation" > 0),
	CONSTRAINT "reflection_record_search_projections_version_v1" CHECK ("reflection_record_search_projections"."projection_version" = 1),
	CONSTRAINT "reflection_record_search_projections_provider_bounded" CHECK (octet_length("reflection_record_search_projections"."embedding_provider") between 1 and 256
        and "reflection_record_search_projections"."embedding_provider" ~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]*$'),
	CONSTRAINT "reflection_record_search_projections_model_bounded" CHECK (octet_length("reflection_record_search_projections"."embedding_canonical_model") between 1 and 256
        and "reflection_record_search_projections"."embedding_canonical_model" ~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]*$'),
	CONSTRAINT "reflection_record_search_projections_dimensions_v1" CHECK ("reflection_record_search_projections"."embedding_dimensions" = 1536
        and vector_dims("reflection_record_search_projections"."embedding") = 1536
        and vector_norm("reflection_record_search_projections"."embedding") > 0),
	CONSTRAINT "reflection_record_search_projections_contract_v1" CHECK ("reflection_record_search_projections"."embedding_contract_version" = 1)
);
--> statement-breakpoint
ALTER TABLE "reflection_record_search_projections" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "reflection_record_search_projections" ADD CONSTRAINT "reflection_record_search_projections_record_id_reflection_records_record_id_fk" FOREIGN KEY ("record_id") REFERENCES "public"."reflection_records"("record_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_reflection_record_search_projections_provenance" ON "reflection_record_search_projections" USING btree ("projection_version","embedding_contract_version","embedding_provider","embedding_canonical_model","embedding_dimensions","record_id");--> statement-breakpoint
CREATE INDEX "idx_reflection_record_search_projections_record" ON "reflection_record_search_projections" USING btree ("record_id","record_processing_generation","projection_generation");--> statement-breakpoint
CREATE POLICY "reflection_record_search_projections_product_all" ON "reflection_record_search_projections" AS PERMISSIVE FOR ALL TO "nautilo" USING (true) WITH CHECK (true);
--> statement-breakpoint
-- M264 REFLECTION SEARCH SECURITY FINALIZER
ALTER TABLE "reflection_record_search_projections" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL ON TABLE "reflection_record_search_projections" FROM PUBLIC, "nautilo_agent", "nautilo_crypto";--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "reflection_record_search_projections" TO "nautilo";--> statement-breakpoint
CREATE FUNCTION "public"."reflection_search_projection_guard_update"()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog AS $$
BEGIN
  IF NEW.record_id IS DISTINCT FROM OLD.record_id
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'Reflection search projection identity is immutable'
      USING ERRCODE = '23514';
  END IF;
  IF NEW.projection_generation <> OLD.projection_generation + 1 THEN
    RAISE EXCEPTION 'Reflection search projection generation must advance exactly once'
      USING ERRCODE = '23514';
  END IF;
  IF NEW.updated_at < OLD.updated_at THEN
    RAISE EXCEPTION 'Reflection search projection time cannot move backward'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION "public"."reflection_search_projection_guard_update"()
  FROM PUBLIC, "nautilo_agent", "nautilo_crypto";--> statement-breakpoint
CREATE TRIGGER "reflection_record_search_projections_update_guard"
BEFORE UPDATE ON "reflection_record_search_projections" FOR EACH ROW
EXECUTE FUNCTION "public"."reflection_search_projection_guard_update"();
