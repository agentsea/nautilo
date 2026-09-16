import { describe, expect, mock, test } from "bun:test";
import Fastify from "fastify";
import {
  EMPTY_REFLECTION_SEMANTIC_LATENCY,
  reflectionAdminStatusSchema,
  type ReflectionAdminStatus,
  type ReflectionProtectedAuthorityStatus,
} from "@nautilo/types";
import {
  REFLECTION_STATUS_WINDOW_MS,
  reflectionStatusRoutes,
  type ReflectionStatusQueryInput,
} from "../../src/routes/reflection-status";

const NOW = new Date("2026-08-14T12:00:00.000Z");

function fixture(): ReflectionAdminStatus {
  return {
    generatedAt: NOW.toISOString(),
    window: {
      since: new Date(NOW.getTime() - REFLECTION_STATUS_WINDOW_MS).toISOString(),
      until: NOW.toISOString(),
    },
    health: "healthy",
    scheduler: {
      state: "cooldown", pauseReason: null, recoveryIntervalMs: 15_000,
      nextEligiblePollAt: "2026-08-14T12:00:15.000Z",
      lastPoll: {
        elapsedMs: 120, claims: 2, databaseWork: 6, modelCalls: 1,
        modelFailures: 0, authorityElapsedMs: 10, searchProjectionElapsedMs: 20,
        candidateElapsedMs: 30, modelElapsedMs: 50, publicationElapsedMs: 10,
        deterministicNoChanges: 0,
        sameRoomPlans: 1,
        crossRoomPlans: 1,
        sameRoomCompletions: 1,
        crossRoomCompletions: 1,
        candidatesOpened: 3,
        unsupportedAuthorityShapes: 0,
        stalePlans: 0,
        capacityOutcomes: 0,
        noEffectiveAudience: 0,
        protectedExecutionUnavailable: 0,
      },
      window: { polls: 2, admitted: 2, completed: 2, created: 1 },
      backlog: { size: 0, oldestAgeMs: 0 },
      latency: EMPTY_REFLECTION_SEMANTIC_LATENCY,
      amplification: "normal",
    },
    current: {
      totalRecords: 4, backlog: 0, due: 0, claimed: 0, checkpointed: 0,
      deferred: 0, complete: 4, quarantined: 0, recoveryEligible: 0,
      maximumRecoveryRound: 0, staleLeases: 0,
      oldestOverdueMs: 0, maximumAttempts: 1, currentParentViolations: 0,
    },
    stages: { authorityProjection: 0, searchProjection: 0, organization: 4 },
    projections: { availableRecords: 4, current: 4, pending: 0, incompatible: 0 },
    last24h: { completedWork: 4, syntheticParentsCreated: 1 },
    lastCompletedAt: NOW.toISOString(),
    nextRecoveryAt: null,
    currentFailures: [],
  };
}

function app(
  queryStatus = mock(async (_input: ReflectionStatusQueryInput) => fixture()),
  queryAuthorityStatus?: (
    input: ReflectionStatusQueryInput,
  ) => Promise<ReflectionProtectedAuthorityStatus>,
) {
  const server = Fastify();
  server.decorateRequest("sessionUserId", null);
  server.addHook("preHandler", async (request) => {
    const user = request.headers["x-test-user"];
    request.sessionUserId = typeof user === "string" ? user : null;
  });
  reflectionStatusRoutes(server, {
    queryStatus,
    ...(queryAuthorityStatus === undefined ? {} : { queryAuthorityStatus }),
    now: () => new Date(NOW),
    hasCapability: async (userId) => userId === "owner",
  });
  return { server, queryStatus };
}

describe("GET /api/admin/reflection-status", () => {
  test("requires authentication and read_server_settings", async () => {
    const { server } = app();
    expect((await server.inject({ method: "GET", url: "/api/admin/reflection-status" })).statusCode).toBe(401);
    expect((await server.inject({
      method: "GET", url: "/api/admin/reflection-status",
      headers: { "x-test-user": "guest" },
    })).statusCode).toBe(403);
  });

  test("returns the bounded content-free status window", async () => {
    const { server, queryStatus } = app();
    const response = await server.inject({
      method: "GET", url: "/api/admin/reflection-status",
      headers: { "x-test-user": "owner" },
    });
    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body)).toEqual(fixture());
    const input = queryStatus.mock.calls[0]?.[0] as ReflectionStatusQueryInput;
    expect(input.since.toISOString()).toBe(
      new Date(NOW.getTime() - REFLECTION_STATUS_WINDOW_MS).toISOString(),
    );
  });

  test("merges the optional protected authority projection", async () => {
    const queryAuthorityStatus = mock(async (_input: ReflectionStatusQueryInput) => ({
      dtoVersion: 1 as const,
      scope: "authority_maintenance_only" as const,
      current: {
        awaitingRecipient: "1",
        awaitingEligibleDeviceAndKeys: "2",
        readyOrRunning: "3",
        reconciliationPending: "4",
        retirementPending: "5",
        verifiedAuthority: "6",
        terminalOrStale: "7",
      },
      last24h: { verifiedAuthority: "8", terminalOrStale: "9" },
    }));
    const { server } = app(undefined, queryAuthorityStatus);
    const response = await server.inject({
      method: "GET", url: "/api/admin/reflection-status",
      headers: { "x-test-user": "owner" },
    });
    expect(response.statusCode).toBe(200);
    const body = reflectionAdminStatusSchema.parse(JSON.parse(response.body));
    expect(body.protectedAuthority?.current).toEqual({
      awaitingRecipient: "1",
      awaitingEligibleDeviceAndKeys: "2",
      readyOrRunning: "3",
      reconciliationPending: "4",
      retirementPending: "5",
      verifiedAuthority: "6",
      terminalOrStale: "7",
    });
    expect(queryAuthorityStatus).toHaveBeenCalledTimes(1);
  });

  test("rejects extra identity or content fields", async () => {
    const { server } = app(mock(async () => ({
      ...fixture(),
      recordId: "private-record",
    }) as unknown as ReflectionAdminStatus));
    const response = await server.inject({
      method: "GET", url: "/api/admin/reflection-status",
      headers: { "x-test-user": "owner" },
    });
    expect(response.statusCode).toBe(500);
    expect(response.body).not.toContain("private-record");
  });

  test("redacts repository exceptions", async () => {
    const { server } = app(mock(async () => {
      throw new Error("private source body");
    }));
    const response = await server.inject({
      method: "GET", url: "/api/admin/reflection-status",
      headers: { "x-test-user": "owner" },
    });
    expect(response.statusCode).toBe(500);
    expect(response.body).not.toContain("private source body");
  });
});
