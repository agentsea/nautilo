import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { compareUnsignedUtf8 } from "../domain/participants.ts";
import { assertCanonicalNamespaceKeyring } from "../format/namespace-keyring-v2.ts";
import {
  CanonicalDecodingError,
  StrictDecoder,
  concatV2,
  encodeU32,
  encodeU64,
  frame,
  frameText,
  utf8V2,
} from "../format/v2-primitives.ts";
import {
  assertVerifiedNamespaceBindingHead,
  namespaceKeyringEnvelopeHash,
} from "../namespace/bindings.ts";
import type {
  HistoricalCommitterResolverV2,
} from "../namespace/authorization.ts";
import type {
  NamespaceKeyClass,
  NamespaceKeyringEnvelopeV2,
  NamespaceKeyringPlaintextV2,
  VerifiedNamespaceBindingHeadV2,
} from "../namespace/types.ts";
import {
  assertU64Counter,
  cryptoDeviceId,
  humanId,
  type CryptoDeviceId,
  type CryptoDomainId,
  type DomainEpoch,
  type HumanId,
  type NamespaceKeyGeneration,
  type U64Counter,
} from "../v2-types/ids.ts";
import { V2_LIMITS, assertV2Limit } from "../v2-types/limits.ts";
import { copyOwnedBytesV2 } from "../v2-types/opaque.ts";

export const DEVICE_TRANSFER_FORMAT_VERSION = 2 as const;
export const RECOVERY_DEVICE_ACTIVATION_DOMAIN =
  "nautilo/lattice-crypto/recovery-device-activation/v2";
const DEVICE_TRANSFER_INVENTORY_DOMAIN =
  "nautilo/lattice-crypto/device-transfer-inventory/v2";

export const HASH_BYTES = 32;
const HPKE_AEAD_TAG_BYTES = 16;
const HPKE_LENGTH_PREFIX_BYTES = 2;
export const MAX_METADATA_BYTES = 3 * 1024;

const TRUSTED_PENDING_FIELDS = Object.freeze([
  "humanId",
  "deviceId",
  "pendingDeviceRevision",
  "encryptionPublicKeyDigest",
  "signingPublicKeyDigest",
  "status",
]);
const PENDING_DEVICE_FIELDS = Object.freeze([
  "humanId",
  "deviceId",
  "pendingDeviceRevision",
  "encryptionPublicKey",
  "signingPublicKey",
]);
const VERIFIED_NAMESPACE_HEAD_FIELDS = Object.freeze([
  "namespaceId",
  "accessRevision",
  "bindingHash",
  "binding",
]);
export const READINESS_INVENTORY_FIELDS = Object.freeze([
  "authorizedHumanId",
  "trustedNamespaceHead",
  "keyClass",
]);
export const LIVE_DOMAIN_FIELDS = Object.freeze([
  "domainId",
  "domainEpoch",
  "committerDeviceId",
]);
export const RECOVERY_KEY_FIELDS = Object.freeze([
  "recoveryKeyId",
  "recoveryGeneration",
]);
export const RECOVERY_CHALLENGE_FIELDS = Object.freeze([
  "formatVersion",
  "challengeId",
  "humanId",
  "targetDeviceId",
  "pendingDeviceRevision",
  "encryptionPublicKeyDigest",
  "signingPublicKeyDigest",
  "recoveryKeyId",
  "recoveryGeneration",
  "recoveryPublicKeyDigest",
  "recoveryArchiveDigest",
  "inventoryRevision",
  "inventoryCount",
  "inventoryDigest",
  "issuedAt",
  "expiresAt",
  "ciphertext",
]);
export const RECOVERY_PROOF_FIELDS = Object.freeze([
  "formatVersion",
  "challengeHash",
  "readinessDigest",
  "response",
]);
export const RECOVERY_VERIFIER_FIELDS = Object.freeze([
  "challengeId",
  "challengeHash",
  "expectedResponseDigest",
  "expectedStatus",
]);
export const INVENTORY_COMMITMENT_FIELDS = Object.freeze([
  "humanId",
  "inventoryRevision",
  "inventoryCount",
  "inventoryDigest",
]);

