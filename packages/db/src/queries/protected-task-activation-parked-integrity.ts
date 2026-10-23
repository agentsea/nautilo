import {
  and,
  asc,
  eq,
  getTableColumns,
  gt,
  inArray,
  notExists,
  sql,
} from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";

import type { DirectDatabase } from "../config/direct-database";
import { jobs } from "../schema/jobs";
import {
  protectedTaskRunOutputBindings,
  type ProtectedTaskRunOutputBinding,
} from "../schema/protected-task-run-output-bindings";
import {
  protectedTaskExecutionSegmentReceipts,
  type ProtectedTaskExecutionSegmentReceipt,
} from "../schema/protected-task-execution-segment-receipts";
import {
  protectedTaskWakeContinuationReceipts,
  type ProtectedTaskWakeContinuationReceipt,
} from "../schema/protected-task-wake-continuation-receipts";
import { taskRuns } from "../schema/task-runs";
import { tasks } from "../schema/tasks";
import { PROTECTED_TASK_RUN_PARK_RECEIPT_METADATA_KEY } from "./tasks";
import {
  protectedTaskRunOutputBindingId,
  protectedTaskRunWakeJobId,
  protectedTaskRunWakeOperationId,
} from "./protected-task-output-binding-identities";
import {
  canonicalProtectedTaskSemanticAuthorityRequirements,
  protectedTaskSemanticAuthorityRequirementsDigest,
} from "./protected-task-execution-receipts";

const CANONICAL_UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const OPAQUE = /^[A-Za-z0-9][A-Za-z0-9._:@/-]*$/u;
const CANONICAL_DIGEST = /^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/u;
const DIGEST_BYTES = 32;
export const PROTECTED_TASK_ACTIVATION_PARKED_PAGE_LIMIT = 64;

type Transaction = Parameters<Parameters<DirectDatabase["transaction"]>[0]>[0];

type ProtectedTaskActivationParkedExecutionIntegrityCandidate = Readonly<{
  kind: "execution";
  taskId: string;
  taskRunId: string;
  jobId: string;
  graphThreadId: string;
  executionSegment: number;
  acceptedPolicyRevision: number;
  transcript: Readonly<{
    contract: "protected_message_associations_v1";
    expectedAssociationCount: number;
    orderedDigest: Uint8Array;
  }>;
  checkpoint: Readonly<{
    contract: "encrypted_langgraph_v1";
    expectedCheckpointCount: number;
    checkpointOrderedDigest: Uint8Array;
    expectedBlobCount: number;
    blobOrderedDigest: Uint8Array;
    expectedPendingWriteCount: number;
    pendingWriteOrderedDigest: Uint8Array;
  }>;
}>;

type ProtectedTaskActivationParkedWakeIntegrityCandidate = Readonly<{
  kind: "wake_continuation";
  taskId: string;
  taskRunId: string;
  jobId: string;
  segment: number;
  acceptedPolicyRevision: number;
  checkpointThreadId: string;
  checkpoint: Readonly<{
    contract: "encrypted_langgraph_v1";
    expectedCheckpointCount: number;
    checkpointOrderedDigest: Uint8Array;
    expectedBlobCount: number;
    blobOrderedDigest: Uint8Array;
    expectedPendingWriteCount: number;
    pendingWriteOrderedDigest: Uint8Array;
  }>;
}>;

export type ProtectedTaskActivationParkedIntegrityCandidate =
  | ProtectedTaskActivationParkedExecutionIntegrityCandidate
  | ProtectedTaskActivationParkedWakeIntegrityCandidate;

export type ProtectedTaskActivationParkedIntegrityPage = Readonly<{
  candidates: readonly ProtectedTaskActivationParkedIntegrityCandidate[];
  nextCursor: string | null;
}>;

