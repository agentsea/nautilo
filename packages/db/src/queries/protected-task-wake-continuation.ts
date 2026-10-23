import { and, desc, eq, lt } from "drizzle-orm";

import type { DirectDatabase } from "../config/direct-database";
import { jobs, type Job } from "../schema/jobs";
import {
  protectedTaskRunOutputBindings,
  type ProtectedTaskRunOutputBinding,
} from "../schema/protected-task-run-output-bindings";
import {
  protectedTaskWakeContinuationReceipts,
  type ProtectedTaskWakeContinuationReceipt,
} from "../schema/protected-task-wake-continuation-receipts";
import type { ProtectedTaskSemanticAuthorityRequirements } from
  "../schema/protected-task-continuation-receipts";
import { taskRuns, type TaskRun } from "../schema/task-runs";
import { tasks, type Task } from "../schema/tasks";
import {
  canonicalProtectedTaskSemanticAuthorityRequirements,
  protectedTaskSemanticAuthorityRequirementsDigest,
  type ProtectedTaskCheckpointManifestReceipt,
  sameProtectedTaskSemanticAuthorityRequirements,
} from "./protected-task-execution-receipts";
import {
  protectedTaskRunOutputBindingId,
  protectedTaskRunWakeJobId,
  protectedTaskRunWakeOperationId,
} from "./protected-task-output-binding-identities";

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const OPAQUE = /^[A-Za-z0-9][A-Za-z0-9._:@/-]*$/u;
const INTEGER_MAX = 2_147_483_647;
const wakeContinuationProofBrand: unique symbol = Symbol(
  "ProtectedTaskWakeContinuationProof",
);

type WakeContinuationTx = Pick<DirectDatabase, "insert" | "select" | "update">;

// The persistence contract refines the existing receipt shape and never imports
// the Agent runtime into database consumers such as Electron.
type ProtectedTaskWakeCheckpointManifest = Readonly<{
  [Field in keyof ProtectedTaskCheckpointManifestReceipt]:
    NonNullable<ProtectedTaskCheckpointManifestReceipt[Field]>;
}> & Readonly<{ contract: "encrypted_langgraph_v1" }>;

export type ParkProtectedTaskWakeContinuationInput = Readonly<{
  wakeJobId: string;
  taskId: string;
  taskRunId: string;
  bindingId: string;
  wakeOperationId: string;
  priorRecipientGeneration: number;
  wakeAuthorizationRequestId: string;
  additionalAuthorizationRequestId: string;
  interruptId: string;
  operationId: string;
  requestDigest: Uint8Array;
  requiredAuthorityDigest: Uint8Array;
  semanticAuthorityRequirements: ProtectedTaskSemanticAuthorityRequirements;
  retainedSourceNamespaceIds: readonly string[];
  sourceEnvelopeDigest: Uint8Array;
  initialPolicyRevision: number;
  initialAgentAuthorizationRevision: number;
  destinationRoomId: string;
  destinationNamespaceId: string;
  destinationAuthorityDigest: Uint8Array;
  checkpointThreadId: string;
  checkpoint: ProtectedTaskWakeCheckpointManifest;
  sealedAt: Date;
}>;

export type ParkProtectedTaskWakeContinuationResult =
  | Readonly<{
      status: "parked" | "exact_replay";
      receipt: ProtectedTaskWakeContinuationReceipt;
    }>
  | Readonly<{ status: "stale" }>;

export type ProtectedTaskWakeContinuationCoordinates = Readonly<{
  wakeJobId: string;
  segment: number;
  wakeAuthorizationRequestId: string;
  priorRecipientGeneration: number;
  jobState: "queued" | "running";
}>;

/** Callback-scoped product proof. Its current assertion fails after release. */
export type VerifiedProtectedTaskWakeContinuation = Readonly<{
  receipt: ProtectedTaskWakeContinuationReceipt;
  priorReceipt: ProtectedTaskWakeContinuationReceipt | null;
  assertCurrent(): Promise<void>;
  readonly [wakeContinuationProofBrand]: true;
}>;

