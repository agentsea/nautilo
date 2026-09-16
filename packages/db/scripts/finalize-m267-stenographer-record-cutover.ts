import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

export const M267_STENOGRAPHER_RECORD_CUTOVER_MARKER =
  "-- M267 STENOGRAPHER RECORD CUTOVER FINALIZER";

const CUTOVER_TABLE = "room_journal_record_cutover";
const RETIREMENT_TABLE = "room_journal_record_rebuild_retirements";

const finalizer = `${M267_STENOGRAPHER_RECORD_CUTOVER_MARKER}
ALTER TABLE "${CUTOVER_TABLE}" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "${RETIREMENT_TABLE}" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL ON TABLE "${CUTOVER_TABLE}" FROM PUBLIC, "nautilo_agent", "nautilo_crypto";--> statement-breakpoint
REVOKE ALL ON TABLE "${RETIREMENT_TABLE}" FROM PUBLIC, "nautilo_agent", "nautilo_crypto";--> statement-breakpoint
GRANT SELECT, INSERT ON TABLE "${CUTOVER_TABLE}" TO "nautilo";--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "${RETIREMENT_TABLE}" TO "nautilo";--> statement-breakpoint
UPDATE "room_journal_state" state
SET "record_conversion_status" = 'pending',
    "record_conversion_cursor_sequence" = 0,
    "record_conversion_failure_count" = 0,
    "record_conversion_retry_after" = NULL,
    "record_conversion_lease_token" = NULL,
    "record_conversion_lease_expires_at" = NULL,
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
BEFORE INSERT OR UPDATE OR DELETE ON "${CUTOVER_TABLE}" FOR EACH ROW
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
EXECUTE FUNCTION "public"."room_journal_record_rebuild_lifecycle"();`;

export function finalizeM267StenographerRecordCutoverMigration(
  migration: string,
): string {
  if (!migration.includes(`CREATE TABLE "${CUTOVER_TABLE}"`)) return migration;
  if (migration.includes(M267_STENOGRAPHER_RECORD_CUTOVER_MARKER)) {
    return migration;
  }
  return `${migration}${migration.endsWith("\n") ? "" : "\n"}--> statement-breakpoint
${finalizer}
`;
}

function run(): void {
  const migrationsDirectory = resolve(import.meta.dir, "../src/migrations");
  const journal = JSON.parse(
    readFileSync(resolve(migrationsDirectory, "meta/_journal.json"), "utf8"),
  ) as { entries: readonly { tag: string }[] };
  const latest = journal.entries.at(-1);
  if (latest === undefined) throw new Error("Migration journal is empty");
  const migrationPath = resolve(migrationsDirectory, `${latest.tag}.sql`);
  const migration = readFileSync(migrationPath, "utf8");
  const finalized = finalizeM267StenographerRecordCutoverMigration(migration);
  if (finalized !== migration) writeFileSync(migrationPath, finalized, "utf8");
}

if (import.meta.main) run();
