import {
  and,
  eq,
  isNull,
  sql,
} from "drizzle-orm";

import type { DirectDatabase } from "../config/direct-database";
import { encryptionTransitionPolicy } from "../schema/encryption-transition";
import { jobs } from "../schema/jobs";
import {
  protectedTaskRunOutputBindings,
  type ProtectedTaskRunOutputBinding,
} from "../schema/protected-task-run-output-bindings";
import { taskRuns, type TaskRun } from "../schema/task-runs";
import { tasks, type Task } from "../schema/tasks";
import { rooms } from "../schema/rooms";
import { actors } from "../schema/trust";
import {
  taskDefinitionCryptoRevisions,
  type TaskDefinitionCryptoRevision,
} from "../schema/task-definition-crypto-revisions";
import {
  taskRunResultCryptoRevisions,
  type TaskRunResultCryptoRevision,
} from "../schema/task-run-result-crypto-revisions";
import {
  protectedTaskRunCancelledResultObjectId,
  protectedTaskRunCancelledResultOperationId,
  protectedTaskRunMessageOperationId,
  protectedTaskRunOutputBindingId,
  protectedTaskRunResultObjectId,
  protectedTaskRunResultOperationId,
  protectedTaskRunWakeOperationId,
} from "./protected-task-output-binding-identities";

const CANONICAL_UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const OPAQUE_CHECKPOINT_COORDINATE = /^[A-Za-z0-9][A-Za-z0-9._:@/-]*$/u;
const CONTINUATION_FINGERPRINT = /^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/u;

export const PROTECTED_TASK_CANCELLED_RESULT = "Task cancelled" as const;

export type ProtectedTaskCancellationOutputAuthority = Readonly<{
  taskId: string;
  taskRunId: string;
  contentNamespaceId: string;
  jobAuthorizationRequestId: string | null;
}>;

export type ProtectedTaskCancellationOutputIntent = Readonly<{
  taskId: string;
  taskRunId: string;
  requesterUserId: string;
  agentId: string;
  contentNamespaceId: string;
  representation: "protected" | "dual";
  resultRevision: 2;
  resultOperationId: string;
  resultObjectId: string;
  policyRevision: number;
  taskStatus: "cancelled";
  runStatus: "cancelled";
  terminalAt: Date;
}>;

export type PrepareProtectedTaskCancellationOutputResult =
  | Readonly<{
      status: "prepared" | "exact_replay";
      binding: ProtectedTaskRunOutputBinding;
      intent: ProtectedTaskCancellationOutputIntent;
      previousAuthority: ProtectedTaskCancellationOutputAuthority;
    }>
  | Readonly<{
      status: "rejected";
      reason:
        | "authority_changed"
        | "conflict"
        | "not_found"
        | "not_ready"
        | "stale";
    }>;

type PreviousAuthoritySettlement = (
  authority: ProtectedTaskCancellationOutputAuthority,
) => Promise<boolean>;

export type ProtectedTaskCancellationProductTransaction = Pick<
  DirectDatabase,
  "select" | "update"
>;

export type ProtectedTaskCancellationProductPrepared = Readonly<{
  operationId: string;
  resultRevision: 2;
  resultObjectId: string;
  requesterHumanId: string;
  authorityFingerprint: Uint8Array;
}>;

export type PublishProtectedTaskCancellationProductResult =
  | Readonly<{ status: "written" | "exact_replay" }>
  | Readonly<{
      status: "rejected";
      reason: "authority_changed" | "conflict" | "not_found";
    }>;

type AssertCurrentCancellationAuthority = (
  transaction: ProtectedTaskCancellationProductTransaction,
) => Promise<boolean>;

class CancellationAuthorityChanged extends Error {}

type ProtectedTaskCancellationJob = Readonly<{
  id: string;
  ownerId: string;
  requestorId: string;
  laneKey: string | null;
  type: string;
  status: string;
  referenceHasClosedKeys: boolean;
  referenceKind: string | null;
  referenceTaskId: string | null;
  referenceTaskRunId: string | null;
  referenceInputObjectId: string | null;
  referenceResultObjectId: string | null;
  referenceAuthorizationRequestId: string | null;
  referencePolicyRevision: string | null;
  referenceExecutionSegment: string | null;
  referenceResumeAcceptanceId: string | null;
  referenceResumeContinuationFingerprint: string | null;
  startedAt: Date | null;
  completedAt: Date | null;
  resultIsNull: boolean;
  messageIsNull: boolean;
}>;

type ProtectedTaskCancellationTask = Pick<
  Task,
  | "id"
  | "ownerId"
  | "requestorId"
  | "agentId"
  | "callingRoomId"
  | "resultDelivery"
  | "status"
  | "contentRepresentation"
  | "contentNamespaceId"
  | "contentRevision"
  | "cryptoObjectId"
  | "cryptoAccessRevision"
  | "cryptoRequiredNamespaceFingerprint"
  | "cryptoMappingState"
  | "cancelledAt"
> & Readonly<{
  promptIsEmpty: boolean;
  expectedOutputIsNull: boolean;
  lastErrorIsNull: boolean;
}>;

type ProtectedTaskCancellationRun = Pick<
  TaskRun,
  | "id"
  | "taskId"
  | "jobId"
  | "status"
  | "completedAt"
  | "resultRepresentation"
  | "resultContentNamespaceId"
  | "resultRevision"
  | "resultCryptoObjectId"
  | "resultCryptoAccessRevision"
  | "resultCryptoRequiredNamespaceFingerprint"
  | "resultCryptoMappingState"
