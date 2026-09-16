/**
 * D246 Wave 3 — bounded transcript rendering.
 *
 * Problem: the main conversation renders every assistant-ui message through
 * `ThreadPrimitive.Messages`, which mounts one message root (+ Markdown, tool
 * cards, reactions, approvals, actions) per message. A 500-message room mounts
 * hundreds of subtrees, blowing up initial render and room-switch commit cost.
 *
 * Fix: mount only a bounded, measured window of message rows plus the streaming
 * tail. This module owns the windowing math (`computeMountPlan`, a pure,
 * deterministically-testable function) and the React shell (`TranscriptWindow`)
 * that renders the plan inside the existing `ThreadPrimitive.Viewport`.
 *
 * Rows are mounted through a caller-supplied id-stable assistant-ui message
 * provider. The window passes both the stable message id and its current
 * positional index to `renderItem`; the id owns provider identity while the
 * index remains window geometry/diagnostic data. This preserves full message
 * context (`useMessage`, tool cards, reactions, edit/approval state) while
 * allowing middle deletions to compact positions safely. Off-window rows are
 * genuinely unmounted and replaced with measured spacer <div>s — we never hide
 * mounted rows with CSS visibility, so the render cost is real, not cosmetic.
 *
 * Variable heights: each mounted row is measured (ResizeObserver, keyed by the
 * stable message id) and the measurement is cached so the spacer that later
 * stands in for an evicted row keeps the scrollbar geometry stable. Unmeasured
 * rows fall back to an estimate.
 *
 * Why not `@tanstack/react-virtual` here: its range is derived from the live
 * viewport rect + scroll offset, which is 0 under the jsdom/happy-dom test
 * environment (no layout, no ResizeObserver-driven rect) and would render from
 * the top rather than the streaming tail, making the bounded-window and
 * tail-mounted acceptance non-deterministic. It also assumes ownership of
 * scroll adjustment, which would fight assistant-ui's viewport autoscroll. A
 * count-anchored window keyed by message id composes cleanly with all of the
 * above and stays deterministic in tests. The assistant-ui id-based custom-list
 * primitive supplies context without binding a surviving row to a stale index.
 */
import {
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type Ref,
  type RefObject,
} from "react";

/** Default cap on simultaneously-mounted message rows for long transcripts. */
export const TRANSCRIPT_MAX_RENDERED = 60;
/** Extra rows materialized around a jumped-to target. */
const TRANSCRIPT_TARGET_OVERSCAN = 3;
/** Fallback row height (px) for rows that have not been measured yet. */
export const TRANSCRIPT_ESTIMATE_PX = 96;
/** Distance from the bottom (px) still treated as "following the tail". */
const STICK_THRESHOLD_PX = 120;
/** Keep virtualization responsive when Electron throttles visual frames. */
const TRANSCRIPT_FRAME_FALLBACK_MS = 32;

export interface FrameFallbackScheduler {
  requestFrame: (callback: FrameRequestCallback) => number;
  cancelFrame: (handle: number) => void;
  setFallback: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
  clearFallback: (handle: ReturnType<typeof setTimeout>) => void;
}

/**
 * Schedule viewport work for the next paint, with a bounded timer fallback for
 * occluded/throttled Electron renderers. Returns an idempotent cancellation.
 */
export function scheduleFrameWithFallback(
  callback: () => void,
  scheduler: FrameFallbackScheduler = {
    requestFrame: (run) => requestAnimationFrame(run),
    cancelFrame: (handle) => cancelAnimationFrame(handle),
    setFallback: (run, delayMs) => setTimeout(run, delayMs),
    clearFallback: (handle) => clearTimeout(handle),
  },
): () => void {
  let active = true;
  let frameHandle: number | null = null;
  let fallbackHandle: ReturnType<typeof setTimeout> | null = null;
  const cancel = (): void => {
    if (!active) return;
    active = false;
    if (frameHandle !== null) scheduler.cancelFrame(frameHandle);
    if (fallbackHandle !== null) scheduler.clearFallback(fallbackHandle);
  };
  const finish = (): void => {
    if (!active) return;
    cancel();
    callback();
  };
  frameHandle = scheduler.requestFrame(finish);
  fallbackHandle = scheduler.setFallback(finish, TRANSCRIPT_FRAME_FALLBACK_MS);
  return cancel;
}

