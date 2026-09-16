import { PROTECTED_TOP_LEVEL_ROOM_KINDS } from "../../message/protected-room-topology.ts";
import {
  actors, alias, and, eq, inArray, isNull, roomMembers, rooms,
  sessionMessageCryptoRevisions as revisions, sessionMessages, sessions, sql,
  conversationHumanPeerShadowOperations as peerOperations,
  conversationSharedAgentShadowOperations as sharedOperations,
} from "@nautilo/db";
import type { LatticeCrypto, LatticeStorage } from "@nautilo/lattice-crypto";
import {
  decodeHumanAiReadableLiveShadowMessagePlan,
  decodeHumanAiReadableLiveShadowMessageRequest,
} from "@nautilo/lattice-crypto";
import {
  decodeHumanPeerLiveShadowMessagePlanV1,
  decodeHumanPeerLiveShadowMessageRequestV1,
  decodeSharedAgentLiveShadowMessagePlanV1,
  decodeSharedAgentLiveShadowMessageRequestV1,
  decodeNamespaceObjectEnvelopeV2,
} from "@nautilo/lattice-crypto/wire";
import { encodeProtectedMessageDtoV2, parseProtectedMessageDtoV2 } from "@nautilo/types";
import { deriveLiveShadowMessageCryptoObjectIdV1 } from "../../message/conversation-repository.ts";
import {
  assertVerifiedConversationProductPostgresHandle,
  conversationProductTypedDb as db,
  executeTypedConversationProductQuery,
  type ConversationProductPostgresHandle,
} from "./postgres-conversation-product-store.ts";

export type PublishedHumanMessageRecoveryResult =
  | Readonly<{ status: "absent" }>
  | Readonly<{
      status: "human_published";
      representationMode: "shadow_encryption" | "full_encryption";
      operationId: string;
      authorizationScheme: "human_peer_v1" | "shared_agent_v1" | "human_ai_readable_v1" | "human_ai_readable_v2";
      acceptedHumanRequestDigestBase64url: string;
      human: ReturnType<typeof parseProtectedMessageDtoV2>;
    }>;

const absent = Object.freeze({ status: "absent" as const });
const equal = (left: Uint8Array, right: Uint8Array) => left.length === right.length
  && left.every((value, index) => value === right[index]);
const encoded = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64url");
const authorityRoom = alias(rooms, "recovery_authority_room");

/**
 * A read-only receipt for the Human mutation, independent of Agent/Conductor
 * completion. It never re-admits a request, creates a Job, or regenerates bytes.
 * The client must compare this receipt to its authenticated ORIGINAL outbox
 * request before removing that exact entry; absent is not a completion proof.
 */