> & Readonly<{
  resultTextIsNull: boolean;
  resultTextIsCancelled: boolean;
  lastErrorIsNull: boolean;
}>;

const cancellationTaskProjection = {
  id: tasks.id,
  ownerId: tasks.ownerId,
  requestorId: tasks.requestorId,
  agentId: tasks.agentId,
  callingRoomId: tasks.callingRoomId,
  resultDelivery: tasks.resultDelivery,
  status: tasks.status,
  contentRepresentation: tasks.contentRepresentation,
  contentNamespaceId: tasks.contentNamespaceId,
  contentRevision: tasks.contentRevision,
  cryptoObjectId: tasks.cryptoObjectId,
  cryptoAccessRevision: tasks.cryptoAccessRevision,
  cryptoRequiredNamespaceFingerprint: tasks.cryptoRequiredNamespaceFingerprint,
  cryptoMappingState: tasks.cryptoMappingState,
  cancelledAt: tasks.cancelledAt,
  promptIsEmpty: sql<boolean>`${tasks.prompt} = ''`,
  expectedOutputIsNull: sql<boolean>`${tasks.expectedOutput} is null`,
  lastErrorIsNull: sql<boolean>`${tasks.lastError} is null`,
} as const;

const cancellationRunProjection = {
  id: taskRuns.id,
  taskId: taskRuns.taskId,
  jobId: taskRuns.jobId,
  status: taskRuns.status,
  completedAt: taskRuns.completedAt,
  resultRepresentation: taskRuns.resultRepresentation,
  resultContentNamespaceId: taskRuns.resultContentNamespaceId,
  resultRevision: taskRuns.resultRevision,
  resultCryptoObjectId: taskRuns.resultCryptoObjectId,
  resultCryptoAccessRevision: taskRuns.resultCryptoAccessRevision,
  resultCryptoRequiredNamespaceFingerprint:
    taskRuns.resultCryptoRequiredNamespaceFingerprint,
  resultCryptoMappingState: taskRuns.resultCryptoMappingState,
  resultTextIsNull: sql<boolean>`${taskRuns.resultText} is null`,
  resultTextIsCancelled:
    sql<boolean>`${taskRuns.resultText} = ${PROTECTED_TASK_CANCELLED_RESULT}`,
  lastErrorIsNull: sql<boolean>`${taskRuns.lastError} is null`,
} as const;

type ProtectedTaskCancellationDefinitionRevision = Pick<
  TaskDefinitionCryptoRevision,
  | "taskId"
  | "contentNamespaceId"
  | "contentRevision"
  | "cryptoObjectId"
  | "representation"
  | "payloadVersion"
  | "cryptoAccessRevision"
  | "requiredNamespaceFingerprint"
  | "completion"
  | "disposition"
  | "failureCode"
>;

const cancellationDefinitionProjection = {
  taskId: taskDefinitionCryptoRevisions.taskId,
  contentNamespaceId: taskDefinitionCryptoRevisions.contentNamespaceId,
  contentRevision: taskDefinitionCryptoRevisions.contentRevision,
  cryptoObjectId: taskDefinitionCryptoRevisions.cryptoObjectId,
  representation: taskDefinitionCryptoRevisions.representation,
  payloadVersion: taskDefinitionCryptoRevisions.payloadVersion,
  cryptoAccessRevision: taskDefinitionCryptoRevisions.cryptoAccessRevision,
  requiredNamespaceFingerprint:
    taskDefinitionCryptoRevisions.requiredNamespaceFingerprint,
  completion: taskDefinitionCryptoRevisions.completion,
  disposition: taskDefinitionCryptoRevisions.disposition,
  failureCode: taskDefinitionCryptoRevisions.failureCode,
} as const;

type ProtectedTaskCancellationResultRevision = Pick<
  TaskRunResultCryptoRevision,
  | "taskId"
  | "taskRunId"
  | "contentNamespaceId"
  | "anchorNamespaceId"
  | "resultRevision"
  | "operationId"
  | "requestDigest"
  | "authorityFingerprint"
  | "requesterHumanId"
  | "cryptoObjectId"
  | "representation"
  | "payloadVersion"
  | "cryptoAccessRevision"
  | "requiredNamespaceFingerprint"
  | "completion"
  | "disposition"
  | "failureCode"
>;

const cancellationResultProjection = {
  taskId: taskRunResultCryptoRevisions.taskId,
  taskRunId: taskRunResultCryptoRevisions.taskRunId,
  contentNamespaceId: taskRunResultCryptoRevisions.contentNamespaceId,
  anchorNamespaceId: taskRunResultCryptoRevisions.anchorNamespaceId,
  resultRevision: taskRunResultCryptoRevisions.resultRevision,
  operationId: taskRunResultCryptoRevisions.operationId,
  requestDigest: taskRunResultCryptoRevisions.requestDigest,
  authorityFingerprint: taskRunResultCryptoRevisions.authorityFingerprint,
  requesterHumanId: taskRunResultCryptoRevisions.requesterHumanId,
  cryptoObjectId: taskRunResultCryptoRevisions.cryptoObjectId,
  representation: taskRunResultCryptoRevisions.representation,
  payloadVersion: taskRunResultCryptoRevisions.payloadVersion,
  cryptoAccessRevision: taskRunResultCryptoRevisions.cryptoAccessRevision,
  requiredNamespaceFingerprint:
    taskRunResultCryptoRevisions.requiredNamespaceFingerprint,
  completion: taskRunResultCryptoRevisions.completion,
  disposition: taskRunResultCryptoRevisions.disposition,
  failureCode: taskRunResultCryptoRevisions.failureCode,
} as const;