/**
 * Anchor for the mounted window.
 * - `bottom`: follow the streaming tail (default / return-to-bottom).
 * - `id`: keep a specific message centered (scrolled-away / jump target).
 *   Stored by id, not index, so prepend/eviction can't drift the anchor.
 */
export type TranscriptAnchor =
  | { readonly mode: "bottom" }
  | {
      readonly mode: "id";
      readonly id: string;
      /** Last known position, used only if an optimistic id reconciles/disappears. */
      readonly fallbackIndex?: number;
      /** Bounded viewport offset recorded with the stable identity. */
      readonly offsetPx?: number;
    };

const BOTTOM_ANCHOR: TranscriptAnchor = { mode: "bottom" };

export interface MountSegment {
  /** inclusive */
  readonly start: number;
  /** exclusive */
  readonly end: number;
}

export interface MountPlan {
  /** false = short-room passthrough (every row mounted, no spacers). */
  readonly windowed: boolean;
  /** Sorted, non-overlapping index ranges to mount. */
  readonly segments: readonly MountSegment[];
  /** Total number of rows mounted by this plan. */
  readonly mountedCount: number;
}

export interface ComputeMountPlanParams {
  readonly count: number;
  readonly anchor: TranscriptAnchor;
  /** Resolve an anchor/target id to its current index (-1 if absent). */
  readonly indexOfId: (id: string) => number;
  readonly maxRendered: number;
  /** Keep the last N rows mounted regardless of anchor (streaming tail). */
  readonly tailKeep: number;
  /** Force a specific index (+context) into the plan (materialized target). */
  readonly materializeIndex: number | null;
  /** Keep the actively focused row (+context) mounted across window changes. */
  readonly focusedIndex: number | null;
  readonly targetOverscan: number;
}

const clamp = (v: number, lo: number, hi: number): number =>
  Math.min(Math.max(v, lo), hi);

function coalesce(
  ranges: readonly MountSegment[],
  count: number,
): MountSegment[] {
  const norm = ranges
    .map((r) => ({ start: clamp(r.start, 0, count), end: clamp(r.end, 0, count) }))
    .filter((r) => r.end > r.start)
    .sort((a, b) => a.start - b.start);
  const out: MountSegment[] = [];
  for (const r of norm) {
    const last = out[out.length - 1];
    if (last && r.start <= last.end) {
      if (r.end > last.end) out[out.length - 1] = { start: last.start, end: r.end };
    } else {
      out.push({ start: r.start, end: r.end });
    }
  }
  return out;
}

/**
 * Pure windowing decision. Deterministic — no DOM, no layout — so it can be
 * unit-tested against fixtures (short room, 500-message room, streaming tail,
 * scrolled-away anchor, offscreen jump target).
 */
