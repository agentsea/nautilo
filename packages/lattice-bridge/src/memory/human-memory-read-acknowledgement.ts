import type { LatticeCrypto } from "@nautilo/lattice-crypto";
import {
  LATTICE_LIMITS,
} from "@nautilo/lattice-crypto";
import {
  HUMAN_HISTORY_READ_ACKNOWLEDGEMENT_MAX_TTL_MS_V1,
  MAX_HUMAN_HISTORY_READ_ACKNOWLEDGEMENT_WIRE_BYTES_V1,
} from "@nautilo/lattice-crypto/wire";

const DOMAIN = "nautilo/memory/human-read-acknowledgement/v1";
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const PORTABLE = /^[A-Za-z0-9][A-Za-z0-9._:@/-]*$/u;

export type HumanMemoryReadAcknowledgementV1 = Readonly<{
  formatVersion: 1;
  purpose: "memory.read_acknowledgement";
  observationToken: Uint8Array;
  policyRevision: number;
  subjectHumanId: string;
  readerDeviceId: string;
  readerDeviceSigningKeyGeneration: number;
  hostAuthorizationRevision: number;
  memoryId: string;
  cryptoObjectId: string;
  contentRevision: number;
  cryptoAccessRevision: number;
  outcome: "verified" | "failed" | "unavailable";
  reason: "none" | "integrity_failure" | "client_crypto_unavailable"
    | "current_read_authority_unavailable" | "retained_key_material_unavailable";
  issuedAt: number;
  deadlineAt: number;
  signature: Uint8Array;
}>;

export type HumanMemoryReadAcknowledgementUnsignedV1 = Omit<
  HumanMemoryReadAcknowledgementV1, "signature"
>;

function counter(value: unknown, minimum = 0): value is number {
  return Number.isSafeInteger(value) && Number(value) >= minimum;
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("");
}

function fromHex(value: unknown, bytes: number): Uint8Array {
  if (typeof value !== "string" || value.length !== bytes * 2
    || !/^[0-9a-f]+$/u.test(value)) throw new TypeError("Memory read acknowledgement bytes are invalid");
  return Uint8Array.from({ length: bytes }, (_, index) =>
    Number.parseInt(value.slice(index * 2, index * 2 + 2), 16));
}

function assertUnsigned(value: HumanMemoryReadAcknowledgementUnsignedV1): void {
  if (value.formatVersion !== 1 || value.purpose !== "memory.read_acknowledgement"
    || !(value.observationToken instanceof Uint8Array)
    || value.observationToken.length !== 32
    || !counter(value.policyRevision, 1)
    || !PORTABLE.test(value.subjectHumanId)
    || encoder.encode(value.subjectHumanId).length > LATTICE_LIMITS.idBytes
    || !PORTABLE.test(value.readerDeviceId)
    || encoder.encode(value.readerDeviceId).length > LATTICE_LIMITS.idBytes
    || !counter(value.readerDeviceSigningKeyGeneration, 1)
    || !counter(value.hostAuthorizationRevision)
    || !UUID.test(value.memoryId) || !PORTABLE.test(value.cryptoObjectId)
    || encoder.encode(value.cryptoObjectId).length > LATTICE_LIMITS.idBytes
    || !counter(value.contentRevision, 1) || !counter(value.cryptoAccessRevision)
    || !((value.outcome === "verified" && value.reason === "none")
      || (value.outcome === "failed" && value.reason === "integrity_failure")
      || (value.outcome === "unavailable" && [
        "client_crypto_unavailable", "current_read_authority_unavailable",
        "retained_key_material_unavailable",
      ].includes(value.reason)))
    || !counter(value.issuedAt) || !counter(value.deadlineAt)
    || value.deadlineAt <= value.issuedAt
    || value.deadlineAt - value.issuedAt
      > HUMAN_HISTORY_READ_ACKNOWLEDGEMENT_MAX_TTL_MS_V1) {
    throw new TypeError("Memory read acknowledgement is invalid");
  }
}

function unsignedWire(value: HumanMemoryReadAcknowledgementUnsignedV1): readonly unknown[] {
  assertUnsigned(value);
  return [DOMAIN, value.formatVersion, value.purpose, hex(value.observationToken),
    value.policyRevision, value.subjectHumanId, value.readerDeviceId,
    value.readerDeviceSigningKeyGeneration, value.hostAuthorizationRevision,
    value.memoryId, value.cryptoObjectId, value.contentRevision,
    value.cryptoAccessRevision, value.outcome, value.reason, value.issuedAt,
    value.deadlineAt];
}

