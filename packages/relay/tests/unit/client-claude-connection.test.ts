import { describe, expect, mock, test } from "bun:test";
import type { RelayCapabilities } from "../../src/types";
import type { RelayClaudeConnectionHostTransport } from "../../src/client";
import type { RelayClaudeConnectionDiscoveryResult } from "../../src/claude-connection-protocol";

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

const capabilities: RelayCapabilities = {
  profile: "desktop-agent",
  claude: { version: 1, hostKind: "electron", registrations: ["claude-agent-sdk"] },
};
const correlationId = "6d141ab4-8ccc-4b69-9e81-75068454f013";
const profileRef = "719f18c6-a3a9-4b8e-994a-9fa36136552e";

describe("D452 Claude Connections relay client", () => {
  test("invokes one current discovery command once and accepts only its detached exact result", async () => {
    let discovers = 0;
    let receivedSession: object | null = null;
    const host = { transport: null as RelayClaudeConnectionHostTransport | null };
    const client = createRelayClient({
      serverUrl: "http://127.0.0.1:9", userId: "owner-1", relayId: "relay-1", capabilities,
      desktopSessionId: "desktop-1", onDispatch: async () => ({ status: "ok" }),
      claudeConnectionHostPort: {
        isReady: () => true,
        onRegistered: (session, nextTransport) => { receivedSession = session; host.transport = nextTransport; },
        onDiscover: () => { discovers++; },
      },
    });
    const connecting = client.connect();
    const socket = sockets.at(-1)!;
    socket.open();
    socket.message(JSON.stringify({ type: "relay:registered", relayId: "relay-1", protocolVersion: 17, relaySessionId: "session-1", pairingGenerationRef: "pair-1", selectedProtocolVersion: 17 }));
    await connecting;
    const scope = { relayId: "relay-1", relaySessionId: "session-1", desktopSessionId: "desktop-1", pairingGenerationRef: "pair-1", selectedProtocolVersion: 17, capabilityRevision: 0 };
    const command = { type: "relay:claude-connection-discover", version: 17, correlationId, scope, profileRef };
    socket.message(JSON.stringify(command));
    socket.message(JSON.stringify(command));
    socket.message(JSON.stringify({
      ...command,
      profileRef: "a51f18c6-a3a9-4b8e-994a-9fa36136552e",
    }));
    socket.message(JSON.stringify({ ...command, scope: { ...scope, relayId: "foreign-relay" } }));
    expect(discovers).toBe(1);
    expect(Object.isFrozen(receivedSession)).toBe(true);
    const result: RelayClaudeConnectionDiscoveryResult = { type: "relay:claude-connection-discovery-result", version: 17, correlationId, scope, profileRef, runtime: { state: "ready", version: "2.1.235", executionQualified: true }, account: { state: "connected", apiProvider: "firstParty" }, catalog: { state: "complete", complete: true, models: [] } };
    if (host.transport === null) throw new Error("missing transport");
    const transport = host.transport;
    expect(transport.send(result)).toBe(true);
    (result.account as { apiProvider?: string }).apiProvider = "gateway";
    socket.message(JSON.stringify(command));
    expect(transport.send({ ...result, account: { state: "connected", apiProvider: "gateway" } })).toBe(false);
    expect(transport.send({
      ...result,
      profileRef: "a51f18c6-a3a9-4b8e-994a-9fa36136552e",
    })).toBe(false);
    const sentResults = socket.sent.map((raw) => JSON.parse(raw) as { type?: unknown; account?: { apiProvider?: unknown } }).filter((message) => message.type === result.type);
    expect(sentResults).toHaveLength(2);
    expect(sentResults.every((message) => message.account?.apiProvider === "firstParty")).toBe(true);
    expect(transport.send(new Proxy({}, { get: () => { throw new Error("hostile"); } }) as never)).toBe(false);
    const staleCommand = {
      ...command,
      correlationId: "c4d141ab4-8ccc-4b69-9e81-75068454f013",
    };
    socket.message(JSON.stringify(staleCommand));
    const revision = client.updateCapabilities(capabilities);
    socket.message(JSON.stringify({
      type: "relay:capabilities-updated", relayId: "relay-1", capabilityRevision: 1, status: "ok",
    }));
    await revision;
    expect(transport.send({ ...result, correlationId: staleCommand.correlationId, scope })).toBe(false);
    socket.message(JSON.stringify({
      type: "relay:registered", relayId: "relay-1", protocolVersion: 17,
      relaySessionId: "session-2", pairingGenerationRef: "pair-2", selectedProtocolVersion: 17,
    }));
    expect(transport.send(result)).toBe(false);
    await client.disconnect();
    expect(transport.send(result)).toBe(false);
  });
});
