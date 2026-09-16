import { z } from "zod";
import {
  HUMAN_MEMORY_EXACT_ACCESS_REQUEST_MAX_ENTRIES_V2,
  MAX_HUMAN_MEMORY_CONTENT_EMBEDDING_REQUEST_WIRE_BYTES_V2,
  MAX_HUMAN_MEMORY_EXACT_ACCESS_REQUEST_WIRE_BYTES_V2,
  MAX_OBJECT_ACCESS_MANIFEST_WIRE_BYTES_V5,
  MAX_RETAINED_NAMESPACE_GENERATIONS_V2,
} from
  "@nautilo/lattice-crypto/wire-limits";
import {
  protectedObjectAccessSignerEvidenceV1Schema,
} from "./protected-object-access.ts";

const portableId = z.string().min(1).max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:@/-]*$/);
const canonicalUuid = z.string().uuid();
const canonicalLowerUuid = canonicalUuid.refine(
  (value) => value === value.toLowerCase(),
  { message: "UUID must use canonical lowercase form" },
);
const base64url = z.string().min(1).max(2_000_000)
  .regex(/^[A-Za-z0-9_-]+$/);
const signedContentEmbeddingRequestBase64url = z.string()
  .min(1)
  .max(Math.ceil(
    MAX_HUMAN_MEMORY_CONTENT_EMBEDDING_REQUEST_WIRE_BYTES_V2 * 4 / 3,
  ))
  .regex(/^[A-Za-z0-9_-]+$/)
  .refine((value) => value.length % 4 !== 1, {
    message: "signed content-embedding request must be unpadded base64url",
  });
const signedExactAccessRequestBase64url = z.string()
  .min(1)
  .max(Math.ceil(
    MAX_HUMAN_MEMORY_EXACT_ACCESS_REQUEST_WIRE_BYTES_V2 * 4 / 3,
  ))
  .regex(/^[A-Za-z0-9_-]+$/)
  .refine((value) => value.length % 4 !== 1, {
    message: "signed exact-access request must be unpadded base64url",
  });
// Exact-access publication consumes V5; use its complete binary envelope,
// encoded as unpadded base64url, rather than another transport-only ceiling.
const accessManifestBase64url = z.string()
  .min(1)
  .max(Math.ceil(MAX_OBJECT_ACCESS_MANIFEST_WIRE_BYTES_V5 * 4 / 3))
  .regex(/^[A-Za-z0-9_-]+$/)
  .refine((value) => value.length % 4 !== 1, {
    message: "exact access manifest must be unpadded base64url",
  });
const nonnegativeInteger = z.number().int().min(0).max(2_147_483_647);
const unixTimestampMs = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const exactRequiredNamespaceIdsSchema = z.array(canonicalLowerUuid)
  .min(1)
  .max(HUMAN_MEMORY_EXACT_ACCESS_REQUEST_MAX_ENTRIES_V2)
  .superRefine((namespaceIds, context) => {
    if (new Set(namespaceIds).size !== namespaceIds.length) {
      context.addIssue({
        code: "custom",
        message: "required Namespace IDs must be unique",
      });
    }
    const canonical = [...namespaceIds].sort();
    if (canonical.some((namespaceId, index) =>
      namespaceId !== namespaceIds[index]
    )) {
      context.addIssue({
        code: "custom",
        message: "required Namespace IDs must be canonical",
      });
    }
  });
const canonicalNamespaceIdsAllowEmptySchema = z.array(canonicalLowerUuid)
  .max(HUMAN_MEMORY_EXACT_ACCESS_REQUEST_MAX_ENTRIES_V2)
  .superRefine((namespaceIds, context) => {
    if (new Set(namespaceIds).size !== namespaceIds.length) {
      context.addIssue({ code: "custom", message: "Namespace IDs must be unique" });
    }
    if ([...namespaceIds].sort().some((id, index) => id !== namespaceIds[index])) {
      context.addIssue({ code: "custom", message: "Namespace IDs must be canonical" });
    }
  });
