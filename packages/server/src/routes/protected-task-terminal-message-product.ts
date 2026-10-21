import {
  acquireEncryptionConsumptionFence, actors, and, deriveProtectedTaskDeliveryGraphThreadId, eq, isNull,
  protectedTaskRunCancelledResultObjectId, protectedTaskRunCancelledResultOperationId,
  protectedTaskRunMessageOperationId, protectedTaskRunOutputBindingId,
  protectedTaskRunOutputBindings, PROTECTED_TASK_CANCELLED_RESULT,
  recordTaskRunMessageAssociationInTx, roomMembers, rooms, sessionMessages,
  sessionMessageCryptoRevisions, sessions, sql, taskRuns, tasks,
} from "@nautilo/db";
import type { CanonicalTranscriptTx } from "@nautilo/trust";
import type { ConversationProductPublicationGuard } from "@nautilo/lattice-bridge/server";
import { assertUnstagedTaskTerminalMessageAuthority,
  type UnstagedTaskTerminalMessageAuthority } from "@nautilo/lattice-bridge/server";

export type ProtectedTaskTerminalMessageIntent = Readonly<{
  taskId: string;
  taskRunId: string;
  requesterUserId: string;
  agentId: string;
  contentNamespaceId: string;
  representation: "dual" | "protected";
  bindingId: string;
  resultObjectId: string;
  resultRevision: 2;
  acceptedPolicyRevision: number;
  terminalAt: Date;
  attachedAt: Date;
  destinationRoomId: string;
  destinationNamespaceId: string;
  messageOperationId: string;
}>;

type ProductTx = Pick<CanonicalTranscriptTx, "select" | "insert">;

/** Closed lifecycle facts only; Task/result plaintext never leaves this query. */
export async function readProtectedTaskTerminalMessageIntent(
  tx: Pick<ProductTx, "select">,
  coordinates: Readonly<{ taskId: string; taskRunId: string }>,
  options: Readonly<{ allowPublished?: boolean }> = {},
): Promise<ProtectedTaskTerminalMessageIntent | null> {
  const [task] = await tx.select({
    id: tasks.id, ownerId: tasks.ownerId, requesterUserId: tasks.requestorId,
    agentId: tasks.agentId, contentNamespaceId: tasks.contentNamespaceId,
    representation: tasks.contentRepresentation, status: tasks.status,
    cancelledAt: tasks.cancelledAt, callingRoomId: tasks.callingRoomId,
    resultDelivery: tasks.resultDelivery,
  }).from(tasks).where(eq(tasks.id, coordinates.taskId)).limit(1).for("update");
  if (!task || task.ownerId !== task.requesterUserId || task.status !== "cancelled"
    || task.cancelledAt === null || task.contentNamespaceId === null
    || task.representation !== "dual" && task.representation !== "protected") return null;
  const [run] = await tx.select({
    id: taskRuns.id, status: taskRuns.status, completedAt: taskRuns.completedAt,
    revision: taskRuns.resultRevision, objectId: taskRuns.resultCryptoObjectId,
    namespaceId: taskRuns.resultContentNamespaceId,
    representation: taskRuns.resultRepresentation, mapping: taskRuns.resultCryptoMappingState,
    siblingIsExact: sql<boolean>`${taskRuns.lastError} is null and (${taskRuns.resultRepresentation} = 'protected'
      and ${taskRuns.resultText} is null or ${taskRuns.resultRepresentation} = 'dual'
      and ${taskRuns.resultText} = ${PROTECTED_TASK_CANCELLED_RESULT})`.mapWith(Boolean),
  }).from(taskRuns).where(and(eq(taskRuns.id, coordinates.taskRunId),
    eq(taskRuns.taskId, task.id))).limit(1).for("update");
  if (!run || run.status !== "cancelled" || run.completedAt?.getTime() !== task.cancelledAt.getTime()
    || run.revision !== 2 || run.objectId !== protectedTaskRunCancelledResultObjectId(task.id, run.id)
    || run.namespaceId !== task.contentNamespaceId || run.representation !== task.representation
    || run.mapping !== "verified" || !run.siblingIsExact) return null;
  const [binding] = await tx.select().from(protectedTaskRunOutputBindings)
    .where(eq(protectedTaskRunOutputBindings.taskRunId, run.id)).limit(1).for("update");
  if (!binding || binding.bindingId !== protectedTaskRunOutputBindingId(run.id)
    || binding.resultRevision !== 2 || binding.resultObjectId !== run.objectId
    || binding.resultOperationId !== protectedTaskRunCancelledResultOperationId(run.id)
    || binding.resultTerminalAt?.getTime() !== run.completedAt.getTime()
    || binding.resultAttachedAt === null
    || binding.completedAt !== null && (options.allowPublished !== true
      || binding.messageId === null || binding.messagePublishedAt === null
      || (binding.deliveryMode === "raw"
        ? binding.completedAt.getTime() !== binding.messagePublishedAt.getTime()
        : binding.deliveryMode !== "raw_and_wake" || binding.wakeJobId === null
          || binding.wakeScheduledAt === null
          || binding.completedAt.getTime() !== binding.wakeScheduledAt.getTime()))
    || (binding.messageId === null) !== (binding.messagePublishedAt === null)
    || binding.deliveryMode !== "raw" && binding.deliveryMode !== "raw_and_wake"
    || task.resultDelivery !== binding.deliveryMode || task.callingRoomId !== binding.destinationRoomId
    || binding.destinationRoomId === null || binding.destinationNamespaceId === null
    || binding.messageOperationId !== protectedTaskRunMessageOperationId(run.id)
    || !Number.isSafeInteger(binding.acceptedPolicyRevision) || binding.acceptedPolicyRevision < 1) return null;
  return Object.freeze({
    taskId: task.id, taskRunId: run.id, requesterUserId: task.requesterUserId,
    agentId: task.agentId, contentNamespaceId: task.contentNamespaceId,
    representation: task.representation, bindingId: binding.bindingId,
    resultObjectId: binding.resultObjectId, resultRevision: 2,
    acceptedPolicyRevision: binding.acceptedPolicyRevision,
    terminalAt: new Date(task.cancelledAt), attachedAt: new Date(binding.resultAttachedAt),
    destinationRoomId: binding.destinationRoomId, destinationNamespaceId: binding.destinationNamespaceId,
    messageOperationId: binding.messageOperationId,
  });
}

