import { describe, expect, spyOn, test } from "bun:test";
import type {
  AcpBindingScope,
  AcpExecutionProfile,
  AcpExecutionScope,
  AcpProcessScope,
  AcpRegistrationId,
  RelayCapabilities,
  RelayServerMessage,
} from "@nautilo/relay";
import { InMemoryRelayRegistry } from "../../src/relay-registry";

const capabilities: RelayCapabilities = {
  profile: "desktop-agent",
  acp: { version: 2, hostKind: "electron", registrations: ["hermes-acp", "opencode-acp"] },
};
const hermesOnly: RelayCapabilities = {
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

async function prepare(
  registry: InMemoryRelayRegistry,
  sent: RelayServerMessage[],
  registrationId: AcpRegistrationId,
): Promise<AcpExecutionScope> {
  const pending = registry.requestAcpPrepare({
    relayId: "relay-1", userId: "owner-1", requestId: `prepare-${registrationId}`,
    registrationId, binding,
  });
  const command = sent.pop();
  if (!command || command.type !== "relay:acp-prepare") throw new Error("prepare missing");
  const workspace = {
    workspaceReceiptId: "receipt-1", workspaceRevision: "revision-1", workspaceFingerprint: "fingerprint-1",
    workspaceExpiresAt: "2030-01-01T00:00:00.000Z",
  } as const;
  expect(registry.acceptAcpMessage({
    relayId: "relay-1", userId: "owner-1",
    message: { type: "relay:acp-prepared", requestId: command.requestId, registrationId, scope: command.scope, binding: command.binding, workspace },
  })).toEqual({ ok: true });
  await pending;
  return { socket: command.scope, binding: command.binding, workspace };
}

async function startOpenCode(
  registry: InMemoryRelayRegistry,
  sent: RelayServerMessage[],
  scope: AcpExecutionScope,
  executionProfile: AcpExecutionProfile = "interactive",
): Promise<void> {
  const pending = registry.requestAcpStart({
    relayId: "relay-1", userId: "owner-1", registrationId: "opencode-acp",
    scope, prompt: "work", executionProfile,
  });
  const command = sent.pop();
  expect(command).toMatchObject({
    type: "relay:acp-start", registrationId: "opencode-acp", executionProfile,
  });
  if (!command || command.type !== "relay:acp-start") throw new Error("start missing");
  expect(registry.acceptAcpMessage({
    relayId: "relay-1", userId: "owner-1",
    message: { type: "relay:acp-started", registrationId: "opencode-acp", scope: command.scope, process, capabilities: { requests: "unsupported" }, eventId: "started-1", eventSequence: 1 },
  })).toEqual({ ok: true });
  await pending;
}

describe("D452 InMemoryRelayRegistry ACP v15 provider-aware execution", () => {
  test("returns only registration-capable authenticated sessions at each provider's protocol floor", async () => {
    const current = new InMemoryRelayRegistry();
    await current.register("relay-current", "owner-1", capabilities, () => undefined, 15, "desktop-current", 2, "pair-current");
    expect(current.getAcpSessionForRegistration("relay-current", "owner-1", "opencode-acp")).toMatchObject({
      relayId: "relay-current", selectedProtocolVersion: 15,
    });

    const missingRegistration = new InMemoryRelayRegistry();
    await missingRegistration.register("relay-hermes", "owner-1", hermesOnly, () => undefined, 15, "desktop-hermes", 0, "pair-hermes");
    expect(missingRegistration.getAcpSessionForRegistration("relay-hermes", "owner-1", "opencode-acp")).toBeNull();

    const oldOpenCode = new InMemoryRelayRegistry();
    await oldOpenCode.register("relay-old", "owner-1", capabilities, () => undefined, 14, "desktop-old", 0, "pair-old");
    expect(oldOpenCode.getAcpSessionForRegistration("relay-old", "owner-1", "opencode-acp")).toBeNull();

    const hermesReadiness = new InMemoryRelayRegistry();
    await hermesReadiness.register("relay-v13", "owner-1", hermesOnly, () => undefined, 13, "desktop-v13", 0, "pair-v13");
    expect(hermesReadiness.getAcpSessionForRegistration("relay-v13", "owner-1", "hermes-acp")).toMatchObject({
      relayId: "relay-v13", selectedProtocolVersion: 13,
    });
    expect(hermesReadiness.getAcpSessionForRegistration("relay-v13", "foreign-owner", "hermes-acp")).toBeNull();
  });

  test.each(["interactive", "autonomous", "plan"] as const)(
    "runs an exact OpenCode %s lifecycle and preserves registration on containment",
    async (executionProfile) => {
      const registry = new InMemoryRelayRegistry();
      const sent: RelayServerMessage[] = [];
      await registry.register("relay-1", "owner-1", capabilities, (message) => sent.push(message), 15, "desktop-1", 2, "pair-1");
      const scope = await prepare(registry, sent, "opencode-acp");
      await startOpenCode(registry, sent, scope, executionProfile);
      const subscription = registry.subscribeAcpExecution(scope, process, "opencode-acp");
      if (!subscription) throw new Error("subscription missing");
      const waiting = subscription.next();
      expect(registry.containAcpExecution(scope, process, "opencode-acp")).toBeTrue();
      expect(await waiting).toMatchObject({
        type: "relay:acp-terminal", registrationId: "opencode-acp", status: "failed", code: "upstream_failure",
      });
      expect(sent.at(-1)).toMatchObject({
        type: "relay:acp-contain", registrationId: "opencode-acp", scope, process,
      });
    },
  );

  test("correlates one exact OpenCode start failure, retires its receipt, and rejects replays", async () => {
    const registry = new InMemoryRelayRegistry();
    const sent: RelayServerMessage[] = [];
    await registry.register("relay-1", "owner-1", capabilities, (message) => sent.push(message), 15, "desktop-1", 2, "pair-1");
    const scope = await prepare(registry, sent, "opencode-acp");
    const pending = registry.requestAcpStart({
      relayId: "relay-1", userId: "owner-1", registrationId: "opencode-acp", scope, prompt: "work", executionProfile: "autonomous",
    });
    const command = sent.pop();
    if (!command || command.type !== "relay:acp-start") throw new Error("OpenCode start missing");
    const failure = { type: "relay:acp-start-failed" as const, registrationId: "opencode-acp" as const, scope: command.scope, stage: "initialized" as const };

    expect(registry.acceptAcpMessage({ relayId: "relay-1", userId: "owner-1", message: failure })).toEqual({ ok: true });
    await expectFailure(pending, "ACP_START_FAILED");
    expect(registry.subscribeAcpExecution(scope, process, "opencode-acp")).toBeNull();
    expect(registry.acceptAcpMessage({ relayId: "relay-1", userId: "owner-1", message: failure })).toEqual({ ok: false, error: "ACP_CORRELATION_REPLAY" });
    await expectFailure(registry.requestAcpStart({ relayId: "relay-1", userId: "owner-1", registrationId: "opencode-acp", scope, prompt: "work", executionProfile: "autonomous" }), "ACP_CONTEXT_STALE");

    const stale = { ...failure, scope: { ...scope, binding: { ...scope.binding, bindingGeneration: "stale" } } };
    expect(registry.acceptAcpMessage({ relayId: "relay-1", userId: "owner-1", message: stale })).toEqual({ ok: false, error: "ACP_CORRELATION_REPLAY" });
    expect(JSON.stringify(failure)).not.toContain("process");
  });

  test.each([
    ["replacement", async (registry: InMemoryRelayRegistry) => registry.register("relay-1", "owner-1", capabilities, () => undefined, 15, "desktop-1", 2, "pair-1"), "ACP_CONTEXT_STALE"],
    ["capability revision", async (registry: InMemoryRelayRegistry) => { expect(registry.updateCapabilities({ relayId: "relay-1", userId: "owner-1", desktopSessionId: "desktop-1", capabilityRevision: 3, capabilities })).toEqual({ ok: true }); }, "ACP_CONTEXT_STALE"],
    ["unregister/close", async (registry: InMemoryRelayRegistry) => registry.unregister("relay-1"), "ACP_RELAY_UNAVAILABLE"],
  ] as const)("marks an exact pending OpenCode start as socket-generation-lost on %s while preserving Hermes legacy", async (_name, invalidate, hermesFailure) => {
    const registry = new InMemoryRelayRegistry();
    const sent: RelayServerMessage[] = [];
    await registry.register("relay-1", "owner-1", capabilities, (message) => sent.push(message), 15, "desktop-1", 2, "pair-1");
    const openCodeScope = await prepare(registry, sent, "opencode-acp");
    const hermesScope = await prepare(registry, sent, "hermes-acp");
    const openCodePending = registry.requestAcpStart({ relayId: "relay-1", userId: "owner-1", registrationId: "opencode-acp", scope: openCodeScope, prompt: "work", executionProfile: "autonomous" });
    const hermesPending = registry.requestAcpStart({ relayId: "relay-1", userId: "owner-1", scope: hermesScope, prompt: "work" });
    void openCodePending.catch(() => undefined); void hermesPending.catch(() => undefined);

    await invalidate(registry);

    await expectFailure(openCodePending, "ACP_SOCKET_GENERATION_LOST");
    await expectFailure(hermesPending, hermesFailure);
    await expectFailure(registry.requestAcpStart({ relayId: "relay-1", userId: "owner-1", registrationId: "opencode-acp", scope: openCodeScope, prompt: "work", executionProfile: "autonomous" }), "ACP_CONTEXT_STALE");
  });

  test("keeps equal Hermes and OpenCode scopes/processes in separate correlation lanes", async () => {
    const registry = new InMemoryRelayRegistry();
    const sent: RelayServerMessage[] = [];
    await registry.register("relay-1", "owner-1", capabilities, (message) => sent.push(message), 15, "desktop-1", 2, "pair-1");
    const hermesScope = await prepare(registry, sent, "hermes-acp");
    const openCodeScope = await prepare(registry, sent, "opencode-acp");
    expect(openCodeScope).toEqual(hermesScope);

    const hermesStart = registry.requestAcpStart({ relayId: "relay-1", userId: "owner-1", scope: hermesScope, prompt: "work" });
    const hermesCommand = sent.pop();
    if (!hermesCommand || hermesCommand.type !== "relay:acp-start") throw new Error("Hermes start missing");
    expect(hermesCommand).toEqual({ type: "relay:acp-start", registrationId: "hermes-acp", scope: hermesScope, prompt: "work" });
    expect(registry.acceptAcpMessage({
      relayId: "relay-1", userId: "owner-1",
      message: { type: "relay:acp-started", registrationId: "hermes-acp", scope: hermesScope, process, capabilities: { requests: "unsupported" }, eventId: "hermes-started", eventSequence: 1 },
    })).toEqual({ ok: true });
    await hermesStart;
    await startOpenCode(registry, sent, openCodeScope);

    const hermesSubscription = registry.subscribeAcpExecution(hermesScope, process);
    const openCodeSubscription = registry.subscribeAcpExecution(openCodeScope, process, "opencode-acp");
    if (!hermesSubscription || !openCodeSubscription) throw new Error("provider subscriptions missing");
    const openCodeEvent = {
      type: "relay:acp-semantic" as const, registrationId: "opencode-acp" as const,
      scope: hermesScope, process, capabilities: { requests: "unsupported" as const },
      payload: { kind: "output_delta" as const, vendorItemId: null, text: "OpenCode lane" },
      eventId: "shared-event", eventSequence: 2,
    };
    const hermesEvent = { ...openCodeEvent, registrationId: "hermes-acp" as const, payload: { ...openCodeEvent.payload, text: "Hermes lane" } };
    expect(registry.acceptAcpMessage({ relayId: "relay-1", userId: "owner-1", message: openCodeEvent })).toEqual({ ok: true });
    expect(registry.acceptAcpMessage({ relayId: "relay-1", userId: "owner-1", message: hermesEvent })).toEqual({ ok: true });
    expect(await openCodeSubscription.next()).toEqual(openCodeEvent);
    expect(await hermesSubscription.next()).toEqual(hermesEvent);
  });

  test("orders OpenCode runtime-health transitions on only the exact live v15 turn", async () => {
    const registry = new InMemoryRelayRegistry();
    const sent: RelayServerMessage[] = [];
    await registry.register("relay-1", "owner-1", capabilities, (message) => sent.push(message), 15, "desktop-1", 2, "pair-1");
    const scope = await prepare(registry, sent, "opencode-acp");
    await startOpenCode(registry, sent, scope, "autonomous");
    const subscription = registry.subscribeAcpExecution(scope, process, "opencode-acp");
    if (!subscription) throw new Error("subscription missing");
    const stalled = { type: "relay:acp-semantic" as const, registrationId: "opencode-acp" as const, scope, process, capabilities: { requests: "unsupported" as const }, payload: { kind: "runtime_status" as const, state: "possibly_stalled" as const }, eventId: "health-stalled", eventSequence: 2 };
    expect(registry.acceptAcpMessage({ relayId: "relay-1", userId: "owner-1", message: { ...stalled, scope: { ...scope, binding: { ...scope.binding, bindingGeneration: "stale" } } } })).toEqual({ ok: false, error: "ACP_CORRELATION_REPLAY" });
    expect(registry.acceptAcpMessage({ relayId: "relay-1", userId: "owner-1", message: stalled })).toEqual({ ok: true });
    expect(await subscription.next()).toEqual(stalled);
    const healthy = { ...stalled, payload: { kind: "runtime_status" as const, state: "healthy" as const }, eventId: "health-healthy", eventSequence: 3 };
    expect(registry.acceptAcpMessage({ relayId: "relay-1", userId: "owner-1", message: healthy })).toEqual({ ok: true });
    expect(await subscription.next()).toEqual(healthy);
    const terminal = { type: "relay:acp-terminal" as const, registrationId: "opencode-acp" as const, scope, process, status: "completed" as const, eventId: "terminal", eventSequence: 4 };
    expect(registry.acceptAcpMessage({ relayId: "relay-1", userId: "owner-1", message: terminal })).toEqual({ ok: true });
    expect(registry.acceptAcpMessage({ relayId: "relay-1", userId: "owner-1", message: { ...healthy, eventId: "late-health", eventSequence: 5 } })).toEqual({ ok: false, error: "ACP_TERMINAL_FENCED" });
  });

  test("rejects unadvertised/below-v15 OpenCode execution and malformed profile input before send", async () => {
    const unadvertised = new InMemoryRelayRegistry();
    await unadvertised.register("relay-1", "owner-1", hermesOnly, () => undefined, 15, "desktop-1", 0, "pair-1");
    await expectFailure(unadvertised.requestAcpPrepare({ relayId: "relay-1", userId: "owner-1", requestId: "open", registrationId: "opencode-acp", binding }), "ACP_RELAY_UNAVAILABLE");

    const old = new InMemoryRelayRegistry();
    await old.register("relay-1", "owner-1", capabilities, () => undefined, 14, "desktop-1", 0, "pair-1");
    await expectFailure(old.requestAcpPrepare({ relayId: "relay-1", userId: "owner-1", requestId: "old", registrationId: "opencode-acp", binding }), "ACP_RELAY_UNAVAILABLE");

    const registry = new InMemoryRelayRegistry();
    const sent: RelayServerMessage[] = [];
    await registry.register("relay-1", "owner-1", capabilities, (message) => sent.push(message), 15, "desktop-1", 0, "pair-1");
    const scope = await prepare(registry, sent, "opencode-acp");
    const before = sent.length;
    await expectFailure(registry.requestAcpStart({ relayId: "relay-1", userId: "owner-1", registrationId: "opencode-acp", scope, prompt: "work" } as never), "ACP_REQUEST_INVALID");
    await expectFailure(registry.requestAcpStart({ relayId: "relay-1", userId: "owner-1", registrationId: "opencode-acp", executionProfile: "unrestricted", scope, prompt: "work" } as never), "ACP_REQUEST_INVALID");
    await expectFailure(registry.requestAcpStart({ relayId: "relay-1", userId: "owner-1", registrationId: "hermes-acp", executionProfile: "interactive", scope, prompt: "work" } as never), "ACP_REQUEST_INVALID");
    expect(sent).toHaveLength(before);
  });

  test("holds OpenCode start correlation for the full handshake and containment budget", async () => {
    const timers: Array<{ callback: () => void; delay: number }> = [];
    const setTimer = spyOn(globalThis, "setTimeout").mockImplementation(((callback: (...args: unknown[]) => void, delay?: number) => {
      const timer = { callback: () => callback(), delay: typeof delay === "number" ? delay : 0 };
      timers.push(timer);
      return timer as unknown as ReturnType<typeof setTimeout>;
    }) as typeof setTimeout);
    const clearTimer = spyOn(globalThis, "clearTimeout").mockImplementation(() => undefined);
    try {
      const registry = new InMemoryRelayRegistry();
      const sent: RelayServerMessage[] = [];
      await registry.register("relay-1", "owner-1", capabilities, (message) => sent.push(message), 15, "desktop-1", 2, "pair-1");
      const scope = await prepare(registry, sent, "opencode-acp");
      const timerIndex = timers.length;
      const pending = registry.requestAcpStart({
        relayId: "relay-1", userId: "owner-1", registrationId: "opencode-acp",
        scope, prompt: "work", executionProfile: "autonomous", timeoutMs: 50_000,
      });
      const command = sent.pop();
      if (!command || command.type !== "relay:acp-start") throw new Error("OpenCode start missing");
      expect(timers.slice(timerIndex).map((timer) => timer.delay)).toEqual([50_000]);
      await expectFailure(registry.requestAcpStart({
        relayId: "relay-1", userId: "owner-1", registrationId: "opencode-acp",
        scope, prompt: "work", executionProfile: "autonomous", timeoutMs: 15_000,
      }), "ACP_REQUEST_INVALID");
      await expectFailure(registry.requestAcpStart({
        relayId: "relay-1", userId: "owner-1", registrationId: "opencode-acp",
        scope, prompt: "work", executionProfile: "autonomous", timeoutMs: 49_999,
      }), "ACP_REQUEST_INVALID");
      expect(registry.acceptAcpMessage({
        relayId: "relay-1", userId: "owner-1",
        message: { type: "relay:acp-start-failed", registrationId: "opencode-acp", scope, stage: "accepted" },
      })).toEqual({ ok: true });
      await expectFailure(pending, "ACP_START_FAILED");
    } finally {
      setTimer.mockRestore();
      clearTimer.mockRestore();
    }
  });
});

async function expectFailure(promise: Promise<unknown>, message: string): Promise<void> {
  let failure: unknown;
  try { await promise; } catch (error) { failure = error; }
  expect(failure).toMatchObject({ message });
}
