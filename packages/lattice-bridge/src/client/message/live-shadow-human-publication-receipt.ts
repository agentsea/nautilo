import type {
  FullEncryptionMessagePreparedRequestV2,
  LiveShadowMessagePreparedRequestV1,
} from "@nautilo/api-client/browser";
import {
  decodeHumanAiReadableLiveShadowMessagePlan,
} from "@nautilo/lattice-crypto";
import {
  decodeHumanPeerLiveShadowMessagePlanV1,
  decodeSharedAgentLiveShadowMessagePlanV1,
} from "@nautilo/lattice-crypto/wire";
import type { ProtectedMessageDtoV2 } from "@nautilo/types";
import type { ClientProfileCoordinates } from "../../client-vault/types.ts";
import { deriveLiveShadowMessageCryptoObjectIdV1 } from "../../message/conversation-repository.ts";

type Publication = Readonly<{
  request: LiveShadowMessagePreparedRequestV1
    | FullEncryptionMessagePreparedRequestV2;
  roomId: string;
  coordinates: ClientProfileCoordinates;
}>;
type Plan = ReturnType<typeof decodeHumanPeerLiveShadowMessagePlanV1>
  | ReturnType<typeof decodeSharedAgentLiveShadowMessagePlanV1>
  | ReturnType<typeof decodeHumanAiReadableLiveShadowMessagePlan>;

function withOwnedPlan(input: Publication, use: (plan: Plan) => boolean): boolean {
  let bytes: Uint8Array | undefined;
  let plan: Plan | undefined;
  try {
    if (!("authorizationScheme" in input.request)) return false;
    const value = input.request.planBytesBase64url;
    bytes = Uint8Array.from(atob(value.replaceAll("-", "+").replaceAll("_", "/")
      + "=".repeat((4 - value.length % 4) % 4)), (character) => character.charCodeAt(0));
    switch (input.request.authorizationScheme) {
      case "human_peer_v1": plan = decodeHumanPeerLiveShadowMessagePlanV1(bytes); break;
      case "shared_agent_v1": plan = decodeSharedAgentLiveShadowMessagePlanV1(bytes); break;
      case "human_ai_readable_v1":
      case "human_ai_readable_v2":
        plan = decodeHumanAiReadableLiveShadowMessagePlan(bytes);
        if ((plan.formatVersion === 2)
          !== (input.request.authorizationScheme === "human_ai_readable_v2")) return false;
        break;
      default: return false;
    }
    // This is proof of a past publication, not a fresh admission: do not apply
    // the plan's short send deadline again. Its original identity stays exact.
    return plan.operationId === input.request.operationId
      && plan.roomId === input.roomId
      && plan.subjectHumanId === input.coordinates.humanActorId
      && plan.committerDeviceId === input.coordinates.deviceId
      && use(plan);
  } catch {
    return false;
  } finally {
    bytes?.fill(0);
    plan?.namespaceHeadDigest.fill(0);
    plan?.namespacePublicationDigest.fill(0);
    plan?.namespacePublicationSetDigest.fill(0);
    plan?.namespaceAudienceFingerprint.fill(0);
  }
}

export function isOwnedHumanPublication(input: Publication): boolean {
  return withOwnedPlan(input, () => true);
}

/** A Human outbox owns this exact publication, not the Agent's later outcome. */
export function matchesHumanPublicationReceipt(input: Publication & Readonly<{
  protectedMessage: ProtectedMessageDtoV2;
}>): boolean {
  return withOwnedPlan(input, (plan) => {
    const { projection, protectedPayload } = input.protectedMessage;
    return input.protectedMessage.dtoVersion === 2
      && projection.messageId === String(plan.humanMessageId)
      && projection.sessionId === plan.sessionId
      && projection.roomId === plan.roomId
      && projection.namespaceId === plan.namespaceId
      && projection.role === plan.role
      && projection.createdAt === new Date(plan.createdAt).toISOString()
      && projection.editRevision === plan.revision
      && projection.authorAgentId === undefined
      && (projection.sourceUserId === undefined
        || projection.sourceUserId === input.coordinates.userId)
      && protectedPayload.status === "encrypted"
      && protectedPayload.payloadVersion === 2
      && protectedPayload.keyClass === plan.keyClass
      && protectedPayload.cryptoObjectId === deriveLiveShadowMessageCryptoObjectIdV1({
        operationId: plan.operationId,
        sessionId: plan.sessionId,
        messageId: plan.humanMessageId,
        revision: plan.revision,
        transcriptOrdinal: plan.transcriptOrdinal,
        authorRole: "user",
      })
      && protectedPayload.encryptedPayloadBytesBase64url
        === input.request.encryptedPayloadBytesBase64url
      && protectedPayload.accessManifestBytesBase64url
        === input.request.accessManifestBytesBase64url
      && protectedPayload.namespaceEnvelopeBytesBase64url
        === input.request.namespaceEnvelopeBytesBase64url;
  });
}
