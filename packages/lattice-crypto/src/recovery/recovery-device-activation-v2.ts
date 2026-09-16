import { sha256 } from "@noble/hashes/sha2.js";
import type { LatticeCrypto } from "../crypto/index.ts";
import {
  assertTrustedCurrentRecoveryKey,
  recoveryKeyGeneration,
  recoveryPublicKeyDigest,
  type RecoveryKeyGeneration,
  type ResolveTrustedCurrentRecoveryKeyV2,
} from "../format/recovery-v2.ts";
import {
  CanonicalDecodingError,
  StrictDecoder,
  concatV2,
  decodeExact,
  encodeU32,
  encodeU64,
  frame,
  frameText,
} from "../format/v2-primitives.ts";
import {
  assertPortableId,
  cryptoDeviceId,
  humanId,
  unixTimestamp,
  type CryptoDeviceId,
  type HumanId,
  type UnixTimestamp,
} from "../v2-types/ids.ts";
import { V2_LIMITS, assertV2Limit } from "../v2-types/limits.ts";
import { copyOwnedBytesV2 } from "../v2-types/opaque.ts";
import {
  DEVICE_TRANSFER_FORMAT_VERSION,
  HASH_BYTES,
  INVENTORY_COMMITMENT_FIELDS,
  MAX_METADATA_BYTES,
  RECOVERY_CHALLENGE_FIELDS,
  RECOVERY_DEVICE_ACTIVATION_DOMAIN,
  RECOVERY_PROOF_FIELDS,
  RECOVERY_VERIFIER_FIELDS,
  assertBytes,
  assertExactFields,
  deviceTransferInventoryRevision,
  equalBytes,
  pendingDeviceRevision,
  predictedHpkeCiphertextBytes,
  readExactText,
  resolvePending,
  validatePendingCandidate,
  type DeviceTransferInventoryRevision,
  type DeviceTransferPendingDeviceV2,
  type PendingDeviceRevision,
  type ResolveTrustedDeviceTransferInventoryCommitmentV2,
  type ResolveTrustedPendingDeviceV2,
} from "./device-transfer-common-v2.ts";
import {
  recoveryReadinessDigest,
  verifyRecoveryDeviceReadinessV2,
  type RecoveryDeviceReadinessV2,
  type RecoveryDeviceReadinessEvidenceV2,
} from "./recovery-readiness-v2.ts";

export interface RecoveryDeviceActivationChallengeV2 {
  readonly formatVersion: 2;
  readonly challengeId: string;
  readonly humanId: HumanId;
  readonly targetDeviceId: CryptoDeviceId;
  readonly pendingDeviceRevision: PendingDeviceRevision;
  readonly encryptionPublicKeyDigest: Uint8Array;
  readonly signingPublicKeyDigest: Uint8Array;
  readonly recoveryKeyId: string;
  readonly recoveryGeneration: RecoveryKeyGeneration;
  readonly recoveryPublicKeyDigest: Uint8Array;
  readonly recoveryArchiveDigest: Uint8Array;
  readonly inventoryRevision: DeviceTransferInventoryRevision;
  readonly inventoryCount: number;
  readonly inventoryDigest: Uint8Array;
  readonly issuedAt: UnixTimestamp;
  readonly expiresAt: UnixTimestamp;
  readonly ciphertext: Uint8Array;
}

export interface RecoveryDeviceActivationProofV2 {
  readonly formatVersion: 2;
  readonly challengeHash: Uint8Array;
  readonly readinessDigest: Uint8Array;
  readonly response: Uint8Array;
}

/**
 * A deliberately narrow recovery proof for replacing a lost Human-device MLS
 * lineage. Unlike the legacy activation proof, this proves only possession of
 * the current recovery key; it does not claim that an account-wide key
 * inventory has already been restored.
 */
export interface RecoveryDevicePossessionProofV2 {
  readonly formatVersion: 2;
  readonly challengeHash: Uint8Array;
  readonly response: Uint8Array;
}

export interface RecoveryDeviceActivationVerifierV2 {
  readonly challengeId: string;
  readonly challengeHash: Uint8Array;
  readonly expectedResponseDigest: Uint8Array;
  readonly expectedStatus: "pending";
}

export interface PreparedRecoveryDeviceActivationChallengeV2 {
  readonly challenge: RecoveryDeviceActivationChallengeV2;
  readonly challengeBytes: Uint8Array;
  readonly verifier: RecoveryDeviceActivationVerifierV2;
  readonly publicationCas: {
    readonly challengeId: string;
    readonly expectedStatus: "absent";
    readonly intendedStatus: "pending";
    readonly intendedChallengeHash: Uint8Array;
  };
}

export type ResolveTrustedRecoveryDeviceActivationChallengeV2 = (
  challengeId: string,
) => RecoveryDeviceActivationVerifierV2 | null;

export interface VerifiedRecoveryDeviceActivationV2 {
  readonly activationCas: {
    readonly humanId: HumanId;
    readonly deviceId: CryptoDeviceId;
    readonly expectedStatus: "pending";
    readonly expectedPendingDeviceRevision: PendingDeviceRevision;
    readonly expectedPendingEncryptionPublicKeyDigest: Uint8Array;
    readonly expectedPendingSigningPublicKeyDigest: Uint8Array;
    readonly intendedStatus: "active";
    readonly recoveryKeyId: string;
    readonly expectedRecoveryGeneration: RecoveryKeyGeneration;
    readonly expectedRecoveryPublicKeyDigest: Uint8Array;
    readonly recoveryArchiveDigest: Uint8Array;
    readonly expectedInventoryRevision: DeviceTransferInventoryRevision;
    readonly expectedInventoryCount: number;
    readonly expectedInventoryDigest: Uint8Array;
    readonly challengeId: string;
    readonly expectedChallengeStatus: "pending";
    readonly intendedChallengeStatus: "consumed";
    readonly expectedChallengeHash: Uint8Array;
  };
}

