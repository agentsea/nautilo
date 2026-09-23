import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  DeepResearchUnavailableError,
  configureRuntimeModelCatalog,
  getUsageContext,
  hydrateRuntimeModelCatalog,
  resetRuntimeModelCatalog,
} from "@nautilo/agent";
import { ModelCatalogSchema } from "@nautilo/types";
import type { ServerEvent } from "@nautilo/types";
import {
  deliverDeepResearchReport,
  DeepResearchSearchUnavailableError,
  _setDeepResearchReportStreamForTests,
  deepResearchExecutor,
  resolveDeepResearchExecutorConfiguration,
  streamDeepResearchReport,
} from "../../src/executors/deep-research-executor";

const modelIds = [
  "openrouter:anthropic/claude-sonnet-4.6",
  "openrouter:moonshotai/kimi-k2.6",
  "openrouter:google/gemini-3.1-pro-preview",
  "openrouter:openai/gpt-5.5",
] as const;

const modelLimits: Record<(typeof modelIds)[number], { contextTokens: number; outputTokens: number }> = {
  "openrouter:anthropic/claude-sonnet-4.6": { contextTokens: 1_000_000, outputTokens: 128_000 },
  "openrouter:moonshotai/kimi-k2.6": { contextTokens: 262_142, outputTokens: 262_142 },
  "openrouter:google/gemini-3.1-pro-preview": { contextTokens: 1_048_576, outputTokens: 65_536 },
  "openrouter:openai/gpt-5.5": { contextTokens: 1_050_000, outputTokens: 128_000 },
};

const catalog = ModelCatalogSchema.parse({
  version: 1,
  catalogVersion: "2026.08.23.2",
  publishedAt: "2026-08-23T00:00:00.000Z",
  entries: modelIds.map((id, index) => ({
    id,
    displayName: id,
    provider: "openrouter",
    routing: "openrouter",
    priority: index + 1,
    defaultEnabled: true,
    cost: { coefficient: 1 },
    privacy: { grade: 2 },
    intelligence: { tier: "frontier" },
    modalities: { input: ["text"], output: ["text"] },
    features: { tools: true, structuredOutputs: true, reasoning: true },
    limits: modelLimits[id],
  })),
});

const plan = {
  version: 1 as const,
  supervisorModel: modelIds[0],
  researchModel: modelIds[1],
  summarizationModel: modelIds[1],
  compressionModel: modelIds[1],
  finalReportModel: modelIds[3],
};

