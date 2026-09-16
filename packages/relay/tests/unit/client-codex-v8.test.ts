import { describe, expect, mock, test } from "bun:test";
import type { RelayCapabilities } from "../../src/types";

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
  close(): void { this.readyState = MockRelayWebSocket.CLOSED; for (const h of this.handlers.get("close") ?? []) h(); }
  open(): void { this.readyState = MockRelayWebSocket.OPEN; for (const h of this.handlers.get("open") ?? []) h(); }
  message(data: string): void { for (const h of this.handlers.get("message") ?? []) h(data); }
}
const sockets: MockRelayWebSocket[] = [];
mock.module("ws", () => ({ default: class extends MockRelayWebSocket { constructor(url: string) { super(url); sockets.push(this); } } }));
const { createRelayClient } = await import("../../src/client");

const CAPABILITIES: RelayCapabilities = {
  profile: "desktop-agent",
  codex: { version: 1, hostKind: "electron", maxProfiles: 4, maxActiveTurns: 4 },
};
const ACP_CAPABILITIES: RelayCapabilities = {
  profile: "desktop-agent",
  acp: { version: 1, hostKind: "electron", registrations: ["hermes-acp"] },
};

describe("D453 RelayCodexHostPort", () => {
  test("does not invoke the host or emit Codex frames before an enriched v8 ack", async () => {
    let registered = 0;
    const client = createRelayClient({
      serverUrl: "http://127.0.0.1:9", userId: "user-1", relayId: "relay-1",
      capabilities: CAPABILITIES, desktopSessionId: "desktop-1",
      onDispatch: async () => ({ status: "ok" }),
      codexHostPort: { isReady: () => true, onRegistered: () => { registered++; } },
    });
    const connecting = client.connect();
    const socket = sockets[0]!;
    socket.open();
    socket.message(JSON.stringify({ type: "relay:registered", relayId: "relay-1" }));
    await connecting;
    expect(registered).toBe(0);
    await client.disconnect();
  });

  test("creates one fresh v8 transport after acknowledgement and routes no generic dispatch", async () => {
    let registered = 0;
    let statusSent = false;
    const client = createRelayClient({
      serverUrl: "http://127.0.0.1:9", userId: "user-1", relayId: "relay-1",
      capabilities: CAPABILITIES, desktopSessionId: "desktop-1",
      onDispatch: async () => ({ status: "ok" }),
      codexHostPort: {
        isReady: () => true,
        onRegistered: (session, transport) => {
          registered++;
          const { capabilityRevision, ...socketScope } = session;
          statusSent = transport.send({
            type: "relay:codex-status",
            socket: socketScope,
            capabilityRevision,
            status: { state: "workspace_unavailable", workspace: { state: "unavailable" } },
          });
        },
      },
    });
    const connecting = client.connect();
    const socket = sockets[sockets.length - 1]!;
    socket.open();
    socket.message(JSON.stringify({
      type: "relay:registered", relayId: "relay-1", relaySessionId: "session-1",
      protocolVersion: 9, pairingGenerationRef: "pair-ref-1", selectedProtocolVersion: 9,
    }));
    await connecting;
    expect(registered).toBe(1);
    expect(statusSent).toBe(true);
    expect(socket.sent.some((raw) => (JSON.parse(raw) as { type: string }).type === "relay:codex-status")).toBe(true);
    expect(socket.sent.some((raw) => (JSON.parse(raw) as { type: string }).type === "relay:dispatch")).toBe(false);
    await client.disconnect();
  });

  test("suppresses an explicitly unready host", async () => {
    let registered = 0;
    const client = createRelayClient({
      serverUrl: "http://127.0.0.1:9", userId: "user-1", relayId: "relay-1",
      capabilities: CAPABILITIES, desktopSessionId: "desktop-1",
      onDispatch: async () => ({ status: "ok" }),
      codexHostPort: {
        isReady: () => false,
        onRegistered: () => { registered++; },
      },
    });
    const connecting = client.connect();
    const socket = sockets[sockets.length - 1]!;
    socket.open();
    socket.message(JSON.stringify({
      type: "relay:registered", relayId: "relay-1", relaySessionId: "session-unready",
      pairingGenerationRef: "pair-unready", selectedProtocolVersion: 8,
    }));
    await connecting;
    expect(registered).toBe(0);
    await client.disconnect();
  });

  test("retains the authenticated ack across capability add/remove and readiness throws", async () => {
    let readiness: "ready" | "unready" | "throw" = "unready";
    let registered = 0;
    let disconnected = 0;
    const noCodex: RelayCapabilities = { profile: "desktop-agent" };
    const client = createRelayClient({
      serverUrl: "http://127.0.0.1:9", userId: "user-1", relayId: "relay-1",
      capabilities: noCodex, desktopSessionId: "desktop-1",
      onDispatch: async () => ({ status: "ok" }),
      codexHostPort: {
        isReady: () => {
          if (readiness === "throw") throw new Error("not ready");
          return readiness === "ready";
        },
        onRegistered: () => { registered++; },
        onDisconnected: () => { disconnected++; },
      },
    });
    const connecting = client.connect();
    const socket = sockets[sockets.length - 1]!;
    socket.open();
    socket.message(JSON.stringify({
      type: "relay:registered", relayId: "relay-1", relaySessionId: "session-transition",
      pairingGenerationRef: "pair-transition", selectedProtocolVersion: 8,
    }));
    await connecting;
    expect(registered).toBe(0);

    readiness = "ready";
    const add = client.updateCapabilities(CAPABILITIES);
    socket.message(JSON.stringify({
      type: "relay:capabilities-updated", relayId: "relay-1",
      capabilityRevision: 1, status: "ok",
    }));
    await add;
    expect(registered).toBe(1);

    const remove = client.updateCapabilities(noCodex);
    socket.message(JSON.stringify({
      type: "relay:capabilities-updated", relayId: "relay-1",
      capabilityRevision: 2, status: "ok",
    }));
    await remove;
    expect(disconnected).toBe(1);

    readiness = "throw";
    const throwingAdd = client.updateCapabilities(CAPABILITIES);
    socket.message(JSON.stringify({
      type: "relay:capabilities-updated", relayId: "relay-1",
      capabilityRevision: 3, status: "ok",
    }));
    await throwingAdd;
    expect(registered).toBe(1);
    await client.disconnect();
  });

  test("reconnect replaces the authenticated Codex session and clears activation state", async () => {
    const sessions: string[] = [];
    let disconnected = 0;
    const client = createRelayClient({
      serverUrl: "http://127.0.0.1:9", userId: "user-1", relayId: "relay-1",
      capabilities: CAPABILITIES, desktopSessionId: "desktop-1",
      onDispatch: async () => ({ status: "ok" }),
      codexHostPort: {
        isReady: () => true,
        onRegistered: (session) => { sessions.push(session.relaySessionId); },
        onDisconnected: () => { disconnected++; },
      },
    });
    const firstConnect = client.connect();
    const firstSocket = sockets[sockets.length - 1]!;
    firstSocket.open();
    firstSocket.message(JSON.stringify({
      type: "relay:registered", relayId: "relay-1", relaySessionId: "session-a",
      pairingGenerationRef: "pair-a", selectedProtocolVersion: 8,
    }));
    await firstConnect;
    await client.disconnect();

    const secondConnect = client.connect();
    const secondSocket = sockets[sockets.length - 1]!;
    secondSocket.open();
    secondSocket.message(JSON.stringify({
      type: "relay:registered", relayId: "relay-1", relaySessionId: "session-b",
      pairingGenerationRef: "pair-b", selectedProtocolVersion: 8,
    }));
    await secondConnect;
    expect(sessions).toEqual(["session-a", "session-b"]);
    expect(disconnected).toBe(1);
    await client.disconnect();
  });

  test("invokes a command once and replays the cached response on an identical retry", async () => {
    let calls = 0;
    let wrongResponseSent = true;
    let sessionScope: Parameters<NonNullable<NonNullable<Parameters<typeof createRelayClient>[0]["codexHostPort"]>["onRegistered"]>>[0] | null = null;
    let hostTransport: Parameters<NonNullable<NonNullable<Parameters<typeof createRelayClient>[0]["codexHostPort"]>["onRegistered"]>>[1] | null = null;
    const client = createRelayClient({
      serverUrl: "http://127.0.0.1:9", userId: "user-1", relayId: "relay-1",
      capabilities: CAPABILITIES, desktopSessionId: "desktop-1",
      onDispatch: async () => ({ status: "ok" }),
      codexHostPort: {
        isReady: () => true,
        onRegistered: (session, transport) => {
          sessionScope = session;
          hostTransport = transport;
        },
        onCommand: (message) => {
          calls++;
          wrongResponseSent = hostTransport?.send({
            type: "relay:codex-command-response",
            commandId: message.commandId,
            scope: message.scope,
            result: {
              kind: "profile_status",
              state: "created",
              profileHandle: "wrong",
              profileGeneration: 1,
              homeHandle: "wrong-home",
            },
          }) ?? true;
          hostTransport?.send({
            type: "relay:codex-command-response",
            commandId: message.commandId,
            scope: message.scope,
            result: { kind: "runtime_status", state: "ready", runtimeGeneration: 1 },
          });
        },
      },
    });
    const connecting = client.connect();
    const socket = sockets[sockets.length - 1]!;
    socket.open();
    socket.message(JSON.stringify({
      type: "relay:registered", relayId: "relay-1", relaySessionId: "session-cache",
      pairingGenerationRef: "pair-cache", selectedProtocolVersion: 8,
    }));
    await connecting;
    expect(sessionScope).not.toBeNull();
    const command = {
      type: "relay:codex-command",
      commandId: "command-cache",
      scope: {
        relayId: "relay-1", relaySessionId: "session-cache", desktopSessionId: "desktop-1",
        pairingGenerationRef: "pair-cache", selectedProtocolVersion: 8,
        capabilityRevision: 0,
      },
      command: { kind: "runtime_inspect" },
    };
    socket.message(JSON.stringify(command));
    socket.message(JSON.stringify(command));
    expect(calls).toBe(1);
    expect(wrongResponseSent).toBe(false);
    expect(socket.sent.filter((raw) =>
      (JSON.parse(raw) as { type: string }).type === "relay:codex-command-response"
    )).toHaveLength(2);

    socket.message(JSON.stringify({
      ...command,
      scope: { ...command.scope, capabilityRevision: 99 },
    }));
    expect(calls).toBe(1);
    await client.disconnect();
  });
});

