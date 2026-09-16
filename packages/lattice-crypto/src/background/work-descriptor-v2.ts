import type { LatticeCrypto } from "../crypto/index.ts";
import {MAX_ENCRYPTED_PAYLOAD_WIRE_BYTES_V2, MAX_NAMESPACE_OBJECT_ENVELOPE_WIRE_BYTES_V2} from "../format/object-v2.ts";
import {
  canonicalizeParticipants,
  compareUnsignedUtf8,
} from "../domain/participants.ts";
import {
  CanonicalDecodingError,
  concatV2,
  decodeExact,
  encodeU32,
  encodeU64,
  frame,
  frameText,
  utf8V2,
  StrictDecoder,
} from "../format/v2-primitives.ts";
import {
  accessRevision,
  agentId,
  agentRuntimeGeneration,
  assertPortableId,
  assertU64Counter,
  authorizationRevision,
  cryptoDomainId,
  domainEpoch,
  humanId,
  namespaceId,
  objectId,
  unixTimestamp,
  type AccessRevision,
  type AgentId,
  type AgentRuntimeGeneration,
  type AuthorizationRevision,
  type CryptoDomainId,
  type DomainEpoch,
  type HumanId,
  type NamespaceId,
  type ObjectId,
  type UnixTimestamp,
} from "../v2-types/ids.ts";
import { V2_LIMITS, assertV2Range } from "../v2-types/limits.ts";
import { copyOwnedBytesV2 } from "../v2-types/opaque.ts";

export const BACKGROUND_WORK_DESCRIPTOR_FORMAT_VERSION_V2 = 2 as const;
export const BACKGROUND_WORK_DESCRIPTOR_DOMAIN_V2 =
  "nautilo/lattice-crypto/background-work-descriptor/v2";
export const MAX_BACKGROUND_WORK_DESCRIPTOR_WIRE_BYTES_V2 = 128 * 1024;
export const MAX_BACKGROUND_AUTHORITY_BINDING_EDGES_V2 =
  V2_LIMITS.bindingsPerBatch;

const HASH_BYTES = 32;
const ENUM_BYTES = 64;

export type BackgroundWorkKindV2 =
  | "memory.review"
  | "memory.exit_flush"
  | "task.dispatch"
  | "task.execute"
  | "task.approval_resume";

export type BackgroundWorkPurposeV2 = BackgroundWorkKindV2;
export type BackgroundWorkOperationV2 = "decrypt" | "encrypt";

export interface BackgroundAgentSubjectV2 {
  readonly kind: "agent";
  readonly agentId: AgentId;
  readonly runtimeGeneration: AgentRuntimeGeneration;
  /** Global Agent Runtime-state authorization revision. */
  readonly authorizationRevision: AuthorizationRevision;
}

export interface BackgroundSyntheticPayloadSourceV2 {
  readonly kind: "synthetic_payload";
  readonly generation: number;
  readonly fingerprint: Uint8Array;
}

export interface BackgroundProtectedMessageInputRevisionV2 {
  readonly productKind: "message";
  readonly productId: string;
  readonly productRevision: number;
  readonly objectId: ObjectId;
}

export type BackgroundProtectedMemoryAccessKindV2 =
  | "namespace"
  | "scope_seed"
  | "scope_origin";

export interface BackgroundProtectedMemoryProductInputRevisionV2 {
  readonly productKind: "memory";
  readonly productId: string;
  readonly productRevision: number;
  readonly cryptoAccessRevision: number;
  readonly accessKind: BackgroundProtectedMemoryAccessKindV2;
  readonly objectId: ObjectId;
}

export type BackgroundProtectedMemoryInputRevisionV2 =
  | BackgroundProtectedMessageInputRevisionV2
  | BackgroundProtectedMemoryProductInputRevisionV2;

export type BackgroundProtectedMemoryProductAuthorityV2 =
  | { readonly mode: "namespace" }
  | {
    readonly mode: "scope";
    readonly scopeId: string;
    readonly originWritableNamespaceId: NamespaceId;
  };

export interface BackgroundProtectedMemoryOutputRevisionV2 {
  readonly action: "create" | "replace";
  readonly memoryId: string;
  readonly expectedContentRevision: number;
  readonly expectedCryptoAccessRevision: number;
  readonly nextContentRevision: number;
  readonly objectId: ObjectId;
  readonly publicationIdempotencyId: string;
}

export interface BackgroundProtectedMemoryTierMutationV2 {
  readonly operationIdempotencyId: string;
  readonly memoryId: string;
  readonly contentRevision: number;
  readonly cryptoAccessRevision: number;
  readonly objectId: ObjectId;
  readonly action: "promote" | "demote";
  readonly expectedTier: 1 | 2;
  readonly nextTier: 1 | 2 | 3;
  readonly requiredNamespaceIds: readonly NamespaceId[];
}

export interface BackgroundProtectedMemoryWorkSourceV2 {
  readonly kind: "protected_memory_work";
  readonly sourceVersion: 1;
  readonly productAuthority: BackgroundProtectedMemoryProductAuthorityV2;
  readonly inputRevisions:
    readonly BackgroundProtectedMemoryInputRevisionV2[];
  readonly outputRevisions:
    readonly BackgroundProtectedMemoryOutputRevisionV2[];
  readonly tierMutations:
    readonly BackgroundProtectedMemoryTierMutationV2[];
}

export type BackgroundWorkSourceV2 =
  | BackgroundSyntheticPayloadSourceV2
  | BackgroundProtectedMemoryWorkSourceV2;

export interface BackgroundInputObjectBindingV2 {
  readonly objectId: ObjectId;
  /** Exact Namespace coordinate through which this object may be opened. */
  readonly namespaceId: NamespaceId;
}

export interface BackgroundOutputObjectSlotV2 {
  readonly objectId: ObjectId;
  readonly objectType: string;
  readonly createdAt: UnixTimestamp;
  /** Complete exact Namespace publication set for this output slot. */
  readonly namespaceIds: readonly NamespaceId[];
}

export interface BackgroundNamespaceRequirementV2 {
  readonly namespaceId: NamespaceId;
  readonly domainId: CryptoDomainId;
  readonly operations: readonly BackgroundWorkOperationV2[];
  readonly expectedAccessRevision: AccessRevision;
  readonly expectedPolicyRevision: AuthorizationRevision;
}

export interface BackgroundDomainRequirementV2 {
  readonly domainId: CryptoDomainId;
  readonly expectedEpoch: DomainEpoch;
  readonly expectedAgentAuthorizationRevision: AuthorizationRevision;
}

export interface BackgroundAgentWorkDescriptorV2 {
  readonly formatVersion:
    typeof BACKGROUND_WORK_DESCRIPTOR_FORMAT_VERSION_V2;
  readonly requestId: string;
  readonly recipientGeneration: number;
  readonly workKind: BackgroundWorkKindV2;
  readonly workId: string;
  /** Routing metadata only; must name one exact requirement. */
  readonly anchorNamespaceId: NamespaceId;
  /** Routing metadata only; must match the anchor Namespace requirement. */
  readonly anchorDomainId: CryptoDomainId;
  readonly subject: BackgroundAgentSubjectV2;
  readonly purpose: BackgroundWorkPurposeV2;
  readonly operations: readonly BackgroundWorkOperationV2[];
  readonly source: BackgroundWorkSourceV2;
  readonly grantScope: readonly HumanId[];
  readonly inputBindings: readonly BackgroundInputObjectBindingV2[];
  readonly outputSlots: readonly BackgroundOutputObjectSlotV2[];
  readonly namespaceRequirements:
    readonly BackgroundNamespaceRequirementV2[];
  readonly domainRequirements: readonly BackgroundDomainRequirementV2[];
  readonly maximumInputObjectCount: number;
  readonly maximumOutputObjectCount: number;
  readonly maximumPlaintextBytes: number;
  readonly maximumCiphertextBytes: number;
  readonly recipientKeyId: string;
  readonly recipientPublicKey: Uint8Array;
  readonly issuedAt: number;
  readonly notBefore: number;
  readonly expiresAt: number;
  readonly idempotencyId: string;
}

const DESCRIPTOR_FIELDS = Object.freeze([
  "formatVersion",
  "requestId",
  "recipientGeneration",
  "workKind",
  "workId",
  "anchorNamespaceId",
  "anchorDomainId",
  "subject",
  "purpose",
  "operations",
  "source",
  "grantScope",
  "inputBindings",
  "outputSlots",
  "namespaceRequirements",
  "domainRequirements",
  "maximumInputObjectCount",
  "maximumOutputObjectCount",
  "maximumPlaintextBytes",
  "maximumCiphertextBytes",
  "recipientKeyId",
  "recipientPublicKey",
  "issuedAt",
  "notBefore",
  "expiresAt",
  "idempotencyId",
] as const);

const SUBJECT_FIELDS = Object.freeze([
  "kind",
  "agentId",
  "runtimeGeneration",
  "authorizationRevision",
] as const);
const SOURCE_FIELDS = Object.freeze([
  "kind",
  "generation",
  "fingerprint",
] as const);
const PROTECTED_MEMORY_SOURCE_FIELDS = Object.freeze([
  "kind",
  "sourceVersion",
  "productAuthority",
  "inputRevisions",
  "outputRevisions",
  "tierMutations",
] as const);
const PROTECTED_MESSAGE_INPUT_FIELDS = Object.freeze([
  "productKind",
  "productId",
  "productRevision",
  "objectId",
] as const);
const PROTECTED_MEMORY_INPUT_FIELDS = Object.freeze([
  ...PROTECTED_MESSAGE_INPUT_FIELDS,
  "cryptoAccessRevision",
  "accessKind",
] as const);
const PROTECTED_MEMORY_NAMESPACE_AUTHORITY_FIELDS = Object.freeze([
  "mode",
] as const);
const PROTECTED_MEMORY_SCOPE_AUTHORITY_FIELDS = Object.freeze([
  "mode",
  "scopeId",
  "originWritableNamespaceId",
] as const);
const PROTECTED_MEMORY_OUTPUT_FIELDS = Object.freeze([
  "action",
  "memoryId",
  "expectedContentRevision",
  "expectedCryptoAccessRevision",
  "nextContentRevision",
  "objectId",
  "publicationIdempotencyId",
] as const);
const PROTECTED_MEMORY_TIER_MUTATION_FIELDS = Object.freeze([
  "operationIdempotencyId",
  "memoryId",
  "contentRevision",
  "cryptoAccessRevision",
  "objectId",
  "action",
  "expectedTier",
  "nextTier",
  "requiredNamespaceIds",
] as const);
const INPUT_BINDING_FIELDS = Object.freeze([
  "objectId",
  "namespaceId",
] as const);
const OUTPUT_SLOT_FIELDS = Object.freeze([
  "objectId",
  "objectType",
  "createdAt",
  "namespaceIds",
] as const);
const NAMESPACE_REQUIREMENT_FIELDS = Object.freeze([
  "namespaceId",
  "domainId",
  "operations",
  "expectedAccessRevision",
  "expectedPolicyRevision",
] as const);
const DOMAIN_REQUIREMENT_FIELDS = Object.freeze([
  "domainId",
  "expectedEpoch",
  "expectedAgentAuthorizationRevision",
] as const);

const WORK_KINDS = new Set<BackgroundWorkKindV2>([
  "memory.review",
  "memory.exit_flush",
  "task.dispatch",
  "task.execute",
  "task.approval_resume",
]);

function assertObject(
  label: string,
  value: unknown,
): asserts value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
}

function assertExactFields(
  label: string,
  value: Record<string, unknown>,
  expected: readonly string[],
): void {
  const actual = Object.keys(value).sort(compareUnsignedUtf8);
  const canonical = [...expected].sort(compareUnsignedUtf8);
  if (
    actual.length !== canonical.length
    || actual.some((field, index) => field !== canonical[index])
  ) {
    throw new TypeError(`${label} has an invalid field set`);
  }
}

function exactBytes(
  label: string,
  value: unknown,
  length: number,
): Uint8Array {
  if (!(value instanceof Uint8Array) || value.length !== length) {
    throw new TypeError(`${label} must be exactly ${length} bytes`);
  }
  return copyOwnedBytesV2(value);
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left[index]! ^ right[index]!;
  }
  return difference === 0;
}

function equalStrings(
  left: readonly string[],
  right: readonly string[],
): boolean {
  return left.length === right.length
    && left.every((value, index) => value === right[index]);
}

function canonicalStringSet<T extends string>(
  label: string,
  values: readonly T[],
): readonly T[] {
  const canonical = [...new Set(values)].sort(compareUnsignedUtf8);
  if (!equalStrings(canonical, values)) {
    throw new TypeError(`${label} must be canonical and unique`);
  }
  return Object.freeze(canonical);
}

function normalizeWorkKind(value: unknown): BackgroundWorkKindV2 {
  if (typeof value !== "string" || !WORK_KINDS.has(value as never)) {
    throw new TypeError("Background work kind is unsupported");
  }
  return value as BackgroundWorkKindV2;
}

function normalizeOperations(
  label: string,
  value: unknown,
): readonly BackgroundWorkOperationV2[] {
  if (!Array.isArray(value)) {
    throw new TypeError(`${label} must be an array`);
  }
  assertV2Range(label, value.length, 1, 2);
  const operations = (value as readonly unknown[]).map((operation) => {
    if (operation !== "decrypt" && operation !== "encrypt") {
      throw new TypeError("Background work operation is unsupported");
    }
    return operation;
  });
  return canonicalStringSet(label, operations);
}

