import { describe, expect, test } from "bun:test";

import type { DirectDatabase } from "../../src/config/direct-database";
import {
  parkProtectedTaskRun,
  type ParkProtectedTaskRunInput,
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
const definitionObjectId = `task-definition:v1:${"a".repeat(64)}`;
// Fixed vector from lattice-bridge's deriveTaskContentCryptoObjectIdV1.
const resultObjectId =
  "task-run-result:v1:c3d2c1c68222360a4404fe37119db6e3e7fcf973c1f1ccf2c4a894683c83705e";
const fingerprint = new Uint8Array(Array.from({ length: 32 }, (_, index) => index));
const parkedAt = new Date("2026-09-28T12:34:56.000Z");
const receiptKey = "nautilo.protectedTaskRunPark.v1";

function reference(
  overrides: Partial<ProtectedTaskDurableJobReference> = {},
): ProtectedTaskDurableJobReference {
  return {
    kind: "protected_task_run_v1",
    taskId: ids.task,
    taskRunId: ids.run,
    inputObjectId: definitionObjectId,
    resultObjectId,
    authorizationRequestId: `task-run-authorization:${ids.run}`,
    policyRevision: 9,
    executionSegment: 1,
    ...overrides,
  };
}

function input(
  overrides: Partial<ParkProtectedTaskRunInput> = {},
): ParkProtectedTaskRunInput {
  return {
    taskId: ids.task,
    taskRunId: ids.run,
    graphThreadId,
    jobId: ids.job,
    generation: 3,
    executionSegment: 1,
    interrupts: [
      { id: "interrupt:z", kind: "await_reply" },
      { id: "interrupt:a", kind: "approval", requestId: "approval:17" },
    ],
    parkedAt,
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
    prompt: "",
    expectedOutput: null,
    scheduleKind: "one_shot",
    status: "running",
    lastError: null,
    contentRepresentation: "protected",
    contentNamespaceId: ids.namespace,
    contentRevision: 4,
    cryptoObjectId: definitionObjectId,
    cryptoAccessRevision: 6,
    cryptoRequiredNamespaceFingerprint: fingerprint,
    cryptoMappingState: "verified",
    metadata: {},
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
    modelId: "openai:gpt-6-sol",
    resultText: null,
    startedAt: new Date("2026-09-28T12:00:00.000Z"),
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
    createdAt: new Date("2026-09-28T12:00:01.000Z"),
    startedAt: new Date("2026-09-28T12:00:02.000Z"),
    completedAt: null,
    metadata: {},
    ...overrides,
  };
}

function receipt(overrides: Record<string, unknown> = {}) {
  return {
    version: 1,
    taskId: ids.task,
    taskRunId: ids.run,
    jobId: ids.job,
    graphThreadId,
    generation: 3,
    executionSegment: 1,
    interrupts: [
      { id: "interrupt:a", kind: "approval", requestId: "approval:17" },
      { id: "interrupt:z", kind: "await_reply" },
    ],
    parkedAt: parkedAt.toISOString(),
    ...overrides,
  };
}

type FixtureOptions = Readonly<{
  task?: Task | undefined;
  run?: TaskRun | undefined;
  job?: Job | undefined;
  loseJobUpdate?: boolean;
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
  let jobRow = Object.prototype.hasOwnProperty.call(options, "job")
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
            if (table === jobs) {
              if (options.loseJobUpdate || !jobRow) return [];
              jobRow = { ...jobRow, ...patch } as Job;
              return [jobRow];
            }
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

async function expectRejected(
  promise: Promise<unknown>,
  message: string,
): Promise<void> {
  let failure: unknown;
  try {
    await promise;
  } catch (error) {
    failure = error;
  }
  expect(failure).toBeInstanceOf(Error);
  expect((failure as Error).message).toContain(message);
}

describe("protected TaskRun clean-interrupt park CAS", () => {
  test("locks Task, Run, and Job and writes only a canonical closed receipt", async () => {
    const fixture = harness();

    expect(await parkProtectedTaskRun(fixture.db, input())).toEqual({
      status: "parked",
    });
    expect(fixture.locks).toEqual([
      { table: tasks, kind: "update" },
      { table: taskRuns, kind: "update" },
      { table: jobs, kind: "update" },
    ]);
    expect(fixture.writes).toEqual([
      {
        table: jobs,
        patch: {
          status: "completed",
          completedAt: parkedAt,
          metadata: { [receiptKey]: receipt() },
        },
      },
      { table: taskRuns, patch: { status: "awaiting" } },
      {
        table: tasks,
        patch: { status: "awaiting", updatedAt: parkedAt },
      },
    ]);
    const persisted = JSON.stringify(fixture.writes.map((write) => write.patch));
    for (const forbidden of ["args", "reason", "prompt", "digest", "secret"]) {
      expect(persisted).not.toContain(forbidden);
    }
  });

  test("keeps cron Task pending while parking its exact running occurrence", async () => {
    const fixture = harness({
      task: task({ scheduleKind: "cron", status: "pending" }),
    });

    expect(await parkProtectedTaskRun(fixture.db, input())).toEqual({
      status: "parked",
    });
    expect(fixture.writes.map((write) => write.table)).toEqual([jobs, taskRuns]);
  });

  test("replays an exact receipt independent of input set ordering", async () => {
    const fixture = harness({
      task: task({ status: "awaiting" }),
      run: run({ status: "awaiting" }),
      job: job({
        status: "completed",
        completedAt: parkedAt,
        metadata: { [receiptKey]: receipt() },
      }),
    });

    expect(await parkProtectedTaskRun(fixture.db, input())).toEqual({
      status: "exact_replay",
    });
    expect(fixture.writes).toEqual([]);
  });

  test("parks the first authorization generation", async () => {
    const fixture = harness();
    expect(await parkProtectedTaskRun(fixture.db, input({ generation: 0 }))).toEqual({
      status: "parked",
    });
    expect(fixture.writes[0]?.patch["metadata"]).toEqual({
      [receiptKey]: receipt({ generation: 0 }),
    });
  });

  test("rejects changed generation, interrupt set, or extra receipt data", async () => {
    for (const changed of [
      receipt({ generation: 4 }),
      receipt({ interrupts: [{ id: "interrupt:a", kind: "approval" }] }),
      receipt({ hidden: "content" }),
    ]) {
      const fixture = harness({
        task: task({ status: "awaiting" }),
        run: run({ status: "awaiting" }),
        job: job({
          status: "completed",
          completedAt: parkedAt,
          metadata: { [receiptKey]: changed },
        }),
      });
      expect(await parkProtectedTaskRun(fixture.db, input())).toEqual({
        status: "rejected",
        reason: "conflict",
      });
      expect(fixture.writes).toEqual([]);
    }
  });

  test("binds the park receipt to the exact execution segment", async () => {
    const fixture = harness({
      task: task({ status: "awaiting" }),
      run: run({ status: "awaiting" }),
      job: job({
        status: "completed",
        completedAt: parkedAt,
        metadata: { [receiptKey]: receipt({ executionSegment: 2 }) },
      }),
    });

    expect(await parkProtectedTaskRun(fixture.db, input())).toEqual({
      status: "rejected",
      reason: "conflict",
    });
    expect(fixture.writes).toEqual([]);
  });

  test("rejects Plain, terminal, mismatched, or non-content-free state", async () => {
    const cases: FixtureOptions[] = [
      { task: task({ contentRepresentation: "ordinary" }) },
      { task: task({ status: "completed" }) },
      { task: task({ prompt: "plaintext" }) },
      { task: task({ cryptoObjectId: `task-definition:v1:${"c".repeat(64)}` }) },
      { run: run({ graphThreadId: `${graphThreadId}:other` }) },
      { run: run({ resultRevision: 1 }) },
      { job: job({ status: "completed", completedAt: parkedAt }) },
      { job: job({ result: { leaked: true } }) },
      { job: job({ input: { ...reference(), taskRunId: "other" } }) },
      {
        job: job({
          metadata: {
            "nautilo.protectedTaskRunTerminal.v1": { version: 1 },
          },
        }),
      },
    ];

    for (const options of cases) {
      const fixture = harness(options);
      expect(await parkProtectedTaskRun(fixture.db, input())).toEqual({
        status: "rejected",
        reason: "stale",
      });
      expect(fixture.writes).toEqual([]);
    }
  });

  test("rejects malformed or content-bearing interrupt coordinates before DB access", async () => {
    let transactions = 0;
    const db = {
      transaction: () => {
        transactions += 1;
        throw new Error("transaction must stay closed");
      },
    } as unknown as DirectDatabase;

    for (const interrupts of [
      [],
      [{ id: "duplicate", kind: "approval" }, { id: "duplicate", kind: "identity" }],
      [{ id: "has spaces", kind: "approval" }],
      [{ id: "interrupt:a", kind: "unknown" }],
      [{ id: "interrupt:a", kind: "approval", args: { secret: true } }],
      [{ id: "interrupt:a", kind: "approval", requestId: undefined }],
    ]) {
      await expectRejected(parkProtectedTaskRun(db, input({
        interrupts: interrupts as ParkProtectedTaskRunInput["interrupts"],
      })), "binding is malformed");
    }
    await expectRejected(parkProtectedTaskRun(db, input({
      jobReference: reference({
        resultObjectId: `task-run-result:v1:${"d".repeat(64)}`,
      }),
    })), "binding is malformed");
    await expectRejected(parkProtectedTaskRun(db, input({
      executionSegment: 2,
    })), "binding is malformed");
    await expectRejected(parkProtectedTaskRun(db, input({
      jobReference: {
        ...reference(),
        hidden: "content",
      } as unknown as ProtectedTaskDurableJobReference,
    })), "binding is malformed");
    expect(transactions).toBe(0);
  });

  test("throws to roll back if any locked write unexpectedly loses its CAS", async () => {
    await expectRejected(parkProtectedTaskRun(
      harness({ loseJobUpdate: true }).db,
      input(),
    ), "lost its Job");
    await expectRejected(parkProtectedTaskRun(
      harness({ loseRunUpdate: true }).db,
      input(),
    ), "lost its TaskRun");
    await expectRejected(parkProtectedTaskRun(
      harness({ loseTaskUpdate: true }).db,
      input(),
    ), "lost its Task");
  });

  test("lets the first locked terminal outcome win without a partial park", async () => {
    const terminalWon = harness({
      task: task({ status: "completed" }),
      run: run({ status: "completed", completedAt: parkedAt }),
      job: job({
        status: "completed",
        completedAt: parkedAt,
        metadata: {
          "nautilo.protectedTaskRunTerminal.v1": { version: 1 },
        },
      }),
    });

    expect(await parkProtectedTaskRun(terminalWon.db, input())).toEqual({
      status: "rejected",
      reason: "stale",
    });
    expect(terminalWon.writes).toEqual([]);
  });
});
