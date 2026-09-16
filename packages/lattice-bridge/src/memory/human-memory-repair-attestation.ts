import { sha256 } from "@noble/hashes/sha2.js";
import {
  portableIdIsValid,
  type LatticeCrypto,
} from "@nautilo/lattice-crypto";
import {
  HUMAN_MEMORY_EXACT_ACCESS_REQUEST_MAX_ENTRIES_V2,
  HUMAN_MEMORY_EXACT_ACCESS_REQUEST_MAX_TTL_MS_V2,
  type MemoryNativeNamespaceAuthorityEntryV1,
} from
  "@nautilo/lattice-crypto/wire";

import { encodeMemoryPayloadV1, type MemoryPayloadV1 } from
  "./memory-payload-v1.ts";

const DOMAIN = "nautilo/memory/human-representation-repair/v1";
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
export const MAX_HUMAN_MEMORY_REPAIR_ATTESTATION_WIRE_BYTES_V1 = 256 * 1024;

export type HumanMemoryRepairDirectionV1 =
  | "ordinary_to_protected"
  | "protected_to_ordinary";

export interface HumanMemoryRepairNamespaceAuthorityV1 {
  readonly namespaceId: string;
  readonly namespaceAccessRevision: number;
  readonly namespaceKeyGeneration: number;
  readonly headDigest: Uint8Array;
  readonly publicationDigest: Uint8Array;
  readonly publicationSetDigest: Uint8Array;
  readonly audienceFingerprint: Uint8Array;
  readonly envelopeHash: Uint8Array;
}

export interface HumanMemoryRepairAttestationUnsignedV1 {
  readonly version: 1;
  readonly purpose: "human_memory_representation_repair";
  readonly direction: HumanMemoryRepairDirectionV1;
  readonly operationId: string;
  readonly policyRevision: number;
  readonly subjectHumanId: string;
  readonly deviceId: string;
  readonly deviceSigningKeyGeneration: number;
  readonly hostAuthorizationRevision: number;
  readonly memoryId: string;
  readonly expectedContentRevision: number;
  readonly targetContentRevision: number;
  readonly expectedCryptoAccessRevision: number;
  readonly cryptoObjectId: string;
  readonly requiredNamespaceFingerprint: Uint8Array;
  readonly currentAuthorityEntries:
    readonly MemoryNativeNamespaceAuthorityEntryV1[];
  readonly namespaces: readonly HumanMemoryRepairNamespaceAuthorityV1[];
  readonly payloadHash: Uint8Array;
  readonly accessManifestHash: Uint8Array;
  readonly authoredPayloadDigest: Uint8Array;
  readonly issuedAt: number;
  readonly deadlineAt: number;
}

export interface HumanMemoryRepairAttestationV1
  extends HumanMemoryRepairAttestationUnsignedV1 {
  readonly signature: Uint8Array;
}

const UNSIGNED_FIELDS = [
  "accessManifestHash", "authoredPayloadDigest", "cryptoObjectId", "deadlineAt",
  "deviceId", "deviceSigningKeyGeneration", "direction",
  "expectedContentRevision", "expectedCryptoAccessRevision",
  "currentAuthorityEntries", "hostAuthorizationRevision", "issuedAt",
  "memoryId", "namespaces",
  "operationId", "payloadHash", "policyRevision", "purpose",
  "requiredNamespaceFingerprint", "subjectHumanId", "targetContentRevision",
  "version",
] as const;
const NAMESPACE_FIELDS = [
  "audienceFingerprint", "envelopeHash", "headDigest", "namespaceAccessRevision",
  "namespaceId", "namespaceKeyGeneration", "publicationDigest",
  "publicationSetDigest",
] as const;
const CURRENT_AUTHORITY_FIELDS = [
  "audienceFingerprint", "headDigest", "keyGeneration",
  "namespaceAccessRevision", "namespaceId", "publicationDigest",
  "publicationSetDigest",
] as const;

function exactFields(value: object, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const canonical = [...expected].sort();
  return actual.length === canonical.length
    && actual.every((field, index) => field === canonical[index]);
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (value) => value.toString(16).padStart(2, "0"))
    .join("");
}

function validDigest(value: unknown): value is Uint8Array {
  return value instanceof Uint8Array && value.length === 32;
}

