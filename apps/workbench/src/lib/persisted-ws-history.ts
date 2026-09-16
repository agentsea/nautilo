/**
 * Persisted WS history (ISSUE-D145, PR #173 review-fix-3).
 *
 * Single localStorage bit recording whether THIS DEVICE has ever
 * observed a successful WS open. The bit is set the first time
 * `wsState` reaches `"open"` and never cleared. On mount the
 * runtime adapter seeds `lastOpenAt` to `Date.now()` if the bit is
 * set, so a hard reload during a server outage produces
 * `authenticated_disconnected` (not `authenticated_connecting`) and
 * the empty-state copy is the honest "Connection required …"
 * placeholder rather than the generic guest welcome.
 *
 * Why device-level (not viewer-level): on a hard reload during
 * outage, `viewerKey` (`auth.viewer.sessionUserId`) is null until
 * `/api/auth/whoami` returns — which can't happen if the same dead
 * server isn't responding. A viewer-keyed flag therefore can't be
 * read in the exact scenario it would be needed. A device-level
 * bool avoids that chicken-and-egg.
 *
 * Why not persist `lastOpenAt` itself: if we hydrated the literal
 * timestamp from a session that ended hours/days ago,
 * `disconnectedDuration = now - lastOpenAt` would surface absurd
 * values to the prolonged-disconnect-toast escalator. Persisting
 * just the bit and seeding `lastOpenAt = Date.now()` at mount
 * gives the user a fresh "we just realized we're disconnected"
 * timer per reload, which matches their actual experience.
 */

const KEY = "nautilo.ws.has-ever-been-open.v1";
const TRUE_VALUE = "1";

function safeStorage(): Storage | null {
  try {
    return typeof window !== "undefined" ? window.localStorage : null;
  } catch {
    return null;
  }
}

/**
 * Returns true iff this device has ever observed a successful WS
 * open transition (across any session). Tolerates storage failure
 * (private window, blocked, sandboxed) by returning false.
 */
export function readHasEverBeenOpen(): boolean {
  const ls = safeStorage();
  if (!ls) return false;
  try {
    return ls.getItem(KEY) === TRUE_VALUE;
  } catch {
    return false;
  }
}

/**
 * Records that the WS just transitioned to "open". Idempotent
 * (safe to call on every "open" transition). Tolerates storage
 * failure by silently no-op'ing — the cache is best-effort, the
 * canonical state machine still works, the user just doesn't get
 * the connection-required copy on hard reload.
 */
export function markHasEverBeenOpen(): void {
  const ls = safeStorage();
  if (!ls) return;
  try {
    ls.setItem(KEY, TRUE_VALUE);
  } catch {
    /* best-effort; degraded gracefully */
  }
}

/**
 * Composed entry point used by the runtime adapter at mount time.
 *
 * Returns `Date.now()` when the device has ever observed a
 * successful WS open (so derivation produces
 * `authenticated_disconnected` while ws is closed); returns null
 * otherwise (genuine first-paint-never-connected; falls through
 * to standard authenticated_connecting / guest copy).
 *
 * Pure function of `readHasEverBeenOpen()` + `Date.now()` — kept
 * separate so a unit test can pin it without touching React.
 */
export function getInitialLastOpenAt(): number | null {
  return readHasEverBeenOpen() ? Date.now() : null;
}

// --- Test-only helper -------------------------------------------------

/**
 * Test helper. NEVER call from production code. Lives in this
 * module rather than reaching into localStorage directly so test
 * files don't have to know the storage key.
 *
 * @internal
 */
export function __resetHasEverBeenOpenForTests(): void {
  const ls = safeStorage();
  if (!ls) return;
  try {
    ls.removeItem(KEY);
  } catch {
    /* swallow */
  }
}
