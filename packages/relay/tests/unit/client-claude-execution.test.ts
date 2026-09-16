import { describe, expect, mock, test } from "bun:test";
import type { RelayClaudeExecutionHostTransport } from "../../src/client";
import type { RelayCapabilities } from "../../src/types";
import { CLAUDE_EXECUTION_PROTOCOL_VERSION } from "../../src/claude-execution-protocol";

class MockRelayWebSocket {
  static OPEN = 1;
  static CONNECTING = 0;
  static CLOSED = 3;
  readyState = MockRelayWebSocket.CONNECTING;
  sent: string[] = [];
  private handlers = new Map<string, Array<(...args: unknown[]) => void>>();
  constructor(_url: string) {}
  on(event: string, handler: (...args: unknown[]) => void): this {
    this.handlers.set(event, [...(this.handlers.get(event) ?? []), handler]);
    return this;
  }
  send(data: string): void { this.sent.push(data); }
  close(): void {
    this.readyState = MockRelayWebSocket.CLOSED;
    for (const handler of this.handlers.get("close") ?? []) handler();
  }
  open(): void {
    this.readyState = MockRelayWebSocket.OPEN;
    for (const handler of this.handlers.get("open") ?? []) handler();
  }
  message(data: string): void {
    for (const handler of this.handlers.get("message") ?? []) handler(data);
  }
}

const sockets: MockRelayWebSocket[] = [];
mock.module("ws", () => ({ default: class extends MockRelayWebSocket {
  constructor(url: string) { super(url); sockets.push(this); }
} }));
const { createRelayClient } = await import("../../src/client");

const capabilities: RelayCapabilities = {
  profile: "desktop-agent",
  claudeExecution: { version: 2 },
};

function registered(socket: MockRelayWebSocket, revision = 0): void {
  socket.message(JSON.stringify({
    type: "relay:registered",
    relayId: "relay-1",
    protocolVersion: CLAUDE_EXECUTION_PROTOCOL_VERSION,
    relaySessionId: "session-1",
    pairingGenerationRef: "pair-1",
    selectedProtocolVersion: CLAUDE_EXECUTION_PROTOCOL_VERSION,
    capabilityRevision: revision,
  }));
}

function scope(revision = 0, relaySessionId = "session-1", pairingGenerationRef = "pair-1") {
  return {
    relayId: "relay-1",
    relaySessionId,
    desktopSessionId: "desktop-1",
    pairingGenerationRef,
    selectedProtocolVersion: CLAUDE_EXECUTION_PROTOCOL_VERSION,
    capabilityRevision: revision,
  } as const;
}

function startCommand(revision = 0) {
  return {
    type: "relay:claude-execution-command",
    scope: scope(revision),
    executionRef: "execution-1",
    action: { kind: "start", prompt: "Summarize this repository", model: "claude-fable-5" },
  } as const;
}

function requireTransport(value: RelayClaudeExecutionHostTransport | null): RelayClaudeExecutionHostTransport {
  if (value === null) throw new Error("missing execution transport");
  return value;
}

function requireReject(value: ((error: Error) => void) | null): (error: Error) => void {
  if (value === null) throw new Error("missing deferred host command");
  return value;
}

