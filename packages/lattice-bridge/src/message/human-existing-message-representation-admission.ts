import {
  authenticateObjectAccessManifestGenesis,
  authorizationRevision,
  cryptoDeviceId,
  encryptedObjectWriteRecord,
  humanId,
  namespaceId,
  objectId,
  unixTimestamp,
  verifyHumanExistingMessageRepresentationPublicationRequest,
  verifyHumanExistingMessageRepresentationPublicationRequestExactReplay,
  type HumanExistingMessageRepresentationPublicationAuthorityContext,
  type LatticeCrypto,
  type ResolveCurrentHumanExistingMessageRepresentationPublicationAuthority,
} from "@nautilo/lattice-crypto";
import {
  decodeEncryptedPayloadV2,
  decodeNamespaceObjectEnvelopeV2,
} from "@nautilo/lattice-crypto/wire";

import {
  assertConversationAuthorRole,
  CONVERSATION_MESSAGE_OBJECT_TYPE,
  deriveMessageCryptoObjectIdV2,
  type ConversationAuthorRole,
  type PreparedConversationCryptoRevision,
} from "./conversation-repository.ts";
import { createPreparedConversationCryptoRevision } from
  "./conversation-prepared-revision.ts";
import {
  encodeMessagePayloadV2,
  type MessagePayloadV2,
} from "./message-payload-v2.ts";

export interface HumanExistingMessageRepresentationProductPlan {
  readonly subjectHumanId: string;
  readonly operationId: string;
  readonly sessionId: string;
  readonly roomId: string;
  readonly messageId: number;
  readonly revision: number;
  readonly createdAt: number;
  readonly objectId: string;
  readonly namespaceId: string;
  readonly namespaceBindingHash: Uint8Array;
  readonly namespaceAccessRevision: number;
  readonly namespaceKeyGeneration: number;
  readonly bindingRevisionAtWrap: number;
  readonly keyClass: "ai" | "human";
  readonly authorRole: ConversationAuthorRole;
  readonly authorHumanTurnId: string | null;
  readonly sessionAgentId: string | null;
}

export interface AdmittedHumanExistingMessageRepresentation {
  readonly prepared: PreparedConversationCryptoRevision;
  readonly allocationRequestDigest: Uint8Array;
}

export interface AdmitHumanExistingMessageRepresentationInput {
  readonly crypto: LatticeCrypto;
  readonly productPlan: HumanExistingMessageRepresentationProductPlan;
  readonly authoritativePlaintext: MessagePayloadV2;
  readonly requestBytes: Uint8Array;
  readonly payloadBytes: Uint8Array;
  readonly manifestBytes: Uint8Array;
  readonly envelopeBytes: readonly Uint8Array[];
  readonly now: number;
  readonly resolveCurrentHumanAuthority:
    ResolveCurrentHumanExistingMessageRepresentationPublicationAuthority;
}

export interface AdmitHumanExistingMessageRepresentationReplayInput {
  readonly crypto: LatticeCrypto;
  readonly productPlan: HumanExistingMessageRepresentationProductPlan;
  readonly authoritativePlaintext: MessagePayloadV2;
  readonly requestBytes: Uint8Array;
  readonly storedPayloadBytes: Uint8Array;
  readonly storedManifestBytes: Uint8Array;
  readonly storedEnvelopeBytes: readonly Uint8Array[];
  readonly durableAllocationRequestDigest: Uint8Array;
  readonly resolveCurrentHumanAuthority:
    ResolveCurrentHumanExistingMessageRepresentationPublicationAuthority;
}

export interface AdmittedHumanExistingMessageRepresentationReplay {
  readonly allocationRequestDigest: Uint8Array;
  readonly operationId: string;
  readonly objectId: string;
}

const PLAN_FIELDS = Object.freeze([
  "subjectHumanId", "operationId", "sessionId", "roomId", "messageId",
  "revision", "createdAt", "objectId", "namespaceId",
  "namespaceBindingHash", "namespaceAccessRevision", "namespaceKeyGeneration",
  "bindingRevisionAtWrap", "keyClass", "authorRole", "authorHumanTurnId",
  "sessionAgentId",
] as const);
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length
    && left.every((byte, index) => byte === right[index]);
}

