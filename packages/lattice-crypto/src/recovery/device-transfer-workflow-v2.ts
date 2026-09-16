import { sha256 } from "@noble/hashes/sha2.js";
import type { LatticeCrypto } from "../crypto/index.ts";
import { compareUnsignedUtf8 } from "../domain/participants.ts";
import {
  decodeNamespaceKeyring,
  encodeNamespaceKeyring,
} from "../format/namespace-keyring-v2.ts";
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
import type {
  NamespaceKeyClass,
  NamespaceKeyringPlaintextV2,
} from "../namespace/types.ts";
import { openNamespaceKeyring } from "../namespace/keyrings.ts";
import {
  accessRevision,
  cryptoDeviceId,
  cryptoDomainId,
  domainEpoch,
  humanId,
  namespaceGeneration,
  namespaceId,
  unixTimestamp,
  type AccessRevision,
  type CryptoDeviceId,
  type CryptoDomainId,
  type DomainEpoch,
  type HumanId,
  type NamespaceId,
  type NamespaceKeyGeneration,
  type UnixTimestamp,
} from "../v2-types/ids.ts";
import { V2_LIMITS, assertV2Limit } from "../v2-types/limits.ts";
import { copyOwnedBytesV2 } from "../v2-types/opaque.ts";
import {
  DEVICE_TRANSFER_FORMAT_VERSION,
  HASH_BYTES,
  MAX_METADATA_BYTES,
  READINESS_INVENTORY_FIELDS,
  assertBytes,
  assertCompleteKeyring,
  assertConsistentCurrentDomainEpochsV2,
  assertExactFields,
  assertKeyClass,
  currentGeneration,
  deviceTransferInventoryRevision,
  equalBytes,
  normalizeInventory,
  pendingDeviceRevision,
  preflightInventoryShape,
  predictedHpkeCiphertextBytes,
  readExactText,
  resolveExactInventoryCommitment,
  resolvePending,
  validatePendingCandidate,
  type DeviceTransferInventoryItemV2,
  type DeviceTransferInventoryRevision,
  type DeviceTransferJoinIntentV2,
  type DeviceTransferKeyringSourceV2,
  type DeviceTransferPendingDeviceV2,
  type PendingDeviceRevision,
  type ResolveTrustedDeviceTransferInventoryCommitmentV2,
  type ResolveTrustedPendingDeviceV2,
} from "./device-transfer-common-v2.ts";
import {
  advanceDeviceTransferApprovalPredictionV2,
  deviceTransferApprovalBasePredictionV2,
} from "./device-transfer-size-v2.ts";

export type {
  DeviceTransferInventoryItemV2,
  DeviceTransferInventoryRevision,
  DeviceTransferJoinIntentV2,
  DeviceTransferKeyringSourceV2,
  DeviceTransferPendingDeviceV2,
  PendingDeviceRevision,
  ResolveTrustedDeviceTransferInventoryCommitmentV2,
  ResolveTrustedPendingDeviceV2,
  TrustedDeviceTransferInventoryCommitmentV2,
  TrustedPendingDeviceV2,
} from "./device-transfer-common-v2.ts";

export const DEVICE_TRANSFER_KEYRING_DOMAIN =
  "nautilo/lattice-crypto/device-transfer-keyring/v2";
export const DEVICE_TRANSFER_APPROVAL_DOMAIN =
  "nautilo/lattice-crypto/device-transfer-approval/v2";
const PACKAGE_FIELDS = Object.freeze([
  "formatVersion",
  "humanId",
  "targetDeviceId",
  "pendingDeviceRevision",
  "encryptionPublicKeyDigest",
  "signingPublicKeyDigest",
  "namespaceId",
  "keyClass",
  "domainId",
  "domainEpoch",
  "accessRevision",
  "currentGeneration",
  "bindingHash",
  "issuerDeviceId",
  "createdAt",
  "ciphertext",
]);
const PACKAGE_METADATA_FIELDS = Object.freeze(
  PACKAGE_FIELDS.filter((field) => field !== "ciphertext"),
);
const JOIN_FIELDS = Object.freeze([
  "formatVersion",
  "humanId",
  "targetDeviceId",
  "pendingDeviceRevision",
  "domainId",
  "domainEpoch",
  "committerDeviceId",
]);
const APPROVAL_FIELDS = Object.freeze([
  "formatVersion",
  "humanId",
  "targetDeviceId",
  "pendingDeviceRevision",
  "encryptionPublicKeyDigest",
  "signingPublicKeyDigest",
  "issuerDeviceId",
  "createdAt",
  "inventoryRevision",
  "inventoryCount",
  "inventoryDigest",
  "packages",
  "joinIntents",
  "signature",
]);
const TRANSFER_SOURCE_FIELDS = Object.freeze([
  ...READINESS_INVENTORY_FIELDS,
  "currentKeyringEnvelope",
  "currentDomainRoot",
  "resolveHistoricalCommitter",
]);
const FRAME_LENGTH_BYTES = 4;
export interface DeviceTransferPackageV2 {
  readonly formatVersion: 2;
  readonly humanId: HumanId;
  readonly targetDeviceId: CryptoDeviceId;
  readonly pendingDeviceRevision: PendingDeviceRevision;
  readonly encryptionPublicKeyDigest: Uint8Array;
  readonly signingPublicKeyDigest: Uint8Array;
  readonly namespaceId: NamespaceId;
  readonly keyClass: NamespaceKeyClass;
  readonly domainId: CryptoDomainId;
  readonly domainEpoch: DomainEpoch;
  readonly accessRevision: AccessRevision;
  readonly currentGeneration: NamespaceKeyGeneration;
  readonly bindingHash: Uint8Array;
  readonly issuerDeviceId: CryptoDeviceId;
  readonly createdAt: UnixTimestamp;
  readonly ciphertext: Uint8Array;
}

export type DeviceTransferPackageMetadataV2 =
  Omit<DeviceTransferPackageV2, "ciphertext">;

