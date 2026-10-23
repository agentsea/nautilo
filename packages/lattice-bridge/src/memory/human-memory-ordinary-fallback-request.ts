import { sha256 } from "@noble/hashes/sha2.js";
import {
  LATTICE_LIMITS,
  type LatticeCrypto,
} from "@nautilo/lattice-crypto";
import {
  assertMemoryEmbeddingDisclosureV2,
  encodeMemoryEmbeddingDisclosureV2,
  decodeMemoryEmbeddingDisclosureV2,
  type MemoryEmbeddingDisclosureV2,
  HUMAN_MEMORY_CONTENT_EMBEDDING_REQUEST_MAX_NAMESPACE_ENVELOPES_V2,
  HUMAN_MEMORY_CONTENT_EMBEDDING_REQUEST_MAX_TTL_MS_V2,
  MAX_HUMAN_MEMORY_CONTENT_EMBEDDING_REQUEST_WIRE_BYTES_V2,
} from "@nautilo/lattice-crypto/wire";
import { encodeMemoryPayloadV1 } from "./memory-payload-v1.ts";

const DOMAIN = "nautilo/memory/human-ordinary-fallback/v1";
const DOMAIN_V2 = "nautilo/memory/human-ordinary-fallback/v2";
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

export interface HumanMemoryOrdinaryFallbackUnsignedRequestV2 extends Omit<
  HumanMemoryOrdinaryFallbackUnsignedRequestV1,
  "formatVersion" | "requestedProvider" | "requestedModel" | "dimensions" | "processorContractVersion"
> {
  readonly formatVersion: 2;
  readonly requestedEmbedding: MemoryEmbeddingDisclosureV2;
  readonly processorContractVersion: 2;
}
export interface HumanMemoryOrdinaryFallbackRequestV2 extends HumanMemoryOrdinaryFallbackUnsignedRequestV2 {
  readonly signature: Uint8Array;
}
export type AuthenticatedHumanMemoryOrdinaryFallbackRequestV2 = Readonly<{
  request: HumanMemoryOrdinaryFallbackRequestV2;
  requestDigest: Uint8Array;
}>;
type FallbackUnsigned = HumanMemoryOrdinaryFallbackUnsignedRequestV1 | HumanMemoryOrdinaryFallbackUnsignedRequestV2;
type FallbackRequest = HumanMemoryOrdinaryFallbackRequestV1 | HumanMemoryOrdinaryFallbackRequestV2;
type FallbackAuthenticated = AuthenticatedHumanMemoryOrdinaryFallbackRequestV1 | AuthenticatedHumanMemoryOrdinaryFallbackRequestV2;
type FallbackVersion = 1 | 2;

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

// Durable replay admission binds the exact canonical request digest, including
// its signing domain and format. Both versions share the same opaque authority.
export type HumanMemoryOrdinaryFallbackReplayAdmissionV2 = HumanMemoryOrdinaryFallbackReplayAdmissionV1;
export function createHumanMemoryOrdinaryFallbackReplayAdmissionV2(
  input: Readonly<{ operationId: string; memoryId: string; requestDigest: Uint8Array }>,
): HumanMemoryOrdinaryFallbackReplayAdmissionV2 {
  if (!(input.requestDigest instanceof Uint8Array)) {
    throw new TypeError("Human Memory ordinary fallback replay admission is invalid");
  }
  return createHumanMemoryOrdinaryFallbackReplayAdmissionV1(input);
}

const FIELDS_V2 = Object.freeze([
  "formatVersion", "purpose", "reason", "operationId", "memoryId",
  "expectedContentRevision", "nextContentRevision", "expectedCryptoAccessRevision",
  "requiredNamespaceIds", "type", "content", "requestedEmbedding", "processorContractVersion",
  "policyRevision", "subjectHumanId", "committerDeviceId", "committerDeviceSigningKeyGeneration",
  "hostAuthorizationRevision", "planIssuedAt", "planDeadlineAt", "issuedAt", "deadlineAt", "signature",
]);

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

