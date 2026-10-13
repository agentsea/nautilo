import { afterEach, describe, expect, spyOn, test } from "bun:test";
import type { NautiloState } from "../../src/agent/state";
import type { CapabilityFundingSession, PersonalCapabilityRole } from "../../src/runtime/capability-funding";
import {
  deepResearchReturnContextForState,
  runWithDeepResearchReturnContext,
} from "../../src/runtime/deep-research-return-context";
import {
  parseDeepResearchTaskMetadataValue,
  readDeepResearchTaskMetadata,
} from "../../src/subagents/deep-research/shared/task-metadata";
import { createRunDeepResearchTool } from "../../src/tools/research/run-deep-research";
import { setTaskToolRuntime, type TaskToolCreateInput, type TaskToolRuntime } from "../../src/tools/tasks/task-tool-runtime";
import { classifyProtectedTaskMetadataV1 } from "@nautilo/types";

const laneModels: Partial<Record<PersonalCapabilityRole, string>> = {
  webSearchSynthesis: "openrouter:web-search",
  deepResearchSupervisor: "openrouter:supervisor",
  deepResearchResearcher: "openrouter:researcher",
  deepResearchSummarization: "openrouter:summarizer",
  deepResearchCompression: "openrouter:compressor",
  deepResearchFinalReport: "openrouter:reporter",
  decision: "openrouter:decision",
};

function capabilitySession(observed: string[]): CapabilityFundingSession {
  return {
    humanUserId: "human-research",
    resolveModel: async (role) => {
      observed.push(`resolve:${role}`);
      return { modelId: laneModels[role] ?? (() => { throw new Error("Unexpected research role"); })(), preferenceRevision: 7 };
    },
    openModel: async (modelId, workload, prior) => {
      observed.push(`model:${workload}:${modelId}:${prior ? "prior" : "fresh"}`);
      return {
        binding: { kind: "server", providerRoute: "openrouter" },
        fundingSession: { kind: "server", runAttempt: async (_id, callback) => callback({
          usageFunding: { kind: "server", providerRoute: "openrouter" },
        }), recheckAttempt: async () => {} },
      };
    },
    openService: async (provider, prior) => {
      observed.push(`service:${provider}:${prior ? "prior" : "fresh"}`);
      return { binding: { kind: "server", providerRoute: provider },
        runAttempt: async (callback) => callback({ apiKey: "request-local-canary",
          usageFunding: { kind: "server", providerRoute: provider } }) };
    },
  };
}

describe("personal Deep Research funding metadata", () => {
  test("admits all five model lanes and Tavily without serializing credentials", async () => {
    const observed: string[] = [];
    let created: TaskToolCreateInput | undefined;
    const tool = createRunDeepResearchTool({
      getCapabilityFundingSession: () => capabilitySession(observed),
      resolveConfiguration: () => { throw new Error("personal admission must not read server model config"); },
      hasSearchCredential: () => { throw new Error("personal admission must not read server Tavily config"); },
      createTask: async (input) => { created = input; return { taskId: "task-research", status: "pending" }; },
    });
    const context = deepResearchReturnContextForState({
      trustedExecutionEntrypoint: "foreground.main",
      userId: "owner-research",
      causalHumanUserId: "human-research",
      roomId: "room-research",
      agentId: "agent-research",
      approvalLaneKey: "room:room-research",
      langgraphThreadId: "thread-research",
      currentThreadId: "thread-research",
      model: "openrouter:chat",
    } as NautiloState);

    await runWithDeepResearchReturnContext(context, () => tool.invoke({ research_brief: "Research it" }));

    const parsed = readDeepResearchTaskMetadata(created?.metadata);
    expect(parsed?.version).toBe(2);
    if (!parsed || parsed.version !== 2) throw new Error("expected admitted metadata");
    expect(parsed.modelPlan).toEqual({
      version: 1,
      supervisorModel: "openrouter:supervisor",
      researchModel: "openrouter:researcher",
      summarizationModel: "openrouter:summarizer",
      compressionModel: "openrouter:compressor",
      finalReportModel: "openrouter:reporter",
    });
    expect(parsed.preferenceRevisions).toEqual({ supervisor: 7, research: 7,
      summarization: 7, compression: 7, finalReport: 7 });
    expect(parsed.tavilyFunding).toEqual({ kind: "server", providerRoute: "tavily" });
    expect(observed.filter((value) => value.startsWith("model:"))).toHaveLength(5);
    expect(JSON.stringify(created)).not.toContain("request-local-canary");
  });

  test("rejects widened or secret-bearing durable metadata", () => {
    const base = {
      version: 2,
      reportLanguage: "English",
      invokingModelId: null,
      modelPlan: { version: 1, supervisorModel: "a", researchModel: "b",
        summarizationModel: "c", compressionModel: "d", finalReportModel: "e" },
      preferenceRevisions: { supervisor: 1, research: 1, summarization: 1, compression: 1, finalReport: 1 },
      modelFunding: Object.fromEntries(["supervisor", "research", "summarization", "compression", "finalReport"]
        .map((lane) => [lane, { kind: "server", providerRoute: "openrouter" }])),
      tavilyFunding: { kind: "server", providerRoute: "tavily" },
    };
    expect(() => parseDeepResearchTaskMetadataValue({ ...base, apiKey: "must-not-persist" })).toThrow(TypeError);
    expect(() => parseDeepResearchTaskMetadataValue({ ...base,
      modelFunding: { ...base.modelFunding, research: { kind: "server", providerRoute: "openrouter", apiKey: "x" } } })).toThrow(TypeError);
  });
});