function normalizeSubject(value: unknown): BackgroundAgentSubjectV2 {
  assertObject("Background Agent subject", value);
  assertExactFields("Background Agent subject", value, SUBJECT_FIELDS);
  if (value["kind"] !== "agent") {
    throw new TypeError("Background v2 work requires an Agent subject");
  }
  return Object.freeze({
    kind: "agent",
    agentId: agentId(value["agentId"]),
    runtimeGeneration: agentRuntimeGeneration(value["runtimeGeneration"]),
    authorizationRevision: authorizationRevision(
      value["authorizationRevision"],
    ),
  });
}

function normalizeSource(
  value: unknown,
): BackgroundWorkSourceV2 {
  assertObject("Background source", value);
  if (value["kind"] === "synthetic_payload") {
    assertExactFields("Background synthetic source", value, SOURCE_FIELDS);
    assertU64Counter(
      "Background synthetic source generation",
      value["generation"],
    );
    return Object.freeze({
      kind: "synthetic_payload",
      generation: value["generation"],
      fingerprint: exactBytes(
        "Background synthetic source fingerprint",
        value["fingerprint"],
        HASH_BYTES,
      ),
    });
  }
  if (value["kind"] !== "protected_memory_work") {
    throw new TypeError("Background v2 work source is unsupported");
  }
  assertExactFields(
    "Background protected Memory source",
    value,
    PROTECTED_MEMORY_SOURCE_FIELDS,
  );
  if (value["sourceVersion"] !== 1) {
    throw new TypeError(
      "Background protected Memory source version is unsupported",
    );
  }
  assertObject(
    "Background protected Memory product authority",
    value["productAuthority"],
  );
  let productAuthority: BackgroundProtectedMemoryProductAuthorityV2;
  if (value["productAuthority"]["mode"] === "namespace") {
    assertExactFields(
      "Background protected Memory Namespace authority",
      value["productAuthority"],
      PROTECTED_MEMORY_NAMESPACE_AUTHORITY_FIELDS,
    );
    productAuthority = Object.freeze({ mode: "namespace" });
  } else if (value["productAuthority"]["mode"] === "scope") {
    assertExactFields(
      "Background protected Memory scope authority",
      value["productAuthority"],
      PROTECTED_MEMORY_SCOPE_AUTHORITY_FIELDS,
    );
    assertPortableId(
      "Background protected Memory scope id",
      value["productAuthority"]["scopeId"],
    );
    productAuthority = Object.freeze({
      mode: "scope",
      scopeId: value["productAuthority"]["scopeId"],
      originWritableNamespaceId: namespaceId(
        value["productAuthority"]["originWritableNamespaceId"],
      ),
    });
  } else {
    throw new TypeError(
      "Background protected Memory product authority is unsupported",
    );
  }
  if (!Array.isArray(value["inputRevisions"])) {
    throw new TypeError(
      "Background protected Memory input revisions must be an array",
    );
  }
  assertV2Range(
    "Background protected Memory input revisions",
    value["inputRevisions"].length,
    1,
    V2_LIMITS.batchItems,
  );
  const inputRevisions = value["inputRevisions"].map(
    (entry): BackgroundProtectedMemoryInputRevisionV2 => {
      assertObject("Background protected Memory input revision", entry);
      if (entry["productKind"] !== "memory"
        && entry["productKind"] !== "message") {
        throw new TypeError(
          "Background protected Memory input product kind is unsupported",
        );
      }
      assertExactFields(
        "Background protected Memory input revision",
        entry,
        entry["productKind"] === "memory"
          ? PROTECTED_MEMORY_INPUT_FIELDS
          : PROTECTED_MESSAGE_INPUT_FIELDS,
      );
      assertPortableId(
        "Background protected Memory input product id",
        entry["productId"],
      );
      assertU64Counter(
        "Background protected Memory input product revision",
        entry["productRevision"],
      );
      if (
        entry["productKind"] === "memory"
        && entry["productRevision"] < 1
      ) {
        throw new RangeError(
          "Background protected Memory input Memory revision must be positive",
        );
      }
      if (entry["productKind"] === "memory") {
        assertU64Counter(
          "Background protected Memory input crypto access revision",
          entry["cryptoAccessRevision"],
        );
        if (
          entry["accessKind"] !== "namespace"
          && entry["accessKind"] !== "scope_seed"
          && entry["accessKind"] !== "scope_origin"
        ) {
          throw new TypeError(
            "Background protected Memory input access kind is unsupported",
          );
        }
        if (
          (productAuthority.mode === "namespace"
            && entry["accessKind"] !== "namespace")
          || (productAuthority.mode === "scope"
            && entry["accessKind"] === "namespace")
        ) {
          throw new TypeError(
            "Background protected Memory input access kind must match product authority",
          );
        }
        return Object.freeze({
          productKind: "memory",
          productId: entry["productId"],
          productRevision: entry["productRevision"],
          cryptoAccessRevision: entry["cryptoAccessRevision"],
          accessKind: entry["accessKind"],
          objectId: objectId(entry["objectId"]),
        });
      }
      return Object.freeze({
        productKind: "message",
        productId: entry["productId"],
        productRevision: entry["productRevision"],
        objectId: objectId(entry["objectId"]),
      });
    },
  );
  canonicalStringSet(
    "Background protected Memory input revisions",
    inputRevisions.map((entry) => entry.objectId),
  );
  if (!Array.isArray(value["outputRevisions"])) {
    throw new TypeError(
      "Background protected Memory output revisions must be an array",
    );
  }
  assertV2Range(
    "Background protected Memory output revisions",
    value["outputRevisions"].length,
    0,
    V2_LIMITS.batchItems,
  );
  const outputRevisions = value["outputRevisions"].map(
    (entry): BackgroundProtectedMemoryOutputRevisionV2 => {
      assertObject("Background protected Memory output revision", entry);
      assertExactFields(
        "Background protected Memory output revision",
        entry,
        PROTECTED_MEMORY_OUTPUT_FIELDS,
      );
      assertPortableId(
        "Background protected Memory output Memory id",
        entry["memoryId"],
      );
      if (entry["action"] !== "create" && entry["action"] !== "replace") {
        throw new TypeError(
          "Background protected Memory output action is unsupported",
        );
      }
      assertU64Counter(
        "Background protected Memory expected content revision",
        entry["expectedContentRevision"],
      );
      assertU64Counter(
        "Background protected Memory expected crypto access revision",
        entry["expectedCryptoAccessRevision"],
      );
      assertU64Counter(
        "Background protected Memory next content revision",
        entry["nextContentRevision"],
      );
      if (
        entry["nextContentRevision"]
          !== entry["expectedContentRevision"] + 1
      ) {
        throw new RangeError(
          "Background protected Memory output revision must advance exactly once",
        );
      }
      assertPortableId(
        "Background protected Memory publication idempotency id",
        entry["publicationIdempotencyId"],
      );
      return Object.freeze({
        action: entry["action"],
        memoryId: entry["memoryId"],
        expectedContentRevision: entry["expectedContentRevision"],
        expectedCryptoAccessRevision:
          entry["expectedCryptoAccessRevision"],
        nextContentRevision: entry["nextContentRevision"],
        objectId: objectId(entry["objectId"]),
        publicationIdempotencyId: entry["publicationIdempotencyId"],
      });
    },
  );
  canonicalStringSet(
    "Background protected Memory output revisions",
    outputRevisions.map((entry) => entry.objectId),
  );
  canonicalStringSet(
    "Background protected Memory output Memory ids",
    [...outputRevisions.map((entry) => entry.memoryId)].sort(
      compareUnsignedUtf8,
    ),
  );
  if (!Array.isArray(value["tierMutations"])) {
    throw new TypeError(
      "Background protected Memory tier mutations must be an array",
    );
  }
  assertV2Range(
    "Background protected Memory tier mutations",
    value["tierMutations"].length,
    0,
    V2_LIMITS.batchItems,
  );
  assertV2Range(
    "Background protected Memory result actions",
    outputRevisions.length + value["tierMutations"].length,
    0,
    V2_LIMITS.batchItems,
  );
  let protectedAuthorityEdgeFloor = inputRevisions.length;
  for (const entry of value["tierMutations"]) {
    assertObject("Background protected Memory tier mutation", entry);
    if (!Array.isArray(entry["requiredNamespaceIds"])) {
      throw new TypeError(
        "Background protected Memory tier required Namespace ids must be an array",
      );
    }
    protectedAuthorityEdgeFloor += entry["requiredNamespaceIds"].length;
    assertV2Range(
      "Background authority binding edges",
      protectedAuthorityEdgeFloor,
      1,
      MAX_BACKGROUND_AUTHORITY_BINDING_EDGES_V2,
    );
  }
  const tierMutations = value["tierMutations"].map(
    (entry): BackgroundProtectedMemoryTierMutationV2 => {
      assertObject("Background protected Memory tier mutation", entry);
      assertExactFields(
        "Background protected Memory tier mutation",
        entry,
        PROTECTED_MEMORY_TIER_MUTATION_FIELDS,
      );
      assertPortableId(
        "Background protected Memory tier operation idempotency id",
        entry["operationIdempotencyId"],
      );
      assertPortableId(
        "Background protected Memory tier Memory id",
        entry["memoryId"],
      );
      assertU64Counter(
        "Background protected Memory tier content revision",
        entry["contentRevision"],
      );
      if (entry["contentRevision"] < 1) {
        throw new RangeError(
          "Background protected Memory tier content revision must be positive",
        );
      }
      assertU64Counter(
        "Background protected Memory tier crypto access revision",
        entry["cryptoAccessRevision"],
      );
      const isPromotion = entry["action"] === "promote"
        && entry["expectedTier"] === 2
        && entry["nextTier"] === 1;
      const isDemotion = entry["action"] === "demote"
        && ((entry["expectedTier"] === 1 && entry["nextTier"] === 2)
          || (entry["expectedTier"] === 2 && entry["nextTier"] === 3));
      if (!isPromotion && !isDemotion) {
        throw new TypeError(
          "Background protected Memory tier transition is not meaningful",
        );
      }
      const action = entry["action"] as "promote" | "demote";
      const expectedTier = entry["expectedTier"] as 1 | 2;
      const nextTier = entry["nextTier"] as 1 | 2 | 3;
      if (!Array.isArray(entry["requiredNamespaceIds"])) {
        throw new TypeError(
          "Background protected Memory tier required Namespace ids must be an array",
        );
      }
      assertV2Range(
        "Background protected Memory tier required Namespace ids",
        entry["requiredNamespaceIds"].length,
        1,
        V2_LIMITS.bindingsPerBatch,
      );
      const requiredNamespaceIds = entry["requiredNamespaceIds"].map(
        namespaceId,
      );
      canonicalStringSet(
        "Background protected Memory tier required Namespace ids",
        requiredNamespaceIds,
      );
      return Object.freeze({
        operationIdempotencyId: entry["operationIdempotencyId"],
        memoryId: entry["memoryId"],
        contentRevision: entry["contentRevision"],
        cryptoAccessRevision: entry["cryptoAccessRevision"],
        objectId: objectId(entry["objectId"]),
        action,
        expectedTier,
        nextTier,
        requiredNamespaceIds: Object.freeze(requiredNamespaceIds),
      });
    },
  );
  canonicalStringSet(
    "Background protected Memory tier mutations",
    tierMutations.map((entry) => entry.operationIdempotencyId),
  );
  canonicalStringSet(
    "Background protected Memory tier Memory ids",
    [...tierMutations.map((entry) => entry.memoryId)].sort(compareUnsignedUtf8),
  );
  canonicalStringSet(
    "Background protected Memory operation idempotency ids",
    [
      ...outputRevisions.map((entry) => entry.publicationIdempotencyId),
      ...tierMutations.map((entry) => entry.operationIdempotencyId),
    ].sort(compareUnsignedUtf8),
  );
  canonicalStringSet(
    "Background protected Memory result Memory ids",
    [
      ...outputRevisions.map((entry) => entry.memoryId),
      ...tierMutations.map((entry) => entry.memoryId),
    ].sort(compareUnsignedUtf8),
  );
  return Object.freeze({
    kind: "protected_memory_work",
    sourceVersion: 1,
    productAuthority,
    inputRevisions: Object.freeze(inputRevisions),
    outputRevisions: Object.freeze(outputRevisions),
    tierMutations: Object.freeze(tierMutations),
  });
}

function normalizeGrantScope(value: unknown): readonly HumanId[] {
  if (!Array.isArray(value)) {
    throw new TypeError("Background grant scope must be an array");
  }
  assertV2Range(
    "Background grant scope",
    value.length,
    1,
    V2_LIMITS.grantScopeHumans,
  );
  const scope = value.map(humanId);
  const canonical = canonicalizeParticipants(scope);
  if (!equalStrings(canonical, scope)) {
    throw new TypeError("Background grant scope must be canonical and unique");
  }
  return Object.freeze([...canonical]);
}

function normalizeInputBindings(
  value: unknown,
): readonly BackgroundInputObjectBindingV2[] {
  if (!Array.isArray(value)) {
    throw new TypeError("Background input bindings must be an array");
  }
  assertV2Range(
    "Background input bindings",
    value.length,
    1,
    V2_LIMITS.batchItems,
  );
  const normalized = value.map((entry): BackgroundInputObjectBindingV2 => {
    assertObject("Background input binding", entry);
    assertExactFields(
      "Background input binding",
      entry,
      INPUT_BINDING_FIELDS,
    );
    return Object.freeze({
      objectId: objectId(entry["objectId"]),
      namespaceId: namespaceId(entry["namespaceId"]),
    });
  });
  const ids = normalized.map((entry) => entry.objectId);
  canonicalStringSet("Background input bindings", ids);
  return Object.freeze(normalized);
}

