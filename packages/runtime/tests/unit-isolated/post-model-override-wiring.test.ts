/**
 * D418 task 3.2.5 — verifies the `langgraphExecutor` threads the Full
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
 * captured deps carry no resolver (byte-for-byte pre-D418 behavior).
 */
import { afterAll, afterEach, describe, expect, mock, test } from "bun:test";
import type { WorkstationAdmissionDecision } from "@nautilo/trust";
import * as realNautiloAgent from "@nautilo/agent";
import * as realTrust from "@nautilo/trust";

let capturedDeps: unknown = undefined;
let capturedPolicyResolver: unknown = undefined;
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
let profileDefaultModel = "test:chat";
let snapshotsToLoad: ModelSnapshotFixture[] = [];
const snapshotLoads: Array<[string, string, string | null]> = [];
const capturedGraphInputs: Record<string, unknown>[] = [];
const resolvedModelIds: string[] = [];

mock.module("@nautilo/agent", () => ({
  ...realNautiloAgent,
  // Keep the REAL defaultPostModelDeps object so the test's mutation is
  // visible to the executor (it imports the same reference).
  defaultPostModelDeps: realNautiloAgent.defaultPostModelDeps,
  createCheckpointSaver: () => ({}),
  // M311 deliberately resolves all selected context before constructing the
  // graph. Keep this wiring test hermetic by supplying the catalog coordinate
  // it now reaches on the way to the mocked graph boundary.
  getDefaultModel: () => ({ id: "test:chat" }),
  getAgentExecutionConfigById: async () => ({
    soulFile: null,
    name: "Test Agent",
    defaultModel: profileDefaultModel,
  }),
  getAgentDisplayNameById: async () => null,
  selectPromptBriefMemories: async () => [],
  maybeSummarizeImagesWithVisionFallback: async () => [],
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
  capturedDeps = undefined;
  capturedPolicyResolver = undefined;
  captureGraphInput = false;
  profileDefaultModel = "test:chat";
  snapshotsToLoad = [];
  snapshotLoads.length = 0;
  capturedGraphInputs.length = 0;
  resolvedModelIds.length = 0;
});

afterAll(() => {
  // Restore the singleton so other test files in the same process see the
  // pre-D418 default (no resolver) unless app.ts installs one.
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
    "job-d418-wiring",
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
}

describe("langgraphExecutor — D418 Full Workstation override resolver wiring", () => {
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

  test("without an installed resolver, the graph deps carry no resolver (pre-D418)", async () => {
    delete (realNautiloAgent.defaultPostModelDeps as PostModelDepsWithResolver)
      .resolveWorkstationApprovalOverride;

    await driveExecutorOnce();

    expect(capturedDeps).toBeDefined();
    const deps = capturedDeps as { resolveWorkstationApprovalOverride?: unknown };
    expect(deps.resolveWorkstationApprovalOverride).toBeUndefined();
  });
});

describe("foreground model-control snapshot ingress", () => {
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
  });
});