describe("Deep Research protected Task creation", () => {
  afterEach(() => setTaskToolRuntime(null));
  function returnContext() {
    return deepResearchReturnContextForState({ trustedExecutionEntrypoint: "foreground.main",
      userId: "owner-research", causalHumanUserId: "human-research", roomId: "room-research",
      agentId: "agent-research", approvalLaneKey: "room:room-research", langgraphThreadId: "thread-research",
      currentThreadId: "thread-research", model: "openrouter:chat" } as NautiloState);
  }
  function invoke(tool: ReturnType<typeof createRunDeepResearchTool>) {
    return runWithDeepResearchReturnContext(returnContext(), () => tool.invoke({
      research_brief: "PRIVATE RESEARCH BRIEF", report_language: "Portuguese",
    }));
  }

  test("reads policy at invocation and sends real admitted v2 metadata only to the selected creator", async () => {
    let ordinary = true;
    const calls: string[] = [];
    const fundingCalls: string[] = [];
    const inputs: TaskToolCreateInput[] = [];
    const create = (label: string) => async (input: TaskToolCreateInput) => {
      calls.push(label); inputs.push(input); return { taskId: label, status: "pending" };
    };
    const runtime: TaskToolRuntime = {
      db: new Proxy({} as TaskToolRuntime["db"], { get() { throw new Error("unexpected database"); } }),
      canUseLegacyTaskContent: async () => { calls.push("policy"); return ordinary; },
      createTask: create("ordinary"), createProtectedTask: create("protected"),
      computeNextFireAt: () => { throw new Error("unexpected scheduling"); },
      pauseTask: async () => { throw new Error("unexpected pause"); },
      unpauseTask: async () => { throw new Error("unexpected unpause"); },
      stopTask: async () => { throw new Error("unexpected stop"); },
    };
    setTaskToolRuntime(runtime);
    const tool = createRunDeepResearchTool({ getCapabilityFundingSession: () => capabilitySession(fundingCalls) });
    expect(calls).toEqual([]);
    expect(String(await invoke(tool))).toContain("Task ID: ordinary");
    ordinary = false;
    expect(String(await invoke(tool))).toContain("Task ID: protected");
    expect(calls).toEqual(["policy", "ordinary", "policy", "protected"]);
    expect(inputs[1]).toEqual(inputs[0]);
    expect(inputs[1]).toMatchObject({ prompt: "PRIVATE RESEARCH BRIEF", ownerId: "owner-research",
      requestorId: "human-research", agentId: "agent-research", resultDelivery: "raw_and_wake" });
    const parsed = readDeepResearchTaskMetadata(inputs[1]?.metadata);
    expect(parsed?.version).toBe(2);
    expect(parsed?.reportLanguage).toBe("Portuguese");
    expect(classifyProtectedTaskMetadataV1(inputs[1]?.metadata).status).toBe("supported");
    expect(JSON.stringify(inputs)).not.toContain("request-local-canary");
  });

  test("missing protected creator fails before funding or ordinary insertion", async () => {
    const calls: string[] = [];
    const tool = createRunDeepResearchTool({
      canUseLegacyTaskContent: async () => false,
      createTask: async () => { calls.push("ordinary"); return { taskId: "bad", status: "pending" }; },
      getCapabilityFundingSession: () => { calls.push("funding"); return capabilitySession([]); },
    });
    const failure = await invoke(tool).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toContain("Protected Deep Research Task creation is unavailable");
    expect(calls).toEqual([]);
  });

  test("protected creation failure never retries ordinary or exposes raw detail through logs or cause", async () => {
    const marker = "PRIVATE_CREATION_FAILURE";
    const logger = spyOn(console, "error").mockImplementation(() => {});
    const calls: string[] = [];
    try {
      const tool = createRunDeepResearchTool({ canUseLegacyTaskContent: async () => false,
        getCapabilityFundingSession: () => capabilitySession([]),
        createTask: async () => { calls.push("ordinary"); throw new Error("forbidden"); },
        createProtectedTask: async () => { calls.push("protected"); throw new Error(marker); },
      });
      const failure = await invoke(tool).catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(Error);
      expect((failure as Error).message).not.toContain(marker);
      expect((failure as Error).cause).toBeUndefined();
      expect(JSON.stringify(logger.mock.calls)).not.toContain(marker);
      expect(calls).toEqual(["protected"]);
    } finally { logger.mockRestore(); }
  });

  test("protected configuration failure has no raw diagnostic or cause", async () => {
    const marker = "PRIVATE_MODEL_CONFIGURATION";
    const logger = spyOn(console, "error").mockImplementation(() => {});
    try {
      const tool = createRunDeepResearchTool({ canUseLegacyTaskContent: async () => false,
        getCapabilityFundingSession: () => undefined, hasSearchCredential: () => true,
        resolveConfiguration: () => { throw new Error(marker); },
        createTask: async () => { throw new Error("ordinary forbidden"); },
        createProtectedTask: async () => { throw new Error("must not create"); },
      });
      const failure = await invoke(tool).catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(Error);
      expect((failure as Error).message).not.toContain(marker);
      expect((failure as Error).cause).toBeUndefined();
      expect(JSON.stringify(logger.mock.calls)).not.toContain(marker);
    } finally { logger.mockRestore(); }
  });
});
