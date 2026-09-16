/**
 * Workbench shell grid-template-columns builder (D077 Phase 3).
 *
 * Pure helper that returns the CSS grid-template-columns string for the
 * workbench shell given the current layout inputs. Lives here (not
 * inline in workbench-shell.tsx) because:
 *
 *   - The combinatorics across rail × browser × browser-collapsed ×
 *     context-collapsed × mobile are annoying. A pure helper gets
 *     unit-tested once; callers stop playing class-string Tetris on
 *     every chrome change.
 *
 *   - D076 (rail) and D077 (resize/collapse) + any future chrome
 *     addition all need to call this same function. One source of truth
 *     means adding a column in the future is a diff of this file plus
 *     a diff of its test, not a grep-and-replace across shell code.
 *
 *   - CSS variables carry the live drag-resize values so the React
 *     state doesn't re-render during drag. This file is the contract
 *     between the divider component (which writes the vars) and the
 *     shell (which reads via grid-template-columns).
 *
 * CSS vars this helper reads (all on documentElement, set by
 * PanelDivider during drag and by usePanelSizes on commit):
 *
 *   --nautilo-browser-width-px    (default DEFAULT_BROWSER_WIDTH)
 *   --nautilo-context-width-px    (default DEFAULT_CONTEXT_WIDTH)
 *
 * Rail width is fixed (icon-only column), so no CSS var for it.
 */

import type { Breakpoint } from "../hooks/use-breakpoint";

// ---------------------------------------------------------------------------
// Constants — width thresholds per panel
// ---------------------------------------------------------------------------

/** Narrow rail — matches VSCode 48 / Zed 44 region. Icon-only; not resizable. */
export const RAIL_WIDTH_PX = 48;

/** Browser column (left) — code-project-sized. */
export const BROWSER_MIN_PX = 200;
export const BROWSER_DEFAULT_PX = 240;
export const BROWSER_MAX_PX = 480;
/** Drag below this on release → snap to collapsed. */
export const BROWSER_COLLAPSE_SNAP_PX = 140;

/**
 * D278 §4.7.4 — fixed width of the group-room Members panel's compact "rail"
 * state (avatar-only column). Matches the nav rail's 48px so the two narrow
 * columns read as siblings. Not resizable; the rail is a discrete ladder
 * step, not a drag target.
 */
export const MEMBERS_RAIL_WIDTH_PX = 48;

/** Context panel (right) — avatar + soul card breathing room. */
export const CONTEXT_MIN_PX = 240;
export const CONTEXT_DEFAULT_PX = 280;
export const CONTEXT_MAX_PX = 480;
export const CONTEXT_COLLAPSE_SNAP_PX = 180;

/**
 * Workbench footer height (D096).
 *
 * Slim, editor-style status bar. Non-collapsible by design: connection
 * state and (D097) security posture are operational state that should
 * stay visible while users hide/show the larger panels.
 */
export const FOOTER_HEIGHT_PX = 32;

// ---------------------------------------------------------------------------
// Inputs / output
// ---------------------------------------------------------------------------

export interface GridColsInput {
  bp: Breakpoint;
  /** Nav rail visible (D076). `false` hides the 48px column entirely. */
  railVisible: boolean;
  /**
   * Browser column mounted at all. Post-D079 Phase 1 the column is
   * always mounted at the desktop breakpoint so the current-folder
   * picker is reachable even when no folder is open.
   */
  browserVisible: boolean;
  /** Browser column user-toggled collapsed (⌘⇧B). */
  browserCollapsed: boolean;
  /** Context panel user-toggled collapsed (⌘⇧I). */
  contextCollapsed: boolean;
  /**
   * A drawer currently owns the trailing column. Drawers are transient
   * surfaces, so they override (but never mutate) the persisted context-panel
   * collapse preference and any fixed-width members-rail geometry.
   */
  drawerOpen?: boolean;
  /** Optional fallback width for the trailing column when no CSS var is set. */
  contextDefaultPx?: number;
  /** Use a fixed trailing width instead of the persisted context-panel CSS var. */
  contextFixedWidth?: boolean;
  /**
   * D110 — document reading mode: the right column is a narrow chat rail. Use
   * `minmax(0, …)` on the main and context tracks so the grid never overflows the
   * viewport. Omit in normal mode so center + Agent panel keep classic sizing.
   */
  readerChatSidecarLayout?: boolean;
}

