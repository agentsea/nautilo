/**
 * Persisted viewer cache (ISSUE-D145, Stack 19 Phase 1 — viewer-collapse fix).
 *
 * Single localStorage record holding the MOST RECENTLY observed `AuthViewer`
 * for this device. Used by `useViewerAuth` so a hard reload during a server
 * outage hydrates the real viewer (and `viewer.isVerified === true` for an
 * authenticated human) instead of immediately rendering as `GUEST_VIEWER`
 * for the seconds-to-minutes it takes the dead server's `/api/auth/whoami`
 * to either succeed or definitively fail.
 *
 * Why this exists (Stack 14 / PR #173 retro)
 * ------------------------------------------
 * Stack 14 shipped the disconnect-cache + RuntimeShellState seam correctly
 * but left `useViewerAuth`'s catch-branch at `setViewer(GUEST_VIEWER)` for
 * any `whoami()` rejection. Dozens of consumers gate on
 * `viewer.isVerified` (workbench-shell, conversation, browser-column tabs,
 * room-navigation, profile, settings/security). When the server is dead,
 * whoami rejects, viewer flips to GUEST_VIEWER, and the entire app
 * re-renders as guest UX even though `RuntimeShellState` correctly reports
 * `authenticated_disconnected`. Two parallel state machines that disagree.
 *
 * Phase 1 fixes the catch-branch to "keep last-known viewer on transient
 * failure"; this module is the persistence layer that makes the same
 * recovery work across hard reloads (the catch-branch only protects an
 * already-running session; reload destroys React state).
 *
 * Why device-level (single record), not viewer-keyed
 * --------------------------------------------------
 * Same chicken-and-egg as `persisted-ws-history.ts`: pre-whoami there is
 * no `sessionUserId` to key on, and the exact scenario this cache must
 * help (hard reload during outage) is one where whoami can't run. A
 * single device-level slot avoids that. Multi-user-on-same-device is
 * handled by `clearLastKnownViewer()` on `signOut()`; the brief window
 * between a completed signOut and the next sign-in's whoami is the only
 * opportunity for cross-user leakage, and `signOut()` already wipes the
 * record. Acceptable for v1.
 *
 * Why not persist a TTL or "stale" timestamp
 * ------------------------------------------
 * The cached viewer is consumed only when whoami fails to refute it.
 * If whoami succeeds (server reachable, role unchanged), it overwrites
 * the cache atomically — stale data evaporates within the next 10s
 * polling tick of `useViewerAuth`. If whoami succeeds with a different
 * role (server says you're now a different user), it overwrites the
 * cache with the new role. The only window where stale data could
 * persist is "user identity changed AND server is unreachable" — for
 * which there is no honest answer; we render the last-known identity
 * because that's strictly less wrong than rendering as GUEST.
 */

import { isCapabilitySlug, type CapabilitySlug, type ViewerRole } from "@nautilo/types";

// M129 — bumped v1 → v2 to carry `capabilities`. A v1 record (no caps)
// fails the version check in `readLastKnownViewer` and is treated as a
// cache miss → GUEST until the next successful whoami repopulates it.
const KEY = "nautilo.viewer.last-known.v2";

/**
 * Schema-versioned envelope. Bump `v` if the AuthViewer shape evolves;
 * `read` returns null on version mismatch (treating it as a cache miss
 * is safer than guessing an old shape).
 */
interface StoredViewer {
  v: 2;
  role: ViewerRole;
  label: string;
  userIdentity: string | null;
  sessionUserId: string | null;
  isVerified: boolean;
  /** M129 — viewer's own Capability union; advisory UI-gating only. */
  capabilities: CapabilitySlug[];
  /** M214 — optional human display name for stale-cache hydration. */
  displayName?: string | null;
  /** M214 — optional human handle for stale-cache hydration. */
  handle?: string | null;
  cachedAt: number;
}

/** Caller-facing shape: same fields the runtime uses, minus `cachedAt` + `v`. */
export interface CachedViewer {
  role: ViewerRole;
  label: string;
  userIdentity: string | null;
  sessionUserId: string | null;
  isVerified: boolean;
  /** M129 — viewer's own Capability union; advisory UI-gating only. */
  capabilities: CapabilitySlug[];
  /** M214 — optional human display name for stale-cache hydration. */
  displayName?: string | null;
  /** M214 — optional human handle for stale-cache hydration. */
  handle?: string | null;
}

