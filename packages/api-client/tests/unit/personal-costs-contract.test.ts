import { afterEach, describe, expect, test } from "bun:test";
import { NautiloApiClient } from "../../src/client";

const BASE = "http://127.0.0.1:9";
const originalFetch = globalThis.fetch;
const summary = {
  currency: "USD" as const,
  range: { key: "30d" as const, since: "2026-09-05T00:00:00.000Z", until: "2026-10-05T00:00:00.000Z" },
  pricingVersion: "catalog-v1",
  entry: { available: true, hasPersonalCredentials: true, hasHistory: false },
  totals: { calls: 0, providerOperations: 0, unknownProviderOperations: 0, inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, totalTokens: 0, estimatedCostUsd: 0, actualCostUsd: 0, totalCostUsd: 0, pendingAttempts: 0, unknownAttempts: 0, retryableAttempts: 0, blockedAttempts: 0 },
  byModel: [], byCallType: [], byProvider: [], byTask: [], timeSeries: [],
  recovery: {
    pendingAttempts: 0,
    retryableAttempts: 0,
    blockedAttempts: 0,
    unknownAttempts: 0,
    attempts: [],
  },
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

  test("preserves unknown service counts independently of model-route rows", async () => {
    const response = {
      ...summary,
      totals: { ...summary.totals, providerOperations: 1, unknownProviderOperations: 1, unknownAttempts: 1 },
      byProvider: [
        { provider: "surplus", operation: "chat", operations: 1, unknownOperations: 1, estimatedCostUsd: 0, actualCostUsd: 0, totalCostUsd: 0 },
        { provider: "tavily", operation: "search", operations: 1, unknownOperations: 1, estimatedCostUsd: 0, actualCostUsd: 0, totalCostUsd: 0 },
      ],
    };
    globalThis.fetch = (async () => Response.json(response)) as unknown as typeof fetch;
    expect((await new NautiloApiClient(BASE).getPersonalCosts("30d")).totals.unknownProviderOperations).toBe(1);
  });

  test("retains service outcomes and unresolved cost evidence without accepting payload data", async () => {
    const serviceOperations = { operations: 3, succeeded: 1, failed: 0, cancelled: 1, interrupted: 0, unknown: 0, legacy: 1 };
    const serviceRecovery = { attempts: [{ provider: "tavily", operation: "search", workload: "deep_research",
      attemptOutcome: "cancelled" as const, failureCode: "cancelled", taskId: null, runId: null, jobId: null,
      occurredAt: "2026-10-08T00:00:00.000Z" }] };
    globalThis.fetch = (async () => Response.json({ ...summary, serviceOperations, serviceRecovery })) as unknown as typeof fetch;
    const parsed = await new NautiloApiClient(BASE).getPersonalCosts("30d");
    expect(parsed.serviceOperations).toEqual(serviceOperations);
    expect(parsed.serviceRecovery).toEqual(serviceRecovery);
    globalThis.fetch = (async () => Response.json({ ...summary, serviceRecovery: { attempts: [{ ...serviceRecovery.attempts[0], prompt: "private" }] } })) as unknown as typeof fetch;
    const rejected = await new NautiloApiClient(BASE).getPersonalCosts("30d").catch((error: unknown) => error);
    expect(rejected).toBeInstanceOf(Error);
  });

  test("accepts older server summaries without additive accounting fields", async () => {
    const { unknownProviderOperations: omitted, ...legacyTotals } = summary.totals;
    const { attempts: omittedAttempts, ...legacyRecovery } = summary.recovery;
    const { byTask: omittedTasks, ...legacySummary } = summary;
    void omitted;
    void omittedAttempts;
    void omittedTasks;
    globalThis.fetch = (async () => Response.json({
      ...legacySummary,
      totals: legacyTotals,
      recovery: legacyRecovery,
    })) as unknown as typeof fetch;
    const parsed = await new NautiloApiClient(BASE).getPersonalCosts("30d");
    expect(parsed.totals.unknownProviderOperations).toBe(0);
    expect(parsed.byTask).toEqual([]);
    expect(parsed.recovery.attempts).toEqual([]);
  });

  test("parses own-Task attribution and bounded recovery diagnostics", async () => {
    const taskId = "22222222-2222-4222-8222-222222222222";
    const attemptId = "33333333-3333-4333-8333-333333333333";
    const reason = "upstream_".repeat(12);
    const response = {
      ...summary,
      byTask: [{
        taskId,
        calls: 1,
        providerOperations: 2,
        unknownProviderOperations: 1,
        estimatedCostUsd: 0,
        actualCostUsd: 0,
        totalCostUsd: 0,
        pendingAttempts: 0,
        unknownAttempts: 1,
      }],
      recovery: {
        ...summary.recovery,
        unknownAttempts: 1,
        attempts: [{
          attemptId,
          status: "unrecoverable",
          reason,
          providerRoute: "openrouter",
          requestReference: "req_0123456789ab",
          lastObservedAt: "2026-10-05T00:00:00.000Z",
          repairAction: "review_cost",
          taskId,
        }],
      },
    };
    globalThis.fetch = (async () => Response.json(response)) as unknown as typeof fetch;

    const parsed = await new NautiloApiClient(BASE).getPersonalCosts("30d");
    expect(parsed.byTask[0]?.taskId).toBe(taskId);
    expect(parsed.recovery.attempts[0]).toMatchObject({ attemptId, taskId, reason });
    for (const invalidReason of ["", "unsafe provider prose", "<provider_error>"]) {
      response.recovery.attempts[0]!.reason = invalidReason;
      const failure = await new NautiloApiClient(BASE).getPersonalCosts("30d")
        .then(() => null, (error: unknown) => error);
      expect(failure).toBeInstanceOf(Error);
    }
  });

  test("rejects malformed spend instead of presenting it as zero", async () => {
    globalThis.fetch = (async () => Response.json({
      ...summary,
      totals: { ...summary.totals, actualCostUsd: -1 },
    })) as unknown as typeof fetch;
    expect(new NautiloApiClient(BASE).getPersonalCosts("30d")).rejects.toThrow();
  });
});
