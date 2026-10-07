import { createHash } from "node:crypto";
import { and, asc, eq, or } from "drizzle-orm";

import type { DirectDatabase } from "../config/direct-database";
import { jobs, type Job } from "../schema/jobs";
import {
  protectedTaskContinuationReceipts,
  type ProtectedTaskContinuationReceipt,
} from "../schema/protected-task-continuation-receipts";
import {
  protectedTaskExecutionSegmentReceipts,
  type ProtectedTaskCheckpointReceiptContract,
  type ProtectedTaskExecutionRoute,
  type ProtectedTaskExecutionSegmentReceipt,
  type ProtectedTaskTranscriptReceiptContract,
} from "../schema/protected-task-execution-segment-receipts";
import { taskRuns, type TaskRun } from "../schema/task-runs";
import { tasks, type Task } from "../schema/tasks";

const CANONICAL_UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const OPAQUE_COORDINATE = /^[A-Za-z0-9][A-Za-z0-9._:@/-]*$/u;
const POSTGRES_INTEGER_MAX = 2_147_483_647;
const DIGEST_BYTES = 32;

export const PROTECTED_TASK_EXECUTION_ROUTES = Object.freeze([
  "native_langgraph_v1",
  "hermes_acp_v1",
  "opencode_acp_v1",
  "codex_acp_v1",
  "claude_code_acp_v1",
] as const satisfies readonly ProtectedTaskExecutionRoute[]);

export type ProtectedTaskTranscriptManifestReceipt = Readonly<{
  contract: ProtectedTaskTranscriptReceiptContract;
  expectedAssociationCount: number;
  orderedDigest: Uint8Array | null;
}>;

export type ProtectedTaskCheckpointManifestReceipt = Readonly<{
  contract: ProtectedTaskCheckpointReceiptContract;
  expectedCheckpointCount: number;
  checkpointOrderedDigest: Uint8Array | null;
  expectedBlobCount: number;
  blobOrderedDigest: Uint8Array | null;
  expectedPendingWriteCount: number;
  pendingWriteOrderedDigest: Uint8Array | null;
}>;

export type SealProtectedTaskExecutionSegmentReceiptInput = Readonly<{
  taskId: string;
  taskRunId: string;
  jobId: string;
  executionSegment: number;
  route: ProtectedTaskExecutionRoute;
  transcript: ProtectedTaskTranscriptManifestReceipt;
  checkpoint: ProtectedTaskCheckpointManifestReceipt;
  sealedAt: Date;
}>;

export type SealProtectedTaskExecutionSegmentReceiptResult =
  | Readonly<{
      status: "sealed" | "exact_replay";
      receipt: ProtectedTaskExecutionSegmentReceipt;
    }>
  | Readonly<{
      status: "rejected";
      reason:
        | "conflict"
        | "not_found"
        | "not_protected"
        | "segment_gap"
        | "stale_job";
    }>;

type ContinuationIdentity = Readonly<{
  taskId: string;
  taskRunId: string;
  jobId: string;
  executionSegment: number;
  sealedAt: Date;
}>;

export type SealProtectedTaskContinuationReceiptInput =
  | (ContinuationIdentity & Readonly<{
      kind: "checkpoint_safe_v1";
      reason: "manual_pause" | "time_limit" | "grant_refresh";
      effectDisposition: "none_v1";
    }>)
  | (ContinuationIdentity & Readonly<{
      kind: "pre_effect_interrupt_v1";
      reason: "grant_refresh" | "additional_authority";
      effectDisposition: "not_started_v1";
      interruptId: string;
      operationId: string;
      requestDigest: Uint8Array;
      requiredAuthorityDigest: Uint8Array;
    }>);

export type SealProtectedTaskContinuationReceiptResult =
  | Readonly<{
      status: "sealed" | "exact_replay";
      receipt: ProtectedTaskContinuationReceipt;
    }>
  | Readonly<{
      status: "rejected";
      reason:
        | "conflict"
        | "missing_segment"
        | "not_found"
        | "not_protected"
        | "stale_job";
    }>;

