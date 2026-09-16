import { describe, expect, test } from "bun:test";
import type {
  HarnessExecutionOutput,
  TaskExecutionRouteFacts,
} from "@nautilo/runtime";
import type { ClaudeExecutionAdmission } from "../../src/claude/connection-controller";
import type { ClaudeHarnessExecutionAdmission } from "../../src/claude/harness-execution";
import {
  CLAUDE_EXECUTION_FAILED,
  ClaudeTaskExecutionRouteFailure,
  ClaudeTaskExecutionRouteSelector,
  createClaudeTaskHarnessExecutionRouteRegistration,
  parseClaudeTaskExecutionMetadata,
  type ClaudeTaskExecutionRouteDeps,
  type ClaudeTaskExecutionRouteTask,
} from "../../src/claude/task-execution-route";

const OWNER = "11111111-1111-4111-8111-111111111111";
const AGENT = "22222222-2222-4222-8222-222222222222";
const TASK = "33333333-3333-4333-8333-333333333333";
const RUN = "44444444-4444-4444-8444-444444444444";
const JOB = "55555555-5555-4555-8555-555555555555";
const ROOM = "66666666-6666-4666-8666-666666666666";

const facts: TaskExecutionRouteFacts = {
  taskId: TASK,
  taskRunId: RUN,
  parentTaskId: null,
  ownerId: OWNER,
  requestorId: OWNER,
  agentId: AGENT,
  roomId: ROOM,
  laneKey: "room:claude",
  graphThreadId: "room:claude:agent",
};

const scope = Object.freeze({
  relayId: "relay-1",
  relaySessionId: "relay-session-1",
  desktopSessionId: "desktop-session-1",
  pairingGenerationRef: "pairing-1",
  selectedProtocolVersion: 18,
  capabilityRevision: 3,
});

const admission: ClaudeExecutionAdmission = Object.freeze({
  profileRef: "profile-1",
  catalogModelId: "claude-sonnet",
  selectedModel: "claude-sonnet-4",
  scope,
});

const metadata = Object.freeze({
  execution: Object.freeze({
    version: 1 as const,
    harnessId: "claude-code" as const,
    source: "genie" as const,
    profileRef: admission.profileRef,
    catalogModelId: admission.catalogModelId,
    selectedModel: admission.selectedModel,
  }),
});

function task(overrides: Partial<ClaudeTaskExecutionRouteTask> = {}): ClaudeTaskExecutionRouteTask {
  return {
    id: TASK,
    ownerId: OWNER,
    requestorId: OWNER,
    agentId: AGENT,
    parentTaskId: null,
    callingRoomId: ROOM,
    targetRoomId: ROOM,
    prompt: "Summarize the conversation.",
    metadata,
    ...overrides,
  };
}

function progress(): Extract<HarnessExecutionOutput, { readonly kind: "progress" }> {
  return {
    kind: "progress",
    attribution: attribution(),
    message: "Claude Code activity",
  };
}

function delta(text = "provisional"): Extract<HarnessExecutionOutput, { readonly kind: "output_delta" }> {
  return { kind: "output_delta", attribution: attribution(), text };
}

function assistant(
  overrides: Partial<Extract<HarnessExecutionOutput, { readonly kind: "assistant_completed" }>> = {},
): Extract<HarnessExecutionOutput, { readonly kind: "assistant_completed" }> {
  return { kind: "assistant_completed", attribution: attribution(), text: "Authoritative answer", ...overrides };
}

function terminal(status: "completed" | "failed" | "interrupted"): Extract<HarnessExecutionOutput, { readonly kind: "terminal" }> {
  return { kind: "terminal", attribution: attribution(), status };
}

function attribution() {
  return {
    bindingId: RUN,
    bindingGeneration: JOB,
    taskId: TASK,
    roomId: ROOM,
    vendorSessionId: "execution-1",
    vendorTurnId: null,
    vendorItemId: null,
  };
}

