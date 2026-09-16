import { sha256 } from "@noble/hashes/sha2.js";

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
import {
  accessRevision,
  agentId,
  assertPortableId,
  authorizationRevision,
  cryptoDeviceId,
  humanId,
  namespaceGeneration,
  namespaceId,
  objectId,
  unixTimestamp,
  type AuthorizationRevision,
  type AgentId,
  type CryptoDeviceId,
  type HumanId,
  type NamespaceId,
  type ObjectId,
  type UnixTimestamp,
} from "../v2-types/ids.ts";
import { V2_LIMITS } from "../v2-types/limits.ts";
import { copyOwnedBytesV2 } from "../v2-types/opaque.ts";

export const SHARED_AGENT_LIVE_SHADOW_FORMAT_VERSION_V1 = 1 as const;
export const SHARED_AGENT_LIVE_SHADOW_PLAN_PURPOSE_V1 =
  "message.shared_agent_live_shadow_plan" as const;
export const SHARED_AGENT_LIVE_SHADOW_PLAN_DOMAIN_V1 =
  "nautilo/lattice-crypto/shared-agent-live-shadow-plan/v1";
export const SHARED_AGENT_LIVE_SHADOW_REQUEST_PURPOSE_V1 =
  "message.shared_agent_live_shadow_publish" as const;
export const SHARED_AGENT_LIVE_SHADOW_REQUEST_DOMAIN_V1 =
  "nautilo/lattice-crypto/shared-agent-live-shadow-request/v1";
export const SHARED_AGENT_LIVE_SHADOW_ACK_PURPOSE_V1 =
  "message.shared_agent_live_shadow_acknowledge" as const;
export const SHARED_AGENT_LIVE_SHADOW_ACK_DOMAIN_V1 =
  "nautilo/lattice-crypto/shared-agent-live-shadow-ack/v1";
const SHARED_AGENT_LIVE_SHADOW_EXECUTION_INPUT_SET_DOMAIN_V1 =
  "nautilo/lattice-crypto/shared-agent-live-shadow-execution-input-set/v1";
export const SHARED_AGENT_LIVE_SHADOW_NORMALIZATION_VERSION_V1 = 1 as const;
export const SHARED_AGENT_LIVE_SHADOW_MAX_TTL_MS_V1 = 30_000;
export const MAX_SHARED_AGENT_LIVE_SHADOW_PLAN_WIRE_BYTES_V1 = 16 * 1024;
export const MAX_SHARED_AGENT_LIVE_SHADOW_REQUEST_WIRE_BYTES_V1 = 16 * 1024;
export const MAX_SHARED_AGENT_LIVE_SHADOW_ACK_WIRE_BYTES_V1 = 8 * 1024;

const HASH_BYTES = 32;
const PG_SERIAL_MAX = 2_147_483_647;
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

export interface SharedAgentLiveShadowExecutionInputV1 {
  readonly operationId: string;
  readonly messageId: number;
}

/**
 * Content-free, order-sensitive commitment to the exact protected Human
 * operations one Conductor-selected Agent execution is allowed to consume.
 */
export function sharedAgentLiveShadowExecutionInputSetDigestV1(
  crypto: Pick<LatticeCrypto, "hash">,
  inputs: readonly SharedAgentLiveShadowExecutionInputV1[],
): Uint8Array {
  if (inputs.length < 1 || inputs.length > 256) {
    throw new RangeError("Shared-Agent execution input count is invalid");
  }
  const seen = new Set<string>();
  const encodedInputs = inputs.map((input) => {
    const operationId = portable(
      "Shared-Agent execution input operation ID",
      input.operationId,
    );
    if (seen.has(operationId)) {
      throw new TypeError("Shared-Agent execution input is duplicated");
    }
    seen.add(operationId);
    return concatV2(frameText(operationId), encodeU64(messageId(input.messageId)));
  });
  const canonical = concatV2(
    frameText(SHARED_AGENT_LIVE_SHADOW_EXECUTION_INPUT_SET_DOMAIN_V1),
    encodeU32(1),
    encodeU32(encodedInputs.length),
    ...encodedInputs.map(frame),
  );
  try {
    return crypto.hash(canonical);
  } finally {
    canonical.fill(0);
    encodedInputs.forEach((value) => value.fill(0));
  }
}

export interface SharedAgentLiveShadowMessagePlanV1 {
  readonly formatVersion: 1;
  readonly purpose: typeof SHARED_AGENT_LIVE_SHADOW_PLAN_PURPOSE_V1;
  readonly operationId: string;
  readonly clientIdempotencyKey: string;
  readonly policyRevision: number;
  readonly sessionId: string;
  readonly roomId: string;
  readonly recipientAgentId: AgentId;
  readonly humanMessageId: number;
  readonly revision: 0;
  readonly transcriptOrdinal: number;
  readonly role: "user";
  readonly createdAt: UnixTimestamp;
  readonly subjectHumanId: HumanId;
  readonly committerDeviceId: CryptoDeviceId;
  readonly committerDeviceSigningKeyGeneration: number;
  readonly hostAuthorizationRevision: AuthorizationRevision;
  readonly namespaceId: NamespaceId;
  readonly keyClass: "ai";
  readonly namespaceAccessRevision: number;
  readonly namespaceKeyGeneration: number;
  readonly namespaceHeadDigest: Uint8Array;
  readonly namespacePublicationDigest: Uint8Array;
  readonly namespacePublicationSetDigest: Uint8Array;
  readonly namespaceAudienceFingerprint: Uint8Array;
  readonly attemptCoordinate: string;
  readonly issuedAt: UnixTimestamp;
  readonly deadlineAt: UnixTimestamp;
}

export interface SharedAgentLiveShadowMessageRequestUnsignedV1 {
  readonly formatVersion: 1;
  readonly purpose: typeof SHARED_AGENT_LIVE_SHADOW_REQUEST_PURPOSE_V1;
  readonly normalizationVersion: 1;
  readonly subjectHumanId: HumanId;
  readonly operationId: string;
  readonly clientIdempotencyKey: string;
  readonly policyRevision: number;
  readonly sessionId: string;
  readonly roomId: string;
  readonly recipientAgentId: AgentId;
  readonly messageId: number;
  readonly revision: 0;
  readonly transcriptOrdinal: number;
  readonly role: "user";
  readonly createdAt: UnixTimestamp;
  readonly cryptoObjectId: ObjectId;
  readonly namespaceId: NamespaceId;
  readonly keyClass: "ai";
  readonly namespaceAccessRevision: number;
  readonly namespaceKeyGeneration: number;
  readonly namespaceHeadDigest: Uint8Array;
  readonly namespacePublicationDigest: Uint8Array;
  readonly namespacePublicationSetDigest: Uint8Array;
  readonly namespaceAudienceFingerprint: Uint8Array;
  readonly planDigest: Uint8Array;
  readonly plaintextPayloadDigest: Uint8Array;
  readonly encryptedPayloadDigest: Uint8Array;
  readonly manifestDigest: Uint8Array;
  readonly envelopeDigest: Uint8Array;
  readonly issuedAt: UnixTimestamp;
  readonly deadlineAt: UnixTimestamp;
  readonly committerDeviceId: CryptoDeviceId;
  readonly committerDeviceSigningKeyGeneration: number;
  readonly hostAuthorizationRevision: AuthorizationRevision;
}