export function sameProtectedTaskTerminalMessageIntent(
  left: ProtectedTaskTerminalMessageIntent, right: ProtectedTaskTerminalMessageIntent,
): boolean {
  const { terminalAt: lt, attachedAt: la, ...l } = left;
  const { terminalAt: rt, attachedAt: ra, ...r } = right;
  return lt.getTime() === rt.getTime() && la.getTime() === ra.getTime()
    && Object.keys(l).length === Object.keys(r).length
    && (Object.keys(l) as (keyof typeof l)[]).every(key => l[key] === r[key]);
}

export type ProtectedTaskTerminalMessageDestination = Readonly<{
  sessionId: string;
  sessionOwnerId: string;
  graphThreadId: string;
}>;

/** Call only inside the canonical destination Namespace authority transaction. */
export async function resolveProtectedTaskTerminalMessageDestination(
  tx: ProductTx, intent: Pick<ProtectedTaskTerminalMessageIntent,
    "requesterUserId" | "agentId" | "destinationRoomId" | "destinationNamespaceId">,
): Promise<ProtectedTaskTerminalMessageDestination | null> {
  const [room] = await tx.select({
    id: rooms.id, ownerId: rooms.ownerId, namespaceId: rooms.namespaceId,
    graphThreadId: rooms.graphThreadId, archivedAt: rooms.archivedAt,
  }).from(rooms).where(eq(rooms.id, intent.destinationRoomId)).limit(1).for("share");
  if (!room || room.namespaceId !== intent.destinationNamespaceId || room.archivedAt !== null) return null;
  const members = await tx.select({
    actorKind: actors.kind, actorAgentId: actors.agentId, actorOwnerId: actors.ownerId,
  }).from(roomMembers).innerJoin(actors, eq(actors.id, roomMembers.actorId))
    .where(eq(roomMembers.roomId, room.id)).for("share");
  if (!members.some(member => member.actorKind === "user" && member.actorOwnerId === intent.requesterUserId)
    || !members.some(member => member.actorKind === "user" && member.actorOwnerId === room.ownerId)) return null;
  const graphThreadId = deriveProtectedTaskDeliveryGraphThreadId({
    roomId: room.id, roomGraphThreadId: room.graphThreadId,
    targetAgentId: intent.agentId, members,
  });
  if (graphThreadId === null) return null;
  let [session] = await tx.select({
    id: sessions.id, ownerId: sessions.ownerId, agentId: sessions.agentId,
    roomId: sessions.roomId, threadId: sessions.threadId,
    personaId: sessions.personaId,
  }).from(sessions).where(and(eq(sessions.ownerId, room.ownerId),
    eq(sessions.threadId, graphThreadId))).limit(1).for("share");
  if (session === undefined) {
    await tx.insert(sessions).values({
      ownerId: room.ownerId, agentId: intent.agentId, roomId: room.id,
      threadId: graphThreadId, personaId: "owner", title: null,
    }).onConflictDoNothing({ target: [sessions.ownerId, sessions.threadId] });
    [session] = await tx.select({
      id: sessions.id, ownerId: sessions.ownerId, agentId: sessions.agentId,
      roomId: sessions.roomId, threadId: sessions.threadId,
      personaId: sessions.personaId,
    }).from(sessions).where(and(eq(sessions.ownerId, room.ownerId),
      eq(sessions.threadId, graphThreadId))).limit(1).for("share");
  }
  return session?.ownerId === room.ownerId && session.agentId === intent.agentId
    && session.roomId === room.id && session.threadId === graphThreadId
    && session.personaId === "owner"
    ? Object.freeze({ sessionId: session.id, sessionOwnerId: session.ownerId, graphThreadId }) : null;
}

