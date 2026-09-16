import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const TABLES = [
  "reflection_record_authority_closure",
  "reflection_record_authority_projections",
  "reflection_record_authority_alternatives",
  "reflection_record_authority_changes",
  "reflection_record_authority_reconciliations",
  "reflection_record_authority_blocks",
] as const;

const migrationsDirectory = resolve(import.meta.dir, "../src/migrations");
const migrationFiles = readdirSync(migrationsDirectory).filter((name) => /^\d{4}_.+\.sql$/u.test(name)).sort().reverse();
const augmentationName = migrationFiles.find(name => readFileSync(resolve(migrationsDirectory, name), "utf8")
  .includes('ALTER TABLE "reflection_record_authority_reconciliations" ADD COLUMN "target_access_namespace_ids"'));
const migrationName = augmentationName ?? migrationFiles.find(name => readFileSync(resolve(migrationsDirectory, name), "utf8")
  .includes('CREATE TABLE "reflection_record_authority_projections"'));
if (migrationName === undefined) process.exit(0);
const migrationPath = resolve(migrationsDirectory, migrationName);
const current = readFileSync(migrationPath, "utf8");
const marker = augmentationName === undefined ? "-- M258 REFLECTION AUTHORITY SECURITY FINALIZER" : "-- M327 REFLECTION AUTHORITY RECEIPT AUGMENTATION FINALIZER";
if (current.includes(marker)) process.exit(0);

const forceAndRoles = TABLES.flatMap((table) => [
  `ALTER TABLE "${table}" FORCE ROW LEVEL SECURITY;`,
  `REVOKE ALL ON TABLE "${table}" FROM PUBLIC, "nautilo_agent", "nautilo_crypto";`,
  `GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "${table}" TO "nautilo";`,
]).join("\n--> statement-breakpoint\n");

