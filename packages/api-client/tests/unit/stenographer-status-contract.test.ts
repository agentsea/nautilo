import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { NautiloApiClient } from "../../src/client";

const SAMPLE = {
  generatedAt: "2026-07-27T10:00:00.000Z",
  window: {
    since: "2026-07-26T10:00:00.000Z",
    until: "2026-07-27T10:00:00.000Z",
  },
  health: "delayed" as const,
  current: {
    eligibleRooms: 6,
    caughtUpRooms: 2,
    accumulatingRooms: 1,
    processingRooms: 1,
    retryingRooms: 1,
    dueRooms: 1,
    staleLeases: 0,
    oldestOverdueMs: 90_000,
    rebuildingRooms: 2,
    historicalPendingRooms: 3,
    historicalCompletedRooms: 3,
  },
  last24h: {
    completedExtractionBatches: 20,
    extractionBatchesWithErrors: 2,
    retriedExtractionBatches: 1,
    zeroEventExtractionBatches: 4,
    eventsWritten: 12,
    extractionDurationP50Ms: 800,
    extractionDurationP95Ms: 1_900,
  },
  journal: {
    projectedBodyCodePointsP50: 400,
    projectedBodyCodePointsP95: 1_200,
    projectedBodyCodePointsMax: 3_000,
  },
  compaction: {
    awaitingRooms: 1,
    processingRooms: 0,
    retryingRooms: 0,
    staleLeases: 0,
    oldestOverdueMs: 0,
    lastCompletedAt: null,
  },
  recentFailures: [
    {
      stage: "extraction" as const,
      errorCode: "timeout" as const,
      occurredAt: "2026-07-27T09:55:00.000Z",
      attemptCount: 2,
      modelId: "provider:model",
    },
  ],
};

const PROTECTION_SAMPLE = {
  dtoVersion: 1 as const,
  generatedAt: "2026-07-27T10:00:00.000Z",
  window: {
    since: "2026-07-26T10:00:00.000Z",
    until: "2026-07-27T10:00:00.000Z",
  },
  queue: {
    current: {
      awaitingRecipient: "1",
      waitingForDevice: "2",
      grantReady: "3",
      claimed: "4",
      running: "5",
      publicationReconciliation: "6",
      oldestWaitingAt: "2026-07-27T09:00:00.000Z",
    },
    last24h: {
      protectedCompleted: "7",
      outputRepairCompleted: "8",
      cancelled: "9",
      terminalFailures: "10",
    },
  },
  authorityWait: {
    extractionRooms: "11",
    compactionRooms: "12",
    oldestAt: null,
  },
  plaintextFallback: {
    missingProtection: {
      extractionBatches: "13",
      compactionRollups: "14",
      oldestAt: "2026-07-27T08:00:00.000Z",
    },
    last24h: {
      extraction: { device: "15", authority: "16" },
      compaction: { device: "17", authority: "18" },
    },
  },
};

describe("admin.stenographerStatus HTTP contract", () => {
  let realFetch: typeof fetch;

  beforeEach(() => {
    realFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  test("GETs the admin endpoint and parses the shared content-free DTO", async () => {
    let seenUrl = "";
    let seenMethod = "";
    const mockFetch = async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      seenUrl = typeof input === "string" ? input : (input as URL).toString();
      seenMethod = init?.method ?? "GET";
      return new Response(JSON.stringify(SAMPLE), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };
    globalThis.fetch = Object.assign(mockFetch, {
      preconnect: realFetch.preconnect.bind(realFetch),
    }) as typeof fetch;

    const client = new NautiloApiClient("http://127.0.0.1:9");
    client.setToken("tok");

    const status = await client.admin.stenographerStatus.get();
    expect(status).toEqual(SAMPLE);
    expect(seenMethod).toBe("GET");
    expect(seenUrl).toBe("http://127.0.0.1:9/api/admin/stenographer-status");
  });

  test("rejects identity or content fields added to the wire response", async () => {
    const mockFetch = async () =>
      new Response(
        JSON.stringify({
          ...SAMPLE,
          roomId: "private-room-id",
          recentFailures: [
            {
              ...SAMPLE.recentFailures[0],
              transcript: "private transcript",
            },
          ],
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      );
    globalThis.fetch = Object.assign(mockFetch, {
      preconnect: realFetch.preconnect.bind(realFetch),
    }) as typeof fetch;

    const client = new NautiloApiClient("http://127.0.0.1:9");
    let parseError: unknown;
    try {
      await client.admin.stenographerStatus.get();
    } catch (error) {
      parseError = error;
    }
    expect(parseError).toBeInstanceOf(Error);
  });

  test("GETs and strictly validates the versioned protection endpoint", async () => {
    let seenUrl = "";
    const mockFetch = async (input: Parameters<typeof fetch>[0]) => {
      seenUrl = typeof input === "string" ? input : (input as URL).toString();
      return new Response(JSON.stringify(PROTECTION_SAMPLE), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };
    globalThis.fetch = Object.assign(mockFetch, {
      preconnect: realFetch.preconnect.bind(realFetch),
    }) as typeof fetch;

    const client = new NautiloApiClient("http://127.0.0.1:9");
    const status = await client.admin.stenographerStatus.getProtection();

    expect(status).toEqual(PROTECTION_SAMPLE);
    expect(seenUrl).toBe(
      "http://127.0.0.1:9/api/admin/stenographer-status/protection",
    );
  });

  test("rejects non-canonical counts and sensitive fields in protection status", async () => {
    const mockFetch = async () =>
      new Response(
        JSON.stringify({
          ...PROTECTION_SAMPLE,
          roomId: "private-room-id",
          queue: {
            ...PROTECTION_SAMPLE.queue,
            current: {
              ...PROTECTION_SAMPLE.queue.current,
              waitingForDevice: "01",
              transcript: "private transcript",
            },
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    globalThis.fetch = Object.assign(mockFetch, {
      preconnect: realFetch.preconnect.bind(realFetch),
    }) as typeof fetch;

    const client = new NautiloApiClient("http://127.0.0.1:9");
    let parseError: unknown;
    try {
      await client.admin.stenographerStatus.getProtection();
    } catch (error) {
      parseError = error;
    }
    expect(parseError).toBeInstanceOf(Error);
  });
});
