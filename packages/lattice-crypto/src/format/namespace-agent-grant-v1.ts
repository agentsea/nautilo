import type { LatticeCrypto } from "../crypto/index.ts";
import { compareUnsignedUtf8 } from "../domain/participants.ts";
import type {
  AccessRevision,
  AgentId,
  AuthorizationRevision,
  CryptoDeviceId,
  GrantId,
  HumanId,
  NamespaceId,
  NamespaceKeyGeneration,
} from "../v2-types/ids.ts";
import {
  accessRevision,
  agentId,
  assertPortableId,
  assertU64Counter,
  authorizationRevision,
  cryptoDeviceId,
  grantId,
  humanId,
  namespaceGeneration,
  namespaceId,
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
  utf8V2,
} from "./v2-primitives.ts";

export const NAMESPACE_AGENT_GRANT_V1_FORMAT_VERSION = 1 as const;
export const NAMESPACE_AGENT_GRANT_V1_PLAN_PURPOSE =
  "namespace.agent-grant.plan" as const;
export const NAMESPACE_AGENT_GRANT_V1_PURPOSE =
  "namespace.agent-grant" as const;
export const NAMESPACE_AGENT_GRANT_V1_SECRET_PURPOSE =
  "namespace.agent-grant.secret" as const;
export const NAMESPACE_AGENT_GRANT_V1_SCHEME =
  "namespace-generation-enumeration-v1" as const;
export const NAMESPACE_AGENT_GRANT_V1_MAX_NAMESPACES =
  V2_LIMITS.distinctDomainsPerGrant;
export const NAMESPACE_AGENT_GRANT_V1_MAX_SECRET_ENTRIES =
  V2_LIMITS.retainedNamespaceGenerations;
export const NAMESPACE_AGENT_GRANT_V1_MAX_SECRET_BYTES =
  V2_LIMITS.grantSecretBytes;
export const NAMESPACE_AGENT_GRANT_V1_MAX_WIRE_BYTES =
  V2_LIMITS.grantWireBytes;
export const NAMESPACE_AGENT_GRANT_V1_MAX_TTL_MS = V2_LIMITS.grantTtlMs;

const PLAN_DOMAIN = "nautilo/lattice-crypto/namespace-agent-grant-plan/v1";
const AUTHORITY_SET_DOMAIN =
  "nautilo/lattice-crypto/namespace-agent-grant-authority-set/v1";
const GRANT_DOMAIN = "nautilo/lattice-crypto/namespace-agent-grant/v1";
const SECRET_DOMAIN =
  "nautilo/lattice-crypto/namespace-agent-grant-secret/v1";
const DIGEST_BYTES = 32;
const GENERATION_KEY_BYTES = 32;

export type NamespaceAgentGrantOperationV1 = "decrypt" | "encrypt";

export interface NamespaceAgentGrantRetainedGenerationV1 {
  readonly generation: NamespaceKeyGeneration;
  readonly accessRevision: AccessRevision;
  readonly headDigest: Uint8Array;
  readonly publicationDigest: Uint8Array;
  readonly publicationSetDigest: Uint8Array;
  readonly audienceFingerprint: Uint8Array;
}

export interface NamespaceAgentGrantAuthorityEntryV1 {
  readonly namespaceId: NamespaceId;
  readonly keyClass: "ai";
  readonly firstRetainedGeneration: NamespaceKeyGeneration;
  readonly currentGeneration: NamespaceKeyGeneration;
  readonly retainedGenerations:
    readonly NamespaceAgentGrantRetainedGenerationV1[];
  readonly agentAuthorizationRevision: AuthorizationRevision;
}

export interface NamespaceAgentGrantPlanV1 {
  readonly formatVersion: typeof NAMESPACE_AGENT_GRANT_V1_FORMAT_VERSION;
  readonly purpose: typeof NAMESPACE_AGENT_GRANT_V1_PLAN_PURPOSE;
  readonly operationId: string;
  readonly policyRevision: number;
  readonly sessionId: string;
  readonly roomId: string;
  readonly subjectHumanId: HumanId;
  readonly issuingDeviceId: CryptoDeviceId;
  readonly issuingDeviceSigningKeyGeneration: number;
  readonly hostAuthorizationRevision: AuthorizationRevision;
  readonly recipientAgentId: AgentId;
  readonly recipientKeyId: string;
  readonly operations: readonly NamespaceAgentGrantOperationV1[];
  readonly issuedAt: number;
  readonly deadlineAt: number;
  readonly namespaceCount: number;
  readonly secretEntryCount: number;
  readonly maximumSecretBytes: number;
  readonly authoritySetDigest: Uint8Array;
  readonly authority: readonly NamespaceAgentGrantAuthorityEntryV1[];
}

export interface NamespaceAgentGrantSecretEntryV1 {
  readonly namespaceId: NamespaceId;
  readonly keyClass: "ai";
  readonly accessRevision: AccessRevision;
  readonly generation: NamespaceKeyGeneration;
  readonly generationKey: Uint8Array;
  readonly audienceFingerprint: Uint8Array;
  readonly headDigest: Uint8Array;
}

export interface NamespaceAgentGrantSecretV1 {
  readonly formatVersion: typeof NAMESPACE_AGENT_GRANT_V1_FORMAT_VERSION;
  readonly purpose: typeof NAMESPACE_AGENT_GRANT_V1_SECRET_PURPOSE;
  readonly grantId: GrantId;
  readonly operationId: string;
  readonly sessionId: string;
  readonly roomId: string;
  readonly subjectHumanId: HumanId;
  readonly issuingDeviceId: CryptoDeviceId;
  readonly recipientAgentId: AgentId;
  readonly recipientKeyId: string;
  readonly authoritySetDigest: Uint8Array;
  readonly entryCount: number;
  readonly entries: readonly NamespaceAgentGrantSecretEntryV1[];
}

