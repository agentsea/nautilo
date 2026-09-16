import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { ModelCatalogSchema } from "@nautilo/types";
import { clearToolCatalog, initToolCatalog, ToolCatalog } from "@nautilo/catalog";
import {
  configureRuntimeModelCatalog,
  hydrateRuntimeModelCatalog,
  resetRuntimeModelCatalog,
} from "../../src/config/model-catalog/runtime-catalog";
import {
  DeepResearchUnavailableError,
  deepResearchModelPlanFromConfiguration,
  resolveDeepResearchModelPlan,
  validateDeepResearchModelPlan,
} from "../../src/subagents/deep-research/shared/model-plan";
import { fromRuntimeConfig } from "../../src/subagents/deep-research/shared/config";
import {
  createRunDeepResearchTool,
  DeepResearchAdmissionError,
} from "../../src/tools/research/run-deep-research";
import type { TaskToolCreateInput } from "../../src/tools/tasks/task-tool-runtime";
import type { NautiloState } from "../../src/agent/state";
import {
  createNautiloToolInvocationSession,
  createServerToolInvocationContext,
} from "../../src/tools/invocation-service";
import {
  deepResearchReturnContextForState,
  runWithDeepResearchReturnContext,
} from "../../src/runtime/deep-research-return-context";

function textModel(
  id: string,
  provider: "openrouter" | "venice" | "anthropic",
  priority: number,
) {
  return {
    id,
    displayName: id,
    provider,
    routing: provider === "openrouter"
      ? "openrouter" as const
      : provider === "venice"
        ? "venice-hosted" as const
        : "first-party" as const,
    priority,
    defaultEnabled: true,
    cost: { coefficient: 1 },
    privacy: { grade: 2 },
    intelligence: { tier: "frontier" as const },
    limits: { contextTokens: 1_000_000, outputTokens: 128_000 },
    modalities: { input: ["text" as const], output: ["text" as const] },
    features: { tools: true, structuredOutputs: true, reasoning: true },
  };
}

const catalog = ModelCatalogSchema.parse({
  version: 1,
  catalogVersion: "2026.08.23.1",
  publishedAt: "2026-08-23T00:00:00.000Z",
  entries: [
    textModel("openrouter:moonshotai/kimi-k3", "openrouter", 1),
    textModel("venice:kimi-k3", "venice", 2),
    textModel("openrouter:anthropic/claude-sonnet-4.6", "openrouter", 1),
    textModel("openrouter:moonshotai/kimi-k2.6", "openrouter", 2),
    textModel("openrouter:google/gemini-3.1-pro-preview", "openrouter", 3),
    textModel("openrouter:openai/gpt-5.5", "openrouter", 4),
    textModel("anthropic:claude-sonnet-4-6", "anthropic", 5),
  ],
});