function assertRequest(value: FallbackRequest, version: FallbackVersion): void {
  if (version === 2) {
    if (typeof value !== "object" || value === null || Array.isArray(value)
      || !FIELDS_V2.every((field) => Object.hasOwn(value, field))
      || Reflect.ownKeys(value).some((field) => typeof field !== "string" || (field !== "importance" && !FIELDS_V2.includes(field)))) {
      throw new TypeError("Human Memory ordinary fallback request has an invalid field set");
    }
    assertMemoryEmbeddingDisclosureV2((value as HumanMemoryOrdinaryFallbackRequestV2).requestedEmbedding);
  }
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
  if (value.formatVersion !== version
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
    || (value.formatVersion === 1 && ((value.requestedProvider !== "openai" && value.requestedProvider !== "openrouter" && value.requestedProvider !== "venice")
      || !validPortable(value.requestedModel) || value.dimensions !== 1536))
    || value.processorContractVersion !== version
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

function wire(value: FallbackRequest): readonly unknown[] {
  return [value.formatVersion === 1 ? DOMAIN : DOMAIN_V2, value.formatVersion, value.purpose, value.reason,
    value.operationId, value.memoryId, value.expectedContentRevision,
    value.nextContentRevision, value.expectedCryptoAccessRevision,
    value.requiredNamespaceIds, value.type, value.content,
    value.importance ?? null,
    ...(value.formatVersion === 1 ? [value.requestedProvider, value.requestedModel, value.dimensions]
      : [decodeMemoryEmbeddingDisclosureV2(encodeMemoryEmbeddingDisclosureV2(value.requestedEmbedding))]),
    value.processorContractVersion, value.policyRevision,
    value.subjectHumanId, value.committerDeviceId,
    value.committerDeviceSigningKeyGeneration, value.hostAuthorizationRevision,
    value.planIssuedAt, value.planDeadlineAt, value.issuedAt, value.deadlineAt,
    hex(value.signature)];
}

function signingBytes(value: FallbackUnsigned): Uint8Array {
  return encoder.encode(JSON.stringify(wire({ ...value, signature: new Uint8Array(64) })
    .slice(0, -1)));
}

function encodeHumanMemoryOrdinaryFallbackRequestForVersion(
  value: FallbackRequest,
  version: FallbackVersion,
): Uint8Array {
  assertRequest(value, version);
  const bytes = encoder.encode(JSON.stringify(wire(value)));
  if (bytes.length > MAX_HUMAN_MEMORY_CONTENT_EMBEDDING_REQUEST_WIRE_BYTES_V2) {
    bytes.fill(0);
    throw new RangeError("Human Memory ordinary fallback request exceeds its wire limit");
  }
  return bytes;
}

function decodeHumanMemoryOrdinaryFallbackRequestForVersion(
  bytes: Uint8Array,
  version: FallbackVersion,
): FallbackRequest {
  if (!(bytes instanceof Uint8Array)
    || bytes.length === 0
    || bytes.length > MAX_HUMAN_MEMORY_CONTENT_EMBEDDING_REQUEST_WIRE_BYTES_V2) {
    throw new TypeError("Human Memory ordinary fallback wire is invalid");
  }
  const raw: unknown = JSON.parse(decoder.decode(bytes));
  const length = version === 1 ? 27 : 25;
  if (!Array.isArray(raw) || raw.length !== length || raw[0] !== (version === 1 ? DOMAIN : DOMAIN_V2)
    || !Array.isArray(raw[9]) || typeof raw[length - 1] !== "string") {
    throw new TypeError("Human Memory ordinary fallback wire is invalid");
  }
  const fields = raw as readonly unknown[];
  const offset = version === 1 ? 0 : -2;
  const value = {
    formatVersion: fields[1], purpose: fields[2], reason: fields[3],
    operationId: fields[4], memoryId: fields[5],
    expectedContentRevision: fields[6], nextContentRevision: fields[7],
    expectedCryptoAccessRevision: fields[8], requiredNamespaceIds: fields[9],
    type: fields[10], content: fields[11],
    ...(fields[12] === null ? {} : { importance: fields[12] }),
    ...(version === 1 ? { requestedProvider: fields[13], requestedModel: fields[14], dimensions: fields[15] }
      : { requestedEmbedding: fields[13] }),
    processorContractVersion: fields[16 + offset],
    policyRevision: fields[17 + offset], subjectHumanId: fields[18 + offset],
    committerDeviceId: fields[19 + offset],
    committerDeviceSigningKeyGeneration: fields[20 + offset],
    hostAuthorizationRevision: fields[21 + offset], planIssuedAt: fields[22 + offset],
    planDeadlineAt: fields[23 + offset], issuedAt: fields[24 + offset], deadlineAt: fields[25 + offset],
    signature: fromHex(fields[26 + offset] as string, 64),
  } as FallbackRequest;
  assertRequest(value, version);
  const canonical = encodeHumanMemoryOrdinaryFallbackRequestForVersion(value, version);
  if (canonical.length !== bytes.length
    || canonical.some((entry, index) => entry !== bytes[index])) {
    throw new TypeError("Human Memory ordinary fallback wire is noncanonical");
  }
  return Object.freeze({ ...value,
    ...(value.formatVersion === 2 ? { requestedEmbedding: decodeMemoryEmbeddingDisclosureV2(encodeMemoryEmbeddingDisclosureV2(value.requestedEmbedding)) } : {}),
    requiredNamespaceIds: Object.freeze([...value.requiredNamespaceIds]),
    signature: value.signature.slice() });
}

function digestHumanMemoryOrdinaryFallbackRequestForVersion(
  bytes: Uint8Array,
  version: FallbackVersion,
): Uint8Array {
  decodeHumanMemoryOrdinaryFallbackRequestForVersion(bytes, version);
  return sha256(bytes);
}

function prepareHumanMemoryOrdinaryFallbackRequestForVersion(
  crypto: LatticeCrypto,
  input: FallbackUnsigned & Readonly<{
    signingPrivateKey: Uint8Array;
  }>,
  version: FallbackVersion,
): Readonly<{ request: FallbackRequest; bytes: Uint8Array }> {
  const { signingPrivateKey, ...unsigned } = input;
  if (version === 2) {
    if (Object.hasOwn(unsigned, "signature")) throw new TypeError("Human Memory ordinary fallback preparation has an invalid field set");
    assertRequest({ ...unsigned, signature: new Uint8Array(64) }, version);
  }
  const signed = signingBytes(unsigned);
  try {
    const request = Object.freeze({ ...unsigned,
      requiredNamespaceIds: Object.freeze([...unsigned.requiredNamespaceIds]),
      signature: crypto.sign(signingPrivateKey, signed) });
    const bytes = encodeHumanMemoryOrdinaryFallbackRequestForVersion(request, version);
    return Object.freeze({ request: version === 1 ? request : decodeHumanMemoryOrdinaryFallbackRequestForVersion(bytes, version), bytes });
  } finally { signed.fill(0); }
}

function verifyHumanMemoryOrdinaryFallbackRequestForVersion(
  crypto: LatticeCrypto,
  input: Readonly<{
    requestBytes: Uint8Array;
    signingPublicKey: Uint8Array;
    now: number;
    replayAdmission?: HumanMemoryOrdinaryFallbackReplayAdmissionV1;
  }>,
  version: FallbackVersion,
): FallbackAuthenticated {
  const request = decodeHumanMemoryOrdinaryFallbackRequestForVersion(input.requestBytes, version);
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
    return Object.freeze({ request, requestDigest }) as FallbackAuthenticated;
  } finally { signed.fill(0); }
}

export function encodeHumanMemoryOrdinaryFallbackRequestV1(value: HumanMemoryOrdinaryFallbackRequestV1): Uint8Array {
  return encodeHumanMemoryOrdinaryFallbackRequestForVersion(value, 1);
}
export function decodeHumanMemoryOrdinaryFallbackRequestV1(bytes: Uint8Array): HumanMemoryOrdinaryFallbackRequestV1 {
  return decodeHumanMemoryOrdinaryFallbackRequestForVersion(bytes, 1) as HumanMemoryOrdinaryFallbackRequestV1;
}
export function digestHumanMemoryOrdinaryFallbackRequestV1(bytes: Uint8Array): Uint8Array {
  return digestHumanMemoryOrdinaryFallbackRequestForVersion(bytes, 1);
}
export function prepareHumanMemoryOrdinaryFallbackRequestV1(crypto: LatticeCrypto, input: HumanMemoryOrdinaryFallbackUnsignedRequestV1 & Readonly<{
  signingPrivateKey: Uint8Array;
}>): Readonly<{ request: HumanMemoryOrdinaryFallbackRequestV1; bytes: Uint8Array }> {
  return prepareHumanMemoryOrdinaryFallbackRequestForVersion(crypto, input, 1) as Readonly<{ request: HumanMemoryOrdinaryFallbackRequestV1; bytes: Uint8Array }>;
}
export function verifyHumanMemoryOrdinaryFallbackRequestV1(crypto: LatticeCrypto, input: Readonly<{
  requestBytes: Uint8Array; signingPublicKey: Uint8Array; now: number;
  replayAdmission?: HumanMemoryOrdinaryFallbackReplayAdmissionV1;
}>): AuthenticatedHumanMemoryOrdinaryFallbackRequestV1 {
  return verifyHumanMemoryOrdinaryFallbackRequestForVersion(crypto, input, 1) as AuthenticatedHumanMemoryOrdinaryFallbackRequestV1;
}

export function encodeHumanMemoryOrdinaryFallbackRequestV2(value: HumanMemoryOrdinaryFallbackRequestV2): Uint8Array {
  return encodeHumanMemoryOrdinaryFallbackRequestForVersion(value, 2);
}
export function decodeHumanMemoryOrdinaryFallbackRequestV2(bytes: Uint8Array): HumanMemoryOrdinaryFallbackRequestV2 {
  return decodeHumanMemoryOrdinaryFallbackRequestForVersion(bytes, 2) as HumanMemoryOrdinaryFallbackRequestV2;
}
export function digestHumanMemoryOrdinaryFallbackRequestV2(bytes: Uint8Array): Uint8Array {
  return digestHumanMemoryOrdinaryFallbackRequestForVersion(bytes, 2);
}
export function prepareHumanMemoryOrdinaryFallbackRequestV2(crypto: LatticeCrypto, input: HumanMemoryOrdinaryFallbackUnsignedRequestV2 & Readonly<{
  signingPrivateKey: Uint8Array;
}>): Readonly<{ request: HumanMemoryOrdinaryFallbackRequestV2; bytes: Uint8Array }> {
  return prepareHumanMemoryOrdinaryFallbackRequestForVersion(crypto, input, 2) as Readonly<{ request: HumanMemoryOrdinaryFallbackRequestV2; bytes: Uint8Array }>;
}
export function verifyHumanMemoryOrdinaryFallbackRequestV2(crypto: LatticeCrypto, input: Readonly<{
  requestBytes: Uint8Array; signingPublicKey: Uint8Array; now: number;
  replayAdmission?: HumanMemoryOrdinaryFallbackReplayAdmissionV2;
}>): AuthenticatedHumanMemoryOrdinaryFallbackRequestV2 {
  return verifyHumanMemoryOrdinaryFallbackRequestForVersion(crypto, input, 2) as AuthenticatedHumanMemoryOrdinaryFallbackRequestV2;
}
