/**
 * Verifies the `langgraphExecutor` threads the Full
 * Workstation approval override resolver (installed by `app.ts` on
 * `defaultPostModelDeps.resolveWorkstationApprovalOverride`) into the graph
 * it builds via `createNautiloGraph`. The post-model Pass 2 consultation is
 * unit-covered in `packages/agent/tests/unit/post-model.test.ts`; this file
 * pins the executor/server DI link so a regression in the wiring (e.g. the
 * executor passing a hard-coded deps object instead of `defaultPostModelDeps`)
 * is caught here.
 *
 * Strategy: mock `@nautilo/agent` so `createNautiloGraph` captures the deps
 * it is handed and then throws a sentinel to halt the executor before any
 * downstream agent call. Mutate the real `defaultPostModelDeps` object with
 * a stub resolver, drive one executor `.next()`, and assert the captured
 * deps carry the stub. A second case asserts that without the mutation the
 * captured deps carry no resolver.
 */
import { afterAll, afterEach, describe, expect, mock, test } from "bun:test";
import type { WorkstationAdmissionDecision } from "@nautilo/trust";
import * as realNautiloAgent from "@nautilo/agent";
import * as realTrust from "@nautilo/trust";
import * as realDatabase from "@nautilo/db";
import * as realFundingPort from "../../src/foreground-chat-funding-port";
import type { ProtectedConversationExecutionServices, ProtectedConversationExecutorTurnScope } from "../../src/conversation/conversation-execution-services";
import * as externalRoomContext from "../../src/executors/external-room-context";

let capturedDeps: unknown = undefined;
let capturedPolicyResolver: unknown = undefined;
let foregroundCatalogHydrated = true;
let foregroundCatalogHydrationCalls = 0;
type ModelSnapshotFixture = {
  roomSelection: { modelId: string } | null;
  agentSelection: { modelId: string } | null;
  serverReasoningPolicy: null;
  turnModelId: string | null;
};
const modelSnapshot: ModelSnapshotFixture = {
  roomSelection: null,
  agentSelection: null,
  serverReasoningPolicy: null,
  turnModelId: null,
};
let captureGraphInput = false;
let profileDefaultModel: string | null = "test:chat";
let snapshotsToLoad: ModelSnapshotFixture[] = [];
const snapshotLoads: Array<[string, string, string | null]> = [];
const capturedGraphInputs: Record<string, unknown>[] = [];
const resolvedModelIds: string[] = [];
const forkSourceLookups: string[][] = [];
const assertForkRoomContextAllowed = externalRoomContext.assertForkRoomContextAllowed;
const externalRoomExecutionInput = externalRoomContext.externalRoomExecutionInput;
const getRealModelTokenLimit = realNautiloAgent.getModelTokenLimit;
const streamRealForegroundGraph = realNautiloAgent.streamForegroundGraph;
let exerciseContextRefresh = false;

// Keep the real history renderer and model-limit resolver. Only its data reads
// and the already-admitted server funding port are replaced in this fixture.
const admittedSessions = new Map<string, realNautiloAgent.ForegroundChatFundingSession>();
let haltAtContextLimit = false;
const preparedContextLimits: number[] = [];
const contextLimitReached = "__real_context_limit_prepared__";
mock.module("../../src/foreground-chat-funding-port", () => ({
  ...realFundingPort,
  openForegroundChatFundingSessionForInvocation: async (input: { roomId: string }) =>
    admittedSessions.get(input.roomId) ?? null,
}));
mock.module("../../src/context/build-transcript-context-deps", () => ({
  defaultBuildTranscriptContextDeps: () => ({
    readRoomTranscript: async () => { await Promise.resolve(); return []; },
    readSubagentTranscript: async () => [],
    close: async () => {},
  }),
}));