export function computeMountPlan(params: ComputeMountPlanParams): MountPlan {
  const {
    count,
    anchor,
    indexOfId,
    maxRendered,
    tailKeep,
    materializeIndex,
    focusedIndex,
    targetOverscan,
  } = params;

  if (count <= 0) return { windowed: false, segments: [], mountedCount: 0 };

  // Short rooms keep the simple current path: mount everything, no spacers.
  if (count <= maxRendered) {
    return {
      windowed: false,
      segments: [{ start: 0, end: count }],
      mountedCount: count,
    };
  }

  const budget = Math.min(Math.max(maxRendered, 1), count);
  let primaryIndex: number;
  if (anchor.mode === "id") {
    const idx = indexOfId(anchor.id);
    if (idx < 0) {
      // Optimistic-id reconciliation or a middle deletion must not throw a
      // reader to the tail. Preserve the same bounded neighborhood instead.
      primaryIndex = anchor.fallbackIndex == null
        ? count - 1
        : clamp(anchor.fallbackIndex, 0, count - 1);
    } else {
      primaryIndex = idx;
    }
  } else {
    primaryIndex = count - 1;
  }

  // Fill one hard budget. Pins are added before the primary viewport range so
  // focused rows, explicit navigation targets, and the streaming tail cannot
  // be evicted; the ordinary window consumes only the remaining capacity.
  const mounted = new Set<number>();
  const addNearest = (center: number, radius: number): void => {
    if (center < 0 || center >= count) return;
    for (let distance = 0; distance <= radius && mounted.size < budget; distance++) {
      const before = center - distance;
      const after = center + distance;
      if (before >= 0) mounted.add(before);
      if (mounted.size >= budget) break;
      if (distance > 0 && after < count) mounted.add(after);
    }
  };

  // Focus is the strongest pin: never discard an actively focused control.
  if (focusedIndex != null) addNearest(focusedIndex, targetOverscan);
  // Programmatic quote/search/retry/edit navigation target.
  if (materializeIndex != null) addNearest(materializeIndex, targetOverscan);
  // Active stream tail remains live even while the user reads older history.
  if (tailKeep > 0) {
    for (let i = count - 1; i >= Math.max(0, count - tailKeep) && mounted.size < budget; i--) {
      mounted.add(i);
    }
  }
  // Spend the rest of the budget around the primary scroll anchor.
  addNearest(primaryIndex, count);

  const sorted = [...mounted].sort((a, b) => a - b);
  const ranges: MountSegment[] = [];
  for (const index of sorted) {
    const last = ranges[ranges.length - 1];
    if (last && last.end === index) {
      ranges[ranges.length - 1] = { start: last.start, end: index + 1 };
    } else {
      ranges.push({ start: index, end: index + 1 });
    }
  }
  const segments = coalesce(ranges, count);
  const mountedCount = segments.reduce((n, s) => n + (s.end - s.start), 0);
  return { windowed: true, segments, mountedCount };
}

export interface TranscriptWindowHandle {
  /** Materialize + anchor the window on a message id. Returns whether found. */
  materializeById: (id: string) => boolean;
  /** Materialize + anchor the window on an index. */
  materializeByIndex: (index: number) => void;
  /** Release the temporary navigation pin after the target DOM row is reached. */
  releaseMaterializedTarget: (id?: string) => void;
  /** Snap back to following the streaming tail. */
  followTail: () => void;
}

export interface TranscriptWindowProps {
  /** Number of messages in the active thread. */
  count: number;
  /** Stable per-index key (message id) used for measurement + anchoring. */
  getItemKey: (index: number) => string;
  /**
   * Render one message row. `id` is the provider identity; `index` is only the
   * row's current position for window geometry and diagnostics.
   */
  renderItem: (index: number, id: string) => ReactNode;
  /** The scrolling viewport that owns this transcript. */
  viewportRef: RefObject<HTMLElement | null>;
  /** True while a turn is streaming — keeps the tail mounted. */
  isRunning?: boolean;
  /** Reader-owned follow intent; geometry is only a test/legacy fallback. */
  followingLiveEdge?: boolean;
  /** Reset the window to the tail when this changes (e.g. active room id). */
  resetKey?: string | null;
  handleRef?: Ref<TranscriptWindowHandle>;
  maxRendered?: number;
  estimateItemHeight?: number;
}

/**
 * Bounded transcript renderer. Mounts a measured window of message rows plus
 * spacers for the evicted regions, inside the caller's scroll viewport.
 */
