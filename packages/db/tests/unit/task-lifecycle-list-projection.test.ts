import { expect, test } from "bun:test";
import { and, asc, desc, eq, getTableColumns, sql } from "drizzle-orm";
import { TASK_FUNDING_FAILURE_CODES } from "@nautilo/types";
import { QueryBuilder, type PgTable } from "drizzle-orm/pg-core";
import type { DirectDatabase } from "../../src/config/direct-database";
import {
  getLatestResumableTaskRun,
  getProtectedTaskMutationSourceById,
  getTaskById,
  getTaskByIdWithMutationVersion,
  getTaskRuns,
  listTasksForOwner,
} from "../../src/queries/tasks";
import { tasks } from "../../src/schema/tasks";
import { taskRuns } from "../../src/schema/task-runs";

const ownerId = "72000000-0000-4000-8000-000000000001";

test("lifecycle list never selects ordinary Task bodies, including both bounded history partitions", async () => {
  const queries: string[] = [];
  const db = {
    select(fields: Parameters<QueryBuilder["select"]>[0]) {
      const query = new QueryBuilder().select(fields).from(tasks).$dynamic();
      const chain = {
        from: () => chain,
        where: (condition: Parameters<typeof query.where>[0]) => { query.where(condition); return chain; },
        orderBy: (...order: Parameters<typeof query.orderBy>) => { query.orderBy(...order); return chain; },
        limit: (limit: number) => { query.limit(limit); return chain; },
        then: (resolve: (rows: never[]) => unknown) => { queries.push(query.toSQL().sql); return Promise.resolve([]).then(resolve); },
      };
      return chain;
    },
    transaction: async (work: (tx: unknown) => unknown) => work(db),
  } as unknown as DirectDatabase;
  for (const opts of [
    {}, { status: "pending" as const }, { status: "completed" as const, includeRecentTerminal: true },
    { includeTerminal: true }, { includeTerminal: true, includeRecentTerminal: true },
  ]) await listTasksForOwner(db, ownerId, opts, { lifecycleOnly: true });
  expect(queries).toHaveLength(6);
  for (const query of queries) {
    expect(query).not.toContain('"prompt"');
    expect(query).not.toContain('"expected_output"');
    expect(query).not.toMatch(/(?:select|,)\s*"last_error"\s*(?:,|from)/u);
    expect(query).toContain("'harnessId'");
    expect(query).toContain('"tasks"."owner_id"');
    expect(query).toContain('"content_revision"');
  }
  queries.length = 0;
  await listTasksForOwner(db, ownerId);
  expect(queries[0]).toContain('"prompt"');
  expect(queries[0]).toContain('"expected_output"');
  expect(queries[0]).toContain('"last_error"');
});


function capturedDetailDb(rows: readonly unknown[] = []) {
  const queries: Array<{ sql: string; params: unknown[] }> = [];
  const db = {
    select(fields: Parameters<QueryBuilder["select"]>[0]) {
      return { from(table: PgTable) {
        const query = new QueryBuilder().select(fields).from(table).$dynamic();
        const chain = {
          where: (condition: Parameters<typeof query.where>[0]) => { query.where(condition); return chain; },
          orderBy: (...order: Parameters<typeof query.orderBy>) => { query.orderBy(...order); return chain; },
          limit: (limit: number) => { query.limit(limit); return chain; },
          then: (resolve: (rows: never[]) => unknown) => {
            queries.push(query.toSQL()); return Promise.resolve(rows as never[]).then(resolve);
          },
        };
        return chain;
      } };
    },
  } as unknown as DirectDatabase;
  return { db, queries };
}

test("protected detail selects owner-fenced Task metadata and closed Run funding diagnostics", async () => {
  const { db, queries } = capturedDetailDb();
  await getTaskById(db, ownerId, { lifecycleOnly: true, ownerId });
  await getTaskRuns(db, ownerId, { lifecycleOnly: true });
  const taskQuery = queries[0]!;
  expect(taskQuery.sql).not.toContain('"prompt"');
  expect(taskQuery.sql).not.toContain('"expected_output"');
  expect(taskQuery.sql).not.toMatch(/(?:select|,)\s*"last_error"\s*(?:,|from)/u);
  expect(taskQuery.sql).not.toMatch(/[, ]"metadata"[, ]/u);
  expect(taskQuery.sql).toContain('"tasks"."owner_id" =');
  expect(taskQuery.params.filter(value => value === ownerId)).toHaveLength(2);
  expect(taskQuery.sql).toContain("'harnessId'");
  const runQuery = queries[1]!;
  expect(runQuery.sql).not.toContain('"result_text"');
  expect(runQuery.sql).not.toMatch(/(?:select|,)\s*"last_error"\s*(?:,|from)/u);
  expect(runQuery.sql).toContain('CASE WHEN "task_runs"."last_error" in');
  expect(runQuery.sql).toContain('ELSE NULL END');
  expect(runQuery.params).toEqual([...TASK_FUNDING_FAILURE_CODES, ownerId]);
  expect(runQuery.sql).toContain('"funding_binding"');
  expect(runQuery.sql).toContain('order by "task_runs"."started_at" asc');
});

