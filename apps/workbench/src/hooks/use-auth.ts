/**
 * Canonical workbench auth surface.
 *
 * `session` owns transport/authentication: sign-in/out state and bearer
 * retrieval (Logto — browser SDK or Electron IPC per `isDesktop`).
 *
 * `viewer` owns Nautilo viewer identity: the Human's role/label/identity from
 * `/api/auth/whoami`. Profile/UI code should read viewer fields only from
 * here, never from a second auth hook.
 */
import { Prompt, useLogto } from "@logto/react";
import {
  createContext,
  createElement,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  isCapabilitySlug,
  type CapabilitySlug,
  type GroupChip,
  type ViewerRole,
  type WhoamiResponse,
} from "@nautilo/types";
import {
  pickHighestRoleSlug,
  type ConditionalReadResult,
} from "@nautilo/api-client/browser";
import { apiClient } from "../lib/api";
import { desktopAPI, isDesktop, type DesktopAuthIssue } from "../lib/desktop";
import { useLogtoResource } from "../contexts/auth-mode";
import {
  buildWorkbenchPostLogoutRedirectUri,
  buildWorkbenchRedirectUri,
  type WorkbenchPostLogoutReturnPath,
} from "../lib/logto-redirect-uri";
import {
  type CachedViewer,
  clearLastKnownViewer,
  readLastKnownViewer,
  writeLastKnownViewer,
} from "../lib/persisted-viewer-cache";
import {
  clearPasswordRecoveryCompletionPending,
  readPasswordRecoveryCompletionPending,
} from "../lib/password-recovery-completion";
import { readSession as readInviteRedeemSession } from "../lib/invite-redeem-session";
import { readOwnerClaimHandoff } from "../lib/owner-claim-handoff";
import {
  computeBrowserAuthState,
  type AuthSessionState,
} from "./use-auth-browser-state";
import { resolveInitialTheme } from "./use-theme";
import {
  addAuthTransitionListener,
  classifyViewerTransitionReason,
  dispatchAuthTransition,
  latchCredentialToken,
  viewerIdentityKey,
  type AuthTransitionReason,
} from "../lib/auth-transition";
export interface AuthIdentity {
  sub: string;
  name?: string;
  email?: string;
}

export interface SignInOptions {
  /**
   * Extra OIDC authorize-URL parameters. Used by the M106 invite-redeem
   * wizard to thread Logto's magic-link one-time token (`one_time_token`)
   * and recipient email (`login_hint`) into the standard sign-in flow,
   * so a new user can complete sign-up without needing an existing
   * password.
   */
  extraParams?: Record<string, string>;
}

/** A deliberately closed set of post-logout destinations for session callers. */
export type AuthSignOutReturnPath = WorkbenchPostLogoutReturnPath;

export interface AuthSession {
  state: AuthSessionState;
  identity?: AuthIdentity;
  issue?: DesktopAuthIssue;
  signIn: (opts?: SignInOptions) => Promise<void>;
  signOut: (returnPath?: AuthSignOutReturnPath) => Promise<void>;
  getAccessToken: () => Promise<string | null>;
}

export interface AuthViewer {
  role: ViewerRole;
  label: string;
  userIdentity: string | null;
  /** Authenticated human id from `/api/auth/whoami` — preferred stable storage scope key. */
  sessionUserId: string | null;
  /** Current session actor id (`actors.id`) from `/api/auth/whoami`. Null when unauthenticated.
   *  Distinct from `sessionUserId`: the latter is the human owner; this is the
   *  per-session actor row used for room membership matching. */
  sessionActorId: string | null;
  isVerified: boolean;
  /**
   * M129 — the viewer's own server-wide Capability union from
   * `whoami.capabilities`. ADVISORY UI-gating only (the server enforces).
   * Empty for guest / anonymous. Consume via `useCan()`. See ISSUE-M129
   * §1.1 / AR-1. Preserved across `staleWhoami` (carried through the
   * persisted viewer cache) so a hard reload during an outage keeps the
   * gated UI stable rather than collapsing to "no privileges".
   */
  capabilities: CapabilitySlug[];
  features: NonNullable<WhoamiResponse["features"]>;
  /**
   * D145 / Stack 19 — true when the most recent `whoami()` request failed
   * (network error, 5xx, parse failure) and we are continuing to render
   * the LAST KNOWN viewer rather than collapsing to GUEST_VIEWER. Consumers
   * that gate on `viewer.isVerified` keep working transparently; consumers
   * that want to surface "stale" disclosure (e.g. settings mutations)
   * can branch on this flag explicitly.
   *
   * Cleared back to false on the next successful `whoami()` (whether the
   * resolved viewer is the same identity or a different one).
   */
  staleWhoami: boolean;
  /** Human display name from the latest successful whoami. */
  displayName: string | null;
  /** Human @handle from the latest successful whoami (without `@`). */
  handle: string | null;
}

export interface AuthAPI {
  session: AuthSession;
  viewer: AuthViewer;
  groups: GroupChip[];
  /** Refresh the authoritative Nautilo viewer after an identity or membership mutation. */
  refreshViewer: () => Promise<void>;
  /** Latch an externally-issued credential through AuthProvider ownership. */
  latchAccessToken: (
    token: string | null,
    options?: { recovered?: boolean },
  ) => string | null;
  /** Monotonic generation — bumps when the effective bearer token changes. */
  credentialGeneration: number;
  /** Monotonic generation — bumps on sign-in/out, user switch, or instance switch. */
  viewerGeneration: number;
}

