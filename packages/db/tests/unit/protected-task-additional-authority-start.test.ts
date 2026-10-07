import { createHash } from "node:crypto";
import { describe, expect, test } from "bun:test";

import type { DirectDatabase } from "../../src/config/direct-database";
import {
  protectedTaskAdditionalAuthorityContinuationFingerprint,
} from "../../src/queries/protected-task-execution-receipts";
import {
  startParkedProtectedTaskRunAdditionalAuthoritySegment,
  type ProtectedTaskDurableJobReference,
  type StartParkedProtectedTaskRunAdditionalAuthoritySegmentInput,
} from "../../src/queries/tasks";
import { jobs, type Job } from "../../src/schema/jobs";
import { protectedTaskContinuationReceipts } from
  "../../src/schema/protected-task-continuation-receipts";
import { protectedTaskExecutionSegmentReceipts } from
  "../../src/schema/protected-task-execution-segment-receipts";
import { taskRunMessageAssociations } from
  "../../src/schema/task-run-message-associations";
import { taskRuns, type TaskRun } from "../../src/schema/task-runs";
import { tasks, type Task } from "../../src/schema/tasks";

const ids = {
  task: "10000000-0000-4000-8000-000000000001",
  run: "20000000-0000-4000-8000-000000000002",
  priorJob: "30000000-0000-4000-8000-000000000003",
  job: "30000000-0000-4000-8000-000000000004",
  owner: "40000000-0000-4000-8000-000000000005",
  agent: "50000000-0000-4000-8000-000000000006",
  namespace: "60000000-0000-4000-8000-000000000007",
};
const graphThreadId = `subagent:${ids.task}:${ids.run}`;
const definitionObjectId = `task-definition:v1:${"a".repeat(64)}`;
const resultObjectId =
  "task-run-result:v1:c3d2c1c68222360a4404fe37119db6e3e7fcf973c1f1ccf2c4a894683c83705e";
const parkedAt = new Date("2026-10-07T12:34:56.000Z");
const parkReceiptKey = "nautilo.protectedTaskRunPark.v1";
const digest = (seed: number): Uint8Array =>
  new Uint8Array(Array.from({ length: 32 }, (_, index) => seed + index));
const definitionFingerprint = digest(1);
const checkpointManifest = Object.freeze({
  contract: "encrypted_langgraph_v1" as const,
  expectedCheckpointCount: 2,
  checkpointOrderedDigest: digest(2),
  expectedBlobCount: 3,
  blobOrderedDigest: digest(3),
  expectedPendingWriteCount: 0,
  pendingWriteOrderedDigest: digest(4),
});
const continuation = Object.freeze({
  interruptId: "interrupt:additional-authority:1",
  operationId: "tool-call:1",
  requestDigest: digest(5),
  requiredAuthorityDigest: digest(6),
});
const transcriptDigest = new Uint8Array(createHash("sha256").update(
  JSON.stringify([
    "protected-task-transcript-manifest:v1",
    ids.task,
    ids.run,
    graphThreadId,
    0,
  ]) + "\n",
  "utf8",
).digest());

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

function continuationFingerprint(): string {
  return protectedTaskAdditionalAuthorityContinuationFingerprint({
    taskRunId: ids.run,
    executionSegment: 1,
    jobId: ids.priorJob,
    kind: "pre_effect_interrupt_v1",
    reason: "additional_authority",
    effectDisposition: "not_started_v1",
    ...continuation,
  });
}

function nextReference(
  overrides: Partial<ProtectedTaskDurableJobReference> = {},
): ProtectedTaskDurableJobReference {
  return {
    ...priorReference(),
    authorizationRequestId: `task-run-authorization:${ids.run}:segment:2`,
    policyRevision: 10,
    executionSegment: 2,
    resumeContinuationFingerprint: continuationFingerprint(),
    ...overrides,
  };
}

function interrupts() {
  return [{
    id: continuation.interruptId,
    kind: "additional_authority" as const,
    requestId: nextReference().authorizationRequestId,
  }];
}

