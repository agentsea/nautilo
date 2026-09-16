import { describe, expect, test } from "bun:test";
import { sha256 } from "@noble/hashes/sha2.js";
import { LatticeCrypto, seededRng } from "../../src/crypto/index.ts";
import {
  createNamespaceBinding,
  verifyNamespaceBindingProof,
} from "../../src/namespace/bindings.ts";
import { sealNamespaceKeyring } from "../../src/namespace/keyrings.ts";
import type {
  NamespaceKeyClass,
  NamespaceKeyringPlaintextV2,
} from "../../src/namespace/types.ts";
import {
  DEVICE_TRANSFER_APPROVAL_DOMAIN,
  DEVICE_TRANSFER_FORMAT_VERSION,
  DEVICE_TRANSFER_KEYRING_DOMAIN,
  MAX_METADATA_BYTES,
  RECOVERY_DEVICE_ACTIVATION_DOMAIN,
  answerRecoveryDeviceActivationChallengeV2,
  answerRecoveryDevicePossessionChallengeV2,
  assessRecoveryDeviceReadinessV2,
  decodeDeviceTransferApproval,
  deviceTransferApprovalSigningBytes,
  decodeRecoveryDeviceActivationChallenge,
  decodeRecoveryDeviceActivationProof,
  deviceTransferInventoryDigestV2,
  deviceTransferPackageAad,
  deviceTransferInventoryRevision,
  openDeviceTransferV2,
  pendingDeviceRevision,
  prepareDeviceTransferV2,
  prepareRecoveryDeviceActivationChallengeV2,
  prepareRecoveryDevicePossessionChallengeV2,
  recoveryReadinessDigest,
  verifyRecoveryDeviceReadinessV2,
  serializeDeviceTransferApproval,
  serializeRecoveryDeviceActivationChallenge,
  serializeRecoveryDeviceActivationProof,
  verifyRecoveryDeviceActivationProofV2,
  verifyRecoveryDevicePossessionProofV2,
  type DeviceTransferKeyringSourceV2,
  type RecoveryDeviceReadinessEvidenceV2,
  type RecoveryDeviceReadinessV2,
} from "../../src/recovery/device-transfer-v2.ts";
import { recoveryKeyGeneration } from "../../src/format/recovery-v2.ts";
import {
  decodeNamespaceKeyring,
  encodeNamespaceKeyring,
} from "../../src/format/namespace-keyring-v2.ts";
import {
  openHumanRecoveryArchiveV2,
  publishHumanRecoveryArchiveV2,
} from "../../src/recovery/human-archive-v2.ts";
import {
  accessRevision,
  cryptoDeviceId,
  cryptoDomainId,
  domainEpoch,
  humanId,
  namespaceGeneration,
  namespaceId,
  unixTimestamp,
} from "../../src/v2-types/ids.ts";
import { V2_LIMITS } from "../../src/v2-types/limits.ts";
import {
  CanonicalDecodingError,
  StrictDecoder,
  concatV2,
  encodeU32,
  encodeU64,
  frame,
  frameText,
} from "../../src/format/v2-primitives.ts";
import { digestPublicKey } from "../../src/recovery/device-transfer-common-v2.ts";
import {
  assertCompleteKeyring,
  assertExactTrustedNamespaceHeadV2,
  assertKeyClass,
  currentGeneration,
  normalizeInventory,
  preflightInventoryShape,
  predictedHpkeCiphertextBytes,
  readExactText,
  resolveExactInventoryCommitment,
  resolvePending,
  validatePendingCandidate,
} from "../../src/recovery/device-transfer-common-v2.ts";
import {
  assertDeviceTransferApprovalWireLengthV2,
} from "../../src/recovery/device-transfer-workflow-v2.ts";
import {
  advanceDeviceTransferApprovalPredictionV2,
  deviceTransferApprovalBasePredictionV2,
} from "../../src/recovery/device-transfer-size-v2.ts";

function bytes(value: number, length = 32): Uint8Array {
  return new Uint8Array(length).fill(value);
}

class LengthSpoofedBytes extends Uint8Array {
  constructor(private readonly spoofedLength: number) {
    super(1);
  }

  override get length(): number {
    return this.spoofedLength;
  }
}

function expectExactError(action: () => unknown, message: string): void {
  try {
    action();
  } catch (error) {
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe(message);
    return;
  }
  throw new Error(`expected exact error: ${message}`);
}