function assertRecoveryChallengeWireBytes(
  bytes: unknown,
): asserts bytes is Uint8Array {
  if (
    !(bytes instanceof Uint8Array)
    || bytes.length > V2_LIMITS.ciphertextBytes + MAX_METADATA_BYTES
  ) {
    throw new CanonicalDecodingError(
      "Recovery device challenge exceeds wire limits",
    );
  }
}

function assertRecoveryProofWireBytes(
  bytes: unknown,
): asserts bytes is Uint8Array {
  if (!(bytes instanceof Uint8Array) || bytes.length > MAX_METADATA_BYTES) {
    throw new CanonicalDecodingError(
      "Recovery device proof exceeds wire limits",
    );
  }
}

function validateRecoveryChallenge(
  value: RecoveryDeviceActivationChallengeV2,
): void {
  if (typeof value !== "object" || value === null) {
    throw new TypeError("Recovery device challenge must be an object");
  }
  assertExactFields(
    "Recovery device challenge",
    value,
    RECOVERY_CHALLENGE_FIELDS,
  );
  if (value.formatVersion !== DEVICE_TRANSFER_FORMAT_VERSION) {
    throw new RangeError("Recovery device challenge version is unsupported");
  }
  assertPortableId("Recovery device challenge id", value.challengeId);
  humanId(value.humanId);
  cryptoDeviceId(value.targetDeviceId);
  pendingDeviceRevision(value.pendingDeviceRevision);
  assertBytes(
    "Recovery device encryption-key digest",
    value.encryptionPublicKeyDigest,
    HASH_BYTES,
  );
  assertBytes(
    "Recovery device signing-key digest",
    value.signingPublicKeyDigest,
    HASH_BYTES,
  );
  assertPortableId("Recovery device key id", value.recoveryKeyId);
  recoveryKeyGeneration(value.recoveryGeneration);
  assertBytes(
    "Recovery device public-key digest",
    value.recoveryPublicKeyDigest,
    HASH_BYTES,
  );
  assertBytes(
    "Recovery device archive digest",
    value.recoveryArchiveDigest,
    HASH_BYTES,
  );
  deviceTransferInventoryRevision(value.inventoryRevision);
  assertV2Limit(
    "Recovery device inventory count",
    value.inventoryCount,
    V2_LIMITS.recoveryPackages,
  );
  assertBytes(
    "Recovery device inventory digest",
    value.inventoryDigest,
    HASH_BYTES,
  );
  unixTimestamp(value.issuedAt);
  unixTimestamp(value.expiresAt);
  if (value.expiresAt <= value.issuedAt) {
    throw new RangeError(
      "Recovery device challenge expiry must follow issuance",
    );
  }
  if (value.expiresAt - value.issuedAt > V2_LIMITS.grantTtlMs) {
    throw new RangeError(
      "Recovery device challenge lifetime exceeds the 24-hour limit",
    );
  }
  if (
    !(value.ciphertext instanceof Uint8Array)
    || value.ciphertext.length < 1
    || value.ciphertext.length > V2_LIMITS.ciphertextBytes
  ) {
    throw new RangeError("Recovery device challenge ciphertext is invalid");
  }
}

function recoveryChallengeMetadataBytes(
  value: Omit<RecoveryDeviceActivationChallengeV2, "ciphertext">
    | RecoveryDeviceActivationChallengeV2,
): Uint8Array {
  return concatV2(
    frameText(RECOVERY_DEVICE_ACTIVATION_DOMAIN),
    frameText("challenge"),
    encodeU32(DEVICE_TRANSFER_FORMAT_VERSION),
    frameText(value.challengeId),
    frameText(value.humanId),
    frameText(value.targetDeviceId),
    encodeU64(value.pendingDeviceRevision),
    frame(value.encryptionPublicKeyDigest),
    frame(value.signingPublicKeyDigest),
    frameText(value.recoveryKeyId),
    encodeU64(value.recoveryGeneration),
    frame(value.recoveryPublicKeyDigest),
    frame(value.recoveryArchiveDigest),
    encodeU64(value.inventoryRevision),
    encodeU32(value.inventoryCount),
    frame(value.inventoryDigest),
    encodeU64(value.issuedAt),
    encodeU64(value.expiresAt),
  );
}

export function serializeRecoveryDeviceActivationChallenge(
  value: RecoveryDeviceActivationChallengeV2,
): Uint8Array {
  validateRecoveryChallenge(value);
  return concatV2(
    recoveryChallengeMetadataBytes(value),
    frame(value.ciphertext),
  );
}

