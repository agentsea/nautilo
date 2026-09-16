import { z } from "zod";
import {
  protectedMemoryCreatePlanSlotResponseV1Schema,
  protectedMemoryDtoV1Schema,
  protectedMemoryPreparedCreateRequestV1Schema,
  protectedMemoryUnavailableResponseV1Schema,
} from "./protected-memory";

const createPlan = protectedMemoryCreatePlanSlotResponseV1Schema.shape;
const preparedCreate = protectedMemoryPreparedCreateRequestV1Schema.shape;
const revision = z.number().int().min(0).max(2_147_483_647);
const digest = z.string().length(43).regex(/^[A-Za-z0-9_-]+$/);
const bytes = new TextEncoder();
export const protectedMemoryRepairPlanRequestV1Schema = z.object({ requestVersion: z.literal(1) }).strict();
// The existing MemoryPayloadV1 contract, not another content format.
const memoryRepairPayloadV1Schema = z.object({
  formatVersion: z.literal(1),
  type: z.string().min(1).max(256).refine((value) => bytes.encode(value).length <= 256),
  content: z.string().min(1).max(65_536).refine((value) => bytes.encode(value).length <= 65_536),
}).strict();

const planCoordinates = {
  dtoVersion: z.literal(1),
  status: z.literal("planned"),
  mode: z.literal("shadow_encryption"),
  shadowBehavior: z.enum(["fallback", "strict"]),
  policyRevision: revision.min(1),
  memoryId: createPlan.memoryId,
  operationId: createPlan.operationId,
  expectedContentRevision: revision,
  targetContentRevision: revision.min(1),
  expectedCryptoAccessRevision: revision,
  cryptoObjectId: preparedCreate.cryptoObjectId,
  requiredNamespaceIds: createPlan.requiredNamespaceIds,
  requiredNamespaceFingerprintBase64url: digest,
  targetAuthorities: createPlan.targetAuthorities,
  createdAt: createPlan.deadlineAt,
  deadlineAt: createPlan.deadlineAt,
};

/** Repair input is never a successful library row. In Strict it may only be
 * consumed inside device crypto; the normal protected read supplies display. */
export const protectedMemoryRepairPlanV1Schema = z.discriminatedUnion("direction", [
  z.object({ ...planCoordinates, direction: z.literal("ordinary_to_protected"),
    repairInput: memoryRepairPayloadV1Schema }).strict(),
  z.object({ ...planCoordinates, direction: z.literal("protected_to_ordinary"),
    repairInput: protectedMemoryDtoV1Schema }).strict(),
]).superRefine((value, context) => {
  // A forward repair may reuse a higher reserved crypto revision after an
  // abandoned attempt. The source revision remains separately bound; reverse
  // repair must use the already published revision without allocating one.
  const validTargetRevision = value.direction === "ordinary_to_protected"
    ? value.targetContentRevision >= Math.max(1, value.expectedContentRevision)
    : value.targetContentRevision === value.expectedContentRevision;
  if (!validTargetRevision
    || value.requiredNamespaceIds.length !== value.targetAuthorities.length
    || value.requiredNamespaceIds.some((id, index) => id !== value.targetAuthorities[index]?.namespaceId)) {
    context.addIssue({ code: "custom", message: "Repair must preserve the exact source revision and audience" });
  }
  if (value.direction === "protected_to_ordinary") {
    const dto = value.repairInput;
    if (dto.projection.memoryId !== value.memoryId
      || dto.projection.contentRevision !== value.expectedContentRevision
      || dto.projection.cryptoAccessRevision !== value.expectedCryptoAccessRevision
      || dto.protectedPayload.status !== "encrypted"
      || dto.protectedPayload.cryptoObjectId !== value.cryptoObjectId
      || dto.projection.requiredNamespaceIds.length !== value.requiredNamespaceIds.length
      || dto.projection.requiredNamespaceIds.some((id, index) => id !== value.requiredNamespaceIds[index])) {
      context.addIssue({ code: "custom", message: "Reverse repair requires the exact protected source" });
    }
  }
});

export const protectedMemoryRepairPlanResponseV1Schema = z.union([
  protectedMemoryRepairPlanV1Schema,
  z.object({ dtoVersion: z.literal(1), status: z.literal("not_needed"),
    memoryId: createPlan.memoryId }).strict(),
  protectedMemoryUnavailableResponseV1Schema,
]);

const preparedCoordinates = {
  requestVersion: z.literal(1),
  memoryId: createPlan.memoryId,
  operationId: createPlan.operationId,
  // Same bounded signed-operation transport as Human exact-access requests.
  signedRepairAttestationBytesBase64url: z.string().min(1).max(349_526)
    .regex(/^[A-Za-z0-9_-]+$/).refine((value) => value.length % 4 !== 1),
};
export const protectedMemoryPreparedRepairRequestV1Schema = z.discriminatedUnion("direction", [
  z.object({ ...preparedCoordinates, direction: z.literal("ordinary_to_protected"),
    encryptedPayloadBytesBase64url: preparedCreate.encryptedPayloadBytesBase64url,
    accessManifestBytesBase64url: preparedCreate.accessManifestBytesBase64url,
    namespaceEnvelopes: preparedCreate.namespaceEnvelopes }).strict(),
  z.object({ ...preparedCoordinates, direction: z.literal("protected_to_ordinary"),
    payload: memoryRepairPayloadV1Schema }).strict(),
]);
export const protectedMemoryRepairResponseV1Schema = z.union([
  z.object({ dtoVersion: z.literal(1), status: z.enum(["repaired", "replayed"]),
    memoryId: createPlan.memoryId, operationId: createPlan.operationId,
    direction: z.enum(["ordinary_to_protected", "protected_to_ordinary"]),
    contentRevision: revision.min(1), cryptoAccessRevision: revision }).strict(),
  protectedMemoryUnavailableResponseV1Schema,
]);

export type ProtectedMemoryRepairPlanV1 = z.infer<typeof protectedMemoryRepairPlanV1Schema>;
export type ProtectedMemoryRepairPlanResponseV1 = z.infer<typeof protectedMemoryRepairPlanResponseV1Schema>;
export type ProtectedMemoryPreparedRepairRequestV1 = z.infer<typeof protectedMemoryPreparedRepairRequestV1Schema>;
export type ProtectedMemoryRepairResponseV1 = z.infer<typeof protectedMemoryRepairResponseV1Schema>;
