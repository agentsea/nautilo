CREATE TABLE "reflection_record_authority_dependencies" (
	"record_id" text NOT NULL,
	"dependency_record_id" text NOT NULL,
	CONSTRAINT "reflection_record_authority_dependencies_record_id_dependency_record_id_pk" PRIMARY KEY("record_id","dependency_record_id"),
	CONSTRAINT "reflection_record_authority_dependencies_no_self" CHECK ("reflection_record_authority_dependencies"."record_id" <> "reflection_record_authority_dependencies"."dependency_record_id")
);
--> statement-breakpoint
ALTER TABLE "reflection_record_authority_dependencies" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "reflection_record_publications" ADD COLUMN "replay_structural_height" integer;--> statement-breakpoint
ALTER TABLE "reflection_record_publications" ADD COLUMN "replay_processing_generation" integer;--> statement-breakpoint
ALTER TABLE "reflection_record_publications" ADD COLUMN "replay_predecessor_record_id" text;--> statement-breakpoint
ALTER TABLE "reflection_record_publications" ADD COLUMN "replay_predecessor_relation" text;--> statement-breakpoint
ALTER TABLE "reflection_record_authority_dependencies" ADD CONSTRAINT "reflection_record_authority_dependencies_record_id_reflection_records_record_id_fk" FOREIGN KEY ("record_id") REFERENCES "public"."reflection_records"("record_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reflection_record_authority_dependencies" ADD CONSTRAINT "reflection_record_authority_dependencies_dependency_record_id_reflection_records_record_id_fk" FOREIGN KEY ("dependency_record_id") REFERENCES "public"."reflection_records"("record_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_reflection_record_authority_dependencies_source" ON "reflection_record_authority_dependencies" USING btree ("dependency_record_id","record_id");--> statement-breakpoint
ALTER TABLE "reflection_record_publications" ADD CONSTRAINT "reflection_record_publications_replay_shape" CHECK ((
      "reflection_record_publications"."replay_structural_height" IS NULL AND "reflection_record_publications"."replay_processing_generation" IS NULL
      AND "reflection_record_publications"."replay_predecessor_record_id" IS NULL AND "reflection_record_publications"."replay_predecessor_relation" IS NULL
    ) OR (
      "reflection_record_publications"."replay_structural_height" IS NOT NULL AND "reflection_record_publications"."replay_structural_height" >= 0
      AND "reflection_record_publications"."replay_processing_generation" IS NOT NULL AND "reflection_record_publications"."replay_processing_generation" > 0
      AND (("reflection_record_publications"."replay_predecessor_record_id" IS NULL AND "reflection_record_publications"."replay_predecessor_relation" IS NULL)
        OR ("reflection_record_publications"."replay_predecessor_record_id" IS NOT NULL
          AND "reflection_record_publications"."replay_predecessor_relation" IS NOT NULL
          AND "reflection_record_publications"."replay_predecessor_relation" IN ('supersedes', 'resolves')))
    ));--> statement-breakpoint
CREATE POLICY "reflection_record_authority_dependencies_product_all" ON "reflection_record_authority_dependencies" AS PERMISSIVE FOR ALL TO "nautilo" USING (true) WITH CHECK (true);
--> statement-breakpoint
-- M327 REFLECTION REPLAY AUTHORITY FINALIZER
ALTER TABLE "reflection_record_authority_dependencies" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL ON TABLE "reflection_record_authority_dependencies" FROM PUBLIC, "nautilo_agent", "nautilo_crypto";--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "reflection_record_authority_dependencies" TO "nautilo";--> statement-breakpoint
CREATE FUNCTION "public"."reflection_record_guard_publication_replay_mutation"()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog AS $$
BEGIN
  IF OLD.replay_structural_height IS DISTINCT FROM NEW.replay_structural_height
     OR OLD.replay_processing_generation IS DISTINCT FROM NEW.replay_processing_generation
     OR OLD.replay_predecessor_record_id IS DISTINCT FROM NEW.replay_predecessor_record_id
     OR OLD.replay_predecessor_relation IS DISTINCT FROM NEW.replay_predecessor_relation THEN
    RAISE EXCEPTION 'Reflection Record publication replay structure is immutable'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION "public"."reflection_record_guard_publication_replay_mutation"()
  FROM PUBLIC, "nautilo_agent", "nautilo_crypto";--> statement-breakpoint
GRANT EXECUTE ON FUNCTION "public"."reflection_record_guard_publication_replay_mutation"()
  TO "nautilo";--> statement-breakpoint
CREATE TRIGGER "reflection_record_publications_replay_mutation_guard"
BEFORE UPDATE ON "reflection_record_publications" FOR EACH ROW
EXECUTE FUNCTION "public"."reflection_record_guard_publication_replay_mutation"();