const projection = Object.freeze({
  task: Object.freeze({
    id: tasks.id,
    requestorId: tasks.requestorId,
    scheduleKind: tasks.scheduleKind,
    status: tasks.status,
    contentRepresentation: tasks.contentRepresentation,
    contentNamespaceId: tasks.contentNamespaceId,
    contentRevision: tasks.contentRevision,
    cryptoObjectId: tasks.cryptoObjectId,
    cryptoAccessRevision: tasks.cryptoAccessRevision,
    cryptoRequiredNamespaceFingerprint: tasks.cryptoRequiredNamespaceFingerprint,
    cryptoMappingState: tasks.cryptoMappingState,
  }),
  run: Object.freeze({
    id: taskRuns.id,
    taskId: taskRuns.taskId,
    jobId: taskRuns.jobId,
    graphThreadId: taskRuns.graphThreadId,
    status: taskRuns.status,
    resultText: taskRuns.resultText,
    completedAt: taskRuns.completedAt,
    lastError: taskRuns.lastError,
    resultRepresentation: taskRuns.resultRepresentation,
    resultContentNamespaceId: taskRuns.resultContentNamespaceId,
    resultRevision: taskRuns.resultRevision,
    resultCryptoObjectId: taskRuns.resultCryptoObjectId,
    resultCryptoAccessRevision: taskRuns.resultCryptoAccessRevision,
    resultCryptoRequiredNamespaceFingerprint:
      taskRuns.resultCryptoRequiredNamespaceFingerprint,
    resultCryptoMappingState: taskRuns.resultCryptoMappingState,
  }),
  job: Object.freeze({
    id: jobs.id,
    ownerId: jobs.ownerId,
    requestorId: jobs.requestorId,
    laneKey: jobs.laneKey,
    type: jobs.type,
    status: jobs.status,
    input: jobs.input,
    result: jobs.result,
    message: jobs.message,
    startedAt: jobs.startedAt,
    completedAt: jobs.completedAt,
    parkReceipt:
      sql<unknown>`${jobs.metadata} -> ${PROTECTED_TASK_RUN_PARK_RECEIPT_METADATA_KEY}`,
  }),
  segment: getTableColumns(protectedTaskExecutionSegmentReceipts),
});

const laterWakeReceipt = alias(
  protectedTaskWakeContinuationReceipts,
  "later_protected_task_wake_continuation_receipt",
);

const wakeProjection = Object.freeze({
  task: getTableColumns(tasks),
  run: getTableColumns(taskRuns),
  binding: getTableColumns(protectedTaskRunOutputBindings),
  job: getTableColumns(jobs),
  receipt: getTableColumns(protectedTaskWakeContinuationReceipts),
});

type CandidateRow = Readonly<{
  task: {
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
  };
  run: {
    id: string;
    taskId: string;
    jobId: string | null;
    graphThreadId: string;
    status: string;
    resultText: string | null;
    completedAt: Date | null;
    lastError: string | null;
    resultRepresentation: string;
    resultContentNamespaceId: string | null;
    resultRevision: number;
    resultCryptoObjectId: string | null;
    resultCryptoAccessRevision: number;
    resultCryptoRequiredNamespaceFingerprint: Uint8Array | null;
    resultCryptoMappingState: string;
  };
  job: {
    id: string;
    ownerId: string;
    requestorId: string;
    laneKey: string | null;
    type: string;
    status: string;
    input: unknown;
    result: unknown;
    message: string | null;
    startedAt: Date | null;
    completedAt: Date | null;
    parkReceipt: unknown;
  };
  segment: ProtectedTaskExecutionSegmentReceipt | null;
}>;

type WakeCandidateRow = Readonly<{
  task: typeof tasks.$inferSelect;
  run: typeof taskRuns.$inferSelect;
  binding: ProtectedTaskRunOutputBinding;
  job: typeof jobs.$inferSelect;
  receipt: ProtectedTaskWakeContinuationReceipt;
}>;

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  return Object.keys(value).sort().join(",") === [...expected].sort().join(",");
}

function positiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function nonnegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function digest(value: Uint8Array | null): value is Uint8Array {
  return value instanceof Uint8Array && value.length === DIGEST_BYTES;
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length
    && left.every((value, index) => value === right[index]);
}

function parseReference(value: unknown, row: CandidateRow) {
  if (!record(value)) return null;
  const optional = Object.hasOwn(value, "resumeAcceptanceId")
    ? "resumeAcceptanceId"
    : Object.hasOwn(value, "resumeContinuationFingerprint")
    ? "resumeContinuationFingerprint"
    : null;
  const keys = [
    "authorizationRequestId", "executionSegment", "inputObjectId", "kind",
    "policyRevision", "resultObjectId", "taskId", "taskRunId",
    ...(optional === null ? [] : [optional]),
  ];
  if (!exactKeys(value, keys)
    || value["kind"] !== "protected_task_run_v1"
    || value["taskId"] !== row.task.id
    || value["taskRunId"] !== row.run.id
    || typeof value["inputObjectId"] !== "string"
    || value["inputObjectId"] !== row.task.cryptoObjectId
    || typeof value["resultObjectId"] !== "string"
    || typeof value["authorizationRequestId"] !== "string"
    || !OPAQUE.test(value["authorizationRequestId"])
    || !positiveInteger(value["policyRevision"])
    || !positiveInteger(value["executionSegment"])
    || optional !== null && (typeof value[optional] !== "string"
      || !OPAQUE.test(value[optional]))) return null;
  return {
    executionSegment: value["executionSegment"],
    policyRevision: value["policyRevision"],
  };
}

