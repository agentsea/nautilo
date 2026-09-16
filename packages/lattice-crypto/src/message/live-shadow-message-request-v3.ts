import { sha256 } from "@noble/hashes/sha2.js";

import type { LatticeCrypto } from "../crypto/index.ts";
import {
  destroyDeviceWrappedDomainAgentGrantPlanV1,
  parseDeviceWrappedDomainAgentGrantPlanV1,
} from "../format/device-wrapped-domain-agent-grant-v1.ts";
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
  grantId,
  humanId,
  namespaceGeneration,
  namespaceId,
  objectId,
  unixTimestamp,
  type AgentId,
  type AuthorizationRevision,
  type CryptoDeviceId,
  type GrantId,
  type HumanId,
  type NamespaceId,
  type ObjectId,
  type UnixTimestamp,
} from "../v2-types/ids.ts";
import { V2_LIMITS } from "../v2-types/limits.ts";
import { copyOwnedBytesV2 } from "../v2-types/opaque.ts";

export const LIVE_SHADOW_MESSAGE_PLAN_FORMAT_VERSION_V3 = 3 as const;
export const LIVE_SHADOW_MESSAGE_PLAN_PURPOSE_V3 =
  "message.live_shadow_plan" as const;
export const LIVE_SHADOW_MESSAGE_PLAN_DOMAIN_V3 =
  "nautilo/lattice-crypto/live-shadow-message-plan/v3";
export const HUMAN_LIVE_SHADOW_MESSAGE_REQUEST_FORMAT_VERSION_V3 = 3 as const;
export const HUMAN_LIVE_SHADOW_MESSAGE_REQUEST_PURPOSE_V3 =
  "message.live_shadow_human_publish" as const;
export const HUMAN_LIVE_SHADOW_MESSAGE_REQUEST_DOMAIN_V3 =
  "nautilo/lattice-crypto/human-live-shadow-message-request/v3";
export const LIVE_SHADOW_MESSAGE_NORMALIZATION_VERSION_V3 = 1 as const;
export const LIVE_SHADOW_MESSAGE_REQUEST_MAX_TTL_MS_V3 = 30_000;
export const MAX_LIVE_SHADOW_MESSAGE_PLAN_WIRE_BYTES_V3 = 256 * 1024;
export const MAX_HUMAN_LIVE_SHADOW_MESSAGE_REQUEST_WIRE_BYTES_V3 =
  16 * 1024;

const HASH_BYTES = 32;
const RECIPIENT_PUBLIC_KEY_BYTES = V2_LIMITS.hpkePublicKeyBytes;
const AGENT_SIGNER_PUBLIC_KEY_BYTES = V2_LIMITS.signingPublicKeyBytes;
const PG_SERIAL_MAX = 2_147_483_647;
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

export interface LiveShadowMessagePlanV3 {
  readonly formatVersion: typeof LIVE_SHADOW_MESSAGE_PLAN_FORMAT_VERSION_V3;
  readonly purpose: typeof LIVE_SHADOW_MESSAGE_PLAN_PURPOSE_V3;
  readonly operationId: string;
  readonly policyRevision: number;
  readonly sessionId: string;
  readonly roomId: string;
  readonly humanMessageId: number;
  readonly revision: 0;
  readonly createdAt: UnixTimestamp;
  readonly subjectHumanId: HumanId;
  readonly committerDeviceId: CryptoDeviceId;
  readonly committerDeviceSigningKeyGeneration: number;
  readonly hostAuthorizationRevision: AuthorizationRevision;
  readonly recipientAgentId: AgentId;
  readonly agentAuthorizationRevision: AuthorizationRevision;
  readonly agentRuntimeGeneration: number;
  readonly agentSignerKeyId: string;
  readonly agentSignerPublicKey: Uint8Array;
  readonly namespaceId: NamespaceId;
  readonly namespaceAccessRevision: number;
  readonly namespaceKeyGeneration: number;
  readonly namespaceHeadDigest: Uint8Array;
  readonly namespacePublicationDigest: Uint8Array;
  readonly namespacePublicationSetDigest: Uint8Array;
  readonly namespaceAudienceFingerprint: Uint8Array;
  readonly grantDomainId: string;
  readonly grantDomainParticipantDigest: Uint8Array;
  readonly grantDomainKeyGeneration: number;
  readonly grantDomainHeadDigest: Uint8Array;
  readonly grantDomainPublicationDigest: Uint8Array;
  readonly grantDomainAuthorizationRevision: AuthorizationRevision;
  readonly namespaceBundleRevision: number;
  readonly namespaceBundleDigest: Uint8Array;
  readonly agentGrantPlanBytes: Uint8Array;
  readonly agentGrantPlanDigest: Uint8Array;
  readonly recipientId: string;
  readonly recipientKeyId: string;
  readonly recipientPublicKey: Uint8Array;
  readonly attemptCoordinate: string;
  readonly issuedAt: UnixTimestamp;
  readonly deadlineAt: UnixTimestamp;
}