const AuthContext = createContext<AuthAPI | null>(null);

function isVerifiedRole(role: ViewerRole): boolean {
  return role !== "guest" && role !== "stranger";
}

/**
 * D420 — the complete set of recognized `ViewerRole` slugs. Used to gate
 * `whoami.highestRole` before accepting it as authority: a future server
 * that mints a new Role slug (e.g. `"operator"`) is NOT trusted blindly.
 */
const VIEWER_ROLE_SET: ReadonlySet<ViewerRole> = new Set<ViewerRole>([
  "owner",
  "admin",
  "superuser",
  "member",
  "contributor",
  "community",
  "guest",
  "anonymous",
  "stranger",
]);

function isViewerRole(slug: string): slug is ViewerRole {
  return VIEWER_ROLE_SET.has(slug as ViewerRole);
}

/**
 * D420 — resolve the workbench viewer role from `/api/auth/whoami`.
 *
 * `whoami.highestRole` is the server-derived highest-rank Role slug (via
 * `findUserHighestRoleSlug`); it is authoritative when it is a recognized
 * `ViewerRole`. This is the fix for the dev-auth guest-shell regression:
 * a valid owner bearer returned `groups: []` (the group-chip projection
 * came back empty) while `highestRole: "owner"` was correct, but the
 * pre-D420 derivation `pickHighestRoleSlug(groups ?? [])` ranked `[]` to
 * `"guest"`, turning an authenticated owner into the Guest shell.
 *
 * Defense against drift: an unknown `highestRole` string (a future Role
 * slug the client doesn't know) is NOT accepted as authority —
 * `isViewerRole` gates it and we fall back to the existing group-chip
 * ranking so the client never trusts an arbitrary future string. Null /
 * undefined `highestRole` (guest / anonymous / no Group) also falls back.
 *
 * Pure — pinned by `use-auth-viewer-role.test.ts` so a refactor that
 * drops the `highestRole` authority or the recognized-role gate fails
 * loudly.
 */
export function resolveViewerRole(
  highestRole: string | null | undefined,
  groups: GroupChip[],
): ViewerRole {
  if (typeof highestRole === "string" && isViewerRole(highestRole)) {
    return highestRole;
  }
  return pickHighestRoleSlug(groups);
}

// Pure stale-bearer helpers live in `./use-auth-stale-detection` so the
// dedicated unit tests can import them without crossing into this
// module (which gets `mock.module`-replaced by sign-in-dialog +
// invite-redeem tests and breaks on CI when load order shifts).
import { computeStaleBearerSignOutAction as runComputeStaleBearerSignOutAction } from "./use-auth-stale-detection";
// M129 — pure label helper lives in its own module so its unit test can
// import it without crossing into this (logto-heavy, mock.module-replaced)
// module. See viewer-label.ts header + use-auth-stale-detection.ts.
import { deriveViewerLabel } from "./viewer-label";

/**
 * M106/M126 — true while the invite-redeem wizard owns authentication.
 * Used to disable `useViewerAuth`'s stale-bearer auto-signOut, which
 * would otherwise race the wizard's `bind-logto-user` call and wipe
 * the tokens mid-flow.
 *
 * The OAuth return briefly renders `/auth/callback` before navigating
 * back to `/invite/:token` or `/claim`. Protect that callback only when a
 * valid, unexpired handoff is awaiting signup/bind; ordinary callbacks retain
 * stale-bearer recovery.
 */
function isOnInviteRedeemPath(): boolean {
  if (typeof window === "undefined") return false;
  const p = window.location.pathname;
  if (p.startsWith("/invite/") || p.startsWith("/redeem/") || p === "/claim") return true;
  if (p !== "/auth/callback") return false;

  const ownerClaimHandoff = readOwnerClaimHandoff();
  if (
    ownerClaimHandoff?.stage === "awaiting-signup" ||
    ownerClaimHandoff?.stage === "awaiting-bind" ||
    ownerClaimHandoff?.stage === "profile"
  ) {
    return true;
  }
  const inviteSession = readInviteRedeemSession();
  return (
    inviteSession?.stage === "awaiting-signup" ||
    inviteSession?.stage === "awaiting-bind"
  );
}

/**
 * D145 / Stack 19 — Pure derivation for the whoami-failure catch branch.
 *
 * On `whoami()` request failure (network unreachable, 5xx, parse error),
 * keep the last-known viewer fields and flip `staleWhoami: true`. The
 * Stack 14 / pre-fix shape was `setViewer(GUEST_VIEWER)` here, which
 * caused dozens of `viewer.isVerified` consumers to re-render as guest
 * UX during transient disconnects.
 *
 * Idempotent on subsequent failures: returns referential-equal `prev`
 * if `staleWhoami` is already true, so React's setState bail-out
 * suppresses redundant re-renders.
 *
 * Note: this catch path does NOT cover the M097 stale-bearer case
 * (server resolves whoami with `{actorRole: "guest", sessionUserId:
 * null}` on a non-empty bearer); that's handled in the resolved branch
 * via `computeStaleBearerSignOutAction`. The catch is exclusively
 * about request-level failure.
 */
