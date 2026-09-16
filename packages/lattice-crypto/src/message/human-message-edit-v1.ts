import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";

import type { LatticeCrypto } from "../crypto/index.ts";
import {
  CanonicalDecodingError,
  concatV2,
  decodeExact,
  encodeU32,
  encodeU64,
  frame,
  frameText,
  utf8V2,
} from "../format/v2-primitives.ts";
import { V2_LIMITS } from "../v2-types/limits.ts";
import { LIVE_SHADOW_MESSAGE_REQUEST_MAX_TTL_MS_V4 } from "./live-shadow-message-request-v4.ts";

export const HUMAN_MESSAGE_EDIT_PLAN_FORMAT_VERSION_V1 = 1 as const;
export const HUMAN_MESSAGE_EDIT_PLAN_PURPOSE_V1 =
  "message.human_edit_plan" as const;
export const HUMAN_MESSAGE_EDIT_PLAN_DOMAIN_V1 =
  "nautilo/lattice-crypto/human-message-edit-plan/v1";
export const HUMAN_MESSAGE_EDIT_REQUEST_FORMAT_VERSION_V1 = 1 as const;
export const HUMAN_MESSAGE_EDIT_REQUEST_PURPOSE_V1 =
  "message.human_edit_publish" as const;
export const HUMAN_MESSAGE_EDIT_REQUEST_DOMAIN_V1 =
  "nautilo/lattice-crypto/human-message-edit-request/v1";
export const HUMAN_MESSAGE_EDIT_MAX_TTL_MS_V1 =
  LIVE_SHADOW_MESSAGE_REQUEST_MAX_TTL_MS_V4;
export const HUMAN_MESSAGE_EDIT_OBJECT_ID_DOMAIN_V1 =
  "nautilo/lattice-crypto/human-message-edit-object-id/v1";

const HASH_BYTES = 32;
const SIGNATURE_BYTES = V2_LIMITS.signatureBytes;
const UUID_BYTES = 36;
const PURPOSE_BYTES = 64;
const HUMAN_MESSAGE_EDIT_OPERATION_PREFIX_V1 = "human-edit:v1:";
const HUMAN_MESSAGE_EDIT_OBJECT_PREFIX_V1 = "message-edit:v1:";
const CANONICAL_UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

export type HumanMessageEditAuthorizationSchemeV1 =
  | "foreground_session_v1"
  | "human_peer_v1"
  | "shared_agent_v1"
  | "human_ai_readable_v1";

export interface HumanMessageEditTargetV1 {
  readonly sessionId: string;
  readonly messageId: number;
  readonly expectedRevision: number;
  readonly nextRevision: number;
  readonly createdAt: number;
  readonly namespaceId: string;
  readonly keyClass: "human" | "ai";
  readonly namespaceAccessRevision: number;
  readonly namespaceKeyGeneration: number;
  readonly namespaceHeadDigest: Uint8Array;
  readonly namespacePublicationDigest: Uint8Array;
  readonly namespacePublicationSetDigest: Uint8Array;
  readonly namespaceAudienceFingerprint: Uint8Array;
  readonly cryptoObjectId: string;
}

export interface HumanMessageEditPlanV1 {
  readonly formatVersion: 1;
  readonly purpose: typeof HUMAN_MESSAGE_EDIT_PLAN_PURPOSE_V1;
  readonly operationId: string;
  readonly clientIdempotencyKey: string;
  readonly authorizationScheme: HumanMessageEditAuthorizationSchemeV1;
  readonly policyRevision: number;
  readonly roomId: string;
  readonly subjectHumanId: string;
  readonly committerDeviceId: string;
  readonly committerDeviceSigningKeyGeneration: number;
  readonly hostAuthorizationRevision: number;
  readonly targets: readonly HumanMessageEditTargetV1[];
  readonly issuedAt: number;
  readonly deadlineAt: number;
}

export interface HumanMessageEditPreparedTargetV1
  extends HumanMessageEditTargetV1 {
  readonly plaintextPayloadDigest: Uint8Array;
  readonly encryptedPayloadDigest: Uint8Array;
  readonly manifestDigest: Uint8Array;
  readonly envelopeDigest: Uint8Array;
}

