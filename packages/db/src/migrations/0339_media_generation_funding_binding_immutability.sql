-- MEDIA_GENERATION_FUNDING_BINDING_IMMUTABILITY
CREATE OR REPLACE FUNCTION "public"."guard_media_generation_funding_binding"()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog
AS $$
BEGIN
  IF NEW.funding_binding IS DISTINCT FROM OLD.funding_binding THEN
    RAISE EXCEPTION 'Media generation funding binding is immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "media_generation_funding_binding_immutable"
BEFORE UPDATE OF "funding_binding" ON "media_generations"
FOR EACH ROW EXECUTE FUNCTION "public"."guard_media_generation_funding_binding"();--> statement-breakpoint
REVOKE ALL ON FUNCTION "public"."guard_media_generation_funding_binding"()
FROM PUBLIC, "nautilo_agent", "nautilo_crypto";