export type ProtectedTaskExecutionContinuationProof = Readonly<{
  segment: ProtectedTaskExecutionSegmentReceipt;
  continuation: ProtectedTaskContinuationReceipt;
}>;

type ReceiptTx = Pick<DirectDatabase, "insert" | "select">;

type CurrentIdentityRejection = Extract<
  SealProtectedTaskExecutionSegmentReceiptResult,
  { status: "rejected" }
>["reason"];

function validCount(value: number): boolean {
  return Number.isSafeInteger(value)
    && value >= 0
    && value <= POSTGRES_INTEGER_MAX;
}

function validSegment(value: number): boolean {
  return validCount(value) && value > 0;
}

function validDigest(value: Uint8Array | null): value is Uint8Array {
  return value instanceof Uint8Array && value.length === DIGEST_BYTES;
}

/** Canonical immutable identity for one pre-effect authority continuation. */
export function protectedTaskAdditionalAuthorityContinuationFingerprint(
  input: Pick<
    ProtectedTaskContinuationReceipt,
    | "taskRunId"
    | "executionSegment"
    | "jobId"
    | "kind"
    | "reason"
    | "effectDisposition"
    | "interruptId"
    | "operationId"
    | "requestDigest"
    | "requiredAuthorityDigest"
  >,
): string {
  if (!CANONICAL_UUID.test(input.taskRunId)
    || !CANONICAL_UUID.test(input.jobId)
    || !validSegment(input.executionSegment)
    || input.kind !== "pre_effect_interrupt_v1"
    || input.reason !== "additional_authority"
    || input.effectDisposition !== "not_started_v1"
    || typeof input.interruptId !== "string"
    || !OPAQUE_COORDINATE.test(input.interruptId)
    || typeof input.operationId !== "string"
    || !OPAQUE_COORDINATE.test(input.operationId)
    || !validDigest(input.requestDigest)
    || !validDigest(input.requiredAuthorityDigest)) {
    throw new TypeError(
      "Protected Task additional-authority continuation is malformed",
    );
  }
  return createHash("sha256").update(JSON.stringify([
    "protected-task-additional-authority-continuation:v1",
    input.taskRunId,
    input.executionSegment,
    input.jobId,
    input.kind,
    input.reason,
    input.effectDisposition,
    input.interruptId,
    input.operationId,
    Buffer.from(input.requestDigest).toString("base64url"),
    Buffer.from(input.requiredAuthorityDigest).toString("base64url"),
  ])).digest("base64url");
}

function sameBytes(
  left: Uint8Array | null,
  right: Uint8Array | null,
): boolean {
  if (left === null || right === null) return left === right;
  return left.length === right.length
    && left.every((byte, index) => byte === right[index]);
}

function validManifestContracts(
  input: SealProtectedTaskExecutionSegmentReceiptInput,
): boolean {
  const transcript = input.transcript;
  const checkpoint = input.checkpoint;
  const transcriptValid = validCount(transcript.expectedAssociationCount)
    && (transcript.contract === "none_v1"
      ? transcript.expectedAssociationCount === 0
        && transcript.orderedDigest === null
      : transcript.contract === "protected_message_associations_v1"
        ? validDigest(transcript.orderedDigest)
        : false);
  const checkpointCountsValid = validCount(
    checkpoint.expectedCheckpointCount,
  ) && validCount(checkpoint.expectedBlobCount)
    && validCount(checkpoint.expectedPendingWriteCount);
  const checkpointValid = checkpointCountsValid
    && (checkpoint.contract === "none_v1"
      ? checkpoint.expectedCheckpointCount === 0
        && checkpoint.expectedBlobCount === 0
        && checkpoint.expectedPendingWriteCount === 0
        && checkpoint.checkpointOrderedDigest === null
        && checkpoint.blobOrderedDigest === null
        && checkpoint.pendingWriteOrderedDigest === null
      : checkpoint.contract === "encrypted_langgraph_v1"
        ? validDigest(checkpoint.checkpointOrderedDigest)
          && validDigest(checkpoint.blobOrderedDigest)
          && validDigest(checkpoint.pendingWriteOrderedDigest)
        : false);
  const routeValid = input.route === "native_langgraph_v1"
    ? transcript.contract === "protected_message_associations_v1"
      && checkpoint.contract === "encrypted_langgraph_v1"
    : input.route === "hermes_acp_v1"
        || input.route === "opencode_acp_v1"
        || input.route === "codex_acp_v1"
        || input.route === "claude_code_acp_v1"
      ? transcript.contract === "none_v1"
        && checkpoint.contract === "none_v1"
      : false;
  return transcriptValid && checkpointValid && routeValid;
}