function rejected(
  reason: Extract<
    PrepareProtectedTaskCancellationOutputResult,
    { status: "rejected" }
  >["reason"],
): PrepareProtectedTaskCancellationOutputResult {
  return Object.freeze({ status: "rejected" as const, reason });
}

function productRejected(
  reason: Extract<
    PublishProtectedTaskCancellationProductResult,
    { status: "rejected" }
  >["reason"],
): PublishProtectedTaskCancellationProductResult {
  return Object.freeze({ status: "rejected" as const, reason });
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left[index]! ^ right[index]!;
  }
  return difference === 0;
}

function exactDestination(
  task: ProtectedTaskCancellationTask,
  binding: ProtectedTaskRunOutputBinding,
  destinationNamespaceId: string | null,
): boolean {
  const deliveryMode = task.callingRoomId === null
    ? "none" as const
    : task.resultDelivery;
  const messageOperationId = deliveryMode === "raw"
      || deliveryMode === "raw_and_wake"
    ? protectedTaskRunMessageOperationId(binding.taskRunId)
    : null;
  const wakeOperationId = deliveryMode === "wake"
      || deliveryMode === "raw_and_wake"
    ? protectedTaskRunWakeOperationId(binding.taskRunId)
    : null;
  return binding.deliveryMode === deliveryMode
    && binding.destinationRoomId === task.callingRoomId
    && binding.destinationNamespaceId === destinationNamespaceId
    && binding.messageOperationId === messageOperationId
    && binding.wakeOperationId === wakeOperationId;
}

function pristineCancelledRun(
  task: ProtectedTaskCancellationTask,
  run: ProtectedTaskCancellationRun,
): boolean {
  return task.status === "cancelled"
    && task.cancelledAt !== null
    && run.status === "cancelled"
    && run.completedAt !== null
    && run.completedAt.getTime() === task.cancelledAt.getTime()
    && run.resultTextIsNull
    && run.lastErrorIsNull
    && run.resultRepresentation === "ordinary"
    && run.resultContentNamespaceId === null
    && run.resultRevision === 0
    && run.resultCryptoObjectId === null
    && run.resultCryptoAccessRevision === 0
    && run.resultCryptoRequiredNamespaceFingerprint === null
    && run.resultCryptoMappingState === "unmapped";
}

function exactProtectedJob(
  task: ProtectedTaskCancellationTask,
  run: ProtectedTaskCancellationRun,
  job: ProtectedTaskCancellationJob,
): ProtectedTaskCancellationOutputAuthority | null {
  if (
    job.id !== run.jobId
    || job.ownerId !== task.requestorId
    || job.requestorId !== task.requestorId
    || job.laneKey !== `task:${task.id}`
    || job.type !== "foreground"
    || !job.resultIsNull
    || !job.messageIsNull
  ) return null;
  const executionSegment = job.referenceExecutionSegment !== null
      && /^[1-9][0-9]*$/u.test(job.referenceExecutionSegment)
    ? Number(job.referenceExecutionSegment)
    : Number.NaN;
  const policyRevision = job.referencePolicyRevision !== null
      && /^[1-9][0-9]*$/u.test(job.referencePolicyRevision)
    ? Number(job.referencePolicyRevision)
    : Number.NaN;
  const hasAcceptance = job.referenceResumeAcceptanceId !== null;
  const hasContinuation =
    job.referenceResumeContinuationFingerprint !== null;
  const resumed = Number.isSafeInteger(executionSegment)
    && executionSegment > 1;
  if (
    !job.referenceHasClosedKeys
    || job.referenceKind !== "protected_task_run_v1"
    || job.referenceTaskId !== task.id
    || job.referenceTaskRunId !== run.id
    || job.referenceInputObjectId !== task.cryptoObjectId
    || job.referenceResultObjectId
      !== protectedTaskRunResultObjectId(task.id, run.id)
    || job.referenceAuthorizationRequestId === null
    || job.referenceAuthorizationRequestId.length === 0
    || !Number.isSafeInteger(policyRevision)
    || policyRevision < 1
    || !Number.isSafeInteger(executionSegment)
    || executionSegment < 1
    || (resumed
      ? hasAcceptance === hasContinuation
      : hasAcceptance || hasContinuation)
    || (hasAcceptance
      && (typeof job.referenceResumeAcceptanceId !== "string"
        || !OPAQUE_CHECKPOINT_COORDINATE.test(
          job.referenceResumeAcceptanceId,
        )))
    || (hasContinuation
      && (typeof job.referenceResumeContinuationFingerprint !== "string"
        || !CONTINUATION_FINGERPRINT.test(
          job.referenceResumeContinuationFingerprint,
        )))
  ) return null;
  const terminal = job.status === "cancelled" && job.completedAt !== null
    || job.status === "completed" && job.startedAt !== null
      && job.completedAt !== null
    || (job.status === "failed" || job.status === "timed_out")
      && job.completedAt !== null;
  if (!terminal) return null;
  return Object.freeze({
    taskId: task.id,
    taskRunId: run.id,
    contentNamespaceId: task.contentNamespaceId!,
    jobAuthorizationRequestId: job.referenceAuthorizationRequestId,
  });
}

