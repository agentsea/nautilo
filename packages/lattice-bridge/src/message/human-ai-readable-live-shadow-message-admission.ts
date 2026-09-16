import {
  authenticateObjectAccessManifestGenesis,
  authorizationRevision,
  cryptoDeviceId,
  encryptedObjectWriteRecord,
  humanId,
  namespaceId,
  objectId,
  unixTimestamp,
  verifyHumanAiReadableLiveShadowMessageRequest,
  verifyHumanAiReadableLiveShadowMessageRequestExactReplay,
  type HumanAiReadableLiveShadowMessagePlan,
  type HumanAiReadableLiveShadowMessageRequest,
  type LatticeCrypto,
  type ResolveCurrentHumanAiReadableDeviceAuthority,
  decodeHumanAiReadableLiveShadowMessagePlan,
  encodeHumanAiReadableLiveShadowMessagePlan,
} from "@nautilo/lattice-crypto";
import {
  decodeEncryptedPayloadV2,
  decodeNamespaceObjectEnvelopeV2,
} from "@nautilo/lattice-crypto/wire";

import {
  CONVERSATION_MESSAGE_OBJECT_TYPE,
  deriveLiveShadowMessageCryptoObjectIdV1,
  type PreparedConversationCryptoRevision,
} from "./conversation-repository.ts";
import { createPreparedConversationCryptoRevision } from
  "./conversation-prepared-revision.ts";
import { decodeMessagePayloadV2 } from "./message-payload-v2.ts";

interface AdmittedHumanAiReadableLiveShadowMessageBase {
  readonly plan: HumanAiReadableLiveShadowMessagePlan;
  readonly prepared: PreparedConversationCryptoRevision;
  readonly requestDigest: Uint8Array;
  readonly plaintextPayloadDigest: Uint8Array;
}
export type AdmittedHumanAiReadableLiveShadowMessageShadow = AdmittedHumanAiReadableLiveShadowMessageBase & Readonly<{ contentRepresentation: "shadow"; ordinaryContent: string; contentVerification: "ordinary_commitment_verified" }>;
export type AdmittedHumanAiReadableLiveShadowMessageFull = AdmittedHumanAiReadableLiveShadowMessageBase & Readonly<{ contentRepresentation: "full"; ordinaryContent: null; contentVerification: "signed_representation_authenticated" }>;
export type AdmittedHumanAiReadableLiveShadowMessage = AdmittedHumanAiReadableLiveShadowMessageShadow | AdmittedHumanAiReadableLiveShadowMessageFull;

interface AdmitHumanAiReadableLiveShadowMessageInputBase {
  readonly crypto: LatticeCrypto;
  readonly expectedPlanBytes: Uint8Array;
  readonly requestBytes: Uint8Array;
  readonly encryptedPayloadBytes: Uint8Array;
  readonly manifestBytes: Uint8Array;
  readonly envelopeBytes: Uint8Array;
  readonly now: number;
  readonly resolveCurrentHumanAuthority:
    ResolveCurrentHumanAiReadableDeviceAuthority;
}
export type AdmitHumanAiReadableLiveShadowMessageShadowInput = AdmitHumanAiReadableLiveShadowMessageInputBase & Readonly<{ contentRepresentation?: "shadow"; ordinaryPayloadBytes: Uint8Array }>;
export type AdmitHumanAiReadableLiveShadowMessageFullInput = AdmitHumanAiReadableLiveShadowMessageInputBase & Readonly<{ contentRepresentation: "full"; ordinaryPayloadBytes?: never }>;
export type AdmitHumanAiReadableLiveShadowMessageInput = AdmitHumanAiReadableLiveShadowMessageShadowInput | AdmitHumanAiReadableLiveShadowMessageFullInput;

export type AdmitHumanAiReadableLiveShadowMessageExactReplayInput =
  (Omit<AdmitHumanAiReadableLiveShadowMessageShadowInput, "now"> | Omit<AdmitHumanAiReadableLiveShadowMessageFullInput, "now">) & Readonly<{ expectedRequestDigest: Uint8Array }>;