function assertPlan(plan: HumanExistingMessageRepresentationProductPlan): void {
  if (typeof plan !== "object" || plan === null || Array.isArray(plan)) {
    throw new TypeError("Human existing Message representation product plan must be an object");
  }
  const actual = Object.keys(plan).sort();
  const expected = [...PLAN_FIELDS].sort();
  if (
    actual.length !== expected.length
    || actual.some((field, index) => field !== expected[index])
  ) throw new TypeError("Human existing Message representation product plan fields are invalid");
  if (!UUID.test(plan.subjectHumanId)) {
    throw new TypeError(
      "Human existing Message representation subject Human ID is invalid",
    );
  }
  humanId(plan.subjectHumanId);
  namespaceId(plan.namespaceId);
  objectId(plan.objectId);
  unixTimestamp(plan.createdAt);
  assertConversationAuthorRole(plan.authorRole);
  if (plan.keyClass !== "ai" && plan.keyClass !== "human") {
    throw new TypeError("Human existing Message representation product plan role is invalid");
  }
  if (
    plan.authorHumanTurnId !== null
    && (
      plan.authorRole !== "user"
      || typeof plan.authorHumanTurnId !== "string"
      || plan.authorHumanTurnId.length === 0
    )
  ) throw new TypeError("Existing Message Human-turn provenance is invalid");
  if (
    plan.sessionAgentId !== null
    && !UUID.test(plan.sessionAgentId)
  ) throw new TypeError("Existing Message Session Agent provenance is invalid");
  if (!(plan.namespaceBindingHash instanceof Uint8Array)
    || plan.namespaceBindingHash.length !== 32) {
    throw new TypeError("Human existing Message representation Namespace binding hash is invalid");
  }
  if (deriveMessageCryptoObjectIdV2(plan) !== plan.objectId) {
    throw new TypeError("Human existing Message representation product object coordinates disagree");
  }
}

function assertRequestMatchesPlan(
  request: ReturnType<typeof verifyHumanExistingMessageRepresentationPublicationRequest>,
  plan: HumanExistingMessageRepresentationProductPlan,
): void {
  if (
    request.subjectHumanId !== plan.subjectHumanId
    || request.operationId !== plan.operationId
    || request.sessionId !== plan.sessionId
    || request.roomId !== plan.roomId
    || request.messageId !== plan.messageId
    || request.revision !== plan.revision
    || request.createdAt !== plan.createdAt
    || request.authorRole !== plan.authorRole
    || request.authorHumanTurnId !== plan.authorHumanTurnId
    || request.sessionAgentId !== plan.sessionAgentId
    || request.cryptoObjectId !== plan.objectId
    || request.namespaceId !== plan.namespaceId
    || !equalBytes(request.namespaceBindingHash, plan.namespaceBindingHash)
    || request.namespaceAccessRevision !== plan.namespaceAccessRevision
    || request.namespaceKeyGeneration !== plan.namespaceKeyGeneration
    || request.bindingRevisionAtWrap !== plan.bindingRevisionAtWrap
  ) throw new TypeError("Existing Message representation request and product plan disagree");
}

