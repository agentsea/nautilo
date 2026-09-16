import { useCallback, useEffect, useRef, type RefObject } from "react";
import { TYPING_PING_INTERVAL_MS } from "@nautilo/types";
import { requestTypingPing } from "./typing-bus";

/**
 * Emits the established room-scoped typing ping only for genuine native edits
 * inside a Nautilo composer. Keeping this at the DOM `input` seam means
 * assistant-ui's programmatic `setText` operations (draft restore, emoji
 * insertion, send/reset) stay silent.
 */
export function useComposerTypingPing({
  rootRef,
  roomId,
  displayName,
}: {
  readonly rootRef: RefObject<HTMLElement | null>;
  readonly roomId: string | null;
  readonly displayName: string | null | undefined;
}): void {
  // A room mismatch is immediately eligible, so the first edit after a room
  // switch cannot be suppressed by a recent ping from the prior room.
  const lastPingRef = useRef<{ roomId: string | null; lastPingAt: number }>({
    roomId: null,
    lastPingAt: 0,
  });
  // The listener remains installed across room/identity changes. Read the
  // current values from a render-synchronised ref so a native input cannot
  // race a passive effect rebind and emit for the prior room.
  const contextRef = useRef({ roomId, displayName });
  contextRef.current = { roomId, displayName };

  const emit = useCallback(() => {
    const current = contextRef.current;
    if (!current.roomId || !current.displayName) return;
    const now = Date.now();
    const last = lastPingRef.current;
    if (
      last.roomId !== current.roomId ||
      now - last.lastPingAt >= TYPING_PING_INTERVAL_MS
    ) {
      lastPingRef.current = { roomId: current.roomId, lastPingAt: now };
      requestTypingPing({ roomId: current.roomId, displayName: current.displayName });
    }
  }, []);

  useEffect(() => {
    const onInput = (event: Event): void => {
      const root = rootRef.current;
      if (!root) return;
      const target = event.target;
      if (!(target instanceof Element)) return;
      const composerInput = target.closest<HTMLElement>("[data-nautilo-composer-input]");
      const contentEditable = target.closest<HTMLElement>("[contenteditable='true']");
      if (
        !composerInput ||
        !contentEditable ||
        !root.contains(composerInput) ||
        !composerInput.contains(contentEditable)
      ) {
        return;
      }
      emit();
    };

    // Lexical stops this event before it reaches the form in bubble phase.
    // Capture at document level, then fail closed against this composer root:
    // Assistant UI may attach the underlying form after this effect's first
    // pass, whereas the ref is guaranteed current by the time a user can edit.
    document.addEventListener("input", onInput, true);
    return () => document.removeEventListener("input", onInput, true);
  }, [emit, rootRef]);
}