export function decodeRecoveryDeviceActivationChallenge(
  bytes: Uint8Array,
): RecoveryDeviceActivationChallengeV2 {
  assertRecoveryChallengeWireBytes(bytes);
  return decodeExact(bytes, (reader) => {
    readExactText(
      reader,
      RECOVERY_DEVICE_ACTIVATION_DOMAIN,
      "Recovery device activation domain",
    );
    readExactText(reader, "challenge", "Recovery device activation kind");
    reader.readVersion(DEVICE_TRANSFER_FORMAT_VERSION);
    const challenge: RecoveryDeviceActivationChallengeV2 = {
      formatVersion: DEVICE_TRANSFER_FORMAT_VERSION,
      challengeId: reader.readText(V2_LIMITS.idBytes),
      humanId: humanId(reader.readText(V2_LIMITS.idBytes)),
      targetDeviceId: cryptoDeviceId(reader.readText(V2_LIMITS.idBytes)),
      pendingDeviceRevision: pendingDeviceRevision(reader.readU64()),
      encryptionPublicKeyDigest: reader.readFrame(HASH_BYTES),
      signingPublicKeyDigest: reader.readFrame(HASH_BYTES),
      recoveryKeyId: reader.readText(V2_LIMITS.idBytes),
      recoveryGeneration: recoveryKeyGeneration(reader.readU64()),
      recoveryPublicKeyDigest: reader.readFrame(HASH_BYTES),
      recoveryArchiveDigest: reader.readFrame(HASH_BYTES),
      inventoryRevision:
        deviceTransferInventoryRevision(reader.readU64()),
      inventoryCount: reader.readCount(V2_LIMITS.recoveryPackages),
      inventoryDigest: reader.readFrame(HASH_BYTES),
      issuedAt: unixTimestamp(reader.readU64()),
      expiresAt: unixTimestamp(reader.readU64()),
      ciphertext: reader.readFrame(V2_LIMITS.ciphertextBytes),
    };
    validateRecoveryChallenge(challenge);
    return Object.freeze(challenge);
  });
}

function validateRecoveryProof(
  value: RecoveryDeviceActivationProofV2,
): void {
  if (typeof value !== "object" || value === null) {
    throw new TypeError("Recovery device proof must be an object");
  }
  assertExactFields(
    "Recovery device proof",
    value,
    RECOVERY_PROOF_FIELDS,
  );
  if (value.formatVersion !== DEVICE_TRANSFER_FORMAT_VERSION) {
    throw new RangeError("Recovery device proof version is unsupported");
  }
  assertBytes("Recovery device challenge hash", value.challengeHash, HASH_BYTES);
  assertBytes("Recovery device readiness digest", value.readinessDigest, HASH_BYTES);
  assertBytes("Recovery device challenge response", value.response, HASH_BYTES);
}

export function serializeRecoveryDeviceActivationProof(
  value: RecoveryDeviceActivationProofV2,
): Uint8Array {
  validateRecoveryProof(value);
  return concatV2(
    frameText(RECOVERY_DEVICE_ACTIVATION_DOMAIN),
    frameText("proof"),
    encodeU32(DEVICE_TRANSFER_FORMAT_VERSION),
    frame(value.challengeHash),
    frame(value.readinessDigest),
    frame(value.response),
  );
}

export function decodeRecoveryDeviceActivationProof(
  bytes: Uint8Array,
): RecoveryDeviceActivationProofV2 {
  assertRecoveryProofWireBytes(bytes);
  const reader = new StrictDecoder(bytes);
  let challengeHash: Uint8Array = new Uint8Array();
  let readinessDigest: Uint8Array = new Uint8Array();
  let response: Uint8Array = new Uint8Array();
  let succeeded = false;
  try {
    readExactText(
      reader,
      RECOVERY_DEVICE_ACTIVATION_DOMAIN,
      "Recovery device activation domain",
    );
    readExactText(reader, "proof", "Recovery device activation kind");
    reader.readVersion(DEVICE_TRANSFER_FORMAT_VERSION);
    challengeHash = reader.readFrame(HASH_BYTES);
    readinessDigest = reader.readFrame(HASH_BYTES);
    response = reader.readFrame(HASH_BYTES);
    reader.assertFinished();
    const proof = {
      formatVersion: DEVICE_TRANSFER_FORMAT_VERSION,
      challengeHash,
      readinessDigest,
      response,
    } as const;
    validateRecoveryProof(proof);
    const result = Object.freeze({
      ...proof,
      challengeHash,
      response,
    });
    succeeded = true;
    return result;
  } catch (error) {
    challengeHash.fill(0);
    readinessDigest.fill(0);
    response.fill(0);
    throw error;
  } finally {
    reader.destroy(!succeeded);
  }
}

function recoveryResponseDigest(
  challengeHash: Uint8Array,
  response: Uint8Array,
): Uint8Array {
  const framedChallengeHash = frame(challengeHash);
  const framedResponse = frame(response);
  const material = concatV2(
    frameText(RECOVERY_DEVICE_ACTIVATION_DOMAIN),
    frameText("response"),
    framedChallengeHash,
    framedResponse,
  );
  try {
    return sha256(material);
  } finally {
    framedChallengeHash.fill(0);
    framedResponse.fill(0);
    material.fill(0);
  }
}

function assertCurrentRecoveryIdentity(
  human: HumanId,
  recoveryKeyIdValue: string,
  recoveryGenerationValue: RecoveryKeyGeneration,
  publicKeyDigest: Uint8Array,
  resolver: ResolveTrustedCurrentRecoveryKeyV2,
): void {
  const trusted = resolver(human);
  if (trusted === null) {
    throw new Error("Current trusted recovery key is required");
  }
  assertTrustedCurrentRecoveryKey(trusted);
  if (
    trusted.humanId !== human
    || trusted.recoveryKeyId !== recoveryKeyIdValue
    || trusted.recoveryGeneration !== recoveryGenerationValue
    || !equalBytes(trusted.publicKeyDigest, publicKeyDigest)
  ) {
    throw new Error("Recovery device challenge uses a stale recovery key");
  }
}

