import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { compareUnsignedUtf8 } from "../domain/participants.ts";
import type { NamespaceKeyClass } from "../namespace/types.ts";
import {
  type AccessRevision,
  type CryptoDeviceId,
  type HumanId,
  type NamespaceId,
  type NamespaceKeyGeneration,
  type U64Counter,
  type UnixTimestamp,
  accessRevision,
  assertPortableId,
  assertU64Counter,
  cryptoDeviceId,
  humanId,
  namespaceGeneration,
  namespaceId,
  unixTimestamp,
} from "../v2-types/ids.ts";
import {
  V2_LIMITS,
  assertV2Limit,
  assertV2Range,
} from "../v2-types/limits.ts";
import {
  CanonicalDecodingError,
  StrictDecoder,
  concatV2,
  decodeExact,
  encodeU32,
  encodeU64,
  frame,
  frameText,
  utf8V2,
} from "./v2-primitives.ts";

export const HUMAN_RECOVERY_FORMAT_VERSION = 2 as const;
export const NAMESPACE_RECOVERY_PACKAGE_DOMAIN =
  "nautilo/lattice-crypto/namespace-generation-package/v2";
export const HUMAN_RECOVERY_ARCHIVE_DOMAIN =
  "nautilo/lattice-crypto/recovery-archive/v2";

const HASH_BYTES = 32;
export const RECOVERY_PUBLIC_KEY_DIGEST_BYTES = 32;
const MAX_PACKAGE_METADATA_BYTES = 2 * 1024;
const MAX_RECOVERY_PACKAGE_WIRE_BYTES =
  V2_LIMITS.ciphertextBytes + MAX_PACKAGE_METADATA_BYTES;
const NAMESPACE_RECOVERY_PACKAGE_FIELDS = Object.freeze([
  "formatVersion",
  "humanId",
  "recoveryKeyId",
  "recoveryGeneration",
  "recoveryPublicKeyDigest",
  "namespaceId",
  "keyClass",
  "accessRevision",
  "currentGeneration",
  "bindingHash",
  "issuerDeviceId",
  "createdAt",
  "ciphertext",
  "signature",
]);
const HUMAN_RECOVERY_ARCHIVE_FIELDS = Object.freeze([
  "formatVersion",
  "humanId",
  "recoveryKeyId",
  "recoveryGeneration",
  "recoveryPublicKeyDigest",
  "issuerDeviceId",
  "createdAt",
  "packages",
  "signature",
]);
const TRUSTED_RECOVERY_KEY_FIELDS = Object.freeze([
  "humanId",
  "recoveryKeyId",
  "recoveryGeneration",
  "publicKeyDigest",
]);

