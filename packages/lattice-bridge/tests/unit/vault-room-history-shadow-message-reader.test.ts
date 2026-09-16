import { describe, expect, test } from "bun:test";
import {
  LatticeCrypto,
  accessRevision,
  authorizationRevision,
  cryptoDeviceId,
  humanId,
  namespaceGeneration,
  namespaceId,
  objectId as latticeObjectId,
  prepareHumanAiReadableLiveShadowMessageRequest,
  prepareHumanPeerLiveShadowMessageRequest,
  unixTimestamp,
  encodeHumanAiReadableLiveShadowMessagePlan,
} from "@nautilo/lattice-crypto";
import {
  deriveHumanMessageEditCryptoObjectIdV1,
  encodeHumanPeerLiveShadowMessagePlanV1,
} from "@nautilo/lattice-crypto/wire";
import { seededRng } from "@nautilo/lattice-crypto/testing";

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
import type { ClientProfileCoordinates, ClientProfileVault } from
  "../../src/client-vault/types.ts";
import type { RetainedRoomNamespaceGeneration } from
  "../../src/client/message/namespace-authority-client.ts";
import {
  createVaultRoomHistoryShadowMessageReader,
  type ConversationProtectedMessageClientDtoV2,
  type RoomHistoryShadowRecordTransportV1,
  type RoomHistoryExistingRepresentationRecordTransportV1,
  type RoomHistoryHumanEditedRepresentationRecordTransportV1,
  type VaultRoomHistoryShadowReadInputV1,
} from
  "../../src/client/message/vault-room-history-shadow-message-reader.ts";
import type {
  RetainedRoomAuthorityClient,
  OpenedRetainedRoomAuthority,
} from
  "../../src/client/message/namespace-authority-client.ts";
import type { NamespaceAuthorityClient } from
  "../../src/client/message/namespace-authority-client.ts";
import { createDomainNamespaceAuthorityAdapterV2 } from
  "../../src/client/message/domain-namespace-authority-adapter.ts";
import type {
  DomainNamespaceAccessResultV2,
  DomainNamespaceAuthorityClientV2,
  OpenedDomainNamespaceAuthorityV2,
  OpenedDomainNamespaceGenerationV2,
} from
  "../../src/client/message/domain-namespace-authority-client.ts";
import type { DomainKeyAuthorityClientV2 } from
  "../../src/client/message/domain-key-authority-client.ts";
import {
  readPreparedConversationCryptoRevision,
  readPreparedConversationCryptoRevisionSnapshot,
} from "../../src/message/conversation-prepared-revision.ts";
import { deriveLiveShadowMessageCryptoObjectIdV1, deriveMessageCryptoObjectIdV2 } from
  "../../src/message/conversation-repository.ts";
import { prepareHumanExistingMessageRepresentationCryptoRevision,
  prepareHumanPeerLiveShadowCryptoRevision } from
  "../../src/message/human-existing-message-representation-crypto.ts";
import {
  encodeMessagePayloadV2,
  type MessagePayloadV2,
} from "../../src/message/message-payload-v2.ts";
import { MemoryClientProfileVault } from
  "../../src/testing/client-profile-vault.ts";
import { sharedHistoryExecution } from "../fixtures/room-history-shared-execution.ts";
import { prepareDeviceWrappedLiveShadowAgentConversationCryptoRevisionWithDek,
  prepareForegroundRuntimeExistingMessageCryptoRevision } from
  "../../src/message/agent-conversation-crypto.ts";

const NOW = 1_800_275_000_000;
const ROOM = "27500000-0000-4000-8000-000000000001";
const NAMESPACE = "27500000-0000-4000-8000-000000000002";
const HUMAN = "27500000-0000-4000-8000-000000000003";
const SESSION = "27500000-0000-4000-8000-000000000004";
const ORIGINAL_AGENT = "27500000-0000-4000-8000-000000000009";
const DEVICE = "device:m275:browser";
const COORDINATES: ClientProfileCoordinates = Object.freeze({
  serverScope: "https://m275.test",
  userId: "27500000-0000-4000-8000-000000000005",
  humanActorId: HUMAN,
  profileId: "profile:m275:browser",
  deviceId: DEVICE,
  installationLineageDigest: "27".repeat(32),
});

function b64(value: Uint8Array): string {
  return Buffer.from(value).toString("base64url");
}