const protectedMemoryAccessListSchema = z.array(z.object({
  userHandle: z.string().min(1).max(128),
  displayName: z.string().min(1),
}).strict()).superRefine((entries, context) => {
  const handles = entries.map((entry) => entry.userHandle);
  if (new Set(handles).size !== handles.length) {
    context.addIssue({
      code: "custom",
      message: "protected Memory audience handles must be unique",
    });
  }
});
const canonicalNamespaceEnvelopeSchema = z.object({
  namespaceId: canonicalLowerUuid,
  envelopeBytesBase64url: base64url,
}).strict();
const exactCanonicalNamespaceEnvelopesSchema = z.array(
  canonicalNamespaceEnvelopeSchema,
).min(1).max(HUMAN_MEMORY_EXACT_ACCESS_REQUEST_MAX_ENTRIES_V2)
  .superRefine((envelopes, context) => {
  const namespaceIds = envelopes.map((entry) => entry.namespaceId);
  if (new Set(namespaceIds).size !== namespaceIds.length) {
    context.addIssue({
      code: "custom",
      message: "Namespace envelopes must be unique",
    });
  }
  const canonical = [...namespaceIds].sort();
  if (canonical.some((namespaceId, index) =>
    namespaceId !== namespaceIds[index]
  )) {
    context.addIssue({
      code: "custom",
      message: "Namespace envelopes must be canonical",
    });
  }
});
const exactCanonicalNamespaceEnvelopesAllowEmptySchema = z.array(
  canonicalNamespaceEnvelopeSchema,
).max(HUMAN_MEMORY_EXACT_ACCESS_REQUEST_MAX_ENTRIES_V2)
  .superRefine((envelopes, context) => {
  const ids = envelopes.map(({ namespaceId }) => namespaceId);
  if (new Set(ids).size !== ids.length || [...ids].sort().some((id, index) => id !== ids[index])) {
    context.addIssue({ code: "custom", message: "Namespace envelopes must be a canonical exact set" });
  }
});
const protectedMemoryNamespaceGenerationAuthorityV1Schema = z.object({
  generation: nonnegativeInteger,
  accessRevision: nonnegativeInteger,
  headDigestBase64url: base64url,
  publicationDigestBase64url: base64url,
  publicationSetDigestBase64url: base64url,
  audienceFingerprintBase64url: base64url,
}).strict();
const protectedMemoryNamespaceAuthorityV1Schema = z.object({
  sourceRoomId: canonicalLowerUuid,
  namespaceId: canonicalLowerUuid,
  currentGeneration: nonnegativeInteger,
  retainedGenerations: z.array(
    protectedMemoryNamespaceGenerationAuthorityV1Schema,
  ).min(1).max(MAX_RETAINED_NAMESPACE_GENERATIONS_V2)
    .superRefine((generations, context) => {
    if (generations.some((entry, index) =>
      index > 0 && generations[index - 1]!.generation >= entry.generation
    )) context.addIssue({
      code: "custom",
      message: "retained Namespace generations must be canonical",
    });
  }),
}).strict().superRefine((authority, context) => {
  if (!authority.retainedGenerations.some((entry) =>
    entry.generation === authority.currentGeneration)) context.addIssue({
      code: "custom", message: "current Namespace generation must be retained",
      path: ["currentGeneration"],
    });
});
const protectedMemoryNamespaceAuthoritiesAllowEmptyV1Schema = z.array(
  protectedMemoryNamespaceAuthorityV1Schema,
).max(HUMAN_MEMORY_EXACT_ACCESS_REQUEST_MAX_ENTRIES_V2)
  .superRefine((authorities, context) => {
  if (authorities.some((entry, index) =>
    index > 0 && authorities[index - 1]!.namespaceId >= entry.namespaceId
  )) context.addIssue({
    code: "custom",
    message: "Namespace authorities must be canonical",
  });
});
const protectedMemoryNamespaceAuthoritiesV1Schema =
  protectedMemoryNamespaceAuthoritiesAllowEmptyV1Schema.min(1);
const protectedMemoryProductAuthoritySchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("namespace") }).strict(),
  z.object({
    mode: z.literal("scope"),
    scopeId: canonicalLowerUuid,
    originWritableNamespaceId: canonicalLowerUuid,
  }).strict(),
]);
const protectedMemoryUnavailableReasonSchema = z.enum([
  "missing_mapping",
  "protected_representation_missing",
  "legacy_plaintext",
  "encryption_pending",
  "stale_revision",
  "incomplete_access_set",
  "integrity_failure",
  "authorization_required",
  "text_search_unsupported",
  "deleted",
  "target_encryption_not_ready",
  "embedding_unavailable",
]);

function exactNamespaceEnvelopeSet(
  namespaceIds: readonly string[],
  envelopes: readonly Readonly<{ namespaceId: string }>[],
): boolean {
  const envelopeIds = envelopes.map((entry) => entry.namespaceId);
  return new Set(namespaceIds).size === namespaceIds.length
    && new Set(envelopeIds).size === envelopeIds.length
    && envelopeIds.length === namespaceIds.length
    && envelopeIds.every((id) => namespaceIds.includes(id));
}

function exactCanonicalNamespaceEnvelopeInventory(
  namespaceIds: readonly string[],
  envelopes: readonly Readonly<{ namespaceId: string }>[],
): boolean {
  return envelopes.length === namespaceIds.length
    && envelopes.every((entry, index) =>
      entry.namespaceId === namespaceIds[index]
    );
}