export interface HumanLiveShadowMessageRequestUnsignedV3 {
  readonly formatVersion:
    typeof HUMAN_LIVE_SHADOW_MESSAGE_REQUEST_FORMAT_VERSION_V3;
  readonly purpose: typeof HUMAN_LIVE_SHADOW_MESSAGE_REQUEST_PURPOSE_V3;
  readonly normalizationVersion:
    typeof LIVE_SHADOW_MESSAGE_NORMALIZATION_VERSION_V3;
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
  readonly namespaceAccessRevision: number;
  readonly namespaceKeyGeneration: number;
  readonly namespaceHeadDigest: Uint8Array;
  readonly namespacePublicationDigest: Uint8Array;
  readonly namespacePublicationSetDigest: Uint8Array;
  readonly namespaceAudienceFingerprint: Uint8Array;
  readonly recipientKeyId: string;
  readonly grantId: GrantId;
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
  readonly committerDeviceSigningKeyGeneration: number;
  readonly hostAuthorizationRevision: AuthorizationRevision;
}

export interface HumanLiveShadowMessageRequestV3
  extends HumanLiveShadowMessageRequestUnsignedV3 {
  readonly signature: Uint8Array;
}

export interface PrepareHumanLiveShadowMessageRequestInputV3
  extends Omit<
    HumanLiveShadowMessageRequestUnsignedV3,
    "formatVersion" | "purpose" | "normalizationVersion"
  > {
  readonly committerSigningPublicKey: Uint8Array;
  readonly committerSigningPrivateKey: Uint8Array;
}

export interface CreatedHumanLiveShadowMessageRequestV3 {
  readonly request: HumanLiveShadowMessageRequestV3;
  readonly bytes: Uint8Array;
  readonly requestDigest: Uint8Array;
}

export type ResolveCurrentHumanLiveShadowMessageAuthorityV3 = (
  context: Readonly<{
    purpose: "human-live-shadow-message-v3-verify";
    subjectHumanId: HumanId;
    operationId: string;
    committerDeviceId: CryptoDeviceId;
    committerDeviceSigningKeyGeneration: number;
    hostAuthorizationRevision: AuthorizationRevision;
  }>,
) => Uint8Array | null;

const PLAN_FIELDS = Object.freeze([
  "formatVersion", "purpose", "operationId", "policyRevision", "sessionId",
  "roomId", "humanMessageId", "revision", "createdAt", "subjectHumanId",
  "committerDeviceId", "committerDeviceSigningKeyGeneration",
  "hostAuthorizationRevision", "recipientAgentId",
  "agentAuthorizationRevision", "agentRuntimeGeneration",
  "agentSignerKeyId", "agentSignerPublicKey", "namespaceId",
  "namespaceAccessRevision", "namespaceKeyGeneration", "namespaceHeadDigest",
  "namespacePublicationDigest", "namespacePublicationSetDigest",
  "namespaceAudienceFingerprint", "grantDomainId",
  "grantDomainParticipantDigest", "grantDomainKeyGeneration",
  "grantDomainHeadDigest", "grantDomainPublicationDigest",
  "grantDomainAuthorizationRevision", "namespaceBundleRevision",
  "namespaceBundleDigest", "agentGrantPlanBytes",
  "agentGrantPlanDigest", "recipientId", "recipientKeyId",
  "recipientPublicKey", "attemptCoordinate", "issuedAt", "deadlineAt",
] as const);
const REQUEST_UNSIGNED_FIELDS = Object.freeze([
  "formatVersion", "purpose", "normalizationVersion", "subjectHumanId",
  "operationId", "policyRevision", "sessionId", "roomId", "messageId",
  "revision", "createdAt", "recipientAgentId", "agentAuthorizationRevision",
  "cryptoObjectId", "namespaceId", "namespaceAccessRevision",
  "namespaceKeyGeneration", "namespaceHeadDigest",
  "namespacePublicationDigest", "namespacePublicationSetDigest",
  "namespaceAudienceFingerprint", "recipientKeyId", "grantId", "grantDigest",
  "grantExpiresAt", "planDigest", "plaintextPayloadDigest",
  "encryptedPayloadDigest", "manifestDigest", "envelopeDigest", "issuedAt",
  "deadlineAt", "committerDeviceId", "committerDeviceSigningKeyGeneration",
  "hostAuthorizationRevision",
] as const);

