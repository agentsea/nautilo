import { afterEach, expect, test } from "bun:test";
import { createHumanActivityTracker, HUMAN_IDLE_AFTER_MS } from "../../src/human-activity";
import { createWsRealtimeClient } from "../../src/ws-client";

test("five-minute boundary, recovery, and resume read the current local clock", () => {
  let now = 1_000;
  const activity = createHumanActivityTracker(() => now);
  expect(activity.isIdle()).toBe(false);
  now += HUMAN_IDLE_AFTER_MS - 1;
  expect(activity.isIdle()).toBe(false);
  now += 1;
  expect(activity.isIdle()).toBe(true);
  activity.recordInteraction();
  expect(activity.isIdle()).toBe(false);
  // A suspended client need not cache or advance a separate idle flag.
  now += HUMAN_IDLE_AFTER_MS;
  expect(activity.isIdle()).toBe(true);
});

const originalWebSocket = globalThis.WebSocket;
const sockets: FakeSocket[] = [];

class FakeSocket {
  static OPEN = 1;
  readyState = 0;
  sent: string[] = [];
  private handlers = new Map<string, Array<(event: { data?: string }) => void>>();
  constructor(_url: string) { sockets.push(this); }
  addEventListener(name: string, handler: (event: { data?: string }) => void) {
    this.handlers.set(name, [...(this.handlers.get(name) ?? []), handler]);
  }
  send(payload: string) { this.sent.push(payload); }
  close() { this.readyState = 3; this.emit("close"); }
  emit(name: string, data?: unknown) {
    for (const handler of this.handlers.get(name) ?? []) handler({ data: JSON.stringify(data) });
  }
  open() { this.readyState = 1; this.emit("open"); }
}

afterEach(() => {
  globalThis.WebSocket = originalWebSocket;
  sockets.length = 0;
});

test("optional idle provider augments ping and legacy caller keeps exact frame", async () => {
  globalThis.WebSocket = FakeSocket as unknown as typeof WebSocket;
  let idle = false;
  const makeClient = (isIdle?: () => boolean) => createWsRealtimeClient("ws://test", {
    onEvent: () => {}, getToken: () => "token", isIdle,
    heartbeatIntervalMs: 5, heartbeatTimeoutMs: 1_000,
  });
  const active = makeClient(() => idle);
  const activeSocket = sockets[0]!;
  activeSocket.open();
  await Promise.resolve();
  activeSocket.emit("message", { type: "auth.accepted" });
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(activeSocket.sent).toContain('{"type":"ping","idle":false}');
  idle = true;
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(activeSocket.sent).toContain('{"type":"ping","idle":true}');
  active.close();

  const legacy = makeClient();
  const legacySocket = sockets[1]!;
  legacySocket.open();
  await Promise.resolve();
  legacySocket.emit("message", { type: "auth.accepted" });
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(legacySocket.sent).toContain('{"type":"ping"}');
  expect(legacySocket.sent.some((frame) => frame.includes('"idle"'))).toBe(false);
  legacy.close();
});
