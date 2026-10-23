import {
  and, eq, sessionMessages,
  sessionMessageCryptoRevisions, type DirectDatabase,
} from "@nautilo/db";
import {
  deriveMessageCryptoObjectIdV2, type ConversationRevisionLifecycle,
} from "@nautilo/lattice-bridge";

type CanonicalTx = Parameters<Parameters<DirectDatabase["transaction"]>[0]>[0];

export type ProtectedTaskMessageAllocationPhase =
  | "pristine"
  | "staged_or_mapped";

export type LockedProtectedTaskMessageAllocation = Readonly<{
  lifecycle: ConversationRevisionLifecycle;
  createdAt: number;
}>;

export type ProtectedTaskMessageExpectedCoordinate = Readonly<{
  messageId: number;
  revision: 0;
  objectId: string;
  createdAt: number;
  publicationPolicyRevision: number;
}>;

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length
    && left.every((value, index) => value === right[index]);
}

function timestamp(value: unknown): number | null {
  if (!(value instanceof Date)) return null;
  const result = value.getTime();
  return Number.isSafeInteger(result) && result >= 0 ? result : null;
}

/**
 * Locks and proves the fixed Task delivery allocation. The
 * `staged_or_mapped` phase admits both the pre-mapping product state and its
 * exact completed/mapped successor because immutable crypto staging lives in
 * the isolated crypto transaction.
 */
