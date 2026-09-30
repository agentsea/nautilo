import {
  and,
  asc,
  eq,
  gt,
  isNotNull,
  isNull,
  or,
} from "drizzle-orm";
import type { DirectDatabase } from "../config/direct-database";
import { encryptionTransitionPolicy } from "../schema/encryption-transition";
import { jobs } from "../schema/jobs";
import {
  protectedTaskRunOutputBindings,
  type ProtectedTaskRunOutputBinding,
} from "../schema/protected-task-run-output-bindings";
import { rooms } from "../schema/rooms";
import { sessionMessageCryptoRevisions } from
  "../schema/session-message-crypto-revisions";
import { sessionMessages, sessions } from "../schema/sessions";
import { taskRuns } from "../schema/task-runs";
import { tasks } from "../schema/tasks";
import {
  protectedTaskRunMessageOperationId,
  protectedTaskRunOutputBindingId,
  protectedTaskRunResultObjectId,
  protectedTaskRunResultOperationId,
  protectedTaskRunWakeJobId,
  protectedTaskRunWakeOperationId,
} from "./protected-task-output-binding-identities";

const CANONICAL_UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

export type ProtectedTaskRunOutputDestination = Readonly<{
  roomId: string;
  namespaceId: string;
}>;

export type AcceptProtectedTaskRunOutputBindingInput = Readonly<{
  taskId: string;
  taskRunId: string;
  requiredPolicyRevision: number;
  acceptedAt: Date;
  destination: ProtectedTaskRunOutputDestination | null;
}>;

export type AcceptProtectedTaskRunOutputBindingResult =
  | Readonly<{
      status: "accepted" | "exact_replay";
      binding: ProtectedTaskRunOutputBinding;
    }>
  | Readonly<{
      status: "rejected";
      reason: "authority_changed" | "conflict" | "not_found" | "stale";
    }>;

export type RecordProtectedTaskRunOutputReceiptResult =
  | Readonly<{
      status: "recorded" | "exact_replay";
      binding: ProtectedTaskRunOutputBinding;
    }>
  | Readonly<{
      status: "rejected";
      reason: "conflict" | "not_found" | "not_ready";
    }>;

export type ProtectedTaskRunWakeReferenceV1 = Readonly<{
  kind: "protected_task_delivery_v1";
  bindingId: string;
  taskId: string;
  taskRunId: string;
  resultObjectId: string;
  wakeOperationId: string;
}>;

export type ProtectedTaskRunOutputRecoveryCursor = Readonly<{
  acceptedAt: Date;
  taskRunId: string;
}>;

function rejected(
  reason: Extract<
    AcceptProtectedTaskRunOutputBindingResult,
    { status: "rejected" }
  >["reason"],
): AcceptProtectedTaskRunOutputBindingResult {
  return Object.freeze({ status: "rejected" as const, reason });
}

function receiptRejected(
  reason: Extract<
    RecordProtectedTaskRunOutputReceiptResult,
    { status: "rejected" }
  >["reason"],
): RecordProtectedTaskRunOutputReceiptResult {
  return Object.freeze({ status: "rejected" as const, reason });
}

function assertAcceptanceInput(
  input: AcceptProtectedTaskRunOutputBindingInput,
): void {
  if (
    !CANONICAL_UUID.test(input.taskId)
    || !CANONICAL_UUID.test(input.taskRunId)
    || !Number.isSafeInteger(input.requiredPolicyRevision)
    || input.requiredPolicyRevision < 1
    || !(input.acceptedAt instanceof Date)
    || !Number.isFinite(input.acceptedAt.getTime())
    || input.destination !== null && (
      !CANONICAL_UUID.test(input.destination.roomId)
      || !CANONICAL_UUID.test(input.destination.namespaceId)
    )
  ) throw new TypeError("Protected Task output binding is malformed");
}

