import { expect, test } from "bun:test";
import {
  LatticeCrypto,
  accessRevision,
  agentId,
  authorizationRevision,
  cryptoDeviceId,
  deriveAgentRuntimeObjectSignerPublic,
  humanId,
  namespaceGeneration,
  namespaceId,
  prepareAgentRuntimeInitialization,
  createCommonHumanObjectAccessManifest,
  unixTimestamp,
} from "@nautilo/lattice-crypto";
import type { TrustedMinimumObjectAccessHead } from "@nautilo/lattice-crypto";
import {
  encodeClientDeviceProfileV2,
  type OpenedClientDeviceProfileV2,
} from "../../src/client-vault/profile-v2.ts";
import {
  createClientDeviceProfileV3Candidate,
  destroyOpenedClientDeviceProfileV3,
  encodeClientDeviceProfileV3,
} from "../../src/client-vault/profile-v3.ts";
import {
  createClientDeviceProfileV4Candidate,
  destroyOpenedClientDeviceProfileV4,
  encodeClientDeviceProfileV4,
} from "../../src/client-vault/profile-v4.ts";
import type { ClientProfileCoordinates, ClientProfileVault } from
  "../../src/client-vault/types.ts";
import { MemoryClientProfileVault } from
  "../../src/testing/client-profile-vault.ts";
import {
  createVaultHumanTaskDeviceContentPortV1,
} from "../../src/client/task/vault-human-task-device-content.ts";
import { ClassifiedDataOperationError } from
  "../../src/transition/encryption-data-operation-owner.ts";
import { decodeTaskPayloadV1 } from "../../src/task/task-payload-v1.ts";
import { addAdditionalDeviceDomainSignerEvidenceV4 } from
  "../../src/device/additional-device-client.ts";
import {
  decodeHumanTaskPublicationRequestV1,
  decodeObjectAccessManifestV5,
  decodeLiveShadowMessagePlanV4,
  encodeAgentRuntimeSignerPublicationV1,
  encodeLiveShadowMessagePlanV4,
} from
  "@nautilo/lattice-crypto/wire";
import {
  encodeTaskDefinitionContentV2,
  encodeTaskPayloadV1,
} from "../../src/task/task-payload-v1.ts";
import { fingerprintTaskDualPublicationFieldsV1 } from
  "../../src/task/task-operational-fields-digest-v1.ts";
import {
  prepareNativeTaskDefinitionCryptoRevision,
} from "../../src/server/task/native-task-definition-preparation.ts";
import {
  readPreparedTaskContentCryptoRevisionSnapshotV1,
} from "../../src/task/task-content-prepared-revision.ts";

const NOW = 1_800_000_000_000;
const HUMAN_ID = "20000000-0000-4000-8000-000000000248";
const TASK_ID = "30000000-0000-4000-8000-000000000248";
const ROOM_ID = "40000000-0000-4000-8000-000000000248";
const NAMESPACE_ID = "50000000-0000-4000-8000-000000000248";
const AGENT_ID = "60000000-0000-4000-8000-000000000248";
const OTHER_AGENT_ID = "60000000-0000-4000-8000-000000000249";
const BINDING_HASH = new Uint8Array(32).fill(0x19);
const NAMESPACE_KEY = new Uint8Array(32).fill(0x48);

function copyTrustedAnchor(
  anchor: TrustedMinimumObjectAccessHead,
): TrustedMinimumObjectAccessHead {
  return {
    ...anchor,
    payloadHash: anchor.payloadHash.slice(),
    manifestHash: anchor.manifestHash.slice(),
  };
}

function equalTrustedAnchors(
  left: TrustedMinimumObjectAccessHead | null,
  right: TrustedMinimumObjectAccessHead | null,
): boolean {
  return left === right || (
    left !== null
    && right !== null
    && left.objectId === right.objectId
    && left.accessRevision === right.accessRevision
    && left.payloadHash.length === right.payloadHash.length
    && left.payloadHash.every((byte, index) => byte === right.payloadHash[index])
    && left.manifestHash.length === right.manifestHash.length
    && left.manifestHash.every((byte, index) => byte === right.manifestHash[index])
  );
}

function seededRng(seed: number): (length: number) => Uint8Array {
  let state = seed >>> 0;
  return (length) => Uint8Array.from({ length }, () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state & 0xff;
  });
}

