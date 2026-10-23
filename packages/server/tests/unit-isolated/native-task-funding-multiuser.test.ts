import { afterAll, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { rejects } from "node:assert/strict";
import { AIMessage, HumanMessage } from "@langchain/core/messages";
import { ToolCatalog, clearToolCatalog, initToolCatalog } from "@nautilo/catalog";
import type { Task, TaskRun } from "@nautilo/db";

const HUMAN_A = "11111111-1111-4111-8111-111111111111";
const HUMAN_B = "22222222-2222-4222-8222-222222222222";
const GENIE_OWNER = "33333333-3333-4333-8333-333333333333";
const AGENT = "44444444-4444-4444-8444-444444444444";
const CHILD_GENIE_OWNER = "99999999-9999-4999-8999-999999999999";
const CHILD_AGENT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const GROUP_ROOM = "55555555-5555-4555-8555-555555555555";
const ORPHAN_ROOM = "55555555-5555-4555-8555-555555555556";
const PARENT_ID = "66666666-6666-4666-8666-666666666666";
const PARENT_RUN_ID = "77777777-7777-4777-8777-777777777777";
const SERVER_MODEL = "openrouter:server-model";
const PERSONAL_MODEL = "openrouter:personal-model";
const DIRECT_AGENT_MODEL = "openrouter:openai/gpt-5.6-sol";
const PERSONAL_BINDING = {
  kind: "personal" as const,
  providerRoute: "openrouter",
  credentialId: "88888888-8888-4888-8888-888888888888",
  credentialRevision: 7,
};

const actualAgent = await import("@nautilo/agent");
const actualDb = await import("@nautilo/db");
const actualTrust = await import("@nautilo/trust");
const actualSurplusRoute = await import("../../../agent/src/providers/surplus-route");
const actualChatInvocation = await import("../../../agent/src/utils/chat-model-invocation");

let invocationAllowed = true;
let sourceRoomLive = true;
let fundingPreference: "personal_first" | "server_first" = "personal_first";
const invocationInputs: Array<{ roomId?: string }> = [];
const fundingInputs: Array<{ humanUserId: string; modelId: string; prior: unknown }> = [];
const taskRows = new Map<string, Task>();
const runRows = new Map<string, TaskRun>();

mock.module("@nautilo/agent", () => ({
  ...actualAgent,
  resolveRetainedModels: (ids: string[]) => ids.map((id) => ({ id, availability: "selectable" as const })),
  resolveCatalogModel: () => ({ workload: "chat", output: ["text"] }),
  validateExactTaskModelSelection: () => null,
}));
mock.module("@nautilo/db", () => ({
  ...actualDb,
  getServerProviderPolicy: async () => ({ allowPersonalProviderKeys: true, fundingPreference }),
  getTaskById: async (_db: unknown, id: string) => taskRows.get(id),
  getTaskRunForTask: async (_db: unknown, taskId: string, runId: string) => {
    const run = runRows.get(runId);
    return run?.taskId === taskId ? run : undefined;
  },
}));
mock.module("@nautilo/trust", () => ({
  ...actualTrust,
  getUserCapabilities: async () => ["invoke_agents", "invoke_other_agents", "use_personal_provider_credentials"],
  findActorByOwnerId: async (humanUserId: string) => ({ id: `actor:${humanUserId}` }),
  getRoomDetailForMember: async (roomId: string, actorId: string) => roomId === GROUP_ROOM && actorId.startsWith("actor:")
    ? { id: GROUP_ROOM, kind: "group", members: [] }
    : null,
  assertCanInvokeAgent: async (input: { roomId?: string }) => {
    invocationInputs.push(input);
    if (!invocationAllowed) throw new Error("invocation_access_withdrawn");
  },
}));
const directDb = {
  select: () => {
    const query = {
      from: () => query,
      innerJoin: () => query,
      where: () => query,
      limit: async () => sourceRoomLive ? [{ id: GROUP_ROOM }] : [],
    };
    return query;
  },
};
mock.module("../../src/lib/server-direct-db", () => ({ getServerDirectDb: () => directDb }));
mock.module("../../src/lib/foreground-chat-funding", () => ({
  isOwnPrivateGenieRoom: async () => false,
  usageFundingFor: (decision: { kind: string; providerRoute: string }) => ({
    kind: decision.kind,
    providerRoute: decision.providerRoute,
  }),
}));
mock.module("../../src/lib/caller-task-model-context", () => ({
  callerTaskModelEnvironment: async () => ({}),
  callerTaskModelIds: async () => [SERVER_MODEL, PERSONAL_MODEL],
  personalOnlyTaskModelIds: async (_humanUserId: string, models: readonly string[]) =>
    models.filter((modelId) => modelId === PERSONAL_MODEL),
}));
mock.module("../../src/lib/capability-funding", () => ({
  createCapabilityFundingSession: () => ({ openModel: async () => {}, openService: async () => {} }),
  prepareCapabilityFundingSession: async () => ({ humanUserId: HUMAN_A }),
}));

class TestModelFundingError extends Error {
  constructor(readonly code: string) { super(code); }
}
mock.module("../../src/lib/model-funding", () => ({
  ModelFundingError: TestModelFundingError,
  readModelFundingPolicy: async () => ({ allowPersonalProviderKeys: true, fundingPreference }),
  resolveModelFunding: async (input: {
    humanUserId: string;
    modelId: string;
    priorDecision?: unknown;
    fundingKind?: "personal" | "server";
  }) => {
    fundingInputs.push({ humanUserId: input.humanUserId, modelId: input.modelId, prior: input.priorDecision });
    if (input.fundingKind === "personal") {
      return { ...PERSONAL_BINDING, humanUserId: input.humanUserId, payerHumanId: input.humanUserId,
        modelId: input.modelId, workload: "native_text_task" as const };
    }
    if (input.priorDecision && typeof input.priorDecision === "object" && "providerRoute" in input.priorDecision && input.priorDecision.providerRoute === "openai-chatgpt") {
      return { ...input.priorDecision, modelId: input.modelId, humanUserId: input.humanUserId, payerHumanId: input.humanUserId, workload: "native_text_task" as const };
    }
    return input.modelId === PERSONAL_MODEL
      ? { ...PERSONAL_BINDING, humanUserId: input.humanUserId, payerHumanId: input.humanUserId,
          modelId: input.modelId, workload: "native_text_task" as const }
      : { kind: "server" as const, providerRoute: input.priorDecision
          && typeof input.priorDecision === "object" && "providerRoute" in input.priorDecision
          && input.priorDecision.providerRoute === "surplus" ? "surplus"
          : input.modelId.startsWith("venice:") ? "venice" : "openrouter", humanUserId: input.humanUserId,
          modelId: input.modelId, workload: "native_text_task" as const };
  },
  withAdmittedPersonalCredential: async (
    _decision: unknown,
    run: (credential: { apiKey: string }) => Promise<unknown>,
  ) => run({ apiKey: "synthetic-personal-secret" }),
}));

const { nativeTaskFundingPort, isPersonalOnlyNativeTaskSelection } = await import("../../src/lib/native-task-funding");
const { createAgentTurnTaskCreationProvenance, createHumanApiTaskCreationProvenance } = await import("@nautilo/runtime");

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: crypto.randomUUID(),
    ownerId: GENIE_OWNER,
    requestorId: HUMAN_A,
    agentId: AGENT,
    prompt: "Do the work",
    expectedOutput: null,
    preset: "task",
    scheduleKind: "now",
    runAt: null,
    cron: null,
    timezone: "UTC",
    catchup: "run_once",
    callingRoomId: GROUP_ROOM,
    targetChat: "last_in_namespace",
    targetChatHandle: null,
    targetRoomId: null,
    resultDelivery: "wake",
    targetUserIds: [HUMAN_A, HUMAN_B],
    useScope: false,
    scopeId: null,
    toolsMode: "none",
    toolsWhitelist: [],
    awaitResponse: false,
    selectionProfile: "balanced",
    selectionSpec: null,
    requestedModelId: SERVER_MODEL,
    fundingMode: "caller",
    timeLimitSeconds: null,
    parentTaskId: null,
    depth: 0,
    status: "running",
    nextFireAt: new Date(),
    lastFiredAt: null,
    fireLockId: null,
    fireLockedAt: null,
    pauseRequestId: null,
    pauseRequestedAt: null,
    pauseReason: null,
    lastError: null,
    localExecutionDelegation: null,
    metadata: {},
    contentRepresentation: "ordinary",
    contentNamespaceId: null,
    contentRevision: 0,
    cryptoObjectId: null,
    cryptoAccessRevision: 0,
    cryptoRequiredNamespaceFingerprint: null,
    cryptoMappingState: "unmapped",
    ordinaryFallbackOperationId: null,
    ordinaryFallbackRequestDigest: null,
    ordinaryFallbackReason: null,
    ordinaryFallbackPolicyRevision: null,
    ordinaryFallbackCompletedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    cancelledAt: null,
    ...overrides,
  };
}