export interface NamespaceAgentGrantV1 {
  readonly formatVersion: typeof NAMESPACE_AGENT_GRANT_V1_FORMAT_VERSION;
  readonly purpose: typeof NAMESPACE_AGENT_GRANT_V1_PURPOSE;
  readonly scheme: typeof NAMESPACE_AGENT_GRANT_V1_SCHEME;
  readonly id: GrantId;
  readonly planBytes: Uint8Array;
  readonly planDigest: Uint8Array;
  readonly secretEntryCount: number;
  readonly secretDigest: Uint8Array;
  readonly encryptedSecret: Uint8Array;
  readonly encryptedSecretDigest: Uint8Array;
  readonly signature: Uint8Array;
}

export interface NamespaceAgentGrantCurrentAuthorityV1 {
  readonly operationId: string;
  readonly policyRevision: number;
  readonly sessionId: string;
  readonly roomId: string;
  readonly subjectHumanId: HumanId;
  readonly issuingDeviceId: CryptoDeviceId;
  readonly issuingDeviceSigningKeyGeneration: number;
  readonly issuingDeviceSigningPublicKey: Uint8Array;
  readonly issuingDeviceActive: boolean;
  readonly hostAuthorizationRevision: AuthorizationRevision;
  readonly recipientAgentId: AgentId;
  readonly recipientKeyId: string;
  readonly recipientEncryptionPrivateKey: Uint8Array;
  readonly agentAuthorized: boolean;
  readonly hostAllowsOperation: boolean;
  readonly operation: NamespaceAgentGrantOperationV1;
  readonly authority: readonly NamespaceAgentGrantAuthorityEntryV1[];
}

export type OpenNamespaceAgentGrantResultV1<Value> =
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

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length
    && left.every((value, index) => value === right[index]);
}

function exactBytes(label: string, value: Uint8Array, length: number): void {
  if (!(value instanceof Uint8Array) || value.length !== length) {
    throw new RangeError(`${label} must be exactly ${length} bytes`);
  }
}

function portable(label: string, value: string): string {
  assertPortableId(label, value);
  return value;
}

function canonicalOperations(
  values: readonly NamespaceAgentGrantOperationV1[],
): readonly NamespaceAgentGrantOperationV1[] {
  if (values.length < 1 || values.length > 2) {
    throw new RangeError("Namespace Agent Grant operations are out of bounds");
  }
  for (const value of values) {
    if (value !== "decrypt" && value !== "encrypt") {
      throw new TypeError("Namespace Agent Grant operation is unsupported");
    }
  }
  const canonical = [...new Set(values)].sort(compareUnsignedUtf8);
  if (
    canonical.length !== values.length
    || canonical.some((value, index) => value !== values[index])
  ) {
    throw new TypeError(
      "Namespace Agent Grant operations must be canonical and unique",
    );
  }
  return Object.freeze(canonical);
}

function validateAuthority(
  entries: readonly NamespaceAgentGrantAuthorityEntryV1[],
): number {
  if (
    !Array.isArray(entries as unknown)
    || entries.length < 1
    || entries.length > NAMESPACE_AGENT_GRANT_V1_MAX_NAMESPACES
  ) {
    throw new RangeError("Namespace Agent Grant authority count is invalid");
  }
  let secretEntryCount = 0;
  for (const [index, entry] of entries.entries()) {
    namespaceId(entry.namespaceId);
    if (entry.keyClass !== "ai") {
      throw new TypeError("Namespace Agent Grant authority must be AI-only");
    }
    namespaceGeneration(entry.firstRetainedGeneration);
    namespaceGeneration(entry.currentGeneration);
    authorizationRevision(entry.agentAuthorizationRevision);
    if (entry.firstRetainedGeneration > entry.currentGeneration) {
      throw new RangeError("Namespace Agent Grant generation range is invalid");
    }
    const retainedCount =
      entry.currentGeneration - entry.firstRetainedGeneration + 1;
    if (
      !Array.isArray(entry.retainedGenerations as unknown)
      || entry.retainedGenerations.length !== retainedCount
    ) throw new TypeError("Namespace Agent Grant retained inventory disagrees");
    for (const [generationIndex, retained] of
      entry.retainedGenerations.entries()) {
      const expectedGeneration =
        entry.firstRetainedGeneration + generationIndex;
      if (retained.generation !== expectedGeneration) {
        throw new TypeError(
          "Namespace Agent Grant retained inventory is noncanonical",
        );
      }
      namespaceGeneration(retained.generation);
      accessRevision(retained.accessRevision);
      exactBytes("Namespace head digest", retained.headDigest, DIGEST_BYTES);
      exactBytes(
        "Namespace publication digest",
        retained.publicationDigest,
        DIGEST_BYTES,
      );
      exactBytes(
        "Namespace publication-set digest",
        retained.publicationSetDigest,
        DIGEST_BYTES,
      );
      exactBytes(
        "Namespace audience fingerprint",
        retained.audienceFingerprint,
        DIGEST_BYTES,
      );
    }
    if (
      index > 0
      && compareUnsignedUtf8(
        entries[index - 1]!.namespaceId,
        entry.namespaceId,
      ) >= 0
    ) {
      throw new TypeError(
        "Namespace Agent Grant authority must be canonical and unique",
      );
    }
    secretEntryCount +=
      entry.currentGeneration - entry.firstRetainedGeneration + 1;
    if (secretEntryCount > NAMESPACE_AGENT_GRANT_V1_MAX_SECRET_ENTRIES) {
      throw new RangeError(
        "Namespace Agent Grant retained generation count exceeds its bound",
      );
    }
  }
  return secretEntryCount;
}

function authorityEntryBytes(
  entry: NamespaceAgentGrantAuthorityEntryV1,
): Uint8Array {
  return concatV2(
    frameText(entry.namespaceId),
    frameText(entry.keyClass),
    encodeU64(entry.firstRetainedGeneration),
    encodeU64(entry.currentGeneration),
    encodeU32(entry.retainedGenerations.length),
    ...entry.retainedGenerations.flatMap((retained) => [
      encodeU64(retained.generation),
      encodeU64(retained.accessRevision),
      frame(retained.headDigest),
      frame(retained.publicationDigest),
      frame(retained.publicationSetDigest),
      frame(retained.audienceFingerprint),
    ]),
    encodeU64(entry.agentAuthorizationRevision),
  );
}