function expectedPreviousAuthority(
  task: ProtectedTaskCancellationTask,
  run: ProtectedTaskCancellationRun,
  job: ProtectedTaskCancellationJob | undefined,
): ProtectedTaskCancellationOutputAuthority | null {
  if (job !== undefined) return exactProtectedJob(task, run, job);
  return Object.freeze({
    taskId: task.id,
    taskRunId: run.id,
    contentNamespaceId: task.contentNamespaceId!,
    jobAuthorizationRequestId: null,
  });
}

function cancellationIntent(
  task: ProtectedTaskCancellationTask,
  run: ProtectedTaskCancellationRun,
  policyRevision: number,
): ProtectedTaskCancellationOutputIntent {
  return Object.freeze({
    taskId: task.id,
    taskRunId: run.id,
    requesterUserId: task.requestorId,
    agentId: task.agentId,
    contentNamespaceId: task.contentNamespaceId!,
    representation: task.contentRepresentation as "protected" | "dual",
    resultRevision: 2 as const,
    resultOperationId: protectedTaskRunCancelledResultOperationId(run.id),
    resultObjectId: protectedTaskRunCancelledResultObjectId(task.id, run.id),
    policyRevision,
    taskStatus: "cancelled" as const,
    runStatus: "cancelled" as const,
    terminalAt: new Date(run.completedAt!.getTime()),
  });
}

function noPublishedOutput(binding: ProtectedTaskRunOutputBinding): boolean {
  return binding.resultAttachedAt === null
    && binding.messageId === null
    && binding.messagePublishedAt === null
    && binding.wakeJobId === null
    && binding.wakeScheduledAt === null
    && binding.completedAt === null;
}

/**
 * Replace a stopped protected occurrence's unused execution-result intent with
 * the fixed cancellation-result coordinate. The caller proves that every
 * previous execution authorization has already settled while the exact stopped
 * product rows remain locked. No crypto publication or delivery occurs here.
 */
