import { describe, expect, test } from "bun:test";
import { getTableName } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";

import type { DirectDatabase } from "../../src/config/direct-database";
import {
  getUnstartedProtectedTaskRunRecoveryBoundary,
  listUnstartedProtectedTaskRunRecoveryCandidates,
  recoverUnstartedProtectedTaskRun,
} from "../../src/queries/protected-task-preexecution";
import { protectedTaskRunResultObjectId } from
  "../../src/queries/protected-task-output-binding-identities";
import type {
  ProtectedTaskDurableJobReference,
  StartProtectedTaskRunInput,
} from "../../src/queries/tasks";
import { encryptionTransitionPolicy } from
  "../../src/schema/encryption-transition";
import { jobs } from "../../src/schema/jobs";
import { protectedTaskContinuationReceipts } from
  "../../src/schema/protected-task-continuation-receipts";
import { protectedTaskExecutionSegmentReceipts } from
  "../../src/schema/protected-task-execution-segment-receipts";
import { protectedTaskRunOutputBindings } from
  "../../src/schema/protected-task-run-output-bindings";
import { taskRuns } from "../../src/schema/task-runs";
import { tasks } from "../../src/schema/tasks";

const ids = {
  task: "10000000-0000-4000-8000-000000000001",
  run: "20000000-0000-4000-8000-000000000002",
  job: "30000000-0000-4000-8000-000000000003",
  replacement: "30000000-0000-4000-8000-000000000004",
  owner: "40000000-0000-4000-8000-000000000004",
  namespace: "60000000-0000-4000-8000-000000000006",
};
const graphThreadId = `subagent:${ids.task}:${ids.run}`;
const objectId = `task-definition:v1:${"a".repeat(64)}`;
const fingerprint = new Uint8Array(Array.from({ length: 32 }, (_, index) => index));

function reference(
  overrides: Partial<ProtectedTaskDurableJobReference> = {},
): ProtectedTaskDurableJobReference {
  return {
    kind: "protected_task_run_v1",
    taskId: ids.task,
    taskRunId: ids.run,
    inputObjectId: objectId,
    resultObjectId: protectedTaskRunResultObjectId(ids.task, ids.run),
    authorizationRequestId: `task-run-authorization:${ids.run}`,
    policyRevision: 9,
    executionSegment: 1,
    ...overrides,
  };
}

function input(
  overrides: Partial<StartProtectedTaskRunInput> = {},
): StartProtectedTaskRunInput {
  return {
    taskId: ids.task,
    taskRunId: ids.run,
    graphThreadId,
    jobId: ids.job,
    contentRepresentation: "protected",
    contentNamespaceId: ids.namespace,
    contentRevision: 4,
    cryptoObjectId: objectId,
    cryptoAccessRevision: 6,
    cryptoRequiredNamespaceFingerprint: fingerprint,
    jobReference: reference(),
    ...overrides,
  };
}

function taskRow(overrides: Record<string, unknown> = {}) {
  return {
    id: ids.task,
    requestorId: ids.owner,
    callingRoomId: null,
    resultDelivery: "wake",
    scheduleKind: "now",
    status: "running",
    contentRepresentation: "protected",
    contentNamespaceId: ids.namespace,
    contentRevision: 4,
    cryptoObjectId: objectId,
    cryptoAccessRevision: 6,
    cryptoRequiredNamespaceFingerprint: fingerprint,
    cryptoMappingState: "verified",
    contentPristine: true,
    ...overrides,
  };
}

function runRow(overrides: Record<string, unknown> = {}) {
  return {
    id: ids.run,
    taskId: ids.task,
    jobId: ids.job,
    graphThreadId,
    status: "running",
    modelId: null,
    fundingPristine: true,
    pristine: true,
    ...overrides,
  };
}

function jobRow(overrides: Record<string, unknown> = {}) {
  return {
    id: ids.job,
    ownerId: ids.owner,
    requestorId: ids.owner,
    laneKey: `task:${ids.task}`,
    type: "foreground",
    status: "cancelled",
    reference: reference(),
    startedAt: null,
    completedAt: new Date("2026-10-08T08:01:00.000Z"),
    pristine: true,
    ...overrides,
  };
}