function authoritySetBytes(
  entries: readonly NamespaceAgentGrantAuthorityEntryV1[],
): Uint8Array {
  validateAuthority(entries);
  return concatV2(
    frameText(AUTHORITY_SET_DOMAIN),
    encodeU32(NAMESPACE_AGENT_GRANT_V1_FORMAT_VERSION),
    encodeU32(entries.length),
    ...entries.map(authorityEntryBytes),
  );
}

export function namespaceAgentGrantAuthoritySetDigestV1(
  crypto: Pick<LatticeCrypto, "hash">,
  entries: readonly NamespaceAgentGrantAuthorityEntryV1[],
): Uint8Array {
  const bytes = authoritySetBytes(entries);
  try {
    return crypto.hash(bytes);
  } finally {
    bytes.fill(0);
  }
}

function validatePlanStructure(plan: NamespaceAgentGrantPlanV1): void {
  if (
    plan.formatVersion !== NAMESPACE_AGENT_GRANT_V1_FORMAT_VERSION
    || plan.purpose !== NAMESPACE_AGENT_GRANT_V1_PLAN_PURPOSE
  ) throw new TypeError("Namespace Agent Grant plan version is unsupported");
  portable("Namespace Agent Grant operation", plan.operationId);
  assertU64Counter("Namespace Agent Grant policy revision", plan.policyRevision);
  if (plan.policyRevision < 1) {
    throw new RangeError("Namespace Agent Grant policy revision must be positive");
  }
  portable("Namespace Agent Grant Session", plan.sessionId);
  portable("Namespace Agent Grant Room", plan.roomId);
  humanId(plan.subjectHumanId);
  cryptoDeviceId(plan.issuingDeviceId);
  assertU64Counter(
    "Namespace Agent Grant device signing generation",
    plan.issuingDeviceSigningKeyGeneration,
  );
  authorizationRevision(plan.hostAuthorizationRevision);
  agentId(plan.recipientAgentId);
  portable("Namespace Agent Grant recipient key", plan.recipientKeyId);
  canonicalOperations(plan.operations);
  if (
    !Number.isSafeInteger(plan.issuedAt)
    || !Number.isSafeInteger(plan.deadlineAt)
    || plan.issuedAt < 0
    || plan.deadlineAt <= plan.issuedAt
    || plan.deadlineAt - plan.issuedAt
      > NAMESPACE_AGENT_GRANT_V1_MAX_TTL_MS
  ) throw new RangeError("Namespace Agent Grant plan timestamps are invalid");
  const secretEntryCount = validateAuthority(plan.authority);
  if (
    plan.namespaceCount !== plan.authority.length
    || plan.secretEntryCount !== secretEntryCount
  ) throw new TypeError("Namespace Agent Grant plan counts disagree");
  if (
    !Number.isSafeInteger(plan.maximumSecretBytes)
    || plan.maximumSecretBytes < 1
    || plan.maximumSecretBytes > NAMESPACE_AGENT_GRANT_V1_MAX_SECRET_BYTES
  ) throw new RangeError("Namespace Agent Grant plan byte bound is invalid");
  exactBytes(
    "Namespace Agent Grant authority set digest",
    plan.authoritySetDigest,
    DIGEST_BYTES,
  );
}

export function createNamespaceAgentGrantPlanV1(
  crypto: Pick<LatticeCrypto, "hash">,
  input: Omit<
    NamespaceAgentGrantPlanV1,
    | "formatVersion"
    | "purpose"
    | "namespaceCount"
    | "secretEntryCount"
    | "authoritySetDigest"
  >,
): NamespaceAgentGrantPlanV1 {
  const secretEntryCount = validateAuthority(input.authority);
  const authoritySetDigest = namespaceAgentGrantAuthoritySetDigestV1(
    crypto,
    input.authority,
  );
  const plan = Object.freeze({
    formatVersion: NAMESPACE_AGENT_GRANT_V1_FORMAT_VERSION,
    purpose: NAMESPACE_AGENT_GRANT_V1_PLAN_PURPOSE,
    ...input,
    operations: Object.freeze([...input.operations]),
    namespaceCount: input.authority.length,
    secretEntryCount,
    authoritySetDigest,
    authority: Object.freeze(input.authority.map((entry) => Object.freeze({
      ...entry,
      retainedGenerations: Object.freeze(entry.retainedGenerations.map(
        (retained) => Object.freeze({
          ...retained,
          headDigest: retained.headDigest.slice(),
          publicationDigest: retained.publicationDigest.slice(),
          publicationSetDigest: retained.publicationSetDigest.slice(),
          audienceFingerprint: retained.audienceFingerprint.slice(),
        }),
      )),
    }))),
  });
  validatePlanStructure(plan);
  return plan;
}

export function serializeNamespaceAgentGrantPlanV1(
  plan: NamespaceAgentGrantPlanV1,
): Uint8Array {
  validatePlanStructure(plan);
  return concatV2(
    frameText(PLAN_DOMAIN),
    encodeU32(plan.formatVersion),
    frameText(plan.purpose),
    frameText(plan.operationId),
    encodeU64(plan.policyRevision),
    frameText(plan.sessionId),
    frameText(plan.roomId),
    frameText(plan.subjectHumanId),
    frameText(plan.issuingDeviceId),
    encodeU64(plan.issuingDeviceSigningKeyGeneration),
    encodeU64(plan.hostAuthorizationRevision),
    frameText(plan.recipientAgentId),
    frameText(plan.recipientKeyId),
    encodeU32(plan.operations.length),
    ...plan.operations.map(frameText),
    encodeU64(plan.issuedAt),
    encodeU64(plan.deadlineAt),
    encodeU32(plan.namespaceCount),
    encodeU32(plan.secretEntryCount),
    encodeU32(plan.maximumSecretBytes),
    frame(plan.authoritySetDigest),
    encodeU32(plan.authority.length),
    ...plan.authority.map(authorityEntryBytes),
  );
}