function exactFields(label: string, value: object, fields: readonly string[]) {
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

function boundedBytes(
  label: string,
  value: unknown,
  maximum: number,
): Uint8Array {
  if (!(value instanceof Uint8Array) || value.length < 1 || value.length > maximum) {
    throw new TypeError(`${label} has an invalid length`);
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
  const id = counter("Live Shadow Message ID", value, 1);
  if (id > PG_SERIAL_MAX) throw new RangeError("Live Shadow Message ID is invalid");
  return id;
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length
    && left.every((byte, index) => byte === right[index]);
}

function validWindow(issuedAt: UnixTimestamp, deadlineAt: UnixTimestamp): void {
  if (
    deadlineAt <= issuedAt
    || deadlineAt - issuedAt > LIVE_SHADOW_MESSAGE_REQUEST_MAX_TTL_MS_V3
  ) throw new RangeError("Live Shadow Message lifetime is invalid");
}

function destroyPlan(value: LiveShadowMessagePlanV3): void {
  value.agentSignerPublicKey.fill(0);
  value.namespaceHeadDigest.fill(0);
  value.namespacePublicationDigest.fill(0);
  value.namespacePublicationSetDigest.fill(0);
  value.namespaceAudienceFingerprint.fill(0);
  value.grantDomainParticipantDigest.fill(0);
  value.grantDomainHeadDigest.fill(0);
  value.grantDomainPublicationDigest.fill(0);
  value.namespaceBundleDigest.fill(0);
  value.agentGrantPlanBytes.fill(0);
  value.agentGrantPlanDigest.fill(0);
  value.recipientPublicKey.fill(0);
}

function normalizePlan(value: LiveShadowMessagePlanV3): LiveShadowMessagePlanV3 {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("Live Shadow Message V3 plan must be an object");
  }
  exactFields("Live Shadow Message V3 plan", value, PLAN_FIELDS);
  if (
    value.formatVersion !== 3
    || value.purpose !== LIVE_SHADOW_MESSAGE_PLAN_PURPOSE_V3
    || value.revision !== 0
  ) throw new TypeError("Live Shadow Message V3 plan shape is invalid");
  const issuedAt = unixTimestamp(value.issuedAt);
  const deadlineAt = unixTimestamp(value.deadlineAt);
  validWindow(issuedAt, deadlineAt);
  const grantPlanBytes = boundedBytes(
    "Live Shadow Namespace Agent Grant plan",
    value.agentGrantPlanBytes,
    MAX_LIVE_SHADOW_MESSAGE_PLAN_WIRE_BYTES_V3 / 2,
  );
  const grantPlanDigest = exactBytes(
    "Live Shadow Namespace Agent Grant plan digest",
    value.agentGrantPlanDigest,
    HASH_BYTES,
  );
  const parsedGrantPlan = parseDeviceWrappedDomainAgentGrantPlanV1(
    grantPlanBytes,
  );
  const actualGrantPlanDigest = sha256(grantPlanBytes);
  try {
    if (
      parsedGrantPlan === null
      || !sameBytes(actualGrantPlanDigest, grantPlanDigest)
      || parsedGrantPlan.operationId !== value.operationId
      || parsedGrantPlan.policyRevision !== value.policyRevision
      || parsedGrantPlan.sessionId !== value.sessionId
      || parsedGrantPlan.roomId !== value.roomId
      || parsedGrantPlan.subjectHumanId !== value.subjectHumanId
      || parsedGrantPlan.committerDeviceId !== value.committerDeviceId
      || parsedGrantPlan.committerDeviceSigningGeneration
        !== value.committerDeviceSigningKeyGeneration
      || parsedGrantPlan.hostAuthorizationRevision
        !== value.hostAuthorizationRevision
      || parsedGrantPlan.recipientAgentId !== value.recipientAgentId
      || parsedGrantPlan.recipientKeyId !== value.recipientKeyId
      || parsedGrantPlan.issuedAt !== issuedAt
      || parsedGrantPlan.deadlineAt !== deadlineAt
      || !parsedGrantPlan.domains.some((authority) =>
        authority.grantDomainId === value.grantDomainId
        && authority.domainKeyGeneration === value.grantDomainKeyGeneration
        && authority.authorizationRevision
          === value.grantDomainAuthorizationRevision
        && sameBytes(
          authority.participantDigest,
          value.grantDomainParticipantDigest,
        )
        && sameBytes(authority.headDigest, value.grantDomainHeadDigest)
        && sameBytes(
          authority.publicationDigest,
          value.grantDomainPublicationDigest,
        )
      )
    ) throw new TypeError("Live Shadow Namespace Agent Grant plan disagrees");
    return Object.freeze({
      formatVersion: 3,
      purpose: LIVE_SHADOW_MESSAGE_PLAN_PURPOSE_V3,
      operationId: portable("Live Shadow operation ID", value.operationId),
      policyRevision: counter("Live Shadow policy revision", value.policyRevision, 1),
      sessionId: uuid("Live Shadow Session ID", value.sessionId),
      roomId: uuid("Live Shadow Room ID", value.roomId),
      humanMessageId: messageId(value.humanMessageId),
      revision: 0,
      createdAt: unixTimestamp(value.createdAt),
      subjectHumanId: humanId(value.subjectHumanId),
      committerDeviceId: cryptoDeviceId(value.committerDeviceId),
      committerDeviceSigningKeyGeneration: counter(
        "Live Shadow device signing-key generation",
        value.committerDeviceSigningKeyGeneration,
      ),
      hostAuthorizationRevision: authorizationRevision(
        value.hostAuthorizationRevision,
      ),
      recipientAgentId: agentId(value.recipientAgentId),
      agentAuthorizationRevision: authorizationRevision(
        value.agentAuthorizationRevision,
      ),
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
      namespaceAccessRevision: accessRevision(value.namespaceAccessRevision),
      namespaceKeyGeneration: namespaceGeneration(value.namespaceKeyGeneration),
      namespaceHeadDigest: exactBytes(
        "Live Shadow Namespace head digest",
        value.namespaceHeadDigest,
        HASH_BYTES,
      ),
      namespacePublicationDigest: exactBytes(
        "Live Shadow Namespace publication digest",
        value.namespacePublicationDigest,
        HASH_BYTES,
      ),
      namespacePublicationSetDigest: exactBytes(
        "Live Shadow Namespace publication-set digest",
        value.namespacePublicationSetDigest,
        HASH_BYTES,
      ),
      namespaceAudienceFingerprint: exactBytes(
        "Live Shadow Namespace audience fingerprint",
        value.namespaceAudienceFingerprint,
        HASH_BYTES,
      ),
      grantDomainId: portable("Live Shadow Grant Domain ID", value.grantDomainId),
      grantDomainParticipantDigest: exactBytes(
        "Live Shadow Grant Domain participant digest",
        value.grantDomainParticipantDigest,
        HASH_BYTES,
      ),
      grantDomainKeyGeneration: counter(
        "Live Shadow Grant Domain key generation",
        value.grantDomainKeyGeneration,
        1,
      ),
      grantDomainHeadDigest: exactBytes(
        "Live Shadow Grant Domain head digest",
        value.grantDomainHeadDigest,
        HASH_BYTES,
      ),
      grantDomainPublicationDigest: exactBytes(
        "Live Shadow Grant Domain publication digest",
        value.grantDomainPublicationDigest,
        HASH_BYTES,
      ),
      grantDomainAuthorizationRevision: authorizationRevision(
        value.grantDomainAuthorizationRevision,
      ),
      namespaceBundleRevision: counter(
        "Live Shadow Namespace bundle revision",
        value.namespaceBundleRevision,
        1,
      ),
      namespaceBundleDigest: exactBytes(
        "Live Shadow Namespace bundle digest",
        value.namespaceBundleDigest,
        HASH_BYTES,
      ),
      agentGrantPlanBytes: grantPlanBytes,
      agentGrantPlanDigest: grantPlanDigest,
      recipientId: portable("Live Shadow recipient ID", value.recipientId),
      recipientKeyId: portable("Live Shadow recipient key ID", value.recipientKeyId),
      recipientPublicKey: exactBytes(
        "Live Shadow recipient public key",
        value.recipientPublicKey,
        RECIPIENT_PUBLIC_KEY_BYTES,
      ),
      attemptCoordinate: portable(
        "Live Shadow attempt coordinate",
        value.attemptCoordinate,
      ),
      issuedAt,
      deadlineAt,
    });
  } catch (error) {
    grantPlanBytes.fill(0);
    grantPlanDigest.fill(0);
    throw error;
  } finally {
    actualGrantPlanDigest.fill(0);
    if (parsedGrantPlan) {
      destroyDeviceWrappedDomainAgentGrantPlanV1(parsedGrantPlan);
    }
  }
}

function planBytes(value: LiveShadowMessagePlanV3): Uint8Array {
  return concatV2(
    frameText(LIVE_SHADOW_MESSAGE_PLAN_DOMAIN_V3), encodeU32(value.formatVersion),
    frameText(value.purpose), frameText(value.operationId),
    encodeU64(value.policyRevision), frameText(value.sessionId),
    frameText(value.roomId), encodeU64(value.humanMessageId),
    encodeU64(value.revision), encodeU64(value.createdAt),
    frameText(value.subjectHumanId), frameText(value.committerDeviceId),
    encodeU64(value.committerDeviceSigningKeyGeneration),
    encodeU64(value.hostAuthorizationRevision), frameText(value.recipientAgentId),
    encodeU64(value.agentAuthorizationRevision),
    encodeU64(value.agentRuntimeGeneration), frameText(value.agentSignerKeyId),
    frame(value.agentSignerPublicKey), frameText(value.namespaceId),
    encodeU64(value.namespaceAccessRevision),
    encodeU64(value.namespaceKeyGeneration), frame(value.namespaceHeadDigest),
    frame(value.namespacePublicationDigest),
    frame(value.namespacePublicationSetDigest),
    frame(value.namespaceAudienceFingerprint), frameText(value.grantDomainId),
    frame(value.grantDomainParticipantDigest),
    encodeU64(value.grantDomainKeyGeneration),
    frame(value.grantDomainHeadDigest),
    frame(value.grantDomainPublicationDigest),
    encodeU64(value.grantDomainAuthorizationRevision),
    encodeU64(value.namespaceBundleRevision),
    frame(value.namespaceBundleDigest), frame(value.agentGrantPlanBytes),
    frame(value.agentGrantPlanDigest), frameText(value.recipientId),
    frameText(value.recipientKeyId), frame(value.recipientPublicKey),
    frameText(value.attemptCoordinate), encodeU64(value.issuedAt),
    encodeU64(value.deadlineAt),
  );
}

export function encodeLiveShadowMessagePlanV3(
  value: LiveShadowMessagePlanV3,
): Uint8Array {
  const normalized = normalizePlan(value);
  try {
    const bytes = planBytes(normalized);
    if (bytes.length > MAX_LIVE_SHADOW_MESSAGE_PLAN_WIRE_BYTES_V3) {
      bytes.fill(0);
      throw new RangeError("Live Shadow Message V3 plan exceeds its wire limit");
    }
    return bytes;
  } finally {
    destroyPlan(normalized);
  }
}

export function decodeLiveShadowMessagePlanV3(
  bytes: Uint8Array,
): LiveShadowMessagePlanV3 {
  if (!(bytes instanceof Uint8Array)
    || bytes.length > MAX_LIVE_SHADOW_MESSAGE_PLAN_WIRE_BYTES_V3) {
    throw new TypeError("Live Shadow Message V3 plan bytes are invalid");
  }
  const raw = decodeExact(bytes, (reader): LiveShadowMessagePlanV3 => {
    if (reader.readText(utf8V2(LIVE_SHADOW_MESSAGE_PLAN_DOMAIN_V3).length)
      !== LIVE_SHADOW_MESSAGE_PLAN_DOMAIN_V3) {
      throw new CanonicalDecodingError("Live Shadow Message V3 plan domain mismatch");
    }
    return {
      formatVersion: reader.readVersion(3) as 3,
      purpose: reader.readText(64) as typeof LIVE_SHADOW_MESSAGE_PLAN_PURPOSE_V3,
      operationId: reader.readText(V2_LIMITS.idBytes),
      policyRevision: reader.readU64(),
      sessionId: reader.readText(36),
      roomId: reader.readText(36),
      humanMessageId: reader.readU64(),
      revision: reader.readU64() as 0,
      createdAt: unixTimestamp(reader.readU64()),
      subjectHumanId: humanId(reader.readText(V2_LIMITS.idBytes)),
      committerDeviceId: cryptoDeviceId(reader.readText(V2_LIMITS.idBytes)),
      committerDeviceSigningKeyGeneration: reader.readU64(),
      hostAuthorizationRevision: authorizationRevision(reader.readU64()),
      recipientAgentId: agentId(reader.readText(V2_LIMITS.idBytes)),
      agentAuthorizationRevision: authorizationRevision(reader.readU64()),
      agentRuntimeGeneration: reader.readU64(),
      agentSignerKeyId: reader.readText(V2_LIMITS.idBytes),
      agentSignerPublicKey: reader.readFrame(AGENT_SIGNER_PUBLIC_KEY_BYTES),
      namespaceId: namespaceId(reader.readText(V2_LIMITS.idBytes)),
      namespaceAccessRevision: reader.readU64(),
      namespaceKeyGeneration: reader.readU64(),
      namespaceHeadDigest: reader.readFrame(HASH_BYTES),
      namespacePublicationDigest: reader.readFrame(HASH_BYTES),
      namespacePublicationSetDigest: reader.readFrame(HASH_BYTES),
      namespaceAudienceFingerprint: reader.readFrame(HASH_BYTES),
      grantDomainId: reader.readText(V2_LIMITS.idBytes),
      grantDomainParticipantDigest: reader.readFrame(HASH_BYTES),
      grantDomainKeyGeneration: reader.readU64(),
      grantDomainHeadDigest: reader.readFrame(HASH_BYTES),
      grantDomainPublicationDigest: reader.readFrame(HASH_BYTES),
      grantDomainAuthorizationRevision: authorizationRevision(reader.readU64()),
      namespaceBundleRevision: reader.readU64(),
      namespaceBundleDigest: reader.readFrame(HASH_BYTES),
      agentGrantPlanBytes: reader.readFrame(
        MAX_LIVE_SHADOW_MESSAGE_PLAN_WIRE_BYTES_V3 / 2,
      ),
      agentGrantPlanDigest: reader.readFrame(HASH_BYTES),
      recipientId: reader.readText(V2_LIMITS.idBytes),
      recipientKeyId: reader.readText(V2_LIMITS.idBytes),
      recipientPublicKey: reader.readFrame(RECIPIENT_PUBLIC_KEY_BYTES),
      attemptCoordinate: reader.readText(V2_LIMITS.idBytes),
      issuedAt: unixTimestamp(reader.readU64()),
      deadlineAt: unixTimestamp(reader.readU64()),
    };
  });
  let normalized: LiveShadowMessagePlanV3 | undefined;
  let canonical: Uint8Array | undefined;
  try {
    normalized = normalizePlan(raw);
    canonical = planBytes(normalized);
    if (!sameBytes(bytes, canonical)) {
      throw new CanonicalDecodingError("Live Shadow Message V3 plan is noncanonical");
    }
    const result = normalized;
    normalized = undefined;
    return result;
  } finally {
    destroyPlan(raw);
    if (normalized) destroyPlan(normalized);
    canonical?.fill(0);
  }
}

export function liveShadowMessagePlanDigestV3(bytes: Uint8Array): Uint8Array {
  const plan = decodeLiveShadowMessagePlanV3(bytes);
  try {
    return sha256(bytes);
  } finally {
    destroyPlan(plan);
  }
}

function destroyRequest(value: HumanLiveShadowMessageRequestV3): void {
  value.namespaceHeadDigest.fill(0);
  value.namespacePublicationDigest.fill(0);
  value.namespacePublicationSetDigest.fill(0);
  value.namespaceAudienceFingerprint.fill(0);
  value.grantDigest.fill(0);
  value.planDigest.fill(0);
  value.plaintextPayloadDigest.fill(0);
  value.encryptedPayloadDigest.fill(0);
  value.manifestDigest.fill(0);
  value.envelopeDigest.fill(0);
  value.signature.fill(0);
}

function normalizeRequestUnsigned(
  value: HumanLiveShadowMessageRequestUnsignedV3,
): HumanLiveShadowMessageRequestUnsignedV3 {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("Human live Shadow V3 request must be an object");
  }
  exactFields("Human live Shadow V3 request", value, REQUEST_UNSIGNED_FIELDS);
  if (
    value.formatVersion !== 3
    || value.purpose !== HUMAN_LIVE_SHADOW_MESSAGE_REQUEST_PURPOSE_V3
    || value.normalizationVersion !== 1
    || value.revision !== 0
  ) throw new TypeError("Human live Shadow V3 request shape is invalid");
  const issuedAt = unixTimestamp(value.issuedAt);
  const deadlineAt = unixTimestamp(value.deadlineAt);
  validWindow(issuedAt, deadlineAt);
  const grantExpiresAt = unixTimestamp(value.grantExpiresAt);
  if (grantExpiresAt < deadlineAt) {
    throw new TypeError("Human live Shadow V3 Grant expires before the request");
  }
  return Object.freeze({
    formatVersion: 3,
    purpose: HUMAN_LIVE_SHADOW_MESSAGE_REQUEST_PURPOSE_V3,
    normalizationVersion: 1,
    subjectHumanId: humanId(value.subjectHumanId),
    operationId: portable("Human live Shadow operation ID", value.operationId),
    policyRevision: counter("Human live Shadow policy revision", value.policyRevision, 1),
    sessionId: uuid("Human live Shadow Session ID", value.sessionId),
    roomId: uuid("Human live Shadow Room ID", value.roomId),
    messageId: messageId(value.messageId),
    revision: 0,
    createdAt: unixTimestamp(value.createdAt),
    recipientAgentId: agentId(value.recipientAgentId),
    agentAuthorizationRevision: authorizationRevision(
      value.agentAuthorizationRevision,
    ),
    cryptoObjectId: objectId(value.cryptoObjectId),
    namespaceId: namespaceId(value.namespaceId),
    namespaceAccessRevision: accessRevision(value.namespaceAccessRevision),
    namespaceKeyGeneration: namespaceGeneration(value.namespaceKeyGeneration),
    namespaceHeadDigest: exactBytes("Namespace head digest", value.namespaceHeadDigest, HASH_BYTES),
    namespacePublicationDigest: exactBytes("Namespace publication digest", value.namespacePublicationDigest, HASH_BYTES),
    namespacePublicationSetDigest: exactBytes("Namespace publication-set digest", value.namespacePublicationSetDigest, HASH_BYTES),
    namespaceAudienceFingerprint: exactBytes("Namespace audience fingerprint", value.namespaceAudienceFingerprint, HASH_BYTES),
    recipientKeyId: portable("Human live Shadow recipient key", value.recipientKeyId),
    grantId: grantId(value.grantId),
    grantDigest: exactBytes("Human live Shadow Grant digest", value.grantDigest, HASH_BYTES),
    grantExpiresAt,
    planDigest: exactBytes("Human live Shadow plan digest", value.planDigest, HASH_BYTES),
    plaintextPayloadDigest: exactBytes("Human live Shadow plaintext digest", value.plaintextPayloadDigest, HASH_BYTES),
    encryptedPayloadDigest: exactBytes("Human live Shadow encrypted digest", value.encryptedPayloadDigest, HASH_BYTES),
    manifestDigest: exactBytes("Human live Shadow manifest digest", value.manifestDigest, HASH_BYTES),
    envelopeDigest: exactBytes("Human live Shadow envelope digest", value.envelopeDigest, HASH_BYTES),
    issuedAt,
    deadlineAt,
    committerDeviceId: cryptoDeviceId(value.committerDeviceId),
    committerDeviceSigningKeyGeneration: counter(
      "Human live Shadow device signing-key generation",
      value.committerDeviceSigningKeyGeneration,
    ),
    hostAuthorizationRevision: authorizationRevision(
      value.hostAuthorizationRevision,
    ),
  });
}