export const protectedMemoryProjectionV1Schema = z.object({
  /** Shadow-only repair hint, never a substitute for displayed ciphertext. */
  representationRepair: z.enum(["ordinary_to_protected", "protected_to_ordinary"]).optional(),
  memoryId: canonicalUuid,
  // A listed ordinary historical row can predate its first protected revision.
  contentRevision: nonnegativeInteger,
  cryptoAccessRevision: nonnegativeInteger,
  importance: z.number().finite().min(0).max(1),
  tier: z.number().int().min(1).max(3),
  createdAt: z.string().datetime({ offset: true }),
  updatedAt: z.string().datetime({ offset: true }),
  /** Product `memory_namespaces` attachments; scope-only rows may be empty. */
  namespaceIds: canonicalNamespaceIdsAllowEmptySchema,
  /** Complete crypto envelope set, including retained scope-origin authority. */
  requiredNamespaceIds: exactRequiredNamespaceIdsSchema,
  /** Authorized opening paths only; the complete envelope inventory remains below. */
  readAuthorities: protectedMemoryNamespaceAuthoritiesAllowEmptyV1Schema,
  /** Present only when this caller can republish the complete exact audience. */
  mutationAuthorities: protectedMemoryNamespaceAuthoritiesV1Schema.optional(),
  /** Authorized product projection only; never derived by opening payloads. */
  accessList: protectedMemoryAccessListSchema.optional(),
  scopeOrigin: z.enum(["seed", "scope"]).optional(),
  demotedAt: z.string().datetime({ offset: true }).nullable().optional(),
  demotedFrom: z.number().int().min(1).max(3).nullable().optional(),
}).strict().superRefine((value, context) => {
  if (value.readAuthorities.some((entry) =>
    !value.requiredNamespaceIds.includes(entry.namespaceId)
  )) context.addIssue({ code: "custom", message: "read authority is outside the exact audience",
    path: ["readAuthorities"] });
  if (value.mutationAuthorities !== undefined && (
    value.mutationAuthorities.length !== value.requiredNamespaceIds.length
    || value.mutationAuthorities.some((entry, index) =>
      entry.namespaceId !== value.requiredNamespaceIds[index]
    )
  )) context.addIssue({ code: "custom", message: "mutation authority must cover the exact audience",
    path: ["mutationAuthorities"] });
});

const encryptedPayload = z.object({
  status: z.literal("encrypted"),
  cryptoObjectId: portableId,
  payloadVersion: z.literal(1),
  encryptedPayloadBytesBase64url: base64url,
  accessManifestBytesBase64url: base64url,
  /** Genesis through the manifest immediately before the current head. */
  accessManifestProofBytesBase64url: z.array(base64url).max(256).optional(),
  // A manifest chain can need several kinds of signer evidence. Preserve its
  // complete evidence set; uniqueness and aggregate byte validation follow.
  accessSignerEvidence: z.array(z.union([
    protectedObjectAccessSignerEvidenceV1Schema,
    z.object({
      kind: z.literal("human_device"),
      subjectHumanId: canonicalLowerUuid,
      committerDeviceId: portableId,
      hostAuthorizationRevision: z.number().int().nonnegative().safe(),
      signingPublicKeyBase64url: base64url.length(43),
    }).strict(),
    z.object({
      kind: z.literal("evidence_issuer_human_device"),
      subjectHumanId: canonicalLowerUuid,
      deviceId: portableId,
      hostAuthorizationRevision: z.number().int().nonnegative().safe(),
      signingPublicKeyBase64url: base64url.length(43),
    }).strict(),
    z.object({
      kind: z.literal("foreground_agent_accepted_execution"),
      planBytesBase64url: base64url,
      planDigestBase64url: base64url.length(43),
    }).strict(),
  ])).superRefine((entries, context) => {
    const keys = entries.map((entry) => entry.kind === "human_device"
      ? `${entry.kind}:${entry.subjectHumanId}:${entry.committerDeviceId}:${entry.hostAuthorizationRevision}`
      : entry.kind === "evidence_issuer_human_device"
      ? `${entry.kind}:${entry.subjectHumanId}:${entry.deviceId}:${entry.hostAuthorizationRevision}`
      : entry.kind === "foreground_agent_accepted_execution"
      ? `${entry.kind}:${entry.planDigestBase64url}`
      : `${entry.kind}:${entry.evidenceBytesBase64url}`);
    if (new Set(keys).size !== keys.length) {
      context.addIssue({
        code: "custom",
        message: "Memory access signer evidence must be unique",
      });
    }
    const encodedBytes = entries.reduce((total, entry) => total + (
      entry.kind === "human_device" || entry.kind === "evidence_issuer_human_device"
        ? entry.signingPublicKeyBase64url.length
        : entry.kind === "foreground_agent_accepted_execution"
        ? entry.planBytesBase64url.length + entry.planDigestBase64url.length
        : entry.evidenceBytesBase64url.length
    ), 0);
    if (encodedBytes > 1_398_102) {
      context.addIssue({
        code: "custom",
        message: "Memory access signer evidence exceeds the profile ceiling",
      });
    }
  }),
  namespaceEnvelopes: exactCanonicalNamespaceEnvelopesSchema,
}).strict();

export const protectedMemoryAccessOperationV1Schema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("grant_room"), roomId: canonicalLowerUuid }).strict(),
  z.object({ kind: z.literal("grant_user"), userHandle: z.string().min(1).max(128) }).strict(),
  z.object({ kind: z.literal("revoke_user"), userHandle: z.string().min(1).max(128) }).strict(),
  z.object({ kind: z.literal("make_private") }).strict(),
  z.object({ kind: z.literal("delete_authorized_view") }).strict(),
]);

export const protectedMemoryAccessPlanRequestV1Schema = z.object({
  requestVersion: z.literal(1),
  operation: protectedMemoryAccessOperationV1Schema,
}).strict();