// Model-selection fixtures have no external source Rooms. Keep the real fork
// guard, but supply its canonical lookup instead of consulting a live database.
mock.module("../../src/executors/external-room-context", () => ({
  ...externalRoomContext,
  externalRoomExecutionInput: (input: Record<string, unknown>) => externalRoomExecutionInput(input, {
    ...realTrust.externalRoomExecutionDependencies,
    policy: async () => null,
  }),
  assertForkRoomContextAllowed: (input: Record<string, unknown>, fork: Parameters<typeof externalRoomContext.assertForkRoomContextAllowed>[1]) =>
    assertForkRoomContextAllowed(input, fork, {
      policy: async () => null,
      roomIdsForThreads: async (threadIds) => {
        forkSourceLookups.push([...threadIds]);
        return [];
      },
    }),
}));
mock.module("@nautilo/db", () => ({
  ...realDatabase,
  getSharedDirectDb: () => { throw new Error("unexpected-database-access-in-model-wiring-test"); },
}));

// Match the production no-image result; an array would falsely signal completion.
const noImageAssistance: typeof realNautiloAgent.maybeSummarizeImagesWithVisionFallback =
  async () => null;

mock.module("@nautilo/agent", () => ({
  ...realNautiloAgent,
  streamForegroundGraph: async function* (...args: Parameters<typeof streamRealForegroundGraph>) {
    if (!exerciseContextRefresh) return yield* streamRealForegroundGraph(...args);
    const graphInput = args[1] as realNautiloAgent.NautiloState;
    const rebuild = args[3]?.rebuildForegroundContext;
    if (!rebuild) throw new Error("missing-foreground-refresh-callback");
    haltAtContextLimit = true;
    if (graphInput.model === null) throw new Error("missing-refresh-model");
    await rebuild({
      state: graphInput,
      request: { kind: "foreground_context_refresh", status: "ready", reason: "visible_assistant_text",
        modelId: graphInput.model, maximumContextCharacters: 1_000, projectionFingerprint: "fixture" },
    });
    throw new Error("unexpected-refresh-success");
  },
  getModelTokenLimit: (modelId: string) => {
    const limit = getRealModelTokenLimit(modelId);
    if (haltAtContextLimit) {
      preparedContextLimits.push(limit);
      throw new Error(contextLimitReached);
    }
    return limit;
  },
  // Keep the REAL defaultPostModelDeps object so the test's mutation is
  // visible to the executor (it imports the same reference).
  defaultPostModelDeps: realNautiloAgent.defaultPostModelDeps,
  createCheckpointSaver: () => ({}),
  // The executor deliberately resolves all selected context before constructing the
  // graph. Keep this wiring test hermetic by supplying the catalog coordinate
  // it now reaches on the way to the mocked graph boundary.
  getDefaultModel: () => ({ id: "test:chat" }),
  getDefaultForegroundAgentModelId: () => {
    if (!foregroundCatalogHydrated) throw new Error("expired-foreground-model-catalog");
    return "test:auto";
  },
  hydrateForegroundAgentModelCatalog: async () => {
    foregroundCatalogHydrationCalls += 1;
    await Promise.resolve();
    foregroundCatalogHydrated = true;
  },
  getAgentExecutionConfigById: async () => ({
    soulFile: null,
    name: "Test Agent",
    defaultModel: profileDefaultModel,
  }),
  getAgentDisplayNameById: async () => null,
  selectPromptBriefMemories: async () => [],
  maybeSummarizeImagesWithVisionFallback: noImageAssistance,
  loadForegroundModelControlSnapshot: async (
    roomId: string,
    agentId: string,
    turnModelId: string | null,
  ) => {
    snapshotLoads.push([roomId, agentId, turnModelId]);
    return snapshotsToLoad.shift() ?? modelSnapshot;
  },
  resolveModelRole: (
    _role: string,
    options?: { configuredId?: string | null },
  ) => {
    const resolved = options?.configuredId?.trim() || "test:chat";
    resolvedModelIds.push(resolved);
    return resolved;
  },
  createNautiloGraph: (
    _saver: unknown,
    policyResolver: unknown,
    deps: unknown,
  ) => {
    capturedDeps = deps;
    capturedPolicyResolver = policyResolver;
    if (!captureGraphInput) {
      throw new Error("__halt_before_downstream_agent_calls__");
    }
    return {
      streamEvents(input: Record<string, unknown>) {
        capturedGraphInputs.push(input);
        throw new Error("__halt_after_graph_input_capture__");
      },
    };
  },
}));

mock.module("@nautilo/trust", () => ({
  ...realTrust,
  getPolicyResolver: () => ({ __stub: true }),
  envelopeReadableNamespaces: () => [],
}));

