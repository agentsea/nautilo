import { describe, expect, test } from "bun:test";
import type { NautiloProfile } from "@nautilo/agent";
import type { DirectDatabase, Task, TaskRun } from "@nautilo/db";
import type {
  ProtectedTaskPredispatchPlan,
  ProtectedTaskRunningOccurrence,
} from "@nautilo/runtime";

import { createProductionProtectedTaskNativeExecutionContext } from
  "../../src/routes/protected-task-native-execution-context";

const ids = {
  owner: "11111111-1111-4111-8111-111111111111",
  agent: "22222222-2222-4222-8222-222222222222",
  task: "33333333-3333-4333-8333-333333333333",
  run: "44444444-4444-4444-8444-444444444444",
  job: "55555555-5555-4555-8555-555555555555",
  room: "66666666-6666-4666-8666-666666666666",
  namespace: "77777777-7777-4777-8777-777777777777",
  actor: "88888888-8888-4888-8888-888888888888",
  memoryNamespace: "99999999-9999-4999-8999-999999999999",
};

const startedAt = new Date("2026-10-01T12:00:00.000Z");
const fingerprint = new Uint8Array(32).fill(0x42);
const graphThreadId = `subagent:task:${ids.task}:initial`;
const cryptoObjectId = `task-definition:v1:${"a".repeat(64)}`;

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: ids.task,
    ownerId: ids.owner,
    requestorId: ids.owner,
    agentId: ids.agent,
    prompt: "",
    expectedOutput: null,
    preset: "in_background",
    scheduleKind: "now",
    runAt: null,
    cron: null,
    timezone: "UTC",
    catchup: "run_once",
    callingRoomId: null,
    targetChat: "orphan",
    targetChatHandle: null,
    targetRoomId: ids.room,
    resultDelivery: "wake",
    targetUserIds: [],
    useScope: false,
    scopeId: null,
    toolsMode: "auto",
    toolsWhitelist: [],
    awaitResponse: false,
    selectionProfile: "balanced",
    selectionSpec: null,
    requestedModelId: null,
    timeLimitSeconds: null,
    parentTaskId: null,
    depth: 0,
    status: "running",
    nextFireAt: null,
    lastFiredAt: null,
    fireLockId: null,
    fireLockedAt: null,
    lastError: null,
    localExecutionDelegation: null,
    metadata: {},
    fundingMode: "legacy_server",
    contentRepresentation: "protected",
    contentNamespaceId: ids.namespace,
    contentRevision: 3,
    cryptoObjectId,
    cryptoAccessRevision: 2,
    cryptoRequiredNamespaceFingerprint: fingerprint,
    cryptoMappingState: "verified",
    createdAt: startedAt,
    updatedAt: startedAt,
    cancelledAt: null,
    ...overrides,
  };
}

function run(overrides: Partial<TaskRun> = {}): TaskRun {
  return {
    id: ids.run,
    taskId: ids.task,
    jobId: ids.job,
    graphThreadId,
    status: "running",
    modelId: null,
    fundingBinding: null,
    fundingPredecessorRunId: null,
    resultText: null,
    startedAt,
    completedAt: null,
    lastError: null,
    resultRepresentation: "ordinary",
    resultContentNamespaceId: null,
    resultRevision: 0,
    resultCryptoObjectId: null,
    resultCryptoAccessRevision: 0,
    resultCryptoRequiredNamespaceFingerprint: null,
    resultCryptoMappingState: "unmapped",
    ...overrides,
  };
}

function occurrence(): ProtectedTaskRunningOccurrence {
  return {
    task: {
      id: ids.task,
      ownerId: ids.owner,
      requestorId: ids.owner,
      agentId: ids.agent,
      callingRoomId: null,
      scheduleKind: "now",
      contentRepresentation: "protected",
      contentNamespaceId: ids.namespace,
      contentRevision: 3,
      cryptoObjectId,
      cryptoAccessRevision: 2,
      cryptoRequiredNamespaceFingerprint: fingerprint,
    },
    run: {
      id: ids.run,
      taskId: ids.task,
      jobId: ids.job,
      graphThreadId,
      status: "running",
      startedAt,
    },
  };
}