const protectedMemoryAccessPlanV1Schema = z.object({
  dtoVersion: z.literal(1),
  status: z.literal("planned"),
  planVersion: z.literal(1),
  operationId: portableId,
  memoryId: canonicalLowerUuid,
  expectedContentRevision: nonnegativeInteger.min(1),
  expectedCryptoAccessRevision: nonnegativeInteger,
  cryptoObjectId: portableId,
  currentNamespaceIds: canonicalNamespaceIdsAllowEmptySchema,
  targetNamespaceIds: canonicalNamespaceIdsAllowEmptySchema,
  addedNamespaceIds: canonicalNamespaceIdsAllowEmptySchema,
  removedNamespaceIds: canonicalNamespaceIdsAllowEmptySchema,
  currentAuthorities: protectedMemoryNamespaceAuthoritiesAllowEmptyV1Schema,
  targetAuthorities: protectedMemoryNamespaceAuthoritiesAllowEmptyV1Schema,
  deadlineAt: unixTimestampMs,
}).strict().superRefine((value, context) => {
  const expectedAdded = value.targetNamespaceIds.filter((namespaceId) =>
    !value.currentNamespaceIds.includes(namespaceId)
  );
  const expectedRemoved = value.currentNamespaceIds.filter((namespaceId) =>
    !value.targetNamespaceIds.includes(namespaceId)
  );
  for (const [path, actual, expected] of [
    ["addedNamespaceIds", value.addedNamespaceIds, expectedAdded],
    ["removedNamespaceIds", value.removedNamespaceIds, expectedRemoved],
    ["currentAuthorities", value.currentAuthorities.map((entry) => entry.namespaceId),
      value.currentNamespaceIds],
    ["targetAuthorities", value.targetAuthorities.map((entry) => entry.namespaceId),
      value.targetNamespaceIds],
  ] as const) {
    if (
      actual.length !== expected.length
      || actual.some((namespaceId, index) => namespaceId !== expected[index])
    ) context.addIssue({
      code: "custom",
      message: "exact access plan inventories disagree",
      path: [path],
    });
  }
});

const protectedMemoryAccessUnchangedV1Schema = z.object({
  dtoVersion: z.literal(1),
  status: z.literal("unchanged"),
  memoryId: canonicalLowerUuid,
  cryptoAccessRevision: nonnegativeInteger,
  requiredNamespaceIds: canonicalNamespaceIdsAllowEmptySchema,
}).strict();

export const protectedMemoryAccessReadinessRequiredV1Schema = z.object({
  dtoVersion: z.literal(1),
  status: z.literal("readiness_required"),
  reason: z.literal("target_encryption_not_ready"),
  memoryId: canonicalLowerUuid,
  sourceRoomId: canonicalLowerUuid,
  requiredNamespaceIds: exactRequiredNamespaceIdsSchema,
}).strict();

export const protectedMemoryAccessPlanResponseV1Schema = z.discriminatedUnion("status", [
  protectedMemoryAccessPlanV1Schema,
  protectedMemoryAccessUnchangedV1Schema,
  protectedMemoryAccessReadinessRequiredV1Schema,
]);

export const protectedMemoryPreparedAccessRequestV1Schema = z.object({
  requestVersion: z.literal(1),
  operationId: portableId,
  memoryId: canonicalLowerUuid,
  expectedContentRevision: nonnegativeInteger.min(1),
  expectedCryptoAccessRevision: nonnegativeInteger,
  nextCryptoAccessRevision: nonnegativeInteger.min(1),
  cryptoObjectId: portableId,
  currentNamespaceIds: canonicalNamespaceIdsAllowEmptySchema,
  targetNamespaceIds: canonicalNamespaceIdsAllowEmptySchema,
  accessManifestBytesBase64url: accessManifestBase64url,
  signedAccessRequestBytesBase64url: signedExactAccessRequestBase64url,
  namespaceEnvelopes: exactCanonicalNamespaceEnvelopesAllowEmptySchema,
}).strict().superRefine((value, context) => {
  if (value.nextCryptoAccessRevision !== value.expectedCryptoAccessRevision + 1) {
    context.addIssue({ code: "custom", message: "access revision must advance exactly once", path: ["nextCryptoAccessRevision"] });
  }
  if (!exactCanonicalNamespaceEnvelopeInventory(value.targetNamespaceIds, value.namespaceEnvelopes)) {
    context.addIssue({ code: "custom", message: "access envelopes must match the exact target set", path: ["namespaceEnvelopes"] });
  }
});

const protectedMemoryOrdinaryFallbackReasonV1Schema = z.enum([
  "encryption_pending", "target_encryption_not_ready",
]);

const protectedMemoryAccessUpdatedResponseV1Schema = z.object({
  dtoVersion: z.literal(1),
  status: z.enum(["updated", "replayed"]),
  operationId: portableId,
  memoryId: canonicalLowerUuid,
  cryptoAccessRevision: nonnegativeInteger.min(1),
  requiredNamespaceIds: canonicalNamespaceIdsAllowEmptySchema,
  followUpPending: z.literal(true).optional(),
}).strict();

const protectedMemoryAccessOrdinaryFallbackResponseV1Schema = z.object({
  dtoVersion: z.literal(1), status: z.literal("ordinary_fallback"),
  operationId: portableId, memoryId: canonicalLowerUuid,
  cryptoAccessRevision: nonnegativeInteger,
  requiredNamespaceIds: canonicalNamespaceIdsAllowEmptySchema,
  reason: protectedMemoryOrdinaryFallbackReasonV1Schema,
  followUpPending: z.literal(true).optional(),
}).strict();

export const protectedMemoryAccessUpdateResponseV1Schema =
  z.discriminatedUnion("status", [protectedMemoryAccessUpdatedResponseV1Schema,
    protectedMemoryAccessOrdinaryFallbackResponseV1Schema]);

