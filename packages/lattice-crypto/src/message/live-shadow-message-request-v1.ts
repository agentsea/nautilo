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
  domainEpoch,
  cryptoDomainId,
  humanId,
  namespaceGeneration,
  namespaceId,
  objectId,
  unixTimestamp,
  type AgentId,
  type AuthorizationRevision,
  type CryptoDeviceId,
  type CryptoDomainId,
  type HumanId,
  type NamespaceId,
  type ObjectId,
  type UnixTimestamp,
} from "../v2-types/ids.ts";
import { V2_LIMITS } from "../v2-types/limits.ts";
import { copyOwnedBytesV2 } from "../v2-types/opaque.ts";

export const LIVE_SHADOW_MESSAGE_PLAN_FORMAT_VERSION_V1 = 1 as const;
export const LIVE_SHADOW_MESSAGE_PLAN_PURPOSE_V1 =
  "message.live_shadow_plan" as const;
export const LIVE_SHADOW_MESSAGE_PLAN_DOMAIN_V1 =
  "nautilo/lattice-crypto/live-shadow-message-plan/v1";
export const HUMAN_LIVE_SHADOW_MESSAGE_REQUEST_FORMAT_VERSION_V1 = 1 as const;
export const HUMAN_LIVE_SHADOW_MESSAGE_REQUEST_PURPOSE_V1 =
  "message.live_shadow_human_publish" as const;
export const HUMAN_LIVE_SHADOW_MESSAGE_REQUEST_DOMAIN_V1 =
  "nautilo/lattice-crypto/human-live-shadow-message-request/v1";
export const LIVE_SHADOW_MESSAGE_NORMALIZATION_VERSION_V1 = 1 as const;
export const LIVE_SHADOW_MESSAGE_REQUEST_MAX_TTL_MS_V1 = 30_000;
export const MAX_LIVE_SHADOW_MESSAGE_PLAN_WIRE_BYTES_V1 = 8 * 1024;
export const MAX_HUMAN_LIVE_SHADOW_MESSAGE_REQUEST_WIRE_BYTES_V1 = 16 * 1024;

const HASH_BYTES = 32;
const RECIPIENT_PUBLIC_KEY_BYTES = 65;
const AGENT_SIGNER_PUBLIC_KEY_BYTES = V2_LIMITS.signingPublicKeyBytes;
const PG_SERIAL_MAX = 2_147_483_647;
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

export interface LiveShadowMessagePlanV1 {
  readonly formatVersion: typeof LIVE_SHADOW_MESSAGE_PLAN_FORMAT_VERSION_V1;
  readonly purpose: typeof LIVE_SHADOW_MESSAGE_PLAN_PURPOSE_V1;
  readonly operationId: string;
  readonly policyRevision: number;
  readonly sessionId: string;
  readonly roomId: string;
  readonly humanMessageId: number;
  readonly revision: 0;
  readonly createdAt: UnixTimestamp;
  readonly subjectHumanId: HumanId;
  readonly committerDeviceId: CryptoDeviceId;
  readonly hostAuthorizationRevision: AuthorizationRevision;
  readonly recipientAgentId: AgentId;
  readonly agentAuthorizationRevision: AuthorizationRevision;
  readonly agentRuntimeGeneration: number;
  readonly agentSignerKeyId: string;
  readonly agentSignerPublicKey: Uint8Array;
  readonly namespaceId: NamespaceId;
  readonly namespaceBindingHash: Uint8Array;
  readonly namespaceAccessRevision: number;
  readonly namespaceKeyGeneration: number;
  readonly bindingRevisionAtWrap: number;
  readonly domainId: CryptoDomainId;
  readonly domainEpoch: number;
  readonly recipientId: string;
  readonly recipientKeyId: string;
  readonly recipientPublicKey: Uint8Array;
  readonly attemptCoordinate: string;
  readonly issuedAt: UnixTimestamp;
  readonly deadlineAt: UnixTimestamp;
}

