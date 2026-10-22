import { describe, expect, test } from "bun:test";
import { getTableName } from "drizzle-orm";

import type { DirectDatabase } from "../../src/config/direct-database";
import {
  recoverUnstartedParkedProtectedTaskClaim,
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
  ParkedProtectedTaskAdditionalAuthority,
  ParkedProtectedTaskHumanContinuation,
  ProtectedTaskDurableJobReference,
  StartParkedProtectedTaskHumanRunSegmentInput,
  StartParkedProtectedTaskCheckpointSegmentInput,
  StartParkedProtectedTaskRunAdditionalAuthoritySegmentInput,
} from "../../src/queries/tasks";
import {
  parseParkedProtectedTaskAdditionalAuthority,
  parseParkedProtectedTaskHumanContinuation,
  parseParkedProtectedTaskCheckpointContinuation,
  protectedTaskHumanContinuationAcceptanceId,
} from
  "../../src/queries/tasks";
import { jobs } from "../../src/schema/jobs";
import { protectedTaskContinuationReceipts } from
  "../../src/schema/protected-task-continuation-receipts";
import { protectedTaskExecutionSegmentReceipts } from
  "../../src/schema/protected-task-execution-segment-receipts";
import { taskRuns } from "../../src/schema/task-runs";
import { tasks } from "../../src/schema/tasks";
import { actors } from "../../src/schema/trust";

const ids = {
  task: "10000000-0000-4000-8000-000000000001",
  run: "20000000-0000-4000-8000-000000000002",
  priorJob: "30000000-0000-4000-8000-000000000003",
  nextJob: "30000000-0000-4000-8000-000000000004",
  owner: "40000000-0000-4000-8000-000000000005",
  humanActor: "40000000-0000-4000-8000-000000000015",
  namespace: "60000000-0000-4000-8000-000000000006",
};
const graphThreadId = `subagent:${ids.task}:${ids.run}`;
const parkReceiptKey = "nautilo.protectedTaskRunPark.v1";
const humanAcceptanceReceiptKey =
  "nautilo.protectedTaskHumanContinuationAcceptance.v1";
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
const humanStableRoutingDigest = digest(20);
const humanInterrupt = Object.freeze({
  id: "interrupt:identity:1",
  kind: "identity" as const,
});

function humanAcceptanceId(): string {
  return protectedTaskHumanContinuationAcceptanceId({
    taskId: ids.task,
    taskRunId: ids.run,
    priorJobId: ids.priorJob,
    executionSegment: 1,
    acceptedBy: { userId: ids.owner, humanActorId: ids.humanActor },
    interrupt: humanInterrupt,
    response: { kind: "identity" },
  });
}

function humanAcceptance() {
  return Object.freeze({
    acceptanceId: humanAcceptanceId(),
    acceptedBy: Object.freeze({
      userId: ids.owner,
      humanActorId: ids.humanActor,
    }),
    interrupt: humanInterrupt,
    response: Object.freeze({ kind: "identity" as const }),
    acceptedAt: new Date("2026-10-08T10:00:30.000Z"),
  });
}

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