function safeStorage(): Storage | null {
  try {
    return typeof window !== "undefined" ? window.localStorage : null;
  } catch {
    return null;
  }
}

function isViewerRole(value: unknown): value is ViewerRole {
  return (
    value === "owner" ||
    value === "admin" ||
    value === "superuser" ||
    value === "member" ||
    value === "contributor" ||
    value === "community" ||
    value === "guest" ||
    value === "anonymous" ||
    value === "stranger"
  );
}

/**
 * Returns the most recently cached viewer for this device, or null if
 * none was ever stored / the stored record fails validation. Tolerates
 * storage failure (private window, blocked, sandboxed) by returning
 * null. Pure read; never mutates storage.
 */
export function readLastKnownViewer(): CachedViewer | null {
  const ls = safeStorage();
  if (!ls) return null;
  let raw: string | null;
  try {
    raw = ls.getItem(KEY);
  } catch {
    return null;
  }
  if (raw === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const candidate = parsed as Partial<StoredViewer>;
  if (candidate.v !== 2) return null;
  if (!isViewerRole(candidate.role)) return null;
  if (typeof candidate.label !== "string") return null;
  if (typeof candidate.isVerified !== "boolean") return null;
  // userIdentity + sessionUserId allowed null OR string
  const userIdentity =
    candidate.userIdentity === null || typeof candidate.userIdentity === "string"
      ? candidate.userIdentity
      : null;
  const sessionUserId =
    candidate.sessionUserId === null || typeof candidate.sessionUserId === "string"
      ? candidate.sessionUserId
      : null;
  // M129 — tolerate a missing/garbled capabilities field (default []),
  // and filter to known slugs so a stale cache can never grant an
  // unknown privilege (AR-6).
  const capabilities = Array.isArray(candidate.capabilities)
    ? candidate.capabilities.filter(
        (c): c is CapabilitySlug => typeof c === "string" && isCapabilitySlug(c),
      )
    : [];
  return {
    role: candidate.role,
    label: candidate.label,
    userIdentity,
    sessionUserId,
    isVerified: candidate.isVerified,
    capabilities,
    displayName:
      candidate.displayName === null || typeof candidate.displayName === "string"
        ? candidate.displayName
        : undefined,
    handle:
      candidate.handle === null || typeof candidate.handle === "string"
        ? candidate.handle
        : undefined,
  };
}

/**
 * Records the viewer fields after a successful whoami. Idempotent
 * (safe to call on every successful whoami; overwrites prior). Tolerates
 * storage failure by silently no-op'ing — the cache is best-effort, the
 * runtime still has the live viewer in React state.
 */
export function writeLastKnownViewer(viewer: CachedViewer): void {
  const ls = safeStorage();
  if (!ls) return;
  const payload: StoredViewer = {
    v: 2,
    role: viewer.role,
    label: viewer.label,
    userIdentity: viewer.userIdentity,
    sessionUserId: viewer.sessionUserId,
    isVerified: viewer.isVerified,
    capabilities: viewer.capabilities,
    ...(viewer.displayName !== undefined ? { displayName: viewer.displayName } : {}),
    ...(viewer.handle !== undefined ? { handle: viewer.handle } : {}),
    cachedAt: Date.now(),
  };
  try {
    ls.setItem(KEY, JSON.stringify(payload));
  } catch {
    /* best-effort; degraded gracefully */
  }
}

/**
 * Clears the cached viewer. Called on `signOut()` so a subsequent
 * sign-in (or anonymous reload) does not see the prior identity.
 * Tolerates storage failure by silently no-op'ing.
 */
export function clearLastKnownViewer(): void {
  const ls = safeStorage();
  if (!ls) return;
  try {
    ls.removeItem(KEY);
  } catch {
    /* swallow */
  }
}

// --- Test-only helper -------------------------------------------------

/**
 * Test helper. NEVER call from production code. Lives in this module
 * rather than reaching into localStorage directly so test files don't
 * have to know the storage key.
 *
 * @internal
 */
export function __resetForTests(): void {
  clearLastKnownViewer();
}
