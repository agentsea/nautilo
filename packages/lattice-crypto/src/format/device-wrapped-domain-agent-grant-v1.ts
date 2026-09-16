import type { LatticeCrypto } from "../crypto/index.ts";
import { compareUnsignedUtf8 } from "../domain/participants.ts";
import type {
  AgentId,
  AuthorizationRevision,
  CryptoDeviceId,
  GrantId,
  HumanId,
} from "../v2-types/ids.ts";
import {
  agentId,
  assertPortableId,
  assertU64Counter,
  authorizationRevision,
  cryptoDeviceId,
  grantId,
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

export const DEVICE_WRAPPED_DOMAIN_AGENT_GRANT_V1_FORMAT_VERSION = 1 as const;
export const DEVICE_WRAPPED_DOMAIN_AGENT_GRANT_V1_PLAN_PURPOSE =
  "device_wrapped_grant_domain.agent_grant_plan" as const;
export const DEVICE_WRAPPED_DOMAIN_AGENT_GRANT_V1_PURPOSE =
  "device_wrapped_grant_domain.agent_grant" as const;
export const DEVICE_WRAPPED_DOMAIN_AGENT_GRANT_V1_SECRET_PURPOSE =
  "device_wrapped_grant_domain.agent_grant_secret" as const;
export const DEVICE_WRAPPED_DOMAIN_AGENT_GRANT_V1_SCHEME =
  "device_wrapped_grant_domain_enumeration_v1" as const;
export const DEVICE_WRAPPED_DOMAIN_AGENT_GRANT_V1_MAX_DOMAINS =
  V2_LIMITS.distinctDomainsPerGrant;
export const DEVICE_WRAPPED_DOMAIN_AGENT_GRANT_V1_MAX_SECRET_BYTES =
  V2_LIMITS.grantSecretBytes;
export const DEVICE_WRAPPED_DOMAIN_AGENT_GRANT_V1_MAX_WIRE_BYTES =
  V2_LIMITS.grantWireBytes;
export const DEVICE_WRAPPED_DOMAIN_AGENT_GRANT_V1_MAX_TTL_MS =
  V2_LIMITS.grantTtlMs;

const PLAN_DOMAIN =
  "nautilo/lattice-crypto/device-wrapped-domain-agent-grant-plan/v1";
const AUTHORITY_SET_DOMAIN =
  "nautilo/lattice-crypto/device-wrapped-domain-agent-grant-authority-set/v1";
const SECRET_DOMAIN =
  "nautilo/lattice-crypto/device-wrapped-domain-agent-grant-secret/v1";
const GRANT_DOMAIN =
  "nautilo/lattice-crypto/device-wrapped-domain-agent-grant/v1";
const HASH_BYTES = 32;
const KEY_BYTES = 32;

export type DeviceWrappedDomainAgentGrantOperationV1 = "decrypt" | "encrypt";

export interface DeviceWrappedDomainAgentGrantAuthorityEntryV1 {
  readonly grantDomainId: string;
  readonly participantDigest: Uint8Array;
  readonly domainKeyGeneration: number;
  readonly headDigest: Uint8Array;
  readonly publicationDigest: Uint8Array;
  readonly publicationAuthorizationRevision: AuthorizationRevision;
  readonly authorizationRevision: AuthorizationRevision;
  readonly activeNamespaceBindingSetDigest: Uint8Array;
  readonly activeNamespaceBindingCount: number;
}

export interface DeviceWrappedDomainAgentGrantPlanV1 {
  readonly formatVersion: typeof DEVICE_WRAPPED_DOMAIN_AGENT_GRANT_V1_FORMAT_VERSION;
  readonly purpose: typeof DEVICE_WRAPPED_DOMAIN_AGENT_GRANT_V1_PLAN_PURPOSE;
  readonly scheme: typeof DEVICE_WRAPPED_DOMAIN_AGENT_GRANT_V1_SCHEME;
  readonly operationId: string;
  readonly policyRevision: number;
  readonly sessionId: string;
  readonly roomId: string;
  readonly subjectHumanId: HumanId;
  readonly committerDeviceId: CryptoDeviceId;
  readonly committerDeviceSigningGeneration: number;
  readonly hostAuthorizationRevision: AuthorizationRevision;
  readonly recipientAgentId: AgentId;
  readonly recipientKeyId: string;
  readonly operations: readonly DeviceWrappedDomainAgentGrantOperationV1[];
  readonly issuedAt: number;
  readonly deadlineAt: number;
  readonly domainCount: number;
  readonly maximumSecretBytes: number;
  readonly domainAuthoritySetDigest: Uint8Array;
  readonly domains: readonly DeviceWrappedDomainAgentGrantAuthorityEntryV1[];
}

export interface DeviceWrappedDomainAgentGrantSecretEntryV1 {
  readonly grantDomainId: string;
  readonly domainKeyGeneration: number;
  readonly participantDigest: Uint8Array;
  readonly headDigest: Uint8Array;
  readonly authorizationRevision: AuthorizationRevision;
  readonly domainAiGrantKey: Uint8Array;
}

export interface DeviceWrappedDomainAgentGrantSecretV1 {
  readonly formatVersion: typeof DEVICE_WRAPPED_DOMAIN_AGENT_GRANT_V1_FORMAT_VERSION;
  readonly purpose: typeof DEVICE_WRAPPED_DOMAIN_AGENT_GRANT_V1_SECRET_PURPOSE;
  readonly grantId: GrantId;
  readonly operationId: string;
  readonly sessionId: string;
  readonly roomId: string;
  readonly subjectHumanId: HumanId;
  readonly committerDeviceId: CryptoDeviceId;
  readonly recipientAgentId: AgentId;
  readonly recipientKeyId: string;
  readonly domainAuthoritySetDigest: Uint8Array;
  readonly domainCount: number;
  readonly domains: readonly DeviceWrappedDomainAgentGrantSecretEntryV1[];
}

export interface DeviceWrappedDomainAgentGrantV1 {
  readonly formatVersion: typeof DEVICE_WRAPPED_DOMAIN_AGENT_GRANT_V1_FORMAT_VERSION;
  readonly purpose: typeof DEVICE_WRAPPED_DOMAIN_AGENT_GRANT_V1_PURPOSE;
  readonly scheme: typeof DEVICE_WRAPPED_DOMAIN_AGENT_GRANT_V1_SCHEME;
  readonly id: GrantId;
  readonly planBytes: Uint8Array;
  readonly planDigest: Uint8Array;
  readonly domainCount: number;
  readonly secretDigest: Uint8Array;
  readonly encryptedSecret: Uint8Array;
  readonly encryptedSecretDigest: Uint8Array;
  readonly signature: Uint8Array;
}

export interface DeviceWrappedDomainAgentGrantCurrentAuthorityV1 {
  readonly operationId: string;
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
  readonly recipientKeyId: string;
  readonly recipientEncryptionPrivateKey: Uint8Array;
  readonly agentAuthorized: boolean;
  readonly hostAllowsOperation: boolean;
  readonly operation: DeviceWrappedDomainAgentGrantOperationV1;
  readonly domains: readonly DeviceWrappedDomainAgentGrantAuthorityEntryV1[];
}

export type OpenDeviceWrappedDomainAgentGrantResultV1<Value> =
  | Readonly<{ status: "opened"; value: Value }>
  | Readonly<{
      status: "unavailable";
      reason:
        | "invalid"
        | "expired"
        | "authority_stale"
        | "operation_denied"
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
  values: readonly DeviceWrappedDomainAgentGrantOperationV1[],
): readonly DeviceWrappedDomainAgentGrantOperationV1[] {
  if (!Array.isArray(values as unknown) || values.length < 1 || values.length > 2) {
    throw new RangeError("Domain Agent Grant operation count is invalid");
  }
  for (const value of values) {
    if (value !== "decrypt" && value !== "encrypt") {
      throw new TypeError("Domain Agent Grant operation is unsupported");
    }
  }
  const canonical = [...new Set(values)].sort(compareUnsignedUtf8);
  if (
    canonical.length !== values.length
    || canonical.some((value, index) => value !== values[index])
  ) throw new TypeError("Domain Agent Grant operations must be canonical and unique");
  return Object.freeze(canonical);
}

function normalizeAuthorityEntry(
  value: DeviceWrappedDomainAgentGrantAuthorityEntryV1,
): DeviceWrappedDomainAgentGrantAuthorityEntryV1 {
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
    activeNamespaceBindingSetDigest: exactBytes("Grant Domain active binding-set digest", value.activeNamespaceBindingSetDigest, HASH_BYTES),
    activeNamespaceBindingCount: counter("Grant Domain active binding count", value.activeNamespaceBindingCount),
  });
}