export type RecoveryDeviceChallengePreparationInputV2 = {
  readonly crypto: LatticeCrypto;
  readonly challengeId: string;
  readonly pendingDevice: DeviceTransferPendingDeviceV2;
  readonly resolveTrustedPendingDevice: ResolveTrustedPendingDeviceV2;
  readonly recoveryKeyId: string;
  readonly recoveryGeneration: RecoveryKeyGeneration;
  readonly recoveryPublicKey: Uint8Array;
  readonly resolveTrustedCurrentRecoveryKey:
    ResolveTrustedCurrentRecoveryKeyV2;
  readonly recoveryArchiveDigest: Uint8Array;
  readonly inventoryRevision: DeviceTransferInventoryRevision;
  readonly resolveTrustedInventoryCommitment:
    ResolveTrustedDeviceTransferInventoryCommitmentV2;
  readonly issuedAt: UnixTimestamp;
  readonly expiresAt: UnixTimestamp;
};

async function prepareRecoveryDeviceChallengeV2(
  input: RecoveryDeviceChallengePreparationInputV2 & Readonly<{
    requireRestoredInventory: boolean;
  }>,
): Promise<PreparedRecoveryDeviceActivationChallengeV2> {
  assertPortableId("Recovery device challenge id", input.challengeId);
  const checkedPending = validatePendingCandidate(input.pendingDevice);
  const recoveryKeyIdValue = (() => {
    assertPortableId("Recovery device key id", input.recoveryKeyId);
    return input.recoveryKeyId;
  })();
  const generation = recoveryKeyGeneration(input.recoveryGeneration);
  assertBytes(
    "Recovery device public key",
    input.recoveryPublicKey,
    V2_LIMITS.hpkePublicKeyBytes,
  );
  const recoveryPublicKey = copyOwnedBytesV2(input.recoveryPublicKey);
  const publicDigest = recoveryPublicKeyDigest(recoveryPublicKey);
  assertBytes(
    "Recovery device archive digest",
    input.recoveryArchiveDigest,
    HASH_BYTES,
  );
  const inventoryRevisionValue = deviceTransferInventoryRevision(
    input.inventoryRevision,
  );
  const issuedAt = unixTimestamp(input.issuedAt);
  const expiresAt = unixTimestamp(input.expiresAt);
  if (expiresAt <= issuedAt) {
    throw new RangeError(
      "Recovery device challenge expiry must follow issuance",
    );
  }
  if (expiresAt - issuedAt > V2_LIMITS.grantTtlMs) {
    throw new RangeError(
      "Recovery device challenge lifetime exceeds the 24-hour limit",
    );
  }
  const pending = resolvePending(
    checkedPending,
    input.resolveTrustedPendingDevice,
  );
  assertCurrentRecoveryIdentity(
    pending.pending.humanId,
    recoveryKeyIdValue,
    generation,
    publicDigest,
    input.resolveTrustedCurrentRecoveryKey,
  );
  const inventoryCommitment =
    input.resolveTrustedInventoryCommitment(pending.pending.humanId);
  if (inventoryCommitment === null) {
    throw new Error(
      "Authoritative device-transfer inventory commitment is required",
    );
  }
  if (typeof inventoryCommitment !== "object") {
    throw new TypeError(
      "Device-transfer inventory commitment must be an object",
    );
  }
  assertExactFields(
    "Device-transfer inventory commitment",
    inventoryCommitment,
    INVENTORY_COMMITMENT_FIELDS,
  );
  assertBytes(
    "Device-transfer inventory commitment digest",
    inventoryCommitment.inventoryDigest,
    HASH_BYTES,
  );
  if (
    humanId(inventoryCommitment.humanId) !== pending.pending.humanId
    || deviceTransferInventoryRevision(
      inventoryCommitment.inventoryRevision,
    ) !== inventoryRevisionValue
    || (assertV2Limit(
      "Device-transfer inventory commitment count",
      inventoryCommitment.inventoryCount,
      V2_LIMITS.recoveryPackages,
    ) === 0 && input.requireRestoredInventory)
  ) {
    throw new Error(
      "Recovery challenge inventory commitment is stale or empty",
    );
  }
  const metadata = {
    formatVersion: DEVICE_TRANSFER_FORMAT_VERSION,
    challengeId: input.challengeId,
    humanId: pending.pending.humanId,
    targetDeviceId: pending.pending.deviceId,
    pendingDeviceRevision: pending.pending.pendingDeviceRevision,
    encryptionPublicKeyDigest: copyOwnedBytesV2(
      pending.encryptionDigest,
    ),
    signingPublicKeyDigest: copyOwnedBytesV2(pending.signingDigest),
    recoveryKeyId: recoveryKeyIdValue,
    recoveryGeneration: generation,
    recoveryPublicKeyDigest: copyOwnedBytesV2(publicDigest),
    recoveryArchiveDigest: copyOwnedBytesV2(
      input.recoveryArchiveDigest,
    ),
    inventoryRevision: inventoryRevisionValue,
    inventoryCount: inventoryCommitment.inventoryCount,
    inventoryDigest: copyOwnedBytesV2(
      inventoryCommitment.inventoryDigest,
    ),
    issuedAt,
    expiresAt,
  } satisfies Omit<RecoveryDeviceActivationChallengeV2, "ciphertext">;
  const generatedSecret = input.crypto.randomBytes(HASH_BYTES);
  let secret: Uint8Array;
  try {
    assertBytes(
      "Recovery device challenge random secret",
      generatedSecret,
      HASH_BYTES,
    );
    secret = copyOwnedBytesV2(generatedSecret);
  } finally {
    generatedSecret.fill(0);
  }
  let plaintext: Uint8Array | null = null;
  let metadataBytes: Uint8Array | null = null;
  let framedMetadata: Uint8Array | null = null;
  let framedSecret: Uint8Array | null = null;
  try {
    metadataBytes = recoveryChallengeMetadataBytes(metadata);
    framedMetadata = frame(metadataBytes);
    framedSecret = frame(secret);
    plaintext = concatV2(framedMetadata, framedSecret);
    const predictedCiphertext = predictedHpkeCiphertextBytes(plaintext.length);
    assertV2Limit(
      "Recovery device challenge ciphertext",
      predictedCiphertext,
      V2_LIMITS.ciphertextBytes,
    );
    const ciphertext = await input.crypto.sealTo(
      recoveryPublicKey,
      plaintext,
    );
    if (ciphertext.length !== predictedCiphertext) {
      throw new Error("Recovery device challenge HPKE is noncanonical");
    }
    const challenge = Object.freeze({
      ...metadata,
      ciphertext: copyOwnedBytesV2(ciphertext),
    });
    const challengeBytes =
      serializeRecoveryDeviceActivationChallenge(challenge);
    const challengeHash = sha256(challengeBytes);
    return Object.freeze({
      challenge,
      challengeBytes: copyOwnedBytesV2(challengeBytes),
      verifier: Object.freeze({
        challengeId: input.challengeId,
        challengeHash: copyOwnedBytesV2(challengeHash),
        expectedResponseDigest:
          copyOwnedBytesV2(
            recoveryResponseDigest(challengeHash, secret),
          ),
        expectedStatus: "pending",
      }),
      publicationCas: Object.freeze({
        challengeId: input.challengeId,
        expectedStatus: "absent",
        intendedStatus: "pending",
        intendedChallengeHash: copyOwnedBytesV2(challengeHash),
      }),
    });
  } finally {
    secret.fill(0);
    plaintext?.fill(0);
    metadataBytes?.fill(0);
    framedMetadata?.fill(0);
    framedSecret?.fill(0);
  }
}