export function parseNamespaceAgentGrantPlanV1(
  bytes: Uint8Array,
): NamespaceAgentGrantPlanV1 | null {
  if (!(bytes instanceof Uint8Array) || bytes.length > V2_LIMITS.grantWireBytes) {
    return null;
  }
  try {
    const plan = decodeExact(bytes, (reader): NamespaceAgentGrantPlanV1 => {
      reader.readFrame(utf8V2(PLAN_DOMAIN).length);
      reader.readVersion(NAMESPACE_AGENT_GRANT_V1_FORMAT_VERSION);
      const purpose = reader.readText(
        V2_LIMITS.schemeIdBytes,
      ) as typeof NAMESPACE_AGENT_GRANT_V1_PLAN_PURPOSE;
      const operationId = reader.readText(V2_LIMITS.idBytes);
      const policyRevision = reader.readU64();
      const sessionId = reader.readText(V2_LIMITS.idBytes);
      const roomId = reader.readText(V2_LIMITS.idBytes);
      const subjectHumanId = humanId(reader.readText(V2_LIMITS.idBytes));
      const issuingDeviceId = cryptoDeviceId(
        reader.readText(V2_LIMITS.idBytes),
      );
      const issuingDeviceSigningKeyGeneration = reader.readU64();
      const hostAuthorizationRevision = authorizationRevision(reader.readU64());
      const recipientAgentId = agentId(reader.readText(V2_LIMITS.idBytes));
      const recipientKeyId = reader.readText(V2_LIMITS.idBytes);
      const operationCount = reader.readCount(2);
      const operations = Array.from(
        { length: operationCount },
        () => reader.readText(7) as NamespaceAgentGrantOperationV1,
      );
      const issuedAt = reader.readU64();
      const deadlineAt = reader.readU64();
      const namespaceCount = reader.readCount(
        NAMESPACE_AGENT_GRANT_V1_MAX_NAMESPACES,
      );
      const secretEntryCount = reader.readCount(
        NAMESPACE_AGENT_GRANT_V1_MAX_SECRET_ENTRIES,
      );
      const maximumSecretBytes = reader.readU32();
      const authoritySetDigest = reader.readFrame(DIGEST_BYTES);
      const authorityCount = reader.readCount(
        NAMESPACE_AGENT_GRANT_V1_MAX_NAMESPACES,
      );
      const authority = Array.from(
        { length: authorityCount },
        (): NamespaceAgentGrantAuthorityEntryV1 => ({
          namespaceId: namespaceId(reader.readText(V2_LIMITS.idBytes)),
          keyClass: reader.readText(2) as "ai",
          firstRetainedGeneration: namespaceGeneration(reader.readU64()),
          currentGeneration: namespaceGeneration(reader.readU64()),
          retainedGenerations: Array.from(
            { length: reader.readCount(NAMESPACE_AGENT_GRANT_V1_MAX_SECRET_ENTRIES) },
            (): NamespaceAgentGrantRetainedGenerationV1 => ({
              generation: namespaceGeneration(reader.readU64()),
              accessRevision: accessRevision(reader.readU64()),
              headDigest: reader.readFrame(DIGEST_BYTES),
              publicationDigest: reader.readFrame(DIGEST_BYTES),
              publicationSetDigest: reader.readFrame(DIGEST_BYTES),
              audienceFingerprint: reader.readFrame(DIGEST_BYTES),
            }),
          ),
          agentAuthorizationRevision: authorizationRevision(reader.readU64()),
        }),
      );
      return {
        formatVersion: NAMESPACE_AGENT_GRANT_V1_FORMAT_VERSION,
        purpose,
        operationId,
        policyRevision,
        sessionId,
        roomId,
        subjectHumanId,
        issuingDeviceId,
        issuingDeviceSigningKeyGeneration,
        hostAuthorizationRevision,
        recipientAgentId,
        recipientKeyId,
        operations,
        issuedAt,
        deadlineAt,
        namespaceCount,
        secretEntryCount,
        maximumSecretBytes,
        authoritySetDigest,
        authority,
      };
    });
    const canonical = serializeNamespaceAgentGrantPlanV1(plan);
    const matches = equalBytes(canonical, bytes);
    canonical.fill(0);
    if (!matches) {
      destroyNamespaceAgentGrantPlanV1(plan);
      return null;
    }
    return plan;
  } catch {
    return null;
  }
}

export function destroyNamespaceAgentGrantPlanV1(
  plan: NamespaceAgentGrantPlanV1,
): void {
  plan.authoritySetDigest.fill(0);
  plan.authority.forEach((entry) => {
    entry.retainedGenerations.forEach((retained) => {
      retained.headDigest.fill(0);
      retained.publicationDigest.fill(0);
      retained.publicationSetDigest.fill(0);
      retained.audienceFingerprint.fill(0);
    });
  });
}

function validateSecretEntries(
  entries: readonly NamespaceAgentGrantSecretEntryV1[],
): void {
  if (
    !Array.isArray(entries as unknown)
    || entries.length < 1
    || entries.length > NAMESPACE_AGENT_GRANT_V1_MAX_SECRET_ENTRIES
  ) throw new RangeError("Namespace Agent Grant secret entry count is invalid");
  for (const [index, entry] of entries.entries()) {
    namespaceId(entry.namespaceId);
    if (entry.keyClass !== "ai") {
      throw new TypeError("Namespace Agent Grant secret must be AI-only");
    }
    accessRevision(entry.accessRevision);
    namespaceGeneration(entry.generation);
    exactBytes(
      "Namespace Agent Grant generation key",
      entry.generationKey,
      GENERATION_KEY_BYTES,
    );
    exactBytes(
      "Namespace Agent Grant audience fingerprint",
      entry.audienceFingerprint,
      DIGEST_BYTES,
    );
    exactBytes(
      "Namespace Agent Grant head digest",
      entry.headDigest,
      DIGEST_BYTES,
    );
    const previous = entries[index - 1];
    if (
      previous !== undefined
      && (
        compareUnsignedUtf8(previous.namespaceId, entry.namespaceId) > 0
        || (
          previous.namespaceId === entry.namespaceId
          && previous.generation >= entry.generation
        )
      )
    ) {
      throw new TypeError(
        "Namespace Agent Grant secret entries must be canonical and unique",
      );
    }
  }
}

