import { and, asc, eq, inArray, isNull, or, sql } from "drizzle-orm";

import type { DirectDatabase } from "../config/direct-database";
import { jobs } from "../schema/jobs";
import { taskRuns } from "../schema/task-runs";
import { tasks } from "../schema/tasks";
import { protectedTaskExecutionSegmentReceipts } from
  "../schema/protected-task-execution-segment-receipts";
import { readProtectedTaskExecutionContinuationProof } from
  "./protected-task-execution-receipts";
import {
  exactParkedProtectedTaskAdditionalAuthorityProof,
  exactParkedProtectedTaskHumanProof,
  exactParkedProtectedTaskPhysicalSegment,
  prepareParkedProtectedTaskCheckpointStart,
  type PreparedParkedProtectedTaskCheckpointStart,
  exactParkedProtectedTaskJobReference,
  prepareParkedProtectedTaskAdditionalAuthorityStart,
  prepareParkedProtectedTaskHumanStart,
  type PreparedParkedProtectedTaskAdditionalAuthorityStart,
  type PreparedParkedProtectedTaskHumanStart,
} from "./protected-task-parked-start-proof";
import {
  copyParkedProtectedTaskAdditionalAuthority,
  copyParkedProtectedTaskHumanContinuation,
  copyParkedProtectedTaskCheckpointContinuation,
  lockParkedProtectedTaskCheckpointContinuation,
  parseParkedProtectedTaskCheckpointContinuation,
  type ParkedProtectedTaskCheckpointContinuation,
  type StartParkedProtectedTaskCheckpointSegmentInput,
  exactProtectedTaskHumanContinuationAcceptanceReceipt,
  lockParkedProtectedTaskAdditionalAuthority,
  lockParkedProtectedTaskHumanContinuation,
  PROTECTED_TASK_HUMAN_ACCEPTANCE_METADATA_KEY,
  PROTECTED_TASK_RUN_PARK_RECEIPT_METADATA_KEY,
  PROTECTED_TASK_RUN_TERMINAL_RECEIPT_METADATA_KEY,
  type ParkedProtectedTaskAdditionalAuthority,
  type ParkedProtectedTaskHumanContinuation,
  type ProtectedTaskDurableJobReference,
  type StartParkedProtectedTaskRunAdditionalAuthoritySegmentInput,
  type StartParkedProtectedTaskHumanRunSegmentInput,
} from "./tasks";

export type ParkedProtectedTaskPreexecutionRecoveryResult = Readonly<{
  status: "recovered" | "exact_replay" | "cancelled" | "stale";
}>;

type RecoveryTransaction = Pick<DirectDatabase, "select" | "update">;

export type RecoverUnstartedParkedProtectedTaskClaimInput = Readonly<{
  expected:
    | ParkedProtectedTaskAdditionalAuthority
    | ParkedProtectedTaskHumanContinuation
    | ParkedProtectedTaskCheckpointContinuation;
  jobReference: ProtectedTaskDurableJobReference;
}>;

const taskProjection = Object.freeze({
  id: tasks.id,
  ownerId: tasks.ownerId,
  agentId: tasks.agentId,
  callingRoomId: tasks.callingRoomId,
  pauseRequestId: tasks.pauseRequestId,
  requestorId: tasks.requestorId,
  scheduleKind: tasks.scheduleKind,
  status: tasks.status,
  contentRepresentation: tasks.contentRepresentation,
  contentNamespaceId: tasks.contentNamespaceId,
  contentRevision: tasks.contentRevision,
  cryptoObjectId: tasks.cryptoObjectId,
  cryptoAccessRevision: tasks.cryptoAccessRevision,
  cryptoRequiredNamespaceFingerprint:
    tasks.cryptoRequiredNamespaceFingerprint,
  cryptoMappingState: tasks.cryptoMappingState,
  contentPristine: and(
    isNull(tasks.lastError),
    or(
      eq(tasks.contentRepresentation, "dual"),
      and(eq(tasks.prompt, ""), isNull(tasks.expectedOutput)),
    ),
  )!.mapWith(Boolean),
});

