/**
 * Stack 19 Phase 5.5 hotfix (2026-05-16) — WS visibility gate.
 *
 * Extracted from `nautilo-runtime.tsx` so the debounce + Electron-skip
 * semantics can be unit-tested independent of the runtime component.
 *
 * Why this is a separate module:
 *
 * Phase 5 originally wired `document.visibilityState` directly to
 * `client.suspend()` / `client.resume()`. Live smoke (s19fresh,
 * 2026-05-16 16:11-16:16Z server log) captured 5 WS reconnects in
 * 5 minutes during normal Electron dev workflow. Root cause: on
 * Electron-on-macOS, `document.visibilityState` flips to `"hidden"`
 * every time the renderer loses focus (clicking the terminal,
 * switching Spaces, Spotlight, Cmd-Tab) — NOT just when the window
 * is truly backgrounded. The original code interpreted every blur
 * as a "suspend the WS" signal.
 *
 * Fix shape:
 *
 *   - Electron desktop: `shouldHandleVisibility(true) === false`. The
 *     OS suspends the process on true backgrounding; we do not need a
 *     userland suspend, and `visibilityState` is too lossy to drive
 *     it from. Phase 5's bandwidth/cycle savings target browser tabs
 *     left open in the background, not the dedicated desktop window.
 *
 *   - Browser: 30s debounce on hidden→suspend. A short tab-switch no
 *     longer churns the WS; a true background tab still gets
 *     suspended after the debounce expires. Resume is immediate (no
 *     debounce) so a returning user is never delayed.
 *
 * Test contract (see `ws-visibility-gate.test.ts`):
 *
 *   1. Electron: `shouldHandleVisibility(isDesktop=true)` returns
 *      false unconditionally. No handler attached, no suspend ever.
 *   2. Browser hidden < 30s: suspend NOT called.
 *   3. Browser hidden ≥ 30s continuously: suspend called exactly once.
 *   4. Browser hidden then visible within 30s: suspend NOT called,
 *      resume NOT called (cancelled before fire).
 *   5. Browser hidden ≥ 30s then visible: suspend then resume,
 *      both called exactly once.
 *   6. Multiple flap cycles within 30s: no extra calls; debounce
 *      is reset on each `visible` (or new `hidden`).
 */

export const VISIBILITY_HIDDEN_DEBOUNCE_MS = 30_000;

/**
 * Should the runtime install a `visibilitychange` listener for the
 * purpose of suspending the WS? Returns `false` on Electron desktop
 * (where `document.visibilityState` is too lossy to drive the
 * suspend; see module header). Returns `true` in the browser path.
 */
export function shouldHandleVisibility(isElectronDesktop: boolean): boolean {
  return !isElectronDesktop;
}

export interface VisibilityGateDeps {
  readonly suspend: () => void;
  readonly resume: () => void;
  readonly onSuspendedChange?: (suspended: boolean) => void;
  /** Test seam — default `setTimeout` / `clearTimeout`. */
  readonly setTimer?: (cb: () => void, ms: number) => ReturnType<typeof setTimeout>;
  readonly clearTimer?: (handle: ReturnType<typeof setTimeout>) => void;
  /** Test seam — default `() => document.visibilityState`. */
  readonly readVisibility?: () => "hidden" | "visible";
  /** Test seam — override the 30s constant for unit tests. */
  readonly debounceMs?: number;
}

export interface VisibilityGate {
  /**
   * Call this from the runtime's `visibilitychange` listener. The
   * gate handles debouncing, cancel-on-rebrowse, and emits
   * suspend/resume to the realtime client.
   */
  onVisibilityChange(): void;
  /**
   * Snapshot of the current scheduled state — useful for tests.
   * `"idle"` = not hidden, no pending suspend.
   * `"pending-suspend"` = hidden and debounce timer armed.
   * `"suspended"` = debounce fired; client is in `suspend()` state.
   */
  state(): "idle" | "pending-suspend" | "suspended";
  /** Cancel any pending timer + drop refs. Idempotent. */
  dispose(): void;
}

/**
 * Build a visibility gate with the debounced suspend / immediate
 * resume semantics described in the module header.
 *
 * Pure factory — no globals, no React, no side effects until
 * `onVisibilityChange` fires.
 */
export function createVisibilityGate(deps: VisibilityGateDeps): VisibilityGate {
  const setTimer = deps.setTimer ?? ((cb, ms) => setTimeout(cb, ms));
  const clearTimer = deps.clearTimer ?? ((h) => clearTimeout(h));
  const readVisibility = deps.readVisibility ?? (() => document.visibilityState as "hidden" | "visible");
  const debounceMs = deps.debounceMs ?? VISIBILITY_HIDDEN_DEBOUNCE_MS;

  let timer: ReturnType<typeof setTimeout> | null = null;
  let suspended = false;

  const clearPending = (): void => {
    if (timer !== null) {
      clearTimer(timer);
      timer = null;
    }
  };

  const setSuspended = (next: boolean): void => {
    if (suspended === next) return;
    suspended = next;
    deps.onSuspendedChange?.(next);
  };

  return {
    onVisibilityChange(): void {
      const vis = readVisibility();
      if (vis === "hidden") {
        if (suspended) return;
        if (timer !== null) return;
        timer = setTimer(() => {
          timer = null;
          if (readVisibility() !== "hidden") return;
          deps.suspend();
          setSuspended(true);
        }, debounceMs);
        return;
      }
      clearPending();
      if (suspended) {
        deps.resume();
        setSuspended(false);
      }
    },
    state(): "idle" | "pending-suspend" | "suspended" {
      if (suspended) return "suspended";
      if (timer !== null) return "pending-suspend";
      return "idle";
    },
    dispose(): void {
      clearPending();
      suspended = false;
    },
  };
}