export interface SharedAgentLiveShadowMessageRequestV1
  extends SharedAgentLiveShadowMessageRequestUnsignedV1 {
  readonly signature: Uint8Array;
}

export type SharedAgentLiveShadowAcknowledgementStatusV1 =
  | "verified"
  | "fallback";
export type SharedAgentLiveShadowAcknowledgementReasonV1 =
  | "matched"
  | "authority_stale"
  | "sender_evidence_unavailable"
  | "namespace_unavailable"
  | "protected_open_failed"
  | "parity_mismatch"
  | "transport_unavailable";

export interface SharedAgentLiveShadowAcknowledgementUnsignedV1 {
  readonly formatVersion: 1;
  readonly purpose: typeof SHARED_AGENT_LIVE_SHADOW_ACK_PURPOSE_V1;
  readonly subjectHumanId: HumanId;
  readonly operationId: string;
  readonly clientIdempotencyKey: string;
  readonly policyRevision: number;
  readonly sessionId: string;
  readonly roomId: string;
  readonly recipientAgentId: AgentId;
  readonly messageId: number;
  readonly revision: 0;
  readonly transcriptOrdinal: number;
  readonly cryptoObjectId: ObjectId;
  readonly protectedMessageDigest: Uint8Array;
  readonly ordinaryPayloadDigest: Uint8Array;
  readonly status: SharedAgentLiveShadowAcknowledgementStatusV1;
  readonly reason: SharedAgentLiveShadowAcknowledgementReasonV1;
  readonly issuedAt: UnixTimestamp;
  readonly deadlineAt: UnixTimestamp;
  readonly committerDeviceId: CryptoDeviceId;
  readonly committerDeviceSigningKeyGeneration: number;
  readonly hostAuthorizationRevision: AuthorizationRevision;
}

export interface SharedAgentLiveShadowAcknowledgementV1
  extends SharedAgentLiveShadowAcknowledgementUnsignedV1 {
  readonly signature: Uint8Array;
}

export type ResolveCurrentSharedAgentDeviceAuthorityV1 = (
  context: Readonly<{
    purpose: "shared-agent-live-shadow-request-v1-verify"
      | "shared-agent-live-shadow-ack-v1-verify";
    subjectHumanId: HumanId;
    recipientAgentId: AgentId;
    operationId: string;
    committerDeviceId: CryptoDeviceId;
    committerDeviceSigningKeyGeneration: number;
    hostAuthorizationRevision: AuthorizationRevision;
  }>,
) => Uint8Array | null;

const PLAN_FIELDS = Object.freeze([
  "formatVersion", "purpose", "operationId", "clientIdempotencyKey",
  "policyRevision", "sessionId", "roomId", "humanMessageId", "revision",
  "recipientAgentId",
  "transcriptOrdinal", "role", "createdAt", "subjectHumanId",
  "committerDeviceId", "committerDeviceSigningKeyGeneration",
  "hostAuthorizationRevision", "namespaceId", "keyClass",
  "namespaceAccessRevision", "namespaceKeyGeneration", "namespaceHeadDigest",
  "namespacePublicationDigest", "namespacePublicationSetDigest",
  "namespaceAudienceFingerprint", "attemptCoordinate", "issuedAt",
  "deadlineAt",
] as const);
const REQUEST_FIELDS = Object.freeze([
  "formatVersion", "purpose", "normalizationVersion", "subjectHumanId",
  "operationId", "clientIdempotencyKey", "policyRevision", "sessionId",
  "roomId", "messageId", "revision", "transcriptOrdinal", "role",
  "recipientAgentId",
  "createdAt", "cryptoObjectId", "namespaceId", "keyClass",
  "namespaceAccessRevision", "namespaceKeyGeneration", "namespaceHeadDigest",
  "namespacePublicationDigest", "namespacePublicationSetDigest",
  "namespaceAudienceFingerprint", "planDigest", "plaintextPayloadDigest",
  "encryptedPayloadDigest", "manifestDigest", "envelopeDigest", "issuedAt",
  "deadlineAt", "committerDeviceId", "committerDeviceSigningKeyGeneration",
  "hostAuthorizationRevision",
] as const);
const ACK_FIELDS = Object.freeze([
  "formatVersion", "purpose", "subjectHumanId", "operationId",
  "clientIdempotencyKey", "policyRevision", "sessionId", "roomId",
  "recipientAgentId",
  "messageId", "revision", "transcriptOrdinal", "cryptoObjectId",
  "protectedMessageDigest", "ordinaryPayloadDigest",
  "status", "reason", "issuedAt", "deadlineAt", "committerDeviceId",
  "committerDeviceSigningKeyGeneration", "hostAuthorizationRevision",
] as const);

function exactFields(label: string, value: object, fields: readonly string[]): void {
  const actual = Object.keys(value).sort();
  const expected = [...fields].sort();
  if (
    actual.length !== expected.length
    || actual.some((field, index) => field !== expected[index])
  ) throw new TypeError(`${label} has an invalid field set`);
}

function exactBytes(label: string, value: unknown, length: number): Uint8Array {
  if (!(value instanceof Uint8Array) || value.length !== length) {
    throw new TypeError(`${label} must be exactly ${length} bytes`);
  }
  return copyOwnedBytesV2(value);
}

function counter(label: string, value: unknown, minimum = 0): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum) {
    throw new RangeError(`${label} is invalid`);
  }
  return value as number;
}

function portable(label: string, value: unknown): string {
  assertPortableId(label, value);
  return value;
}

function uuid(label: string, value: unknown): string {
  if (typeof value !== "string" || !UUID.test(value)) {
    throw new TypeError(`${label} must be a canonical UUID`);
  }
  return value;
}

function messageId(value: unknown): number {
  const result = counter("Shared-Agent Message ID", value, 1);
  if (result > PG_SERIAL_MAX) {
    throw new RangeError("Shared-Agent Message ID is invalid");
  }
  return result;
}

