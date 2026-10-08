import { describe, expect, test } from "bun:test";
import { getTableName } from "drizzle-orm";

import type { DirectDatabase } from "../../src/config/direct-database";
import {
  recoverUnstartedParkedProtectedTaskRun,
} from "../../src/queries/protected-task-parked-preexecution";
import {
  listUnstartedProtectedTaskRunRecoveryCandidates,
} from "../../src/queries/protected-task-preexecution";
import {
  projectParkedProtectedTaskRecoveryCandidate,
  type ParkedProtectedTaskRecoveryCandidateRow,
} from "../../src/queries/protected-task-parked-recovery-candidate";
import {
  protectedTaskAdditionalAuthorityContinuationFingerprint,
  protectedTaskSemanticAuthorityRequirementsDigest,
} from "../../src/queries/protected-task-execution-receipts";
import type {
  ProtectedTaskDurableJobReference,
  StartParkedProtectedTaskRunAdditionalAuthoritySegmentInput,
} from "../../src/queries/tasks";
import { jobs } from "../../src/schema/jobs";
import { protectedTaskContinuationReceipts } from
  "../../src/schema/protected-task-continuation-receipts";
import { protectedTaskExecutionSegmentReceipts } from
  "../../src/schema/protected-task-execution-segment-receipts";
import { taskRuns } from "../../src/schema/task-runs";
import { tasks } from "../../src/schema/tasks";

const ids = {
  task: "10000000-0000-4000-8000-000000000001",
  run: "20000000-0000-4000-8000-000000000002",
  priorJob: "30000000-0000-4000-8000-000000000003",
  nextJob: "30000000-0000-4000-8000-000000000004",
  owner: "40000000-0000-4000-8000-000000000005",
  namespace: "60000000-0000-4000-8000-000000000006",
};
const graphThreadId = `subagent:${ids.task}:${ids.run}`;
const definitionObjectId = `task-definition:v1:${"a".repeat(64)}`;
const resultObjectId =
  "task-run-result:v1:c3d2c1c68222360a4404fe37119db6e3e7fcf973c1f1ccf2c4a894683c83705e";
const parkedAt = new Date("2026-10-08T10:00:00.000Z");
const recoveredAt = new Date("2026-10-08T10:01:00.000Z");
const digest = (seed: number): Uint8Array =>
  new Uint8Array(Array.from({ length: 32 }, (_, index) => seed + index));
const semanticAuthorityRequirements = Object.freeze([Object.freeze({
  namespaceId: ids.namespace,
  operations: Object.freeze(["decrypt", "encrypt"] as const),
})]);
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
  requiredAuthorityDigest: protectedTaskSemanticAuthorityRequirementsDigest(
    semanticAuthorityRequirements,
  ),
  stableRoutingDigest: digest(6),
  semanticAuthorityRequirements,
});

function priorReference(
  segment = 1,
  overrides: Partial<ProtectedTaskDurableJobReference> = {},
): ProtectedTaskDurableJobReference {
  return {
    kind: "protected_task_run_v1",
    taskId: ids.task,
    taskRunId: ids.run,
    inputObjectId: definitionObjectId,
    resultObjectId,
    authorizationRequestId: `task-run-authorization:${ids.run}:segment:${segment}`,
    policyRevision: 9,
    executionSegment: segment,
    ...(segment > 1 ? { resumeContinuationFingerprint: "b".repeat(43) } : {}),
    ...overrides,
  };
}

function nextReference(segment = 1): ProtectedTaskDurableJobReference {
  return {
    ...priorReference(segment),
    authorizationRequestId:
      `task-run-authorization:${ids.run}:segment:${segment + 1}`,
    policyRevision: 10,
    executionSegment: segment + 1,
    resumeContinuationFingerprint:
      protectedTaskAdditionalAuthorityContinuationFingerprint({
        taskRunId: ids.run,
        executionSegment: segment,
        jobId: ids.priorJob,
        kind: "pre_effect_interrupt_v1",
        reason: "additional_authority",
        effectDisposition: "not_started_v1",
        ...continuation,
      }),
  };
}

function interrupts(segment = 1) {
  return [{
    id: continuation.interruptId,
    kind: "additional_authority" as const,
    requestId: nextReference(segment).authorizationRequestId,
  }];
}

