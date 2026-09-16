import { describe, expect, mock, test } from "bun:test";
import type { RelayCapabilities } from "../../src/types";
import {
  RELAY_AUTHENTICATION_REQUIRED_ERROR_CODE,
  RELAY_TOKEN_AUTH_CLOSE_CODE,
} from "../../src/constants";

class MockRelayWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 3;

  readonly sent: string[] = [];
  readyState = MockRelayWebSocket.CONNECTING;
  terminateCalls = 0;
  closeCalls = 0;
  sendError: Error | null = null;
  private readonly handlers = new Map<string, Array<(...args: unknown[]) => void>>();

  constructor(_url: string) {}

  on(event: string, handler: (...args: unknown[]) => void): this {
    this.handlers.set(event, [...(this.handlers.get(event) ?? []), handler]);
    return this;
  }

  send(data: string): void {
    if (this.sendError !== null) throw this.sendError;
    this.sent.push(data);
  }

  close(_code?: number, _reason?: string): void {
    this.closeCalls += 1;
    this.finishClose(_code ?? 1000);
  }

  terminate(): void {
    this.terminateCalls += 1;
    this.finishClose(1006);
  }

  open(): void {
    this.readyState = MockRelayWebSocket.OPEN;
    for (const handler of this.handlers.get("open") ?? []) handler();
  }

  message(data: string): void {
    for (const handler of this.handlers.get("message") ?? []) handler(data);
  }

  serverClose(code: number): void {
    this.finishClose(code);
  }

  private finishClose(code: number): void {
    this.readyState = MockRelayWebSocket.CLOSED;
    for (const handler of this.handlers.get("close") ?? []) handler(code);
  }
}

const sockets: MockRelayWebSocket[] = [];

mock.module("ws", () => ({
  default: class extends MockRelayWebSocket {
    constructor(url: string) {
      super(url);
      sockets.push(this);
    }
  },
}));

const { createRelayClient, RelayAuthenticationRequiredError } = await import("../../src/client");

const capabilities: RelayCapabilities = {
  profile: "device-relay",
};

describe("RelayClient connecting-socket retirement", () => {
  test("treats registration auth rejection as terminal and never retries the same token", async () => {
    sockets.length = 0;
    let authenticationRequired = 0;
    const client = createRelayClient({
      serverUrl: "http://127.0.0.1:9",
      userId: "owner-1",
      relayId: "relay-auth-rejected",
      token: `rty_${"a".repeat(32)}`,
      capabilities,
      reconnectDelayMs: 0,
      onAuthenticationRequired: () => {
        authenticationRequired += 1;
      },
      onDispatch: async () => ({ status: "ok" }),
    });
    let connectError: unknown;
    const connecting = client.connect().catch((error: unknown) => {
      connectError = error;
    });
    const socket = sockets.at(-1)!;
    socket.open();
    socket.message(JSON.stringify({
      type: "relay:error",
      message: "Invalid or missing relay token",
      code: RELAY_AUTHENTICATION_REQUIRED_ERROR_CODE,
    }));
    socket.serverClose(RELAY_TOKEN_AUTH_CLOSE_CODE);
    await connecting;

    expect(connectError).toBeInstanceOf(RelayAuthenticationRequiredError);
    expect(authenticationRequired).toBe(1);
    expect(client.getStatus()).toBe("error");
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(sockets).toHaveLength(1);
  });

  test("a revoked connected token closes once without a reconnect storm", async () => {
    sockets.length = 0;
    let authenticationRequired = 0;
    const client = createRelayClient({
      serverUrl: "http://127.0.0.1:9",
      userId: "owner-1",
      relayId: "relay-auth-revoked",
      token: `rty_${"b".repeat(32)}`,
      capabilities,
      reconnectDelayMs: 0,
      onAuthenticationRequired: () => {
        authenticationRequired += 1;
      },
      onDispatch: async () => ({ status: "ok" }),
    });
    const connecting = client.connect();
    const socket = sockets.at(-1)!;
    socket.open();
    socket.message(JSON.stringify({ type: "relay:registered", relayId: "relay-auth-revoked" }));
    await connecting;
    socket.serverClose(RELAY_TOKEN_AUTH_CLOSE_CODE);

    expect(authenticationRequired).toBe(1);
    expect(client.getStatus()).toBe("error");
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(sockets).toHaveLength(1);
  });

  test("disconnect terminates the exact connecting socket and settles connect without reconnecting", async () => {
    sockets.length = 0;
    const client = createRelayClient({
      serverUrl: "http://127.0.0.1:9",
      userId: "owner-1",
      relayId: "relay-connecting",
      capabilities,
      reconnectDelayMs: 0,
      onDispatch: async () => ({ status: "ok" }),
    });
    const connecting = client.connect();
    const socket = sockets.at(-1)!;
    let connectError: unknown;
    const settledConnect = connecting.catch((error: unknown) => {
      connectError = error;
    });

    expect(socket.readyState).toBe(MockRelayWebSocket.CONNECTING);
    await client.disconnect();
    await settledConnect;

    expect(socket.terminateCalls).toBe(1);
    expect(socket.closeCalls).toBe(0);
    expect(socket.readyState).toBe(MockRelayWebSocket.CLOSED);
    expect(connectError).toEqual(new Error("Relay disconnect"));
    expect(client.getStatus()).toBe("disconnected");
    expect(socket.sent).toEqual([]);

    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(sockets).toHaveLength(1);
  });

  test("OPEN send failure still closes and detaches the exact socket before rejecting", async () => {
    sockets.length = 0;
    let dispatches = 0;
    const client = createRelayClient({
      serverUrl: "http://127.0.0.1:9",
      userId: "owner-1",
      relayId: "relay-open",
      capabilities,
      reconnectDelayMs: 0,
      onDispatch: async () => {
        dispatches += 1;
        return { status: "ok" };
      },
    });
    const connecting = client.connect();
    const socket = sockets.at(-1)!;
    socket.open();
    socket.message(JSON.stringify({
      type: "relay:registered",
      relayId: "relay-open",
    }));
    await connecting;

    const sendError = new Error("graceful disconnect send failed");
    socket.sendError = sendError;
    let disconnectError: unknown;
    try {
      await client.disconnect();
    } catch (error) {
      disconnectError = error;
    }

    expect(disconnectError).toBe(sendError);
    expect(socket.closeCalls).toBe(1);
    expect(socket.readyState).toBe(MockRelayWebSocket.CLOSED);
    expect(client.getStatus()).toBe("disconnected");

    socket.message(JSON.stringify({
      type: "relay:dispatch",
      correlationId: "late-dispatch",
      toolName: "run_shell",
      args: { command: "echo stale" },
      impact: "low",
      approvalObtained: true,
    }));
    await Promise.resolve();
    expect(dispatches).toBe(0);

    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(sockets).toHaveLength(1);
  });
});