export interface HumanMessageEditRequestUnsignedV1 {
  readonly formatVersion: 1;
  readonly purpose: typeof HUMAN_MESSAGE_EDIT_REQUEST_PURPOSE_V1;
  readonly operationId: string;
  readonly clientIdempotencyKey: string;
  readonly authorizationScheme: HumanMessageEditAuthorizationSchemeV1;
  readonly policyRevision: number;
  readonly roomId: string;
  readonly subjectHumanId: string;
  readonly committerDeviceId: string;
  readonly committerDeviceSigningKeyGeneration: number;
  readonly hostAuthorizationRevision: number;
  readonly planDigest: Uint8Array;
  readonly targets: readonly HumanMessageEditPreparedTargetV1[];
  readonly issuedAt: number;
  readonly deadlineAt: number;
}

export interface HumanMessageEditRequestV1
  extends HumanMessageEditRequestUnsignedV1 {
  readonly signature: Uint8Array;
}

export type ResolveCurrentHumanMessageEditAuthorityV1 = (
  input: Readonly<{
    purpose: "human-message-edit-v1-verify";
    subjectHumanId: string;
    operationId: string;
    authorizationScheme: HumanMessageEditAuthorizationSchemeV1;
    committerDeviceId: string;
    committerDeviceSigningKeyGeneration: number;
    hostAuthorizationRevision: number;
  }>,
) => Uint8Array | null;

const schemes = new Set<HumanMessageEditAuthorizationSchemeV1>([
  "foreground_session_v1", "human_peer_v1", "shared_agent_v1",
  "human_ai_readable_v1",
]);

function portable(label: string, value: unknown): string {
  if (typeof value !== "string" || value.length < 1
    || utf8V2(value).length > V2_LIMITS.idBytes) {
    throw new TypeError(`${label} is invalid`);
  }
  return value;
}

function uuid(label: string, value: unknown): string {
  const out = portable(label, value);
  if (!CANONICAL_UUID.test(out)) {
    throw new TypeError(`${label} is invalid`);
  }
  return out;
}

function counter(label: string, value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new TypeError(`${label} is invalid`);
  }
  return value as number;
}

function digest(label: string, value: unknown): Uint8Array {
  if (!(value instanceof Uint8Array) || value.length !== HASH_BYTES) {
    throw new TypeError(`${label} must be 32 bytes`);
  }
  return value.slice();
}

export interface HumanMessageEditObjectCoordinatesV1 {
  readonly operationId: string;
  readonly sessionId: string;
  readonly messageId: number;
  readonly revision: number;
}

function humanMessageEditOperationNonceV1(operationId: string): string {
  const value = portable("Human edit operation ID", operationId);
  if (!value.startsWith(HUMAN_MESSAGE_EDIT_OPERATION_PREFIX_V1)) {
    throw new TypeError("Human edit operation ID is invalid");
  }
  const nonce = value.slice(HUMAN_MESSAGE_EDIT_OPERATION_PREFIX_V1.length);
  if (!CANONICAL_UUID.test(nonce)) {
    throw new TypeError("Human edit operation ID is invalid");
  }
  return nonce;
}

function humanMessageEditOperationIdV1(operationId: string): string {
  return `${HUMAN_MESSAGE_EDIT_OPERATION_PREFIX_V1}${humanMessageEditOperationNonceV1(operationId)}`;
}

/** Operation-scoped immutable candidate identity for one Human Message edit. */
export function deriveHumanMessageEditCryptoObjectIdV1(
  coordinates: HumanMessageEditObjectCoordinatesV1,
): string {
  const nonce = humanMessageEditOperationNonceV1(coordinates.operationId);
  const sessionId = uuid("Human edit object Session ID", coordinates.sessionId);
  const messageId = counter("Human edit object Message ID", coordinates.messageId);
  const revision = counter("Human edit object revision", coordinates.revision);
  if (messageId < 1) throw new TypeError("Human edit object Message ID is invalid");
  const preimage = concatV2(
    frameText(HUMAN_MESSAGE_EDIT_OBJECT_ID_DOMAIN_V1),
    frameText(nonce),
    frameText(sessionId),
    encodeU64(messageId),
    encodeU64(revision),
  );
  try {
    return `${HUMAN_MESSAGE_EDIT_OBJECT_PREFIX_V1}${nonce}:${bytesToHex(sha256(preimage))}`;
  } finally {
    preimage.fill(0);
  }
}