function predispatch(): ProtectedTaskPredispatchPlan {
  const running = occurrence();
  return {
    occurrence: {
      task: running.task,
      run: {
        ...running.run,
        jobId: null,
        status: "awaiting",
      },
    },
    scheduling: {
      ownerId: ids.owner,
      requestorId: ids.owner,
      agentId: ids.agent,
      roomId: ids.room,
      callingRoomId: null,
      graphThreadId,
    },
    target: { roomId: ids.room, targetUserIds: [ids.owner] },
    memory: {
      mode: "namespace",
      authorityStatus: "exact",
      provenance: "target_users_namespace",
      envelope: {
        memoryMode: "namespace",
        ownerId: ids.owner,
        actorId: ids.actor,
        agentId: ids.agent,
        roomId: ids.room,
        readableNamespaces: [ids.memoryNamespace],
        mutableNamespaces: [ids.memoryNamespace],
        writableNamespaces: [ids.memoryNamespace],
        toolPolicy: {},
      },
    },
  } as unknown as ProtectedTaskPredispatchPlan;
}

function reference(): Record<string, unknown> {
  return {
    kind: "protected_task_run_v1",
    taskId: ids.task,
    taskRunId: ids.run,
    inputObjectId: cryptoObjectId,
    resultObjectId: `task-run-result:v1:${"b".repeat(64)}`,
    authorizationRequestId: "request-1",
    policyRevision: 1,
    executionSegment: 1,
  };
}

function profile(): NautiloProfile {
  return {
    name: "Ada",
    soulFile: "Be precise.",
    defaultModel: "provider:profile-model",
  } as NautiloProfile;
}

function harness(
  taskOverrides: Partial<Task> = {},
  executionOverrides: Readonly<{
    run?: Partial<TaskRun>;
    reference?: Record<string, unknown>;
  }> = {},
) {
  const currentTask = task(taskOverrides);
  let currentRun = run(executionOverrides.run);
  let attachCalls = 0;
  const job = {
    id: ids.job,
    ownerId: ids.owner,
    requestorId: ids.owner,
    laneKey: `task:${ids.task}`,
    type: "foreground" as const,
    status: "running" as const,
    input: executionOverrides.reference ?? reference(),
    result: null,
    message: null,
    createdAt: startedAt,
    startedAt,
    completedAt: null,
  };
  const dependencies = {
    db: {} as DirectDatabase,
    resolveToolWhitelist: () => undefined,
    readTask: async () => currentTask,
    readRun: async () => currentRun,
    readJob: async () => job,
    getProfileByAgentId: async () => profile(),
    assertCanUseServerProviderCredentials: async () => {},
    attachProtectedTaskRunModel: async (
      _db: DirectDatabase,
      input: { modelId: string },
    ) => {
      attachCalls += 1;
      if (currentRun.modelId !== null) {
        return currentRun.modelId === input.modelId
          ? { status: "same" as const }
          : { status: "stale" as const };
      }
      currentRun = run({ modelId: input.modelId });
      return { status: "attached" as const };
    },
    resolveTaskReturnBinding: () => ({ status: "not_captured" as const }),
    resolveRelayCapabilities: () => undefined,
  };
  return {
    dependencies,
    get attachCalls() { return attachCalls; },
    setJobStatus(status: string) {
      (job as { status: string }).status = status;
    },
  };
}

const input = {
  occurrence: occurrence(),
  predispatch: predispatch(),
  protectedMetadata: {},
};