function parkReceipt(overrides: Record<string, unknown> = {}) {
  return {
    version: 1,
    taskId: ids.task,
    taskRunId: ids.run,
    jobId: ids.priorJob,
    graphThreadId,
    generation: 3,
    executionSegment: 1,
    interrupts: interrupts(),
    parkedAt: parkedAt.toISOString(),
    ...overrides,
  };
}

function input(
  overrides: Partial<
    StartParkedProtectedTaskRunAdditionalAuthoritySegmentInput
  > = {},
): StartParkedProtectedTaskRunAdditionalAuthoritySegmentInput {
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
    cryptoRequiredNamespaceFingerprint: definitionFingerprint.slice(),
    priorJobReference: priorReference(),
    jobReference: nextReference(),
    checkpointManifest: {
      ...checkpointManifest,
      checkpointOrderedDigest: checkpointManifest.checkpointOrderedDigest.slice(),
      blobOrderedDigest: checkpointManifest.blobOrderedDigest.slice(),
      pendingWriteOrderedDigest: checkpointManifest.pendingWriteOrderedDigest.slice(),
    },
    continuation: {
      ...continuation,
      requestDigest: continuation.requestDigest.slice(),
      requiredAuthorityDigest: continuation.requiredAuthorityDigest.slice(),
    },
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
    targetUserIds: [],
    lastError: null,
    contentRepresentation: "protected",
    contentNamespaceId: ids.namespace,
    contentRevision: 4,
    cryptoObjectId: definitionObjectId,
    cryptoAccessRevision: 6,
    cryptoRequiredNamespaceFingerprint: definitionFingerprint,
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
    startedAt: new Date("2026-10-07T12:00:00.000Z"),
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
    createdAt: new Date("2026-10-07T12:00:01.000Z"),
    startedAt: new Date("2026-10-07T12:00:02.000Z"),
    completedAt: parkedAt,
    metadata: { [parkReceiptKey]: parkReceipt() },
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
    createdAt: new Date("2026-10-07T12:35:00.000Z"),
    startedAt: null,
    completedAt: null,
    metadata: {},
    ...overrides,
  };
}

function segmentReceipt(overrides: Record<string, unknown> = {}) {
  return {
    taskRunId: ids.run,
    executionSegment: 1,
    jobId: ids.priorJob,
    route: "native_langgraph_v1",
    transcriptContract: "protected_message_associations_v1",
    expectedTranscriptAssociationCount: 0,
    transcriptAssociationDigest: transcriptDigest,
    checkpointContract: checkpointManifest.contract,
    expectedCheckpointCount: checkpointManifest.expectedCheckpointCount,
    checkpointDigest: checkpointManifest.checkpointOrderedDigest,
    expectedCheckpointBlobCount: checkpointManifest.expectedBlobCount,
    checkpointBlobDigest: checkpointManifest.blobOrderedDigest,
    expectedPendingWriteCount: checkpointManifest.expectedPendingWriteCount,
    pendingWriteDigest: checkpointManifest.pendingWriteOrderedDigest,
    sealedAt: parkedAt,
    ...overrides,
  };
}

function continuationReceipt(overrides: Record<string, unknown> = {}) {
  return {
    taskRunId: ids.run,
    executionSegment: 1,
    jobId: ids.priorJob,
    kind: "pre_effect_interrupt_v1",
    reason: "additional_authority",
    effectDisposition: "not_started_v1",
    ...continuation,
    sealedAt: parkedAt,
    ...overrides,
  };
}

type HarnessOptions = Readonly<{
  task?: Task | undefined;
  run?: TaskRun | undefined;
  priorJob?: Job | undefined;
  nextJob?: Job | undefined;
  segment?: ReturnType<typeof segmentReceipt> | undefined;
  continuation?: ReturnType<typeof continuationReceipt> | undefined;
  transcriptRows?: readonly Record<string, unknown>[];
  loseRunUpdate?: boolean;
  loseTaskUpdate?: boolean;
}>;

