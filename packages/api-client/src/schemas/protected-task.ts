import {
  LATTICE_LIMITS,
  MAX_OBJECT_ACCESS_MANIFEST_WIRE_BYTES_V5,
} from "@nautilo/lattice-crypto/wire-limits";
import { z } from "zod";

const portableId = z.string().min(1).max(LATTICE_LIMITS.idBytes)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:@/-]*$/u);
const canonicalLowerUuid = z.string().uuid().refine(
  (value) => value === value.toLowerCase(),
  { message: "UUID must use canonical lowercase form" },
);
const counter = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const positiveCounter = counter.min(1);
const digestBase64url = z.string().length(43).regex(/^[A-Za-z0-9_-]+$/u);

function unpaddedBase64url(maxBytes: number, label: string) {
  return z.string().min(1).max(Math.ceil(maxBytes * 4 / 3))
    .regex(/^[A-Za-z0-9_-]+$/u)
    .refine((value) => value.length % 4 !== 1, {
      message: `${label} must be unpadded base64url`,
    });
}

const encryptedPayloadBase64url = unpaddedBase64url(
  LATTICE_LIMITS.ciphertextBytes,
  "encrypted Task payload",
);
const accessManifestBase64url = unpaddedBase64url(
  MAX_OBJECT_ACCESS_MANIFEST_WIRE_BYTES_V5,
  "Task access manifest",
);
const namespaceEnvelopeBase64url = unpaddedBase64url(
  LATTICE_LIMITS.ciphertextBytes,
  "Task Namespace envelope",
);
const signedPublicationRequestBase64url = unpaddedBase64url(
  LATTICE_LIMITS.plaintextBytes,
  "signed Task publication request",
);

const exactTaskNamespaceIdsSchema = z.tuple([canonicalLowerUuid]);
const exactTaskNamespaceEnvelopesSchema = z.tuple([z.object({
  namespaceId: canonicalLowerUuid,
  envelopeBytesBase64url: namespaceEnvelopeBase64url,
}).strict()]);

const protectedTaskPreparedPublicationBaseV1Schema = z.object({
  requestVersion: z.literal(1),
  operationId: portableId,
  planDigestBase64url: digestBase64url,
  taskId: canonicalLowerUuid,
  expectedContentRevision: counter,
  nextContentRevision: positiveCounter,
  expectedCryptoAccessRevision: counter,
  resultCryptoAccessRevision: z.literal(0),
  cryptoObjectId: portableId,
  payloadVersion: z.literal(1),
  requiredNamespaceIds: exactTaskNamespaceIdsSchema,
  encryptedPayloadBytesBase64url: encryptedPayloadBase64url,
  accessManifestBytesBase64url: accessManifestBase64url,
  namespaceEnvelopes: exactTaskNamespaceEnvelopesSchema,
  signedPublicationRequestBytesBase64url: signedPublicationRequestBase64url,
}).strict();

function validateExactTaskNamespace(
  value: Readonly<{
    requiredNamespaceIds: readonly [string];
    namespaceEnvelopes: readonly [Readonly<{ namespaceId: string }>];
  }>,
  context: z.RefinementCtx,
): void {
  if (value.namespaceEnvelopes[0].namespaceId !== value.requiredNamespaceIds[0]) {
    context.addIssue({
      code: "custom",
      message: "prepared Task envelope must match its exact content Namespace",
      path: ["namespaceEnvelopes"],
    });
  }
}

export const protectedTaskPreparedCreateRequestV1Schema =
  protectedTaskPreparedPublicationBaseV1Schema.extend({
    operation: z.literal("create"),
    expectedContentRevision: z.literal(0),
    nextContentRevision: z.literal(1),
    expectedCryptoAccessRevision: z.literal(0),
  }).strict().superRefine(validateExactTaskNamespace);

export const protectedTaskPreparedUpdateRequestV1Schema =
  protectedTaskPreparedPublicationBaseV1Schema.extend({
    operation: z.literal("update"),
    expectedContentRevision: positiveCounter,
    nextContentRevision: positiveCounter,
  }).strict().superRefine((value, context) => {
    validateExactTaskNamespace(value, context);
    if (value.nextContentRevision !== value.expectedContentRevision + 1) {
      context.addIssue({
        code: "custom",
        message: "protected Task update revision must advance exactly once",
        path: ["nextContentRevision"],
      });
    }
  });

export const protectedTaskPreparedPublicationRequestV1Schema =
  z.discriminatedUnion("operation", [
    protectedTaskPreparedCreateRequestV1Schema,
    protectedTaskPreparedUpdateRequestV1Schema,
  ]);

export type ProtectedTaskPreparedCreateRequestV1 = z.infer<
  typeof protectedTaskPreparedCreateRequestV1Schema
>;
export type ProtectedTaskPreparedUpdateRequestV1 = z.infer<
  typeof protectedTaskPreparedUpdateRequestV1Schema
>;
export type ProtectedTaskPreparedPublicationRequestV1 = z.infer<
  typeof protectedTaskPreparedPublicationRequestV1Schema
>;