describe("D452 v18 Claude execution relay client", () => {
  test("registers one ready Desktop host and only forwards exact current-socket traffic", async () => {
    let registrations = 0;
    let commands = 0;
    let disconnected = 0;
    let transport: RelayClaudeExecutionHostTransport | null = null;
    const client = createRelayClient({
      serverUrl: "http://127.0.0.1:9", userId: "owner-1", relayId: "relay-1",
      desktopSessionId: "desktop-1", capabilities, onDispatch: async () => ({ status: "ok" }),
      claudeExecutionHostPort: {
        isReady: () => true,
        onRegistered: (session, nextTransport) => {
          registrations++;
          expect(Object.isFrozen(session)).toBe(true);
          transport = nextTransport;
        },
        onCommand: () => { commands++; },
        onDisconnected: () => { disconnected++; },
      },
    });
    const connecting = client.connect();
    const socket = sockets.at(-1)!;
    socket.open();
    registered(socket);
    await connecting;
    expect(registrations).toBe(1);
    expect(transport).not.toBeNull();

    socket.message(JSON.stringify(startCommand()));
    socket.message(JSON.stringify({ ...startCommand(), scope: { ...scope(), relayId: "foreign" } }));
    socket.message(JSON.stringify({ ...startCommand(), action: { kind: "start", prompt: "p", model: "m", path: "/private" } }));
    expect(commands).toBe(1);

    const currentTransport = requireTransport(transport);
    const event = {
      type: "relay:claude-execution-event",
      scope: scope(),
      executionRef: "execution-1",
      event: { kind: "activity", activity: "tool", state: "progress", toolName: "Edit" },
    } as const;
    expect(currentTransport.send(event)).toBe(true);
    expect(currentTransport.send({ ...event, scope: { ...scope(), capabilityRevision: 1 } })).toBe(false);
    const sentEvents = socket.sent.map((raw) => JSON.parse(raw) as { type?: unknown })
      .filter((frame) => frame.type === "relay:claude-execution-event");
    expect(sentEvents).toHaveLength(1);

    await client.disconnect();
    expect(disconnected).toBe(1);
    expect(currentTransport.send(event)).toBe(false);
  });

  test("never registers below v18, without the distinct capability, or while not ready", async () => {
    const cases: Array<{ protocol: number; nextCapabilities: RelayCapabilities; ready: boolean }> = [
      { protocol: 17, nextCapabilities: capabilities, ready: true },
      { protocol: CLAUDE_EXECUTION_PROTOCOL_VERSION, nextCapabilities: { profile: "desktop-agent" }, ready: true },
      { protocol: CLAUDE_EXECUTION_PROTOCOL_VERSION, nextCapabilities: capabilities, ready: false },
    ];
    for (const item of cases) {
      let registrations = 0;
      const client = createRelayClient({
        serverUrl: "http://127.0.0.1:9", userId: "owner-1", relayId: "relay-1",
        desktopSessionId: "desktop-1", capabilities: item.nextCapabilities, onDispatch: async () => ({ status: "ok" }),
        claudeExecutionHostPort: {
          isReady: () => item.ready,
          onRegistered: () => { registrations++; },
          onCommand: () => undefined,
        },
      });
      const connecting = client.connect();
      const socket = sockets.at(-1)!;
      socket.open();
      socket.message(JSON.stringify({
        type: "relay:registered", relayId: "relay-1", protocolVersion: item.protocol,
        relaySessionId: "session-1", pairingGenerationRef: "pair-1", selectedProtocolVersion: item.protocol,
      }));
      await connecting;
      expect(registrations).toBe(0);
      await client.disconnect();
    }
  });

  test("deactivates on host rejection and rejects malformed/non-desktop capability updates", async () => {
    let disconnected = 0;
    const client = createRelayClient({
      serverUrl: "http://127.0.0.1:9", userId: "owner-1", relayId: "relay-1",
      desktopSessionId: "desktop-1", capabilities, onDispatch: async () => ({ status: "ok" }),
      claudeExecutionHostPort: {
        isReady: () => true,
        onRegistered: () => undefined,
        onCommand: async () => { throw new Error("host rejected command"); },
        onDisconnected: () => { disconnected++; },
      },
    });
    const connecting = client.connect();
    const socket = sockets.at(-1)!;
    socket.open();
    registered(socket);
    await connecting;
    socket.message(JSON.stringify(startCommand()));
    await Promise.resolve();
    await Promise.resolve();
    expect(disconnected).toBe(1);
    let malformedError: unknown;
    try {
      await client.updateCapabilities({ profile: "desktop-agent", claudeExecution: { version: 1 } as never });
    } catch (error) {
      malformedError = error;
    }
    expect(malformedError).toBeInstanceOf(Error);
    expect((malformedError as Error).message).toBe("invalid Claude execution capability");
    let profileError: unknown;
    try {
      await client.updateCapabilities({ profile: "device-relay", claudeExecution: { version: 2 } });
    } catch (error) {
      profileError = error;
    }
    expect(profileError).toBeInstanceOf(Error);
    expect((profileError as Error).message).toBe("invalid Claude execution capability");
    await client.disconnect();
  });

  test("does not let a stale async command rejection deactivate a replacement host", async () => {
    let rejectCommand: ((error: Error) => void) | null = null;
    let disconnected = 0;
    const transports: RelayClaudeExecutionHostTransport[] = [];
    const client = createRelayClient({
      serverUrl: "http://127.0.0.1:9", userId: "owner-1", relayId: "relay-1",
      desktopSessionId: "desktop-1", capabilities, onDispatch: async () => ({ status: "ok" }),
      claudeExecutionHostPort: {
        isReady: () => true,
        onRegistered: (_session, transport) => { transports.push(transport); },
        onCommand: () => new Promise<void>((_resolve, reject) => { rejectCommand = reject as (error: Error) => void; }),
        onDisconnected: () => { disconnected++; },
      },
    });
    const connecting = client.connect();
    const socket = sockets.at(-1)!;
    socket.open();
    registered(socket);
    await connecting;
    socket.message(JSON.stringify(startCommand()));
    socket.message(JSON.stringify({
      type: "relay:registered", relayId: "relay-1", protocolVersion: CLAUDE_EXECUTION_PROTOCOL_VERSION,
      relaySessionId: "session-2", pairingGenerationRef: "pair-2", selectedProtocolVersion: CLAUDE_EXECUTION_PROTOCOL_VERSION,
    }));
    expect(transports).toHaveLength(2);
    expect(disconnected).toBe(1);
    requireReject(rejectCommand)(new Error("stale host rejection"));
    await Promise.resolve();
    await Promise.resolve();
    expect(disconnected).toBe(1);
    expect(transports[1]!.send({
      type: "relay:claude-execution-event",
      scope: scope(0, "session-2", "pair-2"),
      executionRef: "execution-2",
      event: { kind: "started" },
    })).toBe(true);
    await client.disconnect();
  });
});