type WakeContinuationProofState = Readonly<{
  active: { value: boolean };
  receipt: ProtectedTaskWakeContinuationReceipt;
  priorReceipt: ProtectedTaskWakeContinuationReceipt | null;
}>;

const wakeContinuationProofStates = new WeakMap<
  object,
  WakeContinuationProofState
>();

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length
    && left.every((byte, index) => byte === right[index]);
}

function digest(value: unknown): value is Uint8Array {
  return value instanceof Uint8Array && value.length === 32;
}

function validInteger(value: number, minimum = 0): boolean {
  return Number.isSafeInteger(value) && value >= minimum && value <= INTEGER_MAX;
}

function validManifest(value: ProtectedTaskWakeCheckpointManifest): boolean {
  return value.contract === "encrypted_langgraph_v1"
    && validInteger(value.expectedCheckpointCount, 1)
    && validInteger(value.expectedBlobCount)
    && validInteger(value.expectedPendingWriteCount)
    && digest(value.checkpointOrderedDigest)
    && digest(value.blobOrderedDigest)
    && digest(value.pendingWriteOrderedDigest);
}

function exactJobReference(
  value: unknown,
  input: Readonly<{
    taskId: string;
    taskRunId: string;
    bindingId: string;
    wakeOperationId: string;
    destinationNamespaceId: string;
  }>,
  resultObjectId: string,
): boolean {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return Object.keys(record).sort().join(",")
      === "bindingId,kind,resultObjectId,taskId,taskRunId,wakeOperationId"
    && record["kind"] === "protected_task_delivery_v1"
    && record["taskId"] === input.taskId
    && record["taskRunId"] === input.taskRunId
    && record["bindingId"] === input.bindingId
    && record["resultObjectId"] === resultObjectId
    && record["wakeOperationId"] === input.wakeOperationId;
}

function currentProduct(input: Readonly<{
  task: Task;
  run: TaskRun;
  binding: ProtectedTaskRunOutputBinding;
  job: Job;
  coordinates: Readonly<{
    wakeJobId: string;
    taskId: string;
    taskRunId: string;
    bindingId: string;
    wakeOperationId: string;
    destinationNamespaceId: string;
  }>;
  jobStatus: "running" | "queued";
}>): boolean {
  const { task, run, binding, job, coordinates } = input;
  return task.id === coordinates.taskId
    && task.ownerId === task.requestorId
    && (task.contentRepresentation === "dual"
      || task.contentRepresentation === "protected")
    && task.cryptoMappingState === "verified"
    && task.contentRevision > 0
    && task.cryptoObjectId !== null
    && task.contentNamespaceId !== null
    && coordinates.destinationNamespaceId !== task.contentNamespaceId
    && run.id === coordinates.taskRunId
    && run.taskId === coordinates.taskId
    && ["completed", "cancelled", "errored"].includes(run.status)
    && run.completedAt !== null
    && run.resultRepresentation === task.contentRepresentation
    && run.resultCryptoMappingState === "verified"
    && run.resultRevision > 0
    && run.resultCryptoObjectId === binding.resultObjectId
    && run.resultContentNamespaceId === task.contentNamespaceId
    && binding.taskRunId === coordinates.taskRunId
    && binding.bindingId === coordinates.bindingId
    && binding.bindingId === protectedTaskRunOutputBindingId(coordinates.taskRunId)
    && binding.wakeOperationId === coordinates.wakeOperationId
    && binding.wakeOperationId === protectedTaskRunWakeOperationId(
      coordinates.taskRunId,
    )
    && binding.wakeJobId === coordinates.wakeJobId
    && binding.wakeScheduledAt !== null
    && binding.completedAt !== null
    && binding.destinationRoomId !== null
    && binding.destinationNamespaceId !== null
    && job.id === coordinates.wakeJobId
    && job.id === protectedTaskRunWakeJobId(coordinates.taskRunId)
    && job.ownerId === task.ownerId
    && job.requestorId === task.requestorId
    && job.roomId === binding.destinationRoomId
    && job.laneKey === `room:${binding.destinationRoomId}`
    && job.type === "foreground"
    && job.status === input.jobStatus
    && (input.jobStatus === "running"
      ? job.startedAt !== null && job.completedAt === null
      : job.startedAt === null && job.completedAt === null)
    && job.result === null
    && job.message === null
    && Object.keys(job.metadata).length === 0
    && exactJobReference(job.input, coordinates, binding.resultObjectId);
}

