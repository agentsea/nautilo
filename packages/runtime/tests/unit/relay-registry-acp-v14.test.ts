import { describe, expect, spyOn, test } from "bun:test";
import type {
  AcpBindingScope,
  AcpExecutionScope,
  AcpProcessScope,
  RelayCapabilities,
  RelayServerMessage,
} from "@nautilo/relay";
import { InMemoryRelayRegistry } from "../../src/relay-registry";

const capabilities: RelayCapabilities = {
  profile: "desktop-agent",
  acp: { version: 1, hostKind: "electron", registrations: ["hermes-acp"] },
};
const binding: AcpBindingScope = {
  bindingId: "binding-1", bindingGeneration: "generation-1", ownerId: "owner-1",
  taskId: "task-1", taskRunId: "run-1", jobId: "job-1", profileId: "profile-1",
  profileGeneration: "profile-generation-1", postureId: "posture-1", postureGeneration: "posture-generation-1",
};
const process: AcpProcessScope = {
  connectionId: "connection-1", processGeneration: 1, acpSessionId: "acp-session-1",
  turnGeneration: 1, turnRef: "turn-1",
};

async function preparedTurn(registry: InMemoryRelayRegistry, sent: RelayServerMessage[]): Promise<AcpExecutionScope> {
  const prepare = registry.requestAcpPrepare({ relayId: "relay-1", userId: "owner-1", requestId: "prepare-1", binding });
  const command = sent.pop();
  if (!command || command.type !== "relay:acp-prepare") throw new Error("prepare command missing");
  const workspace = {
    workspaceReceiptId: "receipt-1", workspaceRevision: "revision-1", workspaceFingerprint: "fingerprint-1",
    workspaceExpiresAt: "2030-01-01T00:00:00.000Z",
  } as const;
  expect(registry.acceptAcpMessage({
    relayId: "relay-1", userId: "owner-1",
    message: { type: "relay:acp-prepared", requestId: command.requestId, registrationId: "hermes-acp", scope: command.scope, binding: command.binding, workspace },
  })).toEqual({ ok: true });
  expect(await prepare).toEqual(workspace);
  return { socket: command.scope, binding: command.binding, workspace };
}

async function startedTurn(registry: InMemoryRelayRegistry, sent: RelayServerMessage[]): Promise<AcpExecutionScope> {
  const scope = await preparedTurn(registry, sent);
  const start = registry.requestAcpStart({ relayId: "relay-1", userId: "owner-1", scope, prompt: "Edit one file" });
  const command = sent.pop();
  if (!command || command.type !== "relay:acp-start") throw new Error("start command missing");
  expect(registry.acceptAcpMessage({
    relayId: "relay-1", userId: "owner-1",
    message: { type: "relay:acp-started", registrationId: "hermes-acp", scope: command.scope, process, capabilities: { requests: "unsupported" }, eventId: "event-1", eventSequence: 1 },
  })).toEqual({ ok: true });
  expect(await start).toMatchObject({ process, eventSequence: 1 });
  return scope;
}

function semantic(scope: AcpExecutionScope, eventId: string, eventSequence: number, text = "Working", vendorItemId: string | null = null) {
  return {
    type: "relay:acp-semantic" as const, registrationId: "hermes-acp" as const, scope, process,
    capabilities: { requests: "unsupported" as const }, eventId, eventSequence,
    payload: { kind: "output_delta" as const, vendorItemId, text },
  };
}

function commandSummary(
  scope: AcpExecutionScope,
  eventId: string,
  eventSequence: number,
  vendorItemId: string,
  status: "running" | "completed",
) {
  return {
    type: "relay:acp-semantic" as const, registrationId: "hermes-acp" as const, scope, process,
    capabilities: { requests: "unsupported" as const }, eventId, eventSequence,
    payload: { kind: "command_summary" as const, vendorItemId, commands: [{ summary: `tool ${vendorItemId}`, status }] },
  };
}