function harness(options: HarnessOptions = {}) {
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
  const segmentRow = Object.prototype.hasOwnProperty.call(options, "segment")
    ? options.segment
    : segmentReceipt();
  const continuationRow = Object.prototype.hasOwnProperty.call(
    options,
    "continuation",
  ) ? options.continuation : continuationReceipt();
  let lockedJobRead = 0;
  const locks: Array<{ table: unknown; kind: string }> = [];
  const writes: Array<{ table: unknown; patch: Record<string, unknown> }> = [];

  const rows = (table: unknown, locked: boolean): unknown[] => {
    if (table === tasks) return taskRow ? [taskRow] : [];
    if (table === taskRuns) return runRow ? [runRow] : [];
    if (table === jobs) {
      if (!locked) throw new Error("unexpected unlocked Job read");
      const row = lockedJobRead === 0 ? priorJobRow : nextJobRow;
      lockedJobRead += 1;
      return row ? [row] : [];
    }
    if (table === protectedTaskExecutionSegmentReceipts) {
      return segmentRow ? [segmentRow] : [];
    }
    if (table === protectedTaskContinuationReceipts) {
      return continuationRow ? [continuationRow] : [];
    }
    if (table === taskRunMessageAssociations) {
      return [...(options.transcriptRows ?? [])];
    }
    throw new Error("unexpected table");
  };
  const tx = {
    select: () => ({
      from: (table: unknown) => {
        let limitValue: number | undefined;
        const query = {
          where: (_condition: unknown) => query,
          limit: (limit: number) => {
            limitValue = limit;
            return query;
          },
          orderBy: (_order: unknown) => query,
          for: async (kind: string) => {
            locks.push({ table, kind });
            return rows(table, true);
          },
          then: <TResult1 = unknown[]>(
            resolve: (value: unknown[]) => TResult1 | PromiseLike<TResult1>,
          ) => {
            const selectedRows = rows(table, false);
            return Promise.resolve(limitValue === undefined
              ? selectedRows
              : selectedRows.slice(0, limitValue)).then(resolve);
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
  return { db, locks, tx, writes };
}

async function expectMalformed(promise: Promise<unknown>): Promise<void> {
  let failure: unknown;
  try {
    await promise;
  } catch (error) {
    failure = error;
  }
  expect(failure).toBeInstanceOf(Error);
  expect((failure as Error).message).toContain("segment binding is malformed");
}

describe("protected Task additional-authority segment start CAS", () => {
  test("locks the aggregate in order and starts the exact proven segment", async () => {
    const fixture = harness();

    expect(await startParkedProtectedTaskRunAdditionalAuthoritySegment(
      fixture.db,
      input(),
    )).toEqual({ status: "started" });
    expect(fixture.locks).toEqual([
      { table: tasks, kind: "update" },
      { table: taskRuns, kind: "update" },
      { table: jobs, kind: "update" },
      { table: jobs, kind: "update" },
    ]);
    expect(fixture.writes).toHaveLength(2);
    expect(fixture.writes[0]).toEqual({
      table: taskRuns,
      patch: { status: "running", jobId: ids.job },
    });
    expect(fixture.writes[1]?.table).toBe(tasks);
    expect(fixture.writes[1]?.patch["status"]).toBe("running");
  });

  test("accepts the exact started segment as replay without a consumed marker", async () => {
    const fixture = harness({
      task: task({ status: "running" }),
      run: run({ status: "running", jobId: ids.job }),
      nextJob: nextJob({
        status: "running",
        startedAt: new Date("2026-10-07T12:35:01.000Z"),
      }),
      transcriptRows: [{
        taskRunId: ids.run,
        sessionId: "70000000-0000-4000-8000-000000000008",
        messageId: 1,
        publishedRevision: 0,
        kind: "transcript",
        publicationKey: "segment-2-publication",
      }],
    });
    expect(await startParkedProtectedTaskRunAdditionalAuthoritySegment(
      fixture.db,
      input({ checkpointManifest: {
        ...checkpointManifest,
        checkpointOrderedDigest: digest(9),
      } }),
    )).toEqual({ status: "exact_replay" });
    expect(fixture.writes).toEqual([]);
  });

  test("requires both exact receipts and current physical manifests", async () => {
    const cases: Array<{
      options?: HarnessOptions;
      value?: StartParkedProtectedTaskRunAdditionalAuthoritySegmentInput;
    }> = [
      { options: { segment: undefined } },
      { options: { continuation: undefined } },
      { options: { segment: segmentReceipt({ expectedCheckpointCount: 0 }) } },
      { options: { segment: segmentReceipt({ transcriptAssociationDigest: digest(8) }) } },
      { options: { continuation: continuationReceipt({ operationId: "tool-call:other" }) } },
      { value: input({ checkpointManifest: {
        ...checkpointManifest,
        checkpointOrderedDigest: digest(9),
      } }) },
    ];
    for (const candidate of cases) {
      const fixture = harness(candidate.options);
      expect(await startParkedProtectedTaskRunAdditionalAuthoritySegment(
        fixture.db,
        candidate.value ?? input(),
      )).toEqual({ status: "rejected", reason: "conflict" });
      expect(fixture.writes).toEqual([]);
    }
  });

  test("rejects Plain, cancelled, terminal, and changed Job state", async () => {
    for (const options of [
      { task: task({ contentRepresentation: "ordinary" }) },
      { task: task({ status: "cancelled" }) },
      { run: run({ status: "cancelled", completedAt: parkedAt }) },
      { priorJob: priorJob({ status: "cancelled" }) },
      { nextJob: nextJob({ metadata: { hidden: true } }) },
      { nextJob: nextJob({ input: { ...nextReference(), hidden: true } }) },
    ] satisfies HarnessOptions[]) {
      const fixture = harness(options);
      expect(await startParkedProtectedTaskRunAdditionalAuthoritySegment(
        fixture.db,
        input(),
      )).toEqual({ status: "rejected", reason: "stale" });
      expect(fixture.writes).toEqual([]);
    }
  });

  test("rejects altered authority succession before opening a transaction", async () => {
    let transactions = 0;
    const db = {
      transaction: () => {
        transactions += 1;
        throw new Error("transaction must stay closed");
      },
    } as unknown as DirectDatabase;
    await expectMalformed(startParkedProtectedTaskRunAdditionalAuthoritySegment(
      db,
      input({ jobReference: nextReference({
        resumeContinuationFingerprint: "a".repeat(43),
      }) }),
    ));
    await expectMalformed(startParkedProtectedTaskRunAdditionalAuthoritySegment(
      db,
      input({ interrupts: [{
        id: continuation.interruptId,
        kind: "additional_authority",
        requestId: "another-request",
      }] }),
    ));
    await expectMalformed(startParkedProtectedTaskRunAdditionalAuthoritySegment(
      db,
      input({ jobReference: {
        ...nextReference(),
        resumeAcceptanceId: "human-acceptance",
      } }),
    ));
    await expectMalformed(startParkedProtectedTaskRunAdditionalAuthoritySegment(
      db,
      input({ checkpointManifest: {
        ...checkpointManifest,
        expectedCheckpointCount: 0,
      } }),
    ));
    expect(transactions).toBe(0);
  });

  test("copies caller-owned byte inputs before the transaction begins", async () => {
    const value = input();
    const base = harness();
    const db = {
      transaction: async <T>(operation: (tx: never) => Promise<T>) => {
        value.cryptoRequiredNamespaceFingerprint.fill(0xff);
        value.continuation.requestDigest.fill(0xff);
        value.checkpointManifest.checkpointOrderedDigest?.fill(0xff);
        return operation(base.tx as never);
      },
    } as unknown as DirectDatabase;
    expect(await startParkedProtectedTaskRunAdditionalAuthoritySegment(
      db,
      value,
    )).toEqual({ status: "started" });
  });

  test("throws to roll back if either lifecycle update loses its row", () => {
    expect(startParkedProtectedTaskRunAdditionalAuthoritySegment(
      harness({ loseRunUpdate: true }).db,
      input(),
    )).rejects.toThrow("lost its TaskRun");
    expect(startParkedProtectedTaskRunAdditionalAuthoritySegment(
      harness({ loseTaskUpdate: true }).db,
      input(),
    )).rejects.toThrow("lost its Task");
  });
});