function assertExactFields(
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

export type RecoveryKeyGeneration =
  U64Counter<"RecoveryKeyGeneration">;

export function recoveryKeyGeneration(
  value: unknown,
): RecoveryKeyGeneration {
  assertU64Counter("Recovery key generation", value);
  if (value < 1) {
    throw new RangeError("Recovery key generation must be positive");
  }
  return value as RecoveryKeyGeneration;
}

export interface TrustedCurrentRecoveryKeyV2 {
  readonly humanId: HumanId;
  readonly recoveryKeyId: string;
  readonly recoveryGeneration: RecoveryKeyGeneration;
  readonly publicKeyDigest: Uint8Array;
}

export type ResolveTrustedCurrentRecoveryKeyV2 = (
  humanId: HumanId,
) => TrustedCurrentRecoveryKeyV2 | null;

export function recoveryPublicKeyDigest(
  publicKey: Uint8Array,
): Uint8Array {
  assertExactBytes(
    "Recovery public key",
    publicKey,
    V2_LIMITS.hpkePublicKeyBytes,
  );
  return sha256(publicKey);
}

export function assertTrustedCurrentRecoveryKey(
  value: TrustedCurrentRecoveryKeyV2,
): void {
  if (typeof value !== "object" || value === null) {
    throw new TypeError("Trusted current recovery key must be an object");
  }
  assertExactFields(
    "Trusted current recovery key",
    value,
    TRUSTED_RECOVERY_KEY_FIELDS,
  );
  humanId(value.humanId);
  assertPortableId("Recovery key id", value.recoveryKeyId);
  recoveryKeyGeneration(value.recoveryGeneration);
  assertExactBytes(
    "Recovery public-key digest",
    value.publicKeyDigest,
    RECOVERY_PUBLIC_KEY_DIGEST_BYTES,
  );
}

export interface NamespaceRecoveryPackageV2 {
  readonly formatVersion: 2;
  readonly humanId: HumanId;
  readonly recoveryKeyId: string;
  readonly recoveryGeneration: RecoveryKeyGeneration;
  readonly recoveryPublicKeyDigest: Uint8Array;
  readonly namespaceId: NamespaceId;
  readonly keyClass: NamespaceKeyClass;
  readonly accessRevision: AccessRevision;
  readonly currentGeneration: NamespaceKeyGeneration;
  readonly bindingHash: Uint8Array;
  readonly issuerDeviceId: CryptoDeviceId;
  readonly createdAt: UnixTimestamp;
  readonly ciphertext: Uint8Array;
  readonly signature: Uint8Array;
}

export interface HumanRecoveryArchiveV2 {
  readonly formatVersion: 2;
  readonly humanId: HumanId;
  readonly recoveryKeyId: string;
  readonly recoveryGeneration: RecoveryKeyGeneration;
  readonly recoveryPublicKeyDigest: Uint8Array;
  readonly issuerDeviceId: CryptoDeviceId;
  readonly createdAt: UnixTimestamp;
  readonly packages: readonly NamespaceRecoveryPackageV2[];
  readonly signature: Uint8Array;
}

export type NamespaceRecoveryPackageMetadataV2 =
  Omit<NamespaceRecoveryPackageV2, "ciphertext" | "signature">;
type NamespaceRecoverySigningFields =
  Omit<NamespaceRecoveryPackageV2, "signature">;
type HumanRecoveryArchiveSigningFields =
  Omit<HumanRecoveryArchiveV2, "signature">;

function assertExactBytes(
  label: string,
  value: unknown,
  length: number,
): asserts value is Uint8Array {
  if (!(value instanceof Uint8Array) || value.length !== length) {
    throw new RangeError(`${label} must contain exactly ${length} bytes`);
  }
}

function assertKeyClass(
  value: unknown,
): asserts value is NamespaceKeyClass {
  if (value !== "human" && value !== "ai") {
    throw new RangeError("Recovery package key class is unsupported");
  }
}

function validatePackageMetadata(
  value: NamespaceRecoveryPackageMetadataV2,
): void {
  if (typeof value !== "object" || value === null) {
    throw new TypeError("Recovery package must be an object");
  }
  assertExactFields(
    "Recovery package",
    value,
    NAMESPACE_RECOVERY_PACKAGE_FIELDS,
  );
  if (value.formatVersion !== HUMAN_RECOVERY_FORMAT_VERSION) {
    throw new RangeError("Recovery package format version is unsupported");
  }
  humanId(value.humanId);
  assertPortableId("Recovery key id", value.recoveryKeyId);
  recoveryKeyGeneration(value.recoveryGeneration);
  assertExactBytes(
    "Recovery package public-key digest",
    value.recoveryPublicKeyDigest,
    RECOVERY_PUBLIC_KEY_DIGEST_BYTES,
  );
  namespaceId(value.namespaceId);
  assertKeyClass(value.keyClass);
  accessRevision(value.accessRevision);
  namespaceGeneration(value.currentGeneration);
  assertExactBytes("Recovery package binding hash", value.bindingHash, HASH_BYTES);
  cryptoDeviceId(value.issuerDeviceId);
  unixTimestamp(value.createdAt);
}

function validatePackageSigningFields(
  value: NamespaceRecoverySigningFields,
): void {
  validatePackageMetadata(value);
  if (!(value.ciphertext instanceof Uint8Array)) {
    throw new TypeError("Recovery package ciphertext must be bytes");
  }
  assertV2Range(
    "Recovery package ciphertext bytes",
    value.ciphertext.length,
    1,
    V2_LIMITS.ciphertextBytes,
  );
}

export function assertNamespaceRecoveryPackage(
  value: NamespaceRecoveryPackageV2,
): void {
  validatePackageSigningFields(value);
  assertExactBytes(
    "Recovery package signature",
    value.signature,
    V2_LIMITS.signatureBytes,
  );
}

function packageMetadataBytes(
  value: NamespaceRecoveryPackageMetadataV2,
): Uint8Array {
  validatePackageMetadata(value);
  return concatV2(
    frameText(NAMESPACE_RECOVERY_PACKAGE_DOMAIN),
    encodeU32(HUMAN_RECOVERY_FORMAT_VERSION),
    frameText(value.humanId),
    frameText(value.recoveryKeyId),
    encodeU64(value.recoveryGeneration),
    frame(value.recoveryPublicKeyDigest),
    frameText(value.namespaceId),
    frameText(value.keyClass),
    encodeU64(value.accessRevision),
    encodeU64(value.currentGeneration),
    frame(value.bindingHash),
    frameText(value.issuerDeviceId),
    encodeU64(value.createdAt),
  );
}

/**
 * Metadata bound to the recovery-public-key encryption operation. The later
 * workflow must include these bytes in the sealed plaintext/container because
 * the imported HPKE convenience wrapper does not currently expose external
 * AAD.
 */
export function namespaceRecoveryPackageAad(
  value: NamespaceRecoveryPackageMetadataV2,
): Uint8Array {
  return packageMetadataBytes(value);
}

export function namespaceRecoveryPackageSigningBytes(
  value: NamespaceRecoverySigningFields,
): Uint8Array {
  return concatV2(
    packageMetadataBytes(value),
    frame(sha256(value.ciphertext)),
  );
}

export function serializeNamespaceRecoveryPackage(
  value: NamespaceRecoveryPackageV2,
): Uint8Array {
  assertNamespaceRecoveryPackage(value);
  return concatV2(
    packageMetadataBytes(value),
    frame(value.ciphertext),
    frame(value.signature),
  );
}

function readExactText(
  reader: StrictDecoder,
  expected: string,
  label: string,
): void {
  const actual = reader.readText(utf8V2(expected).length);
  if (actual !== expected) {
    throw new CanonicalDecodingError(`${label} is unsupported`);
  }
}

function decodePackageFromReader(
  reader: StrictDecoder,
): NamespaceRecoveryPackageV2 {
  readExactText(
    reader,
    NAMESPACE_RECOVERY_PACKAGE_DOMAIN,
    "Recovery package domain",
  );
  reader.readVersion(HUMAN_RECOVERY_FORMAT_VERSION);
  const decodedHumanId = humanId(reader.readText(V2_LIMITS.idBytes));
  const recoveryKeyId = reader.readText(V2_LIMITS.idBytes);
  assertPortableId("Recovery key id", recoveryKeyId);
  const recoveryGeneration = recoveryKeyGeneration(reader.readU64());
  const recoveryPublicKeyDigest = reader.readFrame(
    RECOVERY_PUBLIC_KEY_DIGEST_BYTES,
  );
  const decodedNamespaceId = namespaceId(reader.readText(V2_LIMITS.idBytes));
  const keyClass = reader.readText(5);
  assertKeyClass(keyClass);
  const decodedAccessRevision = accessRevision(reader.readU64());
  const currentGeneration = namespaceGeneration(reader.readU64());
  const bindingHash = reader.readFrame(HASH_BYTES);
  const issuerDeviceId = cryptoDeviceId(
    reader.readText(V2_LIMITS.idBytes),
  );
  const createdAt = unixTimestamp(reader.readU64());
  const ciphertext = reader.readFrame(V2_LIMITS.ciphertextBytes);
  const signature = reader.readFrame(V2_LIMITS.signatureBytes);
  const value: NamespaceRecoveryPackageV2 = {
    formatVersion: HUMAN_RECOVERY_FORMAT_VERSION,
    humanId: decodedHumanId,
    recoveryKeyId,
    recoveryGeneration,
    recoveryPublicKeyDigest,
    namespaceId: decodedNamespaceId,
    keyClass,
    accessRevision: decodedAccessRevision,
    currentGeneration,
    bindingHash,
    issuerDeviceId,
    createdAt,
    ciphertext,
    signature,
  };
  assertNamespaceRecoveryPackage(value);
  return Object.freeze(value);
}

export function decodeNamespaceRecoveryPackage(
  bytes: Uint8Array,
): NamespaceRecoveryPackageV2 {
  if (!(bytes instanceof Uint8Array)) {
    throw new CanonicalDecodingError(
      "Recovery package wire bytes exceed format limits",
    );
  }
  try {
    assertV2Limit(
      NAMESPACE_RECOVERY_PACKAGE_DOMAIN,
      bytes.length,
      MAX_RECOVERY_PACKAGE_WIRE_BYTES,
    );
  } catch {
    throw new CanonicalDecodingError(
      "Recovery package wire bytes exceed format limits",
    );
  }
  return decodeExact(bytes, decodePackageFromReader);
}

function comparePackages(
  left: NamespaceRecoveryPackageV2,
  right: NamespaceRecoveryPackageV2,
): number {
  const namespaceOrder = compareUnsignedUtf8(
    left.namespaceId,
    right.namespaceId,
  );
  if (namespaceOrder !== 0) return namespaceOrder;
  return compareUnsignedUtf8(left.keyClass, right.keyClass);
}

function assertArchivePackageOwnership(
  archive: HumanRecoveryArchiveSigningFields,
  item: NamespaceRecoveryPackageV2,
): void {
  if (item.humanId !== archive.humanId) {
    throw new RangeError(
      "Recovery archive package belongs to another Human",
    );
  }
  if (
    item.recoveryKeyId !== archive.recoveryKeyId
    || item.recoveryGeneration !== archive.recoveryGeneration
    || bytesToHex(item.recoveryPublicKeyDigest)
      !== bytesToHex(archive.recoveryPublicKeyDigest)
  ) {
    throw new RangeError(
      "Recovery archive package targets another recovery key generation",
    );
  }
}

function validateArchiveSigningFields(
  archive: HumanRecoveryArchiveSigningFields,
): void {
  if (typeof archive !== "object" || archive === null) {
    throw new TypeError("Recovery archive must be an object");
  }
  assertExactFields(
    "Recovery archive",
    archive,
    HUMAN_RECOVERY_ARCHIVE_FIELDS,
  );
  if (archive.formatVersion !== HUMAN_RECOVERY_FORMAT_VERSION) {
    throw new RangeError("Recovery archive format version is unsupported");
  }
  humanId(archive.humanId);
  assertPortableId("Recovery key id", archive.recoveryKeyId);
  recoveryKeyGeneration(archive.recoveryGeneration);
  assertExactBytes(
    "Recovery archive public-key digest",
    archive.recoveryPublicKeyDigest,
    RECOVERY_PUBLIC_KEY_DIGEST_BYTES,
  );
  cryptoDeviceId(archive.issuerDeviceId);
  unixTimestamp(archive.createdAt);
  if (!Array.isArray(archive.packages as unknown)) {
    throw new TypeError("Recovery archive packages must be an array");
  }
  if (archive.packages.length > V2_LIMITS.recoveryPackages) {
    throw new RangeError(
      "Recovery archive exceeds the 4,096 package limit",
    );
  }
  let previous: NamespaceRecoveryPackageV2 | undefined;
  for (const item of archive.packages) {
    assertNamespaceRecoveryPackage(item);
    assertArchivePackageOwnership(archive, item);
    if (previous) {
      const order = comparePackages(previous, item);
      if (order >= 0) {
        throw new RangeError(order === 0
          ? "Recovery archive contains a duplicate Namespace/key-class package"
          : "Recovery archive packages must be in canonical order");
      }
    }
    previous = item;
  }
}

function packageWireLength(value: NamespaceRecoveryPackageV2): number {
  assertNamespaceRecoveryPackage(value);
  return [
    packageMetadataBytes(value).length,
    encodeU32(value.ciphertext.length).length,
    value.ciphertext.length,
    encodeU32(value.signature.length).length,
    value.signature.length,
  ].reduce((total, length) => total + length, 0);
}

function archiveWireLength(
  archive: HumanRecoveryArchiveV2,
): number {
  const fixedLength = [
    archiveMetadataBytes(archive).length,
    encodeU32(archive.packages.length).length,
    encodeU32(archive.signature.length).length,
    archive.signature.length,
  ].reduce((total, length) => total + length, 0);
  return archive.packages.reduce(
    (total, item) => {
      const itemLength = packageWireLength(item);
      return total + encodeU32(itemLength).length + itemLength;
    },
    fixedLength,
  );
}

function assertRecoveryArchiveWireLimit(
  archive: HumanRecoveryArchiveSigningFields,
): void {
  const fullArchive: HumanRecoveryArchiveV2 = {
    ...archive,
    signature: new Uint8Array(V2_LIMITS.signatureBytes),
  };
  if (archiveWireLength(fullArchive) > V2_LIMITS.recoveryArchiveBytes) {
    throw new RangeError(
      "Recovery archive exceeds the 64 MiB aggregate-byte limit",
    );
  }
}

export function assertCanonicalHumanRecoveryArchive(
  archive: HumanRecoveryArchiveV2,
): void {
  validateArchiveSigningFields(archive);
  assertExactBytes(
    "Recovery archive signature",
    archive.signature,
    V2_LIMITS.signatureBytes,
  );
  assertRecoveryArchiveWireLimit(archive);
}

function archiveMetadataBytes(
  archive: HumanRecoveryArchiveSigningFields,
): Uint8Array {
  validateArchiveSigningFields(archive);
  return concatV2(
    frameText(HUMAN_RECOVERY_ARCHIVE_DOMAIN),
    encodeU32(HUMAN_RECOVERY_FORMAT_VERSION),
    frameText(archive.humanId),
    frameText(archive.recoveryKeyId),
    encodeU64(archive.recoveryGeneration),
    frame(archive.recoveryPublicKeyDigest),
    frameText(archive.issuerDeviceId),
    encodeU64(archive.createdAt),
  );
}

export function humanRecoveryArchiveSigningBytes(
  archive: HumanRecoveryArchiveSigningFields,
): Uint8Array {
  validateArchiveSigningFields(archive);
  assertRecoveryArchiveWireLimit(archive);
  return concatV2(
    archiveMetadataBytes(archive),
    encodeU32(archive.packages.length),
    ...archive.packages.map((item) =>
      frame(sha256(serializeNamespaceRecoveryPackage(item)))
    ),
  );
}

export function serializeHumanRecoveryArchive(
  archive: HumanRecoveryArchiveV2,
): Uint8Array {
  assertCanonicalHumanRecoveryArchive(archive);
  return concatV2(
    archiveMetadataBytes(archive),
    encodeU32(archive.packages.length),
    ...archive.packages.map((item) =>
      frame(serializeNamespaceRecoveryPackage(item))
    ),
    frame(archive.signature),
  );
}

export function decodeHumanRecoveryArchive(
  bytes: Uint8Array,
): HumanRecoveryArchiveV2 {
  if (!(bytes instanceof Uint8Array)) {
    throw new CanonicalDecodingError(
      "Recovery archive exceeds the 64 MiB aggregate-byte limit",
    );
  }
  try {
    assertV2Limit(
      HUMAN_RECOVERY_ARCHIVE_DOMAIN,
      bytes.length,
      V2_LIMITS.recoveryArchiveBytes,
    );
  } catch {
    throw new CanonicalDecodingError(
      "Recovery archive exceeds the 64 MiB aggregate-byte limit",
    );
  }
  const decoded = decodeExact(bytes, (reader) => {
    readExactText(
      reader,
      HUMAN_RECOVERY_ARCHIVE_DOMAIN,
      "Recovery archive domain",
    );
    reader.readVersion(HUMAN_RECOVERY_FORMAT_VERSION);
    const decodedHumanId = humanId(reader.readText(V2_LIMITS.idBytes));
    const recoveryKeyId = reader.readText(V2_LIMITS.idBytes);
    assertPortableId("Recovery key id", recoveryKeyId);
    const recoveryGeneration = recoveryKeyGeneration(reader.readU64());
    const recoveryPublicKeyDigest = reader.readFrame(
      RECOVERY_PUBLIC_KEY_DIGEST_BYTES,
    );
    const issuerDeviceId = cryptoDeviceId(
      reader.readText(V2_LIMITS.idBytes),
    );
    const createdAt = unixTimestamp(reader.readU64());
    const packageCount = reader.readCount(V2_LIMITS.recoveryPackages);
    const packages = Array.from({ length: packageCount }, () => {
      const packageBytes = reader.readFrame(MAX_RECOVERY_PACKAGE_WIRE_BYTES);
      return decodeNamespaceRecoveryPackage(packageBytes);
    });
    const signature = reader.readFrame(V2_LIMITS.signatureBytes);
    const archive: HumanRecoveryArchiveV2 = {
      formatVersion: HUMAN_RECOVERY_FORMAT_VERSION,
      humanId: decodedHumanId,
      recoveryKeyId,
      recoveryGeneration,
      recoveryPublicKeyDigest,
      issuerDeviceId,
      createdAt,
      packages,
      signature,
    };
    assertCanonicalHumanRecoveryArchive(archive);
    return Object.freeze({
      ...archive,
      packages: Object.freeze(packages),
    });
  });
  return decoded;
}
