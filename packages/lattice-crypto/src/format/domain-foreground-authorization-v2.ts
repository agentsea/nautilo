import type { LatticeCrypto } from "../crypto/index.ts";
import { compareUnsignedUtf8 } from "../domain/participants.ts";
import type {
  AuthorizationRevision,
  CryptoDeviceId,
  HumanId,
} from "../v2-types/ids.ts";
import {
  assertPortableId,
  assertU64Counter,
  authorizationRevision,
  cryptoDeviceId,
  humanId,
} from "../v2-types/ids.ts";
import { assertV2Range, V2_LIMITS } from "../v2-types/limits.ts";
import { copyOwnedBytesV2 } from "../v2-types/opaque.ts";
import {
  concatV2,
  decodeExact,
  encodeU32,
  encodeU64,
  frame,
  frameText,
  type StrictDecoder,
} from "./v2-primitives.ts";

export const DOMAIN_FOREGROUND_AUTHORIZATION_FORMAT_VERSION_V2 = 2 as const;
export const DOMAIN_FOREGROUND_AUTHORIZATION_PLAN_PURPOSE_V2 =
  "domain_key.foreground_authorization_plan" as const;
export const DOMAIN_FOREGROUND_AUTHORIZATION_PURPOSE_V2 =
  "domain_key.foreground_authorization" as const;
export const DOMAIN_FOREGROUND_AUTHORIZATION_SECRET_PURPOSE_V2 =
  "domain_key.foreground_authorization_secret" as const;
export const DOMAIN_FOREGROUND_AUTHORIZATION_SCHEME_V2 =
  "domain_key_foreground_session_v2" as const;
export const DOMAIN_FOREGROUND_AUTHORIZATION_MAX_TTL_MS_V2 =
  2 * 60 * 60 * 1000;
export const DOMAIN_FOREGROUND_AUTHORIZATION_MAX_PLAN_BYTES_V2 =
  V2_LIMITS.agentGrantPlanBytes;
export const DOMAIN_FOREGROUND_AUTHORIZATION_MAX_SECRET_BYTES_V2 =
  V2_LIMITS.agentGrantSecretBytes;
export const DOMAIN_FOREGROUND_AUTHORIZATION_MAX_WIRE_BYTES_V2 =
  V2_LIMITS.agentGrantWireBytes;

const PLAN_DOMAIN =
  "nautilo/lattice-crypto/domain-foreground-authorization-plan/v2";
const SECRET_DOMAIN =
  "nautilo/lattice-crypto/domain-foreground-authorization-secret/v2";
const AUTHORIZATION_DOMAIN =
  "nautilo/lattice-crypto/domain-foreground-authorization/v2";
const AUTHORITY_SET_DOMAIN =
  "nautilo/lattice-crypto/domain-foreground-authority-set/v2";
const NAMESPACE_BINDING_SET_DOMAIN =
  "nautilo/lattice-crypto/domain-foreground-namespace-binding-set/v2";
const HASH_BYTES = 32;
const KEY_BYTES = 32;
const MAX_DOMAIN_ENTRIES_PER_WIRE_OBJECT = V2_LIMITS.agentGrantDomains;

export type DomainForegroundRecipientKindV2 = "agent" | "runtime";
export type DomainForegroundOperationV2 = "decrypt" | "encrypt";

export type DomainForegroundNamespaceBindingV2 = Readonly<{
  namespaceId: string;
  bindingDigest: Uint8Array;
}>;

export interface DomainForegroundAuthorityEntryV2 {
  readonly domainId: string;
  readonly sourceNamespaceId: string;
  readonly participantDigest: Uint8Array;
  readonly participantCount: number;
  readonly keyClass: "ai";
  readonly domainKeyGeneration: number;
  readonly authorizationRevision: AuthorizationRevision;
  readonly headDigest: Uint8Array;
  readonly activeNamespaceBindingSetDigest: Uint8Array;
  readonly activeNamespaceBindingCount: number;
}

export interface DomainForegroundSecretEntryV2 {
  readonly domainId: string;
  readonly sourceNamespaceId: string;
  readonly participantDigest: Uint8Array;
  readonly participantCount: number;
  readonly keyClass: "ai";
  readonly domainKeyGeneration: number;
  readonly authorizationRevision: AuthorizationRevision;
  readonly headDigest: Uint8Array;
  readonly domainKey: Uint8Array;
}

export interface DomainForegroundAuthorizationPlanV2 {
  readonly formatVersion: typeof DOMAIN_FOREGROUND_AUTHORIZATION_FORMAT_VERSION_V2;
  readonly purpose: typeof DOMAIN_FOREGROUND_AUTHORIZATION_PLAN_PURPOSE_V2;
  readonly scheme: typeof DOMAIN_FOREGROUND_AUTHORIZATION_SCHEME_V2;
  readonly authorizationId: string;
  readonly policyRevision: number;
  readonly sessionId: string;
  readonly roomId: string;
  readonly subjectHumanId: HumanId;
  readonly committerDeviceId: CryptoDeviceId;
  readonly committerDeviceSigningGeneration: number;
  readonly hostAuthorizationRevision: AuthorizationRevision;
  readonly recipientKind: DomainForegroundRecipientKindV2;
  readonly recipientPrincipalId: string;
  readonly recipientAuthorizationRevision: AuthorizationRevision;
  readonly recipientRuntimeGeneration: number;
  readonly recipientKeyId: string;
  readonly operations: readonly DomainForegroundOperationV2[];
  readonly issuedAt: number;
  readonly deadlineAt: number;
  readonly domainCount: number;
  readonly maximumSecretBytes: number;
  readonly domainAuthoritySetDigest: Uint8Array;
  readonly domains: readonly DomainForegroundAuthorityEntryV2[];
}