function normalizeOutputSlots(
  value: unknown,
  inputBindingCount: number,
): readonly BackgroundOutputObjectSlotV2[] {
  if (!Array.isArray(value)) {
    throw new TypeError("Background output slots must be an array");
  }
  assertV2Range(
    "Background output slots",
    value.length,
    0,
    V2_LIMITS.batchItems,
  );
  let bindingEdgeCount = inputBindingCount;
  for (const entry of value) {
    assertObject("Background output slot", entry);
    if (!Array.isArray(entry["namespaceIds"])) {
      throw new TypeError(
        "Background output slot Namespace ids must be an array",
      );
    }
    bindingEdgeCount += entry["namespaceIds"].length;
    assertV2Range(
      "Background authority binding edges",
      bindingEdgeCount,
      1,
      MAX_BACKGROUND_AUTHORITY_BINDING_EDGES_V2,
    );
  }
  const normalized = value.map((entry): BackgroundOutputObjectSlotV2 => {
    assertObject("Background output slot", entry);
    assertExactFields("Background output slot", entry, OUTPUT_SLOT_FIELDS);
    assertPortableId("Background output object type", entry["objectType"]);
    if (!Array.isArray(entry["namespaceIds"])) {
      throw new TypeError(
        "Background output slot Namespace ids must be an array",
      );
    }
    assertV2Range(
      "Background output slot Namespace ids",
      entry["namespaceIds"].length,
      1,
      V2_LIMITS.bindingsPerBatch,
    );
    const namespaceIds = entry["namespaceIds"].map(namespaceId);
    canonicalStringSet(
      "Background output slot Namespace ids",
      namespaceIds,
    );
    return Object.freeze({
      objectId: objectId(entry["objectId"]),
      objectType: entry["objectType"],
      createdAt: unixTimestamp(entry["createdAt"]),
      namespaceIds: Object.freeze(namespaceIds),
    });
  });
  canonicalStringSet(
    "Background output slots",
    normalized.map((entry) => entry.objectId),
  );
  return Object.freeze(normalized);
}

function normalizeNamespaceRequirements(
  value: unknown,
): readonly BackgroundNamespaceRequirementV2[] {
  if (!Array.isArray(value)) {
    throw new TypeError("Background Namespace requirements must be an array");
  }
  assertV2Range(
    "Background Namespace requirements",
    value.length,
    1,
    V2_LIMITS.bindingsPerBatch,
  );
  const normalized = value.map((entry): BackgroundNamespaceRequirementV2 => {
    assertObject("Background Namespace requirement", entry);
    assertExactFields(
      "Background Namespace requirement",
      entry,
      NAMESPACE_REQUIREMENT_FIELDS,
    );
    return Object.freeze({
      namespaceId: namespaceId(entry["namespaceId"]),
      domainId: cryptoDomainId(entry["domainId"]),
      operations: normalizeOperations(
        "Background Namespace required operations",
        entry["operations"],
      ),
      expectedAccessRevision: accessRevision(
        entry["expectedAccessRevision"],
      ),
      expectedPolicyRevision: authorizationRevision(
        entry["expectedPolicyRevision"],
      ),
    });
  });
  canonicalStringSet(
    "Background Namespace requirements",
    normalized.map((entry) => entry.namespaceId),
  );
  return Object.freeze(normalized);
}

function normalizeDomainRequirements(
  value: unknown,
): readonly BackgroundDomainRequirementV2[] {
  if (!Array.isArray(value)) {
    throw new TypeError("Background Domain requirements must be an array");
  }
  assertV2Range(
    "Background Domain requirements",
    value.length,
    1,
    V2_LIMITS.distinctDomainsPerGrant,
  );
  const normalized = value.map((entry): BackgroundDomainRequirementV2 => {
    assertObject("Background Domain requirement", entry);
    assertExactFields(
      "Background Domain requirement",
      entry,
      DOMAIN_REQUIREMENT_FIELDS,
    );
    return Object.freeze({
      domainId: cryptoDomainId(entry["domainId"]),
      expectedEpoch: domainEpoch(entry["expectedEpoch"]),
      expectedAgentAuthorizationRevision: authorizationRevision(
        entry["expectedAgentAuthorizationRevision"],
      ),
    });
  });
  canonicalStringSet(
    "Background Domain requirements",
    normalized.map((entry) => entry.domainId),
  );
  return Object.freeze(normalized);
}

function expectedOperationsForNamespace(
  namespaceIdValue: NamespaceId,
  inputBindings: readonly BackgroundInputObjectBindingV2[],
  outputSlots: readonly BackgroundOutputObjectSlotV2[],
  tierMutations: readonly BackgroundProtectedMemoryTierMutationV2[],
): readonly BackgroundWorkOperationV2[] {
  const operations: BackgroundWorkOperationV2[] = [];
  if (inputBindings.some((entry) => entry.namespaceId === namespaceIdValue)) {
    operations.push("decrypt");
  }
  if (
    outputSlots.some((entry) => entry.namespaceIds.includes(namespaceIdValue))
    || tierMutations.some((entry) =>
      entry.requiredNamespaceIds.includes(namespaceIdValue)
    )
  ) {
    operations.push("encrypt");
  }
  return Object.freeze(operations);
}

function assertExactAuthorityInventory(
  value: Readonly<{
    operations: readonly BackgroundWorkOperationV2[];
    inputBindings: readonly BackgroundInputObjectBindingV2[];
    outputSlots: readonly BackgroundOutputObjectSlotV2[];
    tierMutations: readonly BackgroundProtectedMemoryTierMutationV2[];
    namespaceRequirements: readonly BackgroundNamespaceRequirementV2[];
    domainRequirements: readonly BackgroundDomainRequirementV2[];
    anchorNamespaceId: NamespaceId;
    anchorDomainId: CryptoDomainId;
  }>,
): void {
  const edgeCount = value.inputBindings.length
    + value.outputSlots.reduce(
      (total, slot) => total + slot.namespaceIds.length,
      0,
    )
    + value.tierMutations.reduce(
      (total, mutation) => total + mutation.requiredNamespaceIds.length,
      0,
    );
  assertV2Range(
    "Background authority binding edges",
    edgeCount,
    1,
    MAX_BACKGROUND_AUTHORITY_BINDING_EDGES_V2,
  );

  const referencedNamespaceIds = canonicalStringSet(
    "Background referenced Namespace set",
    [...new Set([
      ...value.inputBindings.map((entry) => entry.namespaceId),
      ...value.outputSlots.flatMap((entry) => entry.namespaceIds),
      ...value.tierMutations.flatMap((entry) =>
        entry.requiredNamespaceIds
      ),
    ])].sort(compareUnsignedUtf8),
  );
  const requiredNamespaceIds = value.namespaceRequirements.map(
    (entry) => entry.namespaceId,
  );
  if (!equalStrings(referencedNamespaceIds, requiredNamespaceIds)) {
    throw new TypeError(
      "Background Namespace requirement set must equal the binding union",
    );
  }
  for (const requirement of value.namespaceRequirements) {
    const expected = expectedOperationsForNamespace(
      requirement.namespaceId,
      value.inputBindings,
      value.outputSlots,
      value.tierMutations,
    );
    if (!equalStrings(expected, requirement.operations)) {
      throw new TypeError(
        "Background Namespace required operations must equal bound use",
      );
    }
  }
  const requiredOperations = [...new Set(
    value.namespaceRequirements.flatMap((entry) => entry.operations),
  )].sort(compareUnsignedUtf8);
  if (!equalStrings(requiredOperations, value.operations)) {
    throw new TypeError(
      "Background descriptor operation set must equal Namespace requirements",
    );
  }

  const domainIds = [...new Set(
    value.namespaceRequirements.map((entry) => entry.domainId),
  )].sort(compareUnsignedUtf8);
  if (
    !equalStrings(
      domainIds,
      value.domainRequirements.map((entry) => entry.domainId),
    )
  ) {
    throw new TypeError(
      "Background Domain requirement set must equal Namespace Domains",
    );
  }
  const anchor = value.namespaceRequirements.find(
    (entry) => entry.namespaceId === value.anchorNamespaceId,
  );
  if (anchor === undefined || anchor.domainId !== value.anchorDomainId) {
    throw new TypeError(
      "Background routing anchor must match one Namespace requirement",
    );
  }
}

function assertProtectedMemorySourceInventory(
  workKind: BackgroundWorkKindV2,
  source: BackgroundWorkSourceV2,
  inputBindings: readonly BackgroundInputObjectBindingV2[],
  outputSlots: readonly BackgroundOutputObjectSlotV2[],
): void {
  if (source.kind === "synthetic_payload") return;
  if (workKind !== "memory.review" && workKind !== "memory.exit_flush") {
    throw new TypeError(
      "Background protected Memory source requires Memory work",
    );
  }
  if (
    source.inputRevisions.length !== inputBindings.length
    || source.inputRevisions.some((entry, index) =>
      entry.objectId !== inputBindings[index]!.objectId
    )
  ) {
    throw new TypeError(
      "Background protected Memory input revisions must equal input bindings",
    );
  }
  if (
    source.outputRevisions.length !== outputSlots.length
    || source.outputRevisions.some((entry, index) =>
      entry.objectId !== outputSlots[index]!.objectId
      || outputSlots[index]!.objectType !== "memory.revision"
    )
  ) {
    throw new TypeError(
      "Background protected Memory output revisions must equal Memory output slots",
    );
  }
  const memoryInputs = source.inputRevisions.filter(
    (entry): entry is BackgroundProtectedMemoryProductInputRevisionV2 =>
      entry.productKind === "memory",
  );
  if (source.productAuthority.mode === "scope") {
    for (const input of memoryInputs) {
      if (input.accessKind !== "scope_origin") continue;
      const binding = inputBindings.find(
        (entry) => entry.objectId === input.objectId,
      );
      if (
        binding?.namespaceId
          !== source.productAuthority.originWritableNamespaceId
      ) {
        throw new TypeError(
          "Background protected Memory scope-origin input must use the exact origin Namespace",
        );
      }
    }
  }
  for (const [index, output] of source.outputRevisions.entries()) {
    const matchingInput = memoryInputs.find(
      (entry) => entry.productId === output.memoryId,
    );
    if (output.action === "create") {
      if (
        output.expectedContentRevision !== 0
        || output.expectedCryptoAccessRevision !== 0
        || output.nextContentRevision !== 1
        || matchingInput !== undefined
      ) {
        throw new TypeError(
          "Background protected Memory create must bind a new revision-one product",
        );
      }
    } else if (
      matchingInput === undefined
      || output.expectedContentRevision !== matchingInput.productRevision
      || output.expectedCryptoAccessRevision
        !== matchingInput.cryptoAccessRevision
      || output.nextContentRevision !== matchingInput.productRevision + 1
      || (source.productAuthority.mode === "scope"
        && matchingInput.accessKind !== "scope_origin")
    ) {
      throw new TypeError(
        "Background protected Memory replace must bind the exact writable input revision",
      );
    }
    if (source.productAuthority.mode === "scope") {
      const namespaceIds = outputSlots[index]!.namespaceIds;
      if (
        namespaceIds.length !== 1
        || namespaceIds[0]
          !== source.productAuthority.originWritableNamespaceId
      ) {
        throw new TypeError(
          "Background protected Memory scope output must use the exact origin Namespace",
        );
      }
    }
  }
  for (const mutation of source.tierMutations) {
    const matchingInput = memoryInputs.find(
      (entry) => entry.productId === mutation.memoryId,
    );
    const matchingBinding = matchingInput === undefined
      ? undefined
      : inputBindings.find((entry) => entry.objectId === matchingInput.objectId);
    if (
      matchingInput === undefined
      || matchingBinding === undefined
      || mutation.contentRevision !== matchingInput.productRevision
      || mutation.cryptoAccessRevision !== matchingInput.cryptoAccessRevision
      || mutation.objectId !== matchingInput.objectId
      || !mutation.requiredNamespaceIds.includes(matchingBinding.namespaceId)
      || (source.productAuthority.mode === "scope"
        && matchingInput.accessKind !== "scope_origin")
    ) {
      throw new TypeError(
        "Background protected Memory tier mutation must bind the exact writable input revision",
      );
    }
    if (
      source.productAuthority.mode === "scope"
      && (mutation.requiredNamespaceIds.length !== 1
        || mutation.requiredNamespaceIds[0]
          !== source.productAuthority.originWritableNamespaceId)
    ) {
      throw new TypeError(
        "Background protected Memory scope tier mutation must use the exact origin Namespace",
      );
    }
  }
}