function canonicalAuthority(
  values: readonly DeviceWrappedDomainAgentGrantAuthorityEntryV1[],
): readonly DeviceWrappedDomainAgentGrantAuthorityEntryV1[] {
  if (
    !Array.isArray(values as unknown)
    || values.length < 1
    || values.length > DEVICE_WRAPPED_DOMAIN_AGENT_GRANT_V1_MAX_DOMAINS
  ) throw new RangeError("Domain Agent Grant Domain count is invalid");
  const domains = values.map(normalizeAuthorityEntry);
  for (let index = 1; index < domains.length; index += 1) {
    if (compareUnsignedUtf8(domains[index - 1]!.grantDomainId, domains[index]!.grantDomainId) >= 0) {
      domains.forEach(destroyAuthorityEntry);
      throw new TypeError("Domain Agent Grant authority must be canonical and unique");
    }
  }
  return Object.freeze(domains);
}

function authorityEntryBytes(
  value: DeviceWrappedDomainAgentGrantAuthorityEntryV1,
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
  value: DeviceWrappedDomainAgentGrantAuthorityEntryV1,
): void {
  value.participantDigest.fill(0);
  value.headDigest.fill(0);
  value.publicationDigest.fill(0);
  value.activeNamespaceBindingSetDigest.fill(0);
}

export function deviceWrappedDomainAgentGrantAuthoritySetDigestV1(
  crypto: Pick<LatticeCrypto, "hash">,
  values: readonly DeviceWrappedDomainAgentGrantAuthorityEntryV1[],
): Uint8Array {
  const domains = canonicalAuthority(values);
  const bytes = concatV2(
    frameText(AUTHORITY_SET_DOMAIN),
    encodeU32(domains.length),
    ...domains.map(authorityEntryBytes),
  );
  try {
    return crypto.hash(bytes);
  } finally {
    bytes.fill(0);
    domains.forEach(destroyAuthorityEntry);
  }
}