export interface DeviceTransferApprovalV2 {
  readonly formatVersion: 2;
  readonly humanId: HumanId;
  readonly targetDeviceId: CryptoDeviceId;
  readonly pendingDeviceRevision: PendingDeviceRevision;
  readonly encryptionPublicKeyDigest: Uint8Array;
  readonly signingPublicKeyDigest: Uint8Array;
  readonly issuerDeviceId: CryptoDeviceId;
  readonly createdAt: UnixTimestamp;
  readonly inventoryRevision: DeviceTransferInventoryRevision;
  readonly inventoryCount: number;
  readonly inventoryDigest: Uint8Array;
  readonly packages: readonly DeviceTransferPackageV2[];
  readonly joinIntents: readonly DeviceTransferJoinIntentV2[];
  readonly signature: Uint8Array;
}

export interface DeviceTransferApproverContextV2 {
  readonly purpose: "device-transfer-publish" | "device-transfer-open";
  readonly humanId: HumanId;
  readonly targetDeviceId: CryptoDeviceId;
  readonly pendingDeviceRevision: PendingDeviceRevision;
  readonly issuerDeviceId: CryptoDeviceId;
  readonly createdAt: UnixTimestamp;
}

export type ResolveCurrentDeviceTransferApproverV2 = (
  context: DeviceTransferApproverContextV2,
) => Uint8Array | null;

export interface DeviceTransferDomainCommitterContextV2
  extends DeviceTransferJoinIntentV2 {
  readonly purpose: "device-transfer-domain-join";
}

/**
 * Current Domain authority is independent of retained Namespace keyrings.
 * A newly bootstrapped Domain can legitimately contain no Namespace inventory
 * yet, but an additional device still has to join that Domain.
 */
export interface DeviceTransferCurrentDomainV2 {
  readonly domainId: CryptoDomainId;
  readonly domainEpoch: DomainEpoch;
}

export type ResolveCurrentDeviceTransferDomainCommitterV2 = (
  context: DeviceTransferDomainCommitterContextV2,
) => Uint8Array | null;

export interface PreparedDeviceTransferV2 {
  readonly approval: DeviceTransferApprovalV2;
  readonly approvalBytes: Uint8Array;
  readonly activationCas: {
    readonly humanId: HumanId;
    readonly deviceId: CryptoDeviceId;
    readonly expectedStatus: "pending";
    readonly expectedPendingDeviceRevision: PendingDeviceRevision;
    readonly expectedPendingEncryptionPublicKeyDigest: Uint8Array;
    readonly expectedPendingSigningPublicKeyDigest: Uint8Array;
    readonly intendedStatus: "active";
    readonly expectedInventoryRevision: DeviceTransferInventoryRevision;
    readonly expectedInventoryCount: number;
    readonly expectedInventoryDigest: Uint8Array;
    readonly approvalHash: Uint8Array;
  };
}

export interface OpenedDeviceTransferV2 {
  readonly keyrings: readonly NamespaceKeyringPlaintextV2[];
  readonly joinIntents: readonly DeviceTransferJoinIntentV2[];
  readonly activationCas: PreparedDeviceTransferV2["activationCas"];
}

function validatePackageMetadata(
  value: DeviceTransferPackageMetadataV2 | DeviceTransferPackageV2,
): void {
  if (typeof value !== "object" || value === null) {
    throw new TypeError("Device transfer package must be an object");
  }
  assertExactFields(
    "Device transfer package",
    value,
    "ciphertext" in value ? PACKAGE_FIELDS : PACKAGE_METADATA_FIELDS,
  );
  if (value.formatVersion !== DEVICE_TRANSFER_FORMAT_VERSION) {
    throw new RangeError("Device transfer package version is unsupported");
  }
  humanId(value.humanId);
  cryptoDeviceId(value.targetDeviceId);
  pendingDeviceRevision(value.pendingDeviceRevision);
  assertBytes(
    "Device transfer encryption-key digest",
    value.encryptionPublicKeyDigest,
    HASH_BYTES,
  );
  assertBytes(
    "Device transfer signing-key digest",
    value.signingPublicKeyDigest,
    HASH_BYTES,
  );
  namespaceId(value.namespaceId);
  assertKeyClass(value.keyClass);
  cryptoDomainId(value.domainId);
  domainEpoch(value.domainEpoch);
  accessRevision(value.accessRevision);
  namespaceGeneration(value.currentGeneration);
  assertBytes("Device transfer binding hash", value.bindingHash, HASH_BYTES);
  cryptoDeviceId(value.issuerDeviceId);
  unixTimestamp(value.createdAt);
}

function packageMetadataBytes(
  value: DeviceTransferPackageMetadataV2 | DeviceTransferPackageV2,
): Uint8Array {
  validatePackageMetadata(value);
  return concatV2(
    frameText(DEVICE_TRANSFER_KEYRING_DOMAIN),
    encodeU32(DEVICE_TRANSFER_FORMAT_VERSION),
    frameText(value.humanId),
    frameText(value.targetDeviceId),
    encodeU64(value.pendingDeviceRevision),
    frame(value.encryptionPublicKeyDigest),
    frame(value.signingPublicKeyDigest),
    frameText(value.namespaceId),
    frameText(value.keyClass),
    frameText(value.domainId),
    encodeU64(value.domainEpoch),
    encodeU64(value.accessRevision),
    encodeU64(value.currentGeneration),
    frame(value.bindingHash),
    frameText(value.issuerDeviceId),
    encodeU64(value.createdAt),
  );
}

export function deviceTransferPackageAad(
  value: DeviceTransferPackageMetadataV2,
): Uint8Array {
  return packageMetadataBytes(value);
}

function assertPackage(value: DeviceTransferPackageV2): void {
  validatePackageMetadata(value);
  if (
    !(value.ciphertext instanceof Uint8Array)
    || value.ciphertext.length < 1
    || value.ciphertext.length > V2_LIMITS.ciphertextBytes
  ) {
    throw new RangeError("Device transfer ciphertext exceeds format limits");
  }
}

