import { createAuthorizedHumanLiveShadowMessageClient } from
  "../../src/client/message/authorized-human-live-shadow-message-client.ts";
import { createPreparedMutationJournal } from
  "../../src/client/memory/prepared-mutation-journal.ts";
import { describe, expect, test } from "bun:test";
import {
  LatticeCrypto,
  accessRevision,
  authorizationRevision,
  cryptoDeviceId,
  humanId,
  namespaceGeneration,
  namespaceId,
  unixTimestamp,
  verifyHumanPeerLiveShadowAcknowledgement,
} from "@nautilo/lattice-crypto";
import {
  decodeHumanPeerLiveShadowMessagePlanV1,
  encodeHumanPeerLiveShadowMessagePlanV1,
} from "@nautilo/lattice-crypto/wire";
import { seededRng } from "@nautilo/lattice-crypto/testing";
import type { PostgresJsBridgeConnection } from "@nautilo/db";

import {
  createClientDeviceProfileV3Candidate,
  destroyOpenedClientDeviceProfileV3,
  encodeClientDeviceProfileV3,
} from "../../src/client-vault/profile-v3.ts";
import {
  createClientDeviceProfileV4Candidate,
  destroyOpenedClientDeviceProfileV4,
  stageAndActivateClientDeviceProfileV4,
} from "../../src/client-vault/profile-v4.ts";
import {
  encodeClientDeviceProfileV2,
  type OpenedClientDeviceProfileV2,
} from "../../src/client-vault/profile-v2.ts";
import type {
  ClientProfileCoordinates,
  ClientProfileVault,
  InterruptedClientProfileResolution,
  StageClientProfileInput,
} from "../../src/client-vault/types.ts";
import type {
  NamespaceAuthorityClient,
  NamespaceGenerationAuthority,
  OpenedNamespaceGeneration,
} from "../../src/client/message/namespace-authority-client.ts";
import {
  createVaultHumanPeerLiveShadowMessageReceiver,
} from "../../src/client/message/vault-human-peer-live-shadow-message-receiver.ts";
import {
  prepareVaultHumanPeerLiveShadowMessage,
} from "../../src/client/message/vault-human-peer-live-shadow-message.ts";
import {
  createVaultRoomHistoryShadowMessageReader,
  type ConversationProtectedMessageClientDtoV2,
} from
  "../../src/client/message/vault-room-history-shadow-message-reader.ts";
import {
  fullEncryptionDurableEventDigestV2,
  liveShadowDurableEventDigestV1,
} from "../../src/message/live-shadow-realtime-evidence.ts";
import {
  admitHumanPeerLiveShadowMessage,
  admitHumanPeerLiveShadowMessageExactReplay,
  type AdmitHumanPeerLiveShadowMessageInput,
} from "../../src/message/human-peer-live-shadow-message-admission.ts";
import {
  createDormantConversationShadowRepository,
} from "../../src/message/conversation-shadow-saga.ts";
import {
  admitAndPersistHumanPeerLiveShadowMessage,
} from "../../src/server/message/human-peer-live-shadow-admission.ts";
import { PostgresHumanPeerLiveShadowPlanner } from
  "../../src/server/message/postgres-human-peer-live-shadow-plan.ts";
import {
  createFakeConversationShadowHarness,
} from "../../src/testing/fake-conversation-shadow-repository.ts";
import { MemoryClientProfileVault } from
  "../../src/testing/client-profile-vault.ts";

const NOW = 1_800_200_000_000;
const SESSION = "10000000-0000-4000-8000-000000000295";
const ROOM = "20000000-0000-4000-8000-000000000295";
const NAMESPACE = "30000000-0000-4000-8000-000000000295";
const SENDER_HUMAN = "40000000-0000-4000-8000-000000000295";
const RECIPIENT_HUMAN = "50000000-0000-4000-8000-000000000295";
const SENDER_DEVICE = "device_m295_sender";
const RECIPIENT_DEVICE = "device_m295_recipient";
const OPERATION = "human_peer_operation_m295_live";
const MESSAGE_ID = 295;

function base64url(value: Uint8Array): string {
  return Buffer.from(value).toString("base64url");
}

