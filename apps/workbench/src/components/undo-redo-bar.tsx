/**
 * D087 Phase 3 §3.8 — persistent undo/redo toolbar.
 *
 * Sits above the workspace/files tree header as a small pair of
 * `← Undo` / `Redo →` buttons with keyboard shortcuts `⌘Z` /
 * `⌘⇧Z`. Enables/disables reactively based on the revision-store
 * state for the Agent's most-recently-touched file, fed by the
 * `revisions.state_changed` WS event (§3.10).
 *
 * Scope: "whichever file the Agent last edited" (from
 * `useMostRecentlyTouchedPath`). This matches the user's mental
 * model for ⌘Z — "undo what she just did" — regardless of whether
 * a file is focused in the tree. No file in history → buttons
 * disabled, keybind is a no-op.
 *
 * Dispatch: POST `/api/file/invoke-direct` with `command: "undo" |
 * "redo"` and the target absolute path. That server route is
 * feature-flagged behind `NAUTILO_DIRECT_DISPATCH` identically to
 * the D090 apply-patch-direct flow; when the flag is off the bar
 * still renders but button clicks surface an error hint.
 *
 * Keyboard: `⌘Z` (redo = `⌘⇧Z`) registered on `window.keydown`.
 * The handler explicitly does NOT steal from a focused composer
 * textarea — `document.activeElement` checks for contenteditable
 * or INPUT/TEXTAREA types and bails out so native undo inside the
 * input box continues to work.
 */

import { useCallback, useEffect } from "react";
import { Undo2, Redo2 } from "lucide-react";
import { apiClient } from "../lib/api";
import { readFileContext } from "../adapters/file-context-ref";
import { useMostRecentlyTouchedPath } from "../adapters/runtime-contexts";
import { useRoomNavigation } from "../contexts/room-navigation-context";

const UNDO_REDO_BAR_CLASSES =
  "flex items-center gap-1 border-b border-border px-2 py-1";

export function UndoRedoBar() {
  const { path, view } = useMostRecentlyTouchedPath();
  const roomNav = useRoomNavigation();

  const handleUndo = useCallback(async () => {
    if (!path || !view.canUndo) return;
    const fileContext = readFileContext();
    // PR-018 MINOR #2 — try/catch the direct-dispatch call. Prior
    // shape was `await apiClient.invokeDirect(...)` bare; rejection
    // (503 when NAUTILO_DIRECT_DISPATCH is off, 401 on missing
    // ownerId, network error) would silently propagate up the
    // button's `onClick={() => void handleUndo()}` and vanish.
    // Surface as a console error so the user can inspect devtools;
    // the staged-patch tool-card pipeline is the success path —
    // errors here are operational (flag mismatch, auth lapse, net
    // blip) and need operator visibility, not user-facing polish.
    try {
      await apiClient.invokeDirect({
        command: "undo",
        args: { path, zone: "absolute" },
        ...(roomNav.activeRoomId ? { roomId: roomNav.activeRoomId } : {}),
        workspacePath: fileContext.workspacePath ?? null,
        currentFolder: fileContext.currentFolder ?? null,
      });
      // Response is fire-and-forget — the staged-patch DiffView lands
      // via the normal tool-activity stream; the user accepts through
      // the regular UI. No toast / inline success message needed.
    } catch (err) {
      console.warn(
        "[undo-redo-bar] undo dispatch failed",
        err instanceof Error ? err.message : String(err),
      );
    }
  }, [path, roomNav.activeRoomId, view.canUndo]);

  const handleRedo = useCallback(async () => {
    if (!path || !view.canRedo) return;
    const fileContext = readFileContext();
    // PR-018 MINOR #2 — mirror handleUndo's try/catch discipline.
    try {
      await apiClient.invokeDirect({
        command: "redo",
        args: { path, zone: "absolute" },
        ...(roomNav.activeRoomId ? { roomId: roomNav.activeRoomId } : {}),
        workspacePath: fileContext.workspacePath ?? null,
        currentFolder: fileContext.currentFolder ?? null,
      });
    } catch (err) {
      console.warn(
        "[undo-redo-bar] redo dispatch failed",
        err instanceof Error ? err.message : String(err),
      );
    }
  }, [path, roomNav.activeRoomId, view.canRedo]);

  // ⌘Z / ⌘⇧Z keybinds. Window-scoped; bails out when a
  // contenteditable / textarea / input has focus so the browser's
  // native undo inside those elements keeps working.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      // Modifier check — ⌘ on Mac, Ctrl on other platforms. We
      // accept either so browser devtools in Electron don't have
      // OS-specific behavior divergence.
      const modKey = e.metaKey || e.ctrlKey;
      if (!modKey) return;
      if (e.key.toLowerCase() !== "z") return;

      const active = document.activeElement as HTMLElement | null;
      if (active) {
        if (active.tagName === "INPUT" || active.tagName === "TEXTAREA") return;
        if (active.isContentEditable) return;
      }

      if (e.shiftKey) {
        if (!view.canRedo) return;
        e.preventDefault();
        void handleRedo();
      } else {
        if (!view.canUndo) return;
        e.preventDefault();
        void handleUndo();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [handleUndo, handleRedo, view.canUndo, view.canRedo]);

  // Tooltip text — uses the latest revision's summary so hovering
  // tells the user exactly what would be undone.
  const undoTooltip = view.snapshot?.latest
    ? `Undo: ${view.snapshot.latest.summary}`
    : "Nothing to undo — no edits this session";
  const redoTooltip = view.canRedo
    ? `Redo: restore the most recent post-undo state on ${path}`
    : "Nothing to redo — no prior undo to walk back from";

  return (
    <div className={UNDO_REDO_BAR_CLASSES} data-testid="undo-redo-bar">
      <button
        type="button"
        onClick={() => void handleUndo()}
        disabled={!view.canUndo}
        title={undoTooltip}
        className="flex items-center gap-1 rounded px-2 py-1 text-xs text-foreground-muted hover:bg-[var(--primary-muted)] hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
        data-testid="undo-button"
      >
        <Undo2 className="h-3.5 w-3.5" aria-hidden />
        <span>Undo</span>
      </button>
      <button
        type="button"
        onClick={() => void handleRedo()}
        disabled={!view.canRedo}
        title={redoTooltip}
        className="flex items-center gap-1 rounded px-2 py-1 text-xs text-foreground-muted hover:bg-[var(--primary-muted)] hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
        data-testid="redo-button"
      >
        <Redo2 className="h-3.5 w-3.5" aria-hidden />
        <span>Redo</span>
      </button>
    </div>
  );
}
