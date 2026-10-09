import type { ProtectedTaskContinuationReceipt } from
  "../schema/protected-task-continuation-receipts";
import type { ProtectedTaskExecutionSegmentReceipt } from
  "../schema/protected-task-execution-segment-receipts";
import {
  exactParkedProtectedTaskAdditionalAuthorityProof,
  prepareParkedProtectedTaskAdditionalAuthorityStart,
} from "./protected-task-parked-start-proof";
import {
  type ProtectedTaskDurableJobReference,
  type StartParkedProtectedTaskRunAdditionalAuthoritySegmentInput,
} from "./tasks";

type CandidateTask = Readonly<{
  id: string;
  requestorId: string;
  scheduleKind: string;
  status: string;
  contentRepresentation: string;
  contentNamespaceId: string | null;
  contentRevision: number;
  cryptoObjectId: string | null;
  cryptoAccessRevision: number;
  cryptoRequiredNamespaceFingerprint: Uint8Array | null;
  cryptoMappingState: string;
  contentPristine: boolean;
}>;

type CandidateRun = Readonly<{
  id: string;
  taskId: string;
  jobId: string | null;
  graphThreadId: string;
  status: string;
  modelId: string | null;
  fundingPristine: boolean;
  pristine: boolean;
}>;

type CandidateJob = Readonly<{
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

type CandidatePriorJob = CandidateJob & Readonly<{
  parkReceipt: unknown;
}>;

export type ParkedProtectedTaskRecoveryCandidateRow = Readonly<{
  task: CandidateTask;
  run: CandidateRun;
  nextJob: CandidateJob;
  priorJob: CandidatePriorJob | null;
  segment: ProtectedTaskExecutionSegmentReceipt | null;
  continuation: ProtectedTaskContinuationReceipt | null;
}>;

export type ProjectedParkedProtectedTaskRecoveryCandidate = Readonly<{
  input: StartParkedProtectedTaskRunAdditionalAuthoritySegmentInput;
  lifecycle: "linked" | "parked";
}>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function date(value: unknown): Date | null {
  if (value instanceof Date && Number.isFinite(value.getTime())) {
    return new Date(value.getTime());
  }
  if (typeof value !== "string") return null;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed : null;
}

/**
 * Reconstruct one restart input solely from product metadata and immutable
 * receipts. The canonical parked-start parser remains the shape owner, and
 * the exact proof comparator binds the reconstructed input back to those rows.
 */
export function projectParkedProtectedTaskRecoveryCandidate(
  row: ParkedProtectedTaskRecoveryCandidateRow,
): ProjectedParkedProtectedTaskRecoveryCandidate | null {
  const { task, run, nextJob, priorJob, segment, continuation } = row;
  if (priorJob === null || segment === null || continuation === null
    || !isRecord(nextJob.reference) || !isRecord(priorJob.reference)
    || !isRecord(priorJob.parkReceipt)
    || (nextJob.status !== "queued" && nextJob.status !== "cancelled")
    || nextJob.startedAt !== null
    || (nextJob.status === "queued"
      ? nextJob.completedAt !== null
      : nextJob.completedAt === null)
    || !nextJob.pristine
    || nextJob.ownerId !== task.requestorId
    || nextJob.requestorId !== task.requestorId
    || nextJob.laneKey !== `task:${task.id}`
    || nextJob.type !== "foreground"
    || priorJob.ownerId !== task.requestorId
    || priorJob.requestorId !== task.requestorId
    || priorJob.laneKey !== `task:${task.id}`
    || priorJob.type !== "foreground"
    || priorJob.status !== "completed"
    || priorJob.startedAt === null || priorJob.completedAt === null
    || !priorJob.pristine
    || task.contentRepresentation !== "dual"
      && task.contentRepresentation !== "protected"
    || task.contentNamespaceId === null || task.cryptoObjectId === null
    || task.cryptoRequiredNamespaceFingerprint === null
    || task.cryptoMappingState !== "verified" || !task.contentPristine
    || run.taskId !== task.id
    || !run.fundingPristine || !run.pristine) return null;

  const nextReference = nextJob.reference as ProtectedTaskDurableJobReference;
  const priorReference = priorJob.reference as ProtectedTaskDurableJobReference;
  const linked = run.status === "running" && run.jobId === nextJob.id;
  const parked = run.status === "awaiting" && run.jobId === priorJob.id;
  const expectedTaskStatus = task.scheduleKind === "cron"
    ? "pending"
    : linked ? "running" : "awaiting";
  const parkedAt = date(priorJob.parkReceipt["parkedAt"]);
  if ((!linked && !parked) || task.status !== expectedTaskStatus
    || parkedAt === null
    || priorJob.completedAt.getTime() !== parkedAt.getTime()
    || segment.taskRunId !== run.id
    || continuation.taskRunId !== run.id
    || segment.jobId !== priorJob.id
    || continuation.jobId !== priorJob.id
    || segment.executionSegment !== nextReference.executionSegment - 1
    || continuation.executionSegment !== segment.executionSegment
    || segment.route !== "native_langgraph_v1"
    || segment.checkpointContract !== "encrypted_langgraph_v1"
    || segment.checkpointDigest === null
    || segment.checkpointBlobDigest === null
    || segment.pendingWriteDigest === null
    || continuation.kind !== "pre_effect_interrupt_v1"
    || continuation.reason !== "additional_authority"
    || continuation.effectDisposition !== "not_started_v1"
    || continuation.interruptId === null
    || continuation.operationId === null
    || continuation.requestDigest === null
    || continuation.requiredAuthorityDigest === null
    || continuation.stableRoutingDigest === null
    || continuation.semanticAuthorityRequirements === null) return null;

  const raw: StartParkedProtectedTaskRunAdditionalAuthoritySegmentInput = {
    taskId: task.id,
    taskRunId: run.id,
    graphThreadId: run.graphThreadId,
    priorJobId: priorJob.id,
    jobId: nextJob.id,
    generation: priorJob.parkReceipt["generation"] as number,
    interrupts: priorJob.parkReceipt["interrupts"] as
      StartParkedProtectedTaskRunAdditionalAuthoritySegmentInput["interrupts"],
    parkedAt,
    contentRepresentation: task.contentRepresentation,
    contentNamespaceId: task.contentNamespaceId,
    contentRevision: task.contentRevision,
    cryptoObjectId: task.cryptoObjectId,
    cryptoAccessRevision: task.cryptoAccessRevision,
    cryptoRequiredNamespaceFingerprint:
      task.cryptoRequiredNamespaceFingerprint.slice(),
    priorJobReference: priorReference,
    jobReference: nextReference,
    checkpointManifest: {
      contract: "encrypted_langgraph_v1",
      expectedCheckpointCount: segment.expectedCheckpointCount,
      checkpointOrderedDigest: segment.checkpointDigest.slice(),
      expectedBlobCount: segment.expectedCheckpointBlobCount,
      blobOrderedDigest: segment.checkpointBlobDigest.slice(),
      expectedPendingWriteCount: segment.expectedPendingWriteCount,
      pendingWriteOrderedDigest: segment.pendingWriteDigest.slice(),
    },
    continuation: {
      interruptId: continuation.interruptId,
      operationId: continuation.operationId,
      requestDigest: continuation.requestDigest.slice(),
      requiredAuthorityDigest: continuation.requiredAuthorityDigest.slice(),
      stableRoutingDigest: continuation.stableRoutingDigest.slice(),
      semanticAuthorityRequirements:
        continuation.semanticAuthorityRequirements,
    },
  };
  try {
    const prepared = prepareParkedProtectedTaskAdditionalAuthorityStart(raw);
    if (!exactParkedProtectedTaskAdditionalAuthorityProof(
      { segment, continuation },
      priorJob.parkReceipt,
      prepared,
      true,
    )) return null;
    return Object.freeze({
      lifecycle: linked ? "linked" : "parked",
      input: Object.freeze({
        ...raw,
        interrupts: prepared.receipt.interrupts,
        parkedAt: prepared.parkedAt,
        cryptoRequiredNamespaceFingerprint:
          prepared.cryptoRequiredNamespaceFingerprint,
        priorJobReference: prepared.priorJobReference,
        jobReference: prepared.jobReference,
        checkpointManifest: prepared.checkpointManifest,
        continuation: prepared.continuation,
      }),
    });
  } catch {
    return null;
  }
}