const pendingPayload = z.object({
  status: z.literal("pending"),
  reason: z.enum(["shadow_pending", "backfill_pending"]),
}).strict();

const unavailablePayload = z.object({
  status: z.literal("unavailable"),
  reason: z.union([protectedMemoryUnavailableReasonSchema, z.enum([
    "unsupported_version",
    "corrupt",
    "lost_key_material",
    "incomplete_access_set",
  ])]),
  cryptoObjectId: portableId.optional(),
}).strict();

/** Browser-safe DTO. Only Fallback Shadow may carry an explicitly ordinary
 * sibling; Strict and Full keep confidential content/type inside ciphertext. */
export const protectedMemoryDtoV1Schema = z.object({
  dtoVersion: z.literal(1),
  ordinaryFallback: z.object({
    policyRevision: nonnegativeInteger.min(1),
    payload: z.object({
      formatVersion: z.literal(1),
      // Mirrors MemoryPayloadV1's byte limits without importing device code.
      type: z.string().min(1).max(256)
        .refine((value) => new TextEncoder().encode(value).length <= 256),
      content: z.string().min(1).max(65_536)
        .refine((value) => new TextEncoder().encode(value).length <= 65_536),
    }).strict(),
  }).strict().optional(),
  readObservationAdmission: z.object({
    tokenBase64url: z.string().length(43).regex(/^[A-Za-z0-9_-]+$/),
    policyRevision: nonnegativeInteger.min(1),
    issuedAt: unixTimestampMs,
    expiresAt: unixTimestampMs,
  }).strict().refine((value) => value.expiresAt > value.issuedAt,
    { message: "Memory read observation admission must have a live interval" }).optional(),
  /** Both Shadow modes compare on device without transporting the ordinary
   * body. Full neither selects that sibling nor emits this digest. */
  shadowComparison: z.object({
    algorithm: z.literal("sha256-memory-payload-v1"),
    digestBase64url: z.string().length(43).regex(/^[A-Za-z0-9_-]+$/),
  }).strict().optional(),
  projection: protectedMemoryProjectionV1Schema,
  protectedPayload: z.discriminatedUnion("status", [
    encryptedPayload,
    pendingPayload,
    unavailablePayload,
  ]),
}).strict().superRefine((value, context) => {
  if (value.protectedPayload.status !== "encrypted") {
    if (value.readObservationAdmission !== undefined) context.addIssue({
      code: "custom", message: "Read observation requires an encrypted source",
      path: ["readObservationAdmission"],
    });
    if (value.shadowComparison !== undefined) context.addIssue({
      code: "custom", message: "Shadow comparison requires an encrypted source",
      path: ["shadowComparison"],
    });
    return;
  }
  if (value.projection.contentRevision < 1) context.addIssue({
    code: "custom", message: "encrypted Memory requires a protected content revision",
    path: ["projection", "contentRevision"],
  });
  if (value.projection.readAuthorities.length === 0) {
    context.addIssue({
      code: "custom",
      message: "encrypted protected Memory requires an authorized read path",
      path: ["projection", "readAuthorities"],
    });
  }
  if (!exactNamespaceEnvelopeSet(
    value.projection.requiredNamespaceIds,
    value.protectedPayload.namespaceEnvelopes,
  )) {
    context.addIssue({
      code: "custom",
      message: "protected Memory Namespace envelopes must exactly match its projection",
      path: ["protectedPayload", "namespaceEnvelopes"],
    });
  }
});

export const protectedMemoryListResponseV1Schema = z.object({
  dtoVersion: z.literal(1),
  items: z.array(protectedMemoryDtoV1Schema).max(256),
  nextCursor: z.string().max(1024).nullable(),
  memoryMode: z.enum(["namespace", "scope"]),
  total: nonnegativeInteger.optional(),
}).strict();

export const protectedMemoryDetailResponseV1Schema = z.object({
  dtoVersion: z.literal(1),
  memory: protectedMemoryDtoV1Schema,
  ordinaryFallbackAuthorization: z.object({
    policyRevision: nonnegativeInteger.min(1),
  }).strict().optional(),
  memoryMode: z.enum(["namespace", "scope"]),
  actionAuthority: z.object({
    canEdit: z.boolean(),
    canArchive: z.boolean(),
    canManageAccess: z.boolean(),
  }).strict(),
}).strict();

export const protectedMemorySearchResponseV1Schema = z.object({
  dtoVersion: z.literal(1),
  items: z.array(z.object({
    memory: protectedMemoryDtoV1Schema,
    score: z.number().finite().min(-1).max(1),
  }).strict()).max(256),
  memoryMode: z.enum(["namespace", "scope"]),
  queryDisclosure: z.literal("embedding_provider"),
}).strict();

/** Encrypted candidates for client-local prompt-brief rendering. */
export const protectedMemoryBriefResponseV1Schema = z.object({
  dtoVersion: z.literal(1),
  items: z.array(protectedMemoryDtoV1Schema).max(64),
  memoryMode: z.enum(["namespace", "scope"]),
}).strict();

export const protectedMemoryUnavailableResponseV1Schema = z.object({
  dtoVersion: z.literal(1),
  status: z.literal("unavailable"),
  reason: protectedMemoryUnavailableReasonSchema,
}).strict();

