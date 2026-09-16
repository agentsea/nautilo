import {
  authenticateObjectAccessManifestGenesis,
  authorizationRevision,
  cryptoDeviceId,
  encryptedObjectWriteRecord,
  humanId,
  namespaceId,
  objectId,
  unixTimestamp,
  verifyForegroundSessionHumanLiveShadowMessageRequest,
  type ForegroundSessionHumanLiveShadowAuthorizationProof,
  type ForegroundSessionHumanLiveShadowMessageRequest,
  type ForegroundSessionLiveShadowMessagePlan,
  type LatticeCrypto,
  type ResolveCurrentForegroundSessionHumanLiveShadowMessageAuthority,
} from "@nautilo/lattice-crypto";
import {
  decodeEncryptedPayloadV2,
  decodeLiveShadowMessagePlanV4,
  decodeNamespaceObjectEnvelopeV2,
  destroyDeviceWrappedDomainAgentForegroundAuthorizationV1,
  encodeLiveShadowMessagePlanV4,
  parseDeviceWrappedDomainAgentForegroundAuthorizationV1,
} from "@nautilo/lattice-crypto/wire";

import {
  CONVERSATION_MESSAGE_OBJECT_TYPE,
  deriveLiveShadowMessageCryptoObjectIdV1,
  type PreparedConversationCryptoRevision,
} from "./conversation-repository.ts";
import { createPreparedConversationCryptoRevision } from
  "./conversation-prepared-revision.ts";
import { decodeMessagePayloadV2 } from "./message-payload-v2.ts";

interface AdmittedForegroundSessionHumanLiveShadowMessageBase {
  readonly plan: ForegroundSessionLiveShadowMessagePlan;
  readonly prepared: PreparedConversationCryptoRevision;
  readonly requestDigest: Uint8Array;
  /** Signed commitment; the actual key consumer compares its opened bytes. */
  readonly plaintextPayloadDigest: Uint8Array;
  readonly authorization: ForegroundSessionHumanLiveShadowAuthorizationProof;
}

export type AdmittedForegroundSessionHumanLiveShadowMessageShadow =
  AdmittedForegroundSessionHumanLiveShadowMessageBase & Readonly<{
    readonly contentRepresentation: "shadow";
    readonly ordinaryContent: string;
    readonly contentVerification: "ordinary_commitment_verified";
  }>;

export type AdmittedForegroundSessionHumanLiveShadowMessageFull =
  AdmittedForegroundSessionHumanLiveShadowMessageBase & Readonly<{
    readonly contentRepresentation: "full";
    readonly ordinaryContent: null;
    readonly contentVerification: "signed_representation_authenticated";
  }>;

export type AdmittedForegroundSessionHumanLiveShadowMessage =
  | AdmittedForegroundSessionHumanLiveShadowMessageShadow
  | AdmittedForegroundSessionHumanLiveShadowMessageFull;

interface AdmitForegroundSessionHumanLiveShadowMessageInputBase {
  readonly crypto: LatticeCrypto;
  readonly expectedPlanBytes: Uint8Array;
  readonly requestBytes: Uint8Array;
  readonly encryptedPayloadBytes: Uint8Array;
  readonly manifestBytes: Uint8Array;
  readonly envelopeBytes: Uint8Array;
  readonly now: number;
  readonly resolveCurrentHumanAuthority:
    ResolveCurrentForegroundSessionHumanLiveShadowMessageAuthority;
}

export type AdmitForegroundSessionHumanLiveShadowMessageShadowInput =
  AdmitForegroundSessionHumanLiveShadowMessageInputBase & Readonly<{
    readonly contentRepresentation?: "shadow";
    readonly ordinaryPayloadBytes: Uint8Array;
  }>;

export type AdmitForegroundSessionHumanLiveShadowMessageFullInput =
  AdmitForegroundSessionHumanLiveShadowMessageInputBase & Readonly<{
    readonly contentRepresentation: "full";
    readonly ordinaryPayloadBytes?: never;
  }>;

export type AdmitForegroundSessionHumanLiveShadowMessageInput =
  | AdmitForegroundSessionHumanLiveShadowMessageShadowInput
  | AdmitForegroundSessionHumanLiveShadowMessageFullInput;

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