async function preparedAgentDefinition(
  manager: Awaited<ReturnType<typeof setup>>,
  managerDeviceId: string,
  writerAgentId = AGENT_ID,
  evidenceHumanId = HUMAN_ID,
) {
  const initialized = await prepareAgentRuntimeInitialization({
    crypto: manager.crypto,
    operationId: "task-definition-agent-initialization",
    agentId: agentId(writerAgentId),
    authorizationRevision: authorizationRevision(7),
    configObjects: [{
      objectId: "task-definition-agent-config",
      configRevision: authorizationRevision(1),
      plaintextDek: new Uint8Array(32).fill(0x29),
    }],
    domains: [],
    resolveCurrentDomainCommitterAuthority: () => null,
    manager: {
      managerHumanId: humanId(HUMAN_ID),
      managerAuthorizationRevision: authorizationRevision(11),
      managerDeviceId: cryptoDeviceId(managerDeviceId),
    },
    managerSigningPrivateKey: manager.signing.privateKey,
    resolveCurrentManagerAuthority: () => manager.signing.publicKey,
  });
  const signer = deriveAgentRuntimeObjectSignerPublic(
    manager.crypto,
    initialized.runtime,
  );
  const prepared = await prepareNativeTaskDefinitionCryptoRevision({
    crypto: manager.crypto,
    taskId: TASK_ID,
    authority: {
      authorityVersion: 1,
      kind: "requester_private_namespace",
      keyClass: "ai",
      requesterHumanId: HUMAN_ID,
      namespaceId: NAMESPACE_ID,
      domainId: "domain:1",
      expectedAccessRevision: 9,
      expectedPolicyRevision: 1,
    },
    entities: {
      signal: new AbortController().signal,
      use: async () => {
        throw new Error("Expected exact foreground Namespace set");
      },
      useCurrentSet: async request => ({
        status: "executed",
        value: await request.execute([{
          namespaceKey: NAMESPACE_KEY,
          authority: {
            namespaceId: NAMESPACE_ID,
            domainId: "domain:1",
            namespaceAccessRevision: 9,
            namespaceKeyGeneration: 2,
            domainKeyGeneration: 3,
            domainAuthorizationRevision: 7,
            domainHeadDigest: new Uint8Array(32).fill(0x31),
            namespaceHeadDigest: new Uint8Array(32).fill(0x32),
            namespacePublicationDigest: new Uint8Array(32).fill(0x33),
            namespacePublicationSetDigest: new Uint8Array(32).fill(0x34),
            namespaceAudienceFingerprint: new Uint8Array(32).fill(0x35),
          },
        }]),
      }),
    },
    createdAt: NOW,
    payload: {
      formatVersion: 1,
      prompt: "Agent-created private prompt",
      expectedOutput: "Agent-created private answer",
      protectedMetadata: {},
    },
    publication: {
      operationId: "task-definition-agent-create",
      grantId: "task-definition-agent-grant",
      grantDigest: new Uint8Array(32).fill(0x41),
      recipientKeyId: "task-definition-agent-recipient",
      runtime: initialized.runtime,
      signerKeyId: signer.principal.signerKeyId,
      signerPublicKey: signer.publicKey,
      agentAuthorizationRevision: 7,
      policyRevision: 1,
    },
  });
  if (prepared === null) throw new Error("Agent Task definition was unavailable");
  const snapshot = readPreparedTaskContentCryptoRevisionSnapshotV1(prepared);
  const foregroundPlanBytes = encodeLiveShadowMessagePlanV4({
    formatVersion: 4,
    purpose: "message.live_shadow_plan",
    operationId: "task-definition-accepted-execution",
    policyRevision: 1,
    sessionId: TASK_ID,
    roomId: ROOM_ID,
    humanMessageId: 1,
    revision: 0,
    createdAt: unixTimestamp(NOW),
    subjectHumanId: humanId(evidenceHumanId),
    committerDeviceId: cryptoDeviceId(managerDeviceId),
    committerDeviceSigningKeyGeneration: 1,
    hostAuthorizationRevision: authorizationRevision(11),
    recipientAgentId: agentId(writerAgentId),
    agentAuthorizationRevision: authorizationRevision(7),
    agentRuntimeGeneration: initialized.runtime.generation,
    agentSignerKeyId: signer.principal.signerKeyId,
    agentSignerPublicKey: Uint8Array.from(signer.publicKey),
    namespaceId: namespaceId(NAMESPACE_ID),
    namespaceAccessRevision: accessRevision(9),
    namespaceKeyGeneration: namespaceGeneration(2),
    namespaceHeadDigest: new Uint8Array(32).fill(0x51),
    namespacePublicationDigest: new Uint8Array(32).fill(0x52),
    namespacePublicationSetDigest: new Uint8Array(32).fill(0x53),
    namespaceAudienceFingerprint: new Uint8Array(32).fill(0x54),
    grantDomainId: "domain:1",
    grantDomainParticipantDigest: new Uint8Array(32).fill(0x55),
    grantDomainKeyGeneration: 3,
    grantDomainHeadDigest: new Uint8Array(32).fill(0x56),
    grantDomainPublicationDigest: new Uint8Array(32).fill(0x57),
    grantDomainAuthorizationRevision: authorizationRevision(7),
    namespaceBundleGrantDomainAuthorizationRevision: authorizationRevision(7),
    namespaceBundleRevision: 1,
    namespaceBundleDigest: new Uint8Array(32).fill(0x58),
    authorization: {
      disposition: "authorization_reusable",
      sessionReference: "task-definition-accepted-session",
      authorizationDigest: new Uint8Array(32).fill(0x59),
    },
    attemptCoordinate: "task-definition-accepted-attempt",
    issuedAt: unixTimestamp(NOW),
    deadlineAt: unixTimestamp(NOW + 30_000),
  });
  const foregroundEvidence = {
    kind: "foreground_agent_accepted_execution" as const,
    planBytesBase64url: base64url(foregroundPlanBytes),
    planDigestBase64url: base64url(manager.crypto.hash(foregroundPlanBytes)),
  };
  signer.publicKey.fill(0);
  return {
    initialized,
    foregroundPlanBytes,
    foregroundEvidence,
    reference: {
      dtoVersion: 1 as const,
      status: "protected" as const,
      objectId: prepared.objectId,
      contentRevision: 1,
      cryptoAccessRevision: 0,
    },
    envelope: {
      readVersion: 1 as const,
      taskId: TASK_ID,
      objectId: prepared.objectId,
      contentRevision: 1,
      cryptoAccessRevision: 0,
      namespaceId: NAMESPACE_ID,
      readAuthority: taskReadAuthority(),
      encryptedPayloadBytes: snapshot.object.payloadBytes.ciphertext,
      accessManifestBytes: snapshot.access.manifestBytes,
      accessManifestProofBytes: [] as Uint8Array[],
      namespaceEnvelopeBytes: snapshot.access.envelopeBytes[0],
      signerEvidence: [{
        kind: "agent_runtime_publication" as const,
        evidenceBytesBase64url: base64url(
          encodeAgentRuntimeSignerPublicationV1(
            initialized.signerPublication,
          ),
        ),
      }],
    },
  };
}

function base64url(value: Uint8Array): string {
  return Buffer.from(value).toString("base64url");
}

function decodeBase64url(value: string): Uint8Array {
  return Uint8Array.from(Buffer.from(value, "base64url"));
}

function taskReadAuthority() {
  return {
    sourceRoomId: ROOM_ID,
    namespaceId: NAMESPACE_ID,
    currentGeneration: 3,
    retainedGenerations: [
      {
        generation: 2,
        accessRevision: 9,
        headDigestBase64url: base64url(new Uint8Array(32).fill(0x51)),
        publicationDigestBase64url: base64url(new Uint8Array(32).fill(0x52)),
        publicationSetDigestBase64url: base64url(new Uint8Array(32).fill(0x53)),
        audienceFingerprintBase64url: base64url(new Uint8Array(32).fill(0x54)),
      },
      {
        generation: 3,
        accessRevision: 10,
        headDigestBase64url: base64url(new Uint8Array(32).fill(0x61)),
        publicationDigestBase64url: base64url(new Uint8Array(32).fill(0x62)),
        publicationSetDigestBase64url: base64url(new Uint8Array(32).fill(0x63)),
        audienceFingerprintBase64url: base64url(new Uint8Array(32).fill(0x64)),
      },
    ],
  };
}