describe("protected Task native execution context", () => {
  test("binds the selected profile model and ordinary depth policy", async () => {
    const state = harness();
    const context = await createProductionProtectedTaskNativeExecutionContext({
      ...state.dependencies,
      resolveTaskModel: ({ baseModelId }) => ({
        modelId: `${baseModelId}/selected`,
        reasons: [],
      }),
    })(input);

    expect(context).toMatchObject({
      assistantName: "Ada",
      soulFile: "Be precise.",
      modelId: "provider:profile-model/selected",
      modelFallbackMode: "agent_chain",
      subagentDepth: 1,
      subagentMaxDepth: 5,
      roomRoster: [],
    });
    expect(state.attachCalls).toBe(1);
  });

  test("uses exact-model resolution and preserves the validated tool ceiling", async () => {
    const state = harness({
      requestedModelId: "provider:exact-model",
      toolsMode: "whitelist",
      toolsWhitelist: ["search_memory"],
    });
    const context = await createProductionProtectedTaskNativeExecutionContext({
      ...state.dependencies,
      resolveExactTaskModelId: input => input.requestedModelId!,
      resolveToolWhitelist: taskRow => [...taskRow.toolsWhitelist],
    })(input);

    expect(context.modelId).toBe("provider:exact-model");
    expect(context.modelFallbackMode).toBe("none");
    expect(context.toolWhitelist).toEqual(["search_memory"]);
  });

  test("reuses the exact persisted model for a continuation segment", async () => {
    const modelId = "provider:profile-model/selected";
    const state = harness({}, {
      run: { modelId },
      reference: {
        ...reference(),
        authorizationRequestId: "request-2",
        executionSegment: 2,
        resumeContinuationFingerprint: "A".repeat(43),
      },
    });
    const context = await createProductionProtectedTaskNativeExecutionContext({
      ...state.dependencies,
      resolveTaskModel: () => ({ modelId, reasons: [] }),
    })(input);

    expect(context.modelId).toBe(modelId);
    expect(state.attachCalls).toBe(1);
  });

  test("rejects a continuation when current model selection drifted", async () => {
    const state = harness({}, {
      run: { modelId: "provider:previous-model" },
      reference: {
        ...reference(),
        authorizationRequestId: "request-2",
        executionSegment: 2,
        resumeContinuationFingerprint: "A".repeat(43),
      },
    });
    const load = createProductionProtectedTaskNativeExecutionContext({
      ...state.dependencies,
      resolveTaskModel: () => ({
        modelId: "provider:replacement-model",
        reasons: [],
      }),
    });

    await Promise.resolve(expect(load(input)).rejects.toThrow(
      "Protected Task execution model binding is stale",
    ));
    expect(state.attachCalls).toBe(1);
  });

  test("rejects a prebound model on the initial execution segment", async () => {
    const state = harness({}, { run: { modelId: "provider:prebound-model" } });
    const load = createProductionProtectedTaskNativeExecutionContext(
      state.dependencies,
    );

    await Promise.resolve(expect(load(input)).rejects.toThrow(
      "Protected Task execution is no longer current",
    ));
    expect(state.attachCalls).toBe(0);
  });

  test("rejects a stale Job before funding or model attachment", async () => {
    const state = harness();
    state.setJobStatus("completed");
    const load = createProductionProtectedTaskNativeExecutionContext({
      ...state.dependencies,
      assertCanUseServerProviderCredentials: async () => {
        throw new Error("must not reach funding");
      },
    });

    await Promise.resolve(expect(load(input)).rejects.toThrow(
      "Protected Task execution Job is no longer current",
    ));
    expect(state.attachCalls).toBe(0);
  });

  test("propagates funding denial without selecting or attaching a model", async () => {
    const state = harness();
    let modelCalls = 0;
    const load = createProductionProtectedTaskNativeExecutionContext({
      ...state.dependencies,
      assertCanUseServerProviderCredentials: async () => {
        throw new Error("funding_source_changed");
      },
      resolveTaskModel: input => {
        modelCalls += 1;
        return { modelId: input.baseModelId, reasons: [] };
      },
    });

    await Promise.resolve(
      expect(load(input)).rejects.toThrow("funding_source_changed"),
    );
    expect(modelCalls).toBe(0);
    expect(state.attachCalls).toBe(0);
  });

  test("rejects caller funding without falling back to server credentials", async () => {
    const state = harness({ fundingMode: "caller" });
    let serverFundingCalls = 0;
    const load = createProductionProtectedTaskNativeExecutionContext({
      ...state.dependencies,
      assertCanUseServerProviderCredentials: async () => {
        serverFundingCalls += 1;
      },
    });

    await Promise.resolve(expect(load(input)).rejects.toThrow(
      "Caller-funded protected Task execution is unsupported",
    ));
    expect(serverFundingCalls).toBe(0);
    expect(state.attachCalls).toBe(0);
  });
  test("rejects changed tool policy while model resolution is in flight", async () => {
    const f = harness();
    const readTask = f.dependencies.readTask;
    let reads = 0;
    const loader = createProductionProtectedTaskNativeExecutionContext({
      ...f.dependencies,
      resolveTaskModel: ({ baseModelId }) => ({ modelId: baseModelId, reasons: [] }),
      readTask: async () => {
        const row = await readTask();
        return ++reads === 1 ? row : { ...row, toolsMode: "none" as const };
      },
    });
    const result = await loader(input).catch((error: unknown) => error);
    expect(result).toBeInstanceOf(Error);
    expect(result instanceof Error ? result.message : null).toContain("changed after model binding");
  });

  test("rejects extra target users added after predispatch before model binding", async () => {
    const f = harness({ targetUserIds: [ids.owner, "b0000000-0000-4000-8000-00000000000b"] });
    const loader = createProductionProtectedTaskNativeExecutionContext(f.dependencies);
    const result = await loader(input).catch((error: unknown) => error);
    expect(result).toBeInstanceOf(Error);
    expect(result instanceof Error ? result.message : null).toContain("no longer current");
    expect(f.attachCalls).toBe(0);
  });

});
