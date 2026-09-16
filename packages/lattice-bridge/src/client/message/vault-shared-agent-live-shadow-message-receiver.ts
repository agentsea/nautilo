import {
  agentId,
  authorizationRevision,
  cryptoDeviceId,
  decryptObjectThroughNamespace,
  humanId,
  objectId,
  prepareHumanAiReadableLiveShadowAcknowledgement,
  prepareSharedAgentLiveShadowAcknowledgement,
  unixTimestamp,
  type LatticeCrypto,
  decodeHumanAiReadableLiveShadowMessagePlan,
} from "@nautilo/lattice-crypto";
import {
  decodeEncryptedPayloadV2,
  decodeSharedAgentLiveShadowMessagePlanV1,
  decodeNamespaceObjectEnvelopeV2,
} from "@nautilo/lattice-crypto/wire";
import {
  encodeProtectedMessageDtoV2,
  parseFullEncryptionMessageRealtimeContentEventV2,
  parseLiveShadowMessageRealtimeEventV1,
  type LiveShadowMessageRealtimeEventV1,
  type FullEncryptionMessageRealtimeContentEventV2,
} from "@nautilo/types";

import {
  authenticateClientDeviceProfileV4,
  destroyOpenedClientDeviceProfileV4,
} from "../../client-vault/profile-v4.ts";
import type {
  ClientProfileCoordinates,
  ClientProfileVault,
} from "../../client-vault/types.ts";
import {
  admitHumanAiReadableLiveShadowMessage,
} from "../../message/human-ai-readable-live-shadow-message-admission.ts";
import {
  admitSharedAgentLiveShadowMessage,
} from "../../message/shared-agent-live-shadow-message-admission.ts";
import { fullEncryptionDurableEventDigestV2, liveShadowDurableEventDigestV1 } from
  "../../message/live-shadow-realtime-evidence.ts";
import {
  decodeMessagePayloadV2,
  encodeMessagePayloadV2,
  type MessagePayloadV2,
} from "../../message/message-payload-v2.ts";
import type { NamespaceAuthorityClient } from
  "./namespace-authority-client.ts";

type SharedAgentEvent = Extract<LiveShadowMessageRealtimeEventV1 | FullEncryptionMessageRealtimeContentEventV2, {
  type: "message.shared_agent_shadow";
}>;

type SharedAgentLiveShadowReceiveBase = Readonly<{
  operationId: string;
  messageId: string;
  logicalMessageKey: string;
  reason:
    | "matched"
    | "authority_stale"
    | "sender_evidence_unavailable"
    | "namespace_unavailable"
    | "protected_open_failed"
    | "parity_mismatch"
    | "transport_unavailable";
}>;
export type SharedAgentLiveShadowReceiveResult =
  | SharedAgentLiveShadowReceiveBase & Readonly<{ status: "verified"; payload: MessagePayloadV2 }>
  | SharedAgentLiveShadowReceiveBase & Readonly<{ status: "fallback"; payload?: MessagePayloadV2 }>;

export interface VaultSharedAgentLiveShadowMessageReceiver {
  receive(
    event: unknown,
    ordinarySibling?: MessagePayloadV2,
  ): Promise<SharedAgentLiveShadowReceiveResult | null>;
}

export interface SharedAgentLiveShadowReceiverApiPort {
  planSharedAgentLiveShadowAcknowledgement(input: Readonly<{
    roomId: string;
    operationId: string;
    clientDeviceId: string;
  }>): Promise<
    | Readonly<{
        status: "ready";
        subjectHumanId: string;
        clientDeviceId: string;
        clientDeviceSigningKeyGeneration: number;
        hostAuthorizationRevision: number;
      }>
    | Readonly<{
        status: "unavailable";
        reason: string;
      }>
  >;
  acknowledgeSharedAgentLiveShadowMessage(input: Readonly<{
    roomId: string;
    operationId: string;
    acknowledgementBytesBase64url: string;
  }>): Promise<"verified" | "replayed">;
}

function fromBase64url(value: string): Uint8Array {
  const padded = value.replaceAll("-", "+").replaceAll("_", "/")
    + "=".repeat((4 - value.length % 4) % 4);
  const result = Uint8Array.from(
    atob(padded),
    (character) => character.charCodeAt(0),
  );
  if (result.length === 0 || toBase64url(result) !== value) {
    result.fill(0);
    throw new TypeError("Human-peer event bytes are noncanonical");
  }
  return result;
}