function validCounter(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

/** Strict structural validation before signature or product authority work. */
export function assertHumanMemoryRepairAttestationV1(
  value: HumanMemoryRepairAttestationV1,
): void {
  if (!exactFields(value, [...UNSIGNED_FIELDS, "signature"])
    || value.version !== 1
    || value.purpose !== "human_memory_representation_repair"
    || (value.direction !== "ordinary_to_protected"
      && value.direction !== "protected_to_ordinary")
    || !portableIdIsValid(value.operationId)
    || !portableIdIsValid(value.subjectHumanId)
    || !portableIdIsValid(value.deviceId)
    || !UUID.test(value.memoryId)
    || !portableIdIsValid(value.cryptoObjectId)
    || !validCounter(value.policyRevision) || value.policyRevision < 1
    || !validCounter(value.deviceSigningKeyGeneration)
    || value.deviceSigningKeyGeneration < 1
    || !validCounter(value.hostAuthorizationRevision)
    || !validCounter(value.expectedContentRevision)
    || !validCounter(value.targetContentRevision)
    || !validCounter(value.expectedCryptoAccessRevision)
    || (value.direction === "ordinary_to_protected"
      ? value.targetContentRevision < Math.max(1, value.expectedContentRevision)
      : value.targetContentRevision !== value.expectedContentRevision)
    || !validCounter(value.issuedAt) || !validCounter(value.deadlineAt)
    || value.deadlineAt <= value.issuedAt
    || value.deadlineAt - value.issuedAt
      > HUMAN_MEMORY_EXACT_ACCESS_REQUEST_MAX_TTL_MS_V2
    || !validDigest(value.requiredNamespaceFingerprint)
    || !validDigest(value.payloadHash)
    || !validDigest(value.accessManifestHash)
    || !validDigest(value.authoredPayloadDigest)
    || !(value.signature instanceof Uint8Array) || value.signature.length !== 64
    || value.namespaces.length < 1
    || value.namespaces.length
      > HUMAN_MEMORY_EXACT_ACCESS_REQUEST_MAX_ENTRIES_V2
    || value.currentAuthorityEntries.length !== value.namespaces.length
    || value.currentAuthorityEntries.some((entry, index) =>
      !exactFields(entry, CURRENT_AUTHORITY_FIELDS)
      || !UUID.test(entry.namespaceId)
      || !validCounter(entry.namespaceAccessRevision)
      || !validCounter(entry.keyGeneration)
      || !validDigest(entry.headDigest)
      || !validDigest(entry.publicationDigest)
      || !validDigest(entry.publicationSetDigest)
      || !validDigest(entry.audienceFingerprint)
      || entry.namespaceId !== value.namespaces[index]?.namespaceId
    )
    || value.namespaces.some((entry, index) =>
      !exactFields(entry, NAMESPACE_FIELDS)
      || !UUID.test(entry.namespaceId)
      || !validCounter(entry.namespaceAccessRevision)
      || !validCounter(entry.namespaceKeyGeneration)
      || !validDigest(entry.headDigest)
      || !validDigest(entry.publicationDigest)
      || !validDigest(entry.publicationSetDigest)
      || !validDigest(entry.audienceFingerprint)
      || !validDigest(entry.envelopeHash)
      || (index > 0
        && value.namespaces[index - 1]!.namespaceId >= entry.namespaceId)
    )) throw new TypeError("Human Memory repair attestation is invalid");
}

function fromHex(value: unknown, length: number): Uint8Array {
  if (typeof value !== "string" || value.length !== length * 2
    || !/^[0-9a-f]+$/u.test(value)) {
    throw new TypeError("Human Memory repair wire digest is invalid");
  }
  return Uint8Array.from({ length }, (_, index) =>
    Number.parseInt(value.slice(index * 2, index * 2 + 2), 16));
}

function wireValue(value: HumanMemoryRepairAttestationV1): readonly unknown[] {
  return [
    DOMAIN, value.version, value.purpose, value.direction, value.operationId,
    value.policyRevision, value.subjectHumanId, value.deviceId,
    value.deviceSigningKeyGeneration, value.hostAuthorizationRevision,
    value.memoryId, value.expectedContentRevision, value.targetContentRevision,
    value.expectedCryptoAccessRevision, value.cryptoObjectId,
    hex(value.requiredNamespaceFingerprint),
    value.currentAuthorityEntries.map((entry) => [entry.namespaceId,
      entry.namespaceAccessRevision, entry.keyGeneration,
      hex(entry.headDigest), hex(entry.publicationDigest),
      hex(entry.publicationSetDigest), hex(entry.audienceFingerprint)]),
    value.namespaces.map((entry) => [entry.namespaceId,
      entry.namespaceAccessRevision, entry.namespaceKeyGeneration,
      hex(entry.headDigest), hex(entry.publicationDigest),
      hex(entry.publicationSetDigest), hex(entry.audienceFingerprint),
      hex(entry.envelopeHash)]),
    hex(value.payloadHash), hex(value.accessManifestHash),
    hex(value.authoredPayloadDigest), value.issuedAt, value.deadlineAt,
    hex(value.signature),
  ];
}

/** Canonical browser-safe transport encoding for the signed attestation. */
export function encodeHumanMemoryRepairAttestationV1(
  value: HumanMemoryRepairAttestationV1,
): Uint8Array {
  assertHumanMemoryRepairAttestationV1(value);
  const bytes = encoder.encode(JSON.stringify(wireValue(value)));
  if (bytes.length > MAX_HUMAN_MEMORY_REPAIR_ATTESTATION_WIRE_BYTES_V1) {
    bytes.fill(0);
    throw new RangeError("Human Memory repair attestation exceeds its wire limit");
  }
  return bytes;
}

/** Strict decoder rejects unknown fields, noncanonical encodings, and oversized input. */
export function decodeHumanMemoryRepairAttestationV1(
  bytes: Uint8Array,
): HumanMemoryRepairAttestationV1 {
  if (!(bytes instanceof Uint8Array)) {
    throw new TypeError("Human Memory repair attestation bytes must be Uint8Array");
  }
  if (bytes.length > MAX_HUMAN_MEMORY_REPAIR_ATTESTATION_WIRE_BYTES_V1) {
    throw new RangeError("Human Memory repair attestation exceeds its wire limit");
  }
  const raw: unknown = JSON.parse(decoder.decode(bytes));
  if (!Array.isArray(raw) || raw.length !== 24 || raw[0] !== DOMAIN
    || !Array.isArray(raw[16]) || !Array.isArray(raw[17])
    || raw[16].length < 1
    || raw[16].length > HUMAN_MEMORY_EXACT_ACCESS_REQUEST_MAX_ENTRIES_V2
    || raw[17].length !== raw[16].length) {
    throw new TypeError("Human Memory repair attestation wire is invalid");
  }
  const currentAuthorityEntries = raw[16].map((entry: unknown) => {
    if (!Array.isArray(entry) || entry.length !== 7) {
      throw new TypeError("Human Memory repair current authority wire is invalid");
    }
    return Object.freeze({
      namespaceId: entry[0] as MemoryNativeNamespaceAuthorityEntryV1["namespaceId"],
      namespaceAccessRevision: entry[1] as number,
      keyGeneration: entry[2] as number,
      headDigest: fromHex(entry[3], 32),
      publicationDigest: fromHex(entry[4], 32),
      publicationSetDigest: fromHex(entry[5], 32),
      audienceFingerprint: fromHex(entry[6], 32),
    });
  });
  const namespaces = raw[17].map((entry: unknown) => {
    if (!Array.isArray(entry) || entry.length !== 8) {
      throw new TypeError("Human Memory repair Namespace wire is invalid");
    }
    return Object.freeze({
      namespaceId: entry[0] as string,
      namespaceAccessRevision: entry[1] as number,
      namespaceKeyGeneration: entry[2] as number,
      headDigest: fromHex(entry[3], 32),
      publicationDigest: fromHex(entry[4], 32),
      publicationSetDigest: fromHex(entry[5], 32),
      audienceFingerprint: fromHex(entry[6], 32),
      envelopeHash: fromHex(entry[7], 32),
    });
  });
  const value: HumanMemoryRepairAttestationV1 = Object.freeze({
    version: raw[1] as 1,
    purpose: raw[2] as "human_memory_representation_repair",
    direction: raw[3] as HumanMemoryRepairDirectionV1,
    operationId: raw[4] as string,
    policyRevision: raw[5] as number,
    subjectHumanId: raw[6] as string,
    deviceId: raw[7] as string,
    deviceSigningKeyGeneration: raw[8] as number,
    hostAuthorizationRevision: raw[9] as number,
    memoryId: raw[10] as string,
    expectedContentRevision: raw[11] as number,
    targetContentRevision: raw[12] as number,
    expectedCryptoAccessRevision: raw[13] as number,
    cryptoObjectId: raw[14] as string,
    requiredNamespaceFingerprint: fromHex(raw[15], 32),
    currentAuthorityEntries,
    namespaces,
    payloadHash: fromHex(raw[18], 32),
    accessManifestHash: fromHex(raw[19], 32),
    authoredPayloadDigest: fromHex(raw[20], 32),
    issuedAt: raw[21] as number,
    deadlineAt: raw[22] as number,
    signature: fromHex(raw[23], 64),
  });
  assertHumanMemoryRepairAttestationV1(value);
  const canonical = encodeHumanMemoryRepairAttestationV1(value);
  try {
    if (canonical.length !== bytes.length
      || canonical.some((byte, index) => byte !== bytes[index])) {
      throw new TypeError("Human Memory repair attestation wire is noncanonical");
    }
  } finally {
    canonical.fill(0);
  }
  return value;
}

export function humanMemoryRepairPayloadDigestV1(
  payload: MemoryPayloadV1,
): Uint8Array {
  const bytes = encodeMemoryPayloadV1(payload);
  try {
    return sha256(bytes);
  } finally {
    bytes.fill(0);
  }
}

export function humanMemoryRepairAttestationSigningDigestV1(
  value: HumanMemoryRepairAttestationUnsignedV1,
): Uint8Array {
  const candidate = { ...value, signature: new Uint8Array(64) };
  assertHumanMemoryRepairAttestationV1(candidate);
  return sha256(encoder.encode(JSON.stringify([
    DOMAIN, value.version, value.purpose, value.direction, value.operationId,
    value.policyRevision, value.subjectHumanId, value.deviceId,
    value.deviceSigningKeyGeneration, value.hostAuthorizationRevision,
    value.memoryId, value.expectedContentRevision, value.targetContentRevision,
    value.expectedCryptoAccessRevision, value.cryptoObjectId,
    hex(value.requiredNamespaceFingerprint),
    value.currentAuthorityEntries.map((entry) => [entry.namespaceId,
      entry.namespaceAccessRevision, entry.keyGeneration,
      hex(entry.headDigest), hex(entry.publicationDigest),
      hex(entry.publicationSetDigest), hex(entry.audienceFingerprint)]),
    value.namespaces.map((entry) => [entry.namespaceId,
      entry.namespaceAccessRevision, entry.namespaceKeyGeneration,
      hex(entry.headDigest), hex(entry.publicationDigest),
      hex(entry.publicationSetDigest), hex(entry.audienceFingerprint),
      hex(entry.envelopeHash)]),
    hex(value.payloadHash), hex(value.accessManifestHash),
    hex(value.authoredPayloadDigest), value.issuedAt, value.deadlineAt,
  ])));
}

export function prepareHumanMemoryRepairAttestationV1(
  crypto: LatticeCrypto,
  input: HumanMemoryRepairAttestationUnsignedV1 & Readonly<{
    signingPrivateKey: Uint8Array;
    signingPublicKey: Uint8Array;
  }>,
): HumanMemoryRepairAttestationV1 {
  const { signingPrivateKey, signingPublicKey, ...unsigned } = input;
  const digest = humanMemoryRepairAttestationSigningDigestV1(unsigned);
  try {
    const signature = crypto.sign(signingPrivateKey, digest);
    if (!crypto.verify(signingPublicKey, digest, signature)) {
      signature.fill(0);
      throw new TypeError("Human Memory repair signing keys do not match");
    }
    const result = Object.freeze({ ...unsigned, signature });
    assertHumanMemoryRepairAttestationV1(result);
    return result;
  } finally {
    digest.fill(0);
  }
}
