/**
 * D145 / Stack 19 — Viewer-resilience invariant for `useViewerAuth`.
 *
 * Regression test for the bug Stack 14 (PR #173) shipped half-fixed:
 * `useViewerAuth`'s catch branch flipped `viewer` to `GUEST_VIEWER` on
 * any `whoami()` rejection (network error, 5xx, transient blip).
 * Dozens of consumers gate UI on `viewer.isVerified`; collapsing it to
 * GUEST during a server hiccup re-rendered the whole app as guest UX
 * even though `RuntimeShellState` correctly reported
 * `authenticated_disconnected`.
 *
 * The fix in `use-auth.ts` extracts the catch-branch derivation into the
 * pure helper `computeViewerOnWhoamiFailure(prev)` which preserves the
 * last-known viewer fields and only flips `staleWhoami: true`. This test
 * pins the invariant at the helper boundary so a future refactor can't
 * silently regress to the Stack 14 shape.
 *
 * Vacuous-test guard
 * ------------------
 * The load-bearing assertion is `expect(result.role).toBe("owner")` (or
 * the role of the prior viewer). It FAILS if the impl is replaced with
 * `() => GUEST_VIEWER` (the Stack 14 / pre-fix no-op) — which is exactly
 * what would have caught the original bug. The `staleWhoami: true`
 * assertion is included as a contract pin but would pass vacuously in
 * isolation (a no-op flip-staleWhoami impl that ignored `prev.role`
 * would still tick that box).
 */
import { describe, expect, test } from "bun:test";
import { computeBrowserAuthState } from "../../src/hooks/use-auth-browser-state";
import {
  computeViewerOnNullToken,
  computeViewerOnWhoamiFailure,
  type AuthViewer,
} from "../../src/hooks/use-auth";
import { deriveViewerLabel } from "../../src/hooks/viewer-label";
import type { CachedViewer } from "../../src/lib/persisted-viewer-cache";

const ownerViewer: AuthViewer = {
  role: "owner",
  label: "Operator",
  userIdentity: "operator@example.com",
  sessionUserId: "550e8400-e29b-41d4-a716-446655440000",
  isVerified: true,
  capabilities: ["manage_server_security"],
  staleWhoami: false,
};

const householdViewer: AuthViewer = {
  role: "household",
  label: "Jeannie",
  userIdentity: "jeannie@example.com",
  sessionUserId: "550e8400-e29b-41d4-a716-446655440001",
  isVerified: true,
  capabilities: [],
  staleWhoami: false,
};

const guestViewer: AuthViewer = {
  role: "guest",
  label: "Guest",
  userIdentity: null,
  sessionUserId: null,
  isVerified: false,
  capabilities: [],
  staleWhoami: false,
};

describe("deriveViewerLabel (M129 — name, not group label)", () => {
  test("prefers displayName", () => {
    expect(deriveViewerLabel({ displayName: "Test004", handle: "t004" }, "member")).toBe("Test004");
  });

  test("falls back to handle when no displayName", () => {
    expect(deriveViewerLabel({ displayName: null, handle: "t004" }, "member")).toBe("t004");
  });

  test("falls back to humanized role, then Guest", () => {
    expect(deriveViewerLabel({ displayName: null, handle: null }, "member")).toBe("member");
    expect(deriveViewerLabel({}, "guest")).toBe("Guest");
  });

  test("REGRESSION: never returns a Group label — the input has no groups field", () => {
    // The two-"Members"-pills bug came from label = group label. This
    // helper structurally cannot see groups, so the identity label can
    // only ever be name/handle/role.
    const label = deriveViewerLabel({ displayName: "Real Name", handle: "rn" }, "member");
    expect(label).toBe("Real Name");
    expect(label).not.toBe("Members");
  });
});

describe("computeBrowserAuthState (Logto loading pulses)", () => {
  test("REGRESSION: loading pulse after signed-in preserves signed-in state", () => {
    expect(
      computeBrowserAuthState({
        previous: "signed-in",
        isLoading: true,
        isAuthenticated: true,
      }),
    ).toBe("signed-in");
  });

  test("initial loading remains unknown before the SDK resolves", () => {
    expect(
      computeBrowserAuthState({
        previous: "unknown",
        isLoading: true,
        isAuthenticated: false,
      }),
    ).toBe("unknown");
  });

  test("non-loading authenticated state resolves signed-in", () => {
    expect(
      computeBrowserAuthState({
        previous: "unknown",
        isLoading: false,
        isAuthenticated: true,
      }),
    ).toBe("signed-in");
  });

  test("signing-in guard preserves in-flight state until authentication resolves", () => {
    expect(
      computeBrowserAuthState({
        previous: "signing-in",
        isLoading: false,
        isAuthenticated: false,
      }),
    ).toBe("signing-in");
  });
});