const runProjection = Object.freeze({
  id: taskRuns.id,
  taskId: taskRuns.taskId,
  jobId: taskRuns.jobId,
  graphThreadId: taskRuns.graphThreadId,
  status: taskRuns.status,
  startedAt: taskRuns.startedAt,
  pristine: and(
    isNull(taskRuns.resultText),
    isNull(taskRuns.completedAt),
    isNull(taskRuns.lastError),
    eq(taskRuns.resultRepresentation, "ordinary"),
    isNull(taskRuns.resultContentNamespaceId),
    eq(taskRuns.resultRevision, 0),
    isNull(taskRuns.resultCryptoObjectId),
    eq(taskRuns.resultCryptoAccessRevision, 0),
    isNull(taskRuns.resultCryptoRequiredNamespaceFingerprint),
    eq(taskRuns.resultCryptoMappingState, "unmapped"),
  )!.mapWith(Boolean),
});

const priorJobProjection = Object.freeze({
  id: jobs.id,
  ownerId: jobs.ownerId,
  requestorId: jobs.requestorId,
  laneKey: jobs.laneKey,
  type: jobs.type,
  status: jobs.status,
  reference: jobs.input,
  startedAt: jobs.startedAt,
  completedAt: jobs.completedAt,
  metadata: jobs.metadata,
  parkReceipt:
    sql<unknown>`${jobs.metadata} -> ${PROTECTED_TASK_RUN_PARK_RECEIPT_METADATA_KEY}`,
  humanAcceptanceReceipt:
    sql<unknown>`${jobs.metadata} -> ${PROTECTED_TASK_HUMAN_ACCEPTANCE_METADATA_KEY}`,
  pristine: and(
    isNull(jobs.result),
    isNull(jobs.message),
    sql<boolean>`NOT (${jobs.metadata} ? ${PROTECTED_TASK_RUN_TERMINAL_RECEIPT_METADATA_KEY})`,
  )!.mapWith(Boolean),
});

const nextJobProjection = Object.freeze({
  id: jobs.id,
  ownerId: jobs.ownerId,
  requestorId: jobs.requestorId,
  laneKey: jobs.laneKey,
  type: jobs.type,
  status: jobs.status,
  reference: jobs.input,
  startedAt: jobs.startedAt,
  completedAt: jobs.completedAt,
  pristine: and(
    isNull(jobs.result),
    isNull(jobs.message),
    eq(jobs.metadata, {}),
  )!.mapWith(Boolean),
});

type ParkedClaimJob = Readonly<{
  id: string;
  ownerId: string;
  requestorId: string;
  laneKey: string | null;
  type: string;
  status: string;
  reference: unknown;
  startedAt: Date | null;
  completedAt: Date | null;
  pristine: boolean;
}>;

function exactParkedClaimReference(
  expected: ParkedProtectedTaskAdditionalAuthority
    | ParkedProtectedTaskHumanContinuation
    | ParkedProtectedTaskCheckpointContinuation,
  reference: ProtectedTaskDurableJobReference,
): boolean {
  const prior = expected.priorJob.reference;
  return exactParkedProtectedTaskJobReference(reference, reference)
    && reference.taskId === expected.occurrence.task.id
    && reference.taskRunId === expected.occurrence.run.id
    && reference.inputObjectId === expected.occurrence.task.cryptoObjectId
    && reference.resultObjectId === prior.resultObjectId
    && reference.authorizationRequestId === expected.authorizationRequestId
    && Number.isSafeInteger(reference.policyRevision)
    && reference.policyRevision >= 1
    && (!("stableRoutingDigest" in expected) || "acceptance" in expected
      || reference.policyRevision >= prior.policyRevision)
    && reference.executionSegment === expected.nextExecutionSegment
    && ("continuationFingerprint" in expected
      ? reference.resumeAcceptanceId === undefined
        && reference.resumeContinuationFingerprint
          === expected.continuationFingerprint
      : reference.resumeContinuationFingerprint === undefined
        && reference.resumeAcceptanceId === expected.acceptance.acceptanceId);
}