function serializePackage(value: DeviceTransferPackageV2): Uint8Array {
  assertPackage(value);
  return concatV2(packageMetadataBytes(value), frame(value.ciphertext));
}

function decodePackage(bytes: Uint8Array): DeviceTransferPackageV2 {
  return decodeExact(bytes, (reader) => {
    readExactText(
      reader,
      DEVICE_TRANSFER_KEYRING_DOMAIN,
      "Device transfer package domain",
    );
    reader.readVersion(DEVICE_TRANSFER_FORMAT_VERSION);
    const value: DeviceTransferPackageV2 = {
      formatVersion: DEVICE_TRANSFER_FORMAT_VERSION,
      humanId: humanId(reader.readText(V2_LIMITS.idBytes)),
      targetDeviceId: cryptoDeviceId(reader.readText(V2_LIMITS.idBytes)),
      pendingDeviceRevision: pendingDeviceRevision(reader.readU64()),
      encryptionPublicKeyDigest: reader.readFrame(HASH_BYTES),
      signingPublicKeyDigest: reader.readFrame(HASH_BYTES),
      namespaceId: namespaceId(reader.readText(V2_LIMITS.idBytes)),
      keyClass: reader.readText(5) as NamespaceKeyClass,
      domainId: cryptoDomainId(reader.readText(V2_LIMITS.idBytes)),
      domainEpoch: domainEpoch(reader.readU64()),
      accessRevision: accessRevision(reader.readU64()),
      currentGeneration: namespaceGeneration(reader.readU64()),
      bindingHash: reader.readFrame(HASH_BYTES),
      issuerDeviceId: cryptoDeviceId(reader.readText(V2_LIMITS.idBytes)),
      createdAt: unixTimestamp(reader.readU64()),
      ciphertext: reader.readFrame(V2_LIMITS.ciphertextBytes),
    };
    assertPackage(value);
    return Object.freeze(value);
  });
}

function validateJoin(value: DeviceTransferJoinIntentV2): void {
  if (typeof value !== "object" || value === null) {
    throw new TypeError("Device transfer join intent must be an object");
  }
  assertExactFields("Device transfer join intent", value, JOIN_FIELDS);
  if (value.formatVersion !== DEVICE_TRANSFER_FORMAT_VERSION) {
    throw new RangeError("Device transfer join version is unsupported");
  }
  humanId(value.humanId);
  cryptoDeviceId(value.targetDeviceId);
  pendingDeviceRevision(value.pendingDeviceRevision);
  cryptoDomainId(value.domainId);
  domainEpoch(value.domainEpoch);
  cryptoDeviceId(value.committerDeviceId);
}

function joinBytes(value: DeviceTransferJoinIntentV2): Uint8Array {
  validateJoin(value);
  return concatV2(
    frameText(DEVICE_TRANSFER_APPROVAL_DOMAIN),
    frameText("current-domain-join"),
    encodeU32(DEVICE_TRANSFER_FORMAT_VERSION),
    frameText(value.humanId),
    frameText(value.targetDeviceId),
    encodeU64(value.pendingDeviceRevision),
    frameText(value.domainId),
    encodeU64(value.domainEpoch),
    frameText(value.committerDeviceId),
  );
}

function approvalWireLength(value: DeviceTransferApprovalV2): number {
  let total = approvalMetadataBytes(value).length
    + FRAME_LENGTH_BYTES
    + FRAME_LENGTH_BYTES
    + FRAME_LENGTH_BYTES
    + value.signature.length;
  assertDeviceTransferApprovalWireLengthV2(total);
  for (const item of value.packages) {
    total += FRAME_LENGTH_BYTES
      + packageMetadataBytes(item).length
      + FRAME_LENGTH_BYTES
      + item.ciphertext.length;
    assertDeviceTransferApprovalWireLengthV2(total);
  }
  for (const intent of value.joinIntents) {
    total += FRAME_LENGTH_BYTES + joinBytes(intent).length;
    assertDeviceTransferApprovalWireLengthV2(total);
  }
  return total;
}

function readJoin(reader: StrictDecoder): DeviceTransferJoinIntentV2 {
  readExactText(
    reader,
    DEVICE_TRANSFER_APPROVAL_DOMAIN,
    "Device transfer approval domain",
  );
  readExactText(reader, "current-domain-join", "Device transfer join kind");
  reader.readVersion(DEVICE_TRANSFER_FORMAT_VERSION);
  const value: DeviceTransferJoinIntentV2 = {
    formatVersion: DEVICE_TRANSFER_FORMAT_VERSION,
    humanId: humanId(reader.readText(V2_LIMITS.idBytes)),
    targetDeviceId: cryptoDeviceId(reader.readText(V2_LIMITS.idBytes)),
    pendingDeviceRevision: pendingDeviceRevision(reader.readU64()),
    domainId: cryptoDomainId(reader.readText(V2_LIMITS.idBytes)),
    domainEpoch: domainEpoch(reader.readU64()),
    committerDeviceId: cryptoDeviceId(reader.readText(V2_LIMITS.idBytes)),
  };
  validateJoin(value);
  return Object.freeze(value);
}

function comparePackages(
  left: DeviceTransferPackageV2,
  right: DeviceTransferPackageV2,
): number {
  const namespaceOrder = compareUnsignedUtf8(
    left.namespaceId,
    right.namespaceId,
  );
  return namespaceOrder === 0
    ? compareUnsignedUtf8(left.keyClass, right.keyClass)
    : namespaceOrder;
}