// Import AFTER the mocks are registered so the executor resolves the mocked
// modules. The dynamic import also keeps bun's module-mock ordering stable.
const { langgraphExecutor } = await import("../../src/executors/langgraph-executor");
const { forkLanggraphExecutor } = await import("../../src/executors/fork-langgraph-executor");

const originalResolver = realNautiloAgent.defaultPostModelDeps.resolveWorkstationApprovalOverride;

// Structural view of the optional resolver field so this test can set /
// delete it under `exactOptionalPropertyTypes: true` without importing the
// `WorkstationApprovalOverrideResolver` type (the agent barrel does not
// re-export it). The field is optional on `PostModelDeps`.
type PostModelDepsWithResolver = {
  resolveWorkstationApprovalOverride?:
    | ((req: unknown) => WorkstationAdmissionDecision | Promise<WorkstationAdmissionDecision>)
    | undefined;
};

afterEach(() => {
  exerciseContextRefresh = false;
  admittedSessions.clear();
  haltAtContextLimit = false;
  preparedContextLimits.length = 0;
  capturedDeps = undefined;
  capturedPolicyResolver = undefined;
  captureGraphInput = false;
  profileDefaultModel = "test:chat";
  foregroundCatalogHydrated = true;
  foregroundCatalogHydrationCalls = 0;
  snapshotsToLoad = [];
  snapshotLoads.length = 0;
  capturedGraphInputs.length = 0;
  resolvedModelIds.length = 0;
  forkSourceLookups.length = 0;
});

afterAll(() => {
  // Restore the singleton so other test files in the same process see the
  // default (no resolver) unless app.ts installs one.
  // `exactOptionalPropertyTypes: true` forbids assigning `undefined` to an
  // optional property, so use `delete` to restore the absent state.
  if (originalResolver === undefined) {
    delete (realNautiloAgent.defaultPostModelDeps as PostModelDepsWithResolver)
      .resolveWorkstationApprovalOverride;
  } else {
    realNautiloAgent.defaultPostModelDeps.resolveWorkstationApprovalOverride =
      originalResolver;
  }
});

function minimalInput(): Record<string, unknown> {
  return {
    ownerId: "owner-1",
    message: "hello",
    agentId: "agent-1",
    humanAlreadyPersisted: true,
  };
}

async function driveExecutorOnce(input: Record<string, unknown> = {}): Promise<void> {
  const controller = new AbortController();
  const gen = langgraphExecutor(
    { ...minimalInput(), ...input },
    "job-override-wiring",
    null,
    controller.signal,
  );
  try {
    await gen.next();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (!msg.includes("__halt_before_downstream_agent_calls__") &&
        !msg.includes("__halt_after_graph_input_capture__")) {
      throw e;
    }
  }
}

async function driveForkOnce(input: Record<string, unknown>): Promise<void> {
  const parentThreadId = "parent-thread";
  const gen = forkLanggraphExecutor(
    {
      ...minimalInput(),
      ...input,
      forkRun: {
        mode: "fork",
        parentThreadId,
        forkThreadId: `${parentThreadId}:fork:turn-1:suffix`,
        checkpointThreadId: `${parentThreadId}:fork:turn-1:suffix`,
        transcriptThreadId: parentThreadId,
        sequence: 1,
        pendingTurns: [],
      },
    },
    "job-model-snapshot-fork",
    null,
    new AbortController().signal,
  );
  try {
    await gen.next();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (!msg.includes("__halt_after_graph_input_capture__")) throw e;
  }
  expect(forkSourceLookups.at(-1)).toEqual([
    parentThreadId,
    `${parentThreadId}:fork:turn-1:suffix`,
  ]);
}