async function authenticateHumanExistingMessageRepresentation(
  input: AdmitHumanExistingMessageRepresentationInput,
  verifyRequest: () => ReturnType<
    typeof verifyHumanExistingMessageRepresentationPublicationRequest
  >,
): Promise<AdmittedHumanExistingMessageRepresentation> {
  assertPlan(input.productPlan);
  if (input.authoritativePlaintext.role !== input.productPlan.authorRole) {
    throw new TypeError(
      "Existing Message plaintext role and immutable product authorship disagree",
    );
  }
  if (input.envelopeBytes.length !== 1) {
    throw new TypeError("Human existing Message representation genesis requires one envelope");
  }
  const requestBytes = input.requestBytes.slice();
  const payloadBytes = input.payloadBytes.slice();
  const manifestBytes = input.manifestBytes.slice();
  const envelopeBytes = input.envelopeBytes.map((bytes) => bytes.slice());
  const plaintextBytes = encodeMessagePayloadV2(input.authoritativePlaintext);
  let verifiedRequest: ReturnType<
    typeof verifyHumanExistingMessageRepresentationPublicationRequest
  > | null = null;
  try {
    verifiedRequest = verifyRequest();
    assertRequestMatchesPlan(verifiedRequest, input.productPlan);
    const payload = decodeEncryptedPayloadV2(payloadBytes);
    const envelope = decodeNamespaceObjectEnvelopeV2(envelopeBytes[0]!);
    const computedHashes = [
      input.crypto.hash(payloadBytes),
      input.crypto.hash(plaintextBytes),
      input.crypto.hash(manifestBytes),
      input.crypto.hash(envelopeBytes[0]!),
    ] as const;
    try {
    if (
      payload.context.objectId !== input.productPlan.objectId
      || payload.context.objectType !== CONVERSATION_MESSAGE_OBJECT_TYPE
      || payload.context.keyClass !== input.productPlan.keyClass
      || payload.context.createdAt !== input.productPlan.createdAt
      || envelope.context.objectId !== input.productPlan.objectId
      || envelope.context.namespaceId !== input.productPlan.namespaceId
      || envelope.context.keyClass !== input.productPlan.keyClass
      || envelope.context.keyGeneration
        !== input.productPlan.namespaceKeyGeneration
      || envelope.context.bindingRevisionAtWrap
        !== input.productPlan.bindingRevisionAtWrap
      || !equalBytes(computedHashes[0], verifiedRequest.ciphertextPayloadHash)
      || !equalBytes(computedHashes[1], verifiedRequest.plaintextPayloadHash)
      || !equalBytes(computedHashes[2], verifiedRequest.accessManifestHash)
      || !equalBytes(computedHashes[3], verifiedRequest.envelopeHash)
    ) throw new TypeError("Human existing Message representation signed crypto facts disagree");
    } finally {
      for (const hash of computedHashes) hash.fill(0);
    }

    const authority = input.resolveCurrentHumanAuthority;
    const access = await authenticateObjectAccessManifestGenesis({
      crypto: input.crypto,
      payloadBytes,
      manifestBytes,
      envelopeBytes,
      resolveCurrentAuthorization: (context) => {
        const publicKey = authority(Object.freeze({
          purpose: "human-existing-message-representation-publication-verify",
          subjectHumanId: humanId(input.productPlan.subjectHumanId),
          operationId: input.productPlan.operationId,
          committerDeviceId: cryptoDeviceId(context.committerDeviceId),
          hostAuthorizationRevision: authorizationRevision(
            context.hostAuthorizationRevision,
          ),
        } satisfies HumanExistingMessageRepresentationPublicationAuthorityContext));
        if (publicKey === null) return null;
        return {
          ...context,
          sourceAuthorized: true,
          targetAuthorized: true,
          currentHostAuthorizationRevision: context.hostAuthorizationRevision,
          committerSigningPublicKey: publicKey,
        };
      },
    });
    if (
      access.manifest.committerDeviceId !== verifiedRequest.committerDeviceId
      || access.manifest.hostAuthorizationRevision
        !== verifiedRequest.hostAuthorizationRevision
    ) throw new TypeError(
      "Existing Message representation request and access manifest signer disagree",
    );
    const prepared = createPreparedConversationCryptoRevision({
      objectId: input.productPlan.objectId,
      namespaceId: input.productPlan.namespaceId,
      object: encryptedObjectWriteRecord(payloadBytes),
      access,
      resolveCurrentAuthorization: async (context) => {
        const publicKey = await Promise.resolve(authority(Object.freeze({
          purpose: "human-existing-message-representation-publication-verify",
          subjectHumanId: humanId(input.productPlan.subjectHumanId),
          operationId: input.productPlan.operationId,
          committerDeviceId: cryptoDeviceId(context.committerDeviceId),
          hostAuthorizationRevision: authorizationRevision(
            context.hostAuthorizationRevision,
          ),
        })));
        if (publicKey === null) return null;
        return {
          ...context,
          sourceAuthorized: true,
          targetAuthorized: true,
          currentHostAuthorizationRevision: context.hostAuthorizationRevision,
          committerSigningPublicKey: publicKey,
        };
      },
    });
    return Object.freeze({
      prepared,
      allocationRequestDigest: input.crypto.hash(requestBytes),
    });
  } finally {
    requestBytes.fill(0); payloadBytes.fill(0); manifestBytes.fill(0);
    plaintextBytes.fill(0);
    for (const bytes of envelopeBytes) bytes.fill(0);
    if (verifiedRequest !== null) {
      verifiedRequest.namespaceBindingHash.fill(0);
      verifiedRequest.ciphertextPayloadHash.fill(0);
      verifiedRequest.plaintextPayloadHash.fill(0);
      verifiedRequest.accessManifestHash.fill(0);
      verifiedRequest.envelopeHash.fill(0);
      verifiedRequest.signature.fill(0);
    }
  }
}

/** Authenticate transient HTTP bytes and mint only process-local authority. */
export async function admitHumanExistingMessageRepresentation(
  input: AdmitHumanExistingMessageRepresentationInput,
): Promise<AdmittedHumanExistingMessageRepresentation> {
  return authenticateHumanExistingMessageRepresentation(input, () =>
    verifyHumanExistingMessageRepresentationPublicationRequest(input.crypto, {
      requestBytes: input.requestBytes,
      now: unixTimestamp(input.now),
      resolveCurrentAuthority: input.resolveCurrentHumanAuthority,
    }));
}

/**
 * Authenticate only an exact already-stored publication after allocation.
 * The returned shape intentionally cannot authorize another crypto write.
 */
export async function admitHumanExistingMessageRepresentationReplay(
  input: AdmitHumanExistingMessageRepresentationReplayInput,
): Promise<AdmittedHumanExistingMessageRepresentationReplay> {
  const admitted = await authenticateHumanExistingMessageRepresentation({
    crypto: input.crypto,
    productPlan: input.productPlan,
    authoritativePlaintext: input.authoritativePlaintext,
    requestBytes: input.requestBytes,
    payloadBytes: input.storedPayloadBytes,
    manifestBytes: input.storedManifestBytes,
    envelopeBytes: input.storedEnvelopeBytes,
    now: 0,
    resolveCurrentHumanAuthority: input.resolveCurrentHumanAuthority,
  }, () => verifyHumanExistingMessageRepresentationPublicationRequestExactReplay(
    input.crypto,
    {
      requestBytes: input.requestBytes,
      expectedRequestDigest: input.durableAllocationRequestDigest,
      resolveCurrentAuthority: input.resolveCurrentHumanAuthority,
    },
  ));
  return Object.freeze({
    allocationRequestDigest: admitted.allocationRequestDigest,
    operationId: input.productPlan.operationId,
    objectId: input.productPlan.objectId,
  });
}
