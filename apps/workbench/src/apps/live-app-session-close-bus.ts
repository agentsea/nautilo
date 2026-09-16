export type LiveAppSessionClosedReason = "relay_disconnected" | "session_closed";

export type LiveAppSessionClosedEvent = {
  sessionId: string;
  reason: LiveAppSessionClosedReason;
};

type Listener = (event: LiveAppSessionClosedEvent) => void;
const listeners = new Set<Listener>();

export function publishLiveAppSessionClosed(event: LiveAppSessionClosedEvent): void {
  for (const listener of listeners) listener(event);
}

export function subscribeLiveAppSessionClosed(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
