import { describe, expect, test } from "bun:test";
import { PROVIDER_TOOL_PRICING_VERSION } from "@nautilo/db";

import { runRecordedDeepResearchTavilySearch } from "../../src/subagents/deep-research/search/factory";
import type { ProviderCostReceipt, ProviderCostRecorder } from "../../src/usage/provider-cost-recorder";

function lifecycleRecorder(events: Array<{ phase: string; receipt: Record<string, unknown> }>): ProviderCostRecorder {
  const settlement = Object.assign(async (receipt: ProviderCostReceipt) => {
    events.push({ phase: "settle", receipt });
  }, { attemptStarted: true as const });
  return Object.assign(async (_receipt: ProviderCostReceipt) => {}, {
    beginAttempt: async (admission: { provider: string; operation: string }) => {
      events.push({ phase: "begin", receipt: admission });
      return settlement;
    },
  }) as ProviderCostRecorder;
}

describe("Deep Research Tavily cost lifecycle", () => {
  test("opens before invocation and settles the fixed search-depth estimate on success", async () => {
    const events: Array<{ phase: string; receipt: Record<string, unknown> }> = [];
    const result = await runRecordedDeepResearchTavilySearch(
      async () => [{ url: "https://example.com" }],
      lifecycleRecorder(events),
      "advanced",
    );

    expect(result).toEqual([{ url: "https://example.com" }]);
    expect(events.map(({ phase }) => phase)).toEqual(["begin", "settle"]);
    expect(events[1]?.receipt).toMatchObject({
      provider: "tavily",
      operation: "deep_research_search",
      estimatedCostUsd: "0.01600000",
      evidenceState: "estimated",
      attemptOutcome: "succeeded",
      pricingVersion: PROVIDER_TOOL_PRICING_VERSION,
      measuredUnits: null,
      unitType: null,
    });
  });

  test("leaves monetary evidence unknown when the provider response is lost", async () => {
    const events: Array<{ phase: string; receipt: Record<string, unknown> }> = [];
    const secret = "private provider response body";
    const failure = await runRecordedDeepResearchTavilySearch(
      async () => { throw new Error(secret); },
      lifecycleRecorder(events),
      "basic",
    ).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toBe(secret);
    expect(events[1]?.receipt).toMatchObject({
      evidenceState: "unknown",
      attemptOutcome: "unknown",
      failureCode: "provider_transport_unknown",
    });
    expect(JSON.stringify(events)).not.toContain(secret);
  });

  test("settles cancellation when the existing Deep Research signal aborts provider invocation", async () => {
    const events: Array<{ phase: string; receipt: Record<string, unknown> }> = [];
    const controller = new AbortController();
    const failure = await runRecordedDeepResearchTavilySearch(
      async () => {
        controller.abort(new DOMException("Research stopped", "AbortError"));
        throw controller.signal.reason;
      },
      lifecycleRecorder(events),
      "basic",
      controller.signal,
    ).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(DOMException);
    expect(events.map(({ phase }) => phase)).toEqual(["begin", "settle"]);
    expect(events[1]?.receipt).toMatchObject({
      evidenceState: "unknown",
      attemptOutcome: "cancelled",
      failureCode: "request_cancelled",
    });
  });
});