function validateApproval(value: DeviceTransferApprovalV2): void {
  if (typeof value !== "object" || value === null) {
    throw new TypeError("Device transfer approval must be an object");
  }
  assertExactFields("Device transfer approval", value, APPROVAL_FIELDS);
  if (value.formatVersion !== DEVICE_TRANSFER_FORMAT_VERSION) {
    throw new RangeError("Device transfer approval version is unsupported");
  }
  humanId(value.humanId);
  cryptoDeviceId(value.targetDeviceId);
  pendingDeviceRevision(value.pendingDeviceRevision);
  assertBytes(
    "Device transfer approval encryption-key digest",
    value.encryptionPublicKeyDigest,
    HASH_BYTES,
  );
  assertBytes(
    "Device transfer approval signing-key digest",
    value.signingPublicKeyDigest,
    HASH_BYTES,
  );
  cryptoDeviceId(value.issuerDeviceId);
  unixTimestamp(value.createdAt);
  deviceTransferInventoryRevision(value.inventoryRevision);
  assertV2Limit(
    "Device transfer approval inventory count",
    value.inventoryCount,
    V2_LIMITS.recoveryPackages,
  );
  assertBytes(
    "Device transfer approval inventory digest",
    value.inventoryDigest,
    HASH_BYTES,
  );
  if (!Array.isArray(value.packages as unknown)) {
    throw new TypeError("Device transfer packages must be an array");
  }
  assertV2Limit(
    "Device transfer package count",
    value.packages.length,
    V2_LIMITS.recoveryPackages,
  );
  if (value.packages.length !== value.inventoryCount) {
    throw new Error(
      "Device transfer approval package count does not match inventory commitment",
    );
  }
  if (!Array.isArray(value.joinIntents as unknown)) {
    throw new TypeError("Device transfer join intents must be an array");
  }
  assertV2Limit(
    "Device transfer join count",
    value.joinIntents.length,
    V2_LIMITS.recoveryPackages,
  );
  let previousPackage: DeviceTransferPackageV2 | undefined;
  for (const item of value.packages) {
    assertPackage(item);
    if (
      item.humanId !== value.humanId
      || item.targetDeviceId !== value.targetDeviceId
      || item.pendingDeviceRevision !== value.pendingDeviceRevision
      || item.issuerDeviceId !== value.issuerDeviceId
      || item.createdAt !== value.createdAt
      || !equalBytes(
        item.encryptionPublicKeyDigest,
        value.encryptionPublicKeyDigest,
      )
      || !equalBytes(
        item.signingPublicKeyDigest,
        value.signingPublicKeyDigest,
      )
    ) {
      throw new Error("Device transfer package is detached from its approval");
    }
    if (
      previousPackage
      && comparePackages(previousPackage, item) >= 0
    ) {
      throw new Error(
        "Device transfer packages must be unique and canonical",
      );
    }
    previousPackage = item;
  }
  for (const intent of value.joinIntents) {
    validateJoin(intent);
    if (
      intent.humanId !== value.humanId
      || intent.targetDeviceId !== value.targetDeviceId
      || intent.pendingDeviceRevision !== value.pendingDeviceRevision
      || intent.committerDeviceId !== value.issuerDeviceId
    ) {
      throw new Error(
        "Device transfer join intents must be exact, unique, and canonical",
      );
    }
  }
  for (let index = 1; index < value.joinIntents.length; index++) {
    if (
      compareUnsignedUtf8(
        value.joinIntents[index - 1]!.domainId,
        value.joinIntents[index]!.domainId,
      ) >= 0
    ) {
      throw new Error(
        "Device transfer join intents must be exact, unique, and canonical",
      );
    }
  }
  assertBytes(
    "Device transfer approval signature",
    value.signature,
    V2_LIMITS.signatureBytes,
  );
}

function approvalMetadataBytes(value: DeviceTransferApprovalV2): Uint8Array {
  return concatV2(
    frameText(DEVICE_TRANSFER_APPROVAL_DOMAIN),
    frameText("approval"),
    encodeU32(DEVICE_TRANSFER_FORMAT_VERSION),
    frameText(value.humanId),
    frameText(value.targetDeviceId),
    encodeU64(value.pendingDeviceRevision),
    frame(value.encryptionPublicKeyDigest),
    frame(value.signingPublicKeyDigest),
    frameText(value.issuerDeviceId),
    encodeU64(value.createdAt),
    encodeU64(value.inventoryRevision),
    encodeU32(value.inventoryCount),
    frame(value.inventoryDigest),
  );
}

export function deviceTransferApprovalSigningBytes(
  value: DeviceTransferApprovalV2,
): Uint8Array {
  validateApproval(value);
  approvalWireLength(value);
  return concatV2(
    approvalMetadataBytes(value),
    encodeU32(value.packages.length),
    ...value.packages.map((item) => frame(sha256(serializePackage(item)))),
    encodeU32(value.joinIntents.length),
    ...value.joinIntents.map((intent) => frame(sha256(joinBytes(intent)))),
  );
}

export function serializeDeviceTransferApproval(
  value: DeviceTransferApprovalV2,
): Uint8Array {
  validateApproval(value);
  const predictedWireLength = approvalWireLength(value);
  const wire = concatV2(
    approvalMetadataBytes(value),
    encodeU32(value.packages.length),
    ...value.packages.map((item) => frame(serializePackage(item))),
    encodeU32(value.joinIntents.length),
    ...value.joinIntents.map((intent) => frame(joinBytes(intent))),
    frame(value.signature),
  );
  if (wire.length !== predictedWireLength) {
    throw new Error("Device transfer approval wire length is noncanonical");
  }
  return wire;
}

export function assertDeviceTransferApprovalWireLengthV2(
  wireLength: number,
): void {
  if (wireLength > V2_LIMITS.recoveryArchiveBytes) {
    throw new RangeError(
      "Device transfer approval exceeds the 64 MiB aggregate-byte limit",
    );
  }
}

