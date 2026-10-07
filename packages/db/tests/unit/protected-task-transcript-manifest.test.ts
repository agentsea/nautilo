import { describe, expect, test } from "bun:test";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";

import type { DirectDatabase } from "../../src/config/direct-database";
import { readProtectedTaskTranscriptManifestInTx } from
  "../../src/queries/task-run-message-associations";
import { taskRunMessageAssociations } from
  "../../src/schema/task-run-message-associations";
import { taskRuns } from "../../src/schema/task-runs";
import { sessionMessages } from "../../src/schema/sessions";

const TASK = "10000000-0000-4000-8000-000000000001";
const OTHER_TASK = "10000000-0000-4000-8000-000000000002";
const RUN = "20000000-0000-4000-8000-000000000001";
const OTHER_RUN = "20000000-0000-4000-8000-000000000002";
const SESSION = "30000000-0000-4000-8000-000000000001";
const THREAD = `subagent:task:${TASK}:${RUN}`;

type ManifestRow = Readonly<{
  taskRunId: string;
  sessionId: string;
  messageId: number;
  publishedRevision: number;
  kind: "transcript" | "raw_delivery" | "wake";
  publicationKey: string;
}>;

function row(overrides: Partial<ManifestRow> = {}): ManifestRow {
  return {
    taskRunId: RUN,
    sessionId: SESSION,
    messageId: 41,
    publishedRevision: 0,
    kind: "transcript",
    publicationKey: `task-transcript:${RUN}:fp:v1:abc`,
    ...overrides,
  };
}

function sqlText(value: unknown): Readonly<{ sql: string; params: unknown[] }> {
  const compiled = new PgDialect().sqlToQuery(value as SQL);
  return {
    sql: compiled.sql.replaceAll('"', "").replace(/\s+/gu, " ").trim(),
    params: compiled.params,
  };
}

function harness(input: Readonly<{
  rows?: readonly ManifestRow[];
  run?: Readonly<{ id: string; taskId: string; graphThreadId: string }> | null;
}> = {}) {
  const calls: Array<{
    selection: Record<string, unknown>;
    table?: unknown;
    where?: unknown;
    orderBy?: unknown;
    limit?: number;
  }> = [];
  const run = input.run === undefined
    ? { id: RUN, taskId: TASK, graphThreadId: THREAD }
    : input.run;
  const rows = input.rows ?? [];
  const tx = {
    select(selection: Record<string, unknown>) {
      const call = { selection } as (typeof calls)[number];
      calls.push(call);
      const query = {
        from(table: unknown) {
          call.table = table;
          return query;
        },
        where(condition: unknown) {
          call.where = condition;
          return query;
        },
        limit(value: number) {
          call.limit = value;
          return Promise.resolve(run === null ? [] : [run]);
        },
        orderBy(value: unknown) {
          call.orderBy = value;
          return Promise.resolve(rows);
        },
      };
      return query;
    },
  } as unknown as Pick<DirectDatabase, "select">;
  return { tx, calls };
}

async function manifest(
  rows: readonly ManifestRow[],
  identity: Readonly<{
    taskId: string;
    taskRunId: string;
    graphThreadId: string;
  }> = { taskId: TASK, taskRunId: RUN, graphThreadId: THREAD },
) {
  const current = harness({
    rows,
    run: {
      id: identity.taskRunId,
      taskId: identity.taskId,
      graphThreadId: identity.graphThreadId,
    },
  });
  return readProtectedTaskTranscriptManifestInTx(current.tx, identity);
}

