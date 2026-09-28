import { describe, expect, test } from "bun:test";

import type { DirectDatabase } from "../../src/config/direct-database";
import {
  startProtectedTaskRun,
  type ProtectedTaskDurableJobReference,
  type StartProtectedTaskRunInput,
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

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: ids.task,
    ownerId: ids.owner,
    requestorId: ids.owner,
    agentId: ids.agent,
    scheduleKind: "now",
    status: "awaiting",
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
    jobId: null,
    graphThreadId,
    status: "awaiting",
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
    status: "queued",
    input: reference(),
    result: null,
    message: null,
    createdAt: new Date("2026-09-20T10:00:01.000Z"),
    startedAt: null,
    completedAt: null,
    metadata: {},
    ...overrides,
  };
}

type FixtureOptions = Readonly<{
  task?: Task | undefined;
  run?: TaskRun | undefined;
  job?: Job | undefined;
  loseRunUpdate?: boolean;
  loseTaskUpdate?: boolean;
}>;

function harness(options: FixtureOptions = {}) {
  let taskRow = Object.prototype.hasOwnProperty.call(options, "task")
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
            if (table === taskRuns) {
              if (options.loseRunUpdate || !runRow) return [];
              runRow = { ...runRow, ...patch } as TaskRun;
              return [runRow];
            }
            if (table === tasks) {
              if (options.loseTaskUpdate || !taskRow) return [];
              taskRow = { ...taskRow, ...patch } as Task;
              return [taskRow];
            }
            throw new Error("unexpected update table");
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

describe("protected TaskRun start transition", () => {
  test("locks Task, exact awaiting run, and queued Job before starting one-shot work", async () => {
    const fixture = harness();
    const result = await startProtectedTaskRun(fixture.db, input());

    expect(result).toEqual({ status: "started" });
    expect(fixture.locks).toEqual([
      { table: tasks, kind: "update" },
      { table: taskRuns, kind: "update" },
      { table: jobs, kind: "share" },
    ]);
    expect(fixture.writes.map((write) => ({
      table: write.table,
      status: write.patch["status"],
      jobId: write.patch["jobId"],
    }))).toEqual([
      { table: taskRuns, status: "running", jobId: ids.job },
      { table: tasks, status: "running", jobId: undefined },
    ]);
  });

  test("starts a cron run while leaving its already-advanced Task pending", async () => {
    const pendingCron = task({ scheduleKind: "cron", status: "pending" });
    const fixture = harness({ task: pendingCron });
    const result = await startProtectedTaskRun(fixture.db, input());

    expect(result).toEqual({ status: "started" });
    expect(fixture.writes).toHaveLength(1);
    expect(fixture.writes[0]?.table).toBe(taskRuns);
  });

  test("returns stale without writes for duplicate or changed durable state", async () => {
    const cases: FixtureOptions[] = [
      { task: task({ status: "paused" }) },
      { task: task({ scheduleKind: "cron", status: "awaiting" }) },
      { task: task({ contentRevision: 5 }) },
      { task: task({ cryptoAccessRevision: 7 }) },
      { task: task({ cryptoMappingState: "stale" }) },
      { task: task({ cryptoRequiredNamespaceFingerprint: new Uint8Array(32).fill(9) }) },
      { run: run({ status: "running" }) },
      { run: run({ jobId: ids.job }) },
      { run: run({ graphThreadId: `${graphThreadId}:other` }) },
      { run: run({ resultRevision: 1 }) },
      { job: job({ status: "running" }) },
      { job: job({ laneKey: "task:other" }) },
      { job: job({ input: { ...reference(), taskRunId: "different" } }) },
      { job: job({ input: { ...reference(), extra: "not-content-free" } }) },
    ];

    for (const options of cases) {
      const fixture = harness(options);
      expect(await startProtectedTaskRun(fixture.db, input())).toEqual({
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
      expect(await startProtectedTaskRun(fixture.db, input())).toEqual({
        status: "stale",
      });
      expect(fixture.writes).toEqual([]);
    }
  });

  test("rejects malformed bindings before opening a transaction", () => {
    let transactions = 0;
    const db = {
      transaction: () => {
        transactions += 1;
        throw new Error("transaction must stay closed");
      },
    } as unknown as DirectDatabase;

    expect(startProtectedTaskRun(db, input({
      cryptoRequiredNamespaceFingerprint: new Uint8Array(31),
    }))).rejects.toThrow("binding is malformed");
    expect(transactions).toBe(0);
  });

  test("throws to roll back if a locked CAS unexpectedly loses either row", () => {
    expect(startProtectedTaskRun(
      harness({ loseRunUpdate: true }).db,
      input(),
    )).rejects.toThrow("lost its locked TaskRun");
    expect(startProtectedTaskRun(
      harness({ loseTaskUpdate: true }).db,
      input(),
    )).rejects.toThrow("lost its locked Task");
  });
});