function copyAuthorization(
  value: ForegroundSessionHumanLiveShadowAuthorizationProof,
): ForegroundSessionHumanLiveShadowAuthorizationProof {
  return value.kind === "establish"
    ? Object.freeze({
      kind: "establish" as const,
      authorizationBytes: value.authorizationBytes.slice(),
      authorizationDigest: value.authorizationDigest.slice(),
    })
    : Object.freeze({
      kind: "reuse" as const,
      sessionReference: value.sessionReference,
      authorizationDigest: value.authorizationDigest.slice(),
    });
}

function destroyPlan(plan: ForegroundSessionLiveShadowMessagePlan): void {
  plan.agentSignerPublicKey.fill(0);
  plan.namespaceHeadDigest.fill(0);
  plan.namespacePublicationDigest.fill(0);
  plan.namespacePublicationSetDigest.fill(0);
  plan.namespaceAudienceFingerprint.fill(0);
  plan.grantDomainParticipantDigest.fill(0);
  plan.grantDomainHeadDigest.fill(0);
  plan.grantDomainPublicationDigest.fill(0);
  plan.namespaceBundleDigest.fill(0);
  if (plan.authorization.disposition === "authorization_required") {
    plan.authorization.authorizationPlanBytes.fill(0);
    plan.authorization.authorizationPlanDigest.fill(0);
    plan.authorization.recipientPublicKey.fill(0);
  } else {
    plan.authorization.authorizationDigest.fill(0);
  }
}

function destroyRequest(
  request: ForegroundSessionHumanLiveShadowMessageRequest,
): void {
  request.namespaceHeadDigest.fill(0);
  request.namespacePublicationDigest.fill(0);
  request.namespacePublicationSetDigest.fill(0);
  request.namespaceAudienceFingerprint.fill(0);
  if (request.authorization.kind === "establish") {
    request.authorization.authorizationBytes.fill(0);
  }
  request.authorization.authorizationDigest.fill(0);
  request.planDigest.fill(0);
  request.plaintextPayloadDigest.fill(0);
  request.encryptedPayloadDigest.fill(0);
  request.manifestDigest.fill(0);
  request.envelopeDigest.fill(0);
  request.signature.fill(0);
}

