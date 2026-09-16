/**
 * M020 §C / M067B Phase 6 — parse resilience + close idempotency on top
 * of the existing M058 auth-first suite (`ws-client-auth.test.ts`).
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createWsRealtimeClient } from "../../src/ws-client";

const RS_OPEN = 1;
const RS_CONNECTING = 0;
const RS_CLOSED = 3;

interface MockWs {
  url: string;
  readyState: number;
  addEventListener: (name: string, fn: (ev: MessageEvent | Event) => void) => void;
  send: (data: string) => void;
  close: () => void;
  triggerOpen: () => void;
  triggerMessage: (data: string) => void;
  triggerClose: () => void;
}

const created: MockWs[] = [];

class MockWebSocket implements MockWs {
  static OPEN = RS_OPEN;
  static CONNECTING = RS_CONNECTING;
  static CLOSED = RS_CLOSED;

  url: string;
  readyState = RS_CONNECTING;
  private listeners = new Map<string, Array<(ev: MessageEvent | Event) => void>>();

  constructor(url: string) {
    this.url = url;
    created.push(this);
  }

  addEventListener(name: string, fn: (ev: MessageEvent | Event) => void): void {
    const list = this.listeners.get(name) ?? [];
    list.push(fn);
    this.listeners.set(name, list);
  }

  send(_data: string): void {
    if (this.readyState !== RS_OPEN) throw new Error("send before open");
  }

  close(): void {
    if (this.readyState === RS_CLOSED) return;
    this.readyState = RS_CLOSED;
    this.emit("close", {} as Event);
  }

  triggerOpen(): void {
    this.readyState = RS_OPEN;
    this.emit("open", {} as Event);
  }

  triggerMessage(data: string): void {
    this.emit("message", { data } as MessageEvent);
  }

  triggerClose(): void {
    this.close();
  }

  private emit(name: string, ev: MessageEvent | Event): void {
    for (const fn of this.listeners.get(name) ?? []) fn(ev);
  }
}

const realWs = (globalThis as { WebSocket?: unknown }).WebSocket;

beforeEach(() => {
  created.length = 0;
  (globalThis as { WebSocket: unknown }).WebSocket = MockWebSocket as unknown as typeof WebSocket;
});

afterEach(() => {
  if (realWs === undefined) delete (globalThis as { WebSocket?: unknown }).WebSocket;
  else (globalThis as { WebSocket: unknown }).WebSocket = realWs;
});

const fast = {
  reconnectBaseMs: 5,
  reconnectMaxMs: 20,
  heartbeatIntervalMs: 0,
  heartbeatTimeoutMs: 1000,
};

async function tick(): Promise<void> {
  await new Promise((r) => setTimeout(r, 0));
}

describe("createWsRealtimeClient — M020 parse + close", () => {
  test("malformed JSON after auth invokes onError without throwing", async () => {
    const errors: string[] = [];
    const client = createWsRealtimeClient("ws://x", {
      onEvent: () => {},
      onError: (e) => errors.push(e.message),
      getToken: () => "tok",
      ...fast,
    });
    const ws = created[0]!;
    ws.triggerOpen();
    await tick();
    ws.triggerMessage(JSON.stringify({ type: "auth.accepted" }));
    ws.triggerMessage("{not-json");
    expect(errors.some((m) => m.toLowerCase().includes("parse") || m.includes("JSON"))).toBe(true);
    client.close();
  });

  test("unknown JSON event after open is forwarded to onEvent (no throw)", async () => {
    const events: unknown[] = [];
    const client = createWsRealtimeClient("ws://x", {
      onEvent: (ev) => events.push(ev),
      getToken: () => "tok",
      ...fast,
    });
    const ws = created[0]!;
    ws.triggerOpen();
    await tick();
    ws.triggerMessage(JSON.stringify({ type: "auth.accepted" }));
    ws.triggerMessage(JSON.stringify({ type: "custom.unknown", n: 1 }));
    expect(events.length).toBe(1);
    client.close();
  });

  test("close() is idempotent", async () => {
    const client = createWsRealtimeClient("ws://x", {
      onEvent: () => {},
      getToken: () => "tok",
      ...fast,
    });
    const ws = created[0]!;
    ws.triggerOpen();
    await tick();
    ws.triggerMessage(JSON.stringify({ type: "auth.accepted" }));
    client.close();
    client.close();
    client.close();
    expect(ws.readyState).toBe(RS_CLOSED);
  });
});
