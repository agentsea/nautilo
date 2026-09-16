import { sha256 } from "@noble/hashes/sha2.js";

import type { LatticeCrypto } from "../crypto/index.ts";
import {
  destroyDeviceWrappedDomainAgentForegroundAuthorizationPlanV1,
  parseDeviceWrappedDomainAgentForegroundAuthorizationPlanV1,
} from "../format/device-wrapped-domain-agent-foreground-authorization-v1.ts";
import {
  DOMAIN_FOREGROUND_AUTHORIZATION_MAX_PLAN_BYTES_V2,
  DOMAIN_FOREGROUND_AUTHORIZATION_MAX_WIRE_BYTES_V2,
  destroyDomainForegroundAuthorizationPlanV2,
  destroyDomainForegroundAuthorizationV2,
  parseDomainForegroundAuthorizationPlanV2,
  parseDomainForegroundAuthorizationV2,
} from "../format/domain-foreground-authorization-v2.ts";
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
  type AgentId,
  type AuthorizationRevision,
  type CryptoDeviceId,
  type HumanId,
  type NamespaceId,
  type ObjectId,
  type UnixTimestamp,
} from "../v2-types/ids.ts";
import { V2_LIMITS } from "../v2-types/limits.ts";
import { copyOwnedBytesV2 } from "../v2-types/opaque.ts";

export const LIVE_SHADOW_MESSAGE_PLAN_FORMAT_VERSION_V4 = 4 as const;
export const LIVE_SHADOW_MESSAGE_PLAN_PURPOSE_V4 =
  "message.live_shadow_plan" as const;
export const LIVE_SHADOW_MESSAGE_PLAN_DOMAIN_V4 =
  "nautilo/lattice-crypto/live-shadow-message-plan/v4";
export const HUMAN_LIVE_SHADOW_MESSAGE_REQUEST_FORMAT_VERSION_V4 = 4 as const;
export const HUMAN_LIVE_SHADOW_MESSAGE_REQUEST_PURPOSE_V4 =
  "message.live_shadow_human_publish" as const;
export const HUMAN_LIVE_SHADOW_MESSAGE_REQUEST_DOMAIN_V4 =
  "nautilo/lattice-crypto/human-live-shadow-message-request/v4";
export const LIVE_SHADOW_MESSAGE_NORMALIZATION_VERSION_V4 = 1 as const;
export const LIVE_SHADOW_MESSAGE_REQUEST_MAX_TTL_MS_V4 = 30_000;
export const MAX_LIVE_SHADOW_MESSAGE_PLAN_WIRE_BYTES_V4 = 8 * 1024 * 1024;
export const MAX_HUMAN_LIVE_SHADOW_MESSAGE_REQUEST_WIRE_BYTES_V4 =
  18 * 1024 * 1024;

const HASH_BYTES = 32;
const RECIPIENT_PUBLIC_KEY_BYTES = V2_LIMITS.hpkePublicKeyBytes;
const AGENT_SIGNER_PUBLIC_KEY_BYTES = V2_LIMITS.signingPublicKeyBytes;
const PG_SERIAL_MAX = 2_147_483_647;
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

export interface LiveShadowAuthorizationRequiredV4 {
  readonly disposition: "authorization_required";
  readonly authorizationId: string;
  readonly authorizationPlanBytes: Uint8Array;
  readonly authorizationPlanDigest: Uint8Array;
  readonly recipientId: string;
  readonly recipientKeyId: string;
  readonly recipientPublicKey: Uint8Array;
}

export interface LiveShadowAuthorizationReusableV4 {
  readonly disposition: "authorization_reusable";
  readonly sessionReference: string;
  readonly authorizationDigest: Uint8Array;
}

export type LiveShadowAuthorizationPlanV4 =
  | LiveShadowAuthorizationRequiredV4
  | LiveShadowAuthorizationReusableV4;

export interface LiveShadowMessagePlanV4 {
  readonly formatVersion: typeof LIVE_SHADOW_MESSAGE_PLAN_FORMAT_VERSION_V4;
  readonly purpose: typeof LIVE_SHADOW_MESSAGE_PLAN_PURPOSE_V4;
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
  readonly namespaceBundleGrantDomainAuthorizationRevision: AuthorizationRevision;
  readonly namespaceBundleRevision: number;
  readonly namespaceBundleDigest: Uint8Array;
  readonly authorization: LiveShadowAuthorizationPlanV4;
  readonly attemptCoordinate: string;
  readonly issuedAt: UnixTimestamp;
  readonly deadlineAt: UnixTimestamp;
}

export interface HumanLiveShadowAuthorizationEstablishV4 {
  readonly kind: "establish";
  readonly authorizationBytes: Uint8Array;
  readonly authorizationDigest: Uint8Array;
}

export interface HumanLiveShadowAuthorizationReuseV4 {
  readonly kind: "reuse";
  readonly sessionReference: string;
  readonly authorizationDigest: Uint8Array;
}

export type HumanLiveShadowAuthorizationProofV4 =
  | HumanLiveShadowAuthorizationEstablishV4
  | HumanLiveShadowAuthorizationReuseV4;

