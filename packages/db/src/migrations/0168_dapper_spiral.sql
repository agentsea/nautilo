CREATE TABLE "room_journal_record_cutover" (
	"singleton_key" smallint PRIMARY KEY DEFAULT 1 NOT NULL,
	"cutover_version" smallint DEFAULT 1 NOT NULL,
	"first_native_record_id" text NOT NULL,
	"activated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "room_journal_record_cutover_singleton" CHECK ("room_journal_record_cutover"."singleton_key" = 1),
	CONSTRAINT "room_journal_record_cutover_version_v1" CHECK ("room_journal_record_cutover"."cutover_version" = 1)
);
--> statement-breakpoint
ALTER TABLE "room_journal_record_cutover" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "room_journal_record_rebuild_retirements" (
	"room_id" uuid NOT NULL,
	"rebuild_generation" integer NOT NULL,
	"record_id" text NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	CONSTRAINT "pk_room_journal_record_rebuild_retirements" PRIMARY KEY("room_id","rebuild_generation","record_id"),
	CONSTRAINT "room_journal_record_rebuild_retirements_generation_positive" CHECK ("room_journal_record_rebuild_retirements"."rebuild_generation" > 0),
	CONSTRAINT "room_journal_record_rebuild_retirements_state" CHECK ("room_journal_record_rebuild_retirements"."state" IN ('pending', 'sunset'))
);
--> statement-breakpoint
ALTER TABLE "room_journal_record_rebuild_retirements" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "room_events" DROP CONSTRAINT "room_events_statement_size";--> statement-breakpoint
ALTER TABLE "room_events" ALTER COLUMN "statement" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "room_events" ADD COLUMN "projection_kind" text DEFAULT 'legacy' NOT NULL;--> statement-breakpoint
ALTER TABLE "room_events" ADD COLUMN "record_id" text;--> statement-breakpoint
ALTER TABLE "room_events" ADD COLUMN "native_attached_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "room_journal_batches" ADD COLUMN "observation_publication_version" smallint DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "room_journal_state" ADD COLUMN "record_conversion_status" text DEFAULT 'not_needed' NOT NULL;--> statement-breakpoint
ALTER TABLE "room_journal_state" ADD COLUMN "record_conversion_cursor_sequence" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "room_journal_state" ADD COLUMN "record_conversion_failure_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "room_journal_state" ADD COLUMN "record_conversion_retry_after" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "room_journal_state" ADD COLUMN "record_conversion_lease_token" uuid;--> statement-breakpoint
ALTER TABLE "room_journal_state" ADD COLUMN "record_conversion_lease_expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "room_journal_state" ADD COLUMN "record_conversion_last_error_code" text;--> statement-breakpoint
ALTER TABLE "room_journal_record_cutover" ADD CONSTRAINT "room_journal_record_cutover_first_native_record_id_reflection_records_record_id_fk" FOREIGN KEY ("first_native_record_id") REFERENCES "public"."reflection_records"("record_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "room_journal_record_rebuild_retirements" ADD CONSTRAINT "room_journal_record_rebuild_retirements_room_id_rooms_id_fk" FOREIGN KEY ("room_id") REFERENCES "public"."rooms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "room_journal_record_rebuild_retirements" ADD CONSTRAINT "room_journal_record_rebuild_retirements_record_id_reflection_records_record_id_fk" FOREIGN KEY ("record_id") REFERENCES "public"."reflection_records"("record_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_room_journal_record_rebuild_retirements_pending" ON "room_journal_record_rebuild_retirements" USING btree ("room_id","state","rebuild_generation");--> statement-breakpoint
ALTER TABLE "room_events" ADD CONSTRAINT "room_events_record_id_reflection_records_record_id_fk" FOREIGN KEY ("record_id") REFERENCES "public"."reflection_records"("record_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_room_events_conversion" ON "room_events" USING btree ("projection_kind","room_id","sequence");--> statement-breakpoint
CREATE INDEX "idx_room_journal_state_record_conversion" ON "room_journal_state" USING btree ("record_conversion_status","record_conversion_retry_after","record_conversion_lease_expires_at");--> statement-breakpoint
ALTER TABLE "room_events" ADD CONSTRAINT "room_events_projection_kind" CHECK ("room_events"."projection_kind" IN ('legacy', 'native'));--> statement-breakpoint
ALTER TABLE "room_events" ADD CONSTRAINT "room_events_projection_shape" CHECK ((
        "room_events"."projection_kind" = 'legacy'
        AND "room_events"."statement" IS NOT NULL
        AND "room_events"."record_id" IS NULL
        AND "room_events"."native_attached_at" IS NULL
      ) OR (
        "room_events"."projection_kind" = 'native'
        AND "room_events"."statement" IS NULL
        AND "room_events"."crypto_object_id" IS NULL
        AND "room_events"."record_id" = "room_events"."id"::text
        AND "room_events"."native_attached_at" IS NOT NULL
      ));--> statement-breakpoint
ALTER TABLE "room_events" ADD CONSTRAINT "room_events_statement_size" CHECK ("room_events"."statement" IS NULL OR char_length("room_events"."statement") BETWEEN 1 AND 500);--> statement-breakpoint
ALTER TABLE "room_journal_batches" ADD CONSTRAINT "room_journal_batches_observation_publication_version" CHECK ("room_journal_batches"."observation_publication_version" IN (1, 2));--> statement-breakpoint
ALTER TABLE "room_journal_state" ADD CONSTRAINT "room_journal_state_record_conversion_status" CHECK ("room_journal_state"."record_conversion_status" IN ('pending', 'completed', 'not_needed'));--> statement-breakpoint
ALTER TABLE "room_journal_state" ADD CONSTRAINT "room_journal_state_record_conversion_cursor_nonnegative" CHECK ("room_journal_state"."record_conversion_cursor_sequence" >= 0);--> statement-breakpoint
ALTER TABLE "room_journal_state" ADD CONSTRAINT "room_journal_state_record_conversion_failures_nonnegative" CHECK ("room_journal_state"."record_conversion_failure_count" >= 0);--> statement-breakpoint
ALTER TABLE "room_journal_state" ADD CONSTRAINT "room_journal_state_record_conversion_lease_pair" CHECK (("room_journal_state"."record_conversion_lease_token" IS NULL) = ("room_journal_state"."record_conversion_lease_expires_at" IS NULL));--> statement-breakpoint
CREATE POLICY "room_journal_record_cutover_product_all" ON "room_journal_record_cutover" AS PERMISSIVE FOR ALL TO "nautilo" USING (true) WITH CHECK (true);--> statement-breakpoint
CREATE POLICY "room_journal_record_rebuild_retirements_product_all" ON "room_journal_record_rebuild_retirements" AS PERMISSIVE FOR ALL TO "nautilo" USING (true) WITH CHECK (true);
--> statement-breakpoint
-- M267 STENOGRAPHER RECORD CUTOVER FINALIZER
ALTER TABLE "room_journal_record_cutover" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "room_journal_record_rebuild_retirements" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL ON TABLE "room_journal_record_cutover" FROM PUBLIC, "nautilo_agent", "nautilo_crypto";--> statement-breakpoint
REVOKE ALL ON TABLE "room_journal_record_rebuild_retirements" FROM PUBLIC, "nautilo_agent", "nautilo_crypto";--> statement-breakpoint
GRANT SELECT, INSERT ON TABLE "room_journal_record_cutover" TO "nautilo";--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "room_journal_record_rebuild_retirements" TO "nautilo";--> statement-breakpoint
UPDATE "room_journal_state" state
SET "record_conversion_status" = 'pending',
    "record_conversion_cursor_sequence" = 0,
    "record_conversion_failure_count" = 0,
    "record_conversion_retry_after" = NULL,
    "record_conversion_last_error_code" = NULL
WHERE EXISTS (
  SELECT 1 FROM "room_events" event
  WHERE event."room_id" = state."room_id"
    AND event."projection_kind" = 'legacy'
);--> statement-breakpoint
CREATE FUNCTION "public"."room_journal_record_writer_guard"()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog AS $$
DECLARE
  cutover_active boolean;
  writer_version text;
BEGIN
  PERFORM pg_advisory_xact_lock(267, 1);
  SELECT EXISTS (
    SELECT 1 FROM public.room_journal_record_cutover WHERE singleton_key = 1
  ) INTO cutover_active;
  writer_version := current_setting('nautilo.stenographer_writer_version', true);

  IF TG_TABLE_NAME = 'room_journal_record_cutover' THEN
    IF TG_OP <> 'INSERT' THEN
      RAISE EXCEPTION 'Stenographer Record cutover is forward-only'
        USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;

  IF NOT cutover_active THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;

  IF TG_TABLE_NAME = 'room_journal_batches' THEN
    IF NEW.status = 'completed' AND NEW.observation_publication_version <> 2 THEN
      RAISE EXCEPTION 'Legacy Stenographer writer rejected after Record cutover'
        USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;

  -- Deletion cannot create a second semantic owner. Keep canonical erasure,
  -- retention, and Room cascades reachable after the writer cutover; any old
  -- rebuild transaction that deletes before inserting legacy rows still rolls
  -- back when its later insert is rejected.
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;

  IF writer_version IS DISTINCT FROM '2' THEN
    RAISE EXCEPTION 'Legacy Stenographer event mutation rejected after Record cutover'
      USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'INSERT' AND NEW.projection_kind <> 'native' THEN
    RAISE EXCEPTION 'Legacy Stenographer event insert rejected after Record cutover'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION "public"."room_journal_record_writer_guard"()
  FROM PUBLIC, "nautilo_agent", "nautilo_crypto";--> statement-breakpoint
GRANT EXECUTE ON FUNCTION "public"."room_journal_record_writer_guard"()
  TO "nautilo";--> statement-breakpoint
CREATE TRIGGER "room_journal_record_cutover_forward_only"
BEFORE INSERT OR UPDATE OR DELETE ON "room_journal_record_cutover" FOR EACH ROW
EXECUTE FUNCTION "public"."room_journal_record_writer_guard"();--> statement-breakpoint
CREATE TRIGGER "room_events_record_writer_guard"
BEFORE INSERT OR UPDATE OR DELETE ON "room_events" FOR EACH ROW
EXECUTE FUNCTION "public"."room_journal_record_writer_guard"();--> statement-breakpoint
CREATE TRIGGER "room_journal_batches_record_writer_guard"
BEFORE UPDATE OF "status", "observation_publication_version"
ON "room_journal_batches" FOR EACH ROW
EXECUTE FUNCTION "public"."room_journal_record_writer_guard"();--> statement-breakpoint
CREATE FUNCTION "public"."room_journal_record_rebuild_lifecycle"()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog AS $$
BEGIN
  IF NEW.rebuild_requested_at IS NOT NULL
     AND (TG_OP = 'INSERT' OR OLD.rebuild_generation IS DISTINCT FROM NEW.rebuild_generation)
  THEN
    INSERT INTO public.room_journal_record_rebuild_retirements (
      room_id, rebuild_generation, record_id, state, created_at
    )
    SELECT event.room_id, NEW.rebuild_generation, event.record_id, 'pending', NEW.rebuild_requested_at
    FROM public.room_events event
    WHERE event.room_id = NEW.room_id
      AND event.projection_kind = 'native'
      AND event.status = 'active'
      AND event.record_id IS NOT NULL
    ON CONFLICT (room_id, rebuild_generation, record_id) DO NOTHING;

    UPDATE public.reflection_records record
    SET lifecycle = 'stale',
        processing_generation = record.processing_generation + 1,
        updated_at = NEW.rebuild_requested_at
    FROM public.room_journal_record_rebuild_retirements retirement
    WHERE retirement.room_id = NEW.room_id
      AND retirement.rebuild_generation = NEW.rebuild_generation
      AND retirement.record_id = record.record_id
      AND retirement.state = 'pending'
      AND record.lifecycle = 'current';
  END IF;

  IF TG_OP = 'UPDATE'
     AND OLD.rebuild_requested_at IS NOT NULL
     AND NEW.rebuild_requested_at IS NULL
  THEN
    UPDATE public.reflection_records record
    SET lifecycle = 'sunset',
        processing_generation = record.processing_generation + 1,
        updated_at = COALESCE(NEW.updated_at, CURRENT_TIMESTAMP)
    FROM public.room_journal_record_rebuild_retirements retirement
    WHERE retirement.room_id = NEW.room_id
      AND retirement.rebuild_generation <= NEW.rebuild_generation
      AND retirement.record_id = record.record_id
      AND retirement.state = 'pending'
      AND record.lifecycle = 'stale';

    UPDATE public.room_journal_record_rebuild_retirements retirement
    SET state = 'sunset',
        completed_at = COALESCE(NEW.updated_at, CURRENT_TIMESTAMP)
    WHERE retirement.room_id = NEW.room_id
      AND retirement.rebuild_generation <= NEW.rebuild_generation
      AND retirement.state = 'pending';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION "public"."room_journal_record_rebuild_lifecycle"()
  FROM PUBLIC, "nautilo_agent", "nautilo_crypto";--> statement-breakpoint
GRANT EXECUTE ON FUNCTION "public"."room_journal_record_rebuild_lifecycle"()
  TO "nautilo";--> statement-breakpoint
CREATE TRIGGER "room_journal_record_rebuild_lifecycle"
AFTER INSERT OR UPDATE OF "rebuild_generation", "rebuild_requested_at"
ON "room_journal_state" FOR EACH ROW
EXECUTE FUNCTION "public"."room_journal_record_rebuild_lifecycle"();