export function decodeDeviceTransferApproval(
  bytes: Uint8Array,
): DeviceTransferApprovalV2 {
  assertDeviceTransferApprovalInputBytes(bytes);
  return decodeExact(bytes, (reader) => {
    readExactText(
      reader,
      DEVICE_TRANSFER_APPROVAL_DOMAIN,
      "Device transfer approval domain",
    );
    readExactText(reader, "approval", "Device transfer approval kind");
    reader.readVersion(DEVICE_TRANSFER_FORMAT_VERSION);
    const human = humanId(reader.readText(V2_LIMITS.idBytes));
    const targetDeviceId = cryptoDeviceId(
      reader.readText(V2_LIMITS.idBytes),
    );
    const revision = pendingDeviceRevision(reader.readU64());
    const encryptionPublicKeyDigest = reader.readFrame(HASH_BYTES);
    const signingPublicKeyDigest = reader.readFrame(HASH_BYTES);
    const issuerDeviceId = cryptoDeviceId(
      reader.readText(V2_LIMITS.idBytes),
    );
    const createdAt = unixTimestamp(reader.readU64());
    const inventoryRevisionValue =
      deviceTransferInventoryRevision(reader.readU64());
    const inventoryCount = reader.readCount(V2_LIMITS.recoveryPackages);
    const inventoryDigestValue = reader.readFrame(HASH_BYTES);
    const packageCount = reader.readCount(V2_LIMITS.recoveryPackages);
    const packages = Array.from({ length: packageCount }, () =>
      decodePackage(
        reader.readFrame(V2_LIMITS.ciphertextBytes + MAX_METADATA_BYTES),
      )
    );
    const joinCount = reader.readCount(V2_LIMITS.recoveryPackages);
    const joinIntents = Array.from({ length: joinCount }, () =>
      decodeExact(
        reader.readFrame(MAX_METADATA_BYTES),
        readJoin,
      )
    );
    const signature = reader.readFrame(V2_LIMITS.signatureBytes);
    const value: DeviceTransferApprovalV2 = {
      formatVersion: DEVICE_TRANSFER_FORMAT_VERSION,
      humanId: human,
      targetDeviceId,
      pendingDeviceRevision: revision,
      encryptionPublicKeyDigest,
      signingPublicKeyDigest,
      issuerDeviceId,
      createdAt,
      inventoryRevision: inventoryRevisionValue,
      inventoryCount,
      inventoryDigest: inventoryDigestValue,
      packages,
      joinIntents,
      signature,
    };
    validateApproval(value);
    return Object.freeze({
      ...value,
      packages: Object.freeze(packages),
      joinIntents: Object.freeze(joinIntents),
    });
  });
}

function assertDeviceTransferApprovalInputBytes(
  bytes: unknown,
): asserts bytes is Uint8Array {
  if (
    !(bytes instanceof Uint8Array)
    || bytes.length > V2_LIMITS.recoveryArchiveBytes
  ) {
    throw new CanonicalDecodingError(
      "Device transfer approval exceeds the 64 MiB aggregate-byte limit",
    );
  }
}

function approverContext(
  purpose: DeviceTransferApproverContextV2["purpose"],
  human: HumanId,
  pending: DeviceTransferPendingDeviceV2,
  issuerDeviceId: CryptoDeviceId,
  createdAt: UnixTimestamp,
): DeviceTransferApproverContextV2 {
  return Object.freeze({
    purpose,
    humanId: human,
    targetDeviceId: pending.deviceId,
    pendingDeviceRevision: pending.pendingDeviceRevision,
    issuerDeviceId,
    createdAt,
  });
}

function joinContext(
  human: HumanId,
  pending: DeviceTransferPendingDeviceV2,
  domainIdValue: CryptoDomainId,
  epoch: DomainEpoch,
  issuerDeviceId: CryptoDeviceId,
): DeviceTransferDomainCommitterContextV2 {
  return Object.freeze({
    purpose: "device-transfer-domain-join",
    formatVersion: DEVICE_TRANSFER_FORMAT_VERSION,
    humanId: human,
    targetDeviceId: pending.deviceId,
    pendingDeviceRevision: pending.pendingDeviceRevision,
    domainId: domainIdValue,
    domainEpoch: epoch,
    committerDeviceId: issuerDeviceId,
  });
}

function currentDomains(
  explicit: readonly DeviceTransferCurrentDomainV2[] | undefined,
  inventory: readonly DeviceTransferInventoryItemV2[],
  label: string,
): ReadonlyMap<string, DomainEpoch> {
  const inventoryDomains = assertConsistentCurrentDomainEpochsV2(
    inventory,
    label,
  );
  if (explicit === undefined) return inventoryDomains;
  if (!Array.isArray(explicit as unknown)) {
    throw new TypeError(`${label} Domains must be an array`);
  }
  assertV2Limit(
    `${label} Domain count`,
    explicit.length,
    V2_LIMITS.recoveryPackages,
  );
  const domains = new Map<string, DomainEpoch>();
  let previous: string | undefined;
  for (const candidate of explicit) {
    if (typeof candidate !== "object" || candidate === null) {
      throw new TypeError(`${label} Domain must be an object`);
    }
    assertExactFields(`${label} Domain`, candidate, ["domainEpoch", "domainId"]);
    const domainIdValue = cryptoDomainId(candidate.domainId);
    const epoch = domainEpoch(candidate.domainEpoch);
    if (
      previous !== undefined
      && compareUnsignedUtf8(previous, domainIdValue) >= 0
    ) {
      throw new Error(`${label} Domains must be unique and canonical`);
    }
    domains.set(domainIdValue, epoch);
    previous = domainIdValue;
  }
  for (const [domainIdValue, epoch] of inventoryDomains) {
    if (domains.get(domainIdValue) !== epoch) {
      throw new Error(`${label} omits or changes an inventory Domain`);
    }
  }
  return domains;
}

function assertSamePublicKey(
  label: string,
  left: Uint8Array | null,
  right: Uint8Array,
): void {
  if (left === null) throw new Error(`${label} is not currently authorized`);
  assertBytes(label, left, V2_LIMITS.signingPublicKeyBytes);
  if (!equalBytes(left, right)) {
    throw new Error(`${label} does not match the approving device`);
  }
}

function packagePlaintext(
  metadata: DeviceTransferPackageMetadataV2,
  keyring: NamespaceKeyringPlaintextV2,
): Uint8Array {
  const keyringBytes = encodeNamespaceKeyring(keyring);
  const framedKeyring = frame(keyringBytes);
  try {
    return concatV2(
      frame(packageMetadataBytes(metadata)),
      framedKeyring,
    );
  } finally {
    keyringBytes.fill(0);
    framedKeyring.fill(0);
  }
}