beforeEach(() => {
  invocationAllowed = true;
  sourceRoomLive = true;
  fundingPreference = "personal_first";
  fundingInputs.length = 0;
  invocationInputs.length = 0;
  taskRows.clear();
  runRows.clear();
});

afterAll(() => mock.restore());

describe("multi-user native Task funding", () => {
  test("foreign Genie selection in a group classifies the exact personal-only model", async () => {
    expect(await isPersonalOnlyNativeTaskSelection({
      requestorId: HUMAN_A,
      agentId: CHILD_AGENT,
      callingRoomId: GROUP_ROOM,
      requestedModelId: PERSONAL_MODEL,
    })).toBeTrue();
  });

  test("two Humans fund the same foreign Genie with their own identity and exact model", async () => {
    for (const [humanUserId, modelId] of [[HUMAN_A, SERVER_MODEL], [HUMAN_B, PERSONAL_MODEL]] as const) {
      const candidate = task({ requestorId: humanUserId, targetUserIds: [humanUserId], requestedModelId: modelId });
      expect(await nativeTaskFundingPort.prepareCreation(candidate,
        createHumanApiTaskCreationProvenance({ ownerId: GENIE_OWNER }))).toBeTrue();
    }
    expect(fundingInputs.map(({ humanUserId, modelId }) => ({ humanUserId, modelId }))).toEqual([
      { humanUserId: HUMAN_A, modelId: SERVER_MODEL },
      { humanUserId: HUMAN_B, modelId: PERSONAL_MODEL },
    ]);
  });

  test("a child chooses and freezes funding independently from its parent", async () => {
    const parent = task({ id: PARENT_ID, requestedModelId: SERVER_MODEL, status: "running", targetRoomId: ORPHAN_ROOM });
    taskRows.set(parent.id, parent);
    runRows.set(PARENT_RUN_ID, { id: PARENT_RUN_ID, taskId: parent.id, status: "running" } as TaskRun);
    const child = task({ ownerId: CHILD_GENIE_OWNER, agentId: CHILD_AGENT,
      requestedModelId: PERSONAL_MODEL, parentTaskId: parent.id,
      depth: parent.depth + 1, callingRoomId: parent.targetRoomId,
      preset: "schedule", targetRoomId: ORPHAN_ROOM });
    const provenance = createAgentTurnTaskCreationProvenance({ ownerId: child.ownerId,
      invocation: { ownerId: child.ownerId, roomId: child.callingRoomId,
        entrypoint: "background.task", taskId: parent.id, taskRunId: PARENT_RUN_ID } });

    expect(await nativeTaskFundingPort.prepareCreation(child, provenance)).toBeTrue();
    expect(await nativeTaskFundingPort.admit(parent)).toEqual({
      modelId: SERVER_MODEL,
      binding: { kind: "server", providerRoute: "openrouter" },
    });
    expect(await nativeTaskFundingPort.admit(child)).toEqual({ modelId: PERSONAL_MODEL, binding: PERSONAL_BINDING });
    expect(invocationInputs.at(-1)?.roomId).toBe(GROUP_ROOM);
  });

  test("revoked invocation authority blocks fresh dispatch admission", async () => {
    const candidate = task();
    expect(await nativeTaskFundingPort.prepareCreation(candidate,
      createHumanApiTaskCreationProvenance({ ownerId: GENIE_OWNER }))).toBeTrue();
    invocationAllowed = false;
    await rejects(nativeTaskFundingPort.admit(candidate), /invocation_access_withdrawn/);
  });

  test("revoked invocation authority blocks a resumed attempt with the frozen binding", async () => {
    const candidate = task();
    const run = {
      id: PARENT_RUN_ID,
      taskId: candidate.id,
      status: "running",
      modelId: SERVER_MODEL,
      graphThreadId: "task-thread",
      fundingBinding: { kind: "server", providerRoute: "openrouter" },
      fundingPredecessorRunId: null,
    } as TaskRun;
    taskRows.set(candidate.id, candidate);
    runRows.set(run.id, run);
    const session = await nativeTaskFundingPort.openSession(candidate, run, SERVER_MODEL, false);
    expect(session.admittedTransport).toBe("direct");
    expect(session.admission).toBeUndefined();
    invocationAllowed = false;
    await rejects(session.recheckAttempt(SERVER_MODEL), /invocation_access_withdrawn/);
    expect(fundingInputs.every(({ humanUserId }) => humanUserId === HUMAN_A)).toBeTrue();
  });

  test("restored server Surplus sessions expose transport without a foreground snapshot", async () => {
    const candidate = task();
    const run = {
      id: PARENT_RUN_ID,
      taskId: candidate.id,
      status: "running",
      modelId: SERVER_MODEL,
      graphThreadId: "task-thread",
      fundingBinding: { kind: "server", providerRoute: "surplus" },
      fundingPredecessorRunId: null,
    } as TaskRun;
    taskRows.set(candidate.id, candidate);
    runRows.set(run.id, run);

    const session = await nativeTaskFundingPort.openSession(candidate, run, SERVER_MODEL, false);

    expect(session.admittedTransport).toBe("surplus");
    expect(session.admission).toBeUndefined();
  });

  test("a foreign Genie's report-back wake retains its native funding and resume boundary", async () => {
    const wakeModel = "venice:wake-model";
    const candidate = task({ status: "completed" });
    const run = {
      id: PARENT_RUN_ID, taskId: candidate.id, status: "completed",
      modelId: SERVER_MODEL, graphThreadId: "task-thread",
      fundingBinding: { kind: "server", providerRoute: "openrouter" },
      fundingPredecessorRunId: null,
    } as TaskRun;
    taskRows.set(candidate.id, candidate);
    runRows.set(run.id, run);

    const session = await nativeTaskFundingPort.openSession(candidate, run, wakeModel, true);

    // This fixture's Genie is absent from the calling Room. A foreground
    // snapshot would route approval resume through a stricter Room-member gate.
    expect(session.admission).toBeUndefined();
    expect(session.admittedTransport).toBe("direct");
    expect(await session.runAttempt(wakeModel, async (attempt) => attempt.usageFunding))
      .toMatchObject({ kind: "server", providerRoute: "venice" });
    expect(fundingInputs).toHaveLength(2);
    for (const input of fundingInputs) {
      expect(input).toMatchObject({ humanUserId: HUMAN_A, modelId: wakeModel,
        prior: { kind: "server", modelId: SERVER_MODEL, providerRoute: "openrouter" } });
    }
  });

  test("a restored direct server admission crosses the real agent-node hydration boundary", async () => {
    const candidate = task({ requestedModelId: DIRECT_AGENT_MODEL });
    const run = {
      id: PARENT_RUN_ID,
      taskId: candidate.id,
      status: "running",
      modelId: DIRECT_AGENT_MODEL,
      graphThreadId: "task-thread",
      fundingBinding: { kind: "server", providerRoute: "openrouter" },
      fundingPredecessorRunId: null,
    } as TaskRun;
    taskRows.set(candidate.id, candidate);
    runRows.set(run.id, run);
    const session = await nativeTaskFundingPort.openSession(candidate, run, DIRECT_AGENT_MODEL, false);
    const hydrate = spyOn(actualSurplusRoute, "hydrateSurplusChatCatalog").mockImplementation(async () => {
      throw new Error("unexpected Surplus catalogue discovery");
    });
    const invoke = spyOn(actualChatInvocation, "invokeChatModelWithFallback").mockResolvedValue({
      response: new AIMessage("Direct provider completed the request."),
      modelUsed: DIRECT_AGENT_MODEL,
    });
    const config = spyOn(actualDb, "getCachedServerModelConfigRow").mockReturnValue({
      preferSurplus: true,
    } as ReturnType<typeof actualDb.getCachedServerModelConfigRow>);
    const previousOpenRouterKey = process.env["OPENROUTER_API_KEY"];
    const previousSurplusKey = process.env["SURPLUS_API_KEY"];
    process.env["OPENROUTER_API_KEY"] = "synthetic-direct-key";
    process.env["SURPLUS_API_KEY"] = "synthetic-surplus-key";
    initToolCatalog(new ToolCatalog());
    const prompt = new HumanMessage("Complete this restored direct-provider task.");

    try {
      const result = await actualAgent.agentNode({
        model: DIRECT_AGENT_MODEL,
        subagentDepth: 1,
        taskRun: true,
        trustedExecutionEntrypoint: "background.task",
        modelFallbackMode: "none",
        preparedMessages: [prompt],
        messages: [prompt],
        userId: HUMAN_A,
        causalHumanUserId: HUMAN_A,
        agentId: AGENT,
        roomId: null,
        turnId: "restored-direct-admission-turn",
        actorRole: "owner",
        memoryAccessEnvelope: null,
        toolWhitelist: [],
        activatedToolNames: [],
        activatedToolLeases: [],
        currentThreadId: "restored-direct-admission-thread",
        currentFolder: "",
        workspacePath: "",
      } as unknown as Parameters<typeof actualAgent.agentNode>[0],
      undefined, undefined, false, undefined, undefined, session);

      expect(result.model).toBe(DIRECT_AGENT_MODEL);
      expect(hydrate).not.toHaveBeenCalled();
      expect(invoke).toHaveBeenCalledTimes(1);
      expect(invoke.mock.calls[0]?.[7]).toMatchObject({ fundingSession: session });
    } finally {
      clearToolCatalog();
      config.mockRestore();
      invoke.mockRestore();
      hydrate.mockRestore();
      if (previousOpenRouterKey === undefined) delete process.env["OPENROUTER_API_KEY"];
      else process.env["OPENROUTER_API_KEY"] = previousOpenRouterKey;
      if (previousSurplusKey === undefined) delete process.env["SURPLUS_API_KEY"];
      else process.env["SURPLUS_API_KEY"] = previousSurplusKey;
    }
  });

  test("restored personal sessions do not gain native admission capabilities", async () => {
    const candidate = task({ requestedModelId: PERSONAL_MODEL });
    const run = {
      id: PARENT_RUN_ID,
      taskId: candidate.id,
      status: "running",
      modelId: PERSONAL_MODEL,
      graphThreadId: "task-thread",
      fundingBinding: PERSONAL_BINDING,
      fundingPredecessorRunId: null,
    } as TaskRun;
    taskRows.set(candidate.id, candidate);
    runRows.set(run.id, run);

    const session = await nativeTaskFundingPort.openSession(candidate, run, PERSONAL_MODEL, false);

    expect(session.kind).toBe("personal");
    expect(session.admission).toBeUndefined();
    expect(session.admittedTransport).toBeUndefined();
  });

  test("a server-first native Task exposes bounded personal recovery", async () => {
    fundingPreference = "server_first";
    const candidate = task();
    const run = {
      id: PARENT_RUN_ID,
      taskId: candidate.id,
      status: "running",
      modelId: SERVER_MODEL,
      graphThreadId: "task-thread",
      fundingBinding: { kind: "server", providerRoute: "openrouter" },
      fundingPredecessorRunId: null,
    } as TaskRun;
    taskRows.set(candidate.id, candidate);
    runRows.set(run.id, run);

    const session = await nativeTaskFundingPort.openSession(candidate, run, SERVER_MODEL, false);
    expect(session.allowUnpinnedSurplusRetry).toBe(true);
    expect(session.openPersonalRecovery).toBeFunction();
    const recovery = await session.openPersonalRecovery!(SERVER_MODEL);
    expect(recovery.allowUnpinnedSurplusRetry).toBe(true);
    expect(recovery.capabilityFunding).toBeUndefined();
    expect(recovery.openPersonalRecovery).toBeUndefined();
    expect(await recovery.runAttempt(SERVER_MODEL, async (attempt) => attempt)).toMatchObject({
      usageFunding: { kind: "personal", providerRoute: "openrouter" },
      personalCredential: { apiKey: "synthetic-personal-secret" },
    });
  });

  test("an archived source Room blocks fresh and resumed paid attempts", async () => {
    const fresh = task({ preset: "schedule", targetRoomId: null });
    expect(await nativeTaskFundingPort.prepareCreation(fresh,
      createHumanApiTaskCreationProvenance({ ownerId: GENIE_OWNER }))).toBeTrue();
    sourceRoomLive = false;
    await rejects(nativeTaskFundingPort.admit(fresh),
      (error: unknown) => (error as { code?: unknown }).code === "unsupported_workload");

    sourceRoomLive = true;
    const resumed = task({ preset: "schedule", targetRoomId: null });
    const run = {
      id: PARENT_RUN_ID,
      taskId: resumed.id,
      status: "running",
      modelId: SERVER_MODEL,
      graphThreadId: "task-thread",
      fundingBinding: { kind: "server", providerRoute: "openrouter" },
      fundingPredecessorRunId: null,
    } as TaskRun;
    taskRows.set(resumed.id, resumed);
    runRows.set(run.id, run);
    const session = await nativeTaskFundingPort.openSession(resumed, run, SERVER_MODEL, false);
    sourceRoomLive = false;
    await rejects(session.recheckAttempt(SERVER_MODEL),
      (error: unknown) => (error as { code?: unknown }).code === "unsupported_workload");
  });

  test("fresh and retained caller-funded schedules bind a missing destination to their source Room", async () => {
    const fresh = task({ preset: "schedule", targetRoomId: null });
    expect(await nativeTaskFundingPort.prepareCreation(fresh,
      createHumanApiTaskCreationProvenance({ ownerId: GENIE_OWNER }))).toBeTrue();
    expect(await nativeTaskFundingPort.admit(fresh)).toEqual({
      modelId: SERVER_MODEL,
      binding: { kind: "server", providerRoute: "openrouter" },
    });

    const run = {
      id: PARENT_RUN_ID,
      taskId: fresh.id,
      status: "running",
      modelId: SERVER_MODEL,
      graphThreadId: "task-thread",
      fundingBinding: { kind: "server", providerRoute: "openrouter" },
      fundingPredecessorRunId: null,
    } as TaskRun;
    taskRows.set(fresh.id, fresh);
    runRows.set(run.id, run);
    const session = await nativeTaskFundingPort.openSession(fresh, run, SERVER_MODEL, false);
    await session.recheckAttempt(SERVER_MODEL);
    const retainedInput = fundingInputs.at(-1);
    expect(retainedInput).toMatchObject({
      humanUserId: HUMAN_A,
      modelId: SERVER_MODEL,
    });
    expect(retainedInput?.prior).toMatchObject({ kind: "server", providerRoute: "openrouter" });

    await rejects(nativeTaskFundingPort.prepareCreation(
      task({ preset: "schedule", targetRoomId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" }),
      createHumanApiTaskCreationProvenance({ ownerId: GENIE_OWNER }),
    ), (error: unknown) => (error as { code?: unknown }).code === "unsupported_workload");
  });

  test("runtime progress may advance while admitted task semantics stay frozen", async () => {
    const candidate = task({ metadata: { bringBack: true } });
    const run = {
      id: PARENT_RUN_ID,
      taskId: candidate.id,
      status: "running",
      modelId: SERVER_MODEL,
      graphThreadId: "task-thread",
      fundingBinding: { kind: "server", providerRoute: "openrouter" },
      fundingPredecessorRunId: null,
    } as TaskRun;
    taskRows.set(candidate.id, candidate);
    runRows.set(run.id, run);
    const session = await nativeTaskFundingPort.openSession(candidate, run, SERVER_MODEL, false);

    taskRows.set(candidate.id, task({ ...candidate, metadata: {
      ...candidate.metadata,
      preparation: { stage: "preparing_model", taskRunId: run.id },
      lastInterruption: { code: "relay_unavailable" },
      writerReviewAwaiting: { version: 1, taskRunId: run.id, proposalId: "proposal" },
      writerReviewAcceptedReceipt: { version: 1, taskRunId: run.id, proposalId: "proposal", acceptedResultRevision: 1 },
    } }));
    await session.recheckAttempt(SERVER_MODEL);

    taskRows.set(candidate.id, task({ ...candidate, metadata: { bringBack: false } }));
    await rejects(session.recheckAttempt(SERVER_MODEL),
      (error: unknown) => (error as { code?: unknown }).code === "funding_source_changed");
  });

  test("subscription-funded children inherit the originating run and persist its account pin", async () => {
    const binding = { ...PERSONAL_BINDING, providerRoute: "openai-chatgpt" };
    const parent = task({ id: PARENT_ID, requestedModelId: PERSONAL_MODEL, targetRoomId: GROUP_ROOM });
    taskRows.set(parent.id, parent);
    runRows.set(PARENT_RUN_ID, { id: PARENT_RUN_ID, taskId: parent.id, status: "running", modelId: PERSONAL_MODEL, fundingBinding: binding } as TaskRun);
    const child = task({ parentTaskId: parent.id, depth: 1, requestedModelId: PERSONAL_MODEL });
    const provenance = createAgentTurnTaskCreationProvenance({ ownerId: GENIE_OWNER,
      invocation: { ownerId: GENIE_OWNER, roomId: GROUP_ROOM, entrypoint: "background.task", taskId: parent.id, taskRunId: PARENT_RUN_ID } });
    const admission = await nativeTaskFundingPort.prepareCreation(child, provenance);
    expect(admission).toEqual({ modelId: PERSONAL_MODEL, binding });
    expect(fundingInputs.at(-1)?.prior).toMatchObject({ ...binding, humanUserId: HUMAN_A, payerHumanId: HUMAN_A });
    const persisted = { ...child, metadata: { subscriptionFunding: binding } };
    expect(await nativeTaskFundingPort.admit(persisted)).toEqual({ modelId: PERSONAL_MODEL, binding });
    expect(fundingInputs.at(-1)?.prior).toMatchObject(binding);
    await rejects(nativeTaskFundingPort.prepareCreation(persisted, provenance), /funding_source_changed/);
    await rejects(nativeTaskFundingPort.prepareCreation({ ...child, toolsWhitelist: ["unsupported-tool"], toolsMode: "whitelist" }, provenance), /unsupported_workload/);
    await rejects(nativeTaskFundingPort.admit(persisted, { id: PARENT_RUN_ID, taskId: child.id, modelId: PERSONAL_MODEL, fundingBinding: PERSONAL_BINDING } as TaskRun), /funding_source_changed/);
  });

  test("forged parent lineage and unclassified metadata fail before funding", async () => {
    const parent = task({ id: PARENT_ID, targetRoomId: GROUP_ROOM });
    taskRows.set(parent.id, parent);
    const provenance = createAgentTurnTaskCreationProvenance({ ownerId: GENIE_OWNER,
      invocation: { ownerId: GENIE_OWNER, roomId: GROUP_ROOM, entrypoint: "background.task",
        taskId: PARENT_ID, taskRunId: PARENT_RUN_ID } });
    await rejects(nativeTaskFundingPort.prepareCreation(task({ parentTaskId: null }), provenance),
      (error: unknown) => (error as { code?: unknown }).code === "unsupported_workload");
    await rejects(nativeTaskFundingPort.prepareCreation(task({ metadata: { fundingBinding: PERSONAL_BINDING } }),
      createHumanApiTaskCreationProvenance({ ownerId: GENIE_OWNER })),
    (error: unknown) => (error as { code?: unknown }).code === "unsupported_workload");
    expect(fundingInputs).toHaveLength(0);
  });
});