function same(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length
    && left.every((value, index) => value === right[index]);
}

function validWindow(issuedAt: UnixTimestamp, deadlineAt: UnixTimestamp): void {
  if (
    deadlineAt <= issuedAt
    || deadlineAt - issuedAt > SHARED_AGENT_LIVE_SHADOW_MAX_TTL_MS_V1
  ) throw new RangeError("Shared-Agent live Shadow lifetime is invalid");
}

function destroyAuthorityBytes(value: Readonly<{
  namespaceHeadDigest: Uint8Array;
  namespacePublicationDigest: Uint8Array;
  namespacePublicationSetDigest: Uint8Array;
  namespaceAudienceFingerprint: Uint8Array;
}>): void {
  value.namespaceHeadDigest.fill(0);
  value.namespacePublicationDigest.fill(0);
  value.namespacePublicationSetDigest.fill(0);
  value.namespaceAudienceFingerprint.fill(0);
}

function normalizePlan(
  value: SharedAgentLiveShadowMessagePlanV1,
): SharedAgentLiveShadowMessagePlanV1 {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("Shared-Agent live Shadow plan must be an object");
  }
  exactFields("Shared-Agent live Shadow plan", value, PLAN_FIELDS);
  if (
    value.formatVersion !== 1
    || value.purpose !== SHARED_AGENT_LIVE_SHADOW_PLAN_PURPOSE_V1
    || value.revision !== 0
    || value.role !== "user"
    || value.keyClass !== "ai"
  ) throw new TypeError("Shared-Agent live Shadow plan shape is invalid");
  const issuedAt = unixTimestamp(value.issuedAt);
  const deadlineAt = unixTimestamp(value.deadlineAt);
  validWindow(issuedAt, deadlineAt);
  return Object.freeze({
    formatVersion: 1,
    purpose: SHARED_AGENT_LIVE_SHADOW_PLAN_PURPOSE_V1,
    operationId: portable("Shared-Agent operation ID", value.operationId),
    clientIdempotencyKey: portable(
      "Shared-Agent client idempotency key",
      value.clientIdempotencyKey,
    ),
    policyRevision: counter("Shared-Agent policy revision", value.policyRevision, 1),
    sessionId: uuid("Shared-Agent Session ID", value.sessionId),
    roomId: uuid("Shared-Agent Room ID", value.roomId),
    recipientAgentId: agentId(value.recipientAgentId),
    humanMessageId: messageId(value.humanMessageId),
    revision: 0,
    transcriptOrdinal: messageId(value.transcriptOrdinal),
    role: "user",
    createdAt: unixTimestamp(value.createdAt),
    subjectHumanId: humanId(value.subjectHumanId),
    committerDeviceId: cryptoDeviceId(value.committerDeviceId),
    committerDeviceSigningKeyGeneration: counter(
      "Shared-Agent device signing-key generation",
      value.committerDeviceSigningKeyGeneration,
    ),
    hostAuthorizationRevision: authorizationRevision(
      value.hostAuthorizationRevision,
    ),
    namespaceId: namespaceId(value.namespaceId),
    keyClass: "ai",
    namespaceAccessRevision: accessRevision(value.namespaceAccessRevision),
    namespaceKeyGeneration: namespaceGeneration(value.namespaceKeyGeneration),
    namespaceHeadDigest: exactBytes(
      "Shared-Agent Namespace head digest",
      value.namespaceHeadDigest,
      HASH_BYTES,
    ),
    namespacePublicationDigest: exactBytes(
      "Shared-Agent Namespace publication digest",
      value.namespacePublicationDigest,
      HASH_BYTES,
    ),
    namespacePublicationSetDigest: exactBytes(
      "Shared-Agent Namespace publication-set digest",
      value.namespacePublicationSetDigest,
      HASH_BYTES,
    ),
    namespaceAudienceFingerprint: exactBytes(
      "Shared-Agent Namespace audience fingerprint",
      value.namespaceAudienceFingerprint,
      HASH_BYTES,
    ),
    attemptCoordinate: portable(
      "Shared-Agent attempt coordinate",
      value.attemptCoordinate,
    ),
    issuedAt,
    deadlineAt,
  });
}

function planBytes(value: SharedAgentLiveShadowMessagePlanV1): Uint8Array {
  return concatV2(
    frameText(SHARED_AGENT_LIVE_SHADOW_PLAN_DOMAIN_V1),
    encodeU32(value.formatVersion),
    frameText(value.purpose),
    frameText(value.operationId),
    frameText(value.clientIdempotencyKey),
    encodeU64(value.policyRevision),
    frameText(value.sessionId),
    frameText(value.roomId),
    frameText(value.recipientAgentId),
    encodeU64(value.humanMessageId),
    encodeU64(value.revision),
    encodeU64(value.transcriptOrdinal),
    frameText(value.role),
    encodeU64(value.createdAt),
    frameText(value.subjectHumanId),
    frameText(value.committerDeviceId),
    encodeU64(value.committerDeviceSigningKeyGeneration),
    encodeU64(value.hostAuthorizationRevision),
    frameText(value.namespaceId),
    frameText(value.keyClass),
    encodeU64(value.namespaceAccessRevision),
    encodeU64(value.namespaceKeyGeneration),
    frame(value.namespaceHeadDigest),
    frame(value.namespacePublicationDigest),
    frame(value.namespacePublicationSetDigest),
    frame(value.namespaceAudienceFingerprint),
    frameText(value.attemptCoordinate),
    encodeU64(value.issuedAt),
    encodeU64(value.deadlineAt),
  );
}

export function encodeSharedAgentLiveShadowMessagePlanV1(
  value: SharedAgentLiveShadowMessagePlanV1,
): Uint8Array {
  const normalized = normalizePlan(value);
  try {
    const bytes = planBytes(normalized);
    if (bytes.length > MAX_SHARED_AGENT_LIVE_SHADOW_PLAN_WIRE_BYTES_V1) {
      bytes.fill(0);
      throw new RangeError("Shared-Agent live Shadow plan exceeds its wire limit");
    }
    return bytes;
  } finally {
    destroyAuthorityBytes(normalized);
  }
}