export async function prepareDeviceTransferV2(input: {
  readonly crypto: LatticeCrypto;
  readonly pendingDevice: DeviceTransferPendingDeviceV2;
  readonly resolveTrustedPendingDevice: ResolveTrustedPendingDeviceV2;
  readonly issuerDeviceId: CryptoDeviceId;
  readonly issuerSigningPrivateKey: Uint8Array;
  readonly createdAt: UnixTimestamp;
  readonly inventoryRevision: DeviceTransferInventoryRevision;
  readonly sources: readonly DeviceTransferKeyringSourceV2[];
  readonly currentDomains?: readonly DeviceTransferCurrentDomainV2[];
  readonly resolveTrustedInventoryCommitment:
    ResolveTrustedDeviceTransferInventoryCommitmentV2;
  readonly resolveCurrentApprover: ResolveCurrentDeviceTransferApproverV2;
  readonly resolveCurrentDomainCommitter:
    ResolveCurrentDeviceTransferDomainCommitterV2;
}): Promise<PreparedDeviceTransferV2> {
  preflightInventoryShape(input.sources, TRANSFER_SOURCE_FIELDS);
  const checkedPending = validatePendingCandidate(input.pendingDevice);
  const issuerDeviceId = cryptoDeviceId(input.issuerDeviceId);
  const createdAt = unixTimestamp(input.createdAt);
  const inventoryRevisionValue = deviceTransferInventoryRevision(
    input.inventoryRevision,
  );
  assertBytes(
    "Device transfer issuer signing private key",
    input.issuerSigningPrivateKey,
    V2_LIMITS.signingPrivateKeyBytes,
  );
  const issuerSigningPrivateKey = copyOwnedBytesV2(
    input.issuerSigningPrivateKey,
  );
  try {
  const sources = normalizeInventory(
    input.sources,
    checkedPending.humanId,
    TRANSFER_SOURCE_FIELDS,
  );
  const trusted = resolvePending(
    checkedPending,
    input.resolveTrustedPendingDevice,
  );
  const human = trusted.pending.humanId;
  const issuerPublicKey = input.resolveCurrentApprover(
    approverContext(
      "device-transfer-publish",
      human,
      trusted.pending,
      issuerDeviceId,
      createdAt,
    ),
  );
  if (issuerPublicKey === null) {
    throw new Error("Device transfer approver is not currently authorized");
  }
  assertBytes(
    "Device transfer approver signing public key",
    issuerPublicKey,
    V2_LIMITS.signingPublicKeyBytes,
  );

  const inventoryCommitment = resolveExactInventoryCommitment(
    human,
    inventoryRevisionValue,
    sources,
    input.resolveTrustedInventoryCommitment,
  );
  const joinsByDomain = new Map<string, DeviceTransferJoinIntentV2>();
  const domains = currentDomains(
    input.currentDomains,
    sources,
    "Device transfer current inventory",
  );
  for (const [domainIdValue, epoch] of domains) {
    const context = joinContext(
      human,
      trusted.pending,
      cryptoDomainId(domainIdValue),
      epoch,
      issuerDeviceId,
    );
    assertSamePublicKey(
      "Device transfer current Domain committer",
      input.resolveCurrentDomainCommitter(context),
      issuerPublicKey,
    );
    joinsByDomain.set(domainIdValue, Object.freeze({
      formatVersion: DEVICE_TRANSFER_FORMAT_VERSION,
      humanId: human,
      targetDeviceId: trusted.pending.deviceId,
      pendingDeviceRevision: trusted.pending.pendingDeviceRevision,
      domainId: cryptoDomainId(domainIdValue),
      domainEpoch: epoch,
      committerDeviceId: issuerDeviceId,
    }));
  }
  const joinIntents = Object.freeze(
    [...joinsByDomain.values()].sort((left, right) =>
      compareUnsignedUtf8(left.domainId, right.domainId)
    ),
  );

  const plans: {
    readonly metadata: DeviceTransferPackageMetadataV2;
    readonly plaintext: Uint8Array;
    readonly ciphertextBytes: number;
  }[] = [];
  let predictedBytes = deviceTransferApprovalBasePredictionV2(
    joinIntents.map((intent) => joinBytes(intent).length),
  );
  try {
    for (const source of sources) {
      let opened: NamespaceKeyringPlaintextV2 | null = null;
      let plaintext: Uint8Array | null = null;
      try {
        const head = source.trustedNamespaceHead;
        opened = openNamespaceKeyring({
          crypto: input.crypto,
          domainRoot: source.currentDomainRoot,
          envelope: source.currentKeyringEnvelope,
          resolveHistoricalCommitter: source.resolveHistoricalCommitter,
        });
        assertCompleteKeyring(opened);
        const metadata: DeviceTransferPackageMetadataV2 = {
          formatVersion: DEVICE_TRANSFER_FORMAT_VERSION,
          humanId: human,
          targetDeviceId: trusted.pending.deviceId,
          pendingDeviceRevision: trusted.pending.pendingDeviceRevision,
          encryptionPublicKeyDigest: copyOwnedBytesV2(
            trusted.encryptionDigest,
          ),
          signingPublicKeyDigest: copyOwnedBytesV2(
            trusted.signingDigest,
          ),
          namespaceId: head.namespaceId,
          keyClass: source.keyClass,
          domainId: head.binding.domainId,
          domainEpoch: head.binding.domainEpoch,
          accessRevision: head.accessRevision,
          currentGeneration: currentGeneration(head, source.keyClass),
          bindingHash: copyOwnedBytesV2(head.bindingHash),
          issuerDeviceId,
          createdAt,
        };
        plaintext = packagePlaintext(metadata, opened);
        const ciphertextBytes = predictedHpkeCiphertextBytes(plaintext.length);
        predictedBytes = advanceDeviceTransferApprovalPredictionV2(
          predictedBytes,
          packageMetadataBytes(metadata).length,
          ciphertextBytes,
        );
        plans.push({ metadata, plaintext, ciphertextBytes });
        plaintext = null;
      } finally {
        opened?.generations.forEach((item) => item.key.fill(0));
        plaintext?.fill(0);
      }
    }

    const proof = concatV2(
      frameText(DEVICE_TRANSFER_APPROVAL_DOMAIN),
      frameText(human),
      frameText(trusted.pending.deviceId),
      encodeU64(trusted.pending.pendingDeviceRevision),
      frameText(issuerDeviceId),
      encodeU64(createdAt),
    );
    if (
      !input.crypto.verify(
        issuerPublicKey,
        proof,
        input.crypto.sign(issuerSigningPrivateKey, proof),
      )
    ) {
      throw new Error(
        "Device transfer issuer private key does not match current authority",
      );
    }

    const packages: DeviceTransferPackageV2[] = [];
    for (const plan of plans) {
      const ciphertext = await input.crypto.sealTo(
        trusted.pending.encryptionPublicKey,
        plan.plaintext,
      );
      if (ciphertext.length !== plan.ciphertextBytes) {
        throw new Error("Device transfer HPKE ciphertext is noncanonical");
      }
      packages.push(Object.freeze({
        ...plan.metadata,
        encryptionPublicKeyDigest:
          plan.metadata.encryptionPublicKeyDigest,
        signingPublicKeyDigest:
          plan.metadata.signingPublicKeyDigest,
        bindingHash: plan.metadata.bindingHash,
        ciphertext: copyOwnedBytesV2(ciphertext),
      }));
    }
    const unsigned: DeviceTransferApprovalV2 = {
      formatVersion: DEVICE_TRANSFER_FORMAT_VERSION,
      humanId: human,
      targetDeviceId: trusted.pending.deviceId,
      pendingDeviceRevision: trusted.pending.pendingDeviceRevision,
      encryptionPublicKeyDigest: trusted.encryptionDigest,
      signingPublicKeyDigest: trusted.signingDigest,
      issuerDeviceId,
      createdAt,
      inventoryRevision: inventoryCommitment.inventoryRevision,
      inventoryCount: inventoryCommitment.inventoryCount,
      inventoryDigest: inventoryCommitment.inventoryDigest,
      packages: Object.freeze(packages),
      joinIntents,
      signature: new Uint8Array(V2_LIMITS.signatureBytes),
    };
    const approval: DeviceTransferApprovalV2 = Object.freeze({
      ...unsigned,
      signature: copyOwnedBytesV2(
        input.crypto.sign(
          issuerSigningPrivateKey,
          deviceTransferApprovalSigningBytes(unsigned),
        ),
      ),
    });
    const approvalBytes = serializeDeviceTransferApproval(approval);
    return Object.freeze({
      approval,
      approvalBytes,
      activationCas: Object.freeze({
        humanId: human,
        deviceId: trusted.pending.deviceId,
        expectedStatus: "pending",
        expectedPendingDeviceRevision:
          trusted.pending.pendingDeviceRevision,
        expectedPendingEncryptionPublicKeyDigest:
          copyOwnedBytesV2(trusted.encryptionDigest),
        expectedPendingSigningPublicKeyDigest:
          copyOwnedBytesV2(trusted.signingDigest),
        intendedStatus: "active",
        expectedInventoryRevision: inventoryCommitment.inventoryRevision,
        expectedInventoryCount: inventoryCommitment.inventoryCount,
        expectedInventoryDigest:
          copyOwnedBytesV2(inventoryCommitment.inventoryDigest),
        approvalHash: sha256(approvalBytes),
      }),
    });
  } finally {
    plans.forEach((plan) => plan.plaintext.fill(0));
  }
  } finally {
    issuerSigningPrivateKey.fill(0);
  }
}

