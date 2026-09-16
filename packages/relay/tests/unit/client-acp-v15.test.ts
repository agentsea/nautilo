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
  close(): void { this.readyState = MockRelayWebSocket.CLOSED; for (const handler of this.handlers.get("close") ?? []) handler(); }
  open(): void { this.readyState = MockRelayWebSocket.OPEN; for (const handler of this.handlers.get("open") ?? []) handler(); }
  message(data: string): void { for (const handler of this.handlers.get("message") ?? []) handler(data); }
}

const sockets: MockRelayWebSocket[] = [];
mock.module("ws", () => ({ default: class extends MockRelayWebSocket {
  constructor(url: string) { super(url); sockets.push(this); }
} }));
const { createRelayClient } = await import("../../src/client");

const capabilities: RelayCapabilities = {
  profile: "desktop-agent",
  acp: { version: 2, hostKind: "electron", registrations: ["hermes-acp", "opencode-acp"] },
};

describe("D452 RelayAcpHostPort v15 provider routing", () => {
  test("disconnect awaits exact ACP host containment before closing the socket", async () => {
    let release!: () => void;
    let containmentStarted = false;
    const client = createRelayClient({
      serverUrl: "http://127.0.0.1:9", userId: "owner-1", relayId: "relay-await",
      capabilities, desktopSessionId: "desktop-await", onDispatch: async () => ({ status: "ok" }),
      acpHostPort: {
        isReady: () => true,
        onDisconnected: async () => {
          containmentStarted = true;
          await new Promise<void>((resolve) => { release = resolve; });
        },
      },
    });
    const connecting = client.connect();
    const socket = sockets.at(-1)!;
    socket.open();
    socket.message(JSON.stringify({
      type: "relay:registered", relayId: "relay-await", relaySessionId: "session-await",
      pairingGenerationRef: "pair-await", selectedProtocolVersion: 15,
    }));
    await connecting;
    let settled = false;
    const disconnecting = client.disconnect().then(() => { settled = true; });
    await Promise.resolve();
    expect(containmentStarted).toBeTrue();
    expect(settled).toBeFalse();
    expect(socket.readyState).toBe(MockRelayWebSocket.OPEN);
    release();
    await disconnecting;
    expect(settled).toBeTrue();
    expect(socket.readyState).toBe(MockRelayWebSocket.CLOSED);
  });

  test("routes and emits OpenCode frames only on the advertised exact v15 socket", async () => {
    const calls: string[] = [];
    const sends: boolean[] = [];
    const client = createRelayClient({
      serverUrl: "http://127.0.0.1:9", userId: "owner-1", relayId: "relay-1",
      capabilities, desktopSessionId: "desktop-1", onDispatch: async () => ({ status: "ok" }),
      acpHostPort: {
        isReady: () => true,
        onRegistered: (socket, transport) => {
          const binding = { bindingId: "binding", bindingGeneration: "generation", ownerId: "owner", taskId: "task", taskRunId: "run", jobId: "job", profileId: "profile", profileGeneration: "profile-generation", postureId: "posture", postureGeneration: "posture-generation" };
          const workspace = { workspaceReceiptId: "receipt", workspaceRevision: "revision", workspaceFingerprint: "fingerprint", workspaceExpiresAt: "2030-01-01T00:00:00.000Z" };
          const scope = { socket, binding, workspace };
          const process = { connectionId: "connection", processGeneration: 1, acpSessionId: "acp", turnGeneration: 1, turnRef: "turn" };
          sends.push(
            transport.send({ type: "relay:acp-prepared", requestId: "prepare", registrationId: "opencode-acp", scope: socket, binding, workspace }),
            transport.send({ type: "relay:acp-started", registrationId: "opencode-acp", scope, process, capabilities: { requests: "unsupported" }, eventId: "event-1", eventSequence: 1 }),
            transport.send({ type: "relay:acp-start-failed", registrationId: "opencode-acp", scope, stage: "initialized" }),
            transport.send({ type: "relay:acp-semantic", registrationId: "opencode-acp", scope, process, capabilities: { requests: "unsupported" }, payload: { kind: "output_delta", vendorItemId: null, text: "ok" }, eventId: "event-2", eventSequence: 2 }),
            transport.send({ type: "relay:acp-terminal", registrationId: "opencode-acp", scope, process, status: "completed", eventId: "event-3", eventSequence: 3 }),
          );
        },
        onPrepare: (message) => { calls.push(`prepare:${message.registrationId}`); },
        onStart: (message) => { calls.push(`start:${message.registrationId}:${message.registrationId === "opencode-acp" ? message.executionProfile : "none"}`); },
        onContain: (message) => { calls.push(`contain:${message.registrationId}`); },
      },
    });
    const connecting = client.connect();
    const socket = sockets.at(-1)!;
    socket.open();
    socket.message(JSON.stringify({
      type: "relay:registered", relayId: "relay-1", relaySessionId: "session-1",
      pairingGenerationRef: "pair-1", selectedProtocolVersion: 15,
    }));
    await connecting;
    expect(sends).toEqual([true, true, true, true, true]);

    const socketScope = { relayId: "relay-1", relaySessionId: "session-1", desktopSessionId: "desktop-1", pairingGenerationRef: "pair-1", selectedProtocolVersion: 15, capabilityRevision: 0 };
    const binding = { bindingId: "binding", bindingGeneration: "generation", ownerId: "owner", taskId: "task", taskRunId: "run", jobId: "job", profileId: "profile", profileGeneration: "profile-generation", postureId: "posture", postureGeneration: "posture-generation" };
    const workspace = { workspaceReceiptId: "receipt", workspaceRevision: "revision", workspaceFingerprint: "fingerprint", workspaceExpiresAt: "2030-01-01T00:00:00.000Z" };
    const executionScope = { socket: socketScope, binding, workspace };
    const process = { connectionId: "connection", processGeneration: 1, acpSessionId: "acp", turnGeneration: 1, turnRef: "turn" };
    socket.message(JSON.stringify({ type: "relay:acp-prepare", requestId: "prepare", registrationId: "opencode-acp", scope: socketScope, binding }));
    socket.message(JSON.stringify({ type: "relay:acp-start", registrationId: "opencode-acp", scope: executionScope, prompt: "work", executionProfile: "interactive" }));
    socket.message(JSON.stringify({ type: "relay:acp-contain", registrationId: "hermes-acp", containmentRef: "same-ref", scope: executionScope, process, code: "upstream_failure" }));
    socket.message(JSON.stringify({ type: "relay:acp-contain", registrationId: "opencode-acp", containmentRef: "same-ref", scope: executionScope, process, code: "upstream_failure" }));
    await Promise.resolve();
    expect(calls).toEqual([
      "prepare:opencode-acp", "start:opencode-acp:interactive",
      "contain:hermes-acp", "contain:opencode-acp",
    ]);
    await client.disconnect();
  });

  test("rejects OpenCode host traffic on a v14 socket while retaining Hermes", async () => {
    const calls: string[] = [];
    const sends: boolean[] = [];
    const client = createRelayClient({
      serverUrl: "http://127.0.0.1:9", userId: "owner-1", relayId: "relay-old",
      capabilities, desktopSessionId: "desktop-old", onDispatch: async () => ({ status: "ok" }),
      acpHostPort: {
        isReady: () => true,
        onRegistered: (socket, transport) => {
          const binding = { bindingId: "binding", bindingGeneration: "generation", ownerId: "owner", taskId: "task", taskRunId: "run", jobId: "job", profileId: "profile", profileGeneration: "profile-generation", postureId: "posture", postureGeneration: "posture-generation" };
          const workspace = { workspaceReceiptId: "receipt", workspaceRevision: "revision", workspaceFingerprint: "fingerprint", workspaceExpiresAt: "2030-01-01T00:00:00.000Z" };
          sends.push(transport.send({ type: "relay:acp-prepared", requestId: "open", registrationId: "opencode-acp", scope: socket, binding, workspace }));
          sends.push(transport.send({ type: "relay:acp-prepared", requestId: "hermes", registrationId: "hermes-acp", scope: socket, binding, workspace }));
        },
        onPrepare: (message) => { calls.push(message.registrationId); },
      },
    });
    const connecting = client.connect();
    const socket = sockets.at(-1)!;
    socket.open();
    socket.message(JSON.stringify({
      type: "relay:registered", relayId: "relay-old", relaySessionId: "session-old",
      pairingGenerationRef: "pair-old", selectedProtocolVersion: 14,
    }));
    await connecting;
    expect(sends).toEqual([false, true]);
    const scope = { relayId: "relay-old", relaySessionId: "session-old", desktopSessionId: "desktop-old", pairingGenerationRef: "pair-old", selectedProtocolVersion: 14, capabilityRevision: 0 };
    const binding = { bindingId: "binding", bindingGeneration: "generation", ownerId: "owner", taskId: "task", taskRunId: "run", jobId: "job", profileId: "profile", profileGeneration: "profile-generation", postureId: "posture", postureGeneration: "posture-generation" };
    socket.message(JSON.stringify({ type: "relay:acp-prepare", requestId: "open", registrationId: "opencode-acp", scope, binding }));
    socket.message(JSON.stringify({ type: "relay:acp-prepare", requestId: "hermes", registrationId: "hermes-acp", scope, binding }));
    await Promise.resolve();
    expect(calls).toEqual(["hermes-acp"]);
    await client.disconnect();
  });
});