/** Parses the nonce only after proving the complete canonical coordinate binding. */
export function parseHumanMessageEditCryptoObjectIdV1(
  objectId: string,
  coordinates: Omit<HumanMessageEditObjectCoordinatesV1, "operationId">,
): Readonly<{ operationId: string; operationNonce: string }> {
  const value = portable("Human edit crypto object ID", objectId);
  const match = /^message-edit:v1:([0-9a-f-]{36}):([0-9a-f]{64})$/u.exec(value);
  if (match === null || !CANONICAL_UUID.test(match[1]!)) {
    throw new TypeError("Human edit crypto object ID is invalid");
  }
  const operationNonce = match[1]!;
  const operationId = `${HUMAN_MESSAGE_EDIT_OPERATION_PREFIX_V1}${operationNonce}`;
  if (deriveHumanMessageEditCryptoObjectIdV1({ ...coordinates, operationId }) !== value) {
    throw new TypeError("Human edit crypto object coordinates disagree");
  }
  return Object.freeze({ operationId, operationNonce });
}

function exactFields(label: string, value: object, expected: readonly string[]) {
  const actual = Object.keys(value).sort();
  const fields = [...expected].sort();
  if (actual.length !== fields.length
    || actual.some((field, index) => field !== fields[index])) {
    throw new TypeError(`${label} has an invalid field set`);
  }
}

const TARGET_FIELDS = [
  "sessionId", "messageId", "expectedRevision", "nextRevision", "createdAt",
  "namespaceId", "keyClass", "namespaceAccessRevision",
  "namespaceKeyGeneration", "namespaceHeadDigest",
  "namespacePublicationDigest", "namespacePublicationSetDigest",
  "namespaceAudienceFingerprint", "cryptoObjectId",
] as const;
const PREPARED_TARGET_FIELDS = [...TARGET_FIELDS,
  "plaintextPayloadDigest", "encryptedPayloadDigest", "manifestDigest",
  "envelopeDigest"] as const;
const PLAN_FIELDS = [
  "formatVersion", "purpose", "operationId", "clientIdempotencyKey",
  "authorizationScheme", "policyRevision", "roomId", "subjectHumanId",
  "committerDeviceId", "committerDeviceSigningKeyGeneration",
  "hostAuthorizationRevision", "targets", "issuedAt", "deadlineAt",
] as const;
const REQUEST_FIELDS = [
  "formatVersion", "purpose", "operationId", "clientIdempotencyKey",
  "authorizationScheme", "policyRevision", "roomId", "subjectHumanId",
  "committerDeviceId", "committerDeviceSigningKeyGeneration",
  "hostAuthorizationRevision", "planDigest", "targets", "issuedAt",
  "deadlineAt",
] as const;

function normalizeTarget(
  value: HumanMessageEditTargetV1,
): HumanMessageEditTargetV1 {
  exactFields("Human edit target", value, TARGET_FIELDS);
  const expectedRevision = counter("Expected edit revision", value.expectedRevision);
  const nextRevision = counter("Next edit revision", value.nextRevision);
  if (nextRevision !== expectedRevision + 1) {
    throw new TypeError("Next edit revision must immediately follow expected revision");
  }
  if (value.keyClass !== "human" && value.keyClass !== "ai") {
    throw new TypeError("Human edit key class is invalid");
  }
  return Object.freeze({
    sessionId: uuid("Edit target session ID", value.sessionId),
    messageId: counter("Edit target message ID", value.messageId),
    expectedRevision, nextRevision,
    createdAt: counter("Edit target created-at", value.createdAt),
    namespaceId: portable("Edit target Namespace ID", value.namespaceId),
    keyClass: value.keyClass,
    namespaceAccessRevision: counter("Namespace access revision", value.namespaceAccessRevision),
    namespaceKeyGeneration: counter("Namespace key generation", value.namespaceKeyGeneration),
    namespaceHeadDigest: digest("Namespace head digest", value.namespaceHeadDigest),
    namespacePublicationDigest: digest("Namespace publication digest", value.namespacePublicationDigest),
    namespacePublicationSetDigest: digest("Namespace publication-set digest", value.namespacePublicationSetDigest),
    namespaceAudienceFingerprint: digest("Namespace audience fingerprint", value.namespaceAudienceFingerprint),
    cryptoObjectId: portable("Edit target crypto object ID", value.cryptoObjectId),
  });
}

function targetCoordinate(target: HumanMessageEditTargetV1): string {
  return `${target.sessionId}\u0000${target.messageId.toString().padStart(16, "0")}`;
}