function assertSegmentInput(
  input: SealProtectedTaskExecutionSegmentReceiptInput,
): void {
  if (!CANONICAL_UUID.test(input.taskId)
    || !CANONICAL_UUID.test(input.taskRunId)
    || !CANONICAL_UUID.test(input.jobId)
    || !validSegment(input.executionSegment)
    || !(input.sealedAt instanceof Date)
    || !Number.isFinite(input.sealedAt.getTime())
    || !PROTECTED_TASK_EXECUTION_ROUTES.includes(input.route)
    || !validManifestContracts(input)) {
    throw new TypeError("Protected Task execution segment receipt is malformed");
  }
}

function assertContinuationInput(
  input: SealProtectedTaskContinuationReceiptInput,
): void {
  const baseValid = CANONICAL_UUID.test(input.taskId)
    && CANONICAL_UUID.test(input.taskRunId)
    && CANONICAL_UUID.test(input.jobId)
    && validSegment(input.executionSegment)
    && input.executionSegment < POSTGRES_INTEGER_MAX
    && input.sealedAt instanceof Date
    && Number.isFinite(input.sealedAt.getTime());
  const shapeValid = input.kind === "checkpoint_safe_v1"
    ? input.effectDisposition === "none_v1"
      && (input.reason === "manual_pause"
        || input.reason === "time_limit"
        || input.reason === "grant_refresh")
    : input.kind === "pre_effect_interrupt_v1"
      && input.effectDisposition === "not_started_v1"
      && (input.reason === "grant_refresh"
        || input.reason === "additional_authority")
      && OPAQUE_COORDINATE.test(input.interruptId)
      && OPAQUE_COORDINATE.test(input.operationId)
      && validDigest(input.requestDigest)
      && validDigest(input.requiredAuthorityDigest);
  if (!baseValid || !shapeValid) {
    throw new TypeError("Protected Task continuation receipt is malformed");
  }
}

function exactProtectedJob(
  task: Task,
  run: TaskRun,
  job: Job,
  input: Readonly<{
    taskId: string;
    taskRunId: string;
    jobId: string;
    executionSegment: number;
  }>,
): boolean {
  const reference = job.input;
  return run.id === input.taskRunId
    && run.taskId === input.taskId
    && run.jobId === input.jobId
    && task.id === input.taskId
    && (task.contentRepresentation === "dual"
      || task.contentRepresentation === "protected")
    && job.id === input.jobId
    && job.ownerId === task.requestorId
    && job.requestorId === task.requestorId
    && job.laneKey === `task:${input.taskId}`
    && job.type === "foreground"
    && job.result === null
    && job.message === null
    && reference !== null
    && typeof reference === "object"
    && !Array.isArray(reference)
    && reference["kind"] === "protected_task_run_v1"
    && reference["taskId"] === input.taskId
    && reference["taskRunId"] === input.taskRunId
    && reference["executionSegment"] === input.executionSegment;
}

