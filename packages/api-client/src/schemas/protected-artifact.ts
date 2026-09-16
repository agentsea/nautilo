import { z } from "zod";
import {
  protectedObjectAccessSignerEvidenceSetV1Schema,
} from "./protected-object-access.ts";

const uuid = z.string().uuid();
const portableId = z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._:@/-]*$/u);
const counter = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const positiveCounter = counter.min(1);
const digestBase64url = z.string().length(43).regex(/^[A-Za-z0-9_-]+$/u);
const bytesBase64url = z.string().min(1).max(349_526).regex(/^[A-Za-z0-9_-]+$/u);
const signedPublicationBase64url = z.string().min(1).max(349_526).regex(/^[A-Za-z0-9_-]+$/u);
const objectId = z.string().min(1).max(128);

export const protectedArtifactOperationV1Schema = z.enum([
  "create",
  "replace_content",
  "revise_control",
]);
export const protectedArtifactLifecycleActionV1Schema = z.enum(["activate", "archive"]);
export const protectedArtifactMimeClassV1Schema = z.enum([
  "text", "image", "audio", "video", "document", "archive", "binary",
]);
export const protectedArtifactSizeBucketV1Schema = z.enum([
  "empty", "le_64_kib", "le_1_mib", "le_10_mib", "le_100_mib",
]);

export const protectedArtifactUnavailableResponseV1Schema = z.object({
  dtoVersion: z.literal(1),
  status: z.literal("unavailable"),
  reason: z.enum([
    "authorization_required",
    "target_encryption_not_ready",
    "encryption_pending",
    "stale_revision",
    "integrity_failure",
    "storage_unavailable",
    "journal_full",
  ]),
}).strict();

export const protectedArtifactPublicationPlanRequestV1Schema = z.object({
  requestVersion: z.literal(1),
  operation: protectedArtifactOperationV1Schema,
  lifecycleAction: protectedArtifactLifecycleActionV1Schema,
  artifactId: uuid.nullable(),
  anchorNamespaceId: uuid,
  expectedArtifactRevision: counter,
  expectedCryptoAccessRevision: counter,
  expectedBlobGeneration: counter,
  expectedBlobId: uuid.nullable(),
  mimeClass: protectedArtifactMimeClassV1Schema,
  sizeBucket: protectedArtifactSizeBucketV1Schema,
}).strict().superRefine((value, context) => {
  const create = value.operation === "create";
  if (value.operation !== "revise_control" && value.lifecycleAction !== "activate") {
    context.addIssue({ code: "custom", message: "content publication must activate", path: ["lifecycleAction"] });
  }
  if (create !== (value.artifactId === null)) {
    context.addIssue({ code: "custom", message: "create alone omits Artifact ID", path: ["artifactId"] });
  }
  if (create && (
    value.expectedArtifactRevision !== 0
    || value.expectedCryptoAccessRevision !== 0
    || value.expectedBlobGeneration !== 0
    || value.expectedBlobId !== null
  )) context.addIssue({ code: "custom", message: "create expectations must be zero", path: ["operation"] });
  if (!create && (
    value.expectedArtifactRevision < 1
    || value.expectedBlobGeneration < 1
    || value.expectedBlobId === null
  )) context.addIssue({ code: "custom", message: "update expectations are incomplete", path: ["operation"] });
});

const bindingSchema = z.object({
  namespaceId: uuid,
  domainId: portableId,
  expectedAccessRevision: counter,
  expectedPolicyRevision: counter,
  bindingHashBase64url: digestBase64url,
}).strict();

function canonicalIds(
  ids: readonly string[],
  context: z.RefinementCtx,
  path: PropertyKey,
  allowEmpty: boolean,
): void {
  if ((!allowEmpty && ids.length === 0) || ids.length > 256) {
    context.addIssue({ code: "custom", message: "Namespace inventory is not bounded", path: [path] });
    return;
  }
  if (ids.some((id, index) => index > 0 && ids[index - 1]! >= id)) {
    context.addIssue({ code: "custom", message: "Namespace inventory must be unique and sorted", path: [path] });
  }
}

