/**
 * D405 — /api/costs auth gating + payload shape. The capability check and DB
 * aggregation are injected so this stays a pure route test (no DB).
 */
import { beforeEach, describe, expect, test } from "bun:test";
import Fastify, { type FastifyInstance } from "fastify";
import type { CostsSummary, PersonalCostsData } from "@nautilo/db";
import type { PersonalCostsSummary } from "@nautilo/types";
import { costsRoutes } from "../../src/routes/costs";

const OWNER = "owner-user-id";
const MEMBER = "member-user-id";

type CostsApiResponse = {
  pricingVersion: string;
  providerPricingVersion: string;
  providerCoverage: {
    state: string;
    accounted: Array<{ provider: string; operation: string }>;
    unavailable: string[];
  };
  byModel: Array<{ displayName: string; hasFallbackEstimate?: boolean }>;
  totals: CostsSummary["totals"];
  byProvider: CostsSummary["byProvider"];
  byUser: Array<{ label: string }>;
  serviceOperations: CostsSummary["serviceOperations"];
  serviceRecovery: CostsSummary["serviceRecovery"];
};

function fakeSummary(): CostsSummary {
  return {
    range: { sinceIso: "2026-06-09T00:00:00.000Z", untilIso: "2026-07-09T00:00:00.000Z" },
    totals: {
      calls: 3,
      providerOperations: 1,
      unknownProviderOperations: 0,
      pendingModelAttempts: 1,
      unknownModelAttempts: 1,
      inputTokens: 1000,
      cachedInputTokens: 0,
      outputTokens: 500,
      totalTokens: 1500,
      estimatedCostUsd: 0.02,
      actualCostUsd: 0.005,
      totalCostUsd: 0.021,
    },
    byModel: [
      {
        model: "anthropic:claude-sonnet-4-6",
        provider: "anthropic",
        calls: 2,
        inputTokens: 800,
        outputTokens: 400,
        estimatedCostUsd: 0.015,
        actualCostUsd: 0,
        totalCostUsd: 0.015,
        hasActual: false,
        hasFallbackEstimate: true,
        pendingAttempts: 1,
        unknownAttempts: 1,
      },
    ],
    serviceOperations: { operations: 1, succeeded: 0, failed: 0, cancelled: 1, interrupted: 0, unknown: 0, legacy: 0 },
    serviceRecovery: { attempts: [{ provider: "tavily", operation: "search", workload: "deep_research", attemptOutcome: "cancelled", failureCode: "cancelled", taskId: null, runId: null, jobId: null, occurredAt: "2026-07-08T00:00:00.000Z" }] },
    byCallType: [{ callType: "chat", calls: 3, totalCostUsd: 0.021 }],
    byProvider: [{
      provider: "browser_use",
      operation: "hosted_read",
      operations: 1,
      unknownOperations: 0,
      estimatedCostUsd: 0,
      actualCostUsd: 0.014,
      totalCostUsd: 0.014,
    }],
    byUser: [
      {
        userId: OWNER,
        handle: "alex",
        name: "Alex",
        calls: 3,
        providerOperations: 1,
        unknownProviderOperations: 0,
        totalTokens: 1500,
        estimatedCostUsd: 0.02,
        actualCostUsd: 0.005,
        totalCostUsd: 0.021,
      },
      {
        userId: null,
        handle: null,
        name: null,
        calls: 1,
        providerOperations: 0,
        unknownProviderOperations: 0,
        totalTokens: 50,
        estimatedCostUsd: 0.001,
        actualCostUsd: 0,
        totalCostUsd: 0.001,
      },
    ],
    timeSeries: [
      { day: "2026-07-08", estimatedCostUsd: 0.02, actualCostUsd: 0.005, totalCostUsd: 0.021 },
    ],
    recovery: {
      pendingAttempts: 1,
      retryableAttempts: 0,
      blockedAttempts: 0,
      unknownAttempts: 1,
      attempts: [],
    },
  };
}

function fakePersonalSummary(): PersonalCostsData {
  return {
    entry: { available: true, hasPersonalCredentials: false, hasHistory: true },
    totals: {
      calls: 1, providerOperations: 0, unknownProviderOperations: 0, inputTokens: 100, cachedInputTokens: 0,
      outputTokens: 25, totalTokens: 125, estimatedCostUsd: 0,
      actualCostUsd: 0.000283, totalCostUsd: 0.000283,
      pendingAttempts: 0, unknownAttempts: 0, retryableAttempts: 0, blockedAttempts: 0,
    },
    byModel: [{
      model: "venice:openai-gpt-55", provider: "venice", displayName: "venice:openai-gpt-55",
      calls: 1, inputTokens: 100, outputTokens: 25, estimatedCostUsd: 0,
      actualCostUsd: 0.000283, totalCostUsd: 0.000283, hasActual: true,
      hasFallbackEstimate: false, pendingAttempts: 0, unknownAttempts: 0, blockedAttempts: 0,
    }],
    byCallType: [{ callType: "chat", calls: 1, totalCostUsd: 0.000283 }],
    byProvider: [],
    byTask: [],
    timeSeries: [{ day: "2026-07-08", estimatedCostUsd: 0, actualCostUsd: 0.000283, totalCostUsd: 0.000283 }],
    recovery: {
      pendingAttempts: 0,
      retryableAttempts: 0,
      blockedAttempts: 0,
      unknownAttempts: 0,
      attempts: [],
    },
  };
}

