/**
 * `createWsRealtimeClient` first-message auth handshake +
 * outbound queue + reconnect-after-rejection unit tests.
 *
 * Pure unit-level: replaces `globalThis.WebSocket` with a
 * controllable fake so the test never opens a real socket.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { UI_ACTION_EVENT_TTL_MS, encodeVoicePcmFrame } from "@nautilo/types";
import {
  createWsRealtimeClient,
  type AuthRejectedReason,
  type RealtimeState,
} from "../../src/ws-client";

// ---------------------------------------------------------------------------
// MockWebSocket — minimal stand-in for the browser/global WebSocket.
// ---------------------------------------------------------------------------

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
  triggerBinary: (payload: Uint8Array) => void;
  triggerClose: () => void;
  triggerError: () => void;
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

  triggerBinary(payload: Uint8Array): void {
    this.dispatch("message", { data: payload } as unknown as MessageEvent);
  }

  triggerClose(): void {
    this.close();
  }

  triggerError(): void {
    this.dispatch("error");
  }

  private dispatch(name: string, ev?: Event | MessageEvent): void {
    const list = this.listeners.get(name) ?? [];
    for (const fn of list) fn(ev ?? ({} as Event));
  }
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

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
  // The auth handshake fires `await getToken()` inside the open
  // listener. One macrotask tick is enough for the awaited promise
  // chain to settle.
  await new Promise((r) => setTimeout(r, 0));
}

// Common quiet timings — avoid the 1s default reconnect window.
const fastTimings = {
  reconnectBaseMs: 5,
  reconnectMaxMs: 20,
  heartbeatIntervalMs: 0, // disabled by default; specific test re-enables
  heartbeatTimeoutMs: 1_000,
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createWsRealtimeClient — first-message auth ()", () => {
  test("negotiates PCM only with a sink and fences audio across reconnects", async () => {
    const received: unknown[] = [];
    const client = createWsRealtimeClient("ws://test", {
      getToken: () => "tok", onEvent: () => {}, onVoiceEvent: event => received.push(event), ...fastTimings,
    });
    const preference = { type: "voice.listen", version: 1, roomId: "room", enabled: true };
    client.send(preference);
    client.send({ type: "voice.stop", turnId: "stale" });
    client.send({ type: "voice.consumed", streamId: "stale", samples: 1 });
    const first = created[0]!; first.triggerOpen(); await flushMicrotasks();
    expect((JSON.parse(first.sent[0]!) as { voiceProtocol?: number }).voiceProtocol).toBe(1);
    first.triggerMessage({ type: "auth.accepted", voiceProtocol: 1 });
    expect(first.sent.slice(1).map(x => JSON.parse(x) as unknown)).toEqual([preference]);
    const streamId = "11111111-1111-4111-8111-111111111111";
    first.triggerMessage({ type: "voice.stream.start", version: 1, streamId, turnId: "turn", roomId: "room", agentId: "agent", sampleRate: 24000, channels: 1, encoding: "pcm_s16le", model: "eleven_v3" });
    const packet = encodeVoicePcmFrame({ streamId, sequence: 0, pcm: new Uint8Array([0, 1]) });
    first.triggerBinary(packet);
    expect(received).toHaveLength(2);
    first.triggerClose(); await wait(30);
    const second = created[1]!; second.triggerOpen(); await flushMicrotasks();
    second.triggerMessage({ type: "auth.accepted", voiceProtocol: 1 });
    expect(second.sent.slice(1).map(x => JSON.parse(x) as unknown)).toEqual([preference]);
    first.triggerBinary(packet);
    expect(received).toHaveLength(2);
    second.triggerBinary(packet); // No start on the fresh connection.
    expect(second.readyState).toBe(RS_CLOSED);
    expect(received).toHaveLength(2);
    client.close();
  });

  test("old servers receive no listener controls and cannot send unnegotiated PCM", async () => {
    const client = createWsRealtimeClient("ws://test", {
      getToken: () => "tok", onEvent: () => {}, onVoiceEvent: () => {}, ...fastTimings,
    });
    const ws = created[0]!; ws.triggerOpen(); await flushMicrotasks();
    ws.triggerMessage({ type: "auth.accepted" });
    client.send({ type: "voice.listen", version: 1, roomId: "room", enabled: true });
    expect(ws.sent).toHaveLength(1);
    ws.triggerBinary(new Uint8Array([0, 1]));
    expect(ws.readyState).toBe(RS_CLOSED);
    client.close();
  });

  test("declares a product-owned initiating surface only in the auth frame", async () => {
    const client = createWsRealtimeClient("ws://test", {
      onEvent: () => {},
      getToken: () => "tok",
      initiatingClientSurface: "mobile.web",
      ...fastTimings,
    });
    const ws = created[0]!;
    ws.triggerOpen();
    await flushMicrotasks();
    expect(JSON.parse(ws.sent[0]!)).toEqual({
      type: "auth",
      token: "tok",
      initiatingClientSurface: "mobile.web",
    });
    client.close();
  });

  test("state sequence on a clean session: connecting → authenticating → open → closed", async () => {
    const states: RealtimeState[] = [];
    const client = createWsRealtimeClient("ws://test", {
      onEvent: () => {},
      onStateChange: (s) => states.push(s),
      getToken: () => "tok",
      ...fastTimings,
    });

    expect(states[0]).toBe("connecting");
    const ws = created[0]!;
    ws.triggerOpen();
    await flushMicrotasks();
    // After the open + getToken settle, we're in "authenticating".
    expect(states).toContain("authenticating");

    ws.triggerMessage({ type: "auth.accepted" });
    expect(states).toContain("open");

    client.close();
    expect(states[states.length - 1]).toBe("closed");
  });

  test("send() during authenticating buffers, flushes in order on auth.accepted", async () => {
    const client = createWsRealtimeClient("ws://test", {
      onEvent: () => {},
      getToken: () => "tok",
      ...fastTimings,
    });
    const ws = created[0]!;
    ws.triggerOpen();
    await flushMicrotasks();

    // We're in authenticating: buffer two sends.
    client.send({ kind: "first" });
    client.send({ kind: "second" });
    // Only the auth frame is on the wire so far.
    expect(ws.sent.length).toBe(1);
    expect(JSON.parse(ws.sent[0]!) as { type: string; token: string }).toMatchObject({
      type: "auth",
      token: "tok",
    });

    ws.triggerMessage({ type: "auth.accepted" });
    // After accept: queued frames flush in order.
    const flushedKinds = ws.sent
      .slice(1)
      .map((s) => (JSON.parse(s) as { kind: string }).kind);
    expect(flushedKinds).toEqual(["first", "second"]);
  });

  test("delivers only strict socket-local controls and drops malformed reserved frames", async () => {
    const controls: unknown[] = [];
    const events: unknown[] = [];
    const errors: Error[] = [];
    const client = createWsRealtimeClient("ws://test", {
      onEvent: (event) => events.push(event),
      onControlEvent: (event) => controls.push(event),
      onError: (error) => errors.push(error),
      getToken: () => "tok",
      ...fastTimings,
    });
    const ws = created[0]!;
    ws.triggerOpen();
    await flushMicrotasks();
    ws.triggerMessage({ type: "auth.accepted" });
    ws.triggerMessage({
      type: "client.session.v1",
      clientActionSessionId: "A1b2C3d4E5f6G7h8I9j0K_",
    });
    const expiresAt = new Date(Date.now() + 20_000).toISOString();
    ws.triggerMessage({
      type: "ui.action.v1",
      actionId: "guide-action-1",
      target: "connections.ssh",
      presentation: "spotlight",
      expiresAt,
    });
    ws.triggerMessage({ type: "client.session.v1", clientActionSessionId: "forged" });
    ws.triggerMessage({
      type: "ui.action.v1",
      actionId: "guide-action-malformed",
      target: "connections.ssh",
      presentation: "spotlight",
      expiresAt,
      injected: true,
    });
    ws.triggerMessage({
      type: "ui.action.v1",
      actionId: "guide-action-expired",
      target: "connections.ssh",
      presentation: "spotlight",
      expiresAt: new Date(Date.now() - 1).toISOString(),
    });
    ws.triggerMessage({
      type: "ui.action.v1",
      actionId: "guide-action-too-far",
      target: "connections.ssh",
      presentation: "spotlight",
      // Exact TTL boundaries are covered with an injected clock in
      // @nautilo/types. Keep this transport assertion comfortably outside
      // the window so two consecutive Date.now() reads cannot cross it.
      expiresAt: new Date(Date.now() + (UI_ACTION_EVENT_TTL_MS * 2)).toISOString(),
    });
    expect(controls).toEqual([{
      type: "client.session.v1",
      clientActionSessionId: "A1b2C3d4E5f6G7h8I9j0K_",
    }, {
      type: "ui.action.v1",
      actionId: "guide-action-1",
      target: "connections.ssh",
      presentation: "spotlight",
      expiresAt,
    }]);
    expect(events).toEqual([]);
    expect(errors.map((error) => error.message)).toContain("WS client session control frame rejected");
    expect(errors.filter((error) => error.message === "WS UI action control frame rejected")).toHaveLength(3);
    client.close();
  });

  test("a reconnect replaces the prior socket-local client session", async () => {
    const controls: string[] = [];
    const client = createWsRealtimeClient("ws://test", {
      onEvent: () => {},
      onControlEvent: (event) => {
        if (event.type === "client.session.v1") controls.push(event.clientActionSessionId);
      },
      getToken: () => "tok",
      ...fastTimings,
    });
    const first = created[0]!;
    first.triggerOpen();
    await flushMicrotasks();
    first.triggerMessage({ type: "auth.accepted" });
    first.triggerMessage({
      type: "client.session.v1",
      clientActionSessionId: "A1b2C3d4E5f6G7h8I9j0K_",
    });
    first.triggerClose();
    await wait(30);
    const second = created[1]!;
    second.triggerOpen();
    await flushMicrotasks();
    second.triggerMessage({ type: "auth.accepted" });
    second.triggerMessage({
      type: "client.session.v1",
      clientActionSessionId: "Z1y2X3w4V5u6T7s8R9q0P_",
    });
    expect(controls).toEqual(["A1b2C3d4E5f6G7h8I9j0K_", "Z1y2X3w4V5u6T7s8R9q0P_"]);
    client.close();
  });

  test("outbound queue cap drops oldest on overflow", async () => {
    const warnSpy = mock((..._args: unknown[]) => {});
    const origWarn = console.warn;
    console.warn = warnSpy as typeof console.warn;

    try {
      const client = createWsRealtimeClient("ws://test", {
        onEvent: () => {},
        getToken: () => "tok",
        outboundQueueLimit: 2,
        ...fastTimings,
      });
      const ws = created[0]!;
      ws.triggerOpen();
      await flushMicrotasks();

      client.send({ type: "typing.ping", kind: "A" });
      client.send({ type: "typing.ping", kind: "B" });
      client.send({ type: "typing.ping", kind: "C" }); // should evict A

      ws.triggerMessage({ type: "auth.accepted" });
      const flushedKinds = ws.sent
        .slice(1)
        .map((s) => (JSON.parse(s) as { kind: string }).kind);
      expect(flushedKinds).toEqual(["B", "C"]);
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(String(warnSpy.mock.calls[0]?.[0])).toContain("type=typing.ping");
    } finally {
      console.warn = origWarn;
    }
  });

  test("3 consecutive invalid_token rejections → onAuthRejected fires + reconnect suspended", async () => {
    let consecutiveCalls = 0;
    const reasons: AuthRejectedReason[] = [];
    const client = createWsRealtimeClient("ws://test", {
      onEvent: () => {},
      getToken: () => "tok",
      onAuthRejected: (r) => reasons.push(r),
      ...fastTimings,
    });

    for (let attempt = 0; attempt < 3; attempt++) {
      // Each iteration: wait for the next MockWebSocket, walk it
      // through open → auth.rejected, then close. The client's
      // reconnect timer should re-fire connect() until the cap hits.
      let ws: MockWebSocketLike | undefined = created[consecutiveCalls];
      // First connect happens synchronously; later ones come after
      // the reconnect timer.
      while (!ws) {
        await wait(10);
        ws = created[consecutiveCalls];
      }
      ws.triggerOpen();
      await flushMicrotasks();
      ws.triggerMessage({ type: "auth.rejected", error: "invalid_token" });
      // close handler fires from triggerClose path
      ws.triggerClose();
      consecutiveCalls++;
      await wait(30);
    }

    expect(reasons).toContain("invalid_token");
    // After the cap, no further sockets should be created.
    const countAfterCap = created.length;
    await wait(60);
    expect(created.length).toBe(countAfterCap);

    client.close();
  });

  test("getToken returning null bumps the cap and eventually fires onAuthRejected('no_token')", async () => {
    const reasons: AuthRejectedReason[] = [];
    const client = createWsRealtimeClient("ws://test", {
      onEvent: () => {},
      getToken: () => null,
      onAuthRejected: (r) => reasons.push(r),
      ...fastTimings,
    });

    for (let attempt = 0; attempt < 3; attempt++) {
      let ws: MockWebSocketLike | undefined = created[attempt];
      while (!ws) {
        await wait(10);
        ws = created[attempt];
      }
      ws.triggerOpen();
      await flushMicrotasks();
      // After getToken() returns null, the client closes the socket.
      // Some implementations need a manual close to fire the close
      // listener; mirror real WS by triggering it here.
      ws.triggerClose();
      await wait(30);
    }
    expect(reasons).toContain("no_token");
    client.close();
  });

  test("client.reconnect() re-enables the loop after onAuthRejected", async () => {
    const reasons: AuthRejectedReason[] = [];
    let tokenSource: string | null = null;
    const client = createWsRealtimeClient("ws://test", {
      onEvent: () => {},
      getToken: () => tokenSource,
      onAuthRejected: (r) => reasons.push(r),
      ...fastTimings,
    });

    // First 3 attempts: getToken returns null → cap hits.
    for (let i = 0; i < 3; i++) {
      let ws: MockWebSocketLike | undefined = created[i];
      while (!ws) {
        await wait(10);
        ws = created[i];
      }
      ws.triggerOpen();
      await flushMicrotasks();
      ws.triggerClose();
      await wait(20);
    }
    expect(reasons.length).toBe(1);
    const beforeReconnect = created.length;

    // User refreshes credentials and calls reconnect().
    tokenSource = "fresh-token";
    client.reconnect();

    await wait(20);
    expect(created.length).toBeGreaterThan(beforeReconnect);
    const ws = created[created.length - 1]!;
    ws.triggerOpen();
    await flushMicrotasks();
    // The fresh token should be on the wire.
    const auth = JSON.parse(ws.sent[0]!) as { type: string; token: string };
    expect(auth).toMatchObject({ type: "auth", token: "fresh-token" });

    client.close();
  });

  test("getToken called fresh on every connect (refreshed bundles picked up transparently)", async () => {
    let tokenSource = "first-token";
    const getToken = mock(() => tokenSource);
    const client = createWsRealtimeClient("ws://test", {
      onEvent: () => {},
      getToken,
      ...fastTimings,
    });

    let ws = created[0]!;
    ws.triggerOpen();
    await flushMicrotasks();
    expect((JSON.parse(ws.sent[0]!) as { token: string }).token).toBe(
      "first-token",
    );
    ws.triggerMessage({ type: "auth.accepted" });

    // Drop and reconnect with refreshed token.
    tokenSource = "second-token";
    ws.triggerClose();
    await wait(30);
    ws = created[1]!;
    ws.triggerOpen();
    await flushMicrotasks();
    expect((JSON.parse(ws.sent[0]!) as { token: string }).token).toBe(
      "second-token",
    );

    client.close();
  });

  test("heartbeat clock starts on auth.accepted, not on socket-open", async () => {
    const errors: Error[] = [];
    const client = createWsRealtimeClient("ws://test", {
      onEvent: () => {},
      getToken: () => "tok",
      onError: (e) => errors.push(e),
      reconnectBaseMs: 5,
      reconnectMaxMs: 20,
      heartbeatIntervalMs: 50,
      heartbeatTimeoutMs: 100,
    });
    const ws = created[0]!;
    ws.triggerOpen();
    await flushMicrotasks();
    // Server "takes too long" to send auth.accepted — well past
    // heartbeatTimeoutMs. If the heartbeat clock was running, the
    // staleness detector would force-close by now.
    await wait(250);
    expect(errors.find((e) => e.message.includes("stale"))).toBeUndefined();
    expect(ws.readyState).toBe(RS_OPEN);

    ws.triggerMessage({ type: "auth.accepted" });
    client.close();
  });

  for (const negotiated of [false, true]) {
    test(`Stop preserves older servers and scopes negotiated speech (${negotiated})`, async () => {
      const client = createWsRealtimeClient("ws://test", { onEvent() {}, onVoiceEvent() {}, getToken: () => "tok", ...fastTimings });
      const ws = created[0]!;
      client.send({ type: "voice.stop" });
      ws.triggerOpen(); await flushMicrotasks();
      ws.triggerMessage({ type: "auth.accepted", ...(negotiated ? { voiceProtocol: 1 } : {}) });
      expect(ws.sent).toHaveLength(1);
      client.send({ type: "voice.stop" });
      expect(ws.sent).toHaveLength(negotiated ? 1 : 2);
      client.send({ type: "voice.stop", turnId: "turn-a" });
      expect(JSON.parse(ws.sent.at(-1)!) as unknown).toEqual({ type: "voice.stop", turnId: "turn-a" });
      client.close();
    });
  }

  test("send() drops to outbound queue while connecting (before socket-open)", async () => {
    const client = createWsRealtimeClient("ws://test", {
      onEvent: () => {},
      getToken: () => "tok",
      ...fastTimings,
    });
    // We're in `connecting` state. send() must buffer (not throw).
    client.send({ kind: "early" });

    const ws = created[0]!;
    ws.triggerOpen();
    await flushMicrotasks();
    ws.triggerMessage({ type: "auth.accepted" });
    const flushedKinds = ws.sent
      .slice(1)
      .map((s) => (JSON.parse(s) as { kind: string }).kind);
    expect(flushedKinds).toEqual(["early"]);
  });
});
