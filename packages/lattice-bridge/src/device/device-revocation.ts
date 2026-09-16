import {
  cryptoDeviceId,
  cryptoDomainId,
  humanId,
  namespaceId,
  type LatticeCrypto,
} from "@nautilo/lattice-crypto";
import {
  MAX_ADDITIONAL_DEVICE_INVENTORY_RECORDS,
} from "./additional-device-enrollment.ts";
import {
  MAX_ACTIVE_DOMAINS_PER_DEVICE,
  MAX_NAMESPACES_PER_DOMAIN_TRANSITION,
} from "../delivery/device-fanout.ts";

export const DEVICE_REVOCATION_MANIFEST_FORMAT_VERSION = 1 as const;

export interface DeviceRevocationNamespaceHead {
  readonly namespaceId: string;
  readonly expectedAccessRevision: number;
  readonly expectedBindingHash: Uint8Array;
}

export interface DeviceRevocationDomainHead {
  readonly domainId: string;
  readonly expectedEpoch: number;
  readonly expectedAuthorizationRevision: number;
  readonly expectedParticipantDigest: Uint8Array;
  readonly namespaces: readonly DeviceRevocationNamespaceHead[];
}

export interface DeviceRevocationManifestUnsigned {
  readonly formatVersion:
    typeof DEVICE_REVOCATION_MANIFEST_FORMAT_VERSION;
  readonly operationId: string;
  readonly idempotencyKey: string;
  readonly humanId: string;
  readonly issuerDeviceId: string;
  readonly targetDeviceId: string;
  readonly expectedIssuerDeviceRevision: number;
  readonly expectedTargetDeviceRevision: number;
  readonly targetPublicFingerprint: Uint8Array;
  readonly targetSigningPublicKeyDigest: Uint8Array;
  readonly targetEncryptionPublicKeyDigest: Uint8Array;
  readonly expectedCustodyRevision: number;
  readonly expectedRecoveryGeneration: number;
  readonly expectedInventoryRevision: number | null;
  readonly expectedInventoryCount: number | null;
  readonly expectedInventoryDigest: Uint8Array | null;
  readonly domains: readonly DeviceRevocationDomainHead[];
  readonly issuedAt: number;
}

export interface DeviceRevocationManifest
  extends DeviceRevocationManifestUnsigned
{
  readonly signature: Uint8Array;
}

export type DeviceRevocationRegistryState =
  | "pending"
  | "active"
  | "revoked"
  | "rejected";

export interface DeviceRevocationRegistryDevice {
  readonly state: DeviceRevocationRegistryState;
  readonly humanId: string;
  readonly revision: number;
  readonly signingPublicKey: Uint8Array;
  readonly encryptionPublicKey: Uint8Array;
  readonly publicFingerprint: Uint8Array;
}

export type ResolveDeviceRevocationDevice = (
  deviceId: string,
) => DeviceRevocationRegistryDevice | null;

export interface VerifiedDeviceRevocationManifest {
  readonly manifest: DeviceRevocationManifest;
  readonly domainCount: number;
  readonly namespaceCount: number;
  readonly authorizationArtifactHash: Uint8Array;
}

const UNSIGNED_FIELDS = Object.freeze([
  "formatVersion",
  "operationId",
  "idempotencyKey",
  "humanId",
  "issuerDeviceId",
  "targetDeviceId",
  "expectedIssuerDeviceRevision",
  "expectedTargetDeviceRevision",
  "targetPublicFingerprint",
  "targetSigningPublicKeyDigest",
  "targetEncryptionPublicKeyDigest",
  "expectedCustodyRevision",
  "expectedRecoveryGeneration",
  "expectedInventoryRevision",
  "expectedInventoryCount",
  "expectedInventoryDigest",
  "domains",
  "issuedAt",
].sort());
const MANIFEST_FIELDS = Object.freeze([...UNSIGNED_FIELDS, "signature"].sort());
const DOMAIN_FIELDS = Object.freeze([
  "domainId",
  "expectedEpoch",
  "expectedAuthorizationRevision",
  "expectedParticipantDigest",
  "namespaces",
].sort());
const NAMESPACE_FIELDS = Object.freeze([
  "namespaceId",
  "expectedAccessRevision",
  "expectedBindingHash",
].sort());
const textEncoder = new TextEncoder();