export async function prepareProtectedTaskCancellationOutput(
  db: DirectDatabase,
  input: Readonly<{
    taskId: string;
    taskRunId: string;
    requiredPolicyRevision: number;
  }>,
  settlePreviousAuthority: PreviousAuthoritySettlement,
): Promise<PrepareProtectedTaskCancellationOutputResult> {
  if (
    !CANONICAL_UUID.test(input.taskId)
    || !CANONICAL_UUID.test(input.taskRunId)
    || !Number.isSafeInteger(input.requiredPolicyRevision)
    || input.requiredPolicyRevision < 1
    || typeof settlePreviousAuthority !== "function"
  ) throw new TypeError("Protected Task cancellation output input is malformed");

  return db.transaction(async (tx) => {
    // Policy is deliberately first: fresh cancellation custody must never be
    // prepared from an execution-era policy snapshot.
    const [policy] = await tx.select().from(encryptionTransitionPolicy)
      .where(eq(encryptionTransitionPolicy.id, "server"))
      .limit(1)
      .for("share");
    if (!policy || policy.revision !== input.requiredPolicyRevision) {
      return rejected("authority_changed");
    }

    const [task] = await tx.select(cancellationTaskProjection).from(tasks)
      .where(eq(tasks.id, input.taskId)).limit(1).for("update");
    if (!task) return rejected("not_found");
    const [run] = await tx.select(cancellationRunProjection).from(taskRuns).where(and(
      eq(taskRuns.id, input.taskRunId),
      eq(taskRuns.taskId, input.taskId),
    )).limit(1).for("update");
    if (!run) return rejected("not_found");

    let job: ProtectedTaskCancellationJob | undefined;
    if (run.jobId !== null) {
      [job] = await tx.select({
        id: jobs.id,
        ownerId: jobs.ownerId,
        requestorId: jobs.requestorId,
        laneKey: jobs.laneKey,
        type: jobs.type,
        status: jobs.status,
        referenceHasClosedKeys: sql<boolean>`
          case when jsonb_typeof(${jobs.input}) = 'object' then
            ${jobs.input} - ARRAY[
              'kind', 'taskId', 'taskRunId', 'inputObjectId', 'resultObjectId',
              'authorizationRequestId', 'policyRevision', 'executionSegment',
              'resumeAcceptanceId', 'resumeContinuationFingerprint'
            ]::text[] = '{}'::jsonb
            and jsonb_typeof(${jobs.input} -> 'kind') = 'string'
            and jsonb_typeof(${jobs.input} -> 'taskId') = 'string'
            and jsonb_typeof(${jobs.input} -> 'taskRunId') = 'string'
            and jsonb_typeof(${jobs.input} -> 'inputObjectId') = 'string'
            and jsonb_typeof(${jobs.input} -> 'resultObjectId') = 'string'
            and jsonb_typeof(${jobs.input} -> 'authorizationRequestId') = 'string'
            and jsonb_typeof(${jobs.input} -> 'policyRevision') = 'number'
            and jsonb_typeof(${jobs.input} -> 'executionSegment') = 'number'
            and (
              (not (${jobs.input} ? 'resumeAcceptanceId')
                and not (${jobs.input} ? 'resumeContinuationFingerprint'))
              or (${jobs.input} ? 'resumeAcceptanceId'
                and not (${jobs.input} ? 'resumeContinuationFingerprint')
                and jsonb_typeof(${jobs.input} -> 'resumeAcceptanceId') = 'string')
              or (not (${jobs.input} ? 'resumeAcceptanceId')
                and ${jobs.input} ? 'resumeContinuationFingerprint'
                and jsonb_typeof(
                  ${jobs.input} -> 'resumeContinuationFingerprint'
                ) = 'string')
            )
          else false end`,
        referenceKind: sql<string | null>`${jobs.input} ->> 'kind'`,
        referenceTaskId: sql<string | null>`${jobs.input} ->> 'taskId'`,
        referenceTaskRunId:
          sql<string | null>`${jobs.input} ->> 'taskRunId'`,
        referenceInputObjectId:
          sql<string | null>`${jobs.input} ->> 'inputObjectId'`,
        referenceResultObjectId:
          sql<string | null>`${jobs.input} ->> 'resultObjectId'`,
        referenceAuthorizationRequestId:
          sql<string | null>`${jobs.input} ->> 'authorizationRequestId'`,
        referencePolicyRevision:
          sql<string | null>`${jobs.input} ->> 'policyRevision'`,
        referenceExecutionSegment:
          sql<string | null>`${jobs.input} ->> 'executionSegment'`,
        referenceResumeAcceptanceId:
          sql<string | null>`${jobs.input} ->> 'resumeAcceptanceId'`,
        referenceResumeContinuationFingerprint:
          sql<string | null>`${jobs.input} ->> 'resumeContinuationFingerprint'`,
        startedAt: jobs.startedAt,
        completedAt: jobs.completedAt,
        resultIsNull: sql<boolean>`${jobs.result} is null`,
        messageIsNull: sql<boolean>`${jobs.message} is null`,
      }).from(jobs).where(eq(jobs.id, run.jobId))
        .limit(1).for("update");
      if (!job) return rejected("not_found");
    }

    const [binding] = await tx.select().from(protectedTaskRunOutputBindings)
      .where(eq(protectedTaskRunOutputBindings.taskRunId, run.id))
      .limit(1).for("update");

    if (
      (task.contentRepresentation !== "protected"
        && task.contentRepresentation !== "dual")
      || task.ownerId !== task.requestorId
      || task.contentNamespaceId === null
      || task.cryptoObjectId === null
      || task.cryptoRequiredNamespaceFingerprint === null
      || task.cryptoRequiredNamespaceFingerprint.length !== 32
      || task.cryptoMappingState !== "verified"
      || !task.lastErrorIsNull
      || policy.mode !== (task.contentRepresentation === "dual"
        ? "shadow_encryption"
        : "encrypted_only")
    ) return rejected("authority_changed");
    if (!pristineCancelledRun(task, run)) return rejected("stale");

    let destinationNamespaceId: string | null = null;
    if (task.callingRoomId !== null) {
      const [room] = await tx.select({
        id: rooms.id,
        namespaceId: rooms.namespaceId,
      }).from(rooms).where(and(
        eq(rooms.id, task.callingRoomId),
        isNull(rooms.archivedAt),
      )).limit(1).for("share");
      if (!room || room.namespaceId === null) return rejected("authority_changed");
      destinationNamespaceId = room.namespaceId;
    }

    if (binding !== undefined && (
      binding.bindingId !== protectedTaskRunOutputBindingId(run.id)
      || !exactDestination(task, binding, destinationNamespaceId)
    )) return rejected("conflict");
    if (binding !== undefined && !noPublishedOutput(binding)) {
      return rejected("conflict");
    }

    const previousAuthority = expectedPreviousAuthority(task, run, job);
    if (previousAuthority === null) return rejected("conflict");

    const cancelledOperationId =
      protectedTaskRunCancelledResultOperationId(run.id);
    const cancelledObjectId =
      protectedTaskRunCancelledResultObjectId(task.id, run.id);
    const exactCancellationIntent = binding !== undefined
      && binding.resultRevision === 2
      && binding.resultOperationId === cancelledOperationId
      && binding.resultObjectId === cancelledObjectId
      && binding.resultTerminalAt?.getTime() === run.completedAt!.getTime()
      && binding.acceptedPolicyRevision === policy.revision;
    const exactExecutionIntent = binding !== undefined
      && binding.resultRevision === 1
      && binding.resultOperationId === protectedTaskRunResultOperationId(run.id)
      && binding.resultObjectId === protectedTaskRunResultObjectId(task.id, run.id)
      && binding.resultTerminalAt === null
      && Number.isSafeInteger(binding.acceptedPolicyRevision)
      && binding.acceptedPolicyRevision > 0;
    const intent = cancellationIntent(task, run, policy.revision);
    if (binding !== undefined
      && !exactCancellationIntent && !exactExecutionIntent) {
      return rejected("conflict");
    }
    if (!await settlePreviousAuthority(previousAuthority)) {
      return rejected("not_ready");
    }
    if (exactCancellationIntent) {
      return Object.freeze({
        status: "exact_replay" as const,
        binding,
        intent,
        previousAuthority,
      });
    }

    if (binding === undefined) {
      const deliveryMode = task.callingRoomId === null
        ? "none" as const
        : task.resultDelivery;
      const [inserted] = await tx.insert(protectedTaskRunOutputBindings).values({
        taskRunId: run.id,
        bindingId: protectedTaskRunOutputBindingId(run.id),
        deliveryMode,
        destinationRoomId: task.callingRoomId,
        destinationNamespaceId,
        resultRevision: 2,
        resultOperationId: cancelledOperationId,
        resultObjectId: cancelledObjectId,
        messageOperationId: deliveryMode === "raw"
            || deliveryMode === "raw_and_wake"
          ? protectedTaskRunMessageOperationId(run.id)
          : null,
        wakeOperationId: deliveryMode === "wake"
            || deliveryMode === "raw_and_wake"
          ? protectedTaskRunWakeOperationId(run.id)
          : null,
        acceptedPolicyRevision: policy.revision,
        acceptedAt: new Date(task.cancelledAt!.getTime()),
        resultTerminalAt: new Date(run.completedAt!.getTime()),
      }).returning();
      if (!inserted) {
        throw new Error("Protected Task cancellation output insert failed");
      }
      return Object.freeze({
        status: "prepared" as const,
        binding: inserted,
        intent,
        previousAuthority,
      });
    }

    const [updated] = await tx.update(protectedTaskRunOutputBindings).set({
      resultRevision: 2,
      resultOperationId: cancelledOperationId,
      resultObjectId: cancelledObjectId,
      acceptedPolicyRevision: policy.revision,
      resultTerminalAt: new Date(run.completedAt!.getTime()),
    }).where(and(
      eq(protectedTaskRunOutputBindings.taskRunId, run.id),
      eq(protectedTaskRunOutputBindings.resultRevision, 1),
      eq(
        protectedTaskRunOutputBindings.resultOperationId,
        protectedTaskRunResultOperationId(run.id),
      ),
      eq(
        protectedTaskRunOutputBindings.resultObjectId,
        protectedTaskRunResultObjectId(task.id, run.id),
      ),
      eq(
        protectedTaskRunOutputBindings.acceptedPolicyRevision,
        binding.acceptedPolicyRevision,
      ),
      isNull(protectedTaskRunOutputBindings.resultTerminalAt),
      isNull(protectedTaskRunOutputBindings.resultAttachedAt),
      isNull(protectedTaskRunOutputBindings.messageId),
      isNull(protectedTaskRunOutputBindings.messagePublishedAt),
      isNull(protectedTaskRunOutputBindings.wakeJobId),
      isNull(protectedTaskRunOutputBindings.wakeScheduledAt),
      isNull(protectedTaskRunOutputBindings.completedAt),
    )).returning();
    if (!updated) {
      throw new Error("Protected Task cancellation output lost its locked binding");
    }
    return Object.freeze({
      status: "prepared" as const,
      binding: updated,
      intent,
      previousAuthority,
    });
  });
}

