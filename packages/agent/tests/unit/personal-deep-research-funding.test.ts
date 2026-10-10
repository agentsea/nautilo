import { describe, expect, test } from "bun:test";
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
import type { TaskToolCreateInput } from "../../src/tools/tasks/task-tool-runtime";

const laneModels: Record<PersonalCapabilityRole, string> = {
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
      return { modelId: laneModels[role], preferenceRevision: 7 };
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