function exactBinding(
  binding: ProtectedTaskRunOutputBinding,
  input: AcceptProtectedTaskRunOutputBindingInput,
  deliveryMode: "none" | "wake" | "raw" | "raw_and_wake",
): boolean {
  const messageOperationId = deliveryMode === "raw"
      || deliveryMode === "raw_and_wake"
    ? protectedTaskRunMessageOperationId(input.taskRunId)
    : null;
  const wakeOperationId = deliveryMode === "wake"
      || deliveryMode === "raw_and_wake"
    ? protectedTaskRunWakeOperationId(input.taskRunId)
    : null;
  return binding.taskRunId === input.taskRunId
    && binding.bindingId === protectedTaskRunOutputBindingId(input.taskRunId)
    && binding.deliveryMode === deliveryMode
    && binding.destinationRoomId === (input.destination?.roomId ?? null)
    && binding.destinationNamespaceId === (input.destination?.namespaceId ?? null)
    && binding.resultOperationId
      === protectedTaskRunResultOperationId(input.taskRunId)
    && binding.resultObjectId
      === protectedTaskRunResultObjectId(input.taskId, input.taskRunId)
    && binding.messageOperationId === messageOperationId
    && binding.wakeOperationId === wakeOperationId
    && binding.acceptedPolicyRevision === input.requiredPolicyRevision;
}

/**
 * Accept one exact, content-free occurrence output before a grant can start
 * the TaskRun. The Task's calling Room is the delivery destination; the
 * execution target Room is intentionally irrelevant here.
 */
export async function acceptProtectedTaskRunOutputBinding(
  db: DirectDatabase,
  input: AcceptProtectedTaskRunOutputBindingInput,
): Promise<AcceptProtectedTaskRunOutputBindingResult> {
  assertAcceptanceInput(input);
  return db.transaction(async (tx) => {
    const [task] = await tx.select().from(tasks).where(eq(tasks.id, input.taskId))
      .limit(1).for("update");
    if (!task) return rejected("not_found");
    const [run] = await tx.select().from(taskRuns).where(and(
      eq(taskRuns.id, input.taskRunId),
      eq(taskRuns.taskId, input.taskId),
    )).limit(1).for("update");
    if (!run) return rejected("not_found");
    const [policy] = await tx.select().from(encryptionTransitionPolicy)
      .where(eq(encryptionTransitionPolicy.id, "server"))
      .limit(1).for("share");
    if (
      !policy
      || policy.revision !== input.requiredPolicyRevision
      || policy.mode !== (task.contentRepresentation === "dual"
        ? "shadow_encryption"
        : "encrypted_only")
    ) return rejected("authority_changed");

    const deliveryMode = task.callingRoomId === null
      ? "none" as const
      : task.resultDelivery;
    if (
      task.contentRepresentation !== "dual"
        && task.contentRepresentation !== "protected"
      || task.cryptoMappingState !== "verified"
      || task.contentNamespaceId === null
      || task.cryptoObjectId === null
      || task.cryptoRequiredNamespaceFingerprint === null
      || task.cryptoRequiredNamespaceFingerprint.length !== 32
      || task.lastError !== null
    ) return rejected("authority_changed");

    if (deliveryMode !== "none") {
      if (
        input.destination === null
        || task.callingRoomId !== input.destination.roomId
      ) return rejected("conflict");
      const [room] = await tx.select({
        id: rooms.id,
        namespaceId: rooms.namespaceId,
      }).from(rooms).where(and(
        eq(rooms.id, input.destination.roomId),
        eq(rooms.namespaceId, input.destination.namespaceId),
        isNull(rooms.archivedAt),
      )).limit(1).for("share");
      if (!room) return rejected("authority_changed");
    }

    const expectedTaskStatus = task.scheduleKind === "cron"
      ? "pending"
      : "awaiting";
    if (
      task.status !== expectedTaskStatus
      || run.status !== "awaiting"
      || run.jobId !== null
      || run.completedAt !== null
      || run.resultText !== null
      || run.lastError !== null
      || run.resultRepresentation !== "ordinary"
      || run.resultContentNamespaceId !== null
      || run.resultRevision !== 0
      || run.resultCryptoObjectId !== null
      || run.resultCryptoAccessRevision !== 0
      || run.resultCryptoRequiredNamespaceFingerprint !== null
      || run.resultCryptoMappingState !== "unmapped"
    ) return rejected("stale");

    const [existing] = await tx.select().from(protectedTaskRunOutputBindings)
      .where(eq(protectedTaskRunOutputBindings.taskRunId, run.id))
      .limit(1).for("update");
    if (existing) {
      const exactCurrentDestination = deliveryMode === "none"
        ? task.callingRoomId === null && input.destination === null
        : input.destination !== null
          && task.callingRoomId === input.destination.roomId;
      return exactCurrentDestination
          && exactBinding(existing, input, deliveryMode)
        ? Object.freeze({ status: "exact_replay" as const, binding: existing })
        : rejected("conflict");
    }

    if (deliveryMode === "none") {
      if (input.destination !== null) return rejected("conflict");
    }

    const [binding] = await tx.insert(protectedTaskRunOutputBindings).values({
      taskRunId: run.id,
      bindingId: protectedTaskRunOutputBindingId(run.id),
      deliveryMode,
      destinationRoomId: input.destination?.roomId ?? null,
      destinationNamespaceId: input.destination?.namespaceId ?? null,
      resultOperationId: protectedTaskRunResultOperationId(run.id),
      resultObjectId: protectedTaskRunResultObjectId(task.id, run.id),
      messageOperationId: deliveryMode === "raw"
          || deliveryMode === "raw_and_wake"
        ? protectedTaskRunMessageOperationId(run.id)
        : null,
      wakeOperationId: deliveryMode === "wake"
          || deliveryMode === "raw_and_wake"
        ? protectedTaskRunWakeOperationId(run.id)
        : null,
      acceptedPolicyRevision: policy.revision,
      acceptedAt: new Date(input.acceptedAt.getTime()),
    }).returning();
    if (!binding) throw new Error("Protected Task output binding insert failed");
    return Object.freeze({ status: "accepted" as const, binding });
  });
}

