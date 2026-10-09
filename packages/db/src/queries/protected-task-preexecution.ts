import {
  and,
  asc,
  desc,
  eq,
  gt,
  inArray,
  isNotNull,
  isNull,
  lt,
  lte,
  ne,
  or,
  sql,
} from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";

import type { DirectDatabase } from "../config/direct-database";
import { jobs } from "../schema/jobs";
import { protectedTaskContinuationReceipts } from
  "../schema/protected-task-continuation-receipts";
import { protectedTaskExecutionSegmentReceipts } from
  "../schema/protected-task-execution-segment-receipts";
import { protectedTaskRunOutputBindings } from
  "../schema/protected-task-run-output-bindings";
import { taskRuns } from "../schema/task-runs";
import { tasks } from "../schema/tasks";
import { acquireEncryptionConsumptionFence } from
  "../utils/encryption-transition-queries";
import {
  projectParkedProtectedTaskRecoveryCandidate,
  type ParkedProtectedTaskRecoveryCandidateRow,
} from "./protected-task-parked-recovery-candidate";
import {
  protectedTaskRunMessageOperationId,
  protectedTaskRunOutputBindingId,
  protectedTaskRunResultObjectId,
  protectedTaskRunResultOperationId,
  protectedTaskRunWakeOperationId,
} from
  "./protected-task-output-binding-identities";
import {
  PROTECTED_TASK_RUN_PARK_RECEIPT_METADATA_KEY,
  PROTECTED_TASK_RUN_TERMINAL_RECEIPT_METADATA_KEY,
  type ProtectedTaskDurableJobReference,
  type StartParkedProtectedTaskRunAdditionalAuthoritySegmentInput,
  type StartProtectedTaskRunInput,
} from "./tasks";

export type ProtectedTaskPreexecutionRecoveryResult = Readonly<{
  status: "deferred" | "exact_replay" | "stale";
}>;

export type ProtectedTaskPreexecutionRecoveryCursor = Readonly<{
  /** PostgreSQL-authored timestamp text preserves sub-millisecond precision. */
  createdAt: string;
  jobId: string;
}>;

export type ProtectedTaskPreexecutionRecoveryCandidate =
  | Readonly<{
      route: "initial";
      input: StartProtectedTaskRunInput;
      jobStatus: "queued" | "cancelled";
      cursor: ProtectedTaskPreexecutionRecoveryCursor;
    }>
  | Readonly<{
      route: "parked_additional_authority";
      input: StartParkedProtectedTaskRunAdditionalAuthoritySegmentInput;
      jobStatus: "queued" | "cancelled";
      lifecycle: "linked" | "parked";
      cursor: ProtectedTaskPreexecutionRecoveryCursor;
    }>;

export type ProtectedTaskPreexecutionRecoveryPage = Readonly<{
  candidates: ProtectedTaskPreexecutionRecoveryCandidate[];
  /** Last raw SQL row when a full page may have more rows after it. */
  continuation: ProtectedTaskPreexecutionRecoveryCursor | undefined;
}>;

