import { afterEach, expect, test } from "bun:test";
import { UI_ACTION_MAX_RETAINED_IDS_PER_SOCKET } from "@nautilo/types";
import {
  clearClientActionSession,
  installClientActionSession,
  retainClientUiAction,
  withCurrentClientActionSession,
} from "../../src/lib/client-action-session";

const session = {
  type: "client.session.v1" as const,
  clientActionSessionId: "A1b2C3d4E5f6G7h8I9j0K_",
};

afterEach(() => {
  clearClientActionSession();
});

test("only the current socket-local control session stamps a foreground request", () => {
  expect(withCurrentClientActionSession({ content: "hello" }))
    .toEqual({ content: "hello" });

  installClientActionSession(session);
  expect(withCurrentClientActionSession({
    content: "hello",
    clientActionSessionId: "caller-forged-value",
  })).toEqual({
    content: "hello",
    clientActionSessionId: session.clientActionSessionId,
  });

  installClientActionSession({
    type: "client.session.v1",
    clientActionSessionId: "Z1y2X3w4V5u6T7s8R9q0P_",
  });
  expect(withCurrentClientActionSession({ content: "new socket" }))
    .toEqual({ content: "new socket", clientActionSessionId: "Z1y2X3w4V5u6T7s8R9q0P_" });

  clearClientActionSession();
  expect(withCurrentClientActionSession({
    content: "after reconnect",
    clientActionSessionId: "caller-forged-value",
  })).toEqual({ content: "after reconnect" });
});

function action(actionId: string, expiresAt: string) {
  return {
    type: "ui.action.v1" as const,
    actionId,
    target: "connections.ssh" as const,
    presentation: "spotlight" as const,
    expiresAt,
  };
}

test("retains automatic action IDs only once, through their expiry, and clears them with the socket", () => {
  const now = 1_000_000;
  const expiresAt = new Date(now + 20_000).toISOString();
  expect(retainClientUiAction(action("action-1", expiresAt), now)).toBe(true);
  expect(retainClientUiAction(action("action-1", expiresAt), now)).toBe(false);
  expect(retainClientUiAction(action("expired", new Date(now).toISOString()), now)).toBe(false);

  clearClientActionSession();
  expect(retainClientUiAction(action("action-1", expiresAt), now)).toBe(true);
});

test("bounds retained automatic action IDs and prunes them before admitting a later action", () => {
  const now = 2_000_000;
  const expiresAt = new Date(now + 20_000).toISOString();
  for (let index = 0; index < UI_ACTION_MAX_RETAINED_IDS_PER_SOCKET; index += 1) {
    expect(retainClientUiAction(action(`action-${index}`, expiresAt), now)).toBe(true);
  }
  expect(retainClientUiAction(action("over-cap", expiresAt), now)).toBe(false);

  const afterExpiry = now + 20_001;
  expect(retainClientUiAction(
    action("after-prune", new Date(afterExpiry + 20_000).toISOString()),
    afterExpiry,
  )).toBe(true);
});

test("actively releases an action exactly at expiry and clears its pending timer", () => {
  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  const timers = new Map<number, () => void>();
  const cleared: number[] = [];
  let nextTimer = 1;
  globalThis.setTimeout = ((callback: () => void) => {
    const timer = nextTimer++;
    timers.set(timer, callback);
    return timer as unknown as ReturnType<typeof setTimeout>;
  }) as typeof setTimeout;
  globalThis.clearTimeout = ((timer: number) => {
    cleared.push(timer);
    timers.delete(timer);
  }) as typeof clearTimeout;

  try {
    const now = 3_000_000;
    const expiresAt = new Date(now + 20_000).toISOString();
    expect(retainClientUiAction(action("timer-action", expiresAt), now)).toBe(true);
    const expiry = timers.get(1);
    expect(expiry).toBeDefined();
    expiry?.();
    expect(retainClientUiAction(action("timer-action", expiresAt), now)).toBe(true);
    clearClientActionSession();
    expect(cleared).toContain(2);
  } finally {
    globalThis.setTimeout = originalSetTimeout;
    globalThis.clearTimeout = originalClearTimeout;
  }
});
