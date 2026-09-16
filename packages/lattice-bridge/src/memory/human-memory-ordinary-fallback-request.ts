import { sha256 } from "@noble/hashes/sha2.js";
import {
  LATTICE_LIMITS,
  type LatticeCrypto,
} from "@nautilo/lattice-crypto";
import {
  HUMAN_MEMORY_CONTENT_EMBEDDING_REQUEST_MAX_NAMESPACE_ENVELOPES_V2,
  HUMAN_MEMORY_CONTENT_EMBEDDING_REQUEST_MAX_TTL_MS_V2,
  MAX_HUMAN_MEMORY_CONTENT_EMBEDDING_REQUEST_WIRE_BYTES_V2,
} from "@nautilo/lattice-crypto/wire";
import { encodeMemoryPayloadV1 } from "./memory-payload-v1.ts";

const DOMAIN = "nautilo/memory/human-ordinary-fallback/v1";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const PORTABLE = /^[A-Za-z0-9][A-Za-z0-9._:@/-]*$/u;
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

export interface HumanMemoryOrdinaryFallbackUnsignedRequestV1 {
  readonly formatVersion: 1;
  readonly purpose:
    | "memory.ordinary_fallback.create"
    | "memory.ordinary_fallback.update";
  readonly reason: "target_encryption_not_ready";
  readonly operationId: string;
  readonly memoryId: string;
  readonly expectedContentRevision: number;
  readonly nextContentRevision: number;
  readonly expectedCryptoAccessRevision: number;
  readonly requiredNamespaceIds: readonly string[];
  readonly type: string;
  readonly content: string;
  readonly importance?: number;
  readonly requestedProvider: "openai" | "openrouter" | "venice";
  readonly requestedModel: string;
  readonly dimensions: 1536;
  readonly processorContractVersion: 1;
  readonly policyRevision: number;
  readonly subjectHumanId: string;
  readonly committerDeviceId: string;
  readonly committerDeviceSigningKeyGeneration: number;
  readonly hostAuthorizationRevision: number;
  readonly planIssuedAt: number | null;
  readonly planDeadlineAt: number | null;
  readonly issuedAt: number;
  readonly deadlineAt: number;
}

export interface HumanMemoryOrdinaryFallbackRequestV1
  extends HumanMemoryOrdinaryFallbackUnsignedRequestV1 {
  readonly signature: Uint8Array;
}

export type AuthenticatedHumanMemoryOrdinaryFallbackRequestV1 = Readonly<{
  request: HumanMemoryOrdinaryFallbackRequestV1;
  requestDigest: Uint8Array;
}>;

declare const replayAdmissionBrand: unique symbol;
export type HumanMemoryOrdinaryFallbackReplayAdmissionV1 = Readonly<{
  [replayAdmissionBrand]: true;
}>;
const replayAdmissions = new WeakMap<object, Readonly<{
  operationId: string;
  memoryId: string;
  requestDigest: Uint8Array;
}>>();

export function createHumanMemoryOrdinaryFallbackReplayAdmissionV1(
  input: Readonly<{ operationId: string; memoryId: string; requestDigest: Uint8Array }>,
): HumanMemoryOrdinaryFallbackReplayAdmissionV1 {
  if (!validPortable(input.operationId) || !validUuid(input.memoryId)
    || input.requestDigest.length !== 32) {
    throw new TypeError("Human Memory ordinary fallback replay admission is invalid");
  }
  const token = Object.freeze({}) as HumanMemoryOrdinaryFallbackReplayAdmissionV1;
  replayAdmissions.set(token, Object.freeze({ ...input,
    requestDigest: input.requestDigest.slice() }));
  return token;
}