async function validateCurrentIdentity(
  tx: Pick<DirectDatabase, "select">,
  input: Readonly<{
    taskId: string;
    taskRunId: string;
    jobId: string;
    executionSegment: number;
  }>,
): Promise<CurrentIdentityRejection | null> {
  const [task] = await tx.select().from(tasks)
    .where(eq(tasks.id, input.taskId)).limit(1).for("share");
  if (!task || task.id !== input.taskId) return "not_found";
  if (task.contentRepresentation !== "dual"
    && task.contentRepresentation !== "protected") return "not_protected";
  const [run] = await tx.select().from(taskRuns).where(and(
    eq(taskRuns.id, input.taskRunId),
    eq(taskRuns.taskId, input.taskId),
  )).limit(1).for("update");
  if (!run || run.id !== input.taskRunId || run.taskId !== input.taskId) {
    return "not_found";
  }
  if (run.jobId !== input.jobId) return "stale_job";
  const [job] = await tx.select().from(jobs)
    .where(eq(jobs.id, input.jobId)).limit(1).for("share");
  return job && exactProtectedJob(task, run, job, input)
    ? null
    : "stale_job";
}

function segmentValues(
  input: SealProtectedTaskExecutionSegmentReceiptInput,
): ProtectedTaskExecutionSegmentReceipt {
  return {
    taskRunId: input.taskRunId,
    executionSegment: input.executionSegment,
    jobId: input.jobId,
    route: input.route,
    transcriptContract: input.transcript.contract,
    expectedTranscriptAssociationCount:
      input.transcript.expectedAssociationCount,
    transcriptAssociationDigest: input.transcript.orderedDigest?.slice() ?? null,
    checkpointContract: input.checkpoint.contract,
    expectedCheckpointCount: input.checkpoint.expectedCheckpointCount,
    checkpointDigest: input.checkpoint.checkpointOrderedDigest?.slice() ?? null,
    expectedCheckpointBlobCount: input.checkpoint.expectedBlobCount,
    checkpointBlobDigest: input.checkpoint.blobOrderedDigest?.slice() ?? null,
    expectedPendingWriteCount: input.checkpoint.expectedPendingWriteCount,
    pendingWriteDigest: input.checkpoint.pendingWriteOrderedDigest?.slice()
      ?? null,
    sealedAt: new Date(input.sealedAt),
  };
}

function exactSegment(
  receipt: ProtectedTaskExecutionSegmentReceipt,
  input: SealProtectedTaskExecutionSegmentReceiptInput,
): boolean {
  const expected = segmentValues(input);
  return receipt.taskRunId === expected.taskRunId
    && receipt.executionSegment === expected.executionSegment
    && receipt.jobId === expected.jobId
    && receipt.route === expected.route
    && receipt.transcriptContract === expected.transcriptContract
    && receipt.expectedTranscriptAssociationCount
      === expected.expectedTranscriptAssociationCount
    && sameBytes(
      receipt.transcriptAssociationDigest,
      expected.transcriptAssociationDigest,
    )
    && receipt.checkpointContract === expected.checkpointContract
    && receipt.expectedCheckpointCount === expected.expectedCheckpointCount
    && sameBytes(receipt.checkpointDigest, expected.checkpointDigest)
    && receipt.expectedCheckpointBlobCount
      === expected.expectedCheckpointBlobCount
    && sameBytes(receipt.checkpointBlobDigest, expected.checkpointBlobDigest)
    && receipt.expectedPendingWriteCount
      === expected.expectedPendingWriteCount
    && sameBytes(receipt.pendingWriteDigest, expected.pendingWriteDigest);
}

function segmentRejected(
  reason: CurrentIdentityRejection,
): SealProtectedTaskExecutionSegmentReceiptResult {
  return Object.freeze({ status: "rejected" as const, reason });
}