describe("langgraphExecutor — Full Workstation override resolver wiring", () => {
  test("threads defaultPostModelDeps.resolveWorkstationApprovalOverride into the graph", async () => {
    const stubResolver = (): WorkstationAdmissionDecision => ({
      override: "none",
      executionClass: "profile_bound_sandbox",
      reason: "no_active_session",
      detail: "stub",
    });
    (realNautiloAgent.defaultPostModelDeps as PostModelDepsWithResolver).resolveWorkstationApprovalOverride =
      stubResolver;

    await driveExecutorOnce();

    expect(capturedDeps).toBeDefined();
    expect(capturedPolicyResolver).toEqual({ __stub: true });
    // The executor spreads defaultPostModelDeps into a per-turn deps object;
    // the resolver reference must survive the spread.
    const deps = capturedDeps as { resolveWorkstationApprovalOverride?: unknown };
    expect(deps.resolveWorkstationApprovalOverride).toBe(stubResolver);
  });

  test("without an installed resolver, the graph deps carry no resolver", async () => {
    delete (realNautiloAgent.defaultPostModelDeps as PostModelDepsWithResolver)
      .resolveWorkstationApprovalOverride;

    await driveExecutorOnce();

    expect(capturedDeps).toBeDefined();
    const deps = capturedDeps as { resolveWorkstationApprovalOverride?: unknown };
    expect(deps.resolveWorkstationApprovalOverride).toBeUndefined();
  });
});

describe("foreground model-control snapshot ingress", () => {
  test("main and fork await catalog hydration before resolving an expired automatic default", async () => {
    captureGraphInput = true;
    profileDefaultModel = null;

    foregroundCatalogHydrated = false;
    await driveExecutorOnce();
    expect(capturedGraphInputs.at(-1)?.["model"]).toBe("test:auto");

    foregroundCatalogHydrated = false;
    await driveForkOnce({});
    expect(capturedGraphInputs.at(-1)?.["model"]).toBe("test:auto");
    expect(foregroundCatalogHydrationCalls).toBe(2);
  });

  test("main and fork preserve an explicit turn model above Room and profile choices", async () => {
    captureGraphInput = true;
    profileDefaultModel = "unknown:unavailable-profile-default";
    const explicitModel = "openrouter:openai/gpt-5.6-terra";
    const snapshot = {
      ...modelSnapshot,
      roomSelection: { modelId: "anthropic:claude-sonnet-4-6" },
      turnModelId: explicitModel,
    };
    snapshotsToLoad = [snapshot, snapshot];

    await driveExecutorOnce({ model: explicitModel });
    await driveForkOnce({ model: explicitModel });

    expect(snapshotLoads).toEqual([
      ["", "agent-1", explicitModel],
      ["", "agent-1", explicitModel],
    ]);
    expect(capturedGraphInputs.map((input) => input["model"])).toEqual([
      explicitModel,
      explicitModel,
    ]);
    expect(capturedGraphInputs.map((input) => input["foregroundModelControlSnapshot"]))
      .toEqual([snapshot, snapshot]);
    expect(resolvedModelIds).toEqual([explicitModel, explicitModel]);
    expect(foregroundCatalogHydrationCalls).toBe(0);
  });

  test("main and fork load a fresh Room snapshot without evaluating an unavailable profile default", async () => {
    captureGraphInput = true;
    profileDefaultModel = "unknown:unavailable-profile-default";
    const firstSnapshot = {
      ...modelSnapshot,
      roomSelection: { modelId: "anthropic:claude-sonnet-4-6" },
    };
    const secondSnapshot = {
      ...modelSnapshot,
      roomSelection: { modelId: "openai:gpt-5.6-terra" },
    };
    snapshotsToLoad = [firstSnapshot, secondSnapshot, firstSnapshot, secondSnapshot];

    await driveExecutorOnce();
    await driveExecutorOnce();
    await driveForkOnce({});
    await driveForkOnce({});

    expect(capturedGraphInputs.map((input) => input["model"])).toEqual([
      "anthropic:claude-sonnet-4-6",
      "openai:gpt-5.6-terra",
      "anthropic:claude-sonnet-4-6",
      "openai:gpt-5.6-terra",
    ]);
    expect(capturedGraphInputs.map((input) => input["foregroundModelControlSnapshot"]))
      .toEqual([firstSnapshot, secondSnapshot, firstSnapshot, secondSnapshot]);
    expect(resolvedModelIds).not.toContain(profileDefaultModel);
    expect(foregroundCatalogHydrationCalls).toBe(0);
  });
});


