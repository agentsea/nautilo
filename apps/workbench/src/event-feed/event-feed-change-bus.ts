type EventFeedChangedListener = () => void;

const listeners = new Set<EventFeedChangedListener>();

export function publishEventFeedChanged(): void {
  for (const listener of listeners) listener();
}

export function subscribeEventFeedChanged(
  listener: EventFeedChangedListener,
): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
