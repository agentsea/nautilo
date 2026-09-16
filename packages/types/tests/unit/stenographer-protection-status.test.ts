import { describe, expect, test } from "bun:test";
import { stenographerProtectionStatusSchema } from "../../src/stenographer-protection-status";

const SAMPLE = {
  dtoVersion: 1 as const,
  generatedAt: "2026-08-12T10:00:00.000Z",
  window: {
    since: "2026-08-11T10:00:00.000Z",
    until: "2026-08-12T10:00:00.000Z",
  },
  queue: {
    current: {
      awaitingRecipient: "0",
      waitingForDevice: "1",
      grantReady: "2",
      claimed: "3",
      running: "4",
      publicationReconciliation: "5",
      oldestWaitingAt: null,
    },
    last24h: {
      protectedCompleted: "6",
      outputRepairCompleted: "7",
      cancelled: "8",
      terminalFailures: "9",
    },
  },
  authorityWait: {
    extractionRooms: "10",
    compactionRooms: "11",
    oldestAt: null,
  },
  plaintextFallback: {
    missingProtection: {
      extractionBatches: "12",
      compactionRollups: "13",
      oldestAt: null,
    },
    last24h: {
      extraction: { device: "14", authority: "15" },
      compaction: { device: "16", authority: "17" },
    },
  },
};

describe("stenographerProtectionStatusSchema", () => {
  test("accepts exact decimal counts and strict content-free fields", () => {
    expect(stenographerProtectionStatusSchema.parse(SAMPLE)).toEqual(SAMPLE);
  });

  test.each(["", "01", "-1", "1.0", " 1"])(
    "rejects non-canonical count %p",
    (waitingForDevice) => {
      expect(() =>
        stenographerProtectionStatusSchema.parse({
          ...SAMPLE,
          queue: {
            ...SAMPLE.queue,
            current: { ...SAMPLE.queue.current, waitingForDevice },
          },
        }),
      ).toThrow();
    },
  );

  test("rejects identity and content fields at every strict boundary", () => {
    expect(() =>
      stenographerProtectionStatusSchema.parse({
        ...SAMPLE,
        roomId: "private-room-id",
      }),
    ).toThrow();
    expect(() =>
      stenographerProtectionStatusSchema.parse({
        ...SAMPLE,
        plaintextFallback: {
          ...SAMPLE.plaintextFallback,
          transcript: "private transcript",
        },
      }),
    ).toThrow();
  });
});