function exactCancellationDefinition(
  task: ProtectedTaskCancellationTask,
  revision: ProtectedTaskCancellationDefinitionRevision | undefined,
  intent: ProtectedTaskCancellationOutputIntent,
): boolean {
  return task.id === intent.taskId
    && task.ownerId === intent.requesterUserId
    && task.requestorId === intent.requesterUserId
    && task.agentId === intent.agentId
    && task.status === "cancelled"
    && task.cancelledAt?.getTime() === intent.terminalAt.getTime()
    && task.contentRepresentation === intent.representation
    && task.contentNamespaceId === intent.contentNamespaceId
    && task.contentRevision > 0
    && task.cryptoObjectId !== null
    && task.cryptoAccessRevision >= 0
    && task.cryptoRequiredNamespaceFingerprint !== null
    && task.cryptoRequiredNamespaceFingerprint.length === 32
    && task.cryptoMappingState === "verified"
    && task.lastErrorIsNull
    && (intent.representation !== "protected"
      || task.promptIsEmpty && task.expectedOutputIsNull)
    && revision !== undefined
    && revision.taskId === task.id
    && revision.contentNamespaceId === intent.contentNamespaceId
    && revision.contentRevision === task.contentRevision
    && revision.cryptoObjectId === task.cryptoObjectId
    && revision.representation === intent.representation
    && revision.payloadVersion === 1
    && revision.cryptoAccessRevision === task.cryptoAccessRevision
    && sameBytes(
      revision.requiredNamespaceFingerprint,
      task.cryptoRequiredNamespaceFingerprint,
    )
    && revision.completion === "complete"
    && revision.disposition === "mapped"
    && revision.failureCode === null;
}

