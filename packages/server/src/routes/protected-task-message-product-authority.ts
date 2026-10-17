import { protectedTaskDefinitionSupportsPolicy } from "@nautilo/db";
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
import { BACKGROUND_AUTHORIZATION_MAX_IDENTIFIER_BYTES } from
  "@nautilo/runtime";
import type { CanonicalTranscriptTx } from "@nautilo/trust";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const PORTABLE_ID = /^[A-Za-z0-9][A-Za-z0-9._:@/-]*$/u;
const SHA256_BASE64URL = /^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/u;
const encoder = new TextEncoder();
type ConversationProductAppendPreparationGuardInput = Omit<
  Extract<
    ConversationProductPublicationGuardInput,
    Readonly<{ action: "appendAllocated" }>
  >,
  "messageId"
>;

export type ProtectedTaskMessageProductAuthority = Readonly<{
  taskId: string;
  taskRunId: string;
  jobId: string;
  taskOwnerId: string;
  graphThreadId: string;
  sessionId: string;
  sessionOwnerId: string;
  executionRoomId: string;
  roomId: string;
  namespaceId: string;
  contentNamespaceId: string;
  contentRevision: number;
  requiredNamespaceFingerprint: Uint8Array;
  agentId: string;
  requestorId: string;
  requesterHumanId: string;
  inputObjectId: string;
  resultObjectId: string;
  authorizationRequestId: string;
  executionSegment: number;
  resumeAcceptanceId?: string;
  resumeContinuationFingerprint?: string;
  policyRevision: number;
  definitionRepresentation: "dual" | "protected";
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
  const hasAcceptance = Object.hasOwn(expected, "resumeAcceptanceId");
  const keys = expected.executionSegment === 1
    ? "authorizationRequestId,executionSegment,inputObjectId,kind,policyRevision,resultObjectId,taskId,taskRunId"
    : hasAcceptance
      ? "authorizationRequestId,executionSegment,inputObjectId,kind,policyRevision,resultObjectId,resumeAcceptanceId,taskId,taskRunId"
      : "authorizationRequestId,executionSegment,inputObjectId,kind,policyRevision,resultObjectId,resumeContinuationFingerprint,taskId,taskRunId";
  return Object.keys(value).sort().join(",") === keys
    && value["kind"] === "protected_task_run_v1"
    && value["taskId"] === expected.taskId
    && value["taskRunId"] === expected.taskRunId
    && value["inputObjectId"] === expected.inputObjectId
    && value["resultObjectId"] === expected.resultObjectId
    && value["authorizationRequestId"] === expected.authorizationRequestId
    && value["executionSegment"] === expected.executionSegment
    && value["resumeAcceptanceId"] === expected.resumeAcceptanceId
    && value["resumeContinuationFingerprint"]
      === expected.resumeContinuationFingerprint
    && value["policyRevision"] === expected.policyRevision;
}