function validateSecretStructure(secret: NamespaceAgentGrantSecretV1): void {
  if (
    secret.formatVersion !== NAMESPACE_AGENT_GRANT_V1_FORMAT_VERSION
    || secret.purpose !== NAMESPACE_AGENT_GRANT_V1_SECRET_PURPOSE
  ) throw new TypeError("Namespace Agent Grant secret version is unsupported");
  grantId(secret.grantId);
  portable("Namespace Agent Grant secret operation", secret.operationId);
  portable("Namespace Agent Grant secret Session", secret.sessionId);
  portable("Namespace Agent Grant secret Room", secret.roomId);
  humanId(secret.subjectHumanId);
  cryptoDeviceId(secret.issuingDeviceId);
  agentId(secret.recipientAgentId);
  portable("Namespace Agent Grant secret recipient", secret.recipientKeyId);
  exactBytes(
    "Namespace Agent Grant secret authority digest",
    secret.authoritySetDigest,
    DIGEST_BYTES,
  );
  validateSecretEntries(secret.entries);
  if (secret.entryCount !== secret.entries.length) {
    throw new TypeError("Namespace Agent Grant secret count disagrees");
  }
}

function secretEntryBytes(
  entry: NamespaceAgentGrantSecretEntryV1,
): Uint8Array {
  const parts = [
    frameText(entry.namespaceId),
    frameText(entry.keyClass),
    encodeU64(entry.accessRevision),
    encodeU64(entry.generation),
    frame(entry.generationKey),
    frame(entry.audienceFingerprint),
    frame(entry.headDigest),
  ];
  try {
    return concatV2(...parts);
  } finally {
    parts.forEach((part) => part.fill(0));
  }
}

export function serializeNamespaceAgentGrantSecretV1(
  secret: NamespaceAgentGrantSecretV1,
): Uint8Array {
  validateSecretStructure(secret);
  const entryBytes = secret.entries.map(secretEntryBytes);
  try {
    const bytes = concatV2(
      frameText(SECRET_DOMAIN),
      encodeU32(secret.formatVersion),
      frameText(secret.purpose),
      frameText(secret.grantId),
      frameText(secret.operationId),
      frameText(secret.sessionId),
      frameText(secret.roomId),
      frameText(secret.subjectHumanId),
      frameText(secret.issuingDeviceId),
      frameText(secret.recipientAgentId),
      frameText(secret.recipientKeyId),
      frame(secret.authoritySetDigest),
      encodeU32(secret.entryCount),
      ...entryBytes,
    );
    if (bytes.length > NAMESPACE_AGENT_GRANT_V1_MAX_SECRET_BYTES) {
      bytes.fill(0);
      throw new RangeError("Namespace Agent Grant secret exceeds its byte bound");
    }
    return bytes;
  } finally {
    entryBytes.forEach((entry) => entry.fill(0));
  }
}

export function parseNamespaceAgentGrantSecretV1(
  bytes: Uint8Array,
): NamespaceAgentGrantSecretV1 | null {
  if (
    !(bytes instanceof Uint8Array)
    || bytes.length < 1
    || bytes.length > NAMESPACE_AGENT_GRANT_V1_MAX_SECRET_BYTES
  ) return null;
  let secret: NamespaceAgentGrantSecretV1 | null = null;
  try {
    secret = decodeExact(bytes, (reader): NamespaceAgentGrantSecretV1 => {
      reader.readFrame(utf8V2(SECRET_DOMAIN).length);
      reader.readVersion(NAMESPACE_AGENT_GRANT_V1_FORMAT_VERSION);
      const purpose = reader.readText(
        V2_LIMITS.schemeIdBytes,
      ) as typeof NAMESPACE_AGENT_GRANT_V1_SECRET_PURPOSE;
      const grantIdValue = grantId(reader.readText(V2_LIMITS.idBytes));
      const operationId = reader.readText(V2_LIMITS.idBytes);
      const sessionId = reader.readText(V2_LIMITS.idBytes);
      const roomId = reader.readText(V2_LIMITS.idBytes);
      const subjectHumanId = humanId(reader.readText(V2_LIMITS.idBytes));
      const issuingDeviceId = cryptoDeviceId(
        reader.readText(V2_LIMITS.idBytes),
      );
      const recipientAgentId = agentId(reader.readText(V2_LIMITS.idBytes));
      const recipientKeyId = reader.readText(V2_LIMITS.idBytes);
      const authoritySetDigest = reader.readFrame(DIGEST_BYTES);
      const entryCount = reader.readCount(
        NAMESPACE_AGENT_GRANT_V1_MAX_SECRET_ENTRIES,
      );
      const entries = Array.from(
        { length: entryCount },
        (): NamespaceAgentGrantSecretEntryV1 => ({
          namespaceId: namespaceId(reader.readText(V2_LIMITS.idBytes)),
          keyClass: reader.readText(2) as "ai",
          accessRevision: accessRevision(reader.readU64()),
          generation: namespaceGeneration(reader.readU64()),
          generationKey: reader.readFrame(GENERATION_KEY_BYTES),
          audienceFingerprint: reader.readFrame(DIGEST_BYTES),
          headDigest: reader.readFrame(DIGEST_BYTES),
        }),
      );
      return {
        formatVersion: NAMESPACE_AGENT_GRANT_V1_FORMAT_VERSION,
        purpose,
        grantId: grantIdValue,
        operationId,
        sessionId,
        roomId,
        subjectHumanId,
        issuingDeviceId,
        recipientAgentId,
        recipientKeyId,
        authoritySetDigest,
        entryCount,
        entries,
      };
    });
    const canonical = serializeNamespaceAgentGrantSecretV1(secret);
    const matches = equalBytes(canonical, bytes);
    canonical.fill(0);
    if (!matches) {
      destroyNamespaceAgentGrantSecretV1(secret);
      return null;
    }
    return secret;
  } catch {
    if (secret !== null) destroyNamespaceAgentGrantSecretV1(secret);
    return null;
  }
}

