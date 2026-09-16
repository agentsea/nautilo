import type { LatticeCrypto } from "../crypto/index.ts";
import { compareUnsignedUtf8 } from "../domain/participants.ts";
import {
  deviceWrappedDomainAgentGrantAuthoritySetDigestV1,
  type DeviceWrappedDomainAgentGrantAuthorityEntryV1,
  type DeviceWrappedDomainAgentGrantOperationV1,
  type DeviceWrappedDomainAgentGrantSecretEntryV1,
} from "./device-wrapped-domain-agent-grant-v1.ts";
import type {
  AgentId,
  AuthorizationRevision,
  CryptoDeviceId,
  HumanId,
} from "../v2-types/ids.ts";
import {
  agentId,
  assertPortableId,
  assertU64Counter,
  authorizationRevision,
  cryptoDeviceId,
  humanId,
} from "../v2-types/ids.ts";
import { V2_LIMITS } from "../v2-types/limits.ts";
import { copyOwnedBytesV2 } from "../v2-types/opaque.ts";
import {
  concatV2,
  decodeExact,
  encodeU32,
  encodeU64,
  frame,
  frameText,
} from "./v2-primitives.ts";

export const DEVICE_WRAPPED_DOMAIN_AGENT_FOREGROUND_AUTHORIZATION_V1_FORMAT_VERSION =
  1 as const;
export const DEVICE_WRAPPED_DOMAIN_AGENT_FOREGROUND_AUTHORIZATION_V1_PLAN_PURPOSE =
  "device_wrapped_grant_domain.agent_foreground_authorization_plan" as const;
export const DEVICE_WRAPPED_DOMAIN_AGENT_FOREGROUND_AUTHORIZATION_V1_PURPOSE =
  "device_wrapped_grant_domain.agent_foreground_authorization" as const;
export const DEVICE_WRAPPED_DOMAIN_AGENT_FOREGROUND_AUTHORIZATION_V1_SECRET_PURPOSE =
  "device_wrapped_grant_domain.agent_foreground_authorization_secret" as const;
export const DEVICE_WRAPPED_DOMAIN_AGENT_FOREGROUND_AUTHORIZATION_V1_SCHEME =
  "device_wrapped_grant_domain_foreground_session_v1" as const;
export const DEVICE_WRAPPED_DOMAIN_AGENT_FOREGROUND_AUTHORIZATION_V1_MAX_DOMAINS =
  V2_LIMITS.distinctDomainsPerGrant;
export const DEVICE_WRAPPED_DOMAIN_AGENT_FOREGROUND_AUTHORIZATION_V1_MAX_SECRET_BYTES =
  V2_LIMITS.grantSecretBytes;
export const DEVICE_WRAPPED_DOMAIN_AGENT_FOREGROUND_AUTHORIZATION_V1_MAX_WIRE_BYTES =
  V2_LIMITS.grantWireBytes;
export const DEVICE_WRAPPED_DOMAIN_AGENT_FOREGROUND_AUTHORIZATION_V1_MAX_TTL_MS =
  2 * 60 * 60 * 1000;

const PLAN_DOMAIN =
  "nautilo/lattice-crypto/device-wrapped-domain-agent-foreground-authorization-plan/v1";
const SECRET_DOMAIN =
  "nautilo/lattice-crypto/device-wrapped-domain-agent-foreground-authorization-secret/v1";
const AUTHORIZATION_DOMAIN =
  "nautilo/lattice-crypto/device-wrapped-domain-agent-foreground-authorization/v1";
const HASH_BYTES = 32;
const KEY_BYTES = 32;

export type DeviceWrappedDomainAgentForegroundAuthorizationOperationV1 =
  DeviceWrappedDomainAgentGrantOperationV1;
export type DeviceWrappedDomainAgentForegroundAuthorizationAuthorityEntryV1 =
  DeviceWrappedDomainAgentGrantAuthorityEntryV1;
export type DeviceWrappedDomainAgentForegroundAuthorizationSecretEntryV1 =
  DeviceWrappedDomainAgentGrantSecretEntryV1;

export interface DeviceWrappedDomainAgentForegroundAuthorizationPlanV1 {
  readonly formatVersion:
    typeof DEVICE_WRAPPED_DOMAIN_AGENT_FOREGROUND_AUTHORIZATION_V1_FORMAT_VERSION;
  readonly purpose:
    typeof DEVICE_WRAPPED_DOMAIN_AGENT_FOREGROUND_AUTHORIZATION_V1_PLAN_PURPOSE;
  readonly scheme:
    typeof DEVICE_WRAPPED_DOMAIN_AGENT_FOREGROUND_AUTHORIZATION_V1_SCHEME;
  readonly authorizationId: string;
  readonly policyRevision: number;
  readonly sessionId: string;
  readonly roomId: string;
  readonly subjectHumanId: HumanId;
  readonly committerDeviceId: CryptoDeviceId;
  readonly committerDeviceSigningGeneration: number;
  readonly hostAuthorizationRevision: AuthorizationRevision;
  readonly recipientAgentId: AgentId;
  readonly agentAuthorizationRevision: AuthorizationRevision;
  readonly agentRuntimeGeneration: number;
  readonly recipientKeyId: string;
  readonly operations: readonly DeviceWrappedDomainAgentForegroundAuthorizationOperationV1[];
  readonly issuedAt: number;
  readonly deadlineAt: number;
  readonly domainCount: number;
  readonly maximumSecretBytes: number;
  readonly domainAuthoritySetDigest: Uint8Array;
  readonly domains: readonly DeviceWrappedDomainAgentForegroundAuthorizationAuthorityEntryV1[];
}

export interface DeviceWrappedDomainAgentForegroundAuthorizationSecretV1 {
  readonly formatVersion:
    typeof DEVICE_WRAPPED_DOMAIN_AGENT_FOREGROUND_AUTHORIZATION_V1_FORMAT_VERSION;
  readonly purpose:
    typeof DEVICE_WRAPPED_DOMAIN_AGENT_FOREGROUND_AUTHORIZATION_V1_SECRET_PURPOSE;
  readonly authorizationId: string;
  readonly sessionId: string;
  readonly roomId: string;
  readonly subjectHumanId: HumanId;
  readonly committerDeviceId: CryptoDeviceId;
  readonly recipientAgentId: AgentId;
  readonly agentRuntimeGeneration: number;
  readonly recipientKeyId: string;
  readonly domainAuthoritySetDigest: Uint8Array;
  readonly domainCount: number;
  readonly domains: readonly DeviceWrappedDomainAgentForegroundAuthorizationSecretEntryV1[];
}