export function prepareRecoveryDeviceActivationChallengeV2(
  input: RecoveryDeviceChallengePreparationInputV2,
): Promise<PreparedRecoveryDeviceActivationChallengeV2> {
  return prepareRecoveryDeviceChallengeV2({
    ...input,
    requireRestoredInventory: true,
  });
}

/**
 * Prepares the one-time proof used to replace a lost Human-device MLS fleet.
 * Empty Domain inventories are valid because this flow proves only recovery
 * key possession; it does not assert that retained object keys were restored.
 */
export function prepareRecoveryDevicePossessionChallengeV2(
  input: RecoveryDeviceChallengePreparationInputV2,
): Promise<PreparedRecoveryDeviceActivationChallengeV2> {
  return prepareRecoveryDeviceChallengeV2({
    ...input,
    requireRestoredInventory: false,
  });
}

export async function answerRecoveryDeviceActivationChallengeV2(input: {
  readonly crypto: LatticeCrypto;
  readonly challengeBytes: Uint8Array;
  readonly pendingDevice: DeviceTransferPendingDeviceV2;
  readonly resolveTrustedPendingDevice: ResolveTrustedPendingDeviceV2;
  readonly recoveryPublicKey: Uint8Array;
  readonly recoveryPrivateKey: Uint8Array;
  readonly resolveTrustedCurrentRecoveryKey:
    ResolveTrustedCurrentRecoveryKeyV2;
  readonly expectedRecoveryArchiveDigest: Uint8Array;
  readonly readiness: RecoveryDeviceReadinessV2;
  readonly readinessEvidence: RecoveryDeviceReadinessEvidenceV2;
  readonly currentTime: UnixTimestamp;
}): Promise<RecoveryDeviceActivationProofV2> {
  if (!(input.challengeBytes instanceof Uint8Array)) {
    throw new TypeError("Recovery device challenge bytes must be bytes");
  }
  const challengeBytes = input.challengeBytes;
  assertRecoveryChallengeWireBytes(challengeBytes);
  const challengeHash = sha256(challengeBytes);
  assertBytes(
    "Recovery device private key",
    input.recoveryPrivateKey,
    V2_LIMITS.hpkePrivateKeyBytes,
  );
  const recoveryPrivateKey = copyOwnedBytesV2(
    input.recoveryPrivateKey,
  );
  try {
    const checkedPending = validatePendingCandidate(input.pendingDevice);
    const challenge = decodeRecoveryDeviceActivationChallenge(
      challengeBytes,
    );
  const publicDigest = recoveryPublicKeyDigest(input.recoveryPublicKey);
  assertBytes(
    "Expected recovery archive digest",
    input.expectedRecoveryArchiveDigest,
    HASH_BYTES,
  );
  const now = unixTimestamp(input.currentTime);
  if (now < challenge.issuedAt || now >= challenge.expiresAt) {
    throw new Error("Recovery device challenge is not currently valid");
  }
  const readiness = verifyRecoveryDeviceReadinessV2({
    readiness: input.readiness,
    evidence: {
      ...input.readinessEvidence,
      pendingDevice: checkedPending,
    },
  });
  const readinessDigest = copyOwnedBytesV2(readiness.readinessDigest);
  const candidateEncryptionDigest =
    sha256(checkedPending.encryptionPublicKey);
  const candidateSigningDigest =
    sha256(checkedPending.signingPublicKey);
  if (
    challenge.targetDeviceId !== checkedPending.deviceId
    || challenge.pendingDeviceRevision
      !== checkedPending.pendingDeviceRevision
    || !equalBytes(
      challenge.encryptionPublicKeyDigest,
      candidateEncryptionDigest,
    )
    || !equalBytes(challenge.signingPublicKeyDigest, candidateSigningDigest)
    || !equalBytes(challenge.recoveryPublicKeyDigest, publicDigest)
    || !equalBytes(
      challenge.recoveryArchiveDigest,
      input.expectedRecoveryArchiveDigest,
    )
    || !equalBytes(
      challenge.recoveryArchiveDigest,
      readiness.recoveryArchiveDigest,
    )
    || !equalBytes(
      challenge.inventoryDigest,
      readiness.inventoryDigest,
    )
    || challenge.inventoryRevision !== readiness.inventoryRevision
    || challenge.inventoryCount !== readiness.inventoryCount
    || !equalBytes(
      readinessDigest,
      recoveryReadinessDigest(
        challenge.recoveryArchiveDigest,
        {
          humanId: challenge.humanId,
          inventoryRevision: challenge.inventoryRevision,
          inventoryCount: challenge.inventoryCount,
          inventoryDigest: challenge.inventoryDigest,
        },
      ),
    )
  ) {
    throw new Error(
      "Recovery device challenge is detached from trusted recovery state",
    );
  }
  const pending = resolvePending(
    checkedPending,
    input.resolveTrustedPendingDevice,
  );
  assertCurrentRecoveryIdentity(
    pending.pending.humanId,
    challenge.recoveryKeyId,
    challenge.recoveryGeneration,
    publicDigest,
    input.resolveTrustedCurrentRecoveryKey,
  );
  const plaintext = await input.crypto.openSealed(
    recoveryPrivateKey,
    challenge.ciphertext,
  );
  if (plaintext === null) {
    throw new Error("Recovery device challenge failed to decrypt");
  }
  try {
    const reader = new StrictDecoder(plaintext);
    try {
      const embeddedMetadata = reader.readFrame(MAX_METADATA_BYTES);
      try {
        const expectedMetadata = recoveryChallengeMetadataBytes(challenge);
        try {
          if (
            !equalBytes(
              embeddedMetadata,
              expectedMetadata,
            )
          ) {
            throw new Error(
              "Recovery device challenge inner metadata does not match",
            );
          }
          const response = reader.readFrame(HASH_BYTES);
          try {
            reader.assertFinished();
            return Object.freeze({
              formatVersion: DEVICE_TRANSFER_FORMAT_VERSION,
              challengeHash,
              readinessDigest,
              response: copyOwnedBytesV2(response),
            });
          } finally {
            response.fill(0);
          }
        } finally {
          expectedMetadata.fill(0);
        }
      } finally {
        embeddedMetadata.fill(0);
      }
    } finally {
      reader.destroy(true);
    }
  } finally {
    plaintext.fill(0);
  }
  } finally {
    recoveryPrivateKey.fill(0);
  }
}