function exactCancellationReservation(
  task: ProtectedTaskCancellationTask,
  revision: ProtectedTaskCancellationResultRevision | undefined,
  intent: ProtectedTaskCancellationOutputIntent,
  prepared: ProtectedTaskCancellationProductPrepared,
  requestDigest: Uint8Array,
): revision is ProtectedTaskCancellationResultRevision {
  return revision !== undefined
    && revision.taskId === intent.taskId
    && revision.taskRunId === intent.taskRunId
    && revision.contentNamespaceId === intent.contentNamespaceId
    && revision.anchorNamespaceId === intent.contentNamespaceId
    && revision.resultRevision === 2
    && revision.operationId === intent.resultOperationId
    && revision.operationId === prepared.operationId
    && sameBytes(revision.requestDigest, requestDigest)
    && revision.cryptoObjectId === intent.resultObjectId
    && revision.cryptoObjectId === prepared.resultObjectId
    && revision.requesterHumanId === prepared.requesterHumanId
    && sameBytes(revision.authorityFingerprint, prepared.authorityFingerprint)
    && revision.representation === intent.representation
    && revision.payloadVersion === 1
    && revision.cryptoAccessRevision === 0
    && task.cryptoRequiredNamespaceFingerprint !== null
    && sameBytes(
      revision.requiredNamespaceFingerprint,
      task.cryptoRequiredNamespaceFingerprint,
    )
    && revision.failureCode === null
    && (revision.disposition === "active"
      && (revision.completion === "pending"
        || revision.completion === "complete")
      || revision.disposition === "mapped"
        && revision.completion === "complete");
}

function exactCancellationBinding(
  binding: ProtectedTaskRunOutputBinding | undefined,
  intent: ProtectedTaskCancellationOutputIntent,
): binding is ProtectedTaskRunOutputBinding {
  return binding !== undefined
    && binding.taskRunId === intent.taskRunId
    && binding.bindingId === protectedTaskRunOutputBindingId(intent.taskRunId)
    && binding.resultRevision === 2
    && binding.resultOperationId === intent.resultOperationId
    && binding.resultObjectId === intent.resultObjectId
    && binding.acceptedPolicyRevision === intent.policyRevision
    && binding.resultTerminalAt?.getTime() === intent.terminalAt.getTime();
}

function cancellationRunState(
  run: ProtectedTaskCancellationRun,
  revision: ProtectedTaskCancellationResultRevision,
  intent: ProtectedTaskCancellationOutputIntent,
): "unwritten" | "written" | "mapped" | null {
  if (
    run.id !== intent.taskRunId
    || run.taskId !== intent.taskId
    || run.status !== "cancelled"
    || run.completedAt?.getTime() !== intent.terminalAt.getTime()
    || !run.lastErrorIsNull
  ) return null;
  const unmapped = run.resultRepresentation === "ordinary"
    && run.resultContentNamespaceId === null
    && run.resultRevision === 0
    && run.resultCryptoObjectId === null
    && run.resultCryptoAccessRevision === 0
    && run.resultCryptoRequiredNamespaceFingerprint === null
    && run.resultCryptoMappingState === "unmapped"
    && revision.disposition === "active";
  if (unmapped) {
    if (intent.representation === "protected") {
      return run.resultTextIsNull ? "written" : null;
    }
    if (run.resultTextIsNull) return "unwritten";
    return run.resultTextIsCancelled
      ? "written"
      : null;
  }
  const mapped = run.resultRepresentation === intent.representation
    && run.resultContentNamespaceId === intent.contentNamespaceId
    && run.resultRevision === 2
    && run.resultCryptoObjectId === intent.resultObjectId
    && run.resultCryptoAccessRevision === revision.cryptoAccessRevision
    && run.resultCryptoRequiredNamespaceFingerprint !== null
    && sameBytes(
      run.resultCryptoRequiredNamespaceFingerprint,
      revision.requiredNamespaceFingerprint,
    )
    && run.resultCryptoMappingState === "verified"
    && revision.completion === "complete"
    && revision.disposition === "mapped"
    && (intent.representation === "protected"
      ? run.resultTextIsNull
      : run.resultTextIsCancelled);
  return mapped ? "mapped" : null;
}

/**
 * Validate and write the product-side fixed cancellation result after the
 * central repository has reserved its immutable revision. This callback never
 * starts execution or changes Task/TaskRun lifecycle state.
 */