async function createProfile(input: Readonly<{
  crypto: LatticeCrypto;
  deviceId: string;
  humanId: string;
  userId: string;
  hostAuthorizationRevision: number;
}>): Promise<Readonly<{
  vault: MemoryClientProfileVault;
  coordinates: ClientProfileCoordinates;
  signingPublicKey: Uint8Array;
}>> {
  const signing = input.crypto.generateSigningKeyPair();
  const encryption = await input.crypto.generateEncryptionKeyPair();
  const v2: OpenedClientDeviceProfileV2 = Object.freeze({
    formatVersion: 2,
    deviceId: input.deviceId,
    signingPublicKey: signing.publicKey,
    signingPrivateKey: signing.privateKey,
    encryptionPublicKey: encryption.publicKey,
    encryptionPrivateKey: encryption.privateKey,
    trustedDeviceRevision: 1,
    trustedHostAuthorizationRevision: input.hostAuthorizationRevision,
    deliveryHighWatermark: 0,
    keyringDeliveries: Object.freeze([]),
  });
  const v2Bytes = encodeClientDeviceProfileV2(v2);
  const v3 = await createClientDeviceProfileV3Candidate({
    crypto: input.crypto,
    currentProfileBytes: v2Bytes,
    expectedDeviceId: input.deviceId,
  });
  const v3Bytes = encodeClientDeviceProfileV3(v3);
  const v4 = await createClientDeviceProfileV4Candidate({
    crypto: input.crypto,
    currentProfileBytes: v3Bytes,
    expectedDeviceId: input.deviceId,
  });
  const coordinates: ClientProfileCoordinates = Object.freeze({
    serverScope: "https://m295.test",
    userId: input.userId,
    humanActorId: input.humanId,
    profileId: `profile_${input.deviceId}`,
    deviceId: input.deviceId,
    installationLineageDigest: "95".repeat(32),
  });
  const vault = new MemoryClientProfileVault();
  await vault.unlock();
  await stageAndActivateClientDeviceProfileV4({
    crypto: input.crypto,
    vault,
    coordinates,
    stageId: `stage_${input.deviceId}`,
    generation: 1,
    publicState: {
      clientKind: "browser",
      publicFingerprint: "59".repeat(32),
    },
    candidate: v4,
  });
  const signingPublicKey = signing.publicKey.slice();
  destroyOpenedClientDeviceProfileV4(v4);
  destroyOpenedClientDeviceProfileV3(v3);
  v2Bytes.fill(0);
  v3Bytes.fill(0);
  signing.publicKey.fill(0);
  signing.privateKey.fill(0);
  encryption.publicKey.fill(0);
  encryption.privateKey.fill(0);
  return Object.freeze({ vault, coordinates, signingPublicKey });
}

function namespaceAuthority(
  generationKey: Uint8Array,
  headDigest: Uint8Array,
  audienceFingerprint: Uint8Array,
): NamespaceAuthorityClient {
  async function withOpenedGenerations<Value>(
    _request: Readonly<{
      sourceRoomId: string;
      subjectHumanId: string;
      deviceSigningKeyGeneration: number;
      keyClass: "ai" | "human";
      authority: readonly NamespaceGenerationAuthority[];
    }>,
    use: (
      entries: readonly OpenedNamespaceGeneration[],
    ) => Promise<Value> | Value,
  ): Promise<
    | Readonly<{ status: "opened"; value: Value }>
    | Readonly<{ status: "unavailable"; reason: string }>
  > {
    const entry: OpenedNamespaceGeneration = Object.freeze({
      namespaceId: namespaceId(NAMESPACE),
      keyClass: "human",
      accessRevision: accessRevision(2),
      generation: namespaceGeneration(3),
      generationKey: generationKey.slice(),
      audienceFingerprint: audienceFingerprint.slice(),
      headDigest: headDigest.slice(),
    });
    try {
      return Object.freeze({
        status: "opened" as const,
        value: await use([entry]),
      });
    } finally {
      entry.generationKey.fill(0);
      entry.audienceFingerprint.fill(0);
      entry.headDigest.fill(0);
    }
  }
  return Object.freeze({
    ensure: async () => Object.freeze({ status: "ready" as const }),
    synchronizeRecipients: async () =>
      Object.freeze({ status: "ready" as const }),
    withOpenedAiGenerations: async () =>
      Object.freeze({
        status: "unavailable" as const,
        reason: "wrong_key_class",
      }),
    withOpenedGenerations,
  });
}

