import { z } from "zod";

export const stenographerErrorCodeSchema = z.enum([
  "provider",
  "timeout",
  "invalid_output",
  "input_too_large",
  "lease_lost",
  "persistence",
  "unknown",
]);

export type StenographerErrorCode = z.infer<typeof stenographerErrorCodeSchema>;

const nonNegativeInteger = z.number().int().nonnegative();
const nullableNonNegativeNumber = z.number().nonnegative().nullable();
const isoTimestamp = z.string().datetime({ offset: true });

export const stenographerAdminStatusSchema = z
  .object({
    generatedAt: isoTimestamp,
    window: z
      .object({
        since: isoTimestamp,
        until: isoTimestamp,
      })
      .strict(),
    health: z.enum(["healthy", "delayed", "degraded"]),
    current: z
      .object({
        eligibleRooms: nonNegativeInteger,
        caughtUpRooms: nonNegativeInteger,
        accumulatingRooms: nonNegativeInteger,
        processingRooms: nonNegativeInteger,
        retryingRooms: nonNegativeInteger,
        dueRooms: nonNegativeInteger,
        staleLeases: nonNegativeInteger,
        oldestOverdueMs: nonNegativeInteger,
        rebuildingRooms: nonNegativeInteger,
        historicalPendingRooms: nonNegativeInteger,
        historicalCompletedRooms: nonNegativeInteger,
      })
      .strict(),
    last24h: z
      .object({
        completedExtractionBatches: nonNegativeInteger,
        extractionBatchesWithErrors: nonNegativeInteger,
        retriedExtractionBatches: nonNegativeInteger,
        zeroEventExtractionBatches: nonNegativeInteger,
        eventsWritten: nonNegativeInteger,
        extractionDurationP50Ms: nullableNonNegativeNumber,
        extractionDurationP95Ms: nullableNonNegativeNumber,
      })
      .strict(),
    journal: z
      .object({
        projectedBodyCodePointsP50: nullableNonNegativeNumber,
        projectedBodyCodePointsP95: nullableNonNegativeNumber,
        projectedBodyCodePointsMax: nullableNonNegativeNumber,
      })
      .strict(),
    compaction: z
      .object({
        awaitingRooms: nonNegativeInteger,
        processingRooms: nonNegativeInteger,
        retryingRooms: nonNegativeInteger,
        staleLeases: nonNegativeInteger,
        oldestOverdueMs: nonNegativeInteger,
        lastCompletedAt: isoTimestamp.nullable(),
      })
      .strict(),
    recentFailures: z
      .array(
        z
          .object({
            stage: z.enum(["extraction", "compaction"]),
            errorCode: stenographerErrorCodeSchema,
            occurredAt: isoTimestamp,
            attemptCount: nonNegativeInteger,
            modelId: z.string().nullable(),
          })
          .strict(),
      )
      .max(5),
  })
  .strict();

export type StenographerAdminStatus = z.infer<typeof stenographerAdminStatusSchema>;