describe("computeViewerOnWhoamiFailure (D145 viewer-collapse fix)", () => {
  test("owner viewer + whoami fails → role/label/sessionUserId preserved (LOAD-BEARING; fails under Stack 14 pre-fix shape)", () => {
    const result = computeViewerOnWhoamiFailure(ownerViewer);

    // LOAD-BEARING: these assertions FAIL if the impl is replaced with
    // `() => GUEST_VIEWER` (the Stack 14 catch-branch no-op). Order
    // matters — these are the assertions that catch the original bug.
    expect(result.role).toBe("owner");
    expect(result.label).toBe("Operator");
    expect(result.userIdentity).toBe("operator@example.com");
    expect(result.sessionUserId).toBe("550e8400-e29b-41d4-a716-446655440000");
    expect(result.isVerified).toBe(true);
    // M129 — capabilities preserved through stale so gated UI stays
    // stable during a transient outage (AR-6).
    expect(result.capabilities).toEqual(["manage_server_security"]);

    // Contract pin: the staleWhoami flag flips to true so consumers
    // that want to surface "view may be stale" can opt in. Would pass
    // vacuously alone — kept for explicit contract assertion.
    expect(result.staleWhoami).toBe(true);
  });

  test("household viewer + whoami fails → identity preserved, staleWhoami flipped", () => {
    const result = computeViewerOnWhoamiFailure(householdViewer);
    expect(result.role).toBe("household");
    expect(result.label).toBe("Jeannie");
    expect(result.sessionUserId).toBe("550e8400-e29b-41d4-a716-446655440001");
    expect(result.isVerified).toBe(true);
    expect(result.staleWhoami).toBe(true);
  });

  test("already-stale viewer + another whoami failure → returns referential-equal prev (idempotent; React setState bail-out suppresses re-render)", () => {
    const alreadyStale: AuthViewer = { ...ownerViewer, staleWhoami: true };
    const result = computeViewerOnWhoamiFailure(alreadyStale);
    // Same reference — drives React useState's bail-out optimization.
    expect(result).toBe(alreadyStale);
  });

  test("guest viewer + whoami fails → degenerate but documented; staleWhoami flips, fields preserved", () => {
    // This case is unlikely in production (a guest has no bearer to
    // call whoami with), but exercising it pins the helper's purity:
    // it doesn't escalate the role, just flips the flag.
    const result = computeViewerOnWhoamiFailure(guestViewer);
    expect(result.role).toBe("guest");
    expect(result.isVerified).toBe(false);
    expect(result.staleWhoami).toBe(true);
  });

  test("does NOT mutate the input viewer (pure)", () => {
    const before = { ...ownerViewer };
    computeViewerOnWhoamiFailure(ownerViewer);
    expect(ownerViewer.role).toBe(before.role);
    expect(ownerViewer.label).toBe(before.label);
    expect(ownerViewer.staleWhoami).toBe(before.staleWhoami); // still false
  });

  test("the no-op replacement THIS test would have caught", () => {
    // Documentation assertion. If a future refactor replaces the helper
    // body with `return GUEST_VIEWER` (the Stack 14 shape), the load-
    // bearing test above fails first. This test exists to make the
    // failure mode obvious to whoever's reading the diff.
    //
    // GIVEN the pre-fix shape:    function computeViewerOnWhoamiFailure(_) { return GUEST_VIEWER; }
    //   THEN result.role would be "guest", failing the first test.
    //
    // GIVEN the half-fixed shape: function computeViewerOnWhoamiFailure(prev) { return { ...GUEST_VIEWER, staleWhoami: true }; }
    //   THEN result.role still "guest", failing the first test.
    //
    // Only `{ ...prev, staleWhoami: true }` (or referentially-equal
    // when already stale) passes both the load-bearing role check
    // AND the staleWhoami contract pin. ✓
    expect(true).toBe(true);
  });
});

/**
 * Stack 19 Phase 6.9.5 regression suite — the parallel `getAccessToken()
 * === null` branch of `useViewerAuth.checkViewer`.
 *
 * Pre-fix this branch unconditionally returned GUEST_VIEWER, which
 * contradicted the omnibus's "no guest screen for signed-in outage"
 * goal whenever the Logto SDK failed to refresh on cold boot (the
 * SDK returns null in that case, indistinguishable from explicit
 * signOut at the call site). Reviewer-cited Stack 19 Phase 6.9.5 HIGH
 * blocker on PR #188.
 *
 * Fix: discriminate via the persisted viewer cache:
 *   - cached present → preserve identity with staleWhoami=true
 *   - cached null → fall through to GUEST_VIEWER
 *
 * The signOut() implementations call clearLastKnownViewer() BEFORE
 * Logto.signOut(), so the explicit-signOut path reliably sees an
 * empty cache when this branch fires.
 */