function validInterrupts(value: unknown): boolean {
  if (!Array.isArray(value)) return false;
  const identities = new Set<string>();
  for (const item of value) {
    if (!record(item)) return false;
    const withRequest = Object.hasOwn(item, "requestId");
    if (!exactKeys(item, withRequest ? ["id", "kind", "requestId"] : ["id", "kind"])
      || typeof item["id"] !== "string" || !OPAQUE.test(item["id"])
      || !["approval", "prove_it", "identity", "await_reply", "additional_authority"]
        .includes(String(item["kind"]))
      || withRequest && (typeof item["requestId"] !== "string"
        || !OPAQUE.test(item["requestId"]))) return false;
    if (identities.has(item["id"])) return false;
    identities.add(item["id"]);
  }
  return true;
}

function validParkReceipt(
  value: unknown,
  row: CandidateRow,
  executionSegment: number,
): boolean {
  if (!record(value)) return false;
  const hasRouting = Object.hasOwn(value, "stableRoutingDigest");
  const keys = [
    "executionSegment", "generation", "graphThreadId", "interrupts", "jobId",
    "parkedAt", "taskId", "taskRunId", "version",
    ...(hasRouting ? ["stableRoutingDigest"] : []),
  ];
  const parkedAt = typeof value["parkedAt"] === "string"
    ? new Date(value["parkedAt"])
    : new Date(Number.NaN);
  return exactKeys(value, keys)
    && value["version"] === 1
    && value["taskId"] === row.task.id
    && value["taskRunId"] === row.run.id
    && value["jobId"] === row.job.id
    && value["graphThreadId"] === row.run.graphThreadId
    && value["executionSegment"] === executionSegment
    && nonnegativeInteger(value["generation"])
    && validInterrupts(value["interrupts"])
    && Number.isFinite(parkedAt.getTime())
    && parkedAt.toISOString() === value["parkedAt"]
    && row.job.completedAt?.getTime() === parkedAt.getTime()
    && (!hasRouting || typeof value["stableRoutingDigest"] === "string"
      && CANONICAL_DIGEST.test(value["stableRoutingDigest"]));
}