export async function publishProtectedTaskCancellationProduct(
  db: DirectDatabase,
  input: Readonly<{
    intent: ProtectedTaskCancellationOutputIntent;
    prepared: ProtectedTaskCancellationProductPrepared;
    requestDigest: Uint8Array;
  }>,
  assertCurrentAuthority: AssertCurrentCancellationAuthority,
): Promise<PublishProtectedTaskCancellationProductResult> {
  const requestedIntent = input.intent;
  const requestedPrepared = input.prepared;
  const requestedDigest = input.requestDigest;
  if (
    !CANONICAL_UUID.test(requestedIntent.taskId)
    || !CANONICAL_UUID.test(requestedIntent.taskRunId)
    || !CANONICAL_UUID.test(requestedIntent.requesterUserId)
    || !CANONICAL_UUID.test(requestedIntent.agentId)
    || !CANONICAL_UUID.test(requestedIntent.contentNamespaceId)
    || requestedIntent.resultRevision !== 2
    || requestedIntent.resultOperationId
      !== protectedTaskRunCancelledResultOperationId(requestedIntent.taskRunId)
    || requestedIntent.resultObjectId
      !== protectedTaskRunCancelledResultObjectId(
        requestedIntent.taskId,
        requestedIntent.taskRunId,
      )
    || requestedPrepared.operationId !== requestedIntent.resultOperationId
    || requestedPrepared.resultRevision !== 2
    || requestedPrepared.resultObjectId !== requestedIntent.resultObjectId
    || !CANONICAL_UUID.test(requestedPrepared.requesterHumanId)
    || !(requestedPrepared.authorityFingerprint instanceof Uint8Array)
    || requestedPrepared.authorityFingerprint.length !== 32
    || !(requestedDigest instanceof Uint8Array)
    || requestedDigest.length !== 32
    || (requestedIntent.representation !== "protected"
      && requestedIntent.representation !== "dual")
    || !Number.isSafeInteger(requestedIntent.policyRevision)
    || requestedIntent.policyRevision < 1
    || requestedIntent.taskStatus !== "cancelled"
    || requestedIntent.runStatus !== "cancelled"
    || !(requestedIntent.terminalAt instanceof Date)
    || !Number.isFinite(requestedIntent.terminalAt.getTime())
    || typeof assertCurrentAuthority !== "function"
  ) throw new TypeError("Protected Task cancellation product input is malformed");

  const intent = Object.freeze({
    ...requestedIntent,
    terminalAt: new Date(requestedIntent.terminalAt.getTime()),
  });
  const prepared = Object.freeze({
    ...requestedPrepared,
    authorityFingerprint: requestedPrepared.authorityFingerprint.slice(),
  });
  const requestDigest = requestedDigest.slice();

  try {
    return await db.transaction(async (tx) => {
      const [policy] = await tx.select().from(encryptionTransitionPolicy)
        .where(eq(encryptionTransitionPolicy.id, "server"))
        .limit(1).for("share");
      const [task] = await tx.select(cancellationTaskProjection).from(tasks)
        .where(eq(tasks.id, intent.taskId)).limit(1).for("update");
      if (!task) return productRejected("not_found");
      const [run] = await tx.select(cancellationRunProjection).from(taskRuns).where(and(
        eq(taskRuns.id, intent.taskRunId),
        eq(taskRuns.taskId, intent.taskId),
      )).limit(1).for("update");
      if (!run) return productRejected("not_found");
      const [binding] = await tx.select().from(protectedTaskRunOutputBindings)
        .where(eq(protectedTaskRunOutputBindings.taskRunId, intent.taskRunId))
        .limit(1).for("update");
      const [definition] = await tx.select(cancellationDefinitionProjection)
        .from(taskDefinitionCryptoRevisions)
        .where(and(
          eq(taskDefinitionCryptoRevisions.taskId, intent.taskId),
          eq(taskDefinitionCryptoRevisions.contentRevision, task.contentRevision),
        )).limit(1).for("share");
      const [reservation] = await tx.select(cancellationResultProjection)
        .from(taskRunResultCryptoRevisions)
        .where(and(
          eq(taskRunResultCryptoRevisions.taskId, intent.taskId),
          eq(taskRunResultCryptoRevisions.taskRunId, intent.taskRunId),
          eq(taskRunResultCryptoRevisions.resultRevision, 2),
          eq(taskRunResultCryptoRevisions.operationId, intent.resultOperationId),
        )).limit(1).for("share");
      const [requesterHuman] = reservation === undefined
        ? []
        : await tx.select({ id: actors.id }).from(actors).where(and(
          eq(actors.id, prepared.requesterHumanId),
          eq(actors.kind, "user"),
          eq(actors.ownerId, intent.requesterUserId),
        )).limit(1).for("share");

      if (
        !policy
        || policy.revision !== intent.policyRevision
        || policy.mode !== (intent.representation === "dual"
          ? "shadow_encryption"
          : "encrypted_only")
      ) return productRejected("authority_changed");
      if (
        !exactCancellationDefinition(task, definition, intent)
        || !exactCancellationBinding(binding, intent)
        || requesterHuman === undefined
        || !exactCancellationReservation(
          task,
          reservation,
          intent,
          prepared,
          requestDigest,
        )
      ) return productRejected("conflict");
      const state = cancellationRunState(run, reservation, intent);
      if (state === null
        || state !== "mapped" && binding.resultAttachedAt !== null) {
        return productRejected("conflict");
      }

      if (!await assertCurrentAuthority(tx)) {
        throw new CancellationAuthorityChanged();
      }
      let status: "written" | "exact_replay" = "exact_replay";
      if (state === "unwritten") {
        const [updated] = await tx.update(taskRuns).set({
          resultText: PROTECTED_TASK_CANCELLED_RESULT,
          lastError: null,
        }).where(and(
          eq(taskRuns.id, intent.taskRunId),
          eq(taskRuns.taskId, intent.taskId),
          eq(taskRuns.status, "cancelled"),
          eq(taskRuns.completedAt, intent.terminalAt),
          eq(taskRuns.resultRepresentation, "ordinary"),
          eq(taskRuns.resultRevision, 0),
          isNull(taskRuns.resultContentNamespaceId),
          isNull(taskRuns.resultCryptoObjectId),
          eq(taskRuns.resultCryptoAccessRevision, 0),
          isNull(taskRuns.resultCryptoRequiredNamespaceFingerprint),
          eq(taskRuns.resultCryptoMappingState, "unmapped"),
          isNull(taskRuns.resultText),
          isNull(taskRuns.lastError),
        )).returning({ id: taskRuns.id });
        if (!updated) {
          throw new Error("Protected Task cancellation product lost its TaskRun");
        }
        status = "written";
      }
      if (!await assertCurrentAuthority(tx)) {
        throw new CancellationAuthorityChanged();
      }
      return Object.freeze({ status });
    });
  } catch (error) {
    if (error instanceof CancellationAuthorityChanged) {
      return productRejected("authority_changed");
    }
    throw error;
  }
}