export interface DeviceWrappedDomainAgentForegroundAuthorizationV1 {
  readonly formatVersion:
    typeof DEVICE_WRAPPED_DOMAIN_AGENT_FOREGROUND_AUTHORIZATION_V1_FORMAT_VERSION;
  readonly purpose:
    typeof DEVICE_WRAPPED_DOMAIN_AGENT_FOREGROUND_AUTHORIZATION_V1_PURPOSE;
  readonly scheme:
    typeof DEVICE_WRAPPED_DOMAIN_AGENT_FOREGROUND_AUTHORIZATION_V1_SCHEME;
  readonly authorizationId: string;
  readonly planBytes: Uint8Array;
  readonly planDigest: Uint8Array;
  readonly domainCount: number;
  readonly secretDigest: Uint8Array;
  readonly encryptedSecret: Uint8Array;
  readonly encryptedSecretDigest: Uint8Array;
  readonly signature: Uint8Array;
}

export interface DeviceWrappedDomainAgentForegroundAuthorizationCurrentAuthorityV1 {
  readonly authorizationId: string;
  readonly policyRevision: number;
  readonly sessionId: string;
  readonly roomId: string;
  readonly subjectHumanId: HumanId;
  readonly committerDeviceId: CryptoDeviceId;
  readonly committerDeviceSigningGeneration: number;
  readonly committerDeviceSigningPublicKey: Uint8Array;
  readonly committerDeviceActive: boolean;
  readonly hostAuthorizationRevision: AuthorizationRevision;
  readonly recipientAgentId: AgentId;
  readonly agentAuthorizationRevision: AuthorizationRevision;
  readonly agentRuntimeGeneration: number;
  readonly recipientKeyId: string;
  readonly recipientEncryptionPrivateKey: Uint8Array;
  readonly agentAuthorized: boolean;
  readonly domains: readonly DeviceWrappedDomainAgentForegroundAuthorizationAuthorityEntryV1[];
}

export type OpenDeviceWrappedDomainAgentForegroundAuthorizationResultV1<Value> =
  | Readonly<{ status: "opened"; value: Value }>
  | Readonly<{
      status: "unavailable";
      reason:
        | "invalid"
        | "expired"
        | "authority_stale"
        | "secret_unavailable";
    }>;

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length
    && left.every((value, index) => value === right[index]);
}

function portable(label: string, value: unknown): string {
  assertPortableId(label, value);
  return value;
}

function counter(label: string, value: unknown, minimum = 0): number {
  assertU64Counter(label, value);
  if (value < minimum) throw new RangeError(`${label} is below its minimum`);
  return value;
}

function exactBytes(label: string, value: unknown, length: number): Uint8Array {
  if (!(value instanceof Uint8Array) || value.length !== length) {
    throw new RangeError(`${label} must be exactly ${length} bytes`);
  }
  return copyOwnedBytesV2(value);
}

function assertExactBytes(
  label: string,
  value: unknown,
  length: number,
): asserts value is Uint8Array {
  if (!(value instanceof Uint8Array) || value.length !== length) {
    throw new RangeError(`${label} must be exactly ${length} bytes`);
  }
}

function canonicalOperations(
  values: readonly DeviceWrappedDomainAgentForegroundAuthorizationOperationV1[],
): readonly DeviceWrappedDomainAgentForegroundAuthorizationOperationV1[] {
  if (!Array.isArray(values as unknown) || values.length !== 2) {
    throw new RangeError("Foreground authorization operation set is invalid");
  }
  const canonical = [...new Set(values)].sort(compareUnsignedUtf8);
  if (
    canonical.length !== 2
    || canonical[0] !== "decrypt"
    || canonical[1] !== "encrypt"
    || canonical.some((value, index) => value !== values[index])
  ) throw new TypeError("Foreground authorization operations must be decrypt, encrypt");
  return Object.freeze(canonical);
}

function normalizeAuthorityEntry(
  value: DeviceWrappedDomainAgentForegroundAuthorizationAuthorityEntryV1,
): DeviceWrappedDomainAgentForegroundAuthorizationAuthorityEntryV1 {
  return Object.freeze({
    grantDomainId: portable("Grant Domain ID", value.grantDomainId),
    participantDigest: exactBytes("Grant Domain participant digest", value.participantDigest, HASH_BYTES),
    domainKeyGeneration: counter("Grant Domain key generation", value.domainKeyGeneration, 1),
    headDigest: exactBytes("Grant Domain head digest", value.headDigest, HASH_BYTES),
    publicationDigest: exactBytes("Grant Domain publication digest", value.publicationDigest, HASH_BYTES),
    publicationAuthorizationRevision: authorizationRevision(
      value.publicationAuthorizationRevision,
    ),
    authorizationRevision: authorizationRevision(value.authorizationRevision),
    activeNamespaceBindingSetDigest: exactBytes(
      "Grant Domain active binding-set digest",
      value.activeNamespaceBindingSetDigest,
      HASH_BYTES,
    ),
    activeNamespaceBindingCount: counter(
      "Grant Domain active binding count",
      value.activeNamespaceBindingCount,
    ),
  });
}

function canonicalAuthority(
  values: readonly DeviceWrappedDomainAgentForegroundAuthorizationAuthorityEntryV1[],
): readonly DeviceWrappedDomainAgentForegroundAuthorizationAuthorityEntryV1[] {
  if (
    !Array.isArray(values as unknown)
    || values.length < 1
    || values.length
      > DEVICE_WRAPPED_DOMAIN_AGENT_FOREGROUND_AUTHORIZATION_V1_MAX_DOMAINS
  ) throw new RangeError("Foreground authorization Domain count is invalid");
  const domains = values.map(normalizeAuthorityEntry);
  for (let index = 1; index < domains.length; index += 1) {
    if (
      compareUnsignedUtf8(
        domains[index - 1]!.grantDomainId,
        domains[index]!.grantDomainId,
      ) >= 0
    ) {
      domains.forEach(destroyAuthorityEntry);
      throw new TypeError("Foreground authorization authority must be canonical and unique");
    }
  }
  return Object.freeze(domains);
}

function authorityEntryBytes(
  value: DeviceWrappedDomainAgentForegroundAuthorizationAuthorityEntryV1,
): Uint8Array {
  return concatV2(
    frameText(value.grantDomainId),
    frame(value.participantDigest),
    encodeU64(value.domainKeyGeneration),
    frame(value.headDigest),
    frame(value.publicationDigest),
    encodeU64(value.publicationAuthorizationRevision),
    encodeU64(value.authorizationRevision),
    frame(value.activeNamespaceBindingSetDigest),
    encodeU64(value.activeNamespaceBindingCount),
  );
}

function destroyAuthorityEntry(
  value: DeviceWrappedDomainAgentForegroundAuthorizationAuthorityEntryV1,
): void {
  value.participantDigest.fill(0);
  value.headDigest.fill(0);
  value.publicationDigest.fill(0);
  value.activeNamespaceBindingSetDigest.fill(0);
}

