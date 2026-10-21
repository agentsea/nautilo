import { describe, expect, test } from "bun:test";
import type { RelayCodexClientMessage, RelayCodexEventMessage, RelayCodexRequestMessage,
  RelayCodexServerMessage } from "@nautilo/relay";
import {
  type HarnessExecutionAdmission,
  type HarnessRequestResponse,
} from "@nautilo/runtime";
import {
  CodexHarnessExecution,
  type CodexBindingSessionPort,
  type CodexRequestSubscriptionPort,
  type CodexTurnEventSubscriptionPort,
} from "../../src/codex/harness-execution";
import {
  CodexTurnEventBroker,
  type CodexRelayTurnScope,
  type CodexRelayTurnSource,
  type CodexTurnEventSubscription,
} from "../../src/codex/turn-event-broker";
import {
  createCodexExecutionAdmission,
  type CreateCodexExecutionAdmissionInput,
} from "../../src/codex/execution-admission";
import { createAcceptedInvocationAuthority } from "@nautilo/trust";
import type { CodexDerivedBindingScope } from "../../src/codex/authority";
import { CodexRequestBroker, CodexRequestSourcePartition,
  type CodexRelayRequestSource } from "../../src/codex/request-broker";

const scope: CodexRelayTurnScope = {
  relayId: "relay", relaySessionId: "relay-session", desktopSessionId: "desktop",
  pairingGenerationRef: "pairing", selectedProtocolVersion: 8, capabilityRevision: 1,
  profileHandle: "profile", profileGeneration: 2, accountGeneration: 3,
  runtimeGeneration: 4, childGeneration: 5,
  workspace: {
    workspaceRef: "workspace", revision: 1, fingerprint: "fingerprint",
    issuedAt: "2026-07-29T00:00:00.000Z", expiresAt: "2026-07-29T01:00:00.000Z",
  },
  bindingId: "binding", bindingGeneration: 6,
  taskId: "task", jobId: "job", threadId: "thread", turnId: "turn",
};

function createSource(): {
  source: CodexRelayTurnSource;
  emit(message: RelayCodexEventMessage): void;
} {
  let listener: ((relayId: string, message: RelayCodexEventMessage) => void) | null = null;
  return {
    source: {
      onCodexMessage(next) {
        listener = next as (relayId: string, message: RelayCodexEventMessage) => void;
        return () => { listener = null; };
      },
      onCodexContextInvalidated() { return () => undefined; },
    },
    emit(message) { listener?.("relay", message); },
  };
}

function createRequestSource(): {
  source: CodexRelayRequestSource;
  emit(message: RelayCodexClientMessage): void;
} {
  let listener: ((relayId: string, message: RelayCodexClientMessage) => void) | null = null;
  return {
    source: {
      onCodexMessage(next) { listener = next; return () => { listener = null; }; },
      onCodexContextInvalidated() { return () => undefined; },
      sendCodex(_relayId: string, _message: RelayCodexServerMessage) { return { ok: true }; },
    },
    emit(message) { listener?.("relay", message); },
  };
}

function event(
  input: RelayCodexEventMessage["event"],
  eventSequence = 1,
): RelayCodexEventMessage {
  return {
    type: "relay:codex-event",
    scope: {
      ...scope,
      selectedProtocolVersion: 8,
      workspace: {
        workspaceRef: "workspace", revision: 1, fingerprint: "fingerprint",
        issuedAt: "2026-07-29T00:00:00.000Z", expiresAt: "2026-07-29T01:00:00.000Z",
      },
      eventId: "event", itemId: "item",
    },
    eventSequence,
    event: input,
  } as RelayCodexEventMessage;
}

function admission(signal: AbortSignal) {
  return createCodexExecutionAdmission({
    jobId: "job", taskId: "task", taskRunId: "run", ownerId: "owner", requesterId: "owner",
    roomId: "room", laneKey: "lane", source: "room", parentTaskId: null,
    binding: { id: "binding", generation: "6" },
    workspace: { id: "workspace", currentFolderReceiptId: "receipt", pairingGeneration: "pairing" },
    profile: { id: "profile", generation: "2" },
    posture: { id: "posture", generation: "1" },
    prompt: "Inspect the change", abortSignal: signal,
    codex: {
      scope: {
        userId: "owner", agentId: "agent", taskId: "task", taskRunId: "run", jobId: "job",
        parentTaskId: null, roomId: "room", laneKey: "lane", profileId: "profile", relayId: "relay",
        profileHandle: "profile", profileGeneration: 2, accountGeneration: 3, posture: "codex_default",
        explicitSteer: true,
        relaySessionId: "relay-session", desktopSessionId: "desktop", pairingGenerationRef: "pairing",
        capabilityRevision: 1, runtimeGeneration: 4, childGeneration: 5,
        workspace: { workspaceRef: "workspace", revision: 1, fingerprint: "fingerprint", issuedAt: "2026-07-29T00:00:00.000Z", expiresAt: "2026-07-30T00:00:00.000Z" },
        codexSandboxMode: "default", codexApprovalPolicy: "default",
      } as CodexDerivedBindingScope,
      selectedModel: null,
      outputContract: {
        version: 1, capabilityModelId: "openai:gpt-test", catalogVersion: "test-v1",
        contextTokens: 1_000_000, outputTokens: 128_000,
      },
      collaborationMode: "work",
      workingDirectory: null,
      bindingKind: "task",
    },
  });
}

