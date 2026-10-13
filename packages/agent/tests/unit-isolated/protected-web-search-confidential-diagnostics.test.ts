/** Real search synthesis and model diagnostics; only provider I/O and funding admission are replaced. */
import { afterAll, beforeAll, beforeEach, expect, mock, spyOn, test } from "bun:test";
import type { ChatModel } from "../../src/providers/types";
import { __setStubModelForTests } from "../../src/providers/universal";
import { fromRuntimeConfig } from "@nautilo/config";
import { runWithCapabilityFundingSession, type CapabilityFundingSession } from "../../src/runtime/capability-funding";
import { createRunWebSearchTool } from "../../src/tools/utilities/web-search";

const marker = "PRIVATE_WEB_SEARCH_SYNTHESIS_ERROR_CANARY";
const cause = Object.assign(new Error(`provider unavailable ${marker}`), { status: 503 });
const priorTestMode = process.env["NAUTILO_TEST_MODE"];
let calls = 0;
const provider: ChatModel = {
  bindTools: () => provider,
  invoke: async () => { calls += 1; throw cause; },
};
const db = await import("@nautilo/db");
spyOn(db, "getCachedServerModelConfigRow").mockReturnValue(null);
spyOn(db, "kickServerModelConfigRefresh").mockImplementation(() => {});
const fallback = await import("../../src/utils/resolve-fallback-policy");
spyOn(fallback, "resolveFallbackPolicy").mockResolvedValue({ enabled: false, chain: [] });
const health = await import("../../src/utils/model-health");
const healthFailure = spyOn(health, "markModelInvokeFailure").mockImplementation(() => {});
const capability: CapabilityFundingSession = {
  humanUserId: "human-web-search",
  resolveModel: async () => ({ modelId: "anthropic:claude-sonnet-4-6", preferenceRevision: 7 }),
  openModel: async () => ({
    binding: { kind: "server", providerRoute: "anthropic" },
    fundingSession: {
      kind: "server", workload: "research", recheckAttempt: async () => {},
      runAttempt: async (_modelId, use) => use({ usageFunding: { kind: "server", providerRoute: "anthropic" } }),
    },
  }),
  openService: async () => { throw new Error("No paid search service in fixture"); },
};

beforeAll(() => {
  process.env["NAUTILO_TEST_MODE"] = "stub";
  __setStubModelForTests(provider);
});
beforeEach(() => { calls = 0; health.clearHealthCache(); healthFailure.mockClear(); });
afterAll(() => {
  __setStubModelForTests(null);
  health.clearHealthCache();
  mock.restore();
  if (priorTestMode === undefined) delete process.env["NAUTILO_TEST_MODE"];
  else process.env["NAUTILO_TEST_MODE"] = priorTestMode;
});

for (const confidential of [false, true]) {
  test(`actual web-search synthesis retains the trusted diagnostic policy (${confidential})`, async () => {
    const logger = spyOn(console, "error").mockImplementation(() => {});
    try {
      const tool = createRunWebSearchTool({
        causalHumanUserId: capability.humanUserId,
        agentId: "agent", currentTaskId: "task", currentTaskRunId: "run",
        ...(confidential ? { confidential: true } : {}),
      }, {
        getRuntimeConfig: () => ({ ...fromRuntimeConfig({ nautilo_search_provider: "duckduckgo_html" }),
          nautilo_search_trusted_domains: [], nautilo_search_read_pages: 0 }),
        createSearchFetcher: () => async query => ({ provider: "duckduckgo_html", query,
          items: [{ url: "https://example.org/article", title: "Example", snippet: "Useful snippet" }] }),
      });
      const failure: unknown = await runWithCapabilityFundingSession(capability,
        () => tool.invoke({ query: "Authorized research", confidential: true }))
        .catch((error: unknown) => error);
      expect(failure).toBe(cause);
      expect(calls).toBe(1);
      expect(JSON.stringify(logger.mock.calls).includes(marker)).toBe(!confidential);
      expect(healthFailure).toHaveBeenCalledTimes(1);
      expect(JSON.stringify(healthFailure.mock.calls).includes(marker)).toBe(!confidential);
      if (confidential) expect(healthFailure.mock.calls[0]?.[1]).toBe("SERVICE_ERROR");
    } finally { logger.mockRestore(); }
  });
}
