import { afterEach, describe, expect, spyOn, test } from "bun:test";
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

  test.each([false, true])("runs a server-funded v2 research worker inside the admitted funding scope (confidential=%s)", async confidential => {
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
    }, confidential ? { confidential: true } : undefined);

    expect(await runWithCapabilityFundingSession(session, () => stream.next())).toEqual({
      done: false,
      value: { phase: confidential ? "deep_research_running" : "Starting deep research..." },
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


for (const confidential of [false, true]) {
  test(`research stream preserves funding but closes diagnostics when confidential=${confidential}`, async () => {
    const marker = "PRIVATE_RESEARCH_PROVIDER_DETAIL";
    const logger = spyOn(console, "error").mockImplementation(() => {});
    const observed: unknown[] = [];
    _setDeepResearchEventStreamForTests(() => {
      observed.push(getDeepResearchFunding());
      return {
        [Symbol.asyncIterator]() {
          observed.push(getDeepResearchFunding());
          let calls = 0;
          return {
            async next() {
              observed.push(getDeepResearchFunding());
              if (calls++ === 0) return { done: false as const, value: {
                event: "on_custom_event", name: "job.progress", data: { phase: marker },
              } };
              throw new Error(marker);
            },
            async return() {
              observed.push(getDeepResearchFunding());
              return { done: true as const, value: undefined };
            },
          };
        },
      };
    });
    try {
      const stream = streamDeepResearchReport({ research_brief: marker,
        deep_research_model_plan: modelPlan, deep_research_funding: funding },
      "run-confidential", new AbortController().signal, session.humanUserId,
      undefined, confidential ? { confidential: true } : undefined);
      const progress: unknown[] = [];
      let failure: unknown;
      try {
        for (;;) {
          const next = await runWithCapabilityFundingSession(session, () => stream.next());
          if (next.done) break;
          progress.push(next.value);
        }
      } catch (error) { failure = error; }
      expect(failure).toBeInstanceOf(Error);
      expect((failure as Error).message).toBe(confidential ? "deep_research_failed" : marker);
      expect((failure as Error).cause).toBeUndefined();
      expect(JSON.stringify(logger.mock.calls).includes(marker)).toBe(!confidential);
      expect(JSON.stringify(progress).includes(marker)).toBe(!confidential);
      if (confidential) expect(progress).toEqual(Array.from({ length: 3 }, () => ({ phase: "deep_research_running" })));
      expect(observed).toHaveLength(5);
      expect(observed.every(value => JSON.stringify(value) === JSON.stringify({
        modelFunding: funding.modelFunding, tavilyFunding: funding.tavilyFunding,
      }))).toBe(true);
    } finally {
      logger.mockRestore();
      _setDeepResearchEventStreamForTests(null);
    }
  });
}

test("confidential stream preserves closed funding failure without ambient fallback", async () => {
  const stream = streamDeepResearchReport({ research_brief: "private", deep_research_funding: funding },
    "run-no-custody", new AbortController().signal, session.humanUserId, undefined, { confidential: true });
  expect(await stream.next()).toEqual({ done: false, value: { phase: "deep_research_running" } });
  expect(await stream.next().catch((error: unknown) => error)).toBeInstanceOf(DeepResearchFundingUnavailableError);
});


test("confidential stream retains only an allowlisted funding code, never its message or cause", async () => {
  _setDeepResearchEventStreamForTests(() => ({
    async *[Symbol.asyncIterator]() {
      yield { event: "on_custom_event", name: "job.progress", data: { phase: "funding" } };
      throw Object.assign(new Error("PRIVATE_FUNDING_DETAIL"), { code: "funding_source_changed" });
    },
  }));
  try {
    const stream = streamDeepResearchReport({ research_brief: "private", deep_research_funding: funding },
      "run-funding-changed", new AbortController().signal, session.humanUserId, undefined, { confidential: true });
    let failure: unknown;
    try {
      while (!(await runWithCapabilityFundingSession(session, () => stream.next())).done) { /* drain closed progress */ }
    } catch (error) { failure = error; }
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toBe("funding_source_changed");
    expect((failure as Error).cause).toBeUndefined();
    expect(failure).toHaveProperty("code", "funding_source_changed");
  } finally { _setDeepResearchEventStreamForTests(null); }
});