function exactFields(
  label: string,
  value: unknown,
  expected: readonly string[],
): void {
  if (typeof value !== "object" || value === null) {
    throw new TypeError(`${label} must be an object`);
  }
  const actual = Object.keys(value).sort();
  if (
    actual.length !== expected.length
    || actual.some((field, index) => field !== expected[index])
  ) {
    throw new TypeError(`${label} fields are malformed`);
  }
}

function safeCounter(label: string, value: unknown): asserts value is number {
  if (
    typeof value !== "number"
    || !Number.isSafeInteger(value)
    || value < 0
  ) {
    throw new RangeError(`${label} must be a nonnegative safe integer`);
  }
}

function advancingCounter(
  label: string,
  value: unknown,
): asserts value is number {
  safeCounter(label, value);
  if (value === Number.MAX_SAFE_INTEGER) {
    throw new RangeError(`${label} cannot advance beyond its safe range`);
  }
}

function exactBytes(
  label: string,
  value: unknown,
  length: number,
): asserts value is Uint8Array {
  if (!(value instanceof Uint8Array) || value.length !== length) {
    throw new RangeError(`${label} must contain exactly ${length} bytes`);
  }
}

function portable(label: string, value: unknown): asserts value is string {
  if (
    typeof value !== "string"
    || value.length < 1
    || value.length > 128
    || !/^[A-Za-z0-9][A-Za-z0-9._:@/-]*$/.test(value)
  ) {
    throw new TypeError(`${label} must be a portable identifier`);
  }
}

function compareUtf8(left: string, right: string): number {
  const leftBytes = textEncoder.encode(left);
  const rightBytes = textEncoder.encode(right);
  const length = Math.min(leftBytes.length, rightBytes.length);
  for (let index = 0; index < length; index++) {
    const difference = leftBytes[index]! - rightBytes[index]!;
    if (difference !== 0) return difference;
  }
  return leftBytes.length - rightBytes.length;
}

function assertCanonicalOrder(label: string, values: readonly string[]): void {
  for (let index = 1; index < values.length; index++) {
    if (compareUtf8(values[index - 1]!, values[index]!) >= 0) {
      throw new Error(`${label} must be unique and canonically ordered`);
    }
  }
}

function canonicalInventory(input: DeviceRevocationManifestUnsigned): {
  readonly revision: number | null;
  readonly count: number | null;
  readonly digest: Uint8Array | null;
} {
  const revision = input.expectedInventoryRevision;
  const count = input.expectedInventoryCount;
  const digest = input.expectedInventoryDigest;
  if (revision === null && count === null && digest === null) {
    return { revision: null, count: null, digest: null };
  }
  if (revision === null || count === null || digest === null) {
    throw new TypeError(
      "Device revocation inventory coordinates must be all null or complete",
    );
  }
  safeCounter("Device revocation inventory revision", revision);
  safeCounter("Device revocation inventory count", count);
  if (
    count < 1
    || count > MAX_ADDITIONAL_DEVICE_INVENTORY_RECORDS
  ) {
    throw new RangeError("Device revocation inventory count is out of bounds");
  }
  exactBytes("Device revocation inventory digest", digest, 32);
  return {
    revision,
    count,
    digest: Uint8Array.from(digest),
  };
}

function canonicalNamespaces(
  namespaces: readonly DeviceRevocationNamespaceHead[],
): readonly DeviceRevocationNamespaceHead[] {
  if (
    !Array.isArray(namespaces)
    || namespaces.length > MAX_NAMESPACES_PER_DOMAIN_TRANSITION
  ) {
    throw new RangeError("Device revocation Domain has too many Namespaces");
  }
  const output = namespaces.map((item: DeviceRevocationNamespaceHead) => {
    exactFields("Device revocation Namespace head", item, NAMESPACE_FIELDS);
    const canonicalNamespaceId = namespaceId(item.namespaceId);
    advancingCounter(
      "Device revocation Namespace access revision",
      item.expectedAccessRevision,
    );
    exactBytes(
      "Device revocation Namespace binding hash",
      item.expectedBindingHash,
      32,
    );
    return Object.freeze({
      namespaceId: canonicalNamespaceId,
      expectedAccessRevision: item.expectedAccessRevision,
      expectedBindingHash: Uint8Array.from(item.expectedBindingHash),
    });
  });
  assertCanonicalOrder(
    "Device revocation Namespaces",
    output.map((item) => item.namespaceId),
  );
  return Object.freeze(output);
}

