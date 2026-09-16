import "../bun-dom-preload";
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { useCallback, useState } from "react";
import {
  isConversationViewportAway,
  transitionConversationViewport,
  type ConversationViewportMode,
} from "../../src/components/conversation-viewport";
import { useConversationLiveEdgeRecovery } from "../../src/hooks/use-conversation-live-edge-recovery";

const observers: TestResizeObserver[] = [];
class TestResizeObserver {
  observe = mock(() => {});
  disconnect = mock(() => {});
  constructor(readonly notify: () => void) { observers.push(this); }
}
const originalResizeObserver = globalThis.ResizeObserver;
beforeEach(() => {
  observers.length = 0;
  globalThis.ResizeObserver = TestResizeObserver as unknown as typeof ResizeObserver;
});
afterEach(() => {
  cleanup();
  globalThis.ResizeObserver = originalResizeObserver;
});

function setup(scrollTop: number, initialMode: ConversationViewportMode = "reader-away") {
  const viewport = document.createElement("div");
  const geometry = { scrollHeight: 1000, clientHeight: 600, scrollTop };
  for (const key of ["scrollHeight", "clientHeight", "scrollTop"] as const) {
    Object.defineProperty(viewport, key, { get: () => geometry[key] });
  }
  const viewportRef = { current: viewport };
  const view = renderHook(({ ready, visitId }) => {
    const [mode, setMode] = useState(initialMode);
    const onAtBottomChange = useCallback((atLiveEdge: boolean) => {
      setMode((current) => transitionConversationViewport(current, {
        type: "viewport-observed", atLiveEdge, origin: "layout",
      }));
    }, []);
    const awayFromLatest = isConversationViewportAway({
      mode, activeScopeKey: "room:a", readyScopeKey: ready ? "room:a" : null,
    });
    useConversationLiveEdgeRecovery({
      viewportRef, readerAway: awayFromLatest && mode === "reader-away", visitId, onAtBottomChange,
    });
    return { mode, awayFromLatest };
  }, { initialProps: { ready: true, visitId: 1 } });
  return { ...view, viewport, geometry };
}

describe("conversation live-edge recovery", () => {
  test.each([400, 399.5, 399])(
    "reopening at scrollTop=%s clears stale away state without a store change or scroll event",
    (scrollTop) => {
      const view = setup(scrollTop);
      expect(view.result.current).toEqual({ mode: "following", awayFromLatest: false });
    },
  );

  test("a delayed automatic tail scroll clears the button without a Human gesture", () => {
    const view = setup(350);
    expect(view.result.current.awayFromLatest).toBe(true);
    act(() => {
      view.geometry.scrollTop = 400;
      view.viewport.dispatchEvent(new Event("scroll"));
    });
    expect(view.result.current.awayFromLatest).toBe(false);
  });

  test("a viewport resize with no scroll event clears the button when all messages fit", () => {
    const view = setup(0);
    act(() => {
      view.geometry.clientHeight = 1000;
      observers[0].notify();
    });
    expect(view.result.current.awayFromLatest).toBe(false);
  });

  test.each(["focus", "visibilitychange"])("returning via %s reconciles settled geometry", (event) => {
    const view = setup(350);
    act(() => {
      view.geometry.scrollTop = 400;
      (event === "focus" ? window : document).dispatchEvent(new Event(event));
    });
    expect(view.result.current.awayFromLatest).toBe(false);
  });

  test.each(["reader-away", "target-pinned"] as const)(
    "preserves %s when there is still content below the viewport",
    (mode) => {
      const view = setup(398, mode);
      act(() => {
        view.viewport.dispatchEvent(new Event("scroll"));
        window.dispatchEvent(new Event("focus"));
        observers[0]?.notify();
      });
      expect(view.result.current).toEqual({ mode, awayFromLatest: true });
      expect(view.geometry.scrollTop).toBe(398);
    },
  );

  test("layout growth cannot invent away intent", () => {
    const view = setup(400, "following");
    act(() => {
      view.geometry.scrollHeight = 2000;
      view.viewport.dispatchEvent(new Event("scroll"));
    });
    expect(view.result.current.awayFromLatest).toBe(false);
  });

  test("a target navigation starting at the bottom stays pinned while its target loads", () => {
    const view = setup(400, "target-pinned");
    act(() => window.dispatchEvent(new Event("focus")));
    expect(view.result.current).toEqual({ mode: "target-pinned", awayFromLatest: true });
  });

  test("a visit waiting for restore cannot consume an old observation", () => {
    const view = setup(350);
    const previousObserver = observers[0];
    view.rerender({ ready: false, visitId: 2 });
    act(() => {
      view.geometry.scrollTop = 400;
      previousObserver.notify();
      window.dispatchEvent(new Event("focus"));
    });
    expect(previousObserver.disconnect).toHaveBeenCalledTimes(1);
    expect(view.result.current.mode).toBe("reader-away");
    view.rerender({ ready: true, visitId: 2 });
    expect(view.result.current.mode).toBe("following");
  });
});