export type PendingDeviceRevision =
  U64Counter<"PendingDeviceRevision">;

export function pendingDeviceRevision(value: unknown): PendingDeviceRevision {
  assertU64Counter("Pending device revision", value);
  return value as PendingDeviceRevision;
}

export type DeviceTransferInventoryRevision =
  U64Counter<"DeviceTransferInventoryRevision">;

export function deviceTransferInventoryRevision(
  value: unknown,
): DeviceTransferInventoryRevision {
  assertU64Counter("Device transfer inventory revision", value);
  return value as DeviceTransferInventoryRevision;
}

export interface TrustedDeviceTransferInventoryCommitmentV2 {
  readonly humanId: HumanId;
  readonly inventoryRevision: DeviceTransferInventoryRevision;
  readonly inventoryCount: number;
  readonly inventoryDigest: Uint8Array;
}

export type ResolveTrustedDeviceTransferInventoryCommitmentV2 = (
  humanId: HumanId,
) => TrustedDeviceTransferInventoryCommitmentV2 | null;

export interface DeviceTransferPendingDeviceV2 {
  readonly humanId: HumanId;
  readonly deviceId: CryptoDeviceId;
  readonly pendingDeviceRevision: PendingDeviceRevision;
  readonly encryptionPublicKey: Uint8Array;
  readonly signingPublicKey: Uint8Array;
}

export interface TrustedPendingDeviceV2 {
  readonly humanId: HumanId;
  readonly deviceId: CryptoDeviceId;
  readonly pendingDeviceRevision: PendingDeviceRevision;
  readonly encryptionPublicKeyDigest: Uint8Array;
  readonly signingPublicKeyDigest: Uint8Array;
  readonly status: "pending";
}

export type ResolveTrustedPendingDeviceV2 = (
  humanId: HumanId,
  deviceId: CryptoDeviceId,
) => TrustedPendingDeviceV2 | null;

export interface DeviceTransferInventoryItemV2 {
  readonly authorizedHumanId: HumanId;
  readonly trustedNamespaceHead: VerifiedNamespaceBindingHeadV2;
  readonly keyClass: NamespaceKeyClass;
}

export interface DeviceTransferKeyringSourceV2
  extends DeviceTransferInventoryItemV2 {
  readonly currentKeyringEnvelope: NamespaceKeyringEnvelopeV2;
  readonly currentDomainRoot: Uint8Array;
  readonly resolveHistoricalCommitter: HistoricalCommitterResolverV2;
}

export interface DeviceTransferJoinIntentV2 {
  readonly formatVersion: 2;
  readonly humanId: HumanId;
  readonly targetDeviceId: CryptoDeviceId;
  readonly pendingDeviceRevision: PendingDeviceRevision;
  readonly domainId: CryptoDomainId;
  readonly domainEpoch: DomainEpoch;
  readonly committerDeviceId: CryptoDeviceId;
}

function assertNoUnknownFields(
  label: string,
  value: object,
  allowed: readonly string[],
): void {
  const allowedSet = new Set(allowed);
  for (const field of Object.keys(value)) {
    if (!allowedSet.has(field)) {
      throw new TypeError(`${label} contains unknown field ${field}`);
    }
  }
}

export function assertExactFields(
  label: string,
  value: object,
  required: readonly string[],
): void {
  assertNoUnknownFields(label, value, required);
  for (const field of required) {
    if (!Object.hasOwn(value, field)) {
      throw new TypeError(`${label} is missing required field ${field}`);
    }
  }
}

export function assertBytes(
  label: string,
  value: unknown,
  length: number,
): asserts value is Uint8Array {
  if (!(value instanceof Uint8Array) || value.length !== length) {
    throw new RangeError(`${label} must contain exactly ${length} bytes`);
  }
}

export function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  return bytesToHex(left) === bytesToHex(right);
}