function parseCandidate(row: CandidateRow): ProtectedTaskActivationParkedIntegrityCandidate {
  const reference = parseReference(row.job.input, row);
  const segment = row.segment;
  const taskStatus = row.task.scheduleKind === "cron" ? "pending" : "awaiting";
  if (reference === null
    || row.task.status !== taskStatus
    || row.task.contentNamespaceId === null
    || !positiveInteger(row.task.contentRevision)
    || row.task.cryptoObjectId === null
    || !nonnegativeInteger(row.task.cryptoAccessRevision)
    || !digest(row.task.cryptoRequiredNamespaceFingerprint)
    || row.task.cryptoMappingState !== "verified"
    || row.run.taskId !== row.task.id
    || row.run.jobId !== row.job.id
    || row.run.status !== "awaiting"
    || row.run.resultText !== null
    || row.run.completedAt !== null
    || row.run.lastError !== null
    || row.run.resultRepresentation !== "ordinary"
    || row.run.resultContentNamespaceId !== null
    || row.run.resultRevision !== 0
    || row.run.resultCryptoObjectId !== null
    || row.run.resultCryptoAccessRevision !== 0
    || row.run.resultCryptoRequiredNamespaceFingerprint !== null
    || row.run.resultCryptoMappingState !== "unmapped"
    || row.job.ownerId !== row.task.requestorId
    || row.job.requestorId !== row.task.requestorId
    || row.job.laneKey !== `task:${row.task.id}`
    || row.job.type !== "foreground"
    || row.job.status !== "completed"
    || row.job.result !== null
    || row.job.message !== null
    || row.job.startedAt === null
    || row.job.completedAt === null
    || !validParkReceipt(row.job.parkReceipt, row, reference.executionSegment)
    || segment === null
    || segment.taskRunId !== row.run.id
    || segment.jobId !== row.job.id
    || segment.executionSegment !== reference.executionSegment
    || segment.route !== "native_langgraph_v1"
    || segment.transcriptContract !== "protected_message_associations_v1"
    || !nonnegativeInteger(segment.expectedTranscriptAssociationCount)
    || !digest(segment.transcriptAssociationDigest)
    || segment.checkpointContract !== "encrypted_langgraph_v1"
    || !positiveInteger(segment.expectedCheckpointCount)
    || !digest(segment.checkpointDigest)
    || !nonnegativeInteger(segment.expectedCheckpointBlobCount)
    || !digest(segment.checkpointBlobDigest)
    || !nonnegativeInteger(segment.expectedPendingWriteCount)
    || !digest(segment.pendingWriteDigest)
    || segment.sealedAt.getTime() !== row.job.completedAt.getTime()) {
    throw new Error("Protected Task parked activation proof is malformed");
  }
  return Object.freeze({
    kind: "execution" as const,
    taskId: row.task.id,
    taskRunId: row.run.id,
    jobId: row.job.id,
    graphThreadId: row.run.graphThreadId,
    executionSegment: reference.executionSegment,
    acceptedPolicyRevision: reference.policyRevision,
    transcript: Object.freeze({
      contract: segment.transcriptContract,
      expectedAssociationCount: segment.expectedTranscriptAssociationCount,
      orderedDigest: segment.transcriptAssociationDigest.slice(),
    }),
    checkpoint: Object.freeze({
      contract: segment.checkpointContract,
      expectedCheckpointCount: segment.expectedCheckpointCount,
      checkpointOrderedDigest: segment.checkpointDigest.slice(),
      expectedBlobCount: segment.expectedCheckpointBlobCount,
      blobOrderedDigest: segment.checkpointBlobDigest.slice(),
      expectedPendingWriteCount: segment.expectedPendingWriteCount,
      pendingWriteOrderedDigest: segment.pendingWriteDigest.slice(),
    }),
  });
}

function validWakeReference(value: unknown, row: WakeCandidateRow): boolean {
  if (!record(value)) return false;
  return exactKeys(value, [
    "bindingId", "kind", "resultObjectId", "taskId", "taskRunId",
    "wakeOperationId",
  ])
    && value["kind"] === "protected_task_delivery_v1"
    && value["taskId"] === row.task.id
    && value["taskRunId"] === row.run.id
    && value["bindingId"] === row.binding.bindingId
    && value["resultObjectId"] === row.binding.resultObjectId
    && value["wakeOperationId"] === row.binding.wakeOperationId;
}

function validWakeAuthority(row: WakeCandidateRow): boolean {
  const receipt = row.receipt;
  const retained = receipt.retainedSourceNamespaceIds;
  if (!Array.isArray(receipt.semanticAuthorityRequirements)
    || retained.length === 0
    || retained.some((id, index) => !CANONICAL_UUID.test(id)
      || index > 0 && retained[index - 1]! >= id)
    || retained.includes(receipt.destinationNamespaceId)
    || receipt.destinationNamespaceId === row.task.contentNamespaceId
    || !digest(receipt.requestDigest)
    || !digest(receipt.requiredAuthorityDigest)
    || !digest(receipt.sourceEnvelopeDigest)
    || !digest(receipt.destinationAuthorityDigest)) return false;
  try {
    const requirements = canonicalProtectedTaskSemanticAuthorityRequirements(
      receipt.semanticAuthorityRequirements,
    );
    const authorityDigest = protectedTaskSemanticAuthorityRequirementsDigest(
      requirements,
    );
    const valid = JSON.stringify(requirements)
        === JSON.stringify(receipt.semanticAuthorityRequirements)
      && sameBytes(authorityDigest, receipt.requiredAuthorityDigest)
      && requirements.length === retained.length + 1
      && retained.every(namespaceId => requirements.some(requirement =>
        requirement.namespaceId === namespaceId
        && requirement.operations.join(",") === "decrypt"))
      && requirements.some(requirement =>
        requirement.namespaceId === receipt.destinationNamespaceId
        && requirement.operations.join(",") === "encrypt");
    authorityDigest.fill(0);
    return valid;
  } catch {
    return false;
  }
}