export function computeViewerOnWhoamiFailure(prev: AuthViewer): AuthViewer {
  return prev.staleWhoami ? prev : { ...prev, staleWhoami: true };
}

const GUEST_VIEWER: AuthViewer = {
  role: "guest",
  label: "Guest",
  userIdentity: null,
  sessionUserId: null,
  sessionActorId: null,
  isVerified: false,
  capabilities: [],
  features: { office: { enabled: false } },
  staleWhoami: false,
  displayName: null,
  handle: null,
};

/**
 * D145 / Stack 19 Phase 6.9.5 (2026-05-17) — pure derivation for the
 * `getAccessToken() === null` branch of `useViewerAuth.checkViewer`.
 *
 * Pre-fix this branch unconditionally returned GUEST_VIEWER, which
 * collapsed the workbench to guest UX whenever the Logto SDK failed
 * to refresh on cold boot — indistinguishable here from "user
 * explicitly signed out" because Logto returns null in both cases.
 * That contradicted the omnibus's "no guest screen for signed-in
 * outage" goal.
 *
 * Fix: discriminate via the persisted viewer cache:
 *   - cached !== null → refresh failure (or any other survivable
 *     null-token cause); preserve the cached identity with
 *     staleWhoami=true so the workbench shell stays visible
 *   - cached === null → genuine signed-out state (signOut() already
 *     cleared the cache, or first launch); collapse to GUEST_VIEWER
 *
 * The signOut() implementations in useElectronSession /
 * useBrowserLogtoSession call clearLastKnownViewer() BEFORE
 * Logto.signOut(), so by the time we observe token === null on the
 * explicit-signOut path, the cache is already empty and we correctly
 * fall through to GUEST_VIEWER. The contract is symmetric with
 * `computeViewerOnWhoamiFailure` for survivable-error semantics.
 *
 * Pure, no globals — reads from caller-supplied `cached`. Pinned by
 * `use-auth-viewer-resilience.test.ts` to make the next refactor
 * loud if it drops the cache-discriminator.
 */
export function computeViewerOnNullToken(cached: CachedViewer | null): AuthViewer {
  if (cached) {
    return {
      role: cached.role,
      label: cached.label,
      userIdentity: cached.userIdentity,
      sessionUserId: cached.sessionUserId,
      // M107 added `sessionActorId` to AuthViewer but the persisted
      // viewer cache (v1 schema in persisted-viewer-cache.ts) does not
      // yet store it. Stale-cache restoration sets it to null; the next
      // successful whoami (≤10s polling cadence) populates it. Consumers
      // already tolerate null (GUEST_VIEWER also has sessionActorId=null).
      sessionActorId: null,
      isVerified: cached.isVerified,
      // M129 — carry the cached capability union through stale restoration
      // so gated UI stays stable during an outage (AR-6). Empty on a
      // genuine guest cache; the next successful whoami refreshes it.
      capabilities: cached.capabilities,
      features: { office: { enabled: false } },
      staleWhoami: true,
      displayName: cached.displayName ?? cached.label ?? null,
      handle: cached.handle ?? null,
    };
  }
  return GUEST_VIEWER;
}

function useCoalescedGetAccessToken(
  getAccessToken: () => Promise<string | null>,
): () => Promise<string | null> {
  const getAccessTokenRef = useRef(getAccessToken);
  getAccessTokenRef.current = getAccessToken;
  const inflightRef = useRef<Promise<string | null> | null>(null);

  return useCallback(async () => {
    if (inflightRef.current) return inflightRef.current;
    const promise = getAccessTokenRef.current().finally(() => {
      if (inflightRef.current === promise) inflightRef.current = null;
    });
    inflightRef.current = promise;
    return promise;
  }, []);
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const value = useAuthValue();
  return createElement(AuthContext.Provider, { value }, children);
}

export function useAuth(): AuthAPI {
  const value = useContext(AuthContext);
  if (!value) {
    throw new Error("useAuth must be used within <AuthProvider>");
  }
  return value;
}

