import { afterEach, describe, expect, test } from "bun:test";
import { NautiloApiClient } from "../../src/client";

const BASE = "http://127.0.0.1:9";
const originalFetch = globalThis.fetch;
const summary = {
  currency: "USD" as const,
  range: { key: "30d" as const, since: "2026-09-05T00:00:00.000Z", until: "2026-10-05T00:00:00.000Z" },
  pricingVersion: "catalog-v1",
  entry: { available: true, hasPersonalCredentials: true, hasHistory: false },
  totals: { calls: 0, providerOperations: 0, inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, totalTokens: 0, estimatedCostUsd: 0, actualCostUsd: 0, totalCostUsd: 0, pendingAttempts: 0, unknownAttempts: 0, retryableAttempts: 0, blockedAttempts: 0 },
  byModel: [], byCallType: [], byProvider: [], timeSeries: [],
  recovery: { pendingAttempts: 0, retryableAttempts: 0, blockedAttempts: 0, unknownAttempts: 0 },
};

afterEach(() => { globalThis.fetch = originalFetch; });

describe("personal costs client contract", () => {
  test("uses the session-scoped account route and parses the empty-before-use state", async () => {
    const calls: Array<{ url: string; authorization: string | null }> = [];
    globalThis.fetch = (async (input, init) => {
      calls.push({
        url: typeof input === "string" ? input : (input as URL).toString(),
        authorization: new Headers(init?.headers).get("authorization"),
      });
      return Response.json(summary);
    }) as typeof fetch;
    const client = new NautiloApiClient(BASE);
    client.setToken("human-session");

    expect(await client.getPersonalCosts("30d")).toEqual(summary);
    expect(calls).toEqual([{ url: `${BASE}/api/account/costs?range=30d`, authorization: "Bearer human-session" }]);
  });

  test("rejects malformed spend instead of presenting it as zero", async () => {
    globalThis.fetch = (async () => Response.json({
      ...summary,
      totals: { ...summary.totals, actualCostUsd: -1 },
    })) as unknown as typeof fetch;
    expect(new NautiloApiClient(BASE).getPersonalCosts("30d")).rejects.toThrow();
  });
});