function canonicalDomains(
  domains: readonly DeviceRevocationDomainHead[],
): readonly DeviceRevocationDomainHead[] {
  if (
    !Array.isArray(domains)
    || domains.length > MAX_ACTIVE_DOMAINS_PER_DEVICE
  ) {
    throw new RangeError("Device revocation has too many Domains");
  }
  let namespaceCount = 0;
  const output = domains.map((item: DeviceRevocationDomainHead) => {
    exactFields("Device revocation Domain head", item, DOMAIN_FIELDS);
    const canonicalDomainId = cryptoDomainId(item.domainId);
    advancingCounter("Device revocation Domain epoch", item.expectedEpoch);
    safeCounter(
      "Device revocation Domain authorization revision",
      item.expectedAuthorizationRevision,
    );
    exactBytes(
      "Device revocation Domain participant digest",
      item.expectedParticipantDigest,
      32,
    );
    const namespaces = canonicalNamespaces(item.namespaces);
    namespaceCount += namespaces.length;
    if (namespaceCount > MAX_ADDITIONAL_DEVICE_INVENTORY_RECORDS) {
      throw new RangeError(
        "Device revocation Namespace inventory exceeds its aggregate bound",
      );
    }
    return Object.freeze({
      domainId: canonicalDomainId,
      expectedEpoch: item.expectedEpoch,
      expectedAuthorizationRevision: item.expectedAuthorizationRevision,
      expectedParticipantDigest: Uint8Array.from(
        item.expectedParticipantDigest,
      ),
      namespaces,
    });
  });
  assertCanonicalOrder(
    "Device revocation Domains",
    output.map((item) => item.domainId),
  );
  return Object.freeze(output);
}

function canonicalUnsigned(
  input: DeviceRevocationManifestUnsigned,
): DeviceRevocationManifestUnsigned {
  exactFields("Device revocation manifest", input, UNSIGNED_FIELDS);
  if (input.formatVersion !== DEVICE_REVOCATION_MANIFEST_FORMAT_VERSION) {
    throw new TypeError("Device revocation manifest version is unsupported");
  }
  portable("Device revocation operation id", input.operationId);
  portable("Device revocation idempotency key", input.idempotencyKey);
  const canonicalHumanId = humanId(input.humanId);
  const canonicalIssuerId = cryptoDeviceId(input.issuerDeviceId);
  const canonicalTargetId = cryptoDeviceId(input.targetDeviceId);
  safeCounter(
    "Device revocation issuer-device revision",
    input.expectedIssuerDeviceRevision,
  );
  advancingCounter(
    "Device revocation target-device revision",
    input.expectedTargetDeviceRevision,
  );
  exactBytes(
    "Device revocation target fingerprint",
    input.targetPublicFingerprint,
    32,
  );
  exactBytes(
    "Device revocation target signing-key digest",
    input.targetSigningPublicKeyDigest,
    32,
  );
  exactBytes(
    "Device revocation target encryption-key digest",
    input.targetEncryptionPublicKeyDigest,
    32,
  );
  advancingCounter(
    "Device revocation custody revision",
    input.expectedCustodyRevision,
  );
  safeCounter(
    "Device revocation recovery generation",
    input.expectedRecoveryGeneration,
  );
  if (input.expectedRecoveryGeneration < 1) {
    throw new RangeError(
      "Device revocation recovery generation must be positive",
    );
  }
  const inventory = canonicalInventory(input);
  const domains = canonicalDomains(input.domains);
  safeCounter("Device revocation issue time", input.issuedAt);
  return Object.freeze({
    formatVersion: DEVICE_REVOCATION_MANIFEST_FORMAT_VERSION,
    operationId: input.operationId,
    idempotencyKey: input.idempotencyKey,
    humanId: canonicalHumanId,
    issuerDeviceId: canonicalIssuerId,
    targetDeviceId: canonicalTargetId,
    expectedIssuerDeviceRevision: input.expectedIssuerDeviceRevision,
    expectedTargetDeviceRevision: input.expectedTargetDeviceRevision,
    targetPublicFingerprint: Uint8Array.from(input.targetPublicFingerprint),
    targetSigningPublicKeyDigest: Uint8Array.from(
      input.targetSigningPublicKeyDigest,
    ),
    targetEncryptionPublicKeyDigest: Uint8Array.from(
      input.targetEncryptionPublicKeyDigest,
    ),
    expectedCustodyRevision: input.expectedCustodyRevision,
    expectedRecoveryGeneration: input.expectedRecoveryGeneration,
    expectedInventoryRevision: inventory.revision,
    expectedInventoryCount: inventory.count,
    expectedInventoryDigest: inventory.digest,
    domains,
    issuedAt: input.issuedAt,
  });
}

