/**
 * D146 — `suspend()` / `resume()` visibility idle close without reconnect
 * backoff; `close()` remains permanent shutdown.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createWsRealtimeClient, type RealtimeState } from "../../src/ws-client";

const RS_CONNECTING = 0;
const RS_OPEN = 1;
const RS_CLOSED = 3;

interface MockWebSocketLike {
  url: string;
  readyState: number;
  sent: string[];
  addEventListener: (
    name: string,
    handler: (ev: Event | MessageEvent) => void,
  ) => void;
  send: (data: string) => void;
  close: () => void;
  triggerOpen: () => void;
  triggerMessage: (payload: unknown) => void;
  triggerClose: () => void;
}

const created: MockWebSocketLike[] = [];

class MockWebSocket implements MockWebSocketLike {
  static OPEN = RS_OPEN;
  static CONNECTING = RS_CONNECTING;
  static CLOSED = RS_CLOSED;

  url: string;
  readyState = RS_CONNECTING;
  sent: string[] = [];
  private listeners: Map<string, Array<(ev: Event | MessageEvent) => void>> =
    new Map();

  constructor(url: string) {
    this.url = url;
    created.push(this);
  }

  addEventListener(
    name: string,
    handler: (ev: Event | MessageEvent) => void,
  ): void {
    const list = this.listeners.get(name) ?? [];
    list.push(handler);
    this.listeners.set(name, list);
  }

  send(data: string): void {
    if (this.readyState !== RS_OPEN) {
      throw new Error("MockWebSocket.send called before OPEN");
    }
    this.sent.push(data);
  }

  close(): void {
    if (this.readyState === RS_CLOSED) return;
    this.readyState = RS_CLOSED;
    this.dispatch("close");
  }

  triggerOpen(): void {
    this.readyState = RS_OPEN;
    this.dispatch("open");
  }

  triggerMessage(payload: unknown): void {
    const event = { data: JSON.stringify(payload) } as MessageEvent;
    this.dispatch("message", event);
  }

  triggerClose(): void {
    this.close();
  }

  private dispatch(name: string, ev?: Event | MessageEvent): void {
    const list = this.listeners.get(name) ?? [];
    for (const fn of list) fn(ev ?? ({} as Event));
  }
}

const realWebSocket = (globalThis as { WebSocket?: unknown }).WebSocket;

beforeEach(() => {
  created.length = 0;
  (globalThis as { WebSocket: unknown }).WebSocket =
    MockWebSocket as unknown as typeof WebSocket;
});

afterEach(() => {
  if (realWebSocket === undefined) {
    delete (globalThis as { WebSocket?: unknown }).WebSocket;
  } else {
    (globalThis as { WebSocket: unknown }).WebSocket = realWebSocket;
  }
});

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function flushMicrotasks(): Promise<void> {
  await new Promise((r) => setTimeout(r, 0));
}

const fastTimings = {
  reconnectBaseMs: 5,
  reconnectMaxMs: 20,
  heartbeatIntervalMs: 0,
  heartbeatTimeoutMs: 1_000,
};

describe("createWsRealtimeClient — D146 suspend / resume", () => {
  test("suspend closes cleanly and does not schedule reconnect backoff", async () => {
    const states: RealtimeState[] = [];
    const client = createWsRealtimeClient("ws://test", {
      onEvent: () => {},
      onStateChange: (s) => states.push(s),
      getToken: () => "tok",
      ...fastTimings,
    });

    const ws0 = created[0]!;
    ws0.triggerOpen();
    await flushMicrotasks();
    ws0.triggerMessage({ type: "auth.accepted" });
    expect(states).toContain("open");

    const nAfterOpen = created.length;
    client.suspend();
    expect(ws0.readyState).toBe(RS_CLOSED);

    await wait(80);
    expect(created.length).toBe(nAfterOpen);

    client.resume();
    await wait(20);
    expect(created.length).toBeGreaterThan(nAfterOpen);

    const ws1 = created[created.length - 1]!;
    ws1.triggerOpen();
    await flushMicrotasks();
    ws1.triggerMessage({ type: "auth.accepted" });

    client.close();
  });

  test("resume re-opens after suspend", async () => {
    const client = createWsRealtimeClient("ws://test", {
      onEvent: () => {},
      getToken: () => "tok",
      ...fastTimings,
    });
    const ws0 = created[0]!;
    ws0.triggerOpen();
    await flushMicrotasks();
    ws0.triggerMessage({ type: "auth.accepted" });

    client.suspend();
    client.resume();

    await wait(20);
    expect(created.length).toBe(2);
    const ws1 = created[1]!;
    ws1.triggerOpen();
    await flushMicrotasks();
    expect(JSON.parse(ws1.sent[0]!) as { type: string }).toMatchObject({
      type: "auth",
    });

    client.close();
  });

  test("close() is permanent — no reconnect and suspend/resume are no-ops", async () => {
    const client = createWsRealtimeClient("ws://test", {
      onEvent: () => {},
      getToken: () => "tok",
      ...fastTimings,
    });
    const ws0 = created[0]!;
    ws0.triggerOpen();
    await flushMicrotasks();
    ws0.triggerMessage({ type: "auth.accepted" });

    const n = created.length;
    client.close();
    await wait(80);
    expect(created.length).toBe(n);

    client.suspend();
    client.resume();
    await wait(80);
    expect(created.length).toBe(n);
  });

  /**
   * Stack 19 Phase 6.9.3 regression — socket-ownership race.
   *
   * Pre-fix: `suspend()` calls `ws.close(1000)` (async in browsers).
   * If `resume()` runs before the OLD socket's close event fires,
   * `connect()` creates a NEW socket and reassigns `ws`. When the
   * OLD close eventually fires, its handler executes on the SHARED
   * `ws` reference: sets `ws = null` + `state = "closed"` + schedules
   * reconnect → kills the new connection mid-flight + churn.
   *
   * Fix (Phase 6.9.3): every handler captures `thisWs` at attach
   * time and short-circuits via `isStale()` when `ws !== thisWs`.
   * Close handler is the load-bearing one.
   *
   * This test models the race by monkey-patching the OLD socket's
   * close() to defer the dispatch, simulating the real-browser
   * window where close() returns sync but the close event fires
   * async.
   */
  test("REGRESSION 6.9.3: suspend → resume race — old socket's deferred close MUST NOT clobber the new socket", async () => {
    const states: RealtimeState[] = [];
    const client = createWsRealtimeClient("ws://test", {
      onEvent: () => {},
      onStateChange: (s) => states.push(s),
      getToken: () => "tok",
      ...fastTimings,
    });

    const ws0 = created[0]!;
    ws0.triggerOpen();
    await flushMicrotasks();
    ws0.triggerMessage({ type: "auth.accepted" });
    expect(states[states.length - 1]).toBe("open");

    // Capture the close listener registered by ws-client so we can
    // fire it manually AFTER resume() has installed the new socket.
    // The mock's normal close() dispatches synchronously; to model
    // the race we need to defer the dispatch.
    let oldSocketCloseListener: ((ev: Event) => void) | null = null;
    const origAddListener = ws0.addEventListener.bind(ws0);
    // No new listeners are added after the initial connect, so this
    // capture is one-shot. We re-store the existing close listener
    // via a side-channel: walk the mock's listener map and grab it.
    const mockListeners = (
      ws0 as unknown as { listeners: Map<string, Array<(ev: Event) => void>> }
    ).listeners;
    const closeList = mockListeners.get("close") ?? [];
    oldSocketCloseListener = closeList[0] ?? null;
    expect(oldSocketCloseListener).not.toBeNull();

    // Defer the close dispatch: when client.suspend() calls
    // ws0.close(), flip readyState but DON'T fire the listener yet.
    ws0.close = () => {
      ws0.readyState = RS_CLOSED;
      // intentionally do NOT call dispatch("close") here — that's
      // what simulates the browser's async close-event timing
    };

    // The race:
    client.suspend();   // schedules close on ws0, but close event deferred
    client.resume();    // creates NEW socket; ws now points to ws1
    await wait(20);
    expect(created.length).toBe(2);
    const ws1 = created[1]!;
    ws1.triggerOpen();
    await flushMicrotasks();
    ws1.triggerMessage({ type: "auth.accepted" });
    expect(states[states.length - 1]).toBe("open"); // new socket is up

    // NOW the deferred old close event fires.
    // LOAD-BEARING: with the Phase 6.9.3 fix, this is a no-op (the
    // handler short-circuits via isStale()). Without the fix, this
    // would set state="closed" + schedule a reconnect, churning the
    // new connection.
    const stateCountBefore = states.length;
    const createdCountBefore = created.length;
    oldSocketCloseListener!({} as Event);
    await wait(20);

    // New socket should still be open. No new state transitions
    // triggered by the stale close.
    expect(states[states.length - 1]).toBe("open");
    expect(states.length).toBe(stateCountBefore); // no new state transitions
    // No reconnect was scheduled, so no new sockets were created.
    expect(created.length).toBe(createdCountBefore);
    // ws1 is still the "live" socket.
    expect(ws1.readyState).toBe(RS_OPEN);

    client.close();
    // Suppress unused-binding warning on origAddListener.
    void origAddListener;
  });

  test("REGRESSION 6.9.3: rapid suspend/resume cycle does not accumulate ghost sockets", async () => {
    const client = createWsRealtimeClient("ws://test", {
      onEvent: () => {},
      getToken: () => "tok",
      ...fastTimings,
    });
    const ws0 = created[0]!;
    ws0.triggerOpen();
    await flushMicrotasks();
    ws0.triggerMessage({ type: "auth.accepted" });

    // 5 suspend/resume cycles in quick succession. Each cycle:
    //  - suspend closes current socket
    //  - resume creates new socket
    // Expected: exactly 1 new socket per resume (5 cycles → 5 new
    // sockets created beyond the initial). No churn from stale close
    // events triggering extra reconnects.
    for (let i = 0; i < 5; i++) {
      client.suspend();
      client.resume();
      await wait(10);
      const ws = created[created.length - 1]!;
      ws.triggerOpen();
      await flushMicrotasks();
      ws.triggerMessage({ type: "auth.accepted" });
    }

    // Initial + 5 resumes = 6 sockets total. Pre-fix the stale close
    // events from previous sockets would have triggered extra
    // scheduleReconnect calls and inflated this count.
    expect(created.length).toBe(6);

    client.close();
  });
});
