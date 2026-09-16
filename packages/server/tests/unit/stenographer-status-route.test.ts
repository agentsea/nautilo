import { beforeEach, describe, expect, mock, test } from "bun:test";
import Fastify, { type FastifyInstance } from "fastify";
import type {
  StenographerAdminStatus,
  StenographerProtectionStatus,
} from "@nautilo/types";
import {
  STENOGRAPHER_STATUS_WINDOW_MS,
  stenographerStatusRoutes,
  type StenographerStatusQueryInput,
} from "../../src/routes/stenographer-status";

const AUTHORIZED = "authorized-user";
const UNAUTHORIZED = "unauthorized-user";
const NOW = new Date("2026-07-27T10:00:00.000Z");

function statusFixture(): StenographerAdminStatus {
  return {
    generatedAt: NOW.toISOString(),
    window: {
      since: new Date(NOW.getTime() - STENOGRAPHER_STATUS_WINDOW_MS).toISOString(),
      until: NOW.toISOString(),
    },
    health: "healthy",
    current: {
      eligibleRooms: 2,
      caughtUpRooms: 2,
      accumulatingRooms: 0,
      processingRooms: 0,
      retryingRooms: 0,
      dueRooms: 0,
      staleLeases: 0,
      oldestOverdueMs: 0,
      rebuildingRooms: 0,
      historicalPendingRooms: 1,
      historicalCompletedRooms: 1,
    },
    last24h: {
      completedExtractionBatches: 3,
      extractionBatchesWithErrors: 0,
      retriedExtractionBatches: 0,
      zeroEventExtractionBatches: 1,
      eventsWritten: 2,
      extractionDurationP50Ms: 500,
      extractionDurationP95Ms: 900,
    },
    journal: {
      projectedBodyCodePointsP50: 240,
      projectedBodyCodePointsP95: 500,
      projectedBodyCodePointsMax: 700,
    },
    compaction: {
      awaitingRooms: 0,
      processingRooms: 0,
      retryingRooms: 0,
      staleLeases: 0,
      oldestOverdueMs: 0,
      lastCompletedAt: null,
    },
    recentFailures: [],
  };
}

function protectionStatusFixture(): StenographerProtectionStatus {
  return {
    dtoVersion: 1,
    generatedAt: NOW.toISOString(),
    window: {
      since: new Date(NOW.getTime() - STENOGRAPHER_STATUS_WINDOW_MS).toISOString(),
      until: NOW.toISOString(),
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
      oldestAt: "2026-07-27T08:00:00.000Z",
    },
    plaintextFallback: {
      missingProtection: {
        extractionBatches: "13",
        compactionRollups: "14",
        oldestAt: "2026-07-27T07:00:00.000Z",
      },
      last24h: {
        extraction: { device: "15", authority: "16" },
        compaction: { device: "17", authority: "18" },
      },
    },
  };
}

function buildApp(options?: {
  queryStatus?: (input: StenographerStatusQueryInput) => Promise<StenographerAdminStatus>;
  queryProtectionStatus?: (
    input: StenographerStatusQueryInput,
  ) => Promise<StenographerProtectionStatus>;
  wireProtection?: boolean;
}): {
  app: FastifyInstance;
  queryStatus: ReturnType<typeof mock>;
  queryProtectionStatus: ReturnType<typeof mock>;
} {
  const app = Fastify();
  app.decorateRequest("sessionUserId", null);
  app.addHook("preHandler", async (request) => {
    const userId = request.headers["x-test-user"];
    request.sessionUserId = typeof userId === "string" ? userId : null;
  });

  const queryStatus = mock(options?.queryStatus ?? (async () => statusFixture()));
  const queryProtectionStatus = mock(
    options?.queryProtectionStatus ?? (async () => protectionStatusFixture()),
  );
  stenographerStatusRoutes(app, {
    queryStatus,
    ...(options?.wireProtection === false ? {} : { queryProtectionStatus }),
    now: () => new Date(NOW),
    hasCapability: async (userId) => userId === AUTHORIZED,
  });
  return { app, queryStatus, queryProtectionStatus };
}

