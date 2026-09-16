ALTER TABLE "reflection_record_publications" ADD COLUMN "origin_publication_binding_ref" text;--> statement-breakpoint
ALTER TABLE "reflection_record_publications" ADD CONSTRAINT "reflection_record_publications_origin_binding_portable" CHECK (octet_length("reflection_record_publications"."origin_publication_binding_ref") between 1 and 128
      and "reflection_record_publications"."origin_publication_binding_ref" ~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]*$');
--> statement-breakpoint
-- M327 REFLECTION ORIGIN IMMUTABILITY FINALIZER
CREATE FUNCTION "public"."reflection_record_guard_publication_origin_mutation"()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog AS $$
BEGIN
  IF OLD.origin_publication_binding_ref IS DISTINCT FROM NEW.origin_publication_binding_ref THEN
    RAISE EXCEPTION 'Reflection Record publication origin is immutable'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION "public"."reflection_record_guard_publication_origin_mutation"()
  FROM PUBLIC, "nautilo_agent", "nautilo_crypto";--> statement-breakpoint
GRANT EXECUTE ON FUNCTION "public"."reflection_record_guard_publication_origin_mutation"()
  TO "nautilo";--> statement-breakpoint
CREATE TRIGGER "reflection_record_publications_origin_mutation_guard"
BEFORE UPDATE ON "reflection_record_publications" FOR EACH ROW
EXECUTE FUNCTION "public"."reflection_record_guard_publication_origin_mutation"();