export interface HumanLiveShadowMessageRequestUnsignedV4 {
  readonly formatVersion:
    typeof HUMAN_LIVE_SHADOW_MESSAGE_REQUEST_FORMAT_VERSION_V4;
  readonly purpose: typeof HUMAN_LIVE_SHADOW_MESSAGE_REQUEST_PURPOSE_V4;
  readonly normalizationVersion:
    typeof LIVE_SHADOW_MESSAGE_NORMALIZATION_VERSION_V4;
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
  readonly authorization: HumanLiveShadowAuthorizationProofV4;
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

export interface HumanLiveShadowMessageRequestV4
  extends HumanLiveShadowMessageRequestUnsignedV4 {
  readonly signature: Uint8Array;
}

export interface PrepareHumanLiveShadowMessageRequestInputV4
  extends Omit<
    HumanLiveShadowMessageRequestUnsignedV4,
    "formatVersion" | "purpose" | "normalizationVersion"
  > {
  readonly committerSigningPublicKey: Uint8Array;
  readonly committerSigningPrivateKey: Uint8Array;
}

export interface CreatedHumanLiveShadowMessageRequestV4 {
  readonly request: HumanLiveShadowMessageRequestV4;
  readonly bytes: Uint8Array;
  readonly requestDigest: Uint8Array;
}

export type ResolveCurrentHumanLiveShadowMessageAuthorityV4 = (
  context: Readonly<{
    purpose: "human-live-shadow-message-v4-verify";
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
  "grantDomainAuthorizationRevision",
  "namespaceBundleGrantDomainAuthorizationRevision", "namespaceBundleRevision",
  "namespaceBundleDigest", "authorization", "attemptCoordinate", "issuedAt",
  "deadlineAt",
] as const);
const REQUEST_UNSIGNED_FIELDS = Object.freeze([
  "formatVersion", "purpose", "normalizationVersion", "subjectHumanId",
  "operationId", "policyRevision", "sessionId", "roomId", "messageId",
  "revision", "createdAt", "recipientAgentId", "agentAuthorizationRevision",
  "cryptoObjectId", "namespaceId", "namespaceAccessRevision",
  "namespaceKeyGeneration", "namespaceHeadDigest",
  "namespacePublicationDigest", "namespacePublicationSetDigest",
  "namespaceAudienceFingerprint", "authorization", "planDigest",
  "plaintextPayloadDigest", "encryptedPayloadDigest", "manifestDigest",
  "envelopeDigest", "issuedAt", "deadlineAt", "committerDeviceId",
  "committerDeviceSigningKeyGeneration", "hostAuthorizationRevision",
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

function boundedBytes(label: string, value: unknown, maximum: number): Uint8Array {
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
    || deadlineAt - issuedAt > LIVE_SHADOW_MESSAGE_REQUEST_MAX_TTL_MS_V4
  ) throw new RangeError("Live Shadow Message lifetime is invalid");
}

function destroyAuthorizationPlan(value: LiveShadowAuthorizationPlanV4): void {
  if (value.disposition === "authorization_required") {
    value.authorizationPlanBytes.fill(0);
    value.authorizationPlanDigest.fill(0);
    value.recipientPublicKey.fill(0);
  } else {
    value.authorizationDigest.fill(0);
  }
}

function destroyAuthorizationProof(
  value: HumanLiveShadowAuthorizationProofV4,
): void {
  if (value.kind === "establish") value.authorizationBytes.fill(0);
  value.authorizationDigest.fill(0);
}

function normalizeAuthorizationPlan(
  value: LiveShadowAuthorizationPlanV4,
  plan: Omit<LiveShadowMessagePlanV4, "authorization">,
): LiveShadowAuthorizationPlanV4 {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("Live Shadow authorization disposition is invalid");
  }
  if (value.disposition === "authorization_required") {
    exactFields("Required live Shadow authorization", value, [
      "disposition", "authorizationId", "authorizationPlanBytes",
      "authorizationPlanDigest", "recipientId", "recipientKeyId",
      "recipientPublicKey",
    ]);
    const authorizationPlanBytes = boundedBytes(
      "Foreground authorization plan",
      value.authorizationPlanBytes,
      DOMAIN_FOREGROUND_AUTHORIZATION_MAX_PLAN_BYTES_V2,
    );
    const authorizationPlanDigest = exactBytes(
      "Foreground authorization plan digest",
      value.authorizationPlanDigest,
      HASH_BYTES,
    );
    const legacyPlan = parseDeviceWrappedDomainAgentForegroundAuthorizationPlanV1(
      authorizationPlanBytes,
    );
    const domainPlan = parseDomainForegroundAuthorizationPlanV2(
      authorizationPlanBytes,
    );
    const actualDigest = sha256(authorizationPlanBytes);
    try {
      const sharedPlanDisagrees = (
        parsed: NonNullable<typeof legacyPlan> | NonNullable<typeof domainPlan>,
      ) =>
        parsed.authorizationId !== value.authorizationId
        || parsed.authorizationId === plan.operationId
        || parsed.policyRevision !== plan.policyRevision
        || parsed.sessionId !== plan.sessionId
        || parsed.roomId !== plan.roomId
        || parsed.subjectHumanId !== plan.subjectHumanId
        || parsed.committerDeviceId !== plan.committerDeviceId
        || parsed.committerDeviceSigningGeneration
          !== plan.committerDeviceSigningKeyGeneration
        || parsed.hostAuthorizationRevision !== plan.hostAuthorizationRevision
        || parsed.recipientKeyId !== value.recipientKeyId
        || parsed.issuedAt > plan.issuedAt
        || parsed.deadlineAt < plan.deadlineAt;
      const legacyPlanDisagrees = legacyPlan !== null && (
        sharedPlanDisagrees(legacyPlan)
        || legacyPlan.recipientAgentId !== plan.recipientAgentId
        || legacyPlan.agentAuthorizationRevision !== plan.agentAuthorizationRevision
        || legacyPlan.agentRuntimeGeneration !== plan.agentRuntimeGeneration
        || !legacyPlan.domains.some((domain) =>
          domain.grantDomainId === plan.grantDomainId
          && domain.domainKeyGeneration === plan.grantDomainKeyGeneration
          && domain.authorizationRevision
            === plan.grantDomainAuthorizationRevision
          && sameBytes(
            domain.participantDigest,
            plan.grantDomainParticipantDigest,
          )
          && sameBytes(domain.headDigest, plan.grantDomainHeadDigest)
          && sameBytes(
            domain.publicationDigest,
            plan.grantDomainPublicationDigest,
          )
        )
      );
      const domainPlanDisagrees = domainPlan !== null && (
        sharedPlanDisagrees(domainPlan)
        || domainPlan.recipientKind !== "agent"
        || domainPlan.recipientPrincipalId !== plan.recipientAgentId
        || domainPlan.recipientAuthorizationRevision
          !== plan.agentAuthorizationRevision
        || domainPlan.recipientRuntimeGeneration !== plan.agentRuntimeGeneration
        || !domainPlan.domains.some((domain) =>
          domain.domainId === plan.grantDomainId
          && domain.domainKeyGeneration === plan.grantDomainKeyGeneration
          && domain.authorizationRevision
            === plan.grantDomainAuthorizationRevision
          && sameBytes(
            domain.participantDigest,
            plan.grantDomainParticipantDigest,
          )
          && sameBytes(domain.headDigest, plan.grantDomainHeadDigest)
          && sameBytes(
            domain.activeNamespaceBindingSetDigest,
            plan.grantDomainPublicationDigest,
          )
        )
      );
      if (
        (legacyPlan === null && domainPlan === null)
        || !sameBytes(actualDigest, authorizationPlanDigest)
        || legacyPlanDisagrees
        || domainPlanDisagrees
      ) throw new TypeError("Foreground authorization plan disagrees");
      return Object.freeze({
        disposition: "authorization_required",
        authorizationId: portable(
          "Foreground authorization ID",
          value.authorizationId,
        ),
        authorizationPlanBytes,
        authorizationPlanDigest,
        recipientId: portable("Foreground authorization recipient ID", value.recipientId),
        recipientKeyId: portable("Foreground authorization recipient key ID", value.recipientKeyId),
        recipientPublicKey: exactBytes(
          "Foreground authorization recipient public key",
          value.recipientPublicKey,
          RECIPIENT_PUBLIC_KEY_BYTES,
        ),
      });
    } catch (error) {
      authorizationPlanBytes.fill(0);
      authorizationPlanDigest.fill(0);
      throw error;
    } finally {
      actualDigest.fill(0);
      if (legacyPlan) {
        destroyDeviceWrappedDomainAgentForegroundAuthorizationPlanV1(legacyPlan);
      }
      if (domainPlan) {
        destroyDomainForegroundAuthorizationPlanV2(domainPlan);
      }
    }
  }
  if (value.disposition === "authorization_reusable") {
    exactFields("Reusable live Shadow authorization", value, [
      "disposition", "sessionReference", "authorizationDigest",
    ]);
    return Object.freeze({
      disposition: "authorization_reusable",
      sessionReference: portable(
        "Foreground authorization session reference",
        value.sessionReference,
      ),
      authorizationDigest: exactBytes(
        "Foreground authorization digest",
        value.authorizationDigest,
        HASH_BYTES,
      ),
    });
  }
  throw new TypeError("Live Shadow authorization disposition is unsupported");
}

function destroyPlan(value: LiveShadowMessagePlanV4): void {
  value.agentSignerPublicKey.fill(0);
  value.namespaceHeadDigest.fill(0);
  value.namespacePublicationDigest.fill(0);
  value.namespacePublicationSetDigest.fill(0);
  value.namespaceAudienceFingerprint.fill(0);
  value.grantDomainParticipantDigest.fill(0);
  value.grantDomainHeadDigest.fill(0);
  value.grantDomainPublicationDigest.fill(0);
  value.namespaceBundleDigest.fill(0);
  destroyAuthorizationPlan(value.authorization);
}

function normalizePlan(value: LiveShadowMessagePlanV4): LiveShadowMessagePlanV4 {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("Live Shadow Message V4 plan must be an object");
  }
  exactFields("Live Shadow Message V4 plan", value, PLAN_FIELDS);
  if (
    value.formatVersion !== 4
    || value.purpose !== LIVE_SHADOW_MESSAGE_PLAN_PURPOSE_V4
    || value.revision !== 0
  ) throw new TypeError("Live Shadow Message V4 plan shape is invalid");
  const issuedAt = unixTimestamp(value.issuedAt);
  const deadlineAt = unixTimestamp(value.deadlineAt);
  validWindow(issuedAt, deadlineAt);
  const base = Object.freeze({
    formatVersion: 4 as const,
    purpose: LIVE_SHADOW_MESSAGE_PLAN_PURPOSE_V4,
    operationId: portable("Live Shadow operation ID", value.operationId),
    policyRevision: counter("Live Shadow policy revision", value.policyRevision, 1),
    sessionId: uuid("Live Shadow Session ID", value.sessionId),
    roomId: uuid("Live Shadow Room ID", value.roomId),
    humanMessageId: messageId(value.humanMessageId),
    revision: 0 as const,
    createdAt: unixTimestamp(value.createdAt),
    subjectHumanId: humanId(value.subjectHumanId),
    committerDeviceId: cryptoDeviceId(value.committerDeviceId),
    committerDeviceSigningKeyGeneration: counter(
      "Live Shadow device signing-key generation",
      value.committerDeviceSigningKeyGeneration,
      1,
    ),
    hostAuthorizationRevision: authorizationRevision(value.hostAuthorizationRevision),
    recipientAgentId: agentId(value.recipientAgentId),
    agentAuthorizationRevision: authorizationRevision(value.agentAuthorizationRevision),
    agentRuntimeGeneration: counter(
      "Live Shadow Agent Runtime generation",
      value.agentRuntimeGeneration,
    ),
    agentSignerKeyId: portable("Live Shadow Agent signer key ID", value.agentSignerKeyId),
    agentSignerPublicKey: exactBytes(
      "Live Shadow Agent signer public key",
      value.agentSignerPublicKey,
      AGENT_SIGNER_PUBLIC_KEY_BYTES,
    ),
    namespaceId: namespaceId(value.namespaceId),
    namespaceAccessRevision: accessRevision(value.namespaceAccessRevision),
    namespaceKeyGeneration: namespaceGeneration(value.namespaceKeyGeneration),
    namespaceHeadDigest: exactBytes("Live Shadow Namespace head digest", value.namespaceHeadDigest, HASH_BYTES),
    namespacePublicationDigest: exactBytes("Live Shadow Namespace publication digest", value.namespacePublicationDigest, HASH_BYTES),
    namespacePublicationSetDigest: exactBytes("Live Shadow Namespace publication-set digest", value.namespacePublicationSetDigest, HASH_BYTES),
    namespaceAudienceFingerprint: exactBytes("Live Shadow Namespace audience fingerprint", value.namespaceAudienceFingerprint, HASH_BYTES),
    grantDomainId: portable("Live Shadow Grant Domain ID", value.grantDomainId),
    grantDomainParticipantDigest: exactBytes("Live Shadow Grant Domain participant digest", value.grantDomainParticipantDigest, HASH_BYTES),
    grantDomainKeyGeneration: counter("Live Shadow Grant Domain key generation", value.grantDomainKeyGeneration, 1),
    grantDomainHeadDigest: exactBytes("Live Shadow Grant Domain head digest", value.grantDomainHeadDigest, HASH_BYTES),
    grantDomainPublicationDigest: exactBytes("Live Shadow Grant Domain publication digest", value.grantDomainPublicationDigest, HASH_BYTES),
    grantDomainAuthorizationRevision: authorizationRevision(value.grantDomainAuthorizationRevision),
    namespaceBundleGrantDomainAuthorizationRevision: authorizationRevision(
      value.namespaceBundleGrantDomainAuthorizationRevision,
    ),
    namespaceBundleRevision: counter("Live Shadow Namespace bundle revision", value.namespaceBundleRevision, 1),
    namespaceBundleDigest: exactBytes("Live Shadow Namespace bundle digest", value.namespaceBundleDigest, HASH_BYTES),
    attemptCoordinate: portable("Live Shadow attempt coordinate", value.attemptCoordinate),
    issuedAt,
    deadlineAt,
  });
  try {
    return Object.freeze({
      ...base,
      authorization: normalizeAuthorizationPlan(value.authorization, base),
    });
  } catch (error) {
    destroyPlan({
      ...base,
      authorization: {
        disposition: "authorization_reusable",
        sessionReference: "wipe-placeholder",
        authorizationDigest: new Uint8Array(HASH_BYTES),
      },
    });
    throw error;
  }
}

