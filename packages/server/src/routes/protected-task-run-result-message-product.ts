import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import {
  acquireEncryptionConsumptionFence, and, eq, rooms, sessions,
  protectedTaskRunMessageOperationId, protectedTaskRunOutputBindingId,
  recordTaskRunMessageAssociationInTx, recordProtectedTaskRunMessagePublished,
} from "@nautilo/db";
import {
  assertAuthenticNativeProtectedTaskRunResultMessageSourceV1,
  assertVerifiedStagedTaskRunResultMessagePublication,
  type ConversationProductPublicationGuard,
  type NativeProtectedTaskRunResultMessageSourceV1,
  type NativeTaskRunResultMessageCurrentAuthority,
  type VerifiedStagedTaskRunResultMessagePublication,
} from "@nautilo/lattice-bridge/server";
import type { ConversationProductAppendInput } from "@nautilo/lattice-bridge";
import type { CanonicalTranscriptTx } from "@nautilo/trust";
import type { ProtectedTaskOutputReadClosedProof } from "./protected-task-output-read-product";
import { lockExactProtectedTaskRunResultMessageAllocation } from
  "./protected-task-run-result-message-allocation";

export type ProtectedTaskRunResultMessageAuthorization =
  | Readonly<{ kind: "source"; source: NativeProtectedTaskRunResultMessageSourceV1 }>
  | Readonly<{ kind: "staged"; proof: VerifiedStagedTaskRunResultMessagePublication;
    currentAuthority: NativeTaskRunResultMessageCurrentAuthority }>;

export type ProtectedTaskRunResultMessageProductInput = Readonly<{
  transaction: CanonicalTranscriptTx;
  intent: ProtectedTaskOutputReadClosedProof;
  destinationNamespaceId: string;
  publicationPolicyRevision: number;
  authorization: ProtectedTaskRunResultMessageAuthorization;
  /** Re-run both canonical proof phases on this same held transaction. */
  revalidate(transaction: CanonicalTranscriptTx): Promise<ProtectedTaskOutputReadClosedProof | null>;
}>;

function reject(): never {
  throw new TypeError("Task result Message product authority changed");
}
function fingerprint(value: ProtectedTaskOutputReadClosedProof): string {
  return JSON.stringify([value.requesterUserId, value.requesterHumanId,
    value.agentId, value.contentNamespaceId, value.representation,
    value.expectedPolicyRevision, value.acceptedPolicyRevision,
    value.result.taskId, value.result.taskRunId, value.result.terminalStatus,
    value.result.contentRevision, value.result.objectId,
    value.result.cryptoAccessRevision, bytesToHex(value.result.genesisManifestHash),
    value.result.signerAgentId, value.invocation.kind, value.invocation.bindingId,
    value.invocation.operationId, value.invocation.roomId, value.invocation.sessionId]);
}