export interface DomainForegroundAuthorizationV2 {
  readonly formatVersion: typeof DOMAIN_FOREGROUND_AUTHORIZATION_FORMAT_VERSION_V2;
  readonly purpose: typeof DOMAIN_FOREGROUND_AUTHORIZATION_PURPOSE_V2;
  readonly scheme: typeof DOMAIN_FOREGROUND_AUTHORIZATION_SCHEME_V2;
  readonly authorizationId: string;
  readonly planBytes: Uint8Array;
  readonly planDigest: Uint8Array;
  readonly domainCount: number;
  readonly secretDigest: Uint8Array;
  readonly encryptedSecret: Uint8Array;
  readonly encryptedSecretDigest: Uint8Array;
  readonly signature: Uint8Array;
}

export interface DomainForegroundAuthorizationCurrentAuthorityV2 {
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
  readonly recipientKind: DomainForegroundRecipientKindV2;
  readonly recipientPrincipalId: string;
  readonly recipientAuthorizationRevision: AuthorizationRevision;
  readonly recipientRuntimeGeneration: number;
  readonly recipientKeyId: string;
  readonly recipientEncryptionPrivateKey: Uint8Array;
  readonly recipientAuthorized: boolean;
  readonly domains: readonly DomainForegroundAuthorityEntryV2[];
}

export type DomainForegroundAuthorizationPublicCurrentAuthorityV2 = Omit<
  DomainForegroundAuthorizationCurrentAuthorityV2,
  "recipientEncryptionPrivateKey"
>;

export type VerifyDomainForegroundAuthorizationResultV2 =
  | Readonly<{ status: "verified" }>
  | Readonly<{
      status: "unavailable";
      reason: "invalid" | "expired" | "authority_stale";
    }>;

export type OpenDomainForegroundAuthorizationResultV2<Value> =
  | Readonly<{ status: "opened"; value: Value }>
  | Readonly<{
      status: "unavailable";
      reason: "invalid" | "expired" | "authority_stale" | "secret_unavailable";
    }>;