export const protectedMemoryPreparedUpdateRequestV1Schema = z.object({
  requestVersion: z.literal(1),
  operationId: portableId,
  expectedContentRevision: nonnegativeInteger.min(1),
  nextContentRevision: nonnegativeInteger.min(2),
  cryptoObjectId: portableId,
  payloadVersion: z.literal(1),
  encryptedPayloadBytesBase64url: base64url,
  accessManifestBytesBase64url: base64url,
  requiredNamespaceIds: exactRequiredNamespaceIdsSchema,
  namespaceEnvelopes: exactCanonicalNamespaceEnvelopesSchema,
  signedContentEmbeddingRequestBytesBase64url:
    signedContentEmbeddingRequestBase64url,
}).strict().superRefine((value, context) => {
  if (value.nextContentRevision !== value.expectedContentRevision + 1) {
    context.addIssue({
      code: "custom",
      message: "protected Memory update revision must advance exactly once",
      path: ["nextContentRevision"],
    });
  }
  if (!exactCanonicalNamespaceEnvelopeInventory(
    value.requiredNamespaceIds,
    value.namespaceEnvelopes,
  )) {
    context.addIssue({
      code: "custom",
      message: "protected Memory update envelopes must match its exact authority set",
      path: ["namespaceEnvelopes"],
    });
  }
});

const protectedMemoryPublishedUpdateResponseV1Schema = z.object({
  dtoVersion: z.literal(1),
  status: z.enum(["published", "replayed"]),
  memory: protectedMemoryDtoV1Schema,
  followUpPending: z.literal(true).optional(),
}).strict();

const protectedMemoryOrdinaryFallbackResponseV1Schema = z.object({
  dtoVersion: z.literal(1), status: z.literal("ordinary_fallback"),
  operationId: portableId, memoryId: canonicalLowerUuid,
  contentRevision: nonnegativeInteger.min(1),
  cryptoAccessRevision: nonnegativeInteger,
  reason: protectedMemoryOrdinaryFallbackReasonV1Schema,
  followUpPending: z.literal(true).optional(),
}).strict();

export const protectedMemoryPreparedUpdateResponseV1Schema =
  z.discriminatedUnion("status", [protectedMemoryPublishedUpdateResponseV1Schema,
    protectedMemoryOrdinaryFallbackResponseV1Schema]);

/** Content-free, server-issued coordinates for one exact protected create. */
export const protectedMemoryCreatePlanSlotResponseV1Schema = z.object({
  dtoVersion: z.literal(1),
  memoryId: canonicalLowerUuid,
  operationId: portableId,
  expectedContentRevision: z.literal(0),
  nextContentRevision: z.literal(1),
  productAuthority: protectedMemoryProductAuthoritySchema,
  requiredNamespaceIds: exactRequiredNamespaceIdsSchema,
  targetAuthorities: protectedMemoryNamespaceAuthoritiesV1Schema,
  ordinaryFallbackAuthorization: z.object({
    policyRevision: nonnegativeInteger.min(1),
  }).strict().optional(),
  issuedAt: unixTimestampMs.optional(),
  deadlineAt: unixTimestampMs,
}).strict().superRefine((value, context) => {
  if (
    value.productAuthority.mode === "scope"
    && (value.requiredNamespaceIds.length !== 1
      || value.requiredNamespaceIds[0]
        !== value.productAuthority.originWritableNamespaceId)
  ) {
    context.addIssue({
      code: "custom",
      message: "scope Memory create must use its exact origin Namespace",
      path: ["requiredNamespaceIds"],
    });
  }
  if (
    value.targetAuthorities.length !== value.requiredNamespaceIds.length
    || value.targetAuthorities.some((entry, index) =>
      entry.namespaceId !== value.requiredNamespaceIds[index]
    )
  ) context.addIssue({
    code: "custom",
    message: "create authority must cover the exact audience",
    path: ["targetAuthorities"],
  });
  if (value.ordinaryFallbackAuthorization !== undefined
    && value.issuedAt === undefined) context.addIssue({
    code: "custom",
    message: "fallback-authorized create plan must include its issue time",
    path: ["issuedAt"],
  });
});

export const protectedMemoryOrdinaryFallbackCreatePlanV1Schema = z.object({
  dtoVersion: z.literal(1),
  status: z.literal("ordinary_fallback_ready"),
  reason: z.literal("target_encryption_not_ready"),
  memoryId: canonicalLowerUuid,
  operationId: portableId,
  expectedContentRevision: z.literal(0),
  nextContentRevision: z.literal(1),
  expectedCryptoAccessRevision: z.literal(0),
  productAuthority: protectedMemoryProductAuthoritySchema,
  requiredNamespaceIds: exactRequiredNamespaceIdsSchema,
  ordinaryFallbackAuthorization: z.object({
    policyRevision: nonnegativeInteger.min(1),
  }).strict(),
  issuedAt: unixTimestampMs,
  deadlineAt: unixTimestampMs,
}).strict().superRefine((value, context) => {
  if (value.deadlineAt <= value.issuedAt) context.addIssue({
    code: "custom", message: "ordinary fallback create plan deadline is invalid",
    path: ["deadlineAt"],
  });
});

