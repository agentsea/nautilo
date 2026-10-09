import { expect, mock, test } from "bun:test";
import type { CapabilityFundingSession } from "../../src/runtime/capability-funding";
import type { Configuration } from "../../src/subagents/deep-research/shared/config";
import type { ProviderCostReceipt, ProviderCostRecorder } from "../../src/usage/provider-cost-recorder";

const settledReceipts: ProviderCostReceipt[] = [];
const attemptRecorder = Object.assign(async (receipt: ProviderCostReceipt) => {
  settledReceipts.push(receipt);
}, { attemptStarted: true as const }) as ProviderCostRecorder;

mock.module("../../src/usage/provider-cost-recorder", () => ({
  beginToolProviderCostAttempt: async () => attemptRecorder,
  createToolProviderCostRecorder: () => attemptRecorder,
  openProviderCostAttempt: async (recorder: ProviderCostRecorder) => recorder,
  providerToolEstimateReceipt: () => ({
    estimatedCostUsd: "0.00800000",
    evidenceState: "estimated" as const,
    pricingVersion: "test-pricing-v1",
    measuredUnits: null,
    unitType: null,
  }),
}));

const { buildSearchTool } = await import("../../src/subagents/deep-research/search/factory");
const { runWithCapabilityFundingSession } = await import("../../src/runtime/capability-funding");
const { runWithDeepResearchFunding } = await import("../../src/subagents/deep-research/shared/funding");

const configuration = {
  search_api: "tavily",
  search_max_results: 5,
  search_depth: "basic",
} as Configuration;

const personalBinding = {
  kind: "personal" as const,
  providerRoute: "tavily",
  credentialId: "11111111-1111-4111-8111-111111111111",
  credentialRevision: 3,
};
const modelBinding = { kind: "server" as const, providerRoute: "openrouter" };
const researchFunding = {
  modelFunding: {
    supervisor: modelBinding,
    research: modelBinding,
    summarization: modelBinding,
    compression: modelBinding,
    finalReport: modelBinding,
  },
  tavilyFunding: personalBinding,
};

test("sends the admitted personal Tavily credential instead of the ambient server key", async () => {
  const originalFetch = globalThis.fetch;
  const originalServerKey = process.env["TAVILY_API_KEY"];
  const personalKey = "tvly-personal-callback-key";
  const serverKey = "tvly-ambient-server-key";
  const authorizations: Array<string | null> = [];
  let requestUrl = "";
  settledReceipts.length = 0;
  process.env["TAVILY_API_KEY"] = serverKey;
  globalThis.fetch = mock(async (input: string | URL | Request, init?: RequestInit) => {
    requestUrl = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    authorizations.push(new Headers(init?.headers).get("authorization"));
    return Response.json({
      query: "credential routing",
      results: [{
        title: "Synthetic result",
        url: "https://example.test/research",
        content: "No network request left this process.",
        score: 1,
      }],
      response_time: 0,
      request_id: "synthetic-provider-request",
    });
  }) as unknown as typeof fetch;

  const capability: CapabilityFundingSession = {
    humanUserId: "human-research",
    resolveModel: async () => { throw new Error("unused"); },
    openModel: async () => { throw new Error("unused"); },
    openService: async (provider, prior) => {
      expect(provider).toBe("tavily");
      expect(prior).toEqual(personalBinding);
      return {
        binding: personalBinding,
        runAttempt: async <T>(run: (attempt: {
          apiKey: string;
          usageFunding: {
            kind: "personal";
            humanUserId: string;
            payerHumanId: string;
            providerRoute: string;
            credentialId: string;
            credentialRevision: number;
          };
        }) => Promise<T>) => run({
          apiKey: personalKey,
          usageFunding: {
            kind: "personal",
            humanUserId: "human-research",
            payerHumanId: "human-research",
            providerRoute: "tavily",
            credentialId: personalBinding.credentialId,
            credentialRevision: personalBinding.credentialRevision,
          },
        }),
      };
    },
  };

  try {
    const result = await runWithCapabilityFundingSession(capability, () =>
      runWithDeepResearchFunding(researchFunding, () =>
        buildSearchTool(configuration)("credential routing")));

    expect(requestUrl).toBe("https://api.tavily.com/search");
    expect(authorizations).toEqual([`Bearer ${personalKey}`]);
    expect(authorizations).not.toContain(`Bearer ${serverKey}`);
    expect(result.items).toEqual([{
      title: "Synthetic result",
      url: "https://example.test/research",
      snippet: "No network request left this process.",
    }]);
    expect(settledReceipts).toHaveLength(1);
    expect(settledReceipts[0]).toMatchObject({
      provider: "tavily",
      operation: "deep_research_search",
      receiptId: "synthetic-provider-request",
      attemptOutcome: "succeeded",
    });
  } finally {
    globalThis.fetch = originalFetch;
    if (originalServerKey === undefined) delete process.env["TAVILY_API_KEY"];
    else process.env["TAVILY_API_KEY"] = originalServerKey;
  }
});