export async function getProtectedTaskRunOutputBinding(
  db: DirectDatabase,
  taskRunId: string,
): Promise<ProtectedTaskRunOutputBinding | undefined> {
  if (!CANONICAL_UUID.test(taskRunId)) {
    throw new TypeError("Protected Task output binding ID is malformed");
  }
  const [binding] = await db.select().from(protectedTaskRunOutputBindings)
    .where(eq(protectedTaskRunOutputBindings.taskRunId, taskRunId)).limit(1);
  return binding;
}

function exactTerminalResult(
  task: typeof tasks.$inferSelect,
  run: typeof taskRuns.$inferSelect,
  binding: ProtectedTaskRunOutputBinding,
): boolean {
  const exactDestination = binding.deliveryMode === "none"
    ? task.callingRoomId === null
      && binding.destinationRoomId === null
      && binding.destinationNamespaceId === null
    : task.callingRoomId === binding.destinationRoomId
      && task.resultDelivery === binding.deliveryMode
      && binding.destinationNamespaceId !== null;
  return (task.contentRepresentation === "protected"
      || task.contentRepresentation === "dual")
    && run.resultRepresentation === task.contentRepresentation
    && exactDestination
    && (run.status === "completed" || run.status === "errored")
    && run.completedAt !== null
    && run.resultRevision === 1
    && run.resultCryptoObjectId === binding.resultObjectId
    && run.resultCryptoMappingState === "verified";
}

/**
 * Reconcile the result repository's verified TaskRun mapping after its product
 * terminal callback committed. Delivery cannot proceed from the earlier
 * terminal receipt alone.
 */
