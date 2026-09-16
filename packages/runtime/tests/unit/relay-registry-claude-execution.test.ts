import { describe, expect, test } from "bun:test";
import type {
  RelayCapabilities,
  RelayClaudeExecutionCommand,
  RelayClaudeExecutionDesktopEvent,
  RelayClaudeExecutionEvent,
  RelayClaudeExecutionSocketScope,
  RelayServerMessage,
} from "@nautilo/relay";
import { InMemoryRelayRegistry } from "../../src/relay-registry";
import { ClaudeAgentSdkHost, type ClaudeAgentSdk, type ClaudeLaunchHandle } from "@nautilo/claude-agent-sdk-host";
import { ElectronClaudeExecutionHost } from "../../../../apps/desktop/electron/claude-execution";

const relayId = "relay-1";
const owner = "owner-1";
const capabilities: RelayCapabilities = {
  profile: "desktop-agent",
  claudeExecution: { version: 2 },
};

const fallbackScope: RelayClaudeExecutionSocketScope = {
  relayId,
  relaySessionId: "fallback-session",
  desktopSessionId: "fallback-desktop",
  pairingGenerationRef: "fallback-pair",
  selectedProtocolVersion: 18,
  capabilityRevision: 0,
};

function currentScope(registry: InMemoryRelayRegistry): RelayClaudeExecutionSocketScope {
  return registry.getClaudeExecutionSession(relayId, owner) ?? fallbackScope;
}

function open(
  registry: InMemoryRelayRegistry,
  input: Partial<{
    relayId: string;
    userId: string;
    prompt: string;
    model: string;
    expectedScope: RelayClaudeExecutionSocketScope;
  }> = {},
) {
  return registry.openClaudeExecution({
    relayId: input.relayId ?? relayId,
    userId: input.userId ?? owner,
    prompt: input.prompt ?? "summarize the room",
    model: input.model ?? "claude-sonnet",
    expectedScope: input.expectedScope ?? currentScope(registry),
  });
}

function eventFor(
  command: RelayClaudeExecutionCommand,
  event: RelayClaudeExecutionEvent,
): RelayClaudeExecutionDesktopEvent {
  return {
    type: "relay:claude-execution-event",
    scope: command.scope,
    executionRef: command.executionRef,
    event,
  };
}

function startCommand(messages: readonly RelayServerMessage[]): RelayClaudeExecutionCommand {
  const command = messages.at(-1);
  expect(command?.type).toBe("relay:claude-execution-command");
  if (command?.type !== "relay:claude-execution-command" || command.action.kind !== "start") {
    throw new Error("missing Claude execution start");
  }
  return command;
}

async function openCurrent() {
  const registry = new InMemoryRelayRegistry();
  const sent: RelayServerMessage[] = [];
  await registry.register(relayId, owner, capabilities, (message) => sent.push(message), 18, "desktop-1", 0, "pair-1");
  const opened = open(registry);
  expect(opened.ok).toBe(true);
  if (!opened.ok) throw new Error("open failed");
  return { registry, sent, control: opened.control, command: startCommand(sent) };
}

async function start(
  registry: InMemoryRelayRegistry,
  command: RelayClaudeExecutionCommand,
): Promise<void> {
  expect(registry.acceptClaudeExecutionEvent({ relayId, userId: owner, message: eventFor(command, { kind: "started" }) })).toEqual({ ok: true });
}

