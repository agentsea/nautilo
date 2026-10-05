import { describe, expect, test } from "bun:test";

import type { DirectDatabase } from "../../src/config/direct-database";
import {
  startProtectedTaskRun,
  startParkedProtectedTaskRunSegment,
  type ProtectedTaskDurableJobReference,
  type StartParkedProtectedTaskRunSegmentInput,
} from "../../src/queries/tasks";
import { jobs, type Job } from "../../src/schema/jobs";
import { taskRuns, type TaskRun } from "../../src/schema/task-runs";
import { tasks, type Task } from "../../src/schema/tasks";

const ids = {
  task: "10000000-0000-4000-8000-000000000001",
  run: "20000000-0000-4000-8000-000000000002",
  priorJob: "30000000-0000-4000-8000-000000000003",
  job: "30000000-0000-4000-8000-000000000004",
  owner: "40000000-0000-4000-8000-000000000004",
  agent: "50000000-0000-4000-8000-000000000005",
  namespace: "60000000-0000-4000-8000-000000000006",
  room: "70000000-0000-4000-8000-000000000007",
  session: "80000000-0000-4000-8000-000000000008",
  sourceUser: "90000000-0000-4000-8000-000000000009",
};
const graphThreadId = `subagent:${ids.task}:${ids.run}`;
const definitionObjectId = `task-definition:v1:${"a".repeat(64)}`;
const resultObjectId =
  "task-run-result:v1:c3d2c1c68222360a4404fe37119db6e3e7fcf973c1f1ccf2c4a894683c83705e";
const fingerprint = new Uint8Array(Array.from({ length: 32 }, (_, index) => index));
const parkedAt = new Date("2026-09-28T12:34:56.000Z");
const receiptKey = "nautilo.protectedTaskRunPark.v1";
const terminalReceiptKey = "nautilo.protectedTaskRunTerminal.v1";
const acceptanceReceiptKey = "nautilo.protectedTaskAwaitReplyAcceptance.v1";
const acceptedAt = new Date("2026-09-28T12:35:00.000Z");
const acceptanceId = "await-reply-acceptance:1";