function deferred(): { promise: Promise<void>; resolve(): void } {
  let resolve: (() => void) | null = null;
  const promise = new Promise<void>((next) => { resolve = next; });
  return { promise, resolve: () => resolve?.() };
}

function deferredValue<Value>(): {
  promise: Promise<Value>;
  resolve(value: Value): void;
} {
  let resolve: ((value: Value) => void) | null = null;
  const promise = new Promise<Value>((next) => { resolve = next; });
  return { promise, resolve: (value) => resolve?.(value) };
}

function sessions(started: ReturnType<typeof deferred>, calls: string[]): CodexBindingSessionPort {
  return {
    async openOrResume() {
      calls.push("open");
      return { id: "session" };
    },
    async startTurn() {
      calls.push("start");
      started.resolve();
      return { scope };
    },
    async interruptTurn() { calls.push("interrupt"); },
    async steerTurn() { calls.push("steer"); },
  };
}

function closedEvents(): CodexTurnEventSubscriptionPort {
  return {
    subscribe(): CodexTurnEventSubscription {
      return {
        async *[Symbol.asyncIterator]() {
          // A relay close without a terminal is the fail-closed regression path.
        },
        terminalReceived: false,
        inactivityExpired: false,
        close() {},
      };
    },
  };
}

function inactiveEvents(): CodexTurnEventSubscriptionPort {
  return {
    subscribe(): CodexTurnEventSubscription {
      return {
        async *[Symbol.asyncIterator]() {
          // The inactivity lease closed the authoritative event stream.
        },
        terminalReceived: false,
        inactivityExpired: true,
        close() {},
      };
    },
  };
}

function pendingEvents(): CodexTurnEventSubscriptionPort {
  return {
    subscribe(): CodexTurnEventSubscription {
      let release: (() => void) | null = null;
      const closed = new Promise<void>((resolve) => { release = resolve; });
      return {
        [Symbol.asyncIterator]() {
          return {
            async next(): Promise<IteratorResult<RelayCodexEventMessage>> {
              await closed;
              return { done: true, value: undefined };
            },
          };
        },
        terminalReceived: false,
        inactivityExpired: false,
        close() { release?.(); },
      };
    },
  };
}

function closedRequests(): CodexRequestSubscriptionPort {
  return {
    subscribe() {
      return {
        async *[Symbol.asyncIterator]() {
          // Requests share the same native execution lifetime as events.
        },
        close() {},
      };
    },
    respond() {},
  };
}

function pendingRequests(): CodexRequestSubscriptionPort {
  return {
    subscribe() {
      let release: (() => void) | null = null;
      const closed = new Promise<void>((resolve) => { release = resolve; });
      return {
        [Symbol.asyncIterator]() {
          return {
            async next(): Promise<IteratorResult<RelayCodexRequestMessage>> {
              await closed;
              return { done: true, value: undefined };
            },
          };
        },
        close() { release?.(); },
      };
    },
    respond() {},
  };
}

function commandRequest(): RelayCodexRequestMessage {
  return {
    type: "relay:codex-request",
    scope: {
      ...scope,
      selectedProtocolVersion: 8,
      workspace: {
        workspaceRef: "workspace", revision: 1, fingerprint: "fingerprint",
        issuedAt: "2026-07-29T00:00:00.000Z", expiresAt: "2026-07-30T00:00:00.000Z",
      },
      eventId: "event", itemId: "item", requestRef: "request",
    },
    request: {
      kind: "command_approval",
      choices: ["accept", "decline"],
      reason: "host_local_only",
      command: { detail: "host_local_only", actionKinds: ["unknown"] },
      expiresAt: "2026-07-30T00:00:00.000Z",
    },
  };
}

