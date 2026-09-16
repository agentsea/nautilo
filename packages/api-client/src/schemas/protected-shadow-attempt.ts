import { z } from "zod";

const tokenBase64url = z.string().length(43).regex(/^[A-Za-z0-9_-]+$/u);
const counter = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);

export const protectedShadowAttemptOperationV2Schema = z.enum([
  "create",
  "update",
  "read_repair",
  "access_update",
  "unsupported",
]);

/** Server-issued, one-shot admission for one exact Shadow-mode attempt. */
export const protectedShadowAttemptObservationAdmissionV2Schema = z.object({
  tokenBase64url,
  expiresAt: counter,
}).strict();

const terminalObservation = z.discriminatedUnion("outcome", [
  z.object({
    outcome: z.literal("unavailable"),
    reason: z.enum([
      "unmigrated",
      "unsupported_operation",
      "client_crypto_unavailable",
      "client_crypto_preparation_failed",
      "client_custody_unavailable",
      "namespace_encryption_not_ready",
      "stale_authority_product",
    ]),
  }).strict(),
  z.object({
    outcome: z.literal("failed"),
    reason: z.enum([
      "parity_mismatch",
      "integrity_failure",
      "publication_failure",
    ]),
  }).strict(),
]);

export const protectedShadowAttemptObservationV2Schema = z.intersection(
  z.object({
    requestVersion: z.literal(2),
    observationTokenBase64url: tokenBase64url,
    latencyMs: z.number().int().min(0).max(300_000),
  }).strict(),
  terminalObservation,
);

export const protectedShadowAttemptObservationResponseV2Schema = z.object({
  status: z.literal("accepted"),
}).strict();

export type ProtectedShadowAttemptObservationAdmissionV2 = z.infer<
  typeof protectedShadowAttemptObservationAdmissionV2Schema
>;
export type ProtectedShadowAttemptOperationV2 = z.infer<
  typeof protectedShadowAttemptOperationV2Schema
>;
export type ProtectedShadowAttemptObservationV2 = z.infer<
  typeof protectedShadowAttemptObservationV2Schema
>;
export type ProtectedShadowAttemptObservationResponseV2 = z.infer<
  typeof protectedShadowAttemptObservationResponseV2Schema
>;
