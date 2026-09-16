import { z } from "zod";

const exactCount = z.string().regex(/^(0|[1-9][0-9]*)$/u);
const isoTimestamp = z.string().datetime({ offset: true });

export const stenographerProtectionStatusSchema = z
  .object({
    dtoVersion: z.literal(1),
    generatedAt: isoTimestamp,
    window: z
      .object({
        since: isoTimestamp,
        until: isoTimestamp,
      })
      .strict(),
    queue: z
      .object({
        current: z
          .object({
            awaitingRecipient: exactCount,
            waitingForDevice: exactCount,
            grantReady: exactCount,
            claimed: exactCount,
            running: exactCount,
            publicationReconciliation: exactCount,
            oldestWaitingAt: isoTimestamp.nullable(),
          })
          .strict(),
        last24h: z
          .object({
            protectedCompleted: exactCount,
            outputRepairCompleted: exactCount,
            cancelled: exactCount,
            terminalFailures: exactCount,
          })
          .strict(),
      })
      .strict(),
    authorityWait: z
      .object({
        extractionRooms: exactCount,
        compactionRooms: exactCount,
        oldestAt: isoTimestamp.nullable(),
      })
      .strict(),
    plaintextFallback: z
      .object({
        missingProtection: z
          .object({
            extractionBatches: exactCount,
            compactionRollups: exactCount,
            oldestAt: isoTimestamp.nullable(),
          })
          .strict(),
        last24h: z
          .object({
            extraction: z
              .object({
                device: exactCount,
                authority: exactCount,
              })
              .strict(),
            compaction: z
              .object({
                device: exactCount,
                authority: exactCount,
              })
              .strict(),
          })
          .strict(),
      })
      .strict(),
  })
  .strict();

export type StenographerProtectionStatus = z.infer<
  typeof stenographerProtectionStatusSchema
>;