export function createDeviceWrappedDomainAgentGrantPlanV1(
  crypto: Pick<LatticeCrypto, "hash">,
  input: Omit<
    DeviceWrappedDomainAgentGrantPlanV1,
    | "formatVersion"
    | "purpose"
    | "scheme"
    | "domainCount"
    | "domainAuthoritySetDigest"
  >,
): DeviceWrappedDomainAgentGrantPlanV1 {
  const digest = deviceWrappedDomainAgentGrantAuthoritySetDigestV1(
    crypto,
    input.domains,
  );
  try {
    return normalizePlan({
      ...input,
      formatVersion: DEVICE_WRAPPED_DOMAIN_AGENT_GRANT_V1_FORMAT_VERSION,
      purpose: DEVICE_WRAPPED_DOMAIN_AGENT_GRANT_V1_PLAN_PURPOSE,
      scheme: DEVICE_WRAPPED_DOMAIN_AGENT_GRANT_V1_SCHEME,
      domainCount: input.domains.length,
      domainAuthoritySetDigest: digest,
    });
  } finally {
    digest.fill(0);
  }
}

function normalizePlan(
  value: DeviceWrappedDomainAgentGrantPlanV1,
): DeviceWrappedDomainAgentGrantPlanV1 {
  if (
    value.formatVersion !== DEVICE_WRAPPED_DOMAIN_AGENT_GRANT_V1_FORMAT_VERSION
    || value.purpose !== DEVICE_WRAPPED_DOMAIN_AGENT_GRANT_V1_PLAN_PURPOSE
    || value.scheme !== DEVICE_WRAPPED_DOMAIN_AGENT_GRANT_V1_SCHEME
  ) throw new TypeError("Domain Agent Grant plan version is unsupported");
  const operations = canonicalOperations(value.operations);
  const domains = canonicalAuthority(value.domains);
  if (value.domainCount !== domains.length) {
    domains.forEach(destroyAuthorityEntry);
    throw new TypeError("Domain Agent Grant Domain count disagrees");
  }
  const issuedAt = counter("Domain Agent Grant issued time", value.issuedAt);
  const deadlineAt = counter("Domain Agent Grant deadline", value.deadlineAt);
  if (
    deadlineAt <= issuedAt
    || deadlineAt - issuedAt > DEVICE_WRAPPED_DOMAIN_AGENT_GRANT_V1_MAX_TTL_MS
  ) {
    domains.forEach(destroyAuthorityEntry);
    throw new RangeError("Domain Agent Grant deadline is invalid");
  }
  const maximumSecretBytes = counter("Domain Agent Grant maximum secret bytes", value.maximumSecretBytes, 1);
  if (maximumSecretBytes > DEVICE_WRAPPED_DOMAIN_AGENT_GRANT_V1_MAX_SECRET_BYTES) {
    domains.forEach(destroyAuthorityEntry);
    throw new RangeError("Domain Agent Grant secret bound is invalid");
  }
  return Object.freeze({
    formatVersion: DEVICE_WRAPPED_DOMAIN_AGENT_GRANT_V1_FORMAT_VERSION,
    purpose: DEVICE_WRAPPED_DOMAIN_AGENT_GRANT_V1_PLAN_PURPOSE,
    scheme: DEVICE_WRAPPED_DOMAIN_AGENT_GRANT_V1_SCHEME,
    operationId: portable("Domain Agent Grant operation ID", value.operationId),
    policyRevision: counter("Domain Agent Grant policy revision", value.policyRevision),
    sessionId: portable("Domain Agent Grant Session ID", value.sessionId),
    roomId: portable("Domain Agent Grant Room ID", value.roomId),
    subjectHumanId: humanId(value.subjectHumanId),
    committerDeviceId: cryptoDeviceId(value.committerDeviceId),
    committerDeviceSigningGeneration: counter("Domain Agent Grant device signing generation", value.committerDeviceSigningGeneration, 1),
    hostAuthorizationRevision: authorizationRevision(value.hostAuthorizationRevision),
    recipientAgentId: agentId(value.recipientAgentId),
    recipientKeyId: portable("Domain Agent Grant recipient key ID", value.recipientKeyId),
    operations,
    issuedAt,
    deadlineAt,
    domainCount: domains.length,
    maximumSecretBytes,
    domainAuthoritySetDigest: exactBytes("Domain Agent Grant authority-set digest", value.domainAuthoritySetDigest, HASH_BYTES),
    domains,
  });
}

