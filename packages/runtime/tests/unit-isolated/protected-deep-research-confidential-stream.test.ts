/** Real Runtime stream, LangGraph nodes and funded model router; only external I/O is replaced. */
import { afterAll, afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import { AIMessage } from "@langchain/core/messages";
import type { ChatModel } from "../../../agent/src/providers/types";
import type { CapabilityFundingSession } from "../../../agent/src/runtime/capability-funding";
import type { AdmittedDeepResearchTaskMetadata } from "../../../agent/src/subagents/deep-research/shared/task-metadata";
import * as logger from "@nautilo/logger";

const lanes = ["supervisor", "research", "summarization", "compression", "finalReport"] as const;
type Lane = typeof lanes[number];
const models: Record<Lane, string> = {
  supervisor: "anthropic:claude-sonnet-4-6",
  research: "openrouter:moonshotai/kimi-k3",
  summarization: "google:gemini-2.5-pro",
  compression: "fireworks:accounts/fireworks/models/deepseek-v4p1-flash",
  finalReport: "openai:gpt-5.5-2026-04-23",
};
const canary = "PRIVATE_RESEARCH_CANARY_71ac";
const modelFunding = {
  supervisor: { kind: "server", providerRoute: "anthropic" },
  research: { kind: "server", providerRoute: "openrouter" },
  summarization: { kind: "server", providerRoute: "google" },
  compression: { kind: "server", providerRoute: "fireworks" },
  finalReport: { kind: "server", providerRoute: "openai" },
} as const;
const modelPlan = {
  version: 1 as const, supervisorModel: models.supervisor, researchModel: models.research,
  summarizationModel: models.summarization, compressionModel: models.compression,
  finalReportModel: models.finalReport,
};
const admitted: AdmittedDeepResearchTaskMetadata = {
  version: 2, reportLanguage: "English", invokingModelId: null, modelPlan,
  preferenceRevisions: { supervisor: 1, research: 1, summarization: 1, compression: 1, finalReport: 1 },
  modelFunding,
  tavilyFunding: { kind: "server", providerRoute: "tavily" },
};
let failLane: Lane | undefined;
let failureStatus = 400;
const visits: Lane[] = [];
const opened: string[] = [];
const health: string[] = [];
const accounting: unknown[] = [];
const realtime: unknown[] = [];
const logs: unknown[][] = [];
const prompts: string[] = [];
let searchCalls = 0;

const actualDb = await import("@nautilo/db");
mock.module("@nautilo/db", () => ({ ...actualDb,
  getCachedServerModelConfigRow: () => null,
  kickServerModelConfigRefresh: () => {},
  insertProviderCostEvent: async (input: unknown) => { accounting.push(input); },
  settleProviderCostEvent: async (input: unknown) => { accounting.push(input); },
}));
const actualTrust = await import("@nautilo/trust");
mock.module("@nautilo/trust", () => ({ ...actualTrust,
  assertCanUseServerProviderCredentials: async () => {},
}));
mock.module("../../../agent/src/utils/resolve-fallback-policy", () => ({
  resolveFallbackPolicy: async () => ({ enabled: false, chain: [] }),
}));
const actualHealth = await import("../../../agent/src/utils/model-health");
mock.module("../../../agent/src/utils/model-health", () => ({ ...actualHealth,
  isModelHealthy: () => true,
  markModelInvokeFailure: (_model: string, reason: string) => { health.push(reason); },
}));
const actualSurplus = await import("../../../agent/src/providers/surplus-attempt");
mock.module("../../../agent/src/providers/surplus-attempt", () => ({ ...actualSurplus,
  canUseQualifiedSurplusChatRoute: () => false,
  invokeSurplusChatAttempt: async () => ({ kind: "direct_fallback" }),
}));
const actualUniversal = await import("../../../agent/src/providers/universal");
mock.module("../../../agent/src/providers/universal", () => ({ ...actualUniversal,
  createUniversalModel: async (modelId: string): Promise<ChatModel> => {
    const lane = lanes.find(candidate => models[candidate] === modelId);
    if (!lane) throw new Error("Unexpected model at provider boundary");
    const model: ChatModel = {
      bindTools: () => model,
      invoke: async messages => {
        visits.push(lane);
        prompts.push(JSON.stringify(messages));
        if (failLane === lane) throw Object.assign(new Error(`${canary}:${lane}:provider-error`), { status: failureStatus });
        const count = visits.filter(value => value === lane).length;
        if (lane === "supervisor") return new AIMessage({ content: `${canary}:supervisor-result`, tool_calls: [
          count === 1
            ? { id: "research-1", name: "ConductResearch", args: { research_topic: `${canary}:topic` }, type: "tool_call" }
            : { id: "complete-1", name: "ResearchComplete", args: {}, type: "tool_call" },
        ] });
        if (lane === "research") return new AIMessage({ content: `${canary}:research-result`, tool_calls: [
          count === 1
            ? { id: "search-1", name: "search", args: { query: `${canary}:query` }, type: "tool_call" }
            : { id: "complete-2", name: "ResearchComplete", args: {}, type: "tool_call" },
        ] });
        return new AIMessage(`${canary}:${lane}:result`);
      },
    };
    return model;
  },
}));
mock.module("@langchain/tavily", () => ({
  TavilySearch: class {
    async invoke(input: { query: string }) {
      searchCalls++;
      expect(input.query).toContain(canary);
      return { results: [{ url: "https://example.test/research", title: "Source", content: `${canary}:search-result` }] };
    }
  },
}));

const { runWithCapabilityFundingSession, getCapabilityFundingSession } = await import("../../../agent/src/runtime/capability-funding");
const { getUsageContext } = await import("../../../agent/src/usage/usage-context");
const { setAgentEventSink } = await import("../../../agent/src/runtime-hooks");
const { eventBus } = await import("../../src/event-bus");
const { streamDeepResearchReport } = await import("../../src/executors/deep-research-executor");
const funding: CapabilityFundingSession = {
  humanUserId: "research-human",
  resolveModel: async () => { throw new Error("Stored model plan must not be reselected"); },
  openModel: async (id, workload, prior) => {
    expect(getCapabilityFundingSession()).toBe(funding);
    expect(workload).toBe("research");
    const lane = lanes.find(candidate => models[candidate] === id);
    if (!lane) throw new Error("Unexpected admitted model");
    const binding = modelFunding[lane];
    expect(prior).toEqual(binding);
    opened.push(id);
    return { binding, fundingSession: {
      kind: "server", workload: "research",
      runAttempt: async (_modelId, use) => {
        expect(getUsageContext()).toMatchObject({
          userId: "research-human", roomId: "room-research",
          metadata: { taskId: "task-research", taskRunId: "run-research", agentId: "agent-research" },
        });
        return use({ usageFunding: binding });
      },
      recheckAttempt: async () => {},
    } };
  },
  openService: async (provider, prior) => {
    expect(getCapabilityFundingSession()).toBe(funding);
    expect(provider).toBe("tavily");
    expect(prior).toEqual(admitted.tavilyFunding);
    return { binding: { kind: "server", providerRoute: "tavily" },
      runAttempt: async use => use({ apiKey: "unit-only", usageFunding: { kind: "server", providerRoute: "tavily" } }),
    };
  },
};
const env = {
  NAUTILO_TEST_MODE: "stub", TAVILY_API_KEY: "unit-only", ANTHROPIC_API_KEY: "unit-only",
  OPENROUTER_API_KEY: "unit-only", GOOGLE_API_KEY: "unit-only", FIREWORKS_API_KEY: "unit-only", OPENAI_API_KEY: "unit-only",
  ALLOW_CLARIFICATION: "false", PREFER_NATIVE_SEARCH: "false",
};
const previousEnv = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]));
Object.assign(process.env, env);
const forbiddenNetworkFetch: typeof fetch = Object.assign(
  async (_input: string | URL | Request, _init?: RequestInit): Promise<Response> => {
    throw new Error("Network forbidden in isolated research test");
  },
  { preconnect: (_url: string | URL) => {} },
);
const network = spyOn(globalThis, "fetch").mockImplementation(forbiddenNetworkFetch);
const spies = (["log", "warn", "error"] as const).map(method => spyOn(logger, method).mockImplementation((...args: unknown[]) => { logs.push(args); }));
const consoleSpies = (["log", "warn", "error"] as const).map(method => spyOn(console, method).mockImplementation((...args: unknown[]) => { logs.push(args); }));
const eventSpy = spyOn(eventBus, "emit").mockImplementation(event => { realtime.push(event); });
setAgentEventSink({ emit: event => { realtime.push(event); } });