function exactParkedClaimJob(
  expected: ParkedProtectedTaskAdditionalAuthority
    | ParkedProtectedTaskHumanContinuation
    | ParkedProtectedTaskCheckpointContinuation,
  reference: ProtectedTaskDurableJobReference,
  job: ParkedClaimJob,
): "queued" | "cancelled" | null {
  if (job.ownerId !== expected.occurrence.task.requestorId
    || job.requestorId !== expected.occurrence.task.requestorId
    || job.laneKey !== `task:${expected.occurrence.task.id}`
    || job.type !== "foreground"
    || !job.pristine
    || !exactParkedProtectedTaskJobReference(job.reference, reference)
    || job.startedAt !== null) return null;
  if (job.status === "queued" && job.completedAt === null) return "queued";
  return job.status === "cancelled"
      && job.completedAt instanceof Date
      && Number.isFinite(job.completedAt.getTime())
      && job.completedAt.getTime() >= expected.priorJob.parkedAt.getTime()
    ? "cancelled"
    : null;
}

async function lockParkedClaimJobs(
  tx: RecoveryTransaction,
  expected: ParkedProtectedTaskAdditionalAuthority
    | ParkedProtectedTaskHumanContinuation
    | ParkedProtectedTaskCheckpointContinuation,
  reference: ProtectedTaskDurableJobReference,
): Promise<Readonly<{
  jobs: readonly ParkedClaimJob[];
  queuedIds: readonly string[];
}> | null> {
  const locked = "acceptance" in expected
    ? await lockParkedProtectedTaskHumanContinuation(tx, expected)
    : "stableRoutingDigest" in expected
      ? await lockParkedProtectedTaskCheckpointContinuation(tx, expected)
      : await lockParkedProtectedTaskAdditionalAuthority(tx, expected);
  if (locked === null) return null;
  const rows = await (
    tx.select(nextJobProjection).from(jobs)
      .where(eq(jobs.input, reference)).orderBy(asc(jobs.id)).for("update")
  ) as unknown as readonly ParkedClaimJob[];
  const queuedIds: string[] = [];
  for (const row of rows) {
    const state = exactParkedClaimJob(locked.current, reference, row);
    if (state === null) return null;
    if (state === "queued") queuedIds.push(row.id);
  }
  return Object.freeze({
    jobs: Object.freeze([...rows]),
    queuedIds: Object.freeze(queuedIds.sort()),
  });
}

type LockedRecovery = Readonly<{
  task: NonNullable<Awaited<ReturnType<typeof selectTask>>>;
  run: NonNullable<Awaited<ReturnType<typeof selectRun>>>;
  priorJob: NonNullable<Awaited<ReturnType<typeof selectPriorJob>>>;
  nextJob: NonNullable<Awaited<ReturnType<typeof selectNextJob>>>;
  lifecycle: "parked" | "linked";
  nextJobState: "queued" | "cancelled";
}>;

type PreparedParkedProtectedTaskRecovery =
  | PreparedParkedProtectedTaskAdditionalAuthorityStart
  | PreparedParkedProtectedTaskHumanStart
  | PreparedParkedProtectedTaskCheckpointStart;

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

async function selectTask(
  tx: RecoveryTransaction,
  input: PreparedParkedProtectedTaskRecovery,
) {
  const [row] = await tx.select(taskProjection).from(tasks)
    .where(eq(tasks.id, input.taskId)).limit(1).for("update");
  return row;
}