function decodePackagePlaintext(
  plaintext: Uint8Array,
  item: DeviceTransferPackageV2,
): NamespaceKeyringPlaintextV2 {
  const reader = new StrictDecoder(plaintext);
  let keyring: NamespaceKeyringPlaintextV2 | null = null;
  try {
    const embedded = reader.readFrame(MAX_METADATA_BYTES);
    if (!equalBytes(embedded, packageMetadataBytes(item))) {
      throw new Error(
        "Device transfer embedded and outer metadata do not match",
      );
    }
    const keyringBytes = reader.readFrame(V2_LIMITS.namespaceKeyringBytes);
    try {
      keyring = decodeNamespaceKeyring(keyringBytes);
    } finally {
      keyringBytes.fill(0);
    }
    reader.assertFinished();
    assertCompleteKeyring(keyring);
    if (
      keyring.namespaceId !== item.namespaceId
      || keyring.keyClass !== item.keyClass
      || keyring.accessRevision !== item.accessRevision
      || keyring.currentGeneration !== item.currentGeneration
    ) {
      throw new Error(
        "Device transfer inner keyring does not match its package",
      );
    }
    return keyring;
  } catch (error) {
    keyring?.generations.forEach((entry) => entry.key.fill(0));
    throw error;
  } finally {
    reader.destroy(true);
  }
}