function u32(value: number): Uint8Array {
  if (!Number.isInteger(value) || value < 0 || value > 0xffff_ffff) {
    throw new RangeError("Device revocation counter is outside uint32");
  }
  const output = new Uint8Array(4);
  new DataView(output.buffer).setUint32(0, value);
  return output;
}

function u64(value: number): Uint8Array {
  safeCounter("Device revocation encoded counter", value);
  const output = new Uint8Array(8);
  new DataView(output.buffer).setBigUint64(0, BigInt(value));
  return output;
}

function frame(value: Uint8Array): Uint8Array {
  const output = new Uint8Array(4 + value.length);
  output.set(u32(value.length));
  output.set(value, 4);
  return output;
}

function text(value: string): Uint8Array {
  return frame(textEncoder.encode(value));
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const output = new Uint8Array(
    parts.reduce((length, part) => length + part.length, 0),
  );
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.length;
  }
  return output;
}

function optionalCounter(value: number | null): Uint8Array {
  return value === null ? u32(0) : concat([u32(1), u64(value)]);
}

function optionalHash(value: Uint8Array | null): Uint8Array {
  return value === null ? u32(0) : concat([u32(1), frame(value)]);
}

function encodeNamespace(item: DeviceRevocationNamespaceHead): Uint8Array {
  return concat([
    text(item.namespaceId),
    u64(item.expectedAccessRevision),
    frame(item.expectedBindingHash),
  ]);
}

function encodeDomain(item: DeviceRevocationDomainHead): Uint8Array {
  return concat([
    text(item.domainId),
    u64(item.expectedEpoch),
    u64(item.expectedAuthorizationRevision),
    frame(item.expectedParticipantDigest),
    u32(item.namespaces.length),
    ...item.namespaces.map(encodeNamespace),
  ]);
}

export function deviceRevocationManifestSigningBytes(
  manifest: DeviceRevocationManifestUnsigned,
): Uint8Array {
  const canonical = canonicalUnsigned(manifest);
  return concat([
    text("nautilo/lattice-bridge/device-revocation-manifest/v1"),
    u32(canonical.formatVersion),
    text(canonical.operationId),
    text(canonical.idempotencyKey),
    text(canonical.humanId),
    text(canonical.issuerDeviceId),
    text(canonical.targetDeviceId),
    u64(canonical.expectedIssuerDeviceRevision),
    u64(canonical.expectedTargetDeviceRevision),
    frame(canonical.targetPublicFingerprint),
    frame(canonical.targetSigningPublicKeyDigest),
    frame(canonical.targetEncryptionPublicKeyDigest),
    u64(canonical.expectedCustodyRevision),
    u64(canonical.expectedRecoveryGeneration),
    optionalCounter(canonical.expectedInventoryRevision),
    optionalCounter(canonical.expectedInventoryCount),
    optionalHash(canonical.expectedInventoryDigest),
    u32(canonical.domains.length),
    ...canonical.domains.map(encodeDomain),
    u64(canonical.issuedAt),
  ]);
}

export function createDeviceRevocationManifest(input: {
  readonly crypto: Pick<LatticeCrypto, "sign">;
  readonly manifest: DeviceRevocationManifestUnsigned;
  readonly issuerSigningPrivateKey: Uint8Array;
}): DeviceRevocationManifest {
  exactBytes(
    "Device revocation issuer signing private key",
    input.issuerSigningPrivateKey,
    32,
  );
  const manifest = canonicalUnsigned(input.manifest);
  const signature = input.crypto.sign(
    input.issuerSigningPrivateKey,
    deviceRevocationManifestSigningBytes(manifest),
  );
  exactBytes("Device revocation signature", signature, 64);
  return Object.freeze({
    ...manifest,
    signature: Uint8Array.from(signature),
  });
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index++) {
    difference |= left[index]! ^ right[index]!;
  }
  return difference === 0;
}

function assertRegistryDevice(
  label: string,
  value: DeviceRevocationRegistryDevice | null,
): asserts value is DeviceRevocationRegistryDevice {
  if (
    value === null
    || typeof value !== "object"
    || (value.state !== "pending"
      && value.state !== "active"
      && value.state !== "revoked"
      && value.state !== "rejected")
  ) {
    throw new Error(`Device revocation ${label} is not registered`);
  }
  humanId(value.humanId);
  safeCounter(`Device revocation ${label} revision`, value.revision);
  exactBytes(
    `Device revocation ${label} signing public key`,
    value.signingPublicKey,
    32,
  );
  exactBytes(
    `Device revocation ${label} encryption public key`,
    value.encryptionPublicKey,
    65,
  );
  exactBytes(
    `Device revocation ${label} public fingerprint`,
    value.publicFingerprint,
    32,
  );
}