function authoritySetDigest(
  crypto: Pick<LatticeCrypto, "hash">,
  values: readonly DeviceWrappedDomainAgentForegroundAuthorizationAuthorityEntryV1[],
): Uint8Array {
  return deviceWrappedDomainAgentGrantAuthoritySetDigestV1(crypto, values);
}

export function createDeviceWrappedDomainAgentForegroundAuthorizationPlanV1(
  crypto: Pick<LatticeCrypto, "hash">,
  input: Omit<
    DeviceWrappedDomainAgentForegroundAuthorizationPlanV1,
    | "formatVersion"
    | "purpose"
    | "scheme"
    | "domainCount"
    | "domainAuthoritySetDigest"
  >,
): DeviceWrappedDomainAgentForegroundAuthorizationPlanV1 {
  const digest = authoritySetDigest(crypto, input.domains);
  try {
    return normalizePlan({
      ...input,
      formatVersion:
        DEVICE_WRAPPED_DOMAIN_AGENT_FOREGROUND_AUTHORIZATION_V1_FORMAT_VERSION,
      purpose:
        DEVICE_WRAPPED_DOMAIN_AGENT_FOREGROUND_AUTHORIZATION_V1_PLAN_PURPOSE,
      scheme: DEVICE_WRAPPED_DOMAIN_AGENT_FOREGROUND_AUTHORIZATION_V1_SCHEME,
      domainCount: input.domains.length,
      domainAuthoritySetDigest: digest,
    });
  } finally {
    digest.fill(0);
  }
}

function normalizePlan(
  value: DeviceWrappedDomainAgentForegroundAuthorizationPlanV1,
): DeviceWrappedDomainAgentForegroundAuthorizationPlanV1 {
  if (
    value.formatVersion
      !== DEVICE_WRAPPED_DOMAIN_AGENT_FOREGROUND_AUTHORIZATION_V1_FORMAT_VERSION
    || value.purpose
      !== DEVICE_WRAPPED_DOMAIN_AGENT_FOREGROUND_AUTHORIZATION_V1_PLAN_PURPOSE
    || value.scheme
      !== DEVICE_WRAPPED_DOMAIN_AGENT_FOREGROUND_AUTHORIZATION_V1_SCHEME
  ) throw new TypeError("Foreground authorization plan version is unsupported");
  const operations = canonicalOperations(value.operations);
  const domains = canonicalAuthority(value.domains);
  if (value.domainCount !== domains.length) {
    domains.forEach(destroyAuthorityEntry);
    throw new TypeError("Foreground authorization Domain count disagrees");
  }
  const issuedAt = counter("Foreground authorization issued time", value.issuedAt);
  const deadlineAt = counter("Foreground authorization deadline", value.deadlineAt);
  if (
    deadlineAt <= issuedAt
    || deadlineAt - issuedAt
      > DEVICE_WRAPPED_DOMAIN_AGENT_FOREGROUND_AUTHORIZATION_V1_MAX_TTL_MS
  ) {
    domains.forEach(destroyAuthorityEntry);
    throw new RangeError("Foreground authorization deadline is invalid");
  }
  const maximumSecretBytes = counter(
    "Foreground authorization maximum secret bytes",
    value.maximumSecretBytes,
    1,
  );
  if (
    maximumSecretBytes
      > DEVICE_WRAPPED_DOMAIN_AGENT_FOREGROUND_AUTHORIZATION_V1_MAX_SECRET_BYTES
  ) {
    domains.forEach(destroyAuthorityEntry);
    throw new RangeError("Foreground authorization secret bound is invalid");
  }
  return Object.freeze({
    formatVersion:
      DEVICE_WRAPPED_DOMAIN_AGENT_FOREGROUND_AUTHORIZATION_V1_FORMAT_VERSION,
    purpose:
      DEVICE_WRAPPED_DOMAIN_AGENT_FOREGROUND_AUTHORIZATION_V1_PLAN_PURPOSE,
    scheme: DEVICE_WRAPPED_DOMAIN_AGENT_FOREGROUND_AUTHORIZATION_V1_SCHEME,
    authorizationId: portable(
      "Foreground authorization ID",
      value.authorizationId,
    ),
    policyRevision: counter("Foreground authorization policy revision", value.policyRevision),
    sessionId: portable("Foreground authorization Session ID", value.sessionId),
    roomId: portable("Foreground authorization Room ID", value.roomId),
    subjectHumanId: humanId(value.subjectHumanId),
    committerDeviceId: cryptoDeviceId(value.committerDeviceId),
    committerDeviceSigningGeneration: counter(
      "Foreground authorization device signing generation",
      value.committerDeviceSigningGeneration,
      1,
    ),
    hostAuthorizationRevision: authorizationRevision(
      value.hostAuthorizationRevision,
    ),
    recipientAgentId: agentId(value.recipientAgentId),
    agentAuthorizationRevision: authorizationRevision(
      value.agentAuthorizationRevision,
    ),
    agentRuntimeGeneration: counter(
      "Foreground authorization Agent Runtime generation",
      value.agentRuntimeGeneration,
    ),
    recipientKeyId: portable(
      "Foreground authorization recipient key ID",
      value.recipientKeyId,
    ),
    operations,
    issuedAt,
    deadlineAt,
    domainCount: domains.length,
    maximumSecretBytes,
    domainAuthoritySetDigest: exactBytes(
      "Foreground authorization authority-set digest",
      value.domainAuthoritySetDigest,
      HASH_BYTES,
    ),
    domains,
  });
}

function planBytes(
  value: DeviceWrappedDomainAgentForegroundAuthorizationPlanV1,
): Uint8Array {
  return concatV2(
    frameText(PLAN_DOMAIN),
    encodeU32(value.formatVersion),
    frameText(value.purpose),
    frameText(value.scheme),
    frameText(value.authorizationId),
    encodeU64(value.policyRevision),
    frameText(value.sessionId),
    frameText(value.roomId),
    frameText(value.subjectHumanId),
    frameText(value.committerDeviceId),
    encodeU64(value.committerDeviceSigningGeneration),
    encodeU64(value.hostAuthorizationRevision),
    frameText(value.recipientAgentId),
    encodeU64(value.agentAuthorizationRevision),
    encodeU64(value.agentRuntimeGeneration),
    frameText(value.recipientKeyId),
    encodeU32(value.operations.length),
    ...value.operations.map(frameText),
    encodeU64(value.issuedAt),
    encodeU64(value.deadlineAt),
    encodeU32(value.domainCount),
    encodeU64(value.maximumSecretBytes),
    frame(value.domainAuthoritySetDigest),
    encodeU32(value.domains.length),
    ...value.domains.map(authorityEntryBytes),
  );
}

export function serializeDeviceWrappedDomainAgentForegroundAuthorizationPlanV1(
  value: DeviceWrappedDomainAgentForegroundAuthorizationPlanV1,
): Uint8Array {
  const normalized = normalizePlan(value);
  try {
    return planBytes(normalized);
  } finally {
    destroyDeviceWrappedDomainAgentForegroundAuthorizationPlanV1(normalized);
  }
}