async function fixture() {
  const crypto = new LatticeCrypto(
    seededRng(275_001),
    { now: () => NOW },
  );
  const signing = crypto.generateSigningKeyPair();
  const encryption = await crypto.generateEncryptionKeyPair();
  const profileV2: OpenedClientDeviceProfileV2 = Object.freeze({
    formatVersion: 2,
    deviceId: DEVICE,
    signingPublicKey: signing.publicKey,
    signingPrivateKey: signing.privateKey,
    encryptionPublicKey: encryption.publicKey,
    encryptionPrivateKey: encryption.privateKey,
    trustedDeviceRevision: 4,
    trustedHostAuthorizationRevision: 7,
    deliveryHighWatermark: 0,
    keyringDeliveries: Object.freeze([]),
  });
  const profileV2Bytes = encodeClientDeviceProfileV2(profileV2);
  const profileV3 = await createClientDeviceProfileV3Candidate({
    crypto,
    currentProfileBytes: profileV2Bytes,
    expectedDeviceId: DEVICE,
  });
  const profileV3Bytes = encodeClientDeviceProfileV3(profileV3);
  const profileV4 = await createClientDeviceProfileV4Candidate({
    crypto,
    currentProfileBytes: profileV3Bytes,
    expectedDeviceId: DEVICE,
  });
  const vault = new MemoryClientProfileVault();
  await vault.unlock();
  await stageAndActivateClientDeviceProfileV4({
    crypto,
    vault,
    coordinates: COORDINATES,
    stageId: "stage:m275:profile",
    generation: 1,
    publicState: {
      clientKind: "browser",
      publicFingerprint: "27".repeat(32),
    },
    candidate: profileV4,
  });
  destroyOpenedClientDeviceProfileV4(profileV4);
  destroyOpenedClientDeviceProfileV3(profileV3);
  profileV2Bytes.fill(0);
  profileV3Bytes.fill(0);

  const generationKey = new Uint8Array(32).fill(0x51);
  const headDigest = new Uint8Array(32).fill(0x52);
  const publicationDigest = new Uint8Array(32).fill(0x53);
  const publicationSetDigest = new Uint8Array(32).fill(0x54);
  const audienceFingerprint = new Uint8Array(32).fill(0x55);
  const retained: RetainedRoomNamespaceGeneration = Object.freeze({
    generation: namespaceGeneration(1),
    accessRevision: accessRevision(2),
    headDigest,
    publicationDigest,
    publicationSetDigest,
    audienceFingerprint,
    generationKey,
  });
  const payload: MessagePayloadV2 = Object.freeze({
    role: "user",
    content: "opened from durable ciphertext",
  });
  const objectId = deriveLiveShadowMessageCryptoObjectIdV1({
    operationId: "history:m275:operation",
    sessionId: SESSION,
    messageId: 275,
    revision: 0,
    authorRole: "user",
    transcriptOrdinal: 1,
  });
  const prepared = prepareHumanExistingMessageRepresentationCryptoRevision({
    crypto,
    objectId,
    payload,
    createdAt: NOW,
    namespace: {
      namespaceId: NAMESPACE,
      accessRevision: 2,
      keyGeneration: 1,
      aiKey: generationKey,
    },
    device: {
      deviceId: DEVICE,
      hostAuthorizationRevision: 7,
      signingPrivateKey: signing.privateKey,
    },
    resolveCurrentAuthorization: () => null,
  });
  const snapshot = readPreparedConversationCryptoRevision(prepared);
  const protectedMessage: ConversationProtectedMessageClientDtoV2 =
    Object.freeze({
      dtoVersion: 2,
      projection: Object.freeze({
        messageId: "275",
        logicalMessageKey: "logical:m275:275",
        sessionId: SESSION,
        roomId: ROOM,
        namespaceId: NAMESPACE,
        role: "user",
        createdAt: new Date(NOW).toISOString(),
        editRevision: 0,
        sourceUserId: COORDINATES.userId,
      }),
      protectedPayload: Object.freeze({
        status: "encrypted",
        cryptoObjectId: objectId,
        payloadVersion: 2,
        keyClass: "ai",
        encryptedPayloadBytesBase64url: b64(
          snapshot.object.payloadBytes.ciphertext,
        ),
        accessManifestBytesBase64url: b64(snapshot.access.manifestBytes),
        namespaceEnvelopeBytesBase64url: b64(
          snapshot.access.envelopeBytes[0]!,
        ),
      }),
    });
  const record: RoomHistoryShadowRecordTransportV1 = Object.freeze({
    sessionId: SESSION,
    messageId: "275",
    editRevision: 0,
    shadowOperationId: "history:m275:operation",
    shadowTranscriptOrdinal: 1,
    ordinaryPayloadBytesBase64url: b64(encodeMessagePayloadV2(payload)),
    ordinarySibling: Object.freeze({
      logicalMessageKey: "logical:m275:275",
      payload,
    }),
    namespaceGeneration: 1,
    namespaceAccessRevision: 2,
    namespaceHeadDigestBase64url: b64(headDigest),
    namespacePublicationDigestBase64url: b64(publicationDigest),
    namespacePublicationSetDigestBase64url: b64(publicationSetDigest),
    namespaceAudienceFingerprintBase64url: b64(audienceFingerprint),
    protectedMessage,
  });
  const authorityInput = Object.freeze({
    scheme: "domain_key_v2" as const,
    keyClass: "ai" as const,
    subjectHumanId: HUMAN,
    readerDeviceId: DEVICE,
    readerDeviceSigningKeyGeneration: 1,
    hostAuthorizationRevision: 1,
    policyRevision: 1,
    roomId: ROOM,
    namespaceId: NAMESPACE,
    namespaceAccessRevision: 2,
    namespaceCurrentGeneration: 1,
    namespaceHeadDigestBase64url: b64(audienceFingerprint),
    domainId: "domain:m275",
    domainKeyGeneration: 1,
    domainAuthorizationRevision: 4,
    domainHeadDigestBase64url: b64(new Uint8Array(32).fill(0x59)),
    namespaceBundleRevision: 1,
    namespaceBundleDigestBase64url: b64(new Uint8Array(32).fill(0x57)),
  });
  let authorityCalls = 0;
  const openedNamespaceKeyClasses: Array<"ai" | "human"> = [];
  let requiredCurrentNamespaceAuthority: Readonly<{
    generation: number;
    accessRevision: number;
    headDigestBase64url: string;
  }> | undefined;
  const observedCurrentNamespaceAuthorities: Array<Readonly<{
    generation: number | undefined;
    accessRevision: number | undefined;
    headDigestBase64url: string | undefined;
  }>> = [];
  const authority: RetainedRoomAuthorityClient = Object.freeze({
    async withOpenedRetainedRoomAuthority<Value>(
      _request: Parameters<
        RetainedRoomAuthorityClient[
          "withOpenedRetainedRoomAuthority"
        ]
      >[0],
      use: (
        authority: OpenedRetainedRoomAuthority,
      ) => Promise<Value> | Value,
    ) {
      authorityCalls++;
      return Object.freeze({
        status: "opened" as const,
        value: await use(Object.freeze({
          retainedGenerations: Object.freeze([retained]),
        })),
      });
    },
  });
  const makeInput = (
    records: readonly RoomHistoryShadowRecordTransportV1[],
  ): VaultRoomHistoryShadowReadInputV1 => Object.freeze({
    sourceRoomId: ROOM,
    authority: authorityInput,
    signerEvidence: Object.freeze([]),
    records,
  });
  const namespaceAuthority: NamespaceAuthorityClient =
    Object.freeze({
      ensure: async () => Object.freeze({
        status: "unavailable" as const,
        reason: "not-used",
      }),
      synchronizeRecipients: async () => Object.freeze({
        status: "unavailable" as const,
        reason: "not-used",
      }),
      withOpenedAiGenerations: async () => Object.freeze({
        status: "unavailable" as const,
        reason: "not-used",
      }),
      async withOpenedGenerations<Value>(_request: Parameters<NonNullable<
        NamespaceAuthorityClient["withOpenedGenerations"]
      >>[0], use: (entries: readonly import("../../src/client/message/namespace-authority-client.ts").OpenedNamespaceGeneration[]) => Value | Promise<Value>) {
        openedNamespaceKeyClasses.push(_request.keyClass);
        const requested = _request.authority.find((entry) =>
          entry.namespaceId === NAMESPACE)?.retainedGenerations;
        const current = requested?.at(-1);
        observedCurrentNamespaceAuthorities.push(Object.freeze({
          generation: current?.generation,
          accessRevision: current?.accessRevision,
          headDigestBase64url: current === undefined ? undefined : b64(current.headDigest),
        }));
        if (requiredCurrentNamespaceAuthority !== undefined) {
          const historical = requested?.find((entry) =>
            entry.generation === retained.generation
            && entry.accessRevision === retained.accessRevision);
          if (historical === undefined
            || b64(historical.headDigest) !== b64(retained.headDigest)
            || b64(historical.publicationDigest) !== b64(retained.publicationDigest)
            || b64(historical.publicationSetDigest) !== b64(retained.publicationSetDigest)
            || b64(historical.audienceFingerprint) !== b64(retained.audienceFingerprint)
            || current?.generation !== requiredCurrentNamespaceAuthority.generation
            || current.accessRevision !== requiredCurrentNamespaceAuthority.accessRevision
            || b64(current.headDigest) !== requiredCurrentNamespaceAuthority.headDigestBase64url) {
            return Object.freeze({ status: "unavailable" as const,
              reason: "binding_stale" });
          }
        }
        return Object.freeze({ status: "opened" as const,
        value: await use([Object.freeze({
          namespaceId: namespaceId(NAMESPACE), keyClass: _request.keyClass,
          generation: retained.generation, accessRevision: retained.accessRevision,
          generationKey: retained.generationKey,
          audienceFingerprint: retained.audienceFingerprint,
          headDigest: retained.headDigest,
        })]) });
      },
    });
  const createReader = (
    selectedVault: ClientProfileVault = vault,
    onDiagnostic?: Parameters<typeof createVaultRoomHistoryShadowMessageReader>[0]["onDiagnostic"],
    selectedNamespaceAuthority: NamespaceAuthorityClient = namespaceAuthority,
  ) =>
    createVaultRoomHistoryShadowMessageReader({
      crypto,
      vault: selectedVault,
      coordinates: COORDINATES,
      authority,
      namespaceAuthority: selectedNamespaceAuthority,
      resolveTrustedDeviceSigningPublicKey: async (request) =>
        request.deviceId === DEVICE
          && request.hostAuthorizationRevision === 7
          && request.trustedDeviceRevision === 4
          ? signing.publicKey.slice()
          : null,
      createProfileStageId: () => "stage:m275:signer",
      ...(onDiagnostic === undefined ? {} : { onDiagnostic }),
    });
  return {
    crypto,
    retained,
    authorityCalls: () => authorityCalls,
    openedNamespaceKeyClasses: () => [...openedNamespaceKeyClasses],
    observedCurrentNamespaceAuthorities: () => [
      ...observedCurrentNamespaceAuthorities,
    ],
    requireCurrentNamespaceAuthority(value: Readonly<{
      generation: number;
      accessRevision: number;
      headDigestBase64url: string;
    }>) {
      requiredCurrentNamespaceAuthority = value;
    },
    createReader,
    makeInput,
    payload,
    protectedMessage,
    record,
    signing,
  };
}

