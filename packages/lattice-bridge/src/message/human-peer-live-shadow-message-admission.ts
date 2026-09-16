import {
  authenticateObjectAccessManifestGenesis,
  authorizationRevision,
  cryptoDeviceId,
  encryptedObjectWriteRecord,
  humanId,
  namespaceId,
  objectId,
  unixTimestamp,
  verifyHumanPeerLiveShadowMessageRequest,
  verifyHumanPeerLiveShadowMessageRequestExactReplay,
  type HumanPeerLiveShadowMessagePlan,
  type HumanPeerLiveShadowMessageRequest,
  type LatticeCrypto,
  type ResolveCurrentHumanPeerDeviceAuthority,
} from "@nautilo/lattice-crypto";
import {
  decodeEncryptedPayloadV2,
  decodeHumanPeerLiveShadowMessagePlanV1,
  decodeNamespaceObjectEnvelopeV2,
  encodeHumanPeerLiveShadowMessagePlanV1,
} from "@nautilo/lattice-crypto/wire";

import {
  CONVERSATION_MESSAGE_OBJECT_TYPE,
  deriveLiveShadowMessageCryptoObjectIdV1,
  type PreparedConversationCryptoRevision,
} from "./conversation-repository.ts";
import { createPreparedConversationCryptoRevision } from
  "./conversation-prepared-revision.ts";
import { decodeMessagePayloadV2 } from "./message-payload-v2.ts";

interface AdmittedHumanPeerLiveShadowMessageBase {
  readonly plan: HumanPeerLiveShadowMessagePlan;
  readonly prepared: PreparedConversationCryptoRevision;
  readonly requestDigest: Uint8Array;
  /** Signed commitment; the receiving device must compare it after opening. */
  readonly plaintextPayloadDigest: Uint8Array;
}

export type AdmittedHumanPeerLiveShadowMessageShadow =
  AdmittedHumanPeerLiveShadowMessageBase & Readonly<{
    readonly contentRepresentation: "shadow";
    readonly ordinaryContent: string;
    readonly contentVerification: "ordinary_commitment_verified";
  }>;

export type AdmittedHumanPeerLiveShadowMessageFull =
  AdmittedHumanPeerLiveShadowMessageBase & Readonly<{
    readonly contentRepresentation: "full";
    readonly ordinaryContent: null;
    readonly contentVerification: "signed_representation_authenticated";
  }>;

export type AdmittedHumanPeerLiveShadowMessage =
  | AdmittedHumanPeerLiveShadowMessageShadow
  | AdmittedHumanPeerLiveShadowMessageFull;

interface AdmitHumanPeerLiveShadowMessageInputBase {
  readonly crypto: LatticeCrypto;
  readonly expectedPlanBytes: Uint8Array;
  readonly requestBytes: Uint8Array;
  readonly encryptedPayloadBytes: Uint8Array;
  readonly manifestBytes: Uint8Array;
  readonly envelopeBytes: Uint8Array;
  readonly now: number;
  readonly resolveCurrentHumanAuthority:
    ResolveCurrentHumanPeerDeviceAuthority;
}

export type AdmitHumanPeerLiveShadowMessageShadowInput =
  AdmitHumanPeerLiveShadowMessageInputBase & Readonly<{
    readonly contentRepresentation?: "shadow";
    readonly ordinaryPayloadBytes: Uint8Array;
  }>;

export type AdmitHumanPeerLiveShadowMessageFullInput =
  AdmitHumanPeerLiveShadowMessageInputBase & Readonly<{
    readonly contentRepresentation: "full";
    readonly ordinaryPayloadBytes?: never;
  }>;

export type AdmitHumanPeerLiveShadowMessageInput =
  | AdmitHumanPeerLiveShadowMessageShadowInput
  | AdmitHumanPeerLiveShadowMessageFullInput;

export type AdmitHumanPeerLiveShadowMessageShadowExactReplayInput =
  Omit<AdmitHumanPeerLiveShadowMessageShadowInput, "now"> & Readonly<{
    readonly expectedRequestDigest: Uint8Array;
  }>;

export type AdmitHumanPeerLiveShadowMessageFullExactReplayInput =
  Omit<AdmitHumanPeerLiveShadowMessageFullInput, "now"> & Readonly<{
    readonly expectedRequestDigest: Uint8Array;
  }>;

export type AdmitHumanPeerLiveShadowMessageExactReplayInput =
  | AdmitHumanPeerLiveShadowMessageShadowExactReplayInput
  | AdmitHumanPeerLiveShadowMessageFullExactReplayInput;

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

function destroyPlan(plan: HumanPeerLiveShadowMessagePlan): void {
  plan.namespaceHeadDigest.fill(0);
  plan.namespacePublicationDigest.fill(0);
  plan.namespacePublicationSetDigest.fill(0);
  plan.namespaceAudienceFingerprint.fill(0);
}

