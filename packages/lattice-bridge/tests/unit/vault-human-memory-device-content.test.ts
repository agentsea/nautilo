import { describe, expect, test } from "bun:test";
import { sha256 } from "@noble/hashes/sha2.js";
import { AuthorizedHumanMemoryUnavailableError } from "../../src/client/memory/authorized-human-memory-client.ts";
import { verifyHumanMemoryOrdinaryFallbackRequestV1 } from
  "../../src/memory/human-memory-ordinary-fallback-request.ts";

import {
  LatticeCrypto,
  accessRevision,
  authorizationRevision,
  cryptoDeviceId,
  createCommonAgentObjectAccessManifest,
  createCommonHumanObjectAccessManifest,
  deriveAgentRuntimeObjectSignerPublic,
  humanId,
  namespaceGeneration,
  namespaceId,
  objectId,
  openObjectDekForNamespace,
  prepareAgentRuntimeInitialization,
  unixTimestamp,
  verifyHumanMemoryContentEmbeddingRequest,
  wrapObjectDekForNamespace,
} from "@nautilo/lattice-crypto";
import {
  decodeEncryptedPayloadV2,
  encodeAgentRuntimeSignerPublicationV1,
  decodeNamespaceObjectEnvelopeV2,
  decodeHumanMemoryExactAccessRequestV2,
  decodeObjectAccessManifestV5,
  decodeLiveShadowMessagePlanV4,
  encodeLiveShadowMessagePlanV4,
  encodeNamespaceObjectEnvelopeV2,
} from "@nautilo/lattice-crypto/wire";

import {
  encodeClientDeviceProfileV2,
  type OpenedClientDeviceProfileV2,
} from "../../src/client-vault/profile-v2.ts";
import {
  authenticateClientDeviceProfileV4,
  createClientDeviceProfileV4Candidate,
  destroyOpenedClientDeviceProfileV4,
  encodeClientDeviceProfileV4,
} from "../../src/client-vault/profile-v4.ts";
import {
  createClientDeviceProfileV3Candidate,
  destroyOpenedClientDeviceProfileV3,
  encodeClientDeviceProfileV3,
} from "../../src/client-vault/profile-v3.ts";
import type {
  ClientProfileCoordinates,
  ClientProfileVault,
} from "../../src/client-vault/types.ts";
import {
  createVaultAuthorizedHumanMemoryDeviceContentPort,
} from "../../src/client/memory/vault-human-memory-device-content.ts";
import { decodeMemoryPayloadV1, encodeMemoryPayloadV1 } from "../../src/memory/memory-payload-v1.ts";
import { MemoryClientProfileVault } from "../../src/testing/client-profile-vault.ts";
import { decodeHumanMemoryRepairAttestationV1, humanMemoryRepairAttestationSigningDigestV1 } from "../../src/memory/human-memory-repair-attestation.ts";
import { deriveMemoryCryptoObjectIdV1, fingerprintRequiredMemoryNamespaces } from "../../src/memory/memory-repository.ts";
import { authenticatePreparedHumanMemoryUpdate } from
  "../../src/server/memory/human-memory-prepared-update.ts";

const MEMORY_ID = "00000000-0000-4000-8000-000000000248";
const NAMESPACE_ID = "00000000-0000-4000-8000-000000000249";
const NAMESPACE_B = "00000000-0000-4000-8000-000000000250";
const SOURCE_ROOM = "00000000-0000-4000-8000-000000000251";
const COORDINATES: ClientProfileCoordinates = Object.freeze({
  serverScope: "https://nautilo.test",
  userId: "10000000-0000-4000-8000-000000000248",
  humanActorId: "20000000-0000-4000-8000-000000000248",
  profileId: "profile:1",
  deviceId: "device:1",
  installationLineageDigest: "48".repeat(32),
});

function seededRng(seed: number): (length: number) => Uint8Array {
  let state = seed >>> 0;
  return (length) => Uint8Array.from({ length }, () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state & 0xff;
  });
}

function decodeBase64url(value: string): Uint8Array {
  const padded = value.replaceAll("-", "+").replaceAll("_", "/")
    + "=".repeat((4 - value.length % 4) % 4);
  return Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
}

async function captureError(operation: () => Promise<unknown>): Promise<unknown> {
  try {
    await operation();
    return undefined;
  } catch (error) {
    return error;
  }
}

const authority = (namespace: string, generation: number, revision: number) => ({
  sourceRoomId: SOURCE_ROOM,
  namespaceId: namespace,
  currentGeneration: generation,
  retainedGenerations: [{
    generation,
    accessRevision: revision,
    headDigestBase64url: Buffer.from(new Uint8Array(32).fill(1)).toString("base64url"),
    publicationDigestBase64url: Buffer.from(new Uint8Array(32).fill(2)).toString("base64url"),
    publicationSetDigestBase64url: Buffer.from(new Uint8Array(32).fill(3)).toString("base64url"),
    audienceFingerprintBase64url: Buffer.from(new Uint8Array(32).fill(4)).toString("base64url"),
  }],
});
const AUTHORITY_A = authority(NAMESPACE_ID, 2, 9);
const AUTHORITY_B = authority(NAMESPACE_B, 1, 3);

function repairPlan(now: number) {
  return {
    dtoVersion: 1 as const, status: "planned" as const, direction: "ordinary_to_protected" as const,
    mode: "shadow_encryption" as const, shadowBehavior: "strict" as const, policyRevision: 1,
    memoryId: MEMORY_ID, operationId: "repair:1", expectedContentRevision: 0, targetContentRevision: 1,
    expectedCryptoAccessRevision: 0,
    cryptoObjectId: deriveMemoryCryptoObjectIdV1({ memoryId: MEMORY_ID, contentRevision: 1 }),
    requiredNamespaceIds: [NAMESPACE_ID],
    requiredNamespaceFingerprintBase64url: Buffer.from(fingerprintRequiredMemoryNamespaces([NAMESPACE_ID])).toString("base64url"),
    targetAuthorities: [AUTHORITY_A], createdAt: now - 1_000_000, deadlineAt: now + 30_000,
    repairInput: { formatVersion: 1 as const, type: "authored category", content: "Historical fact, unchanged." },
  };
}

test("device repairs ordinary history then independently opens the resulting exact ciphertext", async () => {
  const state = await setup();
  const plan = repairPlan(state.now);
  const prepared = await state.content.prepareRepair!(plan);
  if (prepared.direction !== "ordinary_to_protected") throw new Error("Expected forward repair");
  expect("signedContentEmbeddingRequestBytesBase64url" in prepared).toBe(false);
  const attestation = decodeHumanMemoryRepairAttestationV1(decodeBase64url(prepared.signedRepairAttestationBytesBase64url));
  expect(attestation.expectedContentRevision).toBe(0);
  expect(attestation.targetContentRevision).toBe(1);
  expect(attestation.namespaces[0]).toMatchObject({ namespaceId: NAMESPACE_ID, namespaceKeyGeneration: 2 });
  expect(state.crypto.verify(state.signing.publicKey, humanMemoryRepairAttestationSigningDigestV1(attestation), attestation.signature)).toBe(true);
  const current = dtoFromCreate({ ...prepared, cryptoObjectId: plan.cryptoObjectId }, state.signing.publicKey);
  const opened = await state.content.openExact(current);
  try { expect(decodeMemoryPayloadV1(opened)).toEqual(plan.repairInput); }
  finally { opened.fill(0); }
  const advanced = { ...AUTHORITY_A, currentGeneration: 3,
    retainedGenerations: [...AUTHORITY_A.retainedGenerations, { ...AUTHORITY_A.retainedGenerations[0]!,
      generation: 3, accessRevision: 10 }] };
  const reverse = await state.content.prepareRepair!({ ...plan, direction: "protected_to_ordinary",
    operationId: "repair:reverse", expectedContentRevision: 1, targetAuthorities: [advanced],
    repairInput: { ...current, projection: { ...current.projection, readAuthorities: [advanced] } } });
  if (reverse.direction !== "protected_to_ordinary") throw new Error("Expected reverse repair");
  expect(reverse.payload).toEqual(plan.repairInput);
  expect("encryptedPayloadBytesBase64url" in reverse).toBe(false);
  const reverseProof = decodeHumanMemoryRepairAttestationV1(decodeBase64url(reverse.signedRepairAttestationBytesBase64url));
  expect(reverseProof.namespaces[0]?.namespaceKeyGeneration).toBe(2);
  expect(reverseProof.currentAuthorityEntries[0]?.keyGeneration).toBe(3);
});

test("repair rejects Full mode and stale coordinates before acquiring Namespace keys", async () => {
  const state = await setup();
  const plan = repairPlan(state.now);
  expect(await captureError(() => state.content.prepareRepair!({ ...plan,
    mode: "encrypted_only" as never }))).toBeInstanceOf(Error);
  expect(await captureError(() => state.content.prepareRepair!({ ...plan,
    targetContentRevision: 2 }))).toBeInstanceOf(Error);
  expect(state.requestedAuthorities).toHaveLength(0);
});