describe("D452 v18 thin Claude execution relay lane", () => {
  for (const providerOutcome of ["accepted", "rejected"] as const) {
    test(`preserves terminal-first ${providerOutcome} steer across SDK, Desktop and Runtime`, async () => {
      const entered = Promise.withResolvers<void>();
      const releaseObservations = Promise.withResolvers<void>();
      const releaseReceipt = Promise.withResolvers<void>();
      const leaseClosed = Promise.withResolvers<void>();
      const sdkReceipt = Promise.withResolvers<Awaited<ReturnType<ClaudeLaunchHandle["steer"]>>>();
      const registry = new InMemoryRelayRegistry();
      const events: RelayClaudeExecutionDesktopEvent[] = [];
      const leaseAbort = new AbortController();
      const sdk = new ClaudeAgentSdkHost({
        executableResolver: { resolve: async () => ({
          path: "/synthetic/claude", version: "2.1.235",
          features: { accountInfo: true, supportedModels: true, interrupt: true, switchModelsOnFlag: true, modelRefusalFallback: false, modelRefusalNoFallback: false, servingModelIdentity: false },
        }) },
        onFact: () => undefined,
        sdk: { query: (() => ({
          async *[Symbol.asyncIterator]() {
            await releaseObservations.promise;
            yield { type: "stream_event", parent_tool_use_id: null, event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "done" } } };
            yield { type: "result", subtype: "success", is_error: false, result: "done", terminal_reason: null };
          },
          async streamInput(input: AsyncIterable<unknown>) {
            await input[Symbol.asyncIterator]().next();
            entered.resolve();
            await releaseReceipt.promise;
            if (providerOutcome === "rejected") throw new Error("synthetic provider rejection");
          },
          interrupt: async () => ({ still_queued: [] }), close: () => undefined,
          accountInfo: async () => ({}), supportedModels: async () => [],
        })) as unknown as ClaudeAgentSdk["query"] },
      });
      const desktop = new ElectronClaudeExecutionHost({
        currentFolder: () => ({ path: "/synthetic", revision: 0 }),
        leaseProvider: { acquire: async () => ({
          workingDirectory: "/synthetic", signal: leaseAbort.signal,
          validate: async () => !leaseAbort.signal.aborted,
          close: async () => { leaseAbort.abort(); leaseClosed.resolve(); },
        }) },
        createHost: () => ({ launch: async (request) => {
          const handle = await sdk.launch(request);
          return { ...handle, steer: async (prompt: string) => {
            const receipt = await handle.steer(prompt);
            sdkReceipt.resolve(receipt);
            return receipt;
          } };
        } }),
      });
      await registry.register(relayId, owner, capabilities, (message) => {
        if (message.type === "relay:claude-execution-command") desktop.onCommand(message);
      }, 18, "desktop-1", 0, "pair-1");
      desktop.onRegistered(currentScope(registry), { send: (message) => {
        events.push(message);
        return registry.acceptClaudeExecutionEvent({ relayId, userId: owner, message }).ok;
      } });
      const opened = open(registry);
      if (!opened.ok) throw new Error("synthetic lane did not open");
      try {
        expect(await opened.control.next()).toEqual({ kind: "started" });
        const steering = opened.control.steer("Redirect").then(
          (outcome) => outcome,
          (error: unknown) => error instanceof Error ? error.message : "unexpected error",
        );
        await entered.promise;
        releaseObservations.resolve();
        expect(await opened.control.next()).toEqual({ kind: "output_delta", text: "done" });
        expect(await opened.control.next()).toEqual({ kind: "result", outcome: "success", text: null });
        expect(await opened.control.next()).toEqual({ kind: "settled", outcome: "eof" });
        expect(await opened.control.next()).toBeNull();
        await leaseClosed.promise;
        expect(open(registry, { prompt: "x".repeat(16 * 1024 + 1) }).ok).toBe(false);
        releaseReceipt.resolve();
        expect(await sdkReceipt.promise).toEqual({ outcome: providerOutcome });
        // Drain the Desktop async continuation after the SDK receipt, not a
        // product timeout or a timing-dependent race between arbitrary sleeps.
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(events.map((message) => message.event.kind)).toEqual(["started", "output_delta", "result", "settled", "steer_receipt"]);
        expect(await steering).toBe(providerOutcome === "accepted" ? "accepted" : "CLAUDE_EXECUTION_STEER_REJECTED");
        const receiptEvent = events.at(-1);
        if (!receiptEvent) throw new Error("missing receipt");
        expect(registry.acceptClaudeExecutionEvent({ relayId, userId: owner, message: receiptEvent }).ok).toBe(false);
      } finally {
        releaseObservations.resolve(); releaseReceipt.resolve();
        desktop.onDisconnected(); await registry.unregister(relayId);
      }
    });
  }

  test("strips ineligible registration capability and rejects an invalid explicit replacement", async () => {
    const registry = new InMemoryRelayRegistry();
    const sent: RelayServerMessage[] = [];
    await registry.register(relayId, owner, capabilities, (message) => sent.push(message), 17, "desktop-1", 0, "pair-1");
    expect(open(registry, { prompt: "x", model: "m" })).toEqual({
      ok: false,
      error: "CLAUDE_EXECUTION_UNAVAILABLE",
    });
    expect(sent).toEqual([]);
    expect(registry.getClaudeExecutionSession(relayId, owner)).toBeNull();
    expect(registry.updateCapabilities({
      relayId,
      userId: owner,
      desktopSessionId: "desktop-1",
      capabilityRevision: 1,
      capabilities: { profile: "desktop-agent", claudeExecution: { version: 2 } } as unknown as RelayCapabilities,
    })).toEqual({ ok: false, error: "capabilities.claudeExecution requires relay protocol v18" });

    const current = new InMemoryRelayRegistry();
    await current.register(relayId, owner, capabilities, () => undefined, 18, "desktop-1", 0, "pair-1");
    expect(open(current, { userId: "other", prompt: "x", model: "m" })).toEqual({
      ok: false,
      error: "CLAUDE_EXECUTION_CONTEXT_STALE",
    });
    expect(current.getClaudeExecutionSession(relayId, "other")).toBeNull();

    const v1 = new InMemoryRelayRegistry();
    await v1.register(relayId, owner, { profile: "desktop-agent", claudeExecution: { version: 1 } } as never, () => undefined, 18, "desktop-1", 0, "pair-1");
    expect(open(v1)).toEqual({ ok: false, error: "CLAUDE_EXECUTION_UNAVAILABLE" });
  });

  test("returns only the current frozen v18 execution scope and follows capability/socket lifecycle", async () => {
    const registry = new InMemoryRelayRegistry();
    await registry.register(relayId, owner, capabilities, () => undefined, 18, "desktop-1", 0, "pair-1");
    const initial = registry.getClaudeExecutionSession(relayId, owner);
    expect(initial).not.toBeNull();
    if (initial === null) throw new Error("missing initial execution session");
    expect(initial.relayId).toBe(relayId);
    expect(initial.relaySessionId.length).toBeGreaterThan(0);
    expect(initial.desktopSessionId).toBe("desktop-1");
    expect(initial.pairingGenerationRef.length).toBeGreaterThan(0);
    expect(initial.selectedProtocolVersion).toBe(18);
    expect(initial.capabilityRevision).toBe(0);
    expect(Object.isFrozen(initial)).toBe(true);

    expect(registry.updateCapabilities({
      relayId,
      userId: owner,
      desktopSessionId: "desktop-1",
      capabilityRevision: 1,
      capabilities,
    })).toEqual({ ok: true });
    const revised = registry.getClaudeExecutionSession(relayId, owner);
    expect(revised).not.toBeNull();
    if (revised === null) throw new Error("missing revised execution session");
    expect(revised.capabilityRevision).toBe(1);
    expect(revised).not.toEqual(initial);

    await registry.register(relayId, owner, capabilities, () => undefined, 18, "desktop-2", 2, "pair-2");
    const replacement = registry.getClaudeExecutionSession(relayId, owner);
    expect(replacement).not.toBeNull();
    if (replacement === null) throw new Error("missing replacement execution session");
    expect(replacement.desktopSessionId).toBe("desktop-2");
    expect(replacement.capabilityRevision).toBe(2);
    expect(replacement).not.toEqual(revised);

    await registry.unregister(relayId);
    expect(registry.getClaudeExecutionSession(relayId, owner)).toBeNull();
  });

  test("CAS-binds every expected scope fact before lane allocation or start send", async () => {
    const drifted: readonly (readonly [keyof RelayClaudeExecutionSocketScope, string | number])[] = [
      ["relayId", "other-relay"],
      ["relaySessionId", "other-session"],
      ["desktopSessionId", "other-desktop"],
      ["pairingGenerationRef", "other-pair"],
      ["selectedProtocolVersion", 19],
      ["capabilityRevision", 1],
    ];
    for (const [key, value] of drifted) {
      const registry = new InMemoryRelayRegistry();
      const sent: RelayServerMessage[] = [];
      await registry.register(relayId, owner, capabilities, (message) => sent.push(message), 18, "desktop-1", 0, "pair-1");
      const scope = currentScope(registry);
      expect(open(registry, { expectedScope: { ...scope, [key]: value } as RelayClaudeExecutionSocketScope })).toEqual({
        ok: false,
        error: "CLAUDE_EXECUTION_CONTEXT_STALE",
      });
      expect(sent).toEqual([]);
      expect(open(registry, { expectedScope: scope }).ok).toBe(true);
    }
  });

  test("rejects a scope captured before replacement without consuming the successor lane", async () => {
    const registry = new InMemoryRelayRegistry();
    const sent: RelayServerMessage[] = [];
    await registry.register(relayId, owner, capabilities, (message) => sent.push(message), 18, "desktop-1", 0, "pair-1");
    const staleScope = currentScope(registry);
    await registry.register(relayId, owner, capabilities, (message) => sent.push(message), 18, "desktop-2", 1, "pair-2");
    expect(open(registry, { expectedScope: staleScope })).toEqual({
      ok: false,
      error: "CLAUDE_EXECUTION_CONTEXT_STALE",
    });
    expect(sent).toEqual([]);
    expect(open(registry).ok).toBe(true);
  });

  test("fails malformed or hostile expected scope closed before any send or lane mutation", async () => {
    const registry = new InMemoryRelayRegistry();
    const sent: RelayServerMessage[] = [];
    await registry.register(relayId, owner, capabilities, (message) => sent.push(message), 18, "desktop-1", 0, "pair-1");
    expect(registry.openClaudeExecution({
      relayId,
      userId: owner,
      prompt: "x",
      model: "m",
      expectedScope: {} as RelayClaudeExecutionSocketScope,
    })).toEqual({ ok: false, error: "CLAUDE_EXECUTION_INVALID" });
    expect(registry.openClaudeExecution({
      relayId,
      userId: owner,
      prompt: "x",
      model: "m",
      expectedScope: new Proxy({}, { ownKeys: () => { throw new Error("hostile"); } }) as RelayClaudeExecutionSocketScope,
    })).toEqual({ ok: false, error: "CLAUDE_EXECUTION_INVALID" });
    expect(sent).toEqual([]);
    expect(open(registry).ok).toBe(true);
  });

  test("sends one canonical start and yields only ordered stream observations", async () => {
    const { registry, sent, control, command } = await openCurrent();
    expect(Object.isFrozen(command)).toBe(true);
    expect(command.action).toEqual({ kind: "start", prompt: "summarize the room", model: "claude-sonnet" });
    await start(registry, command);
    const first = await control.next();
    expect(first).toEqual({ kind: "started" });
    expect(Object.isFrozen(first)).toBe(true);
    expect(registry.acceptClaudeExecutionEvent({
      relayId,
      userId: owner,
      message: eventFor(command, { kind: "activity", activity: "tool", state: "progress", toolName: "Read" }),
    })).toEqual({ ok: true });
    expect(await control.next()).toEqual({ kind: "activity", activity: "tool", state: "progress", toolName: "Read" });
    expect(registry.acceptClaudeExecutionEvent({
      relayId,
      userId: owner,
      message: eventFor(command, { kind: "settled", outcome: "eof" }),
    })).toEqual({ ok: true });
    expect(await control.next()).toEqual({ kind: "settled", outcome: "eof" });
    expect(await control.next()).toBeNull();
    expect(sent).toHaveLength(1);
  });

  test("opens interaction response only after delivery and consumes its acknowledgement internally", async () => {
    const { registry, sent, control, command } = await openCurrent();
    await start(registry, command);
    await control.next();
    const interaction = {
      kind: "interaction" as const,
      interaction: { kind: "permission" as const, interactionRef: "4ea7d1d5-b1cf-45bf-8b6e-a9473b728733", toolName: "Read", allowSession: false as const },
    };
    expect(registry.acceptClaudeExecutionEvent({ relayId, userId: owner, message: eventFor(command, interaction) })).toEqual({ ok: true });
    await expectFailure(control.respond(interaction.interaction.interactionRef, { kind: "allow_once" }), "CLAUDE_EXECUTION_CONTEXT_STALE");
    expect(await control.next()).toEqual(interaction);
    const response = control.respond(interaction.interaction.interactionRef, { kind: "allow_once" });
    const responseCommand = sent.at(-1);
    expect(responseCommand).toMatchObject({ type: "relay:claude-execution-command", action: { kind: "respond", interactionRef: interaction.interaction.interactionRef } });
    expect(registry.acceptClaudeExecutionEvent({
      relayId,
      userId: owner,
      message: eventFor(command, { kind: "interaction_accepted", interactionRef: interaction.interaction.interactionRef }),
    })).toEqual({ ok: true });
    expect(await response).toBe("accepted");
    const pending = control.next();
    expect(registry.acceptClaudeExecutionEvent({
      relayId,
      userId: owner,
      message: eventFor(command, { kind: "settled", outcome: "eof" }),
    })).toEqual({ ok: true });
    expect(await pending).toEqual({ kind: "settled", outcome: "eof" });
  });

  test("shares one interrupt command and consumes its receipt internally", async () => {
    const { registry, sent, control, command } = await openCurrent();
    await start(registry, command);
    await control.next();
    const first = control.interrupt();
    const second = control.interrupt();
    expect(first).toBe(second);
    const interrupt = sent.at(-1);
    expect(interrupt).toMatchObject({ type: "relay:claude-execution-command", action: { kind: "interrupt" } });
    expect(registry.acceptClaudeExecutionEvent({
      relayId,
      userId: owner,
      message: eventFor(command, { kind: "interrupt_receipt", outcome: "acknowledged" }),
    })).toEqual({ ok: true });
    expect(await first).toBe("acknowledged");
    expect(control.interrupt()).toBe(first);
    expect(sent.filter((message) => message.type === "relay:claude-execution-command" && message.action.kind === "interrupt")).toHaveLength(1);
    expect(registry.acceptClaudeExecutionEvent({
      relayId,
      userId: owner,
      message: eventFor(command, { kind: "interrupt_receipt", outcome: "acknowledged" }),
    })).toEqual({ ok: false, error: "CLAUDE_EXECUTION_PROTOCOL_INVALID" });
    const pending = control.next();
    expect(registry.acceptClaudeExecutionEvent({
      relayId,
      userId: owner,
      message: eventFor(command, { kind: "settled", outcome: "eof" }),
    })).toEqual({ ok: true });
    expect(await pending).toEqual({ kind: "settled", outcome: "eof" });
  });

  test("admits one steer receipt per exact active execution without queuing or projecting it", async () => {
    const { registry, sent, control, command } = await openCurrent();
    await expectFailure(control.steer("Too early"), "CLAUDE_EXECUTION_CONTEXT_STALE");
    await start(registry, command);
    expect(await control.next()).toEqual({ kind: "started" });
    const steer = control.steer("Change direction");
    await expectFailure(control.steer("A concurrent change"), "CLAUDE_EXECUTION_STEER_PENDING");
    const steerCommand = sent.at(-1);
    expect(steerCommand).toMatchObject({
      type: "relay:claude-execution-command",
      executionRef: command.executionRef,
      action: { kind: "steer", prompt: "Change direction" },
    });
    if (steerCommand?.type !== "relay:claude-execution-command" || steerCommand.action.kind !== "steer") {
      throw new Error("missing steer command");
    }
    const pendingObservation = control.next();
    expect(registry.acceptClaudeExecutionEvent({
      relayId,
      userId: owner,
      message: eventFor(command, { kind: "steer_receipt", steerRef: steerCommand.action.steerRef, outcome: "accepted" }),
    })).toEqual({ ok: true });
    expect(await steer).toBe("accepted");
    let resolved = false;
    void pendingObservation.then(() => { resolved = true; });
    await Promise.resolve();
    expect(resolved).toBe(false);
    expect(registry.acceptClaudeExecutionEvent({
      relayId,
      userId: owner,
      message: eventFor(command, { kind: "settled", outcome: "eof" }),
    })).toEqual({ ok: true });
    expect(await pendingObservation).toEqual({ kind: "settled", outcome: "eof" });
  });

  test("rejects stale, provider-rejected, and disconnected steers without treating socket send as success", async () => {
    const provider = await openCurrent();
    await start(provider.registry, provider.command);
    await provider.control.next();
    const rejected = provider.control.steer("Change direction");
    const command = provider.sent.at(-1);
    if (command?.type !== "relay:claude-execution-command" || command.action.kind !== "steer") throw new Error("missing steer command");
    expect(provider.registry.acceptClaudeExecutionEvent({
      relayId,
      userId: owner,
      message: eventFor(provider.command, { kind: "steer_receipt", steerRef: command.action.steerRef, outcome: "rejected" }),
    })).toEqual({ ok: true });
    await expectFailure(rejected, "CLAUDE_EXECUTION_STEER_REJECTED");
    await expectFailure(provider.control.steer("x".repeat(16 * 1024 + 1)), "CLAUDE_EXECUTION_INVALID");

    const disconnected = await openCurrent();
    await start(disconnected.registry, disconnected.command);
    await disconnected.control.next();
    const pending = disconnected.control.steer("Change direction");
    await disconnected.registry.unregister(relayId);
    await expectFailure(pending, "CLAUDE_EXECUTION_UNAVAILABLE");
  });

  test("retires an unanswered settled steer on successor admission or capability revision", async () => {
    const settled = await openCurrent();
    await start(settled.registry, settled.command); await settled.control.next();
    const settlementSteer = settled.control.steer("Change direction");
    expect(settled.registry.acceptClaudeExecutionEvent({
      relayId, userId: owner, message: eventFor(settled.command, { kind: "settled", outcome: "eof" }),
    })).toEqual({ ok: true });
    expect(open(settled.registry, { prompt: "successor" }).ok).toBe(true);
    await expectFailure(settlementSteer, "CLAUDE_EXECUTION_CONTEXT_STALE");

    const revised = await openCurrent();
    await start(revised.registry, revised.command); await revised.control.next();
    const revisionSteer = revised.control.steer("Change direction");
    expect(revised.registry.updateCapabilities({
      relayId, userId: owner, desktopSessionId: "desktop-1", capabilityRevision: 1, capabilities,
    })).toEqual({ ok: true });
    await expectFailure(revisionSteer, "CLAUDE_EXECUTION_CONTEXT_STALE");
  });

  test("settled receipt owner rejects post-terminal commands, foreign/duplicate facts and disconnect", async () => {
    const fx = await openCurrent();
    await start(fx.registry, fx.command); await fx.control.next();
    const pending = fx.control.steer("Redirect").catch((error: unknown) => error instanceof Error ? error.message : "unexpected");
    const steer = fx.sent.at(-1);
    if (steer?.type !== "relay:claude-execution-command" || steer.action.kind !== "steer") throw new Error("missing steer");
    expect(fx.registry.acceptClaudeExecutionEvent({ relayId, userId: owner, message: eventFor(fx.command, { kind: "settled", outcome: "eof" }) })).toEqual({ ok: true });
    expect(await fx.control.next()).toEqual({ kind: "settled", outcome: "eof" });
    expect(await fx.control.next()).toBeNull();
    await expectFailure(fx.control.steer("Too late"), "CLAUDE_EXECUTION_CONTEXT_STALE");
    expect(fx.registry.acceptClaudeExecutionEvent({ relayId, userId: owner, message: eventFor(fx.command, { kind: "output_delta", text: "late" }) }).ok).toBe(false);
    expect(fx.registry.acceptClaudeExecutionEvent({ relayId, userId: "foreign", message: eventFor(fx.command, { kind: "steer_receipt", steerRef: steer.action.steerRef, outcome: "accepted" }) }).ok).toBe(false);
    expect(fx.registry.acceptClaudeExecutionEvent({ relayId, userId: owner, message: eventFor(fx.command, { kind: "steer_receipt", steerRef: "wrong", outcome: "accepted" }) }).ok).toBe(false);
    await fx.registry.unregister(relayId);
    expect(await pending).toBe("CLAUDE_EXECUTION_UNAVAILABLE");
    expect(fx.registry.acceptClaudeExecutionEvent({ relayId, userId: owner, message: eventFor(fx.command, { kind: "steer_receipt", steerRef: steer.action.steerRef, outcome: "accepted" }) }).ok).toBe(false);
  });

  test("disconnect loses only the pending receipt, not an unread completed result", async () => {
    const fx = await openCurrent();
    await start(fx.registry, fx.command); await fx.control.next();
    const pending = fx.control.steer("Redirect").catch((error: unknown) => error instanceof Error ? error.message : "unexpected");
    for (const event of [{ kind: "output_delta", text: "done" }, { kind: "result", outcome: "success", text: null }, { kind: "settled", outcome: "eof" }] as const) {
      expect(fx.registry.acceptClaudeExecutionEvent({ relayId, userId: owner, message: eventFor(fx.command, event) })).toEqual({ ok: true });
    }
    await fx.registry.unregister(relayId);
    expect(await pending).toBe("CLAUDE_EXECUTION_UNAVAILABLE");
    expect(await fx.control.next()).toEqual({ kind: "output_delta", text: "done" });
    expect(await fx.control.next()).toEqual({ kind: "result", outcome: "success", text: null });
    expect(await fx.control.next()).toEqual({ kind: "settled", outcome: "eof" });
    expect(await fx.control.next()).toBeNull();
  });

  test("enforces one active relay lane and releases it after settlement or unavailable", async () => {
    const { registry, control, command } = await openCurrent();
    expect(open(registry, { prompt: "second" })).toEqual({
      ok: false,
      error: "CLAUDE_EXECUTION_BUSY",
    });
    expect(registry.acceptClaudeExecutionEvent({ relayId, userId: owner, message: eventFor(command, { kind: "unavailable" }) })).toEqual({ ok: true });
    expect(await control.next()).toEqual({ kind: "unavailable" });
    expect(await control.next()).toBeNull();
    expect(open(registry, { prompt: "second" }).ok).toBe(true);
  });

  test("rejects foreign, stale, and malformed input without consuming the exact event", async () => {
    const { registry, control, command } = await openCurrent();
    const pending = control.next();
    expect(registry.acceptClaudeExecutionEvent({ relayId, userId: "other", message: eventFor(command, { kind: "started" }) })).toEqual({
      ok: false,
      error: "CLAUDE_EXECUTION_CONTEXT_STALE",
    });
    expect(registry.acceptClaudeExecutionEvent({
      relayId,
      userId: owner,
      message: { type: "relay:claude-execution-event", scope: command.scope, executionRef: command.executionRef, event: { kind: "unknown" } } as unknown as RelayClaudeExecutionDesktopEvent,
    })).toEqual({ ok: false, error: "CLAUDE_EXECUTION_PROTOCOL_INVALID" });
    await start(registry, command);
    expect(await pending).toEqual({ kind: "started" });
  });

  test("bounds buffered observations, sends one best-effort interrupt, and retains only receipt/settlement admission", async () => {
    const { registry, sent, control, command } = await openCurrent();
    await start(registry, command);
    await control.next();
    for (let index = 0; index < 32; index += 1) {
      expect(registry.acceptClaudeExecutionEvent({
        relayId,
        userId: owner,
        message: eventFor(command, { kind: "activity", activity: "hook", state: "progress" }),
      })).toEqual({ ok: true });
    }
    expect(registry.acceptClaudeExecutionEvent({
      relayId,
      userId: owner,
      message: eventFor(command, { kind: "activity", activity: "hook", state: "progress" }),
    })).toEqual({ ok: true });
    expect(sent.at(-1)).toMatchObject({ type: "relay:claude-execution-command", action: { kind: "interrupt" } });
    const interrupt = control.interrupt();
    await expectFailure(control.next(), "CLAUDE_EXECUTION_BACKPRESSURE");
    expect(registry.acceptClaudeExecutionEvent({
      relayId,
      userId: owner,
      message: eventFor(command, { kind: "settled", outcome: "rejected" }),
    })).toEqual({ ok: true });
    expect(await interrupt).toBe("uncertain");
    expect(sent.filter((message) => message.type === "relay:claude-execution-command" && message.action.kind === "interrupt")).toHaveLength(1);
    expect(open(registry, { prompt: "successor" }).ok).toBe(true);
  });

  test("revision, replacement, unregister, and stop reject the thin stream waiters", async () => {
    const revision = await openCurrent();
    const revisionWaiter = revision.control.next();
    expect(revision.registry.updateCapabilities({
      relayId,
      userId: owner,
      desktopSessionId: "desktop-1",
      capabilityRevision: 1,
      capabilities,
    })).toEqual({ ok: true });
    await expectFailure(revisionWaiter, "CLAUDE_EXECUTION_CONTEXT_STALE");

    const replacement = await openCurrent();
    const replacementWaiter = replacement.control.next();
    await replacement.registry.register(relayId, owner, capabilities, () => undefined, 18, "desktop-2", 1, "pair-2");
    await expectFailure(replacementWaiter, "CLAUDE_EXECUTION_CONTEXT_STALE");

    const disconnected = await openCurrent();
    const disconnectWaiter = disconnected.control.next();
    await disconnected.registry.unregister(relayId);
    await expectFailure(disconnectWaiter, "CLAUDE_EXECUTION_UNAVAILABLE");

    const stopped = await openCurrent();
    const stopWaiter = stopped.control.next();
    stopped.registry.stop();
    await expectFailure(stopWaiter, "CLAUDE_EXECUTION_UNAVAILABLE");
  });
});

async function expectFailure(promise: Promise<unknown>, message: string): Promise<void> {
  let failure: unknown;
  try {
    await promise;
  } catch (error) {
    failure = error;
  }
  expect(failure).toMatchObject({ message });
}