async function setup(deviceId: string, seed: number, peer?: Readonly<{
  deviceId: string;
  signingPublicKey: Uint8Array;
  includeLegacyKeyring?: boolean;
}>) {
  const crypto = new LatticeCrypto({ bytes: seededRng(seed) }, { now: () => NOW });
  const signing = crypto.generateSigningKeyPair();
  const encryption = await crypto.generateEncryptionKeyPair();
  const coordinates: ClientProfileCoordinates = Object.freeze({
    serverScope: "https://nautilo.test",
    userId: "10000000-0000-4000-8000-000000000248",
    humanActorId: HUMAN_ID,
    profileId: `profile:${deviceId}`,
    deviceId,
    installationLineageDigest: "48".repeat(32),
  });
  const profile: OpenedClientDeviceProfileV2 = Object.freeze({
    formatVersion: 2,
    deviceId,
    signingPublicKey: signing.publicKey,
    signingPrivateKey: signing.privateKey,
    encryptionPublicKey: encryption.publicKey,
    encryptionPrivateKey: encryption.privateKey,
    trustedDeviceRevision: 7,
    trustedHostAuthorizationRevision: 11,
    deliveryHighWatermark: 4,
    keyringDeliveries: Object.freeze(peer?.includeLegacyKeyring === false ? [] : [Object.freeze({
      deliverySequence: 4,
      operationId: "delivery:4",
      namespaceId: NAMESPACE_ID,
      keyClass: "ai" as const,
      domainId: "domain:1",
      domainEpoch: 3,
      accessRevision: 9,
      bindingHash: BINDING_HASH,
      currentGeneration: 2,
      generations: Object.freeze([
        Object.freeze({ generation: 2, key: NAMESPACE_KEY }),
      ]),
    })]),
  });
  const v2Bytes = encodeClientDeviceProfileV2(profile);
  const v3 = await createClientDeviceProfileV3Candidate({
    crypto, currentProfileBytes: v2Bytes, expectedDeviceId: deviceId,
  });
  const v3Bytes = encodeClientDeviceProfileV3(v3);
  const v4 = await createClientDeviceProfileV4Candidate({
    crypto, currentProfileBytes: v3Bytes, expectedDeviceId: deviceId,
  });
  const trusted = peer === undefined ? v4 : await addAdditionalDeviceDomainSignerEvidenceV4({
    crypto,
    profile: v4,
    humanId: HUMAN_ID,
    domainId: "domain:1",
    domainEpoch: 3,
    participantDigest: new Uint8Array(32).fill(0x61),
    providerTransitionDigest: new Uint8Array(32).fill(0x62),
    peerDeviceId: peer.deviceId,
    peerSigningPublicKey: peer.signingPublicKey,
    acceptedAt: NOW - 1_000,
  });
  const profileBytes = encodeClientDeviceProfileV4(trusted);
  if (trusted !== v4) destroyOpenedClientDeviceProfileV4(trusted);
  destroyOpenedClientDeviceProfileV4(v4);
  destroyOpenedClientDeviceProfileV3(v3);
  v2Bytes.fill(0);
  v3Bytes.fill(0);
  const vault = new MemoryClientProfileVault();
  await vault.unlock();
  await vault.stageProfile({
    coordinates,
    stageId: "stage:1",
    generation: 1,
    profileBytes,
    publicState: { clientKind: "browser", publicFingerprint: "84".repeat(32) },
  });
  await vault.activateProfile(coordinates, "stage:1");
  profileBytes.fill(0);
  const anchors = new Map<string, TrustedMinimumObjectAccessHead>();
  const authorityRequests: Array<Parameters<NonNullable<
    import("../../src/client/message/namespace-authority-client.ts")
      .NamespaceAuthorityClient["withOpenedGenerations"]
  >>[0]> = [];
  let namespaceUnavailable = false;
  let omitSelectedGeneration = false;
  let selectedGenerationKey: Uint8Array = NAMESPACE_KEY;
  const contentDependencies = {
    crypto,
    vault,
    coordinates,
    subjectHumanId: HUMAN_ID,
    now: () => NOW,
    resolveDeviceAdmissionStatus: () => Promise.resolve({
      responseVersion: 1 as const,
      required: true as const,
      status: "admitted" as const,
      deviceId,
      deviceGeneration: 1,
      expiresAt: NOW + 60_000,
    }),
    namespaceAuthority: {
      ensure: () => Promise.resolve({ status: "ready" as const }),
      synchronizeRecipients: () => Promise.resolve({ status: "ready" as const }),
      withOpenedAiGenerations: () => Promise.resolve({
        status: "unavailable" as const, reason: "unused",
      }),
      withOpenedGenerations: async <Value>(request: Parameters<NonNullable<
        import("../../src/client/message/namespace-authority-client.ts")
          .NamespaceAuthorityClient["withOpenedGenerations"]
      >>[0], use: (
        entries: readonly import("../../src/client/message/namespace-authority-client.ts")
          .OpenedNamespaceGeneration[],
      ) => Promise<Value> | Value) => {
        authorityRequests.push(request);
        if (namespaceUnavailable) return {
          status: "unavailable" as const,
          reason: "bundle_not_ready",
        };
        return {
          status: "opened" as const,
          value: await use(request.authority.flatMap(authority =>
          authority.retainedGenerations
            .filter(entry => !omitSelectedGeneration || entry.generation !== 2)
            .map(entry => ({
            namespaceId: namespaceId(authority.namespaceId),
            keyClass: "ai" as const,
            accessRevision: accessRevision(entry.accessRevision),
            generation: namespaceGeneration(entry.generation),
            generationKey: entry.generation === 2
              ? selectedGenerationKey : new Uint8Array(32).fill(0x49),
            audienceFingerprint: entry.audienceFingerprint,
            headDigest: entry.headDigest,
          }))
          )),
        };
      },
    },
    accessAnchors: {
      load: (cryptoObjectId: string) => {
        const anchor = anchors.get(cryptoObjectId);
        return Promise.resolve(anchor === undefined ? null : copyTrustedAnchor(anchor));
      },
      advance: ({ expected, next }: Readonly<{
        expected: TrustedMinimumObjectAccessHead | null;
        next: TrustedMinimumObjectAccessHead;
      }>) => {
        const current = anchors.get(next.objectId) ?? null;
        if (!equalTrustedAnchors(current, expected)) return Promise.resolve(false);
        anchors.set(next.objectId, copyTrustedAnchor(next));
        return Promise.resolve(true);
      },
    },
  };
  return {
    crypto,
    signing,
    content: createVaultHumanTaskDeviceContentPortV1(contentDependencies),
    contentDependencies,
    vault,
    anchors,
    authorityRequests,
    setNamespaceUnavailable(value: boolean) { namespaceUnavailable = value; },
    setOmitSelectedGeneration(value: boolean) { omitSelectedGeneration = value; },
    setSelectedGenerationKey(value: Uint8Array) { selectedGenerationKey = value; },
  };
}

async function preparedHumanTask(
  writer: Awaited<ReturnType<typeof setup>>,
  operationId: string,
) {
  const prepared = await writer.content.prepareCreate({
    plan: {
      planVersion: 1,
      operation: "create",
      operationId,
      taskId: TASK_ID,
      expectedContentRevision: 0,
      nextContentRevision: 1,
      expectedCryptoAccessRevision: 0,
      planDigestBase64url: base64url(new Uint8Array(32).fill(0x31)),
      authority: {
        requesterHumanId: HUMAN_ID,
        sourceRoomId: ROOM_ID,
        namespaceId: NAMESPACE_ID,
        domainId: "domain:1",
        expectedAccessRevision: 9,
        expectedPolicyRevision: 1,
        bindingHashBase64url: base64url(BINDING_HASH),
        keyGeneration: 2,
      },
    },
    payload: {
      formatVersion: 1,
      prompt: "concurrent private prompt",
      expectedOutput: "concurrent private answer",
      protectedMetadata: {},
    },
    task: {},
  });
  const reference = {
    dtoVersion: 1 as const,
    status: "protected" as const,
    objectId: prepared.cryptoObjectId,
    contentRevision: 1,
    cryptoAccessRevision: 0,
  };
  const envelope = {
    readVersion: 1 as const,
    taskId: TASK_ID,
    objectId: prepared.cryptoObjectId,
    contentRevision: 1,
    cryptoAccessRevision: 0,
    namespaceId: NAMESPACE_ID,
    readAuthority: taskReadAuthority(),
    encryptedPayloadBytes: decodeBase64url(prepared.encryptedPayloadBytesBase64url),
    accessManifestBytes: decodeBase64url(prepared.accessManifestBytesBase64url),
    accessManifestProofBytes: [],
    namespaceEnvelopeBytes: decodeBase64url(
      prepared.namespaceEnvelopes[0].envelopeBytesBase64url,
    ),
    signerEvidence: [{
      kind: "human_device" as const,
      subjectHumanId: HUMAN_ID,
      committerDeviceId: writer.contentDependencies.coordinates.deviceId,
      hostAuthorizationRevision: 11,
      signingPublicKeyBase64url: base64url(writer.signing.publicKey),
    }],
  };
  return { prepared, reference, envelope };
}