async function rejectedMessage(
  action: () => Promise<unknown>,
): Promise<string> {
  try {
    await action();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error("expected operation to reject");
}

function mutateFramedText(
  wire: Uint8Array,
  text: string,
  occurrence = 0,
): Uint8Array {
  const frame = frameText(text);
  let index = -1;
  for (let count = 0; count <= occurrence; count++) {
    index = Buffer.from(wire).indexOf(Buffer.from(frame), index + 1);
  }
  if (index < 0) throw new Error(`missing framed text: ${text}`);
  const mutated = wire.slice();
  mutated[index + frame.length - 1] =
    mutated[index + frame.length - 1]! ^ 1;
  return mutated;
}

class TrackingCrypto extends LatticeCrypto {
  readonly sealPlaintexts: Uint8Array[] = [];
  readonly openPlaintexts: Uint8Array[] = [];
  readonly sealOutputs: Uint8Array[] = [];
  readonly randomOutputs: Uint8Array[] = [];
  bufferNextRandom = false;
  shortNextRandom = false;
  afterSealTo: (() => void) | null = null;
  sealCalls = 0;
  openCalls = 0;
  nullOpenAt: number | null = null;
  failNextSeal = false;
  sealLengthDelta = 0;
  reuseSignOutput = false;
  private readonly sharedSignature = new Uint8Array(64);
  openPlaintextTransform:
    ((plaintext: Uint8Array) => Uint8Array) | null = null;
  aeadOpenPlaintextTransform:
    ((plaintext: Uint8Array) => Uint8Array) | null = null;

  override randomBytes(length: number): Uint8Array {
    const generated = super.randomBytes(length);
    const exactOutput = this.bufferNextRandom
      ? Buffer.from(generated)
      : generated;
    const output = this.shortNextRandom
      ? exactOutput.subarray(0, length - 1)
      : exactOutput;
    this.bufferNextRandom = false;
    this.shortNextRandom = false;
    this.randomOutputs.push(output);
    return output;
  }

  override async sealTo(
    publicKey: Uint8Array,
    plaintext: Uint8Array,
  ): Promise<Uint8Array> {
    this.sealCalls++;
    this.sealPlaintexts.push(plaintext);
    if (this.failNextSeal) {
      this.failNextSeal = false;
      throw new Error("injected HPKE seal failure");
    }
    const sealed = await super.sealTo(publicKey, plaintext);
    this.afterSealTo?.();
    const output = this.sealLengthDelta === 0
      ? sealed
      : this.sealLengthDelta < 0
      ? sealed.slice(0, sealed.length + this.sealLengthDelta)
      : new Uint8Array(sealed.length + this.sealLengthDelta);
    this.sealOutputs.push(output);
    return output;
  }

  override async openSealed(
    privateKey: Uint8Array,
    blob: Uint8Array,
  ): Promise<Uint8Array | null> {
    this.openCalls++;
    if (this.openCalls === this.nullOpenAt) return null;
    const raw = await super.openSealed(privateKey, blob);
    const opened = raw === null || this.openPlaintextTransform === null
      ? raw
      : this.openPlaintextTransform(raw);
    if (opened !== null) this.openPlaintexts.push(opened);
    return opened;
  }

  override aeadOpen(
    key: Uint8Array,
    blob: Uint8Array,
    aad?: Uint8Array,
  ): Uint8Array | null {
    const raw = super.aeadOpen(key, blob, aad);
    return raw === null || this.aeadOpenPlaintextTransform === null
      ? raw
      : this.aeadOpenPlaintextTransform(raw);
  }

  override sign(
    privateKey: Uint8Array,
    message: Uint8Array,
  ): Uint8Array {
    const signature = super.sign(privateKey, message);
    if (!this.reuseSignOutput) return signature;
    this.sharedSignature.set(signature);
    return this.sharedSignature;
  }
}

function completeKeyring(
  targetNamespace: string,
  keyClass: NamespaceKeyClass,
): NamespaceKeyringPlaintextV2 {
  const offset = keyClass === "human" ? 0x10 : 0x20;
  return {
    formatVersion: 2,
    namespaceId: namespaceId(targetNamespace),
    keyClass,
    accessRevision: accessRevision(0),
    currentGeneration: namespaceGeneration(1),
    generations: [
      { generation: namespaceGeneration(0), key: bytes(offset + 1) },
      { generation: namespaceGeneration(1), key: bytes(offset + 2) },
    ],
  };
}

async function setup() {
  const crypto = new TrackingCrypto(seededRng(0xd371ce));
  const issuerSigning = crypto.generateSigningKeyPair();
  const pendingSigning = crypto.generateSigningKeyPair();
  const pendingEncryption = await crypto.generateEncryptionKeyPair();
  const recoveryEncryption = await crypto.generateEncryptionKeyPair();
  const issuerDeviceId = cryptoDeviceId("device_alice_current");
  const targetDeviceId = cryptoDeviceId("device_alice_pending");
  const targetHumanId = humanId("human_alice");
  const revision = pendingDeviceRevision(7);
  const createdAt = unixTimestamp(1_700_000_000_000);
  const recoveryKeyId = "recovery_alice_current";
  const recoveryGeneration = recoveryKeyGeneration(2);
  const human = completeKeyring("namespace_room", "human");
  const ai = completeKeyring("namespace_room", "ai");
  const metadata = {
    domainId: cryptoDomainId("domain_ab"),
    domainEpoch: domainEpoch(3),
    previousBindingHash: null,
    committerDeviceId: issuerDeviceId,
  };
  const humanRoot = bytes(0x31);
  const aiRoot = bytes(0x41);
  const humanEnvelope = sealNamespaceKeyring({
    crypto,
    domainRoot: humanRoot,
    keyring: human,
    metadata,
    committerSigningPrivateKey: issuerSigning.privateKey,
    resolveCurrentCommitter: () => issuerSigning.publicKey,
  });
  const aiEnvelope = sealNamespaceKeyring({
    crypto,
    domainRoot: aiRoot,
    keyring: ai,
    metadata,
    committerSigningPrivateKey: issuerSigning.privateKey,
    resolveCurrentCommitter: () => issuerSigning.publicKey,
  });
  const binding = createNamespaceBinding({
    crypto,
    humanEnvelope,
    aiEnvelope,
    committerSigningPrivateKey: issuerSigning.privateKey,
    resolveCurrentCommitter: () => issuerSigning.publicKey,
  });
  const trustedHead = verifyNamespaceBindingProof({
    crypto,
    anchor: null,
    proof: [binding],
    resolveHistoricalCommitter: () => issuerSigning.publicKey,
  });
  const pendingDevice = {
    humanId: targetHumanId,
    deviceId: targetDeviceId,
    pendingDeviceRevision: revision,
    encryptionPublicKey: pendingEncryption.publicKey,
    signingPublicKey: pendingSigning.publicKey,
  };
  const trustedPending = {
    humanId: targetHumanId,
    deviceId: targetDeviceId,
    pendingDeviceRevision: revision,
    encryptionPublicKeyDigest: crypto.hash(pendingEncryption.publicKey),
    signingPublicKeyDigest: crypto.hash(pendingSigning.publicKey),
    status: "pending" as const,
  };
  const sources: readonly DeviceTransferKeyringSourceV2[] = [
    {
      authorizedHumanId: targetHumanId,
      trustedNamespaceHead: trustedHead,
      keyClass: "human",
      currentKeyringEnvelope: humanEnvelope,
      currentDomainRoot: humanRoot,
      resolveHistoricalCommitter: () => issuerSigning.publicKey,
    },
    {
      authorizedHumanId: targetHumanId,
      trustedNamespaceHead: trustedHead,
      keyClass: "ai",
      currentKeyringEnvelope: aiEnvelope,
      currentDomainRoot: aiRoot,
      resolveHistoricalCommitter: () => issuerSigning.publicKey,
    },
  ];
  const expectedInventory = sources.map(
    ({ authorizedHumanId, trustedNamespaceHead, keyClass }) => ({
      authorizedHumanId,
      trustedNamespaceHead,
      keyClass,
    }),
  );
  const resolveTrustedPendingDevice = () => trustedPending;
  const resolveCurrentApprover = () => issuerSigning.publicKey;
  const resolveCurrentDomainCommitter = () => issuerSigning.publicKey;
  const resolveTrustedCurrentRecoveryKey = () => ({
    humanId: targetHumanId,
    recoveryKeyId,
    recoveryGeneration,
    publicKeyDigest: crypto.hash(recoveryEncryption.publicKey),
  });
  const inventoryRevision = deviceTransferInventoryRevision(11);
  const inventoryDigest = deviceTransferInventoryDigestV2({
    humanId: targetHumanId,
    inventoryRevision,
    inventory: expectedInventory,
  });
  const inventoryCommitment = {
    humanId: targetHumanId,
    inventoryRevision,
    inventoryCount: expectedInventory.length,
    inventoryDigest,
  };
  const resolveTrustedInventoryCommitment = () => inventoryCommitment;
  const publishedRecovery = await publishHumanRecoveryArchiveV2({
    crypto,
    humanId: targetHumanId,
    recoveryKeyId,
    recoveryGeneration,
    recoveryPublicKey: recoveryEncryption.publicKey,
    resolveTrustedCurrentRecoveryKey,
    issuerDeviceId,
    createdAt,
    sources,
    issuerSigningPrivateKey: issuerSigning.privateKey,
    resolveIssuerDevice: () => issuerSigning.publicKey,
  });
  const recoveryArchiveDigest = crypto.hash(publishedRecovery.archiveBytes);
  const openedRecoveryKeyrings = await openHumanRecoveryArchiveV2({
    crypto,
    archiveBytes: publishedRecovery.archiveBytes,
    humanId: targetHumanId,
    currentRecoveryKeyId: recoveryKeyId,
    currentRecoveryGeneration: recoveryGeneration,
    recoveryPrivateKey: recoveryEncryption.privateKey,
    resolveTrustedCurrentRecoveryKey,
    expectedInventory,
    resolveIssuerDevice: () => issuerSigning.publicKey,
  });
  crypto.sealCalls = 0;
  crypto.openCalls = 0;
  const prepare = (
    overrides: Partial<Parameters<typeof prepareDeviceTransferV2>[0]> = {},
  ) =>
    prepareDeviceTransferV2({
      crypto,
      pendingDevice,
      resolveTrustedPendingDevice,
      issuerDeviceId,
      issuerSigningPrivateKey: issuerSigning.privateKey,
      createdAt,
      inventoryRevision,
      sources,
      resolveTrustedInventoryCommitment,
      resolveCurrentApprover,
      resolveCurrentDomainCommitter,
      ...overrides,
    });
  const open = (
    approvalBytes: Uint8Array,
    overrides: Partial<Parameters<typeof openDeviceTransferV2>[0]> = {},
  ) =>
    openDeviceTransferV2({
      crypto,
      approvalBytes,
      pendingDevice,
      pendingEncryptionPrivateKey: pendingEncryption.privateKey,
      resolveTrustedPendingDevice,
      expectedInventory,
      resolveTrustedInventoryCommitment,
      resolveCurrentApprover,
      resolveCurrentDomainCommitter,
      ...overrides,
    });
  const assessReadiness = (
    overrides: Partial<Parameters<
      typeof assessRecoveryDeviceReadinessV2
    >[0]> = {},
  ) =>
    assessRecoveryDeviceReadinessV2({
      pendingDevice,
      hasAuthorizedDeviceTransferSource: false,
      recoveryCredential: { recoveryKeyId, recoveryGeneration },
      archiveRecoveryKey: { recoveryKeyId, recoveryGeneration },
      recoveryArchiveDigest,
      inventoryRevision,
      resolveTrustedInventoryCommitment,
      inventory: expectedInventory,
      restoredKeyrings: openedRecoveryKeyrings,
      liveDomains: [{
        domainId: cryptoDomainId("domain_ab"),
        domainEpoch: domainEpoch(3),
        committerDeviceId: issuerDeviceId,
      }],
      ...overrides,
    });
  const readinessEvidence = {
    hasAuthorizedDeviceTransferSource: false,
    recoveryCredential: { recoveryKeyId, recoveryGeneration },
    archiveRecoveryKey: { recoveryKeyId, recoveryGeneration },
    recoveryArchiveDigest,
    inventoryRevision,
    resolveTrustedInventoryCommitment,
    inventory: expectedInventory,
    restoredKeyrings: openedRecoveryKeyrings,
    liveDomains: [{
      domainId: cryptoDomainId("domain_ab"),
      domainEpoch: domainEpoch(3),
      committerDeviceId: issuerDeviceId,
    }],
  } as const;
  const verifyReadiness = (
    readiness: RecoveryDeviceReadinessV2,
    overrides: Partial<RecoveryDeviceReadinessEvidenceV2> = {},
  ) =>
    verifyRecoveryDeviceReadinessV2({
      readiness,
      evidence: {
        ...readinessEvidence,
        ...overrides,
        pendingDevice,
      },
    });
  const prepareRecoveryChallenge = (
    challengeId: string,
    overrides: Partial<Parameters<
      typeof prepareRecoveryDeviceActivationChallengeV2
    >[0]> = {},
  ) =>
    prepareRecoveryDeviceActivationChallengeV2({
      crypto,
      challengeId,
      pendingDevice,
      resolveTrustedPendingDevice,
      recoveryKeyId,
      recoveryGeneration,
      recoveryPublicKey: recoveryEncryption.publicKey,
      resolveTrustedCurrentRecoveryKey,
      recoveryArchiveDigest,
      inventoryRevision,
      resolveTrustedInventoryCommitment,
      issuedAt: unixTimestamp(1_700_000_000_100),
      expiresAt: unixTimestamp(1_700_000_060_100),
      ...overrides,
    });
  const answerRecoveryChallenge = (
    challengeBytes: Uint8Array,
    readiness: ReturnType<typeof assessReadiness>,
    overrides: Partial<Parameters<
      typeof answerRecoveryDeviceActivationChallengeV2
    >[0]> = {},
  ) =>
    answerRecoveryDeviceActivationChallengeV2({
      crypto,
      challengeBytes,
      pendingDevice,
      resolveTrustedPendingDevice,
      recoveryPublicKey: recoveryEncryption.publicKey,
      recoveryPrivateKey: recoveryEncryption.privateKey,
      resolveTrustedCurrentRecoveryKey,
      expectedRecoveryArchiveDigest: recoveryArchiveDigest,
      readiness,
      readinessEvidence,
      currentTime: unixTimestamp(1_700_000_000_200),
      ...overrides,
    });
  return {
    crypto,
    issuerSigning,
    pendingSigning,
    pendingEncryption,
    recoveryEncryption,
    issuerDeviceId,
    targetHumanId,
    targetDeviceId,
    revision,
    createdAt,
    recoveryKeyId,
    recoveryGeneration,
    recoveryArchiveDigest,
    publishedRecovery,
    openedRecoveryKeyrings,
    inventoryRevision,
    inventoryDigest,
    inventoryCommitment,
    human,
    ai,
    aiEnvelope,
    humanRoot,
    trustedHead,
    pendingDevice,
    trustedPending,
    sources,
    expectedInventory,
    resolveTrustedPendingDevice,
    resolveCurrentApprover,
    resolveCurrentDomainCommitter,
    resolveTrustedCurrentRecoveryKey,
    resolveTrustedInventoryCommitment,
    prepare,
    open,
    assessReadiness,
    readinessEvidence,
    verifyReadiness,
    prepareRecoveryChallenge,
    answerRecoveryChallenge,
  };
}

function trustedHeadFixture(
  state: Awaited<ReturnType<typeof setup>>,
  options: {
    namespace: string;
    domain: string;
    epoch?: number;
    accessRevision?: number;
    currentGeneration?: number;
    humanGeneration?: number;
    aiGeneration?: number;
  },
) {
  const revision = options.accessRevision ?? 0;
  const keyring = (
    keyClass: NamespaceKeyClass,
    marker: number,
  ): NamespaceKeyringPlaintextV2 => {
    const generation = keyClass === "human"
      ? options.humanGeneration ?? options.currentGeneration ?? 1
      : options.aiGeneration ?? options.currentGeneration ?? 1;
    return {
    formatVersion: 2,
    namespaceId: namespaceId(options.namespace),
    keyClass,
    accessRevision: accessRevision(revision),
    currentGeneration: namespaceGeneration(generation),
    generations: Array.from({ length: generation + 1 }, (_, index) => ({
      generation: namespaceGeneration(index),
      key: bytes(marker + index),
    })),
    };
  };
  const human = keyring("human", 0x61);
  const ai = keyring("ai", 0x71);
  const previousBindingHash = revision === 0
    ? null
    : state.trustedHead.bindingHash;
  const metadata = {
    domainId: cryptoDomainId(options.domain),
    domainEpoch: domainEpoch(options.epoch ?? 3),
    previousBindingHash,
    committerDeviceId: state.issuerDeviceId,
  };
  const humanRoot = bytes(0x81);
  const aiRoot = bytes(0x91);
  const humanEnvelope = sealNamespaceKeyring({
    crypto: state.crypto,
    domainRoot: humanRoot,
    keyring: human,
    metadata,
    committerSigningPrivateKey: state.issuerSigning.privateKey,
    resolveCurrentCommitter: () => state.issuerSigning.publicKey,
  });
  const aiEnvelope = sealNamespaceKeyring({
    crypto: state.crypto,
    domainRoot: aiRoot,
    keyring: ai,
    metadata,
    committerSigningPrivateKey: state.issuerSigning.privateKey,
    resolveCurrentCommitter: () => state.issuerSigning.publicKey,
  });
  const binding = createNamespaceBinding({
    crypto: state.crypto,
    humanEnvelope,
    aiEnvelope,
    committerSigningPrivateKey: state.issuerSigning.privateKey,
    resolveCurrentCommitter: () => state.issuerSigning.publicKey,
  });
  const anchor = revision === 0
    ? null
    : {
      namespaceId: state.trustedHead.namespaceId,
      accessRevision: state.trustedHead.accessRevision,
      bindingHash: state.trustedHead.bindingHash,
    };
  const head = verifyNamespaceBindingProof({
    crypto: state.crypto,
    anchor,
    proof: [binding],
    resolveHistoricalCommitter: () => state.issuerSigning.publicKey,
  });
  return {
    head,
    human,
    ai,
    humanEnvelope,
    aiEnvelope,
    humanRoot,
    aiRoot,
  };
}

function allZero(value: Uint8Array): boolean {
  return value.every((byte) => byte === 0);
}

function isZeroized(value: Uint8Array | null): boolean {
  return value !== null && allZero(value);
}

function fieldNames(value: unknown, result: string[] = []): string[] {
  if (
    typeof value !== "object"
    || value === null
    || value instanceof Uint8Array
  ) {
    return result;
  }
  for (const [key, child] of Object.entries(value)) {
    result.push(key);
    fieldNames(child, result);
  }
  return result;
}

describe("v2 device-transfer common boundaries", () => {
  test("locks inventory digest domain separation and public-key hashing", async () => {
    const state = await setup();
    const inventory = [...state.expectedInventory].sort((left, right) =>
      left.trustedNamespaceHead.namespaceId.localeCompare(
        right.trustedNamespaceHead.namespaceId,
      ) || left.keyClass.localeCompare(right.keyClass)
    );
    const expectedInventoryDigest = sha256(concatV2(
      frameText("nautilo/lattice-crypto/device-transfer-inventory/v2"),
      encodeU32(DEVICE_TRANSFER_FORMAT_VERSION),
      frameText(state.targetHumanId),
      encodeU64(state.inventoryRevision),
      encodeU32(inventory.length),
      ...inventory.map((item) => {
        const head = item.trustedNamespaceHead;
        return frame(concatV2(
          frameText(head.namespaceId),
          frameText(item.keyClass),
          encodeU64(head.accessRevision),
          frame(head.bindingHash),
          frameText(head.binding.domainId),
          encodeU64(head.binding.domainEpoch),
          encodeU64(
            item.keyClass === "human"
              ? head.binding.humanCurrentGeneration
              : head.binding.aiCurrentGeneration,
          ),
        ));
      }),
    ));
    expect(deviceTransferInventoryDigestV2({
      humanId: state.targetHumanId,
      inventoryRevision: state.inventoryRevision,
      inventory: state.expectedInventory,
    })).toEqual(expectedInventoryDigest);
    expect(digestPublicKey(
      "Pending encryption public key",
      state.pendingEncryption.publicKey,
      V2_LIMITS.hpkePublicKeyBytes,
    )).toEqual(sha256(state.pendingEncryption.publicKey));
  });

  test("validates pending candidate shape and detaches both public keys", async () => {
    const state = await setup();
    expectExactError(
      () => pendingDeviceRevision(-1),
      "Pending device revision must be a non-negative safe integer",
    );
    expectExactError(
      () => deviceTransferInventoryRevision(-1),
      "Device transfer inventory revision must be a non-negative safe integer",
    );
    for (const value of [null, "pending"]) {
      expectExactError(
        () => validatePendingCandidate(value as never),
        "Pending device candidate must be an object",
      );
    }
    expectExactError(
      () =>
        validatePendingCandidate({
          ...state.pendingDevice,
          unexpected: true,
        } as never),
      "Pending device candidate contains unknown field unexpected",
    );
    const { signingPublicKey: _missing, ...missingSigning } =
      state.pendingDevice;
    expectExactError(
      () => validatePendingCandidate(missingSigning as never),
      "Pending device candidate is missing required field signingPublicKey",
    );
    expectExactError(
      () =>
        validatePendingCandidate({
          ...state.pendingDevice,
          encryptionPublicKey: bytes(1, 64),
        }),
      "Pending device encryption public key must contain exactly 65 bytes",
    );
    expectExactError(
      () =>
        validatePendingCandidate({
          ...state.pendingDevice,
          signingPublicKey: bytes(1, 31),
        }),
      "Pending device signing public key must contain exactly 32 bytes",
    );
    const checked = validatePendingCandidate(state.pendingDevice);
    expect(checked.encryptionPublicKey).not.toBe(
      state.pendingDevice.encryptionPublicKey,
    );
    expect(checked.signingPublicKey).not.toBe(
      state.pendingDevice.signingPublicKey,
    );
    expect(checked.encryptionPublicKey).toEqual(
      state.pendingDevice.encryptionPublicKey,
    );
    expect(checked.signingPublicKey).toEqual(
      state.pendingDevice.signingPublicKey,
    );
  });

  test("requires one exact trusted pending record and owns returned digests", async () => {
    const state = await setup();
    const resolve = (record: unknown) =>
      resolvePending(state.pendingDevice, () => record as never);
    expectExactError(
      () => resolve(null),
      "Exact trusted pending device is required",
    );
    expectExactError(
      () => resolve("pending"),
      "Trusted pending device must be an object",
    );
    expectExactError(
      () => resolve({ ...state.trustedPending, unexpected: true }),
      "Trusted pending device contains unknown field unexpected",
    );
    const { status: _status, ...missingStatus } = state.trustedPending;
    expectExactError(
      () => resolve(missingStatus),
      "Trusted pending device is missing required field status",
    );
    expectExactError(
      () => resolve({ ...state.trustedPending, status: "active" }),
      "Device transfer target is not pending",
    );
    expectExactError(
      () =>
        resolve({
          ...state.trustedPending,
          encryptionPublicKeyDigest: bytes(1, 31),
        }),
      "Trusted pending encryption-key digest must contain exactly 32 bytes",
    );
    expectExactError(
      () =>
        resolve({
          ...state.trustedPending,
          signingPublicKeyDigest: bytes(1, 31),
        }),
      "Trusted pending signing-key digest must contain exactly 32 bytes",
    );
    for (const record of [
      { ...state.trustedPending, humanId: humanId("human_other") },
      { ...state.trustedPending, deviceId: cryptoDeviceId("device_other") },
      {
        ...state.trustedPending,
        pendingDeviceRevision: pendingDeviceRevision(8),
      },
      {
        ...state.trustedPending,
        encryptionPublicKeyDigest: bytes(0xee),
      },
      {
        ...state.trustedPending,
        signingPublicKeyDigest: bytes(0xee),
      },
    ]) {
      expectExactError(
        () => resolve(record),
        "Device transfer candidate does not match the trusted pending device",
      );
    }
    const resolved = resolve(state.trustedPending);
    expect(resolved.encryptionDigest).not.toBe(
      state.trustedPending.encryptionPublicKeyDigest,
    );
    expect(resolved.signingDigest).not.toBe(
      state.trustedPending.signingPublicKeyDigest,
    );
  });

  test("selects both key classes and rejects incomplete retained history", async () => {
    const state = await setup();
    const asymmetric = trustedHeadFixture(state, {
      namespace: "namespace_asymmetric",
      domain: "domain_asymmetric",
      humanGeneration: 1,
      aiGeneration: 2,
    });
    expect(currentGeneration(asymmetric.head, "human")).toBe(
      namespaceGeneration(1),
    );
    expect(currentGeneration(asymmetric.head, "ai")).toBe(
      namespaceGeneration(2),
    );
    expect(() => assertKeyClass("human")).not.toThrow();
    expect(() => assertKeyClass("ai")).not.toThrow();
    expectExactError(
      () => assertKeyClass("owner"),
      "Device transfer key class is unsupported",
    );
    expect(() => assertCompleteKeyring(state.human)).not.toThrow();
    expectExactError(
      () =>
        assertCompleteKeyring({
          ...state.human,
          currentGeneration: namespaceGeneration(2),
          generations: [
            state.human.generations[0]!,
            {
              generation: namespaceGeneration(2),
              key: bytes(0xaa),
            },
          ],
        }),
      "Device transfer keyring must contain complete retained history",
    );
    expect(predictedHpkeCiphertextBytes(123)).toBe(206);
  });

  test("preflights every hostile inventory shape and source-only secret field", async () => {
    const state = await setup();
    const fields = [
      "authorizedHumanId",
      "trustedNamespaceHead",
      "keyClass",
      "currentKeyringEnvelope",
      "currentDomainRoot",
      "resolveHistoricalCommitter",
    ];
    expectExactError(
      () => preflightInventoryShape(null as never, fields),
      "Device transfer inventory must be an array",
    );
    expectExactError(
      () =>
        preflightInventoryShape(
          Array.from(
            { length: V2_LIMITS.recoveryPackages + 1 },
            () => null,
          ) as never,
          fields,
        ),
      `Device transfer package count exceeds the ${V2_LIMITS.recoveryPackages} limit`,
    );
    expect(() => preflightInventoryShape([], fields)).not.toThrow();
    for (const item of [null, "source"]) {
      expectExactError(
        () => preflightInventoryShape([item] as never, fields),
        "Device transfer inventory item must be an object",
      );
    }
    expectExactError(
      () =>
        preflightInventoryShape([{
          ...state.sources[0]!,
          unexpected: true,
        } as never], fields),
      "Device transfer inventory item contains unknown field unexpected",
    );
    expectExactError(
      () =>
        preflightInventoryShape([{
          ...state.sources[0]!,
          currentDomainRoot: bytes(1, 31),
        }] as never, fields),
      "Device transfer current Domain root must contain exactly 32 bytes",
    );
    for (const envelope of [null, "envelope"]) {
      expectExactError(
        () =>
          preflightInventoryShape([{
            ...state.sources[0]!,
            currentKeyringEnvelope: envelope,
          }] as never, fields),
        "Device transfer current keyring envelope must be an object",
      );
    }
    expectExactError(
      () =>
        preflightInventoryShape([{
          ...state.sources[0]!,
          resolveHistoricalCommitter: null,
        }] as never, fields),
      "Device transfer historical committer resolver is required",
    );
    expectExactError(
      () =>
        preflightInventoryShape([{
          ...state.sources[0]!,
          currentKeyringEnvelope: state.aiEnvelope,
        }] as never, fields),
      "Device transfer keyring envelope does not match the trusted binding",
    );

    const inconsistent = trustedHeadFixture(state, {
      namespace: "namespace_inconsistent",
      domain: "domain_ab",
      epoch: 4,
    });
    expectExactError(
      () =>
        preflightInventoryShape([
          state.expectedInventory[0]!,
          {
            authorizedHumanId: state.targetHumanId,
            trustedNamespaceHead: inconsistent.head,
            keyClass: "human",
          },
        ], [
          "authorizedHumanId",
          "trustedNamespaceHead",
          "keyClass",
        ]),
      "Device transfer inventory disagrees on the current Domain epoch",
    );
  });

  test("reads exact domains and permits the same class in different Namespaces", async () => {
    expect(() =>
      readExactText(
        new StrictDecoder(frameText("expected")),
        "expected",
        "Test domain",
      )
    ).not.toThrow();
    expectExactError(
      () =>
        readExactText(
          new StrictDecoder(frameText("differen")),
          "expected",
          "Test domain",
        ),
      "Test domain is unsupported",
    );
    const state = await setup();
    const extra = trustedHeadFixture(state, {
      namespace: "namespace_alpha",
      domain: "domain_z",
    });
    const normalized = normalizeInventory(
      [
        state.expectedInventory[0]!,
        {
          authorizedHumanId: state.targetHumanId,
          trustedNamespaceHead: extra.head,
          keyClass: "human",
        },
      ],
      state.targetHumanId,
      [
        "authorizedHumanId",
        "trustedNamespaceHead",
        "keyClass",
      ],
    );
    expect(normalized).toHaveLength(2);
  });

  test("validates head capabilities and canonicalizes Namespace/class inventory order", async () => {
    const state = await setup();
    expect(() =>
      assertExactTrustedNamespaceHeadV2(state.trustedHead)
    ).not.toThrow();
    for (const value of [null, "head"]) {
      expectExactError(
        () => assertExactTrustedNamespaceHeadV2(value as never),
        "Device transfer trusted Namespace head must be an object",
      );
    }
    const extra = trustedHeadFixture(state, {
      namespace: "namespace_alpha",
      domain: "domain_z",
    });
    const extraItem = {
      authorizedHumanId: state.targetHumanId,
      trustedNamespaceHead: extra.head,
      keyClass: "human" as const,
    };
    const normalized = normalizeInventory(
      [
        state.expectedInventory[0]!,
        extraItem,
        state.expectedInventory[1]!,
      ],
      state.targetHumanId,
      [
        "authorizedHumanId",
        "trustedNamespaceHead",
        "keyClass",
      ],
    );
    expect(normalized.map((item) =>
      `${item.trustedNamespaceHead.namespaceId}/${item.keyClass}`
    )).toEqual([
      "namespace_alpha/human",
      "namespace_room/ai",
      "namespace_room/human",
    ]);
    expect(Object.isFrozen(normalized)).toBe(true);
  });

  test("requires an exact authoritative inventory commitment and detaches its digest", async () => {
    const state = await setup();
    const normalized = normalizeInventory(
      state.expectedInventory,
      state.targetHumanId,
      [
        "authorizedHumanId",
        "trustedNamespaceHead",
        "keyClass",
      ],
    );
    const resolve = (record: unknown) =>
      resolveExactInventoryCommitment(
        state.targetHumanId,
        state.inventoryRevision,
        normalized,
        () => record as never,
      );
    expectExactError(
      () => resolve(null),
      "Authoritative device-transfer inventory commitment is required",
    );
    expectExactError(
      () => resolve("commitment"),
      "Device-transfer inventory commitment must be an object",
    );
    expectExactError(
      () => resolve({ ...state.inventoryCommitment, unexpected: true }),
      "Device-transfer inventory commitment contains unknown field unexpected",
    );
    const { inventoryDigest: _digest, ...missingDigest } =
      state.inventoryCommitment;
    expectExactError(
      () => resolve(missingDigest),
      "Device-transfer inventory commitment is missing required field inventoryDigest",
    );
    expectExactError(
      () =>
        resolve({
          ...state.inventoryCommitment,
          inventoryCount: V2_LIMITS.recoveryPackages + 1,
        }),
      `Device-transfer inventory commitment count exceeds the ${V2_LIMITS.recoveryPackages} limit`,
    );
    expectExactError(
      () =>
        resolve({
          ...state.inventoryCommitment,
          inventoryDigest: bytes(1, 31),
        }),
      "Device-transfer inventory commitment digest must contain exactly 32 bytes",
    );
    for (const record of [
      { ...state.inventoryCommitment, humanId: humanId("human_other") },
      {
        ...state.inventoryCommitment,
        inventoryRevision: deviceTransferInventoryRevision(12),
      },
      { ...state.inventoryCommitment, inventoryCount: 1 },
      { ...state.inventoryCommitment, inventoryDigest: bytes(0xee) },
    ]) {
      expectExactError(
        () => resolve(record),
        "Device-transfer inventory does not match authoritative commitment",
      );
    }
    const trustedDigest = state.inventoryCommitment.inventoryDigest;
    const commitment = resolve(state.inventoryCommitment);
    expect(commitment.inventoryDigest).not.toBe(trustedDigest);
    expect(commitment.inventoryDigest).toEqual(trustedDigest);
  });
});

describe("v2 device transfer", () => {
  test("mutation contract: transfer aggregate prediction is exact and fails before HPKE without a 64 MiB fixture", () => {
    expect(deviceTransferApprovalBasePredictionV2([])).toBe(
      3 * 1024 + 4 + V2_LIMITS.signatureBytes,
    );
    expect(deviceTransferApprovalBasePredictionV2([10, 20])).toBe(
      3 * 1024 + 4 + V2_LIMITS.signatureBytes + 4 + 10 + 4 + 20,
    );
    expect(
      advanceDeviceTransferApprovalPredictionV2(100, 20, 30),
    ).toBe(158);
    expect(
      advanceDeviceTransferApprovalPredictionV2(
        V2_LIMITS.recoveryArchiveBytes - 8,
        0,
        0,
      ),
    ).toBe(V2_LIMITS.recoveryArchiveBytes);
    expectExactError(
      () =>
        advanceDeviceTransferApprovalPredictionV2(
          V2_LIMITS.recoveryArchiveBytes - 7,
          0,
          0,
        ),
      `Device transfer approval aggregate bytes exceeds the ${V2_LIMITS.recoveryArchiveBytes} limit`,
    );
    expectExactError(
      () =>
        advanceDeviceTransferApprovalPredictionV2(
          0,
          V2_LIMITS.recoveryArchiveBytes + 1,
          0,
        ),
      `Device transfer approval aggregate component bytes exceeds the ${V2_LIMITS.recoveryArchiveBytes} limit`,
    );
    expectExactError(
      () =>
        deviceTransferApprovalBasePredictionV2(
          Array.from(
            { length: V2_LIMITS.recoveryPackages + 1 },
            () => 0,
          ),
        ),
      `Device transfer join count exceeds the ${V2_LIMITS.recoveryPackages} limit`,
    );
  });

  test("preflights approval aggregate bytes before package hashing or wire allocation", async () => {
    const state = await setup();
    const prepared = await state.prepare();
    const template = prepared.approval.packages[0]!;
    const packages = Array.from({ length: 65 }, (_, index) => ({
      ...template,
      namespaceId: namespaceId(`namespace_${index.toString().padStart(3, "0")}`),
      ciphertext: new LengthSpoofedBytes(V2_LIMITS.ciphertextBytes),
    }));
    const oversized = {
      ...prepared.approval,
      inventoryCount: packages.length,
      packages,
    };
    for (const operation of [
      () => deviceTransferApprovalSigningBytes(oversized),
      () => serializeDeviceTransferApproval(oversized),
    ]) {
      expectExactError(
        operation,
        "Device transfer approval exceeds the 64 MiB aggregate-byte limit",
      );
    }
  });

  test("transfers complete Namespace/class history and emits pure activation and live-join intents", async () => {
    const state = await setup();
    const prepared = await state.prepare();
    const opened = await state.open(prepared.approvalBytes);

    expect(prepared.approval.packages).toHaveLength(2);
    expect(prepared.approval.joinIntents).toEqual([{
      formatVersion: 2,
      humanId: state.targetHumanId,
      targetDeviceId: state.targetDeviceId,
      pendingDeviceRevision: state.revision,
      domainId: cryptoDomainId("domain_ab"),
      domainEpoch: domainEpoch(3),
      committerDeviceId: state.issuerDeviceId,
    }]);
    expect(opened.keyrings.map((keyring) => keyring.keyClass)).toEqual([
      "ai",
      "human",
    ]);
    expect(opened.keyrings.map((keyring) => keyring.generations.length)).toEqual(
      [2, 2],
    );
    expect(opened.activationCas).toEqual(prepared.activationCas);
    expect(Object.keys(prepared.activationCas)).toEqual([
      "humanId",
      "deviceId",
      "expectedStatus",
      "expectedPendingDeviceRevision",
      "expectedPendingEncryptionPublicKeyDigest",
      "expectedPendingSigningPublicKeyDigest",
      "intendedStatus",
      "expectedInventoryRevision",
      "expectedInventoryCount",
      "expectedInventoryDigest",
      "approvalHash",
    ]);
    expect(opened.activationCas).toMatchObject({
      humanId: state.targetHumanId,
      deviceId: state.targetDeviceId,
      expectedStatus: "pending",
      expectedPendingDeviceRevision: state.revision,
      expectedPendingEncryptionPublicKeyDigest:
        state.trustedPending.encryptionPublicKeyDigest,
      expectedPendingSigningPublicKeyDigest:
        state.trustedPending.signingPublicKeyDigest,
      intendedStatus: "active",
      expectedInventoryRevision: state.inventoryRevision,
      expectedInventoryCount: 2,
      expectedInventoryDigest: state.inventoryDigest,
    });

    const fields = fieldNames(prepared).map((field) => field.toLowerCase());
    for (const field of [
      "domainRoot",
      "mls",
      "exporter",
      "privateKey",
      "leaf",
    ]) {
      expect(fields).not.toContain(field.toLowerCase());
    }
    expect(state.crypto.sealPlaintexts.every(allZero)).toBe(true);
    expect(state.crypto.openPlaintexts.every(allZero)).toBe(true);
  });

  test("uses strict canonical versioned approval bytes", async () => {
    const state = await setup();
    const prepared = await state.prepare();
    expect(DEVICE_TRANSFER_FORMAT_VERSION).toBe(2);
    expect(DEVICE_TRANSFER_KEYRING_DOMAIN).toBe(
      "nautilo/lattice-crypto/device-transfer-keyring/v2",
    );
    expect(DEVICE_TRANSFER_APPROVAL_DOMAIN).toBe(
      "nautilo/lattice-crypto/device-transfer-approval/v2",
    );
    expect(
      serializeDeviceTransferApproval(
        decodeDeviceTransferApproval(prepared.approvalBytes),
      ),
    ).toEqual(prepared.approvalBytes);
    expect(() =>
      decodeDeviceTransferApproval(
        new Uint8Array([...prepared.approvalBytes, 0]),
      )
    ).toThrow("trailing bytes");
    expect(() =>
      serializeDeviceTransferApproval({
        ...prepared.approval,
        unexpected: true,
      } as never)
    ).toThrow("unknown field");
    const { inventoryDigest: _omitted, ...missingRequired } =
      prepared.approval;
    expect(() =>
      serializeDeviceTransferApproval(missingRequired as never)
    ).toThrow("missing required field inventoryDigest");
    expect(() =>
      serializeDeviceTransferApproval({
        ...prepared.approval,
        packages: [{
          ...prepared.approval.packages[0]!,
          unexpected: true,
        } as never, ...prepared.approval.packages.slice(1)],
      })
    ).toThrow("unknown field");
  });

  test("validates every approval, package, and join field at the serialization boundary", async () => {
    const state = await setup();
    const prepared = await state.prepare();
    const approval = prepared.approval;
    const firstPackage = approval.packages[0]!;
    const serialize = (overrides: Record<string, unknown>) =>
      serializeDeviceTransferApproval({
        ...approval,
        ...overrides,
      } as never);
    for (const value of [null, "approval"]) {
      expectExactError(
        () => serializeDeviceTransferApproval(value as never),
        "Device transfer approval must be an object",
      );
    }
    expectExactError(
      () => serialize({ unexpected: true }),
      "Device transfer approval contains unknown field unexpected",
    );
    expectExactError(
      () => serialize({ formatVersion: 1 }),
      "Device transfer approval version is unsupported",
    );
    expectExactError(
      () => serialize({ encryptionPublicKeyDigest: bytes(1, 31) }),
      "Device transfer approval encryption-key digest must contain exactly 32 bytes",
    );
    expectExactError(
      () => serialize({ signingPublicKeyDigest: bytes(1, 31) }),
      "Device transfer approval signing-key digest must contain exactly 32 bytes",
    );
    expectExactError(
      () => serialize({ inventoryCount: V2_LIMITS.recoveryPackages + 1 }),
      `Device transfer approval inventory count exceeds the ${V2_LIMITS.recoveryPackages} limit`,
    );
    expectExactError(
      () => serialize({ inventoryDigest: bytes(1, 31) }),
      "Device transfer approval inventory digest must contain exactly 32 bytes",
    );
    expectExactError(
      () => serialize({ packages: null }),
      "Device transfer packages must be an array",
    );
    expectExactError(
      () =>
        serialize({
          inventoryCount: V2_LIMITS.recoveryPackages,
          packages: Array.from(
            { length: V2_LIMITS.recoveryPackages + 1 },
            () => firstPackage,
          ),
        }),
      `Device transfer package count exceeds the ${V2_LIMITS.recoveryPackages} limit`,
    );
    expect(() => serialize({
      inventoryCount: 0,
      packages: [],
      joinIntents: [],
    })).not.toThrow();
    expectExactError(
      () => serialize({ inventoryCount: 1 }),
      "Device transfer approval package count does not match inventory commitment",
    );
    expectExactError(
      () => serialize({ joinIntents: null }),
      "Device transfer join intents must be an array",
    );
    expectExactError(
      () =>
        serialize({
          joinIntents: Array.from(
            { length: V2_LIMITS.recoveryPackages + 1 },
            () => approval.joinIntents[0]!,
          ),
        }),
      `Device transfer join count exceeds the ${V2_LIMITS.recoveryPackages} limit`,
    );
    for (const value of [null, "package"]) {
      expectExactError(
        () =>
          serialize({
            inventoryCount: 1,
            packages: [value],
          }),
        "Device transfer package must be an object",
      );
    }
    const withPackage = (changes: Record<string, unknown>) =>
      serialize({
        packages: [{ ...firstPackage, ...changes }],
        inventoryCount: 1,
      });
    expectExactError(
      () => withPackage({ unexpected: true }),
      "Device transfer package contains unknown field unexpected",
    );
    expectExactError(
      () => withPackage({ formatVersion: 1 }),
      "Device transfer package version is unsupported",
    );
    expectExactError(
      () => withPackage({ encryptionPublicKeyDigest: bytes(1, 31) }),
      "Device transfer encryption-key digest must contain exactly 32 bytes",
    );
    expectExactError(
      () => withPackage({ signingPublicKeyDigest: bytes(1, 31) }),
      "Device transfer signing-key digest must contain exactly 32 bytes",
    );
    expectExactError(
      () => withPackage({ bindingHash: bytes(1, 31) }),
      "Device transfer binding hash must contain exactly 32 bytes",
    );
    for (const ciphertext of [
      "ciphertext",
      new Uint8Array(),
      new Uint8Array(V2_LIMITS.ciphertextBytes + 1),
    ]) {
      expectExactError(
        () => withPackage({ ciphertext }),
        "Device transfer ciphertext exceeds format limits",
      );
    }
    expect(() =>
      withPackage({ ciphertext: new Uint8Array([1]) })
    ).not.toThrow();
    const maximumCiphertextWire = withPackage({
      ciphertext: new Uint8Array(V2_LIMITS.ciphertextBytes),
    });
    expect(() =>
      decodeDeviceTransferApproval(maximumCiphertextWire)
    ).not.toThrow();

    for (const changes of [
      { humanId: humanId("human_other") },
      { targetDeviceId: cryptoDeviceId("device_other") },
      { pendingDeviceRevision: pendingDeviceRevision(8) },
      { issuerDeviceId: cryptoDeviceId("device_other") },
      { createdAt: unixTimestamp(Number(state.createdAt) + 1) },
      { encryptionPublicKeyDigest: bytes(0xee) },
      { signingPublicKeyDigest: bytes(0xee) },
    ]) {
      expectExactError(
        () => withPackage(changes),
        "Device transfer package is detached from its approval",
      );
    }
    expectExactError(
      () =>
        serialize({
          packages: [firstPackage, firstPackage],
          inventoryCount: 2,
        }),
      "Device transfer packages must be unique and canonical",
    );
    const namespaceA = {
      ...firstPackage,
      namespaceId: namespaceId("namespace_a"),
      keyClass: "human" as const,
    };
    const namespaceZ = {
      ...firstPackage,
      namespaceId: namespaceId("namespace_z"),
      keyClass: "human" as const,
    };
    expect(() =>
      serialize({
        packages: [namespaceA, namespaceZ],
        inventoryCount: 2,
      })
    ).not.toThrow();

    const firstJoin = approval.joinIntents[0]!;
    for (const value of [null, "join"]) {
      expectExactError(
        () => serialize({ joinIntents: [value] }),
        "Device transfer join intent must be an object",
      );
    }
    const withJoin = (changes: Record<string, unknown>) =>
      serialize({ joinIntents: [{ ...firstJoin, ...changes }] });
    expectExactError(
      () => withJoin({ unexpected: true }),
      "Device transfer join intent contains unknown field unexpected",
    );
    expectExactError(
      () => withJoin({ formatVersion: 1 }),
      "Device transfer join version is unsupported",
    );
    for (const changes of [
      { humanId: humanId("human_other") },
      { targetDeviceId: cryptoDeviceId("device_other") },
      { pendingDeviceRevision: pendingDeviceRevision(8) },
      { committerDeviceId: cryptoDeviceId("device_other") },
    ]) {
      expectExactError(
        () => withJoin(changes),
        "Device transfer join intents must be exact, unique, and canonical",
      );
    }
    expectExactError(
      () => serialize({ joinIntents: [firstJoin, firstJoin] }),
      "Device transfer join intents must be exact, unique, and canonical",
    );
    const domainA = { ...firstJoin, domainId: cryptoDomainId("domain_a") };
    const domainZ = { ...firstJoin, domainId: cryptoDomainId("domain_z") };
    expect(() =>
      serialize({ joinIntents: [domainA, domainZ] })
    ).not.toThrow();
    expectExactError(
      () => serialize({ joinIntents: [domainZ, domainA] }),
      "Device transfer join intents must be exact, unique, and canonical",
    );
    expectExactError(
      () => serialize({ signature: bytes(1, 63) }),
      "Device transfer approval signature must contain exactly 64 bytes",
    );

    const aad = deviceTransferPackageAad(firstPackage);
    expect(aad.length).toBeGreaterThan(0);
    expect(deviceTransferPackageAad(firstPackage)).toEqual(aad);
    expect(deviceTransferPackageAad({
      ...firstPackage,
      namespaceId: namespaceId("namespace_other"),
    })).not.toEqual(aad);
    expect(() =>
      assertDeviceTransferApprovalWireLengthV2(
        V2_LIMITS.recoveryArchiveBytes,
      )
    ).not.toThrow();
    expectExactError(
      () =>
        assertDeviceTransferApprovalWireLengthV2(
          V2_LIMITS.recoveryArchiveBytes + 1,
        ),
      "Device transfer approval exceeds the 64 MiB aggregate-byte limit",
    );
  });

  test("rejects exact wire domains, kinds, and aggregate limits while accepting the inclusive ceiling", async () => {
    const state = await setup();
    const prepared = await state.prepare();
    expectExactError(
      () => decodeDeviceTransferApproval(null as never),
      "Device transfer approval exceeds the 64 MiB aggregate-byte limit",
    );
    expectExactError(
      () =>
        decodeDeviceTransferApproval(
          new LengthSpoofedBytes(V2_LIMITS.recoveryArchiveBytes + 1),
        ),
      "Device transfer approval exceeds the 64 MiB aggregate-byte limit",
    );
    try {
      decodeDeviceTransferApproval(
        new LengthSpoofedBytes(V2_LIMITS.recoveryArchiveBytes),
      );
    } catch (error) {
      expect((error as Error).message).not.toBe(
        "Device transfer approval exceeds the 64 MiB aggregate-byte limit",
      );
    }
    for (const [text, message] of [
      [
        DEVICE_TRANSFER_APPROVAL_DOMAIN,
        "Device transfer approval domain is unsupported",
      ],
      ["approval", "Device transfer approval kind is unsupported"],
      [
        DEVICE_TRANSFER_KEYRING_DOMAIN,
        "Device transfer package domain is unsupported",
      ],
      ["current-domain-join", "Device transfer join kind is unsupported"],
    ] as const) {
      expectExactError(
        () =>
          decodeDeviceTransferApproval(
            mutateFramedText(prepared.approvalBytes, text),
          ),
        message,
      );
    }
    expectExactError(
      () =>
        decodeDeviceTransferApproval(
          mutateFramedText(
            prepared.approvalBytes,
            DEVICE_TRANSFER_APPROVAL_DOMAIN,
            1,
          ),
        ),
      "Device transfer approval domain is unsupported",
    );
  });

  test("binds the exact pending Human, device revision, and both public keys before HPKE", async () => {
    const state = await setup();
    const wrongEncryption = await state.crypto.generateEncryptionKeyPair();
    expect(state.prepare({
      pendingDevice: {
        ...state.pendingDevice,
        encryptionPublicKey: wrongEncryption.publicKey,
      },
    })).rejects.toThrow("trusted pending device");
    expect(state.crypto.sealCalls).toBe(0);

    expect(state.prepare({
      pendingDevice: {
        ...state.pendingDevice,
        pendingDeviceRevision: pendingDeviceRevision(8),
      },
    })).rejects.toThrow("trusted pending device");
    expect(state.crypto.sealCalls).toBe(0);

    expect(state.prepare({
      pendingDevice: {
        ...state.pendingDevice,
        unexpected: true,
      } as never,
    })).rejects.toThrow("unknown field");
    expect(state.crypto.sealCalls).toBe(0);
  });

  test("requires a current authorized approver and live current-Domain committer", async () => {
    const state = await setup();
    expect(state.prepare({
      resolveCurrentApprover: () => null,
    })).rejects.toThrow("not currently authorized");
    expect(state.crypto.sealCalls).toBe(0);

    expect(state.prepare({
      resolveCurrentDomainCommitter: () => null,
    })).rejects.toThrow("not currently authorized");
    expect(state.crypto.sealCalls).toBe(0);

    const other = state.crypto.generateSigningKeyPair();
    expect(state.prepare({
      resolveCurrentDomainCommitter: () => other.publicKey,
    })).rejects.toThrow("does not match");
    expect(state.crypto.sealCalls).toBe(0);
  });

  test("passes exact frozen authority contexts to both current-authority resolvers", async () => {
    const state = await setup();
    const approverContexts: unknown[] = [];
    const domainContexts: unknown[] = [];
    await state.prepare({
      resolveCurrentApprover: (context) => {
        approverContexts.push(context);
        return state.issuerSigning.publicKey;
      },
      resolveCurrentDomainCommitter: (context) => {
        domainContexts.push(context);
        return state.issuerSigning.publicKey;
      },
    });
    expect(approverContexts).toEqual([{
      purpose: "device-transfer-publish",
      humanId: state.targetHumanId,
      targetDeviceId: state.targetDeviceId,
      pendingDeviceRevision: state.revision,
      issuerDeviceId: state.issuerDeviceId,
      createdAt: state.createdAt,
    }]);
    expect(Object.isFrozen(approverContexts[0])).toBe(true);
    expect(domainContexts).toHaveLength(1);
    expect(domainContexts[0]).toEqual({
      purpose: "device-transfer-domain-join",
      formatVersion: 2,
      humanId: state.targetHumanId,
      targetDeviceId: state.targetDeviceId,
      pendingDeviceRevision: state.revision,
      domainId: cryptoDomainId("domain_ab"),
      domainEpoch: domainEpoch(3),
      committerDeviceId: state.issuerDeviceId,
    });
    expect(Object.isFrozen(domainContexts[0])).toBe(true);
  });

  test("mutation contract: transfer publication binds exact authorities, opened keyrings, ordering, and HPKE size", async () => {
    const state = await setup();
    expect(await rejectedMessage(() =>
      state.prepare({ issuerSigningPrivateKey: bytes(1, 31) })
    )).toBe(
      "Device transfer issuer signing private key must contain exactly 32 bytes",
    );
    expect(await rejectedMessage(() =>
      state.prepare({
        resolveCurrentApprover: () => bytes(1, 31),
      })
    )).toBe(
      "Device transfer approver signing public key must contain exactly 32 bytes",
    );
    expect(await rejectedMessage(() =>
      state.prepare({
        resolveCurrentDomainCommitter: () => null,
      })
    )).toBe(
      "Device transfer current Domain committer is not currently authorized",
    );
    expect(await rejectedMessage(() =>
      state.prepare({
        resolveCurrentDomainCommitter: () => bytes(1, 31),
      })
    )).toBe(
      "Device transfer current Domain committer must contain exactly 32 bytes",
    );
    expect(await rejectedMessage(() =>
      state.prepare({
        resolveCurrentDomainCommitter: () =>
          state.pendingSigning.publicKey,
      })
    )).toBe(
      "Device transfer current Domain committer does not match the approving device",
    );
    expect(await rejectedMessage(() =>
      state.prepare({
        issuerSigningPrivateKey: state.pendingSigning.privateKey,
      })
    )).toBe(
      "Device transfer issuer private key does not match current authority",
    );

    const keyringTransforms: readonly ((
      keyring: NamespaceKeyringPlaintextV2,
    ) => NamespaceKeyringPlaintextV2)[] = [
      (keyring) => ({
        ...keyring,
        namespaceId: namespaceId("namespace_other"),
      }),
      (keyring) => ({
        ...keyring,
        keyClass: keyring.keyClass === "ai" ? "human" : "ai",
      }),
      (keyring) => ({
        ...keyring,
        accessRevision: accessRevision(
          Number(keyring.accessRevision) + 1,
        ),
      }),
      (keyring) => ({
        ...keyring,
        currentGeneration: namespaceGeneration(2),
        generations: [
          ...keyring.generations,
          { generation: namespaceGeneration(2), key: bytes(0xac) },
        ],
      }),
    ];
    for (const transform of keyringTransforms) {
      state.crypto.aeadOpenPlaintextTransform = (plaintext) =>
        encodeNamespaceKeyring(
          transform(decodeNamespaceKeyring(plaintext)),
        );
      expect(await rejectedMessage(() => state.prepare())).toBe(
        "Namespace keyring inner and outer metadata do not match",
      );
    }
    state.crypto.aeadOpenPlaintextTransform = null;

    state.crypto.sealLengthDelta = 1;
    expect(await rejectedMessage(() => state.prepare())).toBe(
      "Device transfer HPKE ciphertext is noncanonical",
    );
    state.crypto.sealLengthDelta = 0;

    const extra = trustedHeadFixture(state, {
      namespace: "namespace_a",
      domain: "domain_z",
    });
    const extraSource: DeviceTransferKeyringSourceV2 = {
      authorizedHumanId: state.targetHumanId,
      trustedNamespaceHead: extra.head,
      keyClass: "human",
      currentKeyringEnvelope: extra.humanEnvelope,
      currentDomainRoot: extra.humanRoot,
      resolveHistoricalCommitter: () =>
        state.issuerSigning.publicKey,
    };
    const expandedSources = [
      extraSource,
      ...state.sources,
    ];
    const expandedInventory = expandedSources.map((source) => ({
      authorizedHumanId: source.authorizedHumanId,
      trustedNamespaceHead: source.trustedNamespaceHead,
      keyClass: source.keyClass,
    }));
    const expandedDigest = deviceTransferInventoryDigestV2({
      humanId: state.targetHumanId,
      inventoryRevision: state.inventoryRevision,
      inventory: expandedInventory,
    });
    const prepared = await state.prepare({
      sources: expandedSources,
      resolveTrustedInventoryCommitment: () => ({
        humanId: state.targetHumanId,
        inventoryRevision: state.inventoryRevision,
        inventoryCount: expandedInventory.length,
        inventoryDigest: expandedDigest,
      }),
    });
    expect(prepared.approval.joinIntents.map((intent) => intent.domainId))
      .toEqual([
        cryptoDomainId("domain_ab"),
        cryptoDomainId("domain_z"),
      ]);
  });

  test("mutation contract: transfer publication detaches every public byte inventory and provider result", async () => {
    const state = await setup();
    const sealOutputOffset = state.crypto.sealOutputs.length;
    state.crypto.reuseSignOutput = true;
    const prepared = await state.prepare();
    const [aiPackage, humanPackage] = prepared.approval.packages;
    expect(aiPackage).toBeDefined();
    expect(humanPackage).toBeDefined();

    expect(aiPackage!.encryptionPublicKeyDigest)
      .not.toBe(humanPackage!.encryptionPublicKeyDigest);
    expect(aiPackage!.signingPublicKeyDigest)
      .not.toBe(humanPackage!.signingPublicKeyDigest);
    expect(aiPackage!.bindingHash)
      .not.toBe(state.trustedHead.bindingHash);
    expect(prepared.approval.encryptionPublicKeyDigest)
      .not.toBe(
        prepared.activationCas
          .expectedPendingEncryptionPublicKeyDigest,
      );
    expect(prepared.approval.signingPublicKeyDigest)
      .not.toBe(
        prepared.activationCas
          .expectedPendingSigningPublicKeyDigest,
      );
    expect(prepared.approval.inventoryDigest)
      .not.toBe(prepared.activationCas.expectedInventoryDigest);

    const rawSealed = state.crypto.sealOutputs.slice(
      sealOutputOffset,
    );
    expect(rawSealed).toHaveLength(2);
    expect(aiPackage!.ciphertext).not.toBe(rawSealed[0]);
    const expectedCiphertext = aiPackage!.ciphertext.slice();
    rawSealed[0]!.fill(0);
    expect(aiPackage!.ciphertext).toEqual(expectedCiphertext);

    const expectedSignature = prepared.approval.signature.slice();
    state.crypto.sign(state.issuerSigning.privateKey, bytes(0xee));
    expect(prepared.approval.signature).toEqual(expectedSignature);
  });

  test("mutation contract: transfer publication wipes every opened keyring key", async () => {
    const state = await setup();
    const originalFill = Uint8Array.prototype.fill;
    const keyWipes: {
      readonly value: Uint8Array;
      readonly before: Uint8Array;
      readonly stack: string;
    }[] = [];
    Uint8Array.prototype.fill = function (
      value: number,
      start?: number,
      end?: number,
    ): Uint8Array {
      const stack = new Error().stack ?? "";
      if (
        value === 0
        && stack.includes("prepareDeviceTransferV2")
        && this.length === 32
      ) {
        keyWipes.push({ value: this, before: this.slice(), stack });
      }
      return originalFill.call(this, value, start, end);
    };
    try {
      await state.prepare();
    } finally {
      Uint8Array.prototype.fill = originalFill;
    }
    const directKeyWipes = keyWipes.filter(({ stack }) =>
      stack.split("\n").slice(0, 4).some((line) =>
        line.includes("device-transfer-workflow-v2.ts")
      )
    );
    for (const marker of [0x11, 0x12, 0x21, 0x22]) {
      const wipe = directKeyWipes.find(({ before }) =>
        before.every((byte) => byte === marker)
      );
      expect(wipe).toBeDefined();
      expect(allZero(wipe!.value)).toBe(true);
    }
  });

  test("wipes both intermediate keyring encodings after package plaintext construction", async () => {
    const state = await setup();
    const originalFill = Uint8Array.prototype.fill;
    const packagePlaintextBuffers: Uint8Array[] = [];
    Uint8Array.prototype.fill = function (
      value: number,
      start?: number,
      end?: number,
    ): Uint8Array {
      if (
        value === 0
        && new Error().stack?.includes("packagePlaintext")
      ) {
        packagePlaintextBuffers.push(this);
      }
      return originalFill.call(this, value, start, end);
    };
    try {
      await state.prepare();
    } finally {
      Uint8Array.prototype.fill = originalFill;
    }
    expect(packagePlaintextBuffers).toHaveLength(8);
    expect(packagePlaintextBuffers.every(allZero)).toBe(true);
  });

  test("rejects signature, current-authority, target-key, inventory, and ciphertext substitution", async () => {
    const state = await setup();
    const prepared = await state.prepare();
    const staleApproverCalls = state.crypto.openCalls;
    expect(state.open(prepared.approvalBytes, {
      resolveCurrentApprover: () => null,
    })).rejects.toThrow("approver is not currently authorized");
    expect(state.crypto.openCalls).toBe(staleApproverCalls);

    const missingInventory = state.expectedInventory.slice(0, 1);
    expect(state.open(prepared.approvalBytes, {
      expectedInventory: missingInventory,
    })).rejects.toThrow("missing or adds unauthorized");
    expect(state.crypto.openCalls).toBe(staleApproverCalls);

    const tampered = decodeDeviceTransferApproval(prepared.approvalBytes);
    const changedCiphertext = tampered.packages[0]!.ciphertext.slice();
    const lastCiphertextIndex = changedCiphertext.length - 1;
    changedCiphertext[lastCiphertextIndex] =
      changedCiphertext[lastCiphertextIndex]! ^ 1;
    const tamperedBytes = serializeDeviceTransferApproval({
      ...tampered,
      packages: [
        { ...tampered.packages[0]!, ciphertext: changedCiphertext },
        ...tampered.packages.slice(1),
      ],
    });
    expect(state.open(tamperedBytes)).rejects.toThrow(
      "current authorized-device signature",
    );
    expect(state.crypto.openCalls).toBe(staleApproverCalls);

    const wrongPrivate = await state.crypto.generateEncryptionKeyPair();
    expect(state.open(prepared.approvalBytes, {
      pendingEncryptionPrivateKey: wrongPrivate.privateKey,
    })).rejects.toThrow("failed to decrypt");
  });

  test("mutation contract: transfer open validates every pending, package, join, and current-authority coordinate", async () => {
    const state = await setup();
    const prepared = await state.prepare();
    const approval =
      decodeDeviceTransferApproval(prepared.approvalBytes);

    expect(await rejectedMessage(() =>
      state.open("approval" as never)
    )).toBe("Device transfer approval bytes must be bytes");
    expect(await rejectedMessage(() =>
      state.open(prepared.approvalBytes, {
        pendingEncryptionPrivateKey: bytes(1, 31),
      })
    )).toBe(
      "Pending device encryption private key must contain exactly 32 bytes",
    );

    const alternateEncryption =
      await state.crypto.generateEncryptionKeyPair();
    const alternateSigning = state.crypto.generateSigningKeyPair();
    const pendingCases = [
      {
        pendingDevice: {
          ...state.pendingDevice,
          humanId: humanId("human_other"),
        },
        expectedInventory: state.expectedInventory.map((item) => ({
          ...item,
          authorizedHumanId: humanId("human_other"),
        })),
      },
      {
        pendingDevice: {
          ...state.pendingDevice,
          deviceId: cryptoDeviceId("device_other"),
        },
      },
      {
        pendingDevice: {
          ...state.pendingDevice,
          pendingDeviceRevision: pendingDeviceRevision(8),
        },
      },
      {
        pendingDevice: {
          ...state.pendingDevice,
          encryptionPublicKey: alternateEncryption.publicKey,
        },
      },
      {
        pendingDevice: {
          ...state.pendingDevice,
          signingPublicKey: alternateSigning.publicKey,
        },
      },
    ];
    for (const overrides of pendingCases) {
      expect(await rejectedMessage(() =>
        state.open(prepared.approvalBytes, overrides)
      )).toBe(
        "Device transfer approval targets another pending device",
      );
    }

    const firstPackage = approval.packages[0]!;
    const packageCases: readonly Record<string, unknown>[] = [
      { namespaceId: namespaceId("namespace_a") },
      { domainId: cryptoDomainId("domain_other") },
      { domainEpoch: domainEpoch(Number(firstPackage.domainEpoch) + 1) },
      {
        accessRevision: accessRevision(
          Number(firstPackage.accessRevision) + 1,
        ),
      },
      {
        currentGeneration: namespaceGeneration(
          Number(firstPackage.currentGeneration) + 1,
        ),
      },
      { bindingHash: bytes(0xb1) },
    ];
    for (const changes of packageCases) {
      const bytesWithPackage = serializeDeviceTransferApproval({
        ...approval,
        packages: [
          { ...firstPackage, ...changes } as never,
          ...approval.packages.slice(1),
        ],
      });
      expect(await rejectedMessage(() =>
        state.open(bytesWithPackage)
      )).toBe(
        "Device transfer package is outside the authorized inventory",
      );
    }

    const singleSource = [state.sources[0]!];
    const singleInventory = [state.expectedInventory[0]!];
    const singleDigest = deviceTransferInventoryDigestV2({
      humanId: state.targetHumanId,
      inventoryRevision: state.inventoryRevision,
      inventory: singleInventory,
    });
    const singlePrepared = await state.prepare({
      sources: singleSource,
      resolveTrustedInventoryCommitment: () => ({
        humanId: state.targetHumanId,
        inventoryRevision: state.inventoryRevision,
        inventoryCount: 1,
        inventoryDigest: singleDigest,
      }),
    });
    expect(await rejectedMessage(() =>
      state.open(singlePrepared.approvalBytes, {
        expectedInventory: [{
          ...singleInventory[0]!,
          keyClass: "ai",
        }],
      })
    )).toBe(
      "Device transfer package is outside the authorized inventory",
    );

    const missingJoin = serializeDeviceTransferApproval({
      ...approval,
      joinIntents: [],
    });
    expect(await rejectedMessage(() => state.open(missingJoin))).toBe(
      "Device transfer current-Domain join inventory is incomplete",
    );
    const staleJoin = serializeDeviceTransferApproval({
      ...approval,
      joinIntents: [{
        ...approval.joinIntents[0]!,
        domainEpoch: domainEpoch(
          Number(approval.joinIntents[0]!.domainEpoch) + 1,
        ),
      }],
    });
    expect(await rejectedMessage(() => state.open(staleJoin))).toBe(
      "Device transfer current-Domain join intent is stale",
    );

    expect(await rejectedMessage(() =>
      state.open(prepared.approvalBytes, {
        resolveCurrentApprover: () => null,
      })
    )).toBe(
      "Device transfer approver is not currently authorized",
    );
    for (const [resolver, message] of [
      [
        () => null,
        "Device transfer current Domain committer is not currently authorized",
      ],
      [
        () => bytes(1, 31),
        "Device transfer current Domain committer must contain exactly 32 bytes",
      ],
      [
        () => state.pendingSigning.publicKey,
        "Device transfer current Domain committer does not match the approving device",
      ],
    ] as const) {
      expect(await rejectedMessage(() =>
        state.open(prepared.approvalBytes, {
          resolveCurrentDomainCommitter: resolver,
        })
      )).toBe(message);
    }

    const unsignedStale = {
      ...approval,
      inventoryDigest: bytes(0xc1),
      signature: new Uint8Array(V2_LIMITS.signatureBytes),
    };
    const staleInventory = serializeDeviceTransferApproval({
      ...unsignedStale,
      signature: state.crypto.sign(
        state.issuerSigning.privateKey,
        deviceTransferApprovalSigningBytes(unsignedStale),
      ),
    });
    expect(await rejectedMessage(() =>
      state.open(staleInventory)
    )).toBe(
      "Device transfer approval uses a stale inventory commitment",
    );

    const approverContexts: unknown[] = [];
    const domainContexts: unknown[] = [];
    await state.open(prepared.approvalBytes, {
      resolveCurrentApprover: (context) => {
        approverContexts.push(context);
        return state.issuerSigning.publicKey;
      },
      resolveCurrentDomainCommitter: (context) => {
        domainContexts.push(context);
        return state.issuerSigning.publicKey;
      },
    });
    expect(approverContexts).toEqual([{
      purpose: "device-transfer-open",
      humanId: state.targetHumanId,
      targetDeviceId: state.targetDeviceId,
      pendingDeviceRevision: state.revision,
      issuerDeviceId: state.issuerDeviceId,
      createdAt: state.createdAt,
    }]);
    expect(domainContexts).toEqual([{
      ...approval.joinIntents[0],
      purpose: "device-transfer-domain-join",
    }]);
  });

  test("transfer open independently binds embedded metadata and every inner keyring coordinate", async () => {
    const state = await setup();
    const prepared = await state.prepare();
    state.crypto.openPlaintextTransform = (plaintext) =>
      mutateFramedText(plaintext, "namespace_room");
    expect(await rejectedMessage(() =>
      state.open(prepared.approvalBytes)
    )).toBe("Device transfer embedded and outer metadata do not match");

    const transforms: readonly ((
      keyring: NamespaceKeyringPlaintextV2,
    ) => NamespaceKeyringPlaintextV2)[] = [
      (keyring) => ({
        ...keyring,
        namespaceId: namespaceId("namespace_other"),
      }),
      (keyring) => ({
        ...keyring,
        keyClass: keyring.keyClass === "ai" ? "human" : "ai",
      }),
      (keyring) => ({
        ...keyring,
        accessRevision: accessRevision(Number(keyring.accessRevision) + 1),
      }),
      (keyring) => ({
        ...keyring,
        currentGeneration: namespaceGeneration(2),
        generations: [
          ...keyring.generations,
          { generation: namespaceGeneration(2), key: bytes(0xac) },
        ],
      }),
    ];
    for (const transform of transforms) {
      state.crypto.openPlaintextTransform = (plaintext) => {
        const reader = new StrictDecoder(plaintext);
        try {
          const embedded = reader.readFrame(MAX_METADATA_BYTES);
          const keyringBytes = reader.readFrame(
            V2_LIMITS.namespaceKeyringBytes,
          );
          reader.assertFinished();
          return concatV2(
            frame(embedded),
            frame(encodeNamespaceKeyring(
              transform(decodeNamespaceKeyring(keyringBytes)),
            )),
          );
        } finally {
          reader.destroy(true);
        }
      };
      expect(await rejectedMessage(() =>
        state.open(prepared.approvalBytes)
      )).toBe("Device transfer inner keyring does not match its package");
    }
    state.crypto.openPlaintextTransform = null;
  });

  test("wipes decoded keys and the decoder-owned plaintext after an inner keyring mismatch", async () => {
    const state = await setup();
    const prepared = await state.prepare();
    state.crypto.openPlaintextTransform = (plaintext) => {
      const reader = new StrictDecoder(plaintext);
      try {
        const embedded = reader.readFrame(MAX_METADATA_BYTES);
        const keyringBytes = reader.readFrame(
          V2_LIMITS.namespaceKeyringBytes,
        );
        reader.assertFinished();
        const keyring = decodeNamespaceKeyring(keyringBytes);
        return concatV2(
          frame(embedded),
          frame(encodeNamespaceKeyring({
            ...keyring,
            namespaceId: namespaceId("namespace_other"),
          })),
        );
      } finally {
        reader.destroy(true);
      }
    };

    const originalFill = Uint8Array.prototype.fill;
    const wipes: {
      readonly value: Uint8Array;
      readonly before: Uint8Array;
      readonly stack: string;
    }[] = [];
    Uint8Array.prototype.fill = function (
      value: number,
      start?: number,
      end?: number,
    ): Uint8Array {
      const stack = new Error().stack ?? "";
      if (value === 0 && stack.includes("decodePackagePlaintext")) {
        wipes.push({ value: this, before: this.slice(), stack });
      }
      return originalFill.call(this, value, start, end);
    };
    try {
      expect(await rejectedMessage(() =>
        state.open(prepared.approvalBytes)
      )).toBe("Device transfer inner keyring does not match its package");
    } finally {
      Uint8Array.prototype.fill = originalFill;
    }

    for (const marker of [0x21, 0x22]) {
      const keyWipes = wipes.filter(({ before }) =>
        before.length === 32 && before.every((byte) => byte === marker)
      );
      expect(keyWipes).toHaveLength(2);
      expect(keyWipes.every(({ value }) => allZero(value))).toBe(true);
    }
    const secretRun = new Uint8Array(32).fill(0x21);
    const decoderPlaintextWipes = wipes.filter(({ before, stack }) =>
      Buffer.from(before).indexOf(Buffer.from(secretRun)) >= 0
      && stack.includes("at destroy (")
      && stack.split("\n")[3]?.includes("decodePackagePlaintext")
    );
    expect(decoderPlaintextWipes).toHaveLength(1);
    expect(decoderPlaintextWipes.every(({ value }) => allZero(value)))
      .toBe(true);
  });

  test("mutation contract: transfer open returns exact detached keys and wipes decoded and partial results", async () => {
    const state = await setup();
    const prepared = await state.prepare();
    const opened = await state.open(prepared.approvalBytes);
    expect(opened.keyrings).toHaveLength(2);
    expect(opened.keyrings[0]).toEqual({
      formatVersion: 2,
      namespaceId: namespaceId("namespace_room"),
      keyClass: "ai",
      accessRevision: accessRevision(0),
      currentGeneration: namespaceGeneration(1),
      generations: [
        { generation: namespaceGeneration(0), key: bytes(0x21) },
        { generation: namespaceGeneration(1), key: bytes(0x22) },
      ],
    });
    expect(opened.keyrings[1]).toEqual({
      formatVersion: 2,
      namespaceId: namespaceId("namespace_room"),
      keyClass: "human",
      accessRevision: accessRevision(0),
      currentGeneration: namespaceGeneration(1),
      generations: [
        { generation: namespaceGeneration(0), key: bytes(0x11) },
        { generation: namespaceGeneration(1), key: bytes(0x12) },
      ],
    });
    expect(opened.keyrings[0]!.generations[0]!.key)
      .not.toBe(state.ai.generations[0]!.key);

    const malformed = await setup();
    const malformedPrepared = await malformed.prepare();
    malformed.crypto.openPlaintextTransform = () =>
      new Uint8Array([0]);
    expect(
      malformed.open(malformedPrepared.approvalBytes),
    ).rejects.toThrow(CanonicalDecodingError);

    const failing = await setup();
    const failingPrepared = await failing.prepare();
    const originalFill = Uint8Array.prototype.fill;
    const wipes: {
      readonly value: Uint8Array;
      readonly before: Uint8Array;
      readonly stack: string;
    }[] = [];
    Uint8Array.prototype.fill = function (
      value: number,
      start?: number,
      end?: number,
    ): Uint8Array {
      const stack = new Error().stack ?? "";
      if (
        value === 0
        && this.length === 32
        && stack.includes("openDeviceTransferV2")
      ) {
        wipes.push({
          value: this,
          before: this.slice(),
          stack,
        });
      }
      return originalFill.call(this, value, start, end);
    };
    failing.crypto.nullOpenAt = 2;
    try {
      expect(
        failing.open(failingPrepared.approvalBytes),
      ).rejects.toThrow("Device transfer package failed to decrypt");
    } finally {
      Uint8Array.prototype.fill = originalFill;
    }
    const directWipes = wipes.filter(({ stack }) =>
      stack.split("\n").slice(0, 5).some((line) =>
        line.includes("at openDeviceTransferV2")
      )
    );
    for (const marker of [0x21, 0x22]) {
      const matching = directWipes.filter(({ before }) =>
        before.every((byte) => byte === marker)
      );
      expect(matching).toHaveLength(2);
      expect(matching.every(({ value }) => allZero(value))).toBe(true);
    }
  });

  test("rejects unauthorized and duplicate Namespace/class sources before HPKE", async () => {
    const state = await setup();
    expect(state.prepare({
      sources: [{
        ...state.sources[0]!,
        authorizedHumanId: humanId("human_mallory"),
      }],
    })).rejects.toThrow("unauthorized Namespace");
    expect(state.crypto.sealCalls).toBe(0);

    expect(state.prepare({
      sources: state.sources.slice(0, 1),
    })).rejects.toThrow("authoritative commitment");
    expect(state.crypto.sealCalls).toBe(0);

    expect(state.prepare({
      sources: [state.sources[0]!, state.sources[0]!],
    })).rejects.toThrow("duplicate");
    expect(state.crypto.sealCalls).toBe(0);
  });

  test("enforces the 4,096-package ceiling before HPKE work", async () => {
    const state = await setup();
    let resolverCalls = 0;
    let pendingResolverCalls = 0;
    expect(state.prepare({
      sources: Array.from(
        { length: V2_LIMITS.recoveryPackages + 1 },
        () => state.sources[0]!,
      ),
      resolveCurrentApprover: () => {
        resolverCalls++;
        return state.issuerSigning.publicKey;
      },
      resolveTrustedPendingDevice: () => {
        pendingResolverCalls++;
        return state.trustedPending;
      },
    })).rejects.toThrow("4096");
    expect(resolverCalls).toBe(0);
    expect(pendingResolverCalls).toBe(0);
    expect(state.crypto.sealCalls).toBe(0);
  });

  test("fully validates every nested source capability before any trusted resolver or crypto", async () => {
    const state = await setup();
    let pendingCalls = 0;
    let approverCalls = 0;
    let inventoryCalls = 0;
    const malformedSource = {
      ...state.sources[0]!,
      trustedNamespaceHead: {
        ...state.trustedHead,
        binding: null,
      },
    } as never;
    expect(state.prepare({
      sources: [malformedSource],
      resolveTrustedPendingDevice: () => {
        pendingCalls++;
        return state.trustedPending;
      },
      resolveCurrentApprover: () => {
        approverCalls++;
        return state.issuerSigning.publicKey;
      },
      resolveTrustedInventoryCommitment: () => {
        inventoryCalls++;
        return state.inventoryCommitment;
      },
    })).rejects.toThrow("proof-verifier capability");
    expect({ pendingCalls, approverCalls, inventoryCalls }).toEqual({
      pendingCalls: 0,
      approverCalls: 0,
      inventoryCalls: 0,
    });
    expect(state.crypto.sealCalls).toBe(0);

    const source = state.sources[0]!;
    const mismatchedCiphertext = source.currentKeyringEnvelope.ciphertext.slice();
    mismatchedCiphertext[0] = mismatchedCiphertext[0]! ^ 1;
    const invalidSources = [
      {
        label: "invalid Domain root",
        source: {
          ...source,
          currentDomainRoot: bytes(1, 31),
        } as never,
        error: "32 bytes",
      },
      {
        label: "missing historical authority resolver",
        source: {
          ...source,
          resolveHistoricalCommitter: null,
        } as never,
        error: "historical committer resolver",
      },
      {
        label: "envelope outside the trusted binding",
        source: {
          ...source,
          currentKeyringEnvelope: {
            ...source.currentKeyringEnvelope,
            ciphertext: mismatchedCiphertext,
          },
        } as never,
        error: "does not match the trusted binding",
      },
    ];
    for (const invalid of invalidSources) {
      pendingCalls = 0;
      approverCalls = 0;
      inventoryCalls = 0;
      expect(state.prepare({
        sources: [invalid.source],
        resolveTrustedPendingDevice: () => {
          pendingCalls++;
          return state.trustedPending;
        },
        resolveCurrentApprover: () => {
          approverCalls++;
          return state.issuerSigning.publicKey;
        },
        resolveTrustedInventoryCommitment: () => {
          inventoryCalls++;
          return state.inventoryCommitment;
        },
      }), invalid.label).rejects.toThrow(invalid.error);
      expect(
        { pendingCalls, approverCalls, inventoryCalls },
        invalid.label,
      ).toEqual({
        pendingCalls: 0,
        approverCalls: 0,
        inventoryCalls: 0,
      });
      expect(state.crypto.sealCalls, invalid.label).toBe(0);
    }

    const prepared = await state.prepare();
    pendingCalls = 0;
    inventoryCalls = 0;
    expect(state.open(prepared.approvalBytes, {
      expectedInventory: [{
        ...state.expectedInventory[0]!,
        trustedNamespaceHead: {
          ...state.trustedHead,
          binding: null,
        },
      } as never],
      resolveTrustedPendingDevice: () => {
        pendingCalls++;
        return state.trustedPending;
      },
      resolveTrustedInventoryCommitment: () => {
        inventoryCalls++;
        return state.inventoryCommitment;
      },
    })).rejects.toThrow("proof-verifier capability");
    expect({ pendingCalls, inventoryCalls }).toEqual({
      pendingCalls: 0,
      inventoryCalls: 0,
    });
  });

  test("joins a current Domain that has no retained Namespace keyrings yet", async () => {
    const state = await setup();
    const currentDomains = [{
      domainId: cryptoDomainId("domain_empty"),
      domainEpoch: domainEpoch(0),
    }];
    const inventoryDigest = deviceTransferInventoryDigestV2({
      humanId: state.targetHumanId,
      inventoryRevision: state.inventoryRevision,
      inventory: [],
    });
    const resolveTrustedInventoryCommitment = () => ({
      humanId: state.targetHumanId,
      inventoryRevision: state.inventoryRevision,
      inventoryCount: 0,
      inventoryDigest,
    });
    const prepared = await state.prepare({
      sources: [],
      currentDomains,
      resolveTrustedInventoryCommitment,
    });
    const opened = await state.open(prepared.approvalBytes, {
      expectedInventory: [],
      expectedDomains: currentDomains,
      resolveTrustedInventoryCommitment,
    });

    expect(prepared.approval.packages).toEqual([]);
    expect(prepared.approval.joinIntents).toEqual([{
      formatVersion: 2,
      humanId: state.targetHumanId,
      targetDeviceId: state.targetDeviceId,
      pendingDeviceRevision: state.revision,
      domainId: cryptoDomainId("domain_empty"),
      domainEpoch: domainEpoch(0),
      committerDeviceId: state.issuerDeviceId,
    }]);
    expect(opened.keyrings).toEqual([]);
    expect(opened.joinIntents).toEqual(prepared.approval.joinIntents);
  });

  test("rejects inconsistent current epochs for one Domain before every resolver and crypto path", async () => {
    const state = await setup();
    const human = completeKeyring("namespace_other", "human");
    const ai = completeKeyring("namespace_other", "ai");
    const metadata = {
      domainId: cryptoDomainId("domain_ab"),
      domainEpoch: domainEpoch(4),
      previousBindingHash: null,
      committerDeviceId: state.issuerDeviceId,
    };
    const humanRoot = bytes(0x51);
    const aiRoot = bytes(0x61);
    const humanEnvelope = sealNamespaceKeyring({
      crypto: state.crypto,
      domainRoot: humanRoot,
      keyring: human,
      metadata,
      committerSigningPrivateKey: state.issuerSigning.privateKey,
      resolveCurrentCommitter: () => state.issuerSigning.publicKey,
    });
    const aiEnvelope = sealNamespaceKeyring({
      crypto: state.crypto,
      domainRoot: aiRoot,
      keyring: ai,
      metadata,
      committerSigningPrivateKey: state.issuerSigning.privateKey,
      resolveCurrentCommitter: () => state.issuerSigning.publicKey,
    });
    const binding = createNamespaceBinding({
      crypto: state.crypto,
      humanEnvelope,
      aiEnvelope,
      committerSigningPrivateKey: state.issuerSigning.privateKey,
      resolveCurrentCommitter: () => state.issuerSigning.publicKey,
    });
    const head = verifyNamespaceBindingProof({
      crypto: state.crypto,
      anchor: null,
      proof: [binding],
      resolveHistoricalCommitter: () => state.issuerSigning.publicKey,
    });
    const inconsistentSource: DeviceTransferKeyringSourceV2 = {
      authorizedHumanId: state.targetHumanId,
      trustedNamespaceHead: head,
      keyClass: "human",
      currentKeyringEnvelope: humanEnvelope,
      currentDomainRoot: humanRoot,
      resolveHistoricalCommitter: () => state.issuerSigning.publicKey,
    };
    const inconsistentInventory = [
      state.expectedInventory[0]!,
      {
        authorizedHumanId: state.targetHumanId,
        trustedNamespaceHead: head,
        keyClass: "human" as const,
      },
    ];
    let pendingCalls = 0;
    let authorityCalls = 0;
    let inventoryCalls = 0;
    expect(state.prepare({
      sources: [state.sources[0]!, inconsistentSource],
      resolveTrustedPendingDevice: () => {
        pendingCalls++;
        return state.trustedPending;
      },
      resolveCurrentApprover: () => {
        authorityCalls++;
        return state.issuerSigning.publicKey;
      },
      resolveTrustedInventoryCommitment: () => {
        inventoryCalls++;
        return state.inventoryCommitment;
      },
    })).rejects.toThrow("current Domain epoch");
    expect({ pendingCalls, authorityCalls, inventoryCalls }).toEqual({
      pendingCalls: 0,
      authorityCalls: 0,
      inventoryCalls: 0,
    });

    const prepared = await state.prepare();
    pendingCalls = 0;
    inventoryCalls = 0;
    expect(state.open(prepared.approvalBytes, {
      expectedInventory: inconsistentInventory,
      resolveTrustedPendingDevice: () => {
        pendingCalls++;
        return state.trustedPending;
      },
      resolveTrustedInventoryCommitment: () => {
        inventoryCalls++;
        return state.inventoryCommitment;
      },
    })).rejects.toThrow("current Domain epoch");
    expect({ pendingCalls, inventoryCalls }).toEqual({
      pendingCalls: 0,
      inventoryCalls: 0,
    });

    inventoryCalls = 0;
    expect(() => state.assessReadiness({
      inventory: inconsistentInventory,
      resolveTrustedInventoryCommitment: () => {
        inventoryCalls++;
        return state.inventoryCommitment;
      },
    })).toThrow("current Domain epoch");
    expect(inventoryCalls).toBe(0);
  });

  test("snapshots approval bytes before asynchronous open work", async () => {
    const state = await setup();
    const prepared = await state.prepare();
    const approvalBytes = prepared.approvalBytes.slice();
    const expectedHash = state.crypto.hash(approvalBytes);
    const originalOpen = state.crypto.openSealed.bind(state.crypto);
    let mutated = false;
    state.crypto.openSealed = async (...args) => {
      if (!mutated) {
        mutated = true;
        approvalBytes[0] = approvalBytes[0]! ^ 1;
      }
      return originalOpen(...args);
    };
    const opened = await state.open(approvalBytes);
    expect(opened.activationCas.approvalHash).toEqual(expectedHash);
  });

  test("snapshots and wipes the issuer private key across transfer publication", async () => {
    const state = await setup();
    const issuerSigningPrivateKey = Buffer.from(
      state.issuerSigning.privateKey,
    );
    const originalSeal = state.crypto.sealTo.bind(state.crypto);
    const originalSign = state.crypto.sign.bind(state.crypto);
    let signingSnapshot: Uint8Array | null = null;
    let mutated = false;
    state.crypto.sign = (privateKey, message) => {
      signingSnapshot ??= privateKey;
      return originalSign(privateKey, message);
    };
    state.crypto.sealTo = async (...args) => {
      if (!mutated) {
        mutated = true;
        issuerSigningPrivateKey.fill(0);
      }
      return originalSeal(...args);
    };
    const prepared = await state.prepare({ issuerSigningPrivateKey });
    expect(isZeroized(signingSnapshot)).toBe(true);
    expect(Buffer.isBuffer(signingSnapshot)).toBe(false);
    const opened = await state.open(prepared.approvalBytes);
    expect(opened.keyrings).toHaveLength(2);
  });

  test("snapshots and wipes the pending encryption private key across transfer open", async () => {
    const state = await setup();
    const prepared = await state.prepare();
    const pendingEncryptionPrivateKey = Buffer.from(
      state.pendingEncryption.privateKey,
    );
    const originalOpen = state.crypto.openSealed.bind(state.crypto);
    let privateSnapshot: Uint8Array | null = null;
    let mutated = false;
    state.crypto.openSealed = async (privateKey, ciphertext) => {
      privateSnapshot ??= privateKey;
      if (!mutated) {
        mutated = true;
        pendingEncryptionPrivateKey.fill(0);
      }
      return originalOpen(privateKey, ciphertext);
    };
    const opened = await state.open(prepared.approvalBytes, {
      pendingEncryptionPrivateKey,
    });
    expect(opened.keyrings).toHaveLength(2);
    expect(isZeroized(privateSnapshot)).toBe(true);
    expect(Buffer.isBuffer(privateSnapshot)).toBe(false);
  });

  test("wipes transfer publication and open private snapshots on HPKE failure", async () => {
    const publishState = await setup();
    const originalSign = publishState.crypto.sign.bind(publishState.crypto);
    let signingSnapshot: Uint8Array | null = null;
    publishState.crypto.sign = (privateKey, message) => {
      signingSnapshot ??= privateKey;
      return originalSign(privateKey, message);
    };
    publishState.crypto.sealTo = async () => {
      throw new Error("injected transfer publication failure");
    };
    expect(publishState.prepare()).rejects.toThrow(
      "injected transfer publication failure",
    );
    expect(isZeroized(signingSnapshot)).toBe(true);

    const openState = await setup();
    const prepared = await openState.prepare();
    let privateSnapshot: Uint8Array | null = null;
    openState.crypto.openSealed = async (privateKey) => {
      privateSnapshot = privateKey;
      throw new Error("injected transfer open failure");
    };
    expect(openState.open(prepared.approvalBytes)).rejects.toThrow(
      "injected transfer open failure",
    );
    expect(isZeroized(privateSnapshot)).toBe(true);
  });

});

describe("v2 recovery-only device activation proof", () => {
  test("permits an empty Domain inventory only for MLS rebootstrap possession", async () => {
    const state = await setup();
    const inventoryRevision = deviceTransferInventoryRevision(0);
    const inventoryDigest = deviceTransferInventoryDigestV2({
      humanId: state.targetHumanId,
      inventoryRevision,
      inventory: Object.freeze([]),
    });
    const input = {
      crypto: state.crypto,
      challengeId: "challenge_empty_rebootstrap",
      pendingDevice: state.pendingDevice,
      resolveTrustedPendingDevice: state.resolveTrustedPendingDevice,
      recoveryKeyId: state.recoveryKeyId,
      recoveryGeneration: state.recoveryGeneration,
      recoveryPublicKey: state.recoveryEncryption.publicKey,
      resolveTrustedCurrentRecoveryKey:
        state.resolveTrustedCurrentRecoveryKey,
      recoveryArchiveDigest: state.recoveryArchiveDigest,
      inventoryRevision,
      resolveTrustedInventoryCommitment: () => ({
        humanId: state.targetHumanId,
        inventoryRevision,
        inventoryCount: 0,
        inventoryDigest,
      }),
      issuedAt: unixTimestamp(1_700_000_000_100),
      expiresAt: unixTimestamp(1_700_000_060_100),
    } as const;
    expect(() => prepareRecoveryDeviceActivationChallengeV2(input))
      .toThrow("stale or empty");
    const prepared = await prepareRecoveryDevicePossessionChallengeV2(input);
    expect(prepared.challenge).toMatchObject({
      inventoryRevision: 0,
      inventoryCount: 0,
    });
    expect(prepared.challenge.inventoryDigest).toEqual(inventoryDigest);
  });

  test("proves current recovery-key possession without claiming inventory restoration", async () => {
    const state = await setup();
    const challenge = await state.prepareRecoveryChallenge(
      "challenge_recovery_possession_only",
    );
    const proof = await answerRecoveryDevicePossessionChallengeV2({
      crypto: state.crypto,
      challengeBytes: challenge.challengeBytes,
      pendingDevice: state.pendingDevice,
      resolveTrustedPendingDevice: state.resolveTrustedPendingDevice,
      recoveryPublicKey: state.recoveryEncryption.publicKey,
      recoveryPrivateKey: state.recoveryEncryption.privateKey,
      resolveTrustedCurrentRecoveryKey:
        state.resolveTrustedCurrentRecoveryKey,
      currentTime: unixTimestamp(1_700_000_000_200),
    });
    const verified = verifyRecoveryDevicePossessionProofV2({
      challengeBytes: challenge.challengeBytes,
      proof,
      resolveTrustedChallenge: () => challenge.verifier,
      pendingDevice: state.pendingDevice,
      resolveTrustedPendingDevice: state.resolveTrustedPendingDevice,
      resolveTrustedCurrentRecoveryKey:
        state.resolveTrustedCurrentRecoveryKey,
      currentTime: unixTimestamp(1_700_000_000_300),
    });
    expect(verified.activationCas).toMatchObject({
      deviceId: state.targetDeviceId,
      intendedStatus: "active",
      expectedRecoveryGeneration: state.recoveryGeneration,
    });
    const changed = Uint8Array.from(proof.response);
    changed[0] = changed[0]! ^ 1;
    expect(() => verifyRecoveryDevicePossessionProofV2({
      challengeBytes: challenge.challengeBytes,
      proof: { ...proof, response: changed },
      resolveTrustedChallenge: () => challenge.verifier,
      pendingDevice: state.pendingDevice,
      resolveTrustedPendingDevice: state.resolveTrustedPendingDevice,
      resolveTrustedCurrentRecoveryKey:
        state.resolveTrustedCurrentRecoveryKey,
      currentTime: unixTimestamp(1_700_000_000_300),
    })).toThrow("exact pending challenge");
  });

  test("reconstructs readiness from trusted evidence after object identity is lost", async () => {
    const state = await setup();
    const readiness = structuredClone(state.assessReadiness());
    const challenge = await state.prepareRecoveryChallenge(
      "challenge_recovery_restart",
    );
    expect(state.answerRecoveryChallenge(
      challenge.challengeBytes,
      readiness,
      {
        readinessEvidence: {
          ...state.readinessEvidence,
          restoredKeyrings: structuredClone(state.openedRecoveryKeyrings),
        },
      },
    )).rejects.toThrow(
      "exact successfully opened archive capability",
    );
    const reopenedKeyrings = await openHumanRecoveryArchiveV2({
      crypto: state.crypto,
      archiveBytes: state.publishedRecovery.archiveBytes,
      humanId: state.targetHumanId,
      currentRecoveryKeyId: state.recoveryKeyId,
      currentRecoveryGeneration: state.recoveryGeneration,
      recoveryPrivateKey: state.recoveryEncryption.privateKey,
      resolveTrustedCurrentRecoveryKey:
        state.resolveTrustedCurrentRecoveryKey,
      expectedInventory: state.expectedInventory,
      resolveIssuerDevice: () => state.issuerSigning.publicKey,
    });

    const proof = await state.answerRecoveryChallenge(
      challenge.challengeBytes,
      readiness,
      {
        readinessEvidence: {
          ...state.readinessEvidence,
          restoredKeyrings: reopenedKeyrings,
        },
      },
    );

    expect(proof.readinessDigest).toEqual(
      recoveryReadinessDigest(
        state.recoveryArchiveDigest,
        state.inventoryCommitment,
      ),
    );
  });

  test("proves recovery-key possession and returns one exact activation/consumption CAS", async () => {
    const state = await setup();
    const readiness: RecoveryDeviceReadinessV2 = state.assessReadiness();
    const challenge = await state.prepareRecoveryChallenge(
      "challenge_recovery_device_1",
    );
    const proof = await state.answerRecoveryChallenge(
      challenge.challengeBytes,
      readiness,
    );
    const proofBytes = serializeRecoveryDeviceActivationProof(proof);
    const verified = verifyRecoveryDeviceActivationProofV2({
      challengeBytes: challenge.challengeBytes,
      proofBytes,
      resolveTrustedChallenge: () => challenge.verifier,
      pendingDevice: state.pendingDevice,
      resolveTrustedPendingDevice: state.resolveTrustedPendingDevice,
      resolveTrustedCurrentRecoveryKey:
        state.resolveTrustedCurrentRecoveryKey,
      currentTime: unixTimestamp(1_700_000_000_300),
    });

    expect(RECOVERY_DEVICE_ACTIVATION_DOMAIN).toBe(
      "nautilo/lattice-crypto/recovery-device-activation/v2",
    );
    expect(verified.activationCas).toMatchObject({
      humanId: state.targetHumanId,
      deviceId: state.targetDeviceId,
      expectedStatus: "pending",
      expectedPendingDeviceRevision: state.revision,
      expectedPendingEncryptionPublicKeyDigest:
        state.trustedPending.encryptionPublicKeyDigest,
      expectedPendingSigningPublicKeyDigest:
        state.trustedPending.signingPublicKeyDigest,
      intendedStatus: "active",
      recoveryKeyId: state.recoveryKeyId,
      expectedRecoveryGeneration: state.recoveryGeneration,
      expectedRecoveryPublicKeyDigest:
        state.resolveTrustedCurrentRecoveryKey().publicKeyDigest,
      recoveryArchiveDigest: state.recoveryArchiveDigest,
      challengeId: "challenge_recovery_device_1",
      expectedChallengeStatus: "pending",
      intendedChallengeStatus: "consumed",
      expectedInventoryRevision: state.inventoryRevision,
      expectedInventoryCount: 2,
      expectedInventoryDigest: state.inventoryDigest,
    });
    expect(challenge.publicationCas).toMatchObject({
      challengeId: "challenge_recovery_device_1",
      expectedStatus: "absent",
      intendedStatus: "pending",
      intendedChallengeHash: challenge.verifier.challengeHash,
    });
    expect(Object.keys(challenge.publicationCas)).toEqual([
      "challengeId",
      "expectedStatus",
      "intendedStatus",
      "intendedChallengeHash",
    ]);
    expect(Object.keys(verified.activationCas)).toEqual([
      "humanId",
      "deviceId",
      "expectedStatus",
      "expectedPendingDeviceRevision",
      "expectedPendingEncryptionPublicKeyDigest",
      "expectedPendingSigningPublicKeyDigest",
      "intendedStatus",
      "recoveryKeyId",
      "expectedRecoveryGeneration",
      "expectedRecoveryPublicKeyDigest",
      "recoveryArchiveDigest",
      "expectedInventoryRevision",
      "expectedInventoryCount",
      "expectedInventoryDigest",
      "challengeId",
      "expectedChallengeStatus",
      "intendedChallengeStatus",
      "expectedChallengeHash",
    ]);
    expect(fieldNames(challenge.verifier)).not.toContain("response");
    expect(fieldNames(challenge.verifier)).not.toContain("privateKey");
    expect(state.crypto.sealPlaintexts.every(allZero)).toBe(true);
    expect(state.crypto.openPlaintexts.every(allZero)).toBe(true);
  });

  test("mutation contract: activation answer validates every direct and trusted-state coordinate", async () => {
    const state = await setup();
    const readiness = state.verifyReadiness(state.assessReadiness());
    const prepared = await state.prepareRecoveryChallenge(
      "challenge_activation_answer_exact",
    );
    const challenge =
      decodeRecoveryDeviceActivationChallenge(prepared.challengeBytes);
    const answer = (
      overrides: Partial<Parameters<
        typeof answerRecoveryDeviceActivationChallengeV2
      >[0]> = {},
    ) =>
      state.answerRecoveryChallenge(
        prepared.challengeBytes,
        readiness,
        overrides,
      );

    expect(await rejectedMessage(() =>
      answer({ challengeBytes: "challenge" as never })
    )).toBe("Recovery device challenge bytes must be bytes");
    expect(await rejectedMessage(() =>
      answer({ recoveryPrivateKey: bytes(1, 31) })
    )).toBe(
      "Recovery device private key must contain exactly 32 bytes",
    );
    expect(await rejectedMessage(() =>
      answer({ expectedRecoveryArchiveDigest: bytes(1, 31) })
    )).toBe(
      "Expected recovery archive digest must contain exactly 32 bytes",
    );
    expect(await rejectedMessage(() =>
      answer({
        currentTime: unixTimestamp(Number(challenge.issuedAt) - 1),
      })
    )).toBe("Recovery device challenge is not currently valid");
    expect(await rejectedMessage(() =>
      answer({ currentTime: challenge.expiresAt })
    )).toBe("Recovery device challenge is not currently valid");
    expect(await answer({ currentTime: challenge.issuedAt }))
      .toBeDefined();

    const alternateChallengeBytes = (
      changes: Record<string, unknown>,
    ) =>
      serializeRecoveryDeviceActivationChallenge({
        ...challenge,
        ...changes,
      } as never);
    const detachedCases = [
      { humanId: humanId("human_other") },
      { targetDeviceId: cryptoDeviceId("device_other") },
      { pendingDeviceRevision: pendingDeviceRevision(8) },
      { encryptionPublicKeyDigest: bytes(0xa1) },
      { signingPublicKeyDigest: bytes(0xa2) },
      { recoveryPublicKeyDigest: bytes(0xa3) },
      { recoveryArchiveDigest: bytes(0xa4) },
      {
        inventoryRevision: deviceTransferInventoryRevision(
          Number(challenge.inventoryRevision) + 1,
        ),
      },
      { inventoryCount: challenge.inventoryCount + 1 },
      { inventoryDigest: bytes(0xa5) },
    ];
    for (const changes of detachedCases) {
      expect(await rejectedMessage(() =>
        answer({ challengeBytes: alternateChallengeBytes(changes) })
      )).toBe(
        "Recovery device challenge is detached from trusted recovery state",
      );
    }

    const originalReadinessDigest = readiness.readinessDigest[0]!;
    readiness.readinessDigest[0] = originalReadinessDigest ^ 1;
    expect(await rejectedMessage(() => answer())).toBe(
      "Recovery activation requires authenticated complete archive readiness",
    );
    readiness.readinessDigest[0] = originalReadinessDigest;

    state.crypto.openPlaintextTransform = (plaintext) => {
      const copy = plaintext.slice();
      copy[4] = copy[4]! ^ 1;
      return copy;
    };
    expect(await rejectedMessage(() => answer())).toBe(
      "Recovery device challenge inner metadata does not match",
    );
    state.crypto.openPlaintextTransform = null;
  });

  test("mutation contract: activation preparation validates direct inputs and authoritative inventory", async () => {
    const state = await setup();
    const issuedAt = unixTimestamp(1_700_000_000_100);
    const prepare = (
      overrides: Partial<Parameters<
        typeof prepareRecoveryDeviceActivationChallengeV2
      >[0]>,
    ) => state.prepareRecoveryChallenge(
      "challenge_activation_prepare_exact",
      overrides,
    );

    const invalidCases: readonly [
      Partial<Parameters<
        typeof prepareRecoveryDeviceActivationChallengeV2
      >[0]>,
      string,
    ][] = [
      [{ challengeId: "" },
        "Recovery device challenge id must be 1-128 ASCII bytes using the portable identifier grammar"],
      [{ recoveryKeyId: "" },
        "Recovery device key id must be 1-128 ASCII bytes using the portable identifier grammar"],
      [{ recoveryPublicKey: bytes(1, 64) },
        "Recovery device public key must contain exactly 65 bytes"],
      [{ recoveryArchiveDigest: bytes(1, 31) },
        "Recovery device archive digest must contain exactly 32 bytes"],
      [{ issuedAt, expiresAt: issuedAt },
        "Recovery device challenge expiry must follow issuance"],
      [{
        issuedAt,
        expiresAt: unixTimestamp(Number(issuedAt) + V2_LIMITS.grantTtlMs + 1),
      }, "Recovery device challenge lifetime exceeds the 24-hour limit"],
      [{ resolveTrustedInventoryCommitment: () => null },
        "Authoritative device-transfer inventory commitment is required"],
      [{ resolveTrustedInventoryCommitment: () => "inventory" as never },
        "Device-transfer inventory commitment must be an object"],
      [{ resolveTrustedInventoryCommitment: () => ({
        ...state.inventoryCommitment,
        unexpected: true,
      }) as never },
      "Device-transfer inventory commitment contains unknown field unexpected"],
      [{ resolveTrustedInventoryCommitment: () => ({
        ...state.inventoryCommitment,
        inventoryDigest: bytes(1, 31),
      }) },
      "Device-transfer inventory commitment digest must contain exactly 32 bytes"],
      [{ resolveTrustedInventoryCommitment: () => ({
        ...state.inventoryCommitment,
        humanId: humanId("human_mallory"),
      }) }, "Recovery challenge inventory commitment is stale or empty"],
      [{ resolveTrustedInventoryCommitment: () => ({
        ...state.inventoryCommitment,
        inventoryRevision: deviceTransferInventoryRevision(
          Number(state.inventoryRevision) + 1,
        ),
      }) }, "Recovery challenge inventory commitment is stale or empty"],
      [{ resolveTrustedInventoryCommitment: () => ({
        ...state.inventoryCommitment,
        inventoryCount: 0,
      }) }, "Recovery challenge inventory commitment is stale or empty"],
      [{ resolveTrustedInventoryCommitment: () => ({
        ...state.inventoryCommitment,
        inventoryCount: V2_LIMITS.recoveryPackages + 1,
      }) },
      `Device-transfer inventory commitment count exceeds the ${V2_LIMITS.recoveryPackages} limit`],
    ];
    for (const [overrides, message] of invalidCases) {
      expect(await rejectedMessage(() => prepare(overrides))).toBe(message);
      expect(state.crypto.sealCalls).toBe(0);
    }

    expect(await prepare({
      issuedAt,
      expiresAt: unixTimestamp(Number(issuedAt) + V2_LIMITS.grantTtlMs),
    })).toBeDefined();

    state.crypto.sealLengthDelta = 1;
    expect(await rejectedMessage(() => prepare({}))).toBe(
      "Recovery device challenge HPKE is noncanonical",
    );
  });

  test("mutation contract: activation answer wipes response and both metadata copies", async () => {
    const state = await setup();
    const readiness = state.assessReadiness();
    const prepared = await state.prepareRecoveryChallenge(
      "challenge_activation_answer_wipes",
    );
    const originalFill = Uint8Array.prototype.fill;
    const wipes: {
      readonly value: Uint8Array;
      readonly before: Uint8Array;
      readonly stack: string;
    }[] = [];
    Uint8Array.prototype.fill = function (
      value: number,
      start?: number,
      end?: number,
    ): Uint8Array {
      const stack = new Error().stack ?? "";
      if (value === 0) {
        wipes.push({ value: this, before: this.slice(), stack });
      }
      return originalFill.call(this, value, start, end);
    };
    let proof: Awaited<ReturnType<
      typeof answerRecoveryDeviceActivationChallengeV2
    >>;
    try {
      proof = await state.answerRecoveryChallenge(
        prepared.challengeBytes,
        readiness,
      );
    } finally {
      Uint8Array.prototype.fill = originalFill;
    }

    const responseWipes = wipes.filter(({ before }) =>
      before.length === proof.response.length
      && before.every((byte, index) => byte === proof.response[index])
    );
    expect(responseWipes).toHaveLength(1);
    expect(allZero(responseWipes[0]!.value)).toBe(true);

    const directWipes = wipes.filter(({ stack }) =>
      stack.split("\n")[2]?.includes(
        "answerRecoveryDeviceActivationChallengeV2",
      )
    );
    const metadataGroups = new Map<string, typeof wipes>();
    for (
      const wipe of directWipes.filter(
        ({ before }) => before.length > 32,
      )
    ) {
      const key = Buffer.from(wipe.before).toString("hex");
      const group = metadataGroups.get(key) ?? [];
      group.push(wipe);
      metadataGroups.set(key, group);
    }
    const metadataWipes = [...metadataGroups.values()].find(
      (group) => group.length === 2,
    );
    expect(metadataWipes).toHaveLength(2);
    expect(metadataWipes!.every(({ value }) => allZero(value)))
      .toBe(true);

    const decoderPlaintextWipes = wipes.filter(({ before, stack }) =>
      Buffer.from(before).indexOf(Buffer.from(proof.response)) >= 0
      && stack.split("\n")[3]?.includes(
        "answerRecoveryDeviceActivationChallengeV2",
      )
    );
    expect(decoderPlaintextWipes).toHaveLength(1);
    expect(decoderPlaintextWipes.every(({ value }) => allZero(value)))
      .toBe(true);
  });

  test("uses strict detached canonical challenge and proof artifacts", async () => {
    const state = await setup();
    const readiness = state.assessReadiness();
    const challenge = await state.prepareRecoveryChallenge(
      "challenge_recovery_device_2",
    );
    const proof = await state.answerRecoveryChallenge(
      challenge.challengeBytes,
      readiness,
    );
    const proofBytes = serializeRecoveryDeviceActivationProof(proof);
    expect(
      serializeRecoveryDeviceActivationChallenge(
        decodeRecoveryDeviceActivationChallenge(challenge.challengeBytes),
      ),
    ).toEqual(challenge.challengeBytes);
    expect(
      serializeRecoveryDeviceActivationProof(
        decodeRecoveryDeviceActivationProof(proofBytes),
      ),
    ).toEqual(proofBytes);
    expect(() =>
      decodeRecoveryDeviceActivationChallenge(
        new Uint8Array([...challenge.challengeBytes, 0]),
      )
    ).toThrow("trailing bytes");
    expect(() =>
      decodeRecoveryDeviceActivationProof(
        new Uint8Array([...proofBytes, 0]),
      )
    ).toThrow("trailing bytes");

    const failing = await setup();
    failing.crypto.failNextSeal = true;
    expect(failing.prepareRecoveryChallenge(
      "challenge_recovery_device_failure",
    )).rejects.toThrow("injected HPKE seal failure");
    expect(failing.crypto.sealPlaintexts.every(allZero)).toBe(true);
  });

  test("wipes the proof decoder-owned wire copy without wiping returned fields", async () => {
    const state = await setup();
    const readiness = state.assessReadiness();
    const challenge = await state.prepareRecoveryChallenge(
      "challenge_proof_decoder_wipe",
    );
    const proofBytes = serializeRecoveryDeviceActivationProof(
      await state.answerRecoveryChallenge(
        challenge.challengeBytes,
        readiness,
      ),
    );
    const originalFill = Uint8Array.prototype.fill;
    const wipes: { readonly value: Uint8Array; readonly before: Uint8Array }[] = [];
    Uint8Array.prototype.fill = function (
      value: number,
      start?: number,
      end?: number,
    ): Uint8Array {
      const stack = new Error().stack ?? "";
      if (
        value === 0
        && stack.split("\n")[3]?.includes(
          "decodeRecoveryDeviceActivationProof",
        )
      ) {
        wipes.push({ value: this, before: this.slice() });
      }
      return originalFill.call(this, value, start, end);
    };
    let decoded: ReturnType<typeof decodeRecoveryDeviceActivationProof>;
    try {
      decoded = decodeRecoveryDeviceActivationProof(proofBytes);
    } finally {
      Uint8Array.prototype.fill = originalFill;
    }

    const wireWipes = wipes.filter(({ before }) =>
      before.length === proofBytes.length
      && before.every((byte, index) => byte === proofBytes[index])
    );
    expect(wireWipes).toHaveLength(1);
    expect(wireWipes.every(({ value }) => allZero(value))).toBe(true);
    expect(decoded.challengeHash).not.toEqual(new Uint8Array(32));
    expect(decoded.readinessDigest).not.toEqual(new Uint8Array(32));
    expect(decoded.response).not.toEqual(new Uint8Array(32));
  });

  test("validates every challenge/proof field, exact time boundary, wire domain, and wire limit", async () => {
    const state = await setup();
    const readiness = state.assessReadiness();
    const prepared = await state.prepareRecoveryChallenge(
      "challenge_codec_boundaries",
    );
    const challenge = prepared.challenge;
    const proof = await state.answerRecoveryChallenge(
      prepared.challengeBytes,
      readiness,
    );
    const serializeChallenge = (changes: Record<string, unknown>) =>
      serializeRecoveryDeviceActivationChallenge({
        ...challenge,
        ...changes,
      } as never);
    const serializeProof = (changes: Record<string, unknown>) =>
      serializeRecoveryDeviceActivationProof({
        ...proof,
        ...changes,
      } as never);
    for (const value of [null, "challenge"]) {
      expectExactError(
        () => serializeRecoveryDeviceActivationChallenge(value as never),
        "Recovery device challenge must be an object",
      );
    }
    expectExactError(
      () => serializeChallenge({ unexpected: true }),
      "Recovery device challenge contains unknown field unexpected",
    );
    expectExactError(
      () => serializeChallenge({ formatVersion: 1 }),
      "Recovery device challenge version is unsupported",
    );
    expectExactError(
      () => serializeChallenge({ challengeId: "" }),
      "Recovery device challenge id must be 1-128 ASCII bytes using the portable identifier grammar",
    );
    expectExactError(
      () => serializeChallenge({ recoveryKeyId: "" }),
      "Recovery device key id must be 1-128 ASCII bytes using the portable identifier grammar",
    );
    for (const [field, message] of [
      [
        "encryptionPublicKeyDigest",
        "Recovery device encryption-key digest must contain exactly 32 bytes",
      ],
      [
        "signingPublicKeyDigest",
        "Recovery device signing-key digest must contain exactly 32 bytes",
      ],
      [
        "recoveryPublicKeyDigest",
        "Recovery device public-key digest must contain exactly 32 bytes",
      ],
      [
        "recoveryArchiveDigest",
        "Recovery device archive digest must contain exactly 32 bytes",
      ],
      [
        "inventoryDigest",
        "Recovery device inventory digest must contain exactly 32 bytes",
      ],
    ] as const) {
      expectExactError(
        () => serializeChallenge({ [field]: bytes(1, 31) }),
        message,
      );
    }
    expectExactError(
      () =>
        serializeChallenge({
          inventoryCount: V2_LIMITS.recoveryPackages + 1,
        }),
      `Recovery device inventory count exceeds the ${V2_LIMITS.recoveryPackages} limit`,
    );
    expect(decodeRecoveryDeviceActivationChallenge(
      serializeChallenge({ inventoryCount: 0 }),
    ).inventoryCount).toBe(0);
    expectExactError(
      () => serializeChallenge({ expiresAt: challenge.issuedAt }),
      "Recovery device challenge expiry must follow issuance",
    );
    expect(() =>
      serializeChallenge({
        expiresAt: unixTimestamp(
          Number(challenge.issuedAt) + V2_LIMITS.grantTtlMs,
        ),
      })
    ).not.toThrow();
    expectExactError(
      () =>
        serializeChallenge({
          expiresAt: unixTimestamp(
            Number(challenge.issuedAt) + V2_LIMITS.grantTtlMs + 1,
          ),
        }),
      "Recovery device challenge lifetime exceeds the 24-hour limit",
    );
    for (const ciphertext of [
      "ciphertext",
      new Uint8Array(),
      new Uint8Array(V2_LIMITS.ciphertextBytes + 1),
    ]) {
      expectExactError(
        () => serializeChallenge({ ciphertext }),
        "Recovery device challenge ciphertext is invalid",
      );
    }
    expect(() =>
      serializeChallenge({ ciphertext: new Uint8Array([1]) })
    ).not.toThrow();
    const maximumChallengeWire = serializeChallenge({
      ciphertext: new Uint8Array(V2_LIMITS.ciphertextBytes),
    });
    expect(() =>
      decodeRecoveryDeviceActivationChallenge(maximumChallengeWire)
    ).not.toThrow();

    for (const value of [null, "proof"]) {
      expectExactError(
        () => serializeRecoveryDeviceActivationProof(value as never),
        "Recovery device proof must be an object",
      );
    }
    expectExactError(
      () => serializeProof({ unexpected: true }),
      "Recovery device proof contains unknown field unexpected",
    );
    expectExactError(
      () => serializeProof({ formatVersion: 1 }),
      "Recovery device proof version is unsupported",
    );
    for (const [field, message] of [
      [
        "challengeHash",
        "Recovery device challenge hash must contain exactly 32 bytes",
      ],
      [
        "readinessDigest",
        "Recovery device readiness digest must contain exactly 32 bytes",
      ],
      [
        "response",
        "Recovery device challenge response must contain exactly 32 bytes",
      ],
    ] as const) {
      expectExactError(
        () => serializeProof({ [field]: bytes(1, 31) }),
        message,
      );
    }

    class LengthSpoofedBytes extends Uint8Array {
      constructor(private readonly spoofedLength: number) {
        super(1);
      }

      override get length(): number {
        return this.spoofedLength;
      }
    }
    for (const [decode, maximum, message] of [
      [
        decodeRecoveryDeviceActivationChallenge,
        V2_LIMITS.ciphertextBytes + 3 * 1024,
        "Recovery device challenge exceeds wire limits",
      ],
      [
        decodeRecoveryDeviceActivationProof,
        3 * 1024,
        "Recovery device proof exceeds wire limits",
      ],
    ] as const) {
      expectExactError(
        () => decode(null as never),
        message,
      );
      expectExactError(
        () => decode(new LengthSpoofedBytes(maximum + 1)),
        message,
      );
      try {
        decode(new LengthSpoofedBytes(maximum));
      } catch (error) {
        expect((error as Error).message).not.toBe(message);
      }
    }
    for (const [wire, text, message] of [
      [
        prepared.challengeBytes,
        RECOVERY_DEVICE_ACTIVATION_DOMAIN,
        "Recovery device activation domain is unsupported",
      ],
      [
        prepared.challengeBytes,
        "challenge",
        "Recovery device activation kind is unsupported",
      ],
      [
        serializeRecoveryDeviceActivationProof(proof),
        RECOVERY_DEVICE_ACTIVATION_DOMAIN,
        "Recovery device activation domain is unsupported",
      ],
      [
        serializeRecoveryDeviceActivationProof(proof),
        "proof",
        "Recovery device activation kind is unsupported",
      ],
    ] as const) {
      const decode = text === "challenge"
        || (
          text === RECOVERY_DEVICE_ACTIVATION_DOMAIN
          && wire === prepared.challengeBytes
        )
        ? decodeRecoveryDeviceActivationChallenge
        : decodeRecoveryDeviceActivationProof;
      expectExactError(
        () => decode(mutateFramedText(wire, text)),
        message,
      );
    }

    const proofBytes = serializeRecoveryDeviceActivationProof(proof);
    for (const truncated of [
      proofBytes.slice(0, 1),
      proofBytes.slice(0, frameText(RECOVERY_DEVICE_ACTIVATION_DOMAIN).length + 8),
      proofBytes.slice(0, proofBytes.length - 40),
    ]) {
      expect(() =>
        decodeRecoveryDeviceActivationProof(truncated)
      ).toThrow(CanonicalDecodingError);
    }
    const independentResponseDigest = sha256(concatV2(
      frameText(RECOVERY_DEVICE_ACTIVATION_DOMAIN),
      frameText("response"),
      frame(proof.challengeHash),
      frame(proof.response),
    ));
    expect(prepared.verifier.expectedResponseDigest).toEqual(
      independentResponseDigest,
    );
  });

  test("wipes all framed response-digest intermediates", async () => {
    const state = await setup();
    const originalFill = Uint8Array.prototype.fill;
    const responseDigestBuffers: Uint8Array[] = [];
    Uint8Array.prototype.fill = function (
      value: number,
      start?: number,
      end?: number,
    ): Uint8Array {
      if (
        value === 0
        && new Error().stack?.includes("recoveryResponseDigest")
      ) {
        responseDigestBuffers.push(this);
      }
      return originalFill.call(this, value, start, end);
    };
    try {
      await state.prepareRecoveryChallenge("challenge_response_wipe");
    } finally {
      Uint8Array.prototype.fill = originalFill;
    }
    expect(responseDigestBuffers.length).toBeGreaterThanOrEqual(3);
    expect(responseDigestBuffers.every(allZero)).toBe(true);
  });

  test("requires the exact current trusted recovery identity", async () => {
    const state = await setup();
    const trusted = state.resolveTrustedCurrentRecoveryKey();
    const cases = [
      {
        name: "missing",
        resolve: () => null,
        message: "Current trusted recovery key is required",
      },
      {
        name: "wrong-human",
        resolve: () => ({
          ...trusted,
          humanId: humanId("human_mallory"),
        }),
        message: "Recovery device challenge uses a stale recovery key",
      },
      {
        name: "wrong-key-id",
        resolve: () => ({
          ...trusted,
          recoveryKeyId: "recovery_alice_old",
        }),
        message: "Recovery device challenge uses a stale recovery key",
      },
    ] as const;
    for (const { name, resolve, message } of cases) {
      try {
        await state.prepareRecoveryChallenge(
          `challenge_recovery_identity_${name}`,
          { resolveTrustedCurrentRecoveryKey: resolve },
        );
        throw new Error(`expected ${name} identity rejection`);
      } catch (error) {
        expect((error as Error).message).toBe(message);
      }
    }
  });

  test("verifies every pending-device, proof, and trusted-verifier binding independently", async () => {
    const state = await setup();
    const readiness = state.assessReadiness();
    const prepared = await state.prepareRecoveryChallenge(
      "challenge_exact_verifier",
    );
    const proof = await state.answerRecoveryChallenge(
      prepared.challengeBytes,
      readiness,
    );
    const proofBytes = serializeRecoveryDeviceActivationProof(proof);
    const verify = (
      overrides: Partial<Parameters<
        typeof verifyRecoveryDeviceActivationProofV2
      >[0]> = {},
    ) =>
      verifyRecoveryDeviceActivationProofV2({
        challengeBytes: prepared.challengeBytes,
        proofBytes,
        resolveTrustedChallenge: () => prepared.verifier,
        pendingDevice: state.pendingDevice,
        resolveTrustedPendingDevice: state.resolveTrustedPendingDevice,
        resolveTrustedCurrentRecoveryKey:
          state.resolveTrustedCurrentRecoveryKey,
        currentTime: unixTimestamp(1_700_000_000_300),
        ...overrides,
      });

    expectExactError(
      () => verify({ currentTime: unixTimestamp(1_700_000_000_099) }),
      "Recovery device challenge is not currently valid",
    );
    expect(() =>
      verify({ currentTime: unixTimestamp(1_700_000_000_100) })
    ).not.toThrow();

    const alternateEncryption =
      await state.crypto.generateEncryptionKeyPair();
    const alternateSigning = state.crypto.generateSigningKeyPair();
    const pendingMismatches = [
      {
        name: "human",
        pendingDevice: {
          ...state.pendingDevice,
          humanId: humanId("human_mallory"),
        },
      },
      {
        name: "device",
        pendingDevice: {
          ...state.pendingDevice,
          deviceId: cryptoDeviceId("device_alice_other"),
        },
      },
      {
        name: "revision",
        pendingDevice: {
          ...state.pendingDevice,
          pendingDeviceRevision: pendingDeviceRevision(8),
        },
      },
      {
        name: "encryption-key",
        pendingDevice: {
          ...state.pendingDevice,
          encryptionPublicKey: alternateEncryption.publicKey,
        },
      },
      {
        name: "signing-key",
        pendingDevice: {
          ...state.pendingDevice,
          signingPublicKey: alternateSigning.publicKey,
        },
      },
    ] as const;
    for (const { pendingDevice } of pendingMismatches) {
      expectExactError(
        () => verify({ pendingDevice }),
        "Recovery device proof does not match the exact pending challenge",
      );
    }

    for (const [field, value] of [
      ["challengeHash", bytes(0xa1)],
      ["readinessDigest", bytes(0xa2)],
    ] as const) {
      expectExactError(
        () =>
          verify({
            proofBytes: serializeRecoveryDeviceActivationProof({
              ...proof,
              [field]: value,
            }),
          }),
        "Recovery device proof does not match the exact pending challenge",
      );
    }

    const {
      expectedResponseDigest: _expectedResponseDigest,
      ...missingExpectedResponseDigest
    } = prepared.verifier;
    const verifierCases = [
      {
        value: null,
        message: "Trusted pending recovery challenge is required",
      },
      {
        value: "verifier",
        message: "Recovery device verifier must be an object",
      },
      {
        value: { ...prepared.verifier, unexpected: true },
        message: "Recovery device verifier contains unknown field unexpected",
      },
      {
        value: missingExpectedResponseDigest,
        message:
          "Recovery device verifier is missing required field expectedResponseDigest",
      },
      {
        value: { ...prepared.verifier, challengeId: "" },
        message:
          "Recovery device challenge id must be 1-128 ASCII bytes using the portable identifier grammar",
      },
      {
        value: { ...prepared.verifier, challengeHash: bytes(1, 31) },
        message:
          "Recovery device verifier challenge hash must contain exactly 32 bytes",
      },
      {
        value: {
          ...prepared.verifier,
          expectedResponseDigest: bytes(1, 31),
        },
        message:
          "Recovery device expected response digest must contain exactly 32 bytes",
      },
      {
        value: { ...prepared.verifier, expectedStatus: "used" },
        message: "Recovery device challenge was already consumed",
      },
    ] as const;
    for (const { value, message } of verifierCases) {
      expectExactError(
        () =>
          verify({
            resolveTrustedChallenge: () => value as never,
          }),
        message,
      );
    }

    for (const verifier of [
      {
        ...prepared.verifier,
        challengeId: "challenge_other_verifier",
      },
      {
        ...prepared.verifier,
        challengeHash: bytes(0xb1),
      },
      {
        ...prepared.verifier,
        expectedResponseDigest: bytes(0xb2),
      },
    ]) {
      expectExactError(
        () => verify({ resolveTrustedChallenge: () => verifier }),
        "Recovery device proof does not match the exact pending challenge",
      );
    }
  });

  test("wipes the decoded activation response after verification", async () => {
    const state = await setup();
    const readiness = state.assessReadiness();
    const prepared = await state.prepareRecoveryChallenge(
      "challenge_verify_response_wipe",
    );
    const proof = await state.answerRecoveryChallenge(
      prepared.challengeBytes,
      readiness,
    );
    const proofBytes = serializeRecoveryDeviceActivationProof(proof);
    const originalFill = Uint8Array.prototype.fill;
    const responseBuffers: Uint8Array[] = [];
    Uint8Array.prototype.fill = function (
      value: number,
      start?: number,
      end?: number,
    ): Uint8Array {
      if (
        value === 0
        && this.length === 32
        && new Error().stack?.includes(
          "verifyRecoveryDeviceActivationProofV2",
        )
      ) {
        responseBuffers.push(this);
      }
      return originalFill.call(this, value, start, end);
    };
    try {
      verifyRecoveryDeviceActivationProofV2({
        challengeBytes: prepared.challengeBytes,
        proofBytes,
        resolveTrustedChallenge: () => prepared.verifier,
        pendingDevice: state.pendingDevice,
        resolveTrustedPendingDevice: state.resolveTrustedPendingDevice,
        resolveTrustedCurrentRecoveryKey:
          state.resolveTrustedCurrentRecoveryKey,
        currentTime: unixTimestamp(1_700_000_000_300),
      });
    } finally {
      Uint8Array.prototype.fill = originalFill;
    }
    expect(responseBuffers.length).toBeGreaterThanOrEqual(1);
    expect(responseBuffers.every(allZero)).toBe(true);
  });

  test("validates complete recovery inputs before trusted resolvers or HPKE", async () => {
    const state = await setup();
    let pendingCalls = 0;
    let recoveryCalls = 0;
    let inventoryCalls = 0;
    expect(state.prepareRecoveryChallenge(
      "challenge_preflight_prepare",
      {
        recoveryArchiveDigest: bytes(1, 31),
        resolveTrustedPendingDevice: () => {
          pendingCalls++;
          return state.trustedPending;
        },
        resolveTrustedCurrentRecoveryKey: () => {
          recoveryCalls++;
          return state.resolveTrustedCurrentRecoveryKey();
        },
        resolveTrustedInventoryCommitment: () => {
          inventoryCalls++;
          return state.inventoryCommitment;
        },
      },
    )).rejects.toThrow("32 bytes");
    expect({ pendingCalls, recoveryCalls, inventoryCalls }).toEqual({
      pendingCalls: 0,
      recoveryCalls: 0,
      inventoryCalls: 0,
    });
    expect(state.crypto.sealCalls).toBe(0);

    const readiness = state.assessReadiness();
    const openCalls = state.crypto.openCalls;
    expect(state.answerRecoveryChallenge(
      new Uint8Array([0]),
      readiness,
      {
        resolveTrustedPendingDevice: () => {
          pendingCalls++;
          return state.trustedPending;
        },
        resolveTrustedCurrentRecoveryKey: () => {
          recoveryCalls++;
          return state.resolveTrustedCurrentRecoveryKey();
        },
      },
    )).rejects.toThrow();
    expect({ pendingCalls, recoveryCalls }).toEqual({
      pendingCalls: 0,
      recoveryCalls: 0,
    });
    expect(state.crypto.openCalls).toBe(openCalls);

    const challenge = await state.prepareRecoveryChallenge(
      "challenge_preflight_verify",
    );
    let challengeCalls = 0;
    expect(() =>
      verifyRecoveryDeviceActivationProofV2({
        challengeBytes: challenge.challengeBytes,
        proofBytes: new Uint8Array([0]),
        resolveTrustedChallenge: () => {
          challengeCalls++;
          return challenge.verifier;
        },
        pendingDevice: state.pendingDevice,
        resolveTrustedPendingDevice: () => {
          pendingCalls++;
          return state.trustedPending;
        },
        resolveTrustedCurrentRecoveryKey: () => {
          recoveryCalls++;
          return state.resolveTrustedCurrentRecoveryKey();
        },
        currentTime: unixTimestamp(1_700_000_000_300),
      })
    ).toThrow();
    expect({ challengeCalls, pendingCalls, recoveryCalls }).toEqual({
      challengeCalls: 0,
      pendingCalls: 0,
      recoveryCalls: 0,
    });
  });

  test("rejects wrong private key, recovery rotation, archive substitution, expiry, replay state, and proof tampering", async () => {
    const state = await setup();
    const readiness = state.assessReadiness();
    const challenge = await state.prepareRecoveryChallenge(
      "challenge_recovery_device_3",
    );
    expect(state.answerRecoveryChallenge(
      challenge.challengeBytes,
      {
        kind: "ready-for-live-join",
        recoveryArchiveDigest: state.recoveryArchiveDigest,
        inventoryRevision: state.inventoryRevision,
        inventoryCount: 2,
        inventoryDigest: state.inventoryDigest,
        readinessDigest: bytes(0x77),
        joinIntents: [],
      } as never,
    )).rejects.toThrow("authenticated complete archive readiness");
    const wrong = await state.crypto.generateEncryptionKeyPair();
    expect(state.answerRecoveryChallenge(
      challenge.challengeBytes,
      readiness,
      {
      recoveryPrivateKey: wrong.privateKey,
      },
    )).rejects.toThrow("failed to decrypt");
    expect(state.answerRecoveryChallenge(
      challenge.challengeBytes,
      readiness,
      {
      resolveTrustedCurrentRecoveryKey: () => ({
        ...state.resolveTrustedCurrentRecoveryKey(),
        recoveryGeneration: recoveryKeyGeneration(3),
      }),
      },
    )).rejects.toThrow("stale recovery key");
    expect(state.answerRecoveryChallenge(
      challenge.challengeBytes,
      readiness,
      {
      expectedRecoveryArchiveDigest: bytes(0xff),
      },
    )).rejects.toThrow("trusted recovery state");

    const proof = await state.answerRecoveryChallenge(
      challenge.challengeBytes,
      readiness,
    );
    const alteredResponse = proof.response.slice();
    alteredResponse[0] = alteredResponse[0]! ^ 1;
    const alteredProofBytes = serializeRecoveryDeviceActivationProof({
      ...proof,
      response: alteredResponse,
    });
    expect(() =>
      verifyRecoveryDeviceActivationProofV2({
        challengeBytes: challenge.challengeBytes,
        proofBytes: alteredProofBytes,
        resolveTrustedChallenge: () => challenge.verifier,
        pendingDevice: state.pendingDevice,
        resolveTrustedPendingDevice: state.resolveTrustedPendingDevice,
        resolveTrustedCurrentRecoveryKey:
          state.resolveTrustedCurrentRecoveryKey,
        currentTime: unixTimestamp(1_700_000_000_300),
      })
    ).toThrow("exact pending challenge");
    expect(() =>
      verifyRecoveryDeviceActivationProofV2({
        challengeBytes: challenge.challengeBytes,
        proofBytes: serializeRecoveryDeviceActivationProof(proof),
        resolveTrustedChallenge: () => ({
          ...challenge.verifier,
          expectedStatus: "used" as never,
        }),
        pendingDevice: state.pendingDevice,
        resolveTrustedPendingDevice: state.resolveTrustedPendingDevice,
        resolveTrustedCurrentRecoveryKey:
          state.resolveTrustedCurrentRecoveryKey,
        currentTime: unixTimestamp(1_700_000_000_300),
      })
    ).toThrow("already consumed");
    expect(() =>
      verifyRecoveryDeviceActivationProofV2({
        challengeBytes: challenge.challengeBytes,
        proofBytes: serializeRecoveryDeviceActivationProof(proof),
        resolveTrustedChallenge: () => challenge.verifier,
        pendingDevice: state.pendingDevice,
        resolveTrustedPendingDevice: state.resolveTrustedPendingDevice,
        resolveTrustedCurrentRecoveryKey:
          state.resolveTrustedCurrentRecoveryKey,
        currentTime: unixTimestamp(1_700_000_060_101),
      })
    ).toThrow("not currently valid");
  });

  test("snapshots challenge and readiness digests across asynchronous answer work and expires at the exact boundary", async () => {
    const state = await setup();
    const readiness = state.assessReadiness();
    const challenge = await state.prepareRecoveryChallenge(
      "challenge_snapshot_boundary",
    );
    const challengeBytes = challenge.challengeBytes.slice();
    const expectedChallengeHash = state.crypto.hash(challengeBytes);
    const expectedReadinessDigest = readiness.kind === "ready-for-live-join"
      ? readiness.readinessDigest.slice()
      : (() => {
        throw new Error("expected live-join readiness");
      })();
    const originalOpen = state.crypto.openSealed.bind(state.crypto);
    let mutated = false;
    state.crypto.openSealed = async (...args) => {
      if (!mutated) {
        mutated = true;
        challengeBytes[0] = challengeBytes[0]! ^ 1;
        readiness.readinessDigest[0] =
          readiness.readinessDigest[0]! ^ 1;
      }
      return originalOpen(...args);
    };
    const proof = await state.answerRecoveryChallenge(
      challengeBytes,
      readiness,
    );
    expect(proof.challengeHash).toEqual(expectedChallengeHash);
    expect(proof.readinessDigest).toEqual(expectedReadinessDigest);

    expect(state.answerRecoveryChallenge(
      challenge.challengeBytes,
      state.assessReadiness(),
      { currentTime: unixTimestamp(1_700_000_060_100) },
    )).rejects.toThrow("not currently valid");

    const validProof = await state.answerRecoveryChallenge(
      challenge.challengeBytes,
      state.assessReadiness(),
      { currentTime: unixTimestamp(1_700_000_060_099) },
    );
    expect(() =>
      verifyRecoveryDeviceActivationProofV2({
        challengeBytes: challenge.challengeBytes,
        proofBytes: serializeRecoveryDeviceActivationProof(validProof),
        resolveTrustedChallenge: () => challenge.verifier,
        pendingDevice: state.pendingDevice,
        resolveTrustedPendingDevice: state.resolveTrustedPendingDevice,
        resolveTrustedCurrentRecoveryKey:
          state.resolveTrustedCurrentRecoveryKey,
        currentTime: unixTimestamp(1_700_000_060_100),
      })
    ).toThrow("not currently valid");
  });

  test("snapshots activation publication and answer keys across HPKE and verifies the resulting proof", async () => {
    const state = await setup();
    const recoveryPublicKey = Buffer.from(
      state.recoveryEncryption.publicKey,
    );
    const originalSeal = state.crypto.sealTo.bind(state.crypto);
    let publicationMutated = false;
    state.crypto.sealTo = async (...args) => {
      if (!publicationMutated) {
        publicationMutated = true;
        recoveryPublicKey.fill(0);
      }
      return originalSeal(...args);
    };
    const challenge = await state.prepareRecoveryChallenge(
      "challenge_key_snapshot",
      { recoveryPublicKey },
    );

    const readiness = state.assessReadiness();
    const recoveryPrivateKey = Buffer.from(
      state.recoveryEncryption.privateKey,
    );
    const originalOpen = state.crypto.openSealed.bind(state.crypto);
    let privateSnapshot: Uint8Array | null = null;
    let answerMutated = false;
    state.crypto.openSealed = async (privateKey, ciphertext) => {
      privateSnapshot ??= privateKey;
      if (!answerMutated) {
        answerMutated = true;
        recoveryPrivateKey.fill(0);
      }
      return originalOpen(privateKey, ciphertext);
    };
    const proof = await state.answerRecoveryChallenge(
      challenge.challengeBytes,
      readiness,
      { recoveryPrivateKey },
    );
    expect(isZeroized(privateSnapshot)).toBe(true);
    expect(Buffer.isBuffer(privateSnapshot)).toBe(false);
    expect(() =>
      verifyRecoveryDeviceActivationProofV2({
        challengeBytes: challenge.challengeBytes,
        proofBytes: serializeRecoveryDeviceActivationProof(proof),
        resolveTrustedChallenge: () => challenge.verifier,
        pendingDevice: state.pendingDevice,
        resolveTrustedPendingDevice: state.resolveTrustedPendingDevice,
        resolveTrustedCurrentRecoveryKey:
          state.resolveTrustedCurrentRecoveryKey,
        currentTime: unixTimestamp(1_700_000_000_300),
      })
    ).not.toThrow();
  });

  test("owns the provider random challenge secret across HPKE publication", async () => {
    const state = await setup();
    const firstRandom = state.crypto.randomOutputs.length;
    state.crypto.bufferNextRandom = true;
    state.crypto.afterSealTo = () => {
      const providerSecret = state.crypto.randomOutputs[firstRandom];
      if (providerSecret === undefined) {
        throw new Error("missing provider challenge secret");
      }
      expect(providerSecret.every((byte) => byte === 0)).toBe(true);
      providerSecret.fill(0xff);
    };
    const challenge = await state.prepareRecoveryChallenge(
      "challenge_random_snapshot",
    );
    state.crypto.afterSealTo = null;
    const proof = await state.answerRecoveryChallenge(
      challenge.challengeBytes,
      state.assessReadiness(),
    );

    expect(() =>
      verifyRecoveryDeviceActivationProofV2({
        challengeBytes: challenge.challengeBytes,
        proofBytes: serializeRecoveryDeviceActivationProof(proof),
        resolveTrustedChallenge: () => challenge.verifier,
        pendingDevice: state.pendingDevice,
        resolveTrustedPendingDevice: state.resolveTrustedPendingDevice,
        resolveTrustedCurrentRecoveryKey:
          state.resolveTrustedCurrentRecoveryKey,
        currentTime: unixTimestamp(1_700_000_000_300),
      })
    ).not.toThrow();
  });

  test("rejects a short provider random challenge secret exactly", async () => {
    const state = await setup();
    state.crypto.shortNextRandom = true;
    expect(state.prepareRecoveryChallenge(
      "challenge_short_random",
    )).rejects.toThrow(
      "Recovery device challenge random secret must contain exactly 32 bytes",
    );
  });

  test("wipes the activation answer private snapshot on HPKE failure", async () => {
    const state = await setup();
    const readiness = state.assessReadiness();
    const challenge = await state.prepareRecoveryChallenge(
      "challenge_private_failure",
    );
    let privateSnapshot: Uint8Array | null = null;
    state.crypto.openSealed = async (privateKey) => {
      privateSnapshot = privateKey;
      throw new Error("injected activation answer failure");
    };
    expect(state.answerRecoveryChallenge(
      challenge.challengeBytes,
      readiness,
    )).rejects.toThrow("injected activation answer failure");
    expect(isZeroized(privateSnapshot)).toBe(true);
  });
});

describe("v2 recovered-device readiness", () => {
  test("locks the complete-archive readiness digest domain and rejects fabricated claims", async () => {
    const state = await setup();
    expect(
      Buffer.from(recoveryReadinessDigest(
        bytes(1),
        {
          humanId: humanId("human_alice"),
          inventoryRevision: deviceTransferInventoryRevision(2),
          inventoryCount: 3,
          inventoryDigest: bytes(4),
        },
      )).toString("hex"),
    ).toBe(
      "671d15f8fc897914f0a5c0338f0d6e304fd15c775f1b1f76b9fd0bec8f31a25c",
    );
    for (const kind of ["ready-for-live-join", "rebootstrap-required"] as const) {
      expect(() =>
        state.verifyReadiness({ kind } as never)
      ).toThrow(
        "Recovery activation requires authenticated complete archive readiness",
      );
    }
    expect(() =>
      state.verifyReadiness({
        kind: "missing-recovery-kit",
        permanentLoss: true,
      })
    ).toThrow(
      "Recovery activation requires authenticated complete archive readiness",
    );
    const ready = state.assessReadiness();
    expect(() =>
      state.verifyReadiness(ready, {
        recoveryCredential: null,
      })
    ).toThrow(
      "Recovery activation requires authenticated complete archive readiness",
    );
  });

  test("rejects every mutable readiness capability field after issuance", async () => {
    const state = await setup();
    const readiness = state.assessReadiness();
    if (readiness.kind !== "ready-for-live-join") {
      throw new Error("expected live-join readiness");
    }
    for (const field of [
      "recoveryArchiveDigest",
      "inventoryDigest",
      "readinessDigest",
    ] as const) {
      const original = readiness[field][0]!;
      readiness[field][0] = original ^ 1;
      expect(() => state.verifyReadiness(readiness)).toThrow(
        "Recovery activation requires authenticated complete archive readiness",
      );
      readiness[field][0] = original;
      expect(() => state.verifyReadiness(readiness)).not.toThrow();
    }
  });

  test("binds every reconstructed readiness scalar, join intent, and rebootstrap Domain", async () => {
    const state = await setup();
    const ready = state.assessReadiness();
    if (ready.kind !== "ready-for-live-join") {
      throw new Error("expected live-join readiness");
    }
    const join = ready.joinIntents[0]!;
    const reject = (readiness: RecoveryDeviceReadinessV2): void => {
      expect(() => state.verifyReadiness(readiness)).toThrow(
        "Recovery activation requires authenticated complete archive readiness",
      );
    };
    for (const readiness of [
      { ...ready, inventoryRevision: deviceTransferInventoryRevision(13) },
      { ...ready, inventoryCount: ready.inventoryCount + 1 },
      { ...ready, joinIntents: [] },
      {
        ...ready,
        joinIntents: [{ ...join, formatVersion: 1 as never }],
      },
      {
        ...ready,
        joinIntents: [{ ...join, humanId: humanId("human_mallory") }],
      },
      {
        ...ready,
        joinIntents: [{
          ...join,
          targetDeviceId: cryptoDeviceId("device_other"),
        }],
      },
      {
        ...ready,
        joinIntents: [{
          ...join,
          pendingDeviceRevision: pendingDeviceRevision(
            Number(join.pendingDeviceRevision) + 1,
          ),
        }],
      },
      {
        ...ready,
        joinIntents: [{ ...join, domainId: cryptoDomainId("domain_other") }],
      },
      {
        ...ready,
        joinIntents: [{
          ...join,
          domainEpoch: domainEpoch(Number(join.domainEpoch) + 1),
        }],
      },
      {
        ...ready,
        joinIntents: [{
          ...join,
          committerDeviceId: cryptoDeviceId("device_other"),
        }],
      },
    ]) reject(readiness as RecoveryDeviceReadinessV2);

    const rebootstrapLiveDomains = [{
      domainId: cryptoDomainId("domain_ab"),
      domainEpoch: domainEpoch(3),
      committerDeviceId: null,
    }] as const;
    const rebootstrap = state.assessReadiness({
      liveDomains: rebootstrapLiveDomains,
    });
    if (rebootstrap.kind !== "rebootstrap-required") {
      throw new Error("expected rebootstrap readiness");
    }
    reject({ ...rebootstrap, rebootstrapDomains: [] });
    reject({
      ...rebootstrap,
      rebootstrapDomains: [cryptoDomainId("domain_other")],
    });
  });

  test("preflights oversized transfer and activation inputs before other work", async () => {
    const state = await setup();
    const oversizedApproval =
      new LengthSpoofedBytes(V2_LIMITS.recoveryArchiveBytes + 1);
    expect(await rejectedMessage(() =>
      state.open(oversizedApproval, {
        expectedInventory: null as never,
        pendingEncryptionPrivateKey: bytes(1, 31),
      })
    )).toBe(
      "Device transfer approval exceeds the 64 MiB aggregate-byte limit",
    );

    const oversizedChallenge = new LengthSpoofedBytes(
      V2_LIMITS.ciphertextBytes + MAX_METADATA_BYTES + 1,
    );
    expect(await rejectedMessage(() =>
      state.answerRecoveryChallenge(
        oversizedChallenge,
        state.assessReadiness(),
        { recoveryPrivateKey: bytes(1, 31) },
      )
    )).toBe("Recovery device challenge exceeds wire limits");
    expectExactError(
      () =>
        verifyRecoveryDeviceActivationProofV2({
          challengeBytes: oversizedChallenge,
          proofBytes: new Uint8Array(),
          resolveTrustedChallenge: () => null,
          pendingDevice: state.pendingDevice,
          resolveTrustedPendingDevice: state.resolveTrustedPendingDevice,
          resolveTrustedCurrentRecoveryKey:
            state.resolveTrustedCurrentRecoveryKey,
          currentTime: unixTimestamp(1_700_000_000_300),
        }),
      "Recovery device challenge exceeds wire limits",
    );
  });

  test("makes missing-kit permanent loss explicit only after every authorized device is gone", async () => {
    const state = await setup();
    expect(() => state.assessReadiness({
      hasAuthorizedDeviceTransferSource: "yes" as never,
    })).toThrow("Authorized device-transfer source flag must be a boolean");
    expect(state.assessReadiness({
      recoveryCredential: null,
      hasAuthorizedDeviceTransferSource: true,
    })).toEqual({ kind: "missing-recovery-kit", permanentLoss: false });
    expect(state.assessReadiness({
      archiveRecoveryKey: null,
      hasAuthorizedDeviceTransferSource: false,
    })).toEqual({ kind: "missing-recovery-kit", permanentLoss: true });
  });

  test("rejects rotated recovery credentials and unauthorized or incomplete keyrings", async () => {
    const state = await setup();
    expect(state.assessReadiness({
      archiveRecoveryKey: {
        recoveryKeyId: "recovery_old",
        recoveryGeneration: 1,
      },
    })).toEqual({ kind: "recovery-key-rotated" });
    expect(() => state.assessReadiness({
      restoredKeyrings: [state.human],
    })).toThrow("exact successfully opened archive capability");
    expect(() => state.assessReadiness({
      recoveryArchiveDigest: bytes(0xfe),
    })).toThrow("exact successfully opened archive capability");
    expect(() => state.assessReadiness({
      inventory: state.expectedInventory.slice(0, 1),
    })).toThrow("authoritative commitment");
  });

  test("validates exact recovery credentials and distinguishes either rotation axis", async () => {
    const state = await setup();
    expectExactError(
      () =>
        state.assessReadiness({
          recoveryCredential: {
            recoveryKeyId: state.recoveryKeyId,
            recoveryGeneration: state.recoveryGeneration,
            unexpected: true,
          } as never,
        }),
      "Recovery credential contains unknown field unexpected",
    );
    expectExactError(
      () =>
        state.assessReadiness({
          recoveryCredential: {
            recoveryKeyId: state.recoveryKeyId,
          } as never,
        }),
      "Recovery credential is missing required field recoveryGeneration",
    );
    expectExactError(
      () =>
        state.assessReadiness({
          archiveRecoveryKey: {
            recoveryKeyId: state.recoveryKeyId,
            recoveryGeneration: state.recoveryGeneration,
            unexpected: true,
          } as never,
        }),
      "Recovery archive key contains unknown field unexpected",
    );
    expectExactError(
      () =>
        state.assessReadiness({
          archiveRecoveryKey: {
            recoveryGeneration: state.recoveryGeneration,
          } as never,
        }),
      "Recovery archive key is missing required field recoveryKeyId",
    );
    expectExactError(
      () =>
        state.assessReadiness({
          recoveryCredential: {
            recoveryKeyId: "",
            recoveryGeneration: state.recoveryGeneration,
          },
        }),
      "Recovery credential key id must be 1-128 ASCII bytes using the portable identifier grammar",
    );
    expectExactError(
      () =>
        state.assessReadiness({
          archiveRecoveryKey: {
            recoveryKeyId: "",
            recoveryGeneration: state.recoveryGeneration,
          },
        }),
      "Recovery archive key id must be 1-128 ASCII bytes using the portable identifier grammar",
    );
    expectExactError(
      () =>
        state.assessReadiness({
          recoveryArchiveDigest: bytes(0xaa, 31),
        }),
      "Recovery readiness archive digest must contain exactly 32 bytes",
    );
    expect(state.assessReadiness({
      archiveRecoveryKey: {
        recoveryKeyId: "recovery_other",
        recoveryGeneration: state.recoveryGeneration,
      },
    })).toEqual({ kind: "recovery-key-rotated" });
    expect(state.assessReadiness({
      archiveRecoveryKey: {
        recoveryKeyId: state.recoveryKeyId,
        recoveryGeneration: recoveryKeyGeneration(
          Number(state.recoveryGeneration) + 1,
        ),
      },
    })).toEqual({ kind: "recovery-key-rotated" });
  });

  test("rejects hostile inventory and live-Domain inventories before issuing readiness", async () => {
    const state = await setup();
    expect(state.assessReadiness({
      inventory: state.expectedInventory.map((item, index) => ({
        ...item,
        authorizedHumanId: index === 0
          ? humanId("human_mallory")
          : item.authorizedHumanId,
      })),
    })).toEqual({
      kind: "unauthorized-namespace",
      namespaceId: namespaceId("namespace_room"),
      keyClass: "human",
    });
    expectExactError(
      () =>
        state.assessReadiness({
          inventory: [
            state.expectedInventory[0]!,
            state.expectedInventory[0]!,
          ],
        }),
      "Recovery readiness inventory contains a duplicate",
    );
    expectExactError(
      () => state.assessReadiness({ liveDomains: null as never }),
      "Recovery readiness live Domains must be an array",
    );
    expectExactError(
      () =>
        state.assessReadiness({
          liveDomains: Array.from(
            { length: V2_LIMITS.recoveryPackages + 1 },
            () => null,
          ) as never,
        }),
      `Recovery readiness live Domain count exceeds the ${V2_LIMITS.recoveryPackages} limit`,
    );
    expectExactError(
      () => state.assessReadiness({ liveDomains: ["domain"] as never }),
      "Recovery readiness live Domain must be an object",
    );
    expectExactError(
      () => state.assessReadiness({ liveDomains: [null] as never }),
      "Recovery readiness live Domain must be an object",
    );
    expectExactError(
      () =>
        state.assessReadiness({
          liveDomains: [{
            domainId: cryptoDomainId("domain_ab"),
            domainEpoch: domainEpoch(3),
            committerDeviceId: state.issuerDeviceId,
            unexpected: true,
          } as never],
        }),
      "Recovery readiness live Domain contains unknown field unexpected",
    );
    expectExactError(
      () =>
        state.assessReadiness({
          liveDomains: [{
            domainId: cryptoDomainId("domain_ab"),
            domainEpoch: domainEpoch(3),
          } as never],
        }),
      "Recovery readiness live Domain is missing required field committerDeviceId",
    );
    expectExactError(
      () =>
        state.assessReadiness({
          liveDomains: [{
            domainId: "" as never,
            domainEpoch: domainEpoch(3),
            committerDeviceId: state.issuerDeviceId,
          }],
        }),
      "Crypto Domain id must be 1-128 ASCII bytes using the portable identifier grammar",
    );
    expectExactError(
      () =>
        state.assessReadiness({
          liveDomains: [{
            domainId: cryptoDomainId("domain_ab"),
            domainEpoch: -1 as never,
            committerDeviceId: state.issuerDeviceId,
          }],
        }),
      "Domain epoch must be a non-negative safe integer",
    );
    expectExactError(
      () =>
        state.assessReadiness({
          liveDomains: [{
            domainId: cryptoDomainId("domain_ab"),
            domainEpoch: domainEpoch(3),
            committerDeviceId: "" as never,
          }],
        }),
      "Crypto device id must be 1-128 ASCII bytes using the portable identifier grammar",
    );
    const live = {
      domainId: cryptoDomainId("domain_ab"),
      domainEpoch: domainEpoch(3),
      committerDeviceId: state.issuerDeviceId,
    };
    expectExactError(
      () => state.assessReadiness({ liveDomains: [live, live] }),
      "Recovery readiness live Domains contain a duplicate",
    );
    expectExactError(
      () =>
        state.assessReadiness({
          liveDomains: [{
            domainId: cryptoDomainId("domain_other"),
            domainEpoch: domainEpoch(3),
            committerDeviceId: state.issuerDeviceId,
          }],
        }),
      "Recovery readiness requires an exact live Domain inventory",
    );
    expectExactError(
      () =>
        state.assessReadiness({
          liveDomains: [
            live,
            {
              domainId: cryptoDomainId("domain_extra"),
              domainEpoch: domainEpoch(3),
              committerDeviceId: state.issuerDeviceId,
            },
          ],
        }),
      "Recovery readiness requires an exact live Domain inventory",
    );
  });

  test("returns exact unauthorized details for extra, stale, and missing restored keyrings", async () => {
    const state = await setup();
    const commitmentFor = (
      inventory: readonly (typeof state.expectedInventory)[number][],
    ) => {
      const digest = deviceTransferInventoryDigestV2({
        humanId: state.targetHumanId,
        inventoryRevision: state.inventoryRevision,
        inventory,
      });
      return () => ({
        humanId: state.targetHumanId,
        inventoryRevision: state.inventoryRevision,
        inventoryCount: inventory.length,
        inventoryDigest: digest,
      });
    };
    const humanOnly = [state.expectedInventory[0]!] as const;
    expect(state.assessReadiness({
      inventory: humanOnly,
      resolveTrustedInventoryCommitment: commitmentFor(humanOnly),
    })).toEqual({
      kind: "unauthorized-namespace",
      namespaceId: namespaceId("namespace_room"),
      keyClass: "ai",
    });

    const nextGeneration = trustedHeadFixture(state, {
      namespace: "namespace_room",
      domain: "domain_ab",
      currentGeneration: 2,
    });
    const generationInventory = state.expectedInventory.map((item) => ({
      ...item,
      trustedNamespaceHead: nextGeneration.head,
    }));
    expect(state.assessReadiness({
      inventory: generationInventory,
      resolveTrustedInventoryCommitment: commitmentFor(generationInventory),
    })).toEqual({
      kind: "unauthorized-namespace",
      namespaceId: namespaceId("namespace_room"),
      keyClass: "ai",
    });

    const nextRevision = trustedHeadFixture(state, {
      namespace: "namespace_room",
      domain: "domain_ab",
      accessRevision: 1,
    });
    const revisionInventory = state.expectedInventory.map((item) => ({
      ...item,
      trustedNamespaceHead: nextRevision.head,
    }));
    expect(state.assessReadiness({
      inventory: revisionInventory,
      resolveTrustedInventoryCommitment: commitmentFor(revisionInventory),
    })).toEqual({
      kind: "unauthorized-namespace",
      namespaceId: namespaceId("namespace_room"),
      keyClass: "ai",
    });

    const extra = trustedHeadFixture(state, {
      namespace: "namespace_extra",
      domain: "domain_extra",
    });
    const extraInventory = [
      ...state.expectedInventory,
      {
        authorizedHumanId: state.targetHumanId,
        trustedNamespaceHead: extra.head,
        keyClass: "human" as const,
      },
    ];
    expect(state.assessReadiness({
      inventory: extraInventory,
      resolveTrustedInventoryCommitment: commitmentFor(extraInventory),
    })).toEqual({
      kind: "unauthorized-namespace",
      namespaceId: namespaceId("namespace_extra"),
      keyClass: "human",
    });
  });

  test("orders multi-Domain join intents deterministically by Domain id", async () => {
    const state = await setup();
    const extra = trustedHeadFixture(state, {
      namespace: "namespace_alpha",
      domain: "domain_z",
    });
    const extraSources: readonly DeviceTransferKeyringSourceV2[] = [
      {
        authorizedHumanId: state.targetHumanId,
        trustedNamespaceHead: extra.head,
        keyClass: "human",
        currentKeyringEnvelope: extra.humanEnvelope,
        currentDomainRoot: extra.humanRoot,
        resolveHistoricalCommitter: () => state.issuerSigning.publicKey,
      },
      {
        authorizedHumanId: state.targetHumanId,
        trustedNamespaceHead: extra.head,
        keyClass: "ai",
        currentKeyringEnvelope: extra.aiEnvelope,
        currentDomainRoot: extra.aiRoot,
        resolveHistoricalCommitter: () => state.issuerSigning.publicKey,
      },
    ];
    const sources = [...extraSources, ...state.sources];
    const inventory = sources.map(
      ({ authorizedHumanId, trustedNamespaceHead, keyClass }) => ({
        authorizedHumanId,
        trustedNamespaceHead,
        keyClass,
      }),
    );
    const published = await publishHumanRecoveryArchiveV2({
      crypto: state.crypto,
      humanId: state.targetHumanId,
      recoveryKeyId: state.recoveryKeyId,
      recoveryGeneration: state.recoveryGeneration,
      recoveryPublicKey: state.recoveryEncryption.publicKey,
      resolveTrustedCurrentRecoveryKey:
        state.resolveTrustedCurrentRecoveryKey,
      issuerDeviceId: state.issuerDeviceId,
      createdAt: state.createdAt,
      sources,
      issuerSigningPrivateKey: state.issuerSigning.privateKey,
      resolveIssuerDevice: () => state.issuerSigning.publicKey,
    });
    const archiveDigest = state.crypto.hash(published.archiveBytes);
    const restored = await openHumanRecoveryArchiveV2({
      crypto: state.crypto,
      archiveBytes: published.archiveBytes,
      humanId: state.targetHumanId,
      currentRecoveryKeyId: state.recoveryKeyId,
      currentRecoveryGeneration: state.recoveryGeneration,
      recoveryPrivateKey: state.recoveryEncryption.privateKey,
      resolveTrustedCurrentRecoveryKey:
        state.resolveTrustedCurrentRecoveryKey,
      expectedInventory: inventory,
      resolveIssuerDevice: () => state.issuerSigning.publicKey,
    });
    const revision = deviceTransferInventoryRevision(12);
    const inventoryDigest = deviceTransferInventoryDigestV2({
      humanId: state.targetHumanId,
      inventoryRevision: revision,
      inventory,
    });
    const readinessEvidence = {
      pendingDevice: state.pendingDevice,
      hasAuthorizedDeviceTransferSource: false,
      recoveryCredential: {
        recoveryKeyId: state.recoveryKeyId,
        recoveryGeneration: state.recoveryGeneration,
      },
      archiveRecoveryKey: {
        recoveryKeyId: state.recoveryKeyId,
        recoveryGeneration: state.recoveryGeneration,
      },
      recoveryArchiveDigest: archiveDigest,
      inventoryRevision: revision,
      resolveTrustedInventoryCommitment: () => ({
        humanId: state.targetHumanId,
        inventoryRevision: revision,
        inventoryCount: inventory.length,
        inventoryDigest,
      }),
      inventory,
      restoredKeyrings: restored,
      liveDomains: [
        {
          domainId: cryptoDomainId("domain_z"),
          domainEpoch: domainEpoch(3),
          committerDeviceId: state.issuerDeviceId,
        },
        {
          domainId: cryptoDomainId("domain_ab"),
          domainEpoch: domainEpoch(3),
          committerDeviceId: state.issuerDeviceId,
        },
      ],
    } as const;
    const readiness = assessRecoveryDeviceReadinessV2(readinessEvidence);
    expect(readiness.kind).toBe("ready-for-live-join");
    if (readiness.kind !== "ready-for-live-join") {
      throw new Error("expected live join readiness");
    }
    expect(readiness.joinIntents.map((intent) => intent.domainId)).toEqual([
      cryptoDomainId("domain_ab"),
      cryptoDomainId("domain_z"),
    ]);

    const rebootstrapEvidence = {
      ...readinessEvidence,
      liveDomains: readinessEvidence.liveDomains.map((domain) => ({
        ...domain,
        committerDeviceId: null,
      })),
    };
    const rebootstrap = assessRecoveryDeviceReadinessV2(rebootstrapEvidence);
    if (rebootstrap.kind !== "rebootstrap-required") {
      throw new Error("expected multi-Domain rebootstrap readiness");
    }
    expect(() =>
      verifyRecoveryDeviceReadinessV2({
        readiness: {
          ...rebootstrap,
          rebootstrapDomains: [
            rebootstrap.rebootstrapDomains[0]!,
            cryptoDomainId("domain_other"),
          ],
        },
        evidence: rebootstrapEvidence,
      })
    ).toThrow(
      "Recovery activation requires authenticated complete archive readiness",
    );
  });

  test("separates live current-Domain joins from explicit recovery-only rebootstrap", async () => {
    const state = await setup();
    const ready = state.assessReadiness();
    expect(() => state.verifyReadiness(ready)).not.toThrow();
    expect(ready).toMatchObject({
      kind: "ready-for-live-join",
      inventoryRevision: state.inventoryRevision,
      inventoryCount: 2,
      inventoryDigest: state.inventoryDigest,
      recoveryArchiveDigest: state.recoveryArchiveDigest,
      joinIntents: [{
        targetDeviceId: state.targetDeviceId,
        committerDeviceId: state.issuerDeviceId,
      }],
    });
    const rebootstrapLiveDomains = [{
      domainId: cryptoDomainId("domain_ab"),
      domainEpoch: domainEpoch(3),
      committerDeviceId: null,
    }] as const;
    const rebootstrap = state.assessReadiness({
      liveDomains: rebootstrapLiveDomains,
    });
    expect(rebootstrap).toMatchObject({
      kind: "rebootstrap-required",
      joinIntents: [],
      rebootstrapDomains: [cryptoDomainId("domain_ab")],
    });
    if (rebootstrap.kind !== "rebootstrap-required") {
      throw new Error("expected recovery rebootstrap readiness");
    }
    expect(() =>
      state.verifyReadiness(rebootstrap, {
        liveDomains: rebootstrapLiveDomains,
      })
    ).not.toThrow();
    expect(() =>
      state.verifyReadiness({
        ...rebootstrap,
        rebootstrapDomains: [],
      }, {
        liveDomains: rebootstrapLiveDomains,
      })
    ).toThrow(
      "Recovery activation requires authenticated complete archive readiness",
    );
    expect(() =>
      state.assessReadiness({
        liveDomains: [],
      })
    ).toThrow("exact live Domain inventory");
    expect(() =>
      state.assessReadiness({
        liveDomains: [{
          domainId: cryptoDomainId("domain_ab"),
          domainEpoch: domainEpoch(2),
          committerDeviceId: state.issuerDeviceId,
        }],
      })
    ).toThrow("stale or inconsistent");
  });
});
