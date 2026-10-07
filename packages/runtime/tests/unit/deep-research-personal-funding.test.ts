import { describe, expect, test } from "bun:test";
import {
  runWithCapabilityFundingSession,
  type CapabilityFundingSession,
} from "@nautilo/agent";
import {
  DeepResearchFundingUnavailableError,
  resolveDeepResearchExecutorConfiguration,
} from "../../src/executors/deep-research-executor";

const modelPlan = {
  version: 1 as const,
  supervisorModel: "openrouter:supervisor",
  researchModel: "openrouter:researcher",
  summarizationModel: "openrouter:summarizer",
  compressionModel: "openrouter:compressor",
  finalReportModel: "openrouter:reporter",
};

const serverBinding = { kind: "server" as const, providerRoute: "openrouter" };
const funding = {
  version: 2 as const,
  reportLanguage: "English",
  invokingModelId: null,
  modelPlan,
  preferenceRevisions: { supervisor: 1, research: 1, summarization: 1, compression: 1, finalReport: 1 },
  modelFunding: { supervisor: serverBinding, research: serverBinding, summarization: serverBinding,
    compression: serverBinding, finalReport: serverBinding },
  tavilyFunding: { kind: "server" as const, providerRoute: "tavily" },
};

const session: CapabilityFundingSession = {
  humanUserId: "human-research",
  resolveModel: async () => ({ modelId: "unused", preferenceRevision: 1 }),
  openModel: async (_id, _workload, prior) => ({ binding: prior ?? serverBinding,
    fundingSession: { kind: "server", runAttempt: async (_model, callback) => callback({
      usageFunding: { kind: "server", providerRoute: "openrouter" },
    }), recheckAttempt: async () => {} } }),
  openService: async (_provider, prior) => ({ binding: prior ?? funding.tavilyFunding,
    runAttempt: async (callback) => callback({ apiKey: "transient",
      usageFunding: { kind: "server", providerRoute: "tavily" } }) }),
};

describe("Deep Research personal funding recovery", () => {
  test("fails closed when v2 funding metadata has no live capability scope", () => {
    expect(() => resolveDeepResearchExecutorConfiguration({
      deep_research_model_plan: modelPlan,
      deep_research_funding: funding,
    }, { OPENROUTER_API_KEY: "server-key", TAVILY_API_KEY: "server-tavily" }))
      .toThrow(DeepResearchFundingUnavailableError);
  });

  test("rehydrates exact admitted lanes without copying ambient credentials", () => {
    const config = runWithCapabilityFundingSession(session, () =>
      resolveDeepResearchExecutorConfiguration({
        deep_research_model_plan: modelPlan,
        deep_research_funding: funding,
      }, { OPENROUTER_API_KEY: "must-not-enter-config", TAVILY_API_KEY: "must-not-enter-config",
        SEARCH_API: "none", MCP_CONFIG: JSON.stringify({ url: "https://external.invalid/tools" }) }));
    expect(config.supervisor_model).toBe(modelPlan.supervisorModel);
    expect(config.final_report_model).toBe(modelPlan.finalReportModel);
    expect(config.openrouter_api_key).toBeNull();
    expect(config.search_api).toBe("tavily");
    expect(config.mcp_config).toBeNull();
  });

  test("rejects a model plan that differs from the admitted metadata", () => {
    expect(() => runWithCapabilityFundingSession(session, () =>
      resolveDeepResearchExecutorConfiguration({
        deep_research_model_plan: { ...modelPlan, researchModel: "openrouter:changed" },
        deep_research_funding: funding,
      }, {}))).toThrow(DeepResearchFundingUnavailableError);
  });
});
