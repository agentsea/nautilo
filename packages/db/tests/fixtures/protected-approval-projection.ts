import { expect } from "bun:test";
import { SQL } from "drizzle-orm";
import { PgDialect, QueryBuilder, type PgTable } from "drizzle-orm/pg-core";
import { jobs, type Job } from "../../src/schema/jobs";
import { taskRuns, type TaskRun } from "../../src/schema/task-runs";
import { tasks, type Task } from "../../src/schema/tasks";

/** Evaluate the closed computed fields against full test storage rows. */
export function projectApprovalRow(table: unknown, row: unknown, selection: unknown): unknown {
  if (row === null || typeof row !== "object" || selection === null
    || typeof selection !== "object") return row;
  const values: Record<string, unknown> = { ...row };
  if (table === tasks) {
    const task = row as Task;
    values["contentPristine"] = task.lastError === null
      && (task.contentRepresentation !== "protected" || task.prompt === "" && task.expectedOutput === null);
  } else if (table === taskRuns) {
    const run = row as TaskRun;
    values["pristine"] = run.resultText === null && run.completedAt === null && run.lastError === null
      && run.resultRepresentation === "ordinary" && run.resultContentNamespaceId === null
      && run.resultRevision === 0 && run.resultCryptoObjectId === null && run.resultCryptoAccessRevision === 0
      && run.resultCryptoRequiredNamespaceFingerprint === null && run.resultCryptoMappingState === "unmapped";
  } else if (table === jobs) {
    const job = row as Job;
    values["pristine"] = job.result === null && job.message === null
      && !("nautilo.protectedTaskRunTerminal.v1" in job.metadata);
    values["metadataEmpty"] = Object.keys(job.metadata).length === 0;
    values["metadata"] = Object.fromEntries(Object.entries(job.metadata).filter(([key]) => [
      "nautilo.protectedTaskRunPark.v1", "nautilo.protectedTaskHumanContinuationAcceptance.v1",
      "nautilo.protectedTaskHumanApprovalPolicy.v1", "nautilo.protectedTaskRunTerminal.v1",
    ].includes(key)));
  }
  return Object.fromEntries(Object.keys(selection).map(key => [key, values[key]]));
}

/** jsonb_set keeps unrelated durable keys; tests inspect the actual SQL patch. */
export function applyApprovalPatch(row: Job, patch: Record<string, unknown>): Record<string, unknown> {
  const metadata = patch["metadata"];
  if (!(metadata instanceof SQL)) return patch;
  const compiled = new PgDialect().sqlToQuery(metadata);
  if (!compiled.sql.startsWith("jsonb_set(")) throw new Error("Unexpected metadata mutation");
  const [key, value] = compiled.params;
  if (typeof key !== "string" || typeof value !== "string") throw new Error("Invalid receipt patch");
  return { ...patch, metadata: { ...row.metadata, [key]: JSON.parse(value) as unknown } };
}

export function compileApprovalSelection(table: unknown, selection: unknown): string {
  return new QueryBuilder().select(selection as Record<string, SQL>)
    .from(table as PgTable).toSQL().sql;
}

export function assertApprovalSelectionsAreContentFree(selections: readonly string[]) {
  expect(selections.length).toBeGreaterThan(0);
  for (const statement of selections) {
    expect(statement).not.toMatch(/(?:select|,)\s*(?:"(?:tasks|task_runs|jobs)"\.)?"(?:prompt|expected_output|last_error|result_text|result|message|metadata|input)"\s*(?:,|from)/u);
  }
  const job = selections.find(statement => statement.endsWith('from "jobs"'));
  expect(job).toContain('CASE\n  WHEN jsonb_typeof("input")');
  expect(job).toContain("::text[]) = '{}'::jsonb");
  expect(job).toContain('"jobs"."result" is null');
  expect(job).toContain('"jobs"."message" is null');
}