export interface HumanLiveShadowMessageRequestUnsignedV1 {
  readonly formatVersion:
    typeof HUMAN_LIVE_SHADOW_MESSAGE_REQUEST_FORMAT_VERSION_V1;
  readonly purpose: typeof HUMAN_LIVE_SHADOW_MESSAGE_REQUEST_PURPOSE_V1;
  readonly normalizationVersion:
    typeof LIVE_SHADOW_MESSAGE_NORMALIZATION_VERSION_V1;
  readonly subjectHumanId: HumanId;
  readonly operationId: string;
  readonly policyRevision: number;
  readonly sessionId: string;
  readonly roomId: string;
  readonly messageId: number;
  readonly revision: 0;
  readonly createdAt: UnixTimestamp;
  readonly recipientAgentId: AgentId;
  readonly agentAuthorizationRevision: AuthorizationRevision;
  readonly cryptoObjectId: ObjectId;
  readonly namespaceId: NamespaceId;
  readonly namespaceBindingHash: Uint8Array;
  readonly namespaceAccessRevision: number;
  readonly namespaceKeyGeneration: number;
  readonly bindingRevisionAtWrap: number;
  readonly domainId: CryptoDomainId;
  readonly domainEpoch: number;
  readonly recipientKeyId: string;
  readonly grantId: string;
  readonly grantDigest: Uint8Array;
  readonly grantExpiresAt: UnixTimestamp;
  readonly planDigest: Uint8Array;
  readonly plaintextPayloadDigest: Uint8Array;
  readonly encryptedPayloadDigest: Uint8Array;
  readonly manifestDigest: Uint8Array;
  readonly envelopeDigest: Uint8Array;
  readonly issuedAt: UnixTimestamp;
  readonly deadlineAt: UnixTimestamp;
  readonly committerDeviceId: CryptoDeviceId;
  readonly hostAuthorizationRevision: AuthorizationRevision;
}

export interface HumanLiveShadowMessageRequestV1
  extends HumanLiveShadowMessageRequestUnsignedV1 {
  readonly signature: Uint8Array;
}

export interface PrepareHumanLiveShadowMessageRequestInputV1
  extends Omit<
    HumanLiveShadowMessageRequestUnsignedV1,
    "formatVersion" | "purpose" | "normalizationVersion"
  > {
  readonly committerSigningPublicKey: Uint8Array;
  readonly committerSigningPrivateKey: Uint8Array;
}

export interface CreatedHumanLiveShadowMessageRequestV1 {
  readonly request: HumanLiveShadowMessageRequestV1;
  readonly bytes: Uint8Array;
  readonly requestDigest: Uint8Array;
}

export type ResolveCurrentHumanLiveShadowMessageAuthorityV1 = (
  context: Readonly<{
    purpose: "human-live-shadow-message-verify";
    subjectHumanId: HumanId;
    operationId: string;
    committerDeviceId: CryptoDeviceId;
    hostAuthorizationRevision: AuthorizationRevision;
  }>,
) => Uint8Array | null;

const PLAN_FIELDS = Object.freeze([
  "formatVersion", "purpose", "operationId", "policyRevision", "sessionId",
  "roomId", "humanMessageId", "revision", "createdAt", "subjectHumanId",
  "committerDeviceId", "hostAuthorizationRevision", "recipientAgentId",
  "agentAuthorizationRevision", "agentRuntimeGeneration",
  "agentSignerKeyId", "agentSignerPublicKey", "namespaceId", "namespaceBindingHash",
  "namespaceAccessRevision", "namespaceKeyGeneration", "bindingRevisionAtWrap",
  "domainId", "domainEpoch", "recipientId", "recipientKeyId",
  "recipientPublicKey", "attemptCoordinate", "issuedAt", "deadlineAt",
] as const);
const REQUEST_UNSIGNED_FIELDS = Object.freeze([
  "formatVersion", "purpose", "normalizationVersion", "subjectHumanId",
  "operationId", "policyRevision", "sessionId", "roomId", "messageId",
  "revision", "createdAt", "recipientAgentId", "agentAuthorizationRevision",
  "cryptoObjectId", "namespaceId", "namespaceBindingHash",
  "namespaceAccessRevision", "namespaceKeyGeneration", "bindingRevisionAtWrap",
  "domainId", "domainEpoch", "recipientKeyId", "grantId", "grantDigest",
  "grantExpiresAt", "planDigest", "plaintextPayloadDigest",
  "encryptedPayloadDigest", "manifestDigest", "envelopeDigest", "issuedAt",
  "deadlineAt", "committerDeviceId", "hostAuthorizationRevision",
] as const);
const REQUEST_FIELDS = Object.freeze([...REQUEST_UNSIGNED_FIELDS, "signature"]);

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

function exactHumanLiveShadowSigningPublicKey(value: unknown): Uint8Array {
  return exactBytes("Human live Shadow signing public key", value, V2_LIMITS.signingPublicKeyBytes);
}

function exactUuid(label: string, value: unknown): string {
  if (typeof value !== "string" || !UUID.test(value)) {
    throw new TypeError(`${label} must be a canonical UUID`);
  }
  return value;
}

