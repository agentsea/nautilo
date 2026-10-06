import {
  and,
  encryptionTransitionPolicy,
  eq,
  jobs,
  rooms,
  recordTaskRunMessageAssociationInTx,
  sessionMessageCryptoRevisions,
  sessions,
  taskRuns,
  tasks,
} from "@nautilo/db";
import { deriveMessageCryptoObjectIdV2 } from "@nautilo/lattice-bridge";
import type {
  ConversationProductPublicationGuard,
  ConversationProductPublicationGuardInput,
} from "@nautilo/lattice-bridge/server";
import type { CanonicalTranscriptTx } from "@nautilo/trust";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

export type ProtectedTaskMessageProductAuthority = Readonly<{
  taskId: string;
  taskRunId: string;
  jobId: string;
  taskOwnerId: string;
  graphThreadId: string;
  sessionId: string;
  sessionOwnerId: string;
  roomId: string;
  namespaceId: string;
  contentNamespaceId: string;
  contentRevision: number;
  requiredNamespaceFingerprint: Uint8Array;
  agentId: string;
  requestorId: string;
  inputObjectId: string;
  resultObjectId: string;
  authorizationRequestId: string;
  executionSegment: number;
  resumeAcceptanceId?: string;
  policyRevision: number;
  representation: "dual" | "protected";
  authorizationExpiresAt: number;
  signal: AbortSignal;
}>;

function reject(): never {
  throw new TypeError("Protected Task Message product authority changed");
}

function exactJobReference(
  value: Record<string, unknown> | null,
  expected: ProtectedTaskMessageProductAuthority,
): boolean {
  if (value === null) return false;
  const keys = expected.executionSegment === 1
    ? "authorizationRequestId,executionSegment,inputObjectId,kind,policyRevision,resultObjectId,taskId,taskRunId"
    : "authorizationRequestId,executionSegment,inputObjectId,kind,policyRevision,resultObjectId,resumeAcceptanceId,taskId,taskRunId";
  return Object.keys(value).sort().join(",") === keys
    && value["kind"] === "protected_task_run_v1"
    && value["taskId"] === expected.taskId
    && value["taskRunId"] === expected.taskRunId
    && value["inputObjectId"] === expected.inputObjectId
    && value["resultObjectId"] === expected.resultObjectId
    && value["authorizationRequestId"] === expected.authorizationRequestId
    && value["executionSegment"] === expected.executionSegment
    && value["resumeAcceptanceId"] === expected.resumeAcceptanceId
    && value["policyRevision"] === expected.policyRevision;
}

function exactAppend(
  input: ConversationProductPublicationGuardInput,
  expected: ProtectedTaskMessageProductAuthority,
): boolean {
  if (input.action !== "appendAllocated") return true;
  return input.idempotencyKey.startsWith(
    `task-transcript:${expected.taskRunId}:fp:v1:`,
  )
    && input.keyClass === "ai"
    && ["assistant", "tool", "system"].includes(input.authorRole)
    && input.publicationPolicy?.expectedRevision === expected.policyRevision
    && input.publicationPolicy.representation === (expected.representation === "dual"
      ? "ordinary_and_protected"
      : "protected_only");
}

async function exactExistingLifecycle(
  tx: CanonicalTranscriptTx,
  input: ConversationProductPublicationGuardInput,
  expected: ProtectedTaskMessageProductAuthority,
): Promise<boolean> {
  if (input.action === "appendAllocated") return true;
  const [lifecycle] = await tx.select().from(sessionMessageCryptoRevisions)
    .where(and(
      eq(sessionMessageCryptoRevisions.sessionId, input.sessionId),
      eq(sessionMessageCryptoRevisions.messageId, input.messageId),
      eq(sessionMessageCryptoRevisions.editRevision, input.revision),
    )).limit(1);
  // The serializable product transaction validates this snapshot. Mapping
  // locks the Message before its lifecycle; an early shared lifecycle lock
  // would invert that order during concurrent replay.
  return lifecycle !== undefined
    && lifecycle.roomId === expected.roomId
    && lifecycle.namespaceIdAtAllocation === expected.namespaceId
    && lifecycle.objectIdScheme === "message_v2"
    && lifecycle.cryptoObjectId === deriveMessageCryptoObjectIdV2(input)
    && lifecycle.representationMode === (expected.representation === "dual"
      ? "shadow_encryption"
      : "full_encryption")
    && lifecycle.publicationPolicyRevision === (expected.representation === "dual"
      ? null
      : expected.policyRevision)
    && lifecycle.keyClass === "ai"
    && ["assistant", "tool", "system"].includes(lifecycle.authorRole)
    && lifecycle.appendIdempotencyKey?.startsWith(
      `task-transcript:${expected.taskRunId}:fp:v1:`,
    ) === true;
}

/**
 * Product-side fence for a Task transcript publisher. It holds the current
 * Task, Run, Job, Session, Room and policy rows in the same transaction that
 * allocates or maps each Message. The Runtime grant is separately checked by
 * the publisher before each phase; this fence refuses stale product state.
 */
