import { z } from "zod";

const canonicalBase64urlSchema = z.string().regex(/^[A-Za-z0-9_-]+$/u);
const uuidSchema = z.string().uuid();
const counterSchema = z.number().int().nonnegative();
const cryptoDeviceIdSchema = z.string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:@/-]*$/u);

export const deviceAdmissionChallengeSchema = z.object({
  formatVersion: z.literal(1),
  challengeId: z.string()
    .min(1)
    .max(128)
    .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u),
  credentialDigestBase64url: canonicalBase64urlSchema,
  userId: uuidSchema,
  humanActorId: uuidSchema,
  deviceId: cryptoDeviceIdSchema,
  deviceGeneration: counterSchema.positive(),
  serverInstanceId: uuidSchema,
  lineageGeneration: counterSchema.positive(),
  epoch: counterSchema,
  securityRevision: counterSchema.positive(),
  headDigestBase64url: canonicalBase64urlSchema,
  nonceBase64url: canonicalBase64urlSchema,
  issuedAt: counterSchema,
  expiresAt: counterSchema,
}).strict();

export const deviceAdmissionChallengeRequestSchema = z.object({
  requestVersion: z.literal(1),
  deviceId: cryptoDeviceIdSchema,
}).strict();

export const deviceAdmissionChallengeResponseSchema = z.object({
  responseVersion: z.literal(1),
  challenge: deviceAdmissionChallengeSchema,
}).strict();

export const deviceAdmissionProofRequestSchema = z.object({
  requestVersion: z.literal(1),
  proof: deviceAdmissionChallengeSchema.extend({
    signatureBase64url: canonicalBase64urlSchema,
  }).strict(),
}).strict();

export const deviceAdmissionStatusSchema = z.discriminatedUnion("status", [
  z.object({
    responseVersion: z.literal(1),
    required: z.literal(false),
    status: z.literal("not_required"),
  }).strict(),
  z.object({
    responseVersion: z.literal(1),
    required: z.literal(true),
    status: z.literal("required"),
    reason: z.enum([
      "device_admission_required",
      "device_admission_expired",
      "device_removed_or_stale",
    ]),
  }).strict(),
  z.object({
    responseVersion: z.literal(1),
    required: z.literal(true),
    status: z.literal("admitted"),
    deviceId: cryptoDeviceIdSchema,
    deviceGeneration: counterSchema.positive(),
    expiresAt: counterSchema,
  }).strict(),
]);

export const deviceAdmissionProofResponseSchema = z.object({
  responseVersion: z.literal(1),
  status: z.literal("admitted"),
  deviceId: cryptoDeviceIdSchema,
  deviceGeneration: counterSchema.positive(),
  expiresAt: counterSchema,
}).strict();

export type DeviceAdmissionChallengeDto = z.infer<
  typeof deviceAdmissionChallengeSchema
>;
export type DeviceAdmissionChallengeRequest = z.infer<
  typeof deviceAdmissionChallengeRequestSchema
>;
export type DeviceAdmissionChallengeResponse = z.infer<
  typeof deviceAdmissionChallengeResponseSchema
>;
export type DeviceAdmissionProofRequest = z.infer<
  typeof deviceAdmissionProofRequestSchema
>;
export type DeviceAdmissionStatus = z.infer<typeof deviceAdmissionStatusSchema>;
export type DeviceAdmissionProofResponse = z.infer<
  typeof deviceAdmissionProofResponseSchema
>;