function requestSigningBytes(
  value: HumanLiveShadowMessageRequestUnsignedV3,
): Uint8Array {
  return concatV2(
    frameText(HUMAN_LIVE_SHADOW_MESSAGE_REQUEST_DOMAIN_V3),
    encodeU32(value.formatVersion), frameText(value.purpose),
    encodeU32(value.normalizationVersion), frameText(value.subjectHumanId),
    frameText(value.operationId), encodeU64(value.policyRevision),
    frameText(value.sessionId), frameText(value.roomId),
    encodeU64(value.messageId), encodeU64(value.revision),
    encodeU64(value.createdAt), frameText(value.recipientAgentId),
    encodeU64(value.agentAuthorizationRevision), frameText(value.cryptoObjectId),
    frameText(value.namespaceId), encodeU64(value.namespaceAccessRevision),
    encodeU64(value.namespaceKeyGeneration), frame(value.namespaceHeadDigest),
    frame(value.namespacePublicationDigest),
    frame(value.namespacePublicationSetDigest),
    frame(value.namespaceAudienceFingerprint), frameText(value.recipientKeyId),
    frameText(value.grantId), frame(value.grantDigest),
    encodeU64(value.grantExpiresAt), frame(value.planDigest),
    frame(value.plaintextPayloadDigest), frame(value.encryptedPayloadDigest),
    frame(value.manifestDigest), frame(value.envelopeDigest),
    encodeU64(value.issuedAt), encodeU64(value.deadlineAt),
    frameText(value.committerDeviceId),
    encodeU64(value.committerDeviceSigningKeyGeneration),
    encodeU64(value.hostAuthorizationRevision),
  );
}