/** Browser-safe create publication; plaintext exists only in the signed blob. */
export const protectedMemoryPreparedCreateRequestV1Schema = z.object({
  requestVersion: z.literal(1),
  memoryId: canonicalLowerUuid,
  operationId: portableId,
  expectedContentRevision: z.literal(0),
  nextContentRevision: z.literal(1),
  cryptoObjectId: portableId,
  payloadVersion: z.literal(1),
  encryptedPayloadBytesBase64url: base64url,
  accessManifestBytesBase64url: base64url,
  requiredNamespaceIds: exactRequiredNamespaceIdsSchema,
  namespaceEnvelopes: exactCanonicalNamespaceEnvelopesSchema,
  signedContentEmbeddingRequestBytesBase64url:
    signedContentEmbeddingRequestBase64url,
}).strict().superRefine((value, context) => {
  if (!exactCanonicalNamespaceEnvelopeInventory(
    value.requiredNamespaceIds,
    value.namespaceEnvelopes,
  )) {
    context.addIssue({
      code: "custom",
      message: "protected Memory create envelopes must match its canonical exact authority set",
      path: ["namespaceEnvelopes"],
    });
  }
});

const protectedMemoryOrdinaryFallbackRequestBaseV1Schema = z.object({
  requestVersion: z.literal(1),
  publicationKind: z.literal("ordinary_fallback"),
  reason: z.literal("target_encryption_not_ready"),
  memoryId: canonicalLowerUuid,
  operationId: portableId,
  expectedContentRevision: nonnegativeInteger,
  nextContentRevision: nonnegativeInteger.min(1),
  expectedCryptoAccessRevision: nonnegativeInteger,
  requiredNamespaceIds: exactRequiredNamespaceIdsSchema,
  signedOrdinaryFallbackRequestBytesBase64url: signedContentEmbeddingRequestBase64url,
}).strict();

export const protectedMemoryOrdinaryFallbackCreateRequestV1Schema =
  protectedMemoryOrdinaryFallbackRequestBaseV1Schema.extend({
    expectedContentRevision: z.literal(0), nextContentRevision: z.literal(1),
    expectedCryptoAccessRevision: z.literal(0),
  }).strict();

export const protectedMemoryOrdinaryFallbackUpdateRequestV1Schema =
  protectedMemoryOrdinaryFallbackRequestBaseV1Schema.superRefine((value, context) => {
    if (value.nextContentRevision !== value.expectedContentRevision + 1) {
      context.addIssue({ code: "custom",
        message: "ordinary fallback update revision must advance exactly once",
        path: ["nextContentRevision"] });
    }
  });

export const protectedMemorySubmittedCreateRequestV1Schema = z.union([
  protectedMemoryPreparedCreateRequestV1Schema,
  protectedMemoryOrdinaryFallbackCreateRequestV1Schema,
]);

export const protectedMemorySubmittedUpdateRequestV1Schema = z.union([
  protectedMemoryPreparedUpdateRequestV1Schema,
  protectedMemoryOrdinaryFallbackUpdateRequestV1Schema,
]);

const protectedMemoryMetadataMutationBaseV1Schema = z.object({
  requestVersion: z.literal(1),
  operationId: portableId,
  expectedContentRevision: nonnegativeInteger.min(1),
  expectedCryptoAccessRevision: nonnegativeInteger,
});

/** Content-free exact archive transition for one protected Memory revision. */
export const protectedMemoryArchiveRequestV1Schema =
  protectedMemoryMetadataMutationBaseV1Schema.extend({
    expectedTier: z.union([z.literal(1), z.literal(2)]),
  }).strict();

/** Content-free exact adjacent tier transition; arbitrary tier setting is forbidden. */
export const protectedMemoryTierTransitionRequestV1Schema =
  protectedMemoryMetadataMutationBaseV1Schema.extend({
    action: z.enum(["promote", "demote"]),
    expectedTier: z.union([z.literal(1), z.literal(2)]),
    nextTier: z.union([z.literal(1), z.literal(2), z.literal(3)]),
  }).strict().superRefine((value, context) => {
    const valid = value.action === "promote"
      ? value.expectedTier === 2 && value.nextTier === 1
      : (value.expectedTier === 1 && value.nextTier === 2)
        || (value.expectedTier === 2 && value.nextTier === 3);
    if (!valid) context.addIssue({
      code: "custom",
      message: "protected Memory tier transition must be an exact adjacent policy transition",
      path: ["nextTier"],
    });
  });

/** Content-free restore from archive to the exact retained prior tier. */
export const protectedMemoryRestoreRequestV1Schema =
  protectedMemoryMetadataMutationBaseV1Schema.extend({
    expectedTier: z.literal(3),
    nextTier: z.union([z.literal(1), z.literal(2)]),
  }).strict();

const protectedMemoryMetadataReceiptBaseV1Schema = z.object({
  dtoVersion: z.literal(1),
  operationId: portableId,
  memoryId: canonicalLowerUuid,
  contentRevision: nonnegativeInteger.min(1),
  cryptoAccessRevision: nonnegativeInteger,
  followUpPending: z.literal(true).optional(),
});

export const protectedMemoryArchiveResponseV1Schema =
  protectedMemoryMetadataReceiptBaseV1Schema.extend({
    status: z.enum(["archived", "replayed"]),
    tier: z.literal(3),
  }).strict();