function build(input: {
  task?: ClaudeTaskExecutionRouteTask | null;
  admission?: ClaudeExecutionAdmission | null;
  admitThrows?: boolean;
  outputs?: readonly HarnessExecutionOutput[];
  projector?: ClaudeTaskExecutionRouteDeps["outputProjection"];
} = {}) {
  const calls: string[] = [];
  const controllerCalls: unknown[] = [];
  const lifecycle: { link: unknown[]; complete: unknown[]; fail: unknown[] } = { link: [], complete: [], fail: [] };
  const projections: unknown[] = [];
  let received: ClaudeHarnessExecutionAdmission | null = null;
  const execution: ClaudeTaskExecutionRouteDeps["execution"] = {
    async *start(nextAdmission) {
      received = nextAdmission;
      calls.push("start");
      for (const output of input.outputs ?? [assistant(), terminal("completed")]) yield output;
    },
  };
  const deps: ClaudeTaskExecutionRouteDeps = {
    tasks: { getTask: async () => input.task === undefined ? task() : input.task },
    controller: {
      admitExecution: async (ownerId, selection) => {
        calls.push("admit");
        controllerCalls.push({ ownerId, selection });
        if (input.admitThrows) throw new Error("private controller state");
        return input.admission === undefined ? admission : input.admission;
      },
    },
    execution,
    taskRuns: {
      linkJob: async (value) => { calls.push("link"); lifecycle.link.push(value); },
      complete: async (value) => { calls.push("complete"); lifecycle.complete.push(value); },
      fail: async (value) => { calls.push("fail"); lifecycle.fail.push(value); },
    },
    outputProjection: input.projector ?? {
      project: async (output, context) => { calls.push(`project:${output.kind}`); projections.push(context); return null; },
    },
  };
  return {
    selector: new ClaudeTaskExecutionRouteSelector(deps), calls, controllerCalls, lifecycle, projections,
    received: () => received,
  };
}

async function collect(
  route: NonNullable<Awaited<ReturnType<ClaudeTaskExecutionRouteSelector["select"]>>>,
  signal = new AbortController().signal,
) {
  const events = [];
  for await (const event of route.executor({ taskId: TASK, taskRunId: RUN }, JOB, facts.laneKey, signal)) events.push(event);
  return events;
}

async function rejected(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
    throw new Error("expected rejection");
  } catch (error) {
    return error;
  }
}

function deferred<T>() {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((nextResolve) => { resolve = nextResolve; });
  return { promise, resolve };
}

function flush(): Promise<void> {
  return new Promise((resolve) => queueMicrotask(resolve));
}