function same(left: Uint8Array, right: Uint8Array): boolean {
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

function bytes(label: string, value: unknown, length: number): Uint8Array {
  if (!(value instanceof Uint8Array) || value.length !== length) {
    throw new RangeError(`${label} must be exactly ${length} bytes`);
  }
  return copyOwnedBytesV2(value);
}

function assertBytes(
  label: string,
  value: unknown,
  length: number,
): asserts value is Uint8Array {
  if (!(value instanceof Uint8Array) || value.length !== length) {
    throw new RangeError(`${label} must be exactly ${length} bytes`);
  }
}

function recipientKind(value: unknown): DomainForegroundRecipientKindV2 {
  if (value !== "agent" && value !== "runtime") {
    throw new TypeError("Foreground recipient kind is invalid");
  }
  return value;
}

function keyClass(value: unknown): "ai" {
  if (value !== "ai") {
    throw new TypeError("Foreground Domain key class must be ai");
  }
  return "ai";
}

function operations(
  values: readonly DomainForegroundOperationV2[],
): readonly DomainForegroundOperationV2[] {
  if (!Array.isArray(values as unknown) || (values.length !== 1 && values.length !== 2)) {
    throw new RangeError("Foreground operation set is invalid");
  }
  const result = [...new Set(values)].sort(compareUnsignedUtf8);
  if (
    result.length !== values.length
    || result[0] !== "decrypt"
    || (result.length === 2 && result[1] !== "encrypt")
    || result.some((value, index) => value !== values[index])
  ) throw new TypeError("Foreground operations must be decrypt or decrypt, encrypt");
  return Object.freeze(result);
}

function normalizeAuthority(
  value: DomainForegroundAuthorityEntryV2,
): DomainForegroundAuthorityEntryV2 {
  return Object.freeze({
    domainId: portable("Foreground Domain ID", value.domainId),
    sourceNamespaceId: portable(
      "Foreground source Namespace ID",
      value.sourceNamespaceId,
    ),
    participantDigest: bytes(
      "Foreground participant digest",
      value.participantDigest,
      HASH_BYTES,
    ),
    participantCount: counter(
      "Foreground participant count",
      value.participantCount,
      1,
    ),
    keyClass: keyClass(value.keyClass),
    domainKeyGeneration: counter(
      "Foreground Domain key generation",
      value.domainKeyGeneration,
      1,
    ),
    authorizationRevision: authorizationRevision(value.authorizationRevision),
    headDigest: bytes("Foreground Domain head digest", value.headDigest, HASH_BYTES),
    activeNamespaceBindingSetDigest: bytes(
      "Foreground Namespace binding-set digest",
      value.activeNamespaceBindingSetDigest,
      HASH_BYTES,
    ),
    activeNamespaceBindingCount: counter(
      "Foreground Namespace binding count",
      value.activeNamespaceBindingCount,
      1,
    ),
  });
}

function normalizeAuthorities(
  values: readonly DomainForegroundAuthorityEntryV2[],
): readonly DomainForegroundAuthorityEntryV2[] {
  if (!Array.isArray(values as unknown)) {
    throw new TypeError("Foreground Domain set must be an array");
  }
  assertV2Range(
    "Foreground Domain set",
    values.length,
    1,
    MAX_DOMAIN_ENTRIES_PER_WIRE_OBJECT,
  );
  const result = values.map(normalizeAuthority).sort((left, right) =>
    compareUnsignedUtf8(left.domainId, right.domainId)
  );
  if (result.some((value, index) =>
    index > 0 && value.domainId === result[index - 1]!.domainId
  )) {
    destroyDomainForegroundAuthorityEntriesV2(result);
    throw new TypeError("Foreground Domain IDs must be unique");
  }
  if (result.some((value, index) => value.domainId !== values[index]?.domainId)) {
    destroyDomainForegroundAuthorityEntriesV2(result);
    throw new TypeError("Foreground Domain set must be canonical");
  }
  return Object.freeze(result);
}

function authorityBytes(value: DomainForegroundAuthorityEntryV2): Uint8Array {
  return concatV2(
    frameText(value.domainId),
    frameText(value.sourceNamespaceId),
    frame(value.participantDigest),
    encodeU64(value.participantCount),
    frameText(value.keyClass),
    encodeU64(value.domainKeyGeneration),
    encodeU64(value.authorizationRevision),
    frame(value.headDigest),
    frame(value.activeNamespaceBindingSetDigest),
    encodeU64(value.activeNamespaceBindingCount),
  );
}

export function domainForegroundAuthoritySetDigestV2(
  crypto: Pick<LatticeCrypto, "hash">,
  values: readonly DomainForegroundAuthorityEntryV2[],
): Uint8Array {
  const normalized = normalizeAuthorities(values);
  const encoded = normalized.map(authorityBytes);
  try {
    const material = concatV2(
      frameText(AUTHORITY_SET_DOMAIN),
      encodeU32(normalized.length),
      ...encoded,
    );
    try {
      return crypto.hash(material);
    } finally {
      material.fill(0);
    }
  } finally {
    destroyDomainForegroundAuthorityEntriesV2(normalized);
    encoded.forEach((entry) => entry.fill(0));
  }
}

export function domainForegroundNamespaceBindingSetDigestV2(
  crypto: Pick<LatticeCrypto, "hash">,
  values: readonly DomainForegroundNamespaceBindingV2[],
): Uint8Array {
  if (!Array.isArray(values as unknown) || values.length < 1) {
    throw new RangeError("Foreground Namespace binding set is invalid");
  }
  const normalized = values.map((value) => Object.freeze({
    namespaceId: portable("Foreground Namespace ID", value.namespaceId),
    bindingDigest: bytes(
      "Foreground Namespace binding digest",
      value.bindingDigest,
      HASH_BYTES,
    ),
  })).sort((left, right) => compareUnsignedUtf8(
    left.namespaceId,
    right.namespaceId,
  ));
  const encoded: Uint8Array[] = [];
  try {
    if (normalized.some((value, index) =>
      index > 0 && value.namespaceId === normalized[index - 1]!.namespaceId
    )) throw new TypeError("Foreground Namespace bindings must be unique");
    encoded.push(...normalized.map((value) => concatV2(
      frameText(value.namespaceId),
      frame(value.bindingDigest),
    )));
    const material = concatV2(
      frameText(NAMESPACE_BINDING_SET_DOMAIN),
      encodeU32(normalized.length),
      ...encoded,
    );
    try {
      return crypto.hash(material);
    } finally {
      material.fill(0);
    }
  } finally {
    normalized.forEach((value) => value.bindingDigest.fill(0));
    encoded.forEach((value) => value.fill(0));
  }
}

function destroyDomainForegroundAuthorityEntriesV2(
  values: readonly DomainForegroundAuthorityEntryV2[],
): void {
  values.forEach((value) => {
    value.participantDigest.fill(0);
    value.headDigest.fill(0);
    value.activeNamespaceBindingSetDigest.fill(0);
  });
}

function normalizePlan(
  value: DomainForegroundAuthorizationPlanV2,
): DomainForegroundAuthorizationPlanV2 {
  if (
    value.formatVersion !== DOMAIN_FOREGROUND_AUTHORIZATION_FORMAT_VERSION_V2
    || value.purpose !== DOMAIN_FOREGROUND_AUTHORIZATION_PLAN_PURPOSE_V2
    || value.scheme !== DOMAIN_FOREGROUND_AUTHORIZATION_SCHEME_V2
  ) throw new TypeError("Foreground authorization plan version is unsupported");
  const domains = normalizeAuthorities(value.domains);
  const issuedAt = counter("Foreground authorization issued time", value.issuedAt);
  const deadlineAt = counter("Foreground authorization deadline", value.deadlineAt);
  if (
    deadlineAt <= issuedAt
    || deadlineAt - issuedAt > DOMAIN_FOREGROUND_AUTHORIZATION_MAX_TTL_MS_V2
  ) {
    destroyDomainForegroundAuthorityEntriesV2(domains);
    throw new RangeError("Foreground authorization deadline is invalid");
  }
  if (value.domainCount !== domains.length) {
    destroyDomainForegroundAuthorityEntriesV2(domains);
    throw new TypeError("Foreground authorization Domain count disagrees");
  }
  const maximumSecretBytes = counter(
    "Foreground maximum secret bytes",
    value.maximumSecretBytes,
    1,
  );
  if (maximumSecretBytes > DOMAIN_FOREGROUND_AUTHORIZATION_MAX_SECRET_BYTES_V2) {
    destroyDomainForegroundAuthorityEntriesV2(domains);
    throw new RangeError("Foreground maximum secret bytes exceeds its bound");
  }
  return Object.freeze({
    formatVersion: DOMAIN_FOREGROUND_AUTHORIZATION_FORMAT_VERSION_V2,
    purpose: DOMAIN_FOREGROUND_AUTHORIZATION_PLAN_PURPOSE_V2,
    scheme: DOMAIN_FOREGROUND_AUTHORIZATION_SCHEME_V2,
    authorizationId: portable("Foreground authorization ID", value.authorizationId),
    policyRevision: counter("Foreground policy revision", value.policyRevision),
    sessionId: portable("Foreground Session ID", value.sessionId),
    roomId: portable("Foreground Room ID", value.roomId),
    subjectHumanId: humanId(value.subjectHumanId),
    committerDeviceId: cryptoDeviceId(value.committerDeviceId),
    committerDeviceSigningGeneration: counter(
      "Foreground device generation",
      value.committerDeviceSigningGeneration,
      1,
    ),
    hostAuthorizationRevision: authorizationRevision(value.hostAuthorizationRevision),
    recipientKind: recipientKind(value.recipientKind),
    recipientPrincipalId: portable(
      "Foreground recipient principal",
      value.recipientPrincipalId,
    ),
    recipientAuthorizationRevision: authorizationRevision(
      value.recipientAuthorizationRevision,
    ),
    recipientRuntimeGeneration: counter(
      "Foreground recipient Runtime generation",
      value.recipientRuntimeGeneration,
    ),
    recipientKeyId: portable("Foreground recipient key", value.recipientKeyId),
    operations: operations(value.operations),
    issuedAt,
    deadlineAt,
    domainCount: domains.length,
    maximumSecretBytes,
    domainAuthoritySetDigest: bytes(
      "Foreground authority-set digest",
      value.domainAuthoritySetDigest,
      HASH_BYTES,
    ),
    domains,
  });
}

export function createDomainForegroundAuthorizationPlanV2(
  crypto: Pick<LatticeCrypto, "hash">,
  input: Omit<
    DomainForegroundAuthorizationPlanV2,
    "formatVersion" | "purpose" | "scheme" | "domainCount" |
      "domainAuthoritySetDigest"
  >,
): DomainForegroundAuthorizationPlanV2 {
  const digest = domainForegroundAuthoritySetDigestV2(crypto, input.domains);
  try {
    return normalizePlan({
      ...input,
      formatVersion: DOMAIN_FOREGROUND_AUTHORIZATION_FORMAT_VERSION_V2,
      purpose: DOMAIN_FOREGROUND_AUTHORIZATION_PLAN_PURPOSE_V2,
      scheme: DOMAIN_FOREGROUND_AUTHORIZATION_SCHEME_V2,
      domainCount: input.domains.length,
      domainAuthoritySetDigest: digest,
    });
  } finally {
    digest.fill(0);
  }
}

function planBytes(value: DomainForegroundAuthorizationPlanV2): Uint8Array {
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
    frameText(value.recipientKind),
    frameText(value.recipientPrincipalId),
    encodeU64(value.recipientAuthorizationRevision),
    encodeU64(value.recipientRuntimeGeneration),
    frameText(value.recipientKeyId),
    encodeU32(value.operations.length),
    ...value.operations.map(frameText),
    encodeU64(value.issuedAt),
    encodeU64(value.deadlineAt),
    encodeU32(value.domainCount),
    encodeU64(value.maximumSecretBytes),
    frame(value.domainAuthoritySetDigest),
    encodeU32(value.domains.length),
    ...value.domains.map(authorityBytes),
  );
}