function input(
  segment = 1,
  overrides: Partial<
    StartParkedProtectedTaskRunAdditionalAuthoritySegmentInput
  > = {},
): StartParkedProtectedTaskRunAdditionalAuthoritySegmentInput {
  return {
    taskId: ids.task,
    taskRunId: ids.run,
    graphThreadId,
    priorJobId: ids.priorJob,
    jobId: ids.nextJob,
    generation: 3,
    interrupts: interrupts(segment),
    parkedAt,
    contentRepresentation: "protected",
    contentNamespaceId: ids.namespace,
    contentRevision: 4,
    cryptoObjectId: definitionObjectId,
    cryptoAccessRevision: 6,
    cryptoRequiredNamespaceFingerprint: digest(1),
    priorJobReference: priorReference(segment),
    jobReference: nextReference(segment),
    checkpointManifest: {
      ...checkpointManifest,
      checkpointOrderedDigest:
        checkpointManifest.checkpointOrderedDigest.slice(),
      blobOrderedDigest: checkpointManifest.blobOrderedDigest.slice(),
      pendingWriteOrderedDigest:
        checkpointManifest.pendingWriteOrderedDigest.slice(),
    },
    continuation: {
      ...continuation,
      requestDigest: continuation.requestDigest.slice(),
      requiredAuthorityDigest: continuation.requiredAuthorityDigest.slice(),
      stableRoutingDigest: continuation.stableRoutingDigest.slice(),
    },
    ...overrides,
  };
}

function parkReceipt(segment = 1, overrides: Record<string, unknown> = {}) {
  return {
    version: 1,
    taskId: ids.task,
    taskRunId: ids.run,
    jobId: ids.priorJob,
    graphThreadId,
    generation: 3,
    executionSegment: segment,
    interrupts: interrupts(segment),
    parkedAt: parkedAt.toISOString(),
    ...overrides,
  };
}

function taskRow(overrides: Record<string, unknown> = {}) {
  return {
    id: ids.task,
    requestorId: ids.owner,
    scheduleKind: "one_shot",
    status: "awaiting",
    contentRepresentation: "protected",
    contentNamespaceId: ids.namespace,
    contentRevision: 4,
    cryptoObjectId: definitionObjectId,
    cryptoAccessRevision: 6,
    cryptoRequiredNamespaceFingerprint: digest(1),
    cryptoMappingState: "verified",
    contentPristine: true,
    ...overrides,
  };
}

function runRow(overrides: Record<string, unknown> = {}) {
  return {
    id: ids.run,
    taskId: ids.task,
    jobId: ids.priorJob,
    graphThreadId,
    status: "awaiting",
    pristine: true,
    ...overrides,
  };
}

function priorJobRow(
  segment = 1,
  overrides: Record<string, unknown> = {},
) {
  return {
    id: ids.priorJob,
    ownerId: ids.owner,
    requestorId: ids.owner,
    laneKey: `task:${ids.task}`,
    type: "foreground",
    status: "completed",
    reference: priorReference(segment),
    startedAt: new Date("2026-10-08T09:59:00.000Z"),
    completedAt: parkedAt,
    parkReceipt: parkReceipt(segment),
    pristine: true,
    ...overrides,
  };
}

function nextJobRow(
  segment = 1,
  overrides: Record<string, unknown> = {},
) {
  return {
    id: ids.nextJob,
    ownerId: ids.owner,
    requestorId: ids.owner,
    laneKey: `task:${ids.task}`,
    type: "foreground",
    status: "queued",
    reference: nextReference(segment),
    startedAt: null,
    completedAt: null,
    pristine: true,
    ...overrides,
  };
}