describe("GET /api/admin/stenographer-status", () => {
  let app: FastifyInstance;

  beforeEach(() => {
    ({ app } = buildApp());
  });

  test("returns 401 without an authenticated viewer", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/api/admin/stenographer-status",
    });

    expect(response.statusCode).toBe(401);
  });

  test("returns 403 without read_server_settings", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/api/admin/stenographer-status",
      headers: { "x-test-user": UNAUTHORIZED },
    });

    expect(response.statusCode).toBe(403);
  });

  test("passes the injected fixed clock/window to the repository", async () => {
    const { app: authorizedApp, queryStatus } = buildApp();
    const response = await authorizedApp.inject({
      method: "GET",
      url: "/api/admin/stenographer-status",
      headers: { "x-test-user": AUTHORIZED },
    });

    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body)).toEqual(statusFixture());
    expect(queryStatus).toHaveBeenCalledTimes(1);
    const input = queryStatus.mock.calls[0]?.[0] as StenographerStatusQueryInput;
    expect(input.now.toISOString()).toBe(NOW.toISOString());
    expect(input.until.toISOString()).toBe(NOW.toISOString());
    expect(input.since.toISOString()).toBe(
      new Date(NOW.getTime() - STENOGRAPHER_STATUS_WINDOW_MS).toISOString(),
    );
  });

  test("rejects non-contract identity/content fields from the repository", async () => {
    const { app: privacyApp } = buildApp({
      queryStatus: async () =>
        ({
          ...statusFixture(),
          roomId: "private-room-id",
          recentFailures: [
            {
              stage: "extraction",
              errorCode: "provider",
              occurredAt: NOW.toISOString(),
              attemptCount: 1,
              modelId: null,
              transcript: "private transcript",
            },
          ],
        }) as unknown as StenographerAdminStatus,
    });

    const response = await privacyApp.inject({
      method: "GET",
      url: "/api/admin/stenographer-status",
      headers: { "x-test-user": AUTHORIZED },
    });

    expect(response.statusCode).toBe(500);
    expect(JSON.parse(response.body)).toEqual({
      error: "Stenographer status unavailable",
    });
    expect(response.body).not.toContain("private");
  });

  test("does not expose repository exception text", async () => {
    const { app: failingApp } = buildApp({
      queryStatus: async () => {
        throw new Error("provider leaked a private transcript");
      },
    });

    const response = await failingApp.inject({
      method: "GET",
      url: "/api/admin/stenographer-status",
      headers: { "x-test-user": AUTHORIZED },
    });

    expect(response.statusCode).toBe(500);
    expect(response.body).not.toContain("provider leaked");
  });
});

describe("GET /api/admin/stenographer-status/protection", () => {
  test("requires authentication and read_server_settings before querying", async () => {
    const { app, queryProtectionStatus } = buildApp();
    const unauthenticated = await app.inject({
      method: "GET",
      url: "/api/admin/stenographer-status/protection",
    });
    const forbidden = await app.inject({
      method: "GET",
      url: "/api/admin/stenographer-status/protection",
      headers: { "x-test-user": UNAUTHORIZED },
    });

    expect(unauthenticated.statusCode).toBe(401);
    expect(forbidden.statusCode).toBe(403);
    expect(queryProtectionStatus).not.toHaveBeenCalled();
  });

  test("returns 503 when the production query has not been wired", async () => {
    const { app, queryProtectionStatus } = buildApp({ wireProtection: false });
    const response = await app.inject({
      method: "GET",
      url: "/api/admin/stenographer-status/protection",
      headers: { "x-test-user": AUTHORIZED },
    });

    expect(response.statusCode).toBe(503);
    expect(JSON.parse(response.body)).toEqual({
      error: "Stenographer protection status unavailable",
    });
    expect(queryProtectionStatus).not.toHaveBeenCalled();
  });

  test("returns the strict content-free DTO for the same 24-hour window", async () => {
    const { app, queryProtectionStatus } = buildApp();
    const response = await app.inject({
      method: "GET",
      url: "/api/admin/stenographer-status/protection",
      headers: { "x-test-user": AUTHORIZED },
    });

    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body)).toEqual(protectionStatusFixture());
    const input = queryProtectionStatus.mock.calls[0]?.[0] as StenographerStatusQueryInput;
    expect(input.now.toISOString()).toBe(NOW.toISOString());
    expect(input.since.toISOString()).toBe(
      new Date(NOW.getTime() - STENOGRAPHER_STATUS_WINDOW_MS).toISOString(),
    );
  });

  test("rejects invalid counts and identity or content fields without leaking them", async () => {
    const { app } = buildApp({
      queryProtectionStatus: async () =>
        ({
          ...protectionStatusFixture(),
          roomId: "private-room-id",
          queue: {
            ...protectionStatusFixture().queue,
            current: {
              ...protectionStatusFixture().queue.current,
              waitingForDevice: "01",
              transcript: "private transcript",
            },
          },
        }) as unknown as StenographerProtectionStatus,
    });
    const response = await app.inject({
      method: "GET",
      url: "/api/admin/stenographer-status/protection",
      headers: { "x-test-user": AUTHORIZED },
    });

    expect(response.statusCode).toBe(500);
    expect(response.body).not.toContain("private");
  });
});
