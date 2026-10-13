import { describe, expect, mock, test } from "bun:test";
import type { RelayCapabilities } from "../../src/types";
import type { RelayBolterHostTransport } from "../../src/client";
import type { RelayBolterScope } from "../../src/bolter-protocol";
class MockRelayWebSocket {
  static OPEN = 1;
  static CONNECTING = 0;
  static CLOSED = 3;
  readyState = MockRelayWebSocket.CONNECTING;
  sent: string[] = [];
  private handlers = new Map<string, Array<(...args: unknown[]) => void>>();
  constructor(_url: string) {}
  on(event: string, handler: (...args: unknown[]) => void): this { this.handlers.set(event, [...(this.handlers.get(event) ?? []), handler]); return this; }
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


const capabilities: RelayCapabilities = { profile: "desktop-agent", bolter: { version: 1, hostKind: "electron" } };
describe("Bolter authenticated client port", () => {
  test("opens only after negotiated registration and retires old scope on capability replacement", async () => {
    const host = { transport: null as RelayBolterHostTransport | null, scope: null as RelayBolterScope | null };
    let commands = 0; let retired = 0; let acknowledgements = 0;
    const client = createRelayClient({ serverUrl: "http://127.0.0.1:9", userId: "human-1", relayId: "relay-1", capabilities,
      desktopSessionId: "desktop-1", onDispatch: async () => { throw new Error("Bolter must never be dispatched as a tool"); },
      bolterHostPort: { isReady: () => true, onRegistered: (scope, transport) => { host.scope = scope; host.transport = transport; },
        onCommand: () => { commands++; }, onBatchAck: () => { acknowledgements++; }, onAuthorized: () => {}, onDisconnected: () => { retired++; } },
    });
    const connecting = client.connect(); const socket = sockets.at(-1)!; socket.open();
    expect(host.transport).toBeNull();
    socket.message(JSON.stringify({ type: "relay:registered", relayId: "relay-1", protocolVersion: 30,
      relaySessionId: "session-1", pairingGenerationRef: "pair-1", selectedProtocolVersion: 30 }));
    await connecting;
    if (!host.scope || !host.transport) throw new Error("missing Bolter port");
    const scope = host.scope; const transport = host.transport;
    const id = "719f18c6-a3a9-4b8e-994a-9fa36136552e";
    const command = { type: "relay:bolter-command", version: 30, scope, correlationId: id,
      command: { action: "check", connectionId: id, generation: 1 } };
    socket.message(JSON.stringify({ ...command, scope: { ...scope, desktopSessionId: "foreign" } }));
    expect(commands).toBe(0);
    socket.message(JSON.stringify(command)); expect(commands).toBe(1);
    const result = { type: "relay:bolter-result" as const, version: 30 as const, scope, correlationId: id,
      result: { kind: "unavailable" as const, reason: "qualification_required" as const } };
    expect(transport.send(result)).toBe(true);
    socket.message(JSON.stringify({ type: "relay:bolter-batch-ack", version: 30, scope, connectionId: id, generation: 1, batchId: "batch", status: "accepted" }));
    expect(acknowledgements).toBe(1);
    const updating = client.updateCapabilities(capabilities);
    socket.message(JSON.stringify({ type: "relay:capabilities-updated", relayId: "relay-1", capabilityRevision: 1, status: "ok" }));
    await updating;
    expect(retired).toBe(1); expect(transport.send(result)).toBe(false);
    socket.message(JSON.stringify(command)); expect(commands).toBe(1);
    await client.disconnect(); expect(retired).toBe(2); expect(transport.send(result)).toBe(false);
  });
});