async function humanPeerHistoryFixture() {
  const state = await fixture();
  const operationId = "history:m314:human-peer";
  const clientIdempotencyKey = "history-m314-human-peer";
  const attemptCoordinate = "history-m314-human-peer-attempt";
  const planBytes = encodeHumanPeerLiveShadowMessagePlanV1({
    formatVersion: 1,
    purpose: "message.human_peer_live_shadow_plan",
    operationId,
    clientIdempotencyKey,
    policyRevision: 4,
    sessionId: SESSION,
    roomId: ROOM,
    humanMessageId: 275,
    revision: 0,
    transcriptOrdinal: 1,
    role: "user",
    createdAt: unixTimestamp(NOW),
    subjectHumanId: humanId(HUMAN),
    committerDeviceId: cryptoDeviceId(DEVICE),
    committerDeviceSigningKeyGeneration: 1,
    hostAuthorizationRevision: authorizationRevision(7),
    namespaceId: namespaceId(NAMESPACE),
    keyClass: "human",
    namespaceAccessRevision: accessRevision(2),
    namespaceKeyGeneration: namespaceGeneration(1),
    namespaceHeadDigest: state.retained.headDigest,
    namespacePublicationDigest: state.retained.publicationDigest,
    namespacePublicationSetDigest: state.retained.publicationSetDigest,
    namespaceAudienceFingerprint: state.retained.audienceFingerprint,
    attemptCoordinate,
    issuedAt: unixTimestamp(NOW - 1_000),
    deadlineAt: unixTimestamp(NOW + 29_000),
  });
  const objectId = deriveLiveShadowMessageCryptoObjectIdV1({
    operationId,
    sessionId: SESSION,
    messageId: 275,
    revision: 0,
    authorRole: "user",
    transcriptOrdinal: 1,
  });
  const prepared = prepareHumanPeerLiveShadowCryptoRevision({
    crypto: state.crypto,
    objectId,
    payload: state.payload,
    createdAt: NOW,
    namespace: {
      namespaceId: NAMESPACE,
      accessRevision: 2,
      keyGeneration: 1,
      humanKey: state.retained.generationKey,
    },
    device: {
      deviceId: DEVICE,
      hostAuthorizationRevision: 7,
      signingPrivateKey: state.signing.privateKey,
    },
    resolveCurrentAuthorization: () => null,
  });
  const snapshot = readPreparedConversationCryptoRevision(prepared);
  const plaintext = encodeMessagePayloadV2(state.payload);
  const request = prepareHumanPeerLiveShadowMessageRequest(state.crypto, {
    operationId,
    clientIdempotencyKey,
    policyRevision: 4,
    sessionId: SESSION,
    roomId: ROOM,
    messageId: 275,
    revision: 0,
    transcriptOrdinal: 1,
    role: "user",
    createdAt: unixTimestamp(NOW),
    subjectHumanId: humanId(HUMAN),
    committerDeviceId: cryptoDeviceId(DEVICE),
    committerDeviceSigningKeyGeneration: 1,
    hostAuthorizationRevision: authorizationRevision(7),
    namespaceId: namespaceId(NAMESPACE),
    keyClass: "human",
    namespaceAccessRevision: accessRevision(2),
    namespaceKeyGeneration: namespaceGeneration(1),
    namespaceHeadDigest: state.retained.headDigest,
    namespacePublicationDigest: state.retained.publicationDigest,
    namespacePublicationSetDigest: state.retained.publicationSetDigest,
    namespaceAudienceFingerprint: state.retained.audienceFingerprint,
    issuedAt: unixTimestamp(NOW - 1_000),
    deadlineAt: unixTimestamp(NOW + 29_000),
    cryptoObjectId: latticeObjectId(objectId),
    planDigest: state.crypto.hash(planBytes),
    plaintextPayloadDigest: state.crypto.hash(plaintext),
    encryptedPayloadDigest: state.crypto.hash(
      snapshot.object.payloadBytes.ciphertext,
    ),
    manifestDigest: state.crypto.hash(snapshot.access.manifestBytes),
    envelopeDigest: state.crypto.hash(snapshot.access.envelopeBytes[0]!),
    committerSigningPublicKey: state.signing.publicKey,
    committerSigningPrivateKey: state.signing.privateKey,
  });
  plaintext.fill(0);
  const record: RoomHistoryShadowRecordTransportV1 = Object.freeze({
    ...state.record,
    shadowOperationId: operationId,
    protectedMessage: Object.freeze({
      ...state.protectedMessage,
      protectedPayload: Object.freeze({
        status: "encrypted" as const,
        cryptoObjectId: objectId,
        payloadVersion: 2 as const,
        keyClass: "human" as const,
        encryptedPayloadBytesBase64url: b64(
          snapshot.object.payloadBytes.ciphertext,
        ),
        accessManifestBytesBase64url: b64(snapshot.access.manifestBytes),
        namespaceEnvelopeBytesBase64url: b64(
          snapshot.access.envelopeBytes[0]!,
        ),
      }),
    }),
  });
  const base = state.makeInput([record]);
  const input: VaultRoomHistoryShadowReadInputV1 = Object.freeze({
    ...base,
    authority: Object.freeze({ ...base.authority, keyClass: "human" }),
    signerEvidence: Object.freeze([Object.freeze({
      kind: "human_peer_live_shadow_request_v1" as const,
      operationId,
      planBytesBase64url: b64(planBytes),
      requestBytesBase64url: b64(request.bytes),
      requestDigestBase64url: b64(request.requestDigest),
      senderDeviceId: DEVICE,
      senderDeviceSigningKeyGeneration: 1,
      senderDeviceSigningPublicKeyBase64url: b64(state.signing.publicKey),
    })]),
  });
  return { state, input };
}

function nativeHistoryNamespaceAuthority(
  state: Awaited<ReturnType<typeof fixture>>,
  current: Readonly<{
    generation: number;
    accessRevision: number;
    headDigest: Uint8Array;
  }>,
) {
  const observed: Array<Readonly<{
    generation: number | undefined;
    accessRevision: number | undefined;
    headDigestBase64url: string | undefined;
  }>> = [];
  const namespaceAuthority: DomainNamespaceAuthorityClientV2 = Object.freeze({
    ensure: async () => Object.freeze({ status: "ready" as const }),
    servicePending: async () => 0,
    async withOpenedGenerations<Value>(
      request: Parameters<
        DomainNamespaceAuthorityClientV2["withOpenedGenerations"]
      >[0],
      use: (
        entries: readonly OpenedDomainNamespaceGenerationV2[],
        _authority: OpenedDomainNamespaceAuthorityV2,
      ) => Value | Promise<Value>,
    ): Promise<DomainNamespaceAccessResultV2<Value>> {
      observed.push(Object.freeze({
        generation: request.expectedCurrentGeneration,
        accessRevision: request.expectedAccessRevision,
        headDigestBase64url: request.expectedCurrentHeadDigest === undefined
          ? undefined
          : b64(request.expectedCurrentHeadDigest),
      }));
      if (
        request.expectedCurrentGeneration !== current.generation
        || request.expectedAccessRevision !== current.accessRevision
        || request.expectedCurrentHeadDigest === undefined
        || b64(request.expectedCurrentHeadDigest) !== b64(current.headDigest)
      ) {
        return Object.freeze({
          status: "unavailable" as const,
          reason: "binding_stale",
        });
      }
      return Object.freeze({
        status: "opened" as const,
        value: await use(Object.freeze([
          Object.freeze({
            namespaceId: NAMESPACE,
            keyClass: "human" as const,
            accessRevision: 2,
            generation: 1,
            headDigest: state.retained.headDigest,
            generationKey: state.retained.generationKey,
          }),
          Object.freeze({
            namespaceId: NAMESPACE,
            keyClass: "human" as const,
            accessRevision: current.accessRevision,
            generation: current.generation,
            headDigest: current.headDigest,
            generationKey: new Uint8Array(32).fill(0x68),
          }),
        ]), Object.freeze({
          sourceRoomId: request.sourceRoomId,
          serverId: "https://m313.test",
          namespaceId: request.namespaceId,
          keyClass: request.keyClass,
          namespaceAccessRevision: current.accessRevision,
          namespaceKeyGeneration: current.generation,
          namespaceHeadDigest: current.headDigest,
          domainId: "domain:m313:history",
          domainKeyGeneration: 1,
          domainAuthorizationRevision: 1,
          domainHeadDigest: current.headDigest,
          bundleRevision: 1,
          bundleDigest: current.headDigest,
        })),
      });
    },
  });
  const domainAuthority: DomainKeyAuthorityClientV2 = Object.freeze({
    ensure: async () => Object.freeze({
      status: "unavailable" as const,
      reason: "not-used",
    }),
    withDomainKey: async () => Object.freeze({
      status: "unavailable" as const,
      reason: "not-used",
    }),
    servicePending: async () => Object.freeze({
      status: "unavailable" as const,
      reason: "not-used",
    }),
  });
  return Object.freeze({
    authority: createDomainNamespaceAuthorityAdapterV2({
      domainAuthority,
      namespaceAuthority,
    }),
    observed: () => [...observed],
  });
}

