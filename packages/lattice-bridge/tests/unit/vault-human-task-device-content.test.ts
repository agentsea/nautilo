import { expect, test } from "bun:test";
import { LatticeCrypto } from "@nautilo/lattice-crypto";
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
import type { ClientProfileCoordinates } from
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
import { decodeHumanTaskPublicationRequestV1 } from
  "@nautilo/lattice-crypto/wire";
import { encodeTaskPayloadV1 } from "../../src/task/task-payload-v1.ts";
import { fingerprintTaskDualPublicationFieldsV1 } from
  "../../src/task/task-operational-fields-digest-v1.ts";

const NOW = 1_800_000_000_000;
const HUMAN_ID = "20000000-0000-4000-8000-000000000248";
const TASK_ID = "30000000-0000-4000-8000-000000000248";
const ROOM_ID = "40000000-0000-4000-8000-000000000248";
const NAMESPACE_ID = "50000000-0000-4000-8000-000000000248";
const BINDING_HASH = new Uint8Array(32).fill(0x19);
const NAMESPACE_KEY = new Uint8Array(32).fill(0x48);

function seededRng(seed: number): (length: number) => Uint8Array {
  let state = seed >>> 0;
  return (length) => Uint8Array.from({ length }, () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state & 0xff;
  });
}

function base64url(value: Uint8Array): string {
  return Buffer.from(value).toString("base64url");
}

function decodeBase64url(value: string): Uint8Array {
  return Uint8Array.from(Buffer.from(value, "base64url"));
}

async function setup(deviceId: string, seed: number, peer?: Readonly<{
  deviceId: string;
  signingPublicKey: Uint8Array;
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
    keyringDeliveries: Object.freeze([Object.freeze({
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
  return {
    crypto,
    signing,
    content: createVaultHumanTaskDeviceContentPortV1({
      crypto,
      vault,
      coordinates,
      subjectHumanId: HUMAN_ID,
      now: () => NOW,
      resolveDeviceAdmissionStatus: () => Promise.resolve({
        responseVersion: 1,
        required: true,
        status: "admitted" as const,
        deviceId,
        deviceGeneration: 1,
        expiresAt: NOW + 60_000,
      }),
      accessAnchors: {
        load: (cryptoObjectId) => Promise.resolve(anchors.get(cryptoObjectId) ?? null),
        advance: ({ expected, next }) => {
          const current = anchors.get(next.objectId) ?? null;
          if (current !== expected) return Promise.resolve(false);
          anchors.set(next.objectId, {
            ...next,
            payloadHash: next.payloadHash.slice(),
            manifestHash: next.manifestHash.slice(),
          });
          return Promise.resolve(true);
        },
      },
    }),
    anchors,
  };
}

test("vault-backed Task prepare/open authenticates local custody and rejects forged signer evidence", async () => {
  const writer = await setup("device:writer", 0x248);
  const reader = await setup("device:reader", 0x249);
  const trustedReader = await setup("device:trusted-reader", 0x250, {
    deviceId: "device:writer",
    signingPublicKey: writer.signing.publicKey,
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

  const opened = await writer.content.openExact({ reference, envelope });
  try {
    expect(decodeTaskPayloadV1(opened)).toMatchObject({
      prompt: "private prompt",
      expectedOutput: "private answer",
    });
  } finally {
    opened.fill(0);
  }
  expect(writer.anchors.has(prepared.cryptoObjectId)).toBe(true);

  const unsupportedRevision = await writer.content.openExact({
    reference: { ...reference, cryptoAccessRevision: 1 },
    envelope: { ...envelope, cryptoAccessRevision: 1 },
  }).catch((cause: unknown) => cause);
  expect(unsupportedRevision).toBeInstanceOf(ClassifiedDataOperationError);
  expect((unsupportedRevision as ClassifiedDataOperationError).failureClass)
    .toBe("unsupported");

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
