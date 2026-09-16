import { describe, expect, test } from "bun:test";
import {
  HarnessControlPlane,
  type HarnessExecutionOutput,
  type HarnessRegistration,
  type TaskExecutionRouteFacts,
} from "@nautilo/runtime";
import type { CodexDerivedBindingScope } from "../../src/codex/authority";
import {
  CodexHarnessAdmissionFailure,
  CodexTaskExecutionRouteSelector,
  type CodexTaskExecutionRouteDeps,
} from "../../src/codex/harness-admission";
import {
  createCodexExecutionAdmission,
  isCodexExecutionAdmission,
} from "../../src/codex/execution-admission";
import { createCodexTaskHarnessExecutionRouteRegistration } from "../../src/codex/harness-composition";
import {
  TaskHarnessExecutionRouteFailure,
  TaskHarnessExecutionRouteProviderFailure,
  TaskHarnessExecutionRouter,
  type PersistedTaskHarnessRoute,
} from "../../src/harness/task-execution-route";

const OWNER = "11111111-1111-4111-8111-111111111111";
const AGENT = "22222222-2222-4222-8222-222222222222";
const PROFILE = "33333333-3333-4333-8333-333333333333";
const TASK = "44444444-4444-4444-8444-444444444444";
const RUN = "55555555-5555-4555-8555-555555555555";
const JOB = "66666666-6666-4666-8666-666666666666";
const ROOM = "77777777-7777-4777-8777-777777777777";

const facts: TaskExecutionRouteFacts = {
  taskId: TASK,
  taskRunId: RUN,
  parentTaskId: null,
  ownerId: OWNER,
  requestorId: OWNER,
  agentId: AGENT,
  roomId: ROOM,
  laneKey: "room:test",
  graphThreadId: "room:test:agent",
};

const scope = {
  userId: OWNER,
  agentId: AGENT,
  taskId: TASK,
  taskRunId: RUN,
  jobId: JOB,
  parentTaskId: null,
  roomId: ROOM,
  laneKey: facts.laneKey,
  profileId: PROFILE,
  relayId: "relay",
  profileHandle: PROFILE,
  profileGeneration: 1,
  accountGeneration: 1,
  posture: "codex_default",
  relaySessionId: "relay-session",
  desktopSessionId: "desktop-session",
  pairingGenerationRef: "pairing",
  capabilityRevision: 1,
  runtimeGeneration: 1,
  childGeneration: 1,
  workspace: {
    workspaceRef: "workspace",
    revision: 1,
    fingerprint: "fingerprint",
    issuedAt: "2026-07-29T00:00:00.000Z",
    expiresAt: "2026-07-30T00:00:00.000Z",
  },
  codexSandboxMode: "default",
  codexApprovalPolicy: "default",
} as CodexDerivedBindingScope;

const readiness = {
  relayId: scope.relayId,
  pairingGenerationRef: scope.pairingGenerationRef,
  capabilityRevision: scope.capabilityRevision,
};
const exactMetadata = { execution: { version: 1, harnessId: "codex", source: "genie", collaborationMode: "work", harnessModelId: "picker-5.5", readiness } };

function task(overrides: Record<string, unknown> = {}) {
  return {
    id: TASK,
    ownerId: OWNER,
    requestorId: OWNER,
    agentId: AGENT,
    parentTaskId: null,
    targetRoomId: ROOM,
    prompt: "Inspect the repository",
    metadata: exactMetadata,
    ...overrides,
  };
}

function terminal(status: "completed" | "failed" | "interrupted"): HarnessExecutionOutput {
  return {
    kind: "terminal",
    attribution: {
      bindingId: "binding", bindingGeneration: "1", taskId: TASK, roomId: ROOM,
      vendorSessionId: "thread", vendorTurnId: "turn", vendorItemId: null,
    },
    status,
    code: status === "completed" ? undefined : "upstream_failure",
  } as HarnessExecutionOutput;
}

function assistantCompleted(
  overrides: Partial<Extract<HarnessExecutionOutput, { readonly kind: "assistant_completed" }>> = {},
): Extract<HarnessExecutionOutput, { readonly kind: "assistant_completed" }> {
  return {
    kind: "assistant_completed",
    attribution: {
      bindingId: "binding", bindingGeneration: "1", taskId: TASK, roomId: ROOM,
      vendorSessionId: "thread", vendorTurnId: "turn", vendorItemId: "item",
    },
    text: "Authoritative answer",
    ...overrides,
  };
}