export function serializeDomainForegroundAuthorizationPlanV2(
  value: DomainForegroundAuthorizationPlanV2,
): Uint8Array {
  const normalized = normalizePlan(value);
  try {
    const encoded = planBytes(normalized);
    if (encoded.length > DOMAIN_FOREGROUND_AUTHORIZATION_MAX_PLAN_BYTES_V2) {
      encoded.fill(0);
      throw new RangeError("Foreground authorization plan exceeds its wire bound");
    }
    return encoded;
  } finally {
    destroyDomainForegroundAuthorizationPlanV2(normalized);
  }
}

function readAuthority(reader: StrictDecoder) {
  return Object.freeze({
    domainId: reader.readText(V2_LIMITS.idBytes),
    sourceNamespaceId: reader.readText(V2_LIMITS.idBytes),
    participantDigest: reader.readFrame(HASH_BYTES),
    participantCount: reader.readU64(),
    keyClass: keyClass(reader.readText(16)),
    domainKeyGeneration: reader.readU64(),
    authorizationRevision: authorizationRevision(reader.readU64()),
    headDigest: reader.readFrame(HASH_BYTES),
    activeNamespaceBindingSetDigest: reader.readFrame(HASH_BYTES),
    activeNamespaceBindingCount: reader.readU64(),
  });
}

export function parseDomainForegroundAuthorizationPlanV2(
  encoded: Uint8Array,
): DomainForegroundAuthorizationPlanV2 | null {
  if (
    !(encoded instanceof Uint8Array)
    || encoded.length < 1
    || encoded.length > DOMAIN_FOREGROUND_AUTHORIZATION_MAX_PLAN_BYTES_V2
  ) return null;
  try {
    const value = decodeExact(encoded, (reader) => {
      if (reader.readText(256) !== PLAN_DOMAIN) throw new TypeError("Plan domain is invalid");
      reader.readVersion(DOMAIN_FOREGROUND_AUTHORIZATION_FORMAT_VERSION_V2);
      if (
        reader.readText(128) !== DOMAIN_FOREGROUND_AUTHORIZATION_PLAN_PURPOSE_V2
        || reader.readText(128) !== DOMAIN_FOREGROUND_AUTHORIZATION_SCHEME_V2
      ) throw new TypeError("Plan purpose is invalid");
      const authorizationId = reader.readText(V2_LIMITS.idBytes);
      const policyRevision = reader.readU64();
      const sessionId = reader.readText(V2_LIMITS.idBytes);
      const roomId = reader.readText(V2_LIMITS.idBytes);
      const subjectHumanId = humanId(reader.readText(V2_LIMITS.idBytes));
      const committerDeviceId = cryptoDeviceId(reader.readText(V2_LIMITS.idBytes));
      const committerDeviceSigningGeneration = reader.readU64();
      const hostAuthorizationRevision = authorizationRevision(reader.readU64());
      const selectedRecipientKind = recipientKind(reader.readText(16));
      const recipientPrincipalId = reader.readText(V2_LIMITS.idBytes);
      const recipientAuthorizationRevision = authorizationRevision(reader.readU64());
      const recipientRuntimeGeneration = reader.readU64();
      const recipientKeyId = reader.readText(V2_LIMITS.idBytes);
      const operationCount = reader.readCount(2);
      const selectedOperations = Array.from({ length: operationCount }, () =>
        reader.readText(16) as DomainForegroundOperationV2
      );
      const issuedAt = reader.readU64();
      const deadlineAt = reader.readU64();
      const domainCount = reader.readCount(MAX_DOMAIN_ENTRIES_PER_WIRE_OBJECT);
      const maximumSecretBytes = reader.readU64();
      const domainAuthoritySetDigest = reader.readFrame(HASH_BYTES);
      const encodedCount = reader.readCount(MAX_DOMAIN_ENTRIES_PER_WIRE_OBJECT);
      if (encodedCount !== domainCount) throw new TypeError("Domain count disagrees");
      const domains = Array.from({ length: encodedCount }, () => readAuthority(reader));
      return normalizePlan({
        formatVersion: DOMAIN_FOREGROUND_AUTHORIZATION_FORMAT_VERSION_V2,
        purpose: DOMAIN_FOREGROUND_AUTHORIZATION_PLAN_PURPOSE_V2,
        scheme: DOMAIN_FOREGROUND_AUTHORIZATION_SCHEME_V2,
        authorizationId,
        policyRevision,
        sessionId,
        roomId,
        subjectHumanId,
        committerDeviceId,
        committerDeviceSigningGeneration,
        hostAuthorizationRevision,
        recipientKind: selectedRecipientKind,
        recipientPrincipalId,
        recipientAuthorizationRevision,
        recipientRuntimeGeneration,
        recipientKeyId,
        operations: selectedOperations,
        issuedAt,
        deadlineAt,
        domainCount,
        maximumSecretBytes,
        domainAuthoritySetDigest,
        domains,
      });
    });
    const canonical = planBytes(value);
    const valid = same(canonical, encoded);
    canonical.fill(0);
    if (!valid) {
      destroyDomainForegroundAuthorizationPlanV2(value);
      return null;
    }
    return value;
  } catch {
    return null;
  }
}