beforeEach(() => {
  failLane = undefined;
  failureStatus = 400;
  for (const values of [visits, opened, health, accounting, realtime, logs, prompts]) values.length = 0;
  searchCalls = 0;
});
afterEach(() => {
  expect(realtime).toEqual([]);
  expect(network).not.toHaveBeenCalled();
});
afterAll(() => {
  for (const spy of [...spies, ...consoleSpies]) spy.mockRestore();
  eventSpy.mockRestore();
  setAgentEventSink(null);
  network.mockRestore();
  for (const [key, value] of Object.entries(previousEnv)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
});

async function run(version: 1 | 2, confidential: boolean) {
  const progress: unknown[] = [];
  const scoped = <T>(use: () => T) => runWithCapabilityFundingSession(version === 2 ? funding : undefined, use);
  const iterator = scoped(() => streamDeepResearchReport({
    research_brief: `${canary}:brief`, report_language: "English", deep_research_model_plan: modelPlan,
    ...(version === 2 ? { deep_research_funding: admitted } : {}),
  }, "job-research", new AbortController().signal, "research-human", {
    roomId: "room-research", taskId: "task-research", taskRunId: "run-research", agentId: "agent-research",
  }, confidential ? { confidential: true } : undefined));
  try {
    for (;;) {
      const next = await scoped(() => iterator.next());
      if (next.done) return { report: next.value, error: null, progress };
      progress.push(next.value);
    }
  } catch (error) {
    return { report: null, error, progress };
  } finally { await scoped(() => iterator.return("")); }
}

for (const version of [1, 2] as const) {
  test(`real v${version} graph routes all five lanes without exposing private results`, async () => {
    const result = await run(version, true);
    expect(result.error).toBeNull();
    expect(result.report).toBe(`${canary}:finalReport:result`);
    expect(new Set(visits)).toEqual(new Set(lanes));
    expect(searchCalls).toBe(1);
    expect(accounting.length).toBeGreaterThan(0);
    expect(prompts.some(value => value.includes(`${canary}:search-result`))).toBe(true);
    expect(JSON.stringify([logs, health, accounting, result.progress])).not.toContain(canary);
    expect(result.progress.length).toBeGreaterThan(0);
    expect(result.progress.every(value => JSON.stringify(value) === '{"phase":"deep_research_running"}')).toBe(true);
    if (version === 2) expect(new Set(opened)).toEqual(new Set(Object.values(models)));
  });
  for (const lane of lanes) {
    test(`real v${version} ${lane} failure keeps provider canaries out of logs, health and progress`, async () => {
      failLane = lane;
      const result = await run(version, true);
      expect(visits).toContain(lane);
      expect(JSON.stringify([logs, health, accounting, result.progress])).not.toContain(canary);
      if (result.error) {
        expect(result.error).toBeInstanceOf(Error);
        expect((result.error as Error).message).toBe("deep_research_failed");
        expect((result.error as Error).cause).toBeUndefined();
      }

    });
  }
  test(`ordinary v${version} retains existing brief and provider-error diagnostics`, async () => {
    failLane = "supervisor";
    const result = await run(version, false);
    expect(visits).toContain("supervisor");
    expect(result.error).toBeInstanceOf(Error);
    expect(JSON.stringify(logs)).toContain(`${canary}:brief`);
    expect(JSON.stringify(logs)).toContain(`${canary}:supervisor:provider-error`);

  });
}

for (const confidential of [false, true]) {
  test(`real v2 model-health sink ${confidential ? "redacts" : "preserves"} the failed provider detail`, async () => {
    failLane = "finalReport";
    failureStatus = 500;
    const result = await run(2, confidential);
    expect(visits).toContain("finalReport");
    expect(result.error).toBeInstanceOf(Error);
    expect(health.length).toBeGreaterThan(0);
    if (confidential) {
      expect(JSON.stringify([logs, health, accounting, result.progress])).not.toContain(canary);
      expect((result.error as Error).message).toBe("deep_research_failed");
    } else expect(JSON.stringify(health)).toContain(`${canary}:finalReport:provider-error`);
  });
}