export async function answerRecoveryDevicePossessionChallengeV2(input: {
  readonly crypto: LatticeCrypto;
  readonly challengeBytes: Uint8Array;
  readonly pendingDevice: DeviceTransferPendingDeviceV2;
  readonly resolveTrustedPendingDevice: ResolveTrustedPendingDeviceV2;
  readonly recoveryPublicKey: Uint8Array;
  readonly recoveryPrivateKey: Uint8Array;
  readonly resolveTrustedCurrentRecoveryKey:
    ResolveTrustedCurrentRecoveryKeyV2;
  readonly currentTime: UnixTimestamp;
}): Promise<RecoveryDevicePossessionProofV2> {
  assertRecoveryChallengeWireBytes(input.challengeBytes);
  assertBytes(
    "Recovery device private key",
    input.recoveryPrivateKey,
    V2_LIMITS.hpkePrivateKeyBytes,
  );
  const challengeHash = sha256(input.challengeBytes);
  const checkedPending = validatePendingCandidate(input.pendingDevice);
  const challenge = decodeRecoveryDeviceActivationChallenge(
    input.challengeBytes,
  );
  const now = unixTimestamp(input.currentTime);
  if (now < challenge.issuedAt || now >= challenge.expiresAt) {
    throw new Error("Recovery device challenge is not currently valid");
  }
  const encryptionDigest = sha256(checkedPending.encryptionPublicKey);
  const signingDigest = sha256(checkedPending.signingPublicKey);
  const recoveryDigest = recoveryPublicKeyDigest(input.recoveryPublicKey);
  if (
    challenge.humanId !== checkedPending.humanId
    || challenge.targetDeviceId !== checkedPending.deviceId
    || challenge.pendingDeviceRevision
      !== checkedPending.pendingDeviceRevision
    || !equalBytes(challenge.encryptionPublicKeyDigest, encryptionDigest)
    || !equalBytes(challenge.signingPublicKeyDigest, signingDigest)
    || !equalBytes(challenge.recoveryPublicKeyDigest, recoveryDigest)
  ) {
    throw new Error(
      "Recovery device challenge is detached from the pending device",
    );
  }
  const pending = resolvePending(
    checkedPending,
    input.resolveTrustedPendingDevice,
  );
  assertCurrentRecoveryIdentity(
    pending.pending.humanId,
    challenge.recoveryKeyId,
    challenge.recoveryGeneration,
    recoveryDigest,
    input.resolveTrustedCurrentRecoveryKey,
  );
  const privateKey = copyOwnedBytesV2(input.recoveryPrivateKey);
  try {
    const plaintext = await input.crypto.openSealed(
      privateKey,
      challenge.ciphertext,
    );
    if (plaintext === null) {
      throw new Error("Recovery device challenge failed to decrypt");
    }
    try {
      const reader = new StrictDecoder(plaintext);
      const embeddedMetadata = reader.readFrame(MAX_METADATA_BYTES);
      try {
        const expectedMetadata = recoveryChallengeMetadataBytes(challenge);
        try {
          if (!equalBytes(embeddedMetadata, expectedMetadata)) {
            throw new Error(
              "Recovery device challenge inner metadata does not match",
            );
          }
        } finally {
          expectedMetadata.fill(0);
        }
      } finally {
        embeddedMetadata.fill(0);
      }
      const response = reader.readFrame(HASH_BYTES);
      try {
        reader.assertFinished();
        return Object.freeze({
          formatVersion: DEVICE_TRANSFER_FORMAT_VERSION,
          challengeHash,
          response: copyOwnedBytesV2(response),
        });
      } finally {
        response.fill(0);
      }
    } finally {
      plaintext.fill(0);
    }
  } finally {
    privateKey.fill(0);
  }
}