function outputRow(overrides: Record<string, unknown> = {}) {
  return {
    taskRunId: ids.run,
    bindingId: `task-run-output:${ids.run}`,
    deliveryMode: "none",
    destinationRoomId: null,
    destinationNamespaceId: null,
    resultOperationId: `task-run-result:${ids.run}`,
    resultObjectId: protectedTaskRunResultObjectId(ids.task, ids.run),
    messageOperationId: null,
    wakeOperationId: null,
    acceptedPolicyRevision: 9,
    resultTerminalAt: null,
    resultAttachedAt: null,
    messageId: null,
    messagePublishedAt: null,
    wakeJobId: null,
    wakeScheduledAt: null,
    completedAt: null,
    ...overrides,
  };
}

type HarnessOptions = Readonly<{
  task?: ReturnType<typeof taskRow>;
  run?: ReturnType<typeof runRow>;
  job?: ReturnType<typeof jobRow>;
  output?: ReturnType<typeof outputRow>;
  segmentReceipt?: boolean;
  continuationReceipt?: boolean;
}>;

function harness(options: HarnessOptions = {}) {
  let currentTask = options.task ?? taskRow();
  let currentRun = options.run ?? runRow();
  const currentJob = options.job ?? jobRow();
  const currentOutput = options.output ?? outputRow();
  const events: string[] = [];
  const writes: Array<{ table: unknown; patch: Record<string, unknown> }> = [];

  const rows = (table: unknown): unknown[] => {
    if (table === encryptionTransitionPolicy) {
      return [{ mode: "encrypted_only", shadowBehavior: "strict", revision: 41 }];
    }
    if (table === tasks) return [currentTask];
    if (table === taskRuns) return [currentRun];
    if (table === protectedTaskRunOutputBindings) return [currentOutput];
    if (table === jobs) return [currentJob];
    if (table === protectedTaskExecutionSegmentReceipts) {
      return options.segmentReceipt ? [{ taskRunId: ids.run }] : [];
    }
    if (table === protectedTaskContinuationReceipts) {
      return options.continuationReceipt ? [{ taskRunId: ids.run }] : [];
    }
    throw new Error("unexpected table");
  };

  const tx = {
    execute: async () => { events.push("policy-fence"); },
    select: () => ({
      from: (table: unknown) => {
        let selected = rows(table);
        const query = {
          where: (_condition: unknown) => query,
          limit: (_limit: number) => query,
          for: async (kind: string) => {
            events.push(`lock:${getTableName(table as typeof tasks)}:${kind}`);
            return selected;
          },
          then: <TResult1 = unknown[], TResult2 = never>(
            onfulfilled?: ((value: unknown[]) => TResult1 | PromiseLike<TResult1>) | null,
            onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
          ) => Promise.resolve(selected).then(onfulfilled, onrejected),
        };
        if (table === encryptionTransitionPolicy) selected = rows(table);
        return query;
      },
    }),
    update: (table: unknown) => ({
      set: (patch: Record<string, unknown>) => ({
        where: (_condition: unknown) => ({
          returning: async () => {
            writes.push({ table, patch });
            if (table === taskRuns) {
              currentRun = { ...currentRun, ...patch };
              return [{ id: ids.run }];
            }
            if (table === tasks) {
              currentTask = { ...currentTask, ...patch };
              return [{ id: ids.task }];
            }
            throw new Error("unexpected update");
          },
        }),
      }),
    }),
  };
  const db = {
    transaction: async <T>(operation: (value: typeof tx) => Promise<T>) =>
      operation(tx),
  } as unknown as DirectDatabase;
  return { db, events, writes };
}