function normalizeTargets(values: readonly HumanMessageEditTargetV1[]) {
  if (!Array.isArray(values) || values.length < 1) {
    throw new TypeError("Human edit target set must be non-empty");
  }
  const targets = values.map(normalizeTarget);
  for (let index = 1; index < targets.length; index++) {
    if (targetCoordinate(targets[index - 1]!) >= targetCoordinate(targets[index]!)) {
      throw new TypeError("Human edit targets must be unique and canonically ordered");
    }
  }
  const expected = targets[0]!.expectedRevision;
  if (targets.some((target) => target.expectedRevision !== expected)) {
    throw new TypeError("Logical edit targets must share one expected revision");
  }
  return Object.freeze(targets);
}

function assertCanonicalTargetOrder(values: readonly HumanMessageEditTargetV1[]) {
  for (let index = 1; index < values.length; index++) {
    if (targetCoordinate(values[index - 1]!) >= targetCoordinate(values[index]!)) {
      throw new TypeError("Human edit targets must be unique and canonically ordered");
    }
  }
  const expected = values[0]!.expectedRevision;
  if (values.some((target) => target.expectedRevision !== expected)) {
    throw new TypeError("Logical edit targets must share one expected revision");
  }
}

function validWindow(issuedAt: number, deadlineAt: number) {
  if (deadlineAt <= issuedAt
    || deadlineAt - issuedAt > HUMAN_MESSAGE_EDIT_MAX_TTL_MS_V1) {
    throw new TypeError("Human edit validity window is invalid");
  }
}

function normalizePlan(value: HumanMessageEditPlanV1): HumanMessageEditPlanV1 {
  exactFields("Human edit plan", value, PLAN_FIELDS);
  if (value.formatVersion !== 1 || value.purpose !== HUMAN_MESSAGE_EDIT_PLAN_PURPOSE_V1
    || !schemes.has(value.authorizationScheme)) {
    throw new TypeError("Human edit plan shape is invalid");
  }
  const issuedAt = counter("Human edit issued-at", value.issuedAt);
  const deadlineAt = counter("Human edit deadline", value.deadlineAt);
  validWindow(issuedAt, deadlineAt);
  return Object.freeze({
    ...value,
    operationId: humanMessageEditOperationIdV1(value.operationId),
    clientIdempotencyKey: portable("Human edit idempotency key", value.clientIdempotencyKey),
    policyRevision: counter("Human edit policy revision", value.policyRevision),
    roomId: uuid("Human edit Room ID", value.roomId),
    subjectHumanId: portable("Human edit subject", value.subjectHumanId),
    committerDeviceId: portable("Human edit device", value.committerDeviceId),
    committerDeviceSigningKeyGeneration: counter("Human edit signing generation", value.committerDeviceSigningKeyGeneration),
    hostAuthorizationRevision: counter("Human edit host authorization revision", value.hostAuthorizationRevision),
    targets: normalizeTargets(value.targets), issuedAt, deadlineAt,
  });
}

function targetBytes(value: HumanMessageEditTargetV1): Uint8Array {
  return concatV2(
    frameText(value.sessionId), encodeU64(value.messageId),
    encodeU64(value.expectedRevision), encodeU64(value.nextRevision),
    encodeU64(value.createdAt),
    frameText(value.namespaceId), frameText(value.keyClass),
    encodeU64(value.namespaceAccessRevision), encodeU64(value.namespaceKeyGeneration),
    frame(value.namespaceHeadDigest), frame(value.namespacePublicationDigest),
    frame(value.namespacePublicationSetDigest), frame(value.namespaceAudienceFingerprint),
    frameText(value.cryptoObjectId),
  );
}

function planBytes(value: HumanMessageEditPlanV1): Uint8Array {
  const targets = value.targets.map(targetBytes);
  try {
    return concatV2(
      frameText(HUMAN_MESSAGE_EDIT_PLAN_DOMAIN_V1), encodeU32(1),
      frameText(value.purpose), frameText(value.operationId),
      frameText(value.clientIdempotencyKey), frameText(value.authorizationScheme),
      encodeU64(value.policyRevision), frameText(value.roomId),
      frameText(value.subjectHumanId), frameText(value.committerDeviceId),
      encodeU64(value.committerDeviceSigningKeyGeneration),
      encodeU64(value.hostAuthorizationRevision), encodeU32(targets.length),
      ...targets.map(frame), encodeU64(value.issuedAt), encodeU64(value.deadlineAt),
    );
  } finally { targets.forEach((target) => target.fill(0)); }
}