export function destroyNamespaceAgentGrantSecretV1(
  secret: NamespaceAgentGrantSecretV1,
): void {
  secret.authoritySetDigest.fill(0);
  secret.entries.forEach((entry) => {
    entry.generationKey.fill(0);
    entry.audienceFingerprint.fill(0);
    entry.headDigest.fill(0);
  });
}

function validateGrantStructure(grant: Omit<NamespaceAgentGrantV1, "signature">): void {
  if (
    grant.formatVersion !== NAMESPACE_AGENT_GRANT_V1_FORMAT_VERSION
    || grant.purpose !== NAMESPACE_AGENT_GRANT_V1_PURPOSE
    || grant.scheme !== NAMESPACE_AGENT_GRANT_V1_SCHEME
  ) throw new TypeError("Namespace Agent Grant version is unsupported");
  grantId(grant.id);
  if (
    !(grant.planBytes instanceof Uint8Array)
    || grant.planBytes.length < 1
    || grant.planBytes.length > NAMESPACE_AGENT_GRANT_V1_MAX_WIRE_BYTES
  ) throw new RangeError("Namespace Agent Grant plan bytes are invalid");
  exactBytes("Namespace Agent Grant plan digest", grant.planDigest, DIGEST_BYTES);
  if (
    !Number.isSafeInteger(grant.secretEntryCount)
    || grant.secretEntryCount < 1
    || grant.secretEntryCount > NAMESPACE_AGENT_GRANT_V1_MAX_SECRET_ENTRIES
  ) throw new RangeError("Namespace Agent Grant secret count is invalid");
  exactBytes("Namespace Agent Grant secret digest", grant.secretDigest, DIGEST_BYTES);
  if (
    !(grant.encryptedSecret instanceof Uint8Array)
    || grant.encryptedSecret.length < 1
    || grant.encryptedSecret.length > NAMESPACE_AGENT_GRANT_V1_MAX_SECRET_BYTES
      + 256
  ) throw new RangeError("Namespace Agent Grant ciphertext is invalid");
  exactBytes(
    "Namespace Agent Grant ciphertext digest",
    grant.encryptedSecretDigest,
    DIGEST_BYTES,
  );
}

export function namespaceAgentGrantSigningBytesV1(
  grant: Omit<NamespaceAgentGrantV1, "signature">,
): Uint8Array {
  validateGrantStructure(grant);
  return concatV2(
    frameText(GRANT_DOMAIN),
    encodeU32(grant.formatVersion),
    frameText(grant.purpose),
    frameText(grant.scheme),
    frameText(grant.id),
    frame(grant.planBytes),
    frame(grant.planDigest),
    encodeU32(grant.secretEntryCount),
    frame(grant.secretDigest),
    frame(grant.encryptedSecret),
    frame(grant.encryptedSecretDigest),
  );
}

export function serializeNamespaceAgentGrantV1(
  grant: NamespaceAgentGrantV1,
): Uint8Array {
  exactBytes(
    "Namespace Agent Grant signature",
    grant.signature,
    V2_LIMITS.signatureBytes,
  );
  const bytes = concatV2(
    namespaceAgentGrantSigningBytesV1(grant),
    frame(grant.signature),
  );
  if (bytes.length > NAMESPACE_AGENT_GRANT_V1_MAX_WIRE_BYTES) {
    bytes.fill(0);
    throw new RangeError("Namespace Agent Grant exceeds its wire bound");
  }
  return bytes;
}

export function parseNamespaceAgentGrantV1(
  bytes: Uint8Array,
): NamespaceAgentGrantV1 | null {
  if (
    !(bytes instanceof Uint8Array)
    || bytes.length < 1
    || bytes.length > NAMESPACE_AGENT_GRANT_V1_MAX_WIRE_BYTES
  ) return null;
  try {
    const grant = decodeExact(bytes, (reader): NamespaceAgentGrantV1 => {
      reader.readFrame(utf8V2(GRANT_DOMAIN).length);
      reader.readVersion(NAMESPACE_AGENT_GRANT_V1_FORMAT_VERSION);
      const purpose = reader.readText(
        V2_LIMITS.schemeIdBytes,
      ) as typeof NAMESPACE_AGENT_GRANT_V1_PURPOSE;
      const scheme = reader.readText(
        V2_LIMITS.schemeIdBytes,
      ) as typeof NAMESPACE_AGENT_GRANT_V1_SCHEME;
      const id = grantId(reader.readText(V2_LIMITS.idBytes));
      const planBytes = reader.readFrame(NAMESPACE_AGENT_GRANT_V1_MAX_WIRE_BYTES);
      const planDigest = reader.readFrame(DIGEST_BYTES);
      const secretEntryCount = reader.readCount(
        NAMESPACE_AGENT_GRANT_V1_MAX_SECRET_ENTRIES,
      );
      const secretDigest = reader.readFrame(DIGEST_BYTES);
      const encryptedSecret = reader.readFrame(
        NAMESPACE_AGENT_GRANT_V1_MAX_SECRET_BYTES + 256,
      );
      const encryptedSecretDigest = reader.readFrame(DIGEST_BYTES);
      const signature = reader.readFrame(V2_LIMITS.signatureBytes);
      return {
        formatVersion: NAMESPACE_AGENT_GRANT_V1_FORMAT_VERSION,
        purpose,
        scheme,
        id,
        planBytes,
        planDigest,
        secretEntryCount,
        secretDigest,
        encryptedSecret,
        encryptedSecretDigest,
        signature,
      };
    });
    const canonical = serializeNamespaceAgentGrantV1(grant);
    const matches = equalBytes(canonical, bytes);
    canonical.fill(0);
    if (!matches) {
      destroyNamespaceAgentGrantV1(grant);
      return null;
    }
    return grant;
  } catch {
    return null;
  }
}