function humanNextReference(): ProtectedTaskDurableJobReference {
  return {
    ...priorReference(),
    authorizationRequestId: humanAcceptanceId(),
    executionSegment: 2,
    resumeAcceptanceId: humanAcceptanceId(),
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

function humanInput(
  overrides: Partial<StartParkedProtectedTaskHumanRunSegmentInput> = {},
): StartParkedProtectedTaskHumanRunSegmentInput {
  return {
    taskId: ids.task,
    taskRunId: ids.run,
    graphThreadId,
    priorJobId: ids.priorJob,
    jobId: ids.nextJob,
    generation: 3,
    interrupts: [humanInterrupt],
    parkedAt,
    stableRoutingDigest: humanStableRoutingDigest.slice(),
    contentRepresentation: "protected",
    contentNamespaceId: ids.namespace,
    contentRevision: 4,
    cryptoObjectId: definitionObjectId,
    cryptoAccessRevision: 6,
    cryptoRequiredNamespaceFingerprint: digest(1),
    priorJobReference: priorReference(),
    jobReference: humanNextReference(),
    checkpointManifest: {
      ...checkpointManifest,
      checkpointOrderedDigest:
        checkpointManifest.checkpointOrderedDigest.slice(),
      blobOrderedDigest: checkpointManifest.blobOrderedDigest.slice(),
      pendingWriteOrderedDigest:
        checkpointManifest.pendingWriteOrderedDigest.slice(),
    },
    acceptance: humanAcceptance(),
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

function humanParkReceipt(overrides: Record<string, unknown> = {}) {
  return parkReceipt(1, {
    interrupts: [humanInterrupt],
    stableRoutingDigest:
      Buffer.from(humanStableRoutingDigest).toString("base64url"),
    ...overrides,
  });
}

function humanAcceptanceReceipt(overrides: Record<string, unknown> = {}) {
  const acceptance = humanAcceptance();
  return {
    version: 1,
    acceptanceId: acceptance.acceptanceId,
    taskId: ids.task,
    taskRunId: ids.run,
    jobId: ids.priorJob,
    graphThreadId,
    generation: 3,
    executionSegment: 1,
    nextExecutionSegment: 2,
    acceptedBy: acceptance.acceptedBy,
    interrupt: acceptance.interrupt,
    response: acceptance.response,
    acceptedAt: acceptance.acceptedAt.toISOString(),
    ...overrides,
  };
}

function taskRow(overrides: Record<string, unknown> = {}) {
  return {
    id: ids.task,
    ownerId: ids.owner,
    requestorId: ids.owner,
    agentId: "50000000-0000-4000-8000-000000000005",
    callingRoomId: null,
    targetRoomId: null,
    targetUserIds: [],
    localExecutionDelegation: null,
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
    startedAt: new Date("2026-10-08T09:59:00.000Z"),
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

function humanPriorJobRow(overrides: Record<string, unknown> = {}) {
  const acceptance = humanAcceptanceReceipt();
  return priorJobRow(1, {
    reference: priorReference(),
    parkReceipt: humanParkReceipt(),
    humanAcceptanceReceipt: acceptance,
    acceptanceReceipt: acceptance,
    metadata: {
      [parkReceiptKey]: humanParkReceipt(),
      [humanAcceptanceReceiptKey]: acceptance,
    },
    ...overrides,
  });
}

function humanNextJobRow(overrides: Record<string, unknown> = {}) {
  return nextJobRow(1, {
    reference: humanNextReference(),
    ...overrides,
  });
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

function expectedAuthority(
  segment = 1,
): ParkedProtectedTaskAdditionalAuthority {
  const expected = parseParkedProtectedTaskAdditionalAuthority({
    task: taskRow() as never,
    run: runRow() as never,
    job: priorJobRow(segment) as never,
    proof: {
      segment: segmentReceipt(segment) as never,
      continuation: continuationReceipt(segment) as never,
    },
    authorizationRequestId: nextReference(segment).authorizationRequestId,
  });
  if (expected === null) throw new Error("invalid parked authority fixture");
  return expected;
}

function expectedHuman(): ParkedProtectedTaskHumanContinuation {
  const expected = parseParkedProtectedTaskHumanContinuation({
    task: taskRow() as never,
    run: runRow() as never,
    job: humanPriorJobRow() as never,
    segment: segmentReceipt() as never,
  });
  if (expected === null) throw new Error("invalid parked Human fixture");
  return expected;
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

function humanDiscoveryRow(
  overrides: Partial<ParkedProtectedTaskRecoveryCandidateRow> = {},
): ParkedProtectedTaskRecoveryCandidateRow {
  return {
    task: taskRow(),
    run: {
      ...runRow(),
      modelId: "openai:gpt-6-sol",
      fundingPristine: true,
    },
    priorJob: humanPriorJobRow(),
    nextJob: humanNextJobRow(),
    segment: segmentReceipt() as
      ParkedProtectedTaskRecoveryCandidateRow["segment"],
    continuation: null,
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

  test("reconstructs an accepted Human continuation from immutable proof", () => {
    expect(projectParkedProtectedTaskRecoveryCandidate(
      humanDiscoveryRow(),
    )).toEqual({ lifecycle: "parked", input: humanInput() });
    expect(projectParkedProtectedTaskRecoveryCandidate(humanDiscoveryRow({
      priorJob: humanPriorJobRow({
        humanAcceptanceReceipt: humanAcceptanceReceipt({
          acceptedBy: {
            userId: ids.owner,
            humanActorId: ids.namespace,
          },
        }),
      }),
    }))).toBeNull();
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
  human?: boolean;
  segment?: number;
  task?: ReturnType<typeof taskRow>;
  run?: ReturnType<typeof runRow>;
  priorJob?: ReturnType<typeof priorJobRow>;
  nextJob?: ReturnType<typeof nextJobRow>;
  segmentReceipt?: ReturnType<typeof segmentReceipt>;
  continuationReceipt?: ReturnType<typeof continuationReceipt> | null;
}>;

function harness(options: HarnessOptions = {}) {
  const segment = options.segment ?? 1;
  let currentTask = options.task ?? taskRow();
  let currentRun = options.run ?? runRow();
  let currentPriorJob: Record<string, unknown> = options.priorJob
    ?? (options.human ? humanPriorJobRow() : priorJobRow(segment));
  let currentNextJob = options.nextJob
    ?? (options.human ? humanNextJobRow() : nextJobRow(segment));
  const currentSegment = options.segmentReceipt ?? segmentReceipt(segment);
  const currentContinuation = Object.prototype.hasOwnProperty.call(
    options,
    "continuationReceipt",
  )
    ? options.continuationReceipt
    : options.human ? null : continuationReceipt(segment);
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
          return currentContinuation === null ? [] : [currentContinuation];
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
                  if (Object.hasOwn(patch, "metadata")) {
                    const metadata = patch["metadata"] as Record<string, unknown>;
                    const acceptance = metadata[humanAcceptanceReceiptKey];
                    currentPriorJob = {
                      ...currentPriorJob,
                      ...patch,
                      humanAcceptanceReceipt: acceptance,
                      acceptanceReceipt: acceptance,
                    };
                    return [{ id: ids.priorJob }];
                  }
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

  test("recovers an accepted Human continuation only from its exact proof", async () => {
    const fixture = harness({ human: true });
    let deferredAfterCancellation = false;
    expect(await recoverUnstartedParkedProtectedTaskRun(
      fixture.db,
      humanInput(),
      recoveredAt,
      async () => {
        deferredAfterCancellation = fixture.writes.some(write =>
          write.table === jobs && write.patch["status"] === "cancelled"
        );
        return true;
      },
    )).toEqual({ status: "recovered" });
    expect(deferredAfterCancellation).toBe(true);

    const stale = harness({
      human: true,
      priorJob: humanPriorJobRow({
        humanAcceptanceReceipt: humanAcceptanceReceipt({
          acceptedBy: {
            userId: ids.owner,
            humanActorId: ids.namespace,
          },
        }),
      }),
    });
    expect(await recoverUnstartedParkedProtectedTaskRun(
      stale.db,
      humanInput(),
      recoveredAt,
      async () => true,
    )).toEqual({ status: "stale" });
    expect(stale.writes).toEqual([]);
  });

  test("restores a consumed Human acceptance after cancelling a linked unstarted Job", async () => {
    const consumed = humanAcceptanceReceipt({ consumedByJobId: ids.nextJob });
    const fixture = harness({
      human: true,
      task: taskRow({ status: "running" }),
      run: runRow({ status: "running", jobId: ids.nextJob }),
      priorJob: humanPriorJobRow({
        humanAcceptanceReceipt: consumed,
        acceptanceReceipt: consumed,
        metadata: {
          [parkReceiptKey]: humanParkReceipt(),
          [humanAcceptanceReceiptKey]: consumed,
        },
      }),
    });
    expect(await recoverUnstartedParkedProtectedTaskRun(
      fixture.db,
      humanInput(),
      recoveredAt,
      async () => true,
    )).toEqual({ status: "recovered" });
    expect(fixture.writes.map(write => ({
      table: write.table,
      status: write.patch["status"],
      jobId: write.patch["jobId"],
      metadata: write.patch["metadata"],
    }))).toEqual([
      { table: jobs, status: "cancelled", jobId: undefined, metadata: undefined },
      {
        table: jobs,
        status: undefined,
        jobId: undefined,
        metadata: {
          [parkReceiptKey]: humanParkReceipt(),
          [humanAcceptanceReceiptKey]: humanAcceptanceReceipt(),
        },
      },
      {
        table: taskRuns,
        status: "awaiting",
        jobId: ids.priorJob,
        metadata: undefined,
      },
      {
        table: tasks,
        status: "awaiting",
        jobId: undefined,
        metadata: undefined,
      },
    ]);

    const writes = fixture.writes.length;
    expect(await recoverUnstartedParkedProtectedTaskRun(
      fixture.db,
      humanInput(),
      new Date("2026-10-08T10:02:00.000Z"),
      async () => true,
    )).toEqual({ status: "exact_replay" });
    expect(fixture.writes).toHaveLength(writes);
  });

  test("never restores a Human continuation after its Job began execution", async () => {
    const consumed = humanAcceptanceReceipt({ consumedByJobId: ids.nextJob });
    const fixture = harness({
      human: true,
      task: taskRow({ status: "running" }),
      run: runRow({ status: "running", jobId: ids.nextJob }),
      priorJob: humanPriorJobRow({
        humanAcceptanceReceipt: consumed,
        acceptanceReceipt: consumed,
        metadata: {
          [parkReceiptKey]: humanParkReceipt(),
          [humanAcceptanceReceiptKey]: consumed,
        },
      }),
      nextJob: humanNextJobRow({
        status: "running",
        startedAt: new Date("2026-10-08T10:00:45.000Z"),
      }),
    });
    expect(await recoverUnstartedParkedProtectedTaskRun(
      fixture.db,
      humanInput(),
      recoveredAt,
      async () => true,
    )).toEqual({ status: "stale" });
    expect(fixture.writes).toEqual([]);
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

function claimJobRow(
  id: string,
  overrides: Record<string, unknown> = {},
) {
  return {
    id,
    ownerId: ids.owner,
    requestorId: ids.owner,
    laneKey: `task:${ids.task}`,
    type: "foreground",
    status: "queued",
    reference: nextReference(),
    startedAt: null,
    completedAt: null,
    pristine: true,
    ...overrides,
  };
}

function claimHarness(
  initialJobs: ReturnType<typeof claimJobRow>[],
  options: Readonly<{ human?: boolean; actorEnabled?: boolean; checkpoint?: ReturnType<typeof checkpointFixture> }> = {},
) {
  let currentJobs = initialJobs.map(row => ({ ...row }));
  const locks: string[] = [];
  const writes: string[][] = [];
  const db = {
    transaction: async <T>(operation: (value: unknown) => Promise<T>) => {
      const rows = (table: unknown, projection: Record<string, unknown>) => {
        if (table === tasks) return [taskRow({
          pauseRequestId: null,
          preset: "task",
          targetUserIds: [],
          useScope: false,
          scopeId: null,
          targetChat: "room",
          targetRoomId: null,
          wideBringBack: true,
        })];
        if (table === taskRuns) return [runRow()];
        if (table === jobs) {
          return Object.hasOwn(projection, "parkReceipt")
            ? [options.checkpoint?.priorJob ?? (options.human ? humanPriorJobRow() : priorJobRow())]
            : currentJobs;
        }
        if (table === protectedTaskExecutionSegmentReceipts) {
          return [segmentReceipt()];
        }
        if (table === protectedTaskContinuationReceipts) {
          return options.human ? [] : [options.checkpoint?.continuation ?? continuationReceipt()];
        }
        if (table === actors) {
          return [{
            humanActorId: ids.humanActor,
            userId: ids.owner,
            kind: "user",
            disabledAt: options.actorEnabled === false ? recoveredAt : null,
          }];
        }
        throw new Error("unexpected table");
      };
      const tx = {
        select: (projection: Record<string, unknown> = {}) => ({
          from: (table: unknown) => {
            const query = {
              innerJoin: (_joined: unknown, _condition: unknown) => query,
              where: (_condition: unknown) => query,
              orderBy: (_order: unknown) => query,
              limit: (_limit: number) => query,
              for: async (kind: string) => {
                locks.push(`${getTableName(table as typeof tasks)}:${kind}`);
                return rows(table, projection);
              },
              then: <TResult1 = unknown[]>(
                resolve: (value: unknown[]) => TResult1 | PromiseLike<TResult1>,
              ) => Promise.resolve(rows(table, projection)).then(resolve),
            };
            return query;
          },
        }),
        update: (table: unknown) => ({
          set: (patch: Record<string, unknown>) => ({
            where: (_condition: unknown) => ({
              returning: async () => {
                if (table !== jobs) throw new Error("unexpected update table");
                const ids = currentJobs.filter(row =>
                  row.status === "queued"
                  && row.startedAt === null
                  && row.completedAt === null
                  && row.pristine
                ).map(row => row.id).sort();
                currentJobs = currentJobs.map(row => ids.includes(row.id)
                  ? { ...row, ...patch }
                  : row);
                writes.push(ids);
                return ids.map(id => ({ id }));
              },
            }),
          }),
        }),
      };
      return operation(tx);
    },
  } as unknown as DirectDatabase;
  return { db, locks, writes };
}

describe("parked protected Task claimed-before-Job recovery", () => {
  test("defers an exact claimed continuation with no persisted Job", async () => {
    const fixture = claimHarness([]);
    let deferred = 0;
    expect(await recoverUnstartedParkedProtectedTaskClaim(
      fixture.db,
      { expected: expectedAuthority(), jobReference: nextReference() },
      recoveredAt,
      async () => { deferred += 1; return true; },
    )).toEqual({ status: "recovered" });
    expect(deferred).toBe(1);
    expect(fixture.writes).toEqual([]);
    expect(fixture.locks.slice(0, 4)).toEqual([
      "tasks:update",
      "task_runs:update",
      "jobs:update",
      "jobs:update",
    ]);
  });

  test("defers an accepted Human continuation with no persisted Job", async () => {
    const fixture = claimHarness([], { human: true });
    let deferred = 0;
    expect(await recoverUnstartedParkedProtectedTaskClaim(
      fixture.db,
      { expected: expectedHuman(), jobReference: humanNextReference() },
      recoveredAt,
      async () => { deferred += 1; return true; },
    )).toEqual({ status: "recovered" });
    expect(deferred).toBe(1);
    expect(fixture.writes).toEqual([]);
    expect(fixture.locks.slice(0, 5)).toEqual([
      "tasks:update",
      "task_runs:update",
      "jobs:update",
      "actors:share",
      "jobs:update",
    ]);

    const revoked = claimHarness([], {
      human: true,
      actorEnabled: false,
    });
    expect(await recoverUnstartedParkedProtectedTaskClaim(
      revoked.db,
      { expected: expectedHuman(), jobReference: humanNextReference() },
      recoveredAt,
      async () => true,
    )).toEqual({ status: "stale" });
  });

  test("cancels every exact queued duplicate and accepts a cancelled replay", async () => {
    const oldId = "30000000-0000-4000-8000-000000000006";
    const newId = "30000000-0000-4000-8000-000000000007";
    const fixture = claimHarness([
      claimJobRow(oldId, { status: "cancelled", completedAt: recoveredAt }),
      claimJobRow(newId),
      claimJobRow(ids.nextJob),
    ]);
    expect(await recoverUnstartedParkedProtectedTaskClaim(
      fixture.db,
      { expected: expectedAuthority(), jobReference: nextReference() },
      recoveredAt,
      async () => true,
    )).toEqual({ status: "recovered" });
    expect(fixture.writes).toEqual([[ids.nextJob, newId].sort()]);

    const replay = claimHarness([
      claimJobRow(oldId, { status: "cancelled", completedAt: recoveredAt }),
    ]);
    expect(await recoverUnstartedParkedProtectedTaskClaim(
      replay.db,
      { expected: expectedAuthority(), jobReference: nextReference() },
      recoveredAt,
      async () => true,
    )).toEqual({ status: "exact_replay" });
  });

  test("rejects started, effectful and substituted exact-reference Jobs", async () => {
    for (const row of [
      claimJobRow(ids.nextJob, {
        status: "running",
        startedAt: recoveredAt,
      }),
      claimJobRow(ids.nextJob, { pristine: false }),
      claimJobRow(ids.nextJob, { ownerId: ids.namespace }),
    ]) {
      const fixture = claimHarness([row]);
      let deferred = 0;
      expect(await recoverUnstartedParkedProtectedTaskClaim(
        fixture.db,
        { expected: expectedAuthority(), jobReference: nextReference() },
        recoveredAt,
        async () => { deferred += 1; return true; },
      )).toEqual({ status: "stale" });
      expect(deferred).toBe(0);
      expect(fixture.writes).toEqual([]);
    }
  });

  test("retains durable cancellation when authorization deferral is unresolved", async () => {
    const fixture = claimHarness([claimJobRow(ids.nextJob)]);
    expect(await recoverUnstartedParkedProtectedTaskClaim(
      fixture.db,
      { expected: expectedAuthority(), jobReference: nextReference() },
      recoveredAt,
      async () => false,
    )).toEqual({ status: "cancelled" });
    expect(fixture.writes).toEqual([[ids.nextJob]]);
  });
});

function checkpointFixture() {
  const park = humanParkReceipt({ interrupts: [] });
  const priorJob = priorJobRow(1, { parkReceipt: park });
  const continuation = continuationReceipt(1, {
    kind: "checkpoint_safe_v1", reason: "grant_refresh", effectDisposition: "none_v1",
    interruptId: null, operationId: null, requestDigest: null, requiredAuthorityDigest: null,
    stableRoutingDigest: null, semanticAuthorityRequirements: null,
  });
  const expected = parseParkedProtectedTaskCheckpointContinuation({
    task: taskRow() as never, run: runRow() as never, job: priorJob as never,
    proof: { segment: segmentReceipt() as never, continuation: continuation as never },
  });
  if (!expected) throw new Error("invalid checkpoint fixture");
  const { acceptance: _acceptance, ...base } = humanInput();
  const start: StartParkedProtectedTaskCheckpointSegmentInput = {
    ...base, interrupts: [], continuationFingerprint: expected.continuationFingerprint,
    jobReference: { ...priorReference(), policyRevision: 10, executionSegment: 2,
      authorizationRequestId: expected.authorizationRequestId,
      resumeContinuationFingerprint: expected.continuationFingerprint,
    },
  };
  return { expected, start, priorJob, continuation,
    nextJob: nextJobRow(1, { reference: start.jobReference }) };
}

describe("checkpoint-safe preexecution recovery", () => {
  test.each([false, true])("cancels and restores only an unstarted checkpoint continuation (linked=%s)", async linked => {
    const value = checkpointFixture();
    const fixture = harness({ priorJob: value.priorJob, nextJob: value.nextJob,
      continuationReceipt: value.continuation,
      task: taskRow({ status: linked ? "running" : "awaiting", pauseRequestId: ids.owner }),
      run: runRow({ status: linked ? "running" : "awaiting", jobId: linked ? ids.nextJob : ids.priorJob }),
    });
    let defers = 0;
    expect(await recoverUnstartedParkedProtectedTaskRun(fixture.db, value.start, recoveredAt, async () => {
      expect(fixture.writes[0]?.patch["status"]).toBe("cancelled"); defers++; return true;
    })).toEqual({ status: "recovered" });
    expect(defers).toBe(1);
    expect(fixture.writes.some(write => "pauseRequestId" in write.patch)).toBe(false);
    expect(await recoverUnstartedParkedProtectedTaskRun(fixture.db, value.start, recoveredAt, async () => true))
      .toEqual({ status: "exact_replay" });
  });

  test("restart discovery reconstructs the genuine checkpoint and rejects substituted physical proof", () => {
    const value = checkpointFixture();
    const row = { ...discoveryRow(), priorJob: value.priorJob, nextJob: value.nextJob,
      continuation: value.continuation as never };
    expect(projectParkedProtectedTaskRecoveryCandidate(row)).toEqual({ lifecycle: "parked", input: value.start });
    expect(projectParkedProtectedTaskRecoveryCandidate({ ...row,
      segment: segmentReceipt(1, { checkpointDigest: digest(17) }) as never,
    })).toBeNull();
  });

  test.each(["running", "routing", "receipt", "policy", "completed"]) ("never defers a checkpoint with %s drift", async changed => {
    const value = checkpointFixture();
    const fixture = harness({
      priorJob: changed === "routing" ? priorJobRow(1, { parkReceipt: humanParkReceipt({ interrupts: [],
        stableRoutingDigest: Buffer.from(digest(19)).toString("base64url") }) }) : value.priorJob,
      nextJob: changed === "running" ? nextJobRow(1, { reference: value.start.jobReference, status: "running", startedAt: recoveredAt }) : value.nextJob,
      continuationReceipt: changed === "receipt" ? null : value.continuation,
      run: changed === "completed" ? runRow({ status: "completed" }) : runRow(),
    });
    let defers = 0;
    const operation = () => recoverUnstartedParkedProtectedTaskRun(fixture.db,
      changed === "policy" ? { ...value.start, jobReference: { ...value.start.jobReference, policyRevision: 8 } } : value.start,
      recoveredAt, async () => { defers++; return true; });
    if (changed === "policy") expect(operation()).rejects.toThrow("binding is malformed");
    else expect(await operation()).toEqual({ status: "stale" });
    expect(defers).toBe(0); expect(fixture.writes).toEqual([]);
  });
});

test.each([false, true])("checkpoint claim recovery fences the queued Job before deferring (persisted=%s)", async persisted => {
  const checkpoint = checkpointFixture();
  const fixture = claimHarness(persisted ? [claimJobRow(ids.nextJob, { reference: checkpoint.start.jobReference })] : [], { checkpoint });
  let deferred = 0;
  expect(await recoverUnstartedParkedProtectedTaskClaim(fixture.db,
    { expected: checkpoint.expected, jobReference: checkpoint.start.jobReference }, recoveredAt, async () => {
      if (persisted) expect(fixture.writes).toEqual([[ids.nextJob]]);
      deferred++; return true;
    })).toEqual({ status: "recovered" });
  expect(deferred).toBe(1);
});