test("vault-backed Task prepare/open authenticates local custody and rejects forged signer evidence", async () => {
  const writer = await setup("device:writer", 0x248);
  const reader = await setup("device:reader", 0x249);
  const trustedReader = await setup("device:trusted-reader", 0x250, {
    deviceId: "device:writer",
    signingPublicKey: writer.signing.publicKey,
    includeLegacyKeyring: false,
  });
  const prepared = await writer.content.prepareCreate({
    plan: {
      planVersion: 1,
      operation: "create",
      operationId: "task:create:1",
      taskId: TASK_ID,
      expectedContentRevision: 0,
      nextContentRevision: 1,
      expectedCryptoAccessRevision: 0,
      planDigestBase64url: base64url(new Uint8Array(32).fill(0x31)),
      authority: {
        requesterHumanId: HUMAN_ID,
        sourceRoomId: ROOM_ID,
        namespaceId: NAMESPACE_ID,
        domainId: "domain:1",
        expectedAccessRevision: 9,
        expectedPolicyRevision: 1,
        bindingHashBase64url: base64url(BINDING_HASH),
        keyGeneration: 2,
      },
    },
    payload: {
      formatVersion: 1,
      prompt: "private prompt",
      expectedOutput: "private answer",
      protectedMetadata: {},
    },
    task: {},
  });
  const reference = {
    dtoVersion: 1 as const,
    status: "protected" as const,
    objectId: prepared.cryptoObjectId,
    contentRevision: 1,
    cryptoAccessRevision: 0,
  };
  const envelope = {
    readVersion: 1 as const,
    taskId: TASK_ID,
    objectId: prepared.cryptoObjectId,
    contentRevision: 1,
    cryptoAccessRevision: 0,
    namespaceId: NAMESPACE_ID,
    readAuthority: taskReadAuthority(),
    encryptedPayloadBytes: decodeBase64url(prepared.encryptedPayloadBytesBase64url),
    accessManifestBytes: decodeBase64url(prepared.accessManifestBytesBase64url),
    accessManifestProofBytes: [],
    namespaceEnvelopeBytes: decodeBase64url(
      prepared.namespaceEnvelopes[0].envelopeBytesBase64url,
    ),
    signerEvidence: [{
      kind: "human_device",
      subjectHumanId: HUMAN_ID,
      committerDeviceId: "device:writer",
      hostAuthorizationRevision: 11,
      signingPublicKeyBase64url: base64url(writer.signing.publicKey),
    }],
  };

  await writer.vault.lock();
  const opened = await writer.content.openExact({ reference, envelope });
  try {
    expect(decodeTaskPayloadV1(opened)).toMatchObject({
      prompt: "private prompt",
      expectedOutput: "private answer",
    });
  } finally {
    opened.fill(0);
  }
  expect(await writer.vault.availability()).toEqual({ status: "available" });
  expect(writer.anchors.has(prepared.cryptoObjectId)).toBe(true);

  const genesis = decodeObjectAccessManifestV5(envelope.accessManifestBytes);
  const previousManifestHash = writer.crypto.hash(envelope.accessManifestBytes);
  const accessUpdate = createCommonHumanObjectAccessManifest(writer.crypto, {
    objectId: genesis.objectId,
    payloadHash: genesis.payloadHash,
    accessRevision: accessRevision(1),
    previousManifestHash,
    envelopeHashes: genesis.envelopeHashes,
    signer: {
      kind: "human_device",
      subjectHumanId: humanId(HUMAN_ID),
      committerDeviceId: cryptoDeviceId("device:writer"),
    },
    signerAuthorizationHash: null,
    hostAuthorizationRevision: authorizationRevision(11),
  }, writer.signing.privateKey);
  const revisionOne = await writer.content.openExact({
    reference: { ...reference, cryptoAccessRevision: 1 },
    envelope: {
      ...envelope,
      cryptoAccessRevision: 1,
      accessManifestBytes: accessUpdate.bytes,
      accessManifestProofBytes: [envelope.accessManifestBytes],
    },
  });
  try {
    expect(decodeTaskPayloadV1(revisionOne).prompt).toBe("private prompt");
  } finally {
    revisionOne.fill(0);
  }
  expect(Number(writer.anchors.get(prepared.cryptoObjectId)?.accessRevision)).toBe(1);
  previousManifestHash.fill(0);
  genesis.payloadHash.fill(0);
  genesis.previousManifestHash?.fill(0);
  genesis.envelopeHashes.forEach(hash => hash.fill(0));
  genesis.signerAuthorizationHash?.fill(0);
  genesis.signature.fill(0);
  accessUpdate.bytes.fill(0);
  accessUpdate.hash.fill(0);

  const truncatedRevision = await writer.content.openExact({
    reference: { ...reference, cryptoAccessRevision: 1 },
    envelope: { ...envelope, cryptoAccessRevision: 1 },
  }).catch((cause: unknown) => cause);
  expect(truncatedRevision).toBeInstanceOf(ClassifiedDataOperationError);
  expect((truncatedRevision as ClassifiedDataOperationError).failureClass)
    .toBe("integrity");

  for (const signerEvidence of [
    [],
    [...envelope.signerEvidence, ...envelope.signerEvidence],
    [{
      ...(envelope.signerEvidence[0] as Record<string, unknown>),
      signingPublicKeyBase64url: base64url(new Uint8Array(32).fill(0xee)),
    }],
  ]) {
    const evidenceError = await writer.content.openExact({
      reference,
      envelope: { ...envelope, signerEvidence },
    }).catch((cause: unknown) => cause);
    expect(evidenceError).toBeInstanceOf(ClassifiedDataOperationError);
    expect((evidenceError as ClassifiedDataOperationError).failureClass)
      .toBe("integrity");
  }

  const retained = writer.anchors.get(prepared.cryptoObjectId)!;
  writer.anchors.set(prepared.cryptoObjectId, {
    ...retained,
    manifestHash: new Uint8Array(32).fill(0xff),
  });
  const rollback = await writer.content.openExact({ reference, envelope })
    .catch((cause: unknown) => cause);
  expect(rollback).toBeInstanceOf(ClassifiedDataOperationError);
  expect((rollback as ClassifiedDataOperationError).failureClass).toBe("integrity");

  const error = await reader.content.openExact({ reference, envelope })
    .catch((cause: unknown) => cause);
  expect(error).toBeInstanceOf(ClassifiedDataOperationError);
  expect((error as ClassifiedDataOperationError).failureClass).toBe("key_waiting");

  const crossDevice = await trustedReader.content.openExact({ reference, envelope });
  try {
    expect(decodeTaskPayloadV1(crossDevice).prompt).toBe("private prompt");
  } finally {
    crossDevice.fill(0);
  }
  expect(trustedReader.authorityRequests).toHaveLength(1);
  expect(trustedReader.authorityRequests[0]!.authority[0]!.retainedGenerations
    .map(entry => entry.generation)).toEqual([2, 3]);
  expect(trustedReader.authorityRequests[0]!.authority[0]!
    .retainedGenerations.at(-1)!.accessRevision).toBe(10);

  const pendingReader = await setup("device:pending-reader", 0x251, {
    deviceId: "device:writer",
    signingPublicKey: writer.signing.publicKey,
    includeLegacyKeyring: false,
  });
  pendingReader.setNamespaceUnavailable(true);
  const pending = await pendingReader.content.openExact({ reference, envelope })
    .catch((cause: unknown) => cause);
  expect(pending).toBeInstanceOf(ClassifiedDataOperationError);
  expect((pending as ClassifiedDataOperationError).failureClass).toBe("key_waiting");
  expect(pendingReader.anchors.has(prepared.cryptoObjectId)).toBe(false);

  const missingReader = await setup("device:missing-reader", 0x256, {
    deviceId: "device:writer",
    signingPublicKey: writer.signing.publicKey,
    includeLegacyKeyring: false,
  });
  missingReader.setOmitSelectedGeneration(true);
  const missing = await missingReader.content.openExact({ reference, envelope })
    .catch((cause: unknown) => cause);
  expect(missing).toBeInstanceOf(ClassifiedDataOperationError);
  expect((missing as ClassifiedDataOperationError).failureClass).toBe("key_waiting");
  expect(missingReader.anchors.has(prepared.cryptoObjectId)).toBe(false);

  const mismatchReader = await setup("device:mismatch-reader", 0x257, {
    deviceId: "device:writer",
    signingPublicKey: writer.signing.publicKey,
    includeLegacyKeyring: false,
  });
  mismatchReader.setSelectedGenerationKey(new Uint8Array(32).fill(0xee));
  const mismatch = await mismatchReader.content.openExact({ reference, envelope })
    .catch((cause: unknown) => cause);
  expect(mismatch).toBeInstanceOf(ClassifiedDataOperationError);
  expect((mismatch as ClassifiedDataOperationError).failureClass).toBe("integrity");
  expect(mismatchReader.anchors.has(prepared.cryptoObjectId)).toBe(false);

  pendingReader.setNamespaceUnavailable(false);
  const wrongAuthority = await pendingReader.content.openExact({
    reference,
    envelope: {
      ...envelope,
      readAuthority: {
        ...taskReadAuthority(),
        namespaceId: "50000000-0000-4000-8000-000000000249",
      },
    },
  }).catch((cause: unknown) => cause);
  expect(wrongAuthority).toBeInstanceOf(ClassifiedDataOperationError);
  expect((wrongAuthority as ClassifiedDataOperationError).failureClass)
    .toBe("integrity");
  expect(pendingReader.anchors.has(prepared.cryptoObjectId)).toBe(false);
});

