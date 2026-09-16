import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

export const M264_REFLECTION_SEARCH_SECURITY_MARKER =
  "-- M264 REFLECTION SEARCH SECURITY FINALIZER";

const TABLE = "reflection_record_search_projections";

const finalizer = `${M264_REFLECTION_SEARCH_SECURITY_MARKER}
ALTER TABLE "${TABLE}" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL ON TABLE "${TABLE}" FROM PUBLIC, "nautilo_agent", "nautilo_crypto";--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "${TABLE}" TO "nautilo";--> statement-breakpoint
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
BEFORE UPDATE ON "${TABLE}" FOR EACH ROW
EXECUTE FUNCTION "public"."reflection_search_projection_guard_update"();`;

export function finalizeM264ReflectionSearchMigration(
  migration: string,
): string {
  if (!migration.includes(`CREATE TABLE "${TABLE}"`)) return migration;
  if (migration.includes(M264_REFLECTION_SEARCH_SECURITY_MARKER)) {
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
  const finalized = finalizeM264ReflectionSearchMigration(migration);
  if (finalized !== migration) writeFileSync(migrationPath, finalized, "utf8");
}

if (import.meta.main) run();