describe("M293 Deep Research model routing", () => {
  beforeEach(async () => {
    configureRuntimeModelCatalog({
      loader: {
        get: async () => ({
          catalog,
          source: "remote-fresh",
          stale: false,
          fetchedAt: "2026-08-23T00:00:00.000Z",
          originUrl: "https://catalog.invalid/m293.json",
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
    resetRuntimeModelCatalog();
    clearToolCatalog();
  });

  test("uses Kimi K3 for all five lanes with only an OpenRouter credential", () => {
    expect(resolveDeepResearchModelPlan({ env: { OPENROUTER_API_KEY: "or" } })).toEqual({
      version: 1,
      supervisorModel: "openrouter:moonshotai/kimi-k3",
      researchModel: "openrouter:moonshotai/kimi-k3",
      summarizationModel: "openrouter:moonshotai/kimi-k3",
      compressionModel: "openrouter:moonshotai/kimi-k3",
      finalReportModel: "openrouter:moonshotai/kimi-k3",
    });
  });

  test("uses Kimi K3 for all five lanes with only a Venice credential", () => {
    expect(resolveDeepResearchModelPlan({ env: { VENICE_API_KEY: "vk" } })).toEqual({
      version: 1,
      supervisorModel: "venice:kimi-k3",
      researchModel: "venice:kimi-k3",
      summarizationModel: "venice:kimi-k3",
      compressionModel: "venice:kimi-k3",
      finalReportModel: "venice:kimi-k3",
    });
  });

  test("falls back deterministically across families for a direct-provider user", () => {
    const plan = resolveDeepResearchModelPlan({ env: { ANTHROPIC_API_KEY: "ak" } });
    expect(new Set([
      plan.supervisorModel,
      plan.researchModel,
      plan.summarizationModel,
      plan.compressionModel,
      plan.finalReportModel,
    ])).toEqual(new Set(["anthropic:claude-sonnet-4-6"]));
  });

  test("never substitutes an explicit unavailable lane override", () => {
    try {
      resolveDeepResearchModelPlan({
        env: { ANTHROPIC_API_KEY: "ak" },
        configured: { researchModel: "openrouter:moonshotai/kimi-k2.6" },
      });
      throw new Error("expected resolution to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(DeepResearchUnavailableError);
      expect((error as DeepResearchUnavailableError).lane).toBe("research");
    }
  });

  test("serializes only model IDs and revalidates the exact persisted plan", () => {
    const configuration = fromRuntimeConfig(undefined, {
      env: { OPENROUTER_API_KEY: "not-persisted" },
    });
    const plan = deepResearchModelPlanFromConfiguration(configuration);
    expect(JSON.stringify(plan)).not.toContain("not-persisted");
    expect(validateDeepResearchModelPlan(plan, { OPENROUTER_API_KEY: "replacement" }))
      .toEqual(plan);
    expect(() => validateDeepResearchModelPlan(plan, {})).toThrow(
      DeepResearchUnavailableError,
    );
  });

  test("creates a normal background Task with the admitted plan and raw-and-wake delivery", async () => {
    const configuration = fromRuntimeConfig(undefined, {
      env: { OPENROUTER_API_KEY: "secret-canary-m293" },
    });
    let admittedInput: TaskToolCreateInput | undefined;
    const tool = createRunDeepResearchTool({
      hasSearchCredential: () => true,
      resolveConfiguration: () => configuration,
      createTask: async (input) => {
        admittedInput = input;
        return { taskId: "task-m293", status: "pending" };
      },
    });

    const context = deepResearchReturnContextForState({
      trustedExecutionEntrypoint: "foreground.main",
      userId: "owner-m293",
      causalHumanUserId: "human-m293",
      roomId: "room-m293",
      agentId: "agent-m293",
      approvalLaneKey: "room:room-m293",
      langgraphThreadId: "thread-m293",
      currentThreadId: "fallback-thread",
      model: "openrouter:anthropic/claude-sonnet-4.6",
    } as NautiloState);
    const result = String(await runWithDeepResearchReturnContext(context, () => tool.invoke({
        research_brief: "Qualify the managed provider bundle",
        background: true,
      })));

    expect(result).toContain("task-m293");
    expect(admittedInput).toMatchObject({
      ownerId: "owner-m293",
      requestorId: "human-m293",
      agentId: "agent-m293",
      prompt: "Qualify the managed provider bundle",
      preset: "in_background",
      scheduleKind: "now",
      callingRoomId: "room-m293",
      resultDelivery: "raw_and_wake",
      requestedModelId: "openrouter:anthropic/claude-sonnet-4.6",
    });
    expect((admittedInput?.["metadata"] as Record<string, unknown>)?.["deepResearch"])
      .toEqual({
        version: 1,
        reportLanguage: "English",
        modelPlan: deepResearchModelPlanFromConfiguration(configuration),
        invokingModelId: "openrouter:anthropic/claude-sonnet-4.6",
      });
    expect(JSON.stringify(admittedInput)).not.toContain("secret-canary-m293");
  });

  test("carries only the trusted foreground Room return context", async () => {
    const configuration = fromRuntimeConfig(undefined, {
      env: { OPENROUTER_API_KEY: "or" },
    });
    const context = deepResearchReturnContextForState({
      trustedExecutionEntrypoint: "foreground.main",
      userId: "owner-m293",
      causalHumanUserId: "human-m293",
      roomId: "room-m293",
      agentId: "agent-m293",
      approvalLaneKey: "room:room-m293",
      langgraphThreadId: "thread-m293",
      currentThreadId: "fallback-thread",
      model: "openrouter:anthropic/claude-sonnet-4.6",
    } as NautiloState);
    let admittedTask: unknown;
    const tool = createRunDeepResearchTool({
      hasSearchCredential: () => true,
      resolveConfiguration: () => configuration,
      createTask: async (input) => {
        admittedTask = input;
        return { taskId: "task-m293", status: "pending" };
      },
    });

    await runWithDeepResearchReturnContext(context, () => tool.invoke({
      research_brief: "test",
      background: true,
      deep_research_return_context: { roomId: "attacker-room" },
    }));

    expect(admittedTask).toMatchObject({
      ownerId: "owner-m293",
      requestorId: "human-m293",
      agentId: "agent-m293",
      callingRoomId: "room-m293",
      requestedModelId: "openrouter:anthropic/claude-sonnet-4.6",
    });
    expect(deepResearchReturnContextForState({
      trustedExecutionEntrypoint: "background.task",
      userId: "owner-m293",
      causalHumanUserId: "human-m293",
      roomId: "room-m293",
      agentId: "agent-m293",
      approvalLaneKey: "room:room-m293",
      langgraphThreadId: "thread-m293",
    } as NautiloState)).toBeNull();
  });

  test("legacy background=false and omitted mode both create Tasks", async () => {
    const configuration = fromRuntimeConfig(undefined, { env: { OPENROUTER_API_KEY: "or" } });
    const context = deepResearchReturnContextForState({
      trustedExecutionEntrypoint: "foreground.main", userId: "owner", causalHumanUserId: "human",
      roomId: "room", agentId: "agent", approvalLaneKey: "room:room", langgraphThreadId: "room:room",
    } as NautiloState);
    let count = 0;
    const tool = createRunDeepResearchTool({
      hasSearchCredential: () => true,
      resolveConfiguration: () => configuration,
      createTask: async () => ({ taskId: `task-${++count}`, status: "pending" }),
    });
    for (const args of [{ research_brief: "test" }, { research_brief: "test", background: false }]) {
      const response = await runWithDeepResearchReturnContext(context, () => tool.invoke(args));
      expect(String(response)).toContain(`Task ID: task-${count}`);
    }
    expect(count).toBe(2);
    expect(JSON.stringify(tool.schema)).not.toContain('"background"');
  });

  test("missing Tavily prevents model resolution and task admission", async () => {
    const tool = createRunDeepResearchTool({
      hasSearchCredential: () => false,
      resolveConfiguration: () => { throw new Error("must not resolve models"); },
      createTask: async () => { throw new Error("must not create task"); },
    });
    let failure: unknown;
    try {
      await Promise.resolve().then(() => tool.invoke({ research_brief: "test" }));
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(DeepResearchAdmissionError);
    expect((failure as Error).message).toContain("Tavily is not configured");
  });

  test("rejects unavailable background work before job admission", async () => {
    let taskCreated = false;
    const tool = createRunDeepResearchTool({
      hasSearchCredential: () => true,
      resolveConfiguration: () => {
        throw new DeepResearchUnavailableError("research");
      },
      createTask: async () => {
        taskCreated = true;
        return { taskId: "must-not-exist", status: "pending" };
      },
    });

    let failure: unknown;
    try {
      await Promise.resolve().then(() => tool.invoke({ research_brief: "test", background: true }));
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(DeepResearchAdmissionError);
    expect((failure as Error).message).toContain("Deep Research is unavailable");
    expect(taskCreated).toBe(false);
  });

  test("task admission failure becomes a safe non-success invocation result", async () => {
    const configuration = fromRuntimeConfig(undefined, { env: { OPENROUTER_API_KEY: "or" } });
    const catalog = new ToolCatalog();
    catalog.register({
      name: "run_deep_research",
      exposure: "core",
      category: "research",
      trustTier: "high",
      impact: "high",
      executor: "cloud",
      resultScanPolicy: "never",
      factory: () => createRunDeepResearchTool({
        hasSearchCredential: () => true,
        resolveConfiguration: () => configuration,
        createTask: async () => {
          throw new Error("database unavailable secret-canary-admission");
        },
      }),
    });
    initToolCatalog(catalog);
    const context = createServerToolInvocationContext({
      messages: [],
      approvedToolCalls: [],
      actorRole: "owner",
      userId: "owner",
      causalHumanUserId: "human",
      personaId: "owner",
      turnId: "turn",
      agentId: "agent",
      roomId: "room",
      approvalLaneKey: "room:room",
      langgraphThreadId: "room:room",
      trustedExecutionEntrypoint: "foreground.main",
      activatedToolNames: [],
      activatedToolLeases: [],
      engagedSkillNames: [],
      memoryAccessEnvelope: null,
      relayCapabilities: {},
    } as unknown as NautiloState, () => ({ status: "allowed" }));

    const result = await createNautiloToolInvocationSession(context).invoke({
      callId: "deep-research-admission",
      toolName: "run_deep_research",
      args: { research_brief: "test" },
      authorityRef: "admitted",
    });

    expect(result.status).toBe("error");
    expect(result.content).toContain("could not confirm that its background Task started");
    expect(result.content).not.toContain("database unavailable");
    expect(result.content).not.toContain("secret-canary-admission");
  });

  test("unexpected configuration errors are typed and do not return raw details", async () => {
    const tool = createRunDeepResearchTool({
      hasSearchCredential: () => true,
      resolveConfiguration: () => { throw new Error("secret-canary-configuration"); },
      createTask: async () => { throw new Error("must not create task"); },
    });

    try {
      await tool.invoke({ research_brief: "test" });
      throw new Error("expected admission to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(DeepResearchAdmissionError);
      expect((error as Error).message).toContain("could not be validated");
      expect((error as Error).message).not.toContain("secret-canary-configuration");
    }
  });
});