/** The guard cannot escape the exact canonical authority-held transaction. */
export function createProtectedTaskTerminalMessageProductGuard(input: Readonly<{
  transaction: CanonicalTranscriptTx;
  intent: ProtectedTaskTerminalMessageIntent;
  destination: ProtectedTaskTerminalMessageDestination;
  publicationPolicyRevision: number;
  isActive(): boolean;
}>): ConversationProductPublicationGuard {
  const reject = (): never => { throw new TypeError("Terminal Task Message publication authority changed"); };
  return Object.freeze<ConversationProductPublicationGuard>({
    async assertPublicationAllowed(tx, operation) {
      if (!input.isActive() || tx !== input.transaction || operation.sessionId !== input.destination.sessionId
        || operation.revision !== 0 || input.publicationPolicyRevision < input.intent.acceptedPolicyRevision) reject();
      const current = await readProtectedTaskTerminalMessageIntent(tx, input.intent);
      if (current === null || !sameProtectedTaskTerminalMessageIntent(input.intent, current)) return reject();
      const destination = await resolveProtectedTaskTerminalMessageDestination(tx, current);
      if (destination === null || destination.sessionId !== input.destination.sessionId
        || destination.sessionOwnerId !== input.destination.sessionOwnerId
        || destination.graphThreadId !== input.destination.graphThreadId) reject();
      if (operation.action === "appendAllocated") {
        if (operation.idempotencyKey !== current.messageOperationId || operation.authorRole !== "assistant"
          || operation.keyClass !== "ai" || operation.publicationPolicy?.expectedRevision !== input.publicationPolicyRevision
          || operation.publicationPolicy.representation !== (current.representation === "protected"
            ? "protected_only" : "ordinary_and_protected")) reject();
      } else {
        const [revision] = await tx.select().from(sessionMessageCryptoRevisions)
          .where(and(eq(sessionMessageCryptoRevisions.sessionId, operation.sessionId),
            eq(sessionMessageCryptoRevisions.messageId, operation.messageId),
            eq(sessionMessageCryptoRevisions.editRevision, operation.revision))).limit(1);
        if (revision === undefined || revision.appendIdempotencyKey !== current.messageOperationId
          || revision.roomId !== current.destinationRoomId || revision.namespaceIdAtAllocation !== current.destinationNamespaceId
          || revision.representationMode !== (current.representation === "protected" ? "full_encryption" : "shadow_encryption")
          || revision.publicationPolicyRevision !== (current.representation === "protected" ? input.publicationPolicyRevision : null)
          || revision.authorRole !== "assistant" || revision.keyClass !== "ai" || revision.objectIdScheme !== "message_v2") reject();
        if (current.representation === "protected") {
          const rows = await tx.select({ id: sessionMessages.id }).from(sessionMessages).where(and(
            eq(sessionMessages.id, operation.messageId), eq(sessionMessages.sessionId, operation.sessionId),
            isNull(sessionMessages.content), isNull(sessionMessages.toolCalls), isNull(sessionMessages.toolName),
          )).limit(1);
          if (rows.length !== 1) reject();
        }
      }
    },
    async recordMappedPublication(tx, operation) {
      if (!input.isActive() || tx !== input.transaction || operation.idempotencyKey !== input.intent.messageOperationId) reject();
      const recorded = await recordTaskRunMessageAssociationInTx(tx, {
        taskId: input.intent.taskId, taskRunId: input.intent.taskRunId,
        sessionId: input.destination.sessionId, expectedThreadId: input.destination.graphThreadId,
        messageId: operation.messageId, publishedRevision: operation.revision,
        kind: "raw_delivery", publicationKey: input.intent.messageOperationId,
        expectedDestinationRoomId: input.intent.destinationRoomId,
        expectedDestinationNamespaceId: input.intent.destinationNamespaceId,
      });
      if (recorded.status === "rejected") reject();
    },
  });
}

