/**
 * Matrix tests for buildGridCols() + friends (D077 Phase 3).
 *
 * Every combination of (rail × browser-visible × browser-collapsed ×
 * context-collapsed × bp) has its expected output locked. If D076
 * adds rooms as a real column or D075 gains per-workspace sizes, the
 * matrix grows and the test is the first place those expectations are
 * asserted. No runtime CSS; pure string assertions.
 */

import { describe, test, expect } from "bun:test";
import {
  buildGridCols,
  buildBrowserDividerLeft,
  buildContextDividerRight,
  DIVIDER_HIT_HALF_PX,
  mainColumnIndex,
  clampBrowserWidth,
  clampContextWidth,
  RAIL_WIDTH_PX,
  BROWSER_MIN_PX,
  BROWSER_DEFAULT_PX,
  BROWSER_MAX_PX,
  CONTEXT_MIN_PX,
  CONTEXT_DEFAULT_PX,
  CONTEXT_MAX_PX,
  FOOTER_HEIGHT_PX,
  SHELL_ROOT_CLASSES,
  SHELL_GRID_CLASSES,
  SHELL_FOOTER_CLASSES,
  type GridColsInput,
} from "../../src/layouts/chrome-shell.layout";

const base: GridColsInput = {
  bp: "desktop",
  railVisible: false,
  browserVisible: false,
  browserCollapsed: false,
  contextCollapsed: false,
};

describe("buildGridCols — mobile / tablet collapses to 1fr", () => {
  test("mobile always 1fr regardless of other inputs", () => {
    expect(buildGridCols({ ...base, bp: "mobile" })).toBe("1fr");
    expect(
      buildGridCols({
        ...base,
        bp: "mobile",
        railVisible: true,
        browserVisible: true,
      }),
    ).toBe("1fr");
  });

  test("tablet always 1fr regardless of other inputs", () => {
    expect(buildGridCols({ ...base, bp: "tablet" })).toBe("1fr");
    expect(
      buildGridCols({
        ...base,
        bp: "tablet",
        railVisible: true,
        contextCollapsed: false,
      }),
    ).toBe("1fr");
  });
});

describe("buildGridCols — desktop matrix", () => {
  test("no rail + no browser → main + context", () => {
    const cols = buildGridCols(base);
    expect(cols).toBe(
      `minmax(0, 1fr) var(--nautilo-context-width-px, ${CONTEXT_DEFAULT_PX}px)`,
    );
  });

  test("no rail + no browser + context collapsed → main only", () => {
    expect(buildGridCols({ ...base, contextCollapsed: true })).toBe("minmax(0, 1fr)");
  });

  test("no rail + browser visible → browser + main + context", () => {
    expect(buildGridCols({ ...base, browserVisible: true })).toBe(
      `var(--nautilo-browser-width-px, ${BROWSER_DEFAULT_PX}px) minmax(0, 1fr) var(--nautilo-context-width-px, ${CONTEXT_DEFAULT_PX}px)`,
    );
  });

  test("no rail + browser collapsed (via ⌘⇧B) → browser column hidden", () => {
    expect(
      buildGridCols({
        ...base,
        browserVisible: true,
        browserCollapsed: true,
      }),
    ).toBe(
      `minmax(0, 1fr) var(--nautilo-context-width-px, ${CONTEXT_DEFAULT_PX}px)`,
    );
  });

  test("rail only → rail + main + context", () => {
    expect(buildGridCols({ ...base, railVisible: true })).toBe(
      `${RAIL_WIDTH_PX}px minmax(0, 1fr) var(--nautilo-context-width-px, ${CONTEXT_DEFAULT_PX}px)`,
    );
  });

  test("rail + browser visible → rail + browser + main + context", () => {
    expect(
      buildGridCols({
        ...base,
        railVisible: true,
        browserVisible: true,
      }),
    ).toBe(
      `${RAIL_WIDTH_PX}px var(--nautilo-browser-width-px, ${BROWSER_DEFAULT_PX}px) minmax(0, 1fr) var(--nautilo-context-width-px, ${CONTEXT_DEFAULT_PX}px)`,
    );
  });

  test("everything collapsed/hidden → rail + main only", () => {
    expect(
      buildGridCols({
        ...base,
        railVisible: true,
        browserVisible: true,
        browserCollapsed: true,
        contextCollapsed: true,
      }),
    ).toBe(`${RAIL_WIDTH_PX}px minmax(0, 1fr)`);
  });

  test("browser visible + both collapses → rail + main", () => {
    expect(
      buildGridCols({
        ...base,
        railVisible: true,
        browserVisible: true,
        browserCollapsed: true,
        contextCollapsed: true,
      }),
    ).toBe(`${RAIL_WIDTH_PX}px minmax(0, 1fr)`);
  });

  test("rail hidden + everything collapsed → shrinkable main only", () => {
    expect(
      buildGridCols({
        ...base,
        browserVisible: true,
        browserCollapsed: true,
        contextCollapsed: true,
      }),
    ).toBe("minmax(0, 1fr)");
  });

  test("open drawer restores a full context track over persisted collapse", () => {
    expect(
      buildGridCols({
        ...base,
        contextCollapsed: true,
        drawerOpen: true,
      }),
    ).toBe(
      `minmax(0, 1fr) var(--nautilo-context-width-px, ${CONTEXT_DEFAULT_PX}px)`,
    );
  });

  test("open drawer overrides the active room's fixed members rail width", () => {
    expect(
      buildGridCols({
        ...base,
        contextCollapsed: true,
        drawerOpen: true,
        contextDefaultPx: 48,
        contextFixedWidth: true,
      }),
    ).toBe(
      `minmax(0, 1fr) var(--nautilo-context-width-px, ${CONTEXT_DEFAULT_PX}px)`,
    );
  });
});