/**
 * Build the `grid-template-columns` value for the workbench shell.
 *
 * Returns a raw CSS value (NOT a Tailwind class name) because the
 * widths are dynamic CSS variables, not compile-time constants.
 * Callers apply it via `style={{ gridTemplateColumns: buildGridCols(...) }}`.
 *
 * Semantics:
 *
 *   - Mobile / tablet → single column, everything else hidden; matches
 *     the existing `grid-cols-[1fr]` pattern.
 *   - Desktop → rail? + browser? + main (1fr) + context?, where each optional
 *     column is gated on its visible+!collapsed flags.
 *   - The main track is always `minmax(0, 1fr)` so fixed leading columns
 *     cannot push it past the viewport; reader-sidecar layout applies the
 *     same zero minimum to its context track.
 *   - Live widths come from CSS variables (`--nautilo-browser-width-px`
 *     and `--nautilo-context-width-px`) with defaults via var()
 *     fallback — so the shell paints correctly on first mount before
 *     usePanelSizes has run.
 */
export function buildGridCols(input: GridColsInput): string {
  if (input.bp !== "desktop") {
    return "1fr";
  }

  const parts: string[] = [];
  const reader = Boolean(input.readerChatSidecarLayout);

  if (input.railVisible) {
    parts.push(`${RAIL_WIDTH_PX}px`);
  }

  if (input.browserVisible && !input.browserCollapsed) {
    parts.push(`var(--nautilo-browser-width-px, ${BROWSER_DEFAULT_PX}px)`);
  }

  parts.push("minmax(0, 1fr)");

  if (input.drawerOpen || !input.contextCollapsed) {
    // A drawer must always be reachable at normal panel width. In particular,
    // do not inherit a collapsed track or the active room's 48px members rail.
    const contextDefault =
      input.drawerOpen ? CONTEXT_DEFAULT_PX : input.contextDefaultPx ?? CONTEXT_DEFAULT_PX;
    const contextFixedWidth = input.drawerOpen ? false : input.contextFixedWidth;
    if (reader) {
      parts.push(
        contextFixedWidth ?
          `minmax(0, ${contextDefault}px)`
        : `minmax(0, var(--nautilo-context-width-px, ${contextDefault}px))`,
      );
    } else {
      parts.push(
        contextFixedWidth ?
          `${contextDefault}px`
        : `var(--nautilo-context-width-px, ${contextDefault}px)`,
      );
    }
  }

  return parts.join(" ");
}

/**
 * Which logical column index holds the flexible "main" slot given the same
 * inputs that built the grid-cols string. Used by callers that need to
 * place children into a specific grid column (e.g. the main element)
 * without double-counting optional leading columns.
 *
 * Kept colocated with buildGridCols() so any change in column order
 * touches both functions together; the unit test matrix covers both
 * outputs for each input combination.
 */
export function mainColumnIndex(input: GridColsInput): number {
  if (input.bp !== "desktop") {
    return 1; // single-column grid, main is the only cell
  }
  let col = 1;
  if (input.railVisible) col += 1;
  if (input.browserVisible && !input.browserCollapsed) col += 1;
  return col;
}

/**
 * Clamp a proposed width to the panel's valid range. Drag handlers use
 * this to bound live updates; callers checking "should we snap to
 * collapse?" should compare the *proposed* (unclamped) value against
 * the collapse snap threshold BEFORE calling clamp.
 */
export function clampBrowserWidth(proposed: number): number {
  return Math.max(BROWSER_MIN_PX, Math.min(BROWSER_MAX_PX, proposed));
}

export function clampContextWidth(proposed: number): number {
  return Math.max(CONTEXT_MIN_PX, Math.min(CONTEXT_MAX_PX, proposed));
}

// ---------------------------------------------------------------------------
// Divider positional math — pure strings, unit-tested alongside buildGridCols
// ---------------------------------------------------------------------------

