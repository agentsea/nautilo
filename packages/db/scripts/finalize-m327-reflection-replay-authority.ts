import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

export const M327_REFLECTION_REPLAY_AUTHORITY_MARKER =
  "-- M327 REFLECTION REPLAY AUTHORITY FINALIZER";
export const M327_REFLECTION_ORIGIN_IMMUTABILITY_MARKER =
  "-- M327 REFLECTION ORIGIN IMMUTABILITY FINALIZER";

const AUTHORITY_DEPENDENCY_TABLE =
  "reflection_record_authority_dependencies";
const PUBLICATION_TABLE = "reflection_record_publications";
const REPLAY_COLUMNS = [
  "replay_structural_height",
  "replay_processing_generation",
  "replay_predecessor_record_id",
  "replay_predecessor_relation",
] as const;

const tableAnchor = `CREATE TABLE "${AUTHORITY_DEPENDENCY_TABLE}"`;
const columnAnchors = REPLAY_COLUMNS.map(
  (column) => `ALTER TABLE "${PUBLICATION_TABLE}" ADD COLUMN "${column}"`,
);
const originColumnAnchor =
  `ALTER TABLE "${PUBLICATION_TABLE}" ADD COLUMN "origin_publication_binding_ref"`;

const finalizer = `${M327_REFLECTION_REPLAY_AUTHORITY_MARKER}
ALTER TABLE "${AUTHORITY_DEPENDENCY_TABLE}" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL ON TABLE "${AUTHORITY_DEPENDENCY_TABLE}" FROM PUBLIC, "nautilo_agent", "nautilo_crypto";--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "${AUTHORITY_DEPENDENCY_TABLE}" TO "nautilo";--> statement-breakpoint
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
BEFORE UPDATE ON "${PUBLICATION_TABLE}" FOR EACH ROW
EXECUTE FUNCTION "public"."reflection_record_guard_publication_replay_mutation"();`;

const originFinalizer = `${M327_REFLECTION_ORIGIN_IMMUTABILITY_MARKER}
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
BEFORE UPDATE ON "${PUBLICATION_TABLE}" FOR EACH ROW
EXECUTE FUNCTION "public"."reflection_record_guard_publication_origin_mutation"();`;

export function finalizeM327ReflectionReplayAuthorityMigration(
  migration: string,
): string {
  let finalized = migration;
  const anchors = [tableAnchor, ...columnAnchors];
  const present = anchors.filter((anchor) => migration.includes(anchor));
  if (present.length > 0 && present.length !== anchors.length) {
    throw new Error(
      `Refusing partial M327 Reflection replay authority finalization: found ${
        present.length
      } of ${anchors.length} schema changes`,
    );
  }
  if (
    present.length === anchors.length
    && !finalized.includes(M327_REFLECTION_REPLAY_AUTHORITY_MARKER)
  ) {
    finalized = `${finalized}${finalized.endsWith("\n") ? "" : "\n"}--> statement-breakpoint
${finalizer}
`;
  }
  if (
    migration.includes(originColumnAnchor)
    && !finalized.includes(M327_REFLECTION_ORIGIN_IMMUTABILITY_MARKER)
  ) {
    finalized = `${finalized}${finalized.endsWith("\n") ? "" : "\n"}--> statement-breakpoint
${originFinalizer}
`;
  }
  return finalized;
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
  const finalized = finalizeM327ReflectionReplayAuthorityMigration(migration);
  if (finalized !== migration) writeFileSync(migrationPath, finalized, "utf8");
}

if (import.meta.main) run();