export function decodeSharedAgentLiveShadowMessagePlanV1(
  bytes: Uint8Array,
): SharedAgentLiveShadowMessagePlanV1 {
  if (
    !(bytes instanceof Uint8Array)
    || bytes.length > MAX_SHARED_AGENT_LIVE_SHADOW_PLAN_WIRE_BYTES_V1
  ) throw new TypeError("Shared-Agent live Shadow plan bytes are invalid");
  const raw = decodeExact(bytes, (reader): SharedAgentLiveShadowMessagePlanV1 => {
    if (
      reader.readText(utf8V2(SHARED_AGENT_LIVE_SHADOW_PLAN_DOMAIN_V1).length)
        !== SHARED_AGENT_LIVE_SHADOW_PLAN_DOMAIN_V1
    ) throw new CanonicalDecodingError("Shared-Agent plan domain mismatch");
    return {
      formatVersion: reader.readVersion(1) as 1,
      purpose: reader.readText(64) as typeof SHARED_AGENT_LIVE_SHADOW_PLAN_PURPOSE_V1,
      operationId: reader.readText(V2_LIMITS.idBytes),
      clientIdempotencyKey: reader.readText(V2_LIMITS.idBytes),
      policyRevision: reader.readU64(),
      sessionId: reader.readText(36),
      roomId: reader.readText(36),
      recipientAgentId: agentId(reader.readText(V2_LIMITS.idBytes)),
      humanMessageId: reader.readU64(),
      revision: reader.readU64() as 0,
      transcriptOrdinal: reader.readU64(),
      role: reader.readText(4) as "user",
      createdAt: unixTimestamp(reader.readU64()),
      subjectHumanId: humanId(reader.readText(V2_LIMITS.idBytes)),
      committerDeviceId: cryptoDeviceId(reader.readText(V2_LIMITS.idBytes)),
      committerDeviceSigningKeyGeneration: reader.readU64(),
      hostAuthorizationRevision: authorizationRevision(reader.readU64()),
      namespaceId: namespaceId(reader.readText(V2_LIMITS.idBytes)),
      keyClass: reader.readText(2) as "ai",
      namespaceAccessRevision: reader.readU64(),
      namespaceKeyGeneration: reader.readU64(),
      namespaceHeadDigest: reader.readFrame(HASH_BYTES),
      namespacePublicationDigest: reader.readFrame(HASH_BYTES),
      namespacePublicationSetDigest: reader.readFrame(HASH_BYTES),
      namespaceAudienceFingerprint: reader.readFrame(HASH_BYTES),
      attemptCoordinate: reader.readText(V2_LIMITS.idBytes),
      issuedAt: unixTimestamp(reader.readU64()),
      deadlineAt: unixTimestamp(reader.readU64()),
    };
  });
  let normalized: SharedAgentLiveShadowMessagePlanV1 | undefined;
  let canonical: Uint8Array | undefined;
  try {
    normalized = normalizePlan(raw);
    canonical = planBytes(normalized);
    if (!same(canonical, bytes)) {
      throw new CanonicalDecodingError("Shared-Agent plan is noncanonical");
    }
    const result = normalized;
    normalized = undefined;
    return result;
  } finally {
    destroyAuthorityBytes(raw);
    if (normalized) destroyAuthorityBytes(normalized);
    canonical?.fill(0);
  }
}

export function sharedAgentLiveShadowMessagePlanDigestV1(
  bytes: Uint8Array,
): Uint8Array {
  const plan = decodeSharedAgentLiveShadowMessagePlanV1(bytes);
  try {
    return sha256(bytes);
  } finally {
    destroyAuthorityBytes(plan);
  }
}

function normalizeRequest(
  value: SharedAgentLiveShadowMessageRequestUnsignedV1,
): SharedAgentLiveShadowMessageRequestUnsignedV1 {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("Shared-Agent live Shadow request must be an object");
  }
  exactFields("Shared-Agent live Shadow request", value, REQUEST_FIELDS);
  if (
    value.formatVersion !== 1
    || value.purpose !== SHARED_AGENT_LIVE_SHADOW_REQUEST_PURPOSE_V1
    || value.normalizationVersion !== 1
    || value.revision !== 0
    || value.role !== "user"
    || value.keyClass !== "ai"
  ) throw new TypeError("Shared-Agent live Shadow request shape is invalid");
  const issuedAt = unixTimestamp(value.issuedAt);
  const deadlineAt = unixTimestamp(value.deadlineAt);
  validWindow(issuedAt, deadlineAt);
  return Object.freeze({
    formatVersion: 1,
    purpose: SHARED_AGENT_LIVE_SHADOW_REQUEST_PURPOSE_V1,
    normalizationVersion: 1,
    subjectHumanId: humanId(value.subjectHumanId),
    operationId: portable("Shared-Agent request operation ID", value.operationId),
    clientIdempotencyKey: portable(
      "Shared-Agent request client idempotency key",
      value.clientIdempotencyKey,
    ),
    policyRevision: counter("Shared-Agent request policy revision", value.policyRevision, 1),
    sessionId: uuid("Shared-Agent request Session ID", value.sessionId),
    roomId: uuid("Shared-Agent request Room ID", value.roomId),
    recipientAgentId: agentId(value.recipientAgentId),
    messageId: messageId(value.messageId),
    revision: 0,
    transcriptOrdinal: messageId(value.transcriptOrdinal),
    role: "user",
    createdAt: unixTimestamp(value.createdAt),
    cryptoObjectId: objectId(value.cryptoObjectId),
    namespaceId: namespaceId(value.namespaceId),
    keyClass: "ai",
    namespaceAccessRevision: accessRevision(value.namespaceAccessRevision),
    namespaceKeyGeneration: namespaceGeneration(value.namespaceKeyGeneration),
    namespaceHeadDigest: exactBytes("Shared-Agent head digest", value.namespaceHeadDigest, HASH_BYTES),
    namespacePublicationDigest: exactBytes("Shared-Agent publication digest", value.namespacePublicationDigest, HASH_BYTES),
    namespacePublicationSetDigest: exactBytes("Shared-Agent publication-set digest", value.namespacePublicationSetDigest, HASH_BYTES),
    namespaceAudienceFingerprint: exactBytes("Shared-Agent audience fingerprint", value.namespaceAudienceFingerprint, HASH_BYTES),
    planDigest: exactBytes("Shared-Agent plan digest", value.planDigest, HASH_BYTES),
    plaintextPayloadDigest: exactBytes("Shared-Agent plaintext digest", value.plaintextPayloadDigest, HASH_BYTES),
    encryptedPayloadDigest: exactBytes("Shared-Agent ciphertext digest", value.encryptedPayloadDigest, HASH_BYTES),
    manifestDigest: exactBytes("Shared-Agent manifest digest", value.manifestDigest, HASH_BYTES),
    envelopeDigest: exactBytes("Shared-Agent envelope digest", value.envelopeDigest, HASH_BYTES),
    issuedAt,
    deadlineAt,
    committerDeviceId: cryptoDeviceId(value.committerDeviceId),
    committerDeviceSigningKeyGeneration: counter(
      "Shared-Agent request device signing-key generation",
      value.committerDeviceSigningKeyGeneration,
    ),
    hostAuthorizationRevision: authorizationRevision(value.hostAuthorizationRevision),
  });
}