describe("computeViewerOnNullToken (D145 / Stack 19 Phase 6.9.5 — getAccessToken=null branch)", () => {
  const cachedOwner: CachedViewer = {
    role: "owner",
    label: "Operator",
    userIdentity: "operator@example.com",
    sessionUserId: "550e8400-e29b-41d4-a716-446655440000",
    isVerified: true,
    capabilities: ["manage_server_security", "manage_members"],
  };

  const cachedHousehold: CachedViewer = {
    role: "household",
    label: "Jeannie",
    userIdentity: "jeannie@example.com",
    sessionUserId: "550e8400-e29b-41d4-a716-446655440001",
    isVerified: true,
    capabilities: [],
  };

  test("REGRESSION: cached owner + null token → preserves identity with staleWhoami=true (LOAD-BEARING; fails under pre-fix shape that returned GUEST_VIEWER unconditionally)", () => {
    const result = computeViewerOnNullToken(cachedOwner);
    // LOAD-BEARING — these FAIL if impl is replaced with `() => GUEST_VIEWER`
    // (the pre-fix shape). Order matters: role + isVerified are the
    // properties consumers gate UI on; if these flip to guest, the
    // workbench collapses to guest UX during a survivable outage.
    expect(result.role).toBe("owner");
    expect(result.label).toBe("Operator");
    expect(result.userIdentity).toBe("operator@example.com");
    expect(result.sessionUserId).toBe("550e8400-e29b-41d4-a716-446655440000");
    expect(result.isVerified).toBe(true);
    // M129 — capabilities carried from cache through the null-token path
    // so a hard reload during an outage keeps gated UI stable (AR-6).
    expect(result.capabilities).toEqual(["manage_server_security", "manage_members"]);
    // Contract pin — would pass vacuously alone but flags the
    // staleWhoami semantic for consumers that want to surface
    // "your view may be stale".
    expect(result.staleWhoami).toBe(true);
  });

  test("REGRESSION: cached household + null token → preserves identity with staleWhoami=true", () => {
    const result = computeViewerOnNullToken(cachedHousehold);
    expect(result.role).toBe("household");
    expect(result.label).toBe("Jeannie");
    expect(result.sessionUserId).toBe("550e8400-e29b-41d4-a716-446655440001");
    expect(result.isVerified).toBe(true);
    expect(result.staleWhoami).toBe(true);
  });

  test("explicit signOut path: cached=null + null token → GUEST_VIEWER (cache was cleared by signOut() before this branch fires)", () => {
    const result = computeViewerOnNullToken(null);
    // The two session-hook signOut() implementations call
    // clearLastKnownViewer() BEFORE Logto.signOut(), so by the time
    // this branch fires for an explicit signOut, cached is null and
    // we correctly collapse to GUEST_VIEWER.
    expect(result.role).toBe("guest");
    expect(result.label).toBe("Guest");
    expect(result.userIdentity).toBeNull();
    expect(result.sessionUserId).toBeNull();
    expect(result.isVerified).toBe(false);
    expect(result.staleWhoami).toBe(false);
  });

  test("does NOT mutate the input cached viewer (pure)", () => {
    const before = { ...cachedOwner };
    computeViewerOnNullToken(cachedOwner);
    expect(cachedOwner.role).toBe(before.role);
    expect(cachedOwner.label).toBe(before.label);
    expect(cachedOwner.userIdentity).toBe(before.userIdentity);
    expect(cachedOwner.sessionUserId).toBe(before.sessionUserId);
    expect(cachedOwner.isVerified).toBe(before.isVerified);
  });

  test("the no-op replacement THIS test would have caught", () => {
    // Documentation assertion. If a future refactor replaces this with
    // `() => GUEST_VIEWER` (the pre-fix shape that the reviewer
    // flagged), the LOAD-BEARING test above fails on `result.role`.
    //
    // GIVEN the pre-fix shape: function computeViewerOnNullToken(_) { return GUEST_VIEWER; }
    //   THEN result.role would be "guest" even when cached.role is
    //   "owner", which is exactly the bug the reviewer caught.
    //
    // Only the cache-discriminator shape passes:
    //   - cached !== null → preserve cached.role + staleWhoami=true
    //   - cached === null → GUEST_VIEWER (collapse correctly)
    expect(true).toBe(true);
  });
});