describe("funded foreground context preparation", () => {
  const modelId = "mindswapper:fixture/chat";
  const model = (maxInputTokens: number): realNautiloAgent.MindSwapperChatModel => ({
    id: modelId,
    displayName: "Scoped chat fixture",
    offers: [{ inputModalities: ["text"], supportedParameters: ["tools"], maxInputTokens, maxOutputTokens: 100 }],
  });
  const session = (models: readonly realNautiloAgent.MindSwapperChatModel[]): realNautiloAgent.ForegroundChatFundingSession => ({
    kind: "server",
    mindswapperModels: models,
    recheckAttempt: async () => {},
    runAttempt: async () => { throw new Error("unexpected-provider-attempt-during-context-preparation"); },
  });

  async function prepare(fork: boolean, protectedContext: boolean, roomId: string): Promise<void> {
    const input = {
      ...minimalInput(), model: modelId, roomId,
      ...(exerciseContextRefresh ? { causalHumanUserId: "human-fixture", explicitlySelected: true, currentMessageId: 10 } : {}),
      ...(fork ? { forkRun: {
        mode: "fork", parentThreadId: "parent", forkThreadId: "parent:fork:fixture",
        checkpointThreadId: "parent:fork:fixture", transcriptThreadId: "parent",
        sequence: 1, pendingTurns: [],
      } } : {}),
    };
    // Context limit resolution must finish before any protected service can be
    // used. The real limit resolver below halts at that precise boundary.
    const services = protectedContext ? {} as ProtectedConversationExecutionServices : undefined;
    const turn: ProtectedConversationExecutorTurnScope | undefined = protectedContext ? {
      history: [],
      readFreshHistory: async () => { throw new Error("unexpected-refresh"); },
      persist: async () => { throw new Error("unexpected-protected-write"); },
    } : undefined;
    const execute = fork ? forkLanggraphExecutor : langgraphExecutor;
    await execute(input, "context-preparation-fixture", null, new AbortController().signal, services, turn).next();
  }

  for (const fork of [false, true]) {
    test(`${fork ? "fork" : "main"} later history refresh re-enters the same model scope outside graph nodes`, async () => {
      exerciseContextRefresh = true;
      captureGraphInput = true;
      admittedSessions.set("room-refresh", session([model(2_000)]));
      const result = await prepare(fork, false, "room-refresh").then(
        () => "unexpected-context-success", (error: unknown) => String(error),
      );
      expect(result).toContain(contextLimitReached);
      expect(preparedContextLimits).toEqual([2_100]);
      expect(() => getRealModelTokenLimit(modelId)).toThrow("unavailable through the current MindSwapper connection");
    });
  }

  for (const fork of [false, true]) for (const protectedContext of [false, true]) {
    test(`${fork ? "fork" : "main"} ${protectedContext ? "protected" : "ordinary"} history uses only its admitted model envelope`, async () => {
      haltAtContextLimit = true;
      admittedSessions.set("room-small", session([model(1_000)]));
      admittedSessions.set("room-large", session([model(4_000)]));
      const results = await Promise.allSettled([
        prepare(fork, protectedContext, "room-small"),
        prepare(fork, protectedContext, "room-large"),
      ]);
      for (const result of results) {
        expect(result.status).toBe("rejected");
        if (result.status === "rejected") expect(String(result.reason)).toContain(contextLimitReached);
      }
      expect(preparedContextLimits.slice().sort((a, b) => a - b)).toEqual([1_100, 4_100]);
      expect(() => realNautiloAgent.getModelTokenLimit(modelId)).toThrow("unavailable through the current MindSwapper connection");
      expect(capturedDeps).toBeUndefined();
    });

    test(`${fork ? "fork" : "main"} ${protectedContext ? "protected" : "ordinary"} history rejects an absent or revoked projection despite ambient rows`, async () => {
      haltAtContextLimit = true;
      for (const unavailable of [[], [{ ...model(1_000), unavailableReason: "revoked" }]]) {
        admittedSessions.set("room-unavailable", session(unavailable));
        const result = await realNautiloAgent.withMindSwapperModels([model(9_000)], () =>
          prepare(fork, protectedContext, "room-unavailable").then(
            () => "unexpected-context-success",
            (error: unknown) => String(error),
          ));
        expect(result).toContain(unavailable.length === 0
          ? "Foreground chat funding authority is unavailable"
          : "unavailable through the current MindSwapper connection");
      }
      expect(preparedContextLimits).toEqual([]);
      expect(capturedDeps).toBeUndefined();
    });
  }
});
