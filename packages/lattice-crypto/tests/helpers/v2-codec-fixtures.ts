import {
  decodeAgentRuntimeGeneration,
  encodeAgentRuntimeGeneration,
  parseAgentRuntimeDomainEnvelope,
  serializeAgentRuntimeDomainEnvelope,
} from "../../src/format/agent-runtime-v2.ts";
import {
  GRANT_V2_FORMAT_VERSION,
  GRANT_V2_SCHEME,
  parseGrantSecretV2,
  parseGrantV2,
  serializeGrantSecretV2,
  serializeGrantV2,
} from "../../src/format/grant-v2.ts";
import {
  parseNamespaceBinding,
  serializeNamespaceBinding,
} from "../../src/format/namespace-binding-v2.ts";
import {
  decodeNamespaceKeyring,
  encodeNamespaceKeyring,
  parseNamespaceKeyringEnvelope,
  serializeNamespaceKeyringEnvelope,
} from "../../src/format/namespace-keyring-v2.ts";
import {
  decodeObjectAccessManifestV2,
  encodeObjectAccessManifestV2,
} from "../../src/format/object-access-manifest-v2.ts";
import {
  decodeEncryptedPayloadV2,
  decodeNamespaceObjectEnvelopeV2,
  encodeEncryptedPayloadV2,
  encodeNamespaceObjectEnvelopeV2,
} from "../../src/format/object-v2.ts";
import {
  decodeHumanRecoveryArchive,
  decodeNamespaceRecoveryPackage,
  recoveryKeyGeneration,
  serializeHumanRecoveryArchive,
  serializeNamespaceRecoveryPackage,
} from "../../src/format/recovery-v2.ts";
import {
  AGENT_MANAGER_RECOVERY_VERSION,
  decodeAgentManagerKeyring,
  decodeAgentManagerRecoveryPackage,
  encodeAgentManagerKeyring,
  serializeAgentManagerRecoveryPackage,
} from "../../src/recovery/agent-manager-v2.ts";
import {
  decodeDeviceTransferApproval,
  serializeDeviceTransferApproval,
} from "../../src/recovery/device-transfer-workflow-v2.ts";
import {
  decodeRecoveryDeviceActivationChallenge,
  decodeRecoveryDeviceActivationProof,
  serializeRecoveryDeviceActivationChallenge,
  serializeRecoveryDeviceActivationProof,
} from "../../src/recovery/recovery-device-activation-v2.ts";
import {
  deviceTransferInventoryRevision,
  pendingDeviceRevision,
} from "../../src/recovery/device-transfer-common-v2.ts";
import {
  accessRevision,
  agentId,
  agentRuntimeGeneration,
  authorizationRevision,
  cryptoDeviceId,
  cryptoDomainId,
  domainEpoch,
  grantId,
  humanId,
  namespaceGeneration,
  namespaceId,
  objectId,
  unixTimestamp,
} from "../../src/v2-types/ids.ts";

export interface V2CodecFixture {
  readonly name: string;
  readonly canonical: Uint8Array;
  readonly roundTrip: (bytes: Uint8Array) => Uint8Array | null;
}

export const V2_CODEC_FIXTURE_NAMES = Object.freeze([
  "Agent Runtime generation",
  "Agent Runtime Domain envelope",
  "grant",
  "grant secret",
  "Namespace binding",
  "Namespace keyring",
  "Namespace keyring envelope",
  "object access manifest",
  "encrypted object payload",
  "Namespace object envelope",
  "Namespace recovery package",
  "Human recovery archive",
  "Agent manager keyring",
  "Agent manager recovery package",
  "device transfer approval and nested package",
  "recovery-device activation challenge",
  "recovery-device activation proof",
] as const);

/**
 * Complete binary-free v2 format inventory shared by property and fuzz lanes.
 * The seed changes every opaque/hash/signature fixture byte while preserving
 * exact valid structure, so recorded seeds exercise more than one golden wire.
 */