function canonicalInput(
  input: ParkProtectedTaskWakeContinuationInput,
): ParkProtectedTaskWakeContinuationInput & Readonly<{ segment: number }> {
  const segment = input.priorRecipientGeneration + 1;
  const retained = [...input.retainedSourceNamespaceIds].sort();
  const requirements = canonicalProtectedTaskSemanticAuthorityRequirements(
    input.semanticAuthorityRequirements,
  );
  const authorityDigest = protectedTaskSemanticAuthorityRequirementsDigest(
    requirements,
  );
  const decryptIds = requirements
    .filter(requirement => requirement.operations.includes("decrypt"))
    .map(requirement => requirement.namespaceId);
  const destination = requirements.find(requirement =>
    requirement.namespaceId === input.destinationNamespaceId);
  const invalid = ![
    input.wakeJobId, input.taskId, input.taskRunId, input.destinationRoomId,
    input.destinationNamespaceId, ...retained,
  ].every(value => UUID.test(value))
    || input.bindingId !== protectedTaskRunOutputBindingId(input.taskRunId)
    || input.wakeJobId !== protectedTaskRunWakeJobId(input.taskRunId)
    || input.wakeOperationId !== protectedTaskRunWakeOperationId(input.taskRunId)
    || input.wakeAuthorizationRequestId !== `task-wake-authorization:${input.wakeJobId}`
    || !OPAQUE.test(input.additionalAuthorizationRequestId)
    || !OPAQUE.test(input.interruptId) || !OPAQUE.test(input.operationId)
    || !OPAQUE.test(input.checkpointThreadId)
    || !validInteger(input.priorRecipientGeneration)
    || !validInteger(segment, 1)
    || !digest(input.requestDigest)
    || !digest(input.requiredAuthorityDigest)
    || !sameBytes(authorityDigest, input.requiredAuthorityDigest)
    || !digest(input.sourceEnvelopeDigest)
    || !digest(input.destinationAuthorityDigest)
    || !validInteger(input.initialPolicyRevision, 1)
    || !validInteger(input.initialAgentAuthorizationRevision, 1)
    || !validManifest(input.checkpoint)
    || !(input.sealedAt instanceof Date)
    || !Number.isFinite(input.sealedAt.getTime())
    || retained.length === 0
    || new Set(retained).size !== retained.length
    || retained.includes(input.destinationNamespaceId)
    || input.retainedSourceNamespaceIds.some((id, index) => id !== retained[index])
    || decryptIds.some(id => !retained.includes(id))
    || requirements.some(requirement => requirement.namespaceId
      !== input.destinationNamespaceId
      && (requirement.operations.length !== 1
        || requirement.operations[0] !== "decrypt"))
    || destination === undefined
    || destination.operations.length !== 1
    || destination.operations[0] !== "encrypt";
  authorityDigest.fill(0);
  if (invalid) {
    throw new TypeError("Protected Task wake continuation input is invalid");
  }
  return Object.freeze({
    ...input,
    segment,
    requestDigest: input.requestDigest.slice(),
    requiredAuthorityDigest: input.requiredAuthorityDigest.slice(),
    sourceEnvelopeDigest: input.sourceEnvelopeDigest.slice(),
    destinationAuthorityDigest: input.destinationAuthorityDigest.slice(),
    retainedSourceNamespaceIds: Object.freeze(retained),
    semanticAuthorityRequirements: requirements,
    checkpoint: Object.freeze({
      ...input.checkpoint,
      checkpointOrderedDigest: input.checkpoint.checkpointOrderedDigest.slice(),
      blobOrderedDigest: input.checkpoint.blobOrderedDigest.slice(),
      pendingWriteOrderedDigest:
        input.checkpoint.pendingWriteOrderedDigest.slice(),
    }),
    sealedAt: new Date(input.sealedAt),
  });
}