export async function recoverPostgresPublishedHumanMessage(
  dependencies: Readonly<{
    product: ConversationProductPostgresHandle;
    storage: Pick<LatticeStorage, "getObject" | "getObjectAccessState">;
    crypto: LatticeCrypto;
  }>,
  input: Readonly<{
    authority: Readonly<{ userId: string; humanActorId: string }>;
    roomId: string;
    operationId: string;
  }>,
): Promise<PublishedHumanMessageRecoveryResult> {
  assertVerifiedConversationProductPostgresHandle(dependencies.product);
  for (const family of ["shared", "peer"] as const) {
    const operation = family === "peer" ? peerOperations : sharedOperations;
    const rows = await executeTypedConversationProductQuery(dependencies.product,
      db.select({
        operation_id: operation.operationId,
        session_id: operation.sessionId,
        room_id: operation.roomId,
        namespace_id: operation.namespaceId,
        subject_human_id: operation.subjectHumanId,
        human_message_id: operation.humanMessageId,
        transcript_ordinal: operation.transcriptOrdinal,
        crypto_object_id: operation.cryptoObjectId,
        state: operation.state,
        plan_bytes: operation.planBytes,
        plan_digest: operation.planDigest,
        human_request_bytes: operation.humanRequestBytes,
        human_request_digest: operation.humanRequestDigest,
        protected_message_digest: operation.protectedMessageDigest,
        operation_policy_revision: operation.policyRevision,
        representation_mode: revisions.representationMode,
        publication_policy_revision: revisions.publicationPolicyRevision,
        parity_status: revisions.parityStatus,
        created_at: sessionMessages.createdAt,
      }).from(operation)
        .innerJoin(sessions, and(eq(sessions.id, operation.sessionId), eq(sessions.roomId, operation.roomId)))
        .innerJoin(actors, and(
          eq(actors.id, input.authority.humanActorId), eq(actors.kind, "user"),
          eq(actors.ownerId, input.authority.userId),
          eq(operation.subjectHumanId, sql<string>`${actors.id}::text`),
        ))
        .innerJoin(rooms, and(eq(rooms.id, operation.roomId), eq(rooms.namespaceId, operation.namespaceId)))
        .innerJoin(authorityRoom, and(
          eq(authorityRoom.id, sql<string>`coalesce(${rooms.parentRoomId}, ${rooms.id})`),
          eq(authorityRoom.namespaceId, rooms.namespaceId),
          isNull(authorityRoom.parentRoomId),
          inArray(authorityRoom.kind, [...PROTECTED_TOP_LEVEL_ROOM_KINDS]),
        ))
        .innerJoin(roomMembers, and(eq(roomMembers.roomId, authorityRoom.id), eq(roomMembers.actorId, actors.id)))
        .innerJoin(sessionMessages, and(
          eq(sessionMessages.sessionId, operation.sessionId), eq(sessionMessages.id, operation.humanMessageId),
          eq(sessionMessages.editRevision, 0), eq(sessionMessages.role, "user"),
          eq(sessionMessages.cryptoObjectId, operation.cryptoObjectId),
        ))
        .innerJoin(revisions, and(
          eq(revisions.sessionId, operation.sessionId), eq(revisions.messageId, operation.humanMessageId),
          eq(revisions.editRevision, 0), eq(revisions.roomId, operation.roomId),
          eq(revisions.namespaceIdAtAllocation, operation.namespaceId),
          eq(revisions.cryptoObjectId, operation.cryptoObjectId),
          eq(family === "peer" ? revisions.humanPeerShadowOperationId : revisions.sharedAgentShadowOperationId, operation.operationId),
          eq(revisions.shadowTranscriptOrdinal, operation.transcriptOrdinal),
          eq(revisions.completion, "complete"), eq(revisions.disposition, "mapped"),
          eq(revisions.authorRole, "user"),
          eq(revisions.keyClass, family === "peer" ? "human" : "ai"),
        ))
        .where(and(eq(operation.operationId, input.operationId), eq(operation.roomId, input.roomId), eq(operation.state, "published")))
        .limit(2));
    if (rows.length === 0) continue;
    if (rows.length !== 1) return absent;
    const row = rows[0]!;
    const representationMode = row.representation_mode;
    const publicationPolicyRevision = row.publication_policy_revision;
    if (
      (representationMode !== "shadow_encryption" && representationMode !== "full_encryption")
      || (representationMode === "shadow_encryption" && row.parity_status !== "client_verified")
      || (representationMode === "full_encryption" && row.parity_status !== "client_authenticated")
    ) return absent;
    const planBytes = row.plan_bytes;
    const requestBytes = row.human_request_bytes;
    const requestDigest = row.human_request_digest;
    const planDigest = row.plan_digest;
    const protectedDigest = row.protected_message_digest;
    if (!(planBytes instanceof Uint8Array) || !(requestBytes instanceof Uint8Array)
      || !(requestDigest instanceof Uint8Array) || requestDigest.length !== 32
      || !(planDigest instanceof Uint8Array) || planDigest.length !== 32
      || !(protectedDigest instanceof Uint8Array) || protectedDigest.length !== 32) return absent;
    let object: Awaited<ReturnType<LatticeStorage["getObject"]>> = null;
    let access: Awaited<ReturnType<LatticeStorage["getObjectAccessState"]>> = null;
    try {
      let authorizationScheme: "human_peer_v1" | "shared_agent_v1" | "human_ai_readable_v1" | "human_ai_readable_v2";
      let plan;
      let request;
      if (family === "peer") {
        authorizationScheme = "human_peer_v1";
        plan = decodeHumanPeerLiveShadowMessagePlanV1(planBytes);
        request = decodeHumanPeerLiveShadowMessageRequestV1(requestBytes);
      } else {
        try {
          plan = decodeHumanAiReadableLiveShadowMessagePlan(planBytes);
          authorizationScheme = plan.formatVersion === 2
            ? "human_ai_readable_v2" : "human_ai_readable_v1";
          request = decodeHumanAiReadableLiveShadowMessageRequest(requestBytes);
        } catch {
          plan = decodeSharedAgentLiveShadowMessagePlanV1(planBytes);
          authorizationScheme = "shared_agent_v1";
          request = decodeSharedAgentLiveShadowMessageRequestV1(requestBytes);
        }
      }
      if (row.state !== "published" || row.operation_id !== input.operationId
        || row.room_id !== input.roomId || row.subject_human_id !== input.authority.humanActorId
        || plan.operationId !== input.operationId || request.operationId !== input.operationId
        || plan.roomId !== input.roomId || request.roomId !== input.roomId
        || plan.subjectHumanId !== input.authority.humanActorId || request.subjectHumanId !== plan.subjectHumanId
        || plan.sessionId !== row.session_id || request.sessionId !== plan.sessionId
        || plan.namespaceId !== row.namespace_id || request.namespaceId !== plan.namespaceId
        || plan.humanMessageId !== row.human_message_id || request.messageId !== plan.humanMessageId
        || plan.transcriptOrdinal !== row.transcript_ordinal || request.transcriptOrdinal !== plan.transcriptOrdinal
        || request.cryptoObjectId !== row.crypto_object_id
        || request.cryptoObjectId !== deriveLiveShadowMessageCryptoObjectIdV1({
          operationId: plan.operationId, sessionId: plan.sessionId, messageId: plan.humanMessageId,
          revision: 0, transcriptOrdinal: plan.transcriptOrdinal, authorRole: "user",
        })
        || request.clientIdempotencyKey !== plan.clientIdempotencyKey
        || request.policyRevision !== plan.policyRevision
        || (representationMode === "full_encryption"
          && publicationPolicyRevision !== request.policyRevision)
        || request.committerDeviceId !== plan.committerDeviceId
        || request.committerDeviceSigningKeyGeneration !== plan.committerDeviceSigningKeyGeneration
        || request.hostAuthorizationRevision !== plan.hostAuthorizationRevision
        || request.namespaceAccessRevision !== plan.namespaceAccessRevision
        || request.namespaceKeyGeneration !== plan.namespaceKeyGeneration
        || !equal(request.namespaceHeadDigest, plan.namespaceHeadDigest)
        || !equal(request.namespacePublicationDigest, plan.namespacePublicationDigest)
        || !equal(request.namespacePublicationSetDigest, plan.namespacePublicationSetDigest)
        || !equal(request.namespaceAudienceFingerprint, plan.namespaceAudienceFingerprint)
        || ("recipientAgentId" in plan && (!("recipientAgentId" in request) || request.recipientAgentId !== plan.recipientAgentId))
        || !equal(dependencies.crypto.hash(planBytes), planDigest)
        || !equal(request.planDigest, planDigest)
        || !equal(dependencies.crypto.hash(requestBytes), requestDigest)) return absent;
      [object, access] = await Promise.all([
        dependencies.storage.getObject(request.cryptoObjectId),
        dependencies.storage.getObjectAccessState(request.cryptoObjectId),
      ]);
      if (object === null || access === null || object.objectId !== request.cryptoObjectId
        || access.head.objectId !== request.cryptoObjectId || access.head.accessRevision !== 0) return absent;
      const envelopes = access.namespaceEnvelopes.filter((entry) => entry.namespaceId === plan.namespaceId);
      if (envelopes.length !== 1) return absent;
      const envelope = envelopes[0]!;
      const envelopeContext = decodeNamespaceObjectEnvelopeV2(envelope.envelopeBytes).context;
      if (envelopeContext.namespaceId !== plan.namespaceId
        || envelopeContext.keyGeneration !== plan.namespaceKeyGeneration
        || envelopeContext.bindingRevisionAtWrap !== plan.namespaceAccessRevision) return absent;
      if (!equal(dependencies.crypto.hash(object.payloadBytes), request.encryptedPayloadDigest)
        || !equal(dependencies.crypto.hash(access.head.manifestBytes), request.manifestDigest)
        || !equal(dependencies.crypto.hash(envelope.envelopeBytes), request.envelopeDigest)) return absent;
      const createdAt = row.created_at instanceof Date ? row.created_at : new Date(String(row.created_at));
      if (createdAt.getTime() !== plan.createdAt || request.createdAt !== plan.createdAt) return absent;
      const human = parseProtectedMessageDtoV2({
        dtoVersion: 2,
        projection: { messageId: String(plan.humanMessageId), sessionId: plan.sessionId,
          roomId: plan.roomId, namespaceId: plan.namespaceId, role: "user", editRevision: 0,
          createdAt: createdAt.toISOString() },
        protectedPayload: { status: "encrypted", cryptoObjectId: request.cryptoObjectId,
          payloadVersion: 2, keyClass: family === "peer" ? "human" : "ai",
          encryptedPayloadBytesBase64url: encoded(object.payloadBytes),
          accessManifestBytesBase64url: encoded(access.head.manifestBytes),
          namespaceEnvelopeBytesBase64url: encoded(envelope.envelopeBytes) },
      });
      if (!equal(dependencies.crypto.hash(new TextEncoder().encode(encodeProtectedMessageDtoV2(human))), protectedDigest)) return absent;
      return Object.freeze({ status: "human_published", operationId: input.operationId,
        representationMode, authorizationScheme,
        acceptedHumanRequestDigestBase64url: encoded(requestDigest), human });
    } catch {
      return absent;
    } finally {
      object?.payloadBytes.fill(0);
      access?.head.manifestBytes.fill(0);
      access?.namespaceEnvelopes.forEach((entry) => entry.envelopeBytes.fill(0));
    }
  }
  return absent;
}
