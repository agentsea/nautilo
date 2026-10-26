import {
  and,
  asc,
  eq,
  gt,
  inArray,
  isNotNull,
  isNull,
  lte,
  or,
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

export type ProtectedTaskCancellationOutputDiscoveryCursor = Readonly<{
  throughTime: Date;
  terminalAt: Date;
  taskRunId: string;
}>;

export type ProtectedTaskCancellationOutputCandidate = Readonly<{
  taskId: string;
  taskRunId: string;
  jobId: string | null;
  terminalAt: Date;
  bindingState: "missing" | "execution" | "cancellation";
  resultState: "unmapped" | "mapped";
}>;

export type ProtectedTaskCancellationOutputDiscoveryPage = Readonly<{
  candidates: readonly ProtectedTaskCancellationOutputCandidate[];
  next: ProtectedTaskCancellationOutputDiscoveryCursor | null;
}>;

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

export type AuthorizeProtectedTaskCancellationPolicyRefresh = (
  context: Readonly<{
    transaction: ProtectedTaskCancellationProductTransaction;
    previousIntent: ProtectedTaskCancellationOutputIntent;
    nextIntent: ProtectedTaskCancellationOutputIntent;
  }>,
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

export type ProtectedTaskCancellationOutputSettlementProof = Readonly<{
  intent: ProtectedTaskCancellationOutputIntent;
  currentPolicyRevision: number;
  requesterHumanId: string;
  authorityFingerprint: Uint8Array;
  cryptoAccessRevision: number;
  requiredNamespaceFingerprint: Uint8Array;
}>;

export type SettleProtectedTaskCancellationOutputResult =
  | Readonly<{
      status: "completed" | "exact_replay";
      binding: ProtectedTaskRunOutputBinding;
    }>
  | Readonly<{
      status: "rejected";
      reason:
        | "authority_changed"
        | "conflict"
        | "not_found"
        | "not_ready";
    }>;

type SettleCancellationAuthorization = (
  proof: ProtectedTaskCancellationOutputSettlementProof,
) => Promise<boolean>;

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

function settlementRejected(
  reason: Extract<
    SettleProtectedTaskCancellationOutputResult,
    { status: "rejected" }
  >["reason"],
): SettleProtectedTaskCancellationOutputResult {
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
 * Discover a finite page of stopped protected occurrences whose fixed
 * cancellation result still needs publication. The time cutoff bounds one
 * traversal; the locked prepare owner remains responsible for exact identity,
 * authority settlement, and current-policy validation.
 */
export async function listProtectedTaskCancellationOutputCandidates(
  db: DirectDatabase,
  input: Readonly<{
    limit: number;
    throughTime: Date;
    cursor?: ProtectedTaskCancellationOutputDiscoveryCursor;
  }>,
): Promise<ProtectedTaskCancellationOutputDiscoveryPage> {
  if (
    !Number.isSafeInteger(input.limit)
    || input.limit < 0
    || !Number.isSafeInteger(input.limit + 1)
    || !(input.throughTime instanceof Date)
    || !Number.isFinite(input.throughTime.getTime())
  ) {
    throw new TypeError("Protected Task cancellation discovery page is malformed");
  }
  if (input.cursor && (
    !(input.cursor.throughTime instanceof Date)
    || !Number.isFinite(input.cursor.throughTime.getTime())
    || input.cursor.throughTime.getTime() !== input.throughTime.getTime()
    || !(input.cursor.terminalAt instanceof Date)
    || !Number.isFinite(input.cursor.terminalAt.getTime())
    || input.cursor.terminalAt.getTime() > input.throughTime.getTime()
    || !CANONICAL_UUID.test(input.cursor.taskRunId)
  )) {
    throw new TypeError("Protected Task cancellation discovery cursor is malformed");
  }
  const limit = input.limit;
  const throughTime = new Date(input.throughTime.getTime());
  const cursor = input.cursor
    ? Object.freeze({
        throughTime: new Date(input.cursor.throughTime.getTime()),
        terminalAt: new Date(input.cursor.terminalAt.getTime()),
        taskRunId: input.cursor.taskRunId,
      })
    : undefined;
  if (limit === 0) {
    return Object.freeze({ candidates: Object.freeze([]), next: null });
  }

  const binding = protectedTaskRunOutputBindings;
  const exactCancellationBinding = and(
    eq(binding.resultRevision, 2),
    sql`${binding.resultOperationId}
      = 'task-run-cancelled-result:' || ${taskRuns.id}::text`,
    eq(binding.resultTerminalAt, taskRuns.completedAt),
    isNull(binding.completedAt),
  );
  const noOutputReceipts = and(
    isNull(binding.resultAttachedAt),
    isNull(binding.messageId),
    isNull(binding.messagePublishedAt),
    isNull(binding.wakeJobId),
    isNull(binding.wakeScheduledAt),
  );
  const unfinishedUnmappedBinding = or(
    isNull(binding.taskRunId),
    and(
      sql`${binding.bindingId} = 'task-run-output:' || ${taskRuns.id}::text`,
      gt(binding.acceptedPolicyRevision, 0),
      noOutputReceipts,
      or(
        and(
          eq(binding.resultRevision, 1),
          sql`${binding.resultOperationId}
            = 'task-run-result:' || ${taskRuns.id}::text`,
          isNull(binding.resultTerminalAt),
        ),
        exactCancellationBinding,
      ),
    ),
  );
  const pristineUnmappedResult = and(
    isNull(taskRuns.resultText),
    isNull(taskRuns.lastError),
    eq(taskRuns.resultRepresentation, "ordinary"),
    isNull(taskRuns.resultContentNamespaceId),
    eq(taskRuns.resultRevision, 0),
    isNull(taskRuns.resultCryptoObjectId),
    eq(taskRuns.resultCryptoAccessRevision, 0),
    isNull(taskRuns.resultCryptoRequiredNamespaceFingerprint),
    eq(taskRuns.resultCryptoMappingState, "unmapped"),
    unfinishedUnmappedBinding,
  );
  const mappedCancellationResult = and(
    eq(taskRuns.resultRepresentation, tasks.contentRepresentation),
    eq(taskRuns.resultContentNamespaceId, tasks.contentNamespaceId),
    eq(taskRuns.resultRevision, 2),
    isNotNull(taskRuns.resultCryptoObjectId),
    eq(taskRuns.resultCryptoObjectId, binding.resultObjectId),
    isNotNull(taskRuns.resultCryptoRequiredNamespaceFingerprint),
    sql`octet_length(${taskRuns.resultCryptoRequiredNamespaceFingerprint}) = 32`,
    eq(taskRuns.resultCryptoMappingState, "verified"),
    isNull(taskRuns.lastError),
    or(
      and(
        eq(tasks.contentRepresentation, "protected"),
        isNull(taskRuns.resultText),
      ),
      and(
        eq(tasks.contentRepresentation, "dual"),
        eq(taskRuns.resultText, PROTECTED_TASK_CANCELLED_RESULT),
      ),
    ),
    sql`${binding.bindingId} = 'task-run-output:' || ${taskRuns.id}::text`,
    gt(binding.acceptedPolicyRevision, 0),
    exactCancellationBinding,
  );
  const rows = await db.select({
    taskId: tasks.id,
    taskRunId: taskRuns.id,
    jobId: taskRuns.jobId,
    terminalAt: taskRuns.completedAt,
    bindingRevision: binding.resultRevision,
    resultRevision: taskRuns.resultRevision,
  }).from(tasks)
    .innerJoin(taskRuns, eq(taskRuns.taskId, tasks.id))
    .leftJoin(binding, eq(binding.taskRunId, taskRuns.id))
    .where(and(
      eq(tasks.status, "cancelled"),
      eq(taskRuns.status, "cancelled"),
      isNotNull(tasks.cancelledAt),
      isNotNull(taskRuns.completedAt),
      eq(taskRuns.completedAt, tasks.cancelledAt),
      lte(taskRuns.completedAt, throughTime),
      eq(tasks.ownerId, tasks.requestorId),
      inArray(tasks.contentRepresentation, ["protected", "dual"]),
      isNotNull(tasks.contentNamespaceId),
      isNotNull(tasks.cryptoObjectId),
      isNotNull(tasks.cryptoRequiredNamespaceFingerprint),
      sql`octet_length(${tasks.cryptoRequiredNamespaceFingerprint}) = 32`,
      eq(tasks.cryptoMappingState, "verified"),
      isNull(tasks.lastError),
      or(
        eq(tasks.contentRepresentation, "dual"),
        and(
          eq(tasks.contentRepresentation, "protected"),
          eq(tasks.prompt, ""),
          isNull(tasks.expectedOutput),
        ),
      ),
      or(pristineUnmappedResult, mappedCancellationResult),
      cursor ? or(
        gt(taskRuns.completedAt, cursor.terminalAt),
        and(
          eq(taskRuns.completedAt, cursor.terminalAt),
          gt(taskRuns.id, cursor.taskRunId),
        ),
      ) : undefined,
    ))
    .orderBy(asc(taskRuns.completedAt), asc(taskRuns.id))
    .limit(limit + 1);

  const hasMore = rows.length > limit;
  const pageRows = rows.slice(0, limit);
  const candidates = Object.freeze(pageRows.map((row) => {
    if (row.terminalAt === null) throw new TypeError("Cancelled TaskRun has no terminal time");
    return Object.freeze({
    taskId: row.taskId,
    taskRunId: row.taskRunId,
    jobId: row.jobId,
    terminalAt: new Date(row.terminalAt.getTime()),
    bindingState: row.bindingRevision === null
      ? "missing" as const
      : row.bindingRevision === 1
        ? "execution" as const
        : "cancellation" as const,
    resultState: row.resultRevision === 0
      ? "unmapped" as const
      : "mapped" as const,
    });
  }));
  const last = candidates.at(-1);
  return Object.freeze({
    candidates,
    next: hasMore && last
      ? Object.freeze({
          throughTime: new Date(throughTime.getTime()),
          terminalAt: new Date(last.terminalAt.getTime()),
          taskRunId: last.taskRunId,
        })
      : null,
  });
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
  authorizePolicyRefresh?: AuthorizeProtectedTaskCancellationPolicyRefresh,
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
    const cancellationIntentAtBindingPolicy = binding !== undefined
      && binding.resultRevision === 2
      && Number.isSafeInteger(binding.acceptedPolicyRevision)
      && binding.acceptedPolicyRevision > 0
      ? cancellationIntent(task, run, binding.acceptedPolicyRevision)
      : null;
    const exactCancellationCoordinate = binding !== undefined
      && binding.resultRevision === 2
      && binding.resultOperationId === cancelledOperationId
      && binding.resultObjectId === cancelledObjectId
      && binding.resultTerminalAt?.getTime() === run.completedAt!.getTime();
    const exactCancellationIntent = exactCancellationCoordinate
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
      const monotonicPolicyRefresh = exactCancellationCoordinate
        && cancellationIntentAtBindingPolicy !== null
        && binding.acceptedPolicyRevision < policy.revision;
      if (!monotonicPolicyRefresh) return rejected("conflict");
      if (authorizePolicyRefresh === undefined) return rejected("not_ready");
      const ledgerRows = await tx.select({
        taskRunId: taskRunResultCryptoRevisions.taskRunId,
      }).from(taskRunResultCryptoRevisions).where(or(
        and(
          eq(taskRunResultCryptoRevisions.taskId, task.id),
          eq(taskRunResultCryptoRevisions.taskRunId, run.id),
          eq(taskRunResultCryptoRevisions.resultRevision, 2),
        ),
        eq(taskRunResultCryptoRevisions.operationId, cancelledOperationId),
      )).limit(2);
      if (ledgerRows.length !== 0) return rejected("conflict");
      if (!await authorizePolicyRefresh(Object.freeze({
        transaction: tx,
        previousIntent: cancellationIntentAtBindingPolicy,
        nextIntent: intent,
      }))) return rejected("not_ready");
      const [refreshed] = await tx.update(protectedTaskRunOutputBindings).set({
        acceptedPolicyRevision: policy.revision,
      }).where(and(
        eq(protectedTaskRunOutputBindings.taskRunId, run.id),
        eq(protectedTaskRunOutputBindings.bindingId, binding.bindingId),
        eq(protectedTaskRunOutputBindings.resultRevision, 2),
        eq(protectedTaskRunOutputBindings.resultOperationId, cancelledOperationId),
        eq(protectedTaskRunOutputBindings.resultObjectId, cancelledObjectId),
        eq(protectedTaskRunOutputBindings.acceptedPolicyRevision,
          binding.acceptedPolicyRevision),
        eq(protectedTaskRunOutputBindings.resultTerminalAt, run.completedAt!),
        isNull(protectedTaskRunOutputBindings.resultAttachedAt),
        isNull(protectedTaskRunOutputBindings.messageId),
        isNull(protectedTaskRunOutputBindings.messagePublishedAt),
        isNull(protectedTaskRunOutputBindings.wakeJobId),
        isNull(protectedTaskRunOutputBindings.wakeScheduledAt),
        isNull(protectedTaskRunOutputBindings.completedAt),
      )).returning();
      if (!refreshed) {
        throw new Error("Protected Task cancellation policy refresh lost its locked binding");
      }
      return Object.freeze({
        status: "prepared" as const,
        binding: refreshed,
        intent,
        previousAuthority,
      });
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
  db: Pick<DirectDatabase, "transaction">,
  input: Readonly<{
    intent: ProtectedTaskCancellationOutputIntent;
    prepared: ProtectedTaskCancellationProductPrepared;
    requestDigest: Uint8Array;
    currentPolicyRevision?: number;
  }>,
  assertCurrentAuthority: AssertCurrentCancellationAuthority,
): Promise<PublishProtectedTaskCancellationProductResult> {
  const requestedIntent = input.intent;
  const requestedPrepared = input.prepared;
  const requestedDigest = input.requestDigest;
  const requestedCurrentPolicyRevision = input.currentPolicyRevision
    ?? requestedIntent.policyRevision;
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
    || !Number.isSafeInteger(requestedCurrentPolicyRevision)
    || requestedCurrentPolicyRevision < requestedIntent.policyRevision
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
  const currentPolicyRevision = requestedCurrentPolicyRevision;

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
        || policy.revision !== currentPolicyRevision
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

function exactCancellationSettlementReceipts(
  binding: ProtectedTaskRunOutputBinding,
  terminalAt: Date,
): boolean {
  const resultAttachedAt = binding.resultAttachedAt?.getTime() ?? null;
  const messagePublishedAt = binding.messagePublishedAt?.getTime() ?? null;
  const wakeScheduledAt = binding.wakeScheduledAt?.getTime() ?? null;
  const completedAt = binding.completedAt?.getTime() ?? null;
  const terminalTime = terminalAt.getTime();
  const hasMessage = binding.messageId !== null
    && messagePublishedAt !== null;
  const hasWake = binding.wakeJobId !== null
    && wakeScheduledAt !== null;
  if (
    (binding.messageId === null) !== (messagePublishedAt === null)
    || (binding.wakeJobId === null) !== (wakeScheduledAt === null)
    || resultAttachedAt !== null && resultAttachedAt !== terminalTime
    || binding.acceptedAt.getTime() > terminalTime
    || messagePublishedAt !== null && messagePublishedAt < terminalTime
    || wakeScheduledAt !== null && wakeScheduledAt < terminalTime
    || resultAttachedAt === null
      && (hasMessage || hasWake || completedAt !== null)
  ) return false;

  switch (binding.deliveryMode) {
    case "none":
      return !hasMessage && !hasWake
        && (completedAt === null || completedAt === terminalTime);
    case "raw":
      return !hasWake
        && (hasMessage
          ? completedAt === messagePublishedAt
          : completedAt === null);
    case "wake":
      return !hasMessage
        && (hasWake
          ? completedAt === wakeScheduledAt
          : completedAt === null);
    case "raw_and_wake":
      return (!hasWake || hasMessage)
        && (hasWake
          ? completedAt === wakeScheduledAt
            && messagePublishedAt !== null
            && wakeScheduledAt >= messagePublishedAt
          : completedAt === null);
  }
}

/**
 * Close authorization settlement for an exact mapped cancellation result.
 * The held callback owns the durable authorization CAS; this transaction owns
 * only the result attachment and no-delivery completion receipts.
 */
export async function settleProtectedTaskCancellationOutput(
  db: Pick<DirectDatabase, "transaction">,
  input: Readonly<{
    taskId: string;
    taskRunId: string;
    currentPolicyRevision?: number;
  }>,
  settleAuthorization: SettleCancellationAuthorization,
): Promise<SettleProtectedTaskCancellationOutputResult> {
  if (
    !CANONICAL_UUID.test(input.taskId)
    || !CANONICAL_UUID.test(input.taskRunId)
    || input.currentPolicyRevision !== undefined && (
      !Number.isSafeInteger(input.currentPolicyRevision)
      || input.currentPolicyRevision < 1
    )
    || typeof settleAuthorization !== "function"
  ) throw new TypeError("Protected Task cancellation settlement is malformed");

  return db.transaction(async (tx) => {
    const [policy] = await tx.select().from(encryptionTransitionPolicy)
      .where(eq(encryptionTransitionPolicy.id, "server"))
      .limit(1).for("share");
    const [task] = await tx.select(cancellationTaskProjection).from(tasks)
      .where(eq(tasks.id, input.taskId)).limit(1).for("update");
    if (!task) return settlementRejected("not_found");
    const [run] = await tx.select(cancellationRunProjection).from(taskRuns)
      .where(and(
        eq(taskRuns.id, input.taskRunId),
        eq(taskRuns.taskId, input.taskId),
      )).limit(1).for("update");
    if (!run) return settlementRejected("not_found");
    const [binding] = await tx.select().from(protectedTaskRunOutputBindings)
      .where(eq(protectedTaskRunOutputBindings.taskRunId, input.taskRunId))
      .limit(1).for("update");
    if (!binding) return settlementRejected("not_found");

    if (
      task.status !== "cancelled"
      || task.cancelledAt === null
      || run.status !== "cancelled"
      || run.completedAt === null
      || run.completedAt.getTime() !== task.cancelledAt.getTime()
      || (task.contentRepresentation !== "protected"
        && task.contentRepresentation !== "dual")
      || task.contentNamespaceId === null
      || binding.resultRevision !== 2
      || binding.acceptedPolicyRevision < 1
    ) return settlementRejected("conflict");

    const intent = cancellationIntent(
      task,
      run,
      binding.acceptedPolicyRevision,
    );
    const currentPolicyRevision = input.currentPolicyRevision
      ?? intent.policyRevision;
    if (
      !policy
      || currentPolicyRevision < intent.policyRevision
      || policy.revision !== currentPolicyRevision
      || policy.mode !== (intent.representation === "dual"
        ? "shadow_encryption"
        : "encrypted_only")
    ) return settlementRejected("authority_changed");

    const [definition] = await tx.select(cancellationDefinitionProjection)
      .from(taskDefinitionCryptoRevisions)
      .where(and(
        eq(taskDefinitionCryptoRevisions.taskId, input.taskId),
        eq(
          taskDefinitionCryptoRevisions.contentRevision,
          task.contentRevision,
        ),
      )).limit(1).for("share");
    const [reservation] = await tx.select(cancellationResultProjection)
      .from(taskRunResultCryptoRevisions)
      .where(and(
        eq(taskRunResultCryptoRevisions.taskId, input.taskId),
        eq(taskRunResultCryptoRevisions.taskRunId, input.taskRunId),
        eq(taskRunResultCryptoRevisions.resultRevision, 2),
        eq(
          taskRunResultCryptoRevisions.operationId,
          intent.resultOperationId,
        ),
      )).limit(1).for("update");
    if (!reservation) return settlementRejected("not_ready");
    const [requesterHuman] = await tx.select({ id: actors.id }).from(actors)
      .where(and(
        eq(actors.id, reservation.requesterHumanId),
        eq(actors.kind, "user"),
        eq(actors.ownerId, intent.requesterUserId),
      )).limit(1).for("share");

    const exactReservation = reservation.taskId === intent.taskId
      && reservation.taskRunId === intent.taskRunId
      && reservation.contentNamespaceId === intent.contentNamespaceId
      && reservation.anchorNamespaceId === intent.contentNamespaceId
      && reservation.resultRevision === 2
      && reservation.operationId === intent.resultOperationId
      && reservation.requestDigest.length === 32
      && reservation.authorityFingerprint.length === 32
      && reservation.cryptoObjectId === intent.resultObjectId
      && reservation.representation === intent.representation
      && reservation.payloadVersion === 1
      && reservation.cryptoAccessRevision === 0
      && task.cryptoRequiredNamespaceFingerprint !== null
      && sameBytes(
        reservation.requiredNamespaceFingerprint,
        task.cryptoRequiredNamespaceFingerprint,
      )
      && reservation.completion === "complete"
      && reservation.disposition === "mapped"
      && reservation.failureCode === null;
    const destinationNamespaceId = task.callingRoomId === null
      ? null
      : binding.destinationNamespaceId;
    if (
      !exactCancellationDefinition(task, definition, intent)
      || !exactCancellationBinding(binding, intent)
      || !exactReservation
      || requesterHuman === undefined
      || cancellationRunState(run, reservation, intent) !== "mapped"
      || !exactDestination(task, binding, destinationNamespaceId)
      || task.callingRoomId !== null && destinationNamespaceId === null
      || !exactCancellationSettlementReceipts(binding, intent.terminalAt)
    ) return settlementRejected("conflict");

    const proof = Object.freeze({
      intent: Object.freeze({
        ...intent,
        terminalAt: new Date(intent.terminalAt.getTime()),
      }),
      currentPolicyRevision: policy.revision,
      requesterHumanId: reservation.requesterHumanId,
      authorityFingerprint: reservation.authorityFingerprint.slice(),
      cryptoAccessRevision: reservation.cryptoAccessRevision,
      requiredNamespaceFingerprint:
        reservation.requiredNamespaceFingerprint.slice(),
    });
    if (!await settleAuthorization(proof)) {
      return settlementRejected("not_ready");
    }

    const attachResult = binding.resultAttachedAt === null;
    const completeNoDelivery = binding.deliveryMode === "none"
      && binding.completedAt === null;
    if (!attachResult && !completeNoDelivery) {
      return Object.freeze({ status: "exact_replay" as const, binding });
    }
    const [updated] = await tx.update(protectedTaskRunOutputBindings).set({
      ...(attachResult
        ? { resultAttachedAt: new Date(intent.terminalAt.getTime()) }
        : {}),
      ...(completeNoDelivery
        ? { completedAt: new Date(intent.terminalAt.getTime()) }
        : {}),
    }).where(and(
      eq(protectedTaskRunOutputBindings.taskRunId, intent.taskRunId),
      eq(protectedTaskRunOutputBindings.bindingId, binding.bindingId),
      eq(protectedTaskRunOutputBindings.resultRevision, 2),
      eq(
        protectedTaskRunOutputBindings.resultOperationId,
        intent.resultOperationId,
      ),
      eq(
        protectedTaskRunOutputBindings.resultObjectId,
        intent.resultObjectId,
      ),
      eq(
        protectedTaskRunOutputBindings.acceptedPolicyRevision,
        intent.policyRevision,
      ),
      eq(protectedTaskRunOutputBindings.resultTerminalAt, intent.terminalAt),
      attachResult
        ? isNull(protectedTaskRunOutputBindings.resultAttachedAt)
        : eq(
            protectedTaskRunOutputBindings.resultAttachedAt,
            binding.resultAttachedAt!,
          ),
      completeNoDelivery
        ? isNull(protectedTaskRunOutputBindings.completedAt)
        : binding.completedAt === null
          ? isNull(protectedTaskRunOutputBindings.completedAt)
          : eq(
              protectedTaskRunOutputBindings.completedAt,
              binding.completedAt,
            ),
    )).returning();
    if (!updated) {
      throw new Error("Protected Task cancellation settlement lost its binding");
    }
    return Object.freeze({ status: "completed" as const, binding: updated });
  });
}