export function destroyNamespaceAgentGrantV1(grant: NamespaceAgentGrantV1): void {
  grant.planBytes.fill(0);
  grant.planDigest.fill(0);
  grant.secretDigest.fill(0);
  grant.encryptedSecret.fill(0);
  grant.encryptedSecretDigest.fill(0);
  grant.signature.fill(0);
}

function planDigestMatches(
  crypto: Pick<LatticeCrypto, "hash">,
  plan: NamespaceAgentGrantPlanV1,
): boolean {
  const actual = namespaceAgentGrantAuthoritySetDigestV1(crypto, plan.authority);
  try {
    return equalBytes(actual, plan.authoritySetDigest);
  } finally {
    actual.fill(0);
  }
}

function secretMatchesPlan(
  secret: NamespaceAgentGrantSecretV1,
  plan: NamespaceAgentGrantPlanV1,
  grantIdValue: GrantId,
): boolean {
  if (
    secret.grantId !== grantIdValue
    || secret.operationId !== plan.operationId
    || secret.sessionId !== plan.sessionId
    || secret.roomId !== plan.roomId
    || secret.subjectHumanId !== plan.subjectHumanId
    || secret.issuingDeviceId !== plan.issuingDeviceId
    || secret.recipientAgentId !== plan.recipientAgentId
    || secret.recipientKeyId !== plan.recipientKeyId
    || secret.entryCount !== plan.secretEntryCount
    || !equalBytes(secret.authoritySetDigest, plan.authoritySetDigest)
  ) return false;
  let secretIndex = 0;
  for (const authority of plan.authority) {
    for (const retained of authority.retainedGenerations) {
      const entry = secret.entries[secretIndex++];
      if (
        entry === undefined
        || entry.namespaceId !== authority.namespaceId
        || entry.keyClass !== "ai"
        || entry.accessRevision !== retained.accessRevision
        || entry.generation !== retained.generation
        || !equalBytes(
          entry.audienceFingerprint,
          retained.audienceFingerprint,
        )
        || !equalBytes(entry.headDigest, retained.headDigest)
      ) return false;
    }
  }
  return secretIndex === secret.entries.length;
}

function authorityMatchesCurrent(
  plan: NamespaceAgentGrantPlanV1,
  current: NamespaceAgentGrantCurrentAuthorityV1,
): boolean {
  if (
    plan.operationId !== current.operationId
    || plan.policyRevision !== current.policyRevision
    || plan.sessionId !== current.sessionId
    || plan.roomId !== current.roomId
    || plan.subjectHumanId !== current.subjectHumanId
    || plan.issuingDeviceId !== current.issuingDeviceId
    || plan.issuingDeviceSigningKeyGeneration
      !== current.issuingDeviceSigningKeyGeneration
    || plan.hostAuthorizationRevision !== current.hostAuthorizationRevision
    || plan.recipientAgentId !== current.recipientAgentId
    || plan.recipientKeyId !== current.recipientKeyId
    || plan.authority.length !== current.authority.length
  ) return false;
  for (const [index, expected] of plan.authority.entries()) {
    const actual = current.authority[index];
    if (actual === undefined) return false;
    const expectedBytes = authorityEntryBytes(expected);
    const actualBytes = authorityEntryBytes(actual);
    try {
      if (!equalBytes(expectedBytes, actualBytes)) return false;
    } finally {
      expectedBytes.fill(0);
      actualBytes.fill(0);
    }
  }
  return true;
}

export async function mintNamespaceAgentGrantV1(
  crypto: LatticeCrypto,
  input: Readonly<{
    grantId: GrantId;
    plan: NamespaceAgentGrantPlanV1;
    entries: readonly NamespaceAgentGrantSecretEntryV1[];
    issuingDeviceSigningPrivateKey: Uint8Array;
    recipientEncryptionPublicKey: Uint8Array;
  }>,
): Promise<NamespaceAgentGrantV1> {
  grantId(input.grantId);
  validatePlanStructure(input.plan);
  if (!planDigestMatches(crypto, input.plan)) {
    throw new TypeError("Namespace Agent Grant plan authority digest disagrees");
  }
  validateSecretEntries(input.entries);
  exactBytes(
    "Namespace Agent Grant signing private key",
    input.issuingDeviceSigningPrivateKey,
    V2_LIMITS.signingPrivateKeyBytes,
  );
  exactBytes(
    "Namespace Agent Grant recipient public key",
    input.recipientEncryptionPublicKey,
    V2_LIMITS.hpkePublicKeyBytes,
  );
  const signingPrivateKey = copyOwnedBytesV2(
    input.issuingDeviceSigningPrivateKey,
  );
  const planBytes = serializeNamespaceAgentGrantPlanV1(input.plan);
  const secret: NamespaceAgentGrantSecretV1 = {
    formatVersion: NAMESPACE_AGENT_GRANT_V1_FORMAT_VERSION,
    purpose: NAMESPACE_AGENT_GRANT_V1_SECRET_PURPOSE,
    grantId: input.grantId,
    operationId: input.plan.operationId,
    sessionId: input.plan.sessionId,
    roomId: input.plan.roomId,
    subjectHumanId: input.plan.subjectHumanId,
    issuingDeviceId: input.plan.issuingDeviceId,
    recipientAgentId: input.plan.recipientAgentId,
    recipientKeyId: input.plan.recipientKeyId,
    authoritySetDigest: input.plan.authoritySetDigest,
    entryCount: input.entries.length,
    entries: input.entries,
  };
  if (!secretMatchesPlan(secret, input.plan, input.grantId)) {
    signingPrivateKey.fill(0);
    planBytes.fill(0);
    throw new TypeError(
      "Namespace Agent Grant secret is not the exact planned generation set",
    );
  }
  let secretBytes: Uint8Array | undefined;
  let encryptedSecret: Uint8Array | undefined;
  let signingBytes: Uint8Array | undefined;
  let planDigest: Uint8Array | undefined;
  let secretDigest: Uint8Array | undefined;
  let encryptedSecretDigest: Uint8Array | undefined;
  let signature: Uint8Array | undefined;
  try {
    secretBytes = serializeNamespaceAgentGrantSecretV1(secret);
    if (secretBytes.length > input.plan.maximumSecretBytes) {
      throw new RangeError("Namespace Agent Grant secret exceeds its plan bound");
    }
    encryptedSecret = await crypto.sealTo(
      input.recipientEncryptionPublicKey,
      secretBytes,
    );
    planDigest = crypto.hash(planBytes);
    secretDigest = crypto.hash(secretBytes);
    encryptedSecretDigest = crypto.hash(encryptedSecret);
    const unsigned = Object.freeze({
      formatVersion: NAMESPACE_AGENT_GRANT_V1_FORMAT_VERSION,
      purpose: NAMESPACE_AGENT_GRANT_V1_PURPOSE,
      scheme: NAMESPACE_AGENT_GRANT_V1_SCHEME,
      id: input.grantId,
      planBytes,
      planDigest,
      secretEntryCount: input.entries.length,
      secretDigest,
      encryptedSecret,
      encryptedSecretDigest,
    });
    signingBytes = namespaceAgentGrantSigningBytesV1(unsigned);
    signature = crypto.sign(signingPrivateKey, signingBytes);
    return Object.freeze({
      ...unsigned,
      planBytes: planBytes.slice(),
      planDigest: unsigned.planDigest.slice(),
      secretDigest: unsigned.secretDigest.slice(),
      encryptedSecret: encryptedSecret.slice(),
      encryptedSecretDigest: unsigned.encryptedSecretDigest.slice(),
      signature: signature.slice(),
    });
  } finally {
    signingPrivateKey.fill(0);
    planBytes.fill(0);
    secretBytes?.fill(0);
    encryptedSecret?.fill(0);
    signingBytes?.fill(0);
    planDigest?.fill(0);
    secretDigest?.fill(0);
    encryptedSecretDigest?.fill(0);
    signature?.fill(0);
  }
}