export function verifyRecoveryDevicePossessionProofV2(input: {
  readonly challengeBytes: Uint8Array;
  readonly proof: RecoveryDevicePossessionProofV2;
  readonly resolveTrustedChallenge:
    ResolveTrustedRecoveryDeviceActivationChallengeV2;
  readonly pendingDevice: DeviceTransferPendingDeviceV2;
  readonly resolveTrustedPendingDevice: ResolveTrustedPendingDeviceV2;
  readonly resolveTrustedCurrentRecoveryKey:
    ResolveTrustedCurrentRecoveryKeyV2;
  readonly currentTime: UnixTimestamp;
}): VerifiedRecoveryDeviceActivationV2 {
  assertRecoveryChallengeWireBytes(input.challengeBytes);
  const challenge = decodeRecoveryDeviceActivationChallenge(
    input.challengeBytes,
  );
  const challengeHash = sha256(input.challengeBytes);
  const proof = input.proof;
  if (
    proof.formatVersion !== DEVICE_TRANSFER_FORMAT_VERSION
    || !(proof.challengeHash instanceof Uint8Array)
    || !(proof.response instanceof Uint8Array)
  ) throw new TypeError("Recovery device possession proof is malformed");
  assertBytes("Recovery challenge hash", proof.challengeHash, HASH_BYTES);
  assertBytes("Recovery challenge response", proof.response, HASH_BYTES);
  const now = unixTimestamp(input.currentTime);
  if (now < challenge.issuedAt || now >= challenge.expiresAt) {
    throw new Error("Recovery device challenge is not currently valid");
  }
  const pending = resolvePending(
    validatePendingCandidate(input.pendingDevice),
    input.resolveTrustedPendingDevice,
  );
  const encryptionDigest = sha256(pending.pending.encryptionPublicKey);
  const signingDigest = sha256(pending.pending.signingPublicKey);
  if (
    challenge.humanId !== pending.pending.humanId
    || challenge.targetDeviceId !== pending.pending.deviceId
    || challenge.pendingDeviceRevision
      !== pending.pending.pendingDeviceRevision
    || !equalBytes(challenge.encryptionPublicKeyDigest, encryptionDigest)
    || !equalBytes(challenge.signingPublicKeyDigest, signingDigest)
    || !equalBytes(proof.challengeHash, challengeHash)
  ) throw new Error(
    "Recovery device proof does not match the exact pending challenge",
  );
  assertCurrentRecoveryIdentity(
    pending.pending.humanId,
    challenge.recoveryKeyId,
    challenge.recoveryGeneration,
    challenge.recoveryPublicKeyDigest,
    input.resolveTrustedCurrentRecoveryKey,
  );
  const verifier = input.resolveTrustedChallenge(challenge.challengeId);
  if (verifier === null || verifier.expectedStatus !== "pending"
    || verifier.challengeId !== challenge.challengeId
    || !equalBytes(verifier.challengeHash, challengeHash)
    || !equalBytes(
      recoveryResponseDigest(challengeHash, proof.response),
      verifier.expectedResponseDigest,
    )) throw new Error(
    "Recovery device proof does not match the exact pending challenge",
  );
  return Object.freeze({
    activationCas: Object.freeze({
      humanId: pending.pending.humanId,
      deviceId: pending.pending.deviceId,
      expectedStatus: "pending" as const,
      expectedPendingDeviceRevision:
        pending.pending.pendingDeviceRevision,
      expectedPendingEncryptionPublicKeyDigest: encryptionDigest,
      expectedPendingSigningPublicKeyDigest: signingDigest,
      intendedStatus: "active" as const,
      recoveryKeyId: challenge.recoveryKeyId,
      expectedRecoveryGeneration: challenge.recoveryGeneration,
      expectedRecoveryPublicKeyDigest:
        challenge.recoveryPublicKeyDigest,
      recoveryArchiveDigest: challenge.recoveryArchiveDigest,
      expectedInventoryRevision: challenge.inventoryRevision,
      expectedInventoryCount: challenge.inventoryCount,
      expectedInventoryDigest: challenge.inventoryDigest,
      challengeId: challenge.challengeId,
      expectedChallengeStatus: "pending" as const,
      intendedChallengeStatus: "consumed" as const,
      expectedChallengeHash: challengeHash,
    }),
  });
}