function toBase64url(value: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < value.length; offset += 0x8000) {
    binary += String.fromCharCode(...value.subarray(offset, offset + 0x8000));
  }
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_")
    .replace(/=+$/u, "");
}

function equal(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length
    && left.every((value, index) => value === right[index]);
}

function destroyPlan(plan: ReturnType<
  typeof decodeSharedAgentLiveShadowMessagePlanV1
> | ReturnType<typeof decodeHumanAiReadableLiveShadowMessagePlan>): void {
  plan.namespaceHeadDigest.fill(0);
  plan.namespacePublicationDigest.fill(0);
  plan.namespacePublicationSetDigest.fill(0);
  plan.namespaceAudienceFingerprint.fill(0);
}

export function createVaultSharedAgentLiveShadowMessageReceiver(input: Readonly<{
  crypto: LatticeCrypto;
  vault: ClientProfileVault;
  coordinates: ClientProfileCoordinates;
  namespaceAuthority: NamespaceAuthorityClient;
  api: SharedAgentLiveShadowReceiverApiPort;
  now?: () => number;
}>): VaultSharedAgentLiveShadowMessageReceiver {
  const now = input.now ?? Date.now;
  const withProfile = async <Value>(
    operation: Parameters<ClientProfileVault["withOpenProfile"]>[1],
  ): Promise<Value> => {
    const availability = await input.vault.availability();
    if (
      availability.status !== "available"
      && (await input.vault.unlock()).status !== "available"
    ) throw new Error("Human-peer Browser profile is unavailable");
    return input.vault.withOpenProfile(
      input.coordinates,
      operation,
    ) as Promise<Value>;
  };
  return Object.freeze({
    async receive(candidate: unknown, ordinarySibling?: MessagePayloadV2) {
      let event: SharedAgentEvent;
      try {
        const parsed = typeof candidate === "object" && candidate !== null
            && "wireVersion" in candidate && candidate.wireVersion === 2
          ? parseFullEncryptionMessageRealtimeContentEventV2(candidate)
          : parseLiveShadowMessageRealtimeEventV1(candidate);
        if (parsed.type !== "message.shared_agent_shadow") return null;
        event = parsed;
      } catch {
        return null;
      }
      let planBytes: Uint8Array | undefined;
      let requestBytes: Uint8Array | undefined;
      let ordinaryBytes: Uint8Array | undefined;
      let protectedDigest: Uint8Array | undefined;
      let senderSigningPublicKey: Uint8Array | undefined;
      let expectedEventDigest: Uint8Array | undefined;
      let actualEventDigest: Uint8Array | undefined;
      let protectedDtoBytes: Uint8Array | undefined;
      let actualProtectedDigest: Uint8Array | undefined;
      let authenticatedPayloadBytes: Uint8Array | undefined;
      let plan:
        | ReturnType<typeof decodeSharedAgentLiveShadowMessagePlanV1>
        | ReturnType<typeof decodeHumanAiReadableLiveShadowMessagePlan>
        | undefined;
      let fallbackPayload = ordinarySibling;
      let status: "verified" | "fallback" = "fallback";
      let reason: SharedAgentLiveShadowReceiveResult["reason"] =
        "transport_unavailable";
      try {
        planBytes = fromBase64url(event.planBytesBase64url);
        requestBytes = fromBase64url(event.requestBytesBase64url);
        ordinaryBytes = event.wireVersion === 1
          ? fromBase64url(event.ordinaryPayloadBytesBase64url) : undefined;
        protectedDigest = fromBase64url(
          event.protectedMessageDigestBase64url,
        );
        senderSigningPublicKey = fromBase64url(
          event.senderDeviceSigningPublicKeyBase64url,
        );
        expectedEventDigest = fromBase64url(event.durableEventDigestBase64url);
        try {
          plan = decodeHumanAiReadableLiveShadowMessagePlan(planBytes);
        } catch {
          plan = decodeSharedAgentLiveShadowMessagePlanV1(planBytes);
        }
        const currentPlan = plan;
        actualEventDigest = event.wireVersion === 1
          ? liveShadowDurableEventDigestV1(input.crypto, {
          operationId: event.operationId,
          policyRevision: event.policyRevision,
          transcriptOrdinal: event.transcriptOrdinal,
          ordinaryPayloadBytes: ordinaryBytes!,
          protectedMessage: event.protectedMessage,
          }) : fullEncryptionDurableEventDigestV2(input.crypto, {
            operationId: event.operationId, policyRevision: event.policyRevision,
            transcriptOrdinal: event.transcriptOrdinal,
            protectedMessage: event.protectedMessage,
          });
        protectedDtoBytes = new TextEncoder().encode(
          encodeProtectedMessageDtoV2(event.protectedMessage),
        );
        actualProtectedDigest = input.crypto.hash(protectedDtoBytes);
        const ordinaryPayload = ordinaryBytes === undefined ? undefined
          : decodeMessagePayloadV2(ordinaryBytes);
        fallbackPayload = ordinaryPayload ?? ordinarySibling;
        const visibleSiblingBytes = ordinarySibling === undefined ? undefined
          : encodeMessagePayloadV2(ordinarySibling);
        try {
          if (
            event.operationId !== currentPlan.operationId
            || event.policyRevision !== currentPlan.policyRevision
            || event.transcriptOrdinal !== currentPlan.transcriptOrdinal
            || event.logicalMessageKey !== `turn:${currentPlan.operationId}`
            || event.protectedMessage.projection.messageId
              !== String(currentPlan.humanMessageId)
            || event.protectedMessage.projection.sessionId !== currentPlan.sessionId
            || event.protectedMessage.projection.roomId !== currentPlan.roomId
            || event.protectedMessage.projection.namespaceId
              !== currentPlan.namespaceId
            || event.protectedMessage.projection.role !== "user"
            || event.protectedMessage.projection.editRevision !== 0
            || !equal(expectedEventDigest, actualEventDigest)
            || !equal(protectedDigest, actualProtectedDigest)
            || (event.wireVersion === 1 && (ordinaryBytes === undefined
              || visibleSiblingBytes === undefined
              || !equal(ordinaryBytes, visibleSiblingBytes)))
          ) {
            reason = "parity_mismatch";
          } else {
            let ackPlan = await input.api
              .planSharedAgentLiveShadowAcknowledgement({
                roomId: currentPlan.roomId,
                operationId: currentPlan.operationId,
                clientDeviceId: input.coordinates.deviceId,
              });
            if (
              event.wireVersion === 2
              && ackPlan.status === "unavailable"
              && ackPlan.reason === "current_read_authority_unavailable"
            ) {
              const ensured = await input.namespaceAuthority.ensure({
                sourceRoomId: currentPlan.roomId,
                namespaceId: currentPlan.namespaceId,
                operationId: currentPlan.operationId,
                idempotencyKey: currentPlan.operationId,
                keyClass: "ai",
              }).catch(() => Object.freeze({
                status: "unavailable" as const,
                reason: "request_failed",
              }));
              if (ensured.status === "ready") {
                ackPlan = await input.api
                  .planSharedAgentLiveShadowAcknowledgement({
                    roomId: currentPlan.roomId,
                    operationId: currentPlan.operationId,
                    clientDeviceId: input.coordinates.deviceId,
                  });
              }
            }
            if (
              ackPlan.status !== "ready"
              || ackPlan.clientDeviceId !== input.coordinates.deviceId
              || input.namespaceAuthority.withOpenedGenerations === undefined
            ) {
              reason = "authority_stale";
            } else {
              const protectedPayload = event.protectedMessage.protectedPayload;
              if (protectedPayload.status !== "encrypted") {
                reason = "protected_open_failed";
              } else {
                const encryptedProtectedPayload = protectedPayload;
                const encryptedBytes = fromBase64url(
                  protectedPayload.encryptedPayloadBytesBase64url,
                );
                const manifestBytes = fromBase64url(
                  protectedPayload.accessManifestBytesBase64url,
                );
                const envelopeBytes = fromBase64url(
                  protectedPayload.namespaceEnvelopeBytesBase64url,
                );
                let openedPayload: Uint8Array | undefined;
                let signedPlaintextCommitment: Uint8Array | undefined;
                try {
                  const admissionInput = {
                    crypto: input.crypto,
                    expectedPlanBytes: planBytes,
                    requestBytes,
                    ...(event.wireVersion === 1
                      ? { contentRepresentation: "shadow" as const,
                        ordinaryPayloadBytes: ordinaryBytes! }
                      : { contentRepresentation: "full" as const }),
                    encryptedPayloadBytes: encryptedBytes,
                    manifestBytes,
                    envelopeBytes,
                    now: now(),
                  } as const;
                  const admitted = "recipientAgentId" in currentPlan
                    ? await admitSharedAgentLiveShadowMessage({
                      ...admissionInput,
                      resolveCurrentHumanAuthority: (context) =>
                        context.subjectHumanId === currentPlan.subjectHumanId
                            && context.recipientAgentId
                              === currentPlan.recipientAgentId
                            && context.operationId === currentPlan.operationId
                            && context.committerDeviceId
                              === currentPlan.committerDeviceId
                            && context.committerDeviceSigningKeyGeneration
                              === currentPlan.committerDeviceSigningKeyGeneration
                            && context.hostAuthorizationRevision
                              === currentPlan.hostAuthorizationRevision
                          ? senderSigningPublicKey!.slice()
                          : null,
                    })
                    : await admitHumanAiReadableLiveShadowMessage({
                      ...admissionInput,
                      resolveCurrentHumanAuthority: (context) =>
                        context.subjectHumanId === currentPlan.subjectHumanId
                            && context.operationId === currentPlan.operationId
                            && context.committerDeviceId
                              === currentPlan.committerDeviceId
                            && context.committerDeviceSigningKeyGeneration
                              === currentPlan.committerDeviceSigningKeyGeneration
                            && context.hostAuthorizationRevision
                              === currentPlan.hostAuthorizationRevision
                          ? senderSigningPublicKey!.slice()
                          : null,
                    });
                  signedPlaintextCommitment =
                    admitted.plaintextPayloadDigest.slice();
                  admitted.requestDigest.fill(0);
                  admitted.plaintextPayloadDigest.fill(0);
                  destroyPlan(admitted.plan);
                  const opened = await input.namespaceAuthority
                    .withOpenedGenerations({
                      sourceRoomId: currentPlan.roomId,
                      subjectHumanId: ackPlan.subjectHumanId,
                      deviceSigningKeyGeneration:
                        ackPlan.clientDeviceSigningKeyGeneration,
                      keyClass: "ai",
                      authority: [{
                        namespaceId: currentPlan.namespaceId,
                        retainedGenerations: [{
                          generation: currentPlan.namespaceKeyGeneration,
                          accessRevision: currentPlan.namespaceAccessRevision,
                          headDigest: currentPlan.namespaceHeadDigest,
                          publicationDigest: currentPlan.namespacePublicationDigest,
                          publicationSetDigest:
                            currentPlan.namespacePublicationSetDigest,
                          audienceFingerprint:
                            currentPlan.namespaceAudienceFingerprint,
                        }],
                      }],
                    }, (entries) => {
                      const generation = entries.find((entry) =>
                        entry.namespaceId === currentPlan.namespaceId
                        && entry.keyClass === "ai"
                        && entry.generation === currentPlan.namespaceKeyGeneration
                        && entry.accessRevision === currentPlan.namespaceAccessRevision
                        && equal(entry.headDigest, currentPlan.namespaceHeadDigest)
                        && equal(
                          entry.audienceFingerprint,
                          currentPlan.namespaceAudienceFingerprint,
                        )
                      );
                      if (generation === undefined) return null;
                      const encrypted = decodeEncryptedPayloadV2(encryptedBytes);
                      const envelope = decodeNamespaceObjectEnvelopeV2(
                        envelopeBytes,
                      );
                      try {
                        return decryptObjectThroughNamespace(
                          input.crypto,
                          generation.generationKey,
                          envelope,
                          encrypted,
                        );
                      } finally {
                        encrypted.ciphertext.fill(0);
                        envelope.wrappedDek.fill(0);
                      }
                    });
                  if (opened.status !== "opened" || opened.value === null) {
                    reason = "namespace_unavailable";
                  } else {
                    openedPayload = opened.value;
                    if (
                      (ordinaryBytes !== undefined
                        && !equal(openedPayload, ordinaryBytes))
                      || (visibleSiblingBytes !== undefined
                        && !equal(openedPayload, visibleSiblingBytes))
                    ) {
                      reason = "parity_mismatch";
                    } else {
                      const openedDigest = input.crypto.hash(openedPayload);
                      const commitmentMatches = signedPlaintextCommitment
                        !== undefined
                        && equal(openedDigest, signedPlaintextCommitment);
                      openedDigest.fill(0);
                      if (!commitmentMatches) {
                        reason = "protected_open_failed";
                      } else {
                        fallbackPayload = decodeMessagePayloadV2(openedPayload);
                        authenticatedPayloadBytes = openedPayload.slice();
                        status = "verified";
                        reason = "matched";
                      }
                    }
                  }
                } catch {
                  reason = "protected_open_failed";
                } finally {
                  encryptedBytes.fill(0);
                  manifestBytes.fill(0);
                  envelopeBytes.fill(0);
                  openedPayload?.fill(0);
                  signedPlaintextCommitment?.fill(0);
                }

                await withProfile(
                  async (profileBytes) => {
                    const profile = await authenticateClientDeviceProfileV4({
                      crypto: input.crypto,
                      profileBytes,
                      expectedDeviceId: input.coordinates.deviceId,
                    });
                    const base = profile.baseProfile.baseProfile;
                    try {
                      if (
                        base.trustedHostAuthorizationRevision
                          !== ackPlan.hostAuthorizationRevision
                      ) throw new TypeError("Recipient authority is stale");
                      const issuedAt = now();
                      const ordinaryPayloadDigest = input.crypto.hash(
                        authenticatedPayloadBytes!,
                      );
                      let acknowledgement: ReturnType<
                        typeof prepareSharedAgentLiveShadowAcknowledgement
                      > | ReturnType<
                        typeof prepareHumanAiReadableLiveShadowAcknowledgement
                      > | undefined;
                      try {
                        const acknowledgementInput = {
                            subjectHumanId: humanId(ackPlan.subjectHumanId),
                            operationId: currentPlan.operationId,
                            clientIdempotencyKey:
                              currentPlan.clientIdempotencyKey,
                            policyRevision: currentPlan.policyRevision,
                            sessionId: currentPlan.sessionId,
                            roomId: currentPlan.roomId,
                            messageId: currentPlan.humanMessageId,
                            revision: 0,
                            transcriptOrdinal: currentPlan.transcriptOrdinal,
                            cryptoObjectId: objectId(
                              encryptedProtectedPayload.cryptoObjectId,
                            ),
                            protectedMessageDigest: protectedDigest!,
                            ordinaryPayloadDigest,
                            status,
                            reason,
                            issuedAt: unixTimestamp(issuedAt),
                            deadlineAt: unixTimestamp(issuedAt + 30_000),
                            committerDeviceId: cryptoDeviceId(base.deviceId),
                            committerDeviceSigningKeyGeneration:
                              ackPlan.clientDeviceSigningKeyGeneration,
                            hostAuthorizationRevision: authorizationRevision(
                              ackPlan.hostAuthorizationRevision,
                            ),
                            committerSigningPublicKey: base.signingPublicKey,
                            committerSigningPrivateKey: base.signingPrivateKey,
                        } as const;
                        acknowledgement = "recipientAgentId" in currentPlan
                          ? prepareSharedAgentLiveShadowAcknowledgement(
                            input.crypto,
                            {
                              ...acknowledgementInput,
                              recipientAgentId: agentId(
                                currentPlan.recipientAgentId,
                              ),
                            },
                          )
                          : prepareHumanAiReadableLiveShadowAcknowledgement(
                            input.crypto,
                            acknowledgementInput,
                          );
                        await input.api.acknowledgeSharedAgentLiveShadowMessage({
                          roomId: currentPlan.roomId,
                          operationId: currentPlan.operationId,
                          acknowledgementBytesBase64url:
                            toBase64url(acknowledgement.bytes),
                        });
                      } finally {
                        ordinaryPayloadDigest.fill(0);
                        acknowledgement?.bytes.fill(0);
                        acknowledgement?.acknowledgementDigest.fill(0);
                        acknowledgement?.acknowledgement.protectedMessageDigest
                          .fill(0);
                        acknowledgement?.acknowledgement.ordinaryPayloadDigest
                          .fill(0);
                        acknowledgement?.acknowledgement.signature.fill(0);
                      }
                    } finally {
                      destroyOpenedClientDeviceProfileV4(profile);
                    }
                  },
                );
              }
            }
          }
        } finally {
          visibleSiblingBytes?.fill(0);
        }
      } catch {
        status = "fallback";
        reason = "transport_unavailable";
      } finally {
        planBytes?.fill(0);
        requestBytes?.fill(0);
        ordinaryBytes?.fill(0);
        protectedDigest?.fill(0);
        senderSigningPublicKey?.fill(0);
        expectedEventDigest?.fill(0);
        actualEventDigest?.fill(0);
        protectedDtoBytes?.fill(0);
        actualProtectedDigest?.fill(0);
        authenticatedPayloadBytes?.fill(0);
        if (plan !== undefined) destroyPlan(plan);
      }
      const base = {
        operationId: event.operationId,
        messageId: event.protectedMessage.projection.messageId,
        logicalMessageKey: event.logicalMessageKey,
        reason,
      };
      return status === "verified" && fallbackPayload !== undefined
        ? Object.freeze({ ...base, status, payload: fallbackPayload })
        : Object.freeze({ ...base, status: "fallback" as const,
          ...(fallbackPayload === undefined ? {} : { payload: fallbackPayload }) });
    },
  });
}