function receiptValues(
  input: ReturnType<typeof canonicalInput>,
): ProtectedTaskWakeContinuationReceipt {
  const retainedSourceNamespaceIds = [...input.retainedSourceNamespaceIds];
  Object.freeze(retainedSourceNamespaceIds);
  return Object.freeze({
    wakeJobId: input.wakeJobId,
    segment: input.segment,
    taskId: input.taskId,
    taskRunId: input.taskRunId,
    bindingId: input.bindingId,
    wakeOperationId: input.wakeOperationId,
    priorRecipientGeneration: input.priorRecipientGeneration,
    wakeAuthorizationRequestId: input.wakeAuthorizationRequestId,
    additionalAuthorizationRequestId: input.additionalAuthorizationRequestId,
    interruptId: input.interruptId,
    operationId: input.operationId,
    requestDigest: input.requestDigest,
    requiredAuthorityDigest: input.requiredAuthorityDigest,
    semanticAuthorityRequirements: input.semanticAuthorityRequirements,
    retainedSourceNamespaceIds,
    sourceEnvelopeDigest: input.sourceEnvelopeDigest,
    initialPolicyRevision: input.initialPolicyRevision,
    initialAgentAuthorizationRevision: input.initialAgentAuthorizationRevision,
    destinationRoomId: input.destinationRoomId,
    destinationNamespaceId: input.destinationNamespaceId,
    destinationAuthorityDigest: input.destinationAuthorityDigest,
    checkpointThreadId: input.checkpointThreadId,
    checkpointContract: input.checkpoint.contract,
    expectedCheckpointCount: input.checkpoint.expectedCheckpointCount,
    checkpointOrderedDigest: input.checkpoint.checkpointOrderedDigest,
    expectedBlobCount: input.checkpoint.expectedBlobCount,
    blobOrderedDigest: input.checkpoint.blobOrderedDigest,
    expectedPendingWriteCount: input.checkpoint.expectedPendingWriteCount,
    pendingWriteOrderedDigest: input.checkpoint.pendingWriteOrderedDigest,
    sealedAt: new Date(input.sealedAt),
  });
}

function canonicalReceipt(
  receipt: ProtectedTaskWakeContinuationReceipt,
): ProtectedTaskWakeContinuationReceipt {
  return receiptValues(canonicalInput({
    ...receipt,
    checkpoint: {
      contract: receipt.checkpointContract,
      expectedCheckpointCount: receipt.expectedCheckpointCount,
      checkpointOrderedDigest: receipt.checkpointOrderedDigest,
      expectedBlobCount: receipt.expectedBlobCount,
      blobOrderedDigest: receipt.blobOrderedDigest,
      expectedPendingWriteCount: receipt.expectedPendingWriteCount,
      pendingWriteOrderedDigest: receipt.pendingWriteOrderedDigest,
    },
  }));
}

function sameRequirements(
  left: ProtectedTaskSemanticAuthorityRequirements,
  right: ProtectedTaskSemanticAuthorityRequirements,
): boolean {
  try {
    // JSONB preserves array order, but not object key insertion order.
    return sameProtectedTaskSemanticAuthorityRequirements(
      canonicalProtectedTaskSemanticAuthorityRequirements(left),
      canonicalProtectedTaskSemanticAuthorityRequirements(right),
    );
  } catch {
    return false;
  }
}