export function destroyDomainForegroundAuthorizationPlanV2(
  value: DomainForegroundAuthorizationPlanV2,
): void {
  value.domainAuthoritySetDigest.fill(0);
  destroyDomainForegroundAuthorityEntriesV2(value.domains);
}

function normalizeSecrets(
  values: readonly DomainForegroundSecretEntryV2[],
): readonly DomainForegroundSecretEntryV2[] {
  if (!Array.isArray(values as unknown)) {
    throw new TypeError("Foreground secret Domain set must be an array");
  }
  assertV2Range(
    "Foreground secret Domain set",
    values.length,
    1,
    MAX_DOMAIN_ENTRIES_PER_WIRE_OBJECT,
  );
  const result = values.map((value) => Object.freeze({
    domainId: portable("Foreground secret Domain ID", value.domainId),
    sourceNamespaceId: portable(
      "Foreground secret source Namespace ID",
      value.sourceNamespaceId,
    ),
    participantDigest: bytes(
      "Foreground secret participant digest",
      value.participantDigest,
      HASH_BYTES,
    ),
    participantCount: counter(
      "Foreground secret participant count",
      value.participantCount,
      1,
    ),
    keyClass: keyClass(value.keyClass),
    domainKeyGeneration: counter(
      "Foreground secret Domain generation",
      value.domainKeyGeneration,
      1,
    ),
    authorizationRevision: authorizationRevision(value.authorizationRevision),
    headDigest: bytes("Foreground secret head digest", value.headDigest, HASH_BYTES),
    domainKey: bytes("Foreground Domain key", value.domainKey, KEY_BYTES),
  })).sort((left, right) => compareUnsignedUtf8(left.domainId, right.domainId));
  if (
    result.some((value, index) =>
      value.domainId !== values[index]?.domainId
      || (index > 0 && value.domainId === result[index - 1]!.domainId)
    )
  ) {
    destroyDomainForegroundSecretEntriesV2(result);
    throw new TypeError("Foreground secret Domain set must be canonical and unique");
  }
  return Object.freeze(result);
}

function secretEntryBytes(value: DomainForegroundSecretEntryV2): Uint8Array {
  return concatV2(
    frameText(value.domainId),
    frameText(value.sourceNamespaceId),
    frame(value.participantDigest),
    encodeU64(value.participantCount),
    frameText(value.keyClass),
    encodeU64(value.domainKeyGeneration),
    encodeU64(value.authorizationRevision),
    frame(value.headDigest),
    frame(value.domainKey),
  );
}

function secretBytes(input: Readonly<{
  plan: DomainForegroundAuthorizationPlanV2;
  domains: readonly DomainForegroundSecretEntryV2[];
}>): Uint8Array {
  return concatV2(
    frameText(SECRET_DOMAIN),
    encodeU32(DOMAIN_FOREGROUND_AUTHORIZATION_FORMAT_VERSION_V2),
    frameText(DOMAIN_FOREGROUND_AUTHORIZATION_SECRET_PURPOSE_V2),
    frameText(input.plan.authorizationId),
    frameText(input.plan.sessionId),
    frameText(input.plan.roomId),
    frameText(input.plan.subjectHumanId),
    frameText(input.plan.committerDeviceId),
    frameText(input.plan.recipientKind),
    frameText(input.plan.recipientPrincipalId),
    encodeU64(input.plan.recipientRuntimeGeneration),
    frameText(input.plan.recipientKeyId),
    frame(input.plan.domainAuthoritySetDigest),
    encodeU32(input.domains.length),
    ...input.domains.map(secretEntryBytes),
  );
}

function parseSecrets(
  encoded: Uint8Array,
  plan: DomainForegroundAuthorizationPlanV2,
): readonly DomainForegroundSecretEntryV2[] | null {
  try {
    return decodeExact(encoded, (reader) => {
      if (reader.readText(256) !== SECRET_DOMAIN) throw new TypeError("Secret domain is invalid");
      reader.readVersion(DOMAIN_FOREGROUND_AUTHORIZATION_FORMAT_VERSION_V2);
      if (reader.readText(128) !== DOMAIN_FOREGROUND_AUTHORIZATION_SECRET_PURPOSE_V2) {
        throw new TypeError("Secret purpose is invalid");
      }
      if (
        reader.readText(V2_LIMITS.idBytes) !== plan.authorizationId
        || reader.readText(V2_LIMITS.idBytes) !== plan.sessionId
        || reader.readText(V2_LIMITS.idBytes) !== plan.roomId
        || reader.readText(V2_LIMITS.idBytes) !== plan.subjectHumanId
        || reader.readText(V2_LIMITS.idBytes) !== plan.committerDeviceId
        || recipientKind(reader.readText(16)) !== plan.recipientKind
        || reader.readText(V2_LIMITS.idBytes) !== plan.recipientPrincipalId
        || reader.readU64() !== plan.recipientRuntimeGeneration
        || reader.readText(V2_LIMITS.idBytes) !== plan.recipientKeyId
        || !same(reader.readFrame(HASH_BYTES), plan.domainAuthoritySetDigest)
      ) throw new TypeError("Secret scope disagrees");
      const count = reader.readCount(MAX_DOMAIN_ENTRIES_PER_WIRE_OBJECT);
      if (count !== plan.domainCount) throw new TypeError("Secret count disagrees");
      const domains = Array.from({ length: count }, () => Object.freeze({
        domainId: reader.readText(V2_LIMITS.idBytes),
        sourceNamespaceId: reader.readText(V2_LIMITS.idBytes),
        participantDigest: reader.readFrame(HASH_BYTES),
        participantCount: reader.readU64(),
        keyClass: keyClass(reader.readText(16)),
        domainKeyGeneration: reader.readU64(),
        authorizationRevision: authorizationRevision(reader.readU64()),
        headDigest: reader.readFrame(HASH_BYTES),
        domainKey: reader.readFrame(KEY_BYTES),
      }));
      return normalizeSecrets(domains);
    });
  } catch {
    return null;
  }
}