function unavailable<Value>(
  reason: Extract<OpenNamespaceAgentGrantResultV1<Value>, {
    status: "unavailable";
  }>["reason"],
): OpenNamespaceAgentGrantResultV1<Value> {
  return Object.freeze({ status: "unavailable", reason });
}

export async function withOpenedNamespaceAgentGrantV1<Value>(
  crypto: LatticeCrypto,
  input: Readonly<{
    grantBytes: Uint8Array;
    now: number;
    current: NamespaceAgentGrantCurrentAuthorityV1;
    operation(entries: readonly NamespaceAgentGrantSecretEntryV1[]):
      Value | PromiseLike<Value>;
  }>,
): Promise<OpenNamespaceAgentGrantResultV1<Value>> {
  const grant = parseNamespaceAgentGrantV1(input.grantBytes);
  if (grant === null) return unavailable("invalid");
  let plan: NamespaceAgentGrantPlanV1 | null = null;
  let secretBytes: Uint8Array | null = null;
  let secret: NamespaceAgentGrantSecretV1 | null = null;
  let signingBytes: Uint8Array | undefined;
  let operationStarted = false;
  try {
    plan = parseNamespaceAgentGrantPlanV1(grant.planBytes);
    if (plan === null) return unavailable("invalid");
    const actualPlanDigest = crypto.hash(grant.planBytes);
    const actualCiphertextDigest = crypto.hash(grant.encryptedSecret);
    const publicDigestsMatch = equalBytes(actualPlanDigest, grant.planDigest)
      && equalBytes(actualCiphertextDigest, grant.encryptedSecretDigest)
      && grant.secretEntryCount === plan.secretEntryCount
      && planDigestMatches(crypto, plan);
    actualPlanDigest.fill(0);
    actualCiphertextDigest.fill(0);
    if (!publicDigestsMatch) return unavailable("invalid");
    if (!Number.isSafeInteger(input.now) || input.now < plan.issuedAt) {
      return unavailable("invalid");
    }
    if (input.now >= plan.deadlineAt) return unavailable("expired");
    if (
      !input.current.issuingDeviceActive
      || !input.current.agentAuthorized
      || !authorityMatchesCurrent(plan, input.current)
    ) return unavailable("authority_stale");
    if (
      !input.current.hostAllowsOperation
      || !plan.operations.includes(input.current.operation)
    ) return unavailable("operation_denied");
    exactBytes(
      "Namespace Agent Grant signing public key",
      input.current.issuingDeviceSigningPublicKey,
      V2_LIMITS.signingPublicKeyBytes,
    );
    exactBytes(
      "Namespace Agent Grant recipient private key",
      input.current.recipientEncryptionPrivateKey,
      V2_LIMITS.hpkePrivateKeyBytes,
    );
    signingBytes = namespaceAgentGrantSigningBytesV1(grant);
    if (!crypto.verify(
      input.current.issuingDeviceSigningPublicKey,
      signingBytes,
      grant.signature,
    )) return unavailable("invalid");
    secretBytes = await crypto.openSealed(
      input.current.recipientEncryptionPrivateKey,
      grant.encryptedSecret,
    );
    if (secretBytes === null) return unavailable("secret_unavailable");
    const actualSecretDigest = crypto.hash(secretBytes);
    const secretDigestMatches = equalBytes(actualSecretDigest, grant.secretDigest);
    actualSecretDigest.fill(0);
    if (!secretDigestMatches) return unavailable("invalid");
    secret = parseNamespaceAgentGrantSecretV1(secretBytes);
    if (
      secret === null
      || !secretMatchesPlan(secret, plan, grant.id)
      || secret.entryCount !== grant.secretEntryCount
    ) return unavailable("invalid");
    operationStarted = true;
    const value = await input.operation(secret.entries);
    operationStarted = false;
    return Object.freeze({
      status: "opened" as const,
      value,
    });
  } catch (error) {
    if (operationStarted) throw error;
    return unavailable("invalid");
  } finally {
    signingBytes?.fill(0);
    secretBytes?.fill(0);
    if (secret !== null) destroyNamespaceAgentGrantSecretV1(secret);
    if (plan !== null) destroyNamespaceAgentGrantPlanV1(plan);
    destroyNamespaceAgentGrantV1(grant);
  }
}