function priorReference(
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

function nextReference(
  overrides: Partial<ProtectedTaskDurableJobReference> = {},
): ProtectedTaskDurableJobReference {
  return {
    ...priorReference(),
    authorizationRequestId: `task-run-authorization:${ids.run}:segment:2`,
    executionSegment: 2,
    resumeAcceptanceId: acceptanceId,
    ...overrides,
  };
}

function acceptance() {
  return {
    acceptanceId,
    interruptId: "interrupt:z",
    message: {
      roomId: ids.room,
      sessionId: ids.session,
      messageId: "41",
      editRevision: 2,
      cryptoObjectId: "message:v2:accepted",
      namespaceId: ids.namespace,
      sourceUserId: ids.sourceUser,
    },
    acceptedAt,
  } as const;
}

function acceptanceReceipt(overrides: Record<string, unknown> = {}) {
  return {
    version: 1,
    acceptanceId,
    taskId: ids.task,
    taskRunId: ids.run,
    jobId: ids.priorJob,
    graphThreadId,
    generation: 3,
    executionSegment: 1,
    nextExecutionSegment: 2,
    interrupt: { id: "interrupt:z", kind: "await_reply" },
    message: acceptance().message,
    acceptedAt: acceptedAt.toISOString(),
    ...overrides,
  };
}

function interrupts() {
  return [
    { id: "interrupt:z", kind: "await_reply" as const },
    { id: "interrupt:a", kind: "approval" as const, requestId: "approval:17" },
  ];
}

function receipt(overrides: Record<string, unknown> = {}) {
  return {
    version: 1,
    taskId: ids.task,
    taskRunId: ids.run,
    jobId: ids.priorJob,
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

function input(
  overrides: Partial<StartParkedProtectedTaskRunSegmentInput> = {},
): StartParkedProtectedTaskRunSegmentInput {
  return {
    taskId: ids.task,
    taskRunId: ids.run,
    graphThreadId,
    priorJobId: ids.priorJob,
    jobId: ids.job,
    generation: 3,
    interrupts: interrupts(),
    parkedAt,
    contentRepresentation: "protected",
    contentNamespaceId: ids.namespace,
    contentRevision: 4,
    cryptoObjectId: definitionObjectId,
    cryptoAccessRevision: 6,
    cryptoRequiredNamespaceFingerprint: fingerprint,
    priorJobReference: priorReference(),
    jobReference: nextReference(),
    acceptance: acceptance(),
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
    fundingMode: "legacy_server",
    status: "awaiting",
    targetRoomId: ids.room,
    targetUserIds: [ids.sourceUser],
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
    jobId: ids.priorJob,
    graphThreadId,
    status: "awaiting",
    modelId: "openai:gpt-6-sol",
    fundingBinding: null,
    fundingPredecessorRunId: null,
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

function priorJob(overrides: Partial<Job> = {}): Job {
  return {
    id: ids.priorJob,
    ownerId: ids.owner,
    requestorId: ids.owner,
    laneKey: `task:${ids.task}`,
    roomId: null,
    type: "foreground",
    status: "completed",
    input: priorReference(),
    result: null,
    message: null,
    createdAt: new Date("2026-09-28T12:00:01.000Z"),
    startedAt: new Date("2026-09-28T12:00:02.000Z"),
    completedAt: parkedAt,
    metadata: {
      [receiptKey]: receipt(),
      [acceptanceReceiptKey]: acceptanceReceipt(),
    },
    ...overrides,
  };
}

function nextJob(overrides: Partial<Job> = {}): Job {
  return {
    id: ids.job,
    ownerId: ids.owner,
    requestorId: ids.owner,
    laneKey: `task:${ids.task}`,
    roomId: null,
    type: "foreground",
    status: "queued",
    input: nextReference(),
    result: null,
    message: null,
    createdAt: new Date("2026-09-28T12:35:00.000Z"),
    startedAt: null,
    completedAt: null,
    metadata: {},
    ...overrides,
  };
}

type FixtureOptions = Readonly<{
  task?: Task | undefined;
  run?: TaskRun | undefined;
  priorJob?: Job | undefined;
  nextJob?: Job | undefined;
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
  const priorJobRow = Object.prototype.hasOwnProperty.call(options, "priorJob")
    ? options.priorJob
    : priorJob();
  const nextJobRow = Object.prototype.hasOwnProperty.call(options, "nextJob")
    ? options.nextJob
    : nextJob();
  let jobRead = 0;
  const locks: Array<{ table: unknown; kind: string }> = [];
  const writes: Array<{ table: unknown; patch: Record<string, unknown> }> = [];

  const rows = (table: unknown): unknown[] => {
    if (table === tasks) return taskRow ? [taskRow] : [];
    if (table === taskRuns) return runRow ? [runRow] : [];
    if (table === jobs) {
      const row = jobRead % 2 === 0 ? priorJobRow : nextJobRow;
      jobRead += 1;
      return row ? [row] : [];
    }
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
            if (table === jobs) return [priorJobRow];
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

describe("protected TaskRun parked-segment start CAS", () => {
  test("locks the aggregate in order, consumes acceptance, and swaps the Job", async () => {
    const fixture = harness();

    expect(await startParkedProtectedTaskRunSegment(fixture.db, input())).toEqual({
      status: "started",
    });
    expect(fixture.locks).toEqual([
      { table: tasks, kind: "update" },
      { table: taskRuns, kind: "update" },
      { table: jobs, kind: "update" },
      { table: jobs, kind: "update" },
    ]);
    expect(fixture.writes).toHaveLength(3);
    expect(fixture.writes[0]).toEqual({
      table: jobs,
      patch: {
        metadata: {
          [receiptKey]: receipt(),
          [acceptanceReceiptKey]: acceptanceReceipt({
            consumedByJobId: ids.job,
          }),
        },
      },
    });
    expect(fixture.writes[1]).toEqual({
      table: taskRuns,
      patch: { status: "running", jobId: ids.job },
    });
    expect(fixture.writes[2]?.table).toBe(tasks);
    expect(fixture.writes[2]?.patch["status"]).toBe("running");
    expect(fixture.writes[2]?.patch["updatedAt"]).toBeInstanceOf(Date);
  });

  test("keeps recipient generation independent from the next execution segment", async () => {
    const fixture = harness({
      priorJob: priorJob({
        metadata: {
          [receiptKey]: receipt({ generation: 0 }),
          [acceptanceReceiptKey]: acceptanceReceipt({ generation: 0 }),
        },
      }),
    });

    expect(await startParkedProtectedTaskRunSegment(fixture.db, input({
      generation: 0,
    }))).toEqual({ status: "started" });
  });

  test("accepts an exact already-started segment as a replay", async () => {
    const fixture = harness({
      task: task({ status: "running" }),
      run: run({ status: "running", jobId: ids.job }),
      nextJob: nextJob({
        status: "running",
        startedAt: new Date("2026-09-28T12:35:01.000Z"),
      }),
      priorJob: priorJob({
        metadata: {
          [receiptKey]: receipt(),
          [acceptanceReceiptKey]: acceptanceReceipt({
            consumedByJobId: ids.job,
          }),
        },
      }),
    });

    expect(await startParkedProtectedTaskRunSegment(fixture.db, input())).toEqual({
      status: "exact_replay",
    });
    expect(fixture.writes).toEqual([]);
  });

  test("keeps a recurring Task pending while starting its parked occurrence", async () => {
    const fixture = harness({
      task: task({ scheduleKind: "cron", status: "pending" }),
    });

    expect(await startParkedProtectedTaskRunSegment(fixture.db, input())).toEqual({
      status: "started",
    });
    expect(fixture.writes).toEqual([
      {
        table: jobs,
        patch: {
          metadata: {
            [receiptKey]: receipt(),
            [acceptanceReceiptKey]: acceptanceReceipt({
              consumedByJobId: ids.job,
            }),
          },
        },
      },
      { table: taskRuns, patch: { status: "running", jobId: ids.job } },
    ]);
  });

  test("rejects any changed prior park receipt as a conflict", async () => {
    for (const changed of [
      receipt({ generation: 4 }),
      receipt({ executionSegment: 2 }),
      receipt({ interrupts: [{ id: "interrupt:a", kind: "approval" }] }),
      receipt({ hidden: "content" }),
    ]) {
      const fixture = harness({
        priorJob: priorJob({ metadata: { [receiptKey]: changed } }),
      });
      expect(await startParkedProtectedTaskRunSegment(fixture.db, input())).toEqual({
        status: "rejected",
        reason: "conflict",
      });
      expect(fixture.writes).toEqual([]);
    }
  });

  test("requires the exact unconsumed acceptance for the fresh segment", async () => {
    for (const changed of [
      undefined,
      acceptanceReceipt({ acceptanceId: "await-reply-acceptance:other" }),
      acceptanceReceipt({ nextExecutionSegment: 3 }),
      acceptanceReceipt({ consumedByJobId: ids.priorJob }),
      acceptanceReceipt({ hidden: "content" }),
    ]) {
      const metadata: Record<string, unknown> = { [receiptKey]: receipt() };
      if (changed !== undefined) metadata[acceptanceReceiptKey] = changed;
      const fixture = harness({ priorJob: priorJob({ metadata }) });
      expect(await startParkedProtectedTaskRunSegment(fixture.db, input())).toEqual({
        status: "rejected",
        reason: "conflict",
      });
      expect(fixture.writes).toEqual([]);
    }
  });

  test("rejects stopped, terminal, stale, Plain, or content-bearing state", async () => {
    const cases: FixtureOptions[] = [
      { task: task({ status: "cancelled" }) },
      { task: task({ status: "completed" }) },
      { task: task({ contentRepresentation: "ordinary" }) },
      { task: task({ prompt: "plaintext" }) },
      { task: task({ cryptoMappingState: "stale" }) },
      { run: run({ status: "cancelled", completedAt: parkedAt }) },
      { run: run({ resultRevision: 1 }) },
      { priorJob: priorJob({ metadata: {
        [receiptKey]: receipt(),
        [acceptanceReceiptKey]: acceptanceReceipt(),
        [terminalReceiptKey]: { version: 1 },
      } }) },
      { nextJob: nextJob({ result: { content: true } }) },
      { nextJob: nextJob({ message: "content" }) },
      { nextJob: nextJob({ metadata: { content: true } }) },
      { nextJob: nextJob({ input: { ...nextReference(), hidden: "content" } }) },
      { nextJob: nextJob({ status: "running", startedAt: new Date() }) },
    ];

    for (const options of cases) {
      const fixture = harness(options);
      expect(await startParkedProtectedTaskRunSegment(fixture.db, input())).toEqual({
        status: "rejected",
        reason: "stale",
      });
      expect(fixture.writes).toEqual([]);
    }
  });

  test("returns not-found when any member of the locked aggregate is absent", async () => {
    for (const options of [
      { task: undefined },
      { run: undefined },
      { priorJob: undefined },
      { nextJob: undefined },
    ] satisfies FixtureOptions[]) {
      const fixture = harness(options);
      expect(await startParkedProtectedTaskRunSegment(fixture.db, input())).toEqual({
        status: "rejected",
        reason: "not_found",
      });
      expect(fixture.writes).toEqual([]);
    }
  });

  test("keeps initial start fenced to segment one", async () => {
    let transactions = 0;
    const db = {
      transaction: () => {
        transactions += 1;
        throw new Error("transaction must stay closed");
      },
    } as unknown as DirectDatabase;

    await expectRejected(startProtectedTaskRun(db, {
      taskId: ids.task,
      taskRunId: ids.run,
      graphThreadId,
      jobId: ids.job,
      contentRepresentation: "protected",
      contentNamespaceId: ids.namespace,
      contentRevision: 4,
      cryptoObjectId: definitionObjectId,
      cryptoAccessRevision: 6,
      cryptoRequiredNamespaceFingerprint: fingerprint,
      jobReference: nextReference(),
    }), "binding is malformed");
    expect(transactions).toBe(0);
  });

  test("rejects malformed segment succession before opening a transaction", async () => {
    let transactions = 0;
    const db = {
      transaction: () => {
        transactions += 1;
        throw new Error("transaction must stay closed");
      },
    } as unknown as DirectDatabase;

    await expectRejected(startParkedProtectedTaskRunSegment(db, input({
      jobReference: nextReference({ executionSegment: 1 }),
    })), "binding is malformed");
    await expectRejected(startParkedProtectedTaskRunSegment(db, input({
      jobReference: nextReference({ executionSegment: 3 }),
    })), "binding is malformed");
    await expectRejected(startParkedProtectedTaskRunSegment(db, input({
      jobReference: nextReference({
        authorizationRequestId: priorReference().authorizationRequestId,
      }),
    })), "binding is malformed");
    await expectRejected(startParkedProtectedTaskRunSegment(db, input({
      jobReference: priorReference({
        authorizationRequestId: `task-run-authorization:${ids.run}:segment:2`,
        executionSegment: 2,
      }),
    })), "binding is malformed");
    await expectRejected(startParkedProtectedTaskRunSegment(db, input({
      jobReference: nextReference({ resumeAcceptanceId: "other-acceptance" }),
    })), "binding is malformed");
    await expectRejected(startParkedProtectedTaskRunSegment(db, input({
      priorJobReference: priorReference({ executionSegment: 0 }),
    })), "binding is malformed");
    await expectRejected(startParkedProtectedTaskRunSegment(db, input({
      priorJobReference: priorReference({
        executionSegment: Number.MAX_SAFE_INTEGER,
      }),
      jobReference: nextReference({
        executionSegment: Number.MAX_SAFE_INTEGER + 1,
      }),
    })), "binding is malformed");
    expect(transactions).toBe(0);
  });

  test("throws to roll back if either locked write loses its row", () => {
    expect(startParkedProtectedTaskRunSegment(
      harness({ loseRunUpdate: true }).db,
      input(),
    )).rejects.toThrow("lost its TaskRun");
    expect(startParkedProtectedTaskRunSegment(
      harness({ loseTaskUpdate: true }).db,
      input(),
    )).rejects.toThrow("lost its Task");
  });
});