export function parseDeviceWrappedDomainAgentForegroundAuthorizationPlanV1(
  bytes: Uint8Array,
): DeviceWrappedDomainAgentForegroundAuthorizationPlanV1 | null {
  if (
    !(bytes instanceof Uint8Array)
    || bytes.length
      > DEVICE_WRAPPED_DOMAIN_AGENT_FOREGROUND_AUTHORIZATION_V1_MAX_WIRE_BYTES
  ) return null;
  try {
    const value = decodeExact(bytes, (reader) => {
      if (reader.readText(256) !== PLAN_DOMAIN) {
        throw new TypeError("Foreground authorization plan domain is invalid");
      }
      reader.readVersion(
        DEVICE_WRAPPED_DOMAIN_AGENT_FOREGROUND_AUTHORIZATION_V1_FORMAT_VERSION,
      );
      if (
        reader.readText(128)
          !== DEVICE_WRAPPED_DOMAIN_AGENT_FOREGROUND_AUTHORIZATION_V1_PLAN_PURPOSE
        || reader.readText(128)
          !== DEVICE_WRAPPED_DOMAIN_AGENT_FOREGROUND_AUTHORIZATION_V1_SCHEME
      ) throw new TypeError("Foreground authorization plan purpose is invalid");
      const authorizationId = reader.readText(V2_LIMITS.idBytes);
      const policyRevision = reader.readU64();
      const sessionId = reader.readText(V2_LIMITS.idBytes);
      const roomId = reader.readText(V2_LIMITS.idBytes);
      const subjectHumanId = humanId(reader.readText(V2_LIMITS.idBytes));
      const committerDeviceId = cryptoDeviceId(reader.readText(V2_LIMITS.idBytes));
      const committerDeviceSigningGeneration = reader.readU64();
      const hostAuthorizationRevision = authorizationRevision(reader.readU64());
      const recipientAgentId = agentId(reader.readText(V2_LIMITS.idBytes));
      const agentAuthorizationRevision = authorizationRevision(reader.readU64());
      const agentRuntimeGeneration = reader.readU64();
      const recipientKeyId = reader.readText(V2_LIMITS.idBytes);
      const operationCount = reader.readCount(2);
      const operations = Array.from({ length: operationCount }, () =>
        reader.readText(16) as DeviceWrappedDomainAgentForegroundAuthorizationOperationV1
      );
      const issuedAt = reader.readU64();
      const deadlineAt = reader.readU64();
      const domainCount = reader.readCount(
        DEVICE_WRAPPED_DOMAIN_AGENT_FOREGROUND_AUTHORIZATION_V1_MAX_DOMAINS,
      );
      const maximumSecretBytes = reader.readU64();
      const domainAuthoritySetDigest = reader.readFrame(HASH_BYTES);
      const encodedCount = reader.readCount(
        DEVICE_WRAPPED_DOMAIN_AGENT_FOREGROUND_AUTHORIZATION_V1_MAX_DOMAINS,
      );
      if (encodedCount !== domainCount) {
        throw new TypeError("Foreground authorization Domain count disagrees");
      }
      const domains = Array.from({ length: encodedCount }, () => Object.freeze({
        grantDomainId: reader.readText(V2_LIMITS.idBytes),
        participantDigest: reader.readFrame(HASH_BYTES),
        domainKeyGeneration: reader.readU64(),
        headDigest: reader.readFrame(HASH_BYTES),
        publicationDigest: reader.readFrame(HASH_BYTES),
        publicationAuthorizationRevision: authorizationRevision(reader.readU64()),
        authorizationRevision: authorizationRevision(reader.readU64()),
        activeNamespaceBindingSetDigest: reader.readFrame(HASH_BYTES),
        activeNamespaceBindingCount: reader.readU64(),
      }));
      return normalizePlan({
        formatVersion:
          DEVICE_WRAPPED_DOMAIN_AGENT_FOREGROUND_AUTHORIZATION_V1_FORMAT_VERSION,
        purpose:
          DEVICE_WRAPPED_DOMAIN_AGENT_FOREGROUND_AUTHORIZATION_V1_PLAN_PURPOSE,
        scheme: DEVICE_WRAPPED_DOMAIN_AGENT_FOREGROUND_AUTHORIZATION_V1_SCHEME,
        authorizationId,
        policyRevision,
        sessionId,
        roomId,
        subjectHumanId,
        committerDeviceId,
        committerDeviceSigningGeneration,
        hostAuthorizationRevision,
        recipientAgentId,
        agentAuthorizationRevision,
        agentRuntimeGeneration,
        recipientKeyId,
        operations,
        issuedAt,
        deadlineAt,
        domainCount,
        maximumSecretBytes,
        domainAuthoritySetDigest,
        domains,
      });
    });
    const canonical = planBytes(value);
    const matches = sameBytes(canonical, bytes);
    canonical.fill(0);
    if (!matches) {
      destroyDeviceWrappedDomainAgentForegroundAuthorizationPlanV1(value);
      return null;
    }
    return value;
  } catch {
    return null;
  }
}

export function destroyDeviceWrappedDomainAgentForegroundAuthorizationPlanV1(
  value: DeviceWrappedDomainAgentForegroundAuthorizationPlanV1,
): void {
  value.domainAuthoritySetDigest.fill(0);
  value.domains.forEach(destroyAuthorityEntry);
}

function normalizeSecretEntry(
  value: DeviceWrappedDomainAgentForegroundAuthorizationSecretEntryV1,
): DeviceWrappedDomainAgentForegroundAuthorizationSecretEntryV1 {
  return Object.freeze({
    grantDomainId: portable("Grant Domain ID", value.grantDomainId),
    domainKeyGeneration: counter("Grant Domain key generation", value.domainKeyGeneration, 1),
    participantDigest: exactBytes("Grant Domain participant digest", value.participantDigest, HASH_BYTES),
    headDigest: exactBytes("Grant Domain head digest", value.headDigest, HASH_BYTES),
    authorizationRevision: authorizationRevision(value.authorizationRevision),
    domainAiGrantKey: exactBytes("Grant Domain AI key", value.domainAiGrantKey, KEY_BYTES),
  });
}

function canonicalSecretEntries(
  values: readonly DeviceWrappedDomainAgentForegroundAuthorizationSecretEntryV1[],
): readonly DeviceWrappedDomainAgentForegroundAuthorizationSecretEntryV1[] {
  if (
    !Array.isArray(values as unknown)
    || values.length < 1
    || values.length
      > DEVICE_WRAPPED_DOMAIN_AGENT_FOREGROUND_AUTHORIZATION_V1_MAX_DOMAINS
  ) throw new RangeError("Foreground authorization secret count is invalid");
  const entries = values.map(normalizeSecretEntry);
  for (let index = 1; index < entries.length; index += 1) {
    if (
      compareUnsignedUtf8(
        entries[index - 1]!.grantDomainId,
        entries[index]!.grantDomainId,
      ) >= 0
    ) {
      entries.forEach(destroySecretEntry);
      throw new TypeError("Foreground authorization secret must be canonical and unique");
    }
  }
  return Object.freeze(entries);
}