function counter(label: string, value: unknown, minimum = 0): number {
  if (
    !Number.isSafeInteger(value)
    || (value as number) < minimum
    || (value as number) > Number.MAX_SAFE_INTEGER
  ) throw new RangeError(`${label} is invalid`);
  return value as number;
}

function exactHumanLiveShadowSigningPrivateKey(value: unknown): Uint8Array {
  return exactBytes("Human live Shadow signing private key", value, V2_LIMITS.signingPrivateKeyBytes);
}

function messageId(value: unknown): number {
  const result = counter("Live Shadow Message ID", value, 1);
  if (result > PG_SERIAL_MAX) throw new RangeError("Live Shadow Message ID is invalid");
  return result;
}

function portable(label: string, value: unknown): string {
  assertPortableId(label, value);
  return value;
}

function validWindow(issuedAt: UnixTimestamp, deadlineAt: UnixTimestamp): void {
  if (
    deadlineAt <= issuedAt
    || deadlineAt - issuedAt > LIVE_SHADOW_MESSAGE_REQUEST_MAX_TTL_MS_V1
  ) throw new RangeError("Live Shadow Message lifetime is invalid");
}

function destroyPlan(value: LiveShadowMessagePlanV1): void {
  value.namespaceBindingHash.fill(0);
  value.recipientPublicKey.fill(0);
  value.agentSignerPublicKey.fill(0);
}

function normalizePlan(value: LiveShadowMessagePlanV1): LiveShadowMessagePlanV1 {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("Live Shadow Message plan must be an object");
  }
  exactFields("Live Shadow Message plan", value, PLAN_FIELDS);
  if (
    value.formatVersion !== LIVE_SHADOW_MESSAGE_PLAN_FORMAT_VERSION_V1
    || value.purpose !== LIVE_SHADOW_MESSAGE_PLAN_PURPOSE_V1
    || value.revision !== 0
  ) throw new TypeError("Live Shadow Message plan version, purpose, or revision is invalid");
  const issuedAt = unixTimestamp(value.issuedAt);
  const deadlineAt = unixTimestamp(value.deadlineAt);
  validWindow(issuedAt, deadlineAt);
  return Object.freeze({
    formatVersion: LIVE_SHADOW_MESSAGE_PLAN_FORMAT_VERSION_V1,
    purpose: LIVE_SHADOW_MESSAGE_PLAN_PURPOSE_V1,
    operationId: portable("Live Shadow operation ID", value.operationId),
    policyRevision: counter("Live Shadow policy revision", value.policyRevision, 1),
    sessionId: exactUuid("Live Shadow Session ID", value.sessionId),
    roomId: exactUuid("Live Shadow Room ID", value.roomId),
    humanMessageId: messageId(value.humanMessageId),
    revision: 0,
    createdAt: unixTimestamp(value.createdAt),
    subjectHumanId: humanId(value.subjectHumanId),
    committerDeviceId: cryptoDeviceId(value.committerDeviceId),
    hostAuthorizationRevision: authorizationRevision(value.hostAuthorizationRevision),
    recipientAgentId: agentId(value.recipientAgentId),
    agentAuthorizationRevision: authorizationRevision(value.agentAuthorizationRevision),
    agentRuntimeGeneration: counter(
      "Live Shadow Agent Runtime generation",
      value.agentRuntimeGeneration,
    ),
    agentSignerKeyId: portable(
      "Live Shadow Agent signer key ID",
      value.agentSignerKeyId,
    ),
    agentSignerPublicKey: exactBytes(
      "Live Shadow Agent signer public key",
      value.agentSignerPublicKey,
      AGENT_SIGNER_PUBLIC_KEY_BYTES,
    ),
    namespaceId: namespaceId(value.namespaceId),
    namespaceBindingHash: exactBytes("Live Shadow Namespace binding hash", value.namespaceBindingHash, HASH_BYTES),
    namespaceAccessRevision: accessRevision(value.namespaceAccessRevision),
    namespaceKeyGeneration: namespaceGeneration(value.namespaceKeyGeneration),
    bindingRevisionAtWrap: accessRevision(value.bindingRevisionAtWrap),
    domainId: cryptoDomainId(value.domainId),
    domainEpoch: domainEpoch(value.domainEpoch),
    recipientId: portable("Live Shadow recipient ID", value.recipientId),
    recipientKeyId: portable("Live Shadow recipient key ID", value.recipientKeyId),
    recipientPublicKey: exactBytes("Live Shadow recipient public key", value.recipientPublicKey, RECIPIENT_PUBLIC_KEY_BYTES),
    attemptCoordinate: portable("Live Shadow attempt coordinate", value.attemptCoordinate),
    issuedAt,
    deadlineAt,
  });
}