describe("M293 background Deep Research admission", () => {
  beforeEach(async () => {
    configureRuntimeModelCatalog({
      loader: {
        get: async () => ({
          catalog,
          source: "remote-fresh",
          stale: false,
          fetchedAt: "2026-08-23T00:00:00.000Z",
          originUrl: "https://catalog.invalid/m293-runtime.json",
          reason: "",
          catalogVersion: catalog.catalogVersion,
        }),
        refresh: async () => {},
        clearCache: () => {},
      },
    });
    await hydrateRuntimeModelCatalog();
  });

  afterEach(() => {
    _setDeepResearchReportStreamForTests(null);
    resetRuntimeModelCatalog();
  });

  test("runs every report stream step as the exact initiating Human", async () => {
    const observedUserIds: Array<string | null | undefined> = [];
    _setDeepResearchReportStreamForTests(async function* () {
      observedUserIds.push(getUsageContext()?.userId);
      yield { phase: "researching" };
      observedUserIds.push(getUsageContext()?.userId);
      return "report";
    });

    const stream = streamDeepResearchReport(
      {},
      "job-deep-research",
      new AbortController().signal,
      "human-deep-research",
    );
    expect(await stream.next()).toEqual({ done: false, value: { phase: "researching" } });
    expect(await stream.next()).toEqual({ done: true, value: "report" });

    expect(observedUserIds).toEqual(["human-deep-research", "human-deep-research"]);
  });

  test("rehydrates and revalidates the exact admitted OpenRouter plan", () => {
    const configuration = resolveDeepResearchExecutorConfiguration(
      { deep_research_model_plan: plan },
      { OPENROUTER_API_KEY: "runtime-key", TAVILY_API_KEY: "runtime-search-key" },
    );
    expect({
      supervisorModel: configuration.supervisor_model,
      researchModel: configuration.research_model,
      summarizationModel: configuration.summarization_model,
      compressionModel: configuration.compression_model,
      finalReportModel: configuration.final_report_model,
    }).toEqual({
      supervisorModel: plan.supervisorModel,
      researchModel: plan.researchModel,
      summarizationModel: plan.summarizationModel,
      compressionModel: plan.compressionModel,
      finalReportModel: plan.finalReportModel,
    });
  });

  test("fails closed when the admitted plan is no longer credentialed", () => {
    expect(() => resolveDeepResearchExecutorConfiguration(
      { deep_research_model_plan: plan },
      {},
    )).toThrow(DeepResearchUnavailableError);
  });

  test("fails before graph execution when Tavily was removed after admission", async () => {
    expect(() => resolveDeepResearchExecutorConfiguration(
      { deep_research_model_plan: plan },
      { OPENROUTER_API_KEY: "runtime-key" },
    )).toThrow(DeepResearchSearchUnavailableError);

    const previousOpenRouterKey = process.env["OPENROUTER_API_KEY"];
    const previousTavilyKey = process.env["TAVILY_API_KEY"];
    process.env["OPENROUTER_API_KEY"] = "runtime-key";
    delete process.env["TAVILY_API_KEY"];
    const events: ServerEvent[] = [];
    let failure: unknown;
    try {
      for await (const event of deepResearchExecutor(
        { research_brief: "test", deep_research_model_plan: plan },
        "job-m293-search-removed",
        "room:room-m293",
        new AbortController().signal,
      )) {
        events.push(event);
      }
    } catch (error) {
      failure = error;
    } finally {
      if (previousOpenRouterKey === undefined) delete process.env["OPENROUTER_API_KEY"];
      else process.env["OPENROUTER_API_KEY"] = previousOpenRouterKey;
      if (previousTavilyKey === undefined) delete process.env["TAVILY_API_KEY"];
      else process.env["TAVILY_API_KEY"] = previousTavilyKey;
    }

    expect(failure).toBeInstanceOf(DeepResearchSearchUnavailableError);
    expect(events).toEqual([{
      type: "job.progress",
      kind: "deep-research",
      jobId: "job-m293-search-removed",
      phase: "Unavailable",
      detail: "Deep Research is unavailable because Tavily is not configured. Ask a server operator to configure Tavily, then try again.",
      laneKey: "room:room-m293",
    }]);
  });

  test("fails a malformed persisted plan before graph execution on its room lane", async () => {
    const events: ServerEvent[] = [];
    let failure: unknown;
    try {
      for await (const event of deepResearchExecutor(
        {
          research_brief: "test",
          deep_research_model_plan: { version: 1, supervisorModel: "bad" },
        },
        "job-m293",
        "room:room-m293",
        new AbortController().signal,
      )) {
        events.push(event);
      }
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(DeepResearchUnavailableError);
    expect(events).toEqual([
      {
        type: "job.progress",
        kind: "deep-research",
        jobId: "job-m293",
        phase: "Unavailable",
        detail: "Deep Research is unavailable because the supervisor model lane has no signed, credentialed model.",
        laneKey: "room:room-m293",
      },
    ]);
  });

  test("delivers one durable room message across executor retries", async () => {
    const messages: Array<{ id: string | undefined; content: unknown }> = [];
    const emitted: unknown[] = [];
    const append = (async (
      _threadId: unknown,
      _ownerId: unknown,
      _actorType: unknown,
      inputMessages: Array<{ id?: string; content?: unknown }>,
    ) => {
      const message = inputMessages[0];
      if (messages.some((item) => item.id === message?.id)) {
        return { insertedRows: [] };
      }
      messages.push({ id: message?.id, content: message?.content });
      return { insertedRows: [{ id: "transcript-row-m293" }] };
    }) as never;
    const route = {
      ownerId: "owner-m293",
      requestorId: "human-m293",
      roomId: "room-m293",
      laneKey: "room:room-m293",
      agentId: "agent-m293",
      graphThreadId: "thread-m293",
    };

    expect(await deliverDeepResearchReport(
      "job-m293",
      "qualified report",
      route,
      { append, emit: (event) => emitted.push(event) },
    )).toBe(true);
    expect(await deliverDeepResearchReport(
      "job-m293",
      "qualified report",
      route,
      { append, emit: (event) => emitted.push(event) },
    )).toBe(false);

    expect(messages).toEqual([{
      id: "deep-research-result:job-m293",
      content: "qualified report",
    }]);
    expect(emitted).toEqual([{
      type: "message.new",
      laneKey: "room:room-m293",
      messageId: "transcript-row-m293",
      role: "ai",
      content: "qualified report",
      authorAgentId: "agent-m293",
    }]);
  });
});
