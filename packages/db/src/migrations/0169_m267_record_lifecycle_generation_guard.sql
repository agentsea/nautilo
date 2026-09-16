-- M267 follow-up: lifecycle changes are mutable Record state, while
-- processing_generation is their optimistic-concurrency fence. The original
-- M257 guard froze processing_generation even when lifecycle changed, making
-- every generation-fenced transition impossible against real PostgreSQL.
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
     OR OLD.payload_version IS DISTINCT FROM NEW.payload_version
     OR OLD.created_at IS DISTINCT FROM NEW.created_at THEN
    RAISE EXCEPTION 'Reflection Record semantic identity is immutable';
  END IF;

  IF OLD.lifecycle IS DISTINCT FROM NEW.lifecycle THEN
    IF NOT (
      (OLD.lifecycle = 'current' AND NEW.lifecycle IN ('stale', 'superseded', 'resolved', 'sunset'))
      OR (OLD.lifecycle = 'stale' AND NEW.lifecycle IN ('current', 'superseded', 'resolved', 'sunset'))
    ) THEN
      RAISE EXCEPTION 'Invalid Reflection Record lifecycle transition';
    END IF;
    IF NEW.processing_generation IS DISTINCT FROM OLD.processing_generation + 1 THEN
      RAISE EXCEPTION 'Reflection Record lifecycle generation must advance exactly once';
    END IF;
  ELSIF OLD.processing_generation IS DISTINCT FROM NEW.processing_generation THEN
    RAISE EXCEPTION 'Reflection Record semantic identity is immutable';
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