function secretEntryBytes(
  value: DeviceWrappedDomainAgentForegroundAuthorizationSecretEntryV1,
): Uint8Array {
  return concatV2(
    frameText(value.grantDomainId),
    encodeU64(value.domainKeyGeneration),
    frame(value.participantDigest),
    frame(value.headDigest),
    encodeU64(value.authorizationRevision),
    frame(value.domainAiGrantKey),
  );
}

function destroySecretEntry(
  value: DeviceWrappedDomainAgentForegroundAuthorizationSecretEntryV1,
): void {
  value.participantDigest.fill(0);
  value.headDigest.fill(0);
  value.domainAiGrantKey.fill(0);
}

function normalizeSecret(
  value: DeviceWrappedDomainAgentForegroundAuthorizationSecretV1,
): DeviceWrappedDomainAgentForegroundAuthorizationSecretV1 {
  if (
    value.formatVersion
      !== DEVICE_WRAPPED_DOMAIN_AGENT_FOREGROUND_AUTHORIZATION_V1_FORMAT_VERSION
    || value.purpose
      !== DEVICE_WRAPPED_DOMAIN_AGENT_FOREGROUND_AUTHORIZATION_V1_SECRET_PURPOSE
  ) throw new TypeError("Foreground authorization secret version is unsupported");
  const domains = canonicalSecretEntries(value.domains);
  if (value.domainCount !== domains.length) {
    domains.forEach(destroySecretEntry);
    throw new TypeError("Foreground authorization secret count disagrees");
  }
  return Object.freeze({
    formatVersion:
      DEVICE_WRAPPED_DOMAIN_AGENT_FOREGROUND_AUTHORIZATION_V1_FORMAT_VERSION,
    purpose:
      DEVICE_WRAPPED_DOMAIN_AGENT_FOREGROUND_AUTHORIZATION_V1_SECRET_PURPOSE,
    authorizationId: portable(
      "Foreground authorization ID",
      value.authorizationId,
    ),
    sessionId: portable("Foreground authorization Session ID", value.sessionId),
    roomId: portable("Foreground authorization Room ID", value.roomId),
    subjectHumanId: humanId(value.subjectHumanId),
    committerDeviceId: cryptoDeviceId(value.committerDeviceId),
    recipientAgentId: agentId(value.recipientAgentId),
    agentRuntimeGeneration: counter(
      "Foreground authorization Agent Runtime generation",
      value.agentRuntimeGeneration,
    ),
    recipientKeyId: portable(
      "Foreground authorization recipient key ID",
      value.recipientKeyId,
    ),
    domainAuthoritySetDigest: exactBytes(
      "Foreground authorization authority-set digest",
      value.domainAuthoritySetDigest,
      HASH_BYTES,
    ),
    domainCount: domains.length,
    domains,
  });
}

function secretBytes(
  value: DeviceWrappedDomainAgentForegroundAuthorizationSecretV1,
): Uint8Array {
  return concatV2(
    frameText(SECRET_DOMAIN),
    encodeU32(value.formatVersion),
    frameText(value.purpose),
    frameText(value.authorizationId),
    frameText(value.sessionId),
    frameText(value.roomId),
    frameText(value.subjectHumanId),
    frameText(value.committerDeviceId),
    frameText(value.recipientAgentId),
    encodeU64(value.agentRuntimeGeneration),
    frameText(value.recipientKeyId),
    frame(value.domainAuthoritySetDigest),
    encodeU32(value.domainCount),
    ...value.domains.map(secretEntryBytes),
  );
}

export function serializeDeviceWrappedDomainAgentForegroundAuthorizationSecretV1(
  value: DeviceWrappedDomainAgentForegroundAuthorizationSecretV1,
): Uint8Array {
  const normalized = normalizeSecret(value);
  try {
    const bytes = secretBytes(normalized);
    if (
      bytes.length
        > DEVICE_WRAPPED_DOMAIN_AGENT_FOREGROUND_AUTHORIZATION_V1_MAX_SECRET_BYTES
    ) {
      bytes.fill(0);
      throw new RangeError("Foreground authorization secret exceeds its wire bound");
    }
    return bytes;
  } finally {
    destroyDeviceWrappedDomainAgentForegroundAuthorizationSecretV1(normalized);
  }
}

export function parseDeviceWrappedDomainAgentForegroundAuthorizationSecretV1(
  bytes: Uint8Array,
): DeviceWrappedDomainAgentForegroundAuthorizationSecretV1 | null {
  if (
    !(bytes instanceof Uint8Array)
    || bytes.length
      > DEVICE_WRAPPED_DOMAIN_AGENT_FOREGROUND_AUTHORIZATION_V1_MAX_SECRET_BYTES
  ) return null;
  try {
    const value = decodeExact(bytes, (reader) => {
      if (reader.readText(256) !== SECRET_DOMAIN) {
        throw new TypeError("Foreground authorization secret domain is invalid");
      }
      reader.readVersion(
        DEVICE_WRAPPED_DOMAIN_AGENT_FOREGROUND_AUTHORIZATION_V1_FORMAT_VERSION,
      );
      if (
        reader.readText(128)
          !== DEVICE_WRAPPED_DOMAIN_AGENT_FOREGROUND_AUTHORIZATION_V1_SECRET_PURPOSE
      ) throw new TypeError("Foreground authorization secret purpose is invalid");
      const authorizationId = reader.readText(V2_LIMITS.idBytes);
      const sessionId = reader.readText(V2_LIMITS.idBytes);
      const roomId = reader.readText(V2_LIMITS.idBytes);
      const subjectHumanId = humanId(reader.readText(V2_LIMITS.idBytes));
      const committerDeviceId = cryptoDeviceId(reader.readText(V2_LIMITS.idBytes));
      const recipientAgentId = agentId(reader.readText(V2_LIMITS.idBytes));
      const agentRuntimeGeneration = reader.readU64();
      const recipientKeyId = reader.readText(V2_LIMITS.idBytes);
      const domainAuthoritySetDigest = reader.readFrame(HASH_BYTES);
      const domainCount = reader.readCount(
        DEVICE_WRAPPED_DOMAIN_AGENT_FOREGROUND_AUTHORIZATION_V1_MAX_DOMAINS,
      );
      const domains = Array.from({ length: domainCount }, () => Object.freeze({
        grantDomainId: reader.readText(V2_LIMITS.idBytes),
        domainKeyGeneration: reader.readU64(),
        participantDigest: reader.readFrame(HASH_BYTES),
        headDigest: reader.readFrame(HASH_BYTES),
        authorizationRevision: authorizationRevision(reader.readU64()),
        domainAiGrantKey: reader.readFrame(KEY_BYTES),
      }));
      return normalizeSecret({
        formatVersion:
          DEVICE_WRAPPED_DOMAIN_AGENT_FOREGROUND_AUTHORIZATION_V1_FORMAT_VERSION,
        purpose:
          DEVICE_WRAPPED_DOMAIN_AGENT_FOREGROUND_AUTHORIZATION_V1_SECRET_PURPOSE,
        authorizationId,
        sessionId,
        roomId,
        subjectHumanId,
        committerDeviceId,
        recipientAgentId,
        agentRuntimeGeneration,
        recipientKeyId,
        domainAuthoritySetDigest,
        domainCount,
        domains,
      });
    });
    const canonical = secretBytes(value);
    const matches = sameBytes(canonical, bytes);
    canonical.fill(0);
    if (!matches) {
      destroyDeviceWrappedDomainAgentForegroundAuthorizationSecretV1(value);
      return null;
    }
    return value;
  } catch {
    return null;
  }
}