export async function recordProtectedTaskRunResultAttached(
  db: DirectDatabase,
  input: Readonly<{ taskId: string; taskRunId: string }>,
): Promise<RecordProtectedTaskRunOutputReceiptResult> {
  if (
    !CANONICAL_UUID.test(input.taskId)
    || !CANONICAL_UUID.test(input.taskRunId)
  ) throw new TypeError("Protected Task result receipt is malformed");
  return db.transaction(async (tx) => {
    const [task] = await tx.select().from(tasks).where(eq(tasks.id, input.taskId))
      .limit(1).for("update");
    if (!task) return receiptRejected("not_found");
    const [run] = await tx.select().from(taskRuns).where(and(
      eq(taskRuns.id, input.taskRunId),
      eq(taskRuns.taskId, input.taskId),
    )).limit(1).for("update");
    if (!run) return receiptRejected("not_found");
    const [binding] = await tx.select().from(protectedTaskRunOutputBindings)
      .where(eq(protectedTaskRunOutputBindings.taskRunId, input.taskRunId))
      .limit(1).for("update");
    if (!binding) return receiptRejected("not_found");
    if (
      !exactTerminalResult(task, run, binding)
      || binding.resultTerminalAt === null
      || run.completedAt?.getTime() !== binding.resultTerminalAt.getTime()
    ) return receiptRejected("not_ready");
    if (binding.resultAttachedAt !== null) {
      return binding.resultAttachedAt.getTime() === run.completedAt.getTime()
        ? Object.freeze({ status: "exact_replay" as const, binding })
        : receiptRejected("conflict");
    }
    const [updated] = await tx.update(protectedTaskRunOutputBindings).set({
      resultAttachedAt: run.completedAt,
      ...(binding.deliveryMode === "none"
        ? { completedAt: run.completedAt }
        : {}),
    }).where(and(
      eq(protectedTaskRunOutputBindings.taskRunId, binding.taskRunId),
      isNull(protectedTaskRunOutputBindings.resultAttachedAt),
    )).returning();
    if (!updated) throw new Error("Protected Task result receipt lost its binding");
    return Object.freeze({ status: "recorded" as const, binding: updated });
  });
}

export async function recordProtectedTaskRunMessagePublished(
  db: DirectDatabase,
  input: Readonly<{ taskId: string; taskRunId: string; messageId: number }>,
): Promise<RecordProtectedTaskRunOutputReceiptResult> {
  if (
    !CANONICAL_UUID.test(input.taskId)
    || !CANONICAL_UUID.test(input.taskRunId)
    || !Number.isSafeInteger(input.messageId)
    || input.messageId < 1
  ) throw new TypeError("Protected Task Message receipt is malformed");
  return db.transaction(async (tx) => {
    const [task] = await tx.select().from(tasks).where(eq(tasks.id, input.taskId))
      .limit(1).for("update");
    if (!task) return receiptRejected("not_found");
    const [run] = await tx.select().from(taskRuns).where(and(
      eq(taskRuns.id, input.taskRunId),
      eq(taskRuns.taskId, input.taskId),
    )).limit(1).for("update");
    if (!run) return receiptRejected("not_found");
    const [binding] = await tx.select().from(protectedTaskRunOutputBindings)
      .where(eq(protectedTaskRunOutputBindings.taskRunId, input.taskRunId))
      .limit(1).for("update");
    if (!binding) return receiptRejected("not_found");
    if (
      !exactTerminalResult(task, run, binding)
      || binding.resultAttachedAt === null
      || binding.messageOperationId === null
      || binding.destinationRoomId === null
      || binding.destinationNamespaceId === null
    ) return receiptRejected("not_ready");
    if (binding.messageId !== null || binding.messagePublishedAt !== null) {
      return binding.messageId === input.messageId
        && binding.messagePublishedAt !== null
        ? Object.freeze({ status: "exact_replay" as const, binding })
        : receiptRejected("conflict");
    }

    const [message] = await tx.select().from(sessionMessages).where(
      eq(sessionMessages.id, input.messageId),
    ).limit(1).for("share");
    if (!message) return receiptRejected("not_found");
    const [session] = await tx.select().from(sessions).where(and(
      eq(sessions.id, message.sessionId),
      eq(sessions.roomId, binding.destinationRoomId),
    )).limit(1).for("share");
    const [revision] = await tx.select().from(sessionMessageCryptoRevisions)
      .where(and(
        eq(sessionMessageCryptoRevisions.sessionId, message.sessionId),
        eq(sessionMessageCryptoRevisions.messageId, message.id),
        eq(sessionMessageCryptoRevisions.editRevision, message.editRevision),
      )).limit(1).for("share");
    const expectedMode = task.contentRepresentation === "dual"
      ? "shadow_encryption"
      : "full_encryption";
    if (
      !session
      || session.ownerId !== task.requestorId
      || session.agentId !== task.agentId
      || !revision
      || message.role !== "assistant"
      || message.cryptoObjectId === null
      || revision.cryptoObjectId !== message.cryptoObjectId
      || revision.roomId !== binding.destinationRoomId
      || revision.namespaceIdAtAllocation !== binding.destinationNamespaceId
      || revision.appendIdempotencyKey !== binding.messageOperationId
      || revision.representationMode !== expectedMode
      || revision.publicationPolicyRevision !== binding.acceptedPolicyRevision
      || revision.payloadVersion !== 2
      || revision.keyClass !== "ai"
      || revision.authorRole !== "assistant"
      || revision.completion !== "complete"
      || revision.disposition !== "mapped"
      || revision.cryptoCompletedAt === null
      || revision.failureCode !== null
      || expectedMode === "full_encryption" && (
        message.content !== null
        || message.toolCalls !== null
        || message.toolName !== null
      )
    ) return receiptRejected("conflict");

    const publishedAt = revision.cryptoCompletedAt;
    if (publishedAt.getTime() < binding.resultAttachedAt.getTime()) {
      return receiptRejected("conflict");
    }
    const [updated] = await tx.update(protectedTaskRunOutputBindings).set({
      messageId: message.id,
      messagePublishedAt: publishedAt,
      ...(binding.deliveryMode === "raw" ? { completedAt: publishedAt } : {}),
    }).where(and(
      eq(protectedTaskRunOutputBindings.taskRunId, binding.taskRunId),
      isNull(protectedTaskRunOutputBindings.messageId),
      isNull(protectedTaskRunOutputBindings.messagePublishedAt),
    )).returning();
    if (!updated) throw new Error("Protected Task Message receipt lost its binding");
    return Object.freeze({ status: "recorded" as const, binding: updated });
  });
}

