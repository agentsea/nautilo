/**
 * D323 — useAutoDismiss timer semantics (the fallback pill's backstop).
 *
 * Closes the coverage gap the audit flagged: the auto-expiry timer was
 * untested. Uses real timers with a short injected TTL + generous waits so
 * the assertions are deterministic without a fake-timer harness.
 */
import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { useAutoDismiss } from "../../src/adapters/use-auto-dismiss";

let happyWindow: Window;
const priorGlobals: Record<string, unknown> = {};
let root: Root;

const TTL = 60; // ms
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function Harness({
  rearmKey,
  onExpire,
}: {
  rearmKey: unknown;
  onExpire: () => void;
}) {
  useAutoDismiss(rearmKey, onExpire, TTL);
  return null;
}

beforeAll(() => {
  happyWindow = new Window({ url: "http://127.0.0.1:3001/" });
  for (const k of ["window", "document", "navigator", "HTMLElement"] as const) {
    priorGlobals[k] = (globalThis as Record<string, unknown>)[k];
  }
  Object.assign(globalThis, {
    window: happyWindow,
    document: happyWindow.document,
    navigator: happyWindow.navigator,
    HTMLElement: happyWindow.HTMLElement,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
});

afterEach(() => {
  if (root) act(() => root.unmount());
});

afterAll(() => {
  Object.assign(globalThis, priorGlobals);
});

function mount(props: { rearmKey: unknown; onExpire: () => void }): {
  rerender: (next: { rearmKey: unknown; onExpire: () => void }) => void;
  unmount: () => void;
} {
  const container = happyWindow.document.createElement("div");
  root = createRoot(container as unknown as Element);
  act(() => root.render(<Harness {...props} />));
  return {
    rerender: (next) => act(() => root.render(<Harness {...next} />)),
    unmount: () => act(() => root.unmount()),
  };
}

describe("useAutoDismiss (D323)", () => {
  test("fires onExpire after the TTL when active", async () => {
    const onExpire = mock(() => {});
    mount({ rearmKey: { id: 1 }, onExpire });
    expect(onExpire).toHaveBeenCalledTimes(0);
    await sleep(TTL * 2);
    expect(onExpire).toHaveBeenCalledTimes(1);
  });

  test("never fires when rearmKey is falsy", async () => {
    const onExpire = mock(() => {});
    mount({ rearmKey: null, onExpire });
    await sleep(TTL * 2);
    expect(onExpire).toHaveBeenCalledTimes(0);
  });

  test("re-arming on a new key cancels the prior timer (no stale fire)", async () => {
    const onExpire = mock(() => {});
    const h = mount({ rearmKey: { id: 1 }, onExpire });
    await sleep(TTL / 2); // 30ms — before the first timer (60ms) would fire
    h.rerender({ rearmKey: { id: 2 }, onExpire }); // cancels timer 1, arms timer 2
    await sleep(TTL * 0.75); // total ~75ms from start: timer 1 (60ms) would have fired if not cancelled
    expect(onExpire).toHaveBeenCalledTimes(0); // proves the prior timer was cleared
    await sleep(TTL); // let timer 2 elapse
    expect(onExpire).toHaveBeenCalledTimes(1);
  });

  test("unmount cancels the timer", async () => {
    const onExpire = mock(() => {});
    const h = mount({ rearmKey: { id: 1 }, onExpire });
    h.unmount();
    await sleep(TTL * 2);
    expect(onExpire).toHaveBeenCalledTimes(0);
  });
});