describe("D452 RelayAcpHostPort callback isolation", () => {
  test("sends prepared and nested-scope execution frames on the exact v14 socket", async () => {
    const results: boolean[] = [];
    const client = createRelayClient({
      serverUrl: "http://127.0.0.1:9", userId: "user-1", relayId: "relay-acp-send",
      capabilities: ACP_CAPABILITIES, desktopSessionId: "desktop-acp-send",
      onDispatch: async () => ({ status: "ok" }),
      acpHostPort: {
        isReady: () => true,
        onRegistered: (socket, transport) => {
          const binding = { bindingId: "binding", bindingGeneration: "generation", ownerId: "owner", taskId: "task", taskRunId: "run", jobId: "job", profileId: "profile", profileGeneration: "profile-generation", postureId: "posture", postureGeneration: "posture-generation" };
          const workspace = { workspaceReceiptId: "receipt", workspaceRevision: "revision", workspaceFingerprint: "fingerprint", workspaceExpiresAt: "2030-01-01T00:00:00.000Z" };
          const scope = { socket, binding, workspace };
          const process = { connectionId: "connection", processGeneration: 1, acpSessionId: "acp", turnGeneration: 1, turnRef: "turn" };
          results.push(
            transport.send({ type: "relay:acp-prepared", requestId: "prepare", registrationId: "hermes-acp", scope: socket, binding, workspace }),
            transport.send({ type: "relay:acp-started", registrationId: "hermes-acp", scope, process, capabilities: { requests: "unsupported" }, eventId: "event-1", eventSequence: 1 }),
            transport.send({ type: "relay:acp-semantic", registrationId: "hermes-acp", scope, process, capabilities: { requests: "unsupported" }, payload: { kind: "output_delta", vendorItemId: null, text: "ok" }, eventId: "event-2", eventSequence: 2 }),
            transport.send({ type: "relay:acp-terminal", registrationId: "hermes-acp", scope, process, status: "completed", eventId: "event-3", eventSequence: 3 }),
          );
        },
      },
    });
    const connecting = client.connect();
    const socket = sockets[sockets.length - 1]!;
    socket.open();
    socket.message(JSON.stringify({
      type: "relay:registered", relayId: "relay-acp-send", relaySessionId: "session-acp-send",
      pairingGenerationRef: "pair-acp-send", selectedProtocolVersion: 14,
    }));
    await connecting;
    expect(results).toEqual([true, true, true, true]);
    expect(socket.sent.map((raw) => (JSON.parse(raw) as { type: string }).type).filter((type) => type.startsWith("relay:acp-"))).toEqual([
      "relay:acp-prepared", "relay:acp-started", "relay:acp-semantic", "relay:acp-terminal",
    ]);
    await client.disconnect();
  });

  test("contains rejected readiness, prepare, and start callbacks", async () => {
    const calls: string[] = [];
    const client = createRelayClient({
      serverUrl: "http://127.0.0.1:9", userId: "user-1", relayId: "relay-acp",
      capabilities: ACP_CAPABILITIES, desktopSessionId: "desktop-acp",
      onDispatch: async () => ({ status: "ok" }),
      acpHostPort: {
        isReady: () => true,
        onReadiness: async () => { calls.push("readiness"); throw new Error("expected"); },
        onPrepare: async () => { calls.push("prepare"); throw new Error("expected"); },
        onStart: async () => { calls.push("start"); throw new Error("expected"); },
        onContain: async () => { calls.push("contain"); throw new Error("expected"); },
      },
    });
    const connecting = client.connect();
    const socket = sockets[sockets.length - 1]!;
    socket.open();
    socket.message(JSON.stringify({
      type: "relay:registered", relayId: "relay-acp", relaySessionId: "session-acp",
      pairingGenerationRef: "pair-acp", selectedProtocolVersion: 14,
    }));
    await connecting;
    const scope = { relayId: "relay-acp", relaySessionId: "session-acp", desktopSessionId: "desktop-acp", pairingGenerationRef: "pair-acp", selectedProtocolVersion: 14, capabilityRevision: 0 };
    const binding = { bindingId: "binding", bindingGeneration: "generation", ownerId: "owner", taskId: "task", taskRunId: "run", jobId: "job", profileId: "profile", profileGeneration: "profile-generation", postureId: "posture", postureGeneration: "posture-generation" };
    const workspace = { workspaceReceiptId: "receipt", workspaceRevision: "revision", workspaceFingerprint: "fingerprint", workspaceExpiresAt: "2030-01-01T00:00:00.000Z" };
    socket.message(JSON.stringify({ type: "relay:acp-readiness", requestId: "request", registrationId: "hermes-acp", scope }));
    socket.message(JSON.stringify({ type: "relay:acp-prepare", requestId: "prepare", registrationId: "hermes-acp", scope, binding }));
    socket.message(JSON.stringify({ type: "relay:acp-start", registrationId: "hermes-acp", scope: { socket: scope, binding, workspace }, prompt: "work" }));
    const process = { connectionId: "connection", processGeneration: 1, acpSessionId: "acp", turnGeneration: 1, turnRef: "turn" };
    const contain = { type: "relay:acp-contain", registrationId: "hermes-acp", containmentRef: "contain-1", scope: { socket: scope, binding, workspace }, process, code: "upstream_failure" };
    socket.message(JSON.stringify(contain));
    socket.message(JSON.stringify(contain));
    socket.message(JSON.stringify({ ...contain, process: { ...process, turnRef: "conflict" } }));
    socket.message(JSON.stringify({ ...contain, containmentRef: "contain-2" }));
    await Promise.resolve();
    expect(calls).toEqual(["readiness", "prepare", "start", "contain", "contain"]);
    await client.disconnect();
  });
});