export function verifyRecoveryDeviceActivationProofV2(input: {
  readonly challengeBytes: Uint8Array;
  readonly proofBytes: Uint8Array;
  readonly resolveTrustedChallenge:
    ResolveTrustedRecoveryDeviceActivationChallengeV2;
  readonly pendingDevice: DeviceTransferPendingDeviceV2;
  readonly resolveTrustedPendingDevice: ResolveTrustedPendingDeviceV2;
  readonly resolveTrustedCurrentRecoveryKey:
    ResolveTrustedCurrentRecoveryKeyV2;
  readonly currentTime: UnixTimestamp;
}): VerifiedRecoveryDeviceActivationV2 {
  if (!(input.challengeBytes instanceof Uint8Array)) {
    throw new TypeError("Recovery device challenge bytes must be bytes");
  }
  if (!(input.proofBytes instanceof Uint8Array)) {
    throw new TypeError("Recovery device proof bytes must be bytes");
  }
  const challengeBytes = input.challengeBytes;
  const proofBytes = input.proofBytes;
  assertRecoveryChallengeWireBytes(challengeBytes);
  assertRecoveryProofWireBytes(proofBytes);
  const challengeHash = sha256(challengeBytes);
  const challenge = decodeRecoveryDeviceActivationChallenge(
    challengeBytes,
  );
  const proof = decodeRecoveryDeviceActivationProof(proofBytes);
  try {
    const checkedPending = validatePendingCandidate(input.pendingDevice);
    const now = unixTimestamp(input.currentTime);
    if (now < challenge.issuedAt || now >= challenge.expiresAt) {
      throw new Error("Recovery device challenge is not currently valid");
    }
    const candidateEncryptionDigest =
      sha256(checkedPending.encryptionPublicKey);
    const candidateSigningDigest =
      sha256(checkedPending.signingPublicKey);
    if (
      challenge.humanId !== checkedPending.humanId
      || challenge.targetDeviceId !== checkedPending.deviceId
      || challenge.pendingDeviceRevision
        !== checkedPending.pendingDeviceRevision
      || !equalBytes(
        challenge.encryptionPublicKeyDigest,
        candidateEncryptionDigest,
      )
      || !equalBytes(
        challenge.signingPublicKeyDigest,
        candidateSigningDigest,
      )
      || !equalBytes(proof.challengeHash, challengeHash)
      || !equalBytes(
        proof.readinessDigest,
        recoveryReadinessDigest(
          challenge.recoveryArchiveDigest,
          {
            humanId: challenge.humanId,
            inventoryRevision: challenge.inventoryRevision,
            inventoryCount: challenge.inventoryCount,
            inventoryDigest: challenge.inventoryDigest,
          },
        ),
      )
    ) {
      throw new Error(
        "Recovery device proof does not match the exact pending challenge",
      );
    }
    const verifier = input.resolveTrustedChallenge(challenge.challengeId);
    if (verifier === null) {
      throw new Error("Trusted pending recovery challenge is required");
    }
    if (typeof verifier !== "object") {
      throw new TypeError("Recovery device verifier must be an object");
    }
    assertExactFields(
      "Recovery device verifier",
      verifier,
      RECOVERY_VERIFIER_FIELDS,
    );
    assertPortableId(
      "Recovery device challenge id",
      verifier.challengeId,
    );
    assertBytes(
      "Recovery device verifier challenge hash",
      verifier.challengeHash,
      HASH_BYTES,
    );
    assertBytes(
      "Recovery device expected response digest",
      verifier.expectedResponseDigest,
      HASH_BYTES,
    );
    if (verifier.expectedStatus !== "pending") {
      throw new Error("Recovery device challenge was already consumed");
    }
    const pending = resolvePending(
      checkedPending,
      input.resolveTrustedPendingDevice,
    );
    assertCurrentRecoveryIdentity(
      pending.pending.humanId,
      challenge.recoveryKeyId,
      challenge.recoveryGeneration,
      challenge.recoveryPublicKeyDigest,
      input.resolveTrustedCurrentRecoveryKey,
    );
    if (
      challenge.challengeId !== verifier.challengeId
      || !equalBytes(challengeHash, verifier.challengeHash)
      || !equalBytes(
        recoveryResponseDigest(challengeHash, proof.response),
        verifier.expectedResponseDigest,
      )
    ) {
      throw new Error(
        "Recovery device proof does not match the exact pending challenge",
      );
    }
    return Object.freeze({
      activationCas: Object.freeze({
        humanId: pending.pending.humanId,
        deviceId: pending.pending.deviceId,
        expectedStatus: "pending",
        expectedPendingDeviceRevision:
          pending.pending.pendingDeviceRevision,
        expectedPendingEncryptionPublicKeyDigest:
          pending.encryptionDigest,
        expectedPendingSigningPublicKeyDigest:
          pending.signingDigest,
        intendedStatus: "active",
        recoveryKeyId: challenge.recoveryKeyId,
        expectedRecoveryGeneration: challenge.recoveryGeneration,
        expectedRecoveryPublicKeyDigest:
          challenge.recoveryPublicKeyDigest,
        recoveryArchiveDigest: challenge.recoveryArchiveDigest,
        expectedInventoryRevision: challenge.inventoryRevision,
        expectedInventoryCount: challenge.inventoryCount,
        expectedInventoryDigest: challenge.inventoryDigest,
        challengeId: challenge.challengeId,
        expectedChallengeStatus: "pending",
        intendedChallengeStatus: "consumed",
        expectedChallengeHash: challengeHash,
      }),
    });
  } finally {
    proof.response.fill(0);
  }
}