function buildApp(caps: Set<string>, seenPersonalPayers: string[] = []): FastifyInstance {
  const app = Fastify();
  app.decorateRequest("sessionUserId", null);
  app.addHook("preHandler", async (request) => {
    const uid = request.headers["x-test-user"];
    request.sessionUserId = typeof uid === "string" && uid.length > 0 ? uid : null;
  });
  costsRoutes(app, {
    hasBillingCapability: async (userId) => caps.has(userId),
    getCostsSummary: async () => fakeSummary(),
    getPersonalCostsSummary: async (input) => {
      seenPersonalPayers.push(input.payerHumanId);
      return fakePersonalSummary();
    },
  });
  return app;
}

describe("/api/costs auth gating (D405)", () => {
  let app: FastifyInstance;

  beforeEach(() => {
    app = buildApp(new Set([OWNER]));
  });

  test("401 when unauthenticated", async () => {
    const res = await app.inject({ method: "GET", url: "/api/costs" });
    expect(res.statusCode).toBe(401);
  });

  test("403 when signed in without manage_billing", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/costs",
      headers: { "x-test-user": MEMBER },
    });
    expect(res.statusCode).toBe(403);
  });

  test("200 with enriched payload for a billing-capable user", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/costs?range=30d",
      headers: { "x-test-user": OWNER },
    });
    expect(res.statusCode).toBe(200);
    const servicePayload = res.json<CostsApiResponse>();
    expect(servicePayload.serviceOperations).toEqual(fakeSummary().serviceOperations);
    expect(servicePayload.serviceRecovery).toEqual(fakeSummary().serviceRecovery);
    const body: CostsApiResponse = res.json();
    expect(body.pricingVersion).toBeTruthy();
    expect(body.providerPricingVersion).toBe("2026-09-02.1");
    expect(body.providerCoverage.state).toBe("partial");
    expect(body.providerCoverage.accounted).toContainEqual({ provider: "browser_use", operation: "hosted_read" });
    expect(body.providerCoverage.accounted).toContainEqual({ provider: "tavily", operation: "search" });
    expect(body.providerCoverage.accounted).toContainEqual({ provider: "cloudconvert", operation: "conversion" });
    expect(body.providerCoverage.unavailable).toEqual(["dynamic_mcp_billing", "external_harness_billing"]);
    expect(body.byProvider).toEqual(fakeSummary().byProvider);
    expect(body.totals.pendingModelAttempts).toBe(1);
    expect(body.totals.unknownModelAttempts).toBe(1);

    // byModel enriched with a catalog display name.
    expect(body.byModel[0]?.displayName).toContain("Claude Sonnet 4.6");
    expect(body.byModel[0]?.hasFallbackEstimate).toBe(true);

    // byUser rows get a human label; null user → system/background.
    expect(body.byUser[0]?.label).toBe("@alex");
    expect(body.byUser[1]?.label).toBe("system / background");
  });

  test("invalid range falls back to default without error", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/costs?range=nonsense",
      headers: { "x-test-user": OWNER },
    });
    expect(res.statusCode).toBe(200);
  });
});

describe("/api/account/costs session scoping", () => {
  test("requires authentication without a billing capability", async () => {
    const app = buildApp(new Set());
    const unauthenticated = await app.inject({ method: "GET", url: "/api/account/costs" });
    expect(unauthenticated.statusCode).toBe(401);

    const seen: string[] = [];
    const memberApp = buildApp(new Set(), seen);
    const response = await memberApp.inject({
      method: "GET",
      url: "/api/account/costs?range=7d",
      headers: { "x-test-user": MEMBER },
    });
    expect(response.statusCode).toBe(200);
    expect(seen).toEqual([MEMBER]);
    expect(response.json()).toMatchObject({
      currency: "USD",
      range: { key: "7d" },
      entry: { available: true, hasPersonalCredentials: false, hasHistory: true },
      totals: { actualCostUsd: 0.000283, totalCostUsd: 0.000283 },
    });
  });

  test("invalid ranges use the bounded default", async () => {
    const app = buildApp(new Set());
    const response = await app.inject({
      method: "GET",
      url: "/api/account/costs?range=all",
      headers: { "x-test-user": MEMBER },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json<PersonalCostsSummary>().range.key).toBe("30d");
  });
});