function planBytes(value: LiveShadowMessagePlanV1): Uint8Array {
  return concatV2(
    frameText(LIVE_SHADOW_MESSAGE_PLAN_DOMAIN_V1), encodeU32(value.formatVersion),
    frameText(value.purpose), frameText(value.operationId), encodeU64(value.policyRevision),
    frameText(value.sessionId), frameText(value.roomId), encodeU64(value.humanMessageId),
    encodeU64(value.revision), encodeU64(value.createdAt), frameText(value.subjectHumanId),
    frameText(value.committerDeviceId), encodeU64(value.hostAuthorizationRevision),
    frameText(value.recipientAgentId), encodeU64(value.agentAuthorizationRevision),
    encodeU64(value.agentRuntimeGeneration), frameText(value.agentSignerKeyId),
    frame(value.agentSignerPublicKey),
    frameText(value.namespaceId), frame(value.namespaceBindingHash),
    encodeU64(value.namespaceAccessRevision), encodeU64(value.namespaceKeyGeneration),
    encodeU64(value.bindingRevisionAtWrap), frameText(value.domainId),
    encodeU64(value.domainEpoch), frameText(value.recipientId),
    frameText(value.recipientKeyId), frame(value.recipientPublicKey),
    frameText(value.attemptCoordinate), encodeU64(value.issuedAt),
    encodeU64(value.deadlineAt),
  );
}

export function encodeLiveShadowMessagePlanV1(
  value: LiveShadowMessagePlanV1,
): Uint8Array {
  const normalized = normalizePlan(value);
  try {
    const bytes = planBytes(normalized);
    if (bytes.length > MAX_LIVE_SHADOW_MESSAGE_PLAN_WIRE_BYTES_V1) {
      bytes.fill(0);
      throw new RangeError("Live Shadow Message plan exceeds its wire limit");
    }
    return bytes;
  } finally {
    destroyPlan(normalized);
  }
}

export function decodeLiveShadowMessagePlanV1(bytes: Uint8Array): LiveShadowMessagePlanV1 {
  if (!(bytes instanceof Uint8Array) || bytes.length > MAX_LIVE_SHADOW_MESSAGE_PLAN_WIRE_BYTES_V1) {
    throw new TypeError("Live Shadow Message plan bytes are invalid");
  }
  const raw = decodeExact(bytes, (reader): LiveShadowMessagePlanV1 => {
    if (reader.readText(utf8V2(LIVE_SHADOW_MESSAGE_PLAN_DOMAIN_V1).length) !== LIVE_SHADOW_MESSAGE_PLAN_DOMAIN_V1) {
      throw new CanonicalDecodingError("Live Shadow Message plan domain mismatch");
    }
    return {
      formatVersion: reader.readVersion(1) as 1,
      purpose: reader.readText(64) as typeof LIVE_SHADOW_MESSAGE_PLAN_PURPOSE_V1,
      operationId: reader.readText(V2_LIMITS.idBytes),
      policyRevision: reader.readU64(),
      sessionId: reader.readText(36),
      roomId: reader.readText(36),
      humanMessageId: reader.readU64(),
      revision: reader.readU64() as 0,
      createdAt: unixTimestamp(reader.readU64()),
      subjectHumanId: humanId(reader.readText(V2_LIMITS.idBytes)),
      committerDeviceId: cryptoDeviceId(reader.readText(V2_LIMITS.idBytes)),
      hostAuthorizationRevision: authorizationRevision(reader.readU64()),
      recipientAgentId: agentId(reader.readText(V2_LIMITS.idBytes)),
      agentAuthorizationRevision: authorizationRevision(reader.readU64()),
      agentRuntimeGeneration: reader.readU64(),
      agentSignerKeyId: reader.readText(V2_LIMITS.idBytes),
      agentSignerPublicKey: reader.readFrame(AGENT_SIGNER_PUBLIC_KEY_BYTES),
      namespaceId: namespaceId(reader.readText(V2_LIMITS.idBytes)),
      namespaceBindingHash: reader.readFrame(HASH_BYTES),
      namespaceAccessRevision: reader.readU64(),
      namespaceKeyGeneration: reader.readU64(),
      bindingRevisionAtWrap: reader.readU64(),
      domainId: cryptoDomainId(reader.readText(V2_LIMITS.idBytes)),
      domainEpoch: reader.readU64(),
      recipientId: reader.readText(V2_LIMITS.idBytes),
      recipientKeyId: reader.readText(V2_LIMITS.idBytes),
      recipientPublicKey: reader.readFrame(RECIPIENT_PUBLIC_KEY_BYTES),
      attemptCoordinate: reader.readText(V2_LIMITS.idBytes),
      issuedAt: unixTimestamp(reader.readU64()),
      deadlineAt: unixTimestamp(reader.readU64()),
    };
  });
  let normalized: LiveShadowMessagePlanV1 | undefined;
  let canonical: Uint8Array | undefined;
  try {
    normalized = normalizePlan(raw);
    canonical = planBytes(normalized);
    if (!sameBytes(canonical, bytes)) throw new CanonicalDecodingError("Live Shadow Message plan is noncanonical");
    const result = normalized;
    normalized = undefined;
    return result;
  } finally {
    destroyPlan(raw);
    if (normalized) destroyPlan(normalized);
    canonical?.fill(0);
  }
}