export function humanMemoryReadAcknowledgementSigningBytesV1(
  value: HumanMemoryReadAcknowledgementUnsignedV1,
): Uint8Array {
  return encoder.encode(JSON.stringify(unsignedWire(value)));
}

export function encodeHumanMemoryReadAcknowledgementV1(
  value: HumanMemoryReadAcknowledgementV1,
): Uint8Array {
  if (!(value.signature instanceof Uint8Array) || value.signature.length !== 64) {
    throw new TypeError("Memory read acknowledgement signature is invalid");
  }
  return encoder.encode(JSON.stringify([...unsignedWire(value), hex(value.signature)]));
}

export function decodeHumanMemoryReadAcknowledgementV1(
  bytes: Uint8Array,
): HumanMemoryReadAcknowledgementV1 {
  if (!(bytes instanceof Uint8Array)
    || bytes.length > MAX_HUMAN_HISTORY_READ_ACKNOWLEDGEMENT_WIRE_BYTES_V1) {
    throw new TypeError("Memory read acknowledgement wire is invalid");
  }
  const raw = JSON.parse(decoder.decode(bytes)) as unknown;
  if (!Array.isArray(raw) || raw.length !== 18 || raw[0] !== DOMAIN) {
    throw new TypeError("Memory read acknowledgement wire is invalid");
  }
  const fields = raw as readonly unknown[];
  const value = Object.freeze({ formatVersion: fields[1], purpose: fields[2],
    observationToken: fromHex(fields[3], 32), policyRevision: fields[4],
    subjectHumanId: fields[5], readerDeviceId: fields[6],
    readerDeviceSigningKeyGeneration: fields[7], hostAuthorizationRevision: fields[8],
    memoryId: fields[9], cryptoObjectId: fields[10], contentRevision: fields[11],
    cryptoAccessRevision: fields[12], outcome: fields[13], reason: fields[14],
    issuedAt: fields[15], deadlineAt: fields[16], signature: fromHex(fields[17], 64),
  }) as HumanMemoryReadAcknowledgementV1;
  assertUnsigned(value);
  const canonical = encodeHumanMemoryReadAcknowledgementV1(value);
  const same = canonical.length === bytes.length
    && canonical.every((byte, index) => byte === bytes[index]);
  canonical.fill(0);
  if (!same) throw new TypeError("Memory read acknowledgement is noncanonical");
  return value;
}

export function prepareHumanMemoryReadAcknowledgementV1(
  crypto: LatticeCrypto,
  input: HumanMemoryReadAcknowledgementUnsignedV1 & Readonly<{
    signingPrivateKey: Uint8Array;
    signingPublicKey: Uint8Array;
  }>,
): Uint8Array {
  const { signingPrivateKey, signingPublicKey, ...unsigned } = input;
  const signingBytes = humanMemoryReadAcknowledgementSigningBytesV1(unsigned);
  const signature = crypto.sign(signingPrivateKey, signingBytes);
  try {
    if (!crypto.verify(signingPublicKey, signingBytes, signature)) {
      throw new TypeError("Memory read acknowledgement signing keys disagree");
    }
    return encodeHumanMemoryReadAcknowledgementV1({ ...unsigned, signature });
  } finally {
    signingBytes.fill(0);
    signature.fill(0);
  }
}

export function verifyHumanMemoryReadAcknowledgementV1(
  crypto: LatticeCrypto,
  input: Readonly<{
    bytes: Uint8Array;
    now: number;
    resolveSigningPublicKey(value: HumanMemoryReadAcknowledgementV1): Uint8Array | null;
  }>,
): HumanMemoryReadAcknowledgementV1 {
  const value = decodeHumanMemoryReadAcknowledgementV1(input.bytes);
  if (input.now < value.issuedAt || input.now >= value.deadlineAt) {
    throw new TypeError("Memory read acknowledgement is expired");
  }
  const publicKey = input.resolveSigningPublicKey(value);
  const signingBytes = humanMemoryReadAcknowledgementSigningBytesV1(value);
  try {
    if (publicKey === null || !crypto.verify(publicKey, signingBytes, value.signature)) {
      throw new TypeError("Memory read acknowledgement signature is invalid");
    }
    return value;
  } finally {
    publicKey?.fill(0);
    signingBytes.fill(0);
  }
}