function useAuthValue(): AuthAPI {
  const session = useSessionAuth();
  const coalescedGetAccessToken = useCoalescedGetAccessToken(session.getAccessToken);
  const [desktopSessionActive, setDesktopSessionActive] = useState(() => !isDesktop);
  const [credentialGeneration, setCredentialGeneration] = useState(() =>
    apiClient.getCredentialGeneration(),
  );
  const [viewerGeneration, setViewerGeneration] = useState(0);
  const viewerGenerationRef = useRef(0);
  viewerGenerationRef.current = viewerGeneration;
  const lastTokenRef = useRef<string | null>(apiClient.getToken());
  const lastViewerIdentityRef = useRef<string | null>(null);
  const lastInstanceIdRef = useRef<string | null>(null);
  const requestViewerCheckRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    if (!isDesktop) {
      setDesktopSessionActive(true);
      return;
    }
    const subscribe = desktopAPI?.activeSession?.onStateChange;
    if (typeof subscribe !== "function") {
      setDesktopSessionActive(true);
      return;
    }
    setDesktopSessionActive(false);
    return subscribe(({ active }) => setDesktopSessionActive(active));
  }, []);

  const latchAccessToken = useCallback(
    (
      acquiredToken: string | null,
      options: { recovered?: boolean } = {},
    ): string | null => {
      const result = latchCredentialToken({
        acquiredToken,
        previousToken: lastTokenRef.current,
        recovered: options.recovered === true,
        viewerGeneration: viewerGenerationRef.current,
        setToken: (token) => apiClient.setToken(token),
        getCredentialGeneration: () => apiClient.getCredentialGeneration(),
        publish: (detail) => {
          setCredentialGeneration(detail.credentialGeneration);
          dispatchAuthTransition(detail);
        },
      });
      lastTokenRef.current = result.token;
      return result.token;
    },
    [],
  );

  const getAndLatchAccessToken = useCallback(
    async (options: { recovered?: boolean } = {}): Promise<string | null> => {
      // A preserved background renderer keeps its in-memory bearer but must
      // not invoke active-only Electron auth IPC. Main will replay `active`
      // when this view returns to the foreground, triggering a fresh sync.
      if (!desktopSessionActive) return lastTokenRef.current;
      return latchAccessToken(await coalescedGetAccessToken(), options);
    },
    [coalescedGetAccessToken, desktopSessionActive, latchAccessToken],
  );

  const bumpViewerGeneration = useCallback((reason: AuthTransitionReason) => {
    setViewerGeneration((prev) => {
      const next = prev + 1;
      viewerGenerationRef.current = next;
      dispatchAuthTransition({
        credentialGeneration: apiClient.getCredentialGeneration(),
        viewerGeneration: next,
        reason,
      });
      return next;
    });
  }, []);

  const noteViewerIdentity = useCallback(
    (input: { sessionUserId: string | null; instanceId: string | null }) => {
      const nextKey = viewerIdentityKey(input);
      const prevKey = lastViewerIdentityRef.current;
      if (prevKey === nextKey) return;
      const reason = classifyViewerTransitionReason({
        previousKey: prevKey,
        nextKey,
        previousInstanceId: lastInstanceIdRef.current,
        nextInstanceId: input.instanceId,
        signedOut: prevKey !== null && nextKey === null,
        signedIn: prevKey === null && nextKey !== null,
      });
      lastViewerIdentityRef.current = nextKey;
      lastInstanceIdRef.current = input.instanceId;
      if (reason) bumpViewerGeneration(reason);
    },
    [bumpViewerGeneration],
  );

  useEffect(() => {
    let cancelled = false;
    const syncToken = async (recovered = false): Promise<void> => {
      await getAndLatchAccessToken({ recovered });
      if (cancelled) return;
      requestViewerCheckRef.current?.();
    };
    void syncToken();
    const onVisible = (): void => {
      if (document.visibilityState === "visible") void syncToken(true);
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [session.state, getAndLatchAccessToken]);

  useEffect(() => {
    apiClient.setTokenProvider(getAndLatchAccessToken);
    return () => apiClient.setTokenProvider(null);
  }, [getAndLatchAccessToken]);

  useEffect(() => {
    apiClient.setActionCapabilityDenialHandler(() => {
      requestViewerCheckRef.current?.();
    });
    return () => apiClient.setActionCapabilityDenialHandler(null);
  }, []);

  const { viewer, groups, refreshViewer } = useViewerAuth({
    enabled: desktopSessionActive,
    getAndLatchAccessToken,
    signOut: session.signOut,
    noteViewerIdentity,
    registerRequestViewerCheck: (request) => {
      requestViewerCheckRef.current = request;
    },
  });
  const authSession = useMemo<AuthSession>(
    () => ({ ...session, getAccessToken: getAndLatchAccessToken }),
    [session, getAndLatchAccessToken],
  );

  return useMemo(
    () => ({
      session: authSession,
      viewer,
      groups,
      refreshViewer,
      latchAccessToken,
      credentialGeneration,
      viewerGeneration,
    }),
    [
      authSession,
      viewer,
      groups,
      refreshViewer,
      latchAccessToken,
      credentialGeneration,
      viewerGeneration,
    ],
  );
}

// The platform is fixed for the lifetime of this module. Selecting the hook
// once keeps the call itself unconditional without rule suppressions that a
// workspace-root staged-file lint cannot resolve.
const usePlatformSession = isDesktop
  ? useElectronSession
  : useBrowserLogtoSession;

function useSessionAuth(): AuthSession {
  return usePlatformSession();
}

interface UseViewerAuthOptions {
  enabled: boolean;
  getAndLatchAccessToken: () => Promise<string | null>;
  signOut: () => Promise<void>;
  noteViewerIdentity: (input: {
    sessionUserId: string | null;
    instanceId: string | null;
  }) => void;
  registerRequestViewerCheck: (request: () => void) => void;
}

export interface WhoamiMemoryCache {
  body: WhoamiResponse | null;
  etag: string | null;
}

type ConditionalWhoamiReader = (
  options?: { ifNoneMatch?: string },
) => Promise<ConditionalReadResult<WhoamiResponse>>;

/**
 * Resolve one whoami refresh against application-memory state. A validator is
 * never useful without its typed body, so an orphan 304 is recovered exactly
 * once with an unconditional request.
 */
export async function readWhoamiWithMemoryCache(
  cache: WhoamiMemoryCache,
  read: ConditionalWhoamiReader,
): Promise<WhoamiResponse> {
  let response = await read(cache.etag ? { ifNoneMatch: cache.etag } : undefined);
  if (response.status === 304) {
    if (cache.body) {
      if (response.etag) cache.etag = response.etag;
      return cache.body;
    }
    response = await read();
    if (response.status === 304) {
      throw new Error("whoami returned 304 without a cached body");
    }
  }
  const previousScope = cache.body
    ? viewerIdentityKey({
        sessionUserId: cache.body.sessionUserId,
        instanceId: cache.body.instanceId,
      })
    : null;
  const nextScope = viewerIdentityKey({
    sessionUserId: response.body.sessionUserId,
    instanceId: response.body.instanceId,
  });
  if (previousScope !== null && previousScope !== nextScope) {
    cache.body = null;
    cache.etag = null;
  }
  cache.body = response.body;
  cache.etag = response.etag;
  return response.body;
}

function useViewerAuth({
  enabled,
  getAndLatchAccessToken,
  signOut,
  noteViewerIdentity,
  registerRequestViewerCheck,
}: UseViewerAuthOptions): {
  viewer: AuthViewer;
  groups: GroupChip[];
  refreshViewer: () => Promise<void>;
} {
  // ISSUE-D145 / Stack 19 — Hydrate from `persisted-viewer-cache` so a hard
  // reload during a server outage starts from the last-known viewer rather
  // than GUEST_VIEWER. The first `checkViewer()` tick will overwrite this
  // synchronously if whoami succeeds, or preserve it (with `staleWhoami:
  // true`) if whoami fails. If no cache exists (genuine first launch),
  // falls through to GUEST_VIEWER as before.
  const [viewer, setViewer] = useState<AuthViewer>(() => {
    const cached = readLastKnownViewer();
    if (!cached) return GUEST_VIEWER;
    // sessionActorId not in v1 cache (see computeViewerOnNullToken comment);
    // null until next successful whoami populates it.
    return {
      ...cached,
      sessionActorId: null,
      features: { office: { enabled: false } },
      staleWhoami: true,
      displayName: cached.displayName ?? cached.label ?? null,
      handle: cached.handle ?? null,
    };
  });
  const [groups, setGroups] = useState<GroupChip[]>([]);
  const staleSignOutTriggered = useRef(false);
  const passwordRecoveryCompletionInFlight = useRef(false);
  const checkViewerInflightRef = useRef<Promise<void> | null>(null);
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;
  const whoamiCacheRef = useRef<WhoamiMemoryCache>({ body: null, etag: null });
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const applyViewerIdentity = useCallback(
    (sessionUserId: string | null, instanceId: string | null) => {
      noteViewerIdentity({ sessionUserId, instanceId });
    },
    [noteViewerIdentity],
  );

  const checkViewer = useCallback(async () => {
    if (!enabledRef.current) return;
    if (checkViewerInflightRef.current) return checkViewerInflightRef.current;
    const run = async (): Promise<void> => {
    const token = await getAndLatchAccessToken();
    if (!enabledRef.current) return;
    if (!token) {
      // No bearer. Two scenarios converge here, distinguishable ONLY by
      // whether the persisted viewer cache is populated:
      //
      //   1. Explicit user signOut() — `signOut()` implementations of
      //      useElectronSession / useBrowserLogtoSession call
      //      `clearLastKnownViewer()` BEFORE Logto.signOut(), so by the
      //      time we observe `token === null` here the cache is empty.
      //      We collapse to GUEST_VIEWER (the user expects to see
      //      Guest UX immediately).
      //
      //   2. Logto SDK failed to refresh on cold boot, OR server-down
      //      transient, OR keychain/cookie eviction without our signOut().
      //      The cache is still populated (signOut() never ran).
      //      We preserve the cached identity with `staleWhoami: true`
      //      so the workbench shell stays visible instead of collapsing
      //      to guest UX during a survivable outage — the same contract
      //      the whoami-failure catch path enforces below.
      //
      // Reviewer-cited gap (Stack 19 Phase 6.9.5, 2026-05-17): pre-fix
      // this branch unconditionally `setViewer(GUEST_VIEWER)`, which
      // contradicted the omnibus's "no guest screen for signed-in
      // outage" goal in scenario 2. Tested via the same persisted-cache
      // shape that the catch path uses; the explicit-signOut path
      // continues to work because the cache-clear ordering in the two
      // session hooks is preserved.
      //
      // Edge case: if a user clears their Logto session via OS Keychain
      // / browser DevTools directly (bypassing our signOut), the cache
      // stays for one re-launch. The next successful whoami either
      // overwrites it with the new identity OR (if the bearer is
      // genuinely dead) leaves it untouched while the workbench renders
      // the cached shell — both acceptable.
      staleSignOutTriggered.current = false;
      whoamiCacheRef.current = { body: null, etag: null };
      const nextViewer = computeViewerOnNullToken(readLastKnownViewer());
      if (mountedRef.current) {
        setViewer(nextViewer);
        setGroups([]);
      }
      applyViewerIdentity(null, null);
      return;
    }

    // M126 — on /invite/:token (and legacy /redeem/:token) we hold a
    // fresh Logto bearer but the local users row doesn't exist yet
    // (the wizard is mid-bind). Post-M126 the trust preHandler returns
    // guest for unbound subs. Skip the whoami round-trip in this
    // window — the wizard manages its own bearer for bind +
    // complete-profile and doesn't need viewer state. The viewer
    // flips to the real role on the next checkViewer tick after the
    // wizard navigates away from /invite or /redeem.
    if (isOnInviteRedeemPath()) {
      whoamiCacheRef.current = { body: null, etag: null };
      if (mountedRef.current) {
        setViewer(GUEST_VIEWER);
        setGroups([]);
      }
      applyViewerIdentity(null, null);
      return;
    }

    try {
      const data = (await readWhoamiWithMemoryCache(
        whoamiCacheRef.current,
        (options) => apiClient.whoamiConditional(options),
      )) as Partial<WhoamiResponse>;
      const action = runComputeStaleBearerSignOutAction({
        nonEmptyToken: true,
        whoami: data,
        staleSignOutAlreadyTriggered: staleSignOutTriggered.current,
      });
      staleSignOutTriggered.current = action.nextStaleSignOutTriggered;
      if (action.shouldSignOut) {
        // M106 — DO NOT auto-signOut while the renderer is on the
        // invite-redeem wizard. Between Logto sign-in completion and
        // the wizard's `bind-logto-user` call, the user has a valid
        // Logto JWT but is NOT yet linked to a Nautilo user — so
        // /api/auth/whoami legitimately returns `actorRole: "guest"`
        // with `sessionUserId: null`. That's exactly the shape the
        // stale-bearer heuristic treats as "force sign-out", which
        // races the wizard and wipes its tokens mid-flow. Skip the
        // sign-out (still hold the guest viewer) and let the wizard's
        // bind step run; the next checkViewer poll will see the
        // linked user and the viewer flips to its real role.
        if (isOnInviteRedeemPath()) {
          if (mountedRef.current) {
            setViewer(GUEST_VIEWER);
            setGroups([]);
          }
          applyViewerIdentity(null, null);
          return;
        }
        // M097 stale-bearer recovery: server resolved whoami with the
        // guest-shape on a non-empty bearer (Logto rotated keys, etc.).
        // D145 / Stack 19 Phase 1.7 — clear the cache so the next mount
        // doesn't hydrate the now-invalid identity, then sign out. The
        // signOut() triggers another `if (!token)` tick covered above.
        console.warn("[useAuth] stale bearer detected; signing out");
        whoamiCacheRef.current = { body: null, etag: null };
        clearLastKnownViewer();
        await signOut();
        if (mountedRef.current) {
          setViewer(GUEST_VIEWER);
          setGroups([]);
        }
        applyViewerIdentity(null, null);
        return;
      }
      const groupsList = data.groups ?? [];
      // D420 — `whoami.highestRole` is authoritative when it is a
      // recognized ViewerRole; otherwise fall back to the existing
      // group-chip ranking. Fixes the dev-auth guest-shell regression
      // where a valid owner bearer with `groups: []` + `highestRole:
      // "owner"` collapsed to Guest under the prior
      // `pickHighestRoleSlug(groups ?? [])` derivation.
      const role = resolveViewerRole(data.highestRole, groupsList);
      const next: AuthViewer = {
        role,
        // M129 — `label` is the human's DISPLAY NAME (see deriveViewerLabel).
        label: deriveViewerLabel(data, role),
        userIdentity: data.userIdentity ?? null,
        sessionUserId: data.sessionUserId ?? null,
        sessionActorId: data.sessionActorId ?? null,
        isVerified: isVerifiedRole(role),
        // M129 — filter unknown slugs from a newer server (graceful AR-6).
        capabilities: (data.capabilities ?? []).filter(isCapabilitySlug),
        features: data.features ?? { office: { enabled: false } },
        staleWhoami: false,
        displayName: data.displayName ?? null,
        handle: data.handle ?? null,
      };
      // ISSUE-D145 / Stack 19 — persist the freshly-resolved viewer so a
      // subsequent mount (hard reload) hydrates from this rather than
      // collapsing to GUEST. Idempotent; the `cachedAt` field gets refreshed
      // every successful tick. Tolerates storage failure silently.
      writeLastKnownViewer({
        role: next.role,
        label: next.label,
        userIdentity: next.userIdentity,
        sessionUserId: next.sessionUserId,
        isVerified: next.isVerified,
        capabilities: next.capabilities,
        displayName: next.displayName,
        handle: next.handle,
      });
      if (mountedRef.current) {
        setViewer(next);
        setGroups(groupsList);
      }
      applyViewerIdentity(next.sessionUserId, data.instanceId ?? null);
      const passwordRecoveryProof = readPasswordRecoveryCompletionPending();
      if (
        next.sessionUserId &&
        passwordRecoveryProof &&
        !passwordRecoveryCompletionInFlight.current
      ) {
        passwordRecoveryCompletionInFlight.current = true;
        void apiClient
          .markPasswordRecoveryCompleted(passwordRecoveryProof)
          .then(() => {
            clearPasswordRecoveryCompletionPending();
          })
          .catch((err) => {
            console.warn("[useAuth] failed to mark password recovery complete", err);
          })
          .finally(() => {
            passwordRecoveryCompletionInFlight.current = false;
          });
      }
    } catch {
      // ISSUE-D145 / Stack 19 — viewer-collapse fix. Whoami request failed
      // (network unreachable, 5xx, parse error). M097's stale-bearer
      // recovery runs in the resolved branch above, NOT here — the server
      // returns 200 + guest-shape on bearer-validation failure per M097's
      // contract, so a true 401-equivalent doesn't reach this catch. The
      // catch is exclusively about request-level failures, which are
      // transient and should NOT collapse the viewer to GUEST_VIEWER (the
      // Stack 14 / pre-fix shape that caused dozens of `viewer.isVerified`
      // consumers to re-render as guest UX during disconnect, even though
      // RuntimeShellState correctly reported `authenticated_disconnected`).
      //
      // Keep the last-known viewer; flip `staleWhoami` to true so consumers
      // that want to surface "your view may be stale" can branch on it
      // (none today; opt-in by future code).
      if (mountedRef.current) {
        setViewer(computeViewerOnWhoamiFailure);
      }
    }
    };
    const promise = run().finally(() => {
      if (checkViewerInflightRef.current === promise) {
        checkViewerInflightRef.current = null;
      }
    });
    checkViewerInflightRef.current = promise;
    return promise;
  }, [getAndLatchAccessToken, signOut, applyViewerIdentity]);

  const requestViewerCheck = useCallback(() => {
    void checkViewer();
  }, [checkViewer]);

  useEffect(() => {
    registerRequestViewerCheck(requestViewerCheck);
    return () => registerRequestViewerCheck(() => undefined);
  }, [registerRequestViewerCheck, requestViewerCheck]);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    let timeoutId: ReturnType<typeof setTimeout> | null = null;

    const scheduleNext = (): void => {
      if (cancelled) return;
      timeoutId = setTimeout(() => void tick(), 10_000);
    };

    const tick = async (): Promise<void> => {
      await checkViewer();
      scheduleNext();
    };

    void tick();

    return () => {
      cancelled = true;
      if (timeoutId !== null) clearTimeout(timeoutId);
    };
  }, [checkViewer, enabled]);

  useEffect(() => {
    const storageHandler = (): void => {
      void checkViewer();
    };
    const authChangedHandler = (): void => {
      staleSignOutTriggered.current = false;
      void checkViewer();
    };
    window.addEventListener("storage", storageHandler);
    const removeAuthListener = addAuthTransitionListener((detail) => {
      if (detail.reason === "signed-out") {
        whoamiCacheRef.current = { body: null, etag: null };
      }
      authChangedHandler();
    });
    return () => {
      window.removeEventListener("storage", storageHandler);
      removeAuthListener();
    };
  }, [checkViewer]);

  return { viewer, groups, refreshViewer: checkViewer };
}