export function liveShadowMessagePlanDigestV1(
  crypto: LatticeCrypto,
  planBytesValue: Uint8Array,
): Uint8Array {
  const plan = decodeLiveShadowMessagePlanV1(planBytesValue);
  try {
    return crypto.hash(planBytesValue);
  } finally {
    destroyPlan(plan);
  }
}

function destroyUnsigned(value: HumanLiveShadowMessageRequestUnsignedV1): void {
  value.namespaceBindingHash.fill(0);
  value.grantDigest.fill(0);
  value.planDigest.fill(0);
  value.plaintextPayloadDigest.fill(0);
  value.encryptedPayloadDigest.fill(0);
  value.manifestDigest.fill(0);
  value.envelopeDigest.fill(0);
}

function destroyRequest(value: HumanLiveShadowMessageRequestV1): void {
  destroyUnsigned(value);
  value.signature.fill(0);
}

function normalizeUnsigned(
  value: HumanLiveShadowMessageRequestUnsignedV1,
): HumanLiveShadowMessageRequestUnsignedV1 {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("Human live Shadow Message request must be an object");
  }
  exactFields("Human live Shadow Message request", value, REQUEST_UNSIGNED_FIELDS);
  if (
    value.formatVersion !== HUMAN_LIVE_SHADOW_MESSAGE_REQUEST_FORMAT_VERSION_V1
    || value.purpose !== HUMAN_LIVE_SHADOW_MESSAGE_REQUEST_PURPOSE_V1
    || value.normalizationVersion !== LIVE_SHADOW_MESSAGE_NORMALIZATION_VERSION_V1
    || value.revision !== 0
  ) throw new TypeError("Human live Shadow Message request version, purpose, normalization, or revision is invalid");
  const issuedAt = unixTimestamp(value.issuedAt);
  const deadlineAt = unixTimestamp(value.deadlineAt);
  const grantExpiresAt = unixTimestamp(value.grantExpiresAt);
  validWindow(issuedAt, deadlineAt);
  if (grantExpiresAt < deadlineAt) throw new RangeError("Live Shadow Grant expires before its request");
  const owned: Uint8Array[] = [];
  try {
    const copyHash = (label: string, bytes: Uint8Array): Uint8Array => {
      const copied = exactBytes(label, bytes, HASH_BYTES);
      owned.push(copied);
      return copied;
    };
    const normalized = Object.freeze({
      formatVersion: HUMAN_LIVE_SHADOW_MESSAGE_REQUEST_FORMAT_VERSION_V1,
      purpose: HUMAN_LIVE_SHADOW_MESSAGE_REQUEST_PURPOSE_V1,
      normalizationVersion: LIVE_SHADOW_MESSAGE_NORMALIZATION_VERSION_V1,
      subjectHumanId: humanId(value.subjectHumanId),
      operationId: portable("Human live Shadow operation ID", value.operationId),
      policyRevision: counter("Human live Shadow policy revision", value.policyRevision, 1),
      sessionId: exactUuid("Human live Shadow Session ID", value.sessionId),
      roomId: exactUuid("Human live Shadow Room ID", value.roomId),
      messageId: messageId(value.messageId),
      revision: 0 as const,
      createdAt: unixTimestamp(value.createdAt),
      recipientAgentId: agentId(value.recipientAgentId),
      agentAuthorizationRevision: authorizationRevision(value.agentAuthorizationRevision),
      cryptoObjectId: objectId(value.cryptoObjectId),
      namespaceId: namespaceId(value.namespaceId),
      namespaceBindingHash: copyHash("Human live Shadow Namespace binding hash", value.namespaceBindingHash),
      namespaceAccessRevision: accessRevision(value.namespaceAccessRevision),
      namespaceKeyGeneration: namespaceGeneration(value.namespaceKeyGeneration),
      bindingRevisionAtWrap: accessRevision(value.bindingRevisionAtWrap),
      domainId: cryptoDomainId(value.domainId),
      domainEpoch: domainEpoch(value.domainEpoch),
      recipientKeyId: portable("Human live Shadow recipient key ID", value.recipientKeyId),
      grantId: portable("Human live Shadow Grant ID", value.grantId),
      grantDigest: copyHash("Human live Shadow Grant digest", value.grantDigest),
      grantExpiresAt,
      planDigest: copyHash("Human live Shadow plan digest", value.planDigest),
      plaintextPayloadDigest: copyHash("Human live Shadow plaintext payload digest", value.plaintextPayloadDigest),
      encryptedPayloadDigest: copyHash("Human live Shadow encrypted payload digest", value.encryptedPayloadDigest),
      manifestDigest: copyHash("Human live Shadow manifest digest", value.manifestDigest),
      envelopeDigest: copyHash("Human live Shadow envelope digest", value.envelopeDigest),
      issuedAt,
      deadlineAt,
      committerDeviceId: cryptoDeviceId(value.committerDeviceId),
      hostAuthorizationRevision: authorizationRevision(value.hostAuthorizationRevision),
    });
    owned.length = 0;
    return normalized;
  } finally {
    for (const bytes of owned) bytes.fill(0);
  }
}