function exactReceipt(
  left: ProtectedTaskWakeContinuationReceipt,
  right: ProtectedTaskWakeContinuationReceipt,
): boolean {
  for (const key of [
    "wakeJobId", "segment", "taskId", "taskRunId", "bindingId",
    "wakeOperationId", "priorRecipientGeneration", "wakeAuthorizationRequestId",
    "additionalAuthorizationRequestId", "interruptId", "operationId", "initialPolicyRevision",
    "initialAgentAuthorizationRevision", "destinationRoomId",
    "destinationNamespaceId", "checkpointThreadId", "checkpointContract",
    "expectedCheckpointCount", "expectedBlobCount",
    "expectedPendingWriteCount",
  ] as const) if (left[key] !== right[key]) return false;
  return left.sealedAt.getTime() === right.sealedAt.getTime()
    && left.retainedSourceNamespaceIds.join(",")
      === right.retainedSourceNamespaceIds.join(",")
    && sameRequirements(
      left.semanticAuthorityRequirements,
      right.semanticAuthorityRequirements,
    )
    && [
      [left.requestDigest, right.requestDigest],
      [left.requiredAuthorityDigest, right.requiredAuthorityDigest],
      [left.sourceEnvelopeDigest, right.sourceEnvelopeDigest],
      [left.destinationAuthorityDigest, right.destinationAuthorityDigest],
      [left.checkpointOrderedDigest, right.checkpointOrderedDigest],
      [left.blobOrderedDigest, right.blobOrderedDigest],
      [left.pendingWriteOrderedDigest, right.pendingWriteOrderedDigest],
    ].every(([a, b]) => sameBytes(a!, b!));
}

function sameContinuationLineage(
  prior: ProtectedTaskWakeContinuationReceipt,
  latest: ProtectedTaskWakeContinuationReceipt,
): boolean {
  return prior.wakeJobId === latest.wakeJobId
    && prior.taskId === latest.taskId
    && prior.taskRunId === latest.taskRunId
    && prior.bindingId === latest.bindingId
    && prior.wakeOperationId === latest.wakeOperationId
    && prior.wakeAuthorizationRequestId === latest.wakeAuthorizationRequestId
    && prior.retainedSourceNamespaceIds.join(",")
      === latest.retainedSourceNamespaceIds.join(",")
    && sameBytes(prior.sourceEnvelopeDigest, latest.sourceEnvelopeDigest)
    && prior.initialPolicyRevision === latest.initialPolicyRevision
    && prior.initialAgentAuthorizationRevision
      === latest.initialAgentAuthorizationRevision
    && prior.segment < latest.segment
    && prior.segment <= latest.priorRecipientGeneration;
}

/** Synchronously reject forged, mutated, spread, or escaped continuation proof. */
export function assertVerifiedProtectedTaskWakeContinuation(
  value: unknown,
): asserts value is VerifiedProtectedTaskWakeContinuation {
  if (value === null || typeof value !== "object") {
    throw new TypeError("Protected Task wake continuation proof is not authentic");
  }
  const state = wakeContinuationProofStates.get(value);
  if (state === undefined || !state.active.value) {
    throw new TypeError("Protected Task wake continuation proof is not current");
  }
  const proof = value as Partial<VerifiedProtectedTaskWakeContinuation>;
  let receipt: ProtectedTaskWakeContinuationReceipt;
  let priorReceipt: ProtectedTaskWakeContinuationReceipt | null;
  try {
    if (proof.receipt === undefined
      || !("priorReceipt" in proof)
      || proof.priorReceipt === undefined) {
      throw new TypeError("Protected Task wake continuation proof is incomplete");
    }
    receipt = canonicalReceipt(proof.receipt);
    priorReceipt = proof.priorReceipt === null
      ? null : canonicalReceipt(proof.priorReceipt);
  } catch {
    throw new TypeError("Protected Task wake continuation proof was mutated");
  }
  if (!exactReceipt(receipt, state.receipt)
    || (priorReceipt === null) !== (state.priorReceipt === null)
    || priorReceipt !== null && state.priorReceipt !== null
      && !exactReceipt(priorReceipt, state.priorReceipt)) {
    throw new TypeError("Protected Task wake continuation proof was mutated");
  }
}