describe("protected Task pre-execution recovery", () => {
  test("fences current policy, proves exact rows, defers authority, then resets", async () => {
    const fixture = harness();
    const result = await recoverUnstartedProtectedTaskRun(
      fixture.db,
      input(),
      async () => {
        fixture.events.push("defer-authority");
        return true;
      },
    );

    expect(result).toEqual({ status: "deferred" });
    expect(fixture.events).toEqual([
      "policy-fence",
      "lock:tasks:update",
      "lock:task_runs:update",
      "lock:protected_task_run_output_bindings:update",
      "lock:jobs:update",
      "defer-authority",
    ]);
    expect(fixture.writes.map(({ table, patch }) => ({
      table,
      status: patch["status"],
      jobId: patch["jobId"],
    }))).toEqual([
      { table: taskRuns, status: "awaiting", jobId: null },
      { table: tasks, status: "awaiting", jobId: undefined },
    ]);
  });

  test("recognizes only an exact already-reset replay and preserves newer links", async () => {
    const replay = harness({
      task: taskRow({ status: "awaiting" }),
      run: runRow({ status: "awaiting", jobId: null }),
    });
    expect(await recoverUnstartedProtectedTaskRun(
      replay.db,
      input(),
      async () => true,
    )).toEqual({ status: "exact_replay" });
    expect(replay.writes).toEqual([]);

    const replacement = harness({
      task: taskRow({ status: "awaiting" }),
      run: runRow({ status: "awaiting", jobId: ids.replacement }),
    });
    let called = 0;
    expect(await recoverUnstartedProtectedTaskRun(
      replacement.db,
      input(),
      async () => { called += 1; return true; },
    )).toEqual({ status: "stale" });
    expect(called).toBe(0);
    expect(replacement.writes).toEqual([]);
  });

  test("does not invoke authorization after any failed durable proof", async () => {
    const cases: HarnessOptions[] = [
      { run: runRow({ modelId: "openai:gpt-test" }) },
      { output: outputRow({ resultAttachedAt: new Date() }) },
      { segmentReceipt: true },
      { continuationReceipt: true },
      { job: jobRow({ startedAt: new Date() }) },
      { job: jobRow({ reference: { ...reference(), taskRunId: "substitute" } }) },
      { job: jobRow({ pristine: false }) },
    ];
    for (const options of cases) {
      const fixture = harness(options);
      let called = 0;
      expect(await recoverUnstartedProtectedTaskRun(
        fixture.db,
        input(),
        async () => { called += 1; return true; },
      )).toEqual({ status: "stale" });
      expect(called).toBe(0);
      expect(fixture.writes).toEqual([]);
    }
  });

  test("leaves product rows unchanged when authorization cannot be fenced", async () => {
    const fixture = harness();
    expect(await recoverUnstartedProtectedTaskRun(
      fixture.db,
      input(),
      async () => false,
    )).toEqual({ status: "stale" });
    expect(fixture.writes).toEqual([]);
  });

  test("rejects continuation coordinates before opening a transaction", async () => {
    let transactions = 0;
    const db = {
      transaction: () => { transactions += 1; throw new Error("unexpected"); },
    } as unknown as DirectDatabase;
    const failure = await recoverUnstartedProtectedTaskRun(db, input({
      jobReference: reference({
        executionSegment: 2,
        resumeAcceptanceId: "acceptance",
      }),
    }), async () => true).then(() => null, (error: unknown) => error);
    expect(failure).toBeInstanceOf(TypeError);
    expect(transactions).toBe(0);
  });
});