function normalizeDescriptor(
  value: BackgroundAgentWorkDescriptorV2,
): BackgroundAgentWorkDescriptorV2 {
  assertObject("Background work descriptor v2", value);
  assertExactFields(
    "Background work descriptor v2",
    value,
    DESCRIPTOR_FIELDS,
  );
  if (value["formatVersion"] !== BACKGROUND_WORK_DESCRIPTOR_FORMAT_VERSION_V2) {
    throw new TypeError(
      "Background work descriptor v2 format version is unsupported",
    );
  }
  assertPortableId("Background request id", value["requestId"]);
  assertU64Counter(
    "Background recipient generation",
    value["recipientGeneration"],
  );
  const workKind = normalizeWorkKind(value["workKind"]);
  assertPortableId("Background product work id", value["workId"]);
  const anchorNamespaceId = namespaceId(value["anchorNamespaceId"]);
  const anchorDomainId = cryptoDomainId(value["anchorDomainId"]);
  const subject = normalizeSubject(value["subject"]);
  const purpose = normalizeWorkKind(value["purpose"]);
  if (workKind !== purpose) {
    throw new TypeError("Background work kind and purpose do not match");
  }
  const operations = normalizeOperations(
    "Background work operations",
    value["operations"],
  );
  const source = normalizeSource(value["source"]);
  const grantScope = normalizeGrantScope(value["grantScope"]);
  const inputBindings = normalizeInputBindings(value["inputBindings"]);
  const outputSlots = normalizeOutputSlots(
    value["outputSlots"],
    inputBindings.length,
  );
  assertProtectedMemorySourceInventory(
    workKind,
    source,
    inputBindings,
    outputSlots,
  );
  const namespaceRequirements = normalizeNamespaceRequirements(
    value["namespaceRequirements"],
  );
  const domainRequirements = normalizeDomainRequirements(
    value["domainRequirements"],
  );
  assertExactAuthorityInventory({
    operations,
    inputBindings,
    outputSlots,
    tierMutations: source.kind === "protected_memory_work"
      ? source.tierMutations
      : [],
    namespaceRequirements,
    domainRequirements,
    anchorNamespaceId,
    anchorDomainId,
  });
  assertV2Range(
    "Background maximum input object count",
    value["maximumInputObjectCount"],
    1,
    V2_LIMITS.batchItems,
  );
  if (value["maximumInputObjectCount"] !== inputBindings.length) {
    throw new RangeError(
      "Background maximum input object count must match the exact input inventory",
    );
  }
  assertV2Range(
    "Background maximum output object count",
    value["maximumOutputObjectCount"],
    0,
    V2_LIMITS.batchItems,
  );
  if (value["maximumOutputObjectCount"] !== outputSlots.length) {
    throw new RangeError(
      "Background maximum output object count must match the output slots",
    );
  }
  const canEncrypt = operations.includes("encrypt");
  const hasEncryptUse = outputSlots.length > 0
    || (source.kind === "protected_memory_work"
      && source.tierMutations.length > 0);
  if (canEncrypt !== hasEncryptUse) {
    throw new TypeError(
      "Background output slot space must match encrypt operations",
    );
  }
  assertV2Range(
    "Background plaintext byte budget",
    value["maximumPlaintextBytes"],
    1,
    V2_LIMITS.plaintextBytes,
  );
  assertV2Range(
    "Background ciphertext byte budget",
    value["maximumCiphertextBytes"],
    1,
    V2_LIMITS.ciphertextBytes,
  );
  assertPortableId("Background recipient key id", value["recipientKeyId"]);
  const recipientPublicKey = exactBytes(
    "Background recipient public key",
    value["recipientPublicKey"],
    V2_LIMITS.hpkePublicKeyBytes,
  );
  try {
    assertU64Counter("Background issued-at timestamp", value["issuedAt"]);
    assertU64Counter("Background not-before timestamp", value["notBefore"]);
    assertU64Counter("Background expiry timestamp", value["expiresAt"]);
    if (
      value["issuedAt"] > value["notBefore"]
      || value["notBefore"] >= value["expiresAt"]
    ) {
      throw new RangeError("Background work descriptor timestamps are invalid");
    }
    if (value["expiresAt"] - value["issuedAt"] > V2_LIMITS.grantTtlMs) {
      throw new RangeError(
        "Background work descriptor TTL exceeds its format limit",
      );
    }
    assertPortableId("Background idempotency id", value["idempotencyId"]);
    return Object.freeze({
      formatVersion: BACKGROUND_WORK_DESCRIPTOR_FORMAT_VERSION_V2,
      requestId: value["requestId"],
      recipientGeneration: value["recipientGeneration"],
      workKind,
      workId: value["workId"],
      anchorNamespaceId,
      anchorDomainId,
      subject,
      purpose,
      operations,
      source,
      grantScope,
      inputBindings,
      outputSlots,
      namespaceRequirements,
      domainRequirements,
      maximumInputObjectCount: value["maximumInputObjectCount"],
      maximumOutputObjectCount: value["maximumOutputObjectCount"],
      maximumPlaintextBytes: value["maximumPlaintextBytes"],
      maximumCiphertextBytes: value["maximumCiphertextBytes"],
      recipientKeyId: value["recipientKeyId"],
      recipientPublicKey,
      issuedAt: value["issuedAt"],
      notBefore: value["notBefore"],
      expiresAt: value["expiresAt"],
      idempotencyId: value["idempotencyId"],
    });
  } catch (error) {
    recipientPublicKey.fill(0);
    throw error;
  }
}

function encodeSource(source: BackgroundWorkSourceV2): readonly Uint8Array[] {
  if (source.kind === "synthetic_payload") {
    return Object.freeze([
      frameText(source.kind),
      encodeU64(source.generation),
      frame(source.fingerprint),
    ]);
  }
  return Object.freeze([
    frameText(source.kind),
    encodeU32(source.sourceVersion),
    frameText(source.productAuthority.mode),
    ...(source.productAuthority.mode === "scope"
      ? [
        frameText(source.productAuthority.scopeId),
        frameText(source.productAuthority.originWritableNamespaceId),
      ]
      : []),
    encodeU32(source.inputRevisions.length),
    ...source.inputRevisions.flatMap((entry) => entry.productKind === "memory"
      ? [
        frameText(entry.productKind),
        frameText(entry.productId),
        encodeU64(entry.productRevision),
        encodeU64(entry.cryptoAccessRevision),
        frameText(entry.accessKind),
        frameText(entry.objectId),
      ]
      : [
        frameText(entry.productKind),
        frameText(entry.productId),
        encodeU64(entry.productRevision),
        frameText(entry.objectId),
      ]),
    encodeU32(source.outputRevisions.length),
    ...source.outputRevisions.flatMap((entry) => [
      frameText(entry.action),
      frameText(entry.memoryId),
      encodeU64(entry.expectedContentRevision),
      encodeU64(entry.expectedCryptoAccessRevision),
      encodeU64(entry.nextContentRevision),
      frameText(entry.objectId),
      frameText(entry.publicationIdempotencyId),
    ]),
    encodeU32(source.tierMutations.length),
    ...source.tierMutations.flatMap((entry) => [
      frameText(entry.operationIdempotencyId),
      frameText(entry.memoryId),
      encodeU64(entry.contentRevision),
      encodeU64(entry.cryptoAccessRevision),
      frameText(entry.objectId),
      frameText(entry.action),
      encodeU32(entry.expectedTier),
      encodeU32(entry.nextTier),
      encodeU32(entry.requiredNamespaceIds.length),
      ...entry.requiredNamespaceIds.map(frameText),
    ]),
  ]);
}

function encodeNormalized(value: BackgroundAgentWorkDescriptorV2): Uint8Array {
  const encoded = concatV2(
    frameText(BACKGROUND_WORK_DESCRIPTOR_DOMAIN_V2),
    encodeU32(BACKGROUND_WORK_DESCRIPTOR_FORMAT_VERSION_V2),
    frameText(value.requestId),
    encodeU64(value.recipientGeneration),
    frameText(value.workKind),
    frameText(value.workId),
    frameText(value.anchorNamespaceId),
    frameText(value.anchorDomainId),
    frameText(value.subject.kind),
    frameText(value.subject.agentId),
    encodeU64(value.subject.runtimeGeneration),
    encodeU64(value.subject.authorizationRevision),
    frameText(value.purpose),
    encodeU32(value.operations.length),
    ...value.operations.map(frameText),
    ...encodeSource(value.source),
    encodeU32(value.grantScope.length),
    ...value.grantScope.map(frameText),
    ...encodeWorkObjects(value),
    encodeU32(value.namespaceRequirements.length),
    ...value.namespaceRequirements.flatMap((entry) => [
      frameText(entry.namespaceId),
      frameText(entry.domainId),
      encodeU32(entry.operations.length),
      ...entry.operations.map(frameText),
      encodeU64(entry.expectedAccessRevision),
      encodeU64(entry.expectedPolicyRevision),
    ]),
    encodeU32(value.domainRequirements.length),
    ...value.domainRequirements.flatMap((entry) => [
      frameText(entry.domainId),
      encodeU64(entry.expectedEpoch),
      encodeU64(entry.expectedAgentAuthorizationRevision),
    ]),
    encodeU32(value.maximumInputObjectCount),
    encodeU32(value.maximumOutputObjectCount),
    ...encodeWorkRecipient(value),
  );
  if (encoded.length > MAX_BACKGROUND_WORK_DESCRIPTOR_WIRE_BYTES_V2) {
    encoded.fill(0);
    throw new RangeError("Background work descriptor exceeds its wire limit");
  }
  return encoded;
}

function encodeBackgroundAgentWorkDescriptorV2(
  value: BackgroundAgentWorkDescriptorV2,
): Uint8Array {
  return encodeNormalized(normalizeDescriptor(value));
}