test("device compares both authored fields without displaying or choosing the ordinary sibling", async () => {
  const state = await setup();
  const plan = repairPlan(state.now);
  const prepared = await state.content.prepareRepair!(plan);
  if (prepared.direction !== "ordinary_to_protected") throw new Error("Expected ciphertext");
  const current = dtoFromCreate({ ...prepared, cryptoObjectId: plan.cryptoObjectId }, state.signing.publicKey);
  const comparison = (payload: typeof plan.repairInput) => ({ algorithm: "sha256-memory-payload-v1" as const,
    digestBase64url: Buffer.from(sha256(encodeMemoryPayloadV1(payload))).toString("base64url") });
  for (const sibling of [{ ...plan.repairInput, type: "changed type" },
    { ...plan.repairInput, content: "changed content" }]) {
    const error = await captureError(() => state.content.openExact({ ...current, shadowComparison: comparison(sibling) }));
    expect(error).toBeInstanceOf(AuthorizedHumanMemoryUnavailableError);
    expect(error).toMatchObject({ reason: "integrity_failure" });
    const editError = await captureError(() => state.content.prepareUpdate({
      current: { ...current, shadowComparison: comparison(sibling) },
      intent: { payload: { formatVersion: 1, type: "fact", content: "An edit must not erase mismatch evidence" },
        requestedProvider: "openai", requestedModel: "text-embedding-3-small" },
    }));
    expect(editError).toBeInstanceOf(AuthorizedHumanMemoryUnavailableError);
    expect(editError).toMatchObject({ reason: "integrity_failure" });
  }
  const opened = await state.content.openExact({ ...current, shadowComparison: comparison(plan.repairInput) });
  try { expect(decodeMemoryPayloadV1(opened)).toEqual(plan.repairInput); }
  finally { opened.fill(0); }

  const withFallbackSibling = await state.content.openExact({
    ...current,
    shadowComparison: comparison(plan.repairInput),
    ordinaryFallback: { policyRevision: 1, payload: {
      formatVersion: 1, type: "fallback", content: "must not replace ciphertext",
    } },
  });
  try { expect(decodeMemoryPayloadV1(withFallbackSibling)).toEqual(plan.repairInput); }
  finally { withFallbackSibling.fill(0); }
});

test("device signs the server-reserved repair revision without changing the original source", async () => {
  const state = await setup();
  const plan = { ...repairPlan(state.now), targetContentRevision: 3,
    cryptoObjectId: deriveMemoryCryptoObjectIdV1({ memoryId: MEMORY_ID, contentRevision: 3 }) };
  const prepared = await state.content.prepareRepair!(plan);
  const proof = decodeHumanMemoryRepairAttestationV1(decodeBase64url(prepared.signedRepairAttestationBytesBase64url));
  expect(proof.expectedContentRevision).toBe(0);
  expect(proof.targetContentRevision).toBe(3);
  expect(proof.cryptoObjectId).toBe(plan.cryptoObjectId);
});

async function setup(options: Readonly<{
  admittedDeviceId?: string;
  lockAfterSetup?: boolean;
  profileTerminalStatus?: "unsupported" | "corrupt" | "storage_lost";
  anchorRequiresAvailableProfile?: boolean;
  admissionRequiresReleasedProfileLease?: boolean;
}> = {}) {
  const now = 1_800_000_000_000;
  const random = seededRng(0x248);
  const crypto = new LatticeCrypto({ bytes: random }, { now: () => now });
  const signing = crypto.generateSigningKeyPair();
  const encryption = await crypto.generateEncryptionKeyPair();
  const namespaceKey = new Uint8Array(32).fill(0x48);
  const profile: OpenedClientDeviceProfileV2 = Object.freeze({
    formatVersion: 2,
    deviceId: COORDINATES.deviceId,
    signingPublicKey: signing.publicKey,
    signingPrivateKey: signing.privateKey,
    encryptionPublicKey: encryption.publicKey,
    encryptionPrivateKey: encryption.privateKey,
    trustedDeviceRevision: 7,
    trustedHostAuthorizationRevision: 11,
    deliveryHighWatermark: 4,
    keyringDeliveries: Object.freeze([Object.freeze({
      deliverySequence: 4,
      operationId: "delivery:4",
      namespaceId: NAMESPACE_ID,
      keyClass: "ai" as const,
      domainId: "domain:1",
      domainEpoch: 3,
      accessRevision: 9,
      bindingHash: new Uint8Array(32).fill(0x19),
      currentGeneration: 2,
      generations: Object.freeze([
        Object.freeze({ generation: 1, key: new Uint8Array(32).fill(0x47) }),
        Object.freeze({ generation: 2, key: namespaceKey }),
      ]),
    }), Object.freeze({
      deliverySequence: 5,
      operationId: "delivery:5",
      namespaceId: NAMESPACE_B,
      keyClass: "ai" as const,
      domainId: "domain:2",
      domainEpoch: 1,
      accessRevision: 3,
      bindingHash: new Uint8Array(32).fill(0x21),
      currentGeneration: 1,
      generations: Object.freeze([
        Object.freeze({ generation: 1, key: new Uint8Array(32).fill(0x52) }),
      ]),
    })]),
  });
  const v2Bytes = encodeClientDeviceProfileV2(profile);
  const v3 = await createClientDeviceProfileV3Candidate({
    crypto, currentProfileBytes: v2Bytes, expectedDeviceId: COORDINATES.deviceId,
  });
  const v3Bytes = encodeClientDeviceProfileV3(v3);
  const v4 = await createClientDeviceProfileV4Candidate({
    crypto, currentProfileBytes: v3Bytes, expectedDeviceId: COORDINATES.deviceId,
  });
  const profileBytes = encodeClientDeviceProfileV4(v4);
  destroyOpenedClientDeviceProfileV4(v4);
  destroyOpenedClientDeviceProfileV3(v3);
  v2Bytes.fill(0); v3Bytes.fill(0);
  const vault = new MemoryClientProfileVault();
  await vault.unlock();
  await vault.stageProfile({
    coordinates: COORDINATES,
    stageId: "stage:1",
    generation: 1,
    profileBytes,
    publicState: { clientKind: "browser", publicFingerprint: "84".repeat(32) },
  });
  await vault.activateProfile(COORDINATES, "stage:1");
  profileBytes.fill(0);
  if (options.lockAfterSetup === true) await vault.lock();
  let profileLeaseOpen = false;
  const contentVault = Object.freeze({
        availability: () => options.profileTerminalStatus === undefined
          ? vault.availability()
          : Promise.resolve({ status: options.profileTerminalStatus }),
        unlock: () => options.profileTerminalStatus === undefined
          ? vault.unlock()
          : Promise.resolve({ status: options.profileTerminalStatus }),
        lock: () => vault.lock(),
        stageProfile: (input) => vault.stageProfile(input),
        activateProfile: (coordinates, stageId) =>
          vault.activateProfile(coordinates, stageId),
        abortStagedProfile: (coordinates, stageId) =>
          vault.abortStagedProfile(coordinates, stageId),
        recoverInterruptedActivation: (coordinates, resolution) =>
          vault.recoverInterruptedActivation(coordinates, resolution),
        withOpenProfile: async (coordinates, operation) => {
          if (profileLeaseOpen) throw new Error("test profile vault reentered");
          profileLeaseOpen = true;
          try { return await vault.withOpenProfile(coordinates, operation); }
          finally { profileLeaseOpen = false; }
        },
        withOpenStagedProfile: (coordinates, stageId, operation) =>
          vault.withOpenStagedProfile(coordinates, stageId, operation),
        listPublicProfiles: () => vault.listPublicProfiles(),
        rotateWrappingMaterial: () => vault.rotateWrappingMaterial(),
        forgetProfile: (coordinates) => vault.forgetProfile(coordinates),
      } satisfies ClientProfileVault);
  let operation = 0;
  const requestedAuthorities: string[] = [];
  const ensuredAuthorities: Array<Readonly<{ sourceRoomId: string;
    namespaceId: string; keyClass?: "ai" | "human" }>> = [];
  const unavailableAuthorities = new Set<string>();
  const namespaceFailures = new Map<string, unknown>();
  const anchors = new Map<string, import("@nautilo/lattice-crypto").TrustedMinimumObjectAccessHead>();
  const contentNamespaceAuthority = {
    ensure: (request: { sourceRoomId: string; namespaceId: string;
      keyClass?: "ai" | "human" }) => {
      ensuredAuthorities.push(request);
      return Promise.resolve({ status: "ready" as const });
    },
    synchronizeRecipients: () => Promise.resolve({ status: "ready" as const }),
    withOpenedAiGenerations: () => Promise.resolve({ status: "unavailable" as const, reason: "unused" }),
    withOpenedGenerations: async <Value>(request: Parameters<NonNullable<import("../../src/client/message/namespace-authority-client.ts").NamespaceAuthorityClient["withOpenedGenerations"]>>[0], use: (entries: readonly import("../../src/client/message/namespace-authority-client.ts").OpenedNamespaceGeneration[]) => Promise<Value> | Value) => {
      const requested = request.authority.map((entry) => entry.namespaceId);
      requestedAuthorities.push(...requested);
      const failure = requested.map((entry) => namespaceFailures.get(entry))
        .find((entry) => entry !== undefined);
      if (failure instanceof Error) throw failure;
      if (requested.some((entry) => unavailableAuthorities.has(entry))) {
        return { status: "unavailable" as const, reason: "test unavailable" };
      }
      return { status: "opened" as const, value: await use(
      request.authority.flatMap((entry) => {
        const delivery = profile.keyringDeliveries.find((item) => item.namespaceId === entry.namespaceId)!;
        return entry.retainedGenerations.map((retained) => ({
          namespaceId: namespaceId(entry.namespaceId), keyClass: "ai" as const,
          accessRevision: accessRevision(retained.accessRevision),
          generation: namespaceGeneration(retained.generation),
          generationKey: delivery.generations.find((item) => item.generation === retained.generation)!.key,
          audienceFingerprint: retained.audienceFingerprint,
          headDigest: retained.headDigest,
        }));
      }),
    ) };
    },
  };
  const content = createVaultAuthorizedHumanMemoryDeviceContentPort({
    crypto,
    vault: contentVault,
    coordinates: COORDINATES,
    subjectHumanId: COORDINATES.humanActorId,
    now: () => now,
    createOperationId: () => `memory-operation:${++operation}`,
    createProfileStageId: () => `memory-profile-v4:${++operation}`,
    accessAnchors: {
      load: async (objectId) => {
        if (options.anchorRequiresAvailableProfile === true
          && (await vault.availability()).status !== "available") {
          throw new Error("test anchor profile vault is locked");
        }
        return anchors.get(objectId) ?? null;
      },
      advance: ({ expected, next }) => {
        const current = anchors.get(next.objectId) ?? null;
        if (current !== expected) return Promise.resolve(false);
        anchors.set(next.objectId, next);
        return Promise.resolve(true);
      },
    },
    resolveDeviceAdmissionStatus: () => Promise.resolve({
      ...(options.admissionRequiresReleasedProfileLease === true && profileLeaseOpen
        ? (() => { throw new Error("test admission entered under profile lease"); })()
        : {}),
      responseVersion: 1, required: true, status: "admitted",
      deviceId: options.admittedDeviceId ?? COORDINATES.deviceId,
      deviceGeneration: 1, expiresAt: now + 60_000,
    }),
    namespaceAuthority: contentNamespaceAuthority,
  });
  return {
    crypto,
    content,
    now,
    signing,
    vault,
    profile,
    anchors,
    requestedAuthorities,
    ensuredAuthorities,
    unavailableAuthorities,
    namespaceFailures,
    restartContent: () => createVaultAuthorizedHumanMemoryDeviceContentPort({
      crypto,
      vault,
      coordinates: COORDINATES,
      subjectHumanId: COORDINATES.humanActorId,
      now: () => now,
      createOperationId: () => `memory-operation:${++operation}`,
      createProfileStageId: () => `memory-profile-v4:${++operation}`,
      accessAnchors: {
        load: (objectId) => Promise.resolve(anchors.get(objectId) ?? null),
        advance: ({ expected, next }) => {
          const current = anchors.get(next.objectId) ?? null;
          if (current !== expected) return Promise.resolve(false);
          anchors.set(next.objectId, next);
          return Promise.resolve(true);
        },
      },
      resolveDeviceAdmissionStatus: () => Promise.resolve({
        responseVersion: 1, required: true, status: "admitted",
        deviceId: options.admittedDeviceId ?? COORDINATES.deviceId,
        deviceGeneration: 1, expiresAt: now + 60_000,
      }),
      namespaceAuthority: contentNamespaceAuthority,
    }),
  };
}