/** Authenticate the closed source or immutable staging token before touching product state. */
export function assertProtectedTaskRunResultMessageAuthorization(
  input: ProtectedTaskRunResultMessageProductInput,
): void {
  const { intent: p, authorization: a } = input;
  const r = p.result;
  const i = p.invocation;
  if (i.kind !== "raw" || r.contentRevision !== 1 || r.terminalStatus === "cancelled"
    || r.signerAgentId !== p.agentId
    || i.bindingId !== protectedTaskRunOutputBindingId(r.taskRunId)
    || i.operationId !== protectedTaskRunMessageOperationId(r.taskRunId)
    || input.publicationPolicyRevision > p.expectedPolicyRevision
    || input.publicationPolicyRevision < p.acceptedPolicyRevision
    || a.kind === "source" && input.publicationPolicyRevision !== p.expectedPolicyRevision
    || a.kind === "staged" && input.publicationPolicyRevision !== a.proof.intent.publicationPolicyRevision) reject();
  if (a.kind === "source") {
    const s = a.source;
    assertAuthenticNativeProtectedTaskRunResultMessageSourceV1(s);
    if (s.requesterHumanId !== p.requesterHumanId
      || s.result.taskId !== r.taskId || s.result.taskRunId !== r.taskRunId
      || s.result.terminalStatus !== r.terminalStatus
      || s.result.contentRevision !== r.contentRevision || s.result.objectId !== r.objectId
      || s.result.cryptoAccessRevision !== r.cryptoAccessRevision
      || s.result.signerAgentId !== p.agentId
      || bytesToHex(s.result.genesisManifestHash) !== bytesToHex(r.genesisManifestHash)
      || s.result.namespace.namespaceId !== p.contentNamespaceId
      || s.result.namespace.expectedPolicyRevision !== p.expectedPolicyRevision
      || s.invocation.bindingId !== i.bindingId || s.invocation.operationId !== i.operationId
      || s.invocation.roomId !== i.roomId || s.invocation.sessionId !== i.sessionId
      || s.messageWrite.namespace.namespaceId !== input.destinationNamespaceId
      || s.messageWrite.namespace.expectedPolicyRevision !== p.expectedPolicyRevision
      || s.messageWrite.signerAgentId !== p.agentId) reject();
  } else {
    assertVerifiedStagedTaskRunResultMessagePublication(a.proof, a.currentAuthority);
    const c = a.currentAuthority;
    if (c.taskId !== r.taskId || c.taskRunId !== r.taskRunId
      || c.bindingId !== i.bindingId || c.messageOperationId !== i.operationId
      || c.sessionId !== i.sessionId || c.roomId !== i.roomId
      || c.namespaceId !== input.destinationNamespaceId
      || c.requesterHumanId !== p.requesterHumanId
      || c.mode !== (p.representation === "protected" ? "encrypted_only" : "shadow_encryption")
      || c.currentPolicyRevision !== p.expectedPolicyRevision
      || c.acceptedPolicyRevision !== p.acceptedPolicyRevision
      || c.resultTerminalStatus !== r.terminalStatus || c.resultContentRevision !== r.contentRevision
      || c.resultObjectId !== r.objectId || c.resultCryptoAccessRevision !== r.cryptoAccessRevision
      || c.resultGenesisManifestHash !== bytesToHex(r.genesisManifestHash)
      || c.resultNamespaceId !== p.contentNamespaceId || a.proof.intent.signerAgentId !== p.agentId) reject();
  }
}