export function humanLiveShadowMessageRequestSigningBytesV3(
  value: HumanLiveShadowMessageRequestV3,
): Uint8Array {
  const { signature: _signature, ...unsigned } = value;
  const normalized = normalizeRequestUnsigned(unsigned);
  try {
    return requestSigningBytes(normalized);
  } finally {
    destroyRequest({ ...normalized, signature: new Uint8Array(64) });
  }
}

export function encodeHumanLiveShadowMessageRequestV3(
  value: HumanLiveShadowMessageRequestV3,
): Uint8Array {
  exactFields("Human live Shadow V3 request", value, [
    ...REQUEST_UNSIGNED_FIELDS,
    "signature",
  ]);
  const { signature, ...unsigned } = value;
  const normalized = normalizeRequestUnsigned(unsigned);
  const normalizedSignature = exactBytes(
    "Human live Shadow signature",
    signature,
    V2_LIMITS.signatureBytes,
  );
  try {
    const bytes = concatV2(
      requestSigningBytes(normalized),
      frame(normalizedSignature),
    );
    if (bytes.length > MAX_HUMAN_LIVE_SHADOW_MESSAGE_REQUEST_WIRE_BYTES_V3) {
      bytes.fill(0);
      throw new RangeError("Human live Shadow V3 request exceeds its wire limit");
    }
    return bytes;
  } finally {
    destroyRequest({ ...normalized, signature: normalizedSignature });
  }
}