function equal(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length
    && left.every((value, index) => value === right[index]);
}

function hashMatches(
  crypto: LatticeCrypto,
  value: Uint8Array,
  expected: Uint8Array,
): boolean {
  const digest = crypto.hash(value);
  try {
    return equal(digest, expected);
  } finally {
    digest.fill(0);
  }
}

function destroyPlan(plan: HumanAiReadableLiveShadowMessagePlan): void {
  plan.namespaceHeadDigest.fill(0);
  plan.namespacePublicationDigest.fill(0);
  plan.namespacePublicationSetDigest.fill(0);
  plan.namespaceAudienceFingerprint.fill(0);
}

function destroyRequest(request: HumanAiReadableLiveShadowMessageRequest): void {
  request.namespaceHeadDigest.fill(0);
  request.namespacePublicationDigest.fill(0);
  request.namespacePublicationSetDigest.fill(0);
  request.namespaceAudienceFingerprint.fill(0);
  request.planDigest.fill(0);
  request.plaintextPayloadDigest.fill(0);
  request.encryptedPayloadDigest.fill(0);
  request.manifestDigest.fill(0);
  request.envelopeDigest.fill(0);
  request.signature.fill(0);
}

/**
 * Authenticate one shared-Room AI-readable Browser sibling without opening it on the
 * server. The device signature binds the complete ordinary/encrypted/object
 * byte closure; recipient Browsers independently open and compare it.
 */
