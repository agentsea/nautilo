import {
  objectId,
  prepareHumanAiReadableLiveShadowMessageRequest,
  type LatticeCrypto,
  decodeHumanAiReadableLiveShadowMessagePlan,
  encodeHumanAiReadableLiveShadowMessagePlan,
} from "@nautilo/lattice-crypto";

import {
  authenticateClientDeviceProfileV4,
  destroyOpenedClientDeviceProfileV4,
} from "../../client-vault/profile-v4.ts";
import type {
  ClientProfileCoordinates,
  ClientProfileVault,
} from "../../client-vault/types.ts";
import {
  deriveLiveShadowMessageCryptoObjectIdV1,
} from "../../message/conversation-repository.ts";
import {
  prepareHumanExistingMessageRepresentationCryptoRevision,
} from "../../message/human-existing-message-representation-crypto.ts";
import {
  encodeMessagePayloadV2,
  type MessagePayloadV2,
} from "../../message/message-payload-v2.ts";
import { readPreparedConversationCryptoRevisionSnapshot } from
  "../../message/conversation-prepared-revision.ts";
import type { NamespaceAuthorityClient } from
  "./namespace-authority-client.ts";

export interface PreparedHumanAiReadableLiveShadowMessage {
  readonly normalizedContent: string;
  readonly operationId: string;
  readonly planBytes: Uint8Array;
  readonly requestBytes: Uint8Array;
  readonly ordinaryPayloadBytes: Uint8Array;
  readonly encryptedPayloadBytes: Uint8Array;
  readonly accessManifestBytes: Uint8Array;
  readonly namespaceEnvelopeBytes: Uint8Array;
  readonly requestDigest: Uint8Array;
}

export type PrepareVaultHumanAiReadableLiveShadowMessageResult =
  | Readonly<{
      status: "prepared";
      value: PreparedHumanAiReadableLiveShadowMessage;
    }>
  | Readonly<{
      status: "unavailable";
      reason:
        | "profile_unavailable"
        | "profile_invalid"
        | "plan_stale"
        | "namespace_unavailable"
        | "content_invalid";
    }>;

export interface PrepareVaultHumanAiReadableLiveShadowMessageInput {
  readonly crypto: LatticeCrypto;
  readonly vault: ClientProfileVault;
  readonly coordinates: ClientProfileCoordinates;
  readonly namespaceAuthority: NamespaceAuthorityClient;
  readonly planBytes: Uint8Array;
  readonly normalizedContent: string;
  readonly now: number;
}

function equal(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length
    && left.every((value, index) => value === right[index]);
}

function unavailable(
  reason: Extract<PrepareVaultHumanAiReadableLiveShadowMessageResult, {
    status: "unavailable";
  }>["reason"],
): PrepareVaultHumanAiReadableLiveShadowMessageResult {
  return Object.freeze({ status: "unavailable", reason });
}

function destroyPlan(plan: ReturnType<
  typeof decodeHumanAiReadableLiveShadowMessagePlan
>): void {
  plan.namespaceHeadDigest.fill(0);
  plan.namespacePublicationDigest.fill(0);
  plan.namespacePublicationSetDigest.fill(0);
  plan.namespaceAudienceFingerprint.fill(0);
}