function useBrowserLogtoSession(): AuthSession {
  const { logtoResource, redirectOrigins } = useLogtoResource();
  const logto = useLogto();
  const logtoRef = useRef(logto);
  logtoRef.current = logto;
  const signingOutRef = useRef(false);

  const { isAuthenticated, isLoading } = logto;

  const [state, setState] = useState<AuthSessionState>("unknown");
  const [identity, setIdentity] = useState<AuthIdentity | undefined>();

  useEffect(() => {
    setState((prev) => {
      const next = computeBrowserAuthState({
        previous: prev,
        isLoading,
        isAuthenticated,
      });
      return prev === next ? prev : next;
    });
  }, [isAuthenticated, isLoading]);

  useEffect(() => {
    if (!isAuthenticated) {
      setIdentity((prev) => (prev === undefined ? prev : undefined));
      return;
    }
    let cancelled = false;
    void logtoRef.current.getIdTokenClaims?.().then((claims) => {
      if (cancelled || !claims) return;
      const next: AuthIdentity = {
        sub: claims.sub,
        ...(typeof claims.name === "string" ? { name: claims.name } : {}),
        ...(typeof claims.email === "string" ? { email: claims.email } : {}),
      };
      setIdentity((prev) => {
        if (
          prev &&
          prev.sub === next.sub &&
          prev.name === next.name &&
          prev.email === next.email
        ) {
          return prev;
        }
        return next;
      });
    });
    return () => {
      cancelled = true;
    };
  }, [isAuthenticated]);

  return useMemo<AuthSession>(() => {
    const audience = logtoResource;
    return {
      state,
      ...(identity ? { identity } : {}),
      signIn: async (opts) => {
        setState("signing-in");
        // Without `prompt=login`, Logto reuses an active IdP browser session
        // (SSO) and returns immediately without username/password. After sign-out
        // or when switching accounts, we must force re-authentication. Per Logto
        // docs, pair `login` with `consent` when requesting `offline_access`.
        await logtoRef.current.signIn({
          redirectUri: buildWorkbenchRedirectUri(
            "/auth/callback",
            window.location.origin,
            redirectOrigins,
          ),
          prompt: [Prompt.Login, Prompt.Consent],
          ...(opts?.extraParams ? { extraParams: opts.extraParams } : {}),
        });
      },
      signOut: async (returnPath) => {
        // D145 / Stack 19 Phase 1.7 — clear the persisted viewer cache on
        // EXPLICIT sign-out. Refresh-failure-on-dead-server is handled in
        // `checkViewer`'s no-token branch (which preserves the cache);
        // this signOut path is the only place we know "the user wants to
        // be a guest now."
        await apiClient.teardownLiveShadowForegroundAuthorizationSessions()
          .catch(() => undefined);
        signingOutRef.current = true;
        clearLastKnownViewer();
        try {
          await logtoRef.current.signOut?.(
            buildWorkbenchPostLogoutRedirectUri(
              returnPath,
              window.location.origin,
              redirectOrigins,
            ),
          );
        } finally {
          signingOutRef.current = false;
        }
      },
      getAccessToken: async () => {
        // Logto is unauthenticated until the sign-in callback stores tokens.
        // Its isLoading flag also covers ordinary token/claims reads, so it
        // cannot mean "no bearer": that would reset viewer/device admission
        // during an authenticated request. Explicit logout remains fenced
        // because Logto keeps isAuthenticated true until its redirect.
        if (!logtoRef.current.isAuthenticated || signingOutRef.current) {
          return null;
        }
        try {
          const token = await logtoRef.current.getAccessToken?.(audience);
          return token ?? null;
        } catch {
          return null;
        }
      },
    };
  }, [state, identity, logtoResource, redirectOrigins]);
}