async function admitHumanAiReadableLiveShadowMessageInternal(
  input: AdmitHumanAiReadableLiveShadowMessageInput
    | AdmitHumanAiReadableLiveShadowMessageExactReplayInput,
): Promise<AdmittedHumanAiReadableLiveShadowMessage> {
  const full = input.contentRepresentation === "full";
  if (full && "ordinaryPayloadBytes" in input) throw new TypeError("Full encryption admission forbids an ordinary payload sibling");
  const planBytes = input.expectedPlanBytes.slice();
  const requestBytes = input.requestBytes.slice();
  const ordinaryPayloadBytes = full ? null : input.ordinaryPayloadBytes.slice();
  const encryptedPayloadBytes = input.encryptedPayloadBytes.slice();
  const manifestBytes = input.manifestBytes.slice();
  const envelopeBytes = input.envelopeBytes.slice();
  let plan: HumanAiReadableLiveShadowMessagePlan | undefined;
  let request: HumanAiReadableLiveShadowMessageRequest | undefined;
  let canonicalPlanBytes: Uint8Array | undefined;
  let transferred = false;
  try {
    plan = decodeHumanAiReadableLiveShadowMessagePlan(planBytes);
    canonicalPlanBytes = encodeHumanAiReadableLiveShadowMessagePlan(plan);
    if (!equal(planBytes, canonicalPlanBytes)) {
      throw new TypeError("Human AI-readable live Shadow plan is noncanonical");
    }
    request = "expectedRequestDigest" in input
      ? verifyHumanAiReadableLiveShadowMessageRequestExactReplay(input.crypto, {
        requestBytes,
        expectedRequestDigest: input.expectedRequestDigest,
        resolveCurrentAuthority: input.resolveCurrentHumanAuthority,
      })
      : verifyHumanAiReadableLiveShadowMessageRequest(input.crypto, {
        requestBytes,
        now: unixTimestamp(input.now),
        resolveCurrentAuthority: input.resolveCurrentHumanAuthority,
      });
    const derivedObjectId = deriveLiveShadowMessageCryptoObjectIdV1({
      operationId: plan.operationId,
      sessionId: plan.sessionId,
      messageId: plan.humanMessageId,
      revision: 0,
      transcriptOrdinal: plan.transcriptOrdinal,
      authorRole: "user",
    });
    if (
      request.formatVersion !== plan.formatVersion
      || request.operationId !== plan.operationId
      || request.clientIdempotencyKey !== plan.clientIdempotencyKey
      || request.policyRevision !== plan.policyRevision
      || request.sessionId !== plan.sessionId
      || request.roomId !== plan.roomId
      || request.messageId !== plan.humanMessageId
      || request.revision !== 0
      || request.transcriptOrdinal !== plan.transcriptOrdinal
      || request.role !== "user"
      || request.createdAt !== plan.createdAt
      || request.subjectHumanId !== plan.subjectHumanId
      || request.committerDeviceId !== plan.committerDeviceId
      || request.committerDeviceSigningKeyGeneration
        !== plan.committerDeviceSigningKeyGeneration
      || request.hostAuthorizationRevision !== plan.hostAuthorizationRevision
      || request.cryptoObjectId !== derivedObjectId
      || request.namespaceId !== plan.namespaceId
      || request.keyClass !== "ai"
      || request.namespaceAccessRevision !== plan.namespaceAccessRevision
      || request.namespaceKeyGeneration !== plan.namespaceKeyGeneration
      || !equal(request.namespaceHeadDigest, plan.namespaceHeadDigest)
      || !equal(
        request.namespacePublicationDigest,
        plan.namespacePublicationDigest,
      )
      || !equal(
        request.namespacePublicationSetDigest,
        plan.namespacePublicationSetDigest,
      )
      || !equal(
        request.namespaceAudienceFingerprint,
        plan.namespaceAudienceFingerprint,
      )
      || !hashMatches(input.crypto, canonicalPlanBytes, request.planDigest)
      || (ordinaryPayloadBytes !== null && !hashMatches(
        input.crypto,
        ordinaryPayloadBytes,
        request.plaintextPayloadDigest,
      ))
      || !hashMatches(
        input.crypto,
        encryptedPayloadBytes,
        request.encryptedPayloadDigest,
      )
      || !hashMatches(input.crypto, manifestBytes, request.manifestDigest)
      || !hashMatches(input.crypto, envelopeBytes, request.envelopeDigest)
    ) throw new TypeError("Human AI-readable signed siblings disagree");

    const ordinaryPayload = ordinaryPayloadBytes === null ? null : decodeMessagePayloadV2(ordinaryPayloadBytes);
    if (
      ordinaryPayload !== null && (ordinaryPayload.role !== "user"
      || ordinaryPayload.toolCalls !== undefined)
    ) throw new TypeError("Human AI-readable ordinary payload is not Human text");
    const encryptedPayload = decodeEncryptedPayloadV2(encryptedPayloadBytes);
    const envelope = decodeNamespaceObjectEnvelopeV2(envelopeBytes);
    try {
      if (
        encryptedPayload.context.objectId !== derivedObjectId
        || encryptedPayload.context.objectType
          !== CONVERSATION_MESSAGE_OBJECT_TYPE
        || encryptedPayload.context.keyClass !== "ai"
        || encryptedPayload.context.createdAt !== plan.createdAt
        || envelope.context.objectId !== derivedObjectId
        || envelope.context.namespaceId !== plan.namespaceId
        || envelope.context.keyClass !== "ai"
        || envelope.context.keyGeneration !== plan.namespaceKeyGeneration
        || envelope.context.bindingRevisionAtWrap
          !== plan.namespaceAccessRevision
      ) throw new TypeError("Human AI-readable protected coordinates disagree");
    } finally {
      encryptedPayload.ciphertext.fill(0);
      envelope.wrappedDek.fill(0);
    }

    const access = await authenticateObjectAccessManifestGenesis({
      crypto: input.crypto,
      payloadBytes: encryptedPayloadBytes,
      manifestBytes,
      envelopeBytes: [envelopeBytes],
      resolveCurrentAuthorization: (context) => {
        const publicKey = input.resolveCurrentHumanAuthority(Object.freeze({
          purpose: "human-ai-readable-live-shadow-request-v1-verify",
          subjectHumanId: humanId(plan!.subjectHumanId),
          operationId: plan!.operationId,
          committerDeviceId: cryptoDeviceId(context.committerDeviceId),
          committerDeviceSigningKeyGeneration:
            plan!.committerDeviceSigningKeyGeneration,
          hostAuthorizationRevision: authorizationRevision(
            context.hostAuthorizationRevision,
          ),
        }));
        if (publicKey === null) return null;
        return Object.freeze({
          ...context,
          sourceAuthorized: true,
          targetAuthorized: true,
          currentHostAuthorizationRevision: context.hostAuthorizationRevision,
          committerSigningPublicKey: publicKey,
        });
      },
    });
    const prepared = createPreparedConversationCryptoRevision({
      objectId: objectId(derivedObjectId),
      namespaceId: namespaceId(plan.namespaceId),
      object: encryptedObjectWriteRecord(encryptedPayloadBytes),
      access,
      resolveCurrentAuthorization: async (context) => {
        const publicKey = await Promise.resolve(
          input.resolveCurrentHumanAuthority(Object.freeze({
            purpose: plan!.formatVersion === 2
              ? "human-ai-readable-live-shadow-request-v2-verify"
              : "human-ai-readable-live-shadow-request-v1-verify",
            subjectHumanId: humanId(plan!.subjectHumanId),
            operationId: plan!.operationId,
            committerDeviceId: cryptoDeviceId(context.committerDeviceId),
            committerDeviceSigningKeyGeneration:
              plan!.committerDeviceSigningKeyGeneration,
            hostAuthorizationRevision: authorizationRevision(
              context.hostAuthorizationRevision,
            ),
          })),
        );
        if (publicKey === null) return null;
        return Object.freeze({
          ...context,
          sourceAuthorized: true,
          targetAuthorized: true,
          currentHostAuthorizationRevision: context.hostAuthorizationRevision,
          committerSigningPublicKey: publicKey,
        });
      },
    });
    transferred = true;
    const common = {
      plan,
      prepared,
      requestDigest: input.crypto.hash(requestBytes),
      plaintextPayloadDigest: request.plaintextPayloadDigest.slice(),
    } as const;
    // Authentication does not open the ciphertext. The execution consumer
    // must open/decode it under its grant and compare the signed commitment.
    return ordinaryPayload === null ? Object.freeze({ ...common, contentRepresentation: "full" as const, ordinaryContent: null, contentVerification: "signed_representation_authenticated" as const }) : Object.freeze({ ...common, contentRepresentation: "shadow" as const, ordinaryContent: ordinaryPayload.content, contentVerification: "ordinary_commitment_verified" as const });
  } finally {
    planBytes.fill(0);
    requestBytes.fill(0);
    ordinaryPayloadBytes?.fill(0);
    encryptedPayloadBytes.fill(0);
    manifestBytes.fill(0);
    envelopeBytes.fill(0);
    canonicalPlanBytes?.fill(0);
    if (request !== undefined) destroyRequest(request);
    if (plan !== undefined && !transferred) destroyPlan(plan);
  }
}