function planBytes(value: DeviceWrappedDomainAgentGrantPlanV1): Uint8Array {
  return concatV2(
    frameText(PLAN_DOMAIN),
    encodeU32(value.formatVersion),
    frameText(value.purpose),
    frameText(value.scheme),
    frameText(value.operationId),
    encodeU64(value.policyRevision),
    frameText(value.sessionId),
    frameText(value.roomId),
    frameText(value.subjectHumanId),
    frameText(value.committerDeviceId),
    encodeU64(value.committerDeviceSigningGeneration),
    encodeU64(value.hostAuthorizationRevision),
    frameText(value.recipientAgentId),
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

export function serializeDeviceWrappedDomainAgentGrantPlanV1(
  value: DeviceWrappedDomainAgentGrantPlanV1,
): Uint8Array {
  const normalized = normalizePlan(value);
  try {
    return planBytes(normalized);
  } finally {
    destroyDeviceWrappedDomainAgentGrantPlanV1(normalized);
  }
}

export function parseDeviceWrappedDomainAgentGrantPlanV1(
  bytes: Uint8Array,
): DeviceWrappedDomainAgentGrantPlanV1 | null {
  try {
    const value = decodeExact(bytes, (reader) => {
      if (reader.readText(256) !== PLAN_DOMAIN) throw new TypeError("Domain Agent Grant plan domain is invalid");
      reader.readVersion(DEVICE_WRAPPED_DOMAIN_AGENT_GRANT_V1_FORMAT_VERSION);
      if (reader.readText(128) !== DEVICE_WRAPPED_DOMAIN_AGENT_GRANT_V1_PLAN_PURPOSE) throw new TypeError("Domain Agent Grant plan purpose is invalid");
      if (reader.readText(128) !== DEVICE_WRAPPED_DOMAIN_AGENT_GRANT_V1_SCHEME) throw new TypeError("Domain Agent Grant plan scheme is invalid");
      const operationId = reader.readText(V2_LIMITS.idBytes);
      const policyRevision = reader.readU64();
      const sessionId = reader.readText(V2_LIMITS.idBytes);
      const roomId = reader.readText(V2_LIMITS.idBytes);
      const subjectHumanId = humanId(reader.readText(V2_LIMITS.idBytes));
      const committerDeviceId = cryptoDeviceId(reader.readText(V2_LIMITS.idBytes));
      const committerDeviceSigningGeneration = reader.readU64();
      const hostAuthorizationRevision = authorizationRevision(reader.readU64());
      const recipientAgentId = agentId(reader.readText(V2_LIMITS.idBytes));
      const recipientKeyId = reader.readText(V2_LIMITS.idBytes);
      const operationCount = reader.readCount(2);
      const operations = Array.from({ length: operationCount }, () =>
        reader.readText(16) as DeviceWrappedDomainAgentGrantOperationV1
      );
      const issuedAt = reader.readU64();
      const deadlineAt = reader.readU64();
      const domainCount = reader.readCount(DEVICE_WRAPPED_DOMAIN_AGENT_GRANT_V1_MAX_DOMAINS);
      const maximumSecretBytes = reader.readU64();
      const domainAuthoritySetDigest = reader.readFrame(HASH_BYTES);
      const encodedCount = reader.readCount(DEVICE_WRAPPED_DOMAIN_AGENT_GRANT_V1_MAX_DOMAINS);
      if (encodedCount !== domainCount) throw new TypeError("Domain Agent Grant Domain count disagrees");
      const domains = Array.from({ length: encodedCount }, () => Object.freeze({
        grantDomainId: reader.readText(V2_LIMITS.idBytes),
        participantDigest: reader.readFrame(HASH_BYTES),
        domainKeyGeneration: reader.readU64(),
        headDigest: reader.readFrame(HASH_BYTES),
        publicationDigest: reader.readFrame(HASH_BYTES),
        publicationAuthorizationRevision:
          authorizationRevision(reader.readU64()),
        authorizationRevision: authorizationRevision(reader.readU64()),
        activeNamespaceBindingSetDigest: reader.readFrame(HASH_BYTES),
        activeNamespaceBindingCount: reader.readU64(),
      }));
      return normalizePlan({
        formatVersion: DEVICE_WRAPPED_DOMAIN_AGENT_GRANT_V1_FORMAT_VERSION,
        purpose: DEVICE_WRAPPED_DOMAIN_AGENT_GRANT_V1_PLAN_PURPOSE,
        scheme: DEVICE_WRAPPED_DOMAIN_AGENT_GRANT_V1_SCHEME,
        operationId,
        policyRevision,
        sessionId,
        roomId,
        subjectHumanId,
        committerDeviceId,
        committerDeviceSigningGeneration,
        hostAuthorizationRevision,
        recipientAgentId,
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
      destroyDeviceWrappedDomainAgentGrantPlanV1(value);
      return null;
    }
    return value;
  } catch {
    return null;
  }
}

export function destroyDeviceWrappedDomainAgentGrantPlanV1(
  value: DeviceWrappedDomainAgentGrantPlanV1,
): void {
  value.domainAuthoritySetDigest.fill(0);
  value.domains.forEach(destroyAuthorityEntry);
}

function normalizeSecretEntry(
  value: DeviceWrappedDomainAgentGrantSecretEntryV1,
): DeviceWrappedDomainAgentGrantSecretEntryV1 {
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
  values: readonly DeviceWrappedDomainAgentGrantSecretEntryV1[],
): readonly DeviceWrappedDomainAgentGrantSecretEntryV1[] {
  if (!Array.isArray(values as unknown) || values.length < 1 || values.length > DEVICE_WRAPPED_DOMAIN_AGENT_GRANT_V1_MAX_DOMAINS) {
    throw new RangeError("Domain Agent Grant secret count is invalid");
  }
  const entries = values.map(normalizeSecretEntry);
  for (let index = 1; index < entries.length; index += 1) {
    if (compareUnsignedUtf8(entries[index - 1]!.grantDomainId, entries[index]!.grantDomainId) >= 0) {
      entries.forEach(destroySecretEntry);
      throw new TypeError("Domain Agent Grant secret must be canonical and unique");
    }
  }
  return Object.freeze(entries);
}

function secretEntryBytes(value: DeviceWrappedDomainAgentGrantSecretEntryV1): Uint8Array {
  return concatV2(
    frameText(value.grantDomainId),
    encodeU64(value.domainKeyGeneration),
    frame(value.participantDigest),
    frame(value.headDigest),
    encodeU64(value.authorizationRevision),
    frame(value.domainAiGrantKey),
  );
}

function destroySecretEntry(value: DeviceWrappedDomainAgentGrantSecretEntryV1): void {
  value.participantDigest.fill(0);
  value.headDigest.fill(0);
  value.domainAiGrantKey.fill(0);
}

function normalizeSecret(
  value: DeviceWrappedDomainAgentGrantSecretV1,
): DeviceWrappedDomainAgentGrantSecretV1 {
  const domains = canonicalSecretEntries(value.domains);
  if (value.domainCount !== domains.length) {
    domains.forEach(destroySecretEntry);
    throw new TypeError("Domain Agent Grant secret count disagrees");
  }
  return Object.freeze({
    formatVersion: DEVICE_WRAPPED_DOMAIN_AGENT_GRANT_V1_FORMAT_VERSION,
    purpose: DEVICE_WRAPPED_DOMAIN_AGENT_GRANT_V1_SECRET_PURPOSE,
    grantId: grantId(value.grantId),
    operationId: portable("Domain Agent Grant operation ID", value.operationId),
    sessionId: portable("Domain Agent Grant Session ID", value.sessionId),
    roomId: portable("Domain Agent Grant Room ID", value.roomId),
    subjectHumanId: humanId(value.subjectHumanId),
    committerDeviceId: cryptoDeviceId(value.committerDeviceId),
    recipientAgentId: agentId(value.recipientAgentId),
    recipientKeyId: portable("Domain Agent Grant recipient key ID", value.recipientKeyId),
    domainAuthoritySetDigest: exactBytes("Domain Agent Grant authority-set digest", value.domainAuthoritySetDigest, HASH_BYTES),
    domainCount: domains.length,
    domains,
  });
}

function secretBytes(value: DeviceWrappedDomainAgentGrantSecretV1): Uint8Array {
  return concatV2(
    frameText(SECRET_DOMAIN),
    encodeU32(value.formatVersion),
    frameText(value.purpose),
    frameText(value.grantId),
    frameText(value.operationId),
    frameText(value.sessionId),
    frameText(value.roomId),
    frameText(value.subjectHumanId),
    frameText(value.committerDeviceId),
    frameText(value.recipientAgentId),
    frameText(value.recipientKeyId),
    frame(value.domainAuthoritySetDigest),
    encodeU32(value.domainCount),
    ...value.domains.map(secretEntryBytes),
  );
}

export function serializeDeviceWrappedDomainAgentGrantSecretV1(
  value: DeviceWrappedDomainAgentGrantSecretV1,
): Uint8Array {
  const normalized = normalizeSecret(value);
  try {
    const bytes = secretBytes(normalized);
    if (bytes.length > DEVICE_WRAPPED_DOMAIN_AGENT_GRANT_V1_MAX_SECRET_BYTES) {
      bytes.fill(0);
      throw new RangeError("Domain Agent Grant secret exceeds its wire bound");
    }
    return bytes;
  } finally {
    destroyDeviceWrappedDomainAgentGrantSecretV1(normalized);
  }
}

export function parseDeviceWrappedDomainAgentGrantSecretV1(
  bytes: Uint8Array,
): DeviceWrappedDomainAgentGrantSecretV1 | null {
  if (bytes.length > DEVICE_WRAPPED_DOMAIN_AGENT_GRANT_V1_MAX_SECRET_BYTES) return null;
  try {
    const value = decodeExact(bytes, (reader) => {
      if (reader.readText(256) !== SECRET_DOMAIN) throw new TypeError("Domain Agent Grant secret domain is invalid");
      reader.readVersion(DEVICE_WRAPPED_DOMAIN_AGENT_GRANT_V1_FORMAT_VERSION);
      if (reader.readText(128) !== DEVICE_WRAPPED_DOMAIN_AGENT_GRANT_V1_SECRET_PURPOSE) throw new TypeError("Domain Agent Grant secret purpose is invalid");
      const grantIdValue = grantId(reader.readText(V2_LIMITS.idBytes));
      const operationId = reader.readText(V2_LIMITS.idBytes);
      const sessionId = reader.readText(V2_LIMITS.idBytes);
      const roomId = reader.readText(V2_LIMITS.idBytes);
      const subjectHumanId = humanId(reader.readText(V2_LIMITS.idBytes));
      const committerDeviceId = cryptoDeviceId(reader.readText(V2_LIMITS.idBytes));
      const recipientAgentId = agentId(reader.readText(V2_LIMITS.idBytes));
      const recipientKeyId = reader.readText(V2_LIMITS.idBytes);
      const domainAuthoritySetDigest = reader.readFrame(HASH_BYTES);
      const domainCount = reader.readCount(DEVICE_WRAPPED_DOMAIN_AGENT_GRANT_V1_MAX_DOMAINS);
      const domains = Array.from({ length: domainCount }, () => Object.freeze({
        grantDomainId: reader.readText(V2_LIMITS.idBytes),
        domainKeyGeneration: reader.readU64(),
        participantDigest: reader.readFrame(HASH_BYTES),
        headDigest: reader.readFrame(HASH_BYTES),
        authorizationRevision: authorizationRevision(reader.readU64()),
        domainAiGrantKey: reader.readFrame(KEY_BYTES),
      }));
      return normalizeSecret({
        formatVersion: DEVICE_WRAPPED_DOMAIN_AGENT_GRANT_V1_FORMAT_VERSION,
        purpose: DEVICE_WRAPPED_DOMAIN_AGENT_GRANT_V1_SECRET_PURPOSE,
        grantId: grantIdValue,
        operationId,
        sessionId,
        roomId,
        subjectHumanId,
        committerDeviceId,
        recipientAgentId,
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
      destroyDeviceWrappedDomainAgentGrantSecretV1(value);
      return null;
    }
    return value;
  } catch {
    return null;
  }
}

export function destroyDeviceWrappedDomainAgentGrantSecretV1(
  value: DeviceWrappedDomainAgentGrantSecretV1,
): void {
  value.domainAuthoritySetDigest.fill(0);
  value.domains.forEach(destroySecretEntry);
}

function grantSigningBytes(
  value: Omit<DeviceWrappedDomainAgentGrantV1, "signature">,
): Uint8Array {
  if (
    value.formatVersion !== DEVICE_WRAPPED_DOMAIN_AGENT_GRANT_V1_FORMAT_VERSION
    || value.purpose !== DEVICE_WRAPPED_DOMAIN_AGENT_GRANT_V1_PURPOSE
    || value.scheme !== DEVICE_WRAPPED_DOMAIN_AGENT_GRANT_V1_SCHEME
  ) throw new TypeError("Domain Agent Grant version is unsupported");
  grantId(value.id);
  assertExactBytes("Domain Agent Grant plan digest", value.planDigest, HASH_BYTES);
  assertExactBytes("Domain Agent Grant secret digest", value.secretDigest, HASH_BYTES);
  assertExactBytes("Domain Agent Grant ciphertext digest", value.encryptedSecretDigest, HASH_BYTES);
  if (value.domainCount < 1 || value.domainCount > DEVICE_WRAPPED_DOMAIN_AGENT_GRANT_V1_MAX_DOMAINS) throw new RangeError("Domain Agent Grant Domain count is invalid");
  if (!(value.planBytes instanceof Uint8Array) || value.planBytes.length < 1 || value.planBytes.length > DEVICE_WRAPPED_DOMAIN_AGENT_GRANT_V1_MAX_WIRE_BYTES) throw new RangeError("Domain Agent Grant plan bytes are invalid");
  if (!(value.encryptedSecret instanceof Uint8Array) || value.encryptedSecret.length < 1 || value.encryptedSecret.length > DEVICE_WRAPPED_DOMAIN_AGENT_GRANT_V1_MAX_SECRET_BYTES + 256) throw new RangeError("Domain Agent Grant ciphertext is invalid");
  return concatV2(
    frameText(GRANT_DOMAIN),
    encodeU32(value.formatVersion),
    frameText(value.purpose),
    frameText(value.scheme),
    frameText(value.id),
    frame(value.planBytes),
    frame(value.planDigest),
    encodeU32(value.domainCount),
    frame(value.secretDigest),
    frame(value.encryptedSecret),
    frame(value.encryptedSecretDigest),
  );
}

export function serializeDeviceWrappedDomainAgentGrantV1(
  value: DeviceWrappedDomainAgentGrantV1,
): Uint8Array {
  assertExactBytes("Domain Agent Grant signature", value.signature, V2_LIMITS.signatureBytes);
  const signing = grantSigningBytes(value);
  try {
    const bytes = concatV2(signing, frame(value.signature));
    if (bytes.length > DEVICE_WRAPPED_DOMAIN_AGENT_GRANT_V1_MAX_WIRE_BYTES) {
      bytes.fill(0);
      throw new RangeError("Domain Agent Grant exceeds its wire bound");
    }
    return bytes;
  } finally {
    signing.fill(0);
  }
}

export function parseDeviceWrappedDomainAgentGrantV1(
  bytes: Uint8Array,
): DeviceWrappedDomainAgentGrantV1 | null {
  if (bytes.length > DEVICE_WRAPPED_DOMAIN_AGENT_GRANT_V1_MAX_WIRE_BYTES) return null;
  try {
    const value = decodeExact(bytes, (reader) => {
      if (reader.readText(256) !== GRANT_DOMAIN) throw new TypeError("Domain Agent Grant domain is invalid");
      reader.readVersion(DEVICE_WRAPPED_DOMAIN_AGENT_GRANT_V1_FORMAT_VERSION);
      if (reader.readText(128) !== DEVICE_WRAPPED_DOMAIN_AGENT_GRANT_V1_PURPOSE) throw new TypeError("Domain Agent Grant purpose is invalid");
      if (reader.readText(128) !== DEVICE_WRAPPED_DOMAIN_AGENT_GRANT_V1_SCHEME) throw new TypeError("Domain Agent Grant scheme is invalid");
      return Object.freeze({
        formatVersion: DEVICE_WRAPPED_DOMAIN_AGENT_GRANT_V1_FORMAT_VERSION,
        purpose: DEVICE_WRAPPED_DOMAIN_AGENT_GRANT_V1_PURPOSE,
        scheme: DEVICE_WRAPPED_DOMAIN_AGENT_GRANT_V1_SCHEME,
        id: grantId(reader.readText(V2_LIMITS.idBytes)),
        planBytes: reader.readFrame(DEVICE_WRAPPED_DOMAIN_AGENT_GRANT_V1_MAX_WIRE_BYTES),
        planDigest: reader.readFrame(HASH_BYTES),
        domainCount: reader.readCount(DEVICE_WRAPPED_DOMAIN_AGENT_GRANT_V1_MAX_DOMAINS),
        secretDigest: reader.readFrame(HASH_BYTES),
        encryptedSecret: reader.readFrame(DEVICE_WRAPPED_DOMAIN_AGENT_GRANT_V1_MAX_SECRET_BYTES + 256),
        encryptedSecretDigest: reader.readFrame(HASH_BYTES),
        signature: reader.readFrame(V2_LIMITS.signatureBytes),
      });
    });
    const canonical = serializeDeviceWrappedDomainAgentGrantV1(value);
    const matches = sameBytes(canonical, bytes);
    canonical.fill(0);
    if (!matches) {
      destroyDeviceWrappedDomainAgentGrantV1(value);
      return null;
    }
    return value;
  } catch {
    return null;
  }
}

export function destroyDeviceWrappedDomainAgentGrantV1(
  value: DeviceWrappedDomainAgentGrantV1,
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
  plan: DeviceWrappedDomainAgentGrantPlanV1,
): boolean {
  const digest = deviceWrappedDomainAgentGrantAuthoritySetDigestV1(
    crypto,
    plan.domains,
  );
  try {
    return sameBytes(digest, plan.domainAuthoritySetDigest);
  } finally {
    digest.fill(0);
  }
}

function secretMatchesPlan(
  secret: DeviceWrappedDomainAgentGrantSecretV1,
  plan: DeviceWrappedDomainAgentGrantPlanV1,
  grantIdValue: GrantId,
): boolean {
  if (
    secret.grantId !== grantIdValue
    || secret.operationId !== plan.operationId
    || secret.sessionId !== plan.sessionId
    || secret.roomId !== plan.roomId
    || secret.subjectHumanId !== plan.subjectHumanId
    || secret.committerDeviceId !== plan.committerDeviceId
    || secret.recipientAgentId !== plan.recipientAgentId
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
  plan: DeviceWrappedDomainAgentGrantPlanV1,
  current: DeviceWrappedDomainAgentGrantCurrentAuthorityV1,
): boolean {
  if (
    plan.operationId !== current.operationId
    || plan.policyRevision !== current.policyRevision
    || plan.sessionId !== current.sessionId
    || plan.roomId !== current.roomId
    || plan.subjectHumanId !== current.subjectHumanId
    || plan.committerDeviceId !== current.committerDeviceId
    || plan.committerDeviceSigningGeneration !== current.committerDeviceSigningGeneration
    || plan.hostAuthorizationRevision !== current.hostAuthorizationRevision
    || plan.recipientAgentId !== current.recipientAgentId
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

export async function mintDeviceWrappedDomainAgentGrantV1(
  crypto: LatticeCrypto,
  input: Readonly<{
    grantId: GrantId;
    plan: DeviceWrappedDomainAgentGrantPlanV1;
    domains: readonly DeviceWrappedDomainAgentGrantSecretEntryV1[];
    committerDeviceSigningPrivateKey: Uint8Array;
    recipientEncryptionPublicKey: Uint8Array;
  }>,
): Promise<DeviceWrappedDomainAgentGrantV1> {
  const plan = normalizePlan(input.plan);
  const domains = canonicalSecretEntries(input.domains);
  const signingPrivateKey = exactBytes("Domain Agent Grant signing private key", input.committerDeviceSigningPrivateKey, V2_LIMITS.signingPrivateKeyBytes);
  const recipientPublicKey = exactBytes("Domain Agent Grant recipient public key", input.recipientEncryptionPublicKey, V2_LIMITS.hpkePublicKeyBytes);
  let encodedPlan: Uint8Array | undefined;
  let encodedSecret: Uint8Array | undefined;
  let encryptedSecret: Uint8Array | undefined;
  let signing: Uint8Array | undefined;
  try {
    if (!planDigestMatches(crypto, plan)) {
      throw new TypeError("Domain Agent Grant authority-set digest disagrees");
    }
    const secret = normalizeSecret({
      formatVersion: DEVICE_WRAPPED_DOMAIN_AGENT_GRANT_V1_FORMAT_VERSION,
      purpose: DEVICE_WRAPPED_DOMAIN_AGENT_GRANT_V1_SECRET_PURPOSE,
      grantId: grantId(input.grantId),
      operationId: plan.operationId,
      sessionId: plan.sessionId,
      roomId: plan.roomId,
      subjectHumanId: plan.subjectHumanId,
      committerDeviceId: plan.committerDeviceId,
      recipientAgentId: plan.recipientAgentId,
      recipientKeyId: plan.recipientKeyId,
      domainAuthoritySetDigest: plan.domainAuthoritySetDigest,
      domainCount: domains.length,
      domains,
    });
    try {
      if (!secretMatchesPlan(secret, plan, input.grantId)) {
        throw new TypeError("Domain Agent Grant secret is not the exact planned Domain set");
      }
      encodedPlan = planBytes(plan);
      encodedSecret = secretBytes(secret);
      if (encodedSecret.length > plan.maximumSecretBytes) {
        throw new RangeError("Domain Agent Grant secret exceeds its plan bound");
      }
      encryptedSecret = await crypto.sealTo(recipientPublicKey, encodedSecret);
      const unsigned = Object.freeze({
        formatVersion: DEVICE_WRAPPED_DOMAIN_AGENT_GRANT_V1_FORMAT_VERSION,
        purpose: DEVICE_WRAPPED_DOMAIN_AGENT_GRANT_V1_PURPOSE,
        scheme: DEVICE_WRAPPED_DOMAIN_AGENT_GRANT_V1_SCHEME,
        id: grantId(input.grantId),
        planBytes: encodedPlan.slice(),
        planDigest: crypto.hash(encodedPlan),
        domainCount: domains.length,
        secretDigest: crypto.hash(encodedSecret),
        encryptedSecret: encryptedSecret.slice(),
        encryptedSecretDigest: crypto.hash(encryptedSecret),
      });
      signing = grantSigningBytes(unsigned);
      const signature = crypto.sign(signingPrivateKey, signing);
      try {
        return Object.freeze({ ...unsigned, signature: signature.slice() });
      } finally {
        signature.fill(0);
      }
    } finally {
      destroyDeviceWrappedDomainAgentGrantSecretV1(secret);
    }
  } finally {
    destroyDeviceWrappedDomainAgentGrantPlanV1(plan);
    domains.forEach(destroySecretEntry);
    signingPrivateKey.fill(0);
    recipientPublicKey.fill(0);
    encodedPlan?.fill(0);
    encodedSecret?.fill(0);
    encryptedSecret?.fill(0);
    signing?.fill(0);
  }
}

export async function withOpenedDeviceWrappedDomainAgentGrantV1<Value>(
  crypto: LatticeCrypto,
  input: Readonly<{
    grantBytes: Uint8Array;
    now: number;
    current: DeviceWrappedDomainAgentGrantCurrentAuthorityV1;
    operation(
      domains: readonly DeviceWrappedDomainAgentGrantSecretEntryV1[],
    ): Value | PromiseLike<Value>;
  }>,
): Promise<OpenDeviceWrappedDomainAgentGrantResultV1<Value>> {
  const grant = parseDeviceWrappedDomainAgentGrantV1(input.grantBytes);
  if (grant === null) return Object.freeze({ status: "unavailable", reason: "invalid" });
  let plan: DeviceWrappedDomainAgentGrantPlanV1 | null = null;
  let secretBytesValue: Uint8Array | null = null;
  let secret: DeviceWrappedDomainAgentGrantSecretV1 | null = null;
  let signing: Uint8Array | undefined;
  let operationStarted = false;
  try {
    plan = parseDeviceWrappedDomainAgentGrantPlanV1(grant.planBytes);
    if (plan === null) return Object.freeze({ status: "unavailable", reason: "invalid" });
    const actualPlanDigest = crypto.hash(grant.planBytes);
    const actualCiphertextDigest = crypto.hash(grant.encryptedSecret);
    const publicValid = sameBytes(actualPlanDigest, grant.planDigest)
      && sameBytes(actualCiphertextDigest, grant.encryptedSecretDigest)
      && grant.domainCount === plan.domainCount
      && planDigestMatches(crypto, plan);
    actualPlanDigest.fill(0);
    actualCiphertextDigest.fill(0);
    if (!publicValid) return Object.freeze({ status: "unavailable", reason: "invalid" });
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
    ) return Object.freeze({ status: "unavailable", reason: "authority_stale" });
    if (
      !input.current.hostAllowsOperation
      || !plan.operations.includes(input.current.operation)
    ) return Object.freeze({ status: "unavailable", reason: "operation_denied" });
    assertExactBytes("Domain Agent Grant signing public key", input.current.committerDeviceSigningPublicKey, V2_LIMITS.signingPublicKeyBytes);
    assertExactBytes("Domain Agent Grant recipient private key", input.current.recipientEncryptionPrivateKey, V2_LIMITS.hpkePrivateKeyBytes);
    signing = grantSigningBytes(grant);
    if (!crypto.verify(input.current.committerDeviceSigningPublicKey, signing, grant.signature)) {
      return Object.freeze({ status: "unavailable", reason: "invalid" });
    }
    secretBytesValue = await crypto.openSealed(
      input.current.recipientEncryptionPrivateKey,
      grant.encryptedSecret,
    );
    if (secretBytesValue === null) {
      return Object.freeze({ status: "unavailable", reason: "secret_unavailable" });
    }
    const actualSecretDigest = crypto.hash(secretBytesValue);
    const secretDigestValid = sameBytes(actualSecretDigest, grant.secretDigest);
    actualSecretDigest.fill(0);
    if (!secretDigestValid) return Object.freeze({ status: "unavailable", reason: "invalid" });
    secret = parseDeviceWrappedDomainAgentGrantSecretV1(secretBytesValue);
    if (
      secret === null
      || !secretMatchesPlan(secret, plan, grant.id)
      || secret.domainCount !== grant.domainCount
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
    if (secret) destroyDeviceWrappedDomainAgentGrantSecretV1(secret);
    if (plan) destroyDeviceWrappedDomainAgentGrantPlanV1(plan);
    destroyDeviceWrappedDomainAgentGrantV1(grant);
  }
}