function requestSigningBytes(value: HumanLiveShadowMessageRequestUnsignedV1): Uint8Array {
  return concatV2(
    frameText(HUMAN_LIVE_SHADOW_MESSAGE_REQUEST_DOMAIN_V1), encodeU32(value.formatVersion),
    frameText(value.purpose), encodeU32(value.normalizationVersion),
    frameText(value.subjectHumanId), frameText(value.operationId), encodeU64(value.policyRevision),
    frameText(value.sessionId), frameText(value.roomId), encodeU64(value.messageId),
    encodeU64(value.revision), encodeU64(value.createdAt), frameText(value.recipientAgentId),
    encodeU64(value.agentAuthorizationRevision), frameText(value.cryptoObjectId),
    frameText(value.namespaceId), frame(value.namespaceBindingHash),
    encodeU64(value.namespaceAccessRevision), encodeU64(value.namespaceKeyGeneration),
    encodeU64(value.bindingRevisionAtWrap), frameText(value.domainId),
    encodeU64(value.domainEpoch), frameText(value.recipientKeyId), frameText(value.grantId),
    frame(value.grantDigest), encodeU64(value.grantExpiresAt), frame(value.planDigest),
    frame(value.plaintextPayloadDigest), frame(value.encryptedPayloadDigest),
    frame(value.manifestDigest), frame(value.envelopeDigest), encodeU64(value.issuedAt),
    encodeU64(value.deadlineAt), frameText(value.committerDeviceId),
    encodeU64(value.hostAuthorizationRevision),
  );
}

function normalizeRequest(value: HumanLiveShadowMessageRequestV1): HumanLiveShadowMessageRequestV1 {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("Human live Shadow Message request must be an object");
  }
  exactFields("Human live Shadow Message request", value, REQUEST_FIELDS);
  const { signature, ...unsignedValue } = value;
  const unsigned = normalizeUnsigned(unsignedValue);
  try {
    return Object.freeze({
      ...unsigned,
      signature: exactBytes("Human live Shadow Message signature", signature, V2_LIMITS.signatureBytes),
    });
  } catch (error) {
    destroyUnsigned(unsigned);
    throw error;
  }
}

export function humanLiveShadowMessageRequestSigningBytesV1(
  value: HumanLiveShadowMessageRequestUnsignedV1,
): Uint8Array {
  const normalized = normalizeUnsigned(value);
  try {
    return requestSigningBytes(normalized);
  } finally {
    destroyUnsigned(normalized);
  }
}

export function encodeHumanLiveShadowMessageRequestV1(
  value: HumanLiveShadowMessageRequestV1,
): Uint8Array {
  const normalized = normalizeRequest(value);
  try {
    const bytes = concatV2(requestSigningBytes(normalized), frame(normalized.signature));
    if (bytes.length > MAX_HUMAN_LIVE_SHADOW_MESSAGE_REQUEST_WIRE_BYTES_V1) {
      bytes.fill(0);
      throw new RangeError("Human live Shadow Message request exceeds its wire limit");
    }
    return bytes;
  } finally {
    destroyRequest(normalized);
  }
}