function requestSigningBytes(
  value: SharedAgentLiveShadowMessageRequestUnsignedV1,
): Uint8Array {
  return concatV2(
    frameText(SHARED_AGENT_LIVE_SHADOW_REQUEST_DOMAIN_V1),
    encodeU32(value.formatVersion), frameText(value.purpose),
    encodeU32(value.normalizationVersion), frameText(value.subjectHumanId),
    frameText(value.operationId), frameText(value.clientIdempotencyKey),
    encodeU64(value.policyRevision),
    frameText(value.sessionId), frameText(value.roomId),
    frameText(value.recipientAgentId),
    encodeU64(value.messageId), encodeU64(value.revision),
    encodeU64(value.transcriptOrdinal), frameText(value.role),
    encodeU64(value.createdAt), frameText(value.cryptoObjectId),
    frameText(value.namespaceId), frameText(value.keyClass),
    encodeU64(value.namespaceAccessRevision),
    encodeU64(value.namespaceKeyGeneration), frame(value.namespaceHeadDigest),
    frame(value.namespacePublicationDigest),
    frame(value.namespacePublicationSetDigest),
    frame(value.namespaceAudienceFingerprint), frame(value.planDigest),
    frame(value.plaintextPayloadDigest), frame(value.encryptedPayloadDigest),
    frame(value.manifestDigest), frame(value.envelopeDigest),
    encodeU64(value.issuedAt), encodeU64(value.deadlineAt),
    frameText(value.committerDeviceId),
    encodeU64(value.committerDeviceSigningKeyGeneration),
    encodeU64(value.hostAuthorizationRevision),
  );
}

function destroyRequest(value: SharedAgentLiveShadowMessageRequestV1): void {
  destroyAuthorityBytes(value);
  value.planDigest.fill(0);
  value.plaintextPayloadDigest.fill(0);
  value.encryptedPayloadDigest.fill(0);
  value.manifestDigest.fill(0);
  value.envelopeDigest.fill(0);
  value.signature.fill(0);
}

export function sharedAgentLiveShadowMessageRequestSigningBytesV1(
  value: SharedAgentLiveShadowMessageRequestV1,
): Uint8Array {
  const { signature: _signature, ...unsigned } = value;
  const normalized = normalizeRequest(unsigned);
  try {
    return requestSigningBytes(normalized);
  } finally {
    destroyRequest({ ...normalized, signature: new Uint8Array(64) });
  }
}

export function encodeSharedAgentLiveShadowMessageRequestV1(
  value: SharedAgentLiveShadowMessageRequestV1,
): Uint8Array {
  exactFields("Shared-Agent live Shadow signed request", value, [
    ...REQUEST_FIELDS,
    "signature",
  ]);
  const { signature, ...unsigned } = value;
  const normalized = normalizeRequest(unsigned);
  const normalizedSignature = exactBytes(
    "Shared-Agent request signature",
    signature,
    V2_LIMITS.signatureBytes,
  );
  try {
    const bytes = concatV2(
      requestSigningBytes(normalized),
      frame(normalizedSignature),
    );
    if (bytes.length > MAX_SHARED_AGENT_LIVE_SHADOW_REQUEST_WIRE_BYTES_V1) {
      bytes.fill(0);
      throw new RangeError("Shared-Agent request exceeds its wire limit");
    }
    return bytes;
  } finally {
    destroyRequest({ ...normalized, signature: normalizedSignature });
  }
}

export function decodeSharedAgentLiveShadowMessageRequestV1(
  bytes: Uint8Array,
): SharedAgentLiveShadowMessageRequestV1 {
  if (
    !(bytes instanceof Uint8Array)
    || bytes.length > MAX_SHARED_AGENT_LIVE_SHADOW_REQUEST_WIRE_BYTES_V1
  ) throw new TypeError("Shared-Agent request bytes are invalid");
  const raw = decodeExact(bytes, (reader): SharedAgentLiveShadowMessageRequestV1 => {
    if (
      reader.readText(utf8V2(SHARED_AGENT_LIVE_SHADOW_REQUEST_DOMAIN_V1).length)
        !== SHARED_AGENT_LIVE_SHADOW_REQUEST_DOMAIN_V1
    ) throw new CanonicalDecodingError("Shared-Agent request domain mismatch");
    return {
      formatVersion: reader.readVersion(1) as 1,
      purpose: reader.readText(64) as typeof SHARED_AGENT_LIVE_SHADOW_REQUEST_PURPOSE_V1,
      normalizationVersion: reader.readVersion(1) as 1,
      subjectHumanId: humanId(reader.readText(V2_LIMITS.idBytes)),
      operationId: reader.readText(V2_LIMITS.idBytes),
      clientIdempotencyKey: reader.readText(V2_LIMITS.idBytes),
      policyRevision: reader.readU64(),
      sessionId: reader.readText(36),
      roomId: reader.readText(36),
      recipientAgentId: agentId(reader.readText(V2_LIMITS.idBytes)),
      messageId: reader.readU64(),
      revision: reader.readU64() as 0,
      transcriptOrdinal: reader.readU64(),
      role: reader.readText(4) as "user",
      createdAt: unixTimestamp(reader.readU64()),
      cryptoObjectId: objectId(reader.readText(V2_LIMITS.idBytes)),
      namespaceId: namespaceId(reader.readText(V2_LIMITS.idBytes)),
      keyClass: reader.readText(2) as "ai",
      namespaceAccessRevision: reader.readU64(),
      namespaceKeyGeneration: reader.readU64(),
      namespaceHeadDigest: reader.readFrame(HASH_BYTES),
      namespacePublicationDigest: reader.readFrame(HASH_BYTES),
      namespacePublicationSetDigest: reader.readFrame(HASH_BYTES),
      namespaceAudienceFingerprint: reader.readFrame(HASH_BYTES),
      planDigest: reader.readFrame(HASH_BYTES),
      plaintextPayloadDigest: reader.readFrame(HASH_BYTES),
      encryptedPayloadDigest: reader.readFrame(HASH_BYTES),
      manifestDigest: reader.readFrame(HASH_BYTES),
      envelopeDigest: reader.readFrame(HASH_BYTES),
      issuedAt: unixTimestamp(reader.readU64()),
      deadlineAt: unixTimestamp(reader.readU64()),
      committerDeviceId: cryptoDeviceId(reader.readText(V2_LIMITS.idBytes)),
      committerDeviceSigningKeyGeneration: reader.readU64(),
      hostAuthorizationRevision: authorizationRevision(reader.readU64()),
      signature: reader.readFrame(V2_LIMITS.signatureBytes),
    };
  });
  let canonical: Uint8Array | undefined;
  try {
    canonical = encodeSharedAgentLiveShadowMessageRequestV1(raw);
    if (!same(canonical, bytes)) {
      throw new CanonicalDecodingError("Shared-Agent request is noncanonical");
    }
    return raw;
  } catch (error) {
    destroyRequest(raw);
    throw error;
  } finally {
    canonical?.fill(0);
  }
}

