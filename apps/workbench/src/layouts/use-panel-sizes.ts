/**
 * Persistent workbench panel sizes + collapse state (D077 Phase 1+2).
 *
 * Single localStorage key carrying every layout-related flag users can
 * control. Typed, version-guarded, synchronous on mount (so the shell
 * paints at the saved size — no default-width flash).
 *
 * State lifecycle:
 *
 *   1. Initial mount — read localStorage synchronously; apply via CSS
 *      var writes so grid-template-columns resolves correctly on the
 *      very first paint.
 *   2. Drag — PanelDivider writes CSS var per-pointermove; no React
 *      re-render until pointerup.
 *   3. Commit — pointerup writes the final width back here, which
 *      persists to localStorage and keeps React state in sync.
 *   4. Toggle — collapse buttons / keyboard shortcuts / native menu
 *      flip a flag through setCollapsed(kind, next).
 *
 * Global per-user (matches VSCode behavior). A future multi-window
 * Electron setup can diverge by keying differently; today one window,
 * one key.
 */

import { useEffect, useState, useCallback, useRef } from "react";
import {
  BROWSER_DEFAULT_PX,
  CONTEXT_DEFAULT_PX,
  clampBrowserWidth,
  clampContextWidth,
} from "./chrome-shell.layout";

const STORAGE_KEY = "nautilo:workbench:panel-sizes";
/** Bump when the shape changes in a backwards-incompatible way. */
const SCHEMA_VERSION = 1;

interface StoredState {
  v: number;
  browserWidth: number;
  contextWidth: number;
  browserCollapsed: boolean;
  contextCollapsed: boolean;
  /** Pre-collapse width so restore returns to what the user had, not default. */
  browserWidthBeforeCollapse: number;
  /** Same for context. */
  contextWidthBeforeCollapse: number;
  /**
   * D076 Chunk 4 — navigation rail collapse flag. Rail itself has a
   * fixed width (48px, no drag-resize) so there's no matching
   * `railWidth` — just a bool. Defaults to `false` (rail visible).
   * Added without bumping SCHEMA_VERSION since `readStoredState`
   * reads it as optional and defaults to `false` on missing; users
   * who set browser/context sizes before Chunk 4 don't lose them on
   * upgrade.
   */
  railCollapsed: boolean;
}

const DEFAULT_STATE: StoredState = {
  v: SCHEMA_VERSION,
  browserWidth: BROWSER_DEFAULT_PX,
  contextWidth: CONTEXT_DEFAULT_PX,
  browserCollapsed: false,
  contextCollapsed: false,
  browserWidthBeforeCollapse: BROWSER_DEFAULT_PX,
  contextWidthBeforeCollapse: CONTEXT_DEFAULT_PX,
  railCollapsed: false,
};

// ---------------------------------------------------------------------------
// Storage I/O (synchronous to keep first-paint clean)
// ---------------------------------------------------------------------------

function readStoredState(): StoredState {
  try {
    if (typeof window === "undefined" || !window.localStorage) {
      return DEFAULT_STATE;
    }
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_STATE;

    const parsed = JSON.parse(raw) as Partial<StoredState>;
    if (parsed.v !== SCHEMA_VERSION) {
      // Schema mismatch → discard, let user re-establish. Non-fatal.
      return DEFAULT_STATE;
    }

    // Re-clamp on read so a hand-edited localStorage can't wedge the
    // UI at a pathological width. Clamps also absorb changes to
    // MIN/MAX constants over time.
    const browserWidth = clampBrowserWidth(
      typeof parsed.browserWidth === "number"
        ? parsed.browserWidth
        : BROWSER_DEFAULT_PX,
    );
    const contextWidth = clampContextWidth(
      typeof parsed.contextWidth === "number"
        ? parsed.contextWidth
        : CONTEXT_DEFAULT_PX,
    );

    return {
      v: SCHEMA_VERSION,
      browserWidth,
      contextWidth,
      browserCollapsed: parsed.browserCollapsed === true,
      contextCollapsed: parsed.contextCollapsed === true,
      browserWidthBeforeCollapse: clampBrowserWidth(
        typeof parsed.browserWidthBeforeCollapse === "number"
          ? parsed.browserWidthBeforeCollapse
          : browserWidth,
      ),
      contextWidthBeforeCollapse: clampContextWidth(
        typeof parsed.contextWidthBeforeCollapse === "number"
          ? parsed.contextWidthBeforeCollapse
          : contextWidth,
      ),
      // D076 Chunk 4 — optional field. Missing in pre-Chunk-4
      // localStorage entries; defaults to `false` (rail visible).
      railCollapsed: parsed.railCollapsed === true,
    };
  } catch {
    return DEFAULT_STATE;
  }
}

function writeStoredState(state: StoredState): void {
  try {
    if (typeof window === "undefined" || !window.localStorage) return;
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // Non-fatal. Quota / private-mode / etc.
  }
}

/** Mirror state to documentElement CSS vars so buildGridCols() and any
 *  divider can read the live values. Called on mount and on commit.
 *  Drag updates happen in the divider directly (bypasses React) — that
 *  path uses the same vars, so everything stays consistent. */