export function assertKeyClass(
  value: unknown,
): asserts value is NamespaceKeyClass {
  if (value !== "human" && value !== "ai") {
    throw new RangeError("Device transfer key class is unsupported");
  }
}

export function readExactText(
  reader: StrictDecoder,
  expected: string,
  label: string,
): void {
  if (reader.readText(utf8V2(expected).length) !== expected) {
    throw new CanonicalDecodingError(`${label} is unsupported`);
  }
}

export function digestPublicKey(
  label: string,
  publicKey: Uint8Array,
  length: number,
): Uint8Array {
  assertBytes(label, publicKey, length);
  return sha256(publicKey);
}

export function validatePendingCandidate(
  value: DeviceTransferPendingDeviceV2,
): DeviceTransferPendingDeviceV2 {
  if (typeof value !== "object" || value === null) {
    throw new TypeError("Pending device candidate must be an object");
  }
  assertExactFields(
    "Pending device candidate",
    value,
    PENDING_DEVICE_FIELDS,
  );
  return Object.freeze({
    humanId: humanId(value.humanId),
    deviceId: cryptoDeviceId(value.deviceId),
    pendingDeviceRevision: pendingDeviceRevision(value.pendingDeviceRevision),
    encryptionPublicKey: (() => {
      assertBytes(
        "Pending device encryption public key",
        value.encryptionPublicKey,
        V2_LIMITS.hpkePublicKeyBytes,
      );
      return copyOwnedBytesV2(value.encryptionPublicKey);
    })(),
    signingPublicKey: (() => {
      assertBytes(
        "Pending device signing public key",
        value.signingPublicKey,
        V2_LIMITS.signingPublicKeyBytes,
      );
      return copyOwnedBytesV2(value.signingPublicKey);
    })(),
  });
}

export function resolvePending(
  pending: DeviceTransferPendingDeviceV2,
  resolver: ResolveTrustedPendingDeviceV2,
): {
  readonly pending: DeviceTransferPendingDeviceV2;
  readonly encryptionDigest: Uint8Array;
  readonly signingDigest: Uint8Array;
} {
  const checked = validatePendingCandidate(pending);
  const record = resolver(checked.humanId, checked.deviceId);
  if (record === null) {
    throw new Error("Exact trusted pending device is required");
  }
  if (typeof record !== "object") {
    throw new TypeError("Trusted pending device must be an object");
  }
  assertExactFields("Trusted pending device", record, TRUSTED_PENDING_FIELDS);
  if (record.status !== "pending") {
    throw new Error("Device transfer target is not pending");
  }
  const encryptionDigest = sha256(checked.encryptionPublicKey);
  const signingDigest = sha256(checked.signingPublicKey);
  assertBytes(
    "Trusted pending encryption-key digest",
    record.encryptionPublicKeyDigest,
    HASH_BYTES,
  );
  assertBytes(
    "Trusted pending signing-key digest",
    record.signingPublicKeyDigest,
    HASH_BYTES,
  );
  if (
    humanId(record.humanId) !== checked.humanId
    || cryptoDeviceId(record.deviceId) !== checked.deviceId
    || pendingDeviceRevision(record.pendingDeviceRevision)
      !== checked.pendingDeviceRevision
    || !equalBytes(record.encryptionPublicKeyDigest, encryptionDigest)
    || !equalBytes(record.signingPublicKeyDigest, signingDigest)
  ) {
    throw new Error(
      "Device transfer candidate does not match the trusted pending device",
    );
  }
  return Object.freeze({ pending: checked, encryptionDigest, signingDigest });
}

export function currentGeneration(
  head: VerifiedNamespaceBindingHeadV2,
  keyClass: NamespaceKeyClass,
): NamespaceKeyGeneration {
  return keyClass === "human"
    ? head.binding.humanCurrentGeneration
    : head.binding.aiCurrentGeneration;
}