export function decodeBackgroundAgentWorkDescriptorV2(
  bytes: Uint8Array,
): BackgroundAgentWorkDescriptorV2 {
  if (!(bytes instanceof Uint8Array)) {
    throw new TypeError("Background work descriptor bytes must be Uint8Array");
  }
  if (bytes.length > MAX_BACKGROUND_WORK_DESCRIPTOR_WIRE_BYTES_V2) {
    throw new RangeError("Background work descriptor exceeds its wire limit");
  }
  const decoded = decodeExact(bytes, (reader): BackgroundAgentWorkDescriptorV2 => {
    const domain = reader.readText(
      utf8V2(BACKGROUND_WORK_DESCRIPTOR_DOMAIN_V2).length,
    );
    if (domain !== BACKGROUND_WORK_DESCRIPTOR_DOMAIN_V2) {
      throw new CanonicalDecodingError(
        "Background work descriptor domain mismatch",
      );
    }
    const formatVersion = reader.readVersion(
      BACKGROUND_WORK_DESCRIPTOR_FORMAT_VERSION_V2,
    ) as typeof BACKGROUND_WORK_DESCRIPTOR_FORMAT_VERSION_V2;
    const requestId = reader.readText(V2_LIMITS.idBytes);
    const recipientGeneration = reader.readU64();
    const workKind = reader.readText(ENUM_BYTES) as BackgroundWorkKindV2;
    const workId = reader.readText(V2_LIMITS.idBytes);
    const anchorNamespaceId = namespaceId(reader.readText(V2_LIMITS.idBytes));
    const anchorDomainId = cryptoDomainId(reader.readText(V2_LIMITS.idBytes));
    const subjectKind = reader.readText(ENUM_BYTES);
    if (subjectKind !== "agent") {
      throw new CanonicalDecodingError(
        "Background v2 work requires an Agent subject",
      );
    }
    const subject: BackgroundAgentSubjectV2 = {
      kind: "agent",
      agentId: agentId(reader.readText(V2_LIMITS.idBytes)),
      runtimeGeneration: agentRuntimeGeneration(reader.readU64()),
      authorizationRevision: authorizationRevision(reader.readU64()),
    };
    const purpose = reader.readText(ENUM_BYTES) as BackgroundWorkPurposeV2;
    const operationCount = reader.readCount(2);
    const operations = Array.from(
      { length: operationCount },
      () => reader.readText(ENUM_BYTES) as BackgroundWorkOperationV2,
    );
    const sourceKind = reader.readText(ENUM_BYTES);
    let source: BackgroundWorkSourceV2;
    let protectedTierBindingEdges = 0;
    if (sourceKind === "synthetic_payload") {
      source = {
        kind: "synthetic_payload",
        generation: reader.readU64(),
        fingerprint: reader.readFrame(HASH_BYTES),
      };
    } else if (sourceKind === "protected_memory_work") {
      const sourceVersion = reader.readVersion(1) as 1;
      const productAuthorityMode = reader.readText(ENUM_BYTES);
      let productAuthority: BackgroundProtectedMemoryProductAuthorityV2;
      if (productAuthorityMode === "namespace") {
        productAuthority = { mode: "namespace" };
      } else if (productAuthorityMode === "scope") {
        productAuthority = {
          mode: "scope",
          scopeId: reader.readText(V2_LIMITS.idBytes),
          originWritableNamespaceId: namespaceId(
            reader.readText(V2_LIMITS.idBytes),
          ),
        };
      } else {
        throw new CanonicalDecodingError(
          "Background protected Memory product authority is unsupported",
        );
      }
      const inputRevisionCount = reader.readCount(V2_LIMITS.batchItems);
      const inputRevisions = Array.from(
        { length: inputRevisionCount },
        (): BackgroundProtectedMemoryInputRevisionV2 => {
          const productKind = reader.readText(ENUM_BYTES);
          const productId = reader.readText(V2_LIMITS.idBytes);
          const productRevision = reader.readU64();
          if (productKind === "memory") {
            return {
              productKind,
              productId,
              productRevision,
              cryptoAccessRevision: reader.readU64(),
              accessKind: reader.readText(
                ENUM_BYTES,
              ) as BackgroundProtectedMemoryAccessKindV2,
              objectId: objectId(reader.readText(V2_LIMITS.idBytes)),
            };
          }
          if (productKind !== "message") {
            throw new CanonicalDecodingError(
              "Background protected Memory input product kind is unsupported",
            );
          }
          return {
            productKind,
            productId,
            productRevision,
            objectId: objectId(reader.readText(V2_LIMITS.idBytes)),
          };
        },
      );
      const outputRevisionCount = reader.readCount(V2_LIMITS.batchItems);
      const outputRevisions = Array.from(
        { length: outputRevisionCount },
        (): BackgroundProtectedMemoryOutputRevisionV2 => ({
          action: reader.readText(ENUM_BYTES) as "create" | "replace",
          memoryId: reader.readText(V2_LIMITS.idBytes),
          expectedContentRevision: reader.readU64(),
          expectedCryptoAccessRevision: reader.readU64(),
          nextContentRevision: reader.readU64(),
          objectId: objectId(reader.readText(V2_LIMITS.idBytes)),
          publicationIdempotencyId: reader.readText(V2_LIMITS.idBytes),
        }),
      );
      const tierMutationCount = reader.readCount(V2_LIMITS.batchItems);
      const tierMutations = Array.from(
        { length: tierMutationCount },
        (): BackgroundProtectedMemoryTierMutationV2 => {
          const operationIdempotencyId = reader.readText(V2_LIMITS.idBytes);
          const memoryId = reader.readText(V2_LIMITS.idBytes);
          const contentRevision = reader.readU64();
          const cryptoAccessRevision = reader.readU64();
          const exactObjectId = objectId(reader.readText(V2_LIMITS.idBytes));
          const action = reader.readText(ENUM_BYTES) as "promote" | "demote";
          const expectedTier = reader.readU32() as 1 | 2;
          const nextTier = reader.readU32() as 1 | 2 | 3;
          const requiredNamespaceCount = reader.readCount(
            V2_LIMITS.bindingsPerBatch,
          );
          protectedTierBindingEdges += requiredNamespaceCount;
          if (
            protectedTierBindingEdges
              > MAX_BACKGROUND_AUTHORITY_BINDING_EDGES_V2
          ) {
            throw new CanonicalDecodingError(
              "Background authority binding edges exceed their limit",
            );
          }
          return {
            operationIdempotencyId,
            memoryId,
            contentRevision,
            cryptoAccessRevision,
            objectId: exactObjectId,
            action,
            expectedTier,
            nextTier,
            requiredNamespaceIds: Array.from(
              { length: requiredNamespaceCount },
              () => namespaceId(reader.readText(V2_LIMITS.idBytes)),
            ),
          };
        },
      );
      source = {
        kind: "protected_memory_work",
        sourceVersion,
        productAuthority,
        inputRevisions,
        outputRevisions,
        tierMutations,
      };
    } else {
      throw new CanonicalDecodingError(
        "Background v2 work source is unsupported",
      );
    }
    const scopeCount = reader.readCount(V2_LIMITS.grantScopeHumans);
    const grantScope = Array.from(
      { length: scopeCount },
      () => humanId(reader.readText(V2_LIMITS.idBytes)),
    );
    const inputCount = reader.readCount(V2_LIMITS.batchItems);
    let bindingEdges = inputCount + protectedTierBindingEdges;
    if (bindingEdges > MAX_BACKGROUND_AUTHORITY_BINDING_EDGES_V2) {
      throw new CanonicalDecodingError(
        "Background authority binding edges exceed their limit",
      );
    }
    const inputBindings = Array.from(
      { length: inputCount },
      (): BackgroundInputObjectBindingV2 => ({
        objectId: objectId(reader.readText(V2_LIMITS.idBytes)),
        namespaceId: namespaceId(reader.readText(V2_LIMITS.idBytes)),
      }),
    );
    const outputCount = reader.readCount(V2_LIMITS.batchItems);
    const outputSlots: BackgroundOutputObjectSlotV2[] = [];
    for (let index = 0; index < outputCount; index += 1) {
      const exactObjectId = objectId(reader.readText(V2_LIMITS.idBytes));
      const objectType = reader.readText(V2_LIMITS.idBytes);
      const createdAt = unixTimestamp(reader.readU64());
      const namespaceCount = reader.readCount(V2_LIMITS.bindingsPerBatch);
      bindingEdges += namespaceCount;
      if (bindingEdges > MAX_BACKGROUND_AUTHORITY_BINDING_EDGES_V2) {
        throw new CanonicalDecodingError(
          "Background authority binding edges exceed their limit",
        );
      }
      outputSlots.push({
        objectId: exactObjectId,
        objectType,
        createdAt,
        namespaceIds: Array.from(
          { length: namespaceCount },
          () => namespaceId(reader.readText(V2_LIMITS.idBytes)),
        ),
      });
    }
    const namespaceCount = reader.readCount(V2_LIMITS.bindingsPerBatch);
    const namespaceRequirements = Array.from(
      { length: namespaceCount },
      (): BackgroundNamespaceRequirementV2 => {
        const exactNamespaceId = namespaceId(
          reader.readText(V2_LIMITS.idBytes),
        );
        const exactDomainId = cryptoDomainId(
          reader.readText(V2_LIMITS.idBytes),
        );
        const exactOperationCount = reader.readCount(2);
        return {
          namespaceId: exactNamespaceId,
          domainId: exactDomainId,
          operations: Array.from(
            { length: exactOperationCount },
            () => reader.readText(ENUM_BYTES) as BackgroundWorkOperationV2,
          ),
          expectedAccessRevision: accessRevision(reader.readU64()),
          expectedPolicyRevision: authorizationRevision(reader.readU64()),
        };
      },
    );
    const domainCount = reader.readCount(V2_LIMITS.distinctDomainsPerGrant);
    const domainRequirements = Array.from(
      { length: domainCount },
      (): BackgroundDomainRequirementV2 => ({
        domainId: cryptoDomainId(reader.readText(V2_LIMITS.idBytes)),
        expectedEpoch: domainEpoch(reader.readU64()),
        expectedAgentAuthorizationRevision: authorizationRevision(
          reader.readU64(),
        ),
      }),
    );
    return {
      formatVersion,
      requestId,
      recipientGeneration,
      workKind,
      workId,
      anchorNamespaceId,
      anchorDomainId,
      subject,
      purpose,
      operations,
      source,
      grantScope,
      inputBindings,
      outputSlots,
      namespaceRequirements,
      domainRequirements,
      maximumInputObjectCount: reader.readU32(),
      maximumOutputObjectCount: reader.readU32(),
      maximumPlaintextBytes: reader.readU64(),
      maximumCiphertextBytes: reader.readU64(),
      recipientKeyId: reader.readText(V2_LIMITS.idBytes),
      recipientPublicKey: reader.readFrame(V2_LIMITS.hpkePublicKeyBytes),
      issuedAt: reader.readU64(),
      notBefore: reader.readU64(),
      expiresAt: reader.readU64(),
      idempotencyId: reader.readText(V2_LIMITS.idBytes),
    };
  });
  const normalized = normalizeDescriptor(decoded);
  const canonical = encodeNormalized(normalized);
  try {
    if (!equalBytes(canonical, bytes)) {
      throw new CanonicalDecodingError(
        "Background work descriptor is noncanonical",
      );
    }
    return normalized;
  } finally {
    canonical.fill(0);
  }
}

export function backgroundWorkDescriptorDigestV2(
  crypto: Pick<LatticeCrypto, "hash">,
  value: BackgroundWorkDescriptorV2,
): Uint8Array {
  const encoded = encodeBackgroundWorkDescriptorV2(value);
  try {
    return exactBytes(
      "Background work descriptor digest",
      crypto.hash(encoded),
      HASH_BYTES,
    );
  } finally {
    encoded.fill(0);
  }
}

/** Both subjects use the same V2 exact object coordinates and recipient binding. */
type WorkObjectsV2 = Readonly<{
  inputBindings: readonly Readonly<{objectId: string; namespaceId: string}>[];
  outputSlots: readonly Readonly<{objectId: string; objectType: string; createdAt: number; namespaceIds: readonly string[]}>[];
}>;
type WorkRecipientV2 = Pick<BackgroundAgentWorkDescriptorV2, "maximumPlaintextBytes" | "maximumCiphertextBytes" | "recipientKeyId" | "recipientPublicKey" | "issuedAt" | "notBefore" | "expiresAt" | "idempotencyId">;
function encodeWorkObjects(value: WorkObjectsV2, semantic = false): Uint8Array[] {return [
    encodeU32(value.inputBindings.length),
    ...value.inputBindings.flatMap((entry) => [
      frameText(entry.objectId),
      frameText(entry.namespaceId),
      ...(semantic ? [frameText((entry as BackgroundReflectionSemanticInputBindingV2).objectType)] : []),
    ]),
    encodeU32(value.outputSlots.length),
    ...value.outputSlots.flatMap((entry) => [
      frameText(entry.objectId),
      frameText(entry.objectType),
      encodeU64(entry.createdAt),
      encodeU32(entry.namespaceIds.length),
      ...entry.namespaceIds.map(frameText),
    ]),
];}
function encodeWorkRecipient(value: WorkRecipientV2): Uint8Array[] {return [
    encodeU64(value.maximumPlaintextBytes),
    encodeU64(value.maximumCiphertextBytes),
    frameText(value.recipientKeyId),
    frame(value.recipientPublicKey),
    encodeU64(value.issuedAt),
    encodeU64(value.notBefore),
    encodeU64(value.expiresAt),
    frameText(value.idempotencyId),];}

export interface BackgroundNamespaceAuthorityV2 {
  readonly serverId: string;
  readonly roomId: string;
  readonly namespaceId: string;
  readonly namespaceAccessRevision: number;
  readonly namespaceKeyGeneration: number;
  /** Signed retained-generation set digest, as in current Domain authority. */
  readonly namespaceHeadDigest: Uint8Array;
  readonly domainId: string;
  readonly domainKeyGeneration: number;
  readonly domainAuthorizationRevision: number;
  readonly domainHeadDigest: Uint8Array;
  readonly bundleRevision: number;
  readonly bundleDigest: Uint8Array;
}

const PURPOSES = {
  "stenographer.extraction": "journal.extract",
  "stenographer.historical": "journal.extract",
  "stenographer.rebuild": "journal.rebuild",
  "stenographer.compaction": "journal.compact",
  "stenographer.publication_reconcile": "journal.reconcile",
  "stenographer.output_repair": "journal.repair",
} as const;

export type StenographerBackgroundWorkKindV2 = keyof typeof PURPOSES;

export interface BackgroundProcessorWorkDescriptorV2 {
  readonly formatVersion: 2;
  readonly requestId: string;
  readonly recipientGeneration: number;
  readonly workKind: StenographerBackgroundWorkKindV2;
  readonly workId: string;
  readonly anchorNamespaceId: string;
  readonly anchorDomainId: string;
  readonly subject: Readonly<{kind: "processor"; processorKind: "stenographer"; processorVersion: 1}>;
  readonly operations: readonly BackgroundWorkOperationV2[];
  readonly purpose: (typeof PURPOSES)[StenographerBackgroundWorkKindV2];
  readonly authority: BackgroundNamespaceAuthorityV2;
  readonly policyRevision: number;
  readonly source: Readonly<{
    kind: "stenographer_work";
    startSequence: number;
    endSequence: number;
    rebuildGeneration: number;
    fingerprint: Uint8Array;
  }>;
  readonly inputBindings: WorkObjectsV2["inputBindings"];
  readonly outputSlots: readonly Readonly<{
    objectId: string;
    objectType: "nautilo.reflection.record.v1" | "room_event_rollup";
    createdAt: number;
    namespaceIds: readonly string[];
  }>[];
  readonly maximumPlaintextBytes: number;
  readonly maximumCiphertextBytes: number;
  readonly recipientKeyId: string;
  readonly recipientPublicKey: Uint8Array;
  readonly issuedAt: number;
  readonly notBefore: number;
  readonly expiresAt: number;
  readonly idempotencyId: string;
}

// These are the existing Room extraction/compaction contract, not a new
// processor permission registry. Counts are validated before allocation.
const STENOGRAPHER_BACKGROUND_MAX_INPUTS_V2 = V2_LIMITS.batchItems;
export const STENOGRAPHER_BACKGROUND_MAX_OUTPUTS_V2 = 5;
export const STENOGRAPHER_BACKGROUND_MAX_TTL_MS_V2 = 5 * 60_000;
export const STENOGRAPHER_BACKGROUND_MAX_PLAINTEXT_BYTES_V2 = 512 * 1_024;
const STENOGRAPHER_BACKGROUND_MAX_CIPHERTEXT_BYTES_V2 =
  V2_LIMITS.ciphertextBytes;

const AUTHORITY_IDS = ["serverId", "roomId", "namespaceId", "domainId"] as const;
const AUTHORITY_COUNTERS = [
  "namespaceAccessRevision", "namespaceKeyGeneration", "domainKeyGeneration",
  "domainAuthorizationRevision", "bundleRevision",
] as const;
const AUTHORITY_DIGESTS = [
  "namespaceHeadDigest", "domainHeadDigest", "bundleDigest",
] as const;
const AUTHORITY_FIELDS = [...AUTHORITY_IDS, ...AUTHORITY_COUNTERS, ...AUTHORITY_DIGESTS];
const PROCESSOR_DESCRIPTOR_FIELDS = [
  "formatVersion", "requestId", "recipientGeneration", "workKind", "workId",
  "anchorNamespaceId", "anchorDomainId", "subject", "operations", "purpose", "authority", "policyRevision",
  "source", "inputBindings", "outputSlots", "maximumPlaintextBytes",
  "maximumCiphertextBytes", "recipientKeyId", "recipientPublicKey", "issuedAt",
  "notBefore", "expiresAt", "idempotencyId",
];