function destroyDomainForegroundSecretEntriesV2(
  values: readonly DomainForegroundSecretEntryV2[],
): void {
  values.forEach((value) => {
    value.participantDigest.fill(0);
    value.headDigest.fill(0);
    value.domainKey.fill(0);
  });
}

function secretsMatchPlan(
  values: readonly DomainForegroundSecretEntryV2[],
  plan: DomainForegroundAuthorizationPlanV2,
): boolean {
  return values.length === plan.domains.length
    && plan.domains.every((authority, index) => {
      const secret = values[index];
      return secret !== undefined
        && secret.domainId === authority.domainId
        && secret.sourceNamespaceId === authority.sourceNamespaceId
        && secret.participantCount === authority.participantCount
        && secret.keyClass === "ai"
        && secret.domainKeyGeneration === authority.domainKeyGeneration
        && secret.authorizationRevision === authority.authorizationRevision
        && same(secret.participantDigest, authority.participantDigest)
        && same(secret.headDigest, authority.headDigest);
    });
}

function signingBytes(
  value: Omit<DomainForegroundAuthorizationV2, "signature">,
): Uint8Array {
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

export async function mintDomainForegroundAuthorizationV2(
  crypto: LatticeCrypto,
  input: Readonly<{
    plan: DomainForegroundAuthorizationPlanV2;
    domains: readonly DomainForegroundSecretEntryV2[];
    committerDeviceSigningPrivateKey: Uint8Array;
    recipientEncryptionPublicKey: Uint8Array;
  }>,
): Promise<DomainForegroundAuthorizationV2> {
  const plan = normalizePlan(input.plan);
  const domains = normalizeSecrets(input.domains);
  const signingPrivateKey = bytes(
    "Foreground signing private key",
    input.committerDeviceSigningPrivateKey,
    V2_LIMITS.signingPrivateKeyBytes,
  );
  const recipientPublicKey = bytes(
    "Foreground recipient public key",
    input.recipientEncryptionPublicKey,
    V2_LIMITS.hpkePublicKeyBytes,
  );
  let encodedPlan: Uint8Array | undefined;
  let encodedSecret: Uint8Array | undefined;
  let encryptedSecret: Uint8Array | undefined;
  let unsignedBytes: Uint8Array | undefined;
  try {
    const digest = domainForegroundAuthoritySetDigestV2(crypto, plan.domains);
    const valid = same(digest, plan.domainAuthoritySetDigest)
      && secretsMatchPlan(domains, plan);
    digest.fill(0);
    if (!valid) throw new TypeError("Foreground Domain authority disagrees");
    encodedPlan = planBytes(plan);
    encodedSecret = secretBytes({ plan, domains });
    if (
      encodedSecret.length > plan.maximumSecretBytes
      || encodedSecret.length > DOMAIN_FOREGROUND_AUTHORIZATION_MAX_SECRET_BYTES_V2
    ) throw new RangeError("Foreground secret exceeds its bound");
    encryptedSecret = await crypto.sealTo(recipientPublicKey, encodedSecret);
    const unsigned = Object.freeze({
      formatVersion: DOMAIN_FOREGROUND_AUTHORIZATION_FORMAT_VERSION_V2,
      purpose: DOMAIN_FOREGROUND_AUTHORIZATION_PURPOSE_V2,
      scheme: DOMAIN_FOREGROUND_AUTHORIZATION_SCHEME_V2,
      authorizationId: plan.authorizationId,
      planBytes: encodedPlan.slice(),
      planDigest: crypto.hash(encodedPlan),
      domainCount: domains.length,
      secretDigest: crypto.hash(encodedSecret),
      encryptedSecret: encryptedSecret.slice(),
      encryptedSecretDigest: crypto.hash(encryptedSecret),
    });
    unsignedBytes = signingBytes(unsigned);
    const signature = crypto.sign(signingPrivateKey, unsignedBytes);
    try {
      return Object.freeze({ ...unsigned, signature: signature.slice() });
    } finally {
      signature.fill(0);
    }
  } finally {
    destroyDomainForegroundAuthorizationPlanV2(plan);
    destroyDomainForegroundSecretEntriesV2(domains);
    signingPrivateKey.fill(0);
    recipientPublicKey.fill(0);
    encodedPlan?.fill(0);
    encodedSecret?.fill(0);
    encryptedSecret?.fill(0);
    unsignedBytes?.fill(0);
  }
}

export function serializeDomainForegroundAuthorizationV2(
  value: DomainForegroundAuthorizationV2,
): Uint8Array {
  assertBytes("Foreground signature", value.signature, V2_LIMITS.signatureBytes);
  const signing = signingBytes(value);
  try {
    const encoded = concatV2(signing, frame(value.signature));
    if (encoded.length > DOMAIN_FOREGROUND_AUTHORIZATION_MAX_WIRE_BYTES_V2) {
      encoded.fill(0);
      throw new RangeError("Foreground authorization exceeds its wire bound");
    }
    return encoded;
  } finally {
    signing.fill(0);
  }
}

export function parseDomainForegroundAuthorizationV2(
  encoded: Uint8Array,
): DomainForegroundAuthorizationV2 | null {
  if (
    !(encoded instanceof Uint8Array)
    || encoded.length < 1
    || encoded.length > DOMAIN_FOREGROUND_AUTHORIZATION_MAX_WIRE_BYTES_V2
  ) return null;
  try {
    const value = decodeExact(encoded, (reader) => {
      if (reader.readText(256) !== AUTHORIZATION_DOMAIN) {
        throw new TypeError("Authorization domain is invalid");
      }
      reader.readVersion(DOMAIN_FOREGROUND_AUTHORIZATION_FORMAT_VERSION_V2);
      if (
        reader.readText(128) !== DOMAIN_FOREGROUND_AUTHORIZATION_PURPOSE_V2
        || reader.readText(128) !== DOMAIN_FOREGROUND_AUTHORIZATION_SCHEME_V2
      ) throw new TypeError("Authorization purpose is invalid");
      return Object.freeze({
        formatVersion: DOMAIN_FOREGROUND_AUTHORIZATION_FORMAT_VERSION_V2,
        purpose: DOMAIN_FOREGROUND_AUTHORIZATION_PURPOSE_V2,
        scheme: DOMAIN_FOREGROUND_AUTHORIZATION_SCHEME_V2,
        authorizationId: reader.readText(V2_LIMITS.idBytes),
        planBytes: reader.readFrame(DOMAIN_FOREGROUND_AUTHORIZATION_MAX_PLAN_BYTES_V2),
        planDigest: reader.readFrame(HASH_BYTES),
        domainCount: reader.readCount(MAX_DOMAIN_ENTRIES_PER_WIRE_OBJECT),
        secretDigest: reader.readFrame(HASH_BYTES),
        encryptedSecret: reader.readFrame(
          DOMAIN_FOREGROUND_AUTHORIZATION_MAX_SECRET_BYTES_V2 + 256,
        ),
        encryptedSecretDigest: reader.readFrame(HASH_BYTES),
        signature: reader.readFrame(V2_LIMITS.signatureBytes),
      });
    });
    const canonical = serializeDomainForegroundAuthorizationV2(value);
    const valid = same(canonical, encoded);
    canonical.fill(0);
    if (!valid) {
      destroyDomainForegroundAuthorizationV2(value);
      return null;
    }
    return value;
  } catch {
    return null;
  }
}

export function destroyDomainForegroundAuthorizationV2(
  value: DomainForegroundAuthorizationV2,
): void {
  value.planBytes.fill(0);
  value.planDigest.fill(0);
  value.secretDigest.fill(0);
  value.encryptedSecret.fill(0);
  value.encryptedSecretDigest.fill(0);
  value.signature.fill(0);
}

function currentMatches(
  plan: DomainForegroundAuthorizationPlanV2,
  current: DomainForegroundAuthorizationPublicCurrentAuthorityV2,
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
    || plan.recipientKind !== current.recipientKind
    || plan.recipientPrincipalId !== current.recipientPrincipalId
    || plan.recipientAuthorizationRevision
      !== current.recipientAuthorizationRevision
    || plan.recipientRuntimeGeneration !== current.recipientRuntimeGeneration
    || plan.recipientKeyId !== current.recipientKeyId
    || plan.domains.length !== current.domains.length
  ) return false;
  return plan.domains.every((expected, index) => {
    const actual = current.domains[index];
    if (actual === undefined) return false;
    const expectedBytes = authorityBytes(expected);
    const actualBytes = authorityBytes(actual);
    try {
      return same(expectedBytes, actualBytes);
    } finally {
      expectedBytes.fill(0);
      actualBytes.fill(0);
    }
  });
}