/**
 * Mirrors the generated 0.139.0 `item/tool/requestUserInput` shape after the
 * Electron host has projected it onto the relay. Plan mode uses this ordinary
 * correlated server request; it is not a separate execution lifecycle.
 */
function userInputRequest(): RelayCodexRequestMessage {
  return {
    type: "relay:codex-request",
    scope: {
      ...scope,
      selectedProtocolVersion: 8,
      workspace: {
        workspaceRef: "workspace", revision: 1, fingerprint: "fingerprint",
        issuedAt: "2026-07-29T00:00:00.000Z", expiresAt: "2026-07-30T00:00:00.000Z",
      },
      eventId: "event", itemId: "input-item", requestRef: "plan-input-request",
    },
    request: {
      kind: "user_input",
      questions: [{
        id: "target", header: "Target", question: "Which target?",
        isOther: false, isSecret: false,
        options: [{ id: "tests", label: "Tests", description: "Run focused tests." }],
      }],
      autoResolutionMs: null,
      expiresAt: "2026-07-30T00:00:00.000Z",
    },
  };
}

function requestPort(
  request: RelayCodexRequestMessage,
  responses: HarnessRequestResponse[],
): CodexRequestSubscriptionPort {
  return {
    subscribe() {
      return {
        async *[Symbol.asyncIterator]() { yield request; },
        close() {},
      };
    },
    respond(response) { responses.push(response); },
  };
}

async function rejected(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
    throw new Error("expected rejection");
  } catch (error) {
    return error;
  }
}