export function TranscriptWindow({
  count,
  getItemKey,
  renderItem,
  viewportRef,
  isRunning = false,
  followingLiveEdge,
  resetKey = null,
  handleRef,
  maxRendered = TRANSCRIPT_MAX_RENDERED,
  estimateItemHeight = TRANSCRIPT_ESTIMATE_PX,
}: TranscriptWindowProps): ReactNode {
  const listRef = useRef<HTMLDivElement>(null);
  const [anchor, setAnchor] = useState<TranscriptAnchor>(BOTTOM_ANCHOR);
  const [materializeIndex, setMaterializeIndex] = useState<number | null>(null);
  const [focusedId, setFocusedId] = useState<string | null>(null);
  const stateResetKeyRef = useRef(resetKey);
  const resetChanged = stateResetKeyRef.current !== resetKey;
  // Derive the reset during render. A passive effect would commit one frame of
  // the prior room's anchor/pins before resetting; these effective values make
  // the first render for the new key tail-only, then layout-sync state pre-paint.
  const effectiveAnchor = resetChanged ? BOTTOM_ANCHOR : anchor;
  const effectiveMaterializeIndex = resetChanged ? null : materializeIndex;
  const effectiveFocusedId = resetChanged ? null : focusedId;
  // Bumped when a measurement changes so spacers recompute. Kept separate from
  // anchor so token-level content growth doesn't thrash the window decision.
  const [, setMeasureVersion] = useState(0);

  const heightsRef = useRef<Map<string, number>>(new Map());
  const observerRef = useRef<ResizeObserver | null>(null);
  const elToId = useRef<WeakMap<Element, string>>(new WeakMap());
  const idToElement = useRef<Map<string, HTMLElement>>(new Map());
  const rowRefCallbacks = useRef<Map<string, (el: HTMLElement | null) => void>>(
    new Map(),
  );
  const cancelPendingVersionBump = useRef<(() => void) | null>(null);

  const clearMeasurementCaches = useCallback((): void => {
    cancelPendingVersionBump.current?.();
    cancelPendingVersionBump.current = null;
    const ro = observerRef.current;
    for (const el of idToElement.current.values()) {
      ro?.unobserve(el);
      elToId.current.delete(el);
    }
    idToElement.current.clear();
    heightsRef.current.clear();
    rowRefCallbacks.current.clear();
  }, []);

  const anchorRef = useRef(anchor);
  anchorRef.current = effectiveAnchor;
  const materializeIndexRef = useRef<number | null>(effectiveMaterializeIndex);
  materializeIndexRef.current = effectiveMaterializeIndex;

  const indexOfId = useCallback(
    (id: string): number => {
      for (let i = 0; i < count; i++) {
        if (getItemKey(i) === id) return i;
      }
      return -1;
    },
    [count, getItemKey],
  );

  // Commit the render-derived room reset before paint.
  useLayoutEffect(() => {
    if (stateResetKeyRef.current === resetKey) return;
    stateResetKeyRef.current = resetKey;
    clearMeasurementCaches();
    setAnchor(BOTTOM_ANCHOR);
    setMaterializeIndex(null);
    setFocusedId(null);
    // Clearing ref callbacks after the new room commits requires one
    // pre-paint render to attach fresh callbacks to its live row elements.
    setMeasureVersion((v) => v + 1);
  }, [resetKey, clearMeasurementCaches]);

  const heightFor = useCallback(
    (index: number): number => {
      // The incoming room's first render must not inherit spacer geometry from
      // the currently committed room. Actual cache cleanup remains commit-safe
      // in the layout effect above.
      if (resetChanged) return estimateItemHeight;
      const h = heightsRef.current.get(getItemKey(index));
      return h != null && h > 0 ? h : estimateItemHeight;
    },
    [getItemKey, estimateItemHeight, resetChanged],
  );

  const spacerPx = useCallback(
    (start: number, end: number): number => {
      let px = 0;
      for (let i = start; i < end; i++) px += heightFor(i);
      return px;
    },
    [heightFor],
  );

  const tailKeep = isRunning ? Math.min(TRANSCRIPT_TARGET_OVERSCAN * 4, maxRendered) : 0;
  const focusedIndex =
    effectiveFocusedId == null ? null : indexOfId(effectiveFocusedId);

  const plan = useMemo(
    () =>
      computeMountPlan({
        count,
        anchor: effectiveAnchor,
        indexOfId,
        maxRendered,
        tailKeep,
        materializeIndex: effectiveMaterializeIndex,
        focusedIndex,
        targetOverscan: TRANSCRIPT_TARGET_OVERSCAN,
      }),
    [
      count,
      effectiveAnchor,
      indexOfId,
      maxRendered,
      tailKeep,
      effectiveMaterializeIndex,
      focusedIndex,
    ],
  );

  // ---- scroll → anchor -----------------------------------------------------
  // Follow the tail while near the bottom; otherwise track the first visible
  // row by id so scrolling up materializes older history and evicts the tail.
  useEffect(() => {
    const vp = viewportRef.current;
    if (!vp) return;
    let cancelPendingRecompute: (() => void) | null = null;
    const recompute = (): void => {
      const list = listRef.current;
      if (!list) return;
      const nearBottom = followingLiveEdge ??
        vp.scrollHeight - vp.scrollTop - vp.clientHeight <= STICK_THRESHOLD_PX;
      // A stale pre-navigation scroll position can look like the tail after a
      // target-centered replan. Keep the explicit target pinned until the
      // navigation owner confirms that its DOM row was actually reached.
      if (nearBottom && materializeIndexRef.current === null) {
        if (anchorRef.current.mode !== "bottom") setAnchor(BOTTOM_ANCHOR);
        return;
      }
      const listTop = list.offsetTop;
      const target = vp.scrollTop - listTop;
      let acc = 0;
      let idx = 0;
      for (; idx < count - 1; idx++) {
        const h = heightFor(idx);
        if (acc + h > target) break;
        acc += h;
      }
      const id = getItemKey(clamp(idx, 0, count - 1));
      const offsetPx = Math.max(0, target - acc);
      const cur = anchorRef.current;
      if (
        cur.mode !== "id" ||
        cur.id !== id ||
        Math.abs((cur.offsetPx ?? 0) - offsetPx) >= 1
      ) {
        setAnchor({ mode: "id", id, fallbackIndex: idx, offsetPx });
      }
    };
    const onScroll = (): void => {
      if (cancelPendingRecompute) return;
      cancelPendingRecompute = scheduleFrameWithFallback(() => {
        cancelPendingRecompute = null;
        recompute();
      });
    };
    vp.addEventListener("scroll", onScroll, { passive: true });
    // A geometry-driven owner may first appear at scrollTop=0 even while its
    // sticky-follow intent still says "bottom". Materialize that real viewport
    // immediately; otherwise it can show only a spacer until the first scroll.
    // Explicit assistant-ui follow intent keeps its existing behavior.
    if (followingLiveEdge === undefined && vp.clientHeight > 0) recompute();
    return () => {
      vp.removeEventListener("scroll", onScroll);
      cancelPendingRecompute?.();
      cancelPendingRecompute = null;
    };
  }, [viewportRef, count, followingLiveEdge, getItemKey, heightFor]);

  // assistant-ui alone decides when following resumes. Windowing consumes the
  // decision so it can remount the tail, but never writes viewport scroll.
  useLayoutEffect(() => {
    if (!followingLiveEdge || materializeIndexRef.current !== null) return;
    if (anchorRef.current.mode !== "bottom") setAnchor(BOTTOM_ANCHOR);
  }, [followingLiveEdge]);

  // ---- row measurement -----------------------------------------------------
  const record = useCallback((id: string, height: number): void => {
    if (height <= 0) return;
    const prev = heightsRef.current.get(id);
    if (prev != null && Math.abs(prev - height) < 1) return;
    heightsRef.current.set(id, height);
    if (cancelPendingVersionBump.current) return;
    cancelPendingVersionBump.current = scheduleFrameWithFallback(() => {
      cancelPendingVersionBump.current = null;
      setMeasureVersion((v) => v + 1);
    });
  }, []);

  useEffect(() => {
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const id = elToId.current.get(entry.target);
        if (!id) continue;
        const box = entry.borderBoxSize?.[0];
        const height = box ? box.blockSize : entry.contentRect.height;
        record(id, height);
      }
    });
    observerRef.current = ro;
    for (const el of idToElement.current.values()) ro.observe(el);
    return () => {
      ro.disconnect();
      observerRef.current = null;
    };
  }, [record]);

  const rowRef = useCallback(
    (id: string): ((el: HTMLElement | null) => void) => {
      const existing = rowRefCallbacks.current.get(id);
      if (existing) return existing;
      const callback = (el: HTMLElement | null): void => {
        const ro = observerRef.current;
        const previous = idToElement.current.get(id);
        if (previous && previous !== el) {
          ro?.unobserve(previous);
          elToId.current.delete(previous);
          idToElement.current.delete(id);
        }
        if (el) {
          // Cache only after React commits the ref. An interrupted render must
          // not retain callbacks created for a room that never committed.
          rowRefCallbacks.current.set(id, callback);
          idToElement.current.set(id, el);
          elToId.current.set(el, id);
          ro?.observe(el);
          // Fallback measure for environments without a live ResizeObserver.
          if (el.offsetHeight > 0) record(id, el.offsetHeight);
        } else {
          // Drop the callback too: long scrolling must not retain one closure
          // for every message that has ever entered the mounted window.
          if (rowRefCallbacks.current.get(id) === callback) {
            rowRefCallbacks.current.delete(id);
          }
        }
      };
      return callback;
    },
    [record],
  );

  const handleRowFocus = useCallback((id: string): void => {
    setFocusedId(id);
  }, []);

  const handleRowBlur = useCallback(
    (id: string, currentTarget: HTMLElement, relatedTarget: EventTarget | null): void => {
      if (relatedTarget && currentTarget.contains(relatedTarget as Node)) return;
      setFocusedId((current) => (current === id ? null : current));
    },
    [],
  );

  useImperativeHandle(
    handleRef,
    (): TranscriptWindowHandle => ({
      materializeById: (id: string): boolean => {
        const idx = indexOfId(id);
        if (idx < 0) return false;
        // This is a temporary navigation target, not evidence of where the
        // reader was positioned. If the target is deleted before a scroll
        // event establishes a reader anchor, use the established missing-id
        // fallback (the tail) instead of retaining a stale target position.
        setAnchor({ mode: "id", id });
        setMaterializeIndex(idx);
        return true;
      },
      materializeByIndex: (index: number): void => {
        if (index < 0 || index >= count) return;
        setAnchor({ mode: "id", id: getItemKey(index) });
        setMaterializeIndex(index);
      },
      releaseMaterializedTarget: (id?: string): void => {
        setMaterializeIndex((current) => {
          if (id !== undefined && current !== null && getItemKey(current) !== id) return current;
          return null;
        });
      },
      followTail: (): void => {
        setAnchor(BOTTOM_ANCHOR);
        setMaterializeIndex(null);
      },
    }),
    [indexOfId, count, getItemKey],
  );

  useEffect(() => () => clearMeasurementCaches(), [clearMeasurementCaches]);

  // ---- render --------------------------------------------------------------
  const children: ReactNode[] = [];
  let cursor = 0;
  for (const seg of plan.segments) {
    if (seg.start > cursor) {
      children.push(
        <div
          key={`spacer-${cursor}-${seg.start}`}
          aria-hidden="true"
          data-transcript-spacer="true"
          style={{ height: spacerPx(cursor, seg.start), overflowAnchor: "none" }}
        />,
      );
    }
    for (let i = seg.start; i < seg.end; i++) {
      const id = getItemKey(i);
      children.push(
        <div
          key={id}
          ref={rowRef(id)}
          data-transcript-row="true"
          data-index={i}
          // Establish a BFC so MessagePrimitive.Root's `mb-4` cannot collapse
          // outside this measured wrapper. Spacer height then represents the
          // complete row footprint, including the message's bottom margin.
          style={{ display: "flow-root", overflowAnchor: "auto" }}
          onFocusCapture={() => handleRowFocus(id)}
          onBlurCapture={(event) =>
            handleRowBlur(id, event.currentTarget, event.relatedTarget)
          }
        >
          {renderItem(i, id)}
        </div>,
      );
    }
    cursor = seg.end;
  }
  if (count > cursor) {
    children.push(
      <div
        key={`spacer-${cursor}-${count}`}
        aria-hidden="true"
        data-transcript-spacer="true"
        style={{ height: spacerPx(cursor, count), overflowAnchor: "none" }}
      />,
    );
  }

  return (
    <div
      ref={listRef}
      data-testid="transcript-window"
      data-transcript-windowed={plan.windowed ? "true" : "false"}
      data-transcript-mounted={plan.mountedCount}
      data-transcript-total={count}
    >
      {children}
    </div>
  );
}