export function decodeHumanLiveShadowMessageRequestV1(
  bytes: Uint8Array,
): HumanLiveShadowMessageRequestV1 {
  if (!(bytes instanceof Uint8Array) || bytes.length > MAX_HUMAN_LIVE_SHADOW_MESSAGE_REQUEST_WIRE_BYTES_V1) {
    throw new TypeError("Human live Shadow Message request bytes are invalid");
  }
  const raw = decodeExact(bytes, (reader): HumanLiveShadowMessageRequestV1 => {
    if (reader.readText(utf8V2(HUMAN_LIVE_SHADOW_MESSAGE_REQUEST_DOMAIN_V1).length) !== HUMAN_LIVE_SHADOW_MESSAGE_REQUEST_DOMAIN_V1) {
      throw new CanonicalDecodingError("Human live Shadow Message request domain mismatch");
    }
    return {
      formatVersion: reader.readVersion(1) as 1,
      purpose: reader.readText(64) as typeof HUMAN_LIVE_SHADOW_MESSAGE_REQUEST_PURPOSE_V1,
      normalizationVersion: reader.readU32() as 1,
      subjectHumanId: humanId(reader.readText(V2_LIMITS.idBytes)),
      operationId: reader.readText(V2_LIMITS.idBytes),
      policyRevision: reader.readU64(),
      sessionId: reader.readText(36),
      roomId: reader.readText(36),
      messageId: reader.readU64(),
      revision: reader.readU64() as 0,
      createdAt: unixTimestamp(reader.readU64()),
      recipientAgentId: agentId(reader.readText(V2_LIMITS.idBytes)),
      agentAuthorizationRevision: authorizationRevision(reader.readU64()),
      cryptoObjectId: objectId(reader.readText(V2_LIMITS.idBytes)),
      namespaceId: namespaceId(reader.readText(V2_LIMITS.idBytes)),
      namespaceBindingHash: reader.readFrame(HASH_BYTES),
      namespaceAccessRevision: reader.readU64(),
      namespaceKeyGeneration: reader.readU64(),
      bindingRevisionAtWrap: reader.readU64(),
      domainId: cryptoDomainId(reader.readText(V2_LIMITS.idBytes)),
      domainEpoch: reader.readU64(),
      recipientKeyId: reader.readText(V2_LIMITS.idBytes),
      grantId: reader.readText(V2_LIMITS.idBytes),
      grantDigest: reader.readFrame(HASH_BYTES),
      grantExpiresAt: unixTimestamp(reader.readU64()),
      planDigest: reader.readFrame(HASH_BYTES),
      plaintextPayloadDigest: reader.readFrame(HASH_BYTES),
      encryptedPayloadDigest: reader.readFrame(HASH_BYTES),
      manifestDigest: reader.readFrame(HASH_BYTES),
      envelopeDigest: reader.readFrame(HASH_BYTES),
      issuedAt: unixTimestamp(reader.readU64()),
      deadlineAt: unixTimestamp(reader.readU64()),
      committerDeviceId: cryptoDeviceId(reader.readText(V2_LIMITS.idBytes)),
      hostAuthorizationRevision: authorizationRevision(reader.readU64()),
      signature: reader.readFrame(V2_LIMITS.signatureBytes),
    };
  });
  let normalized: HumanLiveShadowMessageRequestV1 | undefined;
  let canonical: Uint8Array | undefined;
  try {
    normalized = normalizeRequest(raw);
    canonical = concatV2(requestSigningBytes(normalized), frame(normalized.signature));
    if (!sameBytes(canonical, bytes)) throw new CanonicalDecodingError("Human live Shadow Message request is noncanonical");
    const result = normalized;
    normalized = undefined;
    return result;
  } finally {
    destroyRequest(raw);
    if (normalized) destroyRequest(normalized);
    canonical?.fill(0);
  }
}