test("vault-backed Task open accepts an identical concurrent access-anchor winner", async () => {
  const writer = await setup("device:anchor-race-writer", 0x261);
  const reader = await setup("device:anchor-race-reader", 0x262, {
    deviceId: "device:anchor-race-writer",
    signingPublicKey: writer.signing.publicKey,
    includeLegacyKeyring: false,
  });
  const { reference, envelope } = await preparedHumanTask(
    writer,
    "task:anchor-race:create",
  );
  let current: TrustedMinimumObjectAccessHead | null = null;
  let initialLoads = 0;
  let successfulAdvances = 0;
  let rejectedAdvances = 0;
  let fallbackAnchor: TrustedMinimumObjectAccessHead | null = null;
  let releaseInitialLoads!: () => void;
  const bothInitialLoads = new Promise<void>(resolve => {
    releaseInitialLoads = resolve;
  });
  const content = createVaultHumanTaskDeviceContentPortV1({
    ...reader.contentDependencies,
    accessAnchors: {
      load: async () => {
        if (current === null && initialLoads < 2) {
          initialLoads += 1;
          if (initialLoads === 2) releaseInitialLoads();
          await bothInitialLoads;
          return null;
        }
        fallbackAnchor = current === null ? null : copyTrustedAnchor(current);
        return fallbackAnchor;
      },
      advance: ({ expected, next }) => {
        if (!equalTrustedAnchors(current, expected)) {
          rejectedAdvances += 1;
          return Promise.resolve(false);
        }
        current = copyTrustedAnchor(next);
        successfulAdvances += 1;
        return Promise.resolve(true);
      },
    },
  });

  const opened = await Promise.all([
    content.openExact({ reference, envelope }),
    content.openExact({ reference, envelope }),
  ]);
  try {
    expect(opened.map(value => decodeTaskPayloadV1(value).prompt)).toEqual([
      "concurrent private prompt",
      "concurrent private prompt",
    ]);
    expect(successfulAdvances).toBe(1);
    expect(rejectedAdvances).toBe(1);
    expect(current).not.toBeNull();
    expect(current!.payloadHash.some(byte => byte !== 0)).toBe(true);
    expect(current!.manifestHash.some(byte => byte !== 0)).toBe(true);
    expect(fallbackAnchor).not.toBeNull();
    expect(fallbackAnchor!.payloadHash.every(byte => byte === 0)).toBe(true);
    expect(fallbackAnchor!.manifestHash.every(byte => byte === 0)).toBe(true);
  } finally {
    opened.forEach(value => value.fill(0));
  }
});