export function prepareSharedAgentLiveShadowMessageRequestV1(
  crypto: LatticeCrypto,
  input: Omit<
    SharedAgentLiveShadowMessageRequestUnsignedV1,
    "formatVersion" | "purpose" | "normalizationVersion"
  > & Readonly<{
    committerSigningPublicKey: Uint8Array;
    committerSigningPrivateKey: Uint8Array;
  }>,
): Readonly<{
  request: SharedAgentLiveShadowMessageRequestV1;
  bytes: Uint8Array;
  requestDigest: Uint8Array;
}> {
  const publicKey = exactBytes(
    "Shared-Agent signing public key",
    input.committerSigningPublicKey,
    V2_LIMITS.signingPublicKeyBytes,
  );
  const privateKey = exactBytes(
    "Shared-Agent signing private key",
    input.committerSigningPrivateKey,
    V2_LIMITS.signingPrivateKeyBytes,
  );
  const {
    committerSigningPublicKey: _public,
    committerSigningPrivateKey: _private,
    ...unsigned
  } = input;
  const normalized = normalizeRequest({
    ...unsigned,
    formatVersion: 1,
    purpose: SHARED_AGENT_LIVE_SHADOW_REQUEST_PURPOSE_V1,
    normalizationVersion: 1,
  });
  let signingBytes: Uint8Array | undefined;
  let signature: Uint8Array | undefined;
  try {
    signingBytes = requestSigningBytes(normalized);
    signature = crypto.sign(privateKey, signingBytes);
    if (!crypto.verify(publicKey, signingBytes, signature)) {
      throw new TypeError("Shared-Agent signing keys do not match");
    }
    const bytes = encodeSharedAgentLiveShadowMessageRequestV1({
      ...normalized,
      signature,
    });
    return Object.freeze({
      request: decodeSharedAgentLiveShadowMessageRequestV1(bytes),
      bytes,
      requestDigest: sha256(bytes),
    });
  } finally {
    publicKey.fill(0);
    privateKey.fill(0);
    signingBytes?.fill(0);
    signature?.fill(0);
    destroyRequest({ ...normalized, signature: new Uint8Array(64) });
  }
}

function verifyRequest(
  crypto: LatticeCrypto,
  input: Readonly<{
    requestBytes: Uint8Array;
    now?: UnixTimestamp;
    expectedRequestDigest?: Uint8Array;
    resolveCurrentAuthority: ResolveCurrentSharedAgentDeviceAuthorityV1;
  }>,
  fresh: boolean,
): SharedAgentLiveShadowMessageRequestV1 {
  let request: SharedAgentLiveShadowMessageRequestV1 | undefined;
  let signingBytes: Uint8Array | undefined;
  let publicKey: Uint8Array | undefined;
  let expectedDigest: Uint8Array | undefined;
  let actualDigest: Uint8Array | undefined;
  let verified = false;
  try {
    request = decodeSharedAgentLiveShadowMessageRequestV1(input.requestBytes);
    if (fresh) {
      const now = unixTimestamp(input.now);
      if (now < request.issuedAt || now >= request.deadlineAt) {
        throw new TypeError("Shared-Agent request is not currently valid");
      }
    }
    if (input.expectedRequestDigest !== undefined) {
      expectedDigest = exactBytes(
        "Shared-Agent expected request digest",
        input.expectedRequestDigest,
        HASH_BYTES,
      );
      actualDigest = sha256(input.requestBytes);
      if (!same(actualDigest, expectedDigest)) {
        throw new TypeError("Shared-Agent durable request digest disagrees");
      }
    }
    publicKey = input.resolveCurrentAuthority({
      purpose: "shared-agent-live-shadow-request-v1-verify",
      subjectHumanId: request.subjectHumanId,
      recipientAgentId: request.recipientAgentId,
      operationId: request.operationId,
      committerDeviceId: request.committerDeviceId,
      committerDeviceSigningKeyGeneration:
        request.committerDeviceSigningKeyGeneration,
      hostAuthorizationRevision: request.hostAuthorizationRevision,
    })?.slice();
    if (publicKey === undefined) {
      throw new TypeError("Shared-Agent request authority is unavailable");
    }
    signingBytes = sharedAgentLiveShadowMessageRequestSigningBytesV1(request);
    if (!crypto.verify(publicKey, signingBytes, request.signature)) {
      throw new TypeError("Shared-Agent request signature is invalid");
    }
    verified = true;
    const result = request;
    request = undefined;
    return result;
  } finally {
    if (!verified && request) destroyRequest(request);
    signingBytes?.fill(0);
    publicKey?.fill(0);
    expectedDigest?.fill(0);
    actualDigest?.fill(0);
  }
}

export function verifySharedAgentLiveShadowMessageRequestV1(
  crypto: LatticeCrypto,
  input: Readonly<{
    requestBytes: Uint8Array;
    now: UnixTimestamp;
    resolveCurrentAuthority: ResolveCurrentSharedAgentDeviceAuthorityV1;
  }>,
): SharedAgentLiveShadowMessageRequestV1 {
  return verifyRequest(crypto, input, true);
}

export function verifySharedAgentLiveShadowMessageRequestExactReplayV1(
  crypto: LatticeCrypto,
  input: Readonly<{
    requestBytes: Uint8Array;
    expectedRequestDigest: Uint8Array;
    resolveCurrentAuthority: ResolveCurrentSharedAgentDeviceAuthorityV1;
  }>,
): SharedAgentLiveShadowMessageRequestV1 {
  return verifyRequest(crypto, input, false);
}

export function sharedAgentLiveShadowMessageRequestDigestV1(
  bytes: Uint8Array,
): Uint8Array {
  const request = decodeSharedAgentLiveShadowMessageRequestV1(bytes);
  try {
    return sha256(bytes);
  } finally {
    destroyRequest(request);
  }
}