/** Verify a device grant before durable acceptance on any server instance.
 * The recipient private key is intentionally absent; only the instance that
 * owns that process-local key may subsequently open the accepted grant. */
export function verifyDomainForegroundAuthorizationV2(
  crypto: LatticeCrypto,
  input: Readonly<{
    authorizationBytes: Uint8Array;
    now: number;
    current: DomainForegroundAuthorizationPublicCurrentAuthorityV2;
    expectedOperations?: readonly ["decrypt"] | readonly ["decrypt", "encrypt"];
  }>,
): VerifyDomainForegroundAuthorizationResultV2 {
  const authorization = parseDomainForegroundAuthorizationV2(
    input.authorizationBytes,
  );
  if (authorization === null) {
    return Object.freeze({ status: "unavailable", reason: "invalid" });
  }
  let plan: DomainForegroundAuthorizationPlanV2 | null = null;
  let signing: Uint8Array | undefined;
  try {
    plan = parseDomainForegroundAuthorizationPlanV2(authorization.planBytes);
    if (plan === null) {
      return Object.freeze({ status: "unavailable", reason: "invalid" });
    }
    const expectedOperations = input.expectedOperations ?? ["decrypt", "encrypt"];
    if (plan.operations.length !== expectedOperations.length
      || plan.operations.some((operation, index) => operation !== expectedOperations[index])) {
      return Object.freeze({ status: "unavailable", reason: "authority_stale" });
    }
    const planDigest = crypto.hash(authorization.planBytes);
    const ciphertextDigest = crypto.hash(authorization.encryptedSecret);
    const authorityDigest = domainForegroundAuthoritySetDigestV2(crypto, plan.domains);
    const publicValid = same(planDigest, authorization.planDigest)
      && same(ciphertextDigest, authorization.encryptedSecretDigest)
      && same(authorityDigest, plan.domainAuthoritySetDigest)
      && authorization.authorizationId === plan.authorizationId
      && authorization.domainCount === plan.domainCount;
    planDigest.fill(0);
    ciphertextDigest.fill(0);
    authorityDigest.fill(0);
    if (!publicValid || !Number.isSafeInteger(input.now) || input.now < plan.issuedAt) {
      return Object.freeze({ status: "unavailable", reason: "invalid" });
    }
    if (input.now >= plan.deadlineAt) {
      return Object.freeze({ status: "unavailable", reason: "expired" });
    }
    if (!input.current.committerDeviceActive
      || !input.current.recipientAuthorized
      || !currentMatches(plan, input.current)) {
      return Object.freeze({ status: "unavailable", reason: "authority_stale" });
    }
    assertBytes(
      "Foreground signing public key",
      input.current.committerDeviceSigningPublicKey,
      V2_LIMITS.signingPublicKeyBytes,
    );
    signing = signingBytes(authorization);
    return crypto.verify(
      input.current.committerDeviceSigningPublicKey,
      signing,
      authorization.signature,
    )
      ? Object.freeze({ status: "verified" })
      : Object.freeze({ status: "unavailable", reason: "invalid" });
  } catch {
    return Object.freeze({ status: "unavailable", reason: "invalid" });
  } finally {
    signing?.fill(0);
    if (plan !== null) destroyDomainForegroundAuthorizationPlanV2(plan);
    destroyDomainForegroundAuthorizationV2(authorization);
  }
}