export function assertExactTrustedNamespaceHeadV2(
  head: VerifiedNamespaceBindingHeadV2,
  label = "Device transfer trusted Namespace head",
): void {
  if (typeof head !== "object" || head === null) {
    throw new TypeError(`${label} must be an object`);
  }
  assertExactFields(label, head, VERIFIED_NAMESPACE_HEAD_FIELDS);
  assertVerifiedNamespaceBindingHead(head);
}

/**
 * A Domain has exactly one current epoch. Multiple Namespace heads may point
 * at it, but they must all agree on that epoch before any authority resolver
 * or cryptographic operation is allowed to run.
 */
export function assertConsistentCurrentDomainEpochsV2(
  inventory: readonly DeviceTransferInventoryItemV2[],
  label = "Device transfer inventory",
): ReadonlyMap<string, DomainEpoch> {
  const epochs = new Map<string, DomainEpoch>();
  for (const item of inventory) {
    const { domainId, domainEpoch: epoch } =
      item.trustedNamespaceHead.binding;
    const existing = epochs.get(domainId);
    if (existing !== undefined && existing !== epoch) {
      throw new Error(`${label} disagrees on the current Domain epoch`);
    }
    epochs.set(domainId, epoch);
  }
  return epochs;
}

export function assertCompleteKeyring(
  keyring: NamespaceKeyringPlaintextV2,
): void {
  assertCanonicalNamespaceKeyring(keyring);
  if (
    keyring.generations.some((item, index) => item.generation !== index)
  ) {
    throw new Error(
      "Device transfer keyring must contain complete retained history",
    );
  }
}

export function predictedHpkeCiphertextBytes(
  plaintextBytes: number,
): number {
  return HPKE_LENGTH_PREFIX_BYTES
    + V2_LIMITS.hpkePublicKeyBytes
    + plaintextBytes
    + HPKE_AEAD_TAG_BYTES;
}

export function preflightInventoryShape(
  sources: readonly DeviceTransferInventoryItemV2[],
  allowedFields: readonly string[],
): void {
  if (!Array.isArray(sources as unknown)) {
    throw new TypeError("Device transfer inventory must be an array");
  }
  assertV2Limit(
    "Device transfer package count",
    sources.length,
    V2_LIMITS.recoveryPackages,
  );
  for (const source of sources) {
    if (typeof source !== "object" || source === null) {
      throw new TypeError("Device transfer inventory item must be an object");
    }
    assertExactFields(
      "Device transfer inventory item",
      source,
      allowedFields,
    );
    humanId(source.authorizedHumanId);
    assertKeyClass(source.keyClass);
    assertExactTrustedNamespaceHeadV2(source.trustedNamespaceHead);
    const head = source.trustedNamespaceHead;
    if ("currentDomainRoot" in source) {
      const sourceWithSecrets =
        source as unknown as DeviceTransferKeyringSourceV2;
      assertBytes(
        "Device transfer current Domain root",
        sourceWithSecrets.currentDomainRoot,
        32,
      );
      if (
        typeof sourceWithSecrets.currentKeyringEnvelope !== "object"
        || sourceWithSecrets.currentKeyringEnvelope === null
      ) {
        throw new TypeError(
          "Device transfer current keyring envelope must be an object",
        );
      }
      const envelopeDigest =
        namespaceKeyringEnvelopeHash(sourceWithSecrets.currentKeyringEnvelope);
      const expectedEnvelopeDigest = source.keyClass === "human"
        ? head.binding.humanKeyringEnvelopeHash
        : head.binding.aiKeyringEnvelopeHash;
      if (!equalBytes(envelopeDigest, expectedEnvelopeDigest)) {
        throw new Error(
          "Device transfer keyring envelope does not match the trusted binding",
        );
      }
      if (
        typeof sourceWithSecrets.resolveHistoricalCommitter !== "function"
      ) {
        throw new TypeError(
          "Device transfer historical committer resolver is required",
        );
      }
    }
  }
  assertConsistentCurrentDomainEpochsV2(sources);
}