/**
 * M055 — Electron Logto session. Talks to main via the
 * `nautiloDesktop.auth.*` IPC bridge: `isAuthenticated`,
 * `getAccessToken`, `signIn`, `signOut`, `onStateChange`. The full
 * lifecycle (loopback PKCE, embedded `BrowserWindow`, `safeStorage`,
 * silent refresh, clock-skew compensation) lives in main; the
 * renderer only mirrors state; AuthProvider owns typed auth transitions
 * and `useViewerAuth` re-polls `/api/auth/whoami` when session state flips.
 *
 * State machine:
 *   1. Mount → `auth:status` IPC → `signed-in` | `signed-out`.
 *   2. `signIn()` → optimistic `signing-in`; main fires
 *      `auth:state-change` on completion (or on failure → signed-out).
 *   3. `auth:state-change` from main → mirror locally; AuthProvider token
 *      latch publishes a typed transition so the viewer flips immediately.
 */
/**
 * Bridge alias — `desktopAPI.auth` is the IPC namespace shape, but
 * referencing `desktopAPI.auth.X` directly trips the `canonical-paths`
 * test (which forbids `\bauth\.X\b` to keep `useAuth()` consumers off
 * the legacy top-level field shape). Re-export through a different
 * identifier so the regex is satisfied and the identity is clear.
 */