describe("protected Task pre-execution recovery discovery", () => {
  test("uses a bounded stable keyset and returns only content-free coordinates", async () => {
    let whereSql: Parameters<PgDialect["sqlToQuery"]>[0] | undefined;
    let selectedLimit: number | undefined;
    let selection: Record<string, unknown> | undefined;
    const projected = {
      task: taskRow(),
      run: runRow(),
      job: jobRow({ status: "queued", completedAt: null }),
      cursorCreatedAt: "2026-10-08 08:00:00.123456",
    };
    const query = {
      innerJoin: () => query,
      leftJoin: () => query,
      where: (condition: Parameters<PgDialect["sqlToQuery"]>[0]) => {
        whereSql = condition;
        return query;
      },
      orderBy: () => query,
      limit: async (limit: number) => {
        selectedLimit = limit;
        return [projected];
      },
    };
    const db = {
      select: (fields: Record<string, unknown>) => {
        selection = fields;
        return { from: () => query };
      },
    } as unknown as DirectDatabase;
    const result = await listUnstartedProtectedTaskRunRecoveryCandidates(db, {
      limit: 7,
      through: {
        createdAt: "2026-10-08 09:00:00.654321",
        jobId: "f0000000-0000-4000-8000-00000000000f",
      },
      after: {
        createdAt: "2026-10-08 07:00:00.000001",
        jobId: "00000000-0000-4000-8000-000000000001",
      },
    });

    expect(selectedLimit).toBe(7);
    expect(result).toEqual({
      candidates: [{
        route: "initial",
        input: input(),
        jobStatus: "queued",
        cursor: {
          createdAt: projected.cursorCreatedAt,
          jobId: ids.job,
        },
      }],
      continuation: undefined,
    });
    const rendered = new PgDialect().sqlToQuery(whereSql!);
    expect(rendered.sql).toContain('"tasks"."content_representation" in');
    expect(rendered.sql).toContain('"task_runs"."status" =');
    expect(rendered.sql).toContain('"task_runs"."model_id" is null');
    expect(rendered.sql).toContain('"jobs"."started_at" is null');
    expect(rendered.sql).toContain("case");
    expect(rendered.sql).toContain("::bigint <= 2147483647");
    expect(rendered.sql).toContain('"jobs"."created_at" <');
    expect(rendered.sql).toContain('"jobs"."created_at" >');
    expect(rendered.params).toContain("queued");
    expect(rendered.params).toContain("cancelled");
    const selectedNames = JSON.stringify([
      ...Object.keys(selection?.["task"] as Record<string, unknown>),
      ...Object.keys(selection?.["run"] as Record<string, unknown>),
      ...Object.keys(selection?.["job"] as Record<string, unknown>),
    ]);
    expect(selectedNames).not.toContain("prompt");
    expect(selectedNames).not.toContain("expectedOutput");
    expect(selectedNames).not.toContain("resultText");
    expect(selectedNames).not.toContain("metadata");
  });

  test("freezes the newest eligible Job as a database-precision boundary", async () => {
    const boundary = {
      createdAt: "2026-10-08 09:00:00.654321",
      jobId: ids.job,
    };
    let whereSql: Parameters<PgDialect["sqlToQuery"]>[0] | undefined;
    const query = {
      innerJoin: () => query,
      leftJoin: () => query,
      where: (condition: Parameters<PgDialect["sqlToQuery"]>[0]) => {
        whereSql = condition;
        return query;
      },
      orderBy: () => query,
      limit: async () => [boundary],
    };
    const db = {
      select: () => ({ from: () => query }),
    } as unknown as DirectDatabase;

    expect(await getUnstartedProtectedTaskRunRecoveryBoundary(db))
      .toEqual(boundary);
    const rendered = new PgDialect().sqlToQuery(whereSql!);
    expect(rendered.sql).toContain('"jobs"."status" in');
    expect(rendered.sql).toContain('"jobs"."started_at" is null');
    expect(rendered.sql).toContain('"jobs"."completed_at" is not null');
  });

  test("advances across a full invalid page before returning a later valid row", async () => {
    const invalidCursor = {
      createdAt: "2026-10-08 08:00:00.000001",
      jobId: "30000000-0000-4000-8000-000000000001",
    };
    const validCursor = {
      createdAt: "2026-10-08 08:00:00.000002",
      jobId: ids.job,
    };
    let page = 0;
    const query = {
      innerJoin: () => query,
      leftJoin: () => query,
      where: () => query,
      orderBy: () => query,
      limit: async () => {
        page += 1;
        return page === 1 ? [{
          task: taskRow(),
          run: runRow(),
          job: jobRow({
            id: invalidCursor.jobId,
            reference: { ...reference(), extra: "invalid" },
          }),
          cursorCreatedAt: invalidCursor.createdAt,
        }] : [{
          task: taskRow(),
          run: runRow(),
          job: jobRow(),
          cursorCreatedAt: validCursor.createdAt,
        }];
      },
    };
    const db = {
      select: () => ({ from: () => query }),
    } as unknown as DirectDatabase;
    const through = {
      createdAt: "2026-10-08 09:00:00.000000",
      jobId: "f0000000-0000-4000-8000-00000000000f",
    };

    const first = await listUnstartedProtectedTaskRunRecoveryCandidates(db, {
      limit: 1,
      through,
    });
    expect(first).toEqual({
      candidates: [],
      continuation: invalidCursor,
    });
    const second = await listUnstartedProtectedTaskRunRecoveryCandidates(db, {
      limit: 1,
      through,
      after: first.continuation!,
    });
    expect(second.candidates).toHaveLength(1);
    expect(second.candidates[0]?.input.jobId).toBe(ids.job);
    expect(second.continuation).toEqual(validCursor);
  });
});