test("protected mutation snapshot adds tuple identity without selecting Task bodies", async () => {
  const { db, queries } = capturedDetailDb();
  await getTaskByIdWithMutationVersion(db, ownerId, { lifecycleOnly: true, ownerId });
  const query = queries[0]!;
  expect(query.sql).not.toContain('"prompt"');
  expect(query.sql).not.toContain('"expected_output"');
  expect(query.sql).toContain('xmin::text');
  expect(query.sql).toContain('"tasks"."owner_id" =');
  expect(query.params.filter(value => value === ownerId)).toHaveLength(2);
});

test("protected mutation source selects every operational coordinate without ordinary content", async () => {
  const { db, queries } = capturedDetailDb();
  await getProtectedTaskMutationSourceById(db, ownerId, ownerId);
  const query = queries[0]!;
  const selection = query.sql.slice(0, query.sql.indexOf(" from "));
  expect(selection).not.toContain('"prompt"');
  expect(selection).not.toContain('"expected_output"');
  expect(selection).not.toContain('"last_error"');
  expect(selection).not.toMatch(/"tasks"\."metadata"(?:,|\s+as\s+"metadata")/u);
  for (const protectedInputField of [
    "workingDirectory", "subject", "toolName", "operation", "reportLanguage",
  ]) expect(query.params.filter(value => value === protectedInputField)).toHaveLength(1);
  expect(query.params).not.toContain("privateCanary");
  for (const field of [
    "execution", "harnessModelId", "readiness", "preparation", "researchWork",
    "reviewDecision", "deepResearch", "modelPlan", "modelFunding", "tavilyFunding",
    "credentialRevision", "writerReviewAcceptedReceipt", "acceptedResultRevision",
    "sha256",
  ]) expect(query.params).toContain(field);
  expect(selection).toContain("jsonb_typeof");
  for (const column of [
    "target_chat_handle",
    "funding_mode",
    "local_execution_delegation",
    "content_namespace_id",
    "crypto_required_namespace_fingerprint",
    "ordinary_fallback_operation_id",
    "ordinary_fallback_request_digest",
    "ordinary_fallback_reason",
    "ordinary_fallback_policy_revision",
    "ordinary_fallback_completed_at",
    "updated_at",
  ]) {
    expect(selection).toContain(`"${column}"`);
  }
  expect(selection).toContain("xmin::text");
  expect(query.sql).toContain('"tasks"."owner_id" =');
  expect(query.params.filter(value => value === ownerId)).toHaveLength(2);
});

test("protected funding reads only the newest resumable Run coordinates", async () => {
  const paused = {
    id: "73000000-0000-4000-8000-000000000001",
    taskId: ownerId,
    jobId: "74000000-0000-4000-8000-000000000001",
    graphThreadId: "thread-1",
    status: "paused" as const,
    modelId: "openai/gpt-5.2",
    fundingBinding: null,
    fundingPredecessorRunId: null,
  };
  const captured = capturedDetailDb([paused]);
  expect(await getLatestResumableTaskRun(captured.db, ownerId, { fundingOnly: true }))
    .toEqual(paused);
  const query = captured.queries[0]!;
  expect(query.sql).not.toContain('"result_text"');
  expect(query.sql).not.toContain('"last_error"');
  expect(query.sql.slice(0, query.sql.indexOf(" from "))).toBe([
    'select "id", "task_id", "job_id", "graph_thread_id", "status", "model_id",',
    '"funding_binding", "funding_predecessor_run_id"',
  ].join(" "));
  expect(query.sql).toContain('order by "task_runs"."started_at" desc limit');

  const completed = capturedDetailDb([{ ...paused, status: "completed" }]);
  expect(await getLatestResumableTaskRun(completed.db, ownerId, { fundingOnly: true }))
    .toBeUndefined();
});

test("ordinary detail query text and ordering remain the original full-row contract", async () => {
  const { db, queries } = capturedDetailDb();
  await getTaskById(db, ownerId);
  await getTaskRuns(db, ownerId);
  await getLatestResumableTaskRun(db, ownerId);
  await getTaskByIdWithMutationVersion(db, ownerId);
  expect(queries[0]).toEqual(new QueryBuilder().select().from(tasks)
    .where(and(eq(tasks.id, ownerId))).limit(1).toSQL());
  expect(queries[1]).toEqual(new QueryBuilder().select().from(taskRuns)
    .where(eq(taskRuns.taskId, ownerId)).orderBy(asc(taskRuns.startedAt)).toSQL());
  expect(queries[2]).toEqual(new QueryBuilder().select().from(taskRuns)
    .where(eq(taskRuns.taskId, ownerId)).orderBy(desc(taskRuns.startedAt)).limit(1).toSQL());
  expect(queries[3]).toEqual(new QueryBuilder().select({
    ...getTableColumns(tasks),
    mutationVersion: sql<string>`${tasks}.xmin::text`,
  }).from(tasks).where(and(eq(tasks.id, ownerId))).limit(1).toSQL());
});