export function prepareHumanLiveShadowMessageRequestV1(
  crypto: LatticeCrypto,
  input: PrepareHumanLiveShadowMessageRequestInputV1,
): CreatedHumanLiveShadowMessageRequestV1 {
  const { committerSigningPublicKey, committerSigningPrivateKey, ...rest } = input;
  const unsigned = normalizeUnsigned({
    ...rest,
    formatVersion: 1,
    purpose: HUMAN_LIVE_SHADOW_MESSAGE_REQUEST_PURPOSE_V1,
    normalizationVersion: 1,
  });
  let publicKey: Uint8Array | undefined;
  let secretKey: Uint8Array | undefined;
  let signing: Uint8Array | undefined;
  let signature: Uint8Array | undefined;
  try {
    publicKey = exactHumanLiveShadowSigningPublicKey(committerSigningPublicKey);
    secretKey = exactHumanLiveShadowSigningPrivateKey(committerSigningPrivateKey);
    signing = requestSigningBytes(unsigned);
    signature = exactBytes("Human live Shadow Message signature", crypto.sign(secretKey, signing), V2_LIMITS.signatureBytes);
    if (!crypto.verify(publicKey, signing, signature)) throw new TypeError("Human live Shadow Message signing keys do not match");
    const bytes = encodeHumanLiveShadowMessageRequestV1({ ...unsigned, signature });
    return Object.freeze({
      request: decodeHumanLiveShadowMessageRequestV1(bytes),
      bytes,
      requestDigest: crypto.hash(bytes),
    });
  } finally {
    destroyUnsigned(unsigned);
    publicKey?.fill(0); secretKey?.fill(0); signing?.fill(0); signature?.fill(0);
  }
}

function verifySignature(
  crypto: LatticeCrypto,
  bytes: Uint8Array,
  resolveCurrentAuthority: ResolveCurrentHumanLiveShadowMessageAuthorityV1,
): HumanLiveShadowMessageRequestV1 {
  const request = decodeHumanLiveShadowMessageRequestV1(bytes);
  let publicKey: Uint8Array | undefined;
  let signing: Uint8Array | undefined;
  let ok = false;
  try {
    const resolved = resolveCurrentAuthority(Object.freeze({
      purpose: "human-live-shadow-message-verify" as const,
      subjectHumanId: request.subjectHumanId,
      operationId: request.operationId,
      committerDeviceId: request.committerDeviceId,
      hostAuthorizationRevision: request.hostAuthorizationRevision,
    }));
    if (resolved === null) throw new TypeError("Human live Shadow Message authority is unavailable");
    publicKey = exactBytes("Human live Shadow Message authority public key", resolved, V2_LIMITS.signingPublicKeyBytes);
    signing = requestSigningBytes(request);
    if (!crypto.verify(publicKey, signing, request.signature)) throw new TypeError("Human live Shadow Message signature is invalid");
    ok = true;
    return request;
  } finally {
    publicKey?.fill(0); signing?.fill(0);
    if (!ok) destroyRequest(request);
  }
}

export function verifyHumanLiveShadowMessageRequestV1(
  crypto: LatticeCrypto,
  input: Readonly<{
    requestBytes: Uint8Array;
    now: UnixTimestamp;
    resolveCurrentAuthority: ResolveCurrentHumanLiveShadowMessageAuthorityV1;
  }>,
): HumanLiveShadowMessageRequestV1 {
  const request = verifySignature(crypto, input.requestBytes, input.resolveCurrentAuthority);
  let ok = false;
  try {
    const now = unixTimestamp(input.now);
    if (now < request.issuedAt || now >= request.deadlineAt || now >= request.grantExpiresAt) {
      throw new TypeError("Human live Shadow Message request is not currently valid");
    }
    ok = true;
    return request;
  } finally {
    if (!ok) destroyRequest(request);
  }
}

export function verifyHumanLiveShadowMessageRequestExactReplayV1(
  crypto: LatticeCrypto,
  input: Readonly<{
    requestBytes: Uint8Array;
    expectedRequestDigest: Uint8Array;
    resolveCurrentAuthority: ResolveCurrentHumanLiveShadowMessageAuthorityV1;
  }>,
): HumanLiveShadowMessageRequestV1 {
  const expected = exactBytes("Human live Shadow durable request digest", input.expectedRequestDigest, HASH_BYTES);
  const actual = crypto.hash(input.requestBytes);
  try {
    if (!sameBytes(actual, expected)) throw new TypeError("Human live Shadow durable request digest disagrees");
    return verifySignature(crypto, input.requestBytes, input.resolveCurrentAuthority);
  } finally {
    expected.fill(0); actual.fill(0);
  }
}

export function humanLiveShadowMessageRequestDigestV1(
  crypto: LatticeCrypto,
  bytes: Uint8Array,
): Uint8Array {
  const request = decodeHumanLiveShadowMessageRequestV1(bytes);
  try {
    return crypto.hash(bytes);
  } finally {
    destroyRequest(request);
  }
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length
    && left.every((byte, index) => byte === right[index]);
}
