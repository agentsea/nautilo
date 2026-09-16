import { useCallback, useEffect, useState } from "react";

/**
 * D278 §4.7.4 — the group-room Members panel collapse ladder.
 *
 * Three states, stepped in one direction (Option 2):
 *
 *   full  ⟷  rail (~48px)  ⟷  hidden (off-screen edge strip)
 *
 * - `full`   — agent cards (focus + mode).            «  → rail
 * - `rail`   — avatar-only column, tap still focuses.  » → full · ‹ → hidden
 * - `hidden` — gone; the shell's edge strip restores to the LAST non-hidden
 *              state (rail or full), which is the least-surprising rule.
 *
 * Persisted per room so each conversation remembers how the operator left it.
 * The direct Human-Agent soul path keeps the shared `usePanelSizes` collapse
 * flag; this hook governs only rooms that render the Members column.
 */
export type MembersPanelView = "full" | "rail" | "hidden";

interface StoredView {
  /** Current state. */
  readonly view: MembersPanelView;
  /** Last non-hidden state, so the edge strip restores to rail vs full. */
  readonly restoreView: "full" | "rail";
}

export interface MembersPanelViewState {
  readonly view: MembersPanelView;
  /** Step to an explicit state (remembers the prior non-hidden view). */
  readonly setView: (next: MembersPanelView) => void;
  /** hidden → last non-hidden state (rail or full). */
  readonly restore: () => void;
}

const DEFAULT: StoredView = { view: "full", restoreView: "full" };

function keyFor(roomId: string): string {
  return `nautilo:members-view:${roomId}`;
}

function read(roomId: string | null): StoredView {
  if (!roomId) return DEFAULT;
  try {
    const raw = localStorage.getItem(keyFor(roomId));
    if (!raw) return DEFAULT;
    const parsed = JSON.parse(raw) as Partial<StoredView>;
    const view: MembersPanelView =
      parsed.view === "rail" || parsed.view === "hidden" || parsed.view === "full"
        ? parsed.view
        : "full";
    const restoreView: "full" | "rail" =
      parsed.restoreView === "rail" ? "rail" : "full";
    return { view, restoreView };
  } catch {
    return DEFAULT;
  }
}

function write(roomId: string, state: StoredView): void {
  try {
    localStorage.setItem(keyFor(roomId), JSON.stringify(state));
  } catch {
    /* private mode / quota — non-fatal */
  }
}

export function useMembersPanelView(roomId: string | null): MembersPanelViewState {
  const [state, setState] = useState<StoredView>(() => read(roomId));

  // Re-read when the active room changes so each room restores its own state.
  useEffect(() => {
    setState(read(roomId));
  }, [roomId]);

  const setView = useCallback(
    (next: MembersPanelView) => {
      setState((prev) => {
        const restoreView: "full" | "rail" =
          next === "hidden" ? prev.restoreView : next;
        const computed: StoredView = { view: next, restoreView };
        if (roomId) write(roomId, computed);
        return computed;
      });
    },
    [roomId],
  );

  const restore = useCallback(() => {
    setState((prev) => {
      const target = prev.restoreView;
      const computed: StoredView = { view: target, restoreView: target };
      if (roomId) write(roomId, computed);
      return computed;
    });
  }, [roomId]);

  return { view: state.view, setView, restore };
}