async function sharedExecutionFixture(role: "assistant" | "tool") {
  const state = await fixture();
  const execution = sharedHistoryExecution(state.crypto, {
    operationId: "history:shared:execution", sessionId: SESSION, roomId: ROOM,
    namespaceId: NAMESPACE, humanId: HUMAN, deviceId: DEVICE,
    agentId: "27500000-0000-4000-8000-000000000006",
    // Expired live execution authority remains valid historical signer evidence.
    createdAt: NOW - 60_000, generation: 1, accessRevision: 2,
    headDigest: state.retained.headDigest, publicationDigest: state.retained.publicationDigest,
    publicationSetDigest: state.retained.publicationSetDigest,
    audienceFingerprint: state.retained.audienceFingerprint,
  });
  const ordinal = role === "assistant" ? 2 : 3;
  const messageId = 275 + ordinal;
  const payload: MessagePayloadV2 = {
    role, content: `shared ${role} durable ciphertext`,
    ...(role === "tool" ? { sensitiveMetadata: { toolCallId: "history-tool-call" } } : {}),
  };
  const objectId = deriveLiveShadowMessageCryptoObjectIdV1({
    operationId: execution.plan.operationId, sessionId: SESSION, messageId,
    revision: 0, authorRole: role, transcriptOrdinal: ordinal,
  });
  const prepared = prepareDeviceWrappedLiveShadowAgentConversationCryptoRevisionWithDek({
    crypto: state.crypto, objectId, payload, createdAt: NOW,
    objectDek: new Uint8Array(32).fill(0x61),
    namespace: { namespaceId: NAMESPACE, accessRevision: 2, keyGeneration: 1,
      headDigest: state.retained.headDigest, publicationDigest: state.retained.publicationDigest,
      publicationSetDigest: state.retained.publicationSetDigest,
      audienceFingerprint: state.retained.audienceFingerprint, aiKey: state.retained.generationKey },
    operationId: execution.plan.operationId,
    grant: { grantId: "history-ephemeral-grant", grantHash: new Uint8Array(32).fill(0x62),
      recipientKeyId: "history-ephemeral-recipient" },
    runtime: execution.runtime, signerKeyId: execution.plan.agentSignerKeyId,
    signerPublicKey: execution.plan.agentSignerPublicKey, agentAuthorizationRevision: 9,
    resolveCurrentAuthorization: () => null,
  });
  const snapshot = readPreparedConversationCryptoRevisionSnapshot(prepared).value;
  const logicalMessageKey = `logical:history:${messageId}`;
  const record: RoomHistoryShadowRecordTransportV1 = {
    ...state.record, messageId: String(messageId),
    shadowOperationId: execution.plan.operationId,
    shadowOperationFamily: "shared_execution", shadowTranscriptOrdinal: ordinal,
    ordinaryPayloadBytesBase64url: b64(encodeMessagePayloadV2(payload)),
    ordinarySibling: { logicalMessageKey, payload },
    protectedMessage: {
      dtoVersion: 2, projection: { ...state.protectedMessage.projection,
        messageId: String(messageId), logicalMessageKey, role,
        authorAgentId: execution.plan.recipientAgentId },
      protectedPayload: { status: "encrypted", cryptoObjectId: objectId,
        payloadVersion: 2, keyClass: "ai",
        encryptedPayloadBytesBase64url: b64(snapshot.object.payloadBytes.ciphertext),
        accessManifestBytesBase64url: b64(snapshot.access.manifestBytes),
        namespaceEnvelopeBytesBase64url: b64(snapshot.access.envelopeBytes[0]) },
    },
  };
  const input: VaultRoomHistoryShadowReadInputV1 = {
    ...state.makeInput([record]), signerEvidence: [{
      kind: "shared_agent_execution_plan_v4", operationId: execution.plan.operationId,
      planBytesBase64url: b64(execution.planBytes), planDigestBase64url: b64(execution.planDigest),
    }],
  };
  return { reader: state.createReader(), input, record, payload, execution, state };
}

async function existingRepresentationFixture(role: "user" | "assistant" | "tool" | "system") {
  const shared = await sharedExecutionFixture(role === "user" || role === "system" ? "assistant" : role);
  const { state, execution } = shared;
  const messageId = 42;
  const objectId = deriveMessageCryptoObjectIdV2({ sessionId: SESSION, messageId, revision: 0 });
  const payload: MessagePayloadV2 = { role, content: "existing source message",
    ...(role === "tool" ? { toolName: "lookup", sensitiveMetadata: { toolCallId: "old-tool-call" } } : {}) };
  const prepared = prepareForegroundRuntimeExistingMessageCryptoRevision({
    crypto: state.crypto, objectId, payload, createdAt: NOW,
    objectDek: new Uint8Array(32).fill(0x63),
    namespace: { namespaceId: NAMESPACE, accessRevision: 2, keyGeneration: 1,
      headDigest: state.retained.headDigest, publicationDigest: state.retained.publicationDigest,
      publicationSetDigest: state.retained.publicationSetDigest,
      audienceFingerprint: state.retained.audienceFingerprint, aiKey: state.retained.generationKey },
    operationId: execution.plan.operationId,
    grant: { grantId: "history-ephemeral-grant", grantHash: new Uint8Array(32).fill(0x62),
      recipientKeyId: "history-ephemeral-recipient" },
    runtime: execution.runtime, signerKeyId: execution.plan.agentSignerKeyId,
    signerPublicKey: execution.plan.agentSignerPublicKey, agentAuthorizationRevision: 9,
    resolveCurrentAuthorization: () => null,
  });
  const snapshot = readPreparedConversationCryptoRevisionSnapshot(prepared).value;
  // The original Agent can differ from the Runtime publishing this repair.
  const originalAuthor = role === "user" ? { sourceUserId: COORDINATES.userId }
    : role === "system" ? {} : { authorAgentId: "27500000-0000-4000-8000-000000000009" };
  const logicalMessageKey = "row:42";
  const record: RoomHistoryExistingRepresentationRecordTransportV1 = {
    kind: "existing_representation", sessionId: SESSION, messageId: "42", editRevision: 0,
    // getRoomMessages publishes the Session owner for every role; the protected
    // projection publishes only the role's original author, not that owner.
    ordinarySibling: { logicalMessageKey, payload,
      ...(role === "system" ? {} : { sourceUserId: COORDINATES.userId }), ...originalAuthor },
    protectedMessage: { dtoVersion: 2,
      projection: { messageId: "42", logicalMessageKey, sessionId: SESSION, roomId: ROOM,
        namespaceId: NAMESPACE, role, createdAt: new Date(NOW).toISOString(), editRevision: 0,
        ...originalAuthor },
      protectedPayload: { status: "encrypted", cryptoObjectId: objectId, payloadVersion: 2, keyClass: "ai",
        encryptedPayloadBytesBase64url: b64(snapshot.object.payloadBytes.ciphertext),
        accessManifestBytesBase64url: b64(snapshot.access.manifestBytes),
        namespaceEnvelopeBytesBase64url: b64(snapshot.access.envelopeBytes[0]) } },
    repair: { identityDigestBase64url: b64(new Uint8Array(32).fill(0x64)),
      allocationDigestBase64url: b64(state.crypto.hash(encodeMessagePayloadV2(payload))),
      attestationDigestBase64url: b64(state.crypto.hash(snapshot.access.manifestBytes)),
      publisherSignerKeyId: execution.plan.agentSignerKeyId,
      publisherSigningPublicKeyBase64url: b64(execution.plan.agentSignerPublicKey) },
  };
  return { state, record, payload, reader: state.createReader(), input: state.makeInput([record]) };
}