function authorizationPlanBytes(value: LiveShadowAuthorizationPlanV4): Uint8Array {
  if (value.disposition === "authorization_required") {
    return concatV2(
      frameText(value.disposition), frameText(value.authorizationId),
      frame(value.authorizationPlanBytes), frame(value.authorizationPlanDigest),
      frameText(value.recipientId), frameText(value.recipientKeyId),
      frame(value.recipientPublicKey),
    );
  }
  return concatV2(
    frameText(value.disposition), frameText(value.sessionReference),
    frame(value.authorizationDigest),
  );
}

function planBytes(value: LiveShadowMessagePlanV4): Uint8Array {
  return concatV2(
    frameText(LIVE_SHADOW_MESSAGE_PLAN_DOMAIN_V4), encodeU32(value.formatVersion),
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
    encodeU64(value.grantDomainKeyGeneration), frame(value.grantDomainHeadDigest),
    frame(value.grantDomainPublicationDigest),
    encodeU64(value.grantDomainAuthorizationRevision),
    encodeU64(value.namespaceBundleGrantDomainAuthorizationRevision),
    encodeU64(value.namespaceBundleRevision), frame(value.namespaceBundleDigest),
    authorizationPlanBytes(value.authorization),
    frameText(value.attemptCoordinate), encodeU64(value.issuedAt),
    encodeU64(value.deadlineAt),
  );
}