const finalizer = `
--> statement-breakpoint
${marker}
${forceAndRoles}
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "public"."reflection_authority_reject_immutable_change"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'Reflection authority immutable fact cannot change';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "reflection_record_authority_closure_immutable"
BEFORE UPDATE OR DELETE ON "reflection_record_authority_closure"
FOR EACH ROW EXECUTE FUNCTION "public"."reflection_authority_reject_immutable_change"();
--> statement-breakpoint
CREATE TRIGGER "reflection_record_authority_alternatives_immutable"
BEFORE UPDATE OR DELETE ON "reflection_record_authority_alternatives"
FOR EACH ROW EXECUTE FUNCTION "public"."reflection_authority_reject_immutable_change"();
--> statement-breakpoint
CREATE TRIGGER "reflection_record_authority_changes_immutable"
BEFORE UPDATE OR DELETE ON "reflection_record_authority_changes"
FOR EACH ROW EXECUTE FUNCTION "public"."reflection_authority_reject_immutable_change"();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "public"."reflection_authority_guard_block_mutation"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Reflection authority blocks cannot be deleted';
  END IF;
  IF OLD.block_id IS DISTINCT FROM NEW.block_id
     OR OLD.record_id IS DISTINCT FROM NEW.record_id
     OR OLD.terminal_leaf_handle IS DISTINCT FROM NEW.terminal_leaf_handle
     OR OLD.created_at IS DISTINCT FROM NEW.created_at
     OR (OLD.disposition, NEW.disposition) IS DISTINCT FROM ('blocked', 'purged') THEN
    RAISE EXCEPTION 'Invalid Reflection authority block transition';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "reflection_record_authority_blocks_mutation_guard"
BEFORE UPDATE OR DELETE ON "reflection_record_authority_blocks"
FOR EACH ROW EXECUTE FUNCTION "public"."reflection_authority_guard_block_mutation"();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "public"."reflection_authority_guard_projection_mutation"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Reflection authority projection generations cannot be deleted';
  END IF;
  IF OLD.record_id IS DISTINCT FROM NEW.record_id
     OR OLD.projection_generation IS DISTINCT FROM NEW.projection_generation
     OR OLD.source_change_generation IS DISTINCT FROM NEW.source_change_generation
     OR OLD.audience_set_commitment IS DISTINCT FROM NEW.audience_set_commitment
     OR OLD.computed_at IS DISTINCT FROM NEW.computed_at THEN
    RAISE EXCEPTION 'Reflection authority projection identity is immutable';
  END IF;
  IF OLD.current = false AND NEW.current = true THEN
    RAISE EXCEPTION 'Retired Reflection authority projection cannot become current';
  END IF;
  IF NEW.updated_at < OLD.updated_at THEN
    RAISE EXCEPTION 'Reflection authority projection time cannot move backward';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "reflection_record_authority_projections_mutation_guard"
BEFORE UPDATE OR DELETE ON "reflection_record_authority_projections"
FOR EACH ROW EXECUTE FUNCTION "public"."reflection_authority_guard_projection_mutation"();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "public"."reflection_authority_guard_reconciliation_mutation"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  augmenting boolean;
  checkpoint_pause boolean;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Reflection authority reconciliation receipts cannot be deleted';
  END IF;
  augmenting := OLD.state = 'complete' AND OLD.target_crypto_object_id IS NULL
    AND NEW.state IN ('crypto_complete', 'quarantined')
    AND NEW.target_crypto_object_id IS NOT NULL
    AND NEW.target_representation_generation IS NOT NULL
    AND ((NEW.target_access_namespace_ids IS NOT NULL
      AND NEW.target_audience_set_commitment IS NOT NULL)
      OR (NEW.state = 'quarantined'
        AND NEW.target_access_namespace_ids IS NULL
        AND NEW.target_audience_set_commitment IS NULL))
    AND NEW.target_crypto_retired_at IS NULL
    AND OLD.sealed_checkpoint IS NOT DISTINCT FROM NEW.sealed_checkpoint
    AND OLD.attempt_count IS NOT DISTINCT FROM NEW.attempt_count
    AND OLD.lease_token IS NOT DISTINCT FROM NEW.lease_token
    AND OLD.lease_expires_at IS NOT DISTINCT FROM NEW.lease_expires_at
    AND OLD.next_attempt_at IS NOT DISTINCT FROM NEW.next_attempt_at
    AND (NEW.failure_code IS NULL OR NEW.failure_code = 'mapping_conflict')
    AND OLD.completed_at IS NOT DISTINCT FROM NEW.completed_at
    AND OLD.former_crypto_retired_at IS NOT DISTINCT FROM NEW.former_crypto_retired_at;
  checkpoint_pause := OLD.state = 'leased'
    AND NEW.state = 'pending'
    AND OLD.lease_token IS NOT NULL
    AND OLD.lease_expires_at IS NOT NULL
    AND NEW.lease_token IS NULL
    AND NEW.lease_expires_at IS NULL
    AND NEW.next_attempt_at IS NOT NULL
    AND NEW.failure_code IS NULL
    AND NEW.sealed_checkpoint IS NOT NULL
    AND OLD.target_representation_generation IS NULL
    AND NEW.target_representation_generation IS NULL
    AND OLD.target_crypto_object_id IS NULL
    AND NEW.target_crypto_object_id IS NULL
    AND OLD.target_access_namespace_ids IS NULL
    AND NEW.target_access_namespace_ids IS NULL
    AND OLD.target_audience_set_commitment IS NULL
    AND NEW.target_audience_set_commitment IS NULL
    AND OLD.target_crypto_retired_at IS NULL
    AND NEW.target_crypto_retired_at IS NULL
    AND OLD.former_crypto_object_id IS NULL
    AND NEW.former_crypto_object_id IS NULL
    AND OLD.former_crypto_retired_at IS NULL
    AND NEW.former_crypto_retired_at IS NULL
    AND OLD.completed_at IS NULL
    AND NEW.completed_at IS NULL
    AND NEW.attempt_count = OLD.attempt_count - 1;
  IF OLD.reconciliation_id IS DISTINCT FROM NEW.reconciliation_id
     OR OLD.record_id IS DISTINCT FROM NEW.record_id
     OR OLD.expected_projection_generation IS DISTINCT FROM NEW.expected_projection_generation
     OR OLD.source_change_generation IS DISTINCT FROM NEW.source_change_generation
     OR OLD.created_at IS DISTINCT FROM NEW.created_at THEN
    RAISE EXCEPTION 'Reflection authority reconciliation identity is immutable';
  END IF;
  IF OLD.state = 'complete' AND NOT (augmenting OR (
    NEW.state = 'complete'
    AND OLD.former_crypto_object_id IS NOT NULL
    AND OLD.former_crypto_retired_at IS NULL
    AND NEW.former_crypto_retired_at IS NOT NULL
    AND OLD.sealed_checkpoint IS NOT DISTINCT FROM NEW.sealed_checkpoint
    AND OLD.attempt_count IS NOT DISTINCT FROM NEW.attempt_count
    AND OLD.lease_token IS NOT DISTINCT FROM NEW.lease_token
    AND OLD.lease_expires_at IS NOT DISTINCT FROM NEW.lease_expires_at
    AND OLD.next_attempt_at IS NOT DISTINCT FROM NEW.next_attempt_at
    AND OLD.failure_code IS NOT DISTINCT FROM NEW.failure_code
    AND OLD.target_representation_generation IS NOT DISTINCT FROM NEW.target_representation_generation
    AND OLD.target_crypto_object_id IS NOT DISTINCT FROM NEW.target_crypto_object_id
    AND OLD.former_crypto_object_id IS NOT DISTINCT FROM NEW.former_crypto_object_id
    AND OLD.completed_at IS NOT DISTINCT FROM NEW.completed_at
    AND OLD.target_access_namespace_ids IS NOT DISTINCT FROM NEW.target_access_namespace_ids
    AND OLD.target_audience_set_commitment IS NOT DISTINCT FROM NEW.target_audience_set_commitment
    AND OLD.target_crypto_retired_at IS NOT DISTINCT FROM NEW.target_crypto_retired_at
  )) THEN
    RAISE EXCEPTION 'Completed Reflection authority reconciliation is immutable except retirement acknowledgement';
  END IF;
  IF OLD.state IS DISTINCT FROM NEW.state AND NOT (augmenting OR
    (OLD.state = 'pending' AND NEW.state IN ('leased', 'crypto_complete', 'complete', 'quarantined'))
    OR (OLD.state = 'leased' AND NEW.state IN ('pending', 'crypto_complete', 'complete', 'quarantined'))
    OR (OLD.state = 'crypto_complete' AND NEW.state IN ('attached', 'complete', 'quarantined'))
    OR (OLD.state = 'attached' AND NEW.state IN ('complete', 'quarantined'))
    OR (OLD.state = 'quarantined' AND NEW.state = 'pending' AND OLD.target_crypto_object_id IS NULL)
  ) THEN
    RAISE EXCEPTION 'Invalid Reflection authority reconciliation state transition';
  END IF;
  IF (NEW.attempt_count < OLD.attempt_count AND NOT checkpoint_pause)
     OR NEW.attempt_count > OLD.attempt_count + 1 THEN
    RAISE EXCEPTION 'Invalid Reflection authority reconciliation attempt transition';
  END IF;
  IF OLD.target_crypto_object_id IS NOT NULL
     AND OLD.target_crypto_object_id IS DISTINCT FROM NEW.target_crypto_object_id THEN
    RAISE EXCEPTION 'Reflection authority target crypto identity is immutable';
  END IF;
  IF (OLD.target_representation_generation IS NOT NULL AND OLD.target_representation_generation IS DISTINCT FROM NEW.target_representation_generation)
     OR (OLD.target_access_namespace_ids IS NOT NULL AND OLD.target_access_namespace_ids IS DISTINCT FROM NEW.target_access_namespace_ids)
     OR (OLD.target_audience_set_commitment IS NOT NULL AND OLD.target_audience_set_commitment IS DISTINCT FROM NEW.target_audience_set_commitment)
     OR (OLD.target_crypto_retired_at IS NOT NULL AND OLD.target_crypto_retired_at IS DISTINCT FROM NEW.target_crypto_retired_at)
     OR (OLD.completed_at IS NOT NULL AND OLD.completed_at IS DISTINCT FROM NEW.completed_at) THEN
    RAISE EXCEPTION 'Reflection authority materialization and logical completion are immutable';
  END IF;
  IF OLD.former_crypto_object_id IS NOT NULL
     AND OLD.former_crypto_object_id IS DISTINCT FROM NEW.former_crypto_object_id THEN
    RAISE EXCEPTION 'Reflection authority former crypto identity is immutable';
  END IF;
  IF OLD.former_crypto_retired_at IS NOT NULL
     AND OLD.former_crypto_retired_at IS DISTINCT FROM NEW.former_crypto_retired_at THEN
    RAISE EXCEPTION 'Reflection authority former crypto retirement is immutable';
  END IF;
  IF NEW.updated_at < OLD.updated_at THEN
    RAISE EXCEPTION 'Reflection authority reconciliation time cannot move backward';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "reflection_record_authority_reconciliations_mutation_guard"
BEFORE UPDATE OR DELETE ON "reflection_record_authority_reconciliations"
FOR EACH ROW EXECUTE FUNCTION "public"."reflection_authority_guard_reconciliation_mutation"();
`;

// Existing migrations are immutable. A generated additive migration only
// replaces the canonical guard function; its installed trigger remains intact.
const appended = augmentationName === undefined ? finalizer
  : `\n--> statement-breakpoint\n${marker}\n${finalizer.slice(finalizer.indexOf('CREATE OR REPLACE FUNCTION "public"."reflection_authority_guard_reconciliation_mutation"()'), finalizer.indexOf('CREATE TRIGGER "reflection_record_authority_reconciliations_mutation_guard"'))}`;
writeFileSync(migrationPath, `${current.trimEnd()}${appended}\n`, "utf8");