export async function prepareVaultHumanAiReadableLiveShadowMessage(
  input: PrepareVaultHumanAiReadableLiveShadowMessageInput,
): Promise<PrepareVaultHumanAiReadableLiveShadowMessageResult> {
  let plan;
  try {
    plan = decodeHumanAiReadableLiveShadowMessagePlan(input.planBytes);
  } catch {
    return unavailable("plan_stale");
  }
  try {
    if (
      !Number.isSafeInteger(input.now)
      || input.now < plan.issuedAt
      || input.now >= plan.deadlineAt
      || plan.committerDeviceId !== input.coordinates.deviceId
      || typeof input.normalizedContent !== "string"
      || input.normalizedContent.length < 1
      || input.namespaceAuthority.withOpenedGenerations === undefined
    ) return unavailable("plan_stale");
    const available = await input.vault.availability();
    if (
      available.status !== "available"
      && (await input.vault.unlock()).status !== "available"
    ) return unavailable("profile_unavailable");
    const opened = await input.namespaceAuthority.withOpenedGenerations({
      sourceRoomId: plan.roomId,
      subjectHumanId: plan.subjectHumanId,
      deviceSigningKeyGeneration:
        plan.committerDeviceSigningKeyGeneration,
      keyClass: "ai",
      authority: [{
        namespaceId: plan.namespaceId,
        retainedGenerations: [{
          generation: plan.namespaceKeyGeneration,
          accessRevision: plan.namespaceAccessRevision,
          headDigest: plan.namespaceHeadDigest,
          publicationDigest: plan.namespacePublicationDigest,
          publicationSetDigest: plan.namespacePublicationSetDigest,
          audienceFingerprint: plan.namespaceAudienceFingerprint,
        }],
      }],
    }, async (generations) => {
      const generation = generations.find((candidate) =>
        candidate.keyClass === "ai"
        && candidate.namespaceId === plan.namespaceId
        && candidate.generation === plan.namespaceKeyGeneration
        && candidate.accessRevision === plan.namespaceAccessRevision
        && equal(candidate.headDigest, plan.namespaceHeadDigest)
        && equal(
          candidate.audienceFingerprint,
          plan.namespaceAudienceFingerprint,
        )
      );
      if (generation === undefined) return unavailable("namespace_unavailable");
      return input.vault.withOpenProfile(
        input.coordinates,
        async (profileBytes) => {
          let profile;
          try {
            profile = await authenticateClientDeviceProfileV4({
              crypto: input.crypto,
              profileBytes,
              expectedDeviceId: plan.committerDeviceId,
            });
          } catch {
            return unavailable("profile_invalid");
          }
          const base = profile.baseProfile.baseProfile;
          let payloadBytes: Uint8Array | undefined;
          let canonicalPlanBytes: Uint8Array | undefined;
          try {
            if (
              base.deviceId !== plan.committerDeviceId
              || base.trustedHostAuthorizationRevision
                !== plan.hostAuthorizationRevision
            ) return unavailable("plan_stale");
            const derivedObjectId = deriveLiveShadowMessageCryptoObjectIdV1({
              operationId: plan.operationId,
              sessionId: plan.sessionId,
              messageId: plan.humanMessageId,
              revision: 0,
              transcriptOrdinal: plan.transcriptOrdinal,
              authorRole: "user",
            });
            const payload: MessagePayloadV2 = Object.freeze({
              role: "user",
              content: input.normalizedContent,
            });
            payloadBytes = encodeMessagePayloadV2(payload);
            const prepared =
              prepareHumanExistingMessageRepresentationCryptoRevision({
              crypto: input.crypto,
              objectId: derivedObjectId,
              payload,
              createdAt: plan.createdAt,
              namespace: {
                namespaceId: plan.namespaceId,
                accessRevision: plan.namespaceAccessRevision,
                keyGeneration: plan.namespaceKeyGeneration,
                aiKey: generation.generationKey,
              },
              device: {
                deviceId: plan.committerDeviceId,
                hostAuthorizationRevision: plan.hostAuthorizationRevision,
                signingPrivateKey: base.signingPrivateKey,
              },
              resolveCurrentAuthorization: (context) => Object.freeze({
                ...context,
                sourceAuthorized: true,
                targetAuthorized: true,
                currentHostAuthorizationRevision:
                  plan.hostAuthorizationRevision,
                committerSigningPublicKey: base.signingPublicKey.slice(),
              }),
            });
            const snapshot = readPreparedConversationCryptoRevisionSnapshot(
              prepared,
            );
            if (snapshot.kind !== "human-v2") {
              throw new TypeError("Human AI-readable preparation kind disagrees");
            }
            const encryptedPayloadBytes =
              snapshot.value.object.payloadBytes.ciphertext;
            const accessManifestBytes = snapshot.value.access.manifestBytes;
            const namespaceEnvelopeBytes =
              snapshot.value.access.envelopeBytes[0];
            if (namespaceEnvelopeBytes === undefined) {
              throw new TypeError("Human AI-readable Namespace envelope is absent");
            }
            canonicalPlanBytes =
              encodeHumanAiReadableLiveShadowMessagePlan(plan);
            const request = prepareHumanAiReadableLiveShadowMessageRequest(
              input.crypto,
              {
                subjectHumanId: plan.subjectHumanId,
                operationId: plan.operationId,
                clientIdempotencyKey: plan.clientIdempotencyKey,
                policyRevision: plan.policyRevision,
                sessionId: plan.sessionId,
                roomId: plan.roomId,
                messageId: plan.humanMessageId,
                revision: 0,
                transcriptOrdinal: plan.transcriptOrdinal,
                role: "user",
                createdAt: plan.createdAt,
                cryptoObjectId: objectId(derivedObjectId),
                namespaceId: plan.namespaceId,
                keyClass: "ai",
                namespaceAccessRevision: plan.namespaceAccessRevision,
                namespaceKeyGeneration: plan.namespaceKeyGeneration,
                namespaceHeadDigest: plan.namespaceHeadDigest,
                namespacePublicationDigest: plan.namespacePublicationDigest,
                namespacePublicationSetDigest:
                  plan.namespacePublicationSetDigest,
                namespaceAudienceFingerprint:
                  plan.namespaceAudienceFingerprint,
                planDigest: input.crypto.hash(canonicalPlanBytes),
                plaintextPayloadDigest: input.crypto.hash(payloadBytes),
                encryptedPayloadDigest:
                  input.crypto.hash(encryptedPayloadBytes),
                manifestDigest: input.crypto.hash(accessManifestBytes),
                envelopeDigest: input.crypto.hash(namespaceEnvelopeBytes),
                issuedAt: plan.issuedAt,
                deadlineAt: plan.deadlineAt,
                committerDeviceId: plan.committerDeviceId,
                committerDeviceSigningKeyGeneration:
                  plan.committerDeviceSigningKeyGeneration,
                hostAuthorizationRevision: plan.hostAuthorizationRevision,
                committerSigningPublicKey: base.signingPublicKey,
                committerSigningPrivateKey: base.signingPrivateKey,
              },
              plan.formatVersion,
            );
            return Object.freeze({
              status: "prepared" as const,
              value: Object.freeze({
                normalizedContent: input.normalizedContent,
                operationId: plan.operationId,
                planBytes: canonicalPlanBytes.slice(),
                requestBytes: request.bytes.slice(),
                ordinaryPayloadBytes: payloadBytes.slice(),
                encryptedPayloadBytes: encryptedPayloadBytes.slice(),
                accessManifestBytes: accessManifestBytes.slice(),
                namespaceEnvelopeBytes: namespaceEnvelopeBytes.slice(),
                requestDigest: request.requestDigest.slice(),
              }),
            });
          } finally {
            payloadBytes?.fill(0);
            canonicalPlanBytes?.fill(0);
            destroyOpenedClientDeviceProfileV4(profile);
          }
        },
      );
    });
    if (opened.status !== "opened") {
      return unavailable("namespace_unavailable");
    }
    return opened.value;
  } catch {
    return unavailable("profile_unavailable");
  } finally {
    destroyPlan(plan);
  }
}