function exactWakeReference(
  value: unknown,
  binding: ProtectedTaskRunOutputBinding,
  taskId: string,
): value is ProtectedTaskRunWakeReferenceV1 {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const reference = value as Record<string, unknown>;
  return Object.keys(reference).sort().join(",")
      === "bindingId,kind,resultObjectId,taskId,taskRunId,wakeOperationId"
    && reference["kind"] === "protected_task_delivery_v1"
    && reference["bindingId"] === binding.bindingId
    && reference["taskId"] === taskId
    && reference["taskRunId"] === binding.taskRunId
    && reference["resultObjectId"] === binding.resultObjectId
    && reference["wakeOperationId"] === binding.wakeOperationId;
}

export async function recordProtectedTaskRunWakeScheduled(
  db: DirectDatabase,
  input: Readonly<{ taskId: string; taskRunId: string; wakeJobId: string }>,
): Promise<RecordProtectedTaskRunOutputReceiptResult> {
  if (
    !CANONICAL_UUID.test(input.taskId)
    || !CANONICAL_UUID.test(input.taskRunId)
    || input.wakeJobId !== protectedTaskRunWakeJobId(input.taskRunId)
  ) throw new TypeError("Protected Task wake receipt is malformed");
  return db.transaction(async (tx) => {
    const [task] = await tx.select().from(tasks).where(eq(tasks.id, input.taskId))
      .limit(1).for("update");
    if (!task) return receiptRejected("not_found");
    const [run] = await tx.select().from(taskRuns).where(and(
      eq(taskRuns.id, input.taskRunId),
      eq(taskRuns.taskId, input.taskId),
    )).limit(1).for("update");
    if (!run) return receiptRejected("not_found");
    const [binding] = await tx.select().from(protectedTaskRunOutputBindings)
      .where(eq(protectedTaskRunOutputBindings.taskRunId, input.taskRunId))
      .limit(1).for("update");
    if (!binding) return receiptRejected("not_found");
    if (
      !exactTerminalResult(task, run, binding)
      || binding.resultAttachedAt === null
      || binding.wakeOperationId === null
      || binding.destinationRoomId === null
      || binding.destinationNamespaceId === null
      || binding.deliveryMode === "raw_and_wake"
        && binding.messagePublishedAt === null
    ) return receiptRejected("not_ready");
    if (binding.wakeJobId !== null || binding.wakeScheduledAt !== null) {
      return binding.wakeJobId === input.wakeJobId
        && binding.wakeScheduledAt !== null
        ? Object.freeze({ status: "exact_replay" as const, binding })
        : receiptRejected("conflict");
    }

    const [job] = await tx.select().from(jobs).where(eq(jobs.id, input.wakeJobId))
      .limit(1).for("share");
    if (
      !job
      || job.ownerId !== task.ownerId
      || job.requestorId !== task.requestorId
      || job.roomId !== binding.destinationRoomId
      || job.laneKey !== `room:${binding.destinationRoomId}`
      || job.type !== "foreground"
      || !["queued", "running", "completed"].includes(job.status)
      || job.result !== null
      || job.message !== null
      || !exactWakeReference(job.input, binding, task.id)
      || job.createdAt.getTime() < binding.resultAttachedAt.getTime()
      || binding.messagePublishedAt !== null
        && job.createdAt.getTime() < binding.messagePublishedAt.getTime()
    ) return receiptRejected(job ? "conflict" : "not_found");

    const [updated] = await tx.update(protectedTaskRunOutputBindings).set({
      wakeJobId: job.id,
      wakeScheduledAt: job.createdAt,
      completedAt: job.createdAt,
    }).where(and(
      eq(protectedTaskRunOutputBindings.taskRunId, binding.taskRunId),
      isNull(protectedTaskRunOutputBindings.wakeJobId),
      isNull(protectedTaskRunOutputBindings.wakeScheduledAt),
    )).returning();
    if (!updated) throw new Error("Protected Task wake receipt lost its binding");
    return Object.freeze({ status: "recorded" as const, binding: updated });
  });
}