const taskProjection = Object.freeze({
  id: tasks.id,
  requestorId: tasks.requestorId,
  callingRoomId: tasks.callingRoomId,
  resultDelivery: tasks.resultDelivery,
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
  modelId: taskRuns.modelId,
  fundingPristine: and(
    isNull(taskRuns.fundingBinding),
    isNull(taskRuns.fundingPredecessorRunId),
  )!.mapWith(Boolean),
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

const jobProjection = Object.freeze({
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
    sql<boolean>`NOT (${jobs.metadata} ? ${PROTECTED_TASK_RUN_PARK_RECEIPT_METADATA_KEY})`,
    sql<boolean>`NOT (${jobs.metadata} ? ${PROTECTED_TASK_RUN_TERMINAL_RECEIPT_METADATA_KEY})`,
  )!.mapWith(Boolean),
});

const priorJobs = alias(jobs, "protected_task_preexecution_prior_jobs");
const priorJobProjection = Object.freeze({
  id: priorJobs.id,
  ownerId: priorJobs.ownerId,
  requestorId: priorJobs.requestorId,
  laneKey: priorJobs.laneKey,
  type: priorJobs.type,
  status: priorJobs.status,
  reference: priorJobs.input,
  startedAt: priorJobs.startedAt,
  completedAt: priorJobs.completedAt,
  parkReceipt:
    sql<unknown>`${priorJobs.metadata} -> ${PROTECTED_TASK_RUN_PARK_RECEIPT_METADATA_KEY}`,
  pristine: and(
    isNull(priorJobs.result),
    isNull(priorJobs.message),
    sql<boolean>`NOT (${priorJobs.metadata} ? ${PROTECTED_TASK_RUN_TERMINAL_RECEIPT_METADATA_KEY})`,
  )!.mapWith(Boolean),
});

const segmentProjection = Object.freeze({
  taskRunId: protectedTaskExecutionSegmentReceipts.taskRunId,
  executionSegment: protectedTaskExecutionSegmentReceipts.executionSegment,
  jobId: protectedTaskExecutionSegmentReceipts.jobId,
  route: protectedTaskExecutionSegmentReceipts.route,
  transcriptContract: protectedTaskExecutionSegmentReceipts.transcriptContract,
  expectedTranscriptAssociationCount:
    protectedTaskExecutionSegmentReceipts.expectedTranscriptAssociationCount,
  transcriptAssociationDigest:
    protectedTaskExecutionSegmentReceipts.transcriptAssociationDigest,
  checkpointContract: protectedTaskExecutionSegmentReceipts.checkpointContract,
  expectedCheckpointCount:
    protectedTaskExecutionSegmentReceipts.expectedCheckpointCount,
  checkpointDigest: protectedTaskExecutionSegmentReceipts.checkpointDigest,
  expectedCheckpointBlobCount:
    protectedTaskExecutionSegmentReceipts.expectedCheckpointBlobCount,
  checkpointBlobDigest:
    protectedTaskExecutionSegmentReceipts.checkpointBlobDigest,
  expectedPendingWriteCount:
    protectedTaskExecutionSegmentReceipts.expectedPendingWriteCount,
  pendingWriteDigest: protectedTaskExecutionSegmentReceipts.pendingWriteDigest,
  sealedAt: protectedTaskExecutionSegmentReceipts.sealedAt,
});

const continuationProjection = Object.freeze({
  taskRunId: protectedTaskContinuationReceipts.taskRunId,
  executionSegment: protectedTaskContinuationReceipts.executionSegment,
  jobId: protectedTaskContinuationReceipts.jobId,
  kind: protectedTaskContinuationReceipts.kind,
  reason: protectedTaskContinuationReceipts.reason,
  effectDisposition: protectedTaskContinuationReceipts.effectDisposition,
  interruptId: protectedTaskContinuationReceipts.interruptId,
  operationId: protectedTaskContinuationReceipts.operationId,
  requestDigest: protectedTaskContinuationReceipts.requestDigest,
  requiredAuthorityDigest:
    protectedTaskContinuationReceipts.requiredAuthorityDigest,
  stableRoutingDigest: protectedTaskContinuationReceipts.stableRoutingDigest,
  semanticAuthorityRequirements:
    protectedTaskContinuationReceipts.semanticAuthorityRequirements,
  sealedAt: protectedTaskContinuationReceipts.sealedAt,
});

const referencedTaskRunId =
  sql<string>`${jobs.input} ->> 'taskRunId'`;
const referencedExecutionSegment =
  sql<number>`case
    when ${jobs.input} ->> 'executionSegment' ~ '^[1-9][0-9]{0,9}$'
    then case
      when (${jobs.input} ->> 'executionSegment')::bigint <= 2147483647
      then (${jobs.input} ->> 'executionSegment')::integer
      else null
    end
    else null
  end`;
const referencedPriorExecutionSegment =
  sql<number>`(${referencedExecutionSegment}) - 1`;

function recoveryLifecycleCondition() {
  return or(
    and(
      eq(taskRuns.status, "running"),
      eq(taskRuns.jobId, jobs.id),
      or(
        and(eq(tasks.scheduleKind, "cron"), eq(tasks.status, "pending")),
        and(ne(tasks.scheduleKind, "cron"), eq(tasks.status, "running")),
      ),
    ),
    and(
      eq(taskRuns.status, "awaiting"),
      sql`${referencedExecutionSegment} > 1`,
      or(
        and(eq(tasks.scheduleKind, "cron"), eq(tasks.status, "pending")),
        and(ne(tasks.scheduleKind, "cron"), eq(tasks.status, "awaiting")),
      ),
    ),
  );
}

function recoveryJobCondition() {
  return and(
    inArray(tasks.contentRepresentation, ["dual", "protected"]),
    eq(tasks.cryptoMappingState, "verified"),
    recoveryLifecycleCondition(),
    or(
      and(eq(referencedExecutionSegment, 1), isNull(taskRuns.modelId)),
      sql`${referencedExecutionSegment} > 1`,
    ),
    inArray(jobs.status, ["queued", "cancelled"]),
    isNull(jobs.startedAt),
    or(
      and(eq(jobs.status, "queued"), isNull(jobs.completedAt)),
      and(eq(jobs.status, "cancelled"), isNotNull(jobs.completedAt)),
    ),
    sql`${jobs.input} ->> 'kind' = 'protected_task_run_v1'`,
    sql`${jobs.input} ->> 'taskRunId' = ${taskRuns.id}::text`,
    sql`${jobs.input} ->> 'taskId' = ${tasks.id}::text`,
    sql`${jobs.input} ->> 'executionSegment' ~ '^[1-9][0-9]{0,9}$'`,
  );
}

function sameBytes(left: Uint8Array | null, right: Uint8Array): boolean {
  if (left === null || left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

function exactReference(
  value: unknown,
  expected: ProtectedTaskDurableJobReference,
): boolean {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const reference = value as Record<string, unknown>;
  return Object.keys(reference).sort().join(",")
      === "authorizationRequestId,executionSegment,inputObjectId,kind,policyRevision,resultObjectId,taskId,taskRunId"
    && reference["kind"] === "protected_task_run_v1"
    && reference["taskId"] === expected.taskId
    && reference["taskRunId"] === expected.taskRunId
    && reference["inputObjectId"] === expected.inputObjectId
    && reference["resultObjectId"] === expected.resultObjectId
    && reference["authorizationRequestId"] === expected.authorizationRequestId
    && reference["policyRevision"] === expected.policyRevision
    && reference["executionSegment"] === 1;
}

function assertRecoveryInput(input: StartProtectedTaskRunInput): void {
  const reference = input.jobReference;
  if (!input.taskId || !input.taskRunId || !input.graphThreadId || !input.jobId
    || input.contentRepresentation !== "dual"
      && input.contentRepresentation !== "protected"
    || !input.contentNamespaceId
    || !Number.isSafeInteger(input.contentRevision) || input.contentRevision < 1
    || !input.cryptoObjectId
    || !Number.isSafeInteger(input.cryptoAccessRevision)
    || input.cryptoAccessRevision < 0
    || !(input.cryptoRequiredNamespaceFingerprint instanceof Uint8Array)
    || input.cryptoRequiredNamespaceFingerprint.length !== 32
    || reference.kind !== "protected_task_run_v1"
    || reference.taskId !== input.taskId
    || reference.taskRunId !== input.taskRunId
    || reference.inputObjectId !== input.cryptoObjectId
    || reference.resultObjectId
      !== protectedTaskRunResultObjectId(input.taskId, input.taskRunId)
    || !reference.authorizationRequestId
    || !Number.isSafeInteger(reference.policyRevision)
    || reference.policyRevision < 1
    || reference.executionSegment !== 1
    || reference.resumeAcceptanceId !== undefined
    || reference.resumeContinuationFingerprint !== undefined
    || !exactReference(reference, reference)) {
    throw new TypeError("Protected Task pre-execution recovery binding is malformed");
  }
}

/**
 * Reset one exact initial protected run only after its durable Job has been
 * cancelled without starting. The authorization callback runs while all
 * product rows remain locked; it must atomically fence the old grant.
 */
export async function recoverUnstartedProtectedTaskRun(
  db: DirectDatabase,
  input: StartProtectedTaskRunInput,
  deferAuthorization: () => Promise<boolean>,
): Promise<ProtectedTaskPreexecutionRecoveryResult> {
  assertRecoveryInput(input);
  return db.transaction(async (tx) => {
    await acquireEncryptionConsumptionFence(tx);

    const [task] = await tx.select(taskProjection).from(tasks)
      .where(eq(tasks.id, input.taskId)).limit(1).for("update");
    if (!task) return { status: "stale" };

    const [run] = await tx.select(runProjection).from(taskRuns).where(and(
      eq(taskRuns.id, input.taskRunId),
      eq(taskRuns.taskId, input.taskId),
    )).limit(1).for("update");
    if (!run) return { status: "stale" };

    const [output] = await tx.select().from(protectedTaskRunOutputBindings)
      .where(eq(protectedTaskRunOutputBindings.taskRunId, input.taskRunId))
      .limit(1).for("update");
    if (!output) return { status: "stale" };

    const [job] = await tx.select(jobProjection).from(jobs)
      .where(eq(jobs.id, input.jobId)).limit(1).for("update");
    if (!job) return { status: "stale" };

    // Receipt writers first lock this same Task/Run/Job identity. Our stronger
    // parent locks therefore serialize every possible insert. A receipt-table
    // row lock cannot protect an absent row and would require UPDATE privilege
    // that the immutable evidence tables intentionally do not grant.
    const [segmentReceipt] = await tx.select({
      taskRunId: protectedTaskExecutionSegmentReceipts.taskRunId,
    }).from(protectedTaskExecutionSegmentReceipts).where(or(
      eq(protectedTaskExecutionSegmentReceipts.taskRunId, input.taskRunId),
      eq(protectedTaskExecutionSegmentReceipts.jobId, input.jobId),
    )).limit(1);
    const [continuationReceipt] = await tx.select({
      taskRunId: protectedTaskContinuationReceipts.taskRunId,
    }).from(protectedTaskContinuationReceipts).where(or(
      eq(protectedTaskContinuationReceipts.taskRunId, input.taskRunId),
      eq(protectedTaskContinuationReceipts.jobId, input.jobId),
    )).limit(1);

    const exactReplay = run.status === "awaiting" && run.jobId === null;
    const linkedRunning = run.status === "running" && run.jobId === input.jobId;
    const expectedTaskStatus = task.scheduleKind === "cron"
      ? "pending"
      : exactReplay ? "awaiting" : "running";
    if ((!exactReplay && !linkedRunning)
      || task.status !== expectedTaskStatus
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
      || run.modelId !== null
      || !run.fundingPristine
      || !run.pristine
      || output.bindingId !== protectedTaskRunOutputBindingId(run.id)
      || output.resultOperationId !== protectedTaskRunResultOperationId(run.id)
      || output.resultObjectId !== input.jobReference.resultObjectId
      || output.acceptedPolicyRevision !== input.jobReference.policyRevision
      || output.resultTerminalAt !== null
      || output.resultAttachedAt !== null
      || output.messageId !== null
      || output.messagePublishedAt !== null
      || output.wakeJobId !== null
      || output.wakeScheduledAt !== null
      || output.completedAt !== null
      || (task.callingRoomId === null
        ? output.deliveryMode !== "none"
          || output.destinationRoomId !== null
          || output.destinationNamespaceId !== null
          || output.messageOperationId !== null
          || output.wakeOperationId !== null
        : output.deliveryMode !== task.resultDelivery
          || output.destinationRoomId !== task.callingRoomId
          || output.destinationNamespaceId === null
          || (output.deliveryMode === "raw"
            ? output.messageOperationId
                !== protectedTaskRunMessageOperationId(run.id)
              || output.wakeOperationId !== null
            : output.deliveryMode === "wake"
              ? output.messageOperationId !== null
                || output.wakeOperationId
                  !== protectedTaskRunWakeOperationId(run.id)
              : output.deliveryMode === "raw_and_wake"
                ? output.messageOperationId
                    !== protectedTaskRunMessageOperationId(run.id)
                  || output.wakeOperationId
                    !== protectedTaskRunWakeOperationId(run.id)
                : true))
      || job.ownerId !== task.requestorId
      || job.requestorId !== task.requestorId
      || job.laneKey !== `task:${task.id}`
      || job.type !== "foreground"
      || job.status !== "cancelled"
      || job.startedAt !== null
      || job.completedAt === null
      || !job.pristine
      || !exactReference(job.reference, input.jobReference)
      || segmentReceipt !== undefined
      || continuationReceipt !== undefined) {
      return { status: "stale" };
    }

    if (!await deferAuthorization()) return { status: "stale" };
    if (exactReplay) return { status: "exact_replay" };

    const [updatedRun] = await tx.update(taskRuns).set({
      status: "awaiting",
      jobId: null,
    }).where(and(
      eq(taskRuns.id, run.id),
      eq(taskRuns.taskId, task.id),
      eq(taskRuns.graphThreadId, input.graphThreadId),
      eq(taskRuns.status, "running"),
      eq(taskRuns.jobId, job.id),
      isNull(taskRuns.modelId),
    )).returning({ id: taskRuns.id });
    if (!updatedRun) {
      throw new Error("Protected Task recovery lost its locked TaskRun");
    }

    if (task.scheduleKind !== "cron") {
      const [updatedTask] = await tx.update(tasks).set({
        status: "awaiting",
        updatedAt: new Date(),
      }).where(and(
        eq(tasks.id, task.id),
        eq(tasks.status, "running"),
      )).returning({ id: tasks.id });
      if (!updatedTask) {
        throw new Error("Protected Task recovery lost its locked Task");
      }
    }
    return { status: "deferred" };
  });
}

/** Freeze the newest content-free candidate for one bounded recovery scan. */
export async function getUnstartedProtectedTaskRunRecoveryBoundary(
  db: DirectDatabase,
): Promise<ProtectedTaskPreexecutionRecoveryCursor | undefined> {
  const [row] = await db.select({
    createdAt: sql<string>`${jobs.createdAt}::text`,
    jobId: jobs.id,
  }).from(jobs)
    .innerJoin(taskRuns, eq(sql`${taskRuns.id}::text`, referencedTaskRunId))
    .innerJoin(tasks, eq(tasks.id, taskRuns.taskId))
    .where(recoveryJobCondition())
    .orderBy(desc(jobs.createdAt), desc(jobs.id)).limit(1);
  return row;
}

/**
 * List a stable, bounded page of operational recovery coordinates. Every row
 * is re-proved under locks by recoverUnstartedProtectedTaskRun.
 */
export async function listUnstartedProtectedTaskRunRecoveryCandidates(
  db: DirectDatabase,
  options: Readonly<{
    limit: number;
    through: ProtectedTaskPreexecutionRecoveryCursor;
    after?: ProtectedTaskPreexecutionRecoveryCursor;
  }>,
): Promise<ProtectedTaskPreexecutionRecoveryPage> {
  if (!Number.isInteger(options.limit) || options.limit <= 0) {
    return { candidates: [], continuation: undefined };
  }
  const rows = await db.select({
    task: taskProjection,
    run: runProjection,
    job: jobProjection,
    priorJob: priorJobProjection,
    segment: segmentProjection,
    continuation: continuationProjection,
    cursorCreatedAt: sql<string>`${jobs.createdAt}::text`,
  }).from(jobs)
    .innerJoin(taskRuns, eq(sql`${taskRuns.id}::text`, referencedTaskRunId))
    .innerJoin(tasks, eq(tasks.id, taskRuns.taskId))
    .leftJoin(protectedTaskExecutionSegmentReceipts, and(
      eq(protectedTaskExecutionSegmentReceipts.taskRunId, taskRuns.id),
      eq(
        protectedTaskExecutionSegmentReceipts.executionSegment,
        referencedPriorExecutionSegment,
      ),
    ))
    .leftJoin(protectedTaskContinuationReceipts, and(
      eq(protectedTaskContinuationReceipts.taskRunId, taskRuns.id),
      eq(
        protectedTaskContinuationReceipts.executionSegment,
        referencedPriorExecutionSegment,
      ),
      eq(
        protectedTaskContinuationReceipts.jobId,
        protectedTaskExecutionSegmentReceipts.jobId,
      ),
    ))
    .leftJoin(priorJobs, eq(
      priorJobs.id,
      protectedTaskExecutionSegmentReceipts.jobId,
    ))
    .where(and(
      recoveryJobCondition(),
      or(
        lt(jobs.createdAt, sql`${options.through.createdAt}::timestamp`),
        and(
          eq(jobs.createdAt, sql`${options.through.createdAt}::timestamp`),
          lte(jobs.id, options.through.jobId),
        ),
      ),
      options.after ? or(
        gt(jobs.createdAt, sql`${options.after.createdAt}::timestamp`),
        and(
          eq(jobs.createdAt, sql`${options.after.createdAt}::timestamp`),
          gt(jobs.id, options.after.jobId),
        ),
      ) : undefined,
    )).orderBy(asc(jobs.createdAt), asc(jobs.id)).limit(options.limit);

  const candidates: ProtectedTaskPreexecutionRecoveryCandidate[] = [];
  for (const row of rows) {
    const reference = row.job.reference as ProtectedTaskDurableJobReference;
    if ((row.task.contentRepresentation !== "dual"
        && row.task.contentRepresentation !== "protected")
      || row.task.contentNamespaceId === null
      || row.task.cryptoObjectId === null
      || row.task.cryptoRequiredNamespaceFingerprint === null
      || (row.job.status !== "queued" && row.job.status !== "cancelled")) {
      continue;
    }
    const cursor = { createdAt: row.cursorCreatedAt, jobId: row.job.id };
    if (reference.executionSegment !== 1) {
      const parked = projectParkedProtectedTaskRecoveryCandidate({
        task: row.task,
        run: row.run,
        nextJob: row.job,
        priorJob: row.priorJob,
        segment: row.segment,
        continuation: row.continuation,
      } as ParkedProtectedTaskRecoveryCandidateRow);
      if (parked !== null) candidates.push({
        route: "parked_additional_authority",
        input: parked.input,
        jobStatus: row.job.status,
        lifecycle: parked.lifecycle,
        cursor,
      });
      continue;
    }
    if (row.run.status !== "running" || row.run.jobId !== row.job.id
      || row.run.modelId !== null
      || !exactReference(row.job.reference, reference)) continue;
    const input: StartProtectedTaskRunInput = {
      taskId: row.task.id,
      taskRunId: row.run.id,
      graphThreadId: row.run.graphThreadId,
      jobId: row.job.id,
      contentRepresentation: row.task.contentRepresentation,
      contentNamespaceId: row.task.contentNamespaceId,
      contentRevision: row.task.contentRevision,
      cryptoObjectId: row.task.cryptoObjectId,
      cryptoAccessRevision: row.task.cryptoAccessRevision,
      cryptoRequiredNamespaceFingerprint:
        row.task.cryptoRequiredNamespaceFingerprint.slice(),
      jobReference: reference,
    };
    try {
      assertRecoveryInput(input);
    } catch {
      continue;
    }
    candidates.push({
      route: "initial",
      input,
      jobStatus: row.job.status,
      cursor,
    });
  }
  const lastRaw = rows.at(-1);
  return {
    candidates,
    continuation: rows.length === options.limit && lastRaw !== undefined
      ? { createdAt: lastRaw.cursorCreatedAt, jobId: lastRaw.job.id }
      : undefined,
  };
}