export function destroyDeviceWrappedDomainAgentForegroundAuthorizationSecretV1(
  value: DeviceWrappedDomainAgentForegroundAuthorizationSecretV1,
): void {
  value.domainAuthoritySetDigest.fill(0);
  value.domains.forEach(destroySecretEntry);
}

function authorizationSigningBytes(
  value: Omit<DeviceWrappedDomainAgentForegroundAuthorizationV1, "signature">,
): Uint8Array {
  if (
    value.formatVersion
      !== DEVICE_WRAPPED_DOMAIN_AGENT_FOREGROUND_AUTHORIZATION_V1_FORMAT_VERSION
    || value.purpose
      !== DEVICE_WRAPPED_DOMAIN_AGENT_FOREGROUND_AUTHORIZATION_V1_PURPOSE
    || value.scheme
      !== DEVICE_WRAPPED_DOMAIN_AGENT_FOREGROUND_AUTHORIZATION_V1_SCHEME
  ) throw new TypeError("Foreground authorization version is unsupported");
  portable("Foreground authorization ID", value.authorizationId);
  assertExactBytes("Foreground authorization plan digest", value.planDigest, HASH_BYTES);
  assertExactBytes("Foreground authorization secret digest", value.secretDigest, HASH_BYTES);
  assertExactBytes("Foreground authorization ciphertext digest", value.encryptedSecretDigest, HASH_BYTES);
  if (
    value.domainCount < 1
    || value.domainCount
      > DEVICE_WRAPPED_DOMAIN_AGENT_FOREGROUND_AUTHORIZATION_V1_MAX_DOMAINS
  ) throw new RangeError("Foreground authorization Domain count is invalid");
  if (
    !(value.planBytes instanceof Uint8Array)
    || value.planBytes.length < 1
    || value.planBytes.length
      > DEVICE_WRAPPED_DOMAIN_AGENT_FOREGROUND_AUTHORIZATION_V1_MAX_WIRE_BYTES
  ) throw new RangeError("Foreground authorization plan bytes are invalid");
  if (
    !(value.encryptedSecret instanceof Uint8Array)
    || value.encryptedSecret.length < 1
    || value.encryptedSecret.length
      > DEVICE_WRAPPED_DOMAIN_AGENT_FOREGROUND_AUTHORIZATION_V1_MAX_SECRET_BYTES
        + 256
  ) throw new RangeError("Foreground authorization ciphertext is invalid");
  return concatV2(
    frameText(AUTHORIZATION_DOMAIN),
    encodeU32(value.formatVersion),
    frameText(value.purpose),
    frameText(value.scheme),
    frameText(value.authorizationId),
    frame(value.planBytes),
    frame(value.planDigest),
    encodeU32(value.domainCount),
    frame(value.secretDigest),
    frame(value.encryptedSecret),
    frame(value.encryptedSecretDigest),
  );
}

export function serializeDeviceWrappedDomainAgentForegroundAuthorizationV1(
  value: DeviceWrappedDomainAgentForegroundAuthorizationV1,
): Uint8Array {
  assertExactBytes(
    "Foreground authorization signature",
    value.signature,
    V2_LIMITS.signatureBytes,
  );
  const signing = authorizationSigningBytes(value);
  try {
    const bytes = concatV2(signing, frame(value.signature));
    if (
      bytes.length
        > DEVICE_WRAPPED_DOMAIN_AGENT_FOREGROUND_AUTHORIZATION_V1_MAX_WIRE_BYTES
    ) {
      bytes.fill(0);
      throw new RangeError("Foreground authorization exceeds its wire bound");
    }
    return bytes;
  } finally {
    signing.fill(0);
  }
}

export function parseDeviceWrappedDomainAgentForegroundAuthorizationV1(
  bytes: Uint8Array,
): DeviceWrappedDomainAgentForegroundAuthorizationV1 | null {
  if (
    !(bytes instanceof Uint8Array)
    || bytes.length
      > DEVICE_WRAPPED_DOMAIN_AGENT_FOREGROUND_AUTHORIZATION_V1_MAX_WIRE_BYTES
  ) return null;
  try {
    const value = decodeExact(bytes, (reader) => {
      if (reader.readText(256) !== AUTHORIZATION_DOMAIN) {
        throw new TypeError("Foreground authorization domain is invalid");
      }
      reader.readVersion(
        DEVICE_WRAPPED_DOMAIN_AGENT_FOREGROUND_AUTHORIZATION_V1_FORMAT_VERSION,
      );
      if (
        reader.readText(128)
          !== DEVICE_WRAPPED_DOMAIN_AGENT_FOREGROUND_AUTHORIZATION_V1_PURPOSE
        || reader.readText(128)
          !== DEVICE_WRAPPED_DOMAIN_AGENT_FOREGROUND_AUTHORIZATION_V1_SCHEME
      ) throw new TypeError("Foreground authorization purpose is invalid");
      return Object.freeze({
        formatVersion:
          DEVICE_WRAPPED_DOMAIN_AGENT_FOREGROUND_AUTHORIZATION_V1_FORMAT_VERSION,
        purpose:
          DEVICE_WRAPPED_DOMAIN_AGENT_FOREGROUND_AUTHORIZATION_V1_PURPOSE,
        scheme: DEVICE_WRAPPED_DOMAIN_AGENT_FOREGROUND_AUTHORIZATION_V1_SCHEME,
        authorizationId: reader.readText(V2_LIMITS.idBytes),
        planBytes: reader.readFrame(
          DEVICE_WRAPPED_DOMAIN_AGENT_FOREGROUND_AUTHORIZATION_V1_MAX_WIRE_BYTES,
        ),
        planDigest: reader.readFrame(HASH_BYTES),
        domainCount: reader.readCount(
          DEVICE_WRAPPED_DOMAIN_AGENT_FOREGROUND_AUTHORIZATION_V1_MAX_DOMAINS,
        ),
        secretDigest: reader.readFrame(HASH_BYTES),
        encryptedSecret: reader.readFrame(
          DEVICE_WRAPPED_DOMAIN_AGENT_FOREGROUND_AUTHORIZATION_V1_MAX_SECRET_BYTES
            + 256,
        ),
        encryptedSecretDigest: reader.readFrame(HASH_BYTES),
        signature: reader.readFrame(V2_LIMITS.signatureBytes),
      });
    });
    const canonical = serializeDeviceWrappedDomainAgentForegroundAuthorizationV1(
      value,
    );
    const matches = sameBytes(canonical, bytes);
    canonical.fill(0);
    if (!matches) {
      destroyDeviceWrappedDomainAgentForegroundAuthorizationV1(value);
      return null;
    }
    return value;
  } catch {
    return null;
  }
}