export async function withOpenedDomainForegroundAuthorizationV2<Value>(
  crypto: LatticeCrypto,
  input: Readonly<{
    authorizationBytes: Uint8Array;
    now: number;
    current: DomainForegroundAuthorizationCurrentAuthorityV2;
    /** Existing execution callers require both operations. Read-only consumers
     * must opt in explicitly and retain their decrypt-only callback boundary. */
    expectedOperations?: readonly ["decrypt"] | readonly ["decrypt", "encrypt"];
    operation(domains: readonly DomainForegroundSecretEntryV2[]):
      Value | PromiseLike<Value>;
  }>,
): Promise<OpenDomainForegroundAuthorizationResultV2<Value>> {
  const authorization = parseDomainForegroundAuthorizationV2(
    input.authorizationBytes,
  );
  if (authorization === null) {
    return Object.freeze({ status: "unavailable", reason: "invalid" });
  }
  let plan: DomainForegroundAuthorizationPlanV2 | null = null;
  let plaintext: Uint8Array | null = null;
  let secrets: readonly DomainForegroundSecretEntryV2[] | null = null;
  let signing: Uint8Array | undefined;
  let operationStarted = false;
  try {
    plan = parseDomainForegroundAuthorizationPlanV2(authorization.planBytes);
    if (plan === null) {
      return Object.freeze({ status: "unavailable", reason: "invalid" });
    }
    const expectedOperations = input.expectedOperations ?? ["decrypt", "encrypt"];
    if (plan.operations.length !== expectedOperations.length
      || plan.operations.some((operation, index) => operation !== expectedOperations[index])) {
      return Object.freeze({ status: "unavailable", reason: "authority_stale" });
    }
    const planDigest = crypto.hash(authorization.planBytes);
    const ciphertextDigest = crypto.hash(authorization.encryptedSecret);
    const authorityDigest = domainForegroundAuthoritySetDigestV2(
      crypto,
      plan.domains,
    );
    const publicValid = same(planDigest, authorization.planDigest)
      && same(ciphertextDigest, authorization.encryptedSecretDigest)
      && same(authorityDigest, plan.domainAuthoritySetDigest)
      && authorization.authorizationId === plan.authorizationId
      && authorization.domainCount === plan.domainCount;
    planDigest.fill(0);
    ciphertextDigest.fill(0);
    authorityDigest.fill(0);
    if (!publicValid || !Number.isSafeInteger(input.now) || input.now < plan.issuedAt) {
      return Object.freeze({ status: "unavailable", reason: "invalid" });
    }
    if (input.now >= plan.deadlineAt) {
      return Object.freeze({ status: "unavailable", reason: "expired" });
    }
    if (
      !input.current.committerDeviceActive
      || !input.current.recipientAuthorized
      || !currentMatches(plan, input.current)
    ) return Object.freeze({ status: "unavailable", reason: "authority_stale" });
    assertBytes(
      "Foreground signing public key",
      input.current.committerDeviceSigningPublicKey,
      V2_LIMITS.signingPublicKeyBytes,
    );
    assertBytes(
      "Foreground recipient private key",
      input.current.recipientEncryptionPrivateKey,
      V2_LIMITS.hpkePrivateKeyBytes,
    );
    signing = signingBytes(authorization);
    if (!crypto.verify(
      input.current.committerDeviceSigningPublicKey,
      signing,
      authorization.signature,
    )) return Object.freeze({ status: "unavailable", reason: "invalid" });
    plaintext = await crypto.openSealed(
      input.current.recipientEncryptionPrivateKey,
      authorization.encryptedSecret,
    );
    if (plaintext === null) {
      return Object.freeze({ status: "unavailable", reason: "secret_unavailable" });
    }
    const secretDigest = crypto.hash(plaintext);
    const secretValid = same(secretDigest, authorization.secretDigest);
    secretDigest.fill(0);
    if (!secretValid) return Object.freeze({ status: "unavailable", reason: "invalid" });
    secrets = parseSecrets(plaintext, plan);
    if (
      secrets === null
      || !secretsMatchPlan(secrets, plan)
      || secrets.length !== authorization.domainCount
    ) return Object.freeze({ status: "unavailable", reason: "invalid" });
    operationStarted = true;
    const value = await input.operation(secrets);
    operationStarted = false;
    return Object.freeze({ status: "opened", value });
  } catch (error) {
    if (operationStarted) throw error;
    return Object.freeze({ status: "unavailable", reason: "invalid" });
  } finally {
    signing?.fill(0);
    plaintext?.fill(0);
    if (secrets !== null) destroyDomainForegroundSecretEntriesV2(secrets);
    if (plan !== null) destroyDomainForegroundAuthorizationPlanV2(plan);
    destroyDomainForegroundAuthorizationV2(authorization);
  }
}
