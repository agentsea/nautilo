ALTER TABLE "reflection_record_publications" DROP CONSTRAINT "reflection_record_publications_representation_shape";--> statement-breakpoint
ALTER TABLE "reflection_record_publications" DROP CONSTRAINT "reflection_record_publications_crypto_state_coherent";--> statement-breakpoint
ALTER TABLE "reflection_record_publications" ADD COLUMN "crypto_retired_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "reflection_record_publications" ADD CONSTRAINT "reflection_record_publications_terminal_schedule_clear" CHECK ("reflection_record_publications"."state" not in ('complete', 'blocked', 'quarantined', 'retry_exhausted')
        or (
          "reflection_record_publications"."next_attempt_at" is null
          and "reflection_record_publications"."lease_token" is null
          and "reflection_record_publications"."lease_expires_at" is null
        ));--> statement-breakpoint
ALTER TABLE "reflection_record_publications" ADD CONSTRAINT "reflection_record_publications_retirement_coherent" CHECK ("reflection_record_publications"."crypto_retired_at" is null or "reflection_record_publications"."crypto_object_id" is not null);--> statement-breakpoint
ALTER TABLE "reflection_record_publications" ADD CONSTRAINT "reflection_record_publications_representation_shape" CHECK ((
        "reflection_record_publications"."representation" = 'ordinary'
        and "reflection_record_publications"."crypto_object_id" is null
        and "reflection_record_publications"."crypto_retired_at" is null
        and "reflection_record_publications"."state" = 'complete'
        and "reflection_record_publications"."attempt_count" = 0
      ) or (
        "reflection_record_publications"."representation" = 'protected'
      ));--> statement-breakpoint
ALTER TABLE "reflection_record_publications" ADD CONSTRAINT "reflection_record_publications_crypto_state_coherent" CHECK ((
        "reflection_record_publications"."representation" = 'ordinary'
        and "reflection_record_publications"."crypto_completed_at" is null
      ) or (
        "reflection_record_publications"."representation" = 'protected'
        and (
          ("reflection_record_publications"."state" = 'reserved'
            and "reflection_record_publications"."crypto_object_id" is null
            and "reflection_record_publications"."crypto_completed_at" is null)
          or ("reflection_record_publications"."state" in ('crypto_complete', 'product_attached', 'complete')
            and "reflection_record_publications"."crypto_object_id" is not null
            and "reflection_record_publications"."crypto_completed_at" is not null)
          or "reflection_record_publications"."state" in ('blocked', 'quarantined', 'retry_exhausted')
        )
      ));
--> statement-breakpoint
-- M257 REFLECTION RECORD TRANSITION HARDENING
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

  IF OLD.state IS DISTINCT FROM NEW.state AND NOT (
    (OLD.state = 'reserved' AND NEW.state IN (
      'crypto_complete', 'blocked', 'quarantined', 'retry_exhausted'
    ))
    OR (OLD.state = 'crypto_complete' AND NEW.state IN (
      'product_attached', 'blocked', 'quarantined', 'retry_exhausted'
    ))
    OR (OLD.state = 'product_attached' AND NEW.state IN (
      'complete', 'blocked', 'quarantined', 'retry_exhausted'
    ))
    OR (OLD.state IN ('quarantined', 'retry_exhausted') AND NEW.state = 'blocked')
  ) THEN
    RAISE EXCEPTION 'Invalid Reflection Record publication transition';
  END IF;

  IF NEW.attempt_count < OLD.attempt_count
     OR NEW.attempt_count > OLD.attempt_count + 1 THEN
    RAISE EXCEPTION 'Invalid Reflection Record publication attempt transition';
  END IF;

  IF OLD.crypto_object_id IS NOT NULL
     AND OLD.crypto_object_id IS DISTINCT FROM NEW.crypto_object_id THEN
    RAISE EXCEPTION 'Reflection Record publication crypto identity is immutable';
  END IF;

  IF (OLD.crypto_completed_at IS NOT NULL
        AND OLD.crypto_completed_at IS DISTINCT FROM NEW.crypto_completed_at)
     OR (OLD.product_attached_at IS NOT NULL
        AND OLD.product_attached_at IS DISTINCT FROM NEW.product_attached_at)
     OR (OLD.completed_at IS NOT NULL
        AND OLD.completed_at IS DISTINCT FROM NEW.completed_at)
     OR (OLD.crypto_retired_at IS NOT NULL
        AND OLD.crypto_retired_at IS DISTINCT FROM NEW.crypto_retired_at)
     OR NEW.updated_at < OLD.updated_at THEN
    RAISE EXCEPTION 'Invalid Reflection Record publication timestamp transition';
  END IF;
  RETURN NEW;
END;
$$;