export function encodeHumanMessageEditPlanV1(value: HumanMessageEditPlanV1): Uint8Array {
  return planBytes(normalizePlan(value));
}

function readTarget(reader: Parameters<Parameters<typeof decodeExact>[1]>[0]) {
  return {
    sessionId: reader.readText(UUID_BYTES), messageId: reader.readU64(),
    expectedRevision: reader.readU64(), nextRevision: reader.readU64(),
    createdAt: reader.readU64(),
    namespaceId: reader.readText(V2_LIMITS.idBytes),
    keyClass: reader.readText(5) as "human" | "ai",
    namespaceAccessRevision: reader.readU64(), namespaceKeyGeneration: reader.readU64(),
    namespaceHeadDigest: reader.readFrame(HASH_BYTES),
    namespacePublicationDigest: reader.readFrame(HASH_BYTES),
    namespacePublicationSetDigest: reader.readFrame(HASH_BYTES),
    namespaceAudienceFingerprint: reader.readFrame(HASH_BYTES),
    cryptoObjectId: reader.readText(V2_LIMITS.idBytes),
  };
}

export function decodeHumanMessageEditPlanV1(bytes: Uint8Array): HumanMessageEditPlanV1 {
  if (!(bytes instanceof Uint8Array)) {
    throw new TypeError("Human edit plan bytes are invalid");
  }
  const raw = decodeExact(bytes, (reader) => {
    if (reader.readText(utf8V2(HUMAN_MESSAGE_EDIT_PLAN_DOMAIN_V1).length) !== HUMAN_MESSAGE_EDIT_PLAN_DOMAIN_V1) {
      throw new CanonicalDecodingError("Human edit plan domain mismatch");
    }
    return {
      formatVersion: reader.readVersion(1) as 1,
      purpose: reader.readText(PURPOSE_BYTES) as typeof HUMAN_MESSAGE_EDIT_PLAN_PURPOSE_V1,
      operationId: reader.readText(V2_LIMITS.idBytes),
      clientIdempotencyKey: reader.readText(V2_LIMITS.idBytes),
      authorizationScheme: reader.readText(32) as HumanMessageEditAuthorizationSchemeV1,
      policyRevision: reader.readU64(), roomId: reader.readText(UUID_BYTES),
      subjectHumanId: reader.readText(V2_LIMITS.idBytes),
      committerDeviceId: reader.readText(V2_LIMITS.idBytes),
      committerDeviceSigningKeyGeneration: reader.readU64(),
      hostAuthorizationRevision: reader.readU64(),
      targets: Array.from({ length: reader.readCount(bytes.length) }, () =>
        decodeExact(reader.readFrame(bytes.length), readTarget)),
      issuedAt: reader.readU64(), deadlineAt: reader.readU64(),
    } satisfies HumanMessageEditPlanV1;
  });
  const normalized = normalizePlan(raw);
  const canonical = encodeHumanMessageEditPlanV1(normalized);
  if (!same(bytes, canonical)) throw new CanonicalDecodingError("Human edit plan is noncanonical");
  return normalized;
}

function same(left: Uint8Array, right: Uint8Array) {
  return left.length === right.length && left.every((byte, index) => byte === right[index]);
}

function normalizePreparedTarget(value: HumanMessageEditPreparedTargetV1) {
  exactFields("Prepared human edit target", value, PREPARED_TARGET_FIELDS);
  const { plaintextPayloadDigest: _plaintext, encryptedPayloadDigest: _encrypted,
    manifestDigest: _manifest, envelopeDigest: _envelope, ...target } = value;
  const base = normalizeTarget(target);
  return Object.freeze({ ...base,
    plaintextPayloadDigest: digest("Edit plaintext digest", value.plaintextPayloadDigest),
    encryptedPayloadDigest: digest("Edit ciphertext digest", value.encryptedPayloadDigest),
    manifestDigest: digest("Edit manifest digest", value.manifestDigest),
    envelopeDigest: digest("Edit envelope digest", value.envelopeDigest),
  });
}