export function admitHumanAiReadableLiveShadowMessage(input: AdmitHumanAiReadableLiveShadowMessageShadowInput): Promise<AdmittedHumanAiReadableLiveShadowMessageShadow>;
export function admitHumanAiReadableLiveShadowMessage(input: AdmitHumanAiReadableLiveShadowMessageFullInput): Promise<AdmittedHumanAiReadableLiveShadowMessageFull>;
export function admitHumanAiReadableLiveShadowMessage(input: AdmitHumanAiReadableLiveShadowMessageInput): Promise<AdmittedHumanAiReadableLiveShadowMessage>;
export function admitHumanAiReadableLiveShadowMessage(
  input: AdmitHumanAiReadableLiveShadowMessageInput,
): Promise<AdmittedHumanAiReadableLiveShadowMessage> {
  return admitHumanAiReadableLiveShadowMessageInternal(input);
}

/** Durable-history admission: freshness is replaced by the exact stored digest. */
export function admitHumanAiReadableLiveShadowMessageExactReplay(
  input: AdmitHumanAiReadableLiveShadowMessageExactReplayInput,
): Promise<AdmittedHumanAiReadableLiveShadowMessage> {
  if (input.expectedRequestDigest.length !== 32) {
    throw new TypeError("Human AI-readable replay request digest is invalid");
  }
  return admitHumanAiReadableLiveShadowMessageInternal(input);
}
