import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const TABLES = [
  "task_run_message_associations",
  "protected_task_execution_segment_receipts",
  "protected_task_continuation_receipts",
] as const;
export const TASK_EXECUTION_EVIDENCE_MARKER = "-- TASK_EXECUTION_EVIDENCE_AUTHORITY";
export const TASK_EXECUTION_EVIDENCE_IMMUTABILITY_MARKER =
  "-- TASK_EXECUTION_EVIDENCE_IMMUTABILITY";

/** Drizzle declares the policies; role privileges and forced RLS need SQL. */
export function finalizeTaskExecutionEvidenceMigration(migration: string): string {
  if (migration.includes(TASK_EXECUTION_EVIDENCE_MARKER)) return migration;
  const created = TABLES.filter(table => migration.includes(`CREATE TABLE "${table}"`));
  if (created.length === 0) return migration;
  const clauses = created.map(table => `ALTER TABLE "${table}" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL PRIVILEGES ON TABLE "${table}" FROM PUBLIC, "nautilo", "nautilo_agent", "nautilo_crypto";--> statement-breakpoint
GRANT SELECT, INSERT ON TABLE "${table}" TO "nautilo";`).join("\n--> statement-breakpoint\n");
  return `${migration}\n--> statement-breakpoint\n${TASK_EXECUTION_EVIDENCE_MARKER}\n${clauses}\n`;
}

/**
 * The product role owns these tables and bypasses RLS. Guard immutable rows in
 * the database while retaining only the nested DELETE/row-lock privileges
 * required by their foreign keys.
 */
export function finalizeTaskExecutionEvidenceImmutability(
  migration: string,
): string {
  if (migration.includes(TASK_EXECUTION_EVIDENCE_IMMUTABILITY_MARKER)) {
    return migration;
  }
  return `${migration}\n--> statement-breakpoint
${TASK_EXECUTION_EVIDENCE_IMMUTABILITY_MARKER}
CREATE OR REPLACE FUNCTION "public"."guard_task_execution_evidence"()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF TG_OP = 'UPDATE' OR TG_OP = 'TRUNCATE' OR pg_trigger_depth() < 2 THEN
    RAISE EXCEPTION 'Task execution evidence is immutable' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'DELETE' THEN
    IF TG_TABLE_NAME IN (
      'task_run_message_associations',
      'protected_task_execution_segment_receipts'
    ) THEN
      IF NOT EXISTS (
        SELECT 1 FROM public.task_runs WHERE id = OLD.task_run_id
      ) THEN RETURN OLD; END IF;
    END IF;
    IF TG_TABLE_NAME = 'protected_task_continuation_receipts' THEN
      IF NOT EXISTS (
        SELECT 1
        FROM public.protected_task_execution_segment_receipts
        WHERE task_run_id = OLD.task_run_id
          AND execution_segment = OLD.execution_segment
          AND job_id = OLD.job_id
      ) THEN RETURN OLD; END IF;
    END IF;
  END IF;
  RAISE EXCEPTION 'Task execution evidence is immutable' USING ERRCODE = '23514';
END;
$$;--> statement-breakpoint
GRANT TRIGGER ON TABLE
  "task_run_message_associations",
  "protected_task_execution_segment_receipts",
  "protected_task_continuation_receipts"
TO "nautilo";--> statement-breakpoint
CREATE TRIGGER "task_run_message_associations_immutable_row"
BEFORE UPDATE OR DELETE ON "task_run_message_associations"
FOR EACH ROW EXECUTE FUNCTION "public"."guard_task_execution_evidence"();--> statement-breakpoint
CREATE TRIGGER "task_run_message_associations_immutable_table"
BEFORE TRUNCATE ON "task_run_message_associations"
FOR EACH STATEMENT EXECUTE FUNCTION "public"."guard_task_execution_evidence"();--> statement-breakpoint
CREATE TRIGGER "protected_task_execution_segment_receipts_immutable_row"
BEFORE UPDATE OR DELETE ON "protected_task_execution_segment_receipts"
FOR EACH ROW EXECUTE FUNCTION "public"."guard_task_execution_evidence"();--> statement-breakpoint
CREATE TRIGGER "protected_task_execution_segment_receipts_immutable_table"
BEFORE TRUNCATE ON "protected_task_execution_segment_receipts"
FOR EACH STATEMENT EXECUTE FUNCTION "public"."guard_task_execution_evidence"();--> statement-breakpoint
CREATE TRIGGER "protected_task_continuation_receipts_immutable_row"
BEFORE UPDATE OR DELETE ON "protected_task_continuation_receipts"
FOR EACH ROW EXECUTE FUNCTION "public"."guard_task_execution_evidence"();--> statement-breakpoint
CREATE TRIGGER "protected_task_continuation_receipts_immutable_table"
BEFORE TRUNCATE ON "protected_task_continuation_receipts"
FOR EACH STATEMENT EXECUTE FUNCTION "public"."guard_task_execution_evidence"();--> statement-breakpoint
REVOKE TRIGGER ON TABLE
  "task_run_message_associations",
  "protected_task_execution_segment_receipts",
  "protected_task_continuation_receipts"
FROM "nautilo";--> statement-breakpoint
REVOKE ALL PRIVILEGES ON TABLE
  "task_run_message_associations",
  "protected_task_execution_segment_receipts",
  "protected_task_continuation_receipts"
FROM "nautilo";--> statement-breakpoint
GRANT SELECT, INSERT, DELETE ON TABLE
  "task_run_message_associations",
  "protected_task_execution_segment_receipts",
  "protected_task_continuation_receipts"
TO "nautilo";--> statement-breakpoint
GRANT UPDATE ("task_run_id")
ON TABLE "protected_task_execution_segment_receipts" TO "nautilo";--> statement-breakpoint
REVOKE ALL ON FUNCTION "public"."guard_task_execution_evidence"()
FROM PUBLIC, "nautilo_agent", "nautilo_crypto";\n`;
}

if (import.meta.main) {
  const directory = resolve(import.meta.dir, "../src/migrations");
  const journal = JSON.parse(readFileSync(resolve(directory, "meta/_journal.json"), "utf8")) as {
    entries: readonly { tag: string }[];
  };
  const latest = journal.entries.at(-1);
  if (latest === undefined) throw new Error("Migration journal is empty");
  const path = resolve(directory, `${latest.tag}.sql`);
  const source = readFileSync(path, "utf8");
  const result = process.argv.includes("--immutability")
    ? finalizeTaskExecutionEvidenceImmutability(source)
    : finalizeTaskExecutionEvidenceMigration(source);
  if (result !== source) writeFileSync(path, result);
}
