import { describe, expect, test } from "bun:test";
import { compileFunction } from "node:vm";
import type {
  HarnessExecutionOutput,
  HarnessRequestResponse,
  InMemoryRelayRegistry,
} from "@nautilo/runtime";
import type {
  RelayClaudeExecutionEvent,
  RelayClaudeExecutionResponse,
  RelayClaudeExecutionSocketScope,
} from "@nautilo/relay";
import { parseRelayClaudeExecutionCommand } from "@nautilo/relay";
import { createAcceptedInvocationAuthority } from "@nautilo/trust";
import {
  ClaudeHarnessExecution,
  type ClaudeHarnessExecutionAdmission,
} from "../../src/claude/harness-execution";

const ownerId = "8a60683a-dfea-4e19-ae53-e8a2a7af4abf";
const taskId = "73a71657-f6c4-4491-a887-4667e5e1e29d";
const taskRunId = "f9b74932-fcec-423f-aa0d-270dc51cf760";
const jobId = "ec2e3ad7-21d5-4cdf-bab0-209704909f03";
const roomId = "f4e13a55-7ab1-4c58-b87a-4ef7c1f5f230";
const interactionRef = "3e809a69-6b28-43d1-9c49-7efdd04b6e40";
const questionRef = "f9f76001-4f8d-46de-bc6e-1a949b5c42b8";
const optionA = "6e2d77bd-c0c5-424a-b00f-fafcbf2b5a64";
const optionB = "78dcaed6-bb21-4e70-83b8-1d54a9d365da";

const scope: RelayClaudeExecutionSocketScope = Object.freeze({
  relayId: "relay-1",
  relaySessionId: "session-1",
  desktopSessionId: "desktop-1",
  pairingGenerationRef: "pair-1",
  selectedProtocolVersion: 18,
  capabilityRevision: 4,
});

type OpenResult = ReturnType<Pick<InMemoryRelayRegistry, "openClaudeExecution">["openClaudeExecution"]>;

function deferred<T>() {
  let resolve: (value: T) => void = () => undefined;
  let reject: (reason?: unknown) => void = () => undefined;
  const promise = new Promise<T>((nextResolve, nextReject) => { resolve = nextResolve; reject = nextReject; });
  return { promise, resolve, reject };
}

function flush(): Promise<void> {
  return new Promise((resolve) => queueMicrotask(resolve));
}

async function expectFailure(promise: Promise<unknown>, message: string): Promise<void> {
  let failureMessage = "";
  try { await promise; } catch (error) { failureMessage = error instanceof Error ? error.message : ""; }
  expect(failureMessage).toContain(message);
}

function controlledControl() {
  const queued: RelayClaudeExecutionEvent[] = [];
  const interrupt = deferred<"acknowledged" | "uncertain">();
  const response = deferred<"accepted" | "rejected">();
  const steer = deferred<"accepted">();
  let nextWaiter: ReturnType<typeof deferred<RelayClaudeExecutionEvent | null>> | null = null;
  let closed = false;
  const responses: { interactionRef: string; response: RelayClaudeExecutionResponse }[] = [];
  const steers: string[] = [];
  let steering = false;
  let interrupts = 0;
  const control = Object.freeze({
    executionRef: "44a02889-e6fb-4683-977d-032dc74ea65d",
    next: () => {
      const event = queued.shift();
      if (event !== undefined) return Promise.resolve(event);
      if (closed) return Promise.resolve(null);
      if (nextWaiter !== null) return Promise.reject(new Error("next already pending"));
      nextWaiter = deferred<RelayClaudeExecutionEvent | null>();
      return nextWaiter.promise;
    },
    respond: (nextInteractionRef: string, nextResponse: RelayClaudeExecutionResponse) => {
      responses.push({ interactionRef: nextInteractionRef, response: nextResponse });
      return response.promise;
    },
    steer: (text: string) => {
      steers.push(text);
      if (steering) return Promise.reject(new Error("CLAUDE_EXECUTION_STEER_PENDING"));
      steering = true;
      return steer.promise.finally(() => { steering = false; });
    },
    interrupt: () => { interrupts += 1; return interrupt.promise; },
  });
  return {
    control,
    responses,
    steers,
    get interrupts() { return interrupts; },
    emit(event: RelayClaudeExecutionEvent) {
      const waiter = nextWaiter;
      if (waiter !== null) { nextWaiter = null; waiter.resolve(event); }
      else queued.push(event);
    },
    close() {
      closed = true;
      const waiter = nextWaiter;
      if (waiter !== null) { nextWaiter = null; waiter.resolve(null); }
    },
    failNext(error = new Error("lost")) {
      const waiter = nextWaiter;
      if (waiter !== null) { nextWaiter = null; waiter.reject(error); }
    },
    acknowledge() { interrupt.resolve("acknowledged"); },
    uncertain() { interrupt.resolve("uncertain"); },
    rejectInterrupt() { interrupt.reject(new Error("interrupt failed")); },
    acceptResponse() { response.resolve("accepted"); },
    rejectResponse() { response.resolve("rejected"); },
    acceptSteer() { steer.resolve("accepted"); },
    rejectSteer() { steer.reject(new Error("steer rejected")); },
  };
}