export function encodeLiveShadowMessagePlanV4(
  value: LiveShadowMessagePlanV4,
): Uint8Array {
  const normalized = normalizePlan(value);
  try {
    const bytes = planBytes(normalized);
    if (bytes.length > MAX_LIVE_SHADOW_MESSAGE_PLAN_WIRE_BYTES_V4) {
      bytes.fill(0);
      throw new RangeError("Live Shadow Message V4 plan exceeds its wire limit");
    }
    return bytes;
  } finally {
    destroyPlan(normalized);
  }
}

function readAuthorizationPlan(
  reader: Parameters<Parameters<typeof decodeExact>[1]>[0],
): LiveShadowAuthorizationPlanV4 {
  const disposition = reader.readText(64);
  if (disposition === "authorization_required") {
    return {
      disposition,
      authorizationId: reader.readText(V2_LIMITS.idBytes),
      authorizationPlanBytes: reader.readFrame(
        DOMAIN_FOREGROUND_AUTHORIZATION_MAX_PLAN_BYTES_V2,
      ),
      authorizationPlanDigest: reader.readFrame(HASH_BYTES),
      recipientId: reader.readText(V2_LIMITS.idBytes),
      recipientKeyId: reader.readText(V2_LIMITS.idBytes),
      recipientPublicKey: reader.readFrame(RECIPIENT_PUBLIC_KEY_BYTES),
    };
  }
  if (disposition === "authorization_reusable") {
    return {
      disposition,
      sessionReference: reader.readText(V2_LIMITS.idBytes),
      authorizationDigest: reader.readFrame(HASH_BYTES),
    };
  }
  throw new CanonicalDecodingError("Live Shadow authorization disposition mismatch");
}

