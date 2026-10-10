import { afterEach, describe, expect, test } from "bun:test";
import {
  getUsageContext,
  runWithCapabilityFundingSession,
  type CapabilityFundingSession,
} from "@nautilo/agent";
import { getDeepResearchFunding } from "../../../agent/src/subagents/deep-research/shared/funding";
import {
  DeepResearchFundingUnavailableError,
  _setDeepResearchEventStreamForTests,
  resolveDeepResearchExecutorConfiguration,
  streamDeepResearchReport,
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
  afterEach(() => {
    _setDeepResearchEventStreamForTests(null);
  });

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

  test("runs a server-funded v2 research worker inside the admitted funding scope", async () => {
    const observedFunding: Array<ReturnType<typeof getDeepResearchFunding>> = [];
    const observedUsage: Array<ReturnType<typeof getUsageContext>> = [];
    _setDeepResearchEventStreamForTests((_graph, _input, _config) => {
      observedFunding.push(getDeepResearchFunding());
      observedUsage.push(getUsageContext());
      return {
        [Symbol.asyncIterator]() {
          observedFunding.push(getDeepResearchFunding());
          observedUsage.push(getUsageContext());
          let complete = false;
          return {
            async next() {
              if (complete) return { done: true as const, value: undefined };
              complete = true;
              return {
                done: false as const,
                value: {
                  event: "on_chain_end",
                  data: { output: { final_report: "funded report" } },
                },
              };
            },
          };
        },
      };
    });

    const stream = streamDeepResearchReport({
      research_brief: "bounded test research",
      deep_research_model_plan: modelPlan,
      deep_research_funding: funding,
    }, "run-funded-eager-stream", new AbortController().signal, session.humanUserId, {
      roomId: "room-funded-research",
      taskId: "task-funded-research",
      taskRunId: "run-funded-research",
      agentId: "agent-funded-research",
    });

    expect(await runWithCapabilityFundingSession(session, () => stream.next())).toEqual({
      done: false,
      value: { phase: "Starting deep research..." },
    });
    expect(await runWithCapabilityFundingSession(session, () => stream.next())).toEqual({
      done: true,
      value: "funded report",
    });
    expect(observedFunding).toEqual([
      { modelFunding: funding.modelFunding, tavilyFunding: funding.tavilyFunding },
      { modelFunding: funding.modelFunding, tavilyFunding: funding.tavilyFunding },
    ]);
    expect(observedUsage).toEqual([
      {
        callType: "deep_research",
        userId: session.humanUserId,
        roomId: "room-funded-research",
        metadata: {
          taskId: "task-funded-research",
          taskRunId: "run-funded-research",
          agentId: "agent-funded-research",
          executionId: "run-funded-eager-stream",
          operation: "deep_research",
        },
      },
      {
        callType: "deep_research",
        userId: session.humanUserId,
        roomId: "room-funded-research",
        metadata: {
          taskId: "task-funded-research",
          taskRunId: "run-funded-research",
          agentId: "agent-funded-research",
          executionId: "run-funded-eager-stream",
          operation: "deep_research",
        },
      },
    ]);
  });
});