/** Authenticate every Browser sibling before a foreground session is lent. */
export function admitForegroundSessionHumanLiveShadowMessage(
  input: AdmitForegroundSessionHumanLiveShadowMessageShadowInput,
): Promise<AdmittedForegroundSessionHumanLiveShadowMessageShadow>;
export function admitForegroundSessionHumanLiveShadowMessage(
  input: AdmitForegroundSessionHumanLiveShadowMessageFullInput,
): Promise<AdmittedForegroundSessionHumanLiveShadowMessageFull>;
export function admitForegroundSessionHumanLiveShadowMessage(
  input: AdmitForegroundSessionHumanLiveShadowMessageInput,
): Promise<AdmittedForegroundSessionHumanLiveShadowMessage>;
export async function admitForegroundSessionHumanLiveShadowMessage(
  input: AdmitForegroundSessionHumanLiveShadowMessageInput,
): Promise<AdmittedForegroundSessionHumanLiveShadowMessage> {
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
  let plan: ForegroundSessionLiveShadowMessagePlan | undefined;
  let canonicalPlanBytes: Uint8Array | undefined;
  let request: ForegroundSessionHumanLiveShadowMessageRequest | undefined;
  let transferred = false;
  try {
    plan = decodeLiveShadowMessagePlanV4(planBytes);
    canonicalPlanBytes = encodeLiveShadowMessagePlanV4(plan);
    if (!equal(planBytes, canonicalPlanBytes)) {
      throw new TypeError("Foreground-session live Shadow plan is noncanonical");
    }
    request = verifyForegroundSessionHumanLiveShadowMessageRequest(
      input.crypto,
      {
        requestBytes,
        now: unixTimestamp(input.now),
        resolveCurrentAuthority: input.resolveCurrentHumanAuthority,
      },
    );
    const derivedObjectId = deriveLiveShadowMessageCryptoObjectIdV1({
      operationId: plan.operationId,
      sessionId: plan.sessionId,
      messageId: plan.humanMessageId,
      revision: 0,
      transcriptOrdinal: 1,
      authorRole: "user",
    });
    let authorizationMatches = false;
    if (
      plan.authorization.disposition === "authorization_required"
      && request.authorization.kind === "establish"
      && hashMatches(
        input.crypto,
        request.authorization.authorizationBytes,
        request.authorization.authorizationDigest,
      )
    ) {
      const authorization =
        parseDeviceWrappedDomainAgentForegroundAuthorizationV1(
          request.authorization.authorizationBytes,
        );
      if (authorization !== null) {
        try {
          authorizationMatches = authorization.authorizationId
              === plan.authorization.authorizationId
            && equal(
              authorization.planBytes,
              plan.authorization.authorizationPlanBytes,
            )
            && equal(
              authorization.planDigest,
              plan.authorization.authorizationPlanDigest,
            );
        } finally {
          destroyDeviceWrappedDomainAgentForegroundAuthorizationV1(
            authorization,
          );
        }
      }
    } else if (
      plan.authorization.disposition === "authorization_reusable"
      && request.authorization.kind === "reuse"
    ) {
      authorizationMatches = request.authorization.sessionReference
          === plan.authorization.sessionReference
        && equal(
          request.authorization.authorizationDigest,
          plan.authorization.authorizationDigest,
        );
    }
    if (
      request.operationId !== plan.operationId
      || request.policyRevision !== plan.policyRevision
      || request.sessionId !== plan.sessionId
      || request.roomId !== plan.roomId
      || request.messageId !== plan.humanMessageId
      || request.createdAt !== plan.createdAt
      || request.subjectHumanId !== plan.subjectHumanId
      || request.committerDeviceId !== plan.committerDeviceId
      || request.committerDeviceSigningKeyGeneration
        !== plan.committerDeviceSigningKeyGeneration
      || request.hostAuthorizationRevision !== plan.hostAuthorizationRevision
      || request.recipientAgentId !== plan.recipientAgentId
      || request.agentAuthorizationRevision !== plan.agentAuthorizationRevision
      || request.cryptoObjectId !== derivedObjectId
      || request.namespaceId !== plan.namespaceId
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
      || !authorizationMatches
      || !hashMatches(input.crypto, canonicalPlanBytes, request.planDigest)
    ) throw new TypeError("Foreground-session live Shadow request disagrees");

    const ordinaryPayload = ordinaryPayloadBytes === null
      ? null
      : decodeMessagePayloadV2(ordinaryPayloadBytes);
    if (
      ordinaryPayload !== null
      && (ordinaryPayload.role !== "user" || ordinaryPayload.toolCalls !== undefined)
    ) {
      throw new TypeError("Foreground-session ordinary payload is not Human text");
    }
    const encryptedPayload = decodeEncryptedPayloadV2(encryptedPayloadBytes);
    const envelope = decodeNamespaceObjectEnvelopeV2(envelopeBytes);
    if (
      (ordinaryPayloadBytes !== null && !hashMatches(
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
      || encryptedPayload.context.objectId !== derivedObjectId
      || encryptedPayload.context.objectType !== CONVERSATION_MESSAGE_OBJECT_TYPE
      || encryptedPayload.context.keyClass !== "ai"
      || encryptedPayload.context.createdAt !== plan.createdAt
      || envelope.context.objectId !== derivedObjectId
      || envelope.context.namespaceId !== plan.namespaceId
      || envelope.context.keyClass !== "ai"
      || envelope.context.keyGeneration !== plan.namespaceKeyGeneration
      || envelope.context.bindingRevisionAtWrap
        !== plan.namespaceAccessRevision
    ) throw new TypeError("Foreground-session signed siblings disagree");
    const access = await authenticateObjectAccessManifestGenesis({
      crypto: input.crypto,
      payloadBytes: encryptedPayloadBytes,
      manifestBytes,
      envelopeBytes: [envelopeBytes],
      resolveCurrentAuthorization: (context) => {
        const publicKey = input.resolveCurrentHumanAuthority(Object.freeze({
          purpose: "human-live-shadow-message-v4-verify",
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
            purpose: "human-live-shadow-message-v4-verify",
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
      authorization: copyAuthorization(request.authorization),
    } as const;
    // This admission authenticates the signed protected representation and,
    // in Shadow, the supplied ordinary bytes against their signed commitment.
    // It does not open the ciphertext. A cryptographic consumer must still
    // open/decode it under current grant authority, validate the Human role,
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