/**
 * Half-width of the divider hit strip in pixels. Offsets the absolutely-
 * positioned strip so its visible 1px seam aligns with the grid column
 * boundary while preserving a 6px drag target.
 */
export const DIVIDER_HIT_HALF_PX = 3;

/**
 * Build the `left:` CSS value for the BROWSER divider's absolute position.
 *
 * The browser divider anchors from the left edge of the shell, so its
 * offset must include any leading columns — specifically the rail when
 * visible. Without the rail offset, the divider floats in empty space
 * over the main column (regression caught 2026-04-22 live-verify).
 *
 * The context divider uses `right:` and doesn't need a rail offset,
 * which is why this helper is browser-only.
 */
export function buildBrowserDividerLeft(railOffsetPx: number): string {
  return `calc(${railOffsetPx}px + var(--nautilo-browser-width-px, ${BROWSER_DEFAULT_PX}px) - ${DIVIDER_HIT_HALF_PX}px)`;
}

/**
 * Build the `right:` CSS value for the CONTEXT divider's absolute
 * position. The context column sits at the right edge; no rail offset
 * needed (the rail is on the opposite side).
 */
export function buildContextDividerRight(): string {
  return `calc(var(--nautilo-context-width-px, ${CONTEXT_DEFAULT_PX}px) - ${DIVIDER_HIT_HALF_PX}px)`;
}

// ---------------------------------------------------------------------------
// Shell scroll-boundary classes (load-bearing — keep in sync with regression
// test in `tests/unit/chrome-shell.layout.test.ts`).
// ---------------------------------------------------------------------------

/**
 * ClassName for the outermost shell `<div>` (flex-column, `h-dvh`,
 * `overflow-clip`).
 *
 * `overflow-clip` — NOT `overflow-hidden` — is the document-scroll
 * guard. Without it, a wheel event originating in the right-hand
 * context panel (which has its own internal scroll but typically
 * nothing to scroll) bubbles up through the flex + grid ancestors
 * and ends up scrolling `<html>`/`<body>`, pushing the whole chrome
 * off-screen. The shell IS the viewport; nothing above it ever
 * scrolls.
 *
 * Why `overflow-clip` and not `overflow-hidden`: `overflow-hidden`
 * clips rendering BUT still creates a scroll container — meaning
 * `scrollIntoView()` on any descendant, or a keyboard-focus-induced
 * auto-scroll from the browser, can silently set `scrollTop` on
 * this element and shift the entire chrome vertically off-screen
 * (Electron live-repro 2026-04-24: clicking Accept on a DiffView
 * that had been scrolled-into-view bumped `scrollTop` by 198px,
 * leaving the composer floating mid-viewport with dead space
 * below). `overflow-clip` clips rendering AND marks the element
 * as non-scrollable at the CSS engine level — `scrollTop` writes
 * are ignored. This is exactly what we want.
 *
 * Extracted as a named constant so the regression test can assert
 * the `overflow-clip` class is present without string-matching
 * the JSX.
 */
export const SHELL_ROOT_CLASSES =
  "flex h-dvh w-full flex-col overflow-clip bg-background text-foreground";

/**
 * ClassName for the grid container that holds the rail / browser /
 * main / context cells. `overflow-clip` here — same reasoning as
 * SHELL_ROOT_CLASSES — stops grid cells from bleeding vertically
 * AND prevents any descendant's `scrollIntoView()` / focus-scroll
 * from nudging the grid's own scrollTop. Each cell that needs to
 * scroll (the chat viewport inside `<main>`, the context `<aside>`)
 * owns its own `overflow-y-auto`.
 */
export const SHELL_GRID_CLASSES =
  "relative grid min-h-0 w-full flex-1 overflow-clip";

/**
 * ClassName for the workbench footer auto-row (D096).
 *
 * Mounted below SHELL_GRID_CLASSES as a sibling row in the flex-column
 * shell. `shrink-0` keeps the 1fr grid from squeezing it; `border-t`
 * separates chrome from content without inventing a new theme token.
 */
export const SHELL_FOOTER_CLASSES =
  `flex h-[${FOOTER_HEIGHT_PX}px] shrink-0 items-center justify-start ` +
  "gap-2 border-t border-border bg-background-panel px-4 text-xs text-foreground-muted";