describe("M295 Human-peer live Shadow message", () => {
  test("maps one canonical row and lets an independent recipient open, compare, and acknowledge it", async () => {
    const crypto = new LatticeCrypto(seededRng(295_900));
    const sender = await createProfile({
      crypto,
      deviceId: SENDER_DEVICE,
      humanId: SENDER_HUMAN,
      userId: "60000000-0000-4000-8000-000000000295",
      hostAuthorizationRevision: 7,
    });
    const recipient = await createProfile({
      crypto,
      deviceId: RECIPIENT_DEVICE,
      humanId: RECIPIENT_HUMAN,
      userId: "70000000-0000-4000-8000-000000000295",
      hostAuthorizationRevision: 11,
    });
    const generationKey = new Uint8Array(32).fill(0x95);
    const headDigest = new Uint8Array(32).fill(0x31);
    const publicationDigest = new Uint8Array(32).fill(0x32);
    const publicationSetDigest = new Uint8Array(32).fill(0x33);
    const audienceFingerprint = new Uint8Array(32).fill(0x34);
    const planBytes = encodeHumanPeerLiveShadowMessagePlanV1({
      formatVersion: 1,
      purpose: "message.human_peer_live_shadow_plan",
      operationId: OPERATION,
      clientIdempotencyKey: "human_peer_client_m295_live",
      policyRevision: 4,
      sessionId: SESSION,
      roomId: ROOM,
      humanMessageId: MESSAGE_ID,
      revision: 0,
      transcriptOrdinal: 1,
      role: "user",
      createdAt: unixTimestamp(NOW),
      subjectHumanId: humanId(SENDER_HUMAN),
      committerDeviceId: cryptoDeviceId(SENDER_DEVICE),
      committerDeviceSigningKeyGeneration: 1,
      hostAuthorizationRevision: authorizationRevision(7),
      namespaceId: namespaceId(NAMESPACE),
      keyClass: "human",
      namespaceAccessRevision: accessRevision(2),
      namespaceKeyGeneration: namespaceGeneration(3),
      namespaceHeadDigest: headDigest,
      namespacePublicationDigest: publicationDigest,
      namespacePublicationSetDigest: publicationSetDigest,
      namespaceAudienceFingerprint: audienceFingerprint,
      attemptCoordinate: "human_peer_attempt_m295_live",
      issuedAt: unixTimestamp(NOW),
      deadlineAt: unixTimestamp(NOW + 30_000),
    });
    const prepared = await prepareVaultHumanPeerLiveShadowMessage({
      crypto,
      vault: sender.vault,
      coordinates: sender.coordinates,
      namespaceAuthority: namespaceAuthority(
        generationKey,
        headDigest,
        audienceFingerprint,
      ),
      planBytes,
      normalizedContent: "Human peer protected hello",
      now: NOW + 1,
    });
    expect(prepared.status).toBe("prepared");
    if (prepared.status !== "prepared") throw new Error(prepared.reason);

    const harness = createFakeConversationShadowHarness({
      crypto,
      now: () => new Date(NOW + 1),
    });
    harness.product.addSession({
      sessionId: SESSION,
      roomId: ROOM,
      namespaceId: NAMESPACE,
    });
    const admissionInput = {
      operationId: OPERATION,
      expectedContent: "Human peer protected hello",
      planBytes,
      requestBytes: prepared.value.requestBytes,
      ordinaryPayloadBytes: prepared.value.ordinaryPayloadBytes,
      encryptedPayloadBytes: prepared.value.encryptedPayloadBytes,
      manifestBytes: prepared.value.accessManifestBytes,
      envelopeBytes: prepared.value.namespaceEnvelopeBytes,
      now: NOW + 1,
    } as const;
    const dependencies = {
      crypto,
      product: harness.product,
      sourceUserId: "60000000-0000-4000-8000-000000000295",
      conversation: createDormantConversationShadowRepository({
        product: harness.product,
        crypto: harness.crypto,
      }),
      resolveCurrentHumanAuthority: () => sender.signingPublicKey.slice(),
      senderDeviceSigningPublicKey: sender.signingPublicKey,
    } as const;
    const fullAdmissionInput = {
      crypto,
      contentRepresentation: "full",
      expectedPlanBytes: planBytes,
      requestBytes: prepared.value.requestBytes,
      encryptedPayloadBytes: prepared.value.encryptedPayloadBytes,
      manifestBytes: prepared.value.accessManifestBytes,
      envelopeBytes: prepared.value.namespaceEnvelopeBytes,
      now: NOW + 1,
      resolveCurrentHumanAuthority: () => sender.signingPublicKey.slice(),
    } as const;
    const protectedOnly = await admitHumanPeerLiveShadowMessage(
      fullAdmissionInput,
    );
    expect(protectedOnly).toMatchObject({
      contentRepresentation: "full",
      contentVerification: "signed_representation_authenticated",
      ordinaryContent: null,
    });
    const requestDigest = crypto.hash(prepared.value.requestBytes);
    const replayedProtectedOnly =
      await admitHumanPeerLiveShadowMessageExactReplay({
        ...fullAdmissionInput,
        expectedRequestDigest: requestDigest,
      });
    expect(replayedProtectedOnly).toMatchObject({
      contentRepresentation: "full",
      contentVerification: "signed_representation_authenticated",
      ordinaryContent: null,
    });
    requestDigest.fill(0);
    expect(admitHumanPeerLiveShadowMessage({
      ...fullAdmissionInput,
      ordinaryPayloadBytes: prepared.value.ordinaryPayloadBytes,
    } as unknown as AdmitHumanPeerLiveShadowMessageInput)).rejects.toThrow(
      "forbids an ordinary payload sibling",
    );
    const substitutedCiphertext = prepared.value.encryptedPayloadBytes.slice();
    substitutedCiphertext[substitutedCiphertext.length - 1] =
      substitutedCiphertext.at(-1)! ^ 1;
    expect(admitHumanPeerLiveShadowMessage({
      ...fullAdmissionInput,
      encryptedPayloadBytes: substitutedCiphertext,
    })).rejects.toThrow();
    substitutedCiphertext.fill(0);
    const substitutedRequest = prepared.value.requestBytes.slice();
    substitutedRequest[substitutedRequest.length - 1] =
      substitutedRequest.at(-1)! ^ 1;
    expect(admitHumanPeerLiveShadowMessage({
      ...fullAdmissionInput,
      requestBytes: substitutedRequest,
    })).rejects.toThrow();
    substitutedRequest.fill(0);
    const substitutedPlan = planBytes.slice();
    substitutedPlan[substitutedPlan.length - 1] = substitutedPlan.at(-1)! ^ 1;
    expect(admitHumanPeerLiveShadowMessage({
      ...fullAdmissionInput,
      expectedPlanBytes: substitutedPlan,
    })).rejects.toThrow();
    substitutedPlan.fill(0);
    const decodedPlan = decodeHumanPeerLiveShadowMessagePlanV1(planBytes);
    const changedPolicyPlanBytes = encodeHumanPeerLiveShadowMessagePlanV1({
      ...decodedPlan,
      policyRevision: decodedPlan.policyRevision + 1,
    });
    expect(admitHumanPeerLiveShadowMessage({
      ...fullAdmissionInput,
      expectedPlanBytes: changedPolicyPlanBytes,
    })).rejects.toThrow();
    changedPolicyPlanBytes.fill(0);
    expect(() => encodeHumanPeerLiveShadowMessagePlanV1({
      ...decodedPlan,
      revision: (decodedPlan.revision + 1) as 0,
    })).toThrow("plan shape is invalid");
    decodedPlan.namespaceHeadDigest.fill(0);
    decodedPlan.namespacePublicationDigest.fill(0);
    decodedPlan.namespacePublicationSetDigest.fill(0);
    decodedPlan.namespaceAudienceFingerprint.fill(0);
    expect(admitHumanPeerLiveShadowMessage({
      ...fullAdmissionInput,
      resolveCurrentHumanAuthority: () =>
        recipient.signingPublicKey.slice(),
    })).rejects.toThrow();
    expect(admitHumanPeerLiveShadowMessage({
      ...fullAdmissionInput,
      resolveCurrentHumanAuthority: () => null,
    })).rejects.toThrow();
    const admitted = await admitAndPersistHumanPeerLiveShadowMessage(
      dependencies,
      admissionInput,
    );
    if (admitted.status !== "human_verified") {
      throw new Error(JSON.stringify({
        result: admitted,
        events: harness.events,
        cryptoFailure: harness.crypto.lastFailure?.message,
      }));
    }
    expect(admitted.status).toBe("human_verified");
    expect(harness.product.peekMessage(MESSAGE_ID)).toMatchObject({
      messageId: MESSAGE_ID,
      content: "Human peer protected hello",
      keyClass: "human",
      cryptoObjectId: admitted.protectedMessage.protectedPayload.status
        === "encrypted"
        ? admitted.protectedMessage.protectedPayload.cryptoObjectId
        : null,
    });
    expect(harness.crypto.completionCount).toBe(1);
    const replayed = await admitAndPersistHumanPeerLiveShadowMessage(
      dependencies,
      admissionInput,
    );
    expect(replayed.status).toBe("human_replayed");
    expect(harness.crypto.completionCount).toBe(1);

    const fullHarness = createFakeConversationShadowHarness({
      crypto, now: () => new Date(NOW + 1),
    });
    fullHarness.product.addSession({ sessionId: SESSION, roomId: ROOM, namespaceId: NAMESPACE });
    const full = await admitAndPersistHumanPeerLiveShadowMessage({
      ...dependencies,
      product: fullHarness.product,
      conversation: createDormantConversationShadowRepository({
        product: fullHarness.product, crypto: fullHarness.crypto,
      }),
    }, {
      representationMode: "full_encryption",
      operationId: OPERATION, planBytes,
      requestBytes: prepared.value.requestBytes,
      encryptedPayloadBytes: prepared.value.encryptedPayloadBytes,
      manifestBytes: prepared.value.accessManifestBytes,
      envelopeBytes: prepared.value.namespaceEnvelopeBytes,
      now: NOW + 1,
    });
    expect(full).toMatchObject({
      status: "human_verified", representationMode: "full_encryption",
      operationId: OPERATION, messageId: MESSAGE_ID,
      protectedMessage: { projection: {
        sourceUserId: "60000000-0000-4000-8000-000000000295",
      } },
    });
    expect(full).not.toHaveProperty("content");
    expect(fullHarness.product.peekMessage(MESSAGE_ID)).toMatchObject({ content: null });

    const eventDigest = liveShadowDurableEventDigestV1(crypto, {
      operationId: OPERATION,
      policyRevision: 4,
      transcriptOrdinal: 1,
      ordinaryPayloadBytes: prepared.value.ordinaryPayloadBytes,
      protectedMessage: admitted.protectedMessage,
    });
    let acknowledgements = 0;
    let profileUnlocked = false;
    let profileUnlocks = 0;
    const lockedRecipientVault: ClientProfileVault = Object.freeze({
      availability: async () => Object.freeze({
        status: profileUnlocked ? "available" as const : "locked" as const,
      }),
      unlock: async () => {
        profileUnlocked = true;
        profileUnlocks++;
        return Object.freeze({ status: "available" as const });
      },
      lock: () => recipient.vault.lock(),
      stageProfile: (input: StageClientProfileInput) =>
        recipient.vault.stageProfile(input),
      activateProfile: (coordinates: ClientProfileCoordinates, stageId: string) =>
        recipient.vault.activateProfile(coordinates, stageId),
      abortStagedProfile: (coordinates: ClientProfileCoordinates, stageId: string) =>
        recipient.vault.abortStagedProfile(coordinates, stageId),
      recoverInterruptedActivation: (coordinates: ClientProfileCoordinates,
        resolution: InterruptedClientProfileResolution) =>
        recipient.vault.recoverInterruptedActivation(coordinates, resolution),
      withOpenProfile: <Value>(coordinates: ClientProfileCoordinates,
        operation: (profileBytes: Uint8Array) => Promise<Value> | Value) => {
        if (!profileUnlocked) throw new Error("client profile vault is locked");
        return recipient.vault.withOpenProfile(coordinates, operation);
      },
      listPublicProfiles: () => recipient.vault.listPublicProfiles(),
      rotateWrappingMaterial: () => recipient.vault.rotateWrappingMaterial(),
      forgetProfile: (coordinates: ClientProfileCoordinates) =>
        recipient.vault.forgetProfile(coordinates),
    });
    const receiver = createVaultHumanPeerLiveShadowMessageReceiver({
      crypto,
      vault: lockedRecipientVault,
      coordinates: recipient.coordinates,
      namespaceAuthority: namespaceAuthority(
        generationKey,
        headDigest,
        audienceFingerprint,
      ),
      api: {
        planHumanPeerLiveShadowAcknowledgement: async () => Object.freeze({
          status: "ready" as const,
          subjectHumanId: RECIPIENT_HUMAN,
          clientDeviceId: RECIPIENT_DEVICE,
          clientDeviceSigningKeyGeneration: 1,
          hostAuthorizationRevision: 11,
        }),
        acknowledgeHumanPeerLiveShadowMessage: async (request) => {
          acknowledgements++;
          const bytes = Buffer.from(
            request.acknowledgementBytesBase64url,
            "base64url",
          );
          const acknowledgement = verifyHumanPeerLiveShadowAcknowledgement(
            crypto,
            {
              bytes,
              now: unixTimestamp(NOW + 3),
              resolveCurrentAuthority: () =>
                recipient.signingPublicKey.slice(),
            },
          );
          expect(acknowledgement.status).toBe("verified");
          expect(String(acknowledgement.committerDeviceId))
            .toBe(RECIPIENT_DEVICE);
          return "verified" as const;
        },
      },
      now: () => NOW + 2,
    });
    const ordinarySibling = Object.freeze({
      role: "user" as const,
      content: "Human peer protected hello",
    });
    const liveEvent = Object.freeze({
      wireVersion: 1,
      type: "message.human_peer_shadow",
      laneKey: `room:${ROOM}`,
      operationId: OPERATION,
      policyRevision: 4,
      transcriptOrdinal: 1,
      logicalMessageKey: `turn:${OPERATION}`,
      planBytesBase64url: base64url(planBytes),
      requestBytesBase64url: base64url(prepared.value.requestBytes),
      ordinaryPayloadBytesBase64url:
        base64url(prepared.value.ordinaryPayloadBytes),
      protectedMessage: admitted.protectedMessage,
      protectedMessageDigestBase64url:
        base64url(admitted.protectedMessageDigest),
      senderDeviceSigningPublicKeyBase64url:
        base64url(sender.signingPublicKey),
      durableEventDigestBase64url: base64url(eventDigest),
    });
    const received = await receiver.receive(liveEvent, ordinarySibling);
    expect(received).toMatchObject({
      status: "verified",
      reason: "matched",
      payload: ordinarySibling,
    });
    expect(acknowledgements).toBe(1);
    expect(profileUnlocks).toBe(1);

    const fullDigest = fullEncryptionDurableEventDigestV2(crypto, {
      operationId: OPERATION, policyRevision: 4, transcriptOrdinal: 1,
      protectedMessage: admitted.protectedMessage,
    });
    const fullEvent = { ...liveEvent, wireVersion: 2 as const,
      durableEventDigestBase64url: base64url(fullDigest) };
    delete (fullEvent as { ordinaryPayloadBytesBase64url?: string })
      .ordinaryPayloadBytesBase64url;
    expect(await receiver.receive(fullEvent)).toMatchObject({
      status: "verified", payload: ordinarySibling,
    });
    const ensuredRequests:
      Parameters<NamespaceAuthorityClient["ensure"]>[0][] = [];
    let ensured = false;
    let retryPlanRequests = 0;
    let retryAcknowledgements = 0;
    const retryBaseAuthority = namespaceAuthority(
      generationKey,
      headDigest,
      audienceFingerprint,
    );
    const retryReceiver = createVaultHumanPeerLiveShadowMessageReceiver({
      crypto,
      vault: lockedRecipientVault,
      coordinates: recipient.coordinates,
      namespaceAuthority: Object.freeze({
        ...retryBaseAuthority,
        ensure: async (
          request: Parameters<NamespaceAuthorityClient["ensure"]>[0],
        ) => {
          ensuredRequests.push(request);
          ensured = true;
          return Object.freeze({ status: "ready" as const });
        },
      }),
      api: {
        planHumanPeerLiveShadowAcknowledgement: async () => {
          retryPlanRequests++;
          return ensured
            ? Object.freeze({
                status: "ready" as const,
                subjectHumanId: RECIPIENT_HUMAN,
                clientDeviceId: RECIPIENT_DEVICE,
                clientDeviceSigningKeyGeneration: 1,
                hostAuthorizationRevision: 11,
              })
            : Object.freeze({
                status: "unavailable" as const,
                reason: "current_read_authority_unavailable",
              });
        },
        acknowledgeHumanPeerLiveShadowMessage: async () => {
          retryAcknowledgements++;
          return "verified" as const;
        },
      },
      now: () => NOW + 2,
    });
    expect(await retryReceiver.receive(fullEvent)).toMatchObject({
      status: "verified", reason: "matched", payload: ordinarySibling,
    });
    expect(ensuredRequests).toEqual([{
      sourceRoomId: ROOM,
      namespaceId: NAMESPACE,
      operationId: OPERATION,
      idempotencyKey: OPERATION,
      keyClass: "human",
    }]);
    expect(retryPlanRequests).toBe(2);
    expect(retryAcknowledgements).toBe(1);

    let deniedEnsureRequests = 0;
    let deniedAcknowledgements = 0;
    const deniedReceiver = createVaultHumanPeerLiveShadowMessageReceiver({
      crypto,
      vault: lockedRecipientVault,
      coordinates: recipient.coordinates,
      namespaceAuthority: Object.freeze({
        ...retryBaseAuthority,
        ensure: async () => {
          deniedEnsureRequests++;
          return Object.freeze({
            status: "unavailable" as const,
            reason: "authority_denied",
          });
        },
      }),
      api: {
        planHumanPeerLiveShadowAcknowledgement: async () => Object.freeze({
          status: "unavailable" as const,
          reason: "current_read_authority_unavailable",
        }),
        acknowledgeHumanPeerLiveShadowMessage: async () => {
          deniedAcknowledgements++;
          return "verified" as const;
        },
      },
      now: () => NOW + 2,
    });
    expect(await deniedReceiver.receive(fullEvent)).toMatchObject({
      status: "fallback", reason: "authority_stale",
    });
    expect(deniedEnsureRequests).toBe(1);
    expect(deniedAcknowledgements).toBe(0);
    expect(await deniedReceiver.receive(liveEvent, ordinarySibling))
      .toMatchObject({ status: "fallback", reason: "authority_stale" });
    expect(deniedEnsureRequests).toBe(1);

    const badDigest = fullDigest.slice(); badDigest[0] = badDigest[0]! ^ 1;
    expect(await receiver.receive({ ...fullEvent,
      durableEventDigestBase64url: base64url(badDigest) }))
      .toMatchObject({ status: "fallback" });
    const wrongRole = { ...admitted.protectedMessage,
      projection: { ...admitted.protectedMessage.projection,
        role: "assistant" as const } };
    const wrongRoleDigest = fullEncryptionDurableEventDigestV2(crypto, {
      operationId: OPERATION, policyRevision: 4, transcriptOrdinal: 1,
      protectedMessage: wrongRole,
    });
    const wrongRoleResult = await receiver.receive({ ...fullEvent,
      protectedMessage: wrongRole,
      durableEventDigestBase64url: base64url(wrongRoleDigest) });
    expect(wrongRoleResult).toMatchObject({ status: "fallback" });
    expect(wrongRoleResult?.status === "fallback" && wrongRoleResult.payload)
      .toBeUndefined();

    const acknowledgementFailureReceiver =
      createVaultHumanPeerLiveShadowMessageReceiver({
        crypto,
        vault: lockedRecipientVault,
        coordinates: recipient.coordinates,
        namespaceAuthority: namespaceAuthority(
          generationKey,
          headDigest,
          audienceFingerprint,
        ),
        api: {
          planHumanPeerLiveShadowAcknowledgement: async () => Object.freeze({
            status: "ready" as const,
            subjectHumanId: RECIPIENT_HUMAN,
            clientDeviceId: RECIPIENT_DEVICE,
            clientDeviceSigningKeyGeneration: 1,
            hostAuthorizationRevision: 11,
          }),
          acknowledgeHumanPeerLiveShadowMessage: async () => {
            throw new Error("simulated acknowledgement transport failure");
          },
        },
        now: () => NOW + 2,
      });
    expect(
      await acknowledgementFailureReceiver.receive(liveEvent, ordinarySibling),
    ).toMatchObject({
      status: "fallback",
      reason: "transport_unavailable",
      payload: ordinarySibling,
    });

    const history = createVaultRoomHistoryShadowMessageReader({
      crypto,
      vault: recipient.vault,
      coordinates: recipient.coordinates,
      namespaceAuthority: namespaceAuthority(
        generationKey,
        headDigest,
        audienceFingerprint,
      ),
      authority: Object.freeze({
        withOpenedRetainedRoomAuthority: async () => Object.freeze({
          status: "unavailable" as const,
          reason: "wrong_authority_scheme",
        }),
      }),
      resolveTrustedDeviceSigningPublicKey: async () => null,
      createProfileStageId: () => "stage_m295_history",
    });
    const historyInput = Object.freeze({
      sourceRoomId: ROOM,
      authority: Object.freeze({
        scheme: "domain_key_v2" as const,
        keyClass: "human" as const,
        subjectHumanId: RECIPIENT_HUMAN,
        readerDeviceId: RECIPIENT_DEVICE,
        readerDeviceSigningKeyGeneration: 1,
        hostAuthorizationRevision: 11,
        policyRevision: 4,
        roomId: ROOM,
        namespaceId: NAMESPACE,
        namespaceAccessRevision: 2,
        namespaceCurrentGeneration: 3,
        namespaceHeadDigestBase64url: base64url(headDigest),
        domainId: "domain:m295:human",
        domainKeyGeneration: 1,
        domainAuthorizationRevision: 11,
        domainHeadDigestBase64url: base64url(headDigest),
        namespaceBundleRevision: 1,
        namespaceBundleDigestBase64url: base64url(headDigest),
      }),
      signerEvidence: [Object.freeze({
        kind: "human_peer_live_shadow_request_v1" as const,
        operationId: OPERATION,
        planBytesBase64url: base64url(planBytes),
        requestBytesBase64url: base64url(prepared.value.requestBytes),
        requestDigestBase64url: base64url(prepared.value.requestDigest),
        senderDeviceId: SENDER_DEVICE,
        senderDeviceSigningKeyGeneration: 1,
        senderDeviceSigningPublicKeyBase64url:
          base64url(sender.signingPublicKey),
      })],
      records: [Object.freeze({
        sessionId: SESSION,
        messageId: String(MESSAGE_ID),
        editRevision: 0,
        shadowOperationId: OPERATION,
        shadowTranscriptOrdinal: 1,
        ordinaryPayloadBytesBase64url:
          base64url(prepared.value.ordinaryPayloadBytes),
        ordinarySibling: Object.freeze({
          payload: ordinarySibling,
        }),
        namespaceGeneration: 3,
        namespaceAccessRevision: 2,
        namespaceHeadDigestBase64url: base64url(headDigest),
        namespacePublicationDigestBase64url: base64url(publicationDigest),
        namespacePublicationSetDigestBase64url:
          base64url(publicationSetDigest),
        namespaceAudienceFingerprintBase64url:
          base64url(audienceFingerprint),
        protectedMessage: admitted.protectedMessage as
          ConversationProtectedMessageClientDtoV2,
      })],
    });
    const historyResult = await history.reconcile(historyInput);
    expect(historyResult).toEqual({
      records: [{
        sessionId: SESSION,
        messageId: String(MESSAGE_ID),
        editRevision: 0,
        status: "verified",
        verification: "independent_parity",
        payload: ordinarySibling,
      }],
      eligibleCount: 1,
      verifiedCount: 1,
      fallbackCounts: {},
    });
    const shadowRecord = historyInput.records[0]!;
    const {
      ordinaryPayloadBytesBase64url: _ordinaryPayloadBytes,
      ordinarySibling: _ordinarySibling,
      ...protectedRecord
    } = shadowRecord;
    const fullRecord = Object.freeze({
      ...protectedRecord,
      representationMode: "protected-only" as const,
      selectedSource: Object.freeze({
        role: "user" as const,
        sourceUserId: "60000000-0000-4000-8000-000000000295",
      }),
    });
    const fullHistory = await history.reconcile(Object.freeze({
      ...historyInput,
      records: Object.freeze([fullRecord]),
    }));
    expect(fullHistory.records).toEqual([{
      sessionId: SESSION,
      messageId: String(MESSAGE_ID),
      editRevision: 0,
      status: "verified",
      verification: "signed_representation_authenticated",
      payload: ordinarySibling,
    }]);
    expect("ordinarySibling" in fullRecord).toBe(false);
    expect("ordinaryPayloadBytesBase64url" in fullRecord).toBe(false);
    const wrongSelectedRole = await history.reconcile(Object.freeze({
      ...historyInput,
      records: Object.freeze([Object.freeze({
        ...fullRecord,
        selectedSource: Object.freeze({ role: "assistant" as const }),
      })]),
    }));
    expect(wrongSelectedRole.records[0]).toMatchObject({
      status: "fallback", reason: "integrity_failure",
    });
    const encryptedTransport = admitted.protectedMessage.protectedPayload;
    if (encryptedTransport.status !== "encrypted") {
      throw new Error("Expected encrypted Human-peer history fixture");
    }
    const changedCiphertext = Buffer.from(
      encryptedTransport.encryptedPayloadBytesBase64url,
      "base64url",
    );
    const lastCiphertextByte = changedCiphertext.length - 1;
    changedCiphertext[lastCiphertextByte] =
      changedCiphertext[lastCiphertextByte]! ^ 1;
    const wrongCipher = await history.reconcile(Object.freeze({
      ...historyInput,
      records: Object.freeze([Object.freeze({
        ...fullRecord,
        protectedMessage: Object.freeze({
          ...admitted.protectedMessage,
          protectedPayload: Object.freeze({
            ...encryptedTransport,
            encryptedPayloadBytesBase64url:
              changedCiphertext.toString("base64url"),
          }),
        }) as ConversationProtectedMessageClientDtoV2,
      })]),
    }));
    changedCiphertext.fill(0);
    expect(wrongCipher.records[0]).toMatchObject({
      status: "fallback", reason: "integrity_failure",
    });
    const missingEvidence = await history.reconcile(Object.freeze({
      ...historyInput,
      signerEvidence: Object.freeze([]),
    }));
    expect(missingEvidence).toMatchObject({
      verifiedCount: 0,
      fallbackCounts: { signer_evidence_unavailable: 1 },
      records: [{
        status: "fallback",
        reason: "signer_evidence_unavailable",
      }],
    });

    eventDigest.fill(0);
    generationKey.fill(0);
    headDigest.fill(0);
    publicationDigest.fill(0);
    publicationSetDigest.fill(0);
    audienceFingerprint.fill(0);
    sender.signingPublicKey.fill(0);
    recipient.signingPublicKey.fill(0);
  });
  test("terminalizes expired Human-peer plans without another Room send", async () => {
    const statements: string[] = [];
    const product = {
      async query(sql: string) {
        statements.push(sql);
        return [
          { operation_id: "expired-planned" },
          { operation_id: "expired-verified" },
        ];
      },
      async transactionOnce<Value>(
        use: (connection: PostgresJsBridgeConnection) => Promise<Value>,
      ) {
        return use(product as unknown as PostgresJsBridgeConnection);
      },
    } as unknown as PostgresJsBridgeConnection;
    const planner = new PostgresHumanPeerLiveShadowPlanner(
      product,
      product,
      undefined,
      "test-server",
    );

    expect(await planner.reconcileExpired(NOW, 2)).toBe(2);
    expect(statements).toHaveLength(2);
    expect(statements[0]).toContain("for update");
    expect(statements[0]).toContain("skip locked");
    expect(statements[0]).toContain("in ($1, $2)");
    expect(statements[1]).toContain("update \"conversation_human_peer_shadow_operations\"");
    expect(statements[1]).toContain("\"terminal_reason\" = $2");
  });
});

