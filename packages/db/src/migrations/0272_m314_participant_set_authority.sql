-- M314_PARTICIPANT_SET_AUTHORITY
CREATE OR REPLACE FUNCTION "public"."crypto_participants_are_canonical"(
  "participants" text[]
) RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
STRICT
PARALLEL SAFE
SET search_path = pg_catalog
AS $$
DECLARE
  "participant" text;
  "participant_bytes" bytea;
  "previous_bytes" bytea := NULL;
BEGIN
  IF cardinality("participants") < 1 THEN
    RETURN false;
  END IF;

  FOREACH "participant" IN ARRAY "participants" LOOP
    IF octet_length("participant") NOT BETWEEN 1 AND 128
      OR "participant" !~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]*$'
    THEN
      RETURN false;
    END IF;

    "participant_bytes" := convert_to("participant", 'UTF8');
    IF "previous_bytes" IS NOT NULL
      AND "previous_bytes" >= "participant_bytes"
    THEN
      RETURN false;
    END IF;
    "previous_bytes" := "participant_bytes";
  END LOOP;

  RETURN true;
END;
$$;--> statement-breakpoint