function destroyRequest(request: HumanPeerLiveShadowMessageRequest): void {
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
 * Authenticate one Human-only Browser sibling without opening it on the
 * server. The device signature binds the complete ordinary/encrypted/object
 * byte closure; recipient Browsers independently open and compare it.
 */
async function admitHumanPeerLiveShadowMessageInternal(
  input: AdmitHumanPeerLiveShadowMessageInput
    | AdmitHumanPeerLiveShadowMessageExactReplayInput,
): Promise<AdmittedHumanPeerLiveShadowMessage> {
  const full = input.contentRepresentation === "full";
  if (full && "ordinaryPayloadBytes" in input) {
    throw new TypeError(
      "Full encryption admission forbids an ordinary payload sibling",
    );
  }
  const planBytes = input.expectedPlanBytes.slice();
  const requestBytes = input.requestBytes.slice();
  const ordinaryPayloadBytes = full
    ? null
    : input.ordinaryPayloadBytes.slice();
  const encryptedPayloadBytes = input.encryptedPayloadBytes.slice();
  const manifestBytes = input.manifestBytes.slice();
  const envelopeBytes = input.envelopeBytes.slice();
  let plan: HumanPeerLiveShadowMessagePlan | undefined;
  let request: HumanPeerLiveShadowMessageRequest | undefined;
  let canonicalPlanBytes: Uint8Array | undefined;
  let transferred = false;
  try {
    plan = decodeHumanPeerLiveShadowMessagePlanV1(planBytes);
    canonicalPlanBytes = encodeHumanPeerLiveShadowMessagePlanV1(plan);
    if (!equal(planBytes, canonicalPlanBytes)) {
      throw new TypeError("Human-peer live Shadow plan is noncanonical");
    }
    request = "expectedRequestDigest" in input
      ? verifyHumanPeerLiveShadowMessageRequestExactReplay(input.crypto, {
        requestBytes,
        expectedRequestDigest: input.expectedRequestDigest,
        resolveCurrentAuthority: input.resolveCurrentHumanAuthority,
      })
      : verifyHumanPeerLiveShadowMessageRequest(input.crypto, {
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
      request.operationId !== plan.operationId
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
      || request.keyClass !== "human"
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
    ) throw new TypeError("Human-peer signed siblings disagree");

    const ordinaryPayload = ordinaryPayloadBytes === null
      ? null
      : decodeMessagePayloadV2(ordinaryPayloadBytes);
    if (
      ordinaryPayload !== null
      && (ordinaryPayload.role !== "user"
        || ordinaryPayload.toolCalls !== undefined)
    ) throw new TypeError("Human-peer ordinary payload is not Human text");
    const encryptedPayload = decodeEncryptedPayloadV2(encryptedPayloadBytes);
    const envelope = decodeNamespaceObjectEnvelopeV2(envelopeBytes);
    try {
      if (
        encryptedPayload.context.objectId !== derivedObjectId
        || encryptedPayload.context.objectType
          !== CONVERSATION_MESSAGE_OBJECT_TYPE
        || encryptedPayload.context.keyClass !== "human"
        || encryptedPayload.context.createdAt !== plan.createdAt
        || envelope.context.objectId !== derivedObjectId
        || envelope.context.namespaceId !== plan.namespaceId
        || envelope.context.keyClass !== "human"
        || envelope.context.keyGeneration !== plan.namespaceKeyGeneration
        || envelope.context.bindingRevisionAtWrap
          !== plan.namespaceAccessRevision
      ) throw new TypeError("Human-peer protected coordinates disagree");
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
          purpose: "human-peer-live-shadow-request-v1-verify",
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
            purpose: "human-peer-live-shadow-request-v1-verify",
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
    // This admission authenticates the signed protected representation and,
    // in Shadow, the supplied ordinary bytes against their signed commitment.
    // It does not open the ciphertext. A cryptographic consumer must still
    // open/decode it under current device authority, validate the Human role,
    // and compare the opened bytes with the signed plaintext commitment.
    return ordinaryPayload === null
      ? Object.freeze({
        ...common,
        contentRepresentation: "full" as const,
        ordinaryContent: null,
        contentVerification: "signed_representation_authenticated" as const,
      })
      : Object.freeze({
        ...common,
        contentRepresentation: "shadow" as const,
        ordinaryContent: ordinaryPayload.content,
        contentVerification: "ordinary_commitment_verified" as const,
      });
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


export function admitHumanPeerLiveShadowMessage(
  input: AdmitHumanPeerLiveShadowMessageShadowInput,
): Promise<AdmittedHumanPeerLiveShadowMessageShadow>;
export function admitHumanPeerLiveShadowMessage(
  input: AdmitHumanPeerLiveShadowMessageFullInput,
): Promise<AdmittedHumanPeerLiveShadowMessageFull>;
export function admitHumanPeerLiveShadowMessage(
  input: AdmitHumanPeerLiveShadowMessageInput,
): Promise<AdmittedHumanPeerLiveShadowMessage>;
export function admitHumanPeerLiveShadowMessage(
  input: AdmitHumanPeerLiveShadowMessageInput,
): Promise<AdmittedHumanPeerLiveShadowMessage> {
  return admitHumanPeerLiveShadowMessageInternal(input);
}

/** Durable-history admission: freshness is replaced by the exact stored digest. */
export function admitHumanPeerLiveShadowMessageExactReplay(
  input: AdmitHumanPeerLiveShadowMessageShadowExactReplayInput,
): Promise<AdmittedHumanPeerLiveShadowMessageShadow>;
export function admitHumanPeerLiveShadowMessageExactReplay(
  input: AdmitHumanPeerLiveShadowMessageFullExactReplayInput,
): Promise<AdmittedHumanPeerLiveShadowMessageFull>;
export function admitHumanPeerLiveShadowMessageExactReplay(
  input: AdmitHumanPeerLiveShadowMessageExactReplayInput,
): Promise<AdmittedHumanPeerLiveShadowMessage>;
export function admitHumanPeerLiveShadowMessageExactReplay(
  input: AdmitHumanPeerLiveShadowMessageExactReplayInput,
): Promise<AdmittedHumanPeerLiveShadowMessage> {
  if (input.expectedRequestDigest.length !== 32) {
    throw new TypeError("Human-peer replay request digest is invalid");
  }
  return admitHumanPeerLiveShadowMessageInternal(input);
}
