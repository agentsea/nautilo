import { and, eq, isNull, or, sql } from "drizzle-orm";

import type { DirectDatabase } from "../config/direct-database";
import { jobs } from "../schema/jobs";
import { taskRuns } from "../schema/task-runs";
import { tasks } from "../schema/tasks";
import { readProtectedTaskExecutionContinuationProof } from
  "./protected-task-execution-receipts";
import {
  exactParkedProtectedTaskAdditionalAuthorityProof,
  exactParkedProtectedTaskJobReference,
  prepareParkedProtectedTaskAdditionalAuthorityStart,
  type PreparedParkedProtectedTaskAdditionalAuthorityStart,
} from "./protected-task-parked-start-proof";
import {
  PROTECTED_TASK_RUN_PARK_RECEIPT_METADATA_KEY,
  PROTECTED_TASK_RUN_TERMINAL_RECEIPT_METADATA_KEY,
  type StartParkedProtectedTaskRunAdditionalAuthoritySegmentInput,
} from "./tasks";

export type ParkedProtectedTaskPreexecutionRecoveryResult = Readonly<{
  status: "recovered" | "exact_replay" | "cancelled" | "stale";
}>;

type RecoveryTransaction = Pick<DirectDatabase, "select" | "update">;

const taskProjection = Object.freeze({
  id: tasks.id,
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
  parkReceipt:
    sql<unknown>`${jobs.metadata} -> ${PROTECTED_TASK_RUN_PARK_RECEIPT_METADATA_KEY}`,
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

type LockedRecovery = Readonly<{
  task: NonNullable<Awaited<ReturnType<typeof selectTask>>>;
  run: NonNullable<Awaited<ReturnType<typeof selectRun>>>;
  priorJob: NonNullable<Awaited<ReturnType<typeof selectPriorJob>>>;
  nextJob: NonNullable<Awaited<ReturnType<typeof selectNextJob>>>;
  lifecycle: "parked" | "linked";
  nextJobState: "queued" | "cancelled";
}>;

async function selectTask(
  tx: RecoveryTransaction,
  input: PreparedParkedProtectedTaskAdditionalAuthorityStart,
) {
  const [row] = await tx.select(taskProjection).from(tasks)
    .where(eq(tasks.id, input.taskId)).limit(1).for("update");
  return row;
}

async function selectRun(
  tx: RecoveryTransaction,
  input: PreparedParkedProtectedTaskAdditionalAuthorityStart,
) {
  const [row] = await tx.select(runProjection).from(taskRuns).where(and(
    eq(taskRuns.id, input.taskRunId),
    eq(taskRuns.taskId, input.taskId),
  )).limit(1).for("update");
  return row;
}

async function selectPriorJob(
  tx: RecoveryTransaction,
  input: PreparedParkedProtectedTaskAdditionalAuthorityStart,
) {
  const [row] = await tx.select(priorJobProjection).from(jobs)
    .where(eq(jobs.id, input.priorJobId)).limit(1).for("update");
  return row;
}

async function selectNextJob(
  tx: RecoveryTransaction,
  input: PreparedParkedProtectedTaskAdditionalAuthorityStart,
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
  input: PreparedParkedProtectedTaskAdditionalAuthorityStart,
): Promise<LockedRecovery | null> {
  const task = await selectTask(tx, input);
  if (!task) return null;
  const run = await selectRun(tx, input);
  if (!run) return null;
  const priorJob = await selectPriorJob(tx, input);
  if (!priorJob) return null;
  const nextJob = await selectNextJob(tx, input);
  if (!nextJob) return null;

  const proof = await readProtectedTaskExecutionContinuationProof(tx, {
    taskId: input.taskId,
    taskRunId: input.taskRunId,
    jobId: input.priorJobId,
    executionSegment: input.priorJobReference.executionSegment,
  });
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
    || !exactParkedProtectedTaskAdditionalAuthorityProof(
      proof,
      priorJob.parkReceipt,
      input,
      true,
    )) return null;
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
  startInput: StartParkedProtectedTaskRunAdditionalAuthoritySegmentInput,
  recoveredAt: Date,
  deferAuthorization: () => Promise<boolean>,
): Promise<ParkedProtectedTaskPreexecutionRecoveryResult> {
  const input = prepareParkedProtectedTaskAdditionalAuthorityStart(startInput);
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