export function destroyDeviceWrappedDomainAgentForegroundAuthorizationV1(
  value: DeviceWrappedDomainAgentForegroundAuthorizationV1,
): void {
  value.planBytes.fill(0);
  value.planDigest.fill(0);
  value.secretDigest.fill(0);
  value.encryptedSecret.fill(0);
  value.encryptedSecretDigest.fill(0);
  value.signature.fill(0);
}

function planDigestMatches(
  crypto: Pick<LatticeCrypto, "hash">,
  plan: DeviceWrappedDomainAgentForegroundAuthorizationPlanV1,
): boolean {
  const digest = authoritySetDigest(crypto, plan.domains);
  try {
    return sameBytes(digest, plan.domainAuthoritySetDigest);
  } finally {
    digest.fill(0);
  }
}

function secretMatchesPlan(
  secret: DeviceWrappedDomainAgentForegroundAuthorizationSecretV1,
  plan: DeviceWrappedDomainAgentForegroundAuthorizationPlanV1,
): boolean {
  if (
    secret.authorizationId !== plan.authorizationId
    || secret.sessionId !== plan.sessionId
    || secret.roomId !== plan.roomId
    || secret.subjectHumanId !== plan.subjectHumanId
    || secret.committerDeviceId !== plan.committerDeviceId
    || secret.recipientAgentId !== plan.recipientAgentId
    || secret.agentRuntimeGeneration !== plan.agentRuntimeGeneration
    || secret.recipientKeyId !== plan.recipientKeyId
    || secret.domainCount !== plan.domainCount
    || !sameBytes(secret.domainAuthoritySetDigest, plan.domainAuthoritySetDigest)
  ) return false;
  return plan.domains.every((authority, index) => {
    const entry = secret.domains[index];
    return entry !== undefined
      && entry.grantDomainId === authority.grantDomainId
      && entry.domainKeyGeneration === authority.domainKeyGeneration
      && entry.authorizationRevision === authority.authorizationRevision
      && sameBytes(entry.participantDigest, authority.participantDigest)
      && sameBytes(entry.headDigest, authority.headDigest);
  });
}

function currentMatchesPlan(
  plan: DeviceWrappedDomainAgentForegroundAuthorizationPlanV1,
  current: DeviceWrappedDomainAgentForegroundAuthorizationCurrentAuthorityV1,
): boolean {
  if (
    plan.authorizationId !== current.authorizationId
    || plan.policyRevision !== current.policyRevision
    || plan.sessionId !== current.sessionId
    || plan.roomId !== current.roomId
    || plan.subjectHumanId !== current.subjectHumanId
    || plan.committerDeviceId !== current.committerDeviceId
    || plan.committerDeviceSigningGeneration
      !== current.committerDeviceSigningGeneration
    || plan.hostAuthorizationRevision !== current.hostAuthorizationRevision
    || plan.recipientAgentId !== current.recipientAgentId
    || plan.agentAuthorizationRevision !== current.agentAuthorizationRevision
    || plan.agentRuntimeGeneration !== current.agentRuntimeGeneration
    || plan.recipientKeyId !== current.recipientKeyId
    || plan.domains.length !== current.domains.length
  ) return false;
  return plan.domains.every((expected, index) => {
    const actual = current.domains[index];
    if (actual === undefined) return false;
    const expectedBytes = authorityEntryBytes(expected);
    const actualBytes = authorityEntryBytes(actual);
    try {
      return sameBytes(expectedBytes, actualBytes);
    } finally {
      expectedBytes.fill(0);
      actualBytes.fill(0);
    }
  });
}

export async function mintDeviceWrappedDomainAgentForegroundAuthorizationV1(
  crypto: LatticeCrypto,
  input: Readonly<{
    plan: DeviceWrappedDomainAgentForegroundAuthorizationPlanV1;
    domains: readonly DeviceWrappedDomainAgentForegroundAuthorizationSecretEntryV1[];
    committerDeviceSigningPrivateKey: Uint8Array;
    recipientEncryptionPublicKey: Uint8Array;
  }>,
): Promise<DeviceWrappedDomainAgentForegroundAuthorizationV1> {
  const plan = normalizePlan(input.plan);
  const domains = canonicalSecretEntries(input.domains);
  const signingPrivateKey = exactBytes(
    "Foreground authorization signing private key",
    input.committerDeviceSigningPrivateKey,
    V2_LIMITS.signingPrivateKeyBytes,
  );
  const recipientPublicKey = exactBytes(
    "Foreground authorization recipient public key",
    input.recipientEncryptionPublicKey,
    V2_LIMITS.hpkePublicKeyBytes,
  );
  let encodedPlan: Uint8Array | undefined;
  let encodedSecret: Uint8Array | undefined;
  let encryptedSecret: Uint8Array | undefined;
  let signing: Uint8Array | undefined;
  try {
    if (!planDigestMatches(crypto, plan)) {
      throw new TypeError("Foreground authorization authority-set digest disagrees");
    }
    const secret = normalizeSecret({
      formatVersion:
        DEVICE_WRAPPED_DOMAIN_AGENT_FOREGROUND_AUTHORIZATION_V1_FORMAT_VERSION,
      purpose:
        DEVICE_WRAPPED_DOMAIN_AGENT_FOREGROUND_AUTHORIZATION_V1_SECRET_PURPOSE,
      authorizationId: plan.authorizationId,
      sessionId: plan.sessionId,
      roomId: plan.roomId,
      subjectHumanId: plan.subjectHumanId,
      committerDeviceId: plan.committerDeviceId,
      recipientAgentId: plan.recipientAgentId,
      agentRuntimeGeneration: plan.agentRuntimeGeneration,
      recipientKeyId: plan.recipientKeyId,
      domainAuthoritySetDigest: plan.domainAuthoritySetDigest,
      domainCount: domains.length,
      domains,
    });
    try {
      if (!secretMatchesPlan(secret, plan)) {
        throw new TypeError(
          "Foreground authorization secret is not the exact planned Domain set",
        );
      }
      encodedPlan = planBytes(plan);
      encodedSecret = secretBytes(secret);
      if (encodedSecret.length > plan.maximumSecretBytes) {
        throw new RangeError("Foreground authorization secret exceeds its plan bound");
      }
      encryptedSecret = await crypto.sealTo(recipientPublicKey, encodedSecret);
      const unsigned = Object.freeze({
        formatVersion:
          DEVICE_WRAPPED_DOMAIN_AGENT_FOREGROUND_AUTHORIZATION_V1_FORMAT_VERSION,
        purpose:
          DEVICE_WRAPPED_DOMAIN_AGENT_FOREGROUND_AUTHORIZATION_V1_PURPOSE,
        scheme: DEVICE_WRAPPED_DOMAIN_AGENT_FOREGROUND_AUTHORIZATION_V1_SCHEME,
        authorizationId: plan.authorizationId,
        planBytes: encodedPlan.slice(),
        planDigest: crypto.hash(encodedPlan),
        domainCount: domains.length,
        secretDigest: crypto.hash(encodedSecret),
        encryptedSecret: encryptedSecret.slice(),
        encryptedSecretDigest: crypto.hash(encryptedSecret),
      });
      signing = authorizationSigningBytes(unsigned);
      const signature = crypto.sign(signingPrivateKey, signing);
      try {
        return Object.freeze({ ...unsigned, signature: signature.slice() });
      } finally {
        signature.fill(0);
      }
    } finally {
      destroyDeviceWrappedDomainAgentForegroundAuthorizationSecretV1(secret);
    }
  } finally {
    destroyDeviceWrappedDomainAgentForegroundAuthorizationPlanV1(plan);
    domains.forEach(destroySecretEntry);
    signingPrivateKey.fill(0);
    recipientPublicKey.fill(0);
    encodedPlan?.fill(0);
    encodedSecret?.fill(0);
    encryptedSecret?.fill(0);
    signing?.fill(0);
  }
}