function validCounter(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function validPortable(value: unknown): value is string {
  return typeof value === "string"
    && PORTABLE.test(value)
    && encoder.encode(value).length <= LATTICE_LIMITS.idBytes;
}

function validUuid(value: unknown): value is string {
  return typeof value === "string" && UUID.test(value);
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("");
}

function fromHex(value: string, length: number): Uint8Array {
  if (value.length !== length * 2 || !/^[0-9a-f]+$/u.test(value)) {
    throw new TypeError("Human Memory ordinary fallback signature is invalid");
  }
  return Uint8Array.from({ length }, (_, index) =>
    Number.parseInt(value.slice(index * 2, index * 2 + 2), 16));
}

function assertRequest(value: HumanMemoryOrdinaryFallbackRequestV1): void {
  const create = value.purpose === "memory.ordinary_fallback.create";
  let authoredPayload: Uint8Array;
  try {
    authoredPayload = encodeMemoryPayloadV1({
      formatVersion: 1,
      type: value.type,
      content: value.content,
    });
  } catch {
    throw new TypeError("Human Memory ordinary fallback authored payload is invalid");
  }
  authoredPayload.fill(0);
  if (value.formatVersion !== 1
    || (!create && value.purpose !== "memory.ordinary_fallback.update")
    || value.reason !== "target_encryption_not_ready"
    || !validPortable(value.operationId) || !validUuid(value.memoryId)
    || !validCounter(value.expectedContentRevision)
    || !validCounter(value.nextContentRevision)
    || value.nextContentRevision !== value.expectedContentRevision + 1
    || !validCounter(value.expectedCryptoAccessRevision)
    || (create && value.expectedContentRevision !== 0)
    || (create && value.expectedCryptoAccessRevision !== 0)
    || value.requiredNamespaceIds.length < 1
    || value.requiredNamespaceIds.length
      > HUMAN_MEMORY_CONTENT_EMBEDDING_REQUEST_MAX_NAMESPACE_ENVELOPES_V2
    || value.requiredNamespaceIds.some((id, index) => !validUuid(id)
      || (index > 0 && value.requiredNamespaceIds[index - 1]! >= id))
    || (value.importance !== undefined && (!Number.isFinite(value.importance)
      || value.importance < 0 || value.importance > 1))
    || (value.requestedProvider !== "openai" && value.requestedProvider !== "openrouter" && value.requestedProvider !== "venice")
    || !validPortable(value.requestedModel)
    || value.dimensions !== 1536 || value.processorContractVersion !== 1
    || !validCounter(value.policyRevision) || value.policyRevision < 1
    || !validPortable(value.subjectHumanId) || !validPortable(value.committerDeviceId)
    || !validCounter(value.committerDeviceSigningKeyGeneration)
    || value.committerDeviceSigningKeyGeneration < 1
    || !validCounter(value.hostAuthorizationRevision)
    || !validCounter(value.issuedAt) || !validCounter(value.deadlineAt)
    || value.deadlineAt <= value.issuedAt
    || value.deadlineAt - value.issuedAt
      > HUMAN_MEMORY_CONTENT_EMBEDDING_REQUEST_MAX_TTL_MS_V2
    || (create
      ? !validCounter(value.planIssuedAt) || !validCounter(value.planDeadlineAt)
        || value.planDeadlineAt <= value.planIssuedAt
        || value.planDeadlineAt - value.planIssuedAt
          > HUMAN_MEMORY_CONTENT_EMBEDDING_REQUEST_MAX_TTL_MS_V2
        || value.issuedAt < value.planIssuedAt || value.deadlineAt > value.planDeadlineAt
      : value.planIssuedAt !== null || value.planDeadlineAt !== null)
    || !(value.signature instanceof Uint8Array) || value.signature.length !== 64) {
    throw new TypeError("Human Memory ordinary fallback request is invalid");
  }
}

function wire(value: HumanMemoryOrdinaryFallbackRequestV1): readonly unknown[] {
  return [DOMAIN, value.formatVersion, value.purpose, value.reason,
    value.operationId, value.memoryId, value.expectedContentRevision,
    value.nextContentRevision, value.expectedCryptoAccessRevision,
    value.requiredNamespaceIds, value.type, value.content,
    value.importance ?? null, value.requestedProvider, value.requestedModel,
    value.dimensions, value.processorContractVersion, value.policyRevision,
    value.subjectHumanId, value.committerDeviceId,
    value.committerDeviceSigningKeyGeneration, value.hostAuthorizationRevision,
    value.planIssuedAt, value.planDeadlineAt, value.issuedAt, value.deadlineAt,
    hex(value.signature)];
}

function signingBytes(value: HumanMemoryOrdinaryFallbackUnsignedRequestV1): Uint8Array {
  return encoder.encode(JSON.stringify(wire({ ...value, signature: new Uint8Array(64) })
    .slice(0, -1)));
}

export function encodeHumanMemoryOrdinaryFallbackRequestV1(
  value: HumanMemoryOrdinaryFallbackRequestV1,
): Uint8Array {
  assertRequest(value);
  const bytes = encoder.encode(JSON.stringify(wire(value)));
  if (bytes.length > MAX_HUMAN_MEMORY_CONTENT_EMBEDDING_REQUEST_WIRE_BYTES_V2) {
    bytes.fill(0);
    throw new RangeError("Human Memory ordinary fallback request exceeds its wire limit");
  }
  return bytes;
}

export function decodeHumanMemoryOrdinaryFallbackRequestV1(
  bytes: Uint8Array,
): HumanMemoryOrdinaryFallbackRequestV1 {
  if (!(bytes instanceof Uint8Array)
    || bytes.length === 0
    || bytes.length > MAX_HUMAN_MEMORY_CONTENT_EMBEDDING_REQUEST_WIRE_BYTES_V2) {
    throw new TypeError("Human Memory ordinary fallback wire is invalid");
  }
  const raw: unknown = JSON.parse(decoder.decode(bytes));
  if (!Array.isArray(raw) || raw.length !== 27 || raw[0] !== DOMAIN
    || !Array.isArray(raw[9]) || typeof raw[26] !== "string") {
    throw new TypeError("Human Memory ordinary fallback wire is invalid");
  }
  const fields = raw as readonly unknown[];
  const value = {
    formatVersion: fields[1], purpose: fields[2], reason: fields[3],
    operationId: fields[4], memoryId: fields[5],
    expectedContentRevision: fields[6], nextContentRevision: fields[7],
    expectedCryptoAccessRevision: fields[8], requiredNamespaceIds: fields[9],
    type: fields[10], content: fields[11],
    ...(fields[12] === null ? {} : { importance: fields[12] }),
    requestedProvider: fields[13], requestedModel: fields[14],
    dimensions: fields[15], processorContractVersion: fields[16],
    policyRevision: fields[17], subjectHumanId: fields[18],
    committerDeviceId: fields[19],
    committerDeviceSigningKeyGeneration: fields[20],
    hostAuthorizationRevision: fields[21], planIssuedAt: fields[22],
    planDeadlineAt: fields[23], issuedAt: fields[24], deadlineAt: fields[25],
    signature: fromHex(fields[26] as string, 64),
  } as HumanMemoryOrdinaryFallbackRequestV1;
  assertRequest(value);
  const canonical = encodeHumanMemoryOrdinaryFallbackRequestV1(value);
  if (canonical.length !== bytes.length
    || canonical.some((entry, index) => entry !== bytes[index])) {
    throw new TypeError("Human Memory ordinary fallback wire is noncanonical");
  }
  return Object.freeze({ ...value,
    requiredNamespaceIds: Object.freeze([...value.requiredNamespaceIds]),
    signature: value.signature.slice() });
}

export function digestHumanMemoryOrdinaryFallbackRequestV1(
  bytes: Uint8Array,
): Uint8Array {
  decodeHumanMemoryOrdinaryFallbackRequestV1(bytes);
  return sha256(bytes);
}

export function prepareHumanMemoryOrdinaryFallbackRequestV1(
  crypto: LatticeCrypto,
  input: HumanMemoryOrdinaryFallbackUnsignedRequestV1 & Readonly<{
    signingPrivateKey: Uint8Array;
  }>,
): Readonly<{ request: HumanMemoryOrdinaryFallbackRequestV1; bytes: Uint8Array }> {
  const { signingPrivateKey, ...unsigned } = input;
  const signed = signingBytes(unsigned);
  try {
    const request = Object.freeze({ ...unsigned,
      requiredNamespaceIds: Object.freeze([...unsigned.requiredNamespaceIds]),
      signature: crypto.sign(signingPrivateKey, signed) });
    return Object.freeze({ request, bytes: encodeHumanMemoryOrdinaryFallbackRequestV1(request) });
  } finally { signed.fill(0); }
}

export function verifyHumanMemoryOrdinaryFallbackRequestV1(
  crypto: LatticeCrypto,
  input: Readonly<{
    requestBytes: Uint8Array;
    signingPublicKey: Uint8Array;
    now: number;
    replayAdmission?: HumanMemoryOrdinaryFallbackReplayAdmissionV1;
  }>,
): AuthenticatedHumanMemoryOrdinaryFallbackRequestV1 {
  const request = decodeHumanMemoryOrdinaryFallbackRequestV1(input.requestBytes);
  const requestDigest = sha256(input.requestBytes);
  const replay = input.replayAdmission === undefined ? undefined
    : replayAdmissions.get(input.replayAdmission);
  const signed = signingBytes(request);
  try {
    if (input.replayAdmission !== undefined && (replay === undefined
      || replay.operationId !== request.operationId
      || replay.memoryId !== request.memoryId
      || replay.requestDigest.some((byte, index) => byte !== requestDigest[index]))) {
      throw new TypeError("Human Memory ordinary fallback replay admission disagrees");
    }
    if (!crypto.verify(input.signingPublicKey, signed, request.signature)) {
      throw new TypeError("Human Memory ordinary fallback signature is invalid");
    }
    const verificationTime = replay === undefined ? input.now : request.issuedAt;
    if (!validCounter(verificationTime) || verificationTime < request.issuedAt
      || verificationTime >= request.deadlineAt) {
      throw new TypeError("Human Memory ordinary fallback request is not currently valid");
    }
    return Object.freeze({ request, requestDigest });
  } finally { signed.fill(0); }
}