async function deviceExistingRepresentationFixture(
  keyClass: "ai" | "human",
  role: MessagePayloadV2["role"],
) {
  const state = await fixture();
  const messageId = keyClass === "ai" ? 51 : 52;
  const objectId = deriveMessageCryptoObjectIdV2({
    sessionId: SESSION,
    messageId,
    revision: 0,
  });
  const payload: MessagePayloadV2 = {
    role,
    content: `device repaired ${keyClass} ${role}`,
    ...(role === "system" ? { sensitiveMetadata: { reason: "retained summary" } } : {}),
    ...(role === "tool" ? {
      toolName: "lookup",
      sensitiveMetadata: { toolCallId: `device-${keyClass}-tool-call` },
    } : {}),
  };
  const namespace = {
    namespaceId: NAMESPACE,
    accessRevision: 2,
    keyGeneration: 1,
  } as const;
  const device = {
    deviceId: DEVICE,
    hostAuthorizationRevision: 7,
    signingPrivateKey: state.signing.privateKey,
  } as const;
  const prepared = keyClass === "ai"
    ? prepareHumanExistingMessageRepresentationCryptoRevision({
      crypto: state.crypto,
      objectId,
      payload,
      createdAt: NOW,
      namespace: { ...namespace, aiKey: state.retained.generationKey },
      device,
      resolveCurrentAuthorization: () => null,
    })
    : prepareHumanPeerLiveShadowCryptoRevision({
      crypto: state.crypto,
      objectId,
      payload,
      createdAt: NOW,
      namespace: { ...namespace, humanKey: state.retained.generationKey },
      device,
      resolveCurrentAuthorization: () => null,
    });
  const snapshot = readPreparedConversationCryptoRevision(prepared);
  const logicalMessageKey = `row:device:${keyClass}:${role}`;
  const originalAuthor = role === "user"
    ? { sourceUserId: COORDINATES.userId }
    : role === "system"
      ? {}
      : { authorAgentId: ORIGINAL_AGENT };
  const record: RoomHistoryExistingRepresentationRecordTransportV1 = {
    kind: "existing_representation",
    sessionId: SESSION,
    messageId: String(messageId),
    editRevision: 0,
    ordinarySibling: { logicalMessageKey, payload, ...originalAuthor },
    ...(role === "system" ? { ordinaryPayloadBytesBase64url: b64(encodeMessagePayloadV2(payload)) } : {}),
    protectedMessage: {
      dtoVersion: 2,
      projection: {
        messageId: String(messageId),
        logicalMessageKey,
        sessionId: SESSION,
        roomId: ROOM,
        namespaceId: NAMESPACE,
        role,
        createdAt: new Date(NOW).toISOString(),
        editRevision: 0,
        ...originalAuthor,
      },
      protectedPayload: {
        status: "encrypted",
        cryptoObjectId: objectId,
        payloadVersion: 2,
        keyClass,
        encryptedPayloadBytesBase64url: b64(snapshot.object.payloadBytes.ciphertext),
        accessManifestBytesBase64url: b64(snapshot.access.manifestBytes),
        namespaceEnvelopeBytesBase64url: b64(snapshot.access.envelopeBytes[0]!),
      },
    },
    repair: {
      publisherKind: "human_device",
      publisherHumanId: HUMAN,
      identityDigestBase64url: b64(new Uint8Array(32).fill(0x65)),
      // Allocation stays the canonical ordinary-source commitment. The signed
      // publication-request digest independently guards admission replay.
      allocationDigestBase64url: b64(
        state.crypto.hash(encodeMessagePayloadV2(payload)),
      ),
      attestationDigestBase64url: b64(
        state.crypto.hash(snapshot.access.manifestBytes),
      ),
      publisherSignerKeyId: DEVICE,
      publisherSigningPublicKeyBase64url: b64(state.signing.publicKey),
    },
    retainedGeneration: {
      namespaceGeneration: 1,
      accessRevision: 2,
      headDigestBase64url: b64(state.retained.headDigest),
      publicationDigestBase64url: b64(state.retained.publicationDigest),
      publicationSetDigestBase64url: b64(state.retained.publicationSetDigest),
      audienceFingerprintBase64url: b64(state.retained.audienceFingerprint),
    },
  };
  const base = state.makeInput([record]);
  const input: VaultRoomHistoryShadowReadInputV1 = {
    ...base,
    authority: { ...base.authority, keyClass },
  };
  return { state, record, payload, input };
}