function dtoFromCreate(
  prepared: Pick<Awaited<ReturnType<
    Awaited<ReturnType<typeof setup>>["content"]["prepareCreate"]
  >>, "memoryId" | "cryptoObjectId" | "encryptedPayloadBytesBase64url" | "accessManifestBytesBase64url" | "namespaceEnvelopes">,
  signingPublicKey: Uint8Array,
) {
  const manifest = decodeObjectAccessManifestV5(
    decodeBase64url(prepared.accessManifestBytesBase64url),
  );
  if (manifest.signer.kind !== "human_device") throw new TypeError("expected Human signer");
  return Object.freeze({
    dtoVersion: 1 as const,
    projection: Object.freeze({
      memoryId: prepared.memoryId,
      contentRevision: 1,
      cryptoAccessRevision: 0,
      importance: 0.5,
      tier: 2,
      createdAt: "2027-01-15T08:00:00.000Z",
      updatedAt: "2027-01-15T08:00:00.000Z",
      namespaceIds: [NAMESPACE_ID],
      requiredNamespaceIds: [NAMESPACE_ID],
      readAuthorities: [AUTHORITY_A],
      mutationAuthorities: [AUTHORITY_A],
    }),
    protectedPayload: Object.freeze({
      status: "encrypted" as const,
      cryptoObjectId: prepared.cryptoObjectId,
      payloadVersion: 1 as const,
      encryptedPayloadBytesBase64url:
        prepared.encryptedPayloadBytesBase64url,
      accessManifestBytesBase64url: prepared.accessManifestBytesBase64url,
      accessSignerEvidence: [{
        kind: "human_device" as const,
        subjectHumanId: manifest.signer.subjectHumanId,
        committerDeviceId: manifest.signer.committerDeviceId,
        hostAuthorizationRevision: manifest.hostAuthorizationRevision,
        signingPublicKeyBase64url: Buffer.from(signingPublicKey).toString("base64url"),
      }],
      namespaceEnvelopes: prepared.namespaceEnvelopes,
    }),
  });
}

async function revisionThreeFixture() {
  const state = await setup();
  const created = await state.content.prepareCreate({
    plan: { dtoVersion: 1, memoryId: MEMORY_ID, operationId: "chain:create",
      expectedContentRevision: 0, nextContentRevision: 1,
      productAuthority: { mode: "namespace" }, requiredNamespaceIds: [NAMESPACE_ID],
      targetAuthorities: [AUTHORITY_A],
      deadlineAt: state.now + 30_000 },
    intent: { payload: { formatVersion: 1, type: "fact", content: "chain" },
      requestedProvider: "openai", requestedModel: "text-embedding-3-small" },
  });
  const genesisBytes = decodeBase64url(created.accessManifestBytesBase64url);
  const envelopeABytes = decodeBase64url(
    created.namespaceEnvelopes[0]!.envelopeBytesBase64url,
  );
  const envelopeA = decodeNamespaceObjectEnvelopeV2(envelopeABytes);
  const dek = openObjectDekForNamespace(
    state.crypto,
    state.profile.keyringDeliveries[0]!.generations[1]!.key,
    envelopeA,
  );
  if (dek === null) throw new Error("test DEK unavailable");
  const envelopeBBytes = encodeNamespaceObjectEnvelopeV2(
    wrapObjectDekForNamespace(
      state.crypto,
      state.profile.keyringDeliveries[1]!.generations[0]!.key,
      {
        objectId: objectId(created.cryptoObjectId),
        namespaceId: namespaceId(NAMESPACE_B),
        keyClass: "ai",
        keyGeneration: namespaceGeneration(1),
        bindingRevisionAtWrap: accessRevision(3),
      },
      dek,
    ),
  );
  dek.fill(0);
  const peerSigning = state.crypto.generateSigningKeyPair();
  const revise = (input: Readonly<{
    currentManifestBytes: Uint8Array;
    currentEnvelopeBytes: readonly Uint8Array[];
    anchorManifestBytes: Uint8Array;
    operation: { type: "attach" | "detach"; envelopeBytes: Uint8Array };
    hostRevision: number;
    signer?: Readonly<{
      subjectHumanId: string;
      deviceId: string;
      privateKey: Uint8Array;
    }>;
  }>) => {
    const current = decodeObjectAccessManifestV5(input.currentManifestBytes);
    const envelopeBytes = input.operation.type === "attach"
      ? [...input.currentEnvelopeBytes, input.operation.envelopeBytes]
      : input.currentEnvelopeBytes.filter((bytes) =>
        !bytes.every((byte, index) =>
          byte === input.operation.envelopeBytes[index]
        )
      );
    const created = createCommonHumanObjectAccessManifest(state.crypto, {
      objectId: current.objectId,
      payloadHash: current.payloadHash,
      accessRevision: accessRevision(current.accessRevision + 1),
      previousManifestHash: state.crypto.hash(input.currentManifestBytes),
      envelopeHashes: envelopeBytes.map((bytes) => state.crypto.hash(bytes)),
      signer: {
        kind: "human_device",
        subjectHumanId: humanId(input.signer?.subjectHumanId ?? COORDINATES.humanActorId),
        committerDeviceId: cryptoDeviceId(
          input.signer?.deviceId ?? COORDINATES.deviceId,
        ),
      },
      signerAuthorizationHash: null,
      hostAuthorizationRevision: authorizationRevision(input.hostRevision),
    }, input.signer?.privateKey ?? state.signing.privateKey);
    return Object.freeze({
      manifest: created.manifest,
      manifestBytes: created.bytes,
      manifestHash: created.hash,
      envelopeBytes: Object.freeze(envelopeBytes),
    });
  };
  const revisionOne = revise({
    currentManifestBytes: genesisBytes,
    currentEnvelopeBytes: [envelopeABytes],
    anchorManifestBytes: genesisBytes,
    operation: { type: "attach", envelopeBytes: envelopeBBytes },
    hostRevision: 12,
  });
  const revisionTwo = revise({
    currentManifestBytes: revisionOne.manifestBytes,
    currentEnvelopeBytes: revisionOne.envelopeBytes,
    anchorManifestBytes: revisionOne.manifestBytes,
    operation: { type: "detach", envelopeBytes: envelopeBBytes },
    hostRevision: 13,
    signer: {
      subjectHumanId: "human:peer",
      deviceId: "device:peer",
      privateKey: peerSigning.privateKey,
    },
  });
  const revisionThree = revise({
    currentManifestBytes: revisionTwo.manifestBytes,
    currentEnvelopeBytes: revisionTwo.envelopeBytes,
    anchorManifestBytes: revisionTwo.manifestBytes,
    operation: { type: "attach", envelopeBytes: envelopeBBytes },
    hostRevision: 14,
  });
  const namespaceEnvelopes = revisionThree.envelopeBytes.map((bytes) => ({
    namespaceId: decodeNamespaceObjectEnvelopeV2(bytes).context.namespaceId,
    envelopeBytesBase64url: Buffer.from(bytes).toString("base64url"),
  })).sort((left, right) => left.namespaceId.localeCompare(right.namespaceId));
  const dto = {
    ...dtoFromCreate(created, state.signing.publicKey),
    projection: {
      ...dtoFromCreate(created, state.signing.publicKey).projection,
      cryptoAccessRevision: 3,
      namespaceIds: [NAMESPACE_ID, NAMESPACE_B],
      requiredNamespaceIds: [NAMESPACE_ID, NAMESPACE_B],
      readAuthorities: [AUTHORITY_A],
      mutationAuthorities: [AUTHORITY_A, AUTHORITY_B],
    },
    protectedPayload: {
      ...dtoFromCreate(created, state.signing.publicKey).protectedPayload,
      accessManifestBytesBase64url: Buffer.from(revisionThree.manifestBytes)
        .toString("base64url"),
      accessManifestProofBytesBase64url: [
        genesisBytes,
        revisionOne.manifestBytes,
        revisionTwo.manifestBytes,
      ].map((bytes) => Buffer.from(bytes).toString("base64url")),
      accessSignerEvidence: [
        genesisBytes,
        revisionOne.manifestBytes,
        revisionTwo.manifestBytes,
        revisionThree.manifestBytes,
      ].map((bytes) => {
        const manifest = decodeObjectAccessManifestV5(bytes);
        if (manifest.signer.kind !== "human_device") {
          throw new TypeError("expected Human signer");
        }
        return {
          kind: "human_device" as const,
          subjectHumanId: manifest.signer.subjectHumanId,
          committerDeviceId: manifest.signer.committerDeviceId,
          hostAuthorizationRevision: manifest.hostAuthorizationRevision,
          signingPublicKeyBase64url: Buffer.from(
            manifest.signer.subjectHumanId === "human:peer"
              ? peerSigning.publicKey
              : state.signing.publicKey,
          ).toString("base64url"),
        };
      }),
      namespaceEnvelopes,
    },
  };
  return { ...state, created, dto, genesisBytes, revisionOne, revisionTwo,
    revisionThree };
}