function segmentReceipt(
  segment = 1,
  overrides: Record<string, unknown> = {},
) {
  return {
    taskRunId: ids.run,
    executionSegment: segment,
    jobId: ids.priorJob,
    route: "native_langgraph_v1",
    transcriptContract: "protected_message_associations_v1",
    expectedTranscriptAssociationCount: 0,
    transcriptAssociationDigest: digest(7),
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

function continuationReceipt(
  segment = 1,
  overrides: Record<string, unknown> = {},
) {
  return {
    taskRunId: ids.run,
    executionSegment: segment,
    jobId: ids.priorJob,
    kind: "pre_effect_interrupt_v1",
    reason: "additional_authority",
    effectDisposition: "not_started_v1",
    ...continuation,
    sealedAt: parkedAt,
    ...overrides,
  };
}

function discoveryRow(
  segment = 1,
  overrides: Partial<ParkedProtectedTaskRecoveryCandidateRow> = {},
): ParkedProtectedTaskRecoveryCandidateRow {
  return {
    task: taskRow(),
    run: {
      ...runRow(),
      modelId: "openai:gpt-6-sol",
      fundingPristine: true,
    },
    priorJob: priorJobRow(segment),
    nextJob: nextJobRow(segment),
    segment: segmentReceipt(segment) as
      ParkedProtectedTaskRecoveryCandidateRow["segment"],
    continuation: continuationReceipt(segment) as
      ParkedProtectedTaskRecoveryCandidateRow["continuation"],
    ...overrides,
  };
}

describe("parked protected Task pre-execution recovery discovery", () => {
  test("reconstructs a model-bound segment 3 continuation from immutable proof", () => {
    const projected = projectParkedProtectedTaskRecoveryCandidate(
      discoveryRow(3),
    );
    expect(projected).toEqual({ lifecycle: "parked", input: input(3) });
  });

  test("reconstructs a linked cancelled continuation", () => {
    const projected = projectParkedProtectedTaskRecoveryCandidate(discoveryRow(
      1,
      {
        task: taskRow({ status: "running" }),
        run: {
          ...runRow({ status: "running", jobId: ids.nextJob }),
          modelId: "openai:gpt-6-sol",
          fundingPristine: true,
        },
        nextJob: nextJobRow(1, {
          status: "cancelled",
          completedAt: recoveredAt,
        }),
      },
    ));
    expect(projected?.lifecycle).toBe("linked");
    expect(projected?.input.jobId).toBe(ids.nextJob);
  });

  test("rejects mismatched prior receipts, proof and execution evidence", () => {
    const mismatches = [
      discoveryRow(1, {
        priorJob: priorJobRow(1, {
          parkReceipt: parkReceipt(1, { taskId: ids.run }),
        }),
      }),
      discoveryRow(1, {
        segment: segmentReceipt(1, { jobId: ids.nextJob }) as
          ParkedProtectedTaskRecoveryCandidateRow["segment"],
      }),
      discoveryRow(1, {
        continuation: continuationReceipt(1, {
          requestDigest: digest(19),
        }) as ParkedProtectedTaskRecoveryCandidateRow["continuation"],
      }),
      discoveryRow(1, {
        nextJob: nextJobRow(1, { startedAt: recoveredAt }),
      }),
    ];
    for (const candidate of mismatches) {
      expect(projectParkedProtectedTaskRecoveryCandidate(candidate)).toBeNull();
    }
  });

  test("pages an old cancelled and a newer queued copy independently", async () => {
    const oldJobId = "30000000-0000-4000-8000-000000000009";
    const old = discoveryRow(1, {
      nextJob: nextJobRow(1, {
        id: oldJobId,
        status: "cancelled",
        completedAt: recoveredAt,
      }),
    });
    const current = discoveryRow(1);
    const rows = [
      {
        task: old.task,
        run: old.run,
        job: old.nextJob,
        priorJob: old.priorJob,
        segment: old.segment,
        continuation: old.continuation,
        cursorCreatedAt: "2026-10-08 10:01:00.000001",
      },
      {
        task: current.task,
        run: current.run,
        job: current.nextJob,
        priorJob: current.priorJob,
        segment: current.segment,
        continuation: current.continuation,
        cursorCreatedAt: "2026-10-08 10:01:00.000002",
      },
    ];
    const query = {
      innerJoin: () => query,
      leftJoin: () => query,
      where: () => query,
      orderBy: () => query,
      limit: async () => rows,
    };
    const db = {
      select: () => ({ from: () => query }),
    } as unknown as DirectDatabase;
    const page = await listUnstartedProtectedTaskRunRecoveryCandidates(db, {
      limit: 2,
      through: {
        createdAt: "2026-10-08 11:00:00.000000",
        jobId: "f0000000-0000-4000-8000-00000000000f",
      },
    });
    expect(page.candidates.map(candidate => ({
      route: candidate.route,
      jobId: candidate.input.jobId,
      status: candidate.jobStatus,
    }))).toEqual([
      {
        route: "parked_additional_authority",
        jobId: oldJobId,
        status: "cancelled",
      },
      {
        route: "parked_additional_authority",
        jobId: ids.nextJob,
        status: "queued",
      },
    ]);
    expect(page.continuation).toEqual({
      createdAt: "2026-10-08 10:01:00.000002",
      jobId: ids.nextJob,
    });
  });
});

type HarnessOptions = Readonly<{
  segment?: number;
  task?: ReturnType<typeof taskRow>;
  run?: ReturnType<typeof runRow>;
  priorJob?: ReturnType<typeof priorJobRow>;
  nextJob?: ReturnType<typeof nextJobRow>;
  segmentReceipt?: ReturnType<typeof segmentReceipt>;
  continuationReceipt?: ReturnType<typeof continuationReceipt>;
}>;

function harness(options: HarnessOptions = {}) {
  const segment = options.segment ?? 1;
  let currentTask = options.task ?? taskRow();
  let currentRun = options.run ?? runRow();
  const currentPriorJob = options.priorJob ?? priorJobRow(segment);
  let currentNextJob = options.nextJob ?? nextJobRow(segment);
  const currentSegment = options.segmentReceipt ?? segmentReceipt(segment);
  const currentContinuation = options.continuationReceipt
    ?? continuationReceipt(segment);
  const locks: string[] = [];
  const writes: Array<{ table: unknown; patch: Record<string, unknown> }> = [];
  let transactionCount = 0;

  const db = {
    transaction: async <T>(operation: (value: unknown) => Promise<T>) => {
      transactionCount += 1;
      let lockedJobRead = 0;
      const rows = (table: unknown, locked: boolean): unknown[] => {
        if (table === tasks) return [currentTask];
        if (table === taskRuns) return [currentRun];
        if (table === jobs) {
          if (!locked) throw new Error("unexpected unlocked Job read");
          const row = lockedJobRead === 0 ? currentPriorJob : currentNextJob;
          lockedJobRead += 1;
          return [row];
        }
        if (table === protectedTaskExecutionSegmentReceipts) {
          return [currentSegment];
        }
        if (table === protectedTaskContinuationReceipts) {
          return [currentContinuation];
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
                locks.push(`${getTableName(table as typeof tasks)}:${kind}`);
                return rows(table, true);
              },
              then: <TResult1 = unknown[]>(
                resolve: (value: unknown[]) => TResult1 | PromiseLike<TResult1>,
              ) => Promise.resolve(rows(table, false)).then(resolve),
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
                  currentNextJob = { ...currentNextJob, ...patch };
                  return [{ id: ids.nextJob }];
                }
                if (table === taskRuns) {
                  currentRun = { ...currentRun, ...patch };
                  return [{ id: ids.run }];
                }
                if (table === tasks) {
                  currentTask = { ...currentTask, ...patch };
                  return [{ id: ids.task }];
                }
                throw new Error("unexpected update table");
              },
            }),
          }),
        }),
      };
      return operation(tx);
    },
  } as unknown as DirectDatabase;
  return {
    db,
    locks,
    writes,
    transactionCount: () => transactionCount,
  };
}