function build(input: {
  ownerEnabled?: boolean;
  profile?: { userId?: string; authState?: string; removalState?: string } | null;
  task?: ReturnType<typeof task>;
  outputs?: readonly HarnessExecutionOutput[];
  modelCatalog?: readonly { readonly id: string; readonly model: string }[];
  preflightError?: boolean;
  authorityError?: boolean;
  driverError?: Error;
  onComplete?: (value: Parameters<CodexTaskExecutionRouteDeps["taskRuns"]["complete"]>[0]) => void;
}) {
  const calls: string[] = [];
  let received: unknown;
  let factoryFacts: TaskExecutionRouteFacts | null = null;
  let completion: Parameters<CodexTaskExecutionRouteDeps["taskRuns"]["complete"]>[0] | null = null;
  let failure: Parameters<CodexTaskExecutionRouteDeps["taskRuns"]["fail"]>[0] | null = null;
  const registration: HarnessRegistration = {
    descriptor: {
      id: "codex", displayName: "Codex",
      setup: { installation: "on_demand", activation: "user_initiated" },
      integration: { authentication: "existing_session", resume: "runtime_decides" },
      declaredCapabilities: {
        execution: "supported", resume: "unknown", stop: "unknown", steer: "unknown", requests: "unknown",
      },
    },
    createDriver: () => ({
      execution: {
        async *start(admission) {
          received = admission;
          calls.push("driver");
          if (input.driverError) throw input.driverError;
          for (const output of input.outputs ?? [assistantCompleted(), terminal("completed")]) yield output;
        },
      },
      probeCapabilities: async () => ({ execution: "supported" }),
    }),
  };
  const deps: CodexTaskExecutionRouteDeps = {
    preferences: {
      getOwnerPreference: async () => ({ enabled: input.ownerEnabled ?? true, accountProfileId: PROFILE, defaultPosture: "codex_default" }),
      getProfile: async () => input.profile === null ? undefined : ({
        id: PROFILE, userId: input.profile?.userId ?? OWNER, relayId: "relay",
        profileHandle: PROFILE, profileGeneration: 1, accountGeneration: 1,
        authState: input.profile?.authState ?? "signed_in", removalState: input.profile?.removalState ?? "active",
      }),
    },
    tasks: { getTask: async () => input.task ?? task() },
    taskRuns: {
      linkJob: async (value) => { expect(value).toMatchObject({ taskId: TASK, taskRunId: RUN, jobId: JOB }); calls.push("link"); },
      complete: async (value) => {
        calls.push("complete");
        completion = value;
        input.onComplete?.(value);
      },
      fail: async (value) => { calls.push("fail"); failure = value; },
    },
    preflight: {
      prepare: async (profile) => {
        calls.push("preflight");
        expect(profile).toMatchObject({
          userId: OWNER,
          relayId: "relay",
          profileHandle: PROFILE,
          profileGeneration: 1,
          accountGeneration: 1,
        });
        if (input.preflightError) throw new Error("private desktop path");
      },
    },
    models: {
      list: async () => ({
        models: input.modelCatalog ?? [{ id: "picker-5.5", model: "gpt-5.5" }],
      }),
    },
    limits: {
      resolve: async (modelId) => ({
        modelId,
        catalogVersion: "test-catalog-v1",
        contextTokens: 1_000_000,
        maxOutputTokens: 128_000,
      }),
    },
    authority: {
      deriveScope: async (request) => {
        calls.push("authority");
        expect(request).toMatchObject({ actorId: OWNER, agentId: AGENT, taskId: TASK, taskRunId: RUN, jobId: JOB, roomId: ROOM });
        if (input.authorityError) throw new Error("untrusted upstream text");
        return scope;
      },
    },
    admissionFactory: {
      create: async ({ facts: selectedFacts, jobId, prompt, signal, selectedModel, outputContract, collaborationMode, workingDirectory }) => {
        calls.push("admission");
        factoryFacts = selectedFacts;
        return createCodexExecutionAdmission({
          jobId, taskId: TASK, taskRunId: RUN, ownerId: OWNER, requesterId: OWNER,
          roomId: ROOM, laneKey: facts.laneKey, source: "room", parentTaskId: null,
          binding: { id: "binding", generation: "1" },
          workspace: { id: "workspace", currentFolderReceiptId: "receipt", pairingGeneration: "1" },
          profile: { id: PROFILE, generation: "1" }, posture: { id: "codex_default", generation: "1" },
          prompt, abortSignal: signal,
          codex: { scope, selectedModel, outputContract, collaborationMode, workingDirectory, bindingKind: "task" },
        });
      },
    },
    controlPlane: new HarnessControlPlane([registration]),
    outputProjection: {
      project: async (output) => {
        calls.push(`project:${output.kind}`);
        return null;
      },
    },
  };
  return {
    selector: new CodexTaskExecutionRouteSelector(deps),
    calls,
    received: () => received,
    factoryFacts: () => factoryFacts,
    completion: () => completion,
    failure: () => failure,
  };
}