async function lockedProduct(
  tx: WakeContinuationTx,
  coordinates: Readonly<{
    wakeJobId: string;
    taskId: string;
    taskRunId: string;
    bindingId: string;
    wakeOperationId: string;
    destinationNamespaceId: string;
  }>,
): Promise<Readonly<{
  task: Task;
  run: TaskRun;
  binding: ProtectedTaskRunOutputBinding;
  job: Job;
}> | null> {
  const [task] = await tx.select().from(tasks)
    .where(eq(tasks.id, coordinates.taskId)).limit(1).for("update");
  if (!task) return null;
  const [run] = await tx.select().from(taskRuns).where(and(
    eq(taskRuns.id, coordinates.taskRunId),
    eq(taskRuns.taskId, coordinates.taskId),
  )).limit(1).for("update");
  if (!run) return null;
  const [binding] = await tx.select().from(protectedTaskRunOutputBindings)
    .where(eq(protectedTaskRunOutputBindings.taskRunId, coordinates.taskRunId))
    .limit(1).for("update");
  if (!binding) return null;
  const [job] = await tx.select().from(jobs)
    .where(eq(jobs.id, coordinates.wakeJobId)).limit(1).for("update");
  return job ? Object.freeze({ task, run, binding, job }) : null;
}

/** Atomically seal a drained wake checkpoint and return its Job to the queue. */
export async function parkProtectedTaskWakeContinuation(
  tx: WakeContinuationTx,
  value: ParkProtectedTaskWakeContinuationInput,
): Promise<ParkProtectedTaskWakeContinuationResult> {
  const input = canonicalInput(value);
  const expected = receiptValues(input);
  const product = await lockedProduct(tx, input);
  if (product === null) return Object.freeze({ status: "stale" as const });
  // Every receipt append holds this Job lock; immutable receipts require only SELECT.
  const [existing] = await tx.select().from(protectedTaskWakeContinuationReceipts)
    .where(and(
      eq(protectedTaskWakeContinuationReceipts.wakeJobId, input.wakeJobId),
      eq(protectedTaskWakeContinuationReceipts.segment, input.segment),
    )).limit(1);
  if (existing !== undefined) {
    return exactReceipt(existing, expected)
      && currentProduct({ ...product, coordinates: input, jobStatus: "queued" })
      ? Object.freeze({ status: "exact_replay" as const, receipt: existing })
      : Object.freeze({ status: "stale" as const });
  }
  if (!currentProduct({
    ...product,
    coordinates: input,
    jobStatus: "running",
  })) return Object.freeze({ status: "stale" as const });
  const inserted = await tx.insert(protectedTaskWakeContinuationReceipts)
    .values(expected).onConflictDoNothing().returning();
  if (inserted.length !== 1 || inserted[0] === undefined) {
    return Object.freeze({ status: "stale" as const });
  }
  const updated = await tx.update(jobs).set({
    status: "queued",
    startedAt: null,
    completedAt: null,
  }).where(and(eq(jobs.id, input.wakeJobId), eq(jobs.status, "running")))
    .returning();
  if (updated.length !== 1) {
    throw new TypeError(
      "Protected Task wake continuation lost its locked Job transition",
    );
  }
  return Object.freeze({ status: "parked" as const, receipt: inserted[0] });
}

/** Detached planning read. It grants no authority to rotate a recipient. */
export async function readLatestProtectedTaskWakeContinuation(
  db: Pick<DirectDatabase, "select">,
  wakeJobId: string,
): Promise<ProtectedTaskWakeContinuationReceipt | null> {
  if (!UUID.test(wakeJobId)) {
    throw new TypeError("Protected Task wake continuation Job id is invalid");
  }
  const [receipt] = await db.select().from(protectedTaskWakeContinuationReceipts)
    .where(eq(protectedTaskWakeContinuationReceipts.wakeJobId, wakeJobId))
    .orderBy(desc(protectedTaskWakeContinuationReceipts.segment)).limit(1);
  return receipt ?? null;
}

/**
 * Reprove the latest receipt and exact queued or running wake product while
 * all product rows are locked. The nominal proof and liveness assertion cannot
 * escape the callback and are the only supported authority for recipient
 * rotation or publication.
 */
