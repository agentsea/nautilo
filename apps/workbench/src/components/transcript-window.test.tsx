/**
 * D246 Wave 3 — bounded transcript rendering.
 *
 * Two layers of coverage:
 *   1. `computeMountPlan` — the pure, deterministic windowing decision (short
 *      room passthrough, 500-message bound, streaming tail, scrolled-away
 *      anchor, offscreen materialization, missing-anchor fallback).
 *   2. `TranscriptWindow` — the React shell, rendered under happy-dom, proving
 *      the window mounts a genuinely bounded number of rows (not CSS-hidden),
 *      keeps the tail mounted, keeps the short-room simple path, and can
 *      materialize an offscreen target on demand.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { act, useLayoutEffect, useState, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Window } from "happy-dom";
import { createRef } from "react";
import {
  TranscriptWindow,
  computeMountPlan,
  scheduleFrameWithFallback,
  TRANSCRIPT_ESTIMATE_PX,
  TRANSCRIPT_MAX_RENDERED,
  type TranscriptWindowHandle,
} from "./transcript-window";
import {
  conversationViewportScopeKey,
  isConversationTranscriptReadyForRestore,
  isConversationViewportFollowing,
  materializeFirstConversationAnchor,
  transitionConversationViewport,
  type ConversationViewportMode,
} from "./conversation-viewport";

const idOf = (i: number): string => `m${i}`;

function ConversationRestoreGate({
  activeScopeKey,
  transcriptReadyScopeKey,
  onReady,
  children,
}: {
  activeScopeKey: string;
  transcriptReadyScopeKey: string | null;
  onReady?: () => void;
  children: ReactNode;
}) {
  const ready = isConversationTranscriptReadyForRestore({
    activeScopeKey,
    transcriptReadyScopeKey,
    snapshotHasIdentity: true,
  });
  useLayoutEffect(() => {
    if (ready) onReady?.();
  }, [onReady, ready]);
  return children;
}
const makeIndexOfId =
  (count: number) =>
  (id: string): number => {
    for (let i = 0; i < count; i++) if (idOf(i) === id) return i;
    return -1;
  };

describe("scheduleFrameWithFallback", () => {
  test("runs viewport work from the bounded fallback when frames are throttled", () => {
    let fallback!: () => void;
    const cancelledFrames: number[] = [];
    let runs = 0;
    scheduleFrameWithFallback(
      () => {
        runs += 1;
      },
      {
        requestFrame: () => 7,
        cancelFrame: (handle) => cancelledFrames.push(handle),
        setFallback: (callback, delayMs) => {
          expect(delayMs).toBe(32);
          fallback = callback;
          return 11;
        },
        clearFallback: () => {},
      },
    );

    fallback();

    expect(runs).toBe(1);
    expect(cancelledFrames).toEqual([7]);
  });

  test("cancellation prevents delayed viewport work", () => {
    let frame!: FrameRequestCallback;
    let fallback!: () => void;
    let runs = 0;
    const cancel = scheduleFrameWithFallback(
      () => {
        runs += 1;
      },
      {
        requestFrame: (callback) => {
          frame = callback;
          return 13;
        },
        cancelFrame: () => {},
        setFallback: (callback) => {
          fallback = callback;
          return 17;
        },
        clearFallback: () => {},
      },
    );

    cancel();
    frame(0);
    fallback();

    expect(runs).toBe(0);
  });
});

describe("computeMountPlan", () => {
  test("short rooms mount every row via the simple (non-windowed) path", () => {
    const count = 12;
    const plan = computeMountPlan({
      count,
      anchor: { mode: "bottom" },
      indexOfId: makeIndexOfId(count),
      maxRendered: TRANSCRIPT_MAX_RENDERED,
      tailKeep: 0,
      materializeIndex: null,
      focusedIndex: null,
      targetOverscan: 3,
    });
    expect(plan.windowed).toBe(false);
    expect(plan.mountedCount).toBe(count);
    expect(plan.segments).toEqual([{ start: 0, end: count }]);
  });

  test("a 500-message room bounds mounted rows and keeps the tail", () => {
    const count = 500;
    const plan = computeMountPlan({
      count,
      anchor: { mode: "bottom" },
      indexOfId: makeIndexOfId(count),
      maxRendered: TRANSCRIPT_MAX_RENDERED,
      tailKeep: 0,
      materializeIndex: null,
      focusedIndex: null,
      targetOverscan: 3,
    });
    expect(plan.windowed).toBe(true);
    expect(plan.mountedCount).toBe(TRANSCRIPT_MAX_RENDERED);
    // Streaming tail (the last message) is inside the mounted window.
    const last = plan.segments[plan.segments.length - 1];
    expect(last.end).toBe(count);
    expect(last.start).toBe(count - TRANSCRIPT_MAX_RENDERED);
  });

  test("scrolled-away id anchor centers the window on the anchored message", () => {
    const count = 500;
    const anchorIdx = 120;
    const plan = computeMountPlan({
      count,
      anchor: { mode: "id", id: idOf(anchorIdx) },
      indexOfId: makeIndexOfId(count),
      maxRendered: TRANSCRIPT_MAX_RENDERED,
      tailKeep: 0,
      materializeIndex: null,
      focusedIndex: null,
      targetOverscan: 3,
    });
    expect(plan.windowed).toBe(true);
    // The anchored message is mounted, and the mount is still bounded.
    const covers = plan.segments.some(
      (s) => anchorIdx >= s.start && anchorIdx < s.end,
    );
    expect(covers).toBe(true);
    expect(plan.mountedCount).toBeLessThanOrEqual(TRANSCRIPT_MAX_RENDERED);
    // Window did NOT snap to the bottom.
    expect(plan.segments[plan.segments.length - 1].end).toBeLessThan(count);
  });

  test("streaming tailKeep keeps the last rows mounted while scrolled away", () => {
    const count = 500;
    const tailKeep = 12;
    const plan = computeMountPlan({
      count,
      anchor: { mode: "id", id: idOf(50) },
      indexOfId: makeIndexOfId(count),
      maxRendered: TRANSCRIPT_MAX_RENDERED,
      tailKeep,
      materializeIndex: null,
      focusedIndex: null,
      targetOverscan: 3,
    });
    // Two disjoint segments: the scrolled-to window AND the streaming tail.
    const tail = plan.segments[plan.segments.length - 1];
    expect(tail.end).toBe(count);
    expect(tail.start).toBe(count - tailKeep);
    const coversAnchor = plan.segments.some((s) => 50 >= s.start && 50 < s.end);
    expect(coversAnchor).toBe(true);
  });

  test("an offscreen materialized target is mounted", () => {
    const count = 500;
    const target = 7;
    const plan = computeMountPlan({
      count,
      anchor: { mode: "bottom" },
      indexOfId: makeIndexOfId(count),
      maxRendered: TRANSCRIPT_MAX_RENDERED,
      tailKeep: 0,
      materializeIndex: target,
      focusedIndex: null,
      targetOverscan: 3,
    });
    const covered = plan.segments.some((s) => target >= s.start && target < s.end);
    expect(covered).toBe(true);
  });

  test("a missing id anchor falls back to following the tail", () => {
    const count = 500;
    const plan = computeMountPlan({
      count,
      anchor: { mode: "id", id: "does-not-exist" },
      indexOfId: makeIndexOfId(count),
      maxRendered: TRANSCRIPT_MAX_RENDERED,
      tailKeep: 0,
      materializeIndex: null,
      focusedIndex: null,
      targetOverscan: 3,
    });
    expect(plan.segments[plan.segments.length - 1].end).toBe(count);
  });

  test("optimistic-id reconciliation preserves the last stable neighborhood", () => {
    const count = 500;
    const reconciledIndex = 120;
    const plan = computeMountPlan({
      count,
      anchor: {
        mode: "id",
        id: "optimistic-id-no-longer-present",
        fallbackIndex: reconciledIndex,
        offsetPx: 24,
      },
      indexOfId: makeIndexOfId(count),
      maxRendered: TRANSCRIPT_MAX_RENDERED,
      tailKeep: 0,
      materializeIndex: null,
      focusedIndex: null,
      targetOverscan: 3,
    });
    expect(
      plan.segments.some(
        (segment) => reconciledIndex >= segment.start && reconciledIndex < segment.end,
      ),
    ).toBe(true);
    expect(plan.segments.at(-1)?.end).toBeLessThan(count);
    expect(plan.mountedCount).toBeLessThanOrEqual(TRANSCRIPT_MAX_RENDERED);
  });

  test("a focused row and bounded overscan stay pinned outside the primary window", () => {
    const count = 500;
    const focusedIndex = 100;
    const plan = computeMountPlan({
      count,
      anchor: { mode: "bottom" },
      indexOfId: makeIndexOfId(count),
      maxRendered: TRANSCRIPT_MAX_RENDERED,
      tailKeep: 0,
      materializeIndex: null,
      focusedIndex,
      targetOverscan: 3,
    });
    for (let i = focusedIndex - 3; i <= focusedIndex + 3; i++) {
      expect(plan.segments.some((s) => i >= s.start && i < s.end)).toBe(true);
    }
    expect(plan.segments[plan.segments.length - 1].end).toBe(count);
    expect(plan.mountedCount).toBeLessThanOrEqual(TRANSCRIPT_MAX_RENDERED);
  });

  test("message-id anchoring survives prepend index shifts", () => {
    const before = Array.from({ length: 500 }, (_, i) => idOf(i));
    const anchorId = idOf(120);
    const beforePlan = computeMountPlan({
      count: before.length,
      anchor: { mode: "id", id: anchorId },
      indexOfId: (id) => before.indexOf(id),
      maxRendered: TRANSCRIPT_MAX_RENDERED,
      tailKeep: 0,
      materializeIndex: null,
      focusedIndex: null,
      targetOverscan: 3,
    });
    expect(
      beforePlan.segments.some((s) => 120 >= s.start && 120 < s.end),
    ).toBe(true);

    const after = [
      ...Array.from({ length: 10 }, (_, i) => `prepended-${i}`),
      ...before,
    ];
    const shiftedIndex = after.indexOf(anchorId);
    const afterPlan = computeMountPlan({
      count: after.length,
      anchor: { mode: "id", id: anchorId },
      indexOfId: (id) => after.indexOf(id),
      maxRendered: TRANSCRIPT_MAX_RENDERED,
      tailKeep: 0,
      materializeIndex: null,
      focusedIndex: null,
      targetOverscan: 3,
    });
    expect(shiftedIndex).toBe(130);
    expect(
      afterPlan.segments.some(
        (s) => shiftedIndex >= s.start && shiftedIndex < s.end,
      ),
    ).toBe(true);
    expect(afterPlan.mountedCount).toBeLessThanOrEqual(TRANSCRIPT_MAX_RENDERED);
  });
});

// ---------------------------------------------------------------------------
// React render coverage (happy-dom)
// ---------------------------------------------------------------------------

let happyWindow: Window;
const priorGlobals: Record<string, unknown> = {};
let container: HTMLDivElement;
let root: Root;
let resizeObserverUnobserved: Element[];
let resizeObserverHeight: number | null;

class TestResizeObserver {
  private readonly observed = new Set<Element>();
  private readonly callback: ResizeObserverCallback;

  constructor(callback: ResizeObserverCallback) {
    this.callback = callback;
  }

  observe(target: Element): void {
    this.observed.add(target);
    if (resizeObserverHeight != null) {
      const height = resizeObserverHeight;
      this.callback(
        [
          {
            target,
            contentRect: {
              height,
              width: 0,
              top: 0,
              left: 0,
              bottom: height,
              right: 0,
              x: 0,
              y: 0,
              toJSON: () => ({}),
            },
            borderBoxSize: [{ blockSize: height, inlineSize: 0 }],
          } as ResizeObserverEntry,
        ],
        this,
      );
    }
  }

  unobserve(target: Element): void {
    this.observed.delete(target);
    resizeObserverUnobserved.push(target);
  }

  disconnect(): void {
    this.observed.clear();
  }
}

beforeAll(() => {
  happyWindow = new Window({ url: "http://127.0.0.1:3001/" });
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  for (const k of [
    "window",
    "document",
    "navigator",
    "HTMLElement",
    "ResizeObserver",
    "requestAnimationFrame",
    "cancelAnimationFrame",
  ] as const) {
    priorGlobals[k] = (globalThis as Record<string, unknown>)[k];
  }
  Object.assign(globalThis, {
    window: happyWindow,
    document: happyWindow.document,
    navigator: happyWindow.navigator,
    HTMLElement: happyWindow.HTMLElement,
    ResizeObserver: TestResizeObserver,
    requestAnimationFrame: happyWindow.requestAnimationFrame.bind(happyWindow),
    cancelAnimationFrame: happyWindow.cancelAnimationFrame.bind(happyWindow),
  });
});

beforeEach(() => {
  resizeObserverUnobserved = [];
  resizeObserverHeight = null;
  container = happyWindow.document.createElement("div") as unknown as HTMLDivElement;
  happyWindow.document.body.appendChild(container);
  root = createRoot(container);
});

afterAll(() => {
  Reflect.deleteProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT");
  const g = globalThis as Record<string, unknown>;
  for (const key of Object.keys(priorGlobals)) {
    if (priorGlobals[key] === undefined) delete g[key];
    else g[key] = priorGlobals[key];
  }
});

function rowCount(): number {
  return container.querySelectorAll('[data-transcript-row="true"]').length;
}
function spacerCount(): number {
  return container.querySelectorAll('[data-transcript-spacer="true"]').length;
}
function topSpacerHeightPx(): number {
  const spacer = container.querySelector<HTMLElement>(
    '[data-transcript-spacer="true"]',
  );
  return spacer ? Number.parseFloat(spacer.style.height) : 0;
}
function bottomSpacerHeightPx(): number {
  const spacers = container.querySelectorAll<HTMLElement>(
    '[data-transcript-spacer="true"]',
  );
  const spacer = spacers.item(spacers.length - 1);
  return spacer ? Number.parseFloat(spacer.style.height) : 0;
}
function renderWindow(props: {
  count: number;
  ids?: readonly string[];
  isRunning?: boolean;
  followingLiveEdge?: boolean;
  handleRef?: React.RefObject<TranscriptWindowHandle | null>;
  resetKey?: string;
  maxRendered?: number;
  rowHeight?: number;
  estimateItemHeight?: number;
  activeScopeKey?: string;
  transcriptReadyScopeKey?: string | null;
  onRestoreReady?: () => void;
}): void {
  const viewportRef = { current: container as unknown as HTMLElement };
  const ids = props.ids ?? Array.from({ length: props.count }, (_, i) => idOf(i));
  const rowHeight = props.rowHeight;
  resizeObserverHeight = rowHeight ?? null;
  act(() => {
    root.render(
      <ConversationRestoreGate
        activeScopeKey={props.activeScopeKey ?? "test-room"}
        transcriptReadyScopeKey={props.transcriptReadyScopeKey ?? null}
        onReady={props.onRestoreReady}
      >
      <TranscriptWindow
        count={props.count}
        getItemKey={(i) => ids[i] ?? String(i)}
        renderItem={(i) => (
          <button
            type="button"
            data-row-index={i}
            data-row-id={ids[i]}
            style={
              rowHeight != null
                ? { display: "block", height: `${rowHeight}px`, margin: 0, padding: 0 }
                : undefined
            }
          >
            row {i}
          </button>
        )}
        viewportRef={viewportRef}
        isRunning={props.isRunning ?? false}
        followingLiveEdge={props.followingLiveEdge}
        resetKey={props.resetKey}
        maxRendered={props.maxRendered}
        estimateItemHeight={props.estimateItemHeight}
        {...(props.handleRef ? { handleRef: props.handleRef } : {})}
      />
      </ConversationRestoreGate>,
    );
  });
}

describe("TranscriptWindow (render)", () => {
  test("saved-away Room switch lands its stable row before remote growth", async () => {
    const handleRef = createRef<TranscriptWindowHandle>();
    const roomA = Array.from({ length: 30 }, (_, i) => `a${i}`);
    const latestRoomB = Array.from({ length: 50 }, (_, i) => `b${450 + i}`);
    const aroundSavedAnchor = Array.from({ length: 50 }, (_, i) => `b${100 + i}`);
    let viewportScrollTop = 200;
    let scrollWrites = 0;
    Object.defineProperties(container, {
      scrollHeight: { configurable: true, value: 50_000 },
      clientHeight: { configurable: true, value: 600 },
      scrollTop: {
        configurable: true,
        get: () => viewportScrollTop,
        set: (value: number) => {
          scrollWrites += 1;
          viewportScrollTop = value;
        },
      },
    });
    renderWindow({ count: roomA.length, ids: roomA, resetKey: "room-a", handleRef, followingLiveEdge: false });

    const activeScopeKey = conversationViewportScopeKey("room-b");
    const hydratedLatest = [...latestRoomB, "remote-human-during-switch"];
    const aroundLoads: string[] = [];
    let restoreStarts = 0;
    const startRestore = () => { restoreStarts += 1; };
    const runRestore = () => materializeFirstConversationAnchor({
        candidates: [
          { messageId: "deleted-b120", offsetPx: -20 },
          { messageId: "b121", offsetPx: 70 },
        ],
        materializeById: (messageId) => {
          let materialized = false;
          act(() => {
            materialized = handleRef.current?.materializeById(messageId) ?? false;
          });
          return materialized;
        },
        findTarget: (messageId) =>
          container.querySelector<HTMLElement>(`[data-row-id="${messageId}"]`),
        releaseMaterializedTarget: (messageId) => {
          act(() => handleRef.current?.releaseMaterializedTarget(messageId));
        },
        waitForCommit: async () => {
          await act(async () => {
            await Promise.resolve();
          });
        },
        loadHistoryAround: async (messageId) => {
          aroundLoads.push(messageId);
          if (messageId !== "b121") return false;
          const merged = [...aroundSavedAnchor, ...hydratedLatest];
          renderWindow({
            count: merged.length,
            ids: merged,
            resetKey: "room-b",
            handleRef,
            followingLiveEdge: false,
            isRunning: true,
            activeScopeKey,
            transcriptReadyScopeKey: activeScopeKey,
            onRestoreReady: startRestore,
          });
          return true;
        },
        isCurrent: () => true,
        maxAttempts: 1,
      });

    // The runtime first clears Room A and leaves the viewport fenced while the
    // selected Room asynchronously rehydrates. No auto-follow owner may write
    // during this empty binding frame.
    viewportScrollTop = 0;
    renderWindow({
      count: roomA.length,
      ids: roomA,
      resetKey: "room-b",
      handleRef,
      followingLiveEdge: false,
      activeScopeKey,
      transcriptReadyScopeKey: null,
      onRestoreReady: startRestore,
    });
    expect(restoreStarts).toBe(0);
    renderWindow({
      count: 0,
      ids: [],
      resetKey: "room-b",
      handleRef,
      followingLiveEdge: false,
      activeScopeKey,
      transcriptReadyScopeKey: null,
      onRestoreReady: startRestore,
    });
    expect(restoreStarts).toBe(0);
    expect(scrollWrites).toBe(0);

    // Canonical binding readiness exposes only the latest 50 messages. The
    // saved identity is older, so restore must use loadHistoryAround before it
    // can materialize the row.
    renderWindow({
      count: hydratedLatest.length,
      ids: hydratedLatest,
      resetKey: "room-b",
      handleRef,
      followingLiveEdge: false,
      isRunning: true,
      activeScopeKey,
      transcriptReadyScopeKey: activeScopeKey,
      onRestoreReady: startRestore,
    });
    expect(restoreStarts).toBe(1);
    const restored = await runRestore();

    expect(aroundLoads).toEqual(["deleted-b120", "b121"]);
    expect(restored?.anchor.messageId).toBe("b121");
    const restoredTarget = container.querySelector<HTMLElement>('[data-row-id="b121"]');
    expect(restoredTarget).not.toBeNull();
    Object.defineProperty(restoredTarget, "getBoundingClientRect", {
      configurable: true,
      value: () => ({ top: 190, bottom: 250, left: 0, right: 100, width: 100, height: 60 }),
    });
    const currentOffset = restoredTarget!.getBoundingClientRect().top -
      container.getBoundingClientRect().top;
    container.scrollTop += currentOffset - restored!.anchor.offsetPx;
    act(() => handleRef.current?.releaseMaterializedTarget("b121"));

    const afterMoreRemoteGrowth = [
      ...aroundSavedAnchor,
      ...hydratedLatest,
      "remote-agent-growth",
    ];
    renderWindow({
      count: afterMoreRemoteGrowth.length,
      ids: afterMoreRemoteGrowth,
      resetKey: "room-b",
      handleRef,
      followingLiveEdge: false,
      isRunning: true,
      activeScopeKey,
      transcriptReadyScopeKey: activeScopeKey,
      onRestoreReady: startRestore,
    });
    expect(container.querySelector('[data-row-id="b121"]')).not.toBeNull();
    expect(viewportScrollTop).toBe(120);
    expect(scrollWrites).toBe(1);
    act(() => root.unmount());
  });

  test("mounted legacy chat follows streaming, preserves Human away, and returns on local send", () => {
    function LegacyViewportHarness() {
      const [mode, setMode] = useState<ConversationViewportMode>("following");
      const scopeKey = conversationViewportScopeKey(null);
      const following = isConversationViewportFollowing({
        mode,
        activeScopeKey: scopeKey,
        readyScopeKey: scopeKey,
      });
      return (
        <>
          <output data-testid="legacy-following">{String(following)}</output>
          <button type="button" data-testid="legacy-away" onClick={() => {
            setMode((current) => transitionConversationViewport(current, {
              type: "reader-scrolled-away",
            }));
          }}>Away</button>
          <button type="button" data-testid="legacy-local-send" onClick={() => {
            setMode((current) => transitionConversationViewport(current, {
              type: "local-send",
            }));
          }}>Send</button>
        </>
      );
    }

    act(() => root.render(<LegacyViewportHarness />));
    const following = () => container.querySelector('[data-testid="legacy-following"]')?.textContent;
    expect(following()).toBe("true");
    act(() => container.querySelector<HTMLButtonElement>('[data-testid="legacy-away"]')?.click());
    expect(following()).toBe("false");
    act(() => container.querySelector<HTMLButtonElement>('[data-testid="legacy-local-send"]')?.click());
    expect(following()).toBe("true");
    act(() => root.unmount());
  });

  test("a 500-message fixture mounts a bounded number of rows", () => {
    renderWindow({ count: 500 });
    expect(rowCount()).toBe(TRANSCRIPT_MAX_RENDERED);
    const win = container.querySelector('[data-testid="transcript-window"]');
    expect(win?.getAttribute("data-transcript-windowed")).toBe("true");
    expect(win?.getAttribute("data-transcript-total")).toBe("500");
    // The streaming tail (last message) is genuinely mounted, not hidden.
    expect(
      container.querySelector('[data-row-index="499"]'),
    ).not.toBeNull();
    // Windowing uses real spacers, not CSS-hidden rows.
    expect(spacerCount()).toBeGreaterThan(0);
    const firstRow = container.querySelector<HTMLElement>('[data-transcript-row="true"]');
    expect(firstRow?.style.display).toBe("flow-root");
    expect(firstRow?.style.overflowAnchor).toBe("auto");
    expect(
      container.querySelector<HTMLElement>('[data-transcript-spacer="true"]')?.style
        .overflowAnchor,
    ).toBe("none");
    act(() => root.unmount());
  });

  test("short rooms keep the simple path (all rows, no spacers)", () => {
    renderWindow({ count: 10 });
    expect(rowCount()).toBe(10);
    expect(spacerCount()).toBe(0);
    const win = container.querySelector('[data-testid="transcript-window"]');
    expect(win?.getAttribute("data-transcript-windowed")).toBe("false");
    act(() => root.unmount());
  });

  test("an offscreen target can be materialized on demand", () => {
    const handleRef = createRef<TranscriptWindowHandle>();
    renderWindow({ count: 500, handleRef });
    // Index 3 is far above the bottom window and not mounted initially.
    expect(container.querySelector('[data-row-index="3"]')).toBeNull();
    let found = false;
    act(() => {
      found = handleRef.current?.materializeById(idOf(3)) ?? false;
    });
    expect(found).toBe(true);
    expect(container.querySelector('[data-row-index="3"]')).not.toBeNull();
    // Still bounded — materializing does not mount the whole history.
    expect(rowCount()).toBeLessThanOrEqual(TRANSCRIPT_MAX_RENDERED);
    act(() => root.unmount());
  });

  test("a stale landing cannot release a newer materialized target", () => {
    const handleRef = createRef<TranscriptWindowHandle>();
    renderWindow({ count: 500, handleRef });
    act(() => {
      handleRef.current?.materializeById(idOf(3));
    });
    act(() => {
      handleRef.current?.materializeById(idOf(100));
      handleRef.current?.releaseMaterializedTarget(idOf(3));
    });

    expect(container.querySelector('[data-row-index="100"]')).not.toBeNull();
    expect(container.querySelector('[data-row-index="3"]')).toBeNull();
    act(() => root.unmount());
  });

  test("remote growth cannot replace a released reader-away anchor with the tail", () => {
    const handleRef = createRef<TranscriptWindowHandle>();
    const before = Array.from({ length: 500 }, (_, i) => idOf(i));
    let viewportScrollTop = 200;
    let scrollWrites = 0;
    Object.defineProperties(container, {
      scrollHeight: { configurable: true, value: 50_000 },
      clientHeight: { configurable: true, value: 600 },
      scrollTop: {
        configurable: true,
        get: () => viewportScrollTop,
        set: (value: number) => {
          scrollWrites += 1;
          viewportScrollTop = value;
        },
      },
    });
    renderWindow({
      count: before.length,
      ids: before,
      handleRef,
      followingLiveEdge: false,
    });
    act(() => {
      handleRef.current?.materializeById(idOf(120));
      handleRef.current?.releaseMaterializedTarget(idOf(120));
    });

    const after = [...before, "remote-500"];
    renderWindow({
      count: after.length,
      ids: after,
      handleRef,
      followingLiveEdge: false,
      isRunning: true,
    });

    expect(container.querySelector('[data-row-id="m120"]')).not.toBeNull();
    expect(container.querySelector('[data-row-id="remote-500"]')).not.toBeNull();
    expect(rowCount()).toBeLessThanOrEqual(TRANSCRIPT_MAX_RENDERED);
    expect(viewportScrollTop).toBe(200);
    expect(scrollWrites).toBe(0);
    act(() => root.unmount());
  });

  test("evicted row elements are explicitly unobserved", () => {
    const handleRef = createRef<TranscriptWindowHandle>();
    renderWindow({ count: 500, handleRef });
    const evicted = container.querySelector<HTMLElement>('[data-row-id="m499"]')
      ?.closest<HTMLElement>('[data-transcript-row="true"]');
    expect(evicted).not.toBeNull();
    act(() => {
      handleRef.current?.materializeById(idOf(3));
    });
    expect(resizeObserverUnobserved).toContain(evicted as Element);
    act(() => root.unmount());
  });

  test("focused rows remain mounted when navigation moves the primary window", () => {
    const handleRef = createRef<TranscriptWindowHandle>();
    renderWindow({ count: 500, handleRef, maxRendered: 20 });
    const focused = container.querySelector<HTMLElement>('[data-row-id="m490"]');
    expect(focused).not.toBeNull();
    act(() => focused?.focus());
    act(() => {
      handleRef.current?.materializeById(idOf(3));
    });
    expect(container.querySelector('[data-row-id="m490"]')).not.toBeNull();
    for (let i = 487; i <= 493; i++) {
      expect(container.querySelector(`[data-row-id="m${i}"]`)).not.toBeNull();
    }
    expect(rowCount()).toBeLessThanOrEqual(20);
    act(() => root.unmount());
  });

  test("resetKey renders the new room tail without prior-room rows", () => {
    const handleRef = createRef<TranscriptWindowHandle>();
    const roomA = Array.from({ length: 500 }, (_, i) => `a-${i}`);
    renderWindow({
      count: roomA.length,
      ids: roomA,
      handleRef,
      resetKey: "room-a",
    });
    act(() => {
      handleRef.current?.materializeById("a-3");
    });
    expect(container.querySelector('[data-row-id="a-3"]')).not.toBeNull();

    const roomB = Array.from({ length: 500 }, (_, i) => `b-${i}`);
    renderWindow({
      count: roomB.length,
      ids: roomB,
      handleRef,
      resetKey: "room-b",
    });
    expect(container.querySelector('[data-row-id^="a-"]')).toBeNull();
    expect(container.querySelector('[data-row-id="b-499"]')).not.toBeNull();
    expect(container.querySelector('[data-row-id="b-3"]')).toBeNull();
    expect(rowCount()).toBe(TRANSCRIPT_MAX_RENDERED);
    act(() => root.unmount());
  });

  test("resetKey clears stale measurements so spacers ignore prior-room geometry", () => {
    const handleRef = createRef<TranscriptWindowHandle>();
    const ids = Array.from({ length: 500 }, (_, i) => `shared-${i}`);
    const tallPx = 300;
    const evictedCount = 500 - TRANSCRIPT_MAX_RENDERED;

    renderWindow({
      count: 500,
      ids,
      handleRef,
      resetKey: "room-a",
      rowHeight: tallPx,
    });
    act(() => {
      handleRef.current?.materializeById("shared-100");
    });

    renderWindow({
      count: 500,
      ids,
      handleRef,
      resetKey: "room-b",
      rowHeight: tallPx,
    });

    const expectedWithFreshEstimates = evictedCount * TRANSCRIPT_ESTIMATE_PX;
    const wouldBeStaleWithPriorRoom =
      expectedWithFreshEstimates - TRANSCRIPT_ESTIMATE_PX + tallPx;
    expect(topSpacerHeightPx()).toBe(expectedWithFreshEstimates);
    expect(topSpacerHeightPx()).not.toBe(wouldBeStaleWithPriorRoom);

    // The committed room must be re-observed after cleanup. Once its measured
    // tail is evicted, those new-room measurements should shape its spacer.
    act(() => {
      handleRef.current?.materializeById("shared-100");
    });
    const bottomEvictedCount = 370;
    expect(bottomSpacerHeightPx()).toBe(
      (bottomEvictedCount - TRANSCRIPT_MAX_RENDERED) * TRANSCRIPT_ESTIMATE_PX +
        TRANSCRIPT_MAX_RENDERED * tallPx,
    );
    act(() => root.unmount());
  });

  test("unmount clears row observers and measurement caches", () => {
    const handleRef = createRef<TranscriptWindowHandle>();
    renderWindow({ count: 500, handleRef, rowHeight: 120 });
    const observed = container.querySelector<HTMLElement>('[data-transcript-row="true"]');
    expect(observed).not.toBeNull();
    act(() => {
      handleRef.current?.materializeById(idOf(3));
    });
    act(() => root.unmount());
    expect(resizeObserverUnobserved.length).toBeGreaterThan(0);
  });
});