async function collect(route: NonNullable<Awaited<ReturnType<CodexTaskExecutionRouteSelector["select"]>>>, signal = new AbortController().signal) {
  for await (const _event of route.executor({ taskId: TASK, taskRunId: RUN }, JOB, facts.laneKey, signal)) {
    // The harness's room projector owns output delivery; these fixtures emit none.
  }
}

async function rejected(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
    throw new Error("expected rejection");
  } catch (error) {
    return error;
  }
}

describe("CodexTaskExecutionRouteSelector", () => {
  test("selects Codex through the generic exact-ID route and starts lazily after link + authority", async () => {
    const harness = build({});
    let selectorCreates = 0;
    const generic = new TaskHarnessExecutionRouter({
      tasks: {
        getTask: async () => ({
          id: TASK,
          ownerId: OWNER,
          requestorId: OWNER,
          agentId: AGENT,
          parentTaskId: null,
          targetRoomId: ROOM,
          execution: { version: 1, harnessId: "codex", source: "genie" },
        }) satisfies PersistedTaskHarnessRoute,
      },
      registrations: [createCodexTaskHarnessExecutionRouteRegistration(() => {
        selectorCreates += 1;
        return harness.selector.select;
      })],
    });
    expect(selectorCreates).toBe(0);
    const route = await generic.select(facts);
    expect(selectorCreates).toBe(1);
    expect(route).toMatchObject({
      coalescing: "separate",
      contention: "serialize",
      modelAttribution: "external",
    });
    expect(harness.calls).toEqual([]);
    await collect(route!);
    expect(isCodexExecutionAdmission(harness.received())).toBe(true);
    expect(harness.received()).toMatchObject({ codex: { selectedModel: "gpt-5.5" } });
    expect(harness.factoryFacts()).toEqual(facts);
    expect(Object.isFrozen(harness.factoryFacts())).toBe(true);
    expect(harness.calls).toEqual(["link", "preflight", "authority", "admission", "driver", "complete"]);
    expect(harness.completion()?.resultText).toBe("Authoritative answer");
  });

  test("preserves reviewed Codex selection failures and collapses unknown private errors", async () => {
    for (const [harness, expected] of [
      [build({ ownerEnabled: false }), "CODEX_NOT_ENABLED"],
      [build({ profile: { userId: "foreign" } }), "CODEX_PROFILE_UNAVAILABLE"],
    ] as const) {
      const generic = new TaskHarnessExecutionRouter({
        tasks: {
          getTask: async () => ({
            id: TASK,
            ownerId: OWNER,
            requestorId: OWNER,
            agentId: AGENT,
            parentTaskId: null,
            targetRoomId: ROOM,
            execution: { version: 1, harnessId: "codex", source: "genie" },
          }),
        },
        registrations: [createCodexTaskHarnessExecutionRouteRegistration(
          () => harness.selector.select,
        )],
      });

      const error = await rejected(generic.select(facts));
      expect(error).toBeInstanceOf(TaskHarnessExecutionRouteProviderFailure);
      expect(error).toMatchObject({ code: expected, message: expected });
      expect((error as Error).cause).toBeUndefined();
    }

    const privateFailure = new TaskHarnessExecutionRouter({
      tasks: {
        getTask: async () => ({
          id: TASK,
          ownerId: OWNER,
          requestorId: OWNER,
          agentId: AGENT,
          parentTaskId: null,
          targetRoomId: ROOM,
          execution: { version: 1, harnessId: "codex", source: "genie" },
        }),
      },
      registrations: [createCodexTaskHarnessExecutionRouteRegistration(
        () => async () => {
          throw new Error("private host path and upstream text");
        },
      )],
    });
    const error = await rejected(privateFailure.select(facts));
    expect(error).toBeInstanceOf(TaskHarnessExecutionRouteFailure);
    expect(error).toMatchObject({
      code: "TASK_HARNESS_ROUTE_UNAVAILABLE",
      message: "TASK_HARNESS_ROUTE_UNAVAILABLE",
    });
    expect((error as Error).cause).toBeUndefined();
  });

  test("carries Plan as an exact Task fact without changing binding identity", async () => {
    const harness = build({
      task: task({
        metadata: {
          execution: { version: 1, harnessId: "codex", source: "genie", collaborationMode: "plan", harnessModelId: "picker-5.5", readiness },
        },
      }),
    });
    const route = await harness.selector.select(facts);
    await collect(route!);
    expect(harness.received()).toMatchObject({
      codex: { collaborationMode: "plan", bindingKind: "task" },
    });
  });

  test("leaves ordinary and near-match tasks on the native route", async () => {
    for (const metadata of [
      {},
      { execution: { version: 1, harnessId: "codex", source: "agent", collaborationMode: "work", harnessModelId: "picker-5.5" } },
      { execution: { version: 1, harnessId: "codex", source: "room" } },
      { execution: { version: 2, harnessId: "codex", source: "room", collaborationMode: "work", harnessModelId: "picker-5.5" } },
      { execution: { version: 1, harnessId: "codex", source: "room", collaborationMode: "work", harnessModelId: "picker-5.5", extra: true } },
    ]) {
      const harness = build({ task: task({ metadata }) });
      expect(await harness.selector.select(facts)).toBeUndefined();
      expect(harness.calls).toEqual([]);
    }
  });

  test("fails closed when an exact Codex descriptor no longer agrees with canonical selector facts", async () => {
    const harness = build({ task: task({ targetRoomId: "other-room" }) });
    expect(await rejected(Promise.resolve(harness.selector.select(facts)))).toMatchObject({
      code: "CODEX_EXECUTION_FAILED",
    });
    expect(harness.calls).toEqual([]);
  });

  test("revalidates the harness model id at execution and never falls back across model domains", async () => {
    const harness = build({ modelCatalog: [] });
    const route = await harness.selector.select(facts);

    expect(await rejected(collect(route!))).toMatchObject({
      code: "CODEX_EXECUTION_FAILED",
    });
    expect(harness.received()).toBeUndefined();
    expect(harness.calls).toEqual(["link", "preflight", "fail"]);
  });

  test("rejects owner-disabled and foreign profile states", async () => {
    expect(await rejected(Promise.resolve(build({ ownerEnabled: false }).selector.select(facts)))).toMatchObject({ code: "CODEX_NOT_ENABLED" });
    expect(await rejected(Promise.resolve(build({ profile: { userId: "foreign" } }).selector.select(facts)))).toMatchObject({ code: "CODEX_PROFILE_UNAVAILABLE" });
  });

  test("terminalizes exactly once: only a local aborted Stop avoids failure", async () => {
    const completed = build({ outputs: [assistantCompleted(), terminal("completed")] });
    await collect((await completed.selector.select(facts))!);
    expect(completed.calls).toContain("complete");
    expect(completed.calls).not.toContain("fail");

    const failed = build({ outputs: [terminal("failed")] });
    expect(await rejected(collect((await failed.selector.select(facts))!))).toMatchObject({
      code: "CODEX_EXECUTION_FAILED",
    });
    expect(failed.calls.filter((entry) => entry === "fail")).toHaveLength(1);
    expect(failed.calls).not.toContain("complete");

    const interrupted = build({ outputs: [terminal("interrupted")] });
    expect(await rejected(collect((await interrupted.selector.select(facts))!))).toMatchObject({
      code: "CODEX_EXECUTION_FAILED",
    });
    expect(interrupted.calls).not.toContain("complete");
    expect(interrupted.calls.filter((entry) => entry === "fail")).toHaveLength(1);

    const aborted = build({ outputs: [] });
    const controller = new AbortController();
    controller.abort();
    await collect((await aborted.selector.select(facts))!, controller.signal);
    expect(aborted.calls).toEqual(["link", "preflight", "authority", "admission", "driver"]);
  });

  test("linearizes an authoritative completion before a concurrent/later Stop", async () => {
    const controller = new AbortController();
    // This models the canonical lifecycle write completing first; an ordinary
    // Stop that follows sees the completed Task and is idempotent rather than
    // aborting the Job or relabelling the TaskRun as cancelled.
    const harness = build({ onComplete: () => controller.abort() });
    await collect((await harness.selector.select(facts))!, controller.signal);
    expect(harness.calls.filter((entry) => entry === "complete")).toHaveLength(1);
    expect(harness.calls).not.toContain("fail");
    expect(harness.calls).toEqual([
      "link", "preflight", "authority", "admission", "driver", "complete",
    ]);
  });

  test("rehydrates the selected profile before strict authority and normalizes failures", async () => {
    const harness = build({ preflightError: true });
    expect(await rejected(collect((await harness.selector.select(facts))!))).toMatchObject({
      code: "CODEX_EXECUTION_FAILED",
    } satisfies Partial<CodexHarnessAdmissionFailure>);
    expect(harness.calls).toEqual(["link", "preflight", "fail"]);
  });

  test("normalizes an authority failure to the stable Codex execution error", async () => {
    const harness = build({ authorityError: true });
    expect(await rejected(collect((await harness.selector.select(facts))!))).toMatchObject({
      code: "CODEX_EXECUTION_FAILED",
    } satisfies Partial<CodexHarnessAdmissionFailure>);
    expect(harness.calls).toEqual(["link", "preflight", "authority", "fail"]);
  });

  test("persists an explicit working-directory rejection as a retryable workspace failure", async () => {
    const error = Object.assign(new Error("private host path must not escape"), {
      code: "CODEX_WORKSPACE_UNAVAILABLE",
    });
    const harness = build({ driverError: error });
    expect(await rejected(collect((await harness.selector.select(facts))!))).toMatchObject({
      code: "CODEX_WORKSPACE_UNAVAILABLE",
    } satisfies Partial<CodexHarnessAdmissionFailure>);
    expect(harness.failure()).toMatchObject({ code: "CODEX_WORKSPACE_UNAVAILABLE" });
  });

  test("fails a linked run when the driver ends without a terminal, never treating it as success", async () => {
    const harness = build({ outputs: [] });
    expect(await rejected(collect((await harness.selector.select(facts))!))).toMatchObject({
      code: "CODEX_EXECUTION_FAILED",
    });
    expect(harness.calls.filter((entry) => entry === "fail")).toHaveLength(1);
    expect(harness.calls).not.toContain("complete");
  });

  test("streams provisional deltas while retaining authoritative completion and dropping terminals", async () => {
    const assistant = assistantCompleted();
    const delta = {
      ...assistant,
      kind: "output_delta",
      text: "preview",
    } as HarnessExecutionOutput;
    const harness = build({ outputs: [delta, assistant, terminal("completed")] });
    await collect((await harness.selector.select(facts))!);
    expect(harness.calls).not.toContain("project:assistant_completed");
    expect(harness.calls).toContain("project:output_delta");
    expect(harness.calls).not.toContain("project:terminal");
    expect(harness.completion()?.resultText).toBe("Authoritative answer");
  });

  test("fails closed on an empty/missing result or conflicting second completion", async () => {
    for (const outputs of [
      [terminal("completed")],
      [assistantCompleted({ text: "   " }), terminal("completed")],
      [assistantCompleted(), assistantCompleted({ text: "different" }), terminal("completed")],
    ]) {
      const harness = build({ outputs });
      expect(await rejected(collect((await harness.selector.select(facts))!))).toMatchObject({
        code: "CODEX_EXECUTION_FAILED",
      });
      expect(harness.calls).not.toContain("complete");
      expect(harness.calls.filter((entry) => entry === "fail")).toHaveLength(1);
    }
  });

  test("accepts an exact duplicate completion idempotently", async () => {
    const assistant = assistantCompleted();
    const harness = build({ outputs: [assistant, { ...assistant }, terminal("completed")] });
    await collect((await harness.selector.select(facts))!);
    expect(harness.calls.filter((entry) => entry === "complete")).toHaveLength(1);
    expect(harness.completion()).toMatchObject({ resultText: "Authoritative answer" });
  });
});
