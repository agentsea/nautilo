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
  createDeviceFanoutAdmission,
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

export async function createVerifiedDeviceFanoutAdmissionFixture(
  options: Readonly<{ emptyNamespaceInventory?: boolean }> = {},
) {
  const crypto = new LatticeCrypto();
  const issuer = crypto.generateSigningKeyPair();
  const targetSigning = crypto.generateSigningKeyPair();
  const targetEncryption = await crypto.generateEncryptionKeyPair();
  const issuerDeviceId = cryptoDeviceId("device_alice_current");
  const targetDeviceId = cryptoDeviceId("device_alice_pending");
  const emptyNamespaceInventory = options.emptyNamespaceInventory === true;
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
    idempotencyKey: "fanout_fixture",
    operationId: "operation_fanout_admission",
    challengeId: "challenge_fanout_admission",
    authorizationEvidenceDigest: new Uint8Array(32).fill(0x22),
    authorizationDigest: new Uint8Array(32).fill(0x23),
    expectedCustodyRevision: 4,
    expectedRecoveryGeneration: 2,
    inventoryRevision: emptyNamespaceInventory ? 0 : 8,
    inventoryCount: emptyNamespaceInventory ? 0 : 1,
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
    inventoryRevision: deviceTransferInventoryRevisionV2(
      emptyNamespaceInventory ? 0 : 8,
    ),
    inventoryCount: emptyNamespaceInventory ? 0 : 1,
    inventoryDigest,
    packages: emptyNamespaceInventory ? [] : [{
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
  const approvalBytes = serializeDeviceTransferApprovalV2({
    ...unsigned,
    signature: crypto.sign(
      issuer.privateKey,
      deviceTransferApprovalSigningBytesV2(unsigned),
    ),
  });
  const manifest = createAdditionalDeviceApprovalManifest({
    crypto,
    enrollment,
    approvalBytes,
    issuerDeviceId,
    issuerSigningPrivateKey: issuer.privateKey,
  });
  const approval = verifyAdditionalDeviceApproval({
    crypto,
    enrollment,
    approvalBytes,
    manifest,
    domains: [{
      domainId: "domain_ab",
      expectedEpoch: 3,
      targetEpoch: 4,
      expectedAuthorizationRevision: 5,
      expectedParticipantDigest: new Uint8Array(32).fill(0x61),
      committerDeviceId: issuerDeviceId,
      namespaces: emptyNamespaceInventory ? [] : [{
        namespaceId: "namespace_room",
        expectedAccessRevision: 7,
        expectedBindingHash: new Uint8Array(32).fill(0x41),
      }],
    }],
    resolveActiveApprovingDevice: () => ({
      state: "active",
      signingPublicKey: issuer.publicKey,
    }),
  });
  const admission = createDeviceFanoutAdmission({
    crypto,
    approval,
    now: 20_000,
  });
  return { admission, approval, crypto };
}