const plannedSchema = z.object({
  dtoVersion: z.literal(1),
  status: z.literal("planned"),
  planVersion: z.literal(1),
  operationId: portableId,
  planDigestBase64url: digestBase64url,
  operation: protectedArtifactOperationV1Schema,
  lifecycleAction: protectedArtifactLifecycleActionV1Schema,
  artifactRowId: uuid,
  artifactId: uuid,
  anchorNamespaceId: uuid,
  cryptoObjectId: objectId,
  expectedArtifactRevision: counter,
  nextArtifactRevision: positiveCounter,
  expectedCryptoAccessRevision: counter,
  resultCryptoAccessRevision: z.literal(0),
  expectedBlobGeneration: counter,
  resultBlobGeneration: positiveCounter,
  expectedBlobId: uuid.nullable(),
  resultBlobId: uuid,
  requiredNamespaceIds: z.array(uuid).min(1).max(256),
  bindings: z.array(bindingSchema).min(1).max(256),
  maxPlaintextBytes: positiveCounter,
  maxCiphertextBytes: positiveCounter,
  chunkPlaintextBytes: z.literal(1_048_576),
  mimeClass: protectedArtifactMimeClassV1Schema,
  sizeBucket: protectedArtifactSizeBucketV1Schema,
  deadlineAt: positiveCounter,
}).strict().superRefine((value, context) => {
  canonicalIds(value.requiredNamespaceIds, context, "requiredNamespaceIds", false);
  if (
    value.nextArtifactRevision !== value.expectedArtifactRevision + 1
    || value.bindings.length !== value.requiredNamespaceIds.length
    || value.bindings.some((binding, index) => binding.namespaceId !== value.requiredNamespaceIds[index])
  ) context.addIssue({ code: "custom", message: "Artifact plan coordinates are incoherent", path: ["bindings"] });
  const content = value.operation === "replace_content";
  const control = value.operation === "revise_control";
  if (content && (
    value.resultBlobGeneration !== value.expectedBlobGeneration + 1
    || value.expectedBlobId === value.resultBlobId
  )) context.addIssue({ code: "custom", message: "content replacement must allocate a fresh blob", path: ["resultBlobId"] });
  if (control && (
    value.resultBlobGeneration !== value.expectedBlobGeneration
    || value.expectedBlobId !== value.resultBlobId
  )) context.addIssue({ code: "custom", message: "control revision must retain the blob", path: ["resultBlobId"] });
});

export const protectedArtifactPublicationPlanResponseV1Schema = z.union([
  plannedSchema,
  protectedArtifactUnavailableResponseV1Schema,
]);

const envelopeSchema = z.object({
  namespaceId: uuid,
  envelopeBytesBase64url: bytesBase64url,
}).strict();