export async function withOpenedDeviceWrappedDomainAgentForegroundAuthorizationV1<Value>(
  crypto: LatticeCrypto,
  input: Readonly<{
    authorizationBytes: Uint8Array;
    now: number;
    current: DeviceWrappedDomainAgentForegroundAuthorizationCurrentAuthorityV1;
    operation(
      domains: readonly DeviceWrappedDomainAgentForegroundAuthorizationSecretEntryV1[],
    ): Value | PromiseLike<Value>;
  }>,
): Promise<OpenDeviceWrappedDomainAgentForegroundAuthorizationResultV1<Value>> {
  const authorization =
    parseDeviceWrappedDomainAgentForegroundAuthorizationV1(
      input.authorizationBytes,
    );
  if (authorization === null) {
    return Object.freeze({ status: "unavailable", reason: "invalid" });
  }
  let plan: DeviceWrappedDomainAgentForegroundAuthorizationPlanV1 | null = null;
  let secretBytesValue: Uint8Array | null = null;
  let secret: DeviceWrappedDomainAgentForegroundAuthorizationSecretV1 | null =
    null;
  let signing: Uint8Array | undefined;
  let operationStarted = false;
  try {
    plan = parseDeviceWrappedDomainAgentForegroundAuthorizationPlanV1(
      authorization.planBytes,
    );
    if (plan === null) {
      return Object.freeze({ status: "unavailable", reason: "invalid" });
    }
    const actualPlanDigest = crypto.hash(authorization.planBytes);
    const actualCiphertextDigest = crypto.hash(authorization.encryptedSecret);
    const publicValid = sameBytes(actualPlanDigest, authorization.planDigest)
      && sameBytes(
        actualCiphertextDigest,
        authorization.encryptedSecretDigest,
      )
      && authorization.authorizationId === plan.authorizationId
      && authorization.domainCount === plan.domainCount
      && planDigestMatches(crypto, plan);
    actualPlanDigest.fill(0);
    actualCiphertextDigest.fill(0);
    if (!publicValid) {
      return Object.freeze({ status: "unavailable", reason: "invalid" });
    }
    if (!Number.isSafeInteger(input.now) || input.now < plan.issuedAt) {
      return Object.freeze({ status: "unavailable", reason: "invalid" });
    }
    if (input.now >= plan.deadlineAt) {
      return Object.freeze({ status: "unavailable", reason: "expired" });
    }
    if (
      !input.current.committerDeviceActive
      || !input.current.agentAuthorized
      || !currentMatchesPlan(plan, input.current)
    ) {
      return Object.freeze({ status: "unavailable", reason: "authority_stale" });
    }
    assertExactBytes(
      "Foreground authorization signing public key",
      input.current.committerDeviceSigningPublicKey,
      V2_LIMITS.signingPublicKeyBytes,
    );
    assertExactBytes(
      "Foreground authorization recipient private key",
      input.current.recipientEncryptionPrivateKey,
      V2_LIMITS.hpkePrivateKeyBytes,
    );
    signing = authorizationSigningBytes(authorization);
    if (
      !crypto.verify(
        input.current.committerDeviceSigningPublicKey,
        signing,
        authorization.signature,
      )
    ) return Object.freeze({ status: "unavailable", reason: "invalid" });
    secretBytesValue = await crypto.openSealed(
      input.current.recipientEncryptionPrivateKey,
      authorization.encryptedSecret,
    );
    if (secretBytesValue === null) {
      return Object.freeze({ status: "unavailable", reason: "secret_unavailable" });
    }
    const actualSecretDigest = crypto.hash(secretBytesValue);
    const secretDigestValid = sameBytes(
      actualSecretDigest,
      authorization.secretDigest,
    );
    actualSecretDigest.fill(0);
    if (!secretDigestValid) {
      return Object.freeze({ status: "unavailable", reason: "invalid" });
    }
    secret = parseDeviceWrappedDomainAgentForegroundAuthorizationSecretV1(
      secretBytesValue,
    );
    if (
      secret === null
      || !secretMatchesPlan(secret, plan)
      || secret.domainCount !== authorization.domainCount
    ) return Object.freeze({ status: "unavailable", reason: "invalid" });
    operationStarted = true;
    const value = await input.operation(secret.domains);
    operationStarted = false;
    return Object.freeze({ status: "opened", value });
  } catch (error) {
    if (operationStarted) throw error;
    return Object.freeze({ status: "unavailable", reason: "invalid" });
  } finally {
    signing?.fill(0);
    secretBytesValue?.fill(0);
    if (secret) {
      destroyDeviceWrappedDomainAgentForegroundAuthorizationSecretV1(secret);
    }
    if (plan) {
      destroyDeviceWrappedDomainAgentForegroundAuthorizationPlanV1(plan);
    }
    destroyDeviceWrappedDomainAgentForegroundAuthorizationV1(authorization);
  }
}