export async function lockExactProtectedTaskMessageAllocation(
  input: Readonly<{
    transaction: CanonicalTx;
    intent: Readonly<{
      representation: "protected" | "dual";
      acceptedPolicyRevision: number;
      destinationRoomId: string;
      destinationNamespaceId: string;
      messageOperationId: string;
    }>;
    shadowContentMatches(content: string): boolean;
    sessionId: string;
    expectedPayloadDigest: Uint8Array;
    phase: ProtectedTaskMessageAllocationPhase;
    expected?: ProtectedTaskMessageExpectedCoordinate;
  }>,
): Promise<LockedProtectedTaskMessageAllocation | null> {
  const { transaction, intent, sessionId, expected } = input;
  const identities = await transaction.select({
    sessionId: sessionMessageCryptoRevisions.sessionId,
    messageId: sessionMessageCryptoRevisions.messageId,
  }).from(sessionMessageCryptoRevisions).where(eq(
    sessionMessageCryptoRevisions.appendIdempotencyKey,
    intent.messageOperationId,
  )).limit(2);
  if (identities.length === 0) return null;
  if (identities.length !== 1) {
    throw new TypeError("Task Message allocation identity is ambiguous");
  }
  const identity = identities[0]!;
  if (identity.sessionId !== sessionId) {
    throw new TypeError("Task Message allocation Session changed");
  }
  const messageId = identity.messageId;
  if (expected !== undefined && messageId !== expected.messageId) {
    throw new TypeError("Task Message allocation coordinate changed");
  }

  // Generic Message mapping takes the Message row before its lifecycle row.
  const messages = await transaction.select({
    id: sessionMessages.id, sessionId: sessionMessages.sessionId,
    role: sessionMessages.role, content: sessionMessages.content,
    toolCalls: sessionMessages.toolCalls, toolName: sessionMessages.toolName,
    fingerprint: sessionMessages.fingerprint,
    humanTurnId: sessionMessages.humanTurnId,
    cryptoObjectId: sessionMessages.cryptoObjectId,
    createdAt: sessionMessages.createdAt, editedAt: sessionMessages.editedAt,
    editRevision: sessionMessages.editRevision,
    transcriptOrigin: sessionMessages.transcriptOrigin,
    parentThreadId: sessionMessages.parentThreadId,
    scopeId: sessionMessages.scopeId,
    subthreadRoomId: sessionMessages.subthreadRoomId,
    replyToMessageId: sessionMessages.replyToMessageId,
    metadata: sessionMessages.metadata,
  }).from(sessionMessages).where(and(
    eq(sessionMessages.id, messageId),
    eq(sessionMessages.sessionId, sessionId),
  )).limit(2).for("update");
  const revisions = await transaction.select()
    .from(sessionMessageCryptoRevisions).where(and(
      eq(sessionMessageCryptoRevisions.sessionId, sessionId),
      eq(sessionMessageCryptoRevisions.messageId, messageId),
      eq(sessionMessageCryptoRevisions.editRevision, 0),
    )).limit(2).for("update");
  const message = messages[0];
  const lifecycle = revisions[0];
  const full = intent.representation === "protected";
  const createdAt = timestamp(message?.createdAt);
  const lifecycleCreatedAt = timestamp(lifecycle?.createdAt);
  const lifecycleUpdatedAt = timestamp(lifecycle?.updatedAt);
  const nextAttemptAt = timestamp(lifecycle?.nextAttemptAt);
  const completedAt = timestamp(lifecycle?.cryptoCompletedAt);
  const objectId = deriveMessageCryptoObjectIdV2({
    sessionId, messageId, revision: 0,
  });
  const pristine = lifecycle?.completion === "pending"
    && lifecycle.disposition === "active"
    && lifecycle.parityStatus === "pending"
    && lifecycle.cryptoCompletedAt === null
    && nextAttemptAt !== null
    && message?.cryptoObjectId === null;
  const completed = lifecycle?.completion === "complete"
    && (lifecycle.disposition === "active"
      || lifecycle.disposition === "mapped")
    && lifecycle.parityStatus === (full ? "server_authenticated" : "server_verified")
    && lifecycle.cryptoCompletedAt !== null
    && (lifecycle.disposition === "active"
      ? nextAttemptAt !== null : lifecycle.nextAttemptAt === null)
    && message?.cryptoObjectId === (lifecycle.disposition === "mapped"
      ? objectId : null);

  if (messages.length !== 1 || revisions.length !== 1
    || message === undefined || lifecycle === undefined
    || message.id !== messageId || message.sessionId !== sessionId
    || message.role !== "assistant"
    || (full ? message.content !== null
      : typeof message.content !== "string" || !input.shadowContentMatches(message.content))
    || message.toolCalls !== null || message.toolName !== null
    || message.fingerprint !== null || message.humanTurnId !== null
    || message.editRevision !== 0 || message.editedAt !== null
    || message.transcriptOrigin !== "subagent"
    || message.parentThreadId !== null || message.scopeId !== null
    || message.subthreadRoomId !== null || message.replyToMessageId !== null
    || message.metadata !== null
    || createdAt === null || lifecycleCreatedAt === null
    || lifecycleUpdatedAt === null || lifecycleUpdatedAt < lifecycleCreatedAt
    || !Number.isSafeInteger(lifecycle.sequence) || lifecycle.sequence < 1
    || lifecycle.sessionId !== sessionId || lifecycle.messageId !== messageId
    || lifecycle.editRevision !== 0 || lifecycle.cryptoObjectId !== objectId
    || lifecycle.roomId !== intent.destinationRoomId
    || lifecycle.namespaceIdAtAllocation !== intent.destinationNamespaceId
    || lifecycle.objectIdScheme !== "message_v2"
    || lifecycle.payloadVersion !== 2
    || lifecycle.representationMode !== (full
      ? "full_encryption" : "shadow_encryption")
    || lifecycle.publicationPolicyRevision !== (full
      ? expected?.publicationPolicyRevision
        ?? lifecycle.publicationPolicyRevision
      : null)
    || full && (lifecycle.publicationPolicyRevision === null
      || lifecycle.publicationPolicyRevision < intent.acceptedPolicyRevision)
    || lifecycle.appendIdempotencyKey !== intent.messageOperationId
    || lifecycle.authorRole !== "assistant" || lifecycle.keyClass !== "ai"
    || lifecycle.subthreadReplyClassification !== "excluded"
    || lifecycle.shadowOperationId !== null
    || lifecycle.humanPeerShadowOperationId !== null
    || lifecycle.sharedAgentShadowOperationId !== null
    || lifecycle.sharedAgentShadowExecutionId !== null
    || lifecycle.shadowTranscriptOrdinal !== null
    || lifecycle.shadowReservedCreatedAt !== null
    || lifecycle.shadowStreamId !== null
    || lifecycle.shadowStreamStartDigest !== null
    || lifecycle.shadowStreamTerminalDigest !== null
    || lifecycle.shadowStreamedTextDigest !== null
    || lifecycle.shadowDurableEventDigest !== null
    || lifecycle.leaseToken !== null || lifecycle.leaseExpiresAt !== null
    || lifecycle.failureCode !== null
    || lifecycle.repairIdentityDigest !== null
    || lifecycle.repairSourceRevision !== null
    || lifecycle.repairSourceDigest !== null
    || lifecycle.repairPublisherKind !== null
    || lifecycle.repairPublisherId !== null
    || lifecycle.repairPublisherHumanId !== null
    || lifecycle.repairAttestationDigest !== null
    || lifecycle.terminalOperationId !== null
    || lifecycle.terminalOperationGroupId !== null
    || lifecycle.terminalOperationType !== null
    || lifecycle.terminalExpectedRevision !== null
    || lifecycle.terminalRequestDigest !== null
    || lifecycle.quarantineLeaseToken !== null
    || lifecycle.deleteWasUnread !== null
    || lifecycle.deleteOrphanedTurnId !== null
    || lifecycle.deleteRootParentRoomId !== null
    || lifecycle.deleteRootAnchorMessageId !== null
    || lifecycle.deleteRootReplyCount !== null
    || lifecycle.deleteRootLastReplyAt !== null
    || lifecycle.deleteRootSummaryRevision !== null
    || lifecycle.attemptCount !== 0
    || (lifecycle.cryptoCompletedAt === null
      ? completedAt !== null
      : completedAt === null || completedAt < lifecycleCreatedAt
        || completedAt > lifecycleUpdatedAt)
    || !sameBytes(lifecycle.allocationRequestDigest,
      input.expectedPayloadDigest)
    || (input.phase === "pristine" ? !pristine : !pristine && !completed)
    || expected !== undefined && (expected.revision !== 0
      || expected.objectId !== objectId || expected.createdAt !== createdAt)) {
    throw new TypeError("Task Message allocation is not exact");
  }
  return Object.freeze({
    lifecycle: Object.freeze({ ...lifecycle, revision: 0,
      allocationRequestDigest: lifecycle.allocationRequestDigest.slice() }),
    createdAt,
  });
}