export const protectedArtifactPreparedPublicationRequestV1Schema = z.object({
  requestVersion: z.literal(1),
  operationId: portableId,
  planDigestBase64url: digestBase64url,
  operation: protectedArtifactOperationV1Schema,
  lifecycleAction: protectedArtifactLifecycleActionV1Schema,
  artifactRowId: uuid,
  artifactId: uuid,
  anchorNamespaceId: uuid,
  cryptoObjectId: objectId,
  expectedArtifactRevision: counter,
  nextArtifactRevision: positiveCounter,
  expectedCryptoAccessRevision: counter,
  resultCryptoAccessRevision: z.literal(0),
  expectedBlobGeneration: counter,
  resultBlobGeneration: positiveCounter,
  expectedBlobId: uuid.nullable(),
  resultBlobId: uuid,
  requiredNamespaceIds: z.array(uuid).min(1).max(256),
  encryptedControlPayloadBytesBase64url: bytesBase64url,
  accessManifestBytesBase64url: bytesBase64url,
  namespaceEnvelopes: z.array(envelopeSchema).min(1).max(256),
  signedPublicationRequestBytesBase64url: signedPublicationBase64url,
  ciphertextLength: positiveCounter,
  ciphertextSha256Base64url: digestBase64url,
  chunkPlaintextBytes: z.literal(1_048_576),
  chunkCount: positiveCounter.max(100),
  mimeClass: protectedArtifactMimeClassV1Schema,
  sizeBucket: protectedArtifactSizeBucketV1Schema,
}).strict().superRefine((value, context) => {
  canonicalIds(value.requiredNamespaceIds, context, "requiredNamespaceIds", false);
  if (
    value.nextArtifactRevision !== value.expectedArtifactRevision + 1
    || value.namespaceEnvelopes.length !== value.requiredNamespaceIds.length
    || value.namespaceEnvelopes.some((entry, index) => entry.namespaceId !== value.requiredNamespaceIds[index])
  ) context.addIssue({ code: "custom", message: "prepared Artifact audience is incoherent", path: ["namespaceEnvelopes"] });
});

export const protectedArtifactPublicationResponseV1Schema = z.object({
  dtoVersion: z.literal(1),
  status: z.enum(["published", "replayed"]),
  operationId: portableId,
  artifactId: uuid,
  artifactRevision: positiveCounter,
  cryptoAccessRevision: counter,
  blobId: uuid,
  blobGeneration: positiveCounter,
  requiredNamespaceIds: z.array(uuid).min(1).max(256),
}).strict().superRefine((value, context) => {
  canonicalIds(value.requiredNamespaceIds, context, "requiredNamespaceIds", false);
});

export const protectedArtifactCiphertextStageResponseV1Schema = z.object({
  dtoVersion: z.literal(1),
  status: z.enum(["staged", "replayed"]),
  operationId: portableId,
  artifactId: uuid,
  blobId: uuid,
  blobGeneration: positiveCounter,
  ciphertextLength: positiveCounter,
  ciphertextSha256Base64url: digestBase64url,
}).strict();

export const protectedArtifactDtoV1Schema = z.object({
  dtoVersion: z.literal(1),
  status: z.literal("encrypted"),
  artifactId: uuid,
  artifactRevision: positiveCounter,
  cryptoObjectId: objectId,
  cryptoAccessRevision: counter,
  requiredNamespaceIds: z.array(uuid).min(1).max(256),
  encryptedControlPayloadBytesBase64url: bytesBase64url,
  accessManifestBytesBase64url: bytesBase64url,
  accessManifestProofBytesBase64url: z.array(bytesBase64url).max(256),
  accessSignerEvidence: protectedObjectAccessSignerEvidenceSetV1Schema,
  namespaceEnvelopes: z.array(envelopeSchema).min(1).max(256),
  blobId: uuid,
  blobGeneration: positiveCounter,
  ciphertextLength: positiveCounter,
  ciphertextSha256Base64url: digestBase64url,
  chunkPlaintextBytes: z.literal(1_048_576),
  chunkCount: positiveCounter.max(100),
  mimeClass: protectedArtifactMimeClassV1Schema,
  sizeBucket: protectedArtifactSizeBucketV1Schema,
  archived: z.boolean(),
  canManageAccess: z.boolean(),
}).strict().superRefine((value, context) => {
  canonicalIds(value.requiredNamespaceIds, context, "requiredNamespaceIds", false);
  if (
    value.namespaceEnvelopes.length !== value.requiredNamespaceIds.length
    || value.namespaceEnvelopes.some((entry, index) => entry.namespaceId !== value.requiredNamespaceIds[index])
  ) context.addIssue({ code: "custom", message: "protected Artifact envelope inventory is not exact", path: ["namespaceEnvelopes"] });
});