export async function withCurrentProtectedTaskWakeContinuation<Value>(
  tx: WakeContinuationTx,
  coordinates: ProtectedTaskWakeContinuationCoordinates,
  use: (proof: VerifiedProtectedTaskWakeContinuation) => Promise<Value>,
): Promise<Value | null> {
  if (!UUID.test(coordinates.wakeJobId)
    || !validInteger(coordinates.segment, 1)
    || !validInteger(coordinates.priorRecipientGeneration)
    || coordinates.segment !== coordinates.priorRecipientGeneration + 1
    || coordinates.jobState !== "queued" && coordinates.jobState !== "running"
    || !OPAQUE.test(coordinates.wakeAuthorizationRequestId)) {
    throw new TypeError("Protected Task wake continuation coordinates are invalid");
  }
  const [plannedRow] = await tx.select()
    .from(protectedTaskWakeContinuationReceipts)
    .where(eq(
      protectedTaskWakeContinuationReceipts.wakeJobId,
      coordinates.wakeJobId,
    )).orderBy(desc(protectedTaskWakeContinuationReceipts.segment))
    .limit(1);
  if (plannedRow === undefined
    || plannedRow.segment !== coordinates.segment
    || plannedRow.wakeAuthorizationRequestId
      !== coordinates.wakeAuthorizationRequestId
    || plannedRow.priorRecipientGeneration
      !== coordinates.priorRecipientGeneration) {
    return null;
  }
  let plannedReceipt: ProtectedTaskWakeContinuationReceipt;
  try {
    plannedReceipt = canonicalReceipt(plannedRow);
  } catch {
    return null;
  }
  const product = await lockedProduct(tx, plannedReceipt);
  if (product === null || !currentProduct({
    ...product,
    coordinates: plannedReceipt,
    jobStatus: coordinates.jobState,
  })) return null;
  // Re-read after the same Job lock used by the sole append owner. A receipt row
  // lock adds no serialization and requires UPDATE, which this append-only table denies.
  const [receipt] = await tx.select().from(protectedTaskWakeContinuationReceipts)
    .where(eq(
      protectedTaskWakeContinuationReceipts.wakeJobId,
      coordinates.wakeJobId,
    )).orderBy(desc(protectedTaskWakeContinuationReceipts.segment))
    .limit(1);
  if (receipt === undefined || !exactReceipt(receipt, plannedReceipt)) {
    return null;
  }
  const [priorRow] = await tx.select()
    .from(protectedTaskWakeContinuationReceipts)
    .where(and(
      eq(
        protectedTaskWakeContinuationReceipts.wakeJobId,
        coordinates.wakeJobId,
      ),
      lt(protectedTaskWakeContinuationReceipts.segment, receipt.segment),
    )).orderBy(desc(protectedTaskWakeContinuationReceipts.segment))
    .limit(1);
  let priorReceipt: ProtectedTaskWakeContinuationReceipt | null = null;
  if (priorRow !== undefined) {
    try {
      priorReceipt = canonicalReceipt(priorRow);
    } catch {
      return null;
    }
    if (!sameContinuationLineage(priorReceipt, receipt)) return null;
  }
  const active = { value: true };
  const exposedReceipt = canonicalReceipt(receipt);
  const exposedPriorReceipt = priorReceipt === null
    ? null : canonicalReceipt(priorReceipt);
  const proofState: WakeContinuationProofState = Object.freeze({
    active,
    receipt: canonicalReceipt(receipt),
    priorReceipt: priorReceipt === null ? null : canonicalReceipt(priorReceipt),
  });
  const proof = Object.freeze({
    receipt: exposedReceipt,
    priorReceipt: exposedPriorReceipt,
    async assertCurrent(): Promise<void> {
      assertVerifiedProtectedTaskWakeContinuation(proof);
      await Promise.resolve();
      assertVerifiedProtectedTaskWakeContinuation(proof);
    },
    [wakeContinuationProofBrand]: true as const,
  });
  wakeContinuationProofStates.set(proof, proofState);
  try {
    await proof.assertCurrent();
    const value = await use(proof);
    await proof.assertCurrent();
    return value;
  } finally {
    active.value = false;
  }
}
