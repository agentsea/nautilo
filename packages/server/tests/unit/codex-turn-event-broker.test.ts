import { describe, expect, test } from "bun:test";
import type {
  RelayCodexClientMessage,
  RelayCodexEventMessage,
  RelayCodexStatusMessage,
} from "@nautilo/relay";
import {
  CodexTurnEventBroker,
  type CodexRelayTurnScope,
  type CodexRelayTurnSource,
} from "../../src/codex/turn-event-broker";

const scope: CodexRelayTurnScope = {
  relayId: "relay",
  relaySessionId: "relay-session",
  desktopSessionId: "desktop",
  pairingGenerationRef: "pairing",
  selectedProtocolVersion: 8,
  capabilityRevision: 1,
  profileHandle: "profile",
  profileGeneration: 2,
  accountGeneration: 3,
  runtimeGeneration: 4,
  childGeneration: 5,
  workspace: {
    workspaceRef: "workspace",
    revision: 1,
    fingerprint: "fingerprint",
    issuedAt: "2026-07-29T00:00:00.000Z",
    expiresAt: "2026-07-29T01:00:00.000Z",
  },
  bindingId: "binding",
  bindingGeneration: 6,
  taskId: "task",
  jobId: "job",
  threadId: "thread",
  turnId: "turn",
};

function createSource(): {
  source: CodexRelayTurnSource;
  emit(message: RelayCodexClientMessage): void;
  invalidate(): void;
} {
  let listener: ((relayId: string, message: RelayCodexClientMessage) => void) | null = null;
  let invalidation: ((relayId: string, errorCode: string) => void) | null = null;
  return {
    source: {
      onCodexMessage(next) {
        listener = next;
        return () => { listener = null; };
      },
      onCodexContextInvalidated(next) {
        invalidation = next;
        return () => { invalidation = null; };
      },
    },
    emit(message) { listener?.("relay", message); },
    invalidate() { invalidation?.("relay", "CODEX_RELAY_UNAVAILABLE"); },
  };
}

function event(
  input: RelayCodexEventMessage["event"],
  overrides: Record<string, unknown> = {},
): RelayCodexEventMessage {
  return {
    type: "relay:codex-event",
    scope: {
      ...scope,
      selectedProtocolVersion: 8,
      workspace: {
        workspaceRef: "workspace",
        revision: 1,
        fingerprint: "fingerprint",
        issuedAt: "2026-07-29T00:00:00.000Z",
        expiresAt: "2026-07-29T01:00:00.000Z",
      },
      eventId: "event",
      ...overrides,
    },
    eventSequence: 1,
    event: input,
  } as RelayCodexEventMessage;
}

function status(overrides: {
  readonly childGeneration?: number;
  readonly profileHandle?: string;
  readonly runtimeGeneration?: number;
  readonly workspaceState?: "bound" | "stale";
} = {}): RelayCodexStatusMessage {
  const workspace = overrides.workspaceState === "stale"
    ? { state: "stale" as const }
    : { state: "bound" as const, receipt: scope.workspace };
  return {
    type: "relay:codex-status",
    socket: {
      relayId: scope.relayId,
      relaySessionId: scope.relaySessionId,
      desktopSessionId: scope.desktopSessionId,
      pairingGenerationRef: scope.pairingGenerationRef,
      selectedProtocolVersion: 8,
    },
    capabilityRevision: scope.capabilityRevision,
    status: {
      state: "ready",
      runtimeGeneration: overrides.runtimeGeneration ?? scope.runtimeGeneration,
      runtime: { state: "ready" },
      workspace,
      profiles: [{
        profileHandle: overrides.profileHandle ?? scope.profileHandle,
        profileGeneration: scope.profileGeneration,
        accountGeneration: scope.accountGeneration,
        state: "signed_in",
        ...(overrides.childGeneration === undefined
          ? { childGeneration: scope.childGeneration }
          : { childGeneration: overrides.childGeneration }),
      }],
    },
  };
}

