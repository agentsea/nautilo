import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import type { CapabilityFundingSession, PersonalCapabilityRole } from "@nautilo/agent";
import type { TaskCreateInput } from "@nautilo/runtime";

const HUMAN = "11111111-1111-4111-8111-111111111111";
const AGENT = "22222222-2222-4222-8222-222222222222";
const ROOM = "33333333-3333-4333-8333-333333333333";
const CHAT_MODEL = "openrouter:moonshotai/kimi-k3";
const SERVER_BINDING = { kind: "server" as const, providerRoute: "openrouter" };
const PERSONAL_BINDING = {
  kind: "personal" as const,
  providerRoute: "openrouter",
  credentialId: "44444444-4444-4444-8444-444444444444",
  credentialRevision: 2,
};

let allowPersonalProviderKeys = false;
let capabilities = ["use_server_provider_credentials"];
let producedFunding: "server" | "personal" | "mixed" = "server";
let rejectPersonalRevalidation = false;
const laneModels: Record<PersonalCapabilityRole, string> = {
  webSearchSynthesis: "openrouter:web-search",
  deepResearchSupervisor: "openrouter:supervisor",
  deepResearchResearcher: "openrouter:researcher",
  deepResearchSummarization: "openrouter:summarizer",
  deepResearchCompression: "openrouter:compressor",
  deepResearchFinalReport: "openrouter:reporter",
  decision: "openrouter:decision",
};

const fundingSession: CapabilityFundingSession = {
  humanUserId: HUMAN,
  resolveModel: async (role) => ({ modelId: laneModels[role], preferenceRevision: 3 }),
  openModel: async (modelId, _workload, prior) => {
    if (prior?.kind === "personal" && rejectPersonalRevalidation) {
      throw new TestModelFundingError("personal_credentials_forbidden");
    }
    const freshBinding = producedFunding === "personal"
      || (producedFunding === "mixed" && modelId === laneModels.deepResearchSupervisor)
      ? PERSONAL_BINDING
      : SERVER_BINDING;
    return {
      binding: prior ?? freshBinding,
      fundingSession: {
        kind: (prior ?? freshBinding).kind,
        recheckAttempt: async () => {},
        runAttempt: async (_candidate, run) => run({
          usageFunding: { kind: "server", providerRoute: "openrouter" },
        }),
      },
    };
  },
  openService: async (provider, prior) => ({
    binding: prior ?? { kind: "server", providerRoute: provider },
    runAttempt: async (run) => run({
      apiKey: "request-local-server-key",
      usageFunding: { kind: "server", providerRoute: provider },
    }),
  }),
};

const actualAgent = await import("@nautilo/agent");
const actualDb = await import("@nautilo/db");
const actualTrust = await import("@nautilo/trust");

mock.module("@nautilo/agent", () => ({
  ...actualAgent,
  resolveRetainedModels: (ids: string[]) => ids.map((id) => ({
    id,
    availability: "selectable" as const,
  })),
  resolveCatalogModel: () => ({ workload: "chat", output: ["text"] }),
  validateExactTaskModelSelection: () => null,
}));
mock.module("@nautilo/db", () => ({
  ...actualDb,
  getServerProviderPolicy: async () => ({
    allowPersonalProviderKeys,
    fundingPreference: "server_first" as const,
  }),
}));
mock.module("@nautilo/trust", () => ({
  ...actualTrust,
  getUserCapabilities: async () => capabilities,
  assertCanInvokeAgent: async () => undefined,
}));

const directDb = {
  select: () => {
    const query = {
      from: () => query,
      innerJoin: () => query,
      where: () => query,
      limit: async () => [{ id: ROOM }],
    };
    return query;
  },
};
mock.module("../../src/lib/server-direct-db", () => ({
  getServerDirectDb: () => directDb,
}));
mock.module("../../src/lib/foreground-chat-funding", () => ({
  isOwnPrivateGenieRoom: async () => true,
  usageFundingFor: () => ({ kind: "server", providerRoute: "openrouter" }),
}));
mock.module("../../src/lib/capability-funding", () => ({
  createCapabilityFundingSession: () => fundingSession,
  prepareCapabilityFundingSession: async () => fundingSession,
}));

class TestModelFundingError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}
mock.module("../../src/lib/model-funding", () => ({
  ModelFundingError: TestModelFundingError,
  resolveModelFunding: async (input: { humanUserId: string; modelId: string }) => ({
    kind: "server" as const,
    humanUserId: input.humanUserId,
    modelId: input.modelId,
    workload: "native_text_task" as const,
    providerRoute: "openrouter",
  }),
  withAdmittedPersonalProviderKey: async () => {
    throw new Error("personal funding must not be used");
  },
}));
mock.module("../../src/lib/caller-task-model-context", () => ({
  callerTaskModelEnvironment: async () => ({}),
  callerTaskModelIds: async () => [CHAT_MODEL],
  personalOnlyTaskModelIds: async () => [],
}));