export function decodeHumanLiveShadowMessageRequestV3(
  bytes: Uint8Array,
): HumanLiveShadowMessageRequestV3 {
  if (!(bytes instanceof Uint8Array)
    || bytes.length > MAX_HUMAN_LIVE_SHADOW_MESSAGE_REQUEST_WIRE_BYTES_V3) {
    throw new TypeError("Human live Shadow V3 request bytes are invalid");
  }
  const raw = decodeExact(bytes, (reader): HumanLiveShadowMessageRequestV3 => {
    if (reader.readText(
      utf8V2(HUMAN_LIVE_SHADOW_MESSAGE_REQUEST_DOMAIN_V3).length,
    ) !== HUMAN_LIVE_SHADOW_MESSAGE_REQUEST_DOMAIN_V3) {
      throw new CanonicalDecodingError("Human live Shadow V3 request domain mismatch");
    }
    return {
      formatVersion: reader.readVersion(3) as 3,
      purpose: reader.readText(64) as typeof HUMAN_LIVE_SHADOW_MESSAGE_REQUEST_PURPOSE_V3,
      normalizationVersion: reader.readVersion(1) as 1,
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
      namespaceAccessRevision: reader.readU64(),
      namespaceKeyGeneration: reader.readU64(),
      namespaceHeadDigest: reader.readFrame(HASH_BYTES),
      namespacePublicationDigest: reader.readFrame(HASH_BYTES),
      namespacePublicationSetDigest: reader.readFrame(HASH_BYTES),
      namespaceAudienceFingerprint: reader.readFrame(HASH_BYTES),
      recipientKeyId: reader.readText(V2_LIMITS.idBytes),
      grantId: grantId(reader.readText(V2_LIMITS.idBytes)),
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
      committerDeviceSigningKeyGeneration: reader.readU64(),
      hostAuthorizationRevision: authorizationRevision(reader.readU64()),
      signature: reader.readFrame(V2_LIMITS.signatureBytes),
    };
  });
  let canonical: Uint8Array | undefined;
  try {
    canonical = encodeHumanLiveShadowMessageRequestV3(raw);
    if (!sameBytes(bytes, canonical)) {
      throw new CanonicalDecodingError("Human live Shadow V3 request is noncanonical");
    }
    return raw;
  } catch (error) {
    destroyRequest(raw);
    throw error;
  } finally {
    canonical?.fill(0);
  }
}

