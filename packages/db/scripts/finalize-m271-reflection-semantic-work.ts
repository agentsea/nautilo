import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

export const M271_REFLECTION_SEMANTIC_WORK_SECURITY_MARKER =
  "-- M271 REFLECTION SEMANTIC WORK SECURITY FINALIZER";

const TABLES = [
  "reflection_record_source_dependency_index",
  "reflection_record_semantic_work_admissions",
  "reflection_record_source_change_repairs",
  "reflection_record_semantic_work",
] as const;

const forceRls = TABLES.map(
  (table) => `ALTER TABLE "${table}" FORCE ROW LEVEL SECURITY;`,
).join("\n--> statement-breakpoint\n");

const privileges = TABLES.map(
  (table) => [
    `REVOKE ALL ON TABLE "${table}" FROM PUBLIC, "nautilo_agent", "nautilo_crypto";`,
    `GRANT SELECT, INSERT, UPDATE${
      table === "reflection_record_source_change_repairs" ? "" : ", DELETE"
    } ON TABLE "${table}" TO "nautilo";`,
  ].join("\n--> statement-breakpoint\n"),
).join("\n--> statement-breakpoint\n");

const finalizer = `${M271_REFLECTION_SEMANTIC_WORK_SECURITY_MARKER}
${forceRls}
--> statement-breakpoint
${privileges}
--> statement-breakpoint
CREATE FUNCTION "public"."reflection_semantic_receipt_reject_change"()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog AS $$
BEGIN
  RAISE EXCEPTION 'Reflection semantic index and admission receipts are immutable'
    USING ERRCODE = '23514';
END;
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION "public"."reflection_semantic_receipt_reject_change"()
  FROM PUBLIC, "nautilo_agent", "nautilo_crypto";--> statement-breakpoint
GRANT EXECUTE ON FUNCTION "public"."reflection_semantic_receipt_reject_change"()
  TO "nautilo";--> statement-breakpoint
CREATE TRIGGER "reflection_record_source_dependency_index_immutable"
BEFORE UPDATE OR DELETE ON "reflection_record_source_dependency_index"
FOR EACH ROW EXECUTE FUNCTION "public"."reflection_semantic_receipt_reject_change"();--> statement-breakpoint
CREATE TRIGGER "reflection_record_semantic_work_admissions_immutable"
BEFORE UPDATE OR DELETE ON "reflection_record_semantic_work_admissions"
FOR EACH ROW EXECUTE FUNCTION "public"."reflection_semantic_receipt_reject_change"();--> statement-breakpoint
CREATE FUNCTION "public"."reflection_source_change_repair_guard_update"()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog AS $$
BEGIN
  IF NEW.source_change_commitment IS DISTINCT FROM OLD.source_change_commitment
     OR NEW.source_dependency_commitment IS DISTINCT FROM OLD.source_dependency_commitment
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR NEW.updated_at < OLD.updated_at
     OR OLD.completed_at IS NOT NULL
     OR (NEW.completed_at IS NULL AND OLD.continuation IS NOT NULL AND (
       NEW.continuation IS NULL OR NEW.continuation <= OLD.continuation
     )) THEN
    RAISE EXCEPTION 'Reflection source repair identity and cursor are monotonic'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION "public"."reflection_source_change_repair_guard_update"()
  FROM PUBLIC, "nautilo_agent", "nautilo_crypto";--> statement-breakpoint
GRANT EXECUTE ON FUNCTION "public"."reflection_source_change_repair_guard_update"()
  TO "nautilo";--> statement-breakpoint
CREATE TRIGGER "reflection_record_source_change_repairs_update_guard"
BEFORE UPDATE ON "reflection_record_source_change_repairs" FOR EACH ROW
EXECUTE FUNCTION "public"."reflection_source_change_repair_guard_update"();--> statement-breakpoint
CREATE FUNCTION "public"."reflection_semantic_work_guard_update"()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog AS $$
BEGIN
  IF NEW.record_id IS DISTINCT FROM OLD.record_id
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR NEW.generation < OLD.generation
     OR NEW.completed_generation < OLD.completed_generation
     OR NEW.updated_at < OLD.updated_at THEN
    RAISE EXCEPTION 'Reflection semantic work identity and generations are monotonic'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.generation > OLD.generation THEN
    IF NEW.generation <> OLD.generation + 1
       OR NEW.stage <> 'authority_projection'
       OR NEW.state <> 'due'
       OR NEW.completed_generation <> OLD.completed_generation
       OR NEW.attempt_count <> 0
       OR NEW.claim_generation IS NOT NULL
       OR NEW.lease_token IS NOT NULL
       OR NEW.lease_expires_at IS NOT NULL
       OR NEW.next_attempt_at IS NULL
       OR NEW.failure_code IS NOT NULL
       OR NEW.completed_at IS NOT NULL
       OR NEW.due_since < OLD.due_since THEN
      RAISE EXCEPTION 'New Reflection semantic work generation must advance exactly once and reset to due authority projection'
        USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;

  IF (CASE NEW.change_reason
       WHEN 'created' THEN 1
       WHEN 'revised' THEN 2
       WHEN 'dependency_lost' THEN 3
     END) < (CASE OLD.change_reason
       WHEN 'created' THEN 1
       WHEN 'revised' THEN 2
       WHEN 'dependency_lost' THEN 3
     END) THEN
    RAISE EXCEPTION 'Reflection semantic work reason cannot weaken within a generation'
      USING ERRCODE = '23514';
  END IF;

  IF OLD.state IN ('complete', 'quarantined') AND NEW IS DISTINCT FROM OLD THEN
    RAISE EXCEPTION 'Terminal Reflection semantic work requires a newer generation'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.stage IS DISTINCT FROM OLD.stage AND NOT (
    OLD.state = 'claimed'
    AND NEW.state = 'checkpointed'
    AND (
      (OLD.stage = 'authority_projection' AND NEW.stage = 'search_projection')
      OR (OLD.stage = 'search_projection' AND NEW.stage = 'organization')
    )
  ) THEN
    RAISE EXCEPTION 'Invalid Reflection semantic work stage checkpoint'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.state IS DISTINCT FROM OLD.state AND NOT (
    (OLD.state IN ('due', 'checkpointed', 'deferred', 'claimed')
      AND NEW.state = 'claimed')
    OR (OLD.state = 'claimed'
      AND NEW.state IN ('due', 'checkpointed', 'deferred', 'complete', 'quarantined'))
    OR (OLD.state IN ('due', 'checkpointed', 'deferred')
      AND NEW.state = 'quarantined')
  ) THEN
    RAISE EXCEPTION 'Invalid Reflection semantic work state transition'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION "public"."reflection_semantic_work_guard_update"()
  FROM PUBLIC, "nautilo_agent", "nautilo_crypto";--> statement-breakpoint
GRANT EXECUTE ON FUNCTION "public"."reflection_semantic_work_guard_update"()
  TO "nautilo";--> statement-breakpoint
CREATE TRIGGER "reflection_record_semantic_work_update_guard"
BEFORE UPDATE ON "reflection_record_semantic_work" FOR EACH ROW
EXECUTE FUNCTION "public"."reflection_semantic_work_guard_update"();`;