function admission(overrides: Partial<ClaudeHarnessExecutionAdmission> = {}): ClaudeHarnessExecutionAdmission {
  return {
    jobId,
    taskId,
    taskRunId,
    ownerId,
    requesterId: ownerId,
    roomId,
    laneKey: "lane-1",
    source: "room",
    parentTaskId: null,
    prompt: "Summarize the discussion.",
    abortSignal: new AbortController().signal,
    claude: { profileRef: "profile-1", catalogModelId: "claude-sonnet", selectedModel: "claude-sonnet-4", scope },
    ...overrides,
  };
}

function fixture(result?: OpenResult | (() => OpenResult)) {
  const fake = controlledControl();
  const opens: unknown[] = [];
  const relay: Pick<InMemoryRelayRegistry, "openClaudeExecution"> = {
    openClaudeExecution(input) {
      opens.push(input);
      return typeof result === "function" ? result() : result ?? Object.freeze({ ok: true as const, control: fake.control });
    },
  };
  return { fake, opens, execution: new ClaudeHarnessExecution({ relay }) };
}

// Execute the actual composition closures, not a handwritten copy of their
// ordering. Only external lifecycle effects and HTTP registration are injected;
// this is not a full server/auth/database integration test. Source drift must
// break extraction explicitly so a refactor cannot silently test old wiring.
async function composedStop(execution: ClaudeHarnessExecution) {
  const appSource = await Bun.file(new URL("../../src/app.ts", import.meta.url)).text();
  const routeSource = await Bun.file(new URL("../../src/routes/tasks.ts", import.meta.url)).text();
  const appStart = appSource.indexOf("  const prepareHarnessStop =");
  const appEnd = appSource.indexOf("  setTaskToolRuntime({", appStart);
  const routeStart = routeSource.indexOf('  app.post<{ Params: { id: string } }>("/api/tasks/:id/stop"');
  const routeEnd = routeSource.indexOf("\n  );", routeStart);
  expect(appStart).toBeGreaterThan(-1);
  expect(appEnd).toBeGreaterThan(appStart);
  expect(routeStart).toBeGreaterThan(-1);
  expect(routeEnd).toBeGreaterThan(routeStart);
  const cancelled: string[] = [];
  const lifecycle = Object.freeze({ synthetic: true });
  const cancel = (deps: unknown, id: string) => {
    expect(deps).toBe(lifecycle);
    cancelled.push(id);
    return Promise.resolve("canonical cancellation reached");
  };
  let httpStop: ((request: { params: { id: string } }, reply: unknown) => Promise<unknown>) | undefined;
  const body = new Bun.Transpiler({ loader: "ts" }).transformSync(`
    const { claudeHarnessExecution, codexHarnessExecution, runtimeStopTask, taskLifecycleDeps, app, runLifecycle, getServerDirectDb, jobManager, stopTask } = ports;
    ${appSource.slice(appStart, appEnd)}
    const deps = { prepareStopTask: prepareHarnessStop, observer: null };
    ${routeSource.slice(routeStart, routeEnd + "\n  );".length)}
    return stopTaskForAgentTool;
  `);
  const build = compileFunction(body, ["ports"]) as (ports: Record<string, unknown>) => (id: string) => Promise<unknown>;
  const toolStop = build({
    claudeHarnessExecution: execution,
    codexHarnessExecution: { stopActiveTask: async () => false },
    runtimeStopTask: cancel,
    taskLifecycleDeps: () => lifecycle,
    app: { post: (path: string, handler: typeof httpStop) => { expect(path).toBe("/api/tasks/:id/stop"); httpStop = handler; } },
    runLifecycle: (_request: unknown, _reply: unknown, operation: () => Promise<unknown>) => operation(),
    getServerDirectDb: () => null,
    jobManager: null,
    stopTask: (_deps: unknown, id: string) => cancel(lifecycle, id),
  });
  if (httpStop === undefined) throw new Error("actual Stop route was not registered");
  const handler = httpStop;
  return { cancelled, tool: toolStop, http: (id: string) => handler({ params: { id } }, {}) };
}

async function next(iterator: AsyncIterator<HarnessExecutionOutput>): Promise<HarnessExecutionOutput> {
  const item = await iterator.next();
  if (item.done) throw new Error("unexpected end");
  return item.value;
}

async function begin(fx: ReturnType<typeof fixture>, input = admission()) {
  const iterator = fx.execution.start(input)[Symbol.asyncIterator]();
  const pending = next(iterator);
  fx.fake.emit({ kind: "started" });
  await flush();
  return { iterator, pending };
}

