import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { NautiloApiClient } from "../../src/client";
import {
  EMPTY_REFLECTION_SEMANTIC_LATENCY,
  type ReflectionAdminStatus,
} from "@nautilo/types";

const status: ReflectionAdminStatus = {
  generatedAt: "2026-08-14T12:00:00.000Z",
  window: { since: "2026-08-13T12:00:00.000Z", until: "2026-08-14T12:00:00.000Z" },
  health: "healthy",
  scheduler: {
    state: "cooldown", pauseReason: null, recoveryIntervalMs: 15_000,
    nextEligiblePollAt: "2026-08-14T12:00:15.000Z",
    lastPoll: {
      elapsedMs: 120,
      claims: 2,
      databaseWork: 6,
      modelCalls: 1,
      modelFailures: 0,
      authorityElapsedMs: 10,
      searchProjectionElapsedMs: 20,
      candidateElapsedMs: 25,
      modelElapsedMs: 60,
      publicationElapsedMs: 5,
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
    totalRecords: 2, backlog: 0, due: 0, claimed: 0, checkpointed: 0,
    deferred: 0, complete: 2, quarantined: 0, recoveryEligible: 0,
    maximumRecoveryRound: 0, staleLeases: 0,
    oldestOverdueMs: 0, maximumAttempts: 1, currentParentViolations: 0,
  },
  stages: { authorityProjection: 0, searchProjection: 0, organization: 2 },
  projections: { availableRecords: 2, current: 2, pending: 0, incompatible: 0 },
  last24h: { completedWork: 2, syntheticParentsCreated: 1 },
  lastCompletedAt: "2026-08-14T11:59:00.000Z",
  nextRecoveryAt: null,
  currentFailures: [],
};

describe("admin.reflectionStatus HTTP contract", () => {
  let realFetch: typeof fetch;
  beforeEach(() => { realFetch = globalThis.fetch; });
  afterEach(() => { globalThis.fetch = realFetch; });

  test("gets and validates the content-free operator status", async () => {
    let url = "";
    const mockFetch = async (input: Parameters<typeof fetch>[0]) => {
      url = typeof input === "string" ? input : (input as URL).toString();
      return new Response(JSON.stringify(status), {
        status: 200, headers: { "content-type": "application/json" },
      });
    };
    globalThis.fetch = Object.assign(mockFetch, {
      preconnect: realFetch.preconnect.bind(realFetch),
    }) as typeof fetch;
    const client = new NautiloApiClient("http://127.0.0.1:9");
    client.setToken("token");
    expect(await client.admin.reflectionStatus.get()).toEqual(status);
    expect(url).toBe("http://127.0.0.1:9/api/admin/reflection-status");
  });
});