const { nativeTaskFundingPort } = await import("../../src/lib/native-task-funding");
const { createAgentTurnTaskCreationProvenance } = await import("@nautilo/runtime");
const { createRunDeepResearchTool } = await import(
  "../../../agent/src/tools/research/run-deep-research"
);
const { deepResearchReturnContextForState, runWithDeepResearchReturnContext } = await import(
  "../../../agent/src/runtime/deep-research-return-context"
);
const { resolveDeepResearchExecutorConfiguration } = await import(
  "../../../runtime/src/executors/deep-research-executor"
);

async function produceResearchTask(): Promise<TaskCreateInput> {
  let created: TaskCreateInput | undefined;
  const tool = createRunDeepResearchTool({
    getCapabilityFundingSession: () => fundingSession,
    createTask: async (input) => {
      created = input as TaskCreateInput;
      return { taskId: "task-research", status: "pending" };
    },
  });
  const context = deepResearchReturnContextForState({
    trustedExecutionEntrypoint: "foreground.main",
    userId: HUMAN,
    causalHumanUserId: HUMAN,
    roomId: ROOM,
    agentId: AGENT,
    approvalLaneKey: `room:${ROOM}`,
    langgraphThreadId: "thread-research",
    currentThreadId: "thread-research",
    model: CHAT_MODEL,
  } as never);
  await runWithDeepResearchReturnContext(
    context,
    () => tool.invoke({ research_brief: "Research server-funded behavior" }),
  );
  if (!created) throw new Error("Deep Research producer did not create a Task");
  return created;
}

beforeEach(() => {
  allowPersonalProviderKeys = false;
  capabilities = ["use_server_provider_credentials"];
  producedFunding = "server";
  rejectPersonalRevalidation = false;
});

afterAll(() => {
  mock.restore();
});

describe("v2 Deep Research task funding", () => {
  test.each([
    ["personal keys disabled", false, ["use_personal_provider_credentials", "use_server_provider_credentials"]],
    ["server-only authority", true, ["use_server_provider_credentials"]],
  ] as const)("keeps producer metadata live through admission and worker setup with %s", async (
    _label,
    personalKeysEnabled,
    userCapabilities,
  ) => {
    allowPersonalProviderKeys = personalKeysEnabled;
    capabilities = [...userCapabilities];
    const task = await produceResearchTask();
    const provenance = createAgentTurnTaskCreationProvenance({
      ownerId: HUMAN,
      invocation: {
        ownerId: HUMAN,
        roomId: ROOM,
        entrypoint: "foreground.main",
      },
    });

    expect(await nativeTaskFundingPort.prepareCreation(task, provenance)).toBeTrue();
    const research = actualAgent.readDeepResearchTaskMetadata(task.metadata);
    expect(research?.version).toBe(2);
    if (!research || research.version !== 2) throw new Error("expected admitted v2 metadata");
    const configuration = actualAgent.runWithCapabilityFundingSession(
      fundingSession,
      () => resolveDeepResearchExecutorConfiguration({
        deep_research_model_plan: research.modelPlan,
        deep_research_funding: research,
      }, {}),
    );
    expect(configuration.supervisor_model).toBe(research.modelPlan.supervisorModel);
    expect(configuration.openrouter_api_key).toBeNull();
  });

  test.each(["personal", "mixed"] as const)(
    "rejects a %s v2 binding revoked between producer admission and Task creation",
    async (fundingKind) => {
      producedFunding = fundingKind;
      rejectPersonalRevalidation = true;
      const task = await produceResearchTask();
      const provenance = createAgentTurnTaskCreationProvenance({
        ownerId: HUMAN,
        invocation: {
          ownerId: HUMAN,
          roomId: ROOM,
          entrypoint: "foreground.main",
        },
      });

      expect(await nativeTaskFundingPort.prepareCreation(task, provenance).then(
        () => null,
        (error: unknown) => (error as { code?: unknown }).code,
      )).toBe("personal_credentials_forbidden");
    },
  );

  test("rejects an admitted v2 task outside the caller-funded shape instead of downgrading it", async () => {
    const task = await produceResearchTask();
    const provenance = createAgentTurnTaskCreationProvenance({
      ownerId: HUMAN,
      invocation: {
        ownerId: HUMAN,
        roomId: ROOM,
        entrypoint: "foreground.main",
      },
    });

    expect(await nativeTaskFundingPort.prepareCreation({
      ...task,
      targetUserIds: [HUMAN, "another-human"],
    }, provenance).then(
      () => null,
      (error: unknown) => (error as { code?: unknown }).code,
    )).toBe("unsupported_workload");
  });

  test("rejects malformed Deep Research metadata instead of persisting a legacy task", async () => {
    const task = await produceResearchTask();
    const provenance = createAgentTurnTaskCreationProvenance({
      ownerId: HUMAN,
      invocation: {
        ownerId: HUMAN,
        roomId: ROOM,
        entrypoint: "foreground.main",
      },
    });

    expect(await nativeTaskFundingPort.prepareCreation({
      ...task,
      metadata: { deepResearch: { version: 2 } },
    }, provenance).then(
      () => null,
      (error: unknown) => (error as { code?: unknown }).code,
    )).toBe("unsupported_workload");
  });
});
