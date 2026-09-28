import { describe, expect, test } from "bun:test";

import type { DirectDatabase } from "../../src/config/direct-database";
import {
  attachProtectedTaskRunModel,
  type AttachProtectedTaskRunModelInput,
  type ProtectedTaskDurableJobReference,
} from "../../src/queries/tasks";
import { jobs, type Job } from "../../src/schema/jobs";
import { taskRuns, type TaskRun } from "../../src/schema/task-runs";
import { tasks, type Task } from "../../src/schema/tasks";

const ids = {
  task: "10000000-0000-4000-8000-000000000001",
  run: "20000000-0000-4000-8000-000000000002",
  job: "30000000-0000-4000-8000-000000000003",
  owner: "40000000-0000-4000-8000-000000000004",
  agent: "50000000-0000-4000-8000-000000000005",
  namespace: "60000000-0000-4000-8000-000000000006",
};
const graphThreadId = `subagent:${ids.task}:${ids.run}`;
const objectId = `task-definition:v1:${"a".repeat(64)}`;
const fingerprint = new Uint8Array(Array.from({ length: 32 }, (_, index) => index));
const modelId = "openai:gpt-5.6-sol";

function reference(
  overrides: Partial<ProtectedTaskDurableJobReference> = {},
): ProtectedTaskDurableJobReference {
  return {
    kind: "protected_task_run_v1",
    taskId: ids.task,
    taskRunId: ids.run,
    inputObjectId: objectId,
    resultObjectId: `task-run-result:v1:${"b".repeat(64)}`,
    authorizationRequestId: `task-run-authorization:${ids.run}`,
    policyRevision: 9,
    executionSegment: 1,
    ...overrides,
  };
}

function input(
  overrides: Partial<AttachProtectedTaskRunModelInput> = {},
): AttachProtectedTaskRunModelInput {
  return {
    taskId: ids.task,
    taskRunId: ids.run,
    graphThreadId,
    jobId: ids.job,
    modelId,
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

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: ids.task,
    ownerId: ids.owner,
    requestorId: ids.owner,
    agentId: ids.agent,
    scheduleKind: "now",
    status: "running",
    contentRepresentation: "protected",
    contentNamespaceId: ids.namespace,
    contentRevision: 4,
    cryptoObjectId: objectId,
    cryptoAccessRevision: 6,
    cryptoRequiredNamespaceFingerprint: fingerprint,
    cryptoMappingState: "verified",
    ...overrides,
  } as Task;
}

function run(overrides: Partial<TaskRun> = {}): TaskRun {
  return {
    id: ids.run,
    taskId: ids.task,
    jobId: ids.job,
    graphThreadId,
    status: "running",
    modelId: null,
    resultText: null,
    startedAt: new Date("2026-09-20T10:00:00.000Z"),
    completedAt: null,
    lastError: null,
    resultRepresentation: "ordinary",
    resultContentNamespaceId: null,
    resultRevision: 0,
    resultCryptoObjectId: null,
    resultCryptoAccessRevision: 0,
    resultCryptoRequiredNamespaceFingerprint: null,
    resultCryptoMappingState: "unmapped",
    ...overrides,
  };
}

function job(overrides: Partial<Job> = {}): Job {
  return {
    id: ids.job,
    ownerId: ids.owner,
    requestorId: ids.owner,
    laneKey: `task:${ids.task}`,
    roomId: null,
    type: "foreground",
    status: "running",
    input: reference(),
    result: null,
    message: null,
    createdAt: new Date("2026-09-20T10:00:01.000Z"),
    startedAt: new Date("2026-09-20T10:00:02.000Z"),
    completedAt: null,
    metadata: {},
    ...overrides,
  };
}

type FixtureOptions = Readonly<{
  task?: Task | undefined;
  run?: TaskRun | undefined;
  job?: Job | undefined;
  loseUpdate?: boolean;
}>;

function harness(options: FixtureOptions = {}) {
  const taskRow = Object.prototype.hasOwnProperty.call(options, "task")
    ? options.task
    : task();
  let runRow = Object.prototype.hasOwnProperty.call(options, "run")
    ? options.run
    : run();
  const jobRow = Object.prototype.hasOwnProperty.call(options, "job")
    ? options.job
    : job();
  const locks: Array<{ table: unknown; kind: string }> = [];
  const writes: Array<{ table: unknown; patch: Record<string, unknown> }> = [];

  const rows = (table: unknown): unknown[] => {
    if (table === tasks) return taskRow ? [taskRow] : [];
    if (table === taskRuns) return runRow ? [runRow] : [];
    if (table === jobs) return jobRow ? [jobRow] : [];
    throw new Error("unexpected table");
  };
  const tx = {
    select: () => ({
      from: (table: unknown) => {
        const query = {
          where: (_condition: unknown) => query,
          limit: (_limit: number) => query,
          for: async (kind: string) => {
            locks.push({ table, kind });
            return rows(table);
          },
        };
        return query;
      },
    }),
    update: (table: unknown) => ({
      set: (patch: Record<string, unknown>) => ({
        where: (_condition: unknown) => ({
          returning: async () => {
            writes.push({ table, patch });
            if (table !== taskRuns) throw new Error("unexpected update table");
            if (options.loseUpdate || !runRow) return [];
            runRow = { ...runRow, ...patch } as TaskRun;
            return [runRow];
          },
        }),
      }),
    }),
  };
  const db = {
    transaction: async <T>(operation: (value: typeof tx) => Promise<T>) =>
      operation(tx),
  } as unknown as DirectDatabase;
  return { db, locks, writes };
}