function normalizeRequest(value: HumanMessageEditRequestUnsignedV1) {
  exactFields("Human edit request", value, REQUEST_FIELDS);
  if (value.formatVersion !== 1 || value.purpose !== HUMAN_MESSAGE_EDIT_REQUEST_PURPOSE_V1
    || !schemes.has(value.authorizationScheme)) throw new TypeError("Human edit request shape is invalid");
  const issuedAt = counter("Human edit issued-at", value.issuedAt);
  const deadlineAt = counter("Human edit deadline", value.deadlineAt);
  validWindow(issuedAt, deadlineAt);
  const targets = value.targets.map(normalizePreparedTarget);
  if (targets.length < 1) throw new TypeError("Human edit target set must be non-empty");
  assertCanonicalTargetOrder(targets);
  return Object.freeze({ ...value,
    operationId: humanMessageEditOperationIdV1(value.operationId),
    clientIdempotencyKey: portable("Human edit idempotency key", value.clientIdempotencyKey),
    policyRevision: counter("Human edit policy revision", value.policyRevision),
    roomId: uuid("Human edit Room ID", value.roomId),
    subjectHumanId: portable("Human edit subject", value.subjectHumanId),
    committerDeviceId: portable("Human edit device", value.committerDeviceId),
    committerDeviceSigningKeyGeneration: counter("Human edit signing generation", value.committerDeviceSigningKeyGeneration),
    hostAuthorizationRevision: counter("Human edit host authorization revision", value.hostAuthorizationRevision),
    planDigest: digest("Human edit plan digest", value.planDigest),
    targets: Object.freeze(targets), issuedAt, deadlineAt,
  });
}

function preparedTargetBytes(value: HumanMessageEditPreparedTargetV1) {
  return concatV2(targetBytes(value), frame(value.plaintextPayloadDigest),
    frame(value.encryptedPayloadDigest), frame(value.manifestDigest), frame(value.envelopeDigest));
}

function requestSigningBytes(value: HumanMessageEditRequestUnsignedV1) {
  const targets = value.targets.map(preparedTargetBytes);
  try {
    return concatV2(frameText(HUMAN_MESSAGE_EDIT_REQUEST_DOMAIN_V1), encodeU32(1),
      frameText(value.purpose), frameText(value.operationId), frameText(value.clientIdempotencyKey),
      frameText(value.authorizationScheme), encodeU64(value.policyRevision), frameText(value.roomId),
      frameText(value.subjectHumanId), frameText(value.committerDeviceId),
      encodeU64(value.committerDeviceSigningKeyGeneration), encodeU64(value.hostAuthorizationRevision),
      frame(value.planDigest), encodeU32(targets.length), ...targets.map(frame),
      encodeU64(value.issuedAt), encodeU64(value.deadlineAt));
  } finally { targets.forEach((target) => target.fill(0)); }
}

export function encodeHumanMessageEditRequestV1(value: HumanMessageEditRequestV1) {
  exactFields("Signed human edit request", value, [...REQUEST_FIELDS, "signature"]);
  const { signature, ...unsigned } = value;
  const normalized = normalizeRequest(unsigned);
  if (!(signature instanceof Uint8Array) || signature.length !== SIGNATURE_BYTES) throw new TypeError("Human edit signature is invalid");
  return concatV2(requestSigningBytes(normalized), frame(signature));
}

function readPreparedTarget(reader: Parameters<Parameters<typeof decodeExact>[1]>[0]) {
  return { ...readTarget(reader), plaintextPayloadDigest: reader.readFrame(HASH_BYTES),
    encryptedPayloadDigest: reader.readFrame(HASH_BYTES), manifestDigest: reader.readFrame(HASH_BYTES),
    envelopeDigest: reader.readFrame(HASH_BYTES) };
}