export const protectedArtifactListResponseV1Schema = z.object({
  dtoVersion: z.literal(1),
  items: z.array(protectedArtifactDtoV1Schema).max(100),
  nextCursor: z.string().min(1).max(512).nullable(),
}).strict();

export const protectedArtifactAccessOperationV1Schema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("grant_room"), roomId: uuid }).strict(),
  z.object({ kind: z.literal("grant_user"), userHandle: z.string().min(1).max(128) }).strict(),
  z.object({ kind: z.literal("revoke_user"), userHandle: z.string().min(1).max(128) }).strict(),
  z.object({ kind: z.literal("make_private") }).strict(),
  z.object({ kind: z.literal("delete_authorized_view") }).strict(),
]);

export const protectedArtifactAccessPlanRequestV1Schema = z.object({
  requestVersion: z.literal(1),
  operation: protectedArtifactAccessOperationV1Schema,
}).strict();

const namespaceIdsAllowEmpty = z.array(uuid).max(256).superRefine(
  (ids, context) => canonicalIds(ids, context, "namespaceIds", true),
);
const accessBindings = z.array(bindingSchema).max(256).superRefine(
  (bindings, context) => canonicalIds(
    bindings.map((binding) => binding.namespaceId),
    context,
    "bindings",
    true,
  ),
);

const protectedArtifactAccessPlanV1Schema = z.object({
  dtoVersion: z.literal(1),
  status: z.literal("planned"),
  planVersion: z.literal(1),
  operationId: portableId,
  artifactId: uuid,
  artifactRevision: positiveCounter,
  expectedCryptoAccessRevision: counter,
  nextCryptoAccessRevision: positiveCounter,
  cryptoObjectId: objectId,
  blobId: uuid,
  blobGeneration: positiveCounter,
  currentNamespaceIds: namespaceIdsAllowEmpty,
  targetNamespaceIds: namespaceIdsAllowEmpty,
  addedNamespaceIds: namespaceIdsAllowEmpty,
  removedNamespaceIds: namespaceIdsAllowEmpty,
  currentBindings: accessBindings,
  targetBindings: accessBindings,
  sourceAuthorized: z.literal(true),
  targetAuthorized: z.literal(true),
  deadlineAt: positiveCounter,
}).strict().superRefine((value, context) => {
  if (
    value.nextCryptoAccessRevision !== value.expectedCryptoAccessRevision + 1
    || value.currentBindings.length !== value.currentNamespaceIds.length
    || value.targetBindings.length !== value.targetNamespaceIds.length
    || value.currentBindings.some((binding, index) =>
      binding.namespaceId !== value.currentNamespaceIds[index]
    )
    || value.targetBindings.some((binding, index) =>
      binding.namespaceId !== value.targetNamespaceIds[index]
    )
  ) context.addIssue({ code: "custom", message: "Artifact access plan is inexact" });
});

const protectedArtifactAccessUnchangedV1Schema = z.object({
  dtoVersion: z.literal(1),
  status: z.literal("unchanged"),
  artifactId: uuid,
  cryptoAccessRevision: counter,
  requiredNamespaceIds: namespaceIdsAllowEmpty,
}).strict();

export const protectedArtifactAccessPlanResponseV1Schema = z.discriminatedUnion(
  "status",
  [protectedArtifactAccessPlanV1Schema, protectedArtifactAccessUnchangedV1Schema,
    protectedArtifactUnavailableResponseV1Schema],
);

