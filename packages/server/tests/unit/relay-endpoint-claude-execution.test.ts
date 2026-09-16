import { describe, expect, test } from "bun:test";
import { InMemoryRelayRegistry } from "@nautilo/runtime";
import type {
  RelayCapabilities,
  RelayClaudeExecutionCommand,
  RelayClaudeExecutionDesktopEvent,
  RelayServerMessage,
} from "@nautilo/relay";
import {
  handleRelayClaudeExecutionEvent,
  parseRelayEndpointClientMessage,
} from "../../src/realtime/relay-endpoint";

const owner = "owner-1";
const scope = {
  relayId: "relay-1",
  relaySessionId: "session-1",
  desktopSessionId: "desktop-1",
  pairingGenerationRef: "pair-1",
  selectedProtocolVersion: 18,
  capabilityRevision: 0,
} as const;
const event: RelayClaudeExecutionDesktopEvent = {
  type: "relay:claude-execution-event",
  scope,
  executionRef: "6d141ab4-8ccc-4b69-9e81-75068454f013",
  event: { kind: "started" },
};

describe("D452 relay endpoint Claude execution events", () => {
  test("strictly parses only a bounded canonical Desktop event and rejects decoded bypass", () => {
    const parsed = parseRelayEndpointClientMessage(JSON.stringify(event));
    expect(parsed).toMatchObject({ ok: true, message: event });
    if (!parsed.ok) throw new Error("missing parsed event");
    expect(Object.isFrozen(parsed.message)).toBe(true);
    expect(parseRelayEndpointClientMessage(JSON.stringify({ ...event, privateId: "nope" }))).toEqual({
      ok: false,
      codex: false,
      error: "CLAUDE_EXECUTION_FRAME_INVALID",
    });
    expect(parseRelayEndpointClientMessage(JSON.stringify({ ...event, padding: "😀".repeat(40_000) }))).toEqual({
      ok: false,
      codex: false,
      error: "CLAUDE_EXECUTION_FRAME_TOO_LARGE",
    });
    expect(parseRelayEndpointClientMessage('{"\\u0074ype":"relay:claude-execution-event"}')).toEqual({
      ok: false,
      codex: false,
      error: "CLAUDE_EXECUTION_FRAME_INVALID",
    });
    const serverCommand = {
      type: "relay:claude-execution-command",
      scope,
      executionRef: event.executionRef,
      action: { kind: "interrupt" },
    } as const;
    expect(parseRelayEndpointClientMessage(JSON.stringify(serverCommand))).toEqual({
      ok: false,
      codex: false,
      error: "CLAUDE_EXECUTION_FRAME_INVALID",
    });
    expect(parseRelayEndpointClientMessage(JSON.stringify({ ...serverCommand, padding: "x".repeat(140_000) }))).toEqual({
      ok: false,
      codex: false,
      error: "CLAUDE_EXECUTION_FRAME_TOO_LARGE",
    });
    const escapedCommand = JSON.stringify(serverCommand).replace(
      '"relay:claude-execution-command"',
      '"\\u0072elay:claude-execution-command"',
    );
    expect(parseRelayEndpointClientMessage(escapedCommand)).toEqual({
      ok: false,
      codex: false,
      error: "CLAUDE_EXECUTION_FRAME_INVALID",
    });
  });

  test("routes only a registered current v18 socket and forwards the exact registry result", () => {
    const received: unknown[] = [];
    const registry = {
      acceptClaudeExecutionEvent: (input: unknown) => {
        received.push(input);
        return { ok: true as const };
      },
    };
    expect(handleRelayClaudeExecutionEvent({
      registeredRelayId: scope.relayId,
      registeredUserId: owner,
      registeredProtocolVersion: 18,
      currentSocket: true,
      message: event,
      registry,
    })).toEqual({ ok: true });
    expect(received).toEqual([{ relayId: scope.relayId, userId: owner, message: event }]);
    for (const input of [
      { registeredRelayId: null, registeredUserId: owner, registeredProtocolVersion: 18, currentSocket: true },
      { registeredRelayId: scope.relayId, registeredUserId: null, registeredProtocolVersion: 18, currentSocket: true },
      { registeredRelayId: scope.relayId, registeredUserId: owner, registeredProtocolVersion: 17, currentSocket: true },
      { registeredRelayId: scope.relayId, registeredUserId: owner, registeredProtocolVersion: 18, currentSocket: false },
    ]) {
      expect(handleRelayClaudeExecutionEvent({ ...input, message: event, registry })).toEqual({
        ok: false,
        error: "CLAUDE_EXECUTION_UNAVAILABLE",
      });
    }
    for (const message of [
      { ...event, scope: { ...event.scope, relayId: "other-relay" } },
      { ...event, scope: { ...event.scope, selectedProtocolVersion: 19 } },
    ] as const) {
      expect(handleRelayClaudeExecutionEvent({
        registeredRelayId: scope.relayId,
        registeredUserId: owner,
        registeredProtocolVersion: 18,
        currentSocket: true,
        message,
        registry,
      })).toEqual({ ok: false, error: "CLAUDE_EXECUTION_CONTEXT_STALE" });
    }
    expect(received).toHaveLength(1);
    const failed = {
      acceptClaudeExecutionEvent: () => ({ ok: false as const, error: "CLAUDE_EXECUTION_CONTEXT_STALE" }),
    };
    expect(handleRelayClaudeExecutionEvent({
      registeredRelayId: scope.relayId,
      registeredUserId: owner,
      registeredProtocolVersion: 18,
      currentSocket: true,
      message: event,
      registry: failed,
    })).toEqual({ ok: false, error: "CLAUDE_EXECUTION_CONTEXT_STALE" });
  });

  test("a rejected inbound frame cannot consume the live Runtime control's pending start", async () => {
    const registry = new InMemoryRelayRegistry();
    const sent: RelayServerMessage[] = [];
    const capabilities: RelayCapabilities = { profile: "desktop-agent", claudeExecution: { version: 2 } };
    await registry.register(scope.relayId, owner, capabilities, (message) => sent.push(message), 18, scope.desktopSessionId, 0, "pair-1");
    const expectedScope = registry.getClaudeExecutionSession(scope.relayId, owner);
    if (expectedScope === null) throw new Error("missing execution session");
    const opened = registry.openClaudeExecution({
      relayId: scope.relayId,
      userId: owner,
      prompt: "hello",
      model: "claude-sonnet",
      expectedScope,
    });
    expect(opened.ok).toBe(true);
    if (!opened.ok) throw new Error("missing Runtime control");
    const command = sent.at(-1);
    expect(command?.type).toBe("relay:claude-execution-command");
    if (command?.type !== "relay:claude-execution-command" || command.action.kind !== "start") {
      throw new Error("missing start command");
    }
    const pending = opened.control.next();
    expect(parseRelayEndpointClientMessage(JSON.stringify({
      type: "relay:claude-execution-event",
      scope: command.scope,
      executionRef: command.executionRef,
      event: { kind: "started" },
      forbidden: true,
    }))).toEqual({ ok: false, codex: false, error: "CLAUDE_EXECUTION_FRAME_INVALID" });
    const current = eventFor(command, { kind: "started" });
    expect(handleRelayClaudeExecutionEvent({
      registeredRelayId: scope.relayId,
      registeredUserId: owner,
      registeredProtocolVersion: 18,
      currentSocket: true,
      message: current,
      registry,
    })).toEqual({ ok: true });
    expect(await pending).toEqual({ kind: "started" });
  });
});

function eventFor(
  command: RelayClaudeExecutionCommand,
  item: RelayClaudeExecutionDesktopEvent["event"],
): RelayClaudeExecutionDesktopEvent {
  return {
    type: "relay:claude-execution-event",
    scope: command.scope,
    executionRef: command.executionRef,
    event: item,
  };
}