export function decodeLiveShadowMessagePlanV4(
  bytes: Uint8Array,
): LiveShadowMessagePlanV4 {
  if (!(bytes instanceof Uint8Array)
    || bytes.length > MAX_LIVE_SHADOW_MESSAGE_PLAN_WIRE_BYTES_V4) {
    throw new TypeError("Live Shadow Message V4 plan bytes are invalid");
  }
  const raw = decodeExact(bytes, (reader): LiveShadowMessagePlanV4 => {
    if (reader.readText(utf8V2(LIVE_SHADOW_MESSAGE_PLAN_DOMAIN_V4).length)
      !== LIVE_SHADOW_MESSAGE_PLAN_DOMAIN_V4) {
      throw new CanonicalDecodingError("Live Shadow Message V4 plan domain mismatch");
    }
    return {
      formatVersion: reader.readVersion(4) as 4,
      purpose: reader.readText(64) as typeof LIVE_SHADOW_MESSAGE_PLAN_PURPOSE_V4,
      operationId: reader.readText(V2_LIMITS.idBytes),
      policyRevision: reader.readU64(),
      sessionId: reader.readText(36), roomId: reader.readText(36),
      humanMessageId: reader.readU64(), revision: reader.readU64() as 0,
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
      namespaceBundleGrantDomainAuthorizationRevision:
        authorizationRevision(reader.readU64()),
      namespaceBundleRevision: reader.readU64(),
      namespaceBundleDigest: reader.readFrame(HASH_BYTES),
      authorization: readAuthorizationPlan(reader),
      attemptCoordinate: reader.readText(V2_LIMITS.idBytes),
      issuedAt: unixTimestamp(reader.readU64()),
      deadlineAt: unixTimestamp(reader.readU64()),
    };
  });
  let normalized: LiveShadowMessagePlanV4 | undefined;
  let canonical: Uint8Array | undefined;
  try {
    normalized = normalizePlan(raw);
    canonical = planBytes(normalized);
    if (!sameBytes(bytes, canonical)) {
      throw new CanonicalDecodingError("Live Shadow Message V4 plan is noncanonical");
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

export function liveShadowMessagePlanDigestV4(bytes: Uint8Array): Uint8Array {
  const plan = decodeLiveShadowMessagePlanV4(bytes);
  try {
    return sha256(bytes);
  } finally {
    destroyPlan(plan);
  }
}

function normalizeAuthorizationProof(
  value: HumanLiveShadowAuthorizationProofV4,
): HumanLiveShadowAuthorizationProofV4 {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("Human live Shadow authorization proof is invalid");
  }
  if (value.kind === "establish") {
    exactFields("Establish authorization proof", value, [
      "kind", "authorizationBytes", "authorizationDigest",
    ]);
    const authorizationBytes = boundedBytes(
      "Foreground authorization bytes",
      value.authorizationBytes,
      DOMAIN_FOREGROUND_AUTHORIZATION_MAX_WIRE_BYTES_V2,
    );
    const authorizationDigest = exactBytes(
      "Foreground authorization digest",
      value.authorizationDigest,
      HASH_BYTES,
    );
    const parsed = parseDomainForegroundAuthorizationV2(
      authorizationBytes,
    );
    const actualDigest = sha256(authorizationBytes);
    try {
      if (parsed === null || !sameBytes(actualDigest, authorizationDigest)) {
        throw new TypeError("Foreground authorization bytes disagree");
      }
      return Object.freeze({
        kind: "establish",
        authorizationBytes,
        authorizationDigest,
      });
    } catch (error) {
      authorizationBytes.fill(0);
      authorizationDigest.fill(0);
      throw error;
    } finally {
      actualDigest.fill(0);
      if (parsed) {
        destroyDomainForegroundAuthorizationV2(parsed);
      }
    }
  }
  if (value.kind === "reuse") {
    exactFields("Reuse authorization proof", value, [
      "kind", "sessionReference", "authorizationDigest",
    ]);
    return Object.freeze({
      kind: "reuse",
      sessionReference: portable(
        "Foreground authorization session reference",
        value.sessionReference,
      ),
      authorizationDigest: exactBytes(
        "Foreground authorization digest",
        value.authorizationDigest,
        HASH_BYTES,
      ),
    });
  }
  throw new TypeError("Human live Shadow authorization proof is unsupported");
}

function destroyRequest(value: HumanLiveShadowMessageRequestV4): void {
  value.namespaceHeadDigest.fill(0); value.namespacePublicationDigest.fill(0);
  value.namespacePublicationSetDigest.fill(0);
  value.namespaceAudienceFingerprint.fill(0);
  destroyAuthorizationProof(value.authorization);
  value.planDigest.fill(0); value.plaintextPayloadDigest.fill(0);
  value.encryptedPayloadDigest.fill(0); value.manifestDigest.fill(0);
  value.envelopeDigest.fill(0); value.signature.fill(0);
}

function normalizeRequestUnsigned(
  value: HumanLiveShadowMessageRequestUnsignedV4,
): HumanLiveShadowMessageRequestUnsignedV4 {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("Human live Shadow V4 request must be an object");
  }
  exactFields("Human live Shadow V4 request", value, REQUEST_UNSIGNED_FIELDS);
  if (
    value.formatVersion !== 4
    || value.purpose !== HUMAN_LIVE_SHADOW_MESSAGE_REQUEST_PURPOSE_V4
    || value.normalizationVersion !== 1 || value.revision !== 0
  ) throw new TypeError("Human live Shadow V4 request shape is invalid");
  const issuedAt = unixTimestamp(value.issuedAt);
  const deadlineAt = unixTimestamp(value.deadlineAt);
  validWindow(issuedAt, deadlineAt);
  return Object.freeze({
    formatVersion: 4,
    purpose: HUMAN_LIVE_SHADOW_MESSAGE_REQUEST_PURPOSE_V4,
    normalizationVersion: 1,
    subjectHumanId: humanId(value.subjectHumanId),
    operationId: portable("Human live Shadow operation ID", value.operationId),
    policyRevision: counter("Human live Shadow policy revision", value.policyRevision, 1),
    sessionId: uuid("Human live Shadow Session ID", value.sessionId),
    roomId: uuid("Human live Shadow Room ID", value.roomId),
    messageId: messageId(value.messageId), revision: 0,
    createdAt: unixTimestamp(value.createdAt),
    recipientAgentId: agentId(value.recipientAgentId),
    agentAuthorizationRevision: authorizationRevision(value.agentAuthorizationRevision),
    cryptoObjectId: objectId(value.cryptoObjectId),
    namespaceId: namespaceId(value.namespaceId),
    namespaceAccessRevision: accessRevision(value.namespaceAccessRevision),
    namespaceKeyGeneration: namespaceGeneration(value.namespaceKeyGeneration),
    namespaceHeadDigest: exactBytes("Namespace head digest", value.namespaceHeadDigest, HASH_BYTES),
    namespacePublicationDigest: exactBytes("Namespace publication digest", value.namespacePublicationDigest, HASH_BYTES),
    namespacePublicationSetDigest: exactBytes("Namespace publication-set digest", value.namespacePublicationSetDigest, HASH_BYTES),
    namespaceAudienceFingerprint: exactBytes("Namespace audience fingerprint", value.namespaceAudienceFingerprint, HASH_BYTES),
    authorization: normalizeAuthorizationProof(value.authorization),
    planDigest: exactBytes("Human live Shadow plan digest", value.planDigest, HASH_BYTES),
    plaintextPayloadDigest: exactBytes("Human live Shadow plaintext digest", value.plaintextPayloadDigest, HASH_BYTES),
    encryptedPayloadDigest: exactBytes("Human live Shadow encrypted digest", value.encryptedPayloadDigest, HASH_BYTES),
    manifestDigest: exactBytes("Human live Shadow manifest digest", value.manifestDigest, HASH_BYTES),
    envelopeDigest: exactBytes("Human live Shadow envelope digest", value.envelopeDigest, HASH_BYTES),
    issuedAt, deadlineAt,
    committerDeviceId: cryptoDeviceId(value.committerDeviceId),
    committerDeviceSigningKeyGeneration: counter(
      "Human live Shadow device signing-key generation",
      value.committerDeviceSigningKeyGeneration,
      1,
    ),
    hostAuthorizationRevision: authorizationRevision(value.hostAuthorizationRevision),
  });
}

function authorizationProofBytes(
  value: HumanLiveShadowAuthorizationProofV4,
): Uint8Array {
  if (value.kind === "establish") {
    return concatV2(
      frameText(value.kind), frame(value.authorizationBytes),
      frame(value.authorizationDigest),
    );
  }
  return concatV2(
    frameText(value.kind), frameText(value.sessionReference),
    frame(value.authorizationDigest),
  );
}

function requestSigningBytes(
  value: HumanLiveShadowMessageRequestUnsignedV4,
): Uint8Array {
  return concatV2(
    frameText(HUMAN_LIVE_SHADOW_MESSAGE_REQUEST_DOMAIN_V4),
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
    frame(value.namespaceAudienceFingerprint),
    authorizationProofBytes(value.authorization), frame(value.planDigest),
    frame(value.plaintextPayloadDigest), frame(value.encryptedPayloadDigest),
    frame(value.manifestDigest), frame(value.envelopeDigest),
    encodeU64(value.issuedAt), encodeU64(value.deadlineAt),
    frameText(value.committerDeviceId),
    encodeU64(value.committerDeviceSigningKeyGeneration),
    encodeU64(value.hostAuthorizationRevision),
  );
}

export function humanLiveShadowMessageRequestSigningBytesV4(
  value: HumanLiveShadowMessageRequestV4,
): Uint8Array {
  const { signature: _signature, ...unsigned } = value;
  const normalized = normalizeRequestUnsigned(unsigned);
  try {
    return requestSigningBytes(normalized);
  } finally {
    destroyRequest({ ...normalized, signature: new Uint8Array(64) });
  }
}

export function encodeHumanLiveShadowMessageRequestV4(
  value: HumanLiveShadowMessageRequestV4,
): Uint8Array {
  exactFields("Human live Shadow V4 request", value, [
    ...REQUEST_UNSIGNED_FIELDS, "signature",
  ]);
  const { signature, ...unsigned } = value;
  const normalized = normalizeRequestUnsigned(unsigned);
  const normalizedSignature = exactBytes(
    "Human live Shadow signature",
    signature,
    V2_LIMITS.signatureBytes,
  );
  try {
    const bytes = concatV2(requestSigningBytes(normalized), frame(normalizedSignature));
    if (bytes.length > MAX_HUMAN_LIVE_SHADOW_MESSAGE_REQUEST_WIRE_BYTES_V4) {
      bytes.fill(0);
      throw new RangeError("Human live Shadow V4 request exceeds its wire limit");
    }
    return bytes;
  } finally {
    destroyRequest({ ...normalized, signature: normalizedSignature });
  }
}

function readAuthorizationProof(
  reader: Parameters<Parameters<typeof decodeExact>[1]>[0],
): HumanLiveShadowAuthorizationProofV4 {
  const kind = reader.readText(16);
  if (kind === "establish") {
    return {
      kind,
      authorizationBytes: reader.readFrame(
        DOMAIN_FOREGROUND_AUTHORIZATION_MAX_WIRE_BYTES_V2,
      ),
      authorizationDigest: reader.readFrame(HASH_BYTES),
    };
  }
  if (kind === "reuse") {
    return {
      kind,
      sessionReference: reader.readText(V2_LIMITS.idBytes),
      authorizationDigest: reader.readFrame(HASH_BYTES),
    };
  }
  throw new CanonicalDecodingError("Human live Shadow authorization proof mismatch");
}

export function decodeHumanLiveShadowMessageRequestV4(
  bytes: Uint8Array,
): HumanLiveShadowMessageRequestV4 {
  if (!(bytes instanceof Uint8Array)
    || bytes.length > MAX_HUMAN_LIVE_SHADOW_MESSAGE_REQUEST_WIRE_BYTES_V4) {
    throw new TypeError("Human live Shadow Message V4 request bytes are invalid");
  }
  const raw = decodeExact(bytes, (reader): HumanLiveShadowMessageRequestV4 => {
    if (reader.readText(utf8V2(HUMAN_LIVE_SHADOW_MESSAGE_REQUEST_DOMAIN_V4).length)
      !== HUMAN_LIVE_SHADOW_MESSAGE_REQUEST_DOMAIN_V4) {
      throw new CanonicalDecodingError("Human live Shadow V4 request domain mismatch");
    }
    return {
      formatVersion: reader.readVersion(4) as 4,
      purpose: reader.readText(64) as typeof HUMAN_LIVE_SHADOW_MESSAGE_REQUEST_PURPOSE_V4,
      normalizationVersion: reader.readVersion(1) as 1,
      subjectHumanId: humanId(reader.readText(V2_LIMITS.idBytes)),
      operationId: reader.readText(V2_LIMITS.idBytes),
      policyRevision: reader.readU64(), sessionId: reader.readText(36),
      roomId: reader.readText(36), messageId: reader.readU64(),
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
      authorization: readAuthorizationProof(reader),
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
    canonical = encodeHumanLiveShadowMessageRequestV4(raw);
    if (!sameBytes(bytes, canonical)) {
      throw new CanonicalDecodingError("Human live Shadow V4 request is noncanonical");
    }
    return raw;
  } catch (error) {
    destroyRequest(raw);
    throw error;
  } finally {
    canonical?.fill(0);
  }
}

export function prepareHumanLiveShadowMessageRequestV4(
  crypto: LatticeCrypto,
  input: PrepareHumanLiveShadowMessageRequestInputV4,
): CreatedHumanLiveShadowMessageRequestV4 {
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
  const {
    committerSigningPublicKey: _public,
    committerSigningPrivateKey: _private,
    ...rest
  } = input;
  const normalized = normalizeRequestUnsigned({
    ...rest,
    formatVersion: 4,
    purpose: HUMAN_LIVE_SHADOW_MESSAGE_REQUEST_PURPOSE_V4,
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
    const bytes = encodeHumanLiveShadowMessageRequestV4({
      ...normalized,
      signature,
    });
    return Object.freeze({
      request: decodeHumanLiveShadowMessageRequestV4(bytes),
      bytes,
      requestDigest: sha256(bytes),
    });
  } finally {
    publicKey.fill(0); privateKey.fill(0); signingBytes?.fill(0);
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
    resolveCurrentAuthority: ResolveCurrentHumanLiveShadowMessageAuthorityV4;
  }>,
  enforceFreshness: boolean,
): HumanLiveShadowMessageRequestV4 {
  let request: HumanLiveShadowMessageRequestV4 | undefined;
  let signingBytes: Uint8Array | undefined;
  let currentKey: Uint8Array | undefined;
  let actualDigest: Uint8Array | undefined;
  let expectedDigest: Uint8Array | undefined;
  let verified = false;
  try {
    request = decodeHumanLiveShadowMessageRequestV4(input.requestBytes);
    if (enforceFreshness) {
      const now = unixTimestamp(input.now);
      if (now < request.issuedAt || now >= request.deadlineAt) {
        throw new TypeError("Human live Shadow V4 request is not currently valid");
      }
    }
    if (input.expectedRequestDigest !== undefined) {
      expectedDigest = exactBytes(
        "Expected Human live Shadow V4 request digest",
        input.expectedRequestDigest,
        HASH_BYTES,
      );
      actualDigest = sha256(input.requestBytes);
      if (!sameBytes(actualDigest, expectedDigest)) {
        throw new TypeError("Human live Shadow V4 durable request digest disagrees");
      }
    }
    currentKey = input.resolveCurrentAuthority({
      purpose: "human-live-shadow-message-v4-verify",
      subjectHumanId: request.subjectHumanId,
      operationId: request.operationId,
      committerDeviceId: request.committerDeviceId,
      committerDeviceSigningKeyGeneration:
        request.committerDeviceSigningKeyGeneration,
      hostAuthorizationRevision: request.hostAuthorizationRevision,
    })?.slice();
    if (currentKey === undefined) {
      throw new TypeError("Human live Shadow V4 authority is unavailable");
    }
    signingBytes = humanLiveShadowMessageRequestSigningBytesV4(request);
    if (!crypto.verify(currentKey, signingBytes, request.signature)) {
      throw new TypeError("Human live Shadow V4 signature is invalid");
    }
    verified = true;
    const result = request;
    request = undefined;
    return result;
  } finally {
    if (!verified && request) destroyRequest(request);
    signingBytes?.fill(0); currentKey?.fill(0); actualDigest?.fill(0);
    expectedDigest?.fill(0);
  }
}

export function verifyHumanLiveShadowMessageRequestV4(
  crypto: LatticeCrypto,
  input: Readonly<{
    requestBytes: Uint8Array;
    now: UnixTimestamp;
    resolveCurrentAuthority: ResolveCurrentHumanLiveShadowMessageAuthorityV4;
  }>,
): HumanLiveShadowMessageRequestV4 {
  return verifyRequest(crypto, input, true);
}

export function verifyHumanLiveShadowMessageRequestExactReplayV4(
  crypto: LatticeCrypto,
  input: Readonly<{
    requestBytes: Uint8Array;
    expectedRequestDigest: Uint8Array;
    resolveCurrentAuthority: ResolveCurrentHumanLiveShadowMessageAuthorityV4;
  }>,
): HumanLiveShadowMessageRequestV4 {
  return verifyRequest(crypto, input, false);
}

export function humanLiveShadowMessageRequestDigestV4(
  bytes: Uint8Array,
): Uint8Array {
  const request = decodeHumanLiveShadowMessageRequestV4(bytes);
  try {
    return sha256(bytes);
  } finally {
    destroyRequest(request);
  }
}
