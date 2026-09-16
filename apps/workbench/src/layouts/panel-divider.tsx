/**
 * Draggable panel divider (D077 Phase 2).
 *
 * Sits at the boundary between two grid columns as an absolutely-
 * positioned 6px vertical hit strip. Pointer drag updates a CSS var
 * on documentElement; the grid-template-columns expression (via
 * buildGridCols) reads that var, so layout reflows without React
 * re-rendering the tree. On pointerup we commit the final width back
 * into usePanelSizes (which persists + re-syncs the var authoritatively).
 *
 * Snap-to-collapse: if the pointer is released below the panel's
 * COLLAPSE_SNAP threshold, setCollapsed(true) fires instead of a width
 * commit. The current width is stashed first so the next restore
 * returns to it rather than the default.
 *
 * Render contract: parent grid container has `position: relative` so
 * `left` / `right` on this absolute child resolves against it. Shell
 * wires that via a single className.
 */

import {
  useCallback,
  useEffect,
  useRef,
  type PointerEvent as ReactPointerEvent,
} from "react";
import {
  BROWSER_COLLAPSE_SNAP_PX,
  CONTEXT_COLLAPSE_SNAP_PX,
  DIVIDER_HIT_HALF_PX,
  buildBrowserDividerLeft,
  buildContextDividerRight,
  clampBrowserWidth,
  clampContextWidth,
} from "./chrome-shell.layout";
import type { PanelKind, UsePanelSizes } from "./use-panel-sizes";

interface Props {
  kind: PanelKind;
  /** Full panel-sizes API; the divider calls back through here. */
  sizes: UsePanelSizes;
  /** When set, the divider lines up against this rail offset on the
   *  left (for the browser divider only). Shell passes 48 when the
   *  rail is visible, 0 otherwise. */
  railOffsetPx?: number;
}

export function PanelDivider({ kind, sizes, railOffsetPx = 0 }: Props) {
  // Drag state — refs, not React state, so pointermove updates stay
  // off the render path.
  const draggingRef = useRef(false);
  const originXRef = useRef(0);
  const originWidthRef = useRef(0);
  // Track the live width during drag so pointerup can make the
  // collapse-vs-commit decision against the final value.
  const liveWidthRef = useRef(0);

  const onPointerDown = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      // Only react to primary button (ignore right-click, middle-click,
      // pen erasers, etc.).
      if (e.button !== 0) return;

      draggingRef.current = true;
      originXRef.current = e.clientX;
      originWidthRef.current =
        kind === "browser" ? sizes.browserWidth : sizes.contextWidth;
      liveWidthRef.current = originWidthRef.current;

      // Pointer capture keeps the drag alive even if the cursor briefly
      // leaves this element (typical when dragging fast).
      e.currentTarget.setPointerCapture(e.pointerId);

      // Lock the cursor to col-resize body-wide so the drag doesn't
      // flicker when crossing child elements with their own cursor
      // styles. Cleared on pointerup.
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";
    },
    [kind, sizes.browserWidth, sizes.contextWidth],
  );

  const onPointerMove = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      if (!draggingRef.current) return;

      const dx = e.clientX - originXRef.current;
      let proposed: number;
      if (kind === "browser") {
        // Dragging RIGHT grows the browser column.
        proposed = clampBrowserWidth(originWidthRef.current + dx);
      } else {
        // Context sits on the right: dragging RIGHT shrinks it.
        proposed = clampContextWidth(originWidthRef.current - dx);
      }

      liveWidthRef.current = proposed;

      // Write to the CSS var directly — no React re-render. grid-
      // template-columns reads `var(--nautilo-{kind}-width-px, default)`
      // so the shell reflows immediately.
      if (typeof document !== "undefined") {
        document.documentElement.style.setProperty(
          kind === "browser"
            ? "--nautilo-browser-width-px"
            : "--nautilo-context-width-px",
          `${proposed}px`,
        );
      }
    },
    [kind],
  );

  const finishDrag = useCallback(() => {
    if (!draggingRef.current) return;
    draggingRef.current = false;

    document.body.style.cursor = "";
    document.body.style.userSelect = "";

    // Compare against the original proposed (unclamped wrt snap) value
    // rather than the clamped live value. Use originXRef + final dx?
    // Simpler: compare the live (clamped) value against the snap
    // threshold. This means a user can't force a collapse by dragging
    // WAY past the min — they have to land in [SNAP, MIN] territory.
    // That's fine; MIN and SNAP are chosen so the band is wide enough
    // to hit comfortably.
    const finalWidth = liveWidthRef.current;
    const snap =
      kind === "browser" ? BROWSER_COLLAPSE_SNAP_PX : CONTEXT_COLLAPSE_SNAP_PX;

    if (finalWidth <= snap) {
      // Collapse instead of committing the narrow width. usePanelSizes
      // stashes the pre-collapse width for restore, so the next toggle
      // returns users to what they had — we just need to make sure
      // that stash is the width BEFORE this drag started, not the
      // tiny dragged width.
      sizes.setWidth(kind, originWidthRef.current);
      sizes.setCollapsed(kind, true);
    } else {
      sizes.setWidth(kind, finalWidth);
    }
  }, [kind, sizes]);

  const onPointerUp = useCallback(
    (_e: ReactPointerEvent<HTMLDivElement>) => {
      finishDrag();
    },
    [finishDrag],
  );

  const onPointerCancel = useCallback(
    (_e: ReactPointerEvent<HTMLDivElement>) => {
      finishDrag();
    },
    [finishDrag],
  );

  // Safety: if the component unmounts mid-drag, clean up the body
  // cursor lock so the whole app doesn't stay in col-resize mode.
  useEffect(() => {
    return () => {
      if (draggingRef.current) {
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
      }
    };
  }, []);

  // Positioning — pure helpers live in chrome-shell.layout.ts so the
  // math is unit-testable without mounting React.
  //   Browser divider → right edge of browser column; left offset must
  //     include the rail width when the rail is visible, otherwise the
  //     hit strip floats in space over the main column.
  //   Context divider → left edge of context column; anchored from the
  //     right, unaffected by the rail.
  const positional =
    kind === "browser"
      ? { left: buildBrowserDividerLeft(railOffsetPx) }
      : { right: buildContextDividerRight() };

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={
        kind === "browser" ? "Resize file browser" : "Resize context panel"
      }
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerCancel}
      className="absolute top-0 bottom-0 z-20 cursor-col-resize hover:bg-primary/20 active:bg-primary/30 transition-colors"
      style={{
        width: `${DIVIDER_HIT_HALF_PX * 2}px`,
        ...positional,
      }}
    />
  );
}
