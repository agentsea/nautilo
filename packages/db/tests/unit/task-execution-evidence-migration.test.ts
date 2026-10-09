import { describe, expect, test } from "bun:test";
import { getTableConfig } from "drizzle-orm/pg-core";
import {
  finalizeTaskExecutionEvidenceImmutability,
  finalizeTaskExecutionEvidenceMigration,
} from "../../scripts/finalize-task-execution-evidence";
import { taskRunMessageAssociations } from "../../src/schema/task-run-message-associations";

describe("Task execution evidence authority", () => {
  test("leaves unrelated migrations untouched and finalizes once", () => {
    const unrelated = 'CREATE TABLE "unrelated" (id integer);';
    expect(finalizeTaskExecutionEvidenceMigration(unrelated)).toBe(unrelated);
    const generated = 'CREATE TABLE "task_run_message_associations" (message_id integer);';
    const finalized = finalizeTaskExecutionEvidenceMigration(generated);
    expect(finalizeTaskExecutionEvidenceMigration(finalized)).toBe(finalized);
    expect(finalized).toContain('FORCE ROW LEVEL SECURITY');
    expect(finalized).toContain('FROM PUBLIC, "nautilo", "nautilo_agent", "nautilo_crypto"');
    expect(finalized).toContain('GRANT SELECT, INSERT ON TABLE');
    expect(finalized).not.toContain('GRANT UPDATE');
    expect(finalized).not.toContain('GRANT DELETE');
  });

  test("receipt policies grant only product-role read and insert", () => {
    const table = getTableConfig(taskRunMessageAssociations);
    expect(table.enableRLS).toBe(true);
    expect(table.policies.map(policy => policy.for).sort()).toEqual(["insert", "select"]);
    expect(table.checks.some(check => check.name === "task_run_message_associations_kind_valid")).toBe(true);
  });

  test("guards direct mutation while retaining exact FK cascade privileges", () => {
    const source = "-- generated custom migration";
    const finalized = finalizeTaskExecutionEvidenceImmutability(source);
    expect(finalizeTaskExecutionEvidenceImmutability(finalized)).toBe(finalized);
    expect(finalized.startsWith(source)).toBe(true);
    expect(finalized).toContain("TG_OP = 'UPDATE' OR TG_OP = 'TRUNCATE'");
    expect(finalized).toContain("pg_trigger_depth() < 2");
    expect(finalized).toContain(
      "SELECT 1 FROM public.task_runs WHERE id = OLD.task_run_id",
    );
    expect(finalized).toContain(
      "'protected_task_execution_segment_receipts'\n    ) THEN\n      IF NOT EXISTS (",
    );
    expect(finalized).toContain(
      "IF TG_TABLE_NAME = 'protected_task_continuation_receipts' THEN\n      IF NOT EXISTS (",
    );
    expect(finalized).toContain(
      "FROM public.protected_task_execution_segment_receipts",
    );
    expect(finalized).toContain(
      "task_run_id = OLD.task_run_id\n          AND execution_segment = OLD.execution_segment\n          AND job_id = OLD.job_id",
    );
    for (const table of [
      "task_run_message_associations",
      "protected_task_execution_segment_receipts",
      "protected_task_continuation_receipts",
    ]) {
      expect(finalized).toContain(`CREATE TRIGGER "${table}_immutable_row"`);
      expect(finalized).toContain(`CREATE TRIGGER "${table}_immutable_table"`);
    }
    expect(finalized).toContain("GRANT SELECT, INSERT, DELETE ON TABLE");
    expect(finalized).toContain(
      'GRANT UPDATE ("task_run_id")\nON TABLE "protected_task_execution_segment_receipts" TO "nautilo"',
    );
    expect(finalized).not.toContain(
      'GRANT UPDATE ON TABLE "task_run_message_associations"',
    );
    expect(finalized).not.toContain(
      'GRANT UPDATE ON TABLE "protected_task_continuation_receipts"',
    );
  });
});