function exactAppend(
  input: ConversationProductPublicationGuardInput
    | ConversationProductAppendPreparationGuardInput,
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
  const hasAcceptance = Object.hasOwn(expected, "resumeAcceptanceId");
  const hasContinuation = Object.hasOwn(
    expected,
    "resumeContinuationFingerprint",
  );
  if ([expected.taskId, expected.taskRunId, expected.jobId,
    expected.taskOwnerId, expected.sessionId,
    expected.sessionOwnerId, expected.executionRoomId, expected.roomId,
    expected.namespaceId,
    expected.contentNamespaceId,
    expected.agentId, expected.requestorId,
    expected.requesterHumanId].some((value) => !UUID.test(value))
    || !["dual", "protected"].includes(expected.representation)
    || !["dual", "protected"].includes(expected.definitionRepresentation)
    || expected.graphThreadId.length === 0
    || !Number.isSafeInteger(expected.contentRevision)
    || expected.contentRevision < 1
    || expected.requiredNamespaceFingerprint.length !== 32
    || expected.inputObjectId.length === 0
    || expected.resultObjectId.length === 0
    || expected.authorizationRequestId.length === 0
    || !Number.isSafeInteger(expected.executionSegment)
    || expected.executionSegment < 1
    || (expected.executionSegment === 1
      ? hasAcceptance || hasContinuation
      : hasAcceptance === hasContinuation)
    || (hasAcceptance
      && (typeof expected.resumeAcceptanceId !== "string"
        || !PORTABLE_ID.test(expected.resumeAcceptanceId)
        || encoder.encode(expected.resumeAcceptanceId).length
          > BACKGROUND_AUTHORIZATION_MAX_IDENTIFIER_BYTES))
    || (hasContinuation
      && (typeof expected.resumeContinuationFingerprint !== "string"
        || !SHA256_BASE64URL.test(expected.resumeContinuationFingerprint)))
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
    async prepareAppendPublication(
      tx: CanonicalTranscriptTx,
      input: ConversationProductAppendPreparationGuardInput,
    ): Promise<void> {
      asserted.signal.throwIfAborted();
      if (now() >= asserted.authorizationExpiresAt
        || input.sessionId !== asserted.sessionId
        || input.revision !== 0
        || !exactAppend(input, asserted)) reject();

      const [policy] = await tx.select({ id: encryptionTransitionPolicy.id })
        .from(encryptionTransitionPolicy)
        .where(eq(encryptionTransitionPolicy.id, "server"))
        .limit(1).for("share");
      const [task] = await tx.select({ id: tasks.id }).from(tasks)
        .where(eq(tasks.id, asserted.taskId)).limit(1).for("share");
      const [run] = await tx.select({ id: taskRuns.id }).from(taskRuns)
        .where(and(
          eq(taskRuns.id, asserted.taskRunId),
          eq(taskRuns.taskId, asserted.taskId),
        )).limit(1).for("share");
      const [job] = await tx.select({ id: jobs.id }).from(jobs)
        .where(eq(jobs.id, asserted.jobId)).limit(1).for("share");
      if (!policy || !task || !run || !job) reject();

      // The Task lifecycle precedes both transcript write rows. Lock Session
      // before Rooms so concurrent protected appends cannot deadlock while
      // upgrading the Session message-count write after Room serialization.
      const [session] = await tx.select({ id: sessions.id }).from(sessions)
        .where(eq(sessions.id, asserted.sessionId)).limit(1).for("update");
      if (!session) reject();
      const roomIds = [...new Set([
        asserted.roomId,
        asserted.executionRoomId,
      ])].sort();
      for (const roomId of roomIds) {
        const [room] = await tx.select({ id: rooms.id }).from(rooms)
          .where(eq(rooms.id, roomId)).limit(1).for("update");
        if (!room) reject();
      }
      asserted.signal.throwIfAborted();
      if (now() >= asserted.authorizationExpiresAt) reject();
    },
    async assertPublicationAllowed(
      tx: CanonicalTranscriptTx,
      input: ConversationProductPublicationGuardInput,
    ): Promise<void> {
      asserted.signal.throwIfAborted();
      if (now() >= asserted.authorizationExpiresAt
        || input.sessionId !== asserted.sessionId
        || input.revision !== 0
        || !exactAppend(input, asserted)) reject();

      const [policy] = await tx.select().from(encryptionTransitionPolicy)
        .where(eq(encryptionTransitionPolicy.id, "server"))
        .limit(1).for("share");
      if (!policy) reject();

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
      const roomIds = [...new Set([
        asserted.roomId,
        asserted.executionRoomId,
      ])].sort();
      const lockedRooms: (typeof rooms.$inferSelect)[] = [];
      for (const roomId of roomIds) {
        const [locked] = await tx.select().from(rooms)
          .where(eq(rooms.id, roomId)).limit(1).for("share");
        if (!locked) reject();
        lockedRooms.push(locked);
      }
      const room = lockedRooms.find(value => value.id === asserted.roomId);
      const executionRoom = lockedRooms.find(value =>
        value.id === asserted.executionRoomId);
      if (!room || !executionRoom) reject();

      if (task.ownerId !== asserted.taskOwnerId
        || task.requestorId !== asserted.requestorId
        || task.agentId !== asserted.agentId
        || task.targetRoomId !== asserted.executionRoomId
        || task.contentRepresentation !== asserted.definitionRepresentation
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
        || (asserted.executionRoomId !== asserted.roomId && (
          asserted.namespaceId !== asserted.contentNamespaceId
          || room.ownerId !== asserted.requestorId
          || room.type !== "private"
          || room.kind !== "private"
          || room.parentRoomId !== null
          || room.archivedAt !== null
          || room.humanActorIds.length !== 1
          || room.humanActorIds[0] !== asserted.requesterHumanId
          || executionRoom.ownerId !== asserted.taskOwnerId
          || executionRoom.type !== "private"
          || executionRoom.kind !== "task"
          || executionRoom.archivedAt !== null
          || executionRoom.humanActorIds.length !== 0
        ))
        || !protectedTaskDefinitionSupportsPolicy(task.contentRepresentation, policy.mode)
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
