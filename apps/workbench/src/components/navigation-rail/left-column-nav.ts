/**
 * D303 — pure view-model for the left-column rail toggles (Artifacts + Rooms).
 *
 * Two destinations vs two panels:
 *   - Home is a NAV action (go to the last-active room) — it has no rail
 *     highlight and lives outside this model.
 *   - Artifacts (Boxes) and Rooms (chat) are the two LEFT-COLUMN panels. They
 *     are mutually exclusive (one browserMode at a time) and operate IN PLACE
 *     on any room route — they never navigate (except from a route where the
 *     left column can't show, where they fall back to going Home first).
 *
 * Each toggle is 3-state so collapsing a panel doesn't throw the highlight onto
 * some other icon (the bug that made the flow feel "off"):
 *   - "inactive"  — not the current panel (or the route can't host the column)
 *   - "open"      — this panel is the current mode and visible (full highlight)
 *   - "collapsed" — this panel is the current mode but hidden (a `›` "click to
 *                   expand" affordance, NOT the full highlight)
 */

export type BrowserColumnMode = "artifacts" | "rooms" | "apps" | "web" | "servers";

export interface LeftColumnState {
  /** The current route can host the left column (i.e. not a full-width route
   *  like /settings, /admin, /skills). */
  panelEligible: boolean;
  browserMode: BrowserColumnMode;
  /** Explicit user collapse of the browser column. */
  browserCollapsed: boolean;
}

export type RailIconState = "inactive" | "open" | "collapsed";

/** Minimum width that keeps server identity, state, and row actions visible. */
export const SERVERS_PANEL_USEFUL_WIDTH_PX = 360;

function iconState(s: LeftColumnState, content: BrowserColumnMode): RailIconState {
  if (!s.panelEligible || s.browserMode !== content) return "inactive";
  return s.browserCollapsed ? "collapsed" : "open";
}

export function artifactsIconState(s: LeftColumnState): RailIconState {
  return iconState(s, "artifacts");
}

export function roomsIconState(s: LeftColumnState): RailIconState {
  return iconState(s, "rooms");
}

export function appsIconState(s: LeftColumnState): RailIconState {
  return iconState(s, "apps");
}

export function webIconState(s: LeftColumnState): RailIconState {
  return iconState(s, "web");
}

export function serversIconState(s: LeftColumnState): RailIconState {
  return iconState(s, "servers");
}

/** What a left-column rail toggle click should do. Undefined fields = unchanged. */
export interface ToggleIntent {
  browserMode?: BrowserColumnMode;
  collapsed?: boolean;
  /** Expand a content-heavy panel to its useful width without shrinking a wider user setting. */
  minimumWidthPx?: number;
  /** Only set when the current route can't host the column (full-width route):
   *  go Home so the panel has somewhere to render. In-room clicks stay in place. */
  navigateHome?: boolean;
}

function toggleIntent(s: LeftColumnState, content: BrowserColumnMode): ToggleIntent {
  // Already open → no-op (hide is the panel's own `‹`, not the rail icon).
  if (iconState(s, content) === "open") return {};
  // Otherwise reveal this panel in place; only navigate Home if the route
  // can't host the left column at all.
  return {
    browserMode: content,
    collapsed: false,
    navigateHome: !s.panelEligible,
  };
}

export function artifactsToggleIntent(s: LeftColumnState): ToggleIntent {
  return toggleIntent(s, "artifacts");
}

export function roomsToggleIntent(s: LeftColumnState): ToggleIntent {
  return toggleIntent(s, "rooms");
}

export function appsToggleIntent(s: LeftColumnState): ToggleIntent {
  return toggleIntent(s, "apps");
}

export function webToggleIntent(s: LeftColumnState): ToggleIntent {
  return toggleIntent(s, "web");
}

export function serversToggleIntent(s: LeftColumnState): ToggleIntent {
  const intent = toggleIntent(s, "servers");
  return Object.keys(intent).length === 0
    ? intent
    : { ...intent, minimumWidthPx: SERVERS_PANEL_USEFUL_WIDTH_PX };
}
