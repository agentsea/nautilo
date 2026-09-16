import { z } from "zod";

export const PERSONAL_ENCRYPTION_COVERAGE_FAMILIES = [
  "message",
  "memory",
  "journal_event",
  "reflection_record",
  "artifact",
  "task",
] as const;

const unsignedDecimalStringSchema = z.string().regex(/^(0|[1-9][0-9]*)$/u);

function familyMeasurementSchema<Family extends string>(family: Family) {
  return z.discriminatedUnion("measurement", [
    z.object({
      family: z.literal(family),
      measurement: z.literal("measured"),
      accessible: unsignedDecimalStringSchema,
      plaintextPresent: unsignedDecimalStringSchema,
      encryptedCounterpart: unsignedDecimalStringSchema,
    }).strict(),
    z.object({
      family: z.literal(family),
      measurement: z.literal("unsupported"),
      accessible: unsignedDecimalStringSchema,
      plaintextPresent: unsignedDecimalStringSchema,
      encryptedCounterpart: z.null(),
    }).strict(),
    z.object({
      family: z.literal(family),
      measurement: z.literal("unavailable"),
      accessible: z.null(),
      plaintextPresent: z.null(),
      encryptedCounterpart: z.null(),
    }).strict(),
  ]);
}

export const personalEncryptionCoverageFamilySchema = z.enum(
  PERSONAL_ENCRYPTION_COVERAGE_FAMILIES,
);

export const personalEncryptionCoverageFamilyMeasurementSchema = z.union(
  PERSONAL_ENCRYPTION_COVERAGE_FAMILIES.map(familyMeasurementSchema),
);

const activePersonalEncryptionCoverageV1Schema = z.object({
  dtoVersion: z.literal(1),
  policy: z.enum(["shadow_encryption", "encrypted_only"]),
  computedAt: z.string().datetime(),
  families: z.tuple([
    familyMeasurementSchema("message"),
    familyMeasurementSchema("memory"),
    familyMeasurementSchema("journal_event"),
    familyMeasurementSchema("reflection_record"),
    familyMeasurementSchema("artifact"),
    familyMeasurementSchema("task"),
  ]),
}).strict();

const inactivePersonalEncryptionCoverageV1Schema = z.object({
  dtoVersion: z.literal(1),
  policy: z.literal("plaintext_only"),
  computedAt: z.null(),
  families: z.tuple([]),
}).strict();

/** M308's closed, policy-discriminated personal encryption coverage contract. */
export const personalEncryptionCoverageV1Schema = z.discriminatedUnion(
  "policy",
  [inactivePersonalEncryptionCoverageV1Schema, activePersonalEncryptionCoverageV1Schema],
);

export type PersonalEncryptionCoverageFamily = z.infer<
  typeof personalEncryptionCoverageFamilySchema
>;
export type PersonalEncryptionCoverageFamilyMeasurement = z.infer<
  typeof personalEncryptionCoverageFamilyMeasurementSchema
>;
export type PersonalEncryptionCoverageV1 = z.infer<
  typeof personalEncryptionCoverageV1Schema
>;