export function normalizeInventory<T extends DeviceTransferInventoryItemV2>(
  sources: readonly T[],
  human: HumanId,
  allowedFields: readonly string[],
): readonly T[] {
  preflightInventoryShape(sources, allowedFields);
  const sorted = [...sources].sort((left, right) => {
    const namespaceOrder = compareUnsignedUtf8(
      left.trustedNamespaceHead.namespaceId,
      right.trustedNamespaceHead.namespaceId,
    );
    return namespaceOrder === 0
      ? compareUnsignedUtf8(left.keyClass, right.keyClass)
      : namespaceOrder;
  });
  for (let index = 0; index < sorted.length; index++) {
    const source = sorted[index]!;
    if (source.authorizedHumanId !== human) {
      throw new Error("Device transfer includes an unauthorized Namespace");
    }
    if (
      index > 0
      && sorted[index - 1]!.trustedNamespaceHead.namespaceId
        === source.trustedNamespaceHead.namespaceId
      && sorted[index - 1]!.keyClass === source.keyClass
    ) {
      throw new Error("Device transfer inventory contains a duplicate");
    }
  }
  return Object.freeze(sorted);
}

function inventoryDigest(
  human: HumanId,
  inventoryRevisionValue: DeviceTransferInventoryRevision,
  inventory: readonly DeviceTransferInventoryItemV2[],
): Uint8Array {
  return sha256(concatV2(
    frameText(DEVICE_TRANSFER_INVENTORY_DOMAIN),
    encodeU32(DEVICE_TRANSFER_FORMAT_VERSION),
    frameText(human),
    encodeU64(inventoryRevisionValue),
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
        encodeU64(currentGeneration(head, item.keyClass)),
      ));
    }),
  ));
}

export function resolveExactInventoryCommitment(
  human: HumanId,
  inventoryRevisionValue: DeviceTransferInventoryRevision,
  inventory: readonly DeviceTransferInventoryItemV2[],
  resolver: ResolveTrustedDeviceTransferInventoryCommitmentV2,
): TrustedDeviceTransferInventoryCommitmentV2 {
  const trusted = resolver(human);
  if (trusted === null) {
    throw new Error(
      "Authoritative device-transfer inventory commitment is required",
    );
  }
  if (typeof trusted !== "object") {
    throw new TypeError(
      "Device-transfer inventory commitment must be an object",
    );
  }
  assertExactFields(
    "Device-transfer inventory commitment",
    trusted,
    INVENTORY_COMMITMENT_FIELDS,
  );
  humanId(trusted.humanId);
  const revision = deviceTransferInventoryRevision(
    trusted.inventoryRevision,
  );
  assertV2Limit(
    "Device-transfer inventory commitment count",
    trusted.inventoryCount,
    V2_LIMITS.recoveryPackages,
  );
  assertBytes(
    "Device-transfer inventory commitment digest",
    trusted.inventoryDigest,
    HASH_BYTES,
  );
  const computed = inventoryDigest(human, inventoryRevisionValue, inventory);
  if (
    trusted.humanId !== human
    || revision !== inventoryRevisionValue
    || trusted.inventoryCount !== inventory.length
    || !equalBytes(trusted.inventoryDigest, computed)
  ) {
    throw new Error(
      "Device-transfer inventory does not match authoritative commitment",
    );
  }
  return Object.freeze({
    humanId: human,
    inventoryRevision: revision,
    inventoryCount: trusted.inventoryCount,
    inventoryDigest: copyOwnedBytesV2(trusted.inventoryDigest),
  });
}

export function deviceTransferInventoryDigestV2(input: {
  readonly humanId: HumanId;
  readonly inventoryRevision: DeviceTransferInventoryRevision;
  readonly inventory: readonly DeviceTransferInventoryItemV2[];
}): Uint8Array {
  const human = humanId(input.humanId);
  const revision = deviceTransferInventoryRevision(input.inventoryRevision);
  const normalized = normalizeInventory(
    input.inventory,
    human,
    READINESS_INVENTORY_FIELDS,
  );
  return inventoryDigest(human, revision, normalized);
}
