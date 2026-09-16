// D398 — tiny auth-dead pub/sub. Lets the plain (non-React) api-client token
// provider signal "refresh is dead" so the AuthProvider can sign out and the
// central gate can redirect to login. No app imports here → safe from cycles.

type AuthDeadListener = (serverId: string) => void;

const listeners = new Set<AuthDeadListener>();

/** Subscribe to auth-dead events. Returns an unsubscribe fn. */
export function onAuthDead(listener: AuthDeadListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Raise "auth is dead for this server" — the stored session can no longer be
 * refreshed. Fired by the api-client token provider when `ensureValidToken`
 * returns null (refresh token expired/absent → tokens cleared).
 */
export function emitAuthDead(serverId: string): void {
  for (const listener of listeners) listener(serverId);
}