describe("D452 InMemoryRelayRegistry ACP v14 bounded transport", () => {
  test("faults every exact malformed-event branch once while wrong scope and completed winners remain untouched", async () => {
    const cases: Array<Readonly<{ name: string; options?: ConstructorParameters<typeof InMemoryRelayRegistry>[0]; sequence?: number; act(registry: InMemoryRelayRegistry, scope: AcpExecutionScope): void }>> = [
      { name: "duplicate ID", act: (registry, scope) => { registry.acceptAcpMessage({ relayId: "relay-1", userId: "owner-1", message: semantic(scope, "event-1", 2) }); } },
      { name: "sequence replay", act: (registry, scope) => { registry.acceptAcpMessage({ relayId: "relay-1", userId: "owner-1", message: semantic(scope, "event-2", 1) }); } },
      { name: "sequence gap", act: (registry, scope) => { registry.acceptAcpMessage({ relayId: "relay-1", userId: "owner-1", message: semantic(scope, "event-3", 3) }); } },
      { name: "capability mismatch", act: (registry, scope) => { registry.acceptAcpMessage({ relayId: "relay-1", userId: "owner-1", message: { ...semantic(scope, "event-2", 2), capabilities: { requests: "supported" } } }); } },
      { name: "oversize", act: (registry, scope) => { registry.acceptAcpMessage({ relayId: "relay-1", userId: "owner-1", message: semantic(scope, "event-2", 2, "x".repeat(2 * 1024 * 1024)) }); } },
      { name: "retained N plus one", options: { acpEventQueueMaxEntries: 1 }, sequence: 3, act: (registry, scope) => { registry.acceptAcpMessage({ relayId: "relay-1", userId: "owner-1", message: commandSummary(scope, "event-2", 2, "tool-a", "running") }); registry.acceptAcpMessage({ relayId: "relay-1", userId: "owner-1", message: commandSummary(scope, "event-3", 3, "tool-b", "running") }); } },
    ];
    for (const item of cases) {
      const registry = new InMemoryRelayRegistry(item.options);
      const sent: RelayServerMessage[] = [];
      await registry.register("relay-1", "owner-1", capabilities, (message) => sent.push(message), 14, "desktop-1", 2, "pair-1");
      const scope = await startedTurn(registry, sent);
      item.act(registry, scope);
      const subscription = registry.subscribeAcpExecution(scope, process);
      if (!subscription) throw new Error(`missing terminal subscription for ${item.name}`);
      expect(await subscription.next()).toMatchObject({ type: "relay:acp-terminal", status: "failed", code: "upstream_failure", eventSequence: item.sequence ?? 2 });
      expect(sent.filter((message) => message.type === "relay:acp-contain")).toHaveLength(1);
    }

    const wrong = new InMemoryRelayRegistry();
    const sent: RelayServerMessage[] = [];
    await wrong.register("relay-1", "owner-1", capabilities, (message) => sent.push(message), 14, "desktop-1", 2, "pair-1");
    const scope = await startedTurn(wrong, sent);
    expect(wrong.acceptAcpMessage({ relayId: "relay-1", userId: "owner-1", message: semantic({ ...scope, binding: { ...scope.binding, bindingId: "sibling" } }, "wrong", 2) })).toEqual({ ok: false, error: "ACP_CORRELATION_REPLAY" });
    expect(sent.filter((message) => message.type === "relay:acp-contain")).toHaveLength(0);
    const completed = { type: "relay:acp-terminal" as const, registrationId: "hermes-acp" as const, scope, process, status: "completed" as const, eventId: "done", eventSequence: 2 };
    expect(wrong.acceptAcpMessage({ relayId: "relay-1", userId: "owner-1", message: completed })).toEqual({ ok: true });
    expect(wrong.containAcpExecution(scope, process)).toBeFalse();
  });

  test("contains one exact broker turn with a stable synthetic failure and one opaque contain command", async () => {
    const registry = new InMemoryRelayRegistry();
    const sent: RelayServerMessage[] = [];
    await registry.register("relay-1", "owner-1", capabilities, (message) => sent.push(message), 14, "desktop-1", 2, "pair-1");
    const scope = await startedTurn(registry, sent);
    const subscription = registry.subscribeAcpExecution(scope, process);
    if (!subscription) throw new Error("subscription missing");
    const waiting = subscription.next();
    expect(registry.containAcpExecution(scope, process)).toBeTrue();
    expect(registry.containAcpExecution(scope, process)).toBeFalse();
    const terminal = await waiting;
    expect(terminal).toMatchObject({ type: "relay:acp-terminal", status: "failed", code: "upstream_failure", eventSequence: 2 });
    const contain = sent.at(-1);
    expect(contain).toMatchObject({ type: "relay:acp-contain", registrationId: "hermes-acp", scope, process, code: "upstream_failure" });
    expect(JSON.stringify(contain)).not.toContain("prompt");
    expect(registry.acceptAcpMessage({ relayId: "relay-1", userId: "owner-1", message: semantic(scope, "late", 2) }))
      .toEqual({ ok: false, error: "ACP_TERMINAL_FENCED" });
    subscription.acknowledge(terminal!.eventId, terminal!.eventSequence);
  });

  test("fails closed on a second exact started frame and contains that one active turn", async () => {
    const registry = new InMemoryRelayRegistry();
    const sent: RelayServerMessage[] = [];
    await registry.register("relay-1", "owner-1", capabilities, (message) => sent.push(message), 14, "desktop-1", 2, "pair-1");
    const scope = await startedTurn(registry, sent);
    const subscription = registry.subscribeAcpExecution(scope, process);
    if (!subscription) throw new Error("subscription missing");
    expect(registry.acceptAcpMessage({ relayId: "relay-1", userId: "owner-1", message: { type: "relay:acp-started", registrationId: "hermes-acp", scope, process, capabilities: { requests: "unsupported" }, eventId: "event-1", eventSequence: 1 } }))
      .toEqual({ ok: false, error: "ACP_CORRELATION_REPLAY" });
    expect(await subscription.next()).toMatchObject({ type: "relay:acp-terminal", status: "failed", code: "upstream_failure" });
    expect(sent.filter((message) => message.type === "relay:acp-contain")).toHaveLength(1);
  });

  test("bounds a pre-subscriber synthetic terminal and restores turn capacity at retention expiry", async () => {
    type Timer = { delay: number; callback: () => void };
    const timers: Timer[] = [];
    const setTimer = spyOn(globalThis, "setTimeout").mockImplementation(((callback: (...args: unknown[]) => void, delay?: number) => {
      const timer = { delay: typeof delay === "number" ? delay : 0, callback: () => callback() };
      timers.push(timer);
      return timer as unknown as ReturnType<typeof setTimeout>;
    }) as typeof setTimeout);
    const clearTimer = spyOn(globalThis, "clearTimeout").mockImplementation(() => undefined);
    try {
      const registry = new InMemoryRelayRegistry({ acpMaxTurns: 1 });
      const sent: RelayServerMessage[] = [];
      await registry.register("relay-1", "owner-1", capabilities, (message) => sent.push(message), 14, "desktop-1", 2, "pair-1");
      const scope = await startedTurn(registry, sent);
      expect(registry.containAcpExecution(scope, process)).toBeTrue();
      const retention = timers.filter((timer) => timer.delay === 15_000).at(-1);
      if (!retention) throw new Error("missing containment retention timer");
      retention.callback();
      expect(registry.subscribeAcpExecution(scope, process)).toBeNull();
      await startedTurn(registry, sent); // exact max-turn capacity recovered
    } finally {
      setTimer.mockRestore();
      clearTimer.mockRestore();
    }
  });

  test("bounds a normal completed terminal before subscription and preserves its terminal acknowledgement", async () => {
    type Timer = { delay: number; callback: () => void };
    const timers: Timer[] = [];
    const setTimer = spyOn(globalThis, "setTimeout").mockImplementation(((callback: (...args: unknown[]) => void, delay?: number) => {
      const timer = { delay: typeof delay === "number" ? delay : 0, callback: () => callback() };
      timers.push(timer);
      return timer as unknown as ReturnType<typeof setTimeout>;
    }) as typeof setTimeout);
    const clearTimer = spyOn(globalThis, "clearTimeout").mockImplementation(() => undefined);
    try {
      const registry = new InMemoryRelayRegistry({ acpMaxTurns: 1 });
      const sent: RelayServerMessage[] = [];
      await registry.register("relay-1", "owner-1", capabilities, (message) => sent.push(message), 14, "desktop-1", 2, "pair-1");
      const scope = await startedTurn(registry, sent);
      const terminal = { type: "relay:acp-terminal" as const, registrationId: "hermes-acp" as const, scope, process, status: "completed" as const, eventId: "done", eventSequence: 2 };
      expect(registry.acceptAcpMessage({ relayId: "relay-1", userId: "owner-1", message: terminal })).toEqual({ ok: true });
      const subscriber = registry.subscribeAcpExecution(scope, process);
      if (!subscriber) throw new Error("missing terminal subscriber");
      expect(await subscriber.next()).toEqual(terminal);
      subscriber.acknowledge("done", 2);
      await startedTurn(registry, sent);
    } finally { setTimer.mockRestore(); clearTimer.mockRestore(); }
  });

  test("requires a pending exact binding/job/turn owner, then projects ordered semantic data", async () => {
    const registry = new InMemoryRelayRegistry();
    const sent: RelayServerMessage[] = [];
    await registry.register("relay-1", "owner-1", capabilities, (message) => sent.push(message), 14, "desktop-1", 2, "pair-1");
    const scope = await startedTurn(registry, sent);
    const subscription = registry.subscribeAcpExecution(scope, process);
    if (!subscription) throw new Error("subscription missing");
    const event = semantic(scope, "event-2", 2);
    const wrongJobScope: AcpExecutionScope = { ...scope, binding: { ...scope.binding, jobId: "job-2" } };
    expect(registry.acceptAcpMessage({ relayId: "relay-1", userId: "owner-1", message: semantic(wrongJobScope, "event-2", 2) }))
      .toEqual({ ok: false, error: "ACP_CORRELATION_REPLAY" });
    expect(registry.acceptAcpMessage({ relayId: "relay-1", userId: "owner-1", message: event })).toEqual({ ok: true });
    expect(await subscription.next()).toEqual(event);
    subscription.acknowledge("event-2", 2);
  });

  test("permits identical payloads at distinct monotonic sequence numbers and fences after one terminal", async () => {
    const registry = new InMemoryRelayRegistry();
    const sent: RelayServerMessage[] = [];
    await registry.register("relay-1", "owner-1", capabilities, (message) => sent.push(message), 14, "desktop-1", 2, "pair-1");
    const scope = await startedTurn(registry, sent);
    expect(registry.acceptAcpMessage({ relayId: "relay-1", userId: "owner-1", message: semantic(scope, "event-2", 2, "same") })).toEqual({ ok: true });
    expect(registry.acceptAcpMessage({ relayId: "relay-1", userId: "owner-1", message: semantic(scope, "event-3", 3, "same") })).toEqual({ ok: true });
    const terminal = { type: "relay:acp-terminal" as const, registrationId: "hermes-acp" as const, scope, process, status: "completed" as const, eventId: "event-4", eventSequence: 4 };
    expect(registry.acceptAcpMessage({ relayId: "relay-1", userId: "owner-1", message: terminal })).toEqual({ ok: true });
    expect(registry.acceptAcpMessage({ relayId: "relay-1", userId: "owner-1", message: semantic(scope, "event-5", 5) }))
      .toEqual({ ok: false, error: "ACP_TERMINAL_FENCED" });
  });

  test("applies N/N+1 count and in-flight byte backpressure", async () => {
    const registry = new InMemoryRelayRegistry({ acpEventQueueMaxEntries: 2, acpEventQueueMaxBytes: 10_000 });
    const sent: RelayServerMessage[] = [];
    await registry.register("relay-1", "owner-1", capabilities, (message) => sent.push(message), 14, "desktop-1", 2, "pair-1");
    const scope = await startedTurn(registry, sent);
    const subscription = registry.subscribeAcpExecution(scope, process);
    if (!subscription) throw new Error("subscription missing");
    const second = commandSummary(scope, "event-2", 2, "tool-a", "running");
    const third = commandSummary(scope, "event-3", 3, "tool-b", "running");
    expect(registry.acceptAcpMessage({ relayId: "relay-1", userId: "owner-1", message: second })).toEqual({ ok: true });
    expect(registry.acceptAcpMessage({ relayId: "relay-1", userId: "owner-1", message: third })).toEqual({ ok: true });
    expect(await subscription.next()).toEqual(second); // handed but unacknowledged remains in the bound
    expect(registry.acceptAcpMessage({ relayId: "relay-1", userId: "owner-1", message: commandSummary(scope, "event-4", 4, "tool-c", "running") }))
      .toEqual({ ok: false, error: "ACP_BACKPRESSURE" });
    subscription.acknowledge("event-2", 2);
    expect(await subscription.next()).toMatchObject({ type: "relay:acp-terminal", status: "failed", code: "upstream_failure", eventSequence: 4 });
  });

  test("coalesces only queued same-item provisional updates while preserving distinct and in-flight bounds", async () => {
    const registry = new InMemoryRelayRegistry({ acpEventQueueMaxEntries: 2, acpEventQueueMaxBytes: 10_000 });
    const sent: RelayServerMessage[] = [];
    await registry.register("relay-1", "owner-1", capabilities, (message) => sent.push(message), 14, "desktop-1", 2, "pair-1");
    const scope = await startedTurn(registry, sent);
    const subscription = registry.subscribeAcpExecution(scope, process);
    if (!subscription) throw new Error("subscription missing");

    const handed = commandSummary(scope, "event-2", 2, "tool-a", "running");
    expect(registry.acceptAcpMessage({ relayId: "relay-1", userId: "owner-1", message: handed })).toEqual({ ok: true });
    expect(await subscription.next()).toEqual(handed);

    expect(registry.acceptAcpMessage({ relayId: "relay-1", userId: "owner-1", message: commandSummary(scope, "event-3", 3, "tool-b", "running") })).toEqual({ ok: true });
    const latest = commandSummary(scope, "event-4", 4, "tool-b", "completed");
    expect(registry.acceptAcpMessage({ relayId: "relay-1", userId: "owner-1", message: latest })).toEqual({ ok: true });
    expect(registry.acceptAcpMessage({ relayId: "relay-1", userId: "owner-1", message: commandSummary(scope, "event-5", 5, "tool-c", "running") }))
      .toEqual({ ok: false, error: "ACP_BACKPRESSURE" });

    subscription.acknowledge(handed.eventId, handed.eventSequence);
    expect(await subscription.next()).toMatchObject({ type: "relay:acp-terminal", status: "failed", code: "upstream_failure", eventSequence: 5 });
  });

  test("keeps a long same-item provisional burst bounded without losing its latest state", async () => {
    const registry = new InMemoryRelayRegistry({ acpEventQueueMaxEntries: 2, acpEventQueueMaxBytes: 10_000 });
    const sent: RelayServerMessage[] = [];
    await registry.register("relay-1", "owner-1", capabilities, (message) => sent.push(message), 14, "desktop-1", 2, "pair-1");
    const scope = await startedTurn(registry, sent);
    for (let sequence = 2; sequence <= 178; sequence += 1) {
      expect(registry.acceptAcpMessage({
        relayId: "relay-1", userId: "owner-1",
        message: semantic(scope, `event-${sequence}`, sequence, `chunk-${sequence}`, "assistant-stream-1"),
      })).toEqual({ ok: true });
    }
    const subscription = registry.subscribeAcpExecution(scope, process);
    if (!subscription) throw new Error("subscription missing");
    expect(await subscription.next()).toEqual(semantic(scope, "event-178", 178, "chunk-178", "assistant-stream-1"));
    subscription.acknowledge("event-178", 178);
  });

  test("coalesces one prompt's queued text stream even when the provider rotates message IDs", async () => {
    const registry = new InMemoryRelayRegistry({ acpEventQueueMaxEntries: 2, acpEventQueueMaxBytes: 10_000 });
    const sent: RelayServerMessage[] = [];
    await registry.register("relay-1", "owner-1", capabilities, (message) => sent.push(message), 14, "desktop-1", 2, "pair-1");
    const scope = await startedTurn(registry, sent);
    for (let sequence = 2; sequence <= 178; sequence += 1) {
      expect(registry.acceptAcpMessage({
        relayId: "relay-1", userId: "owner-1",
        message: semantic(scope, `event-${sequence}`, sequence, `chunk-${sequence}`, `message-${sequence}`),
      })).toEqual({ ok: true });
    }
    const subscription = registry.subscribeAcpExecution(scope, process);
    if (!subscription) throw new Error("subscription missing");
    expect(await subscription.next()).toEqual(semantic(scope, "event-178", 178, "chunk-178", "message-178"));
    subscription.acknowledge("event-178", 178);
  });

  test("keeps the pre-subscriber limit for 177 distinct command items", async () => {
    const registry = new InMemoryRelayRegistry({ acpEventQueueMaxEntries: 128, acpEventQueueMaxBytes: 1024 * 1024 });
    const sent: RelayServerMessage[] = [];
    await registry.register("relay-1", "owner-1", capabilities, (message) => sent.push(message), 14, "desktop-1", 2, "pair-1");
    const scope = await preparedTurn(registry, sent);
    const start = registry.requestAcpStart({ relayId: "relay-1", userId: "owner-1", scope, prompt: "work" });
    const command = sent.pop();
    if (!command || command.type !== "relay:acp-start") throw new Error("start command missing");
    expect(registry.acceptAcpMessage({ relayId: "relay-1", userId: "owner-1", message: { type: "relay:acp-started", registrationId: "hermes-acp", scope, process, capabilities: { requests: "unsupported" }, eventId: "started", eventSequence: 1 } })).toEqual({ ok: true });
    await start;
    const results = Array.from({ length: 177 }, (_, index) => registry.acceptAcpMessage({
      relayId: "relay-1", userId: "owner-1", message: commandSummary(scope, `burst-${index + 2}`, index + 2, `tool-${index + 2}`, "running"),
    }));
    expect(results.filter((result) => result.ok)).toHaveLength(128);
    expect(results[128]).toEqual({ ok: false, error: "ACP_BACKPRESSURE" });
    const subscription = registry.subscribeAcpExecution(scope, process);
    if (!subscription) throw new Error("missing terminal subscription");
    expect(await subscription.next()).toMatchObject({ type: "relay:acp-terminal", status: "failed", code: "upstream_failure", eventSequence: 130 });
  });

  test("can emit 177 acknowledged events before a later distinct-command backlog faults", async () => {
    const registry = new InMemoryRelayRegistry({ acpEventQueueMaxEntries: 128, acpEventQueueMaxBytes: 1024 * 1024 });
    const sent: RelayServerMessage[] = [];
    await registry.register("relay-1", "owner-1", capabilities, (message) => sent.push(message), 14, "desktop-1", 2, "pair-1");
    const scope = await startedTurn(registry, sent);
    const subscription = registry.subscribeAcpExecution(scope, process);
    if (!subscription) throw new Error("subscription missing");
    for (let sequence = 2; sequence <= 178; sequence += 1) {
      const event = semantic(scope, `drained-${sequence}`, sequence);
      expect(registry.acceptAcpMessage({ relayId: "relay-1", userId: "owner-1", message: event })).toEqual({ ok: true });
      expect(await subscription.next()).toEqual(event);
      subscription.acknowledge(event.eventId, event.eventSequence);
    }
    for (let sequence = 179; sequence <= 306; sequence += 1) {
      expect(registry.acceptAcpMessage({ relayId: "relay-1", userId: "owner-1", message: commandSummary(scope, `backlog-${sequence}`, sequence, `tool-${sequence}`, "running") })).toEqual({ ok: true });
    }
    expect(registry.acceptAcpMessage({ relayId: "relay-1", userId: "owner-1", message: commandSummary(scope, "backlog-307", 307, "tool-307", "running") }))
      .toEqual({ ok: false, error: "ACP_BACKPRESSURE" });
    expect(await subscription.next()).toMatchObject({ type: "relay:acp-terminal", status: "failed", code: "upstream_failure", eventSequence: 307 });
  });

  test("invalidates pending execution ownership on reconnect and keeps v13 readiness-only", async () => {
    const registry = new InMemoryRelayRegistry();
    const sent: RelayServerMessage[] = [];
    await registry.register("relay-1", "owner-1", capabilities, (message) => sent.push(message), 14, "desktop-1", 2, "pair-1");
    const scope = await preparedTurn(registry, sent);
    await registry.register("relay-1", "owner-1", capabilities, () => undefined, 14, "desktop-1", 3, "pair-2");
    await expectFailure(registry.requestAcpStart({ relayId: "relay-1", userId: "owner-1", scope, prompt: "x" }), "ACP_CONTEXT_STALE");
    await registry.register("relay-2", "owner-1", capabilities, () => undefined, 13, "desktop-2", 0, "pair-2");
    await expectFailure(registry.requestAcpPrepare({ relayId: "relay-2", userId: "owner-1", requestId: "v13", binding }), "ACP_RELAY_UNAVAILABLE");
  });

  test("reconnect wakes an active exact subscriber with one stable fault and no containment command", async () => {
    const registry = new InMemoryRelayRegistry();
    const sent: RelayServerMessage[] = [];
    await registry.register("relay-1", "owner-1", capabilities, (message) => sent.push(message), 14, "desktop-1", 2, "pair-1");
    const scope = await startedTurn(registry, sent);
    const subscription = registry.subscribeAcpExecution(scope, process);
    if (!subscription) throw new Error("subscription missing");
    const waiting = subscription.next();
    await registry.register("relay-1", "owner-1", capabilities, (message) => sent.push(message), 14, "desktop-1", 3, "pair-2");
    expect(await waiting).toMatchObject({ type: "relay:acp-terminal", status: "failed", code: "upstream_failure" });
    expect(sent.some((message) => message.type === "relay:acp-contain")).toBeFalse();
  });

  test("admits only one subscriber ever, rejects concurrent next, and retires a closed terminal turn", async () => {
    const registry = new InMemoryRelayRegistry({ acpMaxTurns: 1 });
    const sent: RelayServerMessage[] = [];
    await registry.register("relay-1", "owner-1", capabilities, (message) => sent.push(message), 14, "desktop-1", 2, "pair-1");
    const scope = await startedTurn(registry, sent);
    const subscription = registry.subscribeAcpExecution(scope, process);
    if (!subscription) throw new Error("subscription missing");
    const waiting = subscription.next();
    await expectFailure(subscription.next(), "ACP_SUBSCRIPTION_NEXT_CONCURRENT");
    subscription.close();
    expect(await waiting).toBeNull();
    expect(registry.subscribeAcpExecution(scope, process)).toBeNull();
    expect(registry.acceptAcpMessage({ relayId: "relay-1", userId: "owner-1", message: semantic(scope, "event-2", 2) }))
      .toEqual({ ok: false, error: "ACP_BACKPRESSURE" });
    // Fault containment releases the closed no-subscriber turn immediately.
    await startedTurn(registry, sent);
  });

  test("retains a terminal that races before the sole subscriber and retires after its acknowledgement", async () => {
    const registry = new InMemoryRelayRegistry({ acpMaxTurns: 1 });
    const sent: RelayServerMessage[] = [];
    await registry.register("relay-1", "owner-1", capabilities, (message) => sent.push(message), 14, "desktop-1", 2, "pair-1");
    const scope = await startedTurn(registry, sent);
    const terminal = { type: "relay:acp-terminal" as const, registrationId: "hermes-acp" as const, scope, process, status: "completed" as const, eventId: "event-2", eventSequence: 2 };
    expect(registry.acceptAcpMessage({ relayId: "relay-1", userId: "owner-1", message: terminal })).toEqual({ ok: true });
    const subscription = registry.subscribeAcpExecution(scope, process);
    if (!subscription) throw new Error("terminal subscription missing");
    expect(await subscription.next()).toEqual(terminal);
    subscription.acknowledge("event-2", 2);
    expect(registry.subscribeAcpExecution(scope, process)).toBeNull();
    await startedTurn(registry, sent);
  });

  test("correlates equal strict scopes independent of object insertion order and rejects malformed binding input before send", async () => {
    const registry = new InMemoryRelayRegistry();
    const sent: RelayServerMessage[] = [];
    await registry.register("relay-1", "owner-1", capabilities, (message) => sent.push(message), 14, "desktop-1", 2, "pair-1");
    await expectFailure(registry.requestAcpPrepare({
      relayId: "relay-1", userId: "owner-1", requestId: "bad-binding",
      binding: { ...binding, bindingId: "bad\0binding" } as AcpBindingScope,
    }), "ACP_REQUEST_INVALID");
    expect(sent).toHaveLength(0);
    const scope = await preparedTurn(registry, sent);
    const reordered: AcpExecutionScope = {
      workspace: { workspaceExpiresAt: scope.workspace.workspaceExpiresAt, workspaceFingerprint: scope.workspace.workspaceFingerprint, workspaceRevision: scope.workspace.workspaceRevision, workspaceReceiptId: scope.workspace.workspaceReceiptId },
      binding: { postureGeneration: scope.binding.postureGeneration, postureId: scope.binding.postureId, profileGeneration: scope.binding.profileGeneration, profileId: scope.binding.profileId, jobId: scope.binding.jobId, taskRunId: scope.binding.taskRunId, taskId: scope.binding.taskId, ownerId: scope.binding.ownerId, bindingGeneration: scope.binding.bindingGeneration, bindingId: scope.binding.bindingId },
      socket: { capabilityRevision: scope.socket.capabilityRevision, selectedProtocolVersion: scope.socket.selectedProtocolVersion, pairingGenerationRef: scope.socket.pairingGenerationRef, desktopSessionId: scope.socket.desktopSessionId, relaySessionId: scope.socket.relaySessionId, relayId: scope.socket.relayId },
    };
    const start = registry.requestAcpStart({ relayId: "relay-1", userId: "owner-1", scope: reordered, prompt: "work" });
    const command = sent.pop();
    if (!command || command.type !== "relay:acp-start") throw new Error("canonical start command missing");
    expect(registry.acceptAcpMessage({ relayId: "relay-1", userId: "owner-1", message: { type: "relay:acp-started", registrationId: "hermes-acp", scope: command.scope, process, capabilities: { requests: "unsupported" }, eventId: "event-1", eventSequence: 1 } })).toEqual({ ok: true });
    await start;
  });

  test("holds correlations for their owned operation envelopes", async () => {
    type FakeTimer = { readonly callback: () => void; readonly delay: number; fired: boolean };
    const timers: FakeTimer[] = [];
    const setTimer = spyOn(globalThis, "setTimeout").mockImplementation(((callback: (...args: unknown[]) => void, delay?: number) => {
      const timer: FakeTimer = {
        callback: () => callback(),
        delay: typeof delay === "number" ? delay : 0,
        fired: false,
      };
      timers.push(timer);
      return timer as unknown as ReturnType<typeof setTimeout>;
    }) as typeof setTimeout);
    const clearTimer = spyOn(globalThis, "clearTimeout").mockImplementation(() => undefined);
    try {
      const registry = new InMemoryRelayRegistry();
      const sent: RelayServerMessage[] = [];
      await registry.register("relay-1", "owner-1", capabilities, (message) => sent.push(message), 14, "desktop-1", 2, "pair-1");

      const readinessTimerIndex = timers.length;
      const readiness = registry.requestAcpReadiness({
        relayId: "relay-1", userId: "owner-1", requestId: "cold-readiness", registrationId: "hermes-acp",
      });
      const readinessCommand = sent.pop();
      if (!readinessCommand || readinessCommand.type !== "relay:acp-readiness") throw new Error("readiness command missing");
      expect(timers.slice(readinessTimerIndex).map((timer) => timer.delay)).toEqual([10_000]);
      expect(registry.acceptAcpMessage({
        relayId: "relay-1", userId: "owner-1",
        message: { ...readinessCommand, type: "relay:acp-readiness-result", state: "ready" },
      })).toEqual({ ok: true });
      await readiness;

      const scope = await preparedTurn(registry, sent);
      const startTimerIndex = timers.length;
      const start = registry.requestAcpStart({ relayId: "relay-1", userId: "owner-1", scope, prompt: "work" });
      const command = sent.pop();
      if (!command || command.type !== "relay:acp-start") throw new Error("start command missing");
      let settled = false;
      void start.finally(() => { settled = true; }).catch(() => undefined);
      const startTimers = timers.slice(startTimerIndex);
      for (const timer of startTimers.filter((candidate) => candidate.delay <= 5_000)) {
        timer.fired = true;
        timer.callback();
      }
      await Promise.resolve();
      expect(settled).toBeFalse();
      expect(startTimers.map((timer) => timer.delay)).toEqual([15_000]);
      expect(registry.acceptAcpMessage({
        relayId: "relay-1", userId: "owner-1",
        message: { type: "relay:acp-started", registrationId: "hermes-acp", scope: command.scope, process, capabilities: { requests: "unsupported" }, eventId: "event-timeout-1", eventSequence: 1 },
      })).toEqual({ ok: true });
      await start;

      await expectFailure(registry.requestAcpStart({ relayId: "relay-1", userId: "owner-1", scope, prompt: "work", timeoutMs: 5_000 }), "ACP_REQUEST_INVALID");
      await expectFailure(registry.requestAcpStart({ relayId: "relay-1", userId: "owner-1", scope, prompt: "work", timeoutMs: 15_001 }), "ACP_REQUEST_INVALID");
      await expectFailure(registry.requestAcpPrepare({ relayId: "relay-1", userId: "owner-1", requestId: "prepare-too-slow", binding, timeoutMs: 5_001 }), "ACP_REQUEST_INVALID");
      await expectFailure(registry.requestAcpReadiness({ relayId: "relay-1", userId: "owner-1", requestId: "readiness-too-slow", registrationId: "hermes-acp", timeoutMs: 10_001 }), "ACP_REQUEST_INVALID");

      const expiryRegistry = new InMemoryRelayRegistry();
      const expirySent: RelayServerMessage[] = [];
      await expiryRegistry.register("relay-1", "owner-1", capabilities, (message) => expirySent.push(message), 14, "desktop-1", 2, "pair-1");
      const expiryScope = await preparedTurn(expiryRegistry, expirySent);
      const expiryTimerIndex = timers.length;
      const expires = expiryRegistry.requestAcpStart({ relayId: "relay-1", userId: "owner-1", scope: expiryScope, prompt: "work", timeoutMs: 15_000 });
      const expiryTimer = timers.slice(expiryTimerIndex).at(-1);
      if (!expiryTimer || expiryTimer.delay !== 15_000) throw new Error("15s start timer missing");
      expiryTimer.fired = true;
      expiryTimer.callback();
      await expectFailure(expires, "ACP_TIMEOUT");
    } finally {
      setTimer.mockRestore();
      clearTimer.mockRestore();
    }
  });

  test("frees acknowledged delivery capacity beyond N and requires a composite acknowledgement", async () => {
    const registry = new InMemoryRelayRegistry({ acpEventQueueMaxEntries: 1, acpEventQueueMaxBytes: 10_000 });
    const sent: RelayServerMessage[] = [];
    await registry.register("relay-1", "owner-1", capabilities, (message) => sent.push(message), 14, "desktop-1", 2, "pair-1");
    const scope = await startedTurn(registry, sent);
    const subscription = registry.subscribeAcpExecution(scope, process);
    if (!subscription) throw new Error("subscription missing");
    for (const [eventId, eventSequence] of [["event-a", 2], ["event-b", 3], ["event-c", 4]] as const) {
      const event = semantic(scope, eventId, eventSequence);
      expect(registry.acceptAcpMessage({ relayId: "relay-1", userId: "owner-1", message: event })).toEqual({ ok: true });
      expect(await subscription.next()).toEqual(event);
      subscription.acknowledge(eventId, eventSequence);
    }
    const reused = semantic(scope, "event-a", 5);
    expect(registry.acceptAcpMessage({ relayId: "relay-1", userId: "owner-1", message: reused })).toEqual({ ok: true });
    expect(await subscription.next()).toEqual(reused);
    subscription.acknowledge("event-a", 2); // stale composite must not release the active sequence 5 item
    expect(registry.acceptAcpMessage({ relayId: "relay-1", userId: "owner-1", message: semantic(scope, "event-d", 6) }))
      .toEqual({ ok: false, error: "ACP_BACKPRESSURE" });
    subscription.acknowledge("event-a", 5);
    expect(await subscription.next()).toMatchObject({ type: "relay:acp-terminal", status: "failed", code: "upstream_failure", eventSequence: 6 });
  });
});

async function expectFailure(promise: Promise<unknown>, message: string): Promise<void> {
  let failure: unknown;
  try { await promise; } catch (error) { failure = error; }
  expect(failure).toMatchObject({ message });
}