test("vault-backed Task open accepts only the exact concurrently retained next anchor", async () => {
  const writer = await setup("device:anchor-next-writer", 0x263);
  const reader = await setup("device:anchor-next-reader", 0x264, {
    deviceId: "device:anchor-next-writer",
    signingPublicKey: writer.signing.publicKey,
    includeLegacyKeyring: false,
  });
  const { reference, envelope } = await preparedHumanTask(
    writer,
    "task:anchor-next:create",
  );
  const genesisPlaintext = await reader.content.openExact({ reference, envelope });
  genesisPlaintext.fill(0);
  const retained = copyTrustedAnchor(reader.anchors.get(reference.objectId)!);
  const genesis = decodeObjectAccessManifestV5(envelope.accessManifestBytes);
  const previousManifestHash = writer.crypto.hash(envelope.accessManifestBytes);
  const accessUpdate = createCommonHumanObjectAccessManifest(writer.crypto, {
    objectId: genesis.objectId,
    payloadHash: genesis.payloadHash,
    accessRevision: accessRevision(1),
    previousManifestHash,
    envelopeHashes: genesis.envelopeHashes,
    signer: {
      kind: "human_device",
      subjectHumanId: humanId(HUMAN_ID),
      committerDeviceId: cryptoDeviceId("device:anchor-next-writer"),
    },
    signerAuthorizationHash: null,
    hostAuthorizationRevision: authorizationRevision(11),
  }, writer.signing.privateKey);
  const nextReference = { ...reference, cryptoAccessRevision: 1 };
  const nextEnvelope = {
    ...envelope,
    cryptoAccessRevision: 1,
    accessManifestBytes: accessUpdate.bytes,
    accessManifestProofBytes: [envelope.accessManifestBytes],
  };

  let winningAnchor: TrustedMinimumObjectAccessHead | null = null;
  let exactLoadCount = 0;
  let exactFallbackAnchor: TrustedMinimumObjectAccessHead | null = null;
  const exactContent = createVaultHumanTaskDeviceContentPortV1({
    ...reader.contentDependencies,
    accessAnchors: {
      load: () => {
        exactLoadCount += 1;
        if (exactLoadCount === 1) return Promise.resolve(copyTrustedAnchor(retained));
        exactFallbackAnchor = copyTrustedAnchor(winningAnchor!);
        return Promise.resolve(exactFallbackAnchor);
      },
      advance: ({ next }) => {
        winningAnchor = copyTrustedAnchor(next);
        return Promise.resolve(false);
      },
    },
  });
  const exact = await exactContent.openExact({
    reference: nextReference,
    envelope: nextEnvelope,
  });
  try {
    expect(decodeTaskPayloadV1(exact).prompt).toBe("concurrent private prompt");
    expect(exactFallbackAnchor!.payloadHash.every(byte => byte === 0)).toBe(true);
    expect(exactFallbackAnchor!.manifestHash.every(byte => byte === 0)).toBe(true);
  } finally {
    exact.fill(0);
  }

  const staleCases = [
    {
      name: "missing",
      change: (_next: TrustedMinimumObjectAccessHead) => null,
    },
    {
      name: "foreign object",
      change: (next: TrustedMinimumObjectAccessHead) => ({
        ...copyTrustedAnchor(next),
        objectId: `${next.objectId}:foreign` as typeof next.objectId,
      }),
    },
    {
      name: "older revision",
      change: (next: TrustedMinimumObjectAccessHead) => ({
        ...copyTrustedAnchor(next),
        accessRevision: accessRevision(0),
      }),
    },
    {
      name: "newer revision",
      change: (next: TrustedMinimumObjectAccessHead) => ({
        ...copyTrustedAnchor(next),
        accessRevision: accessRevision(2),
      }),
    },
    {
      name: "different payload hash length",
      change: (next: TrustedMinimumObjectAccessHead) => ({
        ...copyTrustedAnchor(next),
        payloadHash: next.payloadHash.subarray(0, next.payloadHash.length - 1),
      }),
    },
    {
      name: "different manifest hash",
      change: (next: TrustedMinimumObjectAccessHead) => ({
        ...copyTrustedAnchor(next),
        manifestHash: new Uint8Array(next.manifestHash).fill(0xee),
      }),
    },
  ] as const;
  for (const staleCase of staleCases) {
    let loadCount = 0;
    let proposed: TrustedMinimumObjectAccessHead | null = null;
    const staleContent = createVaultHumanTaskDeviceContentPortV1({
      ...reader.contentDependencies,
      accessAnchors: {
        load: () => {
          loadCount += 1;
          return Promise.resolve(loadCount === 1
            ? copyTrustedAnchor(retained)
            : staleCase.change(proposed!));
        },
        advance: ({ next }) => {
          proposed = copyTrustedAnchor(next);
          return Promise.resolve(false);
        },
      },
    });
    const stale = await staleContent.openExact({
      reference: nextReference,
      envelope: nextEnvelope,
    }).catch((cause: unknown) => cause);
    expect(staleCase.name).toBeString();
    expect(stale).toBeInstanceOf(ClassifiedDataOperationError);
    expect((stale as ClassifiedDataOperationError).failureClass).toBe("stale");
  }

  const unavailable = new ClassifiedDataOperationError(
    "key_waiting",
    "Client profile is unavailable",
  );
  let unavailableLoadCount = 0;
  const unavailableContent = createVaultHumanTaskDeviceContentPortV1({
    ...reader.contentDependencies,
    accessAnchors: {
      load: () => {
        unavailableLoadCount += 1;
        if (unavailableLoadCount === 1) {
          return Promise.resolve(copyTrustedAnchor(retained));
        }
        return Promise.reject(unavailable);
      },
      advance: () => Promise.resolve(false),
    },
  });
  const unavailableResult = await unavailableContent.openExact({
    reference: nextReference,
    envelope: nextEnvelope,
  }).catch((cause: unknown) => cause);
  expect(unavailableResult).toBe(unavailable);

  retained.payloadHash.fill(0);
  retained.manifestHash.fill(0);
  previousManifestHash.fill(0);
  genesis.payloadHash.fill(0);
  genesis.previousManifestHash?.fill(0);
  genesis.envelopeHashes.forEach(hash => hash.fill(0));
  genesis.signerAuthorizationHash?.fill(0);
  genesis.signature.fill(0);
  accessUpdate.bytes.fill(0);
  accessUpdate.hash.fill(0);
});