describe("M275 Browser Room-history Shadow reader", () => {
  test.each(["human", "ai"] as const)(
    "authenticates a retained Full Human edit under the %s key class", async (keyClass) => {
    const state = await fixture();
    const id = deriveHumanMessageEditCryptoObjectIdV1({
      operationId: "human-edit:v1:30000000-0000-4000-8000-000000000318",
      sessionId: SESSION, messageId: 275, revision: 1,
    });
    const prepared = keyClass === "human" ? prepareHumanPeerLiveShadowCryptoRevision({ crypto: state.crypto,
      objectId: id, payload: state.payload, createdAt: NOW,
      namespace: { namespaceId: NAMESPACE, accessRevision: 2, keyGeneration: 1,
        humanKey: state.retained.generationKey },
      device: { deviceId: DEVICE, hostAuthorizationRevision: 7,
        signingPrivateKey: state.signing.privateKey }, resolveCurrentAuthorization: () => null })
      : prepareHumanExistingMessageRepresentationCryptoRevision({ crypto: state.crypto,
        objectId: id, payload: state.payload, createdAt: NOW,
        namespace: { namespaceId: NAMESPACE, accessRevision: 2, keyGeneration: 1,
          aiKey: state.retained.generationKey }, device: { deviceId: DEVICE,
          hostAuthorizationRevision: 7, signingPrivateKey: state.signing.privateKey },
        resolveCurrentAuthorization: () => null });
    const snapshot = readPreparedConversationCryptoRevision(prepared);
    const record: RoomHistoryHumanEditedRepresentationRecordTransportV1 = {
      kind: "human_edited_representation", representationMode: "protected-only",
      sessionId: SESSION, messageId: "275", editRevision: 1,
      selectedSource: { role: "user", logicalMessageKey: "logical:m275:275",
        sourceUserId: COORDINATES.userId }, authorHumanId: HUMAN,
      committerDeviceSigningPublicKeyBase64url: b64(state.signing.publicKey),
      namespaceGeneration: 1, namespaceAccessRevision: 2,
      namespaceHeadDigestBase64url: b64(state.retained.headDigest),
      namespacePublicationDigestBase64url: b64(state.retained.headDigest),
      namespacePublicationSetDigestBase64url: b64(state.retained.headDigest),
      namespaceAudienceFingerprintBase64url: b64(state.retained.headDigest),
      protectedMessage: { dtoVersion: 2, projection: { messageId: "275",
        logicalMessageKey: "logical:m275:275", sessionId: SESSION, roomId: ROOM,
        namespaceId: NAMESPACE, role: "user", createdAt: new Date(NOW).toISOString(),
        editRevision: 1, sourceUserId: COORDINATES.userId },
        protectedPayload: { status: "encrypted", cryptoObjectId: id, payloadVersion: 2,
          keyClass, encryptedPayloadBytesBase64url: b64(snapshot.object.payloadBytes.ciphertext),
          accessManifestBytesBase64url: b64(snapshot.access.manifestBytes),
          namespaceEnvelopeBytesBase64url: b64(snapshot.access.envelopeBytes[0]!) } },
    };
    const base = state.makeInput([record]);
    const authority = { ...base.authority, keyClass };
    const result = await state.createReader().reconcile({ ...base, authority });
    expect(state.openedNamespaceKeyClasses()).toEqual([keyClass]);
    expect(result.records[0]).toMatchObject({ status: "verified",
      verification: "signed_representation_authenticated", payload: state.payload });
    const { selectedSource: _selectedSource, representationMode: _mode, ...coordinates } = record;
    const repeated: RoomHistoryHumanEditedRepresentationRecordTransportV1 = {
      ...coordinates, representationMode: "ordinary-and-protected",
      ordinaryPayloadBytesBase64url: b64(encodeMessagePayloadV2(state.payload)),
      ordinarySibling: { logicalMessageKey: "logical:m275:275",
        sourceUserId: COORDINATES.userId, payload: state.payload },
    };
    const repeatedResult = await state.createReader().reconcile({ ...base, authority,
      records: [repeated] });
    expect(repeatedResult.records[0]).toMatchObject({ status: "verified",
      verification: "independent_parity" });

    const diagnostics: unknown[] = [];
    const malformed = { ...record,
      selectedSource: { ...record.selectedSource, logicalMessageKey: "logical:m275:substituted" } };
    const failed = await state.createReader(undefined, (diagnostic) => diagnostics.push(diagnostic))
      .reconcile({ ...base, authority, records: [malformed] });
    expect(failed.records[0]).toMatchObject({ status: "fallback", reason: "integrity_failure" });
    expect(diagnostics).toEqual([{
      operation: "human_edited_history", stage: "structural_selection", errorName: "type_error",
    }]);
    expect(JSON.stringify(diagnostics)).not.toContain("substituted");

    for (const [candidate, expectedStage] of [
      [{ ...record, sessionId: "session:substituted" }, "structural_coordinates"],
      [{ ...record, protectedMessage: { ...record.protectedMessage,
        protectedPayload: { ...record.protectedMessage.protectedPayload,
          cryptoObjectId: "human-message-edit:v1:substituted" } } }, "object_identity"],
    ] as const) {
      const stagedDiagnostics: unknown[] = [];
      const stagedFailure = await state.createReader(undefined, (diagnostic) =>
        stagedDiagnostics.push(diagnostic)).reconcile({
          ...base, authority,
          records: [candidate as RoomHistoryHumanEditedRepresentationRecordTransportV1],
        });
      expect(stagedFailure.records[0]).toMatchObject({
        status: "fallback", reason: "integrity_failure",
      });
      expect(stagedDiagnostics).toEqual([{
        operation: "human_edited_history", stage: expectedStage,
        errorName: "type_error",
      }]);
    }

    const observerFailure = await state.createReader(undefined, () => {
      throw new Error("observer failed");
    }).reconcile({ ...base, authority, records: [malformed] });
    expect(observerFailure.records[0]).toMatchObject({
      status: "fallback", reason: "integrity_failure",
    });
    const rejected = await state.createReader().reconcile({ ...base, authority,
      records: [{ ...record, committerDeviceSigningPublicKeyBase64url: b64(new Uint8Array(32)) }] });
    expect(rejected.verifiedCount).toBe(0);
    if (record.protectedMessage.protectedPayload.status !== "encrypted") {
      throw new Error("Expected encrypted edited fixture");
    }
    const nonceSubstitution = await state.createReader().reconcile({ ...base, authority,
      records: [{ ...record, protectedMessage: { ...record.protectedMessage,
        protectedPayload: { ...record.protectedMessage.protectedPayload,
          cryptoObjectId: id.replace("30000000", "40000000") } } }] });
    expect(nonceSubstitution.records[0]).toMatchObject({
      status: "fallback", reason: "integrity_failure",
    });
  });
  test.each(["user", "assistant", "tool"] as const)(
    "opens repaired existing %s without treating its Runtime publisher as original author", async (role) => {
      const value = await existingRepresentationFixture(role);
      const result = await value.reader.reconcile(value.input);
      expect(result.verifiedCount).toBe(1);
      expect(result.records[0]).toMatchObject({ status: "verified", payload: value.payload });
      expect(value.input.signerEvidence).toEqual([]);
    });

  test.each([
    ["ai", "user"],
    ["ai", "assistant"],
    ["ai", "tool"],
    ["ai", "system"],
    ["human", "user"],
    ["human", "assistant"],
    ["human", "tool"],
    ["human", "system"],
  ] as const)(
    "opens a device-attested existing %s/%s representation with retained authority",
    async (keyClass, role) => {
      const value = await deviceExistingRepresentationFixture(keyClass, role);
      const result = await value.state.createReader().reconcile(value.input);
      expect(value.state.openedNamespaceKeyClasses()).toEqual([keyClass]);
      expect(value.state.authorityCalls()).toBe(0);
      expect(result).toMatchObject({
        eligibleCount: 1,
        verifiedCount: 1,
        fallbackCounts: {},
        records: [{
          status: "verified",
          verification: "independent_parity",
          payload: value.payload,
        }],
      });
    },
  );

  test.each(["ai", "human"] as const)(
    "opens a device-attested existing %s representation after the Namespace generation advances",
    async (keyClass) => {
      const value = await deviceExistingRepresentationFixture(
        keyClass,
        "system",
      );
      const currentHeadDigestBase64url = b64(
        new Uint8Array(32).fill(0x66),
      );
      value.state.requireCurrentNamespaceAuthority({
        generation: 2,
        accessRevision: 3,
        headDigestBase64url: currentHeadDigestBase64url,
      });

      const result = await value.state.createReader().reconcile({
        ...value.input,
        authority: {
          ...value.input.authority,
          namespaceCurrentGeneration: 2,
          namespaceAccessRevision: 3,
          namespaceHeadDigestBase64url: currentHeadDigestBase64url,
        },
      });

      expect(value.state.observedCurrentNamespaceAuthorities()).toEqual([{
        generation: 2,
        accessRevision: 3,
        headDigestBase64url: currentHeadDigestBase64url,
      }]);
      expect(result).toMatchObject({
        eligibleCount: 1,
        verifiedCount: 1,
        fallbackCounts: {},
        records: [{
          status: "verified",
          verification: "independent_parity",
          payload: value.payload,
        }],
      });
    },
  );

  test("opens historical Human-peer ciphertext under a newer authenticated current Namespace head", async () => {
    const value = await humanPeerHistoryFixture();
    const currentHeadDigest = new Uint8Array(32).fill(0x66);
    const native = nativeHistoryNamespaceAuthority(value.state, {
      generation: 2,
      accessRevision: 3,
      headDigest: currentHeadDigest,
    });
    const result = await value.state.createReader(
      undefined,
      undefined,
      native.authority,
    ).reconcile({
      ...value.input,
      authority: {
        ...value.input.authority,
        namespaceCurrentGeneration: 2,
        namespaceAccessRevision: 3,
        namespaceHeadDigestBase64url: b64(currentHeadDigest),
      },
    });

    expect(native.observed()).toEqual([{
      generation: 2,
      accessRevision: 3,
      headDigestBase64url: b64(currentHeadDigest),
    }]);
    expect(result).toMatchObject({
      eligibleCount: 1,
      verifiedCount: 1,
      fallbackCounts: {},
      records: [{
        status: "verified",
        verification: "independent_parity",
        payload: value.state.payload,
      }],
    });
  });

  test("fails closed when historical Human-peer history carries a substituted current Namespace digest", async () => {
    const value = await humanPeerHistoryFixture();
    const currentHeadDigest = new Uint8Array(32).fill(0x66);
    const substitutedHeadDigest = new Uint8Array(32).fill(0x67);
    const native = nativeHistoryNamespaceAuthority(value.state, {
      generation: 2,
      accessRevision: 3,
      headDigest: currentHeadDigest,
    });
    const result = await value.state.createReader(
      undefined,
      undefined,
      native.authority,
    ).reconcile({
      ...value.input,
      authority: {
        ...value.input.authority,
        namespaceCurrentGeneration: 2,
        namespaceAccessRevision: 3,
        namespaceHeadDigestBase64url: b64(substitutedHeadDigest),
      },
    });

    expect(native.observed()).toEqual([{
      generation: 2,
      accessRevision: 3,
      headDigestBase64url: b64(substitutedHeadDigest),
    }]);
    expect(result).toMatchObject({
      eligibleCount: 1,
      verifiedCount: 0,
      fallbackCounts: { retained_key_material_unavailable: 1 },
      records: [{
        status: "fallback",
        reason: "retained_key_material_unavailable",
      }],
    });
  });

  test("rejects a stale retained binding after fencing authority against the current Namespace head", async () => {
    const value = await deviceExistingRepresentationFixture("ai", "system");
    const currentHeadDigestBase64url = b64(new Uint8Array(32).fill(0x67));
    value.state.requireCurrentNamespaceAuthority({
      generation: 2,
      accessRevision: 3,
      headDigestBase64url: currentHeadDigestBase64url,
    });
    const record: RoomHistoryExistingRepresentationRecordTransportV1 = {
      ...value.record,
      retainedGeneration: {
        ...value.record.retainedGeneration!,
        headDigestBase64url: b64(new Uint8Array(32).fill(0x68)),
      },
    };

    const result = await value.state.createReader().reconcile({
      ...value.input,
      authority: {
        ...value.input.authority,
        namespaceCurrentGeneration: 2,
        namespaceAccessRevision: 3,
        namespaceHeadDigestBase64url: currentHeadDigestBase64url,
      },
      records: [record],
    });

    expect(result.records).toEqual([{
      sessionId: record.sessionId,
      messageId: record.messageId,
      editRevision: record.editRevision,
      status: "fallback",
      reason: "retained_key_material_unavailable",
    }]);
  });

  test.each(["ai", "human"] as const)(
    "authenticates a protected-only device-attested existing system representation under %s authority",
    async (keyClass) => {
      const value = await deviceExistingRepresentationFixture(keyClass, "system");
      const { ordinarySibling, ordinaryPayloadBytesBase64url: _ordinaryBytes, ...coordinates } = value.record;
      const record: RoomHistoryExistingRepresentationRecordTransportV1 = {
        ...coordinates,
        representationMode: "protected-only",
        selectedSource: {
          role: "system",
          ...(ordinarySibling.logicalMessageKey === undefined ? {} : {
            logicalMessageKey: ordinarySibling.logicalMessageKey,
          }),
        },
      };
      const result = await value.state.createReader().reconcile({
        ...value.input,
        records: [record],
      });
      expect(result.records).toMatchObject([{
        status: "verified",
        verification: "signed_representation_authenticated",
        payload: value.payload,
      }]);
    },
  );

  test("opens a mixed retained Runtime/device AI/Human page in source order", async () => {
    const runtime = await existingRepresentationFixture("assistant");
    const deviceHuman = await deviceExistingRepresentationFixture("human", "system");
    const deviceAi = await deviceExistingRepresentationFixture("ai", "tool");
    const records = [deviceHuman.record, runtime.record, deviceAi.record] as const;
    const result = await runtime.state.createReader().reconcile({
      ...runtime.input,
      authorities: [deviceHuman.input.authority, runtime.input.authority],
      records,
    });
    expect(result.records.map((record) => ({
      messageId: record.messageId,
      status: record.status,
      ...(record.status === "verified" ? {
        role: record.payload.role,
        verification: record.verification,
      } : {}),
    }))).toEqual([
      {
        messageId: deviceHuman.record.messageId,
        status: "verified",
        role: "system",
        verification: "independent_parity",
      },
      {
        messageId: runtime.record.messageId,
        status: "verified",
        role: "assistant",
        verification: "independent_parity",
      },
      {
        messageId: deviceAi.record.messageId,
        status: "verified",
        role: "tool",
        verification: "independent_parity",
      },
    ]);
    expect(runtime.state.openedNamespaceKeyClasses()).toEqual(["human", "ai"]);
    expect(runtime.state.authorityCalls()).toBe(1);
  });

  test.each(["ai", "human"] as const)(
    "rejects actor attribution injected into a device-attested existing system representation under %s authority",
    async (keyClass) => {
      const value = await deviceExistingRepresentationFixture(keyClass, "system");
      const record: RoomHistoryExistingRepresentationRecordTransportV1 = {
        ...value.record,
        ordinarySibling: {
          ...value.record.ordinarySibling,
          authorAgentId: ORIGINAL_AGENT,
        },
        protectedMessage: {
          ...value.record.protectedMessage,
          projection: {
            ...value.record.protectedMessage.projection,
            authorAgentId: ORIGINAL_AGENT,
          },
        },
      };
      const result = await value.state.createReader().reconcile({
        ...value.input,
        records: [record],
      });
      expect(result.records).toMatchObject([{
        status: "fallback",
        reason: "integrity_failure",
      }]);
    },
  );

  test.each(["user", "assistant", "tool", "system"] as const)(
    "opens protected-only repaired existing %s from structural authorship", async (role) => {
      const value = await existingRepresentationFixture(role);
      const { ordinarySibling, ordinaryPayloadBytesBase64url: _ordinaryBytes, ...coordinates } = value.record;
      const record: RoomHistoryExistingRepresentationRecordTransportV1 = {
        ...coordinates,
        representationMode: "protected-only",
        selectedSource: {
          role: ordinarySibling.payload.role,
          ...(ordinarySibling.logicalMessageKey === undefined ? {} : {
            logicalMessageKey: ordinarySibling.logicalMessageKey,
          }),
          ...(ordinarySibling.sourceUserId === undefined ? {} : {
            sourceUserId: ordinarySibling.sourceUserId,
          }),
          ...(ordinarySibling.authorAgentId === undefined ? {} : {
            authorAgentId: ordinarySibling.authorAgentId,
          }),
        },
      };
      const result = await value.reader.reconcile({
        ...value.input, records: [record],
      });
      expect(result.records[0]).toMatchObject({
        status: "verified",
        verification: "signed_representation_authenticated",
        payload: value.payload,
      });
      expect("ordinarySibling" in record).toBe(false);
    });

  test.each(["user", "assistant", "tool"] as const)(
    "rejects repaired %s when its ordinary original author disagrees", async (role) => {
      const value = await existingRepresentationFixture(role);
      const record: RoomHistoryExistingRepresentationRecordTransportV1 = {
        ...value.record,
        ordinarySibling: {
          ...value.record.ordinarySibling,
          ...(role === "user" ? { sourceUserId: "27500000-0000-4000-8000-000000000099" }
            : { authorAgentId: "27500000-0000-4000-8000-000000000099" }),
        },
      };
      const result = await value.reader.reconcile({ ...value.input, records: [record] });
      expect(result.verifiedCount).toBe(0);
      expect(result.records[0]).toMatchObject({ status: "fallback", reason: "integrity_failure" });
    });

  test.each(["id", "revision", "role", "author", "attestation", "signature", "signer", "namespace", "envelope", "ciphertext", "allocation", "ordinary"] as const)(
    "fails closed on existing-representation substituted %s", async (field) => {
      const value = await existingRepresentationFixture("tool");
      const record = structuredClone(value.record);
      const mutable = record as unknown as {
        messageId: string; editRevision: number;
        ordinarySibling: { payload: { content: string; role: string } };
        repair: { attestationDigestBase64url: string; allocationDigestBase64url: string; publisherSigningPublicKeyBase64url: string };
        protectedMessage: { projection: { messageId: string; editRevision: number; role: string; authorAgentId: string; namespaceId: string };
          protectedPayload: { accessManifestBytesBase64url: string; namespaceEnvelopeBytesBase64url: string; encryptedPayloadBytesBase64url: string } };
      };
      if (field === "id") {
        mutable.messageId = "43";
        mutable.protectedMessage.projection.messageId = "43";
      }
      if (field === "revision") {
        mutable.editRevision = 1;
        mutable.protectedMessage.projection.editRevision = 1;
      }
      if (field === "role") {
        mutable.protectedMessage.projection.role = "user";
        mutable.ordinarySibling.payload.role = "user";
      }
      if (field === "author") mutable.protectedMessage.projection.authorAgentId = HUMAN;
      if (field === "attestation") mutable.repair.attestationDigestBase64url = b64(new Uint8Array(32));
      if (field === "signature") {
        const bytes = Buffer.from(mutable.protectedMessage.protectedPayload.accessManifestBytesBase64url, "base64url");
        bytes[bytes.length - 1] = bytes[bytes.length - 1]! ^ 1;
        mutable.protectedMessage.protectedPayload.accessManifestBytesBase64url = b64(bytes);
        mutable.repair.attestationDigestBase64url = b64(value.state.crypto.hash(bytes));
      }
      if (field === "signer") mutable.repair.publisherSigningPublicKeyBase64url = b64(new Uint8Array(32));
      if (field === "namespace") mutable.protectedMessage.projection.namespaceId = SESSION;
      if (field === "envelope") mutable.protectedMessage.protectedPayload.namespaceEnvelopeBytesBase64url = "AA";
      if (field === "ciphertext") mutable.protectedMessage.protectedPayload.encryptedPayloadBytesBase64url = "AA";
      if (field === "allocation") mutable.repair.allocationDigestBase64url = b64(new Uint8Array(32));
      if (field === "ordinary") mutable.ordinarySibling.payload.content = "substituted source";
      const result = await value.reader.reconcile({ ...value.input, records: [record] });
      expect(result.verifiedCount).toBe(0);
      expect(result.records[0]?.status).toBe("fallback");
    });

  test("opens current shared Human input with its original device signature", async () => {
    const state = await fixture();
    const result = await state.createReader().reconcile(state.makeInput([{
      ...state.record, shadowOperationFamily: "shared_human",
    }]));
    expect(result.verifiedCount).toBe(1);
    expect(result.records[0]).toMatchObject({ status: "verified", payload: state.payload });
  });

  test.each(([1, 2] as const).flatMap(formatVersion =>
    (["exact", "message", "namespace", "version"] as const).map(coordinates =>
      ({ formatVersion, coordinates }))))("authenticates protected-only shared Human input with %j retained coordinates", async ({ formatVersion, coordinates }) => {
    const state = await fixture();
    const operationId = state.record.shadowOperationId;
    const planBytes = encodeHumanAiReadableLiveShadowMessagePlan({
      formatVersion, purpose: "message.human_ai_readable_live_shadow_plan",
      operationId, clientIdempotencyKey: "history-full-shared-human",
      policyRevision: 4, sessionId: SESSION, roomId: ROOM, humanMessageId: 275,
      revision: 0, transcriptOrdinal: 1, role: "user", createdAt: unixTimestamp(NOW),
      subjectHumanId: humanId(HUMAN), committerDeviceId: cryptoDeviceId(DEVICE),
      committerDeviceSigningKeyGeneration: 1,
      hostAuthorizationRevision: authorizationRevision(7),
      namespaceId: namespaceId(NAMESPACE), keyClass: "ai",
      namespaceAccessRevision: accessRevision(2),
      namespaceKeyGeneration: namespaceGeneration(1),
      namespaceHeadDigest: state.retained.headDigest,
      namespacePublicationDigest: state.retained.publicationDigest,
      namespacePublicationSetDigest: state.retained.publicationSetDigest,
      namespaceAudienceFingerprint: state.retained.audienceFingerprint,
      attemptCoordinate: "history-full-shared-human-attempt",
      issuedAt: unixTimestamp(NOW - 1_000), deadlineAt: unixTimestamp(NOW + 29_000),
    });
    const protectedPayload = state.protectedMessage.protectedPayload;
    if (protectedPayload.status !== "encrypted") throw new Error("Expected encrypted fixture");
    const plaintext = encodeMessagePayloadV2(state.payload);
    const request = prepareHumanAiReadableLiveShadowMessageRequest(state.crypto, {
      operationId, clientIdempotencyKey: "history-full-shared-human",
      policyRevision: 4, sessionId: SESSION, roomId: ROOM, messageId: coordinates === "message" ? 276 : 275,
      revision: 0, transcriptOrdinal: 1, role: "user", createdAt: unixTimestamp(NOW),
      subjectHumanId: humanId(HUMAN), committerDeviceId: cryptoDeviceId(DEVICE),
      committerDeviceSigningKeyGeneration: 1,
      hostAuthorizationRevision: authorizationRevision(7),
      namespaceId: namespaceId(coordinates === "namespace" ? "different-namespace" : NAMESPACE), keyClass: "ai",
      namespaceAccessRevision: accessRevision(2),
      namespaceKeyGeneration: namespaceGeneration(1),
      namespaceHeadDigest: state.retained.headDigest,
      namespacePublicationDigest: state.retained.publicationDigest,
      namespacePublicationSetDigest: state.retained.publicationSetDigest,
      namespaceAudienceFingerprint: state.retained.audienceFingerprint,
      issuedAt: unixTimestamp(NOW - 1_000), deadlineAt: unixTimestamp(NOW + 29_000),
      cryptoObjectId: latticeObjectId(protectedPayload.cryptoObjectId),
      planDigest: state.crypto.hash(planBytes), plaintextPayloadDigest: state.crypto.hash(plaintext),
      encryptedPayloadDigest: state.crypto.hash(Buffer.from(protectedPayload.encryptedPayloadBytesBase64url, "base64url")),
      manifestDigest: state.crypto.hash(Buffer.from(protectedPayload.accessManifestBytesBase64url, "base64url")),
      envelopeDigest: state.crypto.hash(Buffer.from(protectedPayload.namespaceEnvelopeBytesBase64url, "base64url")),
      committerSigningPublicKey: state.signing.publicKey,
      committerSigningPrivateKey: state.signing.privateKey,
    }, formatVersion);
    const { ordinaryPayloadBytesBase64url: _ordinaryBytes,
      ordinarySibling: _ordinarySibling, ...structuralRecord } = state.record;
    const record: RoomHistoryShadowRecordTransportV1 = {
      ...structuralRecord, representationMode: "protected-only" as const,
      shadowOperationFamily: "shared_human" as const,
      selectedSource: { role: "user" as const,
        logicalMessageKey: state.protectedMessage.projection.logicalMessageKey!,
        sourceUserId: COORDINATES.userId } };
    const result = await state.createReader().reconcile({
      ...state.makeInput([record]), signerEvidence: [{
        kind: (formatVersion === 2) !== (coordinates === "version")
          ? "human_ai_readable_live_shadow_request_v2" : "human_ai_readable_live_shadow_request_v1",
        operationId,
        planBytesBase64url: b64(planBytes), requestBytesBase64url: b64(request.bytes),
        requestDigestBase64url: b64(request.requestDigest),
      }],
    });
    if (coordinates === "exact") {
      expect(result.records[0]).toMatchObject({ status: "verified",
        verification: "signed_representation_authenticated", payload: state.payload });
    } else {
      expect(result.verifiedCount).toBe(0);
      expect(result.records[0]).toMatchObject({ status: "fallback" });
    }
  });

  test.each(["assistant", "tool"] as const)("opens shared execution %s with retained accepted plan and runtime signature", async (role) => {
    const state = await sharedExecutionFixture(role);
    const result = await state.reader.reconcile(state.input);
    expect(result.verifiedCount).toBe(1);
    expect(result.records[0]).toMatchObject({ status: "verified", payload: state.payload });
  });

  test.each(["missing", "duplicate", "digest", "room", "author", "generation"] as const)(
    "rejects shared execution substituted %s evidence", async (substitution) => {
      const state = await sharedExecutionFixture("tool");
      const original = state.input.signerEvidence[0]!;
      if (original.kind !== "shared_agent_execution_plan_v4") throw new Error("Expected shared evidence fixture");
      const records = substitution === "author" ? [{
        ...state.record, protectedMessage: { ...state.record.protectedMessage,
          projection: { ...state.record.protectedMessage.projection, authorAgentId: HUMAN } },
      }] : substitution === "generation" ? [{ ...state.record, namespaceGeneration: 2 }]
        : state.input.records;
      const result = await state.reader.reconcile({
        ...state.input, records,
        sourceRoomId: substitution === "room" ? SESSION : ROOM,
        signerEvidence: substitution === "missing" ? []
          : substitution === "duplicate" ? [original, original]
          : substitution === "digest" ? [{ ...original, planDigestBase64url: b64(new Uint8Array(32)) }]
          : state.input.signerEvidence,
      });
      expect(result.verifiedCount).toBe(0);
      expect(result.records[0]?.status).toBe("fallback");
    });

  test("opens, byte-compares, and returns the complete canonical payload", async () => {
    const state = await fixture();
    const result = await state.createReader().reconcile(
      state.makeInput([state.record]),
    );
    expect(result).toEqual({
      records: [{
        sessionId: SESSION,
        messageId: "275",
        editRevision: 0,
        status: "verified",
        verification: "independent_parity",
        payload: state.payload,
      }],
      eligibleCount: 1,
      verifiedCount: 1,
      fallbackCounts: {},
    });
    expect(state.authorityCalls()).toBe(1);
  });

  test("rejects a substituted visible ordinary sibling before render", async () => {
    const state = await fixture();
    const record = Object.freeze({
      ...state.record,
      ordinarySibling: Object.freeze({
        logicalMessageKey: "logical:m275:275",
        payload: Object.freeze({
          role: "user" as const,
          content: "substituted visible plaintext",
        }),
      }),
    });
    const result = await state.createReader().reconcile(state.makeInput([record]));
    expect(result.records).toEqual([{
      sessionId: SESSION,
      messageId: "275",
      editRevision: 0,
      status: "fallback",
      reason: "integrity_failure",
    }]);
  });

  test("isolates malformed ciphertext transport to its row", async () => {
    const state = await fixture();
    const malformed = Object.freeze({
      ...state.record,
      messageId: "276",
      protectedMessage: Object.freeze({
        ...state.protectedMessage,
        projection: Object.freeze({
          ...state.protectedMessage.projection,
          messageId: "276",
        }),
        protectedPayload: Object.freeze({
          ...state.protectedMessage.protectedPayload,
          encryptedPayloadBytesBase64url: "not+base64url",
        }),
      }),
    }) as RoomHistoryShadowRecordTransportV1;
    const result = await state.createReader().reconcile(
      state.makeInput([malformed, state.record]),
    );
    expect(result.records.map((record) => record.status)).toEqual([
      "fallback",
      "verified",
    ]);
    expect(result.records[0]).toMatchObject({ reason: "integrity_failure" });
  });

  test("does not mislabel an assistant manifest substitution as missing signer evidence", async () => {
    const state = await fixture();
    const substituted = Object.freeze({
      ...state.record,
      protectedMessage: Object.freeze({
        ...state.protectedMessage,
        projection: Object.freeze({
          ...state.protectedMessage.projection,
          role: "assistant" as const,
          authorAgentId: "agent:m275:substituted",
        }),
      }),
    });
    const result = await state.createReader().reconcile(
      state.makeInput([substituted]),
    );
    expect(result.records).toMatchObject([{
      status: "fallback",
      reason: "integrity_failure",
    }]);
  });

  test("reports missing local vault custody without mislabeling authority", async () => {
    const state = await fixture();
    const locked = state.createReader(Object.freeze({
      availability: async () => ({ status: "storage_lost" as const }),
      unlock: async () => ({ status: "storage_lost" as const }),
      lock: async () => {},
      stageProfile: async () => { throw new Error("unavailable"); },
      activateProfile: async () => { throw new Error("unavailable"); },
      abortStagedProfile: async () => { throw new Error("unavailable"); },
      recoverInterruptedActivation: async () => {
        throw new Error("unavailable");
      },
      withOpenProfile: async () => { throw new Error("unavailable"); },
      listPublicProfiles: async () => [],
      rotateWrappingMaterial: async () => {},
      forgetProfile: async () => {},
    }));
    const result = await locked.reconcile(state.makeInput([state.record]));
    expect(result.records).toEqual([{
      sessionId: SESSION,
      messageId: "275",
      editRevision: 0,
      status: "fallback",
      reason: "client_custody_unavailable",
    }]);
  });

  test("does no custody or authority work for lifecycle-only fallbacks", async () => {
    const state = await fixture();
    const pending = Object.freeze({
      ...state.record,
      protectedMessage: Object.freeze({
        ...state.protectedMessage,
        protectedPayload: Object.freeze({
          status: "pending" as const,
          reason: "shadow_pending" as const,
        }),
      }),
    });
    const result = await state.createReader().reconcile(
      state.makeInput([pending]),
    );
    expect(result.records).toMatchObject([{
      status: "fallback",
      reason: "live_shadow_lifecycle_unavailable",
    }]);
    expect(state.authorityCalls()).toBe(0);
  });
});