function permission() {
  return {
    kind: "interaction" as const,
    interaction: { kind: "permission" as const, interactionRef, toolName: "Read", allowSession: false as const, detail: { state: "shown" as const, text: "Read\n/workspace/example.txt" } },
  };
}

function question(multiSelect = false) {
  return {
    kind: "interaction" as const,
    interaction: {
      kind: "question" as const,
      interactionRef,
      questions: [{
        questionRef,
        header: "Choose",
        text: "Which option?",
        multiSelect,
        allowOther: true as const,
        options: [
          { optionRef: optionA, label: "A", description: "First" },
          { optionRef: optionB, label: "B", description: "Second" },
        ],
      }],
    },
  };
}

describe("ClaudeHarnessExecution", () => {
  test("admits Stop before started, invalidates parked requests, and permits a healthy successor", async () => {
    const first = controlledControl();
    const second = controlledControl();
    let opens = 0;
    const fx = fixture(() => ({ ok: true, control: ++opens === 1 ? first.control : second.control }));
    const iterator = fx.execution.start(admission())[Symbol.asyncIterator]();
    const pending = next(iterator);
    expect(await fx.execution.stopActiveTask(taskId)).toBe(true);
    expect(first.interrupts).toBe(1);
    first.emit({ kind: "started" });
    first.emit(permission());
    await flush(); await flush();
    expect(fx.execution.hasLiveRequest(interactionRef, ownerId)).toBe(false);
    first.uncertain(); first.close();
    expect(await pending).toMatchObject({ kind: "terminal", status: "failed", code: "process_lost" });
    await iterator.next();
    expect(await fx.execution.stopActiveTask(taskId)).toBe(false);

    const successor = fx.execution.start(admission())[Symbol.asyncIterator]();
    const result = next(successor);
    second.emit({ kind: "started" });
    second.emit({ kind: "output_delta", text: "done" });
    await result;
    const completed = next(successor);
    second.emit({ kind: "result", outcome: "success", text: null });
    second.emit({ kind: "settled", outcome: "eof" });
    expect(await completed).toMatchObject({ kind: "assistant_completed" });
    expect(await next(successor)).toMatchObject({ kind: "terminal", status: "completed" });
    await successor.next();
    expect(await fx.execution.stopActiveTask(taskId)).toBe(false);
    expect(second.interrupts).toBe(0);
  });

  test("Stop immediately revokes an existing parked Human decision", async () => {
    const fx = fixture();
    const active = await begin(fx);
    fx.fake.emit(permission()); await active.pending;
    expect(fx.execution.hasLiveRequest(interactionRef, ownerId)).toBe(true);
    expect(await fx.execution.stopActiveTask(taskId)).toBe(true);
    expect(fx.execution.hasLiveRequest(interactionRef, ownerId)).toBe(false);
    await expectFailure(fx.execution.respond({ kind: "permission_selection_required", requestId: interactionRef, ownerId, outcome: { kind: "selected", optionId: "allow_once" } }, createAcceptedInvocationAuthority(ownerId)), "unavailable");
    expect(fx.fake.responses).toEqual([]);
    fx.fake.uncertain(); fx.fake.close();
    await active.iterator.next(); await active.iterator.next();
  });

  for (const entry of ["tool", "http"] as const) {
    test(`uncertain Claude containment does not prevent canonical ${entry} cancellation`, async () => {
      const fx = fixture();
      const composed = await composedStop(fx.execution);
      const active = await begin(fx);
      try {
        const stopping = composed[entry](taskId);
        fx.fake.uncertain();
        expect(await stopping).toBe("canonical cancellation reached");
        expect(composed.cancelled).toEqual([taskId]);
      } finally {
        fx.fake.close(); await active.pending; await active.iterator.next();
      }
    });

    test(`canonical ${entry} cancellation does not wait for missing provider terminal`, async () => {
      const fx = fixture();
      const composed = await composedStop(fx.execution);
      const active = await begin(fx);
      try {
        let resolved = false;
        const stopping = composed[entry](taskId).then((value) => { resolved = true; return value; });
        fx.fake.acknowledge();
        await flush(); await flush();
        expect(fx.fake.interrupts).toBe(1);
        // Withhold provider terminal facts; cancellation must still resolve.
        expect(await stopping).toBe("canonical cancellation reached");
        expect(resolved).toBe(true);
        expect(composed.cancelled).toEqual([taskId]);
        fx.fake.emit({ kind: "result", outcome: "interrupted", text: null });
        fx.fake.emit({ kind: "settled", outcome: "rejected" });
        expect(await stopping).toBe("canonical cancellation reached");
        expect(composed.cancelled).toEqual([taskId]);
        expect(await active.pending).toMatchObject({ kind: "terminal", status: "interrupted" });
      } finally {
        fx.fake.close(); await active.pending; await active.iterator.next();
      }
    });

    test(`composition reaches ${entry} cancellation normally when Claude has no active task`, async () => {
      const composed = await composedStop(fixture().execution);
      expect(await composed[entry](taskId)).toBe("canonical cancellation reached");
      expect(composed.cancelled).toEqual([taskId]);
    });
  }

  test("steers only the exact live admitted task and surfaces an active provider rejection", async () => {
    const inactive = fixture();
    expect(await inactive.execution.steerActiveTask({
      taskId, ownerId, roomId, profileRef: "profile-1", catalogModelId: "claude-sonnet", selectedModel: "claude-sonnet-4", text: "Change direction",
    })).toBe(false);

    const fx = fixture();
    const active = await begin(fx);
    const steering = fx.execution.steerActiveTask({
      taskId, ownerId, roomId, profileRef: "profile-1", catalogModelId: "claude-sonnet", selectedModel: "claude-sonnet-4", text: "Change direction",
    });
    expect(fx.fake.steers).toEqual(["Change direction"]);
    await expectFailure(fx.execution.steerActiveTask({
      taskId, ownerId, roomId, profileRef: "profile-1", catalogModelId: "claude-sonnet", selectedModel: "claude-sonnet-4", text: "Concurrent",
    }), "CLAUDE_EXECUTION_STEER_PENDING");
    fx.fake.acceptSteer();
    expect(await steering).toBe(true);
    expect(await fx.execution.steerActiveTask({
      taskId, ownerId, roomId, profileRef: "profile-1", catalogModelId: "claude-sonnet", selectedModel: "drifted", text: "Change direction",
    })).toBe(false);
    fx.fake.emit({ kind: "output_delta", text: "redirected" });
    expect(await active.pending).toMatchObject({
      kind: "output_delta", text: "redirected", attribution: { taskId, roomId, vendorSessionId: fx.fake.control.executionRef },
    });
    const completed = next(active.iterator);
    fx.fake.emit({ kind: "result", outcome: "success", text: null });
    fx.fake.emit({ kind: "settled", outcome: "eof" });
    expect(await completed).toMatchObject({ kind: "assistant_completed", text: "redirected" });
    expect(await next(active.iterator)).toMatchObject({ kind: "terminal", status: "completed" });

    const providerFailure = fixture();
    await begin(providerFailure);
    const rejected = providerFailure.execution.steerActiveTask({
      taskId, ownerId, roomId, profileRef: "profile-1", catalogModelId: "claude-sonnet", selectedModel: "claude-sonnet-4", text: "Reject",
    });
    providerFailure.fake.rejectSteer();
    await expectFailure(rejected, "steer rejected");
  });

  test("returns accepted delivery even after the Task's completed stream has retired", async () => {
    const fx = fixture();
    const active = await begin(fx);
    const steering = fx.execution.steerActiveTask({
      taskId, ownerId, roomId, profileRef: "profile-1", catalogModelId: "claude-sonnet", selectedModel: "claude-sonnet-4", text: "Redirect",
    });
    fx.fake.emit({ kind: "output_delta", text: "done" }); await active.pending;
    const completed = next(active.iterator);
    fx.fake.emit({ kind: "result", outcome: "success", text: null });
    fx.fake.emit({ kind: "settled", outcome: "eof" });
    expect(await completed).toMatchObject({ kind: "assistant_completed" });
    expect(await next(active.iterator)).toMatchObject({ kind: "terminal", status: "completed" });
    await active.iterator.next();
    fx.fake.acceptSteer();
    expect(await steering).toBe(true);
  });

  test("returns false after result or Stop, and when a rejected steer races terminal retirement", async () => {
    const afterResult = fixture();
    const resultActive = await begin(afterResult);
    afterResult.fake.emit({ kind: "result", outcome: "failed", text: null });
    await flush();
    expect(await afterResult.execution.steerActiveTask({
      taskId, ownerId, roomId, profileRef: "profile-1", catalogModelId: "claude-sonnet", selectedModel: "claude-sonnet-4", text: "Late",
    })).toBe(false);
    afterResult.fake.emit({ kind: "settled", outcome: "eof" });
    await resultActive.pending;

    const stopping = fixture();
    await begin(stopping);
    void stopping.execution.stopActiveTask(taskId).catch(() => undefined);
    expect(await stopping.execution.steerActiveTask({
      taskId, ownerId, roomId, profileRef: "profile-1", catalogModelId: "claude-sonnet", selectedModel: "claude-sonnet-4", text: "Stopped",
    })).toBe(false);

    const raced = fixture();
    const raceActive = await begin(raced);
    const pendingSteer = raced.execution.steerActiveTask({
      taskId, ownerId, roomId, profileRef: "profile-1", catalogModelId: "claude-sonnet", selectedModel: "claude-sonnet-4", text: "Race",
    });
    raced.fake.emit({ kind: "result", outcome: "failed", text: null });
    await flush();
    raced.fake.emit({ kind: "settled", outcome: "eof" });
    await raceActive.pending;
    raced.fake.rejectSteer();
    expect(await pendingSteer).toBe(false);
  });
  test("opens exactly once with the admitted scope and emits truthful attribution", async () => {
    const fx = fixture();
    const { pending } = await begin(fx);
    expect(fx.opens).toEqual([{
      relayId: scope.relayId, userId: ownerId, prompt: "Summarize the discussion.", model: "claude-sonnet-4", expectedScope: scope,
    }]);
    fx.fake.emit({ kind: "activity", activity: "tool", state: "progress", toolName: "Read" });
    expect(await pending).toMatchObject({
      kind: "progress",
      message: "Claude Code activity",
      attribution: { bindingId: taskRunId, bindingGeneration: jobId, taskId, roomId, vendorSessionId: fx.fake.control.executionRef, vendorTurnId: null },
    });
  });

  test("maps initialized as display-only progress and holds success until eof", async () => {
    const fx = fixture();
    const { iterator, pending } = await begin(fx);
    fx.fake.emit({ kind: "initialized", claudeCodeVersion: "2.1.235", servingModel: "different-display-model" });
    expect(await pending).toMatchObject({ kind: "progress", message: "Claude Code initialized" });
    const delta = next(iterator);
    fx.fake.emit({ kind: "output_delta", text: "Authoritative answer" });
    expect(await delta).toMatchObject({ kind: "output_delta", text: "Authoritative answer" });
    const candidate = next(iterator);
    fx.fake.emit({ kind: "result", outcome: "success", text: null });
    expect(await Promise.race([candidate.then(() => "done"), flush().then(() => "pending")])).toBe("pending");
    fx.fake.emit({ kind: "settled", outcome: "eof" });
    expect(await candidate).toMatchObject({ kind: "assistant_completed", text: "Authoritative answer" });
    expect(await next(iterator)).toMatchObject({ kind: "terminal", status: "completed" });
  });

  test("maps ordered Claude response deltas to ephemeral output with stable attribution", async () => {
    const fx = fixture();
    const { iterator, pending } = await begin(fx);
    fx.fake.emit({ kind: "output_delta", text: "Hello " });
    expect(await pending).toMatchObject({
      kind: "output_delta",
      text: "Hello ",
      attribution: {
        bindingId: taskRunId,
        bindingGeneration: jobId,
        taskId,
        roomId,
        vendorSessionId: fx.fake.control.executionRef,
        vendorTurnId: null,
        vendorItemId: null,
      },
    });
    const second = next(iterator);
    fx.fake.emit({ kind: "output_delta", text: "world" });
    expect(await second).toMatchObject({ kind: "output_delta", text: "world" });
  });

  test("reconstructs a completed response larger than one result frame without truncation", async () => {
    const fx = fixture();
    const { iterator, pending } = await begin(fx);
    const firstText = "a".repeat(48 * 1024);
    const secondText = "b".repeat(20 * 1024);
    fx.fake.emit({ kind: "output_delta", text: firstText });
    expect(await pending).toMatchObject({ kind: "output_delta", text: firstText });
    const second = next(iterator);
    fx.fake.emit({ kind: "output_delta", text: secondText });
    expect(await second).toMatchObject({ kind: "output_delta", text: secondText });
    const completed = next(iterator);
    fx.fake.emit({ kind: "result", outcome: "success", text: null });
    fx.fake.emit({ kind: "settled", outcome: "eof" });
    expect(await completed).toMatchObject({ kind: "assistant_completed", text: firstText + secondText });
    expect(await next(iterator)).toMatchObject({ kind: "terminal", status: "completed" });
  });

  test("treats natural result ordering violations as process loss", async () => {
    const afterResult = fixture();
    const first = await begin(afterResult);
    afterResult.fake.emit({ kind: "result", outcome: "success", text: null });
    afterResult.fake.emit({ kind: "output_delta", text: "late" });
    expect(await first.pending).toMatchObject({ kind: "terminal", status: "failed", code: "process_lost" });
    expect(await first.iterator.next()).toMatchObject({ done: true });

    const beforeResult = fixture();
    const second = await begin(beforeResult);
    beforeResult.fake.emit({ kind: "settled", outcome: "eof" });
    expect(await second.pending).toMatchObject({ kind: "terminal", status: "failed", code: "process_lost" });
    beforeResult.fake.emit({ kind: "result", outcome: "success", text: null });
    expect(await second.iterator.next()).toMatchObject({ done: true });
  });

  test("maps known open failures and throws without opening a stream", async () => {
    for (const [result, code] of [
      [Object.freeze({ ok: false as const, error: "CLAUDE_EXECUTION_INVALID" as const }), "invalid_request"],
      [Object.freeze({ ok: false as const, error: "CLAUDE_EXECUTION_UNAVAILABLE" as const }), "unavailable"],
      [Object.freeze({ ok: false as const, error: "CLAUDE_EXECUTION_CONTEXT_STALE" as const }), "unavailable"],
      [Object.freeze({ ok: false as const, error: "CLAUDE_EXECUTION_BUSY" as const }), "unavailable"],
    ] as const) {
      const fx = fixture(result);
      const iterator = fx.execution.start(admission())[Symbol.asyncIterator]();
      expect(await next(iterator)).toMatchObject({ kind: "terminal", status: "failed", code });
    }
    const fx = fixture(() => { throw new Error("transport"); });
    expect(await next(fx.execution.start(admission())[Symbol.asyncIterator]())).toMatchObject({ kind: "terminal", code: "upstream_failure" });
  });

  test("does not open or fabricate a terminal for a pre-aborted admission", async () => {
    const controller = new AbortController();
    controller.abort();
    const fx = fixture();
    const item = await fx.execution.start(admission({ abortSignal: controller.signal }))[Symbol.asyncIterator]().next();
    expect(item.done).toBe(true);
    expect(fx.opens).toEqual([]);
  });

  test("projects permission choices only through the live accepted request", async () => {
    const fx = fixture();
    const { pending } = await begin(fx);
    fx.fake.emit(permission());
    const request = await pending;
    expect(request).toMatchObject({
      kind: "permission_selection_required", requestId: interactionRef, vendorRequestId: interactionRef,
      options: [{ id: "allow_once" }, { id: "deny" }], tool: { title: "Read", kind: null },
      detail: { state: "shown", text: "Read\n/workspace/example.txt" },
    });
    const authority = createAcceptedInvocationAuthority(ownerId);
    await expectFailure(fx.execution.respond({
      kind: "permission_selection_required", requestId: interactionRef, ownerId, outcome: { kind: "selected", optionId: "approve_for_session" },
    } as HarnessRequestResponse, authority), "invalid");
    const answered = fx.execution.respond({
      kind: "permission_selection_required", requestId: interactionRef, ownerId, outcome: { kind: "selected", optionId: "allow_once" },
    }, authority);
    expect(fx.execution.hasLiveRequest(interactionRef, ownerId)).toBe(false);
    expect(fx.fake.responses).toEqual([{ interactionRef, response: { kind: "allow_once" } }]);
    fx.fake.acceptResponse();
    await answered;
    await expectFailure(fx.execution.respond({
      kind: "permission_selection_required", requestId: interactionRef, ownerId, outcome: { kind: "cancelled" },
    }, authority), "unavailable");
  });

  test("maps deny and cancel to deny, while a rejected response is one-shot", async () => {
    for (const outcome of [
      { kind: "selected" as const, optionId: "deny" },
      { kind: "cancelled" as const },
    ]) {
      const fx = fixture();
      const active = await begin(fx);
      fx.fake.emit(permission());
      await active.pending;
      const response = fx.execution.respond({ kind: "permission_selection_required", requestId: interactionRef, ownerId, outcome }, createAcceptedInvocationAuthority(ownerId));
      expect(fx.fake.responses).toEqual([{ interactionRef, response: { kind: "deny" } }]);
      fx.fake.acceptResponse();
      await response;
    }
    const fx = fixture();
    const active = await begin(fx);
    fx.fake.emit(permission());
    await active.pending;
    const rejected = fx.execution.respond({
      kind: "permission_selection_required", requestId: interactionRef, ownerId, outcome: { kind: "selected", optionId: "allow_once" },
    }, createAcceptedInvocationAuthority(ownerId));
    fx.fake.rejectResponse();
    await expectFailure(rejected, "rejected");
    await expectFailure(fx.execution.respond({
      kind: "permission_selection_required", requestId: interactionRef, ownerId, outcome: { kind: "cancelled" },
    }, createAcceptedInvocationAuthority(ownerId)), "unavailable");
  });

  test("a missing or withheld action cannot be approved through a forged client reply", async () => {
    for (const detail of [undefined, { state: "withheld" as const, reason: "sensitive" as const }]) {
      const fx = fixture();
      const active = await begin(fx);
      fx.fake.emit({ kind: "interaction", interaction: { kind: "permission", interactionRef, toolName: "Bash", allowSession: false, ...(detail ? { detail } : {}) } });
      await active.pending;
      await expectFailure(fx.execution.respond({ kind: "permission_selection_required", requestId: interactionRef, ownerId, outcome: { kind: "selected", optionId: "allow_once" } }, createAcceptedInvocationAuthority(ownerId)), "invalid");
      expect(fx.fake.responses).toEqual([]);
      const denied = fx.execution.respond({ kind: "permission_selection_required", requestId: interactionRef, ownerId, outcome: { kind: "selected", optionId: "deny" } }, createAcceptedInvocationAuthority(ownerId));
      fx.fake.acceptResponse();
      await denied;
    }
  });

  test("validates question answers locally before the Runtime response", async () => {
    const fx = fixture();
    const { pending } = await begin(fx);
    fx.fake.emit(question());
    expect(await pending).toMatchObject({ kind: "user_input_required", requestId: interactionRef, questions: [{ id: questionRef, multiSelect: false }] });
    const authority = createAcceptedInvocationAuthority(ownerId);
    for (const answers of [
      {},
      { [questionRef]: ["4c7f8238-86c4-42a2-a1b1-df4f99804f50"] },
      { [questionRef]: [optionA, optionA] },
      { [questionRef]: [optionA, "Other"] },
    ]) {
      await expectFailure(fx.execution.respond({ kind: "user_input_required", requestId: interactionRef, ownerId, answers }, authority), "invalid");
      expect(fx.fake.responses).toEqual([]);
    }
    const answered = fx.execution.respond({ kind: "user_input_required", requestId: interactionRef, ownerId, answers: { [questionRef]: [optionA] } }, authority);
    expect(fx.fake.responses).toEqual([{ interactionRef, response: { kind: "answers", answers: { [questionRef]: [optionA] } } }]);
    const captured = fx.fake.responses[0];
    expect(Object.getPrototypeOf(captured?.response.kind === "answers" ? captured.response.answers : null)).toBe(Object.prototype);
    expect(parseRelayClaudeExecutionCommand({
      type: "relay:claude-execution-command",
      scope,
      executionRef: fx.fake.control.executionRef,
      action: { kind: "respond", interactionRef, response: captured?.response },
    })).not.toBeNull();
    fx.fake.acceptResponse();
    await answered;
  });

  test("permits multi-select plus one Other and rejects wrong owner or authority", async () => {
    const fx = fixture();
    const { pending } = await begin(fx);
    fx.fake.emit(question(true));
    expect(await pending).toMatchObject({ questions: [{ multiSelect: true }] });
    const response: HarnessRequestResponse = {
      kind: "user_input_required", requestId: interactionRef, ownerId, answers: { [questionRef]: [optionA, optionB, "Other"] },
    };
    await expectFailure(fx.execution.respond(response, createAcceptedInvocationAuthority("other")), "subject mismatch");
    await expectFailure(fx.execution.respond({ ...response, ownerId: "other" }, createAcceptedInvocationAuthority("other")), "unavailable");
    const accepted = fx.execution.respond(response, createAcceptedInvocationAuthority(ownerId));
    fx.fake.acceptResponse();
    await accepted;
  });

  test("preserves one multiline Unicode single-select Other answer", async () => {
    const fx = fixture();
    const { pending } = await begin(fx);
    fx.fake.emit(question());
    await pending;
    const response = fx.execution.respond({
      kind: "user_input_required", requestId: interactionRef, ownerId, answers: { [questionRef]: ["Something\nelse\twith\rcafé"] },
    }, createAcceptedInvocationAuthority(ownerId));
    fx.fake.acceptResponse();
    await response;
    expect(fx.fake.responses[0]?.response).toEqual({ kind: "answers", answers: { [questionRef]: ["Something\nelse\twith\rcafé"] } });
  });

  test("rejects hostile answer-map keys before constructing the wire response", async () => {
    const fx = fixture();
    const { pending } = await begin(fx);
    fx.fake.emit(question());
    await pending;
    const answers: Record<string, readonly string[]> = { [questionRef]: [optionA] };
    Object.defineProperty(answers, "__proto__", { value: [optionB], enumerable: true });
    await expectFailure(fx.execution.respond({
      kind: "user_input_required", requestId: interactionRef, ownerId, answers,
    }, createAcceptedInvocationAuthority(ownerId)), "invalid");
    expect(fx.fake.responses).toEqual([]);
  });

  test("retires live Human authority when result or Stop-first settlement arrives", async () => {
    const afterResult = fixture();
    const first = await begin(afterResult);
    afterResult.fake.emit(permission());
    await first.pending;
    const streamed = next(first.iterator);
    afterResult.fake.emit({ kind: "output_delta", text: "Answer" });
    expect(await streamed).toMatchObject({ kind: "output_delta", text: "Answer" });
    const firstFollowup = next(first.iterator);
    afterResult.fake.emit({ kind: "result", outcome: "success", text: null });
    await flush();
    expect(afterResult.execution.hasLiveRequest(interactionRef, ownerId)).toBe(false);
    await expectFailure(afterResult.execution.respond({
      kind: "permission_selection_required", requestId: interactionRef, ownerId, outcome: { kind: "selected", optionId: "allow_once" },
    }, createAcceptedInvocationAuthority(ownerId)), "unavailable");
    expect(afterResult.fake.responses).toEqual([]);
    afterResult.fake.emit({ kind: "settled", outcome: "eof" });
    expect(await firstFollowup).toMatchObject({ kind: "assistant_completed" });

    const afterSettlement = fixture();
    const second = await begin(afterSettlement);
    afterSettlement.fake.emit(permission());
    await second.pending;
    const secondFollowup = next(second.iterator);
    const stopping = afterSettlement.execution.stopActiveTask(taskId);
    afterSettlement.fake.emit({ kind: "settled", outcome: "rejected" });
    await flush();
    expect(afterSettlement.execution.hasLiveRequest(interactionRef, ownerId)).toBe(false);
    await expectFailure(afterSettlement.execution.respond({
      kind: "permission_selection_required", requestId: interactionRef, ownerId, outcome: { kind: "selected", optionId: "allow_once" },
    }, createAcceptedInvocationAuthority(ownerId)), "unavailable");
    expect(afterSettlement.fake.responses).toEqual([]);
    afterSettlement.fake.emit({ kind: "result", outcome: "interrupted", text: null });
    afterSettlement.fake.acknowledge();
    expect(await stopping).toBe(true);
    expect(await secondFollowup).toMatchObject({ kind: "terminal", status: "interrupted" });
  });

  test("admits repeated Stop once but reports containment only after all three facts", async () => {
    for (const order of permutations(["ack", "result", "settled"] as const)) {
      const fx = fixture();
      const { iterator, pending } = await begin(fx);
      const stopping = fx.execution.stopActiveTask(taskId);
      const concurrent = fx.execution.stopActiveTask(taskId);
      expect(await Promise.all([stopping, concurrent])).toEqual([true, true]);
      expect(fx.fake.interrupts).toBe(1);
      for (const step of order) {
        if (step === "ack") fx.fake.acknowledge();
        if (step === "result") fx.fake.emit({ kind: "result", outcome: "interrupted", text: null });
        if (step === "settled") fx.fake.emit({ kind: "settled", outcome: "rejected" });
        await flush();
      }
      expect(await Promise.all([stopping, concurrent])).toEqual([true, true]);
      expect(await pending).toMatchObject({ kind: "terminal", status: "interrupted", code: "user_stop" });
      await iterator.next();
    }
  });

  test("admits cancellation but keeps partial and spontaneous containment truthful", async () => {
    const fx = fixture();
    const { iterator, pending } = await begin(fx);
    const stopping = fx.execution.stopActiveTask(taskId);
    fx.fake.uncertain();
    fx.fake.emit({ kind: "result", outcome: "interrupted", text: null });
    fx.fake.emit({ kind: "settled", outcome: "rejected" });
    expect(await stopping).toBe(true);
    expect(await pending).toMatchObject({ kind: "terminal", status: "failed", code: "upstream_failure" });
    await iterator.next();

    const spontaneous = fixture();
    const active = await begin(spontaneous);
    spontaneous.fake.emit({ kind: "result", outcome: "interrupted", text: null });
    spontaneous.fake.emit({ kind: "settled", outcome: "rejected" });
    expect(await active.pending).toMatchObject({ kind: "terminal", status: "failed", code: "upstream_failure" });

    const thrown = fixture();
    const throwing = await begin(thrown);
    const stopped = thrown.execution.stopActiveTask(taskId);
    thrown.fake.rejectInterrupt();
    expect(await stopped).toBe(true);
    thrown.fake.emit({ kind: "result", outcome: "failed", text: null });
    thrown.fake.emit({ kind: "settled", outcome: "eof" });
    expect(await throwing.pending).toMatchObject({ kind: "terminal", status: "failed", code: "upstream_failure" });
  });

  test("fires best-effort interrupt for rejected/null stream loss and frees the task for a successor", async () => {
    const fx = fixture();
    const { iterator, pending } = await begin(fx);
    fx.fake.failNext();
    expect(await pending).toMatchObject({ kind: "terminal", status: "failed", code: "process_lost" });
    expect(fx.fake.interrupts).toBe(1);
    await iterator.next();
    expect(await fx.execution.stopActiveTask(taskId)).toBe(false);
    const successor = fx.execution.start(admission())[Symbol.asyncIterator]();
    const successorOutput = next(successor);
    fx.fake.emit({ kind: "started" });
    fx.fake.close();
    expect(await successorOutput).toMatchObject({ kind: "terminal", code: "process_lost" });
    expect(fx.opens).toHaveLength(2);

    const closed = fixture();
    const closeActive = await begin(closed);
    closed.fake.close();
    expect(await closeActive.pending).toMatchObject({ kind: "terminal", status: "failed", code: "process_lost" });
    expect(closed.fake.interrupts).toBe(1);
  });
});

function permutations<T>(values: readonly T[]): readonly (readonly T[])[] {
  if (values.length < 2) return [values];
  return values.flatMap((value, index) => permutations([...values.slice(0, index), ...values.slice(index + 1)])
    .map((rest) => [value, ...rest] as const));
}