export async function sealProtectedTaskExecutionSegmentReceiptInTx(
  tx: ReceiptTx,
  input: SealProtectedTaskExecutionSegmentReceiptInput,
): Promise<SealProtectedTaskExecutionSegmentReceiptResult> {
  assertSegmentInput(input);
  const identityFailure = await validateCurrentIdentity(tx, input);
  if (identityFailure !== null) return segmentRejected(identityFailure);

  const existing = await tx.select()
    .from(protectedTaskExecutionSegmentReceipts)
    .where(or(
      eq(protectedTaskExecutionSegmentReceipts.taskRunId, input.taskRunId),
      eq(protectedTaskExecutionSegmentReceipts.jobId, input.jobId),
    ))
    .orderBy(asc(protectedTaskExecutionSegmentReceipts.executionSegment));
  const runReceipts = existing.filter(receipt =>
    receipt.taskRunId === input.taskRunId
  );
  const candidate = runReceipts.find(receipt =>
    receipt.executionSegment === input.executionSegment
  );
  if (candidate) {
    if (!existing.every(receipt =>
      receipt.jobId !== input.jobId || receipt === candidate
    ) || !exactSegment(candidate, input)) return segmentRejected("conflict");
  } else if (existing.some(receipt => receipt.jobId === input.jobId)) {
    return segmentRejected("conflict");
  }
  const expectedCount = candidate
    ? input.executionSegment
    : input.executionSegment - 1;
  if (runReceipts.length !== expectedCount
    || runReceipts.some((receipt, index) =>
      receipt.executionSegment !== index + 1
    )) return segmentRejected("segment_gap");
  if (runReceipts.some(receipt =>
    receipt.route !== input.route
      || receipt.transcriptContract !== input.transcript.contract
      || receipt.checkpointContract !== input.checkpoint.contract
  )) return segmentRejected("conflict");
  if (candidate) {
    return Object.freeze({
      status: "exact_replay" as const,
      receipt: candidate,
    });
  }

  const [inserted] = await tx.insert(protectedTaskExecutionSegmentReceipts)
    .values(segmentValues(input))
    .onConflictDoNothing()
    .returning();
  if (inserted) {
    return Object.freeze({ status: "sealed" as const, receipt: inserted });
  }
  const raced = await tx.select()
    .from(protectedTaskExecutionSegmentReceipts)
    .where(or(
      and(
        eq(protectedTaskExecutionSegmentReceipts.taskRunId, input.taskRunId),
        eq(
          protectedTaskExecutionSegmentReceipts.executionSegment,
          input.executionSegment,
        ),
      ),
      eq(protectedTaskExecutionSegmentReceipts.jobId, input.jobId),
    )).limit(2);
  const exact = raced.find(receipt => exactSegment(receipt, input));
  return raced.length === 1 && exact
    ? Object.freeze({ status: "exact_replay" as const, receipt: exact })
    : segmentRejected("conflict");
}

export function sealProtectedTaskExecutionSegmentReceipt(
  db: DirectDatabase,
  input: SealProtectedTaskExecutionSegmentReceiptInput,
): Promise<SealProtectedTaskExecutionSegmentReceiptResult> {
  return db.transaction(tx =>
    sealProtectedTaskExecutionSegmentReceiptInTx(tx, input)
  );
}

function continuationValues(
  input: SealProtectedTaskContinuationReceiptInput,
): ProtectedTaskContinuationReceipt {
  return {
    taskRunId: input.taskRunId,
    executionSegment: input.executionSegment,
    jobId: input.jobId,
    kind: input.kind,
    reason: input.reason,
    effectDisposition: input.effectDisposition,
    interruptId: input.kind === "pre_effect_interrupt_v1"
      ? input.interruptId : null,
    operationId: input.kind === "pre_effect_interrupt_v1"
      ? input.operationId : null,
    requestDigest: input.kind === "pre_effect_interrupt_v1"
      ? input.requestDigest.slice() : null,
    requiredAuthorityDigest: input.kind === "pre_effect_interrupt_v1"
      ? input.requiredAuthorityDigest.slice() : null,
    sealedAt: new Date(input.sealedAt),
  };
}