function normalizeAcknowledgement(
  value: SharedAgentLiveShadowAcknowledgementUnsignedV1,
): SharedAgentLiveShadowAcknowledgementUnsignedV1 {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("Shared-Agent acknowledgement must be an object");
  }
  exactFields("Shared-Agent acknowledgement", value, ACK_FIELDS);
  if (
    value.formatVersion !== 1
    || value.purpose !== SHARED_AGENT_LIVE_SHADOW_ACK_PURPOSE_V1
    || value.revision !== 0
    || !["verified", "fallback"].includes(value.status)
    || ![
      "matched", "authority_stale", "sender_evidence_unavailable",
      "namespace_unavailable", "protected_open_failed", "parity_mismatch",
      "transport_unavailable",
    ].includes(value.reason)
    || (value.status === "verified") !== (value.reason === "matched")
  ) throw new TypeError("Shared-Agent acknowledgement shape is invalid");
  const issuedAt = unixTimestamp(value.issuedAt);
  const deadlineAt = unixTimestamp(value.deadlineAt);
  validWindow(issuedAt, deadlineAt);
  return Object.freeze({
    formatVersion: 1,
    purpose: SHARED_AGENT_LIVE_SHADOW_ACK_PURPOSE_V1,
    subjectHumanId: humanId(value.subjectHumanId),
    operationId: portable("Shared-Agent acknowledgement operation ID", value.operationId),
    clientIdempotencyKey: portable(
      "Shared-Agent acknowledgement client idempotency key",
      value.clientIdempotencyKey,
    ),
    policyRevision: counter("Shared-Agent acknowledgement policy revision", value.policyRevision, 1),
    sessionId: uuid("Shared-Agent acknowledgement Session ID", value.sessionId),
    roomId: uuid("Shared-Agent acknowledgement Room ID", value.roomId),
    recipientAgentId: agentId(value.recipientAgentId),
    messageId: messageId(value.messageId),
    revision: 0,
    transcriptOrdinal: messageId(value.transcriptOrdinal),
    cryptoObjectId: objectId(value.cryptoObjectId),
    protectedMessageDigest: exactBytes("Shared-Agent protected Message digest", value.protectedMessageDigest, HASH_BYTES),
    ordinaryPayloadDigest: exactBytes("Shared-Agent ordinary payload digest", value.ordinaryPayloadDigest, HASH_BYTES),
    status: value.status,
    reason: value.reason,
    issuedAt,
    deadlineAt,
    committerDeviceId: cryptoDeviceId(value.committerDeviceId),
    committerDeviceSigningKeyGeneration: counter(
      "Shared-Agent acknowledgement device signing-key generation",
      value.committerDeviceSigningKeyGeneration,
    ),
    hostAuthorizationRevision: authorizationRevision(value.hostAuthorizationRevision),
  });
}

function acknowledgementSigningBytes(
  value: SharedAgentLiveShadowAcknowledgementUnsignedV1,
): Uint8Array {
  return concatV2(
    frameText(SHARED_AGENT_LIVE_SHADOW_ACK_DOMAIN_V1),
    encodeU32(value.formatVersion), frameText(value.purpose),
    frameText(value.subjectHumanId), frameText(value.operationId),
    frameText(value.clientIdempotencyKey), encodeU64(value.policyRevision),
    frameText(value.sessionId),
    frameText(value.roomId), frameText(value.recipientAgentId),
    encodeU64(value.messageId),
    encodeU64(value.revision), encodeU64(value.transcriptOrdinal),
    frameText(value.cryptoObjectId),
    frame(value.protectedMessageDigest), frame(value.ordinaryPayloadDigest),
    frameText(value.status), frameText(value.reason),
    encodeU64(value.issuedAt), encodeU64(value.deadlineAt),
    frameText(value.committerDeviceId),
    encodeU64(value.committerDeviceSigningKeyGeneration),
    encodeU64(value.hostAuthorizationRevision),
  );
}

function destroyAcknowledgement(
  value: SharedAgentLiveShadowAcknowledgementV1,
): void {
  value.protectedMessageDigest.fill(0);
  value.ordinaryPayloadDigest.fill(0);
  value.signature.fill(0);
}

export function sharedAgentLiveShadowAcknowledgementSigningBytesV1(
  value: SharedAgentLiveShadowAcknowledgementV1,
): Uint8Array {
  const { signature: _signature, ...unsigned } = value;
  const normalized = normalizeAcknowledgement(unsigned);
  try {
    return acknowledgementSigningBytes(normalized);
  } finally {
    destroyAcknowledgement({ ...normalized, signature: new Uint8Array(64) });
  }
}

export function encodeSharedAgentLiveShadowAcknowledgementV1(
  value: SharedAgentLiveShadowAcknowledgementV1,
): Uint8Array {
  exactFields("Shared-Agent signed acknowledgement", value, [
    ...ACK_FIELDS,
    "signature",
  ]);
  const { signature, ...unsigned } = value;
  const normalized = normalizeAcknowledgement(unsigned);
  const normalizedSignature = exactBytes(
    "Shared-Agent acknowledgement signature",
    signature,
    V2_LIMITS.signatureBytes,
  );
  try {
    const bytes = concatV2(
      acknowledgementSigningBytes(normalized),
      frame(normalizedSignature),
    );
    if (bytes.length > MAX_SHARED_AGENT_LIVE_SHADOW_ACK_WIRE_BYTES_V1) {
      bytes.fill(0);
      throw new RangeError("Shared-Agent acknowledgement exceeds its wire limit");
    }
    return bytes;
  } finally {
    destroyAcknowledgement({ ...normalized, signature: normalizedSignature });
  }
}