describe("ClaudeTaskExecutionRouteSelector", () => {
  test("parses only the exact six-field creator metadata", () => {
    expect(parseClaudeTaskExecutionMetadata(metadata)).toEqual(metadata);
    for (const value of [
      {},
      { execution: { ...metadata.execution, source: "room" } },
      { execution: { ...metadata.execution, harnessId: "codex" } },
      { execution: { ...metadata.execution, extra: true } },
      { execution: { ...metadata.execution, selectedModel: "" } },
    ]) expect(parseClaudeTaskExecutionMetadata(value)).toBeNull();
  });

  test("selects the exact root Task once and carries scope only into the executor", async () => {
    const fixture = build({ outputs: [progress(), delta(), assistant(), terminal("completed")] });
    const route = await fixture.selector.select(facts);
    expect(route).toMatchObject({ coalescing: "separate", contention: "serialize", modelAttribution: "external" });
    expect(fixture.calls).toEqual(["admit"]);
    expect(fixture.controllerCalls).toEqual([{
      ownerId: OWNER,
      selection: { profileRef: "profile-1", catalogModelId: "claude-sonnet", selectedModel: "claude-sonnet-4" },
    }]);
    await collect(route!);
    expect(fixture.calls).toEqual(["admit", "link", "start", "project:progress", "project:output_delta", "complete"]);
    expect(fixture.received()).toMatchObject({
      taskId: TASK, taskRunId: RUN, jobId: JOB, ownerId: OWNER, requesterId: OWNER, roomId: ROOM,
      claude: { profileRef: "profile-1", catalogModelId: "claude-sonnet", selectedModel: "claude-sonnet-4", scope },
    });
    expect(fixture.lifecycle.complete).toEqual([expect.objectContaining({ resultText: "Authoritative answer", jobId: JOB })]);
    expect(fixture.lifecycle.link[0]).not.toHaveProperty("scope");
    expect(fixture.projections).toEqual([
      { jobId: JOB, laneKey: facts.laneKey, facts },
      { jobId: JOB, laneKey: facts.laneKey, facts },
    ]);
    expect(JSON.stringify(metadata)).not.toContain("relay");
  });

  test("keeps response deltas ephemeral and leaves the final candidate authoritative", async () => {
    const fixture = build({ outputs: [delta("draft"), assistant({ text: "authoritative" }), terminal("completed")] });
    const route = await fixture.selector.select(facts);
    expect(await collect(route!)).toEqual([]);
    expect(fixture.calls).toEqual(["admit", "link", "start", "project:output_delta", "complete"]);
    expect(fixture.lifecycle.complete).toEqual([expect.objectContaining({ resultText: "authoritative" })]);
  });

  test("fails selection before an executor for mismatched root facts or controller admission", async () => {
    for (const fixture of [
      build({ task: task({ requestorId: "other" }) }),
      build({ task: task({ callingRoomId: "other" }) }),
      build({ task: task({ parentTaskId: TASK }) }),
      build({ admission: null }),
      build({ admission: { ...admission, selectedModel: "other" } }),
      build({ admitThrows: true }),
    ]) {
      const error = await rejected(Promise.resolve(fixture.selector.select(facts)));
      expect(error).toBeInstanceOf(ClaudeTaskExecutionRouteFailure);
      expect(error).toMatchObject({ code: CLAUDE_EXECUTION_FAILED });
      expect(fixture.calls).not.toContain("start");
      expect(fixture.lifecycle.link).toEqual([]);
    }
  });

  test("registers one selector instance and preserves only the reviewed failure", async () => {
    let creates = 0;
    const registration = createClaudeTaskHarnessExecutionRouteRegistration(() => {
      creates += 1;
      return async () => { throw new ClaudeTaskExecutionRouteFailure(); };
    });
    const provider = registration.createSelector();
    const input = { facts, descriptor: { version: 1 as const, harnessId: "claude-code", source: "genie" as const } };
    for (let index = 0; index < 2; index += 1) {
      const error = await rejected(Promise.resolve(provider.select(input)));
      expect(error).toMatchObject({ code: CLAUDE_EXECUTION_FAILED, message: CLAUDE_EXECUTION_FAILED });
    }
    expect(creates).toBe(1);
    expect(registration.publicFailureCodes).toEqual([CLAUDE_EXECUTION_FAILED]);
  });

  test("fails exactly once for malformed execution terminals and candidates", async () => {
    for (const outputs of [
      [terminal("completed")],
      [assistant({ attribution: { ...attribution(), bindingGeneration: "wrong-job" } }), terminal("completed")],
      [assistant(), assistant(), terminal("completed")],
      [terminal("failed")],
      [],
    ]) {
      const fixture = build({ outputs });
      const route = await fixture.selector.select(facts);
      const error = await rejected(collect(route!));
      expect(error).toMatchObject({ code: CLAUDE_EXECUTION_FAILED });
      expect(fixture.lifecycle.complete).toEqual([]);
      expect(fixture.lifecycle.fail).toHaveLength(1);
      expect(fixture.lifecycle.fail[0]).toMatchObject({ jobId: JOB, code: CLAUDE_EXECUTION_FAILED });
    }
  });

  test("lets ordinary Stop own an aborted interrupted execution", async () => {
    const controller = new AbortController();
    const fixture = build({ outputs: [terminal("interrupted")] });
    const route = await fixture.selector.select(facts);
    controller.abort();
    await collect(route!, controller.signal);
    expect(fixture.calls).toEqual(["admit", "link"]);
    expect(fixture.lifecycle.fail).toEqual([]);
  });

  test("fails projection errors but aborting during projection yields nothing and does not fail", async () => {
    const failing = build({
      outputs: [progress()],
      projector: { project: async () => { throw new Error("private projection failure"); } },
    });
    expect(await rejected(collect((await failing.selector.select(facts))!))).toMatchObject({ code: CLAUDE_EXECUTION_FAILED });
    expect(failing.lifecycle.fail).toHaveLength(1);

    const controller = new AbortController();
    const pending = deferred<null>();
    const aborted = build({ outputs: [progress()], projector: { project: async () => pending.promise } });
    const running = collect((await aborted.selector.select(facts))!, controller.signal);
    await flush();
    controller.abort();
    pending.resolve(null);
    expect(await running).toEqual([]);
    expect(aborted.lifecycle.fail).toEqual([]);
  });
});