export const protectedMemoryTierTransitionResponseV1Schema =
  protectedMemoryMetadataReceiptBaseV1Schema.extend({
    status: z.enum(["promoted", "demoted", "replayed"]),
    previousTier: z.union([z.literal(1), z.literal(2)]),
    nextTier: z.union([z.literal(1), z.literal(2), z.literal(3)]),
  }).strict().superRefine((value, context) => {
    const valid = value.status === "replayed"
      || (value.status === "promoted"
        && value.previousTier === 2
        && value.nextTier === 1)
      || (value.status === "demoted"
        && ((value.previousTier === 1 && value.nextTier === 2)
          || (value.previousTier === 2 && value.nextTier === 3)));
    if (!valid) context.addIssue({
      code: "custom",
      message: "protected Memory tier receipt is incoherent",
      path: ["nextTier"],
    });
  });

export const protectedMemoryRestoreResponseV1Schema =
  protectedMemoryMetadataReceiptBaseV1Schema.extend({
    status: z.enum(["restored", "replayed"]),
    previousTier: z.literal(3),
    nextTier: z.union([z.literal(1), z.literal(2)]),
  }).strict();

export type ProtectedMemoryProjectionV1 = z.infer<
  typeof protectedMemoryProjectionV1Schema
>;
export type ProtectedMemoryDtoV1 = z.infer<typeof protectedMemoryDtoV1Schema>;
export type ProtectedMemoryListResponseV1 = z.infer<
  typeof protectedMemoryListResponseV1Schema
>;
export type ProtectedMemoryDetailResponseV1 = z.infer<
  typeof protectedMemoryDetailResponseV1Schema
>;
export type ProtectedMemorySearchResponseV1 = z.infer<
  typeof protectedMemorySearchResponseV1Schema
>;
export type ProtectedMemoryBriefResponseV1 = z.infer<
  typeof protectedMemoryBriefResponseV1Schema
>;
export type ProtectedMemoryUnavailableResponseV1 = z.infer<
  typeof protectedMemoryUnavailableResponseV1Schema
>;
export type ProtectedMemoryPreparedUpdateRequestV1 = z.infer<
  typeof protectedMemoryPreparedUpdateRequestV1Schema
>;
export type ProtectedMemoryOrdinaryFallbackUpdateRequestV1 = z.infer<
  typeof protectedMemoryOrdinaryFallbackUpdateRequestV1Schema
>;
export type ProtectedMemorySubmittedUpdateRequestV1 = z.infer<
  typeof protectedMemorySubmittedUpdateRequestV1Schema
>;
export type ProtectedMemoryPreparedUpdateResponseV1 = z.infer<
  typeof protectedMemoryPreparedUpdateResponseV1Schema
>;
export type ProtectedMemoryCreatePlanSlotResponseV1 = z.infer<
  typeof protectedMemoryCreatePlanSlotResponseV1Schema
>;
export type ProtectedMemoryOrdinaryFallbackCreatePlanV1 = z.infer<
  typeof protectedMemoryOrdinaryFallbackCreatePlanV1Schema
>;
export type ProtectedMemoryCreatePlanResponseV1 =
  | ProtectedMemoryCreatePlanSlotResponseV1
  | ProtectedMemoryOrdinaryFallbackCreatePlanV1;
export type ProtectedMemoryPreparedCreateRequestV1 = z.infer<
  typeof protectedMemoryPreparedCreateRequestV1Schema
>;
export type ProtectedMemoryOrdinaryFallbackCreateRequestV1 = z.infer<
  typeof protectedMemoryOrdinaryFallbackCreateRequestV1Schema
>;
export type ProtectedMemorySubmittedCreateRequestV1 = z.infer<
  typeof protectedMemorySubmittedCreateRequestV1Schema
>;
export type ProtectedMemoryArchiveRequestV1 = z.infer<
  typeof protectedMemoryArchiveRequestV1Schema
>;
export type ProtectedMemoryTierTransitionRequestV1 = z.infer<
  typeof protectedMemoryTierTransitionRequestV1Schema
>;
export type ProtectedMemoryRestoreRequestV1 = z.infer<
  typeof protectedMemoryRestoreRequestV1Schema
>;
export type ProtectedMemoryArchiveResponseV1 = z.infer<
  typeof protectedMemoryArchiveResponseV1Schema
>;
export type ProtectedMemoryTierTransitionResponseV1 = z.infer<
  typeof protectedMemoryTierTransitionResponseV1Schema
>;
export type ProtectedMemoryRestoreResponseV1 = z.infer<
  typeof protectedMemoryRestoreResponseV1Schema
>;
export type ProtectedMemoryAccessOperationV1 = z.infer<
  typeof protectedMemoryAccessOperationV1Schema
>;
export type ProtectedMemoryAccessPlanRequestV1 = z.infer<
  typeof protectedMemoryAccessPlanRequestV1Schema
>;
export type ProtectedMemoryAccessPlanResponseV1 = z.infer<
  typeof protectedMemoryAccessPlanResponseV1Schema
>;
export type ProtectedMemoryPreparedAccessRequestV1 = z.infer<
  typeof protectedMemoryPreparedAccessRequestV1Schema
>;
export type ProtectedMemoryAccessUpdateResponseV1 = z.infer<
  typeof protectedMemoryAccessUpdateResponseV1Schema
>;