describe("vault-backed Human Memory device content", () => {
  test("signs an ordinary create intent with the admitted device and no Namespace keys", async () => {
    const state = await setup();
    state.unavailableAuthorities.add(NAMESPACE_ID);
    const prepared = await state.content.prepareOrdinaryFallbackCreate!({
      plan: { dtoVersion: 1, status: "ordinary_fallback_ready",
        reason: "target_encryption_not_ready", memoryId: MEMORY_ID,
        operationId: "memory-create:fallback", expectedContentRevision: 0,
        nextContentRevision: 1, expectedCryptoAccessRevision: 0,
        productAuthority: { mode: "namespace" },
        requiredNamespaceIds: [NAMESPACE_ID],
        ordinaryFallbackAuthorization: { policyRevision: 9 },
        issuedAt: state.now, deadlineAt: state.now + 30_000 },
      intent: { payload: { formatVersion: 1, type: "preference",
        content: "ordinary signed value" }, importance: 0.7,
        requestedProvider: "openai", requestedModel: "text-embedding-3-small" },
    });
    expect(state.requestedAuthorities).toEqual([]);
    const bytes = decodeBase64url(
      prepared.signedOrdinaryFallbackRequestBytesBase64url,
    );
    try {
      const authenticated = verifyHumanMemoryOrdinaryFallbackRequestV1(
        state.crypto, { requestBytes: bytes,
          signingPublicKey: state.signing.publicKey, now: state.now },
      );
      expect(authenticated.request).toMatchObject({
        purpose: "memory.ordinary_fallback.create", policyRevision: 9,
        content: "ordinary signed value", importance: 0.7,
        expectedContentRevision: 0, nextContentRevision: 1,
      });
    } finally { bytes.fill(0); }
    expect(await captureError(() => state.content.prepareCreate({
      plan: { dtoVersion: 1, memoryId: MEMORY_ID,
        operationId: "memory-create:protected-unavailable",
        expectedContentRevision: 0, nextContentRevision: 1,
        productAuthority: { mode: "namespace" },
        requiredNamespaceIds: [NAMESPACE_ID], targetAuthorities: [AUTHORITY_A],
        ordinaryFallbackAuthorization: { policyRevision: 9 },
        issuedAt: state.now, deadlineAt: state.now + 30_000 },
      intent: { payload: { formatVersion: 1, type: "preference",
        content: "ordinary signed value" }, requestedProvider: "openai",
        requestedModel: "text-embedding-3-small" },
    }))).toEqual(new AuthorizedHumanMemoryUnavailableError(
      "target_encryption_not_ready",
    ));
  });

  test("requires the admitted V4 profile authority path", async () => {
    const { content, now } = await setup();
    const created = await content.prepareCreate({
      plan: { dtoVersion: 1, memoryId: MEMORY_ID, operationId: "v3:create",
        expectedContentRevision: 0, nextContentRevision: 1,
        productAuthority: { mode: "namespace" }, requiredNamespaceIds: [NAMESPACE_ID],
        targetAuthorities: [AUTHORITY_A],
        deadlineAt: now + 30_000 },
      intent: { payload: { formatVersion: 1, type: "fact", content: "v3" },
        requestedProvider: "openai", requestedModel: "text-embedding-3-small" },
    });
    expect(created.namespaceEnvelopes.map(({ namespaceId }) => namespaceId))
      .toEqual([NAMESPACE_ID]);
  });

  test("unlocks the profile vault on first Human Memory use", async () => {
    const { content, now, vault } = await setup({ lockAfterSetup: true });
    expect(await vault.availability()).toEqual({ status: "locked" });

    const prepared = await content.prepareCreate({
      plan: { dtoVersion: 1, memoryId: MEMORY_ID, operationId: "locked:create",
        expectedContentRevision: 0, nextContentRevision: 1,
        productAuthority: { mode: "namespace" }, requiredNamespaceIds: [NAMESPACE_ID],
        targetAuthorities: [AUTHORITY_A], deadlineAt: now + 30_000 },
      intent: { payload: { formatVersion: 1, type: "fact", content: "first use" },
        requestedProvider: "openai", requestedModel: "text-embedding-3-small" },
    });

    expect(prepared.memoryId).toBe(MEMORY_ID);
    expect(await vault.availability()).toEqual({ status: "available" });
  });

  test("unlocks before loading the persistent rollback anchor", async () => {
    const state = await setup({ anchorRequiresAvailableProfile: true });
    const created = await state.content.prepareCreate({
      plan: { dtoVersion: 1, memoryId: MEMORY_ID, operationId: "anchor:create",
        expectedContentRevision: 0, nextContentRevision: 1,
        productAuthority: { mode: "namespace" }, requiredNamespaceIds: [NAMESPACE_ID],
        targetAuthorities: [AUTHORITY_A], deadlineAt: state.now + 30_000 },
      intent: { payload: { formatVersion: 1, type: "fact", content: "anchor" },
        requestedProvider: "openai", requestedModel: "text-embedding-3-small" },
    });
    const dto = dtoFromCreate(created, state.signing.publicKey);
    await state.vault.lock();

    const opened = await state.content.openExact(dto);
    try { expect(decodeMemoryPayloadV1(opened).content).toBe("anchor"); }
    finally { opened.fill(0); }
  });

  test("releases the profile lease before admission and Namespace work", async () => {
    const { content, now } = await setup({
      admissionRequiresReleasedProfileLease: true,
    });
    const prepared = await content.prepareCreate({
      plan: { dtoVersion: 1, memoryId: MEMORY_ID, operationId: "lease:create",
        expectedContentRevision: 0, nextContentRevision: 1,
        productAuthority: { mode: "namespace" }, requiredNamespaceIds: [NAMESPACE_ID],
        targetAuthorities: [AUTHORITY_A], deadlineAt: now + 30_000 },
      intent: { payload: { formatVersion: 1, type: "fact", content: "lease" },
        requestedProvider: "openai", requestedModel: "text-embedding-3-small" },
    });
    expect(prepared.memoryId).toBe(MEMORY_ID);
  });

  test("reports terminal profile custody status as typed Human Memory unavailability", async () => {
    const { content, now } = await setup({ profileTerminalStatus: "storage_lost" });
    const error = await captureError(() => content.prepareCreate({
      plan: { dtoVersion: 1, memoryId: MEMORY_ID, operationId: "lost:create",
        expectedContentRevision: 0, nextContentRevision: 1,
        productAuthority: { mode: "namespace" }, requiredNamespaceIds: [NAMESPACE_ID],
        targetAuthorities: [AUTHORITY_A], deadlineAt: now + 30_000 },
      intent: { payload: { formatVersion: 1, type: "fact", content: "unavailable" },
        requestedProvider: "openai", requestedModel: "text-embedding-3-small" },
    }));

    expect(error).toEqual(new AuthorizedHumanMemoryUnavailableError(
      "lost_key_material",
    ));
  });

  test("rejects authority opened for a different admitted device", async () => {
    const { content, now } = await setup({ admittedDeviceId: "device:other" });
    expect(String(await captureError(() => content.prepareCreate({
      plan: { dtoVersion: 1, memoryId: MEMORY_ID, operationId: "wrong-device",
        expectedContentRevision: 0, nextContentRevision: 1,
        productAuthority: { mode: "namespace" }, requiredNamespaceIds: [NAMESPACE_ID],
        targetAuthorities: [AUTHORITY_A], deadlineAt: now + 30_000 },
      intent: { payload: { formatVersion: 1, type: "fact", content: "secret" },
        requestedProvider: "openai", requestedModel: "text-embedding-3-small" },
    })))).toContain("device admission is unavailable");
  });

  test("prepares, signs, and opens one exact Human Namespace create", async () => {
    const { content, crypto, signing, now } = await setup();
    const prepared = await content.prepareCreate({
      plan: {
        dtoVersion: 1,
        memoryId: MEMORY_ID,
        operationId: "memory-create:1",
        expectedContentRevision: 0,
        nextContentRevision: 1,
        productAuthority: { mode: "namespace" },
        requiredNamespaceIds: [NAMESPACE_ID],
        targetAuthorities: [AUTHORITY_A],
        deadlineAt: now + 60_000,
      },
      intent: {
        payload: {
          formatVersion: 1,
          type: "preference",
          content: "Human keys stay local",
        },
        importance: 0.65,
        requestedProvider: "openai",
        requestedModel: "text-embedding-3-small",
      },
    });
    const signedBytes = decodeBase64url(
      prepared.signedContentEmbeddingRequestBytesBase64url,
    );
    try {
      expect(verifyHumanMemoryContentEmbeddingRequest(crypto, {
        requestBytes: signedBytes,
        committerSigningPublicKey: signing.publicKey,
        now: unixTimestamp(now),
      })).toMatchObject({
        requestId: "memory-create:1",
        memoryId: MEMORY_ID,
        expectedProductRevision: 0,
        nextProductRevision: 1,
        type: "preference",
        content: "Human keys stay local",
        importance: 0.65,
      });
    } finally {
      signedBytes.fill(0);
    }
    const opened = await content.openExact(dtoFromCreate(prepared, signing.publicKey));
    try {
      expect(decodeMemoryPayloadV1(opened)).toEqual({
        formatVersion: 1,
        type: "preference",
        content: "Human keys stay local",
      });
    } finally {
      opened.fill(0);
    }
  });

  test("opens foreground Agent content only with exact accepted-execution evidence", async () => {
    const state = await setup();
    const prepared = await state.content.prepareCreate({
      plan: {
        dtoVersion: 1,
        memoryId: MEMORY_ID,
        operationId: "memory-create:agent-read",
        expectedContentRevision: 0,
        nextContentRevision: 1,
        productAuthority: { mode: "namespace" },
        requiredNamespaceIds: [NAMESPACE_ID],
        targetAuthorities: [AUTHORITY_A],
        deadlineAt: state.now + 60_000,
      },
      intent: {
        payload: {
          formatVersion: 1,
          type: "fact",
          content: "Agent and Human share one protocol",
        },
        requestedProvider: "openai",
        requestedModel: "text-embedding-3-small",
      },
    });
    const genesisBytes = decodeBase64url(
      prepared.accessManifestBytesBase64url,
    );
    const genesis = decodeObjectAccessManifestV5(genesisBytes);
    const initialized = await prepareAgentRuntimeInitialization({
      crypto: state.crypto,
      operationId: "runtime:agent-read",
      agentId: "agent-memory-reader",
      authorizationRevision: authorizationRevision(11),
      configObjects: [{
        objectId: objectId("config-memory-reader"),
        configRevision: authorizationRevision(1),
        plaintextDek: new Uint8Array(32).fill(0x66),
      }],
      domains: [],
      resolveCurrentDomainCommitterAuthority: () => null,
      manager: {
        managerHumanId: humanId(COORDINATES.humanActorId),
        managerAuthorizationRevision: authorizationRevision(11),
        managerDeviceId: cryptoDeviceId(COORDINATES.deviceId),
      },
      managerSigningPrivateKey: state.signing.privateKey,
      resolveCurrentManagerAuthority: () => state.signing.publicKey,
    });
    const agentHead = createCommonAgentObjectAccessManifest(state.crypto, {
      objectId: genesis.objectId,
      payloadHash: genesis.payloadHash,
      accessRevision: accessRevision(1),
      previousManifestHash: state.crypto.hash(genesisBytes),
      envelopeHashes: genesis.envelopeHashes,
      signer: deriveAgentRuntimeObjectSignerPublic(
        state.crypto,
        initialized.runtime,
      ).principal,
      signerAuthorizationHash: null,
      hostAuthorizationRevision: authorizationRevision(11),
    }, initialized.runtime);
    const publicationBytes = encodeAgentRuntimeSignerPublicationV1(
      initialized.signerPublication,
    );
    const acceptedDigest = new Uint8Array(32).fill(0x5a);
    const foregroundPlanBytes = encodeLiveShadowMessagePlanV4({
      formatVersion: 4,
      purpose: "message.live_shadow_plan",
      operationId: "memory-agent-accepted-execution",
      policyRevision: 1,
      sessionId: MEMORY_ID,
      roomId: "81000000-0000-4000-8000-000000000030",
      humanMessageId: 1,
      revision: 0,
      createdAt: unixTimestamp(state.now),
      subjectHumanId: humanId(COORDINATES.humanActorId),
      committerDeviceId: cryptoDeviceId(COORDINATES.deviceId),
      committerDeviceSigningKeyGeneration: 1,
      hostAuthorizationRevision: authorizationRevision(11),
      recipientAgentId: initialized.runtime.agentId,
      agentAuthorizationRevision: authorizationRevision(11),
      agentRuntimeGeneration: initialized.runtime.generation,
      agentSignerKeyId: agentHead.manifest.signer.kind === "agent_runtime"
        ? agentHead.manifest.signer.signerKeyId : "invalid",
      agentSignerPublicKey: deriveAgentRuntimeObjectSignerPublic(
        state.crypto,
        initialized.runtime,
      ).publicKey,
      namespaceId: namespaceId(NAMESPACE_ID),
      namespaceAccessRevision: accessRevision(9),
      namespaceKeyGeneration: namespaceGeneration(0),
      namespaceHeadDigest: new Uint8Array(32).fill(1),
      namespacePublicationDigest: new Uint8Array(32).fill(2),
      namespacePublicationSetDigest: new Uint8Array(32).fill(3),
      namespaceAudienceFingerprint: new Uint8Array(32).fill(4),
      grantDomainId: NAMESPACE_B,
      grantDomainParticipantDigest: new Uint8Array(32).fill(5),
      grantDomainKeyGeneration: 1,
      grantDomainHeadDigest: new Uint8Array(32).fill(6),
      grantDomainPublicationDigest: new Uint8Array(32).fill(7),
      grantDomainAuthorizationRevision: authorizationRevision(1),
      namespaceBundleGrantDomainAuthorizationRevision: authorizationRevision(1),
      namespaceBundleRevision: 1,
      namespaceBundleDigest: new Uint8Array(32).fill(8),
      authorization: {
        disposition: "authorization_reusable",
        sessionReference: "memory-agent-authorization",
        authorizationDigest: acceptedDigest,
      },
      attemptCoordinate: "memory-agent-attempt",
      issuedAt: unixTimestamp(state.now),
      deadlineAt: unixTimestamp(state.now + 30_000),
    });
    const foregroundEvidence = {
      kind: "foreground_agent_accepted_execution" as const,
      planBytesBase64url: Buffer.from(foregroundPlanBytes).toString("base64url"),
      planDigestBase64url: Buffer.from(state.crypto.hash(foregroundPlanBytes))
        .toString("base64url"),
    };
    const base = dtoFromCreate(prepared, state.signing.publicKey);
    const dto = {
      ...base,
      projection: { ...base.projection, cryptoAccessRevision: 1 },
      protectedPayload: {
        ...base.protectedPayload,
        accessManifestBytesBase64url: Buffer.from(agentHead.bytes)
          .toString("base64url"),
        accessManifestProofBytesBase64url: [
          Buffer.from(genesisBytes).toString("base64url"),
        ],
        accessSignerEvidence: [
          ...base.protectedPayload.accessSignerEvidence,
          foregroundEvidence,
        ],
      },
    };
    const opened = await state.content.openExact(dto);
    try {
      expect(decodeMemoryPayloadV1(opened).content)
        .toBe("Agent and Human share one protocol");
      expect((await state.vault.listPublicProfiles())[0]?.generation).toBe(1);
      await state.vault.withOpenProfile(COORDINATES, async (profileBytes) => {
        const profile = await authenticateClientDeviceProfileV4({
          crypto: state.crypto,
          profileBytes,
          expectedDeviceId: COORDINATES.deviceId,
        });
        expect(profile.signerEvidence).toHaveLength(0);
        destroyOpenedClientDeviceProfileV4(profile);
      });
      const restartedContent = state.restartContent();
      const restarted = await restartedContent.openExact(dto);
      try {
        expect(decodeMemoryPayloadV1(restarted).content)
          .toBe("Agent and Human share one protocol");
      } finally {
        restarted.fill(0);
      }
      const invalidDigest = Buffer.from(
        foregroundEvidence.planDigestBase64url,
        "base64url",
      );
      invalidDigest[0] = invalidDigest[0]! ^ 1;
      expect(await state.content.openExact({
        ...dto,
        protectedPayload: {
          ...dto.protectedPayload,
          accessSignerEvidence: [
            ...base.protectedPayload.accessSignerEvidence,
            {
            ...foregroundEvidence,
            planDigestBase64url: invalidDigest.toString("base64url"),
            },
          ],
        },
      }).catch((error: unknown) => error)).toEqual(
        new AuthorizedHumanMemoryUnavailableError("integrity_failure"),
      );
      const decodedForegroundPlan = decodeLiveShadowMessagePlanV4(
        foregroundPlanBytes,
      );
      const wrongTupleBytes = encodeLiveShadowMessagePlanV4({
        ...decodedForegroundPlan,
        agentSignerKeyId: "substituted-signer-key",
      });
      expect(await state.content.openExact({
        ...dto,
        protectedPayload: {
          ...dto.protectedPayload,
          accessSignerEvidence: [
            ...base.protectedPayload.accessSignerEvidence,
            {
              kind: "foreground_agent_accepted_execution",
              planBytesBase64url: Buffer.from(wrongTupleBytes)
                .toString("base64url"),
              planDigestBase64url: Buffer.from(state.crypto.hash(wrongTupleBytes))
                .toString("base64url"),
            },
          ],
        },
      }).catch((error: unknown) => error)).toEqual(
        new AuthorizedHumanMemoryUnavailableError("integrity_failure"),
      );
      expect(await state.content.openExact({
        ...dto,
        protectedPayload: {
          ...dto.protectedPayload,
          accessSignerEvidence: base.protectedPayload.accessSignerEvidence,
        },
      }).catch((error: unknown) => error)).toBeInstanceOf(Error);
      const peerManager = state.crypto.generateSigningKeyPair();
      const peerInitialized = await prepareAgentRuntimeInitialization({
        crypto: state.crypto,
        operationId: "runtime:agent-read-peer-manager",
        agentId: "agent-memory-reader-peer-manager",
        authorizationRevision: authorizationRevision(12),
        configObjects: [{
          objectId: objectId("config-memory-reader-peer-manager"),
          configRevision: authorizationRevision(1),
          plaintextDek: new Uint8Array(32).fill(0x67),
        }],
        domains: [],
        resolveCurrentDomainCommitterAuthority: () => null,
        manager: {
          managerHumanId: humanId("human:peer-manager"),
          managerAuthorizationRevision: authorizationRevision(12),
          managerDeviceId: cryptoDeviceId("device:peer-manager"),
        },
        managerSigningPrivateKey: peerManager.privateKey,
        resolveCurrentManagerAuthority: () => peerManager.publicKey,
      });
      const peerAgentHead = createCommonAgentObjectAccessManifest(state.crypto, {
        objectId: genesis.objectId,
        payloadHash: genesis.payloadHash,
        accessRevision: accessRevision(1),
        previousManifestHash: state.crypto.hash(genesisBytes),
        envelopeHashes: genesis.envelopeHashes,
        signer: deriveAgentRuntimeObjectSignerPublic(
          state.crypto,
          peerInitialized.runtime,
        ).principal,
        signerAuthorizationHash: null,
        hostAuthorizationRevision: authorizationRevision(12),
      }, peerInitialized.runtime);
      const peerPublication = encodeAgentRuntimeSignerPublicationV1(
        peerInitialized.signerPublication,
      );
      expect(await state.content.openExact({
        ...dto,
        protectedPayload: {
          ...dto.protectedPayload,
          accessManifestBytesBase64url: Buffer.from(peerAgentHead.bytes)
            .toString("base64url"),
          accessSignerEvidence: [
            ...base.protectedPayload.accessSignerEvidence,
            { kind: "agent_runtime_publication",
              evidenceBytesBase64url: Buffer.from(peerPublication)
                .toString("base64url") },
          ],
        },
      }).catch((error: unknown) => error)).toHaveProperty("message", expect.stringContaining("issuer is not trusted"));
      peerManager.privateKey.fill(0);
      peerPublication.fill(0);
      peerAgentHead.bytes.fill(0);
      wrongTupleBytes.fill(0);
      const humanRevision = await restartedContent.prepareUpdate({
        current: dto,
        intent: {
          payload: {
            formatVersion: 1,
            type: "fact",
            content: "Human continues the Agent revision",
          },
          requestedProvider: "openai",
          requestedModel: "text-embedding-3-small",
        },
      });
      const humanManifestBytes = decodeBase64url(
        humanRevision.accessManifestBytesBase64url,
      );
      try {
        const humanManifest = decodeObjectAccessManifestV5(humanManifestBytes);
        expect(Number(humanManifest.accessRevision)).toBe(0);
        expect(humanManifest.signer.kind).toBe("human_device");
      } finally {
        humanManifestBytes.fill(0);
      }
    } finally {
      opened.fill(0);
      publicationBytes.fill(0);
      genesisBytes.fill(0);
    }
  });

  test("prepares an authenticated content replacement", async () => {
    const { content, crypto, now, signing } = await setup();
    const created = await content.prepareCreate({
      plan: {
        dtoVersion: 1,
        memoryId: MEMORY_ID,
        operationId: "memory-create:1",
        expectedContentRevision: 0,
        nextContentRevision: 1,
        productAuthority: { mode: "namespace" },
        requiredNamespaceIds: [NAMESPACE_ID],
        targetAuthorities: [AUTHORITY_A],
        deadlineAt: 1_800_000_060_000,
      },
      intent: {
        payload: { formatVersion: 1, type: "fact", content: "old" },
        requestedProvider: "openrouter",
        requestedModel: "openai/text-embedding-3-small",
      },
    });
    const current = dtoFromCreate(created, signing.publicKey);
    (await content.openExact(current)).fill(0);
    const updated = await content.prepareUpdate({
      current,
      intent: {
        payload: { formatVersion: 1, type: "fact", content: "new" },
        requestedProvider: "openai",
        requestedModel: "text-embedding-3-small",
      },
    });
    expect(updated).toMatchObject({
      expectedContentRevision: 1,
      nextContentRevision: 2,
      requiredNamespaceIds: [NAMESPACE_ID],
    });
    const authenticated = await authenticatePreparedHumanMemoryUpdate({
      crypto, expectedHumanId: COORDINATES.humanActorId, memoryId: MEMORY_ID,
      prepared: updated, now,
      resolveHistoricalDeviceAuthority: (authority) => Promise.resolve({
        ...authority, committerSigningPublicKey: signing.publicKey.slice(),
      }),
    });
    expect(authenticated.authored.content).toBe("new");
  });

  test("requires exact server-derived Human signer evidence", async () => {
    const { content, crypto, now, signing, vault } = await setup();
    const prepared = await content.prepareCreate({
      plan: { dtoVersion: 1, memoryId: MEMORY_ID, operationId: "evidence:create",
        expectedContentRevision: 0, nextContentRevision: 1,
        productAuthority: { mode: "namespace" }, requiredNamespaceIds: [NAMESPACE_ID],
        targetAuthorities: [AUTHORITY_A], deadlineAt: now + 30_000 },
      intent: { payload: { formatVersion: 1, type: "fact", content: "evidence" },
        requestedProvider: "openai", requestedModel: "text-embedding-3-small" },
    });
    const dto = dtoFromCreate(prepared, signing.publicKey);
    if (dto.protectedPayload.status !== "encrypted") throw new Error();
    const missing = {
      ...dto,
      protectedPayload: { ...dto.protectedPayload, accessSignerEvidence: [] },
    };
    const missingError = await captureError(() => content.openExact(missing));
    expect(missingError).toEqual(
      new AuthorizedHumanMemoryUnavailableError("integrity_failure"),
    );

    const exact = dto.protectedPayload.accessSignerEvidence[0]!;
    if (exact.kind !== "human_device") throw new Error();
    const wrongRevision = { ...dto, protectedPayload: {
      ...dto.protectedPayload,
      accessSignerEvidence: [{ ...exact,
        hostAuthorizationRevision: exact.hostAuthorizationRevision + 1 }],
    } };
    expect(await captureError(() => content.openExact(wrongRevision))).toEqual(
      new AuthorizedHumanMemoryUnavailableError("integrity_failure"),
    );

    const keyed = dto.protectedPayload.accessSignerEvidence[0]!;
    if (keyed.kind !== "human_device") throw new Error();
    const wrongKey = { ...dto, protectedPayload: {
      ...dto.protectedPayload,
      accessSignerEvidence: [{ ...keyed,
        signingPublicKeyBase64url: Buffer.from(new Uint8Array(32).fill(0xa5))
          .toString("base64url") }],
    } };
    expect(await captureError(() => content.openExact(wrongKey))).toEqual(
      new AuthorizedHumanMemoryUnavailableError("integrity_failure"),
    );
    const opened = await content.openExact(dto);
    opened.fill(0);
    await vault.withOpenProfile(COORDINATES, async (profileBytes) => {
      const profile = await authenticateClientDeviceProfileV4({
        crypto, profileBytes,
        expectedDeviceId: COORDINATES.deviceId,
      });
      try {
        expect(profile.signerEvidence).toHaveLength(0);
      } finally {
        destroyOpenedClientDeviceProfileV4(profile);
      }
    });
  });

  test("rejects manifest rollback and ciphertext tampering", async () => {
    const { content, now, signing } = await setup();
    const created = await content.prepareCreate({
      plan: {
        dtoVersion: 1,
        memoryId: MEMORY_ID,
        operationId: "memory-create:1",
        expectedContentRevision: 0,
        nextContentRevision: 1,
        productAuthority: { mode: "scope", scopeId: MEMORY_ID,
          originWritableNamespaceId: NAMESPACE_ID },
        requiredNamespaceIds: [NAMESPACE_ID],
        targetAuthorities: [AUTHORITY_A],
        deadlineAt: now + 60_000,
      },
      intent: {
        payload: { formatVersion: 1, type: "fact", content: "secret" },
        requestedProvider: "openai",
        requestedModel: "text-embedding-3-small",
      },
    });
    const current = dtoFromCreate(created, signing.publicKey);
    if (current.protectedPayload.status !== "encrypted") throw new Error();
    const tampered = {
      ...current,
      protectedPayload: {
        ...current.protectedPayload,
        encryptedPayloadBytesBase64url:
          `${current.protectedPayload.encryptedPayloadBytesBase64url.slice(0, -1)}A`,
      },
    };
    expect(await captureError(() => content.openExact(tampered))).toEqual(
      new AuthorizedHumanMemoryUnavailableError("integrity_failure"),
    );
    expect(await captureError(() => content.openExact({
      ...current,
      projection: { ...current.projection, cryptoAccessRevision: 1 },
    }))).toEqual(new AuthorizedHumanMemoryUnavailableError("integrity_failure"));
  });

  test("opens through the exact retained Namespace generation", async () => {
    const { content, now, signing } = await setup();
    const created = await content.prepareCreate({
      plan: {
        dtoVersion: 1,
        memoryId: MEMORY_ID,
        operationId: "memory-create:rotation",
        expectedContentRevision: 0,
        nextContentRevision: 1,
        productAuthority: { mode: "namespace" },
        requiredNamespaceIds: [NAMESPACE_ID],
        targetAuthorities: [AUTHORITY_A],
        deadlineAt: now + 30_000,
      },
      intent: {
        payload: { formatVersion: 1, type: "fact", content: "before rebind" },
        requestedProvider: "openai",
        requestedModel: "text-embedding-3-small",
      },
    });
    const opened = await content.openExact(dtoFromCreate(created, signing.publicKey));
    try {
      expect(decodeMemoryPayloadV1(opened).content).toBe("before rebind");
    } finally {
      opened.fill(0);
    }
  });

  test("preserves the complete cross-Domain audience on content edit", async () => {
    const { content, now, requestedAuthorities, signing } = await setup();
    const created = await content.prepareCreate({
      plan: {
        dtoVersion: 1,
        memoryId: MEMORY_ID,
        operationId: "memory-create:shared",
        expectedContentRevision: 0,
        nextContentRevision: 1,
        productAuthority: { mode: "namespace" },
        requiredNamespaceIds: [NAMESPACE_ID, NAMESPACE_B],
        targetAuthorities: [AUTHORITY_A, AUTHORITY_B],
        deadlineAt: now + 30_000,
      },
      intent: {
        payload: { formatVersion: 1, type: "fact", content: "shared old" },
        requestedProvider: "openai",
        requestedModel: "text-embedding-3-small",
      },
    });
    const createdDto = dtoFromCreate(created, signing.publicKey);
    const current = {
      ...createdDto,
      projection: {
        ...createdDto.projection,
        namespaceIds: [NAMESPACE_ID, NAMESPACE_B],
        requiredNamespaceIds: [NAMESPACE_ID, NAMESPACE_B],
        readAuthorities: [AUTHORITY_A],
        mutationAuthorities: [AUTHORITY_A, AUTHORITY_B],
      },
    };
    requestedAuthorities.length = 0;
    (await content.openExact(current)).fill(0);
    expect(requestedAuthorities).toEqual([NAMESPACE_ID]);
    requestedAuthorities.length = 0;
    const updated = await content.prepareUpdate({
      current,
      intent: {
        payload: { formatVersion: 1, type: "fact", content: "shared new" },
        requestedProvider: "openai",
        requestedModel: "text-embedding-3-small",
      },
    });
    expect(updated.requiredNamespaceIds).toEqual([NAMESPACE_ID, NAMESPACE_B]);
    expect(updated.namespaceEnvelopes.map(({ namespaceId }) => namespaceId))
      .toEqual([NAMESPACE_ID, NAMESPACE_B]);
    const payloadBytes = decodeBase64url(updated.encryptedPayloadBytesBase64url);
    const manifestBytes = decodeBase64url(updated.accessManifestBytesBase64url);
    const envelopeBytes = updated.namespaceEnvelopes.map(({ envelopeBytesBase64url }) =>
      decodeBase64url(envelopeBytesBase64url)
    );
    try {
      const payload = decodeEncryptedPayloadV2(payloadBytes);
      const manifest = decodeObjectAccessManifestV5(manifestBytes);
      expect(payload.context.keyClass).toBe("ai");
      expect(Number(manifest.accessRevision)).toBe(0);
      expect(manifest.signer.kind).toBe("human_device");
      expect(envelopeBytes.map((bytes) =>
        decodeNamespaceObjectEnvelopeV2(bytes).context.keyClass
      )).toEqual(["ai", "ai"]);
    } finally {
      payloadBytes.fill(0);
      manifestBytes.fill(0);
      envelopeBytes.forEach((bytes) => bytes.fill(0));
    }
  });

  test("tries a second authorized read path when the first is unavailable", async () => {
    const { content, now, unavailableAuthorities, namespaceFailures,
      requestedAuthorities, signing } = await setup();
    const created = await content.prepareCreate({
      plan: { dtoVersion: 1, memoryId: MEMORY_ID, operationId: "read:fallback",
        expectedContentRevision: 0, nextContentRevision: 1,
        productAuthority: { mode: "namespace" },
        requiredNamespaceIds: [NAMESPACE_ID, NAMESPACE_B],
        targetAuthorities: [AUTHORITY_A, AUTHORITY_B], deadlineAt: now + 30_000 },
      intent: { payload: { formatVersion: 1, type: "fact", content: "fallback" },
        requestedProvider: "openai", requestedModel: "text-embedding-3-small" },
    });
    const base = dtoFromCreate(created, signing.publicKey);
    const shared = { ...base, projection: { ...base.projection,
      namespaceIds: [NAMESPACE_ID, NAMESPACE_B],
      requiredNamespaceIds: [NAMESPACE_ID, NAMESPACE_B],
      readAuthorities: [AUTHORITY_A, AUTHORITY_B],
      mutationAuthorities: [AUTHORITY_A, AUTHORITY_B] } };
    unavailableAuthorities.add(NAMESPACE_ID);
    requestedAuthorities.length = 0;
    const opened = await content.openExact(shared);
    expect(decodeMemoryPayloadV1(opened).content).toBe("fallback");
    opened.fill(0);
    expect(requestedAuthorities).toEqual([NAMESPACE_ID, NAMESPACE_B]);
    unavailableAuthorities.add(NAMESPACE_B);
    const waiting = await captureError(() => content.openExact(shared));
    expect(waiting).toBeInstanceOf(AuthorizedHumanMemoryUnavailableError);
    expect(waiting).toMatchObject({ reason: "encryption_pending" });

    unavailableAuthorities.clear();
    if (shared.protectedPayload.status !== "encrypted") throw new Error();
    const malformed = { ...shared, protectedPayload: {
      ...shared.protectedPayload,
      encryptedPayloadBytesBase64url: "***",
    } };
    expect(await captureError(() => content.openExact(malformed))).toEqual(
      new AuthorizedHumanMemoryUnavailableError("corrupt"),
    );
    const afterMalformed = await content.openExact(shared);
    afterMalformed.fill(0);

    const storageFailure = new Error("vault-backed authority storage failed");
    namespaceFailures.set(NAMESPACE_ID, storageFailure);
    expect(await captureError(() => content.openExact(shared))).toBe(storageFailure);
    const abort = new DOMException("cancelled", "AbortError");
    namespaceFailures.set(NAMESPACE_ID, abort);
    expect(await captureError(() => content.openExact(shared))).toBe(abort);
  });

  test("refuses content mutation without the complete exact authority set", async () => {
    const { content, now, signing } = await setup();
    const created = await content.prepareCreate({
      plan: { dtoVersion: 1, memoryId: MEMORY_ID, operationId: "update:authority",
        expectedContentRevision: 0, nextContentRevision: 1,
        productAuthority: { mode: "namespace" },
        requiredNamespaceIds: [NAMESPACE_ID, NAMESPACE_B],
        targetAuthorities: [AUTHORITY_A, AUTHORITY_B], deadlineAt: now + 30_000 },
      intent: { payload: { formatVersion: 1, type: "fact", content: "old" },
        requestedProvider: "openai", requestedModel: "text-embedding-3-small" },
    });
    const base = dtoFromCreate(created, signing.publicKey);
    const incomplete = { ...base, projection: { ...base.projection,
      namespaceIds: [NAMESPACE_ID, NAMESPACE_B],
      requiredNamespaceIds: [NAMESPACE_ID, NAMESPACE_B],
      readAuthorities: [AUTHORITY_A], mutationAuthorities: [AUTHORITY_A] } };
    expect(String(await captureError(() => content.prepareUpdate({
      current: incomplete,
      intent: { payload: { formatVersion: 1, type: "fact", content: "new" },
        requestedProvider: "openai", requestedModel: "text-embedding-3-small" },
    })))).toContain("mutation authority is unavailable");
  });

  test("rejects a noncanonical direct create audience before key custody", async () => {
    const { content, now } = await setup();
    expect(String(await captureError(() => content.prepareCreate({
      plan: {
        dtoVersion: 1,
        memoryId: MEMORY_ID,
        operationId: "memory-create:reordered",
        expectedContentRevision: 0,
        nextContentRevision: 1,
        productAuthority: { mode: "namespace" },
        requiredNamespaceIds: [NAMESPACE_B, NAMESPACE_ID],
        targetAuthorities: [AUTHORITY_B, AUTHORITY_A],
        deadlineAt: now + 30_000,
      },
      intent: {
        payload: { formatVersion: 1, type: "fact", content: "not canonical" },
        requestedProvider: "openai",
        requestedModel: "text-embedding-3-small",
      },
    })))).toContain("create plan is invalid");
  });

  test("rejects a readable subset that omits an inaccessible v5 audience", async () => {
    const { content, now, signing } = await setup();
    const created = await content.prepareCreate({
      plan: {
        dtoVersion: 1,
        memoryId: MEMORY_ID,
        operationId: "memory-create:incomplete",
        expectedContentRevision: 0,
        nextContentRevision: 1,
        productAuthority: { mode: "namespace" },
        requiredNamespaceIds: [NAMESPACE_ID, NAMESPACE_B],
        targetAuthorities: [AUTHORITY_A, AUTHORITY_B],
        deadlineAt: now + 30_000,
      },
      intent: {
        payload: { formatVersion: 1, type: "fact", content: "shared exact" },
        requestedProvider: "openai",
        requestedModel: "text-embedding-3-small",
      },
    });
    const base = dtoFromCreate(created, signing.publicKey);
    const narrowed = {
      ...base,
      projection: {
        ...base.projection,
        namespaceIds: [NAMESPACE_ID],
        requiredNamespaceIds: [NAMESPACE_ID],
      },
      protectedPayload: {
        ...base.protectedPayload,
        namespaceEnvelopes: [created.namespaceEnvelopes[0]!],
      },
    };
    expect(await captureError(() => content.openExact(narrowed))).toEqual(
      new AuthorizedHumanMemoryUnavailableError("integrity_failure"),
    );
  });

  test("signs exact access coordinates against the authenticated current head", async () => {
    const { content, crypto, now, signing } = await setup();
    const created = await content.prepareCreate({
      plan: { dtoVersion: 1, memoryId: MEMORY_ID, operationId: "memory-create:access",
        expectedContentRevision: 0, nextContentRevision: 1,
        productAuthority: { mode: "namespace" }, requiredNamespaceIds: [NAMESPACE_ID],
        targetAuthorities: [AUTHORITY_A],
        deadlineAt: now + 30_000 },
      intent: { payload: { formatVersion: 1, type: "fact", content: "share me" },
        requestedProvider: "openai", requestedModel: "text-embedding-3-small" },
    });
    const current = dtoFromCreate(created, signing.publicKey);
    (await content.openExact(current)).fill(0);
    const prepared = await content.prepareAccess({
      current,
      plan: {
        dtoVersion: 1, status: "planned", planVersion: 1,
        operationId: "memory-access:1", memoryId: MEMORY_ID,
        expectedContentRevision: 1, expectedCryptoAccessRevision: 0,
        cryptoObjectId: created.cryptoObjectId,
        currentNamespaceIds: [NAMESPACE_ID],
        targetNamespaceIds: [NAMESPACE_ID, NAMESPACE_B],
        addedNamespaceIds: [NAMESPACE_B], removedNamespaceIds: [],
        currentAuthorities: [AUTHORITY_A],
        targetAuthorities: [AUTHORITY_A, AUTHORITY_B],
        deadlineAt: now + 30_000,
      },
    });
    const signedBytes = decodeBase64url(prepared.signedAccessRequestBytesBase64url);
    const manifestBytes = decodeBase64url(current.protectedPayload.status === "encrypted"
      ? current.protectedPayload.accessManifestBytesBase64url : "");
    try {
      const signed = decodeHumanMemoryExactAccessRequestV2(signedBytes);
      expect(signed.currentManifestHash).toEqual(crypto.hash(manifestBytes));
      expect(signed.currentEntries.map(({ namespaceId }) => String(namespaceId)))
        .toEqual([NAMESPACE_ID]);
      expect(signed.targetEntries.map(({ namespaceId }) => String(namespaceId)))
        .toEqual([NAMESPACE_ID, NAMESPACE_B]);
    } finally {
      signedBytes.fill(0);
      manifestBytes.fill(0);
    }
  });

  test("uses the authenticated source Room to ensure Human-share readiness", async () => {
    const state = await setup();
    const created = await state.content.prepareCreate({
      plan: { dtoVersion: 1, memoryId: MEMORY_ID,
        operationId: "memory-create:readiness", expectedContentRevision: 0,
        nextContentRevision: 1, productAuthority: { mode: "namespace" },
        requiredNamespaceIds: [NAMESPACE_ID], targetAuthorities: [AUTHORITY_A],
        deadlineAt: state.now + 30_000 },
      intent: { payload: { formatVersion: 1, type: "fact", content: "share me" },
        requestedProvider: "openai", requestedModel: "text-embedding-3-small" },
    });
    const current = dtoFromCreate(created, state.signing.publicKey);
    await state.content.prepareAccessReadiness({ current,
      sourceRoomId: SOURCE_ROOM, requiredNamespaceIds: [NAMESPACE_B] });
    expect(state.ensuredAuthorities).toHaveLength(1);
    expect(state.ensuredAuthorities[0]).toMatchObject({
      sourceRoomId: SOURCE_ROOM, namespaceId: NAMESPACE_B, keyClass: "ai",
    });
    expect(state.content.prepareAccessReadiness({ current,
      sourceRoomId: MEMORY_ID, requiredNamespaceIds: [NAMESPACE_B] }))
      .rejects.toThrow("readiness target is not authenticated");
  });

  test("slices a full revision-3 proof from retained revision 1 and signs head 3", async () => {
    const state = await revisionThreeFixture();
    if (state.dto.protectedPayload.status !== "encrypted") throw new Error();
    expect(new Set(state.dto.protectedPayload.accessSignerEvidence.flatMap(
      (entry) => entry.kind === "human_device"
        ? [String(entry.subjectHumanId)] : [],
    ))).toEqual(new Set([COORDINATES.humanActorId, "human:peer"]));
    const genesis = decodeObjectAccessManifestV5(state.genesisBytes);
    state.anchors.set(state.created.cryptoObjectId, {
      objectId: objectId(state.created.cryptoObjectId),
      payloadHash: genesis.payloadHash,
      accessRevision: accessRevision(1),
      manifestHash: state.crypto.hash(state.revisionOne.manifestBytes),
    });
    const opened = await state.content.openExact(state.dto);
    opened.fill(0);
    expect(Number(
      state.anchors.get(state.created.cryptoObjectId)?.accessRevision,
    )).toBe(3);
    const updated = await state.content.prepareUpdate({
      current: state.dto,
      intent: {
        payload: { formatVersion: 1, type: "fact", content: "after grant" },
        requestedProvider: "openai",
        requestedModel: "text-embedding-3-small",
      },
    });
    expect(updated.requiredNamespaceIds).toEqual([NAMESPACE_ID, NAMESPACE_B]);
    expect(updated.namespaceEnvelopes.map(({ namespaceId }) => namespaceId))
      .toEqual([NAMESPACE_ID, NAMESPACE_B]);
    const prepared = await state.content.prepareAccess({
      current: state.dto,
      plan: {
        dtoVersion: 1, status: "planned", planVersion: 1,
        operationId: "chain:delete", memoryId: MEMORY_ID,
        expectedContentRevision: 1, expectedCryptoAccessRevision: 3,
        cryptoObjectId: state.created.cryptoObjectId,
        currentNamespaceIds: [NAMESPACE_ID, NAMESPACE_B], targetNamespaceIds: [],
        addedNamespaceIds: [], removedNamespaceIds: [NAMESPACE_ID, NAMESPACE_B],
        currentAuthorities: [AUTHORITY_A, AUTHORITY_B],
        targetAuthorities: [],
        deadlineAt: state.now + 30_000,
      },
    });
    const signedBytes = decodeBase64url(prepared.signedAccessRequestBytesBase64url);
    try {
      const signed = decodeHumanMemoryExactAccessRequestV2(signedBytes);
      expect(signed.expectedAccessRevision).toBe(3);
      expect(signed.currentManifestHash).toEqual(
        state.crypto.hash(state.revisionThree.manifestBytes),
      );
    } finally {
      signedBytes.fill(0);
    }
  });

  test("rejects truncated, substituted-anchor, and below-anchor access heads", async () => {
    const state = await revisionThreeFixture();
    const genesis = decodeObjectAccessManifestV5(state.genesisBytes);
    const retained = {
      objectId: objectId(state.created.cryptoObjectId),
      payloadHash: genesis.payloadHash,
      accessRevision: accessRevision(1),
      manifestHash: state.crypto.hash(state.revisionOne.manifestBytes),
    };
    state.anchors.set(state.created.cryptoObjectId, retained);
    const truncated = structuredClone(state.dto);
    truncated.protectedPayload.accessManifestProofBytesBase64url = [
      Buffer.from(state.genesisBytes).toString("base64url"),
      Buffer.from(state.revisionTwo.manifestBytes).toString("base64url"),
    ];
    expect(await captureError(() => state.content.openExact(truncated))).toEqual(
      new AuthorizedHumanMemoryUnavailableError("integrity_failure"),
    );

    state.anchors.set(state.created.cryptoObjectId, {
      ...retained,
      manifestHash: new Uint8Array(32).fill(0xff),
    });
    expect(await captureError(() => state.content.openExact(state.dto))).toEqual(
      new AuthorizedHumanMemoryUnavailableError("integrity_failure"),
    );

    state.anchors.set(state.created.cryptoObjectId, {
      ...retained,
      accessRevision: accessRevision(4),
      manifestHash: new Uint8Array(32).fill(0xee),
    });
    expect(await captureError(() => state.content.openExact(state.dto))).toEqual(
      new AuthorizedHumanMemoryUnavailableError("integrity_failure"),
    );
  });
});
