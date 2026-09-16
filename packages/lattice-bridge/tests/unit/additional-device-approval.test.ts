import { describe, expect, test } from "bun:test";
import {
  LatticeCrypto,
  accessRevision,
  cryptoDeviceId,
  cryptoDomainId,
  domainEpoch,
  humanId,
  namespaceGeneration,
  namespaceId,
  unixTimestamp,
} from "@nautilo/lattice-crypto";
import {
  deviceTransferApprovalSigningBytesV2,
  deviceTransferInventoryRevisionV2,
  pendingDeviceRevisionV2,
  serializeDeviceTransferApprovalV2,
  type DeviceTransferApprovalV2,
} from "@nautilo/lattice-crypto/wire";
import {
  createAdditionalDeviceApprovalManifest,
  nautiloActorId,
  nautiloUserId,
  verifyAdditionalDeviceApproval,
  type PendingAdditionalDeviceEnrollment,
  type TranslationResult,
} from "../../src/index.ts";

function valueOf<T>(result: TranslationResult<T>): T {
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

const USER_ID = valueOf(
  nautiloUserId("00000000-0000-4000-8000-00000000000a"),
);
const ACTOR_ID = valueOf(
  nautiloActorId("00000000-0000-4000-8000-00000000000b"),
);

async function fixture() {
  const crypto = new LatticeCrypto();
  const issuer = crypto.generateSigningKeyPair();
  const targetSigning = crypto.generateSigningKeyPair();
  const targetEncryption = await crypto.generateEncryptionKeyPair();
  const issuerDeviceId = cryptoDeviceId("device_alice_current");
  const targetDeviceId = cryptoDeviceId("device_alice_pending");
  const inventoryDigest = new Uint8Array(32).fill(0x31);
  const enrollment: PendingAdditionalDeviceEnrollment = {
    formatVersion: 1,
    userId: USER_ID,
    humanActorId: ACTOR_ID,
    deviceId: targetDeviceId,
    clientKind: "electron",
    installationLineageDigest: new Uint8Array(32).fill(0x21),
    deviceGeneration: 1,
    signingPublicKey: targetSigning.publicKey,
    encryptionPublicKey: targetEncryption.publicKey,
    method: "device_approval",
    idempotencyKey: "approval_fixture",
    operationId: "operation_approval_fixture",
    challengeId: "challenge_approval_fixture",
    authorizationEvidenceDigest: new Uint8Array(32).fill(0x22),
    authorizationDigest: new Uint8Array(32).fill(0x23),
    expectedCustodyRevision: 4,
    expectedRecoveryGeneration: 2,
    inventoryRevision: 8,
    inventoryCount: 1,
    inventoryDigest,
    deviceRevision: 0,
    status: "pending",
    issuedAt: 10_000,
    expiresAt: 310_000,
  };
  const unsigned: DeviceTransferApprovalV2 = {
    formatVersion: 2,
    humanId: humanId(ACTOR_ID),
    targetDeviceId,
    pendingDeviceRevision: pendingDeviceRevisionV2(0),
    encryptionPublicKeyDigest: crypto.hash(targetEncryption.publicKey),
    signingPublicKeyDigest: crypto.hash(targetSigning.publicKey),
    issuerDeviceId,
    createdAt: unixTimestamp(10_100),
    inventoryRevision: deviceTransferInventoryRevisionV2(8),
    inventoryCount: 1,
    inventoryDigest,
    packages: [{
      formatVersion: 2,
      humanId: humanId(ACTOR_ID),
      targetDeviceId,
      pendingDeviceRevision: pendingDeviceRevisionV2(0),
      encryptionPublicKeyDigest: crypto.hash(targetEncryption.publicKey),
      signingPublicKeyDigest: crypto.hash(targetSigning.publicKey),
      namespaceId: namespaceId("namespace_room"),
      keyClass: "human",
      domainId: cryptoDomainId("domain_ab"),
      domainEpoch: domainEpoch(3),
      accessRevision: accessRevision(7),
      currentGeneration: namespaceGeneration(2),
      bindingHash: new Uint8Array(32).fill(0x41),
      issuerDeviceId,
      createdAt: unixTimestamp(10_100),
      ciphertext: new Uint8Array(105).fill(0x51),
    }],
    joinIntents: [{
      formatVersion: 2,
      humanId: humanId(ACTOR_ID),
      targetDeviceId,
      pendingDeviceRevision: pendingDeviceRevisionV2(0),
      domainId: cryptoDomainId("domain_ab"),
      domainEpoch: domainEpoch(3),
      committerDeviceId: issuerDeviceId,
    }],
    signature: new Uint8Array(64),
  };
  const approval: DeviceTransferApprovalV2 = {
    ...unsigned,
    signature: crypto.sign(
      issuer.privateKey,
      deviceTransferApprovalSigningBytesV2(unsigned),
    ),
  };
  const approvalBytes = serializeDeviceTransferApprovalV2(approval);
  const manifest = createAdditionalDeviceApprovalManifest({
    crypto,
    enrollment,
    approvalBytes,
    issuerDeviceId,
    issuerSigningPrivateKey: issuer.privateKey,
  });
  const domains = [{
    domainId: "domain_ab",
    expectedEpoch: 3,
    targetEpoch: 4,
    expectedAuthorizationRevision: 5,
    expectedParticipantDigest: new Uint8Array(32).fill(0x61),
    committerDeviceId: issuerDeviceId,
    namespaces: [{
      namespaceId: "namespace_room",
      expectedAccessRevision: 7,
      expectedBindingHash: new Uint8Array(32).fill(0x41),
    }],
  }];
  const resolveActiveApprovingDevice = () => ({
    state: "active" as const,
    signingPublicKey: issuer.publicKey,
  });
  return {
    crypto,
    issuer,
    enrollment,
    approvalBytes,
    manifest,
    domains,
    resolveActiveApprovingDevice,
  };
}

describe("additional-device cryptographic approval", () => {
  test("binds a core transfer approval to the exact durable operation", async () => {
    const setup = await fixture();
    const verified = verifyAdditionalDeviceApproval(setup);
    expect(verified.plan).toMatchObject({
      operationId: setup.enrollment.operationId,
      method: "device_approval",
      humanId: ACTOR_ID,
      targetDeviceId: setup.enrollment.deviceId,
      expectedDeviceRevision: 0,
      expectedCustodyRevision: 4,
      expectedRecoveryGeneration: 2,
      inventoryRevision: 8,
      inventoryCount: 1,
    });
    expect(verified.plan.authorizationArtifactHash).toEqual(
      setup.crypto.hash(setup.approvalBytes),
    );
    expect(verified.artifactChunks).toHaveLength(1);
  });

  test("rejects operation substitution even when the core approval is valid", async () => {
    const setup = await fixture();
    expect(() => verifyAdditionalDeviceApproval({
      ...setup,
      manifest: {
        ...setup.manifest,
        operationId: "operation_substituted",
      },
    })).toThrow("does not match its pending operation");
  });

  test("rejects revoked approvers and stale Domain inventory", async () => {
    const setup = await fixture();
    expect(() => verifyAdditionalDeviceApproval({
      ...setup,
      resolveActiveApprovingDevice: () => null,
    })).toThrow("approving device is not authorized");
    expect(() => verifyAdditionalDeviceApproval({
      ...setup,
      domains: [{
        ...setup.domains[0]!,
        expectedEpoch: 4,
        targetEpoch: 5,
      }],
    })).toThrow("Domain inventory is stale");
  });

  test("rejects a forged outer manifest signed by another device", async () => {
    const setup = await fixture();
    const attacker = setup.crypto.generateSigningKeyPair();
    const forged = createAdditionalDeviceApprovalManifest({
      crypto: setup.crypto,
      enrollment: setup.enrollment,
      approvalBytes: setup.approvalBytes,
      issuerDeviceId: setup.manifest.issuerDeviceId,
      issuerSigningPrivateKey: attacker.privateKey,
    });
    expect(() => verifyAdditionalDeviceApproval({
      ...setup,
      manifest: forged,
    })).toThrow("approving device is not authorized");
  });
});