describe("CodexTurnEventBroker", () => {
  test("retains events received before start returns and keeps authority metadata beside the vendor turn", async () => {
    const { source, emit } = createSource();
    const broker = new CodexTurnEventBroker({ source });
    emit(event({ kind: "message_delta", text: "early", sequence: 1 }, { itemId: "item" }));
    emit(event({ kind: "message_delta", text: "second item", sequence: 2 }, {
      itemId: "second-item", eventId: "second-event",
    }));

    const events = broker.subscribe(scope)[Symbol.asyncIterator]();
    expect(await events.next()).toMatchObject({
      done: false,
      value: { event: { kind: "message_delta", text: "early" } },
    });
    expect(await events.next()).toMatchObject({
      done: false,
      value: {
        scope: { itemId: "second-item", eventId: "second-event" },
        event: { kind: "message_delta", text: "second item" },
      },
    });

    emit(event({
      kind: "turn_completed", status: "completed", itemsView: "full", assistantItems: [],
    }));
    expect(await events.next()).toMatchObject({
      done: false,
      value: { event: { kind: "turn_completed" } },
    });
    expect(await events.next()).toMatchObject({ done: true });
    broker.dispose();
  });

  test("rejects a second consumer and late events after terminal cleanup", async () => {
    const { source, emit } = createSource();
    const broker = new CodexTurnEventBroker({ source });
    const first = broker.subscribe(scope);
    expect(() => broker.subscribe(scope)).toThrow(
      expect.objectContaining({ code: "consumer_exists" }),
    );

    const iterator = first[Symbol.asyncIterator]();
    const waiting = iterator.next();
    emit(event({ kind: "turn_completed", status: "completed", itemsView: "full", assistantItems: [] }));
    expect(await waiting).toMatchObject({ done: false });
    expect(() => broker.subscribe(scope)).toThrow(
      expect.objectContaining({ code: "stale_generation" }),
    );
    emit(event({ kind: "message_delta", text: "late", sequence: 2 }, { itemId: "late" }));
    expect(await iterator.next()).toMatchObject({ done: true });
    broker.dispose();
  });

  test("retains an already-received terminal when Stop arrives before the consumer resumes", async () => {
    const { source, emit } = createSource();
    const broker = new CodexTurnEventBroker({ source });
    const controller = new AbortController();
    // This is the terminal-before-Stop ordering: the exact relay frame is
    // already in the broker, but execution has not yet consumed it.
    emit(event({ kind: "turn_completed", status: "completed", itemsView: "full", assistantItems: [] }));
    const subscription = broker.subscribe(scope, controller.signal);
    controller.abort();

    expect(subscription.terminalReceived).toBeTrue();
    const iterator = subscription[Symbol.asyncIterator]();
    expect(await iterator.next()).toMatchObject({
      done: false,
      value: { event: { kind: "turn_completed", status: "completed" } },
    });
    expect(await iterator.next()).toMatchObject({ done: true });
    broker.dispose();
  });

  test("does not deliver a request from a different admitted workspace", async () => {
    const { source, emit } = createSource();
    const broker = new CodexTurnEventBroker({ source });
    const iterator = broker.subscribe(scope)[Symbol.asyncIterator]();
    const waiting = iterator.next();
    emit(event({ kind: "message_delta", text: "wrong workspace", sequence: 1 }, {
      itemId: "item",
      workspace: { ...scope.workspace, fingerprint: "other-workspace" },
    }));
    emit(event({ kind: "message_delta", text: "right workspace", sequence: 2 }, {
      itemId: "item",
    }));
    expect(await waiting).toMatchObject({
      done: false,
      value: {
        event: { kind: "message_delta", text: "right workspace" },
      },
    });
    emit(event({ kind: "turn_completed", status: "completed", itemsView: "full", assistantItems: [] }));
    expect(await iterator.next()).toMatchObject({
      done: false,
      value: { event: { kind: "turn_completed" } },
    });
    broker.dispose();
  });

  test("preserves buffered event order when item-level metadata changes", async () => {
    const { source, emit } = createSource();
    const broker = new CodexTurnEventBroker({ source });
    emit(event({ kind: "message_delta", text: "old", sequence: 1 }, { itemId: "item" }));
    emit(event({ kind: "message_delta", text: "new", sequence: 1 }, {
      itemId: "new-item", eventId: "new-event",
    }));

    const events = broker.subscribe(scope)[Symbol.asyncIterator]();
    expect(await events.next()).toMatchObject({
      done: false,
      value: { event: { kind: "message_delta", text: "old" } },
    });
    expect(await events.next()).toMatchObject({
      done: false,
      value: {
        scope: { itemId: "new-item", eventId: "new-event" },
        event: { kind: "message_delta", text: "new" },
      },
    });
    broker.dispose();
  });

  test("tombstones a no-consumer stream evicted by the bounded inbox", () => {
    const { source, emit } = createSource();
    const broker = new CodexTurnEventBroker({ source, maxBufferedTurns: 1 });
    emit(event({ kind: "message_delta", text: "old", sequence: 1 }, { itemId: "item" }));
    emit(event({ kind: "message_delta", text: "other", sequence: 1 }, {
      itemId: "item", turnId: "other-turn",
    }));

    expect(() => broker.subscribe(scope)).toThrow(
      expect.objectContaining({ code: "stale_generation" }),
    );
    emit(event({ kind: "turn_completed", status: "completed", itemsView: "full", assistantItems: [] }));
    expect(() => broker.subscribe(scope)).toThrow(
      expect.objectContaining({ code: "stale_generation" }),
    );
    broker.dispose();
  });

  test("tombstones an overflowing cached pre-consumer turn", () => {
    const { source, emit } = createSource();
    const broker = new CodexTurnEventBroker({ source, maxEventsPerTurn: 1 });
    emit(event({ kind: "message_delta", text: "one", sequence: 1 }, { itemId: "item" }));
    emit(event({ kind: "message_delta", text: "two", sequence: 2 }, { itemId: "item" }));
    expect(() => broker.subscribe(scope)).toThrow(
      expect.objectContaining({ code: "stale_generation" }),
    );
    broker.dispose();
  });

  test("closes only a turn whose exact child generation disappears from host status", async () => {
    const { source, emit } = createSource();
    const broker = new CodexTurnEventBroker({ source });
    const siblingScope = {
      ...scope,
      profileHandle: "sibling",
      bindingId: "sibling-binding",
      taskId: "sibling-task",
      jobId: "sibling-job",
      threadId: "sibling-thread",
      turnId: "sibling-turn",
    };
    const dead = broker.subscribe(scope)[Symbol.asyncIterator]();
    const sibling = broker.subscribe(siblingScope)[Symbol.asyncIterator]();
    const deadPending = dead.next();
    const siblingPending = sibling.next();

    emit(status({ profileHandle: "sibling" }));

    expect(await deadPending).toMatchObject({ done: true });
    let siblingSettled = false;
    void siblingPending.then(() => { siblingSettled = true; });
    await Promise.resolve();
    expect(siblingSettled).toBeFalse();

    emit(event(
      { kind: "message_delta", text: "sibling alive", sequence: 1 },
      {
        profileHandle: "sibling",
        bindingId: "sibling-binding",
        taskId: "sibling-task",
        jobId: "sibling-job",
        threadId: "sibling-thread",
        turnId: "sibling-turn",
        itemId: "sibling-item",
      },
    ));
    expect(await siblingPending).toMatchObject({
      done: false,
      value: { event: { text: "sibling alive" } },
    });
    broker.dispose();
  });

  test("tombstones buffered turns when runtime or workspace authority changes", () => {
    const { source, emit } = createSource();
    const broker = new CodexTurnEventBroker({ source });
    emit(event({ kind: "message_delta", text: "buffered", sequence: 1 }, { itemId: "item" }));
    emit(status({ workspaceState: "stale" }));
    expect(() => broker.subscribe(scope)).toThrow(
      expect.objectContaining({ code: "stale_generation" }),
    );
    broker.dispose();
  });

  test("closes an active turn when its relay context is invalidated", async () => {
    const { source, invalidate } = createSource();
    const broker = new CodexTurnEventBroker({ source });
    const iterator = broker.subscribe(scope)[Symbol.asyncIterator]();
    const pending = iterator.next();

    invalidate();

    expect(await pending).toMatchObject({ done: true });
    broker.dispose();
  });

  test("expires only after a full inactivity lease since the latest accepted event", async () => {
    const { source, emit } = createSource();
    const timers = new Map<number, () => void>();
    let nextTimer = 0;
    const broker = new CodexTurnEventBroker({
      source,
      turnInactivityTimeoutMs: 10,
      timer: {
        setTimeout(callback) {
          const handle = ++nextTimer;
          timers.set(handle, callback);
          return handle;
        },
        clearTimeout(handle) {
          timers.delete(handle as number);
        },
      },
    });
    const subscription = broker.subscribe(scope);
    const iterator = subscription[Symbol.asyncIterator]();
    const firstLease = nextTimer;
    const first = iterator.next();

    emit(event({ kind: "message_delta", text: "alive", sequence: 1 }, { itemId: "item" }));
    expect(await first).toMatchObject({ done: false });
    expect(timers.has(firstLease)).toBeFalse();
    const secondLease = nextTimer;
    const pending = iterator.next();

    timers.get(secondLease)?.();

    expect(await pending).toMatchObject({ done: true });
    expect(subscription.inactivityExpired).toBeTrue();
    broker.dispose();
  });
});
