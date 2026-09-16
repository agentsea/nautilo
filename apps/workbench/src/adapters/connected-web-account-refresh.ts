/**
 * Tiny in-memory refresh signal shared by the global login journey and the
 * Connections card projection. It carries no account data and is deliberately
 * not persisted: the server remains the only account-state authority.
 */
const listeners = new Set<() => void>();

export function publishConnectedWebAccountRefresh(): void {
  for (const listener of listeners) listener();
}

export function subscribeConnectedWebAccountRefresh(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
