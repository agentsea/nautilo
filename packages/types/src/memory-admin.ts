import { z } from "zod";

const count = z.number().int().nonnegative();
const timestamp = z.string().datetime({ offset: true });

export const memoryReviewFailureCodeSchema = z.enum([
  "invalid_proposal", "memory_unavailable", "source_changed", "embedding_failed",
  "iteration_exhausted", "model_unavailable", "provider_failed", "cancelled",
  "execution_unavailable", "publication_uncertain", "source_or_lease_changed",
  "authority_or_source_unavailable", "storage_failed", "unknown",
]);
export const memoryReviewFailurePhaseSchema = z.enum([
  "reconciliation", "access", "input", "model", "publication", "effects", "unknown",
]);

/** Automatic retry is limited to transient pre-publication failures. */
export const MEMORY_REVIEW_AUTOMATIC_RETRY_CODES = [
  "provider_failed", "cancelled", "source_changed", "embedding_failed", "storage_failed",
] as const;

/** Operator retry still reopens current authority; uncertain commits never re-run. */
export const MEMORY_REVIEW_MANUAL_RETRY_CODES = [
  ...MEMORY_REVIEW_AUTOMATIC_RETRY_CODES,
  "invalid_proposal", "iteration_exhausted", "memory_unavailable", "model_unavailable",
  "execution_unavailable", "authority_or_source_unavailable",
] as const;

/** Operational metadata only: never Room labels, Memory text, or provider errors. */
export const memoryAdminStatusSchema = z.object({
  generatedAt: timestamp,
  window: z.object({ since: timestamp, until: timestamp }).strict(),
  enabled: z.boolean(),
  model: z.object({
    id: z.string().nullable(), provider: z.string().nullable(),
    source: z.enum(["server", "conductor"]), available: z.boolean(),
  }).strict(),
  encryption: z.object({
    mode: z.enum(["ordinary", "fallback", "strict"]), available: z.boolean(),
  }).strict(),
  trackedSince: timestamp.nullable(),
  health: z.enum(["healthy", "paused", "waiting", "delayed", "degraded", "unavailable"]),
  current: z.object({
    accumulating: count, due: count, processing: count, retrying: count,
    blocked: count, caughtUp: count, safelyRetryable: count,
    oldestOverdueMs: z.number().nonnegative().nullable(),
  }).strict(),
  lastSuccessfulReviewAt: timestamp.nullable(),
  lastAttemptAt: timestamp.nullable(),
  last24h: z.object({
    completedReviews: count.nullable(), noChangeReviews: count.nullable(),
    created: count.nullable(), replaced: count.nullable(), promoted: count.nullable(),
    demoted: count.nullable(), failures: count.nullable(),
    lastReviewDurationMs: z.number().nonnegative().nullable(),
  }).strict(),
  recentFailures: z.array(z.object({
    phase: memoryReviewFailurePhaseSchema, code: memoryReviewFailureCodeSchema, occurredAt: timestamp,
    nextRetryAt: timestamp.nullable(), retryable: z.boolean(),
  }).strict()),
  followUpPending: count,
  exitFlush: z.literal("not_scheduled"),
}).strict();

export type MemoryAdminStatus = z.infer<typeof memoryAdminStatusSchema>;
export const memoryRetryResponseSchema = z.object({ requested: count }).strict();