describe("Browser V2 Human-only negotiation", () => {
  test.each([
    { full: false, substitutedMarker: false },
    { full: true, substitutedMarker: false },
    { full: false, substitutedMarker: true },
  ])("validates Human-only plan negotiation %j", async ({ full, substitutedMarker }) => {
    const crypto = new LatticeCrypto(seededRng(741_002));
    const sender = await createProfile({ crypto, deviceId: SENDER_DEVICE,
      humanId: SENDER_HUMAN, userId: "60000000-0000-4000-8000-000000000001",
      hostAuthorizationRevision: 7 });
    const generationKey = new Uint8Array(32).fill(0x95);
    const headDigest = new Uint8Array(32).fill(0x31);
    const publicationDigest = new Uint8Array(32).fill(0x32);
    const publicationSetDigest = new Uint8Array(32).fill(0x33);
    const audienceFingerprint = new Uint8Array(32).fill(0x34);
    const planBytes = encodeHumanPeerLiveShadowMessagePlanV1({
      formatVersion: 1,
      purpose: "message.human_peer_live_shadow_plan",
      operationId: OPERATION,
      clientIdempotencyKey: "human-peer-negotiation",
      policyRevision: 4,
      sessionId: SESSION,
      roomId: ROOM,
      humanMessageId: MESSAGE_ID,
      revision: 0,
      transcriptOrdinal: 1,
      role: "user",
      createdAt: unixTimestamp(NOW),
      subjectHumanId: humanId(SENDER_HUMAN),
      committerDeviceId: cryptoDeviceId(SENDER_DEVICE),
      committerDeviceSigningKeyGeneration: 1,
      hostAuthorizationRevision: authorizationRevision(7),
      namespaceId: namespaceId(NAMESPACE),
      keyClass: "human",
      namespaceAccessRevision: accessRevision(2),
      namespaceKeyGeneration: namespaceGeneration(3),
      namespaceHeadDigest: headDigest,
      namespacePublicationDigest: publicationDigest,
      namespacePublicationSetDigest: publicationSetDigest,
      namespaceAudienceFingerprint: audienceFingerprint,
      attemptCoordinate: "human-peer-negotiation-attempt",
      issuedAt: unixTimestamp(NOW),
      deadlineAt: unixTimestamp(NOW + 30_000),
    });
    let sent = 0;
    let journaled = 0;
    const client = createAuthorizedHumanLiveShadowMessageClient({
      planRequestVersion: 2, crypto, vault: sender.vault, coordinates: sender.coordinates,
      namespaceAuthority: namespaceAuthority(generationKey, headDigest, audienceFingerprint),
      now: () => NOW + 1, normalizeContent: (content) => content,
      createIdempotencyKey: () => "human-peer-negotiation",
      ensureJournalAvailable: async () => true,
      journal: createPreparedMutationJournal({ now: () => NOW + 1, vault: {
        listIndexes: async () => [],
        putSealed: async ({ canonicalBody }) => {
          journaled++;
          const request: unknown = JSON.parse(new TextDecoder().decode(canonicalBody));
          expect(request).toMatchObject({ authorizationScheme: "human_peer_v1" });
          if (full) expect(request).not.toHaveProperty("ordinaryPayloadBytesBase64url");
          else expect(request).toHaveProperty("ordinaryPayloadBytesBase64url");
          return "inserted";
        },
        withOpenedBody: async () => { throw new Error("not used"); },
        updateIndex: async () => false, removeExact: async () => false,
      } }),
      api: {
        planLiveShadowRoomMessage: async (_roomId, request) => {
          expect(request.requestVersion).toBe(2);
          return { responseVersion: 1, status: "planned",
            planBytesBase64url: base64url(planBytes),
            ...(substitutedMarker ? { authorizationScheme: "human_ai_readable_v2" as const } : {}),
            ...(full ? { representationMode: "full_encryption" as const } : {}) };
        },
        sendRoomMessage: async (_roomId, body) => {
          sent++;
          expect(journaled).toBe(1);
          expect("content" in body).toBe(!full);
          expect(body.liveShadow).toMatchObject({ status: "prepared", authorizationScheme: "human_peer_v1" });
          const prepared = body.liveShadow;
          if (prepared?.status !== "prepared") throw new Error("unprotected send");
          const decode = (bytes: string) => new Uint8Array(Buffer.from(bytes, "base64url"));
          const admitted = await admitHumanPeerLiveShadowMessage({
            crypto, contentRepresentation: "full", expectedPlanBytes: planBytes,
            requestBytes: decode(prepared.signedRequestBytesBase64url),
            encryptedPayloadBytes: decode(prepared.encryptedPayloadBytesBase64url),
            manifestBytes: decode(prepared.accessManifestBytesBase64url),
            envelopeBytes: decode(prepared.namespaceEnvelopeBytesBase64url),
            now: NOW + 1, resolveCurrentHumanAuthority: () => sender.signingPublicKey.slice(),
          });
          expect(admitted).toMatchObject({ contentVerification: "signed_representation_authenticated" });
          return { messageId: MESSAGE_ID, jobId: "", accepted: true, attachments: [], coalesced: false };
        },
      },
    });
    const sending = client.send(ROOM, { content: "Human-only negotiation check", clientActionSessionId: "peer-browser" });
    if (substitutedMarker) {
      expect(sending).rejects.toThrow("Protected message plan is invalid");
      expect(journaled).toBe(0);
      expect(sent).toBe(0);
    } else {
      await sending;
      expect(sent).toBe(1);
    }
    generationKey.fill(0);
    planBytes.fill(0);
  });
});