describe("protected Task transcript manifest", () => {
  test("queries only exact run-bound transcript coordinates in Message order", async () => {
    const current = harness({ rows: [row()] });
    await readProtectedTaskTranscriptManifestInTx(current.tx, {
      taskId: TASK,
      taskRunId: RUN,
      graphThreadId: THREAD,
    });

    expect(current.calls).toHaveLength(2);
    const runQuery = current.calls[0]!;
    expect(runQuery.table).toBe(taskRuns);
    expect(Object.keys(runQuery.selection)).toEqual([
      "id", "taskId", "graphThreadId",
    ]);
    expect(runQuery.limit).toBe(1);
    const compiledRun = sqlText(runQuery.where);
    expect(compiledRun.sql).toContain("task_runs.id = $");
    expect(compiledRun.sql).toContain("task_runs.task_id = $");
    expect(compiledRun.sql).toContain("task_runs.graph_thread_id = $");
    expect(compiledRun.params).toEqual([RUN, TASK, THREAD]);

    const transcriptQuery = current.calls[1]!;
    expect(transcriptQuery.table).toBe(taskRunMessageAssociations);
    expect(Object.keys(transcriptQuery.selection)).toEqual([
      "taskRunId",
      "sessionId",
      "messageId",
      "publishedRevision",
      "kind",
      "publicationKey",
    ]);
    const compiledTranscript = sqlText(transcriptQuery.where);
    expect(compiledTranscript.sql).toContain(
      "task_run_message_associations.task_run_id = $",
    );
    expect(compiledTranscript.sql).toContain(
      "task_run_message_associations.kind = $",
    );
    expect(compiledTranscript.params).toEqual([RUN, "transcript"]);
    const compiledOrder = sqlText(transcriptQuery.orderBy);
    expect(compiledOrder.sql).toBe(
      "task_run_message_associations.message_id asc",
    );
    expect(Object.keys(transcriptQuery.selection)).not.toContain("content");
    expect(Object.values(transcriptQuery.selection)).not.toContain(
      sessionMessages.content,
    );
    expect(Object.values(transcriptQuery.selection)).not.toContain(
      sessionMessages.metadata,
    );
    expect(Object.values(transcriptQuery.selection)).not.toContain(
      sessionMessages.toolCalls,
    );
  });

  test("has deterministic empty and nonempty golden digests", async () => {
    const empty = await manifest([]);
    const nonemptyRows = [
      row(),
      row({
        messageId: 42,
        publishedRevision: 3,
        publicationKey: `task-transcript:${RUN}:fp:v1:def`,
      }),
    ];
    const first = await manifest(nonemptyRows);
    const replay = await manifest(nonemptyRows);

    expect(Buffer.from(empty.orderedDigest ?? []).toString("hex")).toBe(
      "6834f05b4659f0c55dc4cc7ffaaae557fb747f0ca4481555d7eb79f1f0ede025",
    );
    expect(Buffer.from(first.orderedDigest ?? []).toString("hex")).toBe(
      "8b418f0cd4f3f8ccee285fc7166b01e8b0b7c87824e24405381da56856352572",
    );
    expect(replay).toEqual(first);
    expect(empty).toMatchObject({
      contract: "protected_message_associations_v1",
      expectedAssociationCount: 0,
    });
    expect(first.expectedAssociationCount).toBe(2);
  });

  test("binds revisions, publication keys, and TaskRun identity", async () => {
    const baseline = await manifest([row()]);
    const revision = await manifest([row({ publishedRevision: 1 })]);
    const publication = await manifest([row({ publicationKey: "changed-key" })]);
    const identity = await manifest([row({ taskRunId: OTHER_RUN })], {
      taskId: OTHER_TASK,
      taskRunId: OTHER_RUN,
      graphThreadId: `subagent:task:${OTHER_TASK}:${OTHER_RUN}`,
    });
    const digests = [baseline, revision, publication, identity].map(value =>
      Buffer.from(value.orderedDigest ?? []).toString("hex")
    );
    expect(new Set(digests).size).toBe(digests.length);
  });

  test("rejects malformed, unordered, duplicate, and wrong-run provenance", async () => {
    const invalid = [
      [row({ sessionId: "not-a-uuid" })],
      [row({ publishedRevision: -1 })],
      [row({ publicationKey: "" })],
      [row({ messageId: 42 }), row({ messageId: 41 })],
      [row(), row()],
      [row({ taskRunId: OTHER_RUN })],
    ];
    for (const rows of invalid) {
      // eslint-disable-next-line @typescript-eslint/await-thenable -- bun expect().rejects
      await expect(readProtectedTaskTranscriptManifestInTx(
        harness({ rows }).tx,
        { taskId: TASK, taskRunId: RUN, graphThreadId: THREAD },
      )).rejects.toThrow("invalid provenance");
    }
  });

  test("rejects malformed or missing TaskRun identity before reading rows", async () => {
    // eslint-disable-next-line @typescript-eslint/await-thenable -- bun expect().rejects
    await expect(readProtectedTaskTranscriptManifestInTx(
      harness().tx,
      { taskId: "bad", taskRunId: RUN, graphThreadId: THREAD },
    )).rejects.toThrow("identity is malformed");

    const missing = harness({ run: null });
    // eslint-disable-next-line @typescript-eslint/await-thenable -- bun expect().rejects
    await expect(readProtectedTaskTranscriptManifestInTx(missing.tx, {
      taskId: TASK,
      taskRunId: RUN,
      graphThreadId: THREAD,
    })).rejects.toThrow("lost its TaskRun");
    expect(missing.calls).toHaveLength(1);
  });
});