function exactContinuation(
  receipt: ProtectedTaskContinuationReceipt,
  input: SealProtectedTaskContinuationReceiptInput,
): boolean {
  const expected = continuationValues(input);
  return receipt.taskRunId === expected.taskRunId
    && receipt.executionSegment === expected.executionSegment
    && receipt.jobId === expected.jobId
    && receipt.kind === expected.kind
    && receipt.reason === expected.reason
    && receipt.effectDisposition === expected.effectDisposition
    && receipt.interruptId === expected.interruptId
    && receipt.operationId === expected.operationId
    && sameBytes(receipt.requestDigest, expected.requestDigest)
    && sameBytes(
      receipt.requiredAuthorityDigest,
      expected.requiredAuthorityDigest,
    );
}

function continuationRejected(
  reason: Extract<
    SealProtectedTaskContinuationReceiptResult,
    { status: "rejected" }
  >["reason"],
): SealProtectedTaskContinuationReceiptResult {
  return Object.freeze({ status: "rejected" as const, reason });
}

export async function sealProtectedTaskContinuationReceiptInTx(
  tx: ReceiptTx,
  input: SealProtectedTaskContinuationReceiptInput,
): Promise<SealProtectedTaskContinuationReceiptResult> {
  assertContinuationInput(input);
  const identityFailure = await validateCurrentIdentity(tx, input);
  if (identityFailure !== null) {
    return continuationRejected(identityFailure === "segment_gap"
      ? "conflict" : identityFailure);
  }
  const segments = await tx.select()
    .from(protectedTaskExecutionSegmentReceipts)
    .where(and(
      eq(protectedTaskExecutionSegmentReceipts.taskRunId, input.taskRunId),
      eq(
        protectedTaskExecutionSegmentReceipts.executionSegment,
        input.executionSegment,
      ),
      eq(protectedTaskExecutionSegmentReceipts.jobId, input.jobId),
    )).limit(2);
  const segment = segments.find(receipt =>
    receipt.taskRunId === input.taskRunId
      && receipt.executionSegment === input.executionSegment
      && receipt.jobId === input.jobId
  );
  if (!segment
    || segment.route !== "native_langgraph_v1"
    || segment.checkpointContract !== "encrypted_langgraph_v1") {
    return continuationRejected("missing_segment");
  }

  const existing = await tx.select().from(protectedTaskContinuationReceipts)
    .where(or(
      and(
        eq(protectedTaskContinuationReceipts.taskRunId, input.taskRunId),
        eq(
          protectedTaskContinuationReceipts.executionSegment,
          input.executionSegment,
        ),
      ),
      eq(protectedTaskContinuationReceipts.jobId, input.jobId),
    )).limit(2);
  const candidate = existing.find(receipt =>
    receipt.taskRunId === input.taskRunId
      && receipt.executionSegment === input.executionSegment
  );
  if (candidate) {
    return existing.length === 1 && exactContinuation(candidate, input)
      ? Object.freeze({
          status: "exact_replay" as const,
          receipt: candidate,
        })
      : continuationRejected("conflict");
  }
  if (existing.some(receipt => receipt.jobId === input.jobId)) {
    return continuationRejected("conflict");
  }

  const [inserted] = await tx.insert(protectedTaskContinuationReceipts)
    .values(continuationValues(input))
    .onConflictDoNothing()
    .returning();
  if (inserted) {
    return Object.freeze({ status: "sealed" as const, receipt: inserted });
  }
  const raced = await tx.select().from(protectedTaskContinuationReceipts)
    .where(or(
      and(
        eq(protectedTaskContinuationReceipts.taskRunId, input.taskRunId),
        eq(
          protectedTaskContinuationReceipts.executionSegment,
          input.executionSegment,
        ),
      ),
      eq(protectedTaskContinuationReceipts.jobId, input.jobId),
    )).limit(2);
  const exact = raced.find(receipt => exactContinuation(receipt, input));
  return raced.length === 1 && exact
    ? Object.freeze({ status: "exact_replay" as const, receipt: exact })
    : continuationRejected("conflict");
}