export function fixtureV2Codecs(seed: number): readonly V2CodecFixture[] {
  if (!Number.isSafeInteger(seed) || seed < 0) {
    throw new RangeError("v2 codec fixture seed must be non-negative");
  }
  const bytes = (value: number, length = 32): Uint8Array =>
    Uint8Array.from(
      { length },
      (_, index) =>
        (value + seed * 17 + (seed === 0 ? 0 : index * 31)) & 0xff,
    );
  const runtimeGeneration = {
    agentId: agentId("agent_genie"),
    keyClass: "runtime" as const,
    generation: agentRuntimeGeneration(3),
    key: bytes(0x11),
  };
  const runtimeEnvelope = {
    formatVersion: 1 as const,
    agentId: agentId("agent_genie"),
    domainId: cryptoDomainId("domain_ab"),
    domainEpoch: domainEpoch(2),
    agentAuthorizationRevision: authorizationRevision(3),
    runtimeGeneration: agentRuntimeGeneration(4),
    ciphertext: bytes(0x12, 40),
    committerDeviceId: cryptoDeviceId("device_alice"),
    signature: bytes(0x13, 64),
  };
  const grant = {
    formatVersion: GRANT_V2_FORMAT_VERSION,
    id: grantId("grant_1"),
    issuingDeviceId: cryptoDeviceId("device_alice"),
    recipientAgentId: agentId("agent_genie"),
    recipientKeyId: "invocation_key_1",
    scope: [humanId("alice"), humanId("bob")],
    operations: ["decrypt", "encrypt"] as const,
    issuedAt: 1_000,
    expiresAt: 2_000,
    coveredDomains: [{
      domainId: cryptoDomainId("domain_ab"),
      domainEpoch: domainEpoch(3),
      agentAuthorizationRevision: authorizationRevision(7),
    }],
    encryptedSecret: bytes(0x14, 48),
    scheme: GRANT_V2_SCHEME,
    signature: bytes(0x15, 64),
    singleUse: true,
    consumed: false,
  };
  const grantSecret = [{
    domainId: cryptoDomainId("domain_ab"),
    aiRoot: bytes(0x16),
  }];
  const binding = {
    formatVersion: 2 as const,
    namespaceId: namespaceId("namespace_room"),
    domainId: cryptoDomainId("domain_ab"),
    domainEpoch: domainEpoch(2),
    accessRevision: accessRevision(3),
    humanCurrentGeneration: namespaceGeneration(4),
    aiCurrentGeneration: namespaceGeneration(5),
    previousBindingHash: bytes(0x17),
    humanKeyringEnvelopeHash: bytes(0x18),
    aiKeyringEnvelopeHash: bytes(0x19),
    committerDeviceId: cryptoDeviceId("device_alice"),
    signature: bytes(0x1a, 64),
  };
  const keyring = {
    formatVersion: 2 as const,
    namespaceId: namespaceId("namespace_room"),
    keyClass: "human" as const,
    accessRevision: accessRevision(1),
    currentGeneration: namespaceGeneration(1),
    generations: [
      { generation: namespaceGeneration(0), key: bytes(0x1b) },
      { generation: namespaceGeneration(1), key: bytes(0x1c) },
    ],
  };
  const keyringEnvelope = {
    formatVersion: 2 as const,
    namespaceId: namespaceId("namespace_room"),
    keyClass: "human" as const,
    domainId: cryptoDomainId("domain_ab"),
    domainEpoch: domainEpoch(2),
    accessRevision: accessRevision(1),
    currentGeneration: namespaceGeneration(1),
    previousBindingHash: bytes(0x1d),
    ciphertext: bytes(0x1e, 48),
    committerDeviceId: cryptoDeviceId("device_alice"),
    signature: bytes(0x1f, 64),
  };
  const manifest = {
    formatVersion: 2 as const,
    objectId: objectId("object_1"),
    payloadHash: bytes(0x20),
    accessRevision: accessRevision(0),
    previousManifestHash: null,
    envelopeHashes: [bytes(0x21)],
    committerDeviceId: cryptoDeviceId("device_alice"),
    hostAuthorizationRevision: authorizationRevision(0),
    signature: bytes(0x22, 64),
  };
  const payload = {
    formatVersion: 2 as const,
    context: {
      objectId: objectId("object_1"),
      keyClass: "human" as const,
      objectType: "message",
      createdAt: unixTimestamp(1_000),
    },
    ciphertext: bytes(0x23, 48),
  };
  const objectEnvelope = {
    formatVersion: 2 as const,
    context: {
      objectId: objectId("object_1"),
      namespaceId: namespaceId("namespace_room"),
      keyClass: "human" as const,
      keyGeneration: namespaceGeneration(1),
      bindingRevisionAtWrap: accessRevision(1),
    },
    wrappedDek: bytes(0x24, 48),
  };
  const recoveryPackage = {
    formatVersion: 2 as const,
    humanId: humanId("alice"),
    recoveryKeyId: "recovery_key_1",
    recoveryGeneration: recoveryKeyGeneration(1),
    recoveryPublicKeyDigest: bytes(0x25),
    namespaceId: namespaceId("namespace_room"),
    keyClass: "human" as const,
    accessRevision: accessRevision(1),
    currentGeneration: namespaceGeneration(1),
    bindingHash: bytes(0x26),
    issuerDeviceId: cryptoDeviceId("device_alice"),
    createdAt: unixTimestamp(1_000),
    ciphertext: bytes(0x27, 48),
    signature: bytes(0x28, 64),
  };
  const recoveryArchive = {
    formatVersion: 2 as const,
    humanId: humanId("alice"),
    recoveryKeyId: "recovery_key_1",
    recoveryGeneration: recoveryKeyGeneration(1),
    recoveryPublicKeyDigest: bytes(0x25),
    issuerDeviceId: cryptoDeviceId("device_alice"),
    createdAt: unixTimestamp(1_000),
    packages: [recoveryPackage],
    signature: bytes(0x29, 64),
  };
  const managerKeyring = {
    formatVersion: AGENT_MANAGER_RECOVERY_VERSION,
    agentId: agentId("agent_genie"),
    keyClass: "runtime" as const,
    currentGeneration: agentRuntimeGeneration(1),
    generations: [
      { generation: agentRuntimeGeneration(0), key: bytes(0x2a) },
      { generation: agentRuntimeGeneration(1), key: bytes(0x2b) },
    ],
  };
  const managerPackage = {
    formatVersion: AGENT_MANAGER_RECOVERY_VERSION,
    managerHumanId: humanId("alice"),
    agentId: agentId("agent_genie"),
    keyClass: "runtime" as const,
    managerAuthorizationRevision: authorizationRevision(1),
    recoveryKeyId: "recovery_key_1",
    recoveryGeneration: recoveryKeyGeneration(1),
    recoveryPublicKeyDigest: bytes(0x2c),
    currentGeneration: agentRuntimeGeneration(1),
    issuerDeviceId: cryptoDeviceId("device_alice"),
    createdAt: unixTimestamp(1_000),
    ciphertext: bytes(0x2d, 48),
    signature: bytes(0x2e, 64),
  };
  const transferPackage = {
    formatVersion: 2 as const,
    humanId: humanId("alice"),
    targetDeviceId: cryptoDeviceId("device_new"),
    pendingDeviceRevision: pendingDeviceRevision(1),
    encryptionPublicKeyDigest: bytes(0x2f),
    signingPublicKeyDigest: bytes(0x30),
    namespaceId: namespaceId("namespace_room"),
    keyClass: "human" as const,
    domainId: cryptoDomainId("domain_ab"),
    domainEpoch: domainEpoch(1),
    accessRevision: accessRevision(1),
    currentGeneration: namespaceGeneration(1),
    bindingHash: bytes(0x31),
    issuerDeviceId: cryptoDeviceId("device_alice"),
    createdAt: unixTimestamp(1_000),
    ciphertext: bytes(0x32, 48),
  };
  const transferApproval = {
    formatVersion: 2 as const,
    humanId: transferPackage.humanId,
    targetDeviceId: transferPackage.targetDeviceId,
    pendingDeviceRevision: transferPackage.pendingDeviceRevision,
    encryptionPublicKeyDigest: transferPackage.encryptionPublicKeyDigest,
    signingPublicKeyDigest: transferPackage.signingPublicKeyDigest,
    issuerDeviceId: transferPackage.issuerDeviceId,
    createdAt: transferPackage.createdAt,
    inventoryRevision: deviceTransferInventoryRevision(1),
    inventoryCount: 1,
    inventoryDigest: bytes(0x33),
    packages: [transferPackage],
    joinIntents: [],
    signature: bytes(0x34, 64),
  };
  const activationChallenge = {
    formatVersion: 2 as const,
    challengeId: "challenge_1",
    humanId: humanId("alice"),
    targetDeviceId: cryptoDeviceId("device_new"),
    pendingDeviceRevision: pendingDeviceRevision(1),
    encryptionPublicKeyDigest: bytes(0x35),
    signingPublicKeyDigest: bytes(0x36),
    recoveryKeyId: "recovery_key_1",
    recoveryGeneration: recoveryKeyGeneration(1),
    recoveryPublicKeyDigest: bytes(0x37),
    recoveryArchiveDigest: bytes(0x38),
    inventoryRevision: deviceTransferInventoryRevision(1),
    inventoryCount: 1,
    inventoryDigest: bytes(0x39),
    issuedAt: unixTimestamp(1_000),
    expiresAt: unixTimestamp(2_000),
    ciphertext: bytes(0x3a, 48),
  };
  const activationProof = {
    formatVersion: 2 as const,
    challengeHash: bytes(0x3b),
    readinessDigest: bytes(0x3c),
    response: bytes(0x3d),
  };

  const codecs: readonly V2CodecFixture[] = [
    {
      name: V2_CODEC_FIXTURE_NAMES[0],
      canonical: encodeAgentRuntimeGeneration(runtimeGeneration),
      roundTrip: (value) =>
        encodeAgentRuntimeGeneration(decodeAgentRuntimeGeneration(value)),
    },
    {
      name: V2_CODEC_FIXTURE_NAMES[1],
      canonical: serializeAgentRuntimeDomainEnvelope(runtimeEnvelope),
      roundTrip: (value) =>
        serializeAgentRuntimeDomainEnvelope(
          parseAgentRuntimeDomainEnvelope(value),
        ),
    },
    {
      name: V2_CODEC_FIXTURE_NAMES[2],
      canonical: serializeGrantV2(grant),
      roundTrip: (value) => {
        const decoded = parseGrantV2(value);
        return decoded === null ? null : serializeGrantV2(decoded);
      },
    },
    {
      name: V2_CODEC_FIXTURE_NAMES[3],
      canonical: serializeGrantSecretV2(grantSecret),
      roundTrip: (value) => {
        const decoded = parseGrantSecretV2(value);
        return decoded === null ? null : serializeGrantSecretV2(decoded);
      },
    },
    {
      name: V2_CODEC_FIXTURE_NAMES[4],
      canonical: serializeNamespaceBinding(binding),
      roundTrip: (value) =>
        serializeNamespaceBinding(parseNamespaceBinding(value)),
    },
    {
      name: V2_CODEC_FIXTURE_NAMES[5],
      canonical: encodeNamespaceKeyring(keyring),
      roundTrip: (value) =>
        encodeNamespaceKeyring(decodeNamespaceKeyring(value)),
    },
    {
      name: V2_CODEC_FIXTURE_NAMES[6],
      canonical: serializeNamespaceKeyringEnvelope(keyringEnvelope),
      roundTrip: (value) =>
        serializeNamespaceKeyringEnvelope(
          parseNamespaceKeyringEnvelope(value),
        ),
    },
    {
      name: V2_CODEC_FIXTURE_NAMES[7],
      canonical: encodeObjectAccessManifestV2(manifest),
      roundTrip: (value) =>
        encodeObjectAccessManifestV2(decodeObjectAccessManifestV2(value)),
    },
    {
      name: V2_CODEC_FIXTURE_NAMES[8],
      canonical: encodeEncryptedPayloadV2(payload),
      roundTrip: (value) =>
        encodeEncryptedPayloadV2(decodeEncryptedPayloadV2(value)),
    },
    {
      name: V2_CODEC_FIXTURE_NAMES[9],
      canonical: encodeNamespaceObjectEnvelopeV2(objectEnvelope),
      roundTrip: (value) =>
        encodeNamespaceObjectEnvelopeV2(
          decodeNamespaceObjectEnvelopeV2(value),
        ),
    },
    {
      name: V2_CODEC_FIXTURE_NAMES[10],
      canonical: serializeNamespaceRecoveryPackage(recoveryPackage),
      roundTrip: (value) =>
        serializeNamespaceRecoveryPackage(
          decodeNamespaceRecoveryPackage(value),
        ),
    },
    {
      name: V2_CODEC_FIXTURE_NAMES[11],
      canonical: serializeHumanRecoveryArchive(recoveryArchive),
      roundTrip: (value) =>
        serializeHumanRecoveryArchive(decodeHumanRecoveryArchive(value)),
    },
    {
      name: V2_CODEC_FIXTURE_NAMES[12],
      canonical: encodeAgentManagerKeyring(managerKeyring),
      roundTrip: (value) =>
        encodeAgentManagerKeyring(decodeAgentManagerKeyring(value)),
    },
    {
      name: V2_CODEC_FIXTURE_NAMES[13],
      canonical: serializeAgentManagerRecoveryPackage(managerPackage),
      roundTrip: (value) =>
        serializeAgentManagerRecoveryPackage(
          decodeAgentManagerRecoveryPackage(value),
        ),
    },
    {
      name: V2_CODEC_FIXTURE_NAMES[14],
      canonical: serializeDeviceTransferApproval(transferApproval),
      roundTrip: (value) =>
        serializeDeviceTransferApproval(decodeDeviceTransferApproval(value)),
    },
    {
      name: V2_CODEC_FIXTURE_NAMES[15],
      canonical: serializeRecoveryDeviceActivationChallenge(
        activationChallenge,
      ),
      roundTrip: (value) =>
        serializeRecoveryDeviceActivationChallenge(
          decodeRecoveryDeviceActivationChallenge(value),
        ),
    },
    {
      name: V2_CODEC_FIXTURE_NAMES[16],
      canonical: serializeRecoveryDeviceActivationProof(activationProof),
      roundTrip: (value) =>
        serializeRecoveryDeviceActivationProof(
          decodeRecoveryDeviceActivationProof(value),
        ),
    },
  ];
  return Object.freeze(codecs);
}