export async function openDeviceTransferV2(input: {
  readonly crypto: LatticeCrypto;
  readonly approvalBytes: Uint8Array;
  readonly pendingDevice: DeviceTransferPendingDeviceV2;
  readonly pendingEncryptionPrivateKey: Uint8Array;
  readonly resolveTrustedPendingDevice: ResolveTrustedPendingDeviceV2;
  readonly expectedInventory: readonly DeviceTransferInventoryItemV2[];
  readonly expectedDomains?: readonly DeviceTransferCurrentDomainV2[];
  readonly resolveTrustedInventoryCommitment:
    ResolveTrustedDeviceTransferInventoryCommitmentV2;
  readonly resolveCurrentApprover: ResolveCurrentDeviceTransferApproverV2;
  readonly resolveCurrentDomainCommitter:
    ResolveCurrentDeviceTransferDomainCommitterV2;
}): Promise<OpenedDeviceTransferV2> {
  if (!(input.approvalBytes instanceof Uint8Array)) {
    throw new TypeError("Device transfer approval bytes must be bytes");
  }
  const approvalBytes = input.approvalBytes;
  assertDeviceTransferApprovalInputBytes(approvalBytes);
  const approvalHash = sha256(approvalBytes);
  preflightInventoryShape(
    input.expectedInventory,
    READINESS_INVENTORY_FIELDS,
  );
  const checkedPending = validatePendingCandidate(input.pendingDevice);
  assertBytes(
    "Pending device encryption private key",
    input.pendingEncryptionPrivateKey,
    V2_LIMITS.hpkePrivateKeyBytes,
  );
  const pendingEncryptionPrivateKey = copyOwnedBytesV2(
    input.pendingEncryptionPrivateKey,
  );
  try {
  const approval = decodeDeviceTransferApproval(approvalBytes);
  const expected = normalizeInventory(
    input.expectedInventory,
    checkedPending.humanId,
    READINESS_INVENTORY_FIELDS,
  );
  const candidatePending = Object.freeze({
    pending: checkedPending,
    encryptionDigest: sha256(checkedPending.encryptionPublicKey),
    signingDigest: sha256(checkedPending.signingPublicKey),
  });
  if (
    approval.humanId !== checkedPending.humanId
    || approval.targetDeviceId !== checkedPending.deviceId
    || approval.pendingDeviceRevision
      !== checkedPending.pendingDeviceRevision
    || !equalBytes(
      approval.encryptionPublicKeyDigest,
      candidatePending.encryptionDigest,
    )
    || !equalBytes(
      approval.signingPublicKeyDigest,
      candidatePending.signingDigest,
    )
  ) {
    throw new Error(
      "Device transfer approval targets another pending device",
    );
  }
  if (expected.length !== approval.packages.length) {
    throw new Error(
      "Device transfer approval is missing or adds unauthorized keyrings",
    );
  }
  for (let index = 0; index < expected.length; index++) {
    const source = expected[index]!;
    const item = approval.packages[index]!;
    const head = source.trustedNamespaceHead;
    if (
      item.namespaceId !== head.namespaceId
      || item.keyClass !== source.keyClass
      || item.domainId !== head.binding.domainId
      || item.domainEpoch !== head.binding.domainEpoch
      || item.accessRevision !== head.accessRevision
      || item.currentGeneration !== currentGeneration(head, source.keyClass)
      || !equalBytes(item.bindingHash, head.bindingHash)
    ) {
      throw new Error(
        "Device transfer package is outside the authorized inventory",
      );
    }
  }

  const expectedDomains = currentDomains(
    input.expectedDomains,
    expected,
    "Device transfer expected inventory",
  );
  if (approval.joinIntents.length !== expectedDomains.size) {
    throw new Error("Device transfer current-Domain join inventory is incomplete");
  }
  for (const intent of approval.joinIntents) {
    if (
      expectedDomains.get(intent.domainId) !== intent.domainEpoch
    ) {
      throw new Error("Device transfer current-Domain join intent is stale");
    }
  }

  const pending = resolvePending(
    checkedPending,
    input.resolveTrustedPendingDevice,
  );
  const issuerPublicKey = input.resolveCurrentApprover(
    approverContext(
      "device-transfer-open",
      approval.humanId,
      pending.pending,
      approval.issuerDeviceId,
      approval.createdAt,
    ),
  );
  if (issuerPublicKey === null) {
    throw new Error(
      "Device transfer approver is not currently authorized",
    );
  }
  if (
    !input.crypto.verify(
      issuerPublicKey,
      deviceTransferApprovalSigningBytes(approval),
      approval.signature,
    )
  ) {
    throw new Error(
      "Device transfer approval lacks current authorized-device signature",
    );
  }
  const inventoryCommitment = resolveExactInventoryCommitment(
    pending.pending.humanId,
    approval.inventoryRevision,
    expected,
    input.resolveTrustedInventoryCommitment,
  );
  if (
    !equalBytes(
      approval.inventoryDigest,
      inventoryCommitment.inventoryDigest,
    )
  ) {
    throw new Error(
      "Device transfer approval uses a stale inventory commitment",
    );
  }
  for (const intent of approval.joinIntents) {
    assertSamePublicKey(
      "Device transfer current Domain committer",
      input.resolveCurrentDomainCommitter({
        ...intent,
        purpose: "device-transfer-domain-join",
      }),
      issuerPublicKey,
    );
  }

  const restored: NamespaceKeyringPlaintextV2[] = [];
  try {
    for (const item of approval.packages) {
      const plaintext = await input.crypto.openSealed(
        pendingEncryptionPrivateKey,
        item.ciphertext,
      );
      if (plaintext === null) {
        throw new Error("Device transfer package failed to decrypt");
      }
      let decoded: NamespaceKeyringPlaintextV2 | null = null;
      try {
        decoded = decodePackagePlaintext(plaintext, item);
        restored.push(Object.freeze({
          ...decoded,
          generations: Object.freeze(
            decoded.generations.map((entry) =>
              Object.freeze({
                generation: entry.generation,
                key: copyOwnedBytesV2(entry.key),
              })
            ),
          ),
        }));
      } finally {
        plaintext.fill(0);
        decoded?.generations.forEach((entry) => entry.key.fill(0));
      }
    }
    return Object.freeze({
      keyrings: Object.freeze(restored),
      joinIntents: Object.freeze(approval.joinIntents),
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
        expectedInventoryRevision: inventoryCommitment.inventoryRevision,
        expectedInventoryCount: inventoryCommitment.inventoryCount,
        expectedInventoryDigest:
          inventoryCommitment.inventoryDigest,
        approvalHash,
      }),
    });
  } catch (error) {
    restored.forEach((keyring) =>
      keyring.generations.forEach((entry) => entry.key.fill(0))
    );
    throw error;
  }
  } finally {
    pendingEncryptionPrivateKey.fill(0);
  }
}
