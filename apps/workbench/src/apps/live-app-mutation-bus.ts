import type { ToolEndEvent } from "@nautilo/types";

export type LiveAppMutationCommitted = {
  appId: "nautilo-design" | "nautilo-board";
  toolCallId: string;
};

type Listener = (event: LiveAppMutationCommitted) => void;
const listeners = new Set<Listener>();

export function liveAppMutationFromToolEnd(
  event: ToolEndEvent,
): LiveAppMutationCommitted | null {
  if (event.status !== "success") return null;
  const appId = event.toolName === "app_nautilo_design__edit_open_design"
    ? "nautilo-design"
    : event.toolName === "app_nautilo_board__edit_open_board"
      ? "nautilo-board"
      : null;
  if (!appId) return null;
  // This is a reconciliation signal, not authoritative document content.
  // The mounted surface rereads its own bound file and notifies the editor
  // only if canonical state changed; dirty-editor protection remains intact.
  return {
    appId,
    toolCallId: event.toolCallId,
  };
}

export function publishLiveAppMutationCommitted(
  event: LiveAppMutationCommitted,
): void {
  for (const listener of listeners) listener(event);
}

export function subscribeLiveAppMutationCommitted(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function resetLiveAppMutationBusForTest(): void {
  listeners.clear();
}