export function sealProtectedTaskContinuationReceipt(
  db: DirectDatabase,
  input: SealProtectedTaskContinuationReceiptInput,
): Promise<SealProtectedTaskContinuationReceiptResult> {
  return db.transaction(tx =>
    sealProtectedTaskContinuationReceiptInTx(tx, input)
  );
}

function cloneSegment(
  receipt: ProtectedTaskExecutionSegmentReceipt,
): ProtectedTaskExecutionSegmentReceipt {
  return Object.freeze({
    ...receipt,
    transcriptAssociationDigest:
      receipt.transcriptAssociationDigest?.slice() ?? null,
    checkpointDigest: receipt.checkpointDigest?.slice() ?? null,
    checkpointBlobDigest: receipt.checkpointBlobDigest?.slice() ?? null,
    pendingWriteDigest: receipt.pendingWriteDigest?.slice() ?? null,
    sealedAt: new Date(receipt.sealedAt),
  });
}

function cloneContinuation(
  receipt: ProtectedTaskContinuationReceipt,
): ProtectedTaskContinuationReceipt {
  return Object.freeze({
    ...receipt,
    requestDigest: receipt.requestDigest?.slice() ?? null,
    requiredAuthorityDigest: receipt.requiredAuthorityDigest?.slice() ?? null,
    sealedAt: new Date(receipt.sealedAt),
  });
}

/** Read one exact immutable resume proof; absence is not replay authority. */
export async function readProtectedTaskExecutionContinuationProof(
  db: Pick<DirectDatabase, "select">,
  input: Readonly<{
    taskId: string;
    taskRunId: string;
    jobId: string;
    executionSegment: number;
  }>,
): Promise<ProtectedTaskExecutionContinuationProof | null> {
  if (!CANONICAL_UUID.test(input.taskId)
    || !CANONICAL_UUID.test(input.taskRunId)
    || !CANONICAL_UUID.test(input.jobId)
    || !validSegment(input.executionSegment)) {
    throw new TypeError("Protected Task continuation identity is malformed");
  }
  const [run] = await db.select().from(taskRuns).where(and(
    eq(taskRuns.id, input.taskRunId),
    eq(taskRuns.taskId, input.taskId),
  )).limit(1);
  if (!run || run.id !== input.taskRunId || run.taskId !== input.taskId) {
    return null;
  }
  const segments = await db.select()
    .from(protectedTaskExecutionSegmentReceipts)
    .where(and(
      eq(protectedTaskExecutionSegmentReceipts.taskRunId, input.taskRunId),
      eq(
        protectedTaskExecutionSegmentReceipts.executionSegment,
        input.executionSegment,
      ),
      eq(protectedTaskExecutionSegmentReceipts.jobId, input.jobId),
    )).limit(2);
  const continuations = await db.select()
    .from(protectedTaskContinuationReceipts)
    .where(and(
      eq(protectedTaskContinuationReceipts.taskRunId, input.taskRunId),
      eq(
        protectedTaskContinuationReceipts.executionSegment,
        input.executionSegment,
      ),
      eq(protectedTaskContinuationReceipts.jobId, input.jobId),
    )).limit(2);
  if (segments.length !== 1 || continuations.length !== 1) return null;
  const segment = segments[0]!;
  const continuation = continuations[0]!;
  if (segment.taskRunId !== input.taskRunId
    || segment.executionSegment !== input.executionSegment
    || segment.jobId !== input.jobId
    || segment.route !== "native_langgraph_v1"
    || segment.checkpointContract !== "encrypted_langgraph_v1"
    || continuation.taskRunId !== input.taskRunId
    || continuation.executionSegment !== input.executionSegment
    || continuation.jobId !== input.jobId) return null;
  return Object.freeze({
    segment: cloneSegment(segment),
    continuation: cloneContinuation(continuation),
  });
}