// Structural bound for the single-Room processor variant. The shared V2
// envelope keeps its existing 128 KiB ceiling; no Agent capacity changes.
const processorIdFrameBytes = 4 + V2_LIMITS.idBytes;
const processorHashFrameBytes = 4 + HASH_BYTES;
export const MAX_BACKGROUND_PROCESSOR_WORK_DESCRIPTOR_WIRE_BYTES_V2 =
  4 + BACKGROUND_WORK_DESCRIPTOR_DOMAIN_V2.length + 4
  + 11 * processorIdFrameBytes + 8 + 4 + 4 + 2 * (4 + "decrypt".length)
  + 3 * 8 + processorHashFrameBytes
  + AUTHORITY_IDS.length * processorIdFrameBytes + AUTHORITY_COUNTERS.length * 8
  + AUTHORITY_DIGESTS.length * processorHashFrameBytes + 8
  + 4 + STENOGRAPHER_BACKGROUND_MAX_INPUTS_V2 * 2 * processorIdFrameBytes
  + 4 + STENOGRAPHER_BACKGROUND_MAX_OUTPUTS_V2 * (3 * processorIdFrameBytes + 8 + 4)
  + 2 * 8 + 4 + V2_LIMITS.hpkePublicKeyBytes + 3 * 8;

function exactFields(value: unknown, expected: readonly string[]): void {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Background descriptor requires an exact object");
  }
  const actual = Object.keys(value).sort();
  const fields = [...expected].sort();
  if (actual.length !== fields.length
    || actual.some((key, index) => key !== fields[index])) {
    throw new TypeError("Background descriptor fields are invalid");
  }
}

function assertProcessorBytes(bytes: Uint8Array, length: number): void {
  if (!(bytes instanceof Uint8Array) || bytes.length !== length) {
    throw new TypeError("Background authority byte length is invalid");
  }
}

function encodeBackgroundNamespaceAuthorityV2(
  value: BackgroundNamespaceAuthorityV2,
): Uint8Array {
  exactFields(value, AUTHORITY_FIELDS);
  for (const key of AUTHORITY_IDS) assertPortableId(key, value[key]);
  for (const key of AUTHORITY_COUNTERS) assertU64Counter(key, value[key]);
  for (const key of AUTHORITY_DIGESTS) {
    if (!(value[key] instanceof Uint8Array) || value[key].length !== HASH_BYTES) {
      throw new TypeError("Background authority digest is invalid");
    }
  }
  return concatV2(
    ...AUTHORITY_IDS.map((key) => frameText(value[key])),
    ...AUTHORITY_COUNTERS.map((key) => encodeU64(value[key])),
    ...AUTHORITY_DIGESTS.map((key) => frame(value[key])),
  );
}

function readAuthority(decoder: StrictDecoder): BackgroundNamespaceAuthorityV2 {
  const fields: Record<string, string | number | Uint8Array> = {};
  for (const key of AUTHORITY_IDS) fields[key] = decoder.readText(V2_LIMITS.idBytes);
  for (const key of AUTHORITY_COUNTERS) fields[key] = decoder.readU64();
  for (const key of AUTHORITY_DIGESTS) fields[key] = decoder.readFrame(HASH_BYTES);
  const value = fields as unknown as BackgroundNamespaceAuthorityV2;
  encodeBackgroundNamespaceAuthorityV2(value);
  return value;
}

function encodeBackgroundProcessorWorkDescriptorV2(value: BackgroundProcessorWorkDescriptorV2): Uint8Array {
  exactFields(value, PROCESSOR_DESCRIPTOR_FIELDS);
  exactFields(value.subject, ["kind", "processorKind", "processorVersion"]);
  if (value.subject.kind !== "processor") throw new TypeError("Expected processor subject");
  if (value.anchorNamespaceId !== value.authority.namespaceId || value.anchorDomainId !== value.authority.domainId) throw new TypeError("Background authority anchor mismatch");
  if (value.formatVersion !== 2 || value.subject.processorKind !== "stenographer"
    || value.subject.processorVersion !== 1 || !Object.hasOwn(PURPOSES, value.workKind)
    || value.purpose !== PURPOSES[value.workKind]) {
    throw new TypeError("Unsupported background processor contract");
  }
  for (const key of ["requestId", "workId", "recipientKeyId", "idempotencyId"] as const) {
    assertPortableId(key, value[key]);
  }
  for (const key of ["recipientGeneration", "policyRevision", "issuedAt", "notBefore", "expiresAt",
    "maximumPlaintextBytes", "maximumCiphertextBytes"] as const) {
    assertU64Counter(key, value[key]);
  }
  if (value.notBefore < value.issuedAt || value.expiresAt <= value.notBefore
    || value.expiresAt - value.issuedAt > STENOGRAPHER_BACKGROUND_MAX_TTL_MS_V2
    || value.maximumPlaintextBytes < 1
    || value.maximumPlaintextBytes > STENOGRAPHER_BACKGROUND_MAX_PLAINTEXT_BYTES_V2
    || value.maximumCiphertextBytes < 1
    || value.maximumCiphertextBytes > STENOGRAPHER_BACKGROUND_MAX_CIPHERTEXT_BYTES_V2) {
    throw new RangeError("Background attempt exceeds its operation contract");
  }
  exactFields(value.source, ["kind", "startSequence", "endSequence", "rebuildGeneration", "fingerprint"]);
  if (value.source.kind !== "stenographer_work") throw new TypeError("Unsupported processor source");
  for (const key of ["startSequence", "endSequence", "rebuildGeneration"] as const) {
    assertU64Counter(key, value.source[key]);
  }
  if (value.source.endSequence < value.source.startSequence) throw new RangeError("Invalid background source range");
  assertProcessorBytes(value.source.fingerprint, HASH_BYTES);
  assertProcessorBytes(value.recipientPublicKey, V2_LIMITS.hpkePublicKeyBytes);
  const reconciliation = value.workKind === "stenographer.publication_reconcile";
  const repair = value.workKind === "stenographer.output_repair";
  if (!Array.isArray(value.inputBindings as unknown) || (!reconciliation && !repair && value.inputBindings.length < 1)
    || value.inputBindings.length > STENOGRAPHER_BACKGROUND_MAX_INPUTS_V2
    || !Array.isArray(value.outputSlots as unknown) || (!reconciliation && !repair && value.outputSlots.length < 1)
    || value.outputSlots.length > STENOGRAPHER_BACKGROUND_MAX_OUTPUTS_V2) {
    throw new RangeError("Background object inventory is invalid");
  }
  if (reconciliation && (value.outputSlots.length !== 0
    || value.inputBindings.length > STENOGRAPHER_BACKGROUND_MAX_OUTPUTS_V2)) {
    throw new TypeError("Publication reconciliation permits only the exact committed input prefix");
  }
  if (repair && (value.inputBindings.length + value.outputSlots.length < 1
    || value.inputBindings.length + value.outputSlots.length > STENOGRAPHER_BACKGROUND_MAX_OUTPUTS_V2)) {
    throw new TypeError("Output repair requires its complete bounded inventory");
  }
  const seen = new Set<string>();
  const requiredOperations = [...(value.inputBindings.length ? ["decrypt"] : []), ...(value.outputSlots.length ? ["encrypt"] : [])];
  if (!Array.isArray(value.operations) || value.operations.length !== requiredOperations.length || value.operations.some((operation, index) => operation !== requiredOperations[index])) throw new TypeError("Processor operations must match exact object inventory");
  for (const entry of value.inputBindings) {
    exactFields(entry, ["objectId", "namespaceId"]);
    if (entry.namespaceId !== value.anchorNamespaceId) throw new TypeError("Processor input Namespace mismatch");
    const id = entry.objectId;
    assertPortableId("Input object", id);
    if (seen.has(id)) throw new TypeError("Duplicate background object");
    seen.add(id);
  }
  const outputType = value.workKind === "stenographer.compaction"
    ? "room_event_rollup" : "nautilo.reflection.record.v1";
  if (value.workKind === "stenographer.compaction" && value.outputSlots.length !== 1) {
    throw new TypeError("Compaction requires one rollup slot");
  }
  for (const output of value.outputSlots) {
    exactFields(output, ["objectId", "objectType", "createdAt", "namespaceIds"]);
    if (!Array.isArray(output.namespaceIds as unknown) || output.namespaceIds.length !== 1 || output.namespaceIds[0] !== value.anchorNamespaceId) throw new TypeError("Processor output Namespace mismatch");
    assertPortableId("Output object", output.objectId);
    assertU64Counter("Output creation time", output.createdAt);
    if ((repair ? !["nautilo.reflection.record.v1", "room_event_rollup"].includes(output.objectType) : output.objectType !== outputType) || seen.has(output.objectId)) throw new TypeError("Invalid background output slot");
    seen.add(output.objectId);
  }
  const bytes = concatV2(
    frameText(BACKGROUND_WORK_DESCRIPTOR_DOMAIN_V2), encodeU32(value.formatVersion),
    frameText(value.requestId), encodeU64(value.recipientGeneration),
    frameText(value.workKind), frameText(value.workId),
    frameText(value.anchorNamespaceId), frameText(value.anchorDomainId),
    frameText(value.subject.kind), frameText(value.subject.processorKind), encodeU32(value.subject.processorVersion),
    frameText(value.purpose), encodeU32(value.operations.length), ...value.operations.map(frameText),
    frameText(value.source.kind), encodeU64(value.source.startSequence), encodeU64(value.source.endSequence),
    encodeU64(value.source.rebuildGeneration), frame(value.source.fingerprint),
    encodeBackgroundNamespaceAuthorityV2(value.authority), encodeU64(value.policyRevision),
    ...encodeWorkObjects(value), ...encodeWorkRecipient(value),
  );
  if (bytes.length > MAX_BACKGROUND_PROCESSOR_WORK_DESCRIPTOR_WIRE_BYTES_V2) throw new RangeError("Background descriptor is oversized");
  return bytes;
}

function readProcessorDescriptorV2(bytes: Uint8Array): BackgroundProcessorWorkDescriptorV2 {
  return decodeExact(bytes, (decoder) => {
    if (decoder.readText(BACKGROUND_WORK_DESCRIPTOR_DOMAIN_V2.length) !== BACKGROUND_WORK_DESCRIPTOR_DOMAIN_V2) throw new TypeError("Unsupported background descriptor domain");
    decoder.readVersion(2);
    const requestId = decoder.readText(V2_LIMITS.idBytes);
    const recipientGeneration = decoder.readU64();
    const workKind = decoder.readText(ENUM_BYTES) as StenographerBackgroundWorkKindV2;
    const workId = decoder.readText(V2_LIMITS.idBytes);
    const anchorNamespaceId = decoder.readText(V2_LIMITS.idBytes);
    const anchorDomainId = decoder.readText(V2_LIMITS.idBytes);
    const subject = {kind: decoder.readText(ENUM_BYTES) as "processor", processorKind: decoder.readText(ENUM_BYTES) as "stenographer", processorVersion: decoder.readU32() as 1};
    const purpose = decoder.readText(ENUM_BYTES) as BackgroundProcessorWorkDescriptorV2["purpose"];
    const operations = Array.from({length: decoder.readCount(2)}, () => decoder.readText(ENUM_BYTES) as BackgroundWorkOperationV2);
    const source = {kind: decoder.readText(ENUM_BYTES) as "stenographer_work", startSequence: decoder.readU64(), endSequence: decoder.readU64(), rebuildGeneration: decoder.readU64(), fingerprint: decoder.readFrame(HASH_BYTES)};
    const authority = readAuthority(decoder);
    const policyRevision = decoder.readU64();
    const inputBindings = Array.from({length: decoder.readCount(STENOGRAPHER_BACKGROUND_MAX_INPUTS_V2)}, () => ({objectId: decoder.readText(V2_LIMITS.idBytes), namespaceId: decoder.readText(V2_LIMITS.idBytes)}));
    const outputSlots = Array.from({length: decoder.readCount(STENOGRAPHER_BACKGROUND_MAX_OUTPUTS_V2)}, () => ({objectId: decoder.readText(V2_LIMITS.idBytes), objectType: decoder.readText(V2_LIMITS.idBytes) as BackgroundProcessorWorkDescriptorV2["outputSlots"][number]["objectType"], createdAt: decoder.readU64(), namespaceIds: Array.from({length: decoder.readCount(1)}, () => decoder.readText(V2_LIMITS.idBytes))}));
    const value: BackgroundProcessorWorkDescriptorV2 = {formatVersion: 2, requestId, recipientGeneration, workKind, workId, anchorNamespaceId, anchorDomainId, subject, purpose, operations, source, authority, policyRevision, inputBindings, outputSlots,
      maximumPlaintextBytes: decoder.readU64(), maximumCiphertextBytes: decoder.readU64(), recipientKeyId: decoder.readText(V2_LIMITS.idBytes), recipientPublicKey: decoder.readFrame(V2_LIMITS.hpkePublicKeyBytes), issuedAt: decoder.readU64(), notBefore: decoder.readU64(), expiresAt: decoder.readU64(), idempotencyId: decoder.readText(V2_LIMITS.idBytes)};
    const canonical = encodeBackgroundProcessorWorkDescriptorV2(value);
    try {if (!equalBytes(canonical, bytes)) throw new TypeError("Noncanonical background descriptor");}
    finally {canonical.fill(0);}
    return value;
  });
}

export interface BackgroundReflectionNamespaceRequirementV2 {
  readonly authority: BackgroundNamespaceAuthorityV2;
  readonly operations: readonly BackgroundWorkOperationV2[];
}

export interface BackgroundProcessorDomainRequirementV2 {
  readonly domainId: string;
  readonly domainKeyGeneration: number;
  readonly domainAuthorizationRevision: number;
  readonly domainHeadDigest: Uint8Array;
}

type ReflectionDescriptorCommonV2 = Omit<BackgroundProcessorWorkDescriptorV2,
  "workKind" | "purpose" | "subject" | "authority" | "source"> & Readonly<{
  subject: Readonly<{kind: "processor"; processorKind: "reflection"; processorVersion: 1}>;
  namespaceRequirements: readonly BackgroundReflectionNamespaceRequirementV2[];
}>;