/** Restart reconciliation reads terminalized runs with an incomplete output. */
export async function listProtectedTaskRunOutputBindingsNeedingDelivery(
  db: DirectDatabase,
  batch: number,
  after?: ProtectedTaskRunOutputRecoveryCursor,
): Promise<ProtectedTaskRunOutputBinding[]> {
  if (
    !Number.isSafeInteger(batch)
    || batch < 0
  ) {
    throw new TypeError("Protected Task output recovery batch is malformed");
  }
  if (batch === 0) return [];
  if (after && (
    !(after.acceptedAt instanceof Date)
    || !Number.isFinite(after.acceptedAt.getTime())
    || !CANONICAL_UUID.test(after.taskRunId)
  )) throw new TypeError("Protected Task output recovery cursor is malformed");
  return db.select().from(protectedTaskRunOutputBindings).where(and(
    isNotNull(protectedTaskRunOutputBindings.resultTerminalAt),
    isNull(protectedTaskRunOutputBindings.completedAt),
    after ? or(
      gt(protectedTaskRunOutputBindings.acceptedAt, after.acceptedAt),
      and(
        eq(protectedTaskRunOutputBindings.acceptedAt, after.acceptedAt),
        gt(protectedTaskRunOutputBindings.taskRunId, after.taskRunId),
      ),
    ) : undefined,
  )).orderBy(
    asc(protectedTaskRunOutputBindings.acceptedAt),
    asc(protectedTaskRunOutputBindings.taskRunId),
  ).limit(batch);
}

export {
  protectedTaskRunMessageOperationId,
  protectedTaskRunOutputBindingId,
  protectedTaskRunResultObjectId,
  protectedTaskRunResultOperationId,
  protectedTaskRunWakeJobId,
  protectedTaskRunWakeOperationId,
};