export function verifyDeviceRevocationManifest(input: {
  readonly crypto: Pick<LatticeCrypto, "hash" | "verify">;
  readonly manifest: DeviceRevocationManifest;
  readonly resolveDevice: ResolveDeviceRevocationDevice;
}): VerifiedDeviceRevocationManifest {
  exactFields("Device revocation manifest", input.manifest, MANIFEST_FIELDS);
  exactBytes("Device revocation signature", input.manifest.signature, 64);
  if (typeof input.resolveDevice !== "function") {
    throw new TypeError("Device revocation registry resolver is required");
  }
  const unsigned: DeviceRevocationManifestUnsigned = {
    formatVersion: input.manifest.formatVersion,
    operationId: input.manifest.operationId,
    idempotencyKey: input.manifest.idempotencyKey,
    humanId: input.manifest.humanId,
    issuerDeviceId: input.manifest.issuerDeviceId,
    targetDeviceId: input.manifest.targetDeviceId,
    expectedIssuerDeviceRevision:
      input.manifest.expectedIssuerDeviceRevision,
    expectedTargetDeviceRevision:
      input.manifest.expectedTargetDeviceRevision,
    targetPublicFingerprint: input.manifest.targetPublicFingerprint,
    targetSigningPublicKeyDigest:
      input.manifest.targetSigningPublicKeyDigest,
    targetEncryptionPublicKeyDigest:
      input.manifest.targetEncryptionPublicKeyDigest,
    expectedCustodyRevision: input.manifest.expectedCustodyRevision,
    expectedRecoveryGeneration: input.manifest.expectedRecoveryGeneration,
    expectedInventoryRevision: input.manifest.expectedInventoryRevision,
    expectedInventoryCount: input.manifest.expectedInventoryCount,
    expectedInventoryDigest: input.manifest.expectedInventoryDigest,
    domains: input.manifest.domains,
    issuedAt: input.manifest.issuedAt,
  };
  const canonical = canonicalUnsigned(unsigned);
  const signingBytes = deviceRevocationManifestSigningBytes(canonical);
  const issuer = input.resolveDevice(canonical.issuerDeviceId);
  assertRegistryDevice("issuer", issuer);
  if (
    issuer.state !== "active"
    || issuer.humanId !== canonical.humanId
    || issuer.revision !== canonical.expectedIssuerDeviceRevision
    || !input.crypto.verify(
      issuer.signingPublicKey,
      signingBytes,
      input.manifest.signature,
    )
  ) {
    throw new Error(
      "Device revocation issuer is not an active same-Human authority",
    );
  }
  const target = input.resolveDevice(canonical.targetDeviceId);
  assertRegistryDevice("target", target);
  const signingDigest = input.crypto.hash(target.signingPublicKey);
  const encryptionDigest = input.crypto.hash(target.encryptionPublicKey);
  const fingerprint = input.crypto.hash(concat([
    target.signingPublicKey,
    target.encryptionPublicKey,
  ]));
  if (
    target.state !== "active"
    || target.humanId !== canonical.humanId
    || target.revision !== canonical.expectedTargetDeviceRevision
    || !equalBytes(
      target.publicFingerprint,
      canonical.targetPublicFingerprint,
    )
    || !equalBytes(fingerprint, canonical.targetPublicFingerprint)
    || !equalBytes(
      signingDigest,
      canonical.targetSigningPublicKeyDigest,
    )
    || !equalBytes(
      encryptionDigest,
      canonical.targetEncryptionPublicKeyDigest,
    )
  ) {
    throw new Error(
      "Device revocation target does not match its active registry record",
    );
  }
  const signature = Uint8Array.from(input.manifest.signature);
  const manifest = Object.freeze({ ...canonical, signature });
  const namespaceCount = canonical.domains.reduce(
    (count, domain) => count + domain.namespaces.length,
    0,
  );
  return Object.freeze({
    manifest,
    domainCount: canonical.domains.length,
    namespaceCount,
    authorizationArtifactHash: input.crypto.hash(concat([
      signingBytes,
      frame(signature),
    ])),
  });
}