export function finalizeM271ReflectionSemanticWorkMigration(
  migration: string,
): string {
  if (!TABLES.every((table) => migration.includes(`CREATE TABLE "${table}"`))) {
    return migration;
  }
  if (migration.includes(M271_REFLECTION_SEMANTIC_WORK_SECURITY_MARKER)) {
    return migration;
  }
  return `${migration}${migration.endsWith("\n") ? "" : "\n"}--> statement-breakpoint
${finalizer}
`;
}

export const M287_RECORD_DEPENDENCY_REPAIR_SECURITY_MARKER =
  "-- M287 RECORD DEPENDENCY REPAIR SECURITY FINALIZER";

const RECORD_DEPENDENCY_REPAIR_TABLE =
  "reflection_record_dependency_change_repairs";

const recordDependencyRepairFinalizer = `${M287_RECORD_DEPENDENCY_REPAIR_SECURITY_MARKER}
ALTER TABLE "${RECORD_DEPENDENCY_REPAIR_TABLE}" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL ON TABLE "${RECORD_DEPENDENCY_REPAIR_TABLE}" FROM PUBLIC, "nautilo_agent", "nautilo_crypto";--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON TABLE "${RECORD_DEPENDENCY_REPAIR_TABLE}" TO "nautilo";--> statement-breakpoint
CREATE FUNCTION "public"."reflection_record_dependency_repair_guard_update"()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog AS $$
BEGIN
  IF NEW.change_commitment IS DISTINCT FROM OLD.change_commitment
     OR NEW.changed_record_id IS DISTINCT FROM OLD.changed_record_id
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR NEW.updated_at < OLD.updated_at
     OR OLD.completed_at IS NOT NULL
     OR (NEW.completed_at IS NULL AND OLD.continuation IS NOT NULL AND (
       NEW.continuation IS NULL OR NEW.continuation <= OLD.continuation
     )) THEN
    RAISE EXCEPTION 'Reflection Record dependency repair identity and cursor are monotonic'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION "public"."reflection_record_dependency_repair_guard_update"()
  FROM PUBLIC, "nautilo_agent", "nautilo_crypto";--> statement-breakpoint
GRANT EXECUTE ON FUNCTION "public"."reflection_record_dependency_repair_guard_update"()
  TO "nautilo";--> statement-breakpoint
CREATE TRIGGER "reflection_record_dependency_change_repairs_update_guard"
BEFORE UPDATE ON "${RECORD_DEPENDENCY_REPAIR_TABLE}" FOR EACH ROW
EXECUTE FUNCTION "public"."reflection_record_dependency_repair_guard_update"();`;

export function finalizeM287RecordDependencyRepairMigration(
  migration: string,
): string {
  if (!migration.includes(`CREATE TABLE "${RECORD_DEPENDENCY_REPAIR_TABLE}"`)) {
    return migration;
  }
  if (migration.includes(M287_RECORD_DEPENDENCY_REPAIR_SECURITY_MARKER)) {
    return migration;
  }
  return `${migration}${migration.endsWith("\n") ? "" : "\n"}--> statement-breakpoint
${recordDependencyRepairFinalizer}
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
  const finalized = finalizeM287RecordDependencyRepairMigration(
    finalizeM271ReflectionSemanticWorkMigration(migration),
  );
  if (finalized !== migration) writeFileSync(migrationPath, finalized, "utf8");
}

if (import.meta.main) run();