test("vault-backed Task open accepts only the Task-bound trusted Agent Runtime signer", async () => {
  const manager = await setup("device:agent-manager", 0x252);
  const reader = await setup("device:agent-reader", 0x253, {
    deviceId: "device:agent-manager",
    signingPublicKey: manager.signing.publicKey,
  });
  const prepared = await preparedAgentDefinition(
    manager,
    "device:agent-manager",
  );

  await reader.vault.lock();
  const opened = await reader.content.openExact({
    reference: prepared.reference,
    envelope: prepared.envelope,
    expectedAgentId: AGENT_ID,
  });
  try {
    expect(decodeTaskPayloadV1(opened)).toMatchObject({
      prompt: "Agent-created private prompt",
      expectedOutput: "Agent-created private answer",
    });
  } finally {
    opened.fill(0);
  }
  expect(await reader.vault.availability()).toEqual({ status: "available" });
  expect(reader.anchors.has(prepared.reference.objectId)).toBe(true);

  for (const attempt of [
    {
      expectedAgentId: "60000000-0000-4000-8000-000000000249",
      envelope: prepared.envelope,
    },
    {
      expectedAgentId: AGENT_ID,
      envelope: {
        ...prepared.envelope,
        signerEvidence: [{
          ...prepared.envelope.signerEvidence[0]!,
          evidenceBytesBase64url: base64url(new Uint8Array(64).fill(0xee)),
        }],
      },
    },
  ]) {
    const error = await reader.content.openExact({
      reference: prepared.reference,
      envelope: attempt.envelope,
      expectedAgentId: attempt.expectedAgentId,
    }).catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(ClassifiedDataOperationError);
  }

  const untrusted = await setup("device:agent-untrusted", 0x254);
  const error = await untrusted.content.openExact({
    reference: prepared.reference,
    envelope: prepared.envelope,
    expectedAgentId: AGENT_ID,
  }).catch((cause: unknown) => cause);
  expect(error).toBeInstanceOf(ClassifiedDataOperationError);
  expect((error as ClassifiedDataOperationError).failureClass)
    .toBe("key_waiting");

  const foregroundReader = await setup("device:agent-foreground-reader", 0x255);
  const foregroundEnvelope = {
    ...prepared.envelope,
    signerEvidence: [prepared.foregroundEvidence],
  };
  await foregroundReader.vault.lock();
  const foregroundOpened = await foregroundReader.content.openExact({
    reference: prepared.reference,
    envelope: foregroundEnvelope,
    expectedAgentId: AGENT_ID,
  });
  try {
    expect(decodeTaskPayloadV1(foregroundOpened).prompt)
      .toBe("Agent-created private prompt");
  } finally {
    foregroundOpened.fill(0);
  }
  expect(await foregroundReader.vault.availability())
    .toEqual({ status: "available" });
  expect(foregroundReader.anchors.has(prepared.reference.objectId)).toBe(true);

  const badDigest = decodeBase64url(
    prepared.foregroundEvidence.planDigestBase64url,
  );
  badDigest[0] = badDigest[0]! ^ 1;
  const decodedPlan = decodeLiveShadowMessagePlanV4(
    prepared.foregroundPlanBytes,
  );
  const wrongGenerationBytes = encodeLiveShadowMessagePlanV4({
    ...decodedPlan,
    agentRuntimeGeneration: decodedPlan.agentRuntimeGeneration + 1,
  });
  for (const signerEvidence of [
    [{
      ...prepared.foregroundEvidence,
      planDigestBase64url: base64url(badDigest),
    }],
    [{
      ...prepared.foregroundEvidence,
      planBytesBase64url: base64url(wrongGenerationBytes),
      planDigestBase64url: base64url(manager.crypto.hash(wrongGenerationBytes)),
    }],
    [prepared.foregroundEvidence, prepared.foregroundEvidence],
  ]) {
    const rejected = await foregroundReader.content.openExact({
      reference: prepared.reference,
      envelope: { ...foregroundEnvelope, signerEvidence },
      expectedAgentId: AGENT_ID,
    }).catch((cause: unknown) => cause);
    expect(rejected).toBeInstanceOf(ClassifiedDataOperationError);
    expect((rejected as ClassifiedDataOperationError).failureClass)
      .toBe("integrity");
  }
  badDigest.fill(0);
  wrongGenerationBytes.fill(0);
  decodedPlan.agentSignerPublicKey.fill(0);
  decodedPlan.namespaceHeadDigest.fill(0);
  decodedPlan.namespacePublicationDigest.fill(0);
  decodedPlan.namespacePublicationSetDigest.fill(0);
  decodedPlan.namespaceAudienceFingerprint.fill(0);
  decodedPlan.grantDomainParticipantDigest.fill(0);
  decodedPlan.grantDomainHeadDigest.fill(0);
  decodedPlan.grantDomainPublicationDigest.fill(0);
  decodedPlan.namespaceBundleDigest.fill(0);
  if (decodedPlan.authorization.disposition === "authorization_reusable") {
    decodedPlan.authorization.authorizationDigest.fill(0);
  }
});

test("vault-backed Task definition accepts an authenticated same-Human cross-Agent author", async () => {
  const manager = await setup("device:cross-agent-manager", 0x262);
  const reader = await setup("device:cross-agent-reader", 0x263);
  const prepared = await preparedAgentDefinition(
    manager,
    "device:cross-agent-manager",
    OTHER_AGENT_ID,
  );
  const envelope = {
    ...prepared.envelope,
    signerEvidence: [prepared.foregroundEvidence],
  };
  const opened = await reader.content.openExact({
    reference: prepared.reference,
    envelope,
    expectedAgentId: AGENT_ID,
  });
  expect(decodeTaskPayloadV1(opened).prompt)
    .toBe("Agent-created private prompt");
  opened.fill(0);

  const badDigest = decodeBase64url(
    prepared.foregroundEvidence.planDigestBase64url,
  );
  badDigest[0] = badDigest[0]! ^ 1;
  for (const signerEvidence of [
    [],
    [{ ...prepared.foregroundEvidence,
      planDigestBase64url: base64url(badDigest) }],
  ]) {
    const rejected = await reader.content.openExact({
      reference: prepared.reference,
      envelope: { ...envelope, signerEvidence },
      expectedAgentId: AGENT_ID,
    }).catch((cause: unknown) => cause);
    expect(rejected).toBeInstanceOf(ClassifiedDataOperationError);
    expect((rejected as ClassifiedDataOperationError).failureClass)
      .toBe("integrity");
  }
  badDigest.fill(0);

  const wrongHuman = await preparedAgentDefinition(
    manager,
    "device:cross-agent-manager",
    OTHER_AGENT_ID,
    "other-human",
  );
  const wrongHumanResult = await reader.content.openExact({
    reference: wrongHuman.reference,
    envelope: { ...wrongHuman.envelope,
      signerEvidence: [wrongHuman.foregroundEvidence] },
    expectedAgentId: AGENT_ID,
  }).catch((cause: unknown) => cause);
  expect(wrongHumanResult).toBeInstanceOf(ClassifiedDataOperationError);
  expect((wrongHumanResult as ClassifiedDataOperationError).failureClass)
    .toBe("integrity");
});