export function decodeHumanMessageEditRequestV1(bytes: Uint8Array): HumanMessageEditRequestV1 {
  if (!(bytes instanceof Uint8Array)) throw new TypeError("Human edit request bytes are invalid");
  const raw = decodeExact(bytes, (reader) => {
    if (reader.readText(utf8V2(HUMAN_MESSAGE_EDIT_REQUEST_DOMAIN_V1).length) !== HUMAN_MESSAGE_EDIT_REQUEST_DOMAIN_V1) throw new CanonicalDecodingError("Human edit request domain mismatch");
    return { formatVersion: reader.readVersion(1) as 1,
      purpose: reader.readText(PURPOSE_BYTES) as typeof HUMAN_MESSAGE_EDIT_REQUEST_PURPOSE_V1,
      operationId: reader.readText(V2_LIMITS.idBytes), clientIdempotencyKey: reader.readText(V2_LIMITS.idBytes),
      authorizationScheme: reader.readText(32) as HumanMessageEditAuthorizationSchemeV1,
      policyRevision: reader.readU64(), roomId: reader.readText(UUID_BYTES),
      subjectHumanId: reader.readText(V2_LIMITS.idBytes), committerDeviceId: reader.readText(V2_LIMITS.idBytes),
      committerDeviceSigningKeyGeneration: reader.readU64(), hostAuthorizationRevision: reader.readU64(),
      planDigest: reader.readFrame(HASH_BYTES),
      targets: Array.from({ length: reader.readCount(bytes.length) }, () =>
        decodeExact(reader.readFrame(bytes.length), readPreparedTarget)),
      issuedAt: reader.readU64(), deadlineAt: reader.readU64(), signature: reader.readFrame(SIGNATURE_BYTES),
    } satisfies HumanMessageEditRequestV1;
  });
  const { signature, ...unsigned } = raw;
  const normalized = normalizeRequest(unsigned);
  const request = Object.freeze({ ...normalized, signature: signature.slice() });
  const canonical = encodeHumanMessageEditRequestV1(request);
  if (!same(bytes, canonical)) throw new CanonicalDecodingError("Human edit request is noncanonical");
  return request;
}

export function prepareHumanMessageEditRequestV1(crypto: LatticeCrypto, input:
  Omit<HumanMessageEditRequestUnsignedV1, "formatVersion" | "purpose"> & Readonly<{
    committerSigningPublicKey: Uint8Array; committerSigningPrivateKey: Uint8Array;
  }>) {
  const { committerSigningPublicKey, committerSigningPrivateKey, ...rest } = input;
  const normalized = normalizeRequest({ ...rest, formatVersion: 1, purpose: HUMAN_MESSAGE_EDIT_REQUEST_PURPOSE_V1 });
  const signingBytes = requestSigningBytes(normalized);
  const signature = crypto.sign(committerSigningPrivateKey, signingBytes);
  if (!crypto.verify(committerSigningPublicKey, signingBytes, signature)) throw new TypeError("Human edit signing keys do not match");
  const bytes = encodeHumanMessageEditRequestV1({ ...normalized, signature });
  return Object.freeze({ request: decodeHumanMessageEditRequestV1(bytes), bytes, requestDigest: sha256(bytes) });
}

export function verifyHumanMessageEditRequestV1(crypto: LatticeCrypto, input: Readonly<{
  requestBytes: Uint8Array; planBytes: Uint8Array; now: number;
  resolveCurrentAuthority: ResolveCurrentHumanMessageEditAuthorityV1;
}>): HumanMessageEditRequestV1 {
  const plan = decodeHumanMessageEditPlanV1(input.planBytes);
  const request = decodeHumanMessageEditRequestV1(input.requestBytes);
  const planDigest = sha256(input.planBytes);
  const coordinatesMatch = request.operationId === plan.operationId
    && request.clientIdempotencyKey === plan.clientIdempotencyKey
    && request.authorizationScheme === plan.authorizationScheme
    && request.policyRevision === plan.policyRevision && request.roomId === plan.roomId
    && request.subjectHumanId === plan.subjectHumanId && request.committerDeviceId === plan.committerDeviceId
    && request.committerDeviceSigningKeyGeneration === plan.committerDeviceSigningKeyGeneration
    && request.hostAuthorizationRevision === plan.hostAuthorizationRevision
    && request.issuedAt === plan.issuedAt && request.deadlineAt === plan.deadlineAt
    && same(request.planDigest, planDigest) && request.targets.length === plan.targets.length
    && request.targets.every((target, index) => same(targetBytes(target), targetBytes(plan.targets[index]!)));
  if (!coordinatesMatch || input.now < plan.issuedAt || input.now >= plan.deadlineAt) throw new TypeError("Human edit request disagrees with its current plan");
  const publicKey = input.resolveCurrentAuthority({ purpose: "human-message-edit-v1-verify",
    subjectHumanId: request.subjectHumanId, operationId: request.operationId,
    authorizationScheme: request.authorizationScheme, committerDeviceId: request.committerDeviceId,
    committerDeviceSigningKeyGeneration: request.committerDeviceSigningKeyGeneration,
    hostAuthorizationRevision: request.hostAuthorizationRevision });
  if (publicKey === null || !crypto.verify(publicKey, requestSigningBytes(request), request.signature)) throw new TypeError("Human edit request authority is stale or invalid");
  return request;
}