function parseWakeCandidate(
  row: WakeCandidateRow,
): ProtectedTaskActivationParkedWakeIntegrityCandidate {
  const { task, run, binding, job, receipt } = row;
  const queued = job.status === "queued"
    && job.startedAt === null && job.completedAt === null;
  const running = job.status === "running"
    && job.startedAt !== null && job.completedAt === null;
  if (task.id !== receipt.taskId
    || task.ownerId !== task.requestorId
    || !["dual", "protected"].includes(task.contentRepresentation)
    || task.cryptoMappingState !== "verified"
    || !positiveInteger(task.contentRevision)
    || task.cryptoObjectId === null
    || task.contentNamespaceId === null
    || run.id !== receipt.taskRunId
    || run.taskId !== task.id
    || !["completed", "cancelled", "errored"].includes(run.status)
    || run.completedAt === null
    || run.resultRepresentation !== task.contentRepresentation
    || run.resultCryptoMappingState !== "verified"
    || !positiveInteger(run.resultRevision)
    || run.resultCryptoObjectId !== binding.resultObjectId
    || run.resultContentNamespaceId !== task.contentNamespaceId
    || binding.taskRunId !== run.id
    || binding.bindingId !== protectedTaskRunOutputBindingId(run.id)
    || binding.bindingId !== receipt.bindingId
    || binding.resultObjectId !== run.resultCryptoObjectId
    || binding.wakeOperationId !== protectedTaskRunWakeOperationId(run.id)
    || binding.wakeOperationId !== receipt.wakeOperationId
    || binding.wakeJobId !== job.id
    || binding.wakeScheduledAt === null
    || binding.completedAt === null
    || binding.destinationRoomId === null
    || binding.destinationNamespaceId === null
    || !["wake", "raw_and_wake"].includes(binding.deliveryMode)
    || job.id !== receipt.wakeJobId
    || job.id !== protectedTaskRunWakeJobId(run.id)
    || job.ownerId !== task.ownerId
    || job.requestorId !== task.requestorId
    || job.roomId !== binding.destinationRoomId
    || job.laneKey !== `room:${binding.destinationRoomId}`
    || job.type !== "foreground"
    || !queued && !running
    || job.result !== null
    || job.message !== null
    || !record(job.metadata)
    || Object.keys(job.metadata).length !== 0
    || !validWakeReference(job.input, row)
    || receipt.segment !== receipt.priorRecipientGeneration + 1
    || !positiveInteger(receipt.segment)
    || !nonnegativeInteger(receipt.priorRecipientGeneration)
    || receipt.wakeAuthorizationRequestId
      !== `task-wake-authorization:${job.id}`
    || !OPAQUE.test(receipt.additionalAuthorizationRequestId)
    || !OPAQUE.test(receipt.interruptId)
    || !OPAQUE.test(receipt.operationId)
    || !positiveInteger(receipt.initialPolicyRevision)
    || !positiveInteger(receipt.initialAgentAuthorizationRevision)
    || receipt.destinationRoomId === binding.destinationRoomId
      && receipt.destinationNamespaceId === binding.destinationNamespaceId
    || receipt.checkpointThreadId !== `protected-task-wake:${job.id}`
    || receipt.checkpointContract !== "encrypted_langgraph_v1"
    || !positiveInteger(receipt.expectedCheckpointCount)
    || !digest(receipt.checkpointOrderedDigest)
    || !nonnegativeInteger(receipt.expectedBlobCount)
    || !digest(receipt.blobOrderedDigest)
    || !nonnegativeInteger(receipt.expectedPendingWriteCount)
    || !digest(receipt.pendingWriteOrderedDigest)
    || !Number.isFinite(receipt.sealedAt.getTime())
    || !validWakeAuthority(row)) {
    throw new Error("Protected Task parked wake activation proof is malformed");
  }
  return Object.freeze({
    kind: "wake_continuation" as const,
    taskId: task.id,
    taskRunId: run.id,
    jobId: job.id,
    segment: receipt.segment,
    acceptedPolicyRevision: receipt.initialPolicyRevision,
    checkpointThreadId: receipt.checkpointThreadId,
    checkpoint: Object.freeze({
      contract: receipt.checkpointContract,
      expectedCheckpointCount: receipt.expectedCheckpointCount,
      checkpointOrderedDigest: receipt.checkpointOrderedDigest.slice(),
      expectedBlobCount: receipt.expectedBlobCount,
      blobOrderedDigest: receipt.blobOrderedDigest.slice(),
      expectedPendingWriteCount: receipt.expectedPendingWriteCount,
      pendingWriteOrderedDigest: receipt.pendingWriteOrderedDigest.slice(),
    }),
  });
}