test("vault-backed Task open keeps terminal custody loss classified as key waiting", async () => {
  const writer = await setup("device:terminal-custody-writer", 0x256);
  const prepared = await writer.content.prepareCreate({
    plan: {
      planVersion: 1,
      operation: "create",
      operationId: "task:terminal-custody:create",
      taskId: TASK_ID,
      expectedContentRevision: 0,
      nextContentRevision: 1,
      expectedCryptoAccessRevision: 0,
      planDigestBase64url: base64url(new Uint8Array(32).fill(0x31)),
      authority: {
        requesterHumanId: HUMAN_ID,
        sourceRoomId: ROOM_ID,
        namespaceId: NAMESPACE_ID,
        domainId: "domain:1",
        expectedAccessRevision: 9,
        expectedPolicyRevision: 1,
        bindingHashBase64url: base64url(BINDING_HASH),
        keyGeneration: 2,
      },
    },
    payload: {
      formatVersion: 1,
      prompt: "terminal custody prompt",
      expectedOutput: null,
      protectedMetadata: {},
    },
    task: {},
  });
  const terminalVault: ClientProfileVault = {
    availability: () => Promise.resolve({ status: "storage_lost" }),
    unlock: () => Promise.resolve({ status: "storage_lost" }),
    lock: () => writer.vault.lock(),
    stageProfile: input => writer.vault.stageProfile(input),
    activateProfile: (coordinates, stageId) =>
      writer.vault.activateProfile(coordinates, stageId),
    abortStagedProfile: (coordinates, stageId) =>
      writer.vault.abortStagedProfile(coordinates, stageId),
    recoverInterruptedActivation: (coordinates, resolution) =>
      writer.vault.recoverInterruptedActivation(coordinates, resolution),
    withOpenProfile: (coordinates, operation) =>
      writer.vault.withOpenProfile(coordinates, operation),
    listPublicProfiles: () => writer.vault.listPublicProfiles(),
    rotateWrappingMaterial: () => writer.vault.rotateWrappingMaterial(),
    forgetProfile: coordinates => writer.vault.forgetProfile(coordinates),
  };
  const terminalContent = createVaultHumanTaskDeviceContentPortV1({
    ...writer.contentDependencies,
    vault: terminalVault,
  });
  const error = await terminalContent.openExact({
    reference: {
      dtoVersion: 1,
      status: "protected",
      objectId: prepared.cryptoObjectId,
      contentRevision: 1,
      cryptoAccessRevision: 0,
    },
    envelope: {
      readVersion: 1,
      taskId: TASK_ID,
      objectId: prepared.cryptoObjectId,
      contentRevision: 1,
      cryptoAccessRevision: 0,
      namespaceId: NAMESPACE_ID,
      readAuthority: taskReadAuthority(),
      encryptedPayloadBytes: decodeBase64url(prepared.encryptedPayloadBytesBase64url),
      accessManifestBytes: decodeBase64url(prepared.accessManifestBytesBase64url),
      accessManifestProofBytes: [],
      namespaceEnvelopeBytes: decodeBase64url(
        prepared.namespaceEnvelopes[0].envelopeBytesBase64url,
      ),
      signerEvidence: [{
        kind: "human_device",
        subjectHumanId: HUMAN_ID,
        committerDeviceId: "device:terminal-custody-writer",
        hostAuthorizationRevision: 11,
        signingPublicKeyBase64url: base64url(writer.signing.publicKey),
      }],
    },
  }).catch((cause: unknown) => cause);
  expect(error).toBeInstanceOf(ClassifiedDataOperationError);
  expect((error as ClassifiedDataOperationError).failureClass).toBe("key_waiting");
  expect(writer.anchors.size).toBe(0);
});

test("dual Task preparation encrypts and signs the same canonical ordinary payload bytes", async () => {
  const writer = await setup("device:dual-writer", 0x251);
  const plan = {
    planVersion: 1 as const,
    operation: "create" as const,
    operationId: "task:dual:create:1",
    taskId: TASK_ID,
    expectedContentRevision: 0,
    nextContentRevision: 1,
    expectedCryptoAccessRevision: 0,
    planDigestBase64url: base64url(new Uint8Array(32).fill(0x31)),
    authority: {
      requesterHumanId: HUMAN_ID,
      sourceRoomId: ROOM_ID,
      namespaceId: NAMESPACE_ID,
      domainId: "domain:1",
      expectedAccessRevision: 9,
      expectedPolicyRevision: 1,
      bindingHashBase64url: base64url(BINDING_HASH),
      keyGeneration: 2,
    },
  };
  const task = { scheduleKind: "now" as const };
  const payloads = ["first private prompt", "second private prompt"].map((prompt) => ({
    formatVersion: 1 as const,
    prompt,
    expectedOutput: null,
    protectedMetadata: {},
  }));
  const prepared = await Promise.all(payloads.map((payload) =>
    writer.content.prepareDualCreate({ plan, payload, task })
  ));
  const signedDigests = prepared.map((request, index) => {
    expect(request.representation).toBe("dual");
    const canonical = encodeTaskPayloadV1(payloads[index]!);
    const ordinary = decodeBase64url(request.ordinaryPayloadBytesBase64url);
    const signedBytes = decodeBase64url(request.signedPublicationRequestBytesBase64url);
    try {
      expect(ordinary).toEqual(canonical);
      const signed = decodeHumanTaskPublicationRequestV1(signedBytes);
      const expected = fingerprintTaskDualPublicationFieldsV1(
        "create",
        task,
        canonical,
      );
      try {
        expect(signed.operationalFieldsDigest).toEqual(expected);
        return signed.operationalFieldsDigest.slice();
      } finally {
        expected.fill(0);
        signed.operationalFieldsDigest.fill(0);
      }
    } finally {
      canonical.fill(0);
      ordinary.fill(0);
      signedBytes.fill(0);
    }
  });
  expect(signedDigests[0]).not.toEqual(signedDigests[1]);
  for (const digest of signedDigests) digest.fill(0);
});

test("dual Task update signs and publishes the exact carried V2 definition bytes", async () => {
  const writer = await setup("device:dual-v2-writer", 0x252);
  const plan = {
    planVersion: 1 as const,
    operation: "update" as const,
    operationId: "task:dual:update:2",
    taskId: TASK_ID,
    expectedContentRevision: 1,
    nextContentRevision: 2,
    expectedCryptoAccessRevision: 0,
    planDigestBase64url: base64url(new Uint8Array(32).fill(0x31)),
    authority: {
      requesterHumanId: HUMAN_ID,
      sourceRoomId: ROOM_ID,
      namespaceId: NAMESPACE_ID,
      domainId: "domain:1",
      expectedAccessRevision: 9,
      expectedPolicyRevision: 1,
      bindingHashBase64url: base64url(BINDING_HASH),
      keyGeneration: 2,
    },
  };
  const task = { scheduleKind: "now" as const };
  const payload = {
    formatVersion: 2 as const,
    prompt: "edited private prompt",
    expectedOutput: null,
    protectedMetadata: {},
    retainedHistoricalError: "provider unavailable",
  };
  const prepared = await writer.content.prepareDualUpdate({ plan, payload, task });
  const canonical = encodeTaskDefinitionContentV2(payload);
  const ordinary = decodeBase64url(prepared.ordinaryPayloadBytesBase64url);
  const signedBytes = decodeBase64url(prepared.signedPublicationRequestBytesBase64url);
  try {
    expect(ordinary).toEqual(canonical);
    const signed = decodeHumanTaskPublicationRequestV1(signedBytes);
    const expected = fingerprintTaskDualPublicationFieldsV1("update", task, canonical);
    try {
      expect(signed.operationalFieldsDigest).toEqual(expected);
    } finally {
      signed.operationalFieldsDigest.fill(0);
      expected.fill(0);
    }
  } finally {
    canonical.fill(0);
    ordinary.fill(0);
    signedBytes.fill(0);
  }
});