describe("protected TaskRun model binding", () => {
  test("locks Task, running TaskRun, and live Job before attaching the native model", async () => {
    const fixture = harness();

    expect(await attachProtectedTaskRunModel(fixture.db, input())).toEqual({
      status: "attached",
    });
    expect(fixture.locks).toEqual([
      { table: tasks, kind: "update" },
      { table: taskRuns, kind: "update" },
      { table: jobs, kind: "share" },
    ]);
    expect(fixture.writes).toEqual([
      { table: taskRuns, patch: { modelId } },
    ]);
  });

  test("accepts a pending cron parent and a queued live Job", async () => {
    const fixture = harness({
      task: task({
        scheduleKind: "cron",
        status: "pending",
        contentRepresentation: "dual",
      }),
      job: job({ status: "queued", startedAt: null }),
    });

    expect(await attachProtectedTaskRunModel(fixture.db, input({
      contentRepresentation: "dual",
    }))).toEqual({
      status: "attached",
    });
  });

  test("treats an exact already-attached model as an idempotent replay", async () => {
    const fixture = harness({ run: run({ modelId }) });

    expect(await attachProtectedTaskRunModel(fixture.db, input())).toEqual({
      status: "same",
    });
    expect(fixture.writes).toEqual([]);
  });

  test("returns stale without writes when durable authority changed", async () => {
    const cases: FixtureOptions[] = [
      { task: task({ status: "paused" }) },
      { task: task({ contentRepresentation: "ordinary" }) },
      { task: task({ contentRevision: 5 }) },
      { task: task({ cryptoAccessRevision: 7 }) },
      { task: task({ cryptoMappingState: "stale" }) },
      { task: task({ cryptoRequiredNamespaceFingerprint: new Uint8Array(32).fill(9) }) },
      { run: run({ status: "completed", completedAt: new Date() }) },
      { run: run({ jobId: "70000000-0000-4000-8000-000000000007" }) },
      { run: run({ modelId: "anthropic:claude-sonnet-4-6" }) },
      { run: run({ resultRevision: 1 }) },
      { job: job({ status: "completed", completedAt: new Date() }) },
      { job: job({ status: "queued" }) },
      { job: job({ status: "running", startedAt: null }) },
      { job: job({ message: "terminal text" }) },
      { job: job({ laneKey: "task:other" }) },
      { job: job({ input: { ...reference(), taskRunId: "different" } }) },
    ];

    for (const options of cases) {
      const fixture = harness(options);
      expect(await attachProtectedTaskRunModel(fixture.db, input())).toEqual({
        status: "stale",
      });
      expect(fixture.writes).toEqual([]);
    }
  });

  test("returns stale when any exact row is absent", async () => {
    for (const options of [
      { task: undefined },
      { run: undefined },
      { job: undefined },
    ] satisfies FixtureOptions[]) {
      const fixture = harness(options);
      expect(await attachProtectedTaskRunModel(fixture.db, input())).toEqual({
        status: "stale",
      });
      expect(fixture.writes).toEqual([]);
    }
  });

  test("rejects malformed or non-native model bindings before opening a transaction", () => {
    let transactions = 0;
    const db = {
      transaction: () => {
        transactions += 1;
        throw new Error("transaction must stay closed");
      },
    } as unknown as DirectDatabase;

    expect(attachProtectedTaskRunModel(db, input({ modelId: "model-without-provider" })))
      .rejects.toThrow("binding is malformed");
    expect(attachProtectedTaskRunModel(db, input({
      cryptoRequiredNamespaceFingerprint: new Uint8Array(31),
    }))).rejects.toThrow("binding is malformed");
    expect(transactions).toBe(0);
  });

  test("throws to roll back if the locked model CAS unexpectedly loses its row", () => {
    expect(attachProtectedTaskRunModel(
      harness({ loseUpdate: true }).db,
      input(),
    )).rejects.toThrow("lost its locked TaskRun");
  });
});