async function selectRun(
  tx: RecoveryTransaction,
  input: PreparedParkedProtectedTaskRecovery,
) {
  const [row] = await tx.select(runProjection).from(taskRuns).where(and(
    eq(taskRuns.id, input.taskRunId),
    eq(taskRuns.taskId, input.taskId),
  )).limit(1).for("update");
  return row;
}

async function selectPriorJob(
  tx: RecoveryTransaction,
  input: PreparedParkedProtectedTaskRecovery,
) {
  const [row] = await tx.select(priorJobProjection).from(jobs)
    .where(eq(jobs.id, input.priorJobId)).limit(1).for("update");
  return row;
}

async function selectNextJob(
  tx: RecoveryTransaction,
  input: PreparedParkedProtectedTaskRecovery,
) {
  const [row] = await tx.select(nextJobProjection).from(jobs)
    .where(eq(jobs.id, input.jobId)).limit(1).for("update");
  return row;
}

function sameBytes(left: Uint8Array | null, right: Uint8Array): boolean {
  if (left === null || left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

async function lockExactRecovery(
  tx: RecoveryTransaction,
  input: PreparedParkedProtectedTaskRecovery,
): Promise<LockedRecovery | null> {
  const task = await selectTask(tx, input);
  if (!task) return null;
  const run = await selectRun(tx, input);
  if (!run) return null;
  const priorJob = await selectPriorJob(tx, input);
  if (!priorJob) return null;
  const nextJob = await selectNextJob(tx, input);
  if (!nextJob) return null;

  const proof = !("acceptance" in input)
    ? await readProtectedTaskExecutionContinuationProof(tx, {
        taskId: input.taskId,
        taskRunId: input.taskRunId,
        jobId: input.priorJobId,
        executionSegment: input.priorJobReference.executionSegment,
      })
    : null;
  const humanSegments = "acceptance" in input
    ? await tx.select().from(protectedTaskExecutionSegmentReceipts).where(and(
        eq(protectedTaskExecutionSegmentReceipts.taskRunId, input.taskRunId),
        eq(protectedTaskExecutionSegmentReceipts.jobId, input.priorJobId),
        eq(
          protectedTaskExecutionSegmentReceipts.executionSegment,
          input.priorJobReference.executionSegment,
        ),
      )).limit(2)
    : [];
  // Only normalize lifecycle for proving the retained checkpoint; the actual
  // parked/linked states and unstarted next Job are independently fenced below.
  const checkpoint = "continuationFingerprint" in input
    ? parseParkedProtectedTaskCheckpointContinuation({
        task: { ...task, pauseRequestId: null,
          status: task.scheduleKind === "cron" ? "pending" : "awaiting" },
        run: { ...run, status: "awaiting", jobId: priorJob.id },
        job: priorJob, proof,
      })
    : null;
  const exactProof = "continuationFingerprint" in input
    ? checkpoint !== null
      && checkpoint.continuationFingerprint === input.continuationFingerprint
      && checkpoint.authorizationRequestId === input.jobReference.authorizationRequestId
      && checkpoint.priorJob.generation === input.generation
      && checkpoint.priorJob.parkedAt.getTime() === input.parkedAt.getTime()
      && sameBytes(checkpoint.stableRoutingDigest, input.stableRoutingDigest)
      && exactParkedProtectedTaskPhysicalSegment(checkpoint.proof.segment, input, true)
    : "continuation" in input
    ? exactParkedProtectedTaskAdditionalAuthorityProof(
        proof,
        priorJob.parkReceipt,
        input,
        true,
      )
    : humanSegments.length === 1
      && exactParkedProtectedTaskHumanProof(
        humanSegments[0]!,
        priorJob.parkReceipt,
        input,
        true,
      )
      && exactProtectedTaskHumanContinuationAcceptanceReceipt(
        priorJob.humanAcceptanceReceipt,
        {
          taskId: input.taskId,
          taskRunId: input.taskRunId,
          graphThreadId: input.graphThreadId,
          priorJobId: input.priorJobId,
          generation: input.generation,
          executionSegment: input.priorJobReference.executionSegment,
          interrupts: input.receipt.interrupts,
          parkedAt: input.parkedAt,
          stableRoutingDigest: input.stableRoutingDigest,
          priorJobReference: input.priorJobReference,
          acceptance: input.acceptance,
        },
        run.jobId === nextJob.id ? nextJob.id : undefined,
      );
  const expectedParkedTaskStatus = task.scheduleKind === "cron"
    ? "pending"
    : "awaiting";
  const expectedRunningTaskStatus = task.scheduleKind === "cron"
    ? "pending"
    : "running";
  const parked = task.status === expectedParkedTaskStatus
    && run.status === "awaiting"
    && run.jobId === priorJob.id;
  const linked = task.status === expectedRunningTaskStatus
    && run.status === "running"
    && run.jobId === nextJob.id;
  const queued = nextJob.status === "queued"
    && nextJob.startedAt === null
    && nextJob.completedAt === null;
  const cancelled = nextJob.status === "cancelled"
    && nextJob.startedAt === null
    && nextJob.completedAt !== null
    && Number.isFinite(nextJob.completedAt.getTime())
    && nextJob.completedAt.getTime() >= input.parkedAt.getTime();
  if ((!parked && !linked)
    || (!queued && !cancelled)
    || task.contentRepresentation !== input.contentRepresentation
    || task.contentNamespaceId !== input.contentNamespaceId
    || task.contentRevision !== input.contentRevision
    || task.cryptoObjectId !== input.cryptoObjectId
    || task.cryptoAccessRevision !== input.cryptoAccessRevision
    || task.cryptoMappingState !== "verified"
    || !task.contentPristine
    || !sameBytes(
      task.cryptoRequiredNamespaceFingerprint,
      input.cryptoRequiredNamespaceFingerprint,
    )
    || run.graphThreadId !== input.graphThreadId
    || !run.pristine
    || priorJob.ownerId !== task.requestorId
    || priorJob.requestorId !== task.requestorId
    || priorJob.laneKey !== `task:${task.id}`
    || priorJob.type !== "foreground"
    || priorJob.status !== "completed"
    || priorJob.startedAt === null
    || priorJob.completedAt?.getTime() !== input.parkedAt.getTime()
    || !priorJob.pristine
    || !exactParkedProtectedTaskJobReference(
      priorJob.reference,
      input.priorJobReference,
    )
    || nextJob.ownerId !== task.requestorId
    || nextJob.requestorId !== task.requestorId
    || nextJob.laneKey !== `task:${task.id}`
    || nextJob.type !== "foreground"
    || !nextJob.pristine
    || !exactParkedProtectedTaskJobReference(
      nextJob.reference,
      input.jobReference,
    )
    || !exactProof) return null;
  return Object.freeze({
    task,
    run,
    priorJob,
    nextJob,
    lifecycle: parked ? "parked" : "linked",
    nextJobState: queued ? "queued" : "cancelled",
  });
}

/**
 * Cancel one exact unstarted continuation Job, fence its accepted authority,
 * then restore the immutable parked hand-off after an uncertain start reply.
 */
export async function recoverUnstartedParkedProtectedTaskRun(
  db: DirectDatabase,
  startInput: StartParkedProtectedTaskRunAdditionalAuthoritySegmentInput
    | StartParkedProtectedTaskHumanRunSegmentInput
    | StartParkedProtectedTaskCheckpointSegmentInput,
  recoveredAt: Date,
  deferAuthorization: () => Promise<boolean>,
): Promise<ParkedProtectedTaskPreexecutionRecoveryResult> {
  const input = "continuationFingerprint" in startInput
    ? prepareParkedProtectedTaskCheckpointStart(startInput)
    : "continuation" in startInput
      ? prepareParkedProtectedTaskAdditionalAuthorityStart(startInput)
      : prepareParkedProtectedTaskHumanStart(startInput);
  if (!(recoveredAt instanceof Date)
    || !Number.isFinite(recoveredAt.getTime())
    || recoveredAt.getTime() < input.parkedAt.getTime()) {
    throw new TypeError(
      "Protected Task parked pre-execution recovery time is malformed",
    );
  }
  const cancelledAt = new Date(recoveredAt.getTime());
  const cancellation = await db.transaction(async (tx) => {
    const locked = await lockExactRecovery(tx, input);
    if (locked === null) return { status: "stale" } as const;
    if (locked.nextJobState === "cancelled") {
      return { status: "exact_replay" } as const;
    }
    const [cancelledJob] = await tx.update(jobs).set({
      status: "cancelled",
      completedAt: cancelledAt,
    }).where(and(
      eq(jobs.id, locked.nextJob.id),
      eq(jobs.status, "queued"),
      isNull(jobs.startedAt),
      isNull(jobs.completedAt),
      isNull(jobs.result),
      isNull(jobs.message),
      eq(jobs.metadata, {}),
    )).returning({ id: jobs.id });
    if (!cancelledJob) {
      throw new Error(
        "Protected Task parked recovery lost its queued continuation Job",
      );
    }
    return { status: "cancelled" } as const;
  });
  if (cancellation.status === "stale") return cancellation;

  let recovery: ParkedProtectedTaskPreexecutionRecoveryResult;
  try {
    recovery = await db.transaction(async (tx) => {
      const locked = await lockExactRecovery(tx, input);
      if (locked === null || locked.nextJobState !== "cancelled") {
        return { status: "cancelled" } as const;
      }
      if (!await deferAuthorization()) return { status: "cancelled" } as const;
      if (locked.lifecycle === "parked") {
        return {
          status: cancellation.status === "exact_replay"
            ? "exact_replay"
            : "recovered",
        } as const;
      }

      if ("acceptance" in input) {
        const metadata = locked.priorJob.metadata;
        const consumed = record(metadata)
          ? metadata[PROTECTED_TASK_HUMAN_ACCEPTANCE_METADATA_KEY]
          : undefined;
        if (!record(consumed)
          || consumed["consumedByJobId"] !== locked.nextJob.id) {
          return { status: "cancelled" } as const;
        }
        const restoredAcceptance = { ...consumed };
        delete restoredAcceptance["consumedByJobId"];
        const [restoredReceipt] = await tx.update(jobs).set({
          metadata: {
            ...metadata,
            [PROTECTED_TASK_HUMAN_ACCEPTANCE_METADATA_KEY]: restoredAcceptance,
          },
        }).where(and(
          eq(jobs.id, locked.priorJob.id),
          eq(jobs.status, "completed"),
          isNull(jobs.result),
          isNull(jobs.message),
          eq(jobs.metadata, metadata),
        )).returning({ id: jobs.id });
        if (!restoredReceipt) {
          throw new Error(
            "Protected Task parked recovery lost its Human acceptance",
          );
        }
      }

      const [restoredRun] = await tx.update(taskRuns).set({
        status: "awaiting",
        jobId: locked.priorJob.id,
      }).where(and(
        eq(taskRuns.id, locked.run.id),
        eq(taskRuns.taskId, locked.task.id),
        eq(taskRuns.graphThreadId, input.graphThreadId),
        eq(taskRuns.status, "running"),
        eq(taskRuns.jobId, locked.nextJob.id),
        isNull(taskRuns.completedAt),
      )).returning({ id: taskRuns.id });
      if (!restoredRun) {
        throw new Error("Protected Task parked recovery lost its TaskRun");
      }
      if (locked.task.scheduleKind !== "cron") {
        const [restoredTask] = await tx.update(tasks).set({
          status: "awaiting",
          updatedAt: cancelledAt,
        }).where(and(
          eq(tasks.id, locked.task.id),
          eq(tasks.status, "running"),
        )).returning({ id: tasks.id });
        if (!restoredTask) {
          throw new Error("Protected Task parked recovery lost its Task");
        }
      }
      return { status: "recovered" } as const;
    });
  } catch {
    return { status: "cancelled" };
  }
  return recovery;
}

/**
 * Recover a claimed parked continuation before its Job identity is known.
 * Exact Job absence and cancellation are serialized with same-transaction
 * continuation persistence by the shared Task -> Run -> prior Job locks.
 */
export async function recoverUnstartedParkedProtectedTaskClaim(
  db: DirectDatabase,
  supplied: RecoverUnstartedParkedProtectedTaskClaimInput,
  recoveredAt: Date,
  deferAuthorization: () => Promise<boolean>,
): Promise<ParkedProtectedTaskPreexecutionRecoveryResult> {
  const expected = "acceptance" in supplied.expected
    ? copyParkedProtectedTaskHumanContinuation(supplied.expected)
    : "stableRoutingDigest" in supplied.expected
      ? copyParkedProtectedTaskCheckpointContinuation(supplied.expected)
      : copyParkedProtectedTaskAdditionalAuthority(supplied.expected);
  const reference = Object.freeze({ ...supplied.jobReference });
  if (!exactParkedClaimReference(expected, reference)
    || !(recoveredAt instanceof Date)
    || !Number.isFinite(recoveredAt.getTime())
    || recoveredAt.getTime() < expected.priorJob.parkedAt.getTime()
    || typeof deferAuthorization !== "function") {
    throw new TypeError(
      "Protected Task parked claim recovery input is malformed",
    );
  }
  const cancelledAt = new Date(recoveredAt.getTime());
  const cancellation = await db.transaction(async tx => {
    const locked = await lockParkedClaimJobs(tx, expected, reference);
    if (locked === null) return { status: "stale" as const };
    if (locked.queuedIds.length === 0) {
      return {
        status: "ready" as const,
        hadJobs: locked.jobs.length > 0,
        cancelled: false,
      };
    }
    const cancelledRows = await tx.update(jobs).set({
      status: "cancelled",
      completedAt: cancelledAt,
    }).where(and(
      inArray(jobs.id, locked.queuedIds),
      eq(jobs.input, reference),
      eq(jobs.status, "queued"),
      isNull(jobs.startedAt),
      isNull(jobs.completedAt),
      isNull(jobs.result),
      isNull(jobs.message),
      eq(jobs.metadata, {}),
    )).returning({ id: jobs.id });
    const cancelledIds = cancelledRows.map(row => row.id).sort();
    if (cancelledIds.length !== locked.queuedIds.length
      || cancelledIds.some((id, index) => id !== locked.queuedIds[index])) {
      throw new Error(
        "Protected Task parked claim recovery lost a queued continuation Job",
      );
    }
    return {
      status: "ready" as const,
      hadJobs: true,
      cancelled: true,
    };
  });
  if (cancellation.status === "stale") return cancellation;

  try {
    return await db.transaction(async tx => {
      const locked = await lockParkedClaimJobs(tx, expected, reference);
      if (locked === null || locked.queuedIds.length > 0) {
        return cancellation.hadJobs || cancellation.cancelled
          ? { status: "cancelled" as const }
          : { status: "stale" as const };
      }
      if (!await deferAuthorization()) {
        return cancellation.hadJobs || cancellation.cancelled
          ? { status: "cancelled" as const }
          : { status: "stale" as const };
      }
      return {
        status: cancellation.cancelled || !cancellation.hadJobs
          ? "recovered" as const
          : "exact_replay" as const,
      };
    });
  } catch {
    return cancellation.hadJobs || cancellation.cancelled
      ? { status: "cancelled" }
      : { status: "stale" };
  }
}