describe("CodexHarnessExecution", () => {
  test("brands server-authored admissions and deep-copies their identity", () => {
    const source = admission(new AbortController().signal);
    const mutableBinding = { ...source.binding };
    const mutableWorkspace = { ...source.workspace };
    const mutableProfile = { ...source.profile };
    const mutablePosture = { ...source.posture };
    const mutableScopeWorkspace = { ...source.codex.scope.workspace };
    const mutableInput: CreateCodexExecutionAdmissionInput = {
      ...source,
      binding: mutableBinding,
      workspace: mutableWorkspace,
      profile: mutableProfile,
      posture: mutablePosture,
      codex: {
        ...source.codex,
        scope: { ...source.codex.scope, workspace: mutableScopeWorkspace },
      },
    };
    const isolated = createCodexExecutionAdmission(mutableInput);
    mutableBinding.id = "swapped";
    mutableWorkspace.id = "swapped";
    mutableScopeWorkspace.fingerprint = "swapped";
    expect(isolated.binding.id).toBe("binding");
    expect(isolated.workspace.id).toBe("workspace");
    expect(isolated.codex.scope.workspace.fingerprint).toBe("fingerprint");
    expect(Object.isFrozen(isolated.binding)).toBe(true);
    expect(Object.isFrozen(isolated.workspace)).toBe(true);
    expect(Object.isFrozen(isolated.codex.scope)).toBe(true);
    expect(Object.isFrozen(isolated.codex.scope.workspace)).toBe(true);
  });

  test("rejects an unbranded structural runtime admission before opening a Codex session", async () => {
    const calls: string[] = [];
    const started = deferred();
    const execution = new CodexHarnessExecution({ events: closedEvents(), requests: closedRequests(), sessions: sessions(started, calls) });
    const structural = {
      jobId: "job", taskId: "task", taskRunId: "run", ownerId: "owner", requesterId: "owner",
      roomId: "room", laneKey: "lane", source: "room", parentTaskId: null,
      binding: { id: "binding", generation: "6" },
      workspace: { id: "workspace", currentFolderReceiptId: "receipt", pairingGeneration: "pairing" },
      profile: { id: "profile", generation: "2" }, posture: { id: "posture", generation: "1" },
      prompt: "nope", abortSignal: new AbortController().signal,
    } satisfies HarnessExecutionAdmission;
    expect(await rejected(execution.start(structural)[Symbol.asyncIterator]().next())).toMatchObject({
      message: "Codex execution admission was not server-authored",
    });
    expect(calls).toEqual([]);
  });
  test("opens and starts through the injected binding port, then projects one authoritative terminal", async () => {
    const { source, emit } = createSource();
    const broker = new CodexTurnEventBroker({ source });
    const calls: string[] = [];
    const started = deferred();
    const execution = new CodexHarnessExecution({ events: broker, requests: closedRequests(), sessions: sessions(started, calls) });
    const iterator = execution.start(admission(new AbortController().signal))[Symbol.asyncIterator]();

    const first = iterator.next();
    await started.promise;
    emit(event({ kind: "message_delta", text: "draft", sequence: 1 }));
    expect(await first).toMatchObject({
      done: false, value: { kind: "output_delta", text: "draft" },
    });

    const second = iterator.next();
    emit(event({
      kind: "turn_completed", status: "completed",
      itemsView: "full",
      assistantItems: [{ itemId: "final", text: "authoritative", phase: "final_answer" }],
    }, 2));
    expect(await second).toMatchObject({
      done: false, value: { kind: "assistant_completed", text: "authoritative" },
    });
    expect(await iterator.next()).toMatchObject({
      done: false, value: { kind: "terminal", status: "completed" },
    });
    expect(await iterator.next()).toMatchObject({ done: true });
    expect(calls).toEqual(["open", "start"]);
    broker.dispose();
  });

  test("resolves and steers only the exact live owner/Room turn", async () => {
    const { source } = createSource();
    const events = new CodexTurnEventBroker({ source });
    const calls: string[] = [];
    const started = deferred();
    const controller = new AbortController();
    const execution = new CodexHarnessExecution({
      events,
      requests: closedRequests(),
      sessions: sessions(started, calls),
      mintActorRef: () => "actor-ref",
    });
    const iterator = execution.start(admission(controller.signal))[Symbol.asyncIterator]();
    const waiting = iterator.next();
    await started.promise;
    await Promise.resolve();

    const reference = execution.activeTurnForTask({
      taskId: "task",
      ownerId: "owner",
      roomId: "room",
    });
    expect(reference).toEqual({
      bindingId: "binding",
      bindingGeneration: "6",
      vendorSessionId: "thread",
      vendorTurnId: "turn",
    });
    expect(execution.activeTurnForTask({
      taskId: "task",
      ownerId: "other",
      roomId: "room",
    })).toBeNull();

    await execution.steer({ ...reference!, text: "Check the focused failure" });
    expect(calls).toEqual(["open", "start", "steer"]);
    await execution.steer({ ...reference!, vendorTurnId: null, text: "must not match" }).then(
      () => { throw new Error("expected stale turn steering to fail"); },
      (error: unknown) => {
        expect(error).toBeInstanceOf(Error);
        expect((error as Error).message).toBe("Codex active turn is unavailable for steering");
      },
    );
    expect(calls).toEqual(["open", "start", "steer"]);

    controller.abort();
    await waiting;
    await iterator.return?.();
    expect(execution.activeTurnForTask({
      taskId: "task",
      ownerId: "owner",
      roomId: "room",
    })).toBeNull();
    events.dispose();
  });

  test("multiplexes an ephemeral native request and keeps response routing on the execution facet", async () => {
    const calls: string[] = [];
    const started = deferred();
    const responses: HarnessRequestResponse[] = [];
    const execution = new CodexHarnessExecution({
      events: pendingEvents(),
      requests: requestPort(commandRequest(), responses),
      sessions: sessions(started, calls),
    });
    const iterator = execution.start(admission(new AbortController().signal))[Symbol.asyncIterator]();
    const result = iterator.next();
    await started.promise;
    expect(await result).toMatchObject({
      done: false,
      value: { kind: "command_approval_required", requestId: "request", ownerId: "owner" },
    });

    await execution.respond({
      kind: "command_approval_required", requestId: "request", ownerId: "owner", decision: "deny",
    }, createAcceptedInvocationAuthority("owner"));
    expect(responses).toEqual([{
      kind: "command_approval_required", requestId: "request", ownerId: "owner", decision: "deny",
    }]);
  });

  test("claims the ordinary request scope before provider awaits and releases it on consumer close", async () => {
    const upstream = createRequestSource();
    const partition = new CodexRequestSourcePartition(upstream.source);
    const requests = new CodexRequestBroker({ source: partition.ordinary,
      now: () => Date.parse("2026-07-29T00:00:00.000Z") });
    const earlyRequest = { ...commandRequest(), scope: { ...commandRequest().scope,
      workspace: scope.workspace } } satisfies RelayCodexRequestMessage;
    const calls: string[] = [];
    const execution = new CodexHarnessExecution({
      events: pendingEvents(), requests,
      requestScopes: { claim: identity => partition.claimOrdinary(identity) },
      sessions: {
        async openOrResume() {
          calls.push("open");
          upstream.emit(earlyRequest);
          return { id: "session" };
        },
        async startTurn() { calls.push("start"); return { scope }; },
        async interruptTurn() { calls.push("interrupt"); },
        async steerTurn() { calls.push("steer"); },
      },
    });
    const iterator = execution.start(admission(new AbortController().signal))[Symbol.asyncIterator]();
    expect(await iterator.next()).toMatchObject({
      done: false, value: { kind: "command_approval_required", requestId: "request" },
    });
    expect(calls).toEqual(["open", "start"]);
    expect(await iterator.return?.()).toMatchObject({ done: true });
    upstream.emit({ ...commandRequest(), scope: { ...commandRequest().scope,
      requestRef: "late", turnId: "late-turn" } });
    expect(requests.hasLiveRequest("late", "owner")).toBeFalse();
    requests.dispose();
    partition.dispose();
  });

  test("releases an ordinary request scope when a pre-subscription provider await rejects", async () => {
    const lifecycle: string[] = [];
    const execution = new CodexHarnessExecution({
      events: closedEvents(), requests: closedRequests(),
      requestScopes: { claim: () => {
        lifecycle.push("claim");
        return { close() { lifecycle.push("release"); } };
      } },
      sessions: {
        async openOrResume() { lifecycle.push("open"); throw new Error("open failed"); },
        async startTurn() { throw new Error("must not start"); },
        async interruptTurn() {}, async steerTurn() {},
      },
    });
    const iterator = execution.start(admission(new AbortController().signal))[Symbol.asyncIterator]();
    expect(await rejected(iterator.next())).toMatchObject({ message: "open failed" });
    expect(lifecycle).toEqual(["claim", "open", "release"]);
  });

  test("interrupts once on abort, suppresses a late relay event, and emits one interrupted terminal", async () => {
    const { source, emit } = createSource();
    const broker = new CodexTurnEventBroker({ source });
    const calls: string[] = [];
    const started = deferred();
    const controller = new AbortController();
    const execution = new CodexHarnessExecution({ events: broker, requests: closedRequests(), sessions: sessions(started, calls) });
    const iterator = execution.start(admission(controller.signal))[Symbol.asyncIterator]();

    const terminal = iterator.next();
    await started.promise;
    controller.abort();
    expect(await terminal).toMatchObject({
      done: false,
      value: { kind: "terminal", status: "interrupted", code: "user_stop" },
    });
    emit(event({
      kind: "turn_completed", status: "completed", itemsView: "full",
      assistantItems: [{ itemId: "late-final", text: "late", phase: "final_answer" }],
    }, 2));
    expect(await iterator.next()).toMatchObject({ done: true });
    expect(calls).toEqual(["open", "start", "interrupt"]);
    broker.dispose();
  });

  test("never fabricates user_stop when exact host containment rejects", async () => {
    const { source } = createSource();
    const broker = new CodexTurnEventBroker({ source });
    const calls: string[] = [];
    const started = deferred();
    const controller = new AbortController();
    const base = sessions(started, calls);
    const execution = new CodexHarnessExecution({
      events: broker,
      requests: closedRequests(),
      sessions: {
        ...base,
        async interruptTurn() {
          calls.push("interrupt");
          throw new Error("containment uncertain");
        },
      },
    });
    const iterator = execution.start(admission(controller.signal))[Symbol.asyncIterator]();
    const terminal = iterator.next();
    await started.promise;
    await Promise.resolve();
    await Promise.resolve();
    // Route preparation is best effort and must not prevent the ordinary
    // local Task cancellation from running.
    expect(await execution.stopActiveTask("task")).toBeTrue();
    controller.abort();

    expect(await rejected(terminal)).toMatchObject({ message: "containment uncertain" });
    expect(calls).toEqual(["open", "start", "interrupt"]);
    broker.dispose();
  });

  test("contains and fails a turn whose accepted event stream goes inactive", async () => {
    const { source } = createSource();
    const manualTimer: { expire?: () => void } = {};
    const broker = new CodexTurnEventBroker({
      source,
      turnInactivityTimeoutMs: 10,
      timer: {
        setTimeout(callback) {
          manualTimer.expire = callback;
          return callback;
        },
        clearTimeout(handle) {
          if (manualTimer.expire === handle) delete manualTimer.expire;
        },
      },
    });
    const calls: string[] = [];
    const started = deferred();
    const execution = new CodexHarnessExecution({
      events: broker,
      requests: closedRequests(),
      sessions: sessions(started, calls),
    });
    const iterator = execution.start(admission(new AbortController().signal))[Symbol.asyncIterator]();

    const terminal = iterator.next();
    await started.promise;
    await Promise.resolve();
    manualTimer.expire?.();

    expect(await terminal).toMatchObject({
      done: false,
      value: { kind: "terminal", status: "failed", code: "process_lost" },
    });
    expect(calls).toEqual(["open", "start", "interrupt"]);
    broker.dispose();
  });

  test("starts containment once without gating the Task Stop route", async () => {
    const { source } = createSource();
    const broker = new CodexTurnEventBroker({ source });
    const calls: string[] = [];
    const started = deferred();
    const contained = deferred();
    const controller = new AbortController();
    const base = sessions(started, calls);
    const execution = new CodexHarnessExecution({
      events: broker,
      requests: closedRequests(),
      sessions: {
        ...base,
        async interruptTurn() {
          calls.push("interrupt");
          await contained.promise;
        },
      },
    });
    const iterator = execution.start(admission(controller.signal))[Symbol.asyncIterator]();
    const pending = iterator.next();
    await started.promise;
    await Promise.resolve();
    await Promise.resolve();

    const firstStop = execution.stopActiveTask("task");
    const secondStop = execution.stopActiveTask("task");
    await Promise.resolve();
    expect(await Promise.all([firstStop, secondStop])).toEqual([true, true]);
    expect(calls).toEqual(["open", "start", "interrupt"]);

    contained.resolve();
    controller.abort();
    expect(await pending).toMatchObject({
      done: false,
      value: { kind: "terminal", status: "interrupted", code: "user_stop" },
    });
    expect(calls).toEqual(["open", "start", "interrupt"]);
    broker.dispose();
  });

  test("preserves an exact terminal received before Stop without an upstream interrupt", async () => {
    const { source, emit } = createSource();
    const broker = new CodexTurnEventBroker({ source });
    const calls: string[] = [];
    const started = deferred();
    const controller = new AbortController();
    const execution = new CodexHarnessExecution({
      events: broker,
      requests: closedRequests(),
      sessions: sessions(started, calls),
    });
    const iterator = execution.start(admission(controller.signal))[Symbol.asyncIterator]();

    const first = iterator.next();
    await started.promise;
    await Promise.resolve();
    // The relay receives this terminal synchronously before the user hits Stop.
    // The executor has not yet resumed its event continuation when Stop fires.
    emit(event({
      kind: "turn_completed", status: "completed", itemsView: "full",
      assistantItems: [{ itemId: "final", text: "authoritative", phase: "final_answer" }],
    }));
    controller.abort();

    expect(await first).toMatchObject({
      done: false,
      value: { kind: "assistant_completed", text: "authoritative" },
    });
    expect(await iterator.next()).toMatchObject({
      done: false,
      value: { kind: "terminal", status: "completed" },
    });
    expect(await iterator.next()).toMatchObject({ done: true });
    expect(calls).toEqual(["open", "start"]);
    broker.dispose();
  });

  test("stops a Plan input wait with one interrupt and one interrupted terminal", async () => {
    const { source, emit } = createSource();
    const events = new CodexTurnEventBroker({ source });
    const calls: string[] = [];
    const started = deferred();
    const controller = new AbortController();
    let requestClosed = false;
    const requests: CodexRequestSubscriptionPort = {
      subscribe() {
        let close: (() => void) | null = null;
        const closed = new Promise<void>((resolve) => { close = resolve; });
        return {
          async *[Symbol.asyncIterator]() {
            yield userInputRequest();
            await closed;
          },
          close() {
            requestClosed = true;
            close?.();
          },
        };
      },
      respond() {
        throw new Error("late Plan input response must not reach the relay");
      },
    };
    const execution = new CodexHarnessExecution({ events, requests, sessions: sessions(started, calls) });
    const iterator = execution.start(admission(controller.signal))[Symbol.asyncIterator]();

    const input = iterator.next();
    await started.promise;
    expect(await input).toMatchObject({
      done: false,
      value: {
        kind: "user_input_required",
        requestId: "plan-input-request",
        questions: [{ id: "target" }],
      },
    });

    controller.abort();
    expect(await iterator.next()).toMatchObject({
      done: false,
      value: { kind: "terminal", status: "interrupted", code: "user_stop" },
    });
    expect(await iterator.next()).toMatchObject({ done: true });
    expect(requestClosed).toBeTrue();
    expect(calls).toEqual(["open", "start", "interrupt"]);

    expect(() => execution.respond({
      kind: "user_input_required",
      requestId: "plan-input-request",
      ownerId: "owner",
      answers: { target: ["tests"] },
    }, createAcceptedInvocationAuthority("owner"))).toThrow("late Plan input response");
    emit(event({ kind: "message_delta", text: "late", sequence: 2 }));
    events.dispose();
  });

  test("fails closed when the relay stream ends before an authoritative terminal", async () => {
    const calls: string[] = [];
    const started = deferred();
    const execution = new CodexHarnessExecution({ events: closedEvents(), requests: pendingRequests(), sessions: sessions(started, calls) });
    const iterator = execution.start(admission(new AbortController().signal))[Symbol.asyncIterator]();

    const result = iterator.next();
    await started.promise;
    expect(await result).toMatchObject({
      done: false,
      value: { kind: "terminal", status: "failed", code: "process_lost" },
    });
    expect(calls).toEqual(["open", "start"]);
  });

  test("does not start or interrupt upstream when admission is already aborted", async () => {
    const { source } = createSource();
    const broker = new CodexTurnEventBroker({ source });
    const calls: string[] = [];
    const started = deferred();
    const controller = new AbortController();
    controller.abort();
    const execution = new CodexHarnessExecution({ events: broker, requests: closedRequests(), sessions: sessions(started, calls) });

    const iterator = execution.start(admission(controller.signal))[Symbol.asyncIterator]();
    expect(await iterator.next()).toMatchObject({ done: true });
    expect(calls).toEqual(["open"]);
    broker.dispose();
  });

  test("releases protected custody while session open is stalled without starting a late session", async () => {
    const controller = new AbortController();
    const openInvoked = deferred();
    const opened = deferredValue<{ id: string }>();
    const calls: string[] = [];
    const execution = new CodexHarnessExecution({
      abortStreamOnCancellation: true,
      events: closedEvents(),
      requests: closedRequests(),
      sessions: {
        async openOrResume() {
          calls.push("open");
          openInvoked.resolve();
          return await opened.promise;
        },
        async startTurn() {
          calls.push("start");
          return { scope };
        },
        async interruptTurn() { calls.push("interrupt"); },
        async steerTurn() { calls.push("steer"); },
      },
    });

    const iterator = execution.start(admission(controller.signal))[Symbol.asyncIterator]();
    const pending = iterator.next();
    await openInvoked.promise;
    controller.abort();
    expect(await pending).toMatchObject({ done: true });

    opened.resolve({ id: "late-session" });
    await Promise.resolve();
    await Promise.resolve();
    expect(calls).toEqual(["open"]);
  });

  test("contains one exact late protected turn after a stalled start without retaining custody", async () => {
    const controller = new AbortController();
    const startInvoked = deferred();
    const lateTurn = deferredValue<{ scope: CodexRelayTurnScope }>();
    const interruptInvoked = deferred();
    const interruptFinished = deferred();
    const calls: string[] = [];
    const execution = new CodexHarnessExecution({
      abortStreamOnCancellation: true,
      events: closedEvents(),
      requests: closedRequests(),
      sessions: {
        async openOrResume() {
          calls.push("open");
          return { id: "session" };
        },
        async startTurn() {
          calls.push("start");
          startInvoked.resolve();
          return await lateTurn.promise;
        },
        async interruptTurn(input) {
          calls.push(`interrupt:${input.turn.scope.turnId}`);
          interruptInvoked.resolve();
          await interruptFinished.promise;
        },
        async steerTurn() { calls.push("steer"); },
      },
    });

    const iterator = execution.start(admission(controller.signal))[Symbol.asyncIterator]();
    const pending = iterator.next();
    await startInvoked.promise;
    controller.abort();
    expect(await pending).toMatchObject({ done: true });

    lateTurn.resolve({ scope });
    await interruptInvoked.promise;
    expect(calls).toEqual(["open", "start", "interrupt:turn"]);
    interruptFinished.resolve();
  });

  test("releases a protected stream wait while exact interrupt containment remains unsettled", async () => {
    const controller = new AbortController();
    const started = deferred();
    const interruptInvoked = deferred();
    const interruptFinished = deferred();
    const calls: string[] = [];
    const base = sessions(started, calls);
    const execution = new CodexHarnessExecution({
      abortStreamOnCancellation: true,
      events: pendingEvents(),
      requests: pendingRequests(),
      sessions: {
        ...base,
        async interruptTurn() {
          calls.push("interrupt");
          interruptInvoked.resolve();
          await interruptFinished.promise;
        },
      },
    });
    const iterator = execution.start(admission(controller.signal))[Symbol.asyncIterator]();
    const terminal = iterator.next();
    await started.promise;
    while (execution.activeTurnForTask({
      taskId: "task",
      ownerId: "owner",
      roomId: "room",
    }) === null) {
      await Promise.resolve();
    }

    controller.abort();
    await interruptInvoked.promise;
    expect(await terminal).toMatchObject({
      done: false,
      value: { kind: "terminal", status: "failed", code: "process_lost" },
    });
    expect(await iterator.next()).toMatchObject({ done: true });
    expect(calls).toEqual(["open", "start", "interrupt"]);
    interruptFinished.resolve();
  });

  test("protected consumer return starts one interrupt and does not await rejection or containment", async () => {
    for (const outcome of ["hanging", "rejected"] as const) {
      const { source, emit } = createSource();
      const broker = new CodexTurnEventBroker({ source });
      const calls: string[] = [];
      const started = deferred();
      const base = sessions(started, calls);
      const execution = new CodexHarnessExecution({
        abortStreamOnCancellation: true,
        events: broker,
        requests: closedRequests(),
        sessions: {
          ...base,
          async interruptTurn() {
            calls.push("interrupt");
            if (outcome === "rejected") throw new Error("interrupt failed");
            await new Promise<void>(() => undefined);
          },
        },
      });
      const iterator = execution.start(admission(new AbortController().signal))[Symbol.asyncIterator]();
      const first = iterator.next();
      await started.promise;
      emit(event({ kind: "message_delta", text: "partial", sequence: 1 }));
      expect(await first).toMatchObject({
        done: false,
        value: { kind: "output_delta", text: "partial" },
      });

      expect(await iterator.return?.()).toMatchObject({ done: true });
      await Promise.resolve();
      await Promise.resolve();
      expect(calls).toEqual(["open", "start", "interrupt"]);
      broker.dispose();
    }
  });

  test("protected authoritative completion does not send a redundant interrupt", async () => {
    const { source, emit } = createSource();
    const broker = new CodexTurnEventBroker({ source });
    const calls: string[] = [];
    const started = deferred();
    const execution = new CodexHarnessExecution({
      abortStreamOnCancellation: true,
      events: broker,
      requests: closedRequests(),
      sessions: sessions(started, calls),
    });
    const iterator = execution.start(admission(new AbortController().signal))[Symbol.asyncIterator]();
    const first = iterator.next();
    await started.promise;
    emit(event({
      kind: "turn_completed", status: "completed", itemsView: "full",
      assistantItems: [{ itemId: "final", text: "authoritative", phase: "final_answer" }],
    }));
    expect(await first).toMatchObject({
      done: false,
      value: { kind: "assistant_completed", text: "authoritative" },
    });
    expect(await iterator.next()).toMatchObject({
      done: false,
      value: { kind: "terminal", status: "completed" },
    });
    expect(await iterator.next()).toMatchObject({ done: true });
    expect(calls).toEqual(["open", "start"]);
    broker.dispose();
  });

  test("releases a protected inactivity containment wait when authorization expires", async () => {
    const controller = new AbortController();
    const started = deferred();
    const interruptInvoked = deferred();
    const interruptFinished = deferred();
    const calls: string[] = [];
    const base = sessions(started, calls);
    const execution = new CodexHarnessExecution({
      abortStreamOnCancellation: true,
      events: inactiveEvents(),
      requests: closedRequests(),
      sessions: {
        ...base,
        async interruptTurn() {
          calls.push("interrupt");
          interruptInvoked.resolve();
          await interruptFinished.promise;
        },
      },
    });
    const iterator = execution.start(admission(controller.signal))[Symbol.asyncIterator]();
    const terminal = iterator.next();
    await started.promise;
    await interruptInvoked.promise;

    controller.abort();
    expect(await terminal).toMatchObject({
      done: false,
      value: { kind: "terminal", status: "failed", code: "process_lost" },
    });
    expect(calls).toEqual(["open", "start", "interrupt"]);
    interruptFinished.resolve();
  });

  test("preserves the ordinary stalled-open wait until the provider operation settles", async () => {
    const controller = new AbortController();
    const openInvoked = deferred();
    const opened = deferredValue<{ id: string }>();
    const calls: string[] = [];
    const execution = new CodexHarnessExecution({
      events: closedEvents(),
      requests: closedRequests(),
      sessions: {
        async openOrResume() {
          calls.push("open");
          openInvoked.resolve();
          return await opened.promise;
        },
        async startTurn() {
          calls.push("start");
          return { scope };
        },
        async interruptTurn() { calls.push("interrupt"); },
        async steerTurn() { calls.push("steer"); },
      },
    });
    const iterator = execution.start(admission(controller.signal))[Symbol.asyncIterator]();
    let settled = false;
    const pending = iterator.next().then((result) => {
      settled = true;
      return result;
    });
    await openInvoked.promise;

    controller.abort();
    await Promise.resolve();
    await Promise.resolve();
    expect(settled).toBeFalse();

    opened.resolve({ id: "ordinary-session" });
    expect(await pending).toMatchObject({ done: true });
    expect(calls).toEqual(["open"]);
  });
});