function syncCssVars(state: StoredState): void {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  root.style.setProperty(
    "--nautilo-browser-width-px",
    `${state.browserWidth}px`,
  );
  root.style.setProperty(
    "--nautilo-context-width-px",
    `${state.contextWidth}px`,
  );
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Kinds that have a width + stash state. The rail is a sibling toggle
 * but has no width concept (fixed 48px), so it uses `RailCollapseKind`
 * below.
 */
export type PanelKind = "browser" | "context";

/**
 * D076 Chunk 4 — superset of PanelKind for collapse-only controls.
 * The rail collapses but can't be resized, so it flows through
 * setCollapsed / toggleCollapsed only. setWidth rejects it at the
 * type level.
 */
export type CollapsibleKind = PanelKind | "rail";

export interface UsePanelSizes {
  browserWidth: number;
  contextWidth: number;
  browserCollapsed: boolean;
  contextCollapsed: boolean;
  /** D076 Chunk 4 — nav rail collapsed (⌘⇧0). Fixed 48px, no width state. */
  railCollapsed: boolean;

  /**
   * Commit a new width for a panel (typically called on pointerup by
   * PanelDivider). Persists + re-mirrors CSS vars. Does NOT update
   * `collapsed`; use setCollapsed() for that.
   */
  setWidth: (kind: PanelKind, next: number) => void;

  /**
   * Toggle / set collapse for a panel. When collapsing, stashes the
   * current width into `beforeCollapse` so restore returns to it.
   * When expanding, restores from the stash. Rail has no width so
   * its setCollapsed is a simple flag flip.
   */
  setCollapsed: (kind: CollapsibleKind, next: boolean) => void;

  /** Convenience — flip the collapse. */
  toggleCollapsed: (kind: CollapsibleKind) => void;

  /** Reset everything to factory defaults. */
  resetAll: () => void;
}

export function usePanelSizes(): UsePanelSizes {
  // Read synchronously on first render so no default-width flash.
  const [state, setState] = useState<StoredState>(() => {
    const initial = readStoredState();
    // Mirror to CSS vars during the same synchronous render pass —
    // belt-and-suspenders alongside the effect below. Safe because
    // syncCssVars no-ops when document is undefined (SSR).
    syncCssVars(initial);
    return initial;
  });

  // On every state change, persist + re-mirror. The initial render
  // above already mirrored, so this effect just covers updates.
  const didMount = useRef(false);
  useEffect(() => {
    if (!didMount.current) {
      didMount.current = true;
      // Skip persistence on the very first render — the state we're
      // seeing IS what we just read from storage; writing it back would
      // needlessly touch quota + fire storage events in other tabs.
      return;
    }
    writeStoredState(state);
    syncCssVars(state);
  }, [state]);

  const setWidth = useCallback((kind: PanelKind, next: number) => {
    setState((prev) => {
      if (kind === "browser") {
        const clamped = clampBrowserWidth(next);
        if (clamped === prev.browserWidth) return prev;
        return { ...prev, browserWidth: clamped };
      }
      const clamped = clampContextWidth(next);
      if (clamped === prev.contextWidth) return prev;
      return { ...prev, contextWidth: clamped };
    });
  }, []);

  const setCollapsed = useCallback((kind: CollapsibleKind, next: boolean) => {
    setState((prev) => {
      if (kind === "browser") {
        if (prev.browserCollapsed === next) return prev;
        if (next) {
          // Collapsing — stash current width so restore returns to it.
          return {
            ...prev,
            browserCollapsed: true,
            browserWidthBeforeCollapse: prev.browserWidth,
          };
        }
        // Expanding — restore from stash.
        return {
          ...prev,
          browserCollapsed: false,
          browserWidth: prev.browserWidthBeforeCollapse,
        };
      }
      if (kind === "context") {
        if (prev.contextCollapsed === next) return prev;
        if (next) {
          return {
            ...prev,
            contextCollapsed: true,
            contextWidthBeforeCollapse: prev.contextWidth,
          };
        }
        return {
          ...prev,
          contextCollapsed: false,
          contextWidth: prev.contextWidthBeforeCollapse,
        };
      }
      // kind === "rail" — no width to stash, just flip the flag.
      if (prev.railCollapsed === next) return prev;
      return { ...prev, railCollapsed: next };
    });
  }, []);

  const toggleCollapsed = useCallback(
    (kind: CollapsibleKind) => {
      const current =
        kind === "browser"
          ? state.browserCollapsed
          : kind === "context"
            ? state.contextCollapsed
            : state.railCollapsed;
      setCollapsed(kind, !current);
    },
    [setCollapsed, state.browserCollapsed, state.contextCollapsed, state.railCollapsed],
  );

  const resetAll = useCallback(() => {
    setState(DEFAULT_STATE);
  }, []);

  return {
    browserWidth: state.browserWidth,
    contextWidth: state.contextWidth,
    browserCollapsed: state.browserCollapsed,
    contextCollapsed: state.contextCollapsed,
    railCollapsed: state.railCollapsed,
    setWidth,
    setCollapsed,
    toggleCollapsed,
    resetAll,
  };
}
