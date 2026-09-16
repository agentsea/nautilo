import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createWsRealtimeClient } from "@nautilo/realtime-client";
import { resumeRealtimeAfterAdmission } from "../../src/adapters/admission-realtime-resume";

const CONNECTING = 0;
const OPEN = 1;
const CLOSED = 3;

class MockWebSocket {
  static readonly OPEN = OPEN;
  static readonly CONNECTING = CONNECTING;
  static readonly CLOSED = CLOSED;

  readonly sent: string[] = [];
  readyState = CONNECTING;
  private readonly listeners = new Map<string, Array<(event: Event | MessageEvent) => void>>();

  constructor(readonly url: string) {
    sockets.push(this);
  }

  addEventListener(name: string, handler: (event: Event | MessageEvent) => void): void {
    this.listeners.set(name, [...(this.listeners.get(name) ?? []), handler]);
  }

  send(data: string): void {
    if (this.readyState !== OPEN) throw new Error("send before open");
    this.sent.push(data);
  }

  close(): void {
    if (this.readyState === CLOSED) return;
    this.readyState = CLOSED;
    this.dispatch("close", {} as Event);
  }

  open(): void {
    this.readyState = OPEN;
    this.dispatch("open", {} as Event);
  }

  rejectAdmission(): void {
    this.dispatch("message", {
      data: JSON.stringify({
        type: "auth.rejected",
        error: "device_admission_expired",
      }),
    } as MessageEvent);
  }

  private dispatch(name: string, event: Event | MessageEvent): void {
    for (const handler of this.listeners.get(name) ?? []) handler(event);
  }
}

const sockets: MockWebSocket[] = [];
const realWebSocket = globalThis.WebSocket;
const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

beforeEach(() => {
  sockets.length = 0;
  globalThis.WebSocket = MockWebSocket as unknown as typeof WebSocket;
});

afterEach(() => {
  globalThis.WebSocket = realWebSocket;
});

describe("admission realtime resume wiring", () => {
  test.each(["paused", "blocked"] as const)("reopens one suspended mounted client after %s reproof", async (status) => {
    const client = createWsRealtimeClient("ws://nautilo.test/ws", {
      onEvent: () => undefined,
      getToken: () => "token",
      reconnectBaseMs: 0,
      reconnectMaxMs: 0,
      heartbeatIntervalMs: 60_000,
      heartbeatTimeoutMs: 120_000,
    });

    for (let attempt = 0; attempt < 3; attempt += 1) {
      await wait(0);
      const socket = sockets[attempt];
      expect(socket).toBeDefined();
      socket.open();
      await wait(0);
      socket.rejectAdmission();
      await wait(0);
    }

    const afterFailureCap = sockets.length;
    await wait(5);
    expect(sockets).toHaveLength(afterFailureCap);

    const paused = { status, identity: "server:viewer:device" };
    const open = { status: "open" as const, identity: "server:viewer:device" };
    expect(resumeRealtimeAfterAdmission({ client, previous: paused, current: open })).toBe(true);
    await wait(0);
    expect(sockets).toHaveLength(afterFailureCap + 1);

    expect(resumeRealtimeAfterAdmission({ client, previous: open, current: open })).toBe(false);
    expect(resumeRealtimeAfterAdmission({
      client,
      previous: paused,
      current: { status: "open", identity: "server:other:device" },
    })).toBe(false);
    expect(resumeRealtimeAfterAdmission({
      client,
      previous: { status: "checking", identity: paused.identity },
      current: open,
    })).toBe(false);
    await wait(5);
    expect(sockets).toHaveLength(afterFailureCap + 1);

    client.close();
  });
});