/** Renew only a pristine Full allocation while the matching crypto absence fence lives. */
export async function refreshUnstagedProtectedTaskTerminalMessagePolicy(input: Readonly<{
  transaction: CanonicalTranscriptTx;
  intent: ProtectedTaskTerminalMessageIntent;
  sessionId: string;
  messageId: number;
  objectId: string;
  createdAt: number;
  allocationRequestDigest: Uint8Array;
  expectedPolicyRevision: number;
  nextPolicyRevision: number;
  unstagedAuthority: UnstagedTaskTerminalMessageAuthority;
}>): Promise<"refreshed" | "exact_replay" | "conflict"> {
  const assertUnstaged = () => assertUnstagedTaskTerminalMessageAuthority(input.unstagedAuthority, {
    requestId: `task-run-delivery-message-authorization:${input.intent.taskRunId}`,
    objectId: input.objectId,
  });
  assertUnstaged();
  if (input.intent.representation !== "protected"
    || !Number.isSafeInteger(input.expectedPolicyRevision)
    || !Number.isSafeInteger(input.nextPolicyRevision)
    || input.expectedPolicyRevision < input.intent.acceptedPolicyRevision
    || input.nextPolicyRevision < input.expectedPolicyRevision
    || input.allocationRequestDigest.length !== 32) return "conflict";
  const tx = input.transaction;
  const currentIntent = await readProtectedTaskTerminalMessageIntent(tx, input.intent);
  if (currentIntent === null || !sameProtectedTaskTerminalMessageIntent(input.intent, currentIntent)) return "conflict";
  const policy = await acquireEncryptionConsumptionFence(tx);
  if (policy.mode !== "encrypted_only" || policy.revision !== input.nextPolicyRevision) return "conflict";
  const destination = await resolveProtectedTaskTerminalMessageDestination(tx, currentIntent);
  if (destination?.sessionId !== input.sessionId) return "conflict";
  // Generic Message mapping uses this order. Keep allocation identity/digest
  // intact: a fresh append would change its digest and create a conflict.
  const [message] = await tx.select().from(sessionMessages).where(and(
    eq(sessionMessages.id, input.messageId), eq(sessionMessages.sessionId, input.sessionId),
  )).limit(1).for("update");
  if (message === undefined || message.editRevision !== 0 || message.role !== "assistant"
    || message.createdAt.getTime() !== input.createdAt || message.cryptoObjectId !== null
    || message.content !== null || message.toolCalls !== null || message.toolName !== null) return "conflict";
  const [revision] = await tx.select().from(sessionMessageCryptoRevisions).where(and(
    eq(sessionMessageCryptoRevisions.sessionId, input.sessionId),
    eq(sessionMessageCryptoRevisions.messageId, input.messageId),
    eq(sessionMessageCryptoRevisions.editRevision, 0),
  )).limit(1).for("update");
  if (revision === undefined || revision.cryptoObjectId !== input.objectId
    || revision.objectIdScheme !== "message_v2" || revision.payloadVersion !== 2
    || revision.roomId !== currentIntent.destinationRoomId
    || revision.namespaceIdAtAllocation !== currentIntent.destinationNamespaceId
    || revision.appendIdempotencyKey !== currentIntent.messageOperationId
    || revision.authorRole !== "assistant" || revision.keyClass !== "ai"
    || revision.representationMode !== "full_encryption"
    || revision.completion !== "pending" || revision.disposition !== "active"
    || revision.cryptoCompletedAt !== null || revision.leaseToken !== null
    || revision.repairIdentityDigest !== null || revision.shadowOperationId !== null
    || revision.humanPeerShadowOperationId !== null || revision.sharedAgentShadowOperationId !== null
    || revision.sharedAgentShadowExecutionId !== null
    || revision.allocationRequestDigest.length !== input.allocationRequestDigest.length
    || revision.allocationRequestDigest.some((byte, index) => byte !== input.allocationRequestDigest[index])) return "conflict";
  if (revision.publicationPolicyRevision === input.nextPolicyRevision) return "exact_replay";
  if (revision.publicationPolicyRevision !== input.expectedPolicyRevision) return "conflict";
  assertUnstaged();
  const updated = await tx.update(sessionMessageCryptoRevisions).set({
    publicationPolicyRevision: input.nextPolicyRevision,
    updatedAt: sql`greatest(${sessionMessageCryptoRevisions.updatedAt}, CURRENT_TIMESTAMP)`,
  }).where(and(eq(sessionMessageCryptoRevisions.sessionId, input.sessionId),
    eq(sessionMessageCryptoRevisions.messageId, input.messageId),
    eq(sessionMessageCryptoRevisions.editRevision, 0),
    eq(sessionMessageCryptoRevisions.publicationPolicyRevision, input.expectedPolicyRevision),
    eq(sessionMessageCryptoRevisions.completion, "pending"),
    eq(sessionMessageCryptoRevisions.disposition, "active"),
  )).returning({ id: sessionMessageCryptoRevisions.messageId });
  if (updated.length !== 1) throw new Error("Pending terminal Message policy lost its allocation");
  assertUnstaged();
  return "refreshed";
}