export function decodeSharedAgentLiveShadowAcknowledgementV1(
  bytes: Uint8Array,
): SharedAgentLiveShadowAcknowledgementV1 {
  if (
    !(bytes instanceof Uint8Array)
    || bytes.length > MAX_SHARED_AGENT_LIVE_SHADOW_ACK_WIRE_BYTES_V1
  ) throw new TypeError("Shared-Agent acknowledgement bytes are invalid");
  const raw = decodeExact(bytes, (reader): SharedAgentLiveShadowAcknowledgementV1 => {
    if (
      reader.readText(utf8V2(SHARED_AGENT_LIVE_SHADOW_ACK_DOMAIN_V1).length)
        !== SHARED_AGENT_LIVE_SHADOW_ACK_DOMAIN_V1
    ) throw new CanonicalDecodingError("Shared-Agent acknowledgement domain mismatch");
    return {
      formatVersion: reader.readVersion(1) as 1,
      purpose: reader.readText(64) as typeof SHARED_AGENT_LIVE_SHADOW_ACK_PURPOSE_V1,
      subjectHumanId: humanId(reader.readText(V2_LIMITS.idBytes)),
      operationId: reader.readText(V2_LIMITS.idBytes),
      clientIdempotencyKey: reader.readText(V2_LIMITS.idBytes),
      policyRevision: reader.readU64(),
      sessionId: reader.readText(36),
      roomId: reader.readText(36),
      recipientAgentId: agentId(reader.readText(V2_LIMITS.idBytes)),
      messageId: reader.readU64(),
      revision: reader.readU64() as 0,
      transcriptOrdinal: reader.readU64(),
      cryptoObjectId: objectId(reader.readText(V2_LIMITS.idBytes)),
      protectedMessageDigest: reader.readFrame(HASH_BYTES),
      ordinaryPayloadDigest: reader.readFrame(HASH_BYTES),
      status: reader.readText(16) as SharedAgentLiveShadowAcknowledgementStatusV1,
      reason: reader.readText(64) as SharedAgentLiveShadowAcknowledgementReasonV1,
      issuedAt: unixTimestamp(reader.readU64()),
      deadlineAt: unixTimestamp(reader.readU64()),
      committerDeviceId: cryptoDeviceId(reader.readText(V2_LIMITS.idBytes)),
      committerDeviceSigningKeyGeneration: reader.readU64(),
      hostAuthorizationRevision: authorizationRevision(reader.readU64()),
      signature: reader.readFrame(V2_LIMITS.signatureBytes),
    };
  });
  let canonical: Uint8Array | undefined;
  try {
    canonical = encodeSharedAgentLiveShadowAcknowledgementV1(raw);
    if (!same(canonical, bytes)) {
      throw new CanonicalDecodingError("Shared-Agent acknowledgement is noncanonical");
    }
    return raw;
  } catch (error) {
    destroyAcknowledgement(raw);
    throw error;
  } finally {
    canonical?.fill(0);
  }
}

export function prepareSharedAgentLiveShadowAcknowledgementV1(
  crypto: LatticeCrypto,
  input: Omit<
    SharedAgentLiveShadowAcknowledgementUnsignedV1,
    "formatVersion" | "purpose"
  > & Readonly<{
    committerSigningPublicKey: Uint8Array;
    committerSigningPrivateKey: Uint8Array;
  }>,
): Readonly<{
  acknowledgement: SharedAgentLiveShadowAcknowledgementV1;
  bytes: Uint8Array;
  acknowledgementDigest: Uint8Array;
}> {
  const publicKey = exactBytes(
    "Shared-Agent acknowledgement public key",
    input.committerSigningPublicKey,
    V2_LIMITS.signingPublicKeyBytes,
  );
  const privateKey = exactBytes(
    "Shared-Agent acknowledgement private key",
    input.committerSigningPrivateKey,
    V2_LIMITS.signingPrivateKeyBytes,
  );
  const {
    committerSigningPublicKey: _public,
    committerSigningPrivateKey: _private,
    ...unsigned
  } = input;
  const normalized = normalizeAcknowledgement({
    ...unsigned,
    formatVersion: 1,
    purpose: SHARED_AGENT_LIVE_SHADOW_ACK_PURPOSE_V1,
  });
  let signingBytes: Uint8Array | undefined;
  let signature: Uint8Array | undefined;
  try {
    signingBytes = acknowledgementSigningBytes(normalized);
    signature = crypto.sign(privateKey, signingBytes);
    if (!crypto.verify(publicKey, signingBytes, signature)) {
      throw new TypeError("Shared-Agent acknowledgement signing keys do not match");
    }
    const bytes = encodeSharedAgentLiveShadowAcknowledgementV1({
      ...normalized,
      signature,
    });
    return Object.freeze({
      acknowledgement: decodeSharedAgentLiveShadowAcknowledgementV1(bytes),
      bytes,
      acknowledgementDigest: sha256(bytes),
    });
  } finally {
    publicKey.fill(0);
    privateKey.fill(0);
    signingBytes?.fill(0);
    signature?.fill(0);
    destroyAcknowledgement({ ...normalized, signature: new Uint8Array(64) });
  }
}

export function verifySharedAgentLiveShadowAcknowledgementV1(
  crypto: LatticeCrypto,
  input: Readonly<{
    bytes: Uint8Array;
    now: UnixTimestamp;
    resolveCurrentAuthority: ResolveCurrentSharedAgentDeviceAuthorityV1;
  }>,
): SharedAgentLiveShadowAcknowledgementV1 {
  let acknowledgement: SharedAgentLiveShadowAcknowledgementV1 | undefined;
  let signingBytes: Uint8Array | undefined;
  let publicKey: Uint8Array | undefined;
  let verified = false;
  try {
    acknowledgement = decodeSharedAgentLiveShadowAcknowledgementV1(input.bytes);
    const now = unixTimestamp(input.now);
    if (now < acknowledgement.issuedAt || now >= acknowledgement.deadlineAt) {
      throw new TypeError("Shared-Agent acknowledgement is not currently valid");
    }
    publicKey = input.resolveCurrentAuthority({
      purpose: "shared-agent-live-shadow-ack-v1-verify",
      subjectHumanId: acknowledgement.subjectHumanId,
      recipientAgentId: acknowledgement.recipientAgentId,
      operationId: acknowledgement.operationId,
      committerDeviceId: acknowledgement.committerDeviceId,
      committerDeviceSigningKeyGeneration:
        acknowledgement.committerDeviceSigningKeyGeneration,
      hostAuthorizationRevision: acknowledgement.hostAuthorizationRevision,
    })?.slice();
    if (publicKey === undefined) {
      throw new TypeError("Shared-Agent acknowledgement authority is unavailable");
    }
    signingBytes = sharedAgentLiveShadowAcknowledgementSigningBytesV1(
      acknowledgement,
    );
    if (!crypto.verify(publicKey, signingBytes, acknowledgement.signature)) {
      throw new TypeError("Shared-Agent acknowledgement signature is invalid");
    }
    verified = true;
    const result = acknowledgement;
    acknowledgement = undefined;
    return result;
  } finally {
    if (!verified && acknowledgement) destroyAcknowledgement(acknowledgement);
    signingBytes?.fill(0);
    publicKey?.fill(0);
  }
}

export function sharedAgentLiveShadowAcknowledgementDigestV1(
  bytes: Uint8Array,
): Uint8Array {
  const acknowledgement = decodeSharedAgentLiveShadowAcknowledgementV1(bytes);
  try {
    return sha256(bytes);
  } finally {
    destroyAcknowledgement(acknowledgement);
  }
}