export type BackgroundReflectionMaintenanceWorkDescriptorV2 = ReflectionDescriptorCommonV2 & (
  | Readonly<{
    workKind: "reflection.authority_reproject";
    purpose: "record.reproject";
    source: Readonly<{kind: "reflection_authority"; recordRef: string;
      sourceChangeGeneration: number; projectionGeneration: number;
      expectedRepresentationGeneration: number; targetRepresentationGeneration: number; fingerprint: Uint8Array}>;
  }>
  | Readonly<{
    workKind: "reflection.publication_reconcile";
    purpose: "record.reconcile";
    source: Readonly<{kind: "reflection_publication"; publicationId: string; recordRef: string;
      representationGeneration: number; fingerprint: Uint8Array}>;
  }>
);

export interface BackgroundReflectionSemanticInputBindingV2 {
  readonly objectId: string;
  readonly namespaceId: string;
  readonly objectType: "nautilo.reflection.record.v1" | "nautilo-memory-v1" | "nautilo-message-v2";
}

export type BackgroundReflectionSemanticWorkDescriptorV2 = Omit<ReflectionDescriptorCommonV2, "inputBindings"> & Readonly<{
  source: Readonly<{kind: "reflection_semantic"; recordRef: string; claimGeneration: number; fingerprint: Uint8Array}>;
  inputBindings: readonly BackgroundReflectionSemanticInputBindingV2[];
}> & (
  | Readonly<{workKind: "reflection.search_projection"; purpose: "record.search_projection"}>
  | Readonly<{workKind: "reflection.organization"; purpose: "record.organize"}>
  | Readonly<{workKind: "reflection.dependency_rewrite"; purpose: "record.dependency_rewrite"}>
);

export type BackgroundReflectionWorkDescriptorV2 = BackgroundReflectionMaintenanceWorkDescriptorV2 | BackgroundReflectionSemanticWorkDescriptorV2;

export type AnyBackgroundProcessorWorkDescriptorV2 = BackgroundProcessorWorkDescriptorV2 | BackgroundReflectionWorkDescriptorV2;
export type BackgroundWorkDescriptorV2 = BackgroundAgentWorkDescriptorV2 | AnyBackgroundProcessorWorkDescriptorV2;

// Carrier capacity follows the current complete V2 authority-set contract.
// These are not family/model batch sizes. Existing Stenographer bounds stay fixed.
export const BACKGROUND_REFLECTION_MAX_NAMESPACES_V2 = V2_LIMITS.agentGrantNamespaces;
export const REFLECTION_BACKGROUND_MAX_DOMAINS_V2 = V2_LIMITS.agentGrantDomains;
export const REFLECTION_BACKGROUND_MAX_INPUTS_V2 = V2_LIMITS.agentGrantNamespaces;
export const REFLECTION_BACKGROUND_MAX_OUTPUT_NAMESPACES_V2 = V2_LIMITS.namespaceEnvelopesPerManifest;
// Record payload v1 and its database representation both cap a body at 256 KiB.
// One unchanged Record read plus write fits the existing 512 KiB background budget.
export const REFLECTION_BACKGROUND_MAX_PLAINTEXT_BYTES_V2 = V2_LIMITS.plaintextBytes / 2;
// Two framed payloads, one input envelope, and the existing complete output
// envelope-set budget. Public descriptor/certificate bytes have separate bounds.
export const REFLECTION_BACKGROUND_MAX_CIPHERTEXT_BYTES_V2 = 2 * MAX_ENCRYPTED_PAYLOAD_WIRE_BYTES_V2
  + MAX_NAMESPACE_OBJECT_ENVELOPE_WIRE_BYTES_V2 + V2_LIMITS.manifestEnvelopeBytes;
// Both families use the current short-lived background attempt window.
const authorityWireMaximum = AUTHORITY_IDS.length * processorIdFrameBytes
  + AUTHORITY_COUNTERS.length * 8 + AUTHORITY_DIGESTS.length * processorHashFrameBytes;
const operationsWireMaximum = 4 + 2 * (4 + "decrypt".length);
// Same common prefix/recipient layout; source adds at most two IDs/four counters.
// Exactly one Record output, with the existing per-object envelope bound.
export const MAX_BACKGROUND_REFLECTION_WORK_DESCRIPTOR_WIRE_BYTES_V2 =
  MAX_BACKGROUND_PROCESSOR_WORK_DESCRIPTOR_WIRE_BYTES_V2
  + 2 * processorIdFrameBytes + 4 * 8 + 4
  + BACKGROUND_REFLECTION_MAX_NAMESPACES_V2 * (authorityWireMaximum + operationsWireMaximum)
  + 4 + REFLECTION_BACKGROUND_MAX_INPUTS_V2 * 2 * processorIdFrameBytes
  + 4 + 2 * processorIdFrameBytes + 8 + 4 + V2_LIMITS.namespaceEnvelopesPerManifest * processorIdFrameBytes;
// Mirrors the existing exact Reflection execution-plan byte policy, without a
// dependency from portable cryptography to the product bridge.
export const REFLECTION_SEMANTIC_MAX_INPUT_PLAINTEXT_BYTES_V2 = V2_LIMITS.plaintextBytes;
export const REFLECTION_SEMANTIC_MAX_OUTPUT_PLAINTEXT_BYTES_V2 = V2_LIMITS.plaintextBytes / 4;
export const REFLECTION_SEMANTIC_MAX_PLAINTEXT_BYTES_V2 = REFLECTION_SEMANTIC_MAX_INPUT_PLAINTEXT_BYTES_V2 + REFLECTION_SEMANTIC_MAX_OUTPUT_PLAINTEXT_BYTES_V2;
export const REFLECTION_SEMANTIC_MAX_CIPHERTEXT_BYTES_V2 = REFLECTION_SEMANTIC_MAX_PLAINTEXT_BYTES_V2
  + (REFLECTION_BACKGROUND_MAX_INPUTS_V2 + 1) * (MAX_ENCRYPTED_PAYLOAD_WIRE_BYTES_V2 - V2_LIMITS.plaintextBytes)
  + REFLECTION_BACKGROUND_MAX_INPUTS_V2 * MAX_NAMESPACE_OBJECT_ENVELOPE_WIRE_BYTES_V2 + V2_LIMITS.manifestEnvelopeBytes;
export const MAX_BACKGROUND_REFLECTION_SEMANTIC_WORK_DESCRIPTOR_WIRE_BYTES_V2 = MAX_BACKGROUND_REFLECTION_WORK_DESCRIPTOR_WIRE_BYTES_V2
  + REFLECTION_BACKGROUND_MAX_INPUTS_V2 * (4 + "nautilo.reflection.record.v1".length);
export const MAX_ANY_BACKGROUND_PROCESSOR_WORK_DESCRIPTOR_WIRE_BYTES_V2 = Math.max(
  MAX_BACKGROUND_PROCESSOR_WORK_DESCRIPTOR_WIRE_BYTES_V2, MAX_BACKGROUND_REFLECTION_SEMANTIC_WORK_DESCRIPTOR_WIRE_BYTES_V2);

export function backgroundProcessorNamespaceRequirementsV2(
  descriptor: AnyBackgroundProcessorWorkDescriptorV2,
): readonly BackgroundReflectionNamespaceRequirementV2[] {
  return "namespaceRequirements" in descriptor ? descriptor.namespaceRequirements
    : [{authority: descriptor.authority, operations: descriptor.operations}];
}

/** One secret per distinct current Domain, even when many Namespaces share it. */
export function backgroundProcessorDomainRequirementsV2(
  descriptor: AnyBackgroundProcessorWorkDescriptorV2,
): readonly BackgroundProcessorDomainRequirementV2[] {
  const domains = new Map<string, BackgroundProcessorDomainRequirementV2>();
  for (const {authority} of backgroundProcessorNamespaceRequirementsV2(descriptor)) {
    const previous = domains.get(authority.domainId);
    if (previous !== undefined && (previous.domainKeyGeneration !== authority.domainKeyGeneration
      || previous.domainAuthorizationRevision !== authority.domainAuthorizationRevision
      || !equalBytes(previous.domainHeadDigest, authority.domainHeadDigest))) {
      throw new TypeError("Background Namespace authorities disagree on their shared Domain");
    }
    if (previous === undefined) domains.set(authority.domainId, {domainId: authority.domainId,
      domainKeyGeneration: authority.domainKeyGeneration, domainAuthorizationRevision: authority.domainAuthorizationRevision,
      domainHeadDigest: copyOwnedBytesV2(authority.domainHeadDigest)});
  }
  if (domains.size < 1 || domains.size > REFLECTION_BACKGROUND_MAX_DOMAINS_V2) throw new RangeError("Background Domain set exceeds capacity");
  return [...domains.values()].sort((a, b) => compareUnsignedUtf8(a.domainId, b.domainId));
}