describe("buildGridCols — reader chat sidecar (D110)", () => {
  test("uses minmax tracks when readerChatSidecarLayout is true", () => {
    expect(
      buildGridCols({
        ...base,
        readerChatSidecarLayout: true,
      }),
    ).toBe(
      `minmax(0, 1fr) minmax(0, var(--nautilo-context-width-px, ${CONTEXT_DEFAULT_PX}px))`,
    );
  });

  test("reader + rail + browser → minmax main and context", () => {
    expect(
      buildGridCols({
        ...base,
        railVisible: true,
        browserVisible: true,
        readerChatSidecarLayout: true,
      }),
    ).toBe(
      `${RAIL_WIDTH_PX}px var(--nautilo-browser-width-px, ${BROWSER_DEFAULT_PX}px) minmax(0, 1fr) minmax(0, var(--nautilo-context-width-px, ${CONTEXT_DEFAULT_PX}px))`,
    );
  });
});

describe("mainColumnIndex — tracks leading-column count", () => {
  test("mobile → 1", () => {
    expect(mainColumnIndex({ ...base, bp: "mobile" })).toBe(1);
  });

  test("no rail + no browser → 1", () => {
    expect(mainColumnIndex(base)).toBe(1);
  });

  test("rail only → 2", () => {
    expect(mainColumnIndex({ ...base, railVisible: true })).toBe(2);
  });

  test("browser only → 2", () => {
    expect(mainColumnIndex({ ...base, browserVisible: true })).toBe(2);
  });

  test("rail + browser → 3", () => {
    expect(
      mainColumnIndex({
        ...base,
        railVisible: true,
        browserVisible: true,
      }),
    ).toBe(3);
  });

  test("rail + browser-visible + browser-collapsed → 2 (collapsed column is gone)", () => {
    expect(
      mainColumnIndex({
        ...base,
        railVisible: true,
        browserVisible: true,
        browserCollapsed: true,
      }),
    ).toBe(2);
  });

  test("context collapse does NOT change main column index (trailing, not leading)", () => {
    const withCtx = mainColumnIndex({
      ...base,
      railVisible: true,
      browserVisible: true,
      contextCollapsed: false,
    });
    const withoutCtx = mainColumnIndex({
      ...base,
      railVisible: true,
      browserVisible: true,
      contextCollapsed: true,
    });
    expect(withCtx).toBe(withoutCtx);
  });
});