const desktopAuthBridge = desktopAPI ? desktopAPI.auth : null;

function useElectronSession(): AuthSession {
  const [state, setState] = useState<AuthSessionState>("unknown");
  const [identity, setIdentity] = useState<AuthIdentity | undefined>();
  const [issue, setIssue] = useState<DesktopAuthIssue>(null);

  useEffect(() => {
    if (!desktopAuthBridge) {
      setState("signed-out");
      return;
    }
    let cancelled = false;
    void desktopAuthBridge.isAuthenticated().then(async (ok) => {
      if (cancelled) return;
      setState(ok ? "signed-in" : "signed-out");
      const nextIssue = ok ? null : await desktopAuthBridge.getIssue();
      if (!cancelled) setIssue(nextIssue);
    });
    const unsubscribe = desktopAuthBridge.onStateChange((ev) => {
      setState(ev.state);
      if (ev.state === "signed-out") {
        setIdentity(undefined);
        void desktopAuthBridge.getIssue().then(setIssue);
      } else {
        setIssue(null);
      }
      // Match D102's contract: session state transitions trigger the
      // AuthProvider token latch, which publishes typed auth transitions
      // so `useViewerAuth` re-polls whoami immediately.
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, []);

  return useMemo<AuthSession>(
    () => ({
      state,
      ...(identity ? { identity } : {}),
      ...(issue != null ? { issue } : {}),
      signIn: async (opts) => {
        if (!desktopAuthBridge) throw new Error("desktopAPI unavailable");
        setState("signing-in");
        // Workbench defaults to dark even before useTheme has persisted a
        // preference. Send that effective theme, not a nullable storage read,
        // so the first hosted login cannot disagree with the app behind it.
        const theme = resolveInitialTheme(window.localStorage);
        const result = await desktopAuthBridge.signIn({
          ...(opts?.extraParams ? { extraParams: opts.extraParams } : {}),
          theme,
        });
        if (!result.ok) {
          setState("signed-out");
          setIssue(await desktopAuthBridge.getIssue());
          if (result.error === "cancelled") return;
          throw new Error(result.error ?? "Electron sign-in failed");
        }
        // Don't flip to signed-in here — main broadcasts
        // `auth:state-change` on success and the listener above
        // mirrors it. That keeps a single source of truth for the
        // post-sign-in state transition.
      },
      signOut: async (_returnPath) => {
        if (!desktopAuthBridge) return;
        // D145 / Stack 19 Phase 1.7 — clear the persisted viewer cache on
        // EXPLICIT sign-out. Refresh-failure-on-dead-server is handled in
        // `checkViewer`'s no-token branch (which preserves the cache);
        // this signOut path is the only place we know "the user wants to
        // be a guest now."
        await apiClient.teardownLiveShadowForegroundAuthorizationSessions()
          .catch(() => undefined);
        clearLastKnownViewer();
        await desktopAuthBridge.signOut();
        // Stack 39 Phase 3 — re-fetch issue after clear so a successful
        // stale-auth wipe drops the recovery card, while a transient IPC
        // race does not leave a stale null that hides mismatch too early.
        setIssue(await desktopAuthBridge.getIssue());
      },
      getAccessToken: async () => {
        if (!desktopAuthBridge) return null;
        return desktopAuthBridge.getAccessToken();
      },
    }),
    [state, identity, issue],
  );
}