function encodeBackgroundReflectionWorkDescriptorV2(value: BackgroundReflectionWorkDescriptorV2): Uint8Array {
  exactFields(value, [...PROCESSOR_DESCRIPTOR_FIELDS.filter(key => key !== "authority"), "namespaceRequirements"]);
  exactFields(value.subject, ["kind", "processorKind", "processorVersion"]);
  const reconcile = value.workKind === "reflection.publication_reconcile";
  const semantic = value.source.kind === "reflection_semantic";
  const semanticPurpose = {"reflection.search_projection": "record.search_projection", "reflection.organization": "record.organize", "reflection.dependency_rewrite": "record.dependency_rewrite"} as const;
  const expectedPurpose = semanticPurpose[value.workKind as keyof typeof semanticPurpose];
  if (value.formatVersion !== 2 || value.subject.kind !== "processor" || value.subject.processorKind !== "reflection"
    || value.subject.processorVersion !== 1
    || (semantic ? expectedPurpose === undefined || value.purpose !== expectedPurpose
      : (value.workKind !== "reflection.authority_reproject" && !reconcile)
        || value.purpose !== (reconcile ? "record.reconcile" : "record.reproject")
        || value.source.kind !== (reconcile ? "reflection_publication" : "reflection_authority"))) {
    throw new TypeError("Unsupported Reflection processor contract");
  }
  for (const key of ["requestId", "workId", "recipientKeyId", "idempotencyId", "anchorNamespaceId", "anchorDomainId"] as const) assertPortableId(key, value[key]);
  for (const key of ["recipientGeneration", "policyRevision", "issuedAt", "notBefore", "expiresAt", "maximumPlaintextBytes", "maximumCiphertextBytes"] as const) assertU64Counter(key, value[key]);
  if (value.notBefore < value.issuedAt || value.expiresAt <= value.notBefore || value.expiresAt - value.issuedAt > STENOGRAPHER_BACKGROUND_MAX_TTL_MS_V2
    || value.maximumPlaintextBytes < 1 || value.maximumPlaintextBytes > (semantic ? REFLECTION_SEMANTIC_MAX_PLAINTEXT_BYTES_V2 : REFLECTION_BACKGROUND_MAX_PLAINTEXT_BYTES_V2)
    || value.maximumCiphertextBytes < 1 || value.maximumCiphertextBytes > (semantic ? REFLECTION_SEMANTIC_MAX_CIPHERTEXT_BYTES_V2 : REFLECTION_BACKGROUND_MAX_CIPHERTEXT_BYTES_V2)) throw new RangeError("Reflection attempt exceeds its resource contract");
  assertPortableId("Reflection Record reference", value.source.recordRef);
  assertProcessorBytes(value.source.fingerprint, HASH_BYTES);
  assertProcessorBytes(value.recipientPublicKey, V2_LIMITS.hpkePublicKeyBytes);
  let sourceBytes: Uint8Array;
  if (value.source.kind === "reflection_authority") {
    exactFields(value.source, ["kind", "recordRef", "sourceChangeGeneration", "projectionGeneration", "expectedRepresentationGeneration", "targetRepresentationGeneration", "fingerprint"]);
    for (const key of ["sourceChangeGeneration", "projectionGeneration", "expectedRepresentationGeneration", "targetRepresentationGeneration"] as const) assertU64Counter(key, value.source[key]);
    if (value.source.expectedRepresentationGeneration < 1 || value.source.targetRepresentationGeneration !== value.source.expectedRepresentationGeneration + 1) throw new TypeError("Reflection representation transition is not exact");
    sourceBytes = concatV2(frameText(value.source.kind), frameText(value.source.recordRef), encodeU64(value.source.sourceChangeGeneration),
      encodeU64(value.source.projectionGeneration), encodeU64(value.source.expectedRepresentationGeneration), encodeU64(value.source.targetRepresentationGeneration), frame(value.source.fingerprint));
  } else if (value.source.kind === "reflection_semantic") {
    exactFields(value.source, ["kind", "recordRef", "claimGeneration", "fingerprint"]);
    assertU64Counter("Reflection source claim generation", value.source.claimGeneration);
    sourceBytes = concatV2(frameText(value.source.kind), frameText(value.source.recordRef), encodeU64(value.source.claimGeneration), frame(value.source.fingerprint));
  } else {
    exactFields(value.source, ["kind", "publicationId", "recordRef", "representationGeneration", "fingerprint"]);
    assertPortableId("Reflection publication", value.source.publicationId);
    assertU64Counter("Reflection published representation", value.source.representationGeneration);
    if (value.source.representationGeneration < 1) throw new TypeError("Reflection published representation must be positive");
    sourceBytes = concatV2(frameText(value.source.kind), frameText(value.source.publicationId), frameText(value.source.recordRef),
      encodeU64(value.source.representationGeneration), frame(value.source.fingerprint));
  }
  if (!Array.isArray(value.namespaceRequirements as unknown) || value.namespaceRequirements.length < 1 || value.namespaceRequirements.length > BACKGROUND_REFLECTION_MAX_NAMESPACES_V2) throw new RangeError("Reflection Namespace requirements exceed capacity");
  const requirements = new Map<string, BackgroundReflectionNamespaceRequirementV2>();
  const namespaceBytes: Uint8Array[] = [];
  let serverId: string | undefined;
  let previousId: string | undefined;
  for (const requirement of value.namespaceRequirements) {
    exactFields(requirement, ["authority", "operations"]);
    const {authority} = requirement;
    if (previousId !== undefined && compareUnsignedUtf8(previousId, authority.namespaceId) >= 0) throw new TypeError("Reflection Namespace requirements must be canonical and unique");
    if (serverId !== undefined && authority.serverId !== serverId) throw new TypeError("Reflection Namespace requirements cross Server authority");
    serverId = authority.serverId; previousId = authority.namespaceId;
    const ops = normalizeOperations("Reflection Namespace operations", requirement.operations);
    requirements.set(authority.namespaceId, requirement);
    namespaceBytes.push(encodeBackgroundNamespaceAuthorityV2(authority), encodeU32(ops.length), ...ops.map(frameText));
  }
  const domains = backgroundProcessorDomainRequirementsV2(value);
  domains.forEach(domain => domain.domainHeadDigest.fill(0));
  if (requirements.get(value.anchorNamespaceId)?.authority.domainId !== value.anchorDomainId) throw new TypeError("Reflection routing anchor does not name an exact requirement");
  if (!Array.isArray(value.inputBindings as unknown) || value.inputBindings.length < 1 || value.inputBindings.length > REFLECTION_BACKGROUND_MAX_INPUTS_V2
    || !Array.isArray(value.outputSlots as unknown) || (semantic ? value.outputSlots.length > (value.workKind === "reflection.search_projection" ? 0 : 1) : value.outputSlots.length !== (reconcile ? 0 : 1))) throw new RangeError("Reflection object inventory is invalid");
  const used = new Map<string, Set<BackgroundWorkOperationV2>>();
  const addOperation = (namespace: string, operation: BackgroundWorkOperationV2) => {
    if (!requirements.get(namespace)?.operations.includes(operation)) throw new TypeError("Reflection object exceeds its Namespace operation authority");
    const ops = used.get(namespace) ?? new Set<BackgroundWorkOperationV2>(); ops.add(operation); used.set(namespace, ops);
  };
  const objects = new Set<string>();
  const inputPairs = new Set<string>();
  for (const binding of value.inputBindings) {
    exactFields(binding, semantic ? ["objectId", "namespaceId", "objectType"] : ["objectId", "namespaceId"]); assertPortableId("Reflection input", binding.objectId);
    if (semantic && (!("objectType" in binding) || !["nautilo.reflection.record.v1", "nautilo-memory-v1", "nautilo-message-v2"].includes(binding.objectType as string))) throw new TypeError("Reflection semantic input type is unsupported");
    if (semantic && "objectType" in binding && binding.objectType === "nautilo-message-v2" && value.workKind !== "reflection.dependency_rewrite") throw new TypeError("Message inputs require Reflection dependency repair");
    const pair = JSON.stringify([binding.objectId, binding.namespaceId]);
    if (inputPairs.has(pair)) throw new TypeError("Reflection object inventory contains duplicate input pairs");
    inputPairs.add(pair);
    objects.add(binding.objectId); addOperation(binding.namespaceId, "decrypt");
  }
  for (const output of value.outputSlots) {
    exactFields(output, ["objectId", "objectType", "createdAt", "namespaceIds"]);
    assertPortableId("Reflection output", output.objectId); assertU64Counter("Reflection output time", output.createdAt);
    if (output.objectType !== "nautilo.reflection.record.v1" || objects.has(output.objectId)
      || !Array.isArray(output.namespaceIds as unknown) || output.namespaceIds.length < 1 || output.namespaceIds.length > V2_LIMITS.namespaceEnvelopesPerManifest) throw new TypeError("Reflection output requires an exact supported Record publication set");
    canonicalStringSet("Reflection output Namespaces", output.namespaceIds);
    output.namespaceIds.forEach((id: string) => addOperation(id, "encrypt")); objects.add(output.objectId);
  }
  if (used.size !== requirements.size || [...requirements].some(([id, requirement]) => {
    const operations = [...(used.get(id) ?? [])].sort(compareUnsignedUtf8);
    return !equalStrings(operations, requirement.operations);
  })) throw new TypeError("Reflection Namespace requirements include unused authority");
  const operations = [...new Set([...used.values()].flatMap(ops => [...ops]))].sort(compareUnsignedUtf8);
  if (!equalStrings(value.operations, operations)) throw new TypeError("Reflection operations disagree with exact inventory");
  const bytes = concatV2(frameText(BACKGROUND_WORK_DESCRIPTOR_DOMAIN_V2), encodeU32(2), frameText(value.requestId), encodeU64(value.recipientGeneration),
    frameText(value.workKind), frameText(value.workId), frameText(value.anchorNamespaceId), frameText(value.anchorDomainId),
    frameText(value.subject.kind), frameText(value.subject.processorKind), encodeU32(value.subject.processorVersion), frameText(value.purpose),
    encodeU32(value.operations.length), ...value.operations.map(frameText), sourceBytes,
    encodeU32(value.namespaceRequirements.length), ...namespaceBytes, encodeU64(value.policyRevision), ...encodeWorkObjects(value, semantic), ...encodeWorkRecipient(value));
  if (bytes.length > (semantic ? MAX_BACKGROUND_REFLECTION_SEMANTIC_WORK_DESCRIPTOR_WIRE_BYTES_V2 : MAX_BACKGROUND_REFLECTION_WORK_DESCRIPTOR_WIRE_BYTES_V2)) throw new RangeError("Reflection descriptor exceeds its wire bound");
  return bytes;
}

function readReflectionDescriptorV2(bytes: Uint8Array): BackgroundReflectionWorkDescriptorV2 {
  return decodeExact(bytes, decoder => {
    if (decoder.readText(BACKGROUND_WORK_DESCRIPTOR_DOMAIN_V2.length) !== BACKGROUND_WORK_DESCRIPTOR_DOMAIN_V2) throw new TypeError("Unsupported background descriptor domain");
    decoder.readVersion(2);
    const requestId = decoder.readText(V2_LIMITS.idBytes), recipientGeneration = decoder.readU64();
    const workKind = decoder.readText(ENUM_BYTES), workId = decoder.readText(V2_LIMITS.idBytes);
    const anchorNamespaceId = decoder.readText(V2_LIMITS.idBytes), anchorDomainId = decoder.readText(V2_LIMITS.idBytes);
    const subject = {kind: decoder.readText(ENUM_BYTES), processorKind: decoder.readText(ENUM_BYTES), processorVersion: decoder.readU32()};
    const purpose = decoder.readText(ENUM_BYTES);
    const operations = Array.from({length: decoder.readCount(2)}, () => decoder.readText(ENUM_BYTES));
    const sourceKind = decoder.readText(ENUM_BYTES);
    let source: BackgroundReflectionWorkDescriptorV2["source"];
    if (sourceKind === "reflection_authority") source = {kind: sourceKind, recordRef: decoder.readText(V2_LIMITS.idBytes),
      sourceChangeGeneration: decoder.readU64(), projectionGeneration: decoder.readU64(), expectedRepresentationGeneration: decoder.readU64(), targetRepresentationGeneration: decoder.readU64(), fingerprint: decoder.readFrame(HASH_BYTES)};
    else if (sourceKind === "reflection_publication") source = {kind: sourceKind, publicationId: decoder.readText(V2_LIMITS.idBytes), recordRef: decoder.readText(V2_LIMITS.idBytes), representationGeneration: decoder.readU64(), fingerprint: decoder.readFrame(HASH_BYTES)};
    else if (sourceKind === "reflection_semantic") source = {kind: sourceKind, recordRef: decoder.readText(V2_LIMITS.idBytes), claimGeneration: decoder.readU64(), fingerprint: decoder.readFrame(HASH_BYTES)};
    else throw new TypeError("Unsupported Reflection source");
    const namespaceRequirements = Array.from({length: decoder.readCount(BACKGROUND_REFLECTION_MAX_NAMESPACES_V2)}, () => ({authority: readAuthority(decoder),
      operations: Array.from({length: decoder.readCount(2)}, () => decoder.readText(ENUM_BYTES))}));
    const policyRevision = decoder.readU64();
    const inputBindings = Array.from({length: decoder.readCount(REFLECTION_BACKGROUND_MAX_INPUTS_V2)}, () => ({objectId: decoder.readText(V2_LIMITS.idBytes), namespaceId: decoder.readText(V2_LIMITS.idBytes), ...(sourceKind === "reflection_semantic" ? {objectType: decoder.readText(ENUM_BYTES)} : {})}));
    const outputSlots = Array.from({length: decoder.readCount(1)}, () => ({objectId: decoder.readText(V2_LIMITS.idBytes), objectType: decoder.readText(V2_LIMITS.idBytes), createdAt: decoder.readU64(),
      namespaceIds: Array.from({length: decoder.readCount(V2_LIMITS.namespaceEnvelopesPerManifest)}, () => decoder.readText(V2_LIMITS.idBytes))}));
    const value = {formatVersion: 2, requestId, recipientGeneration, workKind, workId, anchorNamespaceId, anchorDomainId, subject, purpose, operations, source, namespaceRequirements, policyRevision, inputBindings, outputSlots,
      maximumPlaintextBytes: decoder.readU64(), maximumCiphertextBytes: decoder.readU64(), recipientKeyId: decoder.readText(V2_LIMITS.idBytes), recipientPublicKey: decoder.readFrame(V2_LIMITS.hpkePublicKeyBytes),
      issuedAt: decoder.readU64(), notBefore: decoder.readU64(), expiresAt: decoder.readU64(), idempotencyId: decoder.readText(V2_LIMITS.idBytes)} as BackgroundReflectionWorkDescriptorV2;
    const canonical = encodeBackgroundReflectionWorkDescriptorV2(value);
    try {if (!equalBytes(canonical, bytes)) throw new TypeError("Noncanonical Reflection descriptor");} finally {canonical.fill(0);}
    return value;
  });
}

export function encodeBackgroundWorkDescriptorV2(value: BackgroundWorkDescriptorV2): Uint8Array {
  if (value.subject?.kind !== "processor") return encodeBackgroundAgentWorkDescriptorV2(value as BackgroundAgentWorkDescriptorV2);
  return value.subject.processorKind === "reflection"
    ? encodeBackgroundReflectionWorkDescriptorV2(value as BackgroundReflectionWorkDescriptorV2)
    : encodeBackgroundProcessorWorkDescriptorV2(value as BackgroundProcessorWorkDescriptorV2);
}

/** Dispatch only on the signed V2 subject tag. Unknown variants never fall back. */
export function decodeBackgroundWorkDescriptorV2(bytes: Uint8Array): BackgroundWorkDescriptorV2 {
  if (!(bytes instanceof Uint8Array)) throw new TypeError("Background work descriptor bytes must be Uint8Array");
  if (bytes.length > Math.max(MAX_BACKGROUND_WORK_DESCRIPTOR_WIRE_BYTES_V2, MAX_ANY_BACKGROUND_PROCESSOR_WORK_DESCRIPTOR_WIRE_BYTES_V2)) throw new RangeError("Background work descriptor exceeds its wire limit");
  const reader = new StrictDecoder(bytes);
  let kind: string;
  let processorKind: string | undefined;
  try {
    if (reader.readText(BACKGROUND_WORK_DESCRIPTOR_DOMAIN_V2.length) !== BACKGROUND_WORK_DESCRIPTOR_DOMAIN_V2) throw new CanonicalDecodingError("Background work descriptor domain mismatch");
    reader.readVersion(2);
    reader.readText(V2_LIMITS.idBytes); reader.readU64(); reader.readText(ENUM_BYTES); reader.readText(V2_LIMITS.idBytes);
    reader.readText(V2_LIMITS.idBytes); reader.readText(V2_LIMITS.idBytes);
    kind = reader.readText(ENUM_BYTES);
    if (kind === "processor") processorKind = reader.readText(ENUM_BYTES);
  } finally {reader.destroy(true);}
  if (kind === "agent") return decodeBackgroundAgentWorkDescriptorV2(bytes);
  if (kind === "processor" && processorKind === "stenographer") return readProcessorDescriptorV2(bytes);
  if (kind === "processor" && processorKind === "reflection") return readReflectionDescriptorV2(bytes);
  throw new CanonicalDecodingError("Unsupported background V2 subject");
}

export function decodeBackgroundProcessorWorkDescriptorV2(bytes: Uint8Array): BackgroundProcessorWorkDescriptorV2 {
  const value = decodeBackgroundWorkDescriptorV2(bytes);
  if (value.subject.kind !== "processor" || value.subject.processorKind !== "stenographer") throw new CanonicalDecodingError("Background work requires a Stenographer processor subject");
  return value as BackgroundProcessorWorkDescriptorV2;
}

export function decodeAnyBackgroundProcessorWorkDescriptorV2(bytes: Uint8Array): AnyBackgroundProcessorWorkDescriptorV2 {
  const value = decodeBackgroundWorkDescriptorV2(bytes);
  if (value.subject.kind !== "processor") throw new CanonicalDecodingError("Background work requires a processor subject");
  return value as AnyBackgroundProcessorWorkDescriptorV2;
}