export const protectedArtifactPreparedAccessRequestV1Schema = z.object({
  requestVersion: z.literal(1),
  operationId: portableId,
  artifactId: uuid,
  artifactRevision: positiveCounter,
  expectedCryptoAccessRevision: counter,
  nextCryptoAccessRevision: positiveCounter,
  cryptoObjectId: objectId,
  blobId: uuid,
  blobGeneration: positiveCounter,
  currentNamespaceIds: namespaceIdsAllowEmpty,
  targetNamespaceIds: namespaceIdsAllowEmpty,
  accessManifestBytesBase64url: bytesBase64url,
  signedAccessRequestBytesBase64url: signedPublicationBase64url,
  namespaceEnvelopes: z.array(envelopeSchema).max(256),
}).strict().superRefine((value, context) => {
  if (
    value.nextCryptoAccessRevision !== value.expectedCryptoAccessRevision + 1
    || value.namespaceEnvelopes.length !== value.targetNamespaceIds.length
    || value.namespaceEnvelopes.some((entry, index) =>
      entry.namespaceId !== value.targetNamespaceIds[index]
    )
  ) context.addIssue({ code: "custom", message: "Artifact access preparation is inexact" });
});

export const protectedArtifactAccessUpdateResponseV1Schema = z.object({
  dtoVersion: z.literal(1),
  status: z.enum(["updated", "replayed"]),
  operationId: portableId,
  artifactId: uuid,
  cryptoAccessRevision: positiveCounter,
  requiredNamespaceIds: namespaceIdsAllowEmpty,
}).strict();

export type ProtectedArtifactOperationV1 = z.infer<typeof protectedArtifactOperationV1Schema>;
export type ProtectedArtifactLifecycleActionV1 = z.infer<typeof protectedArtifactLifecycleActionV1Schema>;
export type ProtectedArtifactMimeClassV1 = z.infer<typeof protectedArtifactMimeClassV1Schema>;
export type ProtectedArtifactSizeBucketV1 = z.infer<typeof protectedArtifactSizeBucketV1Schema>;
export type ProtectedArtifactUnavailableResponseV1 = z.infer<typeof protectedArtifactUnavailableResponseV1Schema>;
export type ProtectedArtifactPublicationPlanRequestV1 = z.infer<typeof protectedArtifactPublicationPlanRequestV1Schema>;
export type ProtectedArtifactPublicationPlanResponseV1 = z.infer<typeof protectedArtifactPublicationPlanResponseV1Schema>;
export type ProtectedArtifactPreparedPublicationRequestV1 = z.infer<typeof protectedArtifactPreparedPublicationRequestV1Schema>;
export type ProtectedArtifactPublicationResponseV1 = z.infer<typeof protectedArtifactPublicationResponseV1Schema>;
export type ProtectedArtifactCiphertextStageResponseV1 = z.infer<typeof protectedArtifactCiphertextStageResponseV1Schema>;
export type ProtectedArtifactDtoV1 = z.infer<typeof protectedArtifactDtoV1Schema>;
export type ProtectedArtifactListResponseV1 = z.infer<typeof protectedArtifactListResponseV1Schema>;
export type ProtectedArtifactAccessOperationV1 = z.infer<typeof protectedArtifactAccessOperationV1Schema>;
export type ProtectedArtifactAccessPlanRequestV1 = z.infer<typeof protectedArtifactAccessPlanRequestV1Schema>;
export type ProtectedArtifactAccessPlanResponseV1 = z.infer<typeof protectedArtifactAccessPlanResponseV1Schema>;
export type ProtectedArtifactPreparedAccessRequestV1 = z.infer<typeof protectedArtifactPreparedAccessRequestV1Schema>;
export type ProtectedArtifactAccessUpdateResponseV1 = z.infer<typeof protectedArtifactAccessUpdateResponseV1Schema>;

export interface ProtectedArtifactCiphertextRangeV1 {
  readonly status: "encrypted_chunks";
  readonly artifactId: string;
  readonly artifactRevision: number;
  readonly cryptoAccessRevision: number;
  readonly blobId: string;
  readonly blobGeneration: number;
  readonly plaintextLength: number;
  readonly ciphertextLength: number;
  readonly ciphertextSha256Base64url: string;
  readonly chunkPlaintextBytes: 1_048_576;
  readonly chunkCount: number;
  readonly firstChunkIndex: number;
  readonly returnedChunkCount: number;
  readonly body: Uint8Array;
}