export function prepareHumanLiveShadowMessageRequestV3(
  crypto: LatticeCrypto,
  input: PrepareHumanLiveShadowMessageRequestInputV3,
): CreatedHumanLiveShadowMessageRequestV3 {
  const publicKey = exactBytes(
    "Human live Shadow signing public key",
    input.committerSigningPublicKey,
    V2_LIMITS.signingPublicKeyBytes,
  );
  const privateKey = exactBytes(
    "Human live Shadow signing private key",
    input.committerSigningPrivateKey,
    V2_LIMITS.signingPrivateKeyBytes,
  );
  const { committerSigningPublicKey: _public, committerSigningPrivateKey: _private, ...rest } = input;
  const normalized = normalizeRequestUnsigned({
    ...rest,
    formatVersion: 3,
    purpose: HUMAN_LIVE_SHADOW_MESSAGE_REQUEST_PURPOSE_V3,
    normalizationVersion: 1,
  });
  let signingBytes: Uint8Array | undefined;
  let signature: Uint8Array | undefined;
  try {
    signingBytes = requestSigningBytes(normalized);
    signature = crypto.sign(privateKey, signingBytes);
    if (!crypto.verify(publicKey, signingBytes, signature)) {
      throw new TypeError("Human live Shadow signing keys do not match");
    }
    const bytes = encodeHumanLiveShadowMessageRequestV3({
      ...normalized,
      signature,
    });
    return Object.freeze({
      request: decodeHumanLiveShadowMessageRequestV3(bytes),
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
    resolveCurrentAuthority: ResolveCurrentHumanLiveShadowMessageAuthorityV3;
  }>,
  enforceFreshness: boolean,
): HumanLiveShadowMessageRequestV3 {
  let request: HumanLiveShadowMessageRequestV3 | undefined;
  let signingBytes: Uint8Array | undefined;
  let currentKey: Uint8Array | undefined;
  let actualDigest: Uint8Array | undefined;
  let expectedDigest: Uint8Array | undefined;
  let verified = false;
  try {
    request = decodeHumanLiveShadowMessageRequestV3(input.requestBytes);
    if (enforceFreshness) {
      const now = unixTimestamp(input.now);
      if (
        now < request.issuedAt
        || now >= request.deadlineAt
        || now >= request.grantExpiresAt
      ) {
        throw new TypeError(
          "Human live Shadow V3 request is not currently valid",
        );
      }
    }
    if (input.expectedRequestDigest !== undefined) {
      expectedDigest = exactBytes(
        "Expected Human live Shadow V3 request digest",
        input.expectedRequestDigest,
        HASH_BYTES,
      );
      actualDigest = sha256(input.requestBytes);
      if (!sameBytes(actualDigest, expectedDigest)) {
        throw new TypeError(
          "Human live Shadow V3 durable request digest disagrees",
        );
      }
    }
    currentKey = input.resolveCurrentAuthority({
      purpose: "human-live-shadow-message-v3-verify",
      subjectHumanId: request.subjectHumanId,
      operationId: request.operationId,
      committerDeviceId: request.committerDeviceId,
      committerDeviceSigningKeyGeneration:
        request.committerDeviceSigningKeyGeneration,
      hostAuthorizationRevision: request.hostAuthorizationRevision,
    })?.slice();
    if (currentKey === undefined) {
      throw new TypeError("Human live Shadow V3 authority is unavailable");
    }
    signingBytes = humanLiveShadowMessageRequestSigningBytesV3(request);
    if (!crypto.verify(currentKey, signingBytes, request.signature)) {
      throw new TypeError("Human live Shadow V3 signature is invalid");
    }
    verified = true;
    const result = request;
    request = undefined;
    return result;
  } finally {
    if (!verified && request) destroyRequest(request);
    signingBytes?.fill(0);
    currentKey?.fill(0);
    actualDigest?.fill(0);
    expectedDigest?.fill(0);
  }
}

export function verifyHumanLiveShadowMessageRequestV3(
  crypto: LatticeCrypto,
  input: Readonly<{
    requestBytes: Uint8Array;
    now: UnixTimestamp;
    resolveCurrentAuthority: ResolveCurrentHumanLiveShadowMessageAuthorityV3;
  }>,
): HumanLiveShadowMessageRequestV3 {
  return verifyRequest(crypto, input, true);
}

export function verifyHumanLiveShadowMessageRequestExactReplayV3(
  crypto: LatticeCrypto,
  input: Readonly<{
    requestBytes: Uint8Array;
    expectedRequestDigest: Uint8Array;
    resolveCurrentAuthority: ResolveCurrentHumanLiveShadowMessageAuthorityV3;
  }>,
): HumanLiveShadowMessageRequestV3 {
  return verifyRequest(crypto, input, false);
}

export function humanLiveShadowMessageRequestDigestV3(
  bytes: Uint8Array,
): Uint8Array {
  const request = decodeHumanLiveShadowMessageRequestV3(bytes);
  try {
    return sha256(bytes);
  } finally {
    destroyRequest(request);
  }
}