describe("clamp functions", () => {
  test("clampBrowserWidth bounds to [MIN, MAX]", () => {
    expect(clampBrowserWidth(50)).toBe(BROWSER_MIN_PX);
    expect(clampBrowserWidth(BROWSER_DEFAULT_PX)).toBe(BROWSER_DEFAULT_PX);
    expect(clampBrowserWidth(9999)).toBe(BROWSER_MAX_PX);
    // Exactly MIN / MAX pass through unchanged.
    expect(clampBrowserWidth(BROWSER_MIN_PX)).toBe(BROWSER_MIN_PX);
    expect(clampBrowserWidth(BROWSER_MAX_PX)).toBe(BROWSER_MAX_PX);
  });

  test("clampContextWidth bounds to [MIN, MAX]", () => {
    expect(clampContextWidth(50)).toBe(CONTEXT_MIN_PX);
    expect(clampContextWidth(CONTEXT_DEFAULT_PX)).toBe(CONTEXT_DEFAULT_PX);
    expect(clampContextWidth(9999)).toBe(CONTEXT_MAX_PX);
    expect(clampContextWidth(CONTEXT_MIN_PX)).toBe(CONTEXT_MIN_PX);
    expect(clampContextWidth(CONTEXT_MAX_PX)).toBe(CONTEXT_MAX_PX);
  });

  test("clamp passes NaN through — caller must pre-validate", () => {
    // Math.min/max propagate NaN, so Clamp(NaN) returns NaN. This is
    // intentional: the divider's drag handler seeds originWidth from a
    // resolved number and only ever adds finite deltas, so NaN can't
    // reach here through valid paths. If a future caller DOES hit this,
    // they'll see NaN, which blows up the CSS var write loudly — much
    // better than silently clamping to MAX and hiding the bug.
    expect(Number.isNaN(clampBrowserWidth(Number.NaN))).toBe(true);
    expect(Number.isNaN(clampContextWidth(Number.NaN))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Scroll-boundary regression — D083 Phase 2a + 2026-04-24 follow-up.
//
// Original D083 2a symptom: focusing the right-hand context panel and
// scrolling caused the WHOLE page to scroll (chrome pushed off-screen)
// because the shell root + grid container had `overflow: visible`,
// letting a wheel event bubble up to <html>/<body> and scroll the
// document.
//
// Second symptom (2026-04-24 D090 live-verify): clicking Accept on a
// DiffView that had been brought into view via `scrollIntoView()` —
// which the MCP harness does when expanding a tool card — would nudge
// the GRID container's `scrollTop` to ~198px. That left the entire
// chrome (including the composer) shifted up in the viewport with
// blank background showing below. Root cause: `overflow-hidden`
// clips RENDERING but still creates a scroll container at the CSS
// engine level; `scrollIntoView()` on any descendant will silently
// set `scrollTop` on the nearest scroll container — `overflow-hidden`
// ancestors included. The chrome-scroll test below passed anyway
// because it checked the class, not the behavior.
//
// Combined fix: `overflow-clip` on both SHELL_ROOT_CLASSES AND
// SHELL_GRID_CLASSES. `overflow-clip` clips rendering AND marks the
// element as non-scrollable — `scrollTop` writes are ignored, so
// neither wheel-bubble (D083 2a) nor descendant `scrollIntoView()`
// (2026-04-24) can relocate the shell. Inner containers that
// legitimately scroll (chat viewport, context aside) still own their
// own `overflow-y-auto` and scroll internally.
//
// These tests lock the scroll-boundary contract with two assertion
// layers: the class is overflow-clip (not overflow-hidden), AND
// specifically rejects `overflow-hidden` as well so a future
// "re-tightening" doesn't silently regress us back to the 2026-04-24
// failure mode.
// ---------------------------------------------------------------------------

describe("shell scroll-boundary classes (D083 Phase 2a + 2026-04-24 regression)", () => {
  test("SHELL_ROOT_CLASSES pins the shell to the viewport with overflow-clip", () => {
    expect(SHELL_ROOT_CLASSES).toContain("h-dvh");
    expect(SHELL_ROOT_CLASSES).toContain("overflow-clip");
    // Must NOT be any of the weaker / incorrect variants:
    //   - `overflow-hidden` allows scrollIntoView to nudge scrollTop
    //     (2026-04-24 regression) and must be excluded.
    //   - `overflow-auto` / `overflow-scroll` / `overflow-visible` are
    //     the original D083 2a failure modes.
    expect(SHELL_ROOT_CLASSES).not.toContain("overflow-hidden");
    expect(SHELL_ROOT_CLASSES).not.toContain("overflow-auto");
    expect(SHELL_ROOT_CLASSES).not.toContain("overflow-scroll");
    expect(SHELL_ROOT_CLASSES).not.toContain("overflow-visible");
  });

  test("SHELL_ROOT_CLASSES is a flex column (banner collapses via flex, not grid)", () => {
    expect(SHELL_ROOT_CLASSES).toContain("flex");
    expect(SHELL_ROOT_CLASSES).toContain("flex-col");
  });

  test("SHELL_GRID_CLASSES is a grid with min-h-0 + flex-1 + overflow-clip", () => {
    expect(SHELL_GRID_CLASSES).toContain("grid");
    expect(SHELL_GRID_CLASSES).toContain("min-h-0");
    expect(SHELL_GRID_CLASSES).toContain("flex-1");
    expect(SHELL_GRID_CLASSES).toContain("overflow-clip");
    // Same stricter exclusion as SHELL_ROOT_CLASSES. `overflow-hidden`
    // is explicitly rejected because the 2026-04-24 live-repro ran
    // through the grid container, NOT the root — so this class is
    // load-bearing for the fix on its own merits.
    expect(SHELL_GRID_CLASSES).not.toContain("overflow-hidden");
    expect(SHELL_GRID_CLASSES).not.toContain("overflow-auto");
    expect(SHELL_GRID_CLASSES).not.toContain("overflow-visible");
  });

  test("SHELL_GRID_CLASSES is position:relative (dividers anchor against it)", () => {
    expect(SHELL_GRID_CLASSES).toContain("relative");
  });

  test("SHELL_FOOTER_CLASSES pins a slim non-collapsible status row", () => {
    expect(FOOTER_HEIGHT_PX).toBe(32);
    expect(SHELL_FOOTER_CLASSES).toContain(`h-[${FOOTER_HEIGHT_PX}px]`);
    expect(SHELL_FOOTER_CLASSES).toContain("shrink-0");
    expect(SHELL_FOOTER_CLASSES).toContain("justify-start");
    expect(SHELL_FOOTER_CLASSES).toContain("border-t");
    expect(SHELL_FOOTER_CLASSES).toContain("bg-background-panel");
    expect(SHELL_FOOTER_CLASSES).not.toContain("overflow-hidden");
    expect(SHELL_FOOTER_CLASSES).not.toContain("overflow-auto");
    expect(SHELL_FOOTER_CLASSES).not.toContain("overflow-scroll");
  });
});

// ---------------------------------------------------------------------------
// Divider positional math regression — 2026-04-22 live-verify catch.
//
// Symptom: with the nav rail visible, the LEFT (browser) drag handle
// rendered ~48px left of the actual browser column right-edge, floating
// in empty space over the main column. Root cause: workbench-shell.tsx
// wasn't threading RAIL_WIDTH_PX into <PanelDivider kind="browser" />
// as the `railOffsetPx` prop, so the divider's `left:` calc assumed
// the browser column started at window edge 0 when it actually started
// at 48px.
//
// These tests lock the expected positional CSS so any regression in
// either the shell wiring OR the positional helpers fails here first.
// ---------------------------------------------------------------------------

describe("divider positional math (D077 / 2026-04-22 live-verify)", () => {
  test("browser divider left includes the rail offset when the rail is visible", () => {
    const left = buildBrowserDividerLeft(RAIL_WIDTH_PX);
    expect(left).toContain(`${RAIL_WIDTH_PX}px`);
    expect(left).toContain("var(--nautilo-browser-width-px");
    expect(left).toContain(`${DIVIDER_HIT_HALF_PX}px`);
  });

  test("browser divider left equals 'calc(0px + browser - 3px)' when rail is hidden", () => {
    expect(buildBrowserDividerLeft(0)).toBe(
      `calc(0px + var(--nautilo-browser-width-px, ${BROWSER_DEFAULT_PX}px) - ${DIVIDER_HIT_HALF_PX}px)`,
    );
  });

  test("browser divider left equals 'calc(48px + browser - 3px)' when rail is visible", () => {
    expect(buildBrowserDividerLeft(RAIL_WIDTH_PX)).toBe(
      `calc(${RAIL_WIDTH_PX}px + var(--nautilo-browser-width-px, ${BROWSER_DEFAULT_PX}px) - ${DIVIDER_HIT_HALF_PX}px)`,
    );
  });

  test("context divider right is rail-independent (anchored from right edge)", () => {
    const right = buildContextDividerRight();
    expect(right).toBe(
      `calc(var(--nautilo-context-width-px, ${CONTEXT_DEFAULT_PX}px) - ${DIVIDER_HIT_HALF_PX}px)`,
    );
    // Critical: RAIL_WIDTH_PX must NOT appear — the context column sits
    // on the opposite side of the rail.
    expect(right).not.toContain(`${RAIL_WIDTH_PX}px`);
  });

  test("DIVIDER_HIT_HALF_PX is 3 (6px total hit strip — wide enough to grab, narrow enough not to be ugly)", () => {
    expect(DIVIDER_HIT_HALF_PX).toBe(3);
  });
});
