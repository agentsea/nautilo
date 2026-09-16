import { z } from "zod";

export const computerContextReferenceSchema = z.string().regex(/^dctx_[A-Za-z0-9_-]{43}$/);

const referenceBase = z.object({ version: z.literal(1), context: computerContextReferenceSchema }).strict();
export const computerContinuationReferenceSchema = referenceBase.extend({ reference: z.string().regex(/^dcont_[A-Za-z0-9_-]{43}$/) }).strict();
export const computerWindowTargetReferenceSchema = referenceBase.extend({ reference: z.string().regex(/^dtgt_[A-Za-z0-9_-]{43}$/) }).strict();
export const computerAppTargetReferenceSchema = referenceBase.extend({ reference: z.string().regex(/^datgt_[A-Za-z0-9_-]{43}$/) }).strict();
export const computerScreenSnapshotReferenceSchema = referenceBase.extend({ reference: z.string().regex(/^dsnap_[A-Za-z0-9_-]{43}$/) }).strict();
export const computerElementTargetReferenceSchema = referenceBase.extend({ reference: z.string().regex(/^detgt_[A-Za-z0-9_-]{43}$/) }).strict();
export const computerTargetReferenceSchema = z.union([
  computerWindowTargetReferenceSchema,
  computerAppTargetReferenceSchema,
  computerElementTargetReferenceSchema,
]);
export const computerAnyTargetReferenceSchema = z.union([
  computerWindowTargetReferenceSchema,
  computerAppTargetReferenceSchema,
  computerElementTargetReferenceSchema,
  computerScreenSnapshotReferenceSchema,
]);