export function createProtectedTaskMessageProductGuard(
  expected: ProtectedTaskMessageProductAuthority,
  now: () => number = Date.now,
): ConversationProductPublicationGuard {
  if ([expected.taskId, expected.taskRunId, expected.jobId,
    expected.taskOwnerId, expected.sessionId,
    expected.sessionOwnerId, expected.roomId, expected.namespaceId,
    expected.contentNamespaceId,
    expected.agentId, expected.requestorId].some((value) => !UUID.test(value))
    || expected.graphThreadId.length === 0
    || !Number.isSafeInteger(expected.contentRevision)
    || expected.contentRevision < 1
    || expected.requiredNamespaceFingerprint.length !== 32
    || expected.inputObjectId.length === 0
    || expected.resultObjectId.length === 0
    || expected.authorizationRequestId.length === 0
    || !Number.isSafeInteger(expected.executionSegment)
    || expected.executionSegment < 1
    || (expected.executionSegment === 1) !== (expected.resumeAcceptanceId === undefined)
    || !Number.isSafeInteger(expected.policyRevision)
    || expected.policyRevision < 1
    || !Number.isSafeInteger(expected.authorizationExpiresAt)
    || !(expected.signal instanceof AbortSignal)) {
    throw new TypeError("Protected Task Message guard identity is invalid");
  }
  const asserted = Object.freeze({
    ...expected,
    requiredNamespaceFingerprint: expected.requiredNamespaceFingerprint.slice(),
  });
  return Object.freeze({
    async assertPublicationAllowed(
      tx: CanonicalTranscriptTx,
      input: ConversationProductPublicationGuardInput,
    ): Promise<void> {
      asserted.signal.throwIfAborted();
      if (now() >= asserted.authorizationExpiresAt
        || input.sessionId !== asserted.sessionId
        || input.revision !== 0
        || !exactAppend(input, asserted)) reject();

      const [task] = await tx.select().from(tasks)
        .where(eq(tasks.id, asserted.taskId)).limit(1).for("share");
      if (!task) reject();
      const [run] = await tx.select().from(taskRuns).where(and(
        eq(taskRuns.id, asserted.taskRunId),
        eq(taskRuns.taskId, asserted.taskId),
      )).limit(1).for("share");
      if (!run) reject();
      const [job] = await tx.select().from(jobs)
        .where(eq(jobs.id, asserted.jobId)).limit(1).for("share");
      if (!job) reject();
      const [session] = await tx.select().from(sessions)
        .where(eq(sessions.id, asserted.sessionId)).limit(1).for("share");
      if (!session) reject();
      const [room] = await tx.select().from(rooms)
        .where(eq(rooms.id, asserted.roomId)).limit(1).for("share");
      if (!room) reject();
      const [policy] = await tx.select().from(encryptionTransitionPolicy)
        .where(eq(encryptionTransitionPolicy.id, "server"))
        .limit(1).for("share");
      if (!policy) reject();

      if (task.ownerId !== asserted.taskOwnerId
        || task.requestorId !== asserted.requestorId
        || task.agentId !== asserted.agentId
        || task.targetRoomId !== asserted.roomId
        || task.contentRepresentation !== asserted.representation
        || task.contentNamespaceId !== asserted.contentNamespaceId
        || task.contentRevision !== asserted.contentRevision
        || task.cryptoRequiredNamespaceFingerprint?.length !== 32
        || task.cryptoRequiredNamespaceFingerprint.some((byte, index) =>
          byte !== asserted.requiredNamespaceFingerprint[index])
        || task.cryptoObjectId !== asserted.inputObjectId
        || task.cryptoMappingState !== "verified"
        || task.lastError !== null
        || task.status !== (task.scheduleKind === "cron" ? "pending" : "running")
        || run.taskId !== task.id
        || run.jobId !== job.id
        || run.graphThreadId !== asserted.graphThreadId
        || run.status !== "running"
        || run.completedAt !== null
        || run.resultText !== null
        || run.lastError !== null
        || job.ownerId !== task.requestorId
        || job.requestorId !== task.requestorId
        || job.laneKey !== `task:${task.id}`
        || job.type !== "foreground"
        || job.status !== "running"
        || job.result !== null
        || job.message !== null
        || !exactJobReference(job.input, asserted)
        || session.ownerId !== asserted.sessionOwnerId
        || session.agentId !== asserted.agentId
        || session.threadId !== asserted.graphThreadId
        || session.roomId !== asserted.roomId
        || room.namespaceId !== asserted.namespaceId
        || policy.revision !== asserted.policyRevision
        || policy.mode !== (asserted.representation === "dual"
          ? "shadow_encryption"
          : "encrypted_only")
        || !await exactExistingLifecycle(tx, input, asserted)) reject();
      asserted.signal.throwIfAborted();
      if (now() >= asserted.authorizationExpiresAt) reject();
    },
    async recordMappedPublication(
      tx: CanonicalTranscriptTx,
      input: Parameters<NonNullable<ConversationProductPublicationGuard["recordMappedPublication"]>>[1],
    ): Promise<void> {
      asserted.signal.throwIfAborted();
      if (input.sessionId !== asserted.sessionId
        || input.revision !== 0
        || input.idempotencyKey?.startsWith(
          `task-transcript:${asserted.taskRunId}:fp:v1:`,
        ) !== true) reject();
      const result = await recordTaskRunMessageAssociationInTx(tx, {
        taskId: asserted.taskId,
        taskRunId: asserted.taskRunId,
        sessionId: input.sessionId,
        expectedThreadId: asserted.graphThreadId,
        messageId: input.messageId,
        publishedRevision: input.revision,
        kind: "transcript",
        publicationKey: input.idempotencyKey,
      });
      if (result.status === "rejected") reject();
    },
  });
}