describe("parked protected Task pre-execution recovery", () => {
  test("cancels an unlinked queued continuation before deferring authority", async () => {
    const fixture = harness();
    let deferredAfterCancellation = false;
    expect(await recoverUnstartedParkedProtectedTaskRun(
      fixture.db,
      input(),
      recoveredAt,
      async () => {
        deferredAfterCancellation = fixture.writes.some(write =>
          write.table === jobs && write.patch["status"] === "cancelled"
        );
        return true;
      },
    )).toEqual({ status: "recovered" });
    expect(deferredAfterCancellation).toBe(true);
    expect(fixture.writes).toEqual([{
      table: jobs,
      patch: { status: "cancelled", completedAt: recoveredAt },
    }]);
    expect(fixture.locks.slice(0, 4)).toEqual([
      "tasks:update",
      "task_runs:update",
      "jobs:update",
      "jobs:update",
    ]);
  });

  test("restores a linked Run only after durable cancellation and deferral", async () => {
    const fixture = harness({
      task: taskRow({ status: "running" }),
      run: runRow({ status: "running", jobId: ids.nextJob }),
    });
    expect(await recoverUnstartedParkedProtectedTaskRun(
      fixture.db,
      input(),
      recoveredAt,
      async () => true,
    )).toEqual({ status: "recovered" });
    expect(fixture.writes.map(write => ({
      table: write.table,
      status: write.patch["status"],
      jobId: write.patch["jobId"],
    }))).toEqual([
      { table: jobs, status: "cancelled", jobId: undefined },
      { table: taskRuns, status: "awaiting", jobId: ids.priorJob },
      { table: tasks, status: "awaiting", jobId: undefined },
    ]);
  });

  test("supports a later continuation segment without weakening succession", async () => {
    const fixture = harness({ segment: 3 });
    expect(await recoverUnstartedParkedProtectedTaskRun(
      fixture.db,
      input(3),
      recoveredAt,
      async () => true,
    )).toEqual({ status: "recovered" });
  });

  test("rejects mismatched mapping and immutable hand-off proof", async () => {
    for (const options of [
      { task: taskRow({ cryptoAccessRevision: 7 }) },
      { priorJob: priorJobRow(1, {
        parkReceipt: parkReceipt(1, { generation: 4 }),
      }) },
      { continuationReceipt: continuationReceipt(1, {
        operationId: "tool-call:other",
      }) },
      { segmentReceipt: segmentReceipt(1, {
        checkpointDigest: digest(20),
      }) },
    ] satisfies HarnessOptions[]) {
      const fixture = harness(options);
      let deferred = 0;
      expect(await recoverUnstartedParkedProtectedTaskRun(
        fixture.db,
        input(),
        recoveredAt,
        async () => { deferred += 1; return true; },
      )).toEqual({ status: "stale" });
      expect(deferred).toBe(0);
      expect(fixture.writes).toEqual([]);
    }
  });

  test("rejects any started or effectful replacement Job", async () => {
    const fixture = harness({
      task: taskRow({ status: "running" }),
      run: runRow({ status: "running", jobId: ids.nextJob }),
      nextJob: nextJobRow(1, {
        status: "running",
        startedAt: new Date("2026-10-08T10:00:30.000Z"),
      }),
    });
    expect(await recoverUnstartedParkedProtectedTaskRun(
      fixture.db,
      input(),
      recoveredAt,
      async () => true,
    )).toEqual({ status: "stale" });
    expect(fixture.writes).toEqual([]);
  });

  test("loses cleanly to Stop and does not accept a false cancelled replay", async () => {
    const stopped = harness({
      task: taskRow({ status: "cancelled" }),
      run: runRow({ status: "cancelled", jobId: ids.nextJob }),
      nextJob: nextJobRow(1, {
        status: "cancelled",
        completedAt: new Date("2026-10-08T10:00:30.000Z"),
      }),
    });
    expect(await recoverUnstartedParkedProtectedTaskRun(
      stopped.db,
      input(),
      recoveredAt,
      async () => true,
    )).toEqual({ status: "stale" });

    const falseReplay = harness({
      nextJob: nextJobRow(1, {
        status: "cancelled",
        completedAt: new Date("2026-10-08T09:59:59.000Z"),
      }),
    });
    expect(await recoverUnstartedParkedProtectedTaskRun(
      falseReplay.db,
      input(),
      recoveredAt,
      async () => true,
    )).toEqual({ status: "stale" });
  });

  test("reports durable cancellation when authority deferral cannot commit", async () => {
    const fixture = harness();
    expect(await recoverUnstartedParkedProtectedTaskRun(
      fixture.db,
      input(),
      recoveredAt,
      async () => false,
    )).toEqual({ status: "cancelled" });
    expect(fixture.writes).toHaveLength(1);
  });

  test("replays an exact cancelled and restored recovery", async () => {
    const fixture = harness();
    expect(await recoverUnstartedParkedProtectedTaskRun(
      fixture.db,
      input(),
      recoveredAt,
      async () => true,
    )).toEqual({ status: "recovered" });
    const writes = fixture.writes.length;
    expect(await recoverUnstartedParkedProtectedTaskRun(
      fixture.db,
      input(),
      new Date("2026-10-08T10:02:00.000Z"),
      async () => true,
    )).toEqual({ status: "exact_replay" });
    expect(fixture.writes).toHaveLength(writes);
    expect(fixture.transactionCount()).toBe(4);
  });
});
