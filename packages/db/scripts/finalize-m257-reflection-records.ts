import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const TABLES = [
  "reflection_records",
  "reflection_record_dependencies",
  "reflection_record_successors",
  "reflection_record_payload_representations",
  "reflection_record_payload_representation_heads",
  "reflection_record_publications",
] as const;

const migrationsDirectory = resolve(import.meta.dir, "../src/migrations");
const migrationNames = readdirSync(migrationsDirectory)
  .filter((name) => /^\d{4}_.+\.sql$/u.test(name))
  .sort();
const migration = [...migrationNames].reverse()
  .find((name) => {
    const sql = readFileSync(resolve(migrationsDirectory, name), "utf8");
    return sql.includes('CREATE TABLE "reflection_records"');
  });

if (migration === undefined) {
  process.exit(0);
}

const migrationPath = resolve(migrationsDirectory, migration);
if (!existsSync(migrationPath)) {
  process.exit(0);
}

const current = readFileSync(migrationPath, "utf8");
const marker = "-- M257 REFLECTION RECORD SECURITY FINALIZER";
const transitionMarker = "-- M257 REFLECTION RECORD TRANSITION HARDENING";

const forceRls = TABLES.map(
  (table) => `ALTER TABLE "${table}" FORCE ROW LEVEL SECURITY;`,
).join("\n--> statement-breakpoint\n");

const revokeAndGrant = TABLES.map(
  (table) => [
    `REVOKE ALL ON TABLE "${table}" FROM PUBLIC, "nautilo_agent", "nautilo_crypto";`,
    `GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "${table}" TO "nautilo";`,
  ].join("\n--> statement-breakpoint\n"),
).join("\n--> statement-breakpoint\n");

const publicationGuardFunction = `CREATE OR REPLACE FUNCTION "public"."reflection_record_guard_publication_mutation"()
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
$$;`;

if (current.includes(marker)) {
  const transitionMigration = [...migrationNames].reverse().find((name) => {
    if (name === migration) return false;
    const sql = readFileSync(resolve(migrationsDirectory, name), "utf8");
    return sql.includes('ADD COLUMN "crypto_retired_at"');
  });
  if (transitionMigration === undefined) process.exit(0);
  const transitionPath = resolve(migrationsDirectory, transitionMigration);
  const transitionCurrent = readFileSync(transitionPath, "utf8");
  if (transitionCurrent.includes(transitionMarker)) process.exit(0);
  writeFileSync(
    transitionPath,
    `${transitionCurrent.trimEnd()}\n--> statement-breakpoint\n${transitionMarker}\n${publicationGuardFunction}\n`,
    "utf8",
  );
  process.exit(0);
}

const finalizer = `
--> statement-breakpoint
${marker}
${forceRls}
--> statement-breakpoint
${revokeAndGrant}
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "public"."reflection_record_reject_immutable_change"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'Reflection Record graph/history rows are immutable';
END;
$$;
--> statement-breakpoint
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
     OR OLD.processing_generation IS DISTINCT FROM NEW.processing_generation
     OR OLD.payload_version IS DISTINCT FROM NEW.payload_version
     OR OLD.created_at IS DISTINCT FROM NEW.created_at THEN
    RAISE EXCEPTION 'Reflection Record semantic identity is immutable';
  END IF;

  IF OLD.lifecycle IS DISTINCT FROM NEW.lifecycle AND NOT (
    (OLD.lifecycle = 'current' AND NEW.lifecycle IN ('stale', 'superseded', 'resolved', 'sunset'))
    OR (OLD.lifecycle = 'stale' AND NEW.lifecycle IN ('current', 'superseded', 'resolved', 'sunset'))
  ) THEN
    RAISE EXCEPTION 'Invalid Reflection Record lifecycle transition';
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
--> statement-breakpoint
CREATE TRIGGER "reflection_records_mutation_guard"
BEFORE UPDATE OR DELETE ON "reflection_records"
FOR EACH ROW EXECUTE FUNCTION "public"."reflection_record_guard_record_mutation"();
--> statement-breakpoint
CREATE TRIGGER "reflection_record_dependencies_immutable"
BEFORE UPDATE OR DELETE ON "reflection_record_dependencies"
FOR EACH ROW EXECUTE FUNCTION "public"."reflection_record_reject_immutable_change"();
--> statement-breakpoint
CREATE TRIGGER "reflection_record_successors_immutable"
BEFORE UPDATE OR DELETE ON "reflection_record_successors"
FOR EACH ROW EXECUTE FUNCTION "public"."reflection_record_reject_immutable_change"();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "public"."reflection_record_guard_representation_mutation"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  current_disposition text;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'Reflection Record payload generations are immutable';
  END IF;
  SELECT disposition INTO current_disposition
    FROM reflection_records
   WHERE record_id = OLD.record_id;
  IF current_disposition IS DISTINCT FROM 'purged' THEN
    RAISE EXCEPTION 'Reflection Record payload can be removed only after purge';
  END IF;
  RETURN OLD;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "reflection_record_payload_representations_mutation_guard"
BEFORE UPDATE OR DELETE ON "reflection_record_payload_representations"
FOR EACH ROW EXECUTE FUNCTION "public"."reflection_record_guard_representation_mutation"();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "public"."reflection_record_guard_head_mutation"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  current_disposition text;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF OLD.record_id IS DISTINCT FROM NEW.record_id
       OR OLD.representation IS DISTINCT FROM NEW.representation
       OR OLD.current_representation_generation >= NEW.current_representation_generation THEN
      RAISE EXCEPTION 'Reflection Record representation head must advance by CAS';
    END IF;
    RETURN NEW;
  END IF;
  SELECT disposition INTO current_disposition
    FROM reflection_records
   WHERE record_id = OLD.record_id;
  IF current_disposition IS DISTINCT FROM 'purged' THEN
    RAISE EXCEPTION 'Reflection Record representation head can be removed only after purge';
  END IF;
  RETURN OLD;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "reflection_record_payload_heads_mutation_guard"
BEFORE UPDATE OR DELETE ON "reflection_record_payload_representation_heads"
FOR EACH ROW EXECUTE FUNCTION "public"."reflection_record_guard_head_mutation"();
--> statement-breakpoint
${publicationGuardFunction}
--> statement-breakpoint
CREATE TRIGGER "reflection_record_publications_mutation_guard"
BEFORE UPDATE OR DELETE ON "reflection_record_publications"
FOR EACH ROW EXECUTE FUNCTION "public"."reflection_record_guard_publication_mutation"();
`;

writeFileSync(migrationPath, `${current.trimEnd()}${finalizer}\n`, "utf8");