/** Page every current linked park; malformed rows fail instead of disappearing. */
export async function listProtectedTaskActivationParkedIntegrityCandidates(
  transaction: Pick<Transaction, "select">,
  input: Readonly<{ limit?: number; afterJobId?: string }>,
): Promise<ProtectedTaskActivationParkedIntegrityPage> {
  const limit = input.limit ?? PROTECTED_TASK_ACTIVATION_PARKED_PAGE_LIMIT;
  if (!Number.isSafeInteger(limit) || limit < 1
    || limit > PROTECTED_TASK_ACTIVATION_PARKED_PAGE_LIMIT
    || input.afterJobId !== undefined && !CANONICAL_UUID.test(input.afterJobId)) {
    throw new TypeError("Protected Task parked activation cursor is malformed");
  }
  const executionRows = await transaction.select(projection)
    .from(taskRuns)
    .innerJoin(tasks, eq(tasks.id, taskRuns.taskId))
    .innerJoin(jobs, eq(jobs.id, taskRuns.jobId))
    .leftJoin(
      protectedTaskExecutionSegmentReceipts,
      and(
        eq(protectedTaskExecutionSegmentReceipts.taskRunId, taskRuns.id),
        eq(protectedTaskExecutionSegmentReceipts.jobId, jobs.id),
      ),
    )
    .where(and(
      inArray(tasks.contentRepresentation, ["dual", "protected"]),
      eq(taskRuns.status, "awaiting"),
      eq(jobs.status, "completed"),
      sql`${jobs.metadata} ? ${PROTECTED_TASK_RUN_PARK_RECEIPT_METADATA_KEY}`,
      ...(input.afterJobId === undefined ? [] : [gt(jobs.id, input.afterJobId)]),
    ))
    .orderBy(asc(jobs.id))
    .limit(limit);
  const wakeRows = await transaction.select(wakeProjection)
    .from(protectedTaskWakeContinuationReceipts)
    .innerJoin(tasks, eq(tasks.id, protectedTaskWakeContinuationReceipts.taskId))
    .innerJoin(
      taskRuns,
      eq(taskRuns.id, protectedTaskWakeContinuationReceipts.taskRunId),
    )
    .innerJoin(
      protectedTaskRunOutputBindings,
      eq(
        protectedTaskRunOutputBindings.taskRunId,
        protectedTaskWakeContinuationReceipts.taskRunId,
      ),
    )
    .innerJoin(jobs, eq(jobs.id, protectedTaskWakeContinuationReceipts.wakeJobId))
    .where(and(
      inArray(tasks.contentRepresentation, ["dual", "protected"]),
      notExists(transaction.select({ segment: laterWakeReceipt.segment })
        .from(laterWakeReceipt).where(and(
          eq(
            laterWakeReceipt.wakeJobId,
            protectedTaskWakeContinuationReceipts.wakeJobId,
          ),
          gt(
            laterWakeReceipt.segment,
            protectedTaskWakeContinuationReceipts.segment,
          ),
        ))),
      ...(input.afterJobId === undefined ? [] : [gt(
        protectedTaskWakeContinuationReceipts.wakeJobId,
        input.afterJobId,
      )]),
    ))
    .orderBy(asc(protectedTaskWakeContinuationReceipts.wakeJobId))
    .limit(limit);
  const candidates = [
    ...executionRows.map(row => parseCandidate(row as CandidateRow)),
    ...wakeRows.map(row => parseWakeCandidate(row as WakeCandidateRow)),
  ].sort((left, right) => left.jobId.localeCompare(right.jobId));
  for (let index = 1; index < candidates.length; index += 1) {
    if (candidates[index - 1]!.jobId === candidates[index]!.jobId) {
      throw new Error("Protected Task parked activation proof is duplicated");
    }
  }
  const pageCandidates = candidates.slice(0, limit);
  const hasMore = candidates.length > limit
    || executionRows.length === limit
    || wakeRows.length === limit;
  return Object.freeze({
    candidates: Object.freeze(pageCandidates),
    nextCursor: hasMore && pageCandidates.length > 0
      ? pageCandidates.at(-1)!.jobId
      : null,
  });
}
