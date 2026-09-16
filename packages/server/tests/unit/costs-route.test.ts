/**
 * D405 — /api/costs auth gating + payload shape. The capability check and DB
 * aggregation are injected so this stays a pure route test (no DB).
 */
import { beforeEach, describe, expect, test } from "bun:test";
import Fastify, { type FastifyInstance } from "fastify";
import type { CostsSummary } from "@nautilo/db";
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
  byProvider: CostsSummary["byProvider"];
  byUser: Array<{ label: string }>;
};

function fakeSummary(): CostsSummary {
  return {
    range: { sinceIso: "2026-06-09T00:00:00.000Z", untilIso: "2026-07-09T00:00:00.000Z" },
    totals: {
      calls: 3,
      providerOperations: 1,
      unknownProviderOperations: 0,
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
      },
    ],
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
  };
}

function buildApp(caps: Set<string>): FastifyInstance {
  const app = Fastify();
  app.decorateRequest("sessionUserId", null);
  app.addHook("preHandler", async (request) => {
    const uid = request.headers["x-test-user"];
    request.sessionUserId = typeof uid === "string" && uid.length > 0 ? uid : null;
  });
  costsRoutes(app, {
    hasBillingCapability: async (userId) => caps.has(userId),
    getCostsSummary: async () => fakeSummary(),
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
    const body: CostsApiResponse = res.json();
    expect(body.pricingVersion).toBeTruthy();
    expect(body.providerPricingVersion).toBe("2026-09-02.1");
    expect(body.providerCoverage.state).toBe("partial");
    expect(body.providerCoverage.accounted).toContainEqual({ provider: "browser_use", operation: "hosted_read" });
    expect(body.providerCoverage.accounted).toContainEqual({ provider: "tavily", operation: "search" });
    expect(body.providerCoverage.accounted).toContainEqual({ provider: "cloudconvert", operation: "conversion" });
    expect(body.providerCoverage.unavailable).toEqual(["dynamic_mcp_billing", "external_harness_billing"]);
    expect(body.byProvider).toEqual(fakeSummary().byProvider);

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