/** Only the borrowed store facade consumes this guard; arbitrary append payloads stay private. */
export function createProtectedTaskRunResultMessageProductGuard(input:
  ProtectedTaskRunResultMessageProductInput & Readonly<{ isActive(): boolean }>,
): ConversationProductPublicationGuard {
  const expected = fingerprint(input.intent);
  const assertCurrent = async (tx: CanonicalTranscriptTx) => {
    if (!input.isActive() || tx !== input.transaction || fingerprint(input.intent) !== expected) reject();
    assertProtectedTaskRunResultMessageAuthorization(input);
    const current = await input.revalidate(tx);
    if (current === null || fingerprint(current) !== expected) reject();
    // The enclosing combined owner already holds these locks. Re-read the actual
    // Room and Session instead of treating the Task-private Namespace as a destination.
    const [room] = await tx.select().from(rooms).where(eq(rooms.id, input.intent.invocation.roomId)).limit(1).for("share");
    const [session] = await tx.select().from(sessions).where(and(
      eq(sessions.id, input.intent.invocation.sessionId),
      eq(sessions.roomId, input.intent.invocation.roomId),
    )).limit(1).for("share");
    const policy = await acquireEncryptionConsumptionFence(tx);
    if (room === undefined || room.archivedAt !== null || room.namespaceId !== input.destinationNamespaceId
      || session === undefined || session.agentId !== input.intent.agentId
      || session.ownerId !== room.ownerId || session.personaId !== "owner"
      || policy.revision !== input.intent.expectedPolicyRevision
      || policy.mode !== (input.intent.representation === "protected" ? "encrypted_only" : "shadow_encryption")) reject();
    assertProtectedTaskRunResultMessageAuthorization(input);
    if (!input.isActive()) reject();
    return session;
  };
  return Object.freeze<ConversationProductPublicationGuard>({
    async assertPublicationAllowed(tx, operation) {
      await assertCurrent(tx);
      if (operation.sessionId !== input.intent.invocation.sessionId || operation.revision !== 0) reject();
      if (operation.action === "appendAllocated") {
        if (input.authorization.kind !== "source"
          || operation.idempotencyKey !== input.intent.invocation.operationId
          || operation.authorRole !== "assistant" || operation.keyClass !== "ai"
          || operation.publicationPolicy?.expectedRevision !== input.publicationPolicyRevision
          || operation.publicationPolicy.representation !== (input.intent.representation === "protected"
            ? "protected_only" : "ordinary_and_protected")) reject();
      } else {
        if (input.authorization.kind !== "staged") return reject();
        const { proof } = input.authorization;
        if (operation.messageId !== proof.intent.messageId) reject();
        const allocation = await lockExactProtectedTaskRunResultMessageAllocation({
          transaction: tx, intent: input.intent, destinationNamespaceId: input.destinationNamespaceId,
          expectedPayloadDigest: hexToBytes(proof.intent.payloadDigest), phase: "staged_or_mapped",
          expected: { messageId: proof.intent.messageId, revision: 0, objectId: proof.intent.objectId,
            createdAt: proof.intent.createdAt, publicationPolicyRevision: proof.intent.publicationPolicyRevision },
        });
        if (allocation === null) reject();
      }
    },
    async recordMappedPublication(tx, operation) {
      const session = await assertCurrent(tx);
      if (input.authorization.kind !== "staged" || operation.revision !== 0
        || operation.messageId !== input.authorization.proof.intent.messageId
        || operation.sessionId !== input.intent.invocation.sessionId
        || operation.idempotencyKey !== input.intent.invocation.operationId) reject();
      const { proof } = input.authorization;
      const allocation = await lockExactProtectedTaskRunResultMessageAllocation({
        transaction: tx, intent: input.intent, destinationNamespaceId: input.destinationNamespaceId,
        expectedPayloadDigest: hexToBytes(proof.intent.payloadDigest), phase: "staged_or_mapped",
        expected: { messageId: proof.intent.messageId, revision: 0, objectId: proof.intent.objectId,
          createdAt: proof.intent.createdAt, publicationPolicyRevision: proof.intent.publicationPolicyRevision },
      });
      if (allocation?.lifecycle.completion !== "complete"
        || allocation.lifecycle.disposition !== "mapped") reject();
      const result = await recordTaskRunMessageAssociationInTx(tx, {
        taskId: input.intent.result.taskId, taskRunId: input.intent.result.taskRunId,
        sessionId: session.id, expectedThreadId: session.threadId,
        messageId: operation.messageId, publishedRevision: 0, kind: "raw_delivery",
        publicationKey: input.intent.invocation.operationId,
        expectedDestinationRoomId: input.intent.invocation.roomId,
        expectedDestinationNamespaceId: input.destinationNamespaceId,
      });
      if (result.status === "rejected") reject();
      const recorded = await recordProtectedTaskRunMessagePublished({ transaction: callback => callback(tx) }, {
        taskId: input.intent.result.taskId, taskRunId: input.intent.result.taskRunId,
        messageId: operation.messageId,
      });
      if (recorded.status === "rejected") reject();
      assertProtectedTaskRunResultMessageAuthorization(input);
      if (!input.isActive()) reject();
    },
  });
}

/** Internal append constructor: callers can supply authority, never a payload. */
export function protectedTaskRunResultMessageAppendInput(
  input: ProtectedTaskRunResultMessageProductInput,
): ConversationProductAppendInput {
  assertProtectedTaskRunResultMessageAuthorization(input);
  if (input.authorization.kind !== "source") reject();
  return Object.freeze<ConversationProductAppendInput>({
    sessionId: input.intent.invocation.sessionId, idempotencyKey: input.intent.invocation.operationId,
    content: input.intent.representation === "protected" ? null : input.authorization.source.payload.content,
    publicationPolicy: { expectedRevision: input.publicationPolicyRevision,
      representation: input.intent.representation === "protected" ? "protected_only" : "ordinary_and_protected" },
    keyClass: "ai", authorRole: "assistant", toolCalls: null, toolName: null,
    fingerprint: null, humanTurnId: null, transcriptOrigin: "subagent",
    parentThreadId: null, scopeId: null, metadata: null, subthreadRoomId: null, replyToMessageId: null,
    notificationContext: { mentionedHumanUserIds: [], causalHumanUserId: null, causalHumanTurnId: null },
    structuralProjection: { notificationEligibility: "excluded", subthreadReplyClassification: "excluded" },
    requestDigest: input.authorization.source.payloadDigest.slice(),
  });
}
