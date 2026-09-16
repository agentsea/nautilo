// D369 Phase 2 — AuthProvider: per-active-server sign-in state.
// Sits inside ServerRegistryProvider; keys off the active server. Wires the
// api-client to always carry a fresh token (ensureValidToken) for the active
// server. Native redirect and refresh behavior are covered by simulator QA.
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";

import { getApiClient } from "@/lib/api";
import { clearAccountDeletionAttempt } from "@/lib/account-deletion-recovery";
import {
  ensureValidToken,
  NativeAuthError,
  reauthenticateToServer,
  signInToServer,
  signOutServer,
} from "@/lib/auth";
import { onAuthDead } from "@/lib/auth-events";
import { releasePushBindingForIdentity } from "@/lib/push-identity-lifecycle";
import { createAuthSessionEndCoordinator } from "@/lib/auth-session-end";
import { decideAuthRecovery } from "@/lib/auth-state-decision";
import type { SettingsReauthIdentity } from "@/lib/settings-reauth";
import { shouldHandleAuthDead } from "@/lib/session-expiry";
import {
  confirmVerifiedTokenOwner,
  loadTokenSnapshot,
  saveTokens,
  serverIdFromUrl,
} from "@/lib/server-store";
import {
  clearViewerCache,
  readViewerCache,
  writeViewerCache,
  type CachedViewer,
} from "@/lib/viewer-cache";
import { useServers } from "@/providers/server-registry";
import type { WhoamiResponse } from "@nautilo/types";

type AuthStatus = "loading" | "signed-in" | "signed-out";
export type ViewerState = "loading" | "cached" | "verified" | "stale" | "none";
export type ViewerIdentity = CachedViewer;
/** Result of an explicit viewer revalidation, used by invite landing only. */
export type ViewerRefreshResult = "verified" | "failed" | "stale";

interface AuthValue {
  status: AuthStatus;
  /** Present only when the app confirmed that a previously active session died. */
  signInNotice: string | null;
  /** Per-active-server viewer identity. Cached fields are advisory UI data only. */
  viewer: ViewerIdentity | null;
  /** Whether viewer is hydrating, cached, verified, stale, or unavailable. */
  viewerState: ViewerState;
  /** Revalidate viewer identity; RealtimeProvider calls this after reconnect. */
  refreshViewer: () => Promise<ViewerRefreshResult>;
  /** Trigger interactive sign-in against the active server. Returns error or null. */
  signIn: (returnPath?: string | null) => Promise<string | null>;
  /** Complete an exact-server invitation's registration-only PKCE exchange. */
  registerInvite: (input: Readonly<{
    serverId: string;
    serverUrl: string;
    handle: string;
    isCurrent: () => boolean;
  }>) => Promise<"completed" | "stale" | "server-mismatch">;
  /** Clear only an unbound registration credential before retrying invite auth. */
  clearInviteRegistration: (input: Readonly<{
    serverId: string;
    serverUrl: string;
    isCurrent: () => boolean;
  }>) => Promise<"cleared" | "stale" | "server-mismatch">;
  /** Fresh-login and verify the same server-bound identity for a Settings action. */
  reauthenticate: () => Promise<SettingsReauthIdentity>;
  /** Begin fresh authentication without retaining a sensitive action closure. */
  beginReauthentication: (returnPath: string) => Promise<void>;
  /** Clear local state and remove the server registration after authoritative deletion. */
  commitAccountDeleted: () => Promise<void>;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthValue | null>(null);

function hasDurablyConfirmedOwner(value: unknown): boolean {
  return typeof value === "string" && value.trim().length > 0 && value.length <= 180;
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const { activeServer, remove } = useServers();
  const [status, setStatus] = useState<AuthStatus>("loading");
  const [viewer, setViewer] = useState<ViewerIdentity | null>(null);
  const [viewerState, setViewerState] = useState<ViewerState>("loading");
  const [viewerServerId, setViewerServerId] = useState<string | null>(null);
  const [signInNotice, setSignInNotice] = useState<string | null>(null);
  const sessionGenerationRef = useRef(0);
  const viewerRefreshGenerationRef = useRef(0);
  const statusRef = useRef(status);
  statusRef.current = status;
  const activeServerRef = useRef(activeServer);
  activeServerRef.current = activeServer;
  const sessionEndInFlightByServerRef = useRef(new Map<string, Promise<void>>());
  const sessionEndCoordinatorRef = useRef<ReturnType<typeof createAuthSessionEndCoordinator> | null>(null);
  if (!sessionEndCoordinatorRef.current) {
    sessionEndCoordinatorRef.current = createAuthSessionEndCoordinator({
      loadStoredBearer: async (serverId) => (await loadTokenSnapshot(serverId)).tokens?.accessToken ?? null,
      releasePushBinding: releasePushBindingForIdentity,
      clearClientBearer: (serverUrl) => { getApiClient(serverUrl).setToken(null); },
      clearViewerCache,
      clearTokens: signOutServer,
    });
  }

  const commitSignedOut = useCallback((notice?: string | null) => {
    sessionGenerationRef.current += 1;
    viewerRefreshGenerationRef.current += 1;
    statusRef.current = "signed-out";
    if (notice !== undefined) setSignInNotice(notice);
    setViewer(null);
    setViewerState("none");
    setViewerServerId(null);
    setStatus("signed-out");
  }, []);

  const applyAuthRecovery = useCallback((input: {
    hasDurablyConfirmedOwner: boolean;
    cleanupFailed: boolean;
  }) => {
    const decision = decideAuthRecovery(input);
    statusRef.current = decision.status;
    setStatus(decision.status);
    setViewerState(decision.viewerState);
    if (decision.clearViewer) {
      setViewer(null);
      setViewerServerId(null);
    }
    setSignInNotice(decision.notice);
  }, []);

  const toViewer = useCallback((whoami: WhoamiResponse): ViewerIdentity | null => {
    if (!whoami.sessionUserId || !whoami.sessionActorId) return null;
    const displayName = whoami.displayName?.trim() || whoami.handle?.trim();
    return {
      userId: whoami.sessionUserId,
      actorId: whoami.sessionActorId,
      ...(whoami.handle?.trim() ? { handle: whoami.handle.trim() } : {}),
      ...(displayName ? { displayName } : {}),
      capabilities: whoami.capabilities,
    };
  }, []);

  const recordVerifiedTokenOwner = useCallback(async (
    serverId: string,
    bearerToken: string,
    nextViewer: ViewerIdentity,
  ): Promise<boolean> => confirmVerifiedTokenOwner(
    serverId,
    bearerToken,
    nextViewer.userId,
  ), []);

  /**
   * One identity-loss path: revoke the exact binding while its old bearer is
   * still available, or durably retain only the revoke proof before any
   * token/viewer deletion.  It deliberately touches just this server.
   */
  const clearPersistedSession = useCallback(async (
    server: typeof activeServer,
    bearerToken: string | null | undefined,
  ) => {
    if (!server) return;
    const id = serverIdFromUrl(server.serverUrl);
    await sessionEndCoordinatorRef.current!.end({
      serverId: id,
      serverUrl: server.serverUrl,
      // Keep the in-memory bearer available until the exact-binding request
      // or proof tombstone has committed. This prevents logout from
      // degrading immediately into unauthenticated cleanup.
      bearerToken,
    });
  }, []);

  const refreshViewer = useCallback(async (): Promise<ViewerRefreshResult> => {
    const server = activeServerRef.current;
    if (!server) return "failed";
    const sessionGeneration = sessionGenerationRef.current;
    const refreshGeneration = ++viewerRefreshGenerationRef.current;
    const isCurrent = () =>
      sessionGenerationRef.current === sessionGeneration &&
      viewerRefreshGenerationRef.current === refreshGeneration &&
      activeServerRef.current?.id === server.id;
    const serverId = serverIdFromUrl(server.serverUrl);
    try {
      const token = await ensureValidToken(serverId, server.serverUrl);
      if (!isCurrent()) return "stale";
      if (!token) {
        await clearPersistedSession(server, null);
        if (!isCurrent()) return "stale";
        commitSignedOut("Your session ended. Sign in again.");
        return "failed";
      }
      const client = getApiClient(server.serverUrl);
      // `whoami()` intentionally does not invoke the async token provider; its
      // callers must latch a fresh bearer first (api-client contract).
      client.setToken(token);
      const next = toViewer(await client.whoami());
      if (!isCurrent()) return "stale";
      if (!next) {
        await clearPersistedSession(server, token);
        if (!isCurrent()) return "stale";
        commitSignedOut("Your session ended. Sign in again.");
        return "failed";
      }
      if (!await recordVerifiedTokenOwner(serverId, token, next)) {
        if (!isCurrent()) return "stale";
        await clearPersistedSession(server, token);
        if (!isCurrent()) return "stale";
        commitSignedOut("Your session could not be verified. Sign in again.");
        return "failed";
      }
      if (!isCurrent()) return "stale";
      setViewer(next);
      setViewerState("verified");
      setViewerServerId(server.id);
      statusRef.current = "signed-in";
      setStatus("signed-in");
      void writeViewerCache(serverId, next);
      return "verified";
    } catch {
      if (!isCurrent()) return "stale";
      const snapshot = await loadTokenSnapshot(serverId).catch(() => null);
      if (!isCurrent()) return "stale";
      applyAuthRecovery({
        hasDurablyConfirmedOwner: hasDurablyConfirmedOwner(snapshot?.tokens?.userId),
        cleanupFailed: false,
      });
      return "failed";
    }
  }, [applyAuthRecovery, clearPersistedSession, commitSignedOut, recordVerifiedTokenOwner, toViewer]);

  // Re-evaluate whenever the active server changes. Hydrate this server's
  // identity cache before whoami so switching back preserves its own viewer.
  useEffect(() => {
    let cancelled = false;
    const sessionGeneration = ++sessionGenerationRef.current;
    viewerRefreshGenerationRef.current += 1;
    setSignInNotice(null);
    const isCurrent = () =>
      !cancelled &&
      sessionGenerationRef.current === sessionGeneration &&
      activeServerRef.current?.id === activeServer?.id;
    async function evaluate() {
      if (!activeServer) {
        if (isCurrent()) {
          statusRef.current = "signed-out";
          commitSignedOut(null);
        }
        return;
      }
      statusRef.current = "loading";
      setStatus("loading");
      setViewer(null);
      setViewerState("loading");
      setViewerServerId(activeServer.id);
      const id = serverIdFromUrl(activeServer.serverUrl);
      let hasConfirmedOwner = false;
      let cleanupAttempted = false;
      try {
        // Read the durable ownership fence before advisory viewer cache data:
        // a cache I/O failure must not demote a previously confirmed Human to
        // an indefinite/loading or misleading signed-out state.
        const stored = await loadTokenSnapshot(id);
        const hadStoredSession = stored.tokens !== null;
        hasConfirmedOwner = hasDurablyConfirmedOwner(stored.tokens?.userId);
        const cached = await readViewerCache(id);
        if (isCurrent() && cached) {
          setViewer(cached);
          setViewerState("cached");
        }
        if (!isCurrent()) return;
        const token = await ensureValidToken(id, activeServer.serverUrl);
        if (!token) {
          if (isCurrent()) {
            cleanupAttempted = true;
            await clearPersistedSession(activeServer, null);
            if (!isCurrent()) return;
            commitSignedOut(hadStoredSession ? "Your session ended. Sign in again." : null);
          }
          return;
        }
        const client = getApiClient(activeServer.serverUrl);
        // Keep cold-start identity verification authenticated. `whoami()` uses
        // the already-latched bearer by contract and does not refresh it itself.
        client.setToken(token);
        if (!isCurrent()) return;
        const next = toViewer(await client.whoami());
        if (!isCurrent()) return;
        if (!next) {
          cleanupAttempted = true;
          await clearPersistedSession(activeServer, token);
          if (!isCurrent()) return;
          commitSignedOut("Your session ended. Sign in again.");
          return;
        }
        if (!await recordVerifiedTokenOwner(id, token, next)) {
          if (!isCurrent()) return;
          cleanupAttempted = true;
          await clearPersistedSession(activeServer, token);
          if (!isCurrent()) return;
          commitSignedOut("Your session could not be verified. Sign in again.");
          return;
        }
        if (!isCurrent()) return;
        statusRef.current = "signed-in";
        setStatus("signed-in");
        setViewer(next);
        setViewerState("verified");
        setViewerServerId(activeServer.id);
        void writeViewerCache(id, next);
      } catch {
        if (isCurrent()) {
          applyAuthRecovery({
            hasDurablyConfirmedOwner: hasConfirmedOwner,
            cleanupFailed: cleanupAttempted,
          });
        }
      }
    }
    void evaluate();
    return () => {
      cancelled = true;
    };
  }, [activeServer, applyAuthRecovery, clearPersistedSession, commitSignedOut, recordVerifiedTokenOwner]);

  const signIn = useCallback<AuthValue["signIn"]>(async () => {
    if (!activeServer) return "No active server.";
    const server = activeServer;
    const sessionGeneration = ++sessionGenerationRef.current;
    viewerRefreshGenerationRef.current += 1;
    setSignInNotice(null);
    let signInClient: ReturnType<typeof getApiClient> | null = null;
    let priorToken: string | null = null;
    let committedNewIdentity = false;
    try {
      const id = serverIdFromUrl(server.serverUrl);
      const snapshot = await loadTokenSnapshot(id);
      priorToken = snapshot.tokens?.accessToken ?? null;
      const bundle = await signInToServer(id, server.serverUrl);
      if (
        sessionGenerationRef.current !== sessionGeneration ||
        activeServerRef.current?.id !== server.id
      ) return "The active server changed during sign-in. Try again.";
      signInClient = getApiClient(server.serverUrl);
      signInClient.setToken(bundle.accessToken);
      const next = toViewer(await signInClient.whoami());
      if (!next) throw new Error("Sign-in did not produce a verified Nautilo identity.");
      if (
        sessionGenerationRef.current !== sessionGeneration ||
        activeServerRef.current?.id !== server.id
      ) return "The active server changed during sign-in. Try again.";
      // If interactive auth verified a different Human for this same server,
      // release the old Human's exact binding while its old bearer still
      // exists. The lifecycle either receives a 204 or persists a proof-only
      // tombstone before B's credential is allowed to replace A's locally.
      await releasePushBindingForIdentity({
        serverId: id,
        serverUrl: server.serverUrl,
        bearerToken: priorToken,
        nextOwnerUserId: next.userId,
      });
      if (
        sessionGenerationRef.current !== sessionGeneration ||
        activeServerRef.current?.id !== server.id
      ) return "The active server changed during sign-in. Try again.";
      // A verified, still-current interactive login supersedes any older
      // background refresh. `saveTokens` advances the storage revision before
      // joining the mutation queue, so an in-flight refresh cannot win.
      await saveTokens(id, { ...bundle, userId: next.userId });
      committedNewIdentity = true;
      if (
        sessionGenerationRef.current !== sessionGeneration ||
        activeServerRef.current?.id !== server.id
      ) throw new Error("The current server or session changed during sign-in.");
      statusRef.current = "signed-in";
      setStatus("signed-in");
      setViewer(next);
      setViewerState("verified");
      setViewerServerId(server.id);
      void writeViewerCache(id, next);
      return null;
    } catch (e) {
      if (signInClient) signInClient.setToken(priorToken);
      if (
        sessionGenerationRef.current !== sessionGeneration ||
        activeServerRef.current?.id !== server.id
      ) return e instanceof Error ? e.message : "Sign-in failed";
      // A failed account-switch cleanup must leave the old account's
      // credential and viewer intact. Treating a failed B login as an A
      // logout would both lie to the UI and strand its revocation proof.
      if (priorToken && !committedNewIdentity) {
        return e instanceof Error ? e.message : "Sign-in failed";
      }
      await clearViewerCache(serverIdFromUrl(server.serverUrl));
      commitSignedOut(null);
      return e instanceof Error ? e.message : "Sign-in failed";
    }
  }, [activeServer, commitSignedOut, toViewer]);

  const registerInvite = useCallback<AuthValue["registerInvite"]>(async ({
    serverId,
    serverUrl,
    handle,
    isCurrent,
  }) => {
    if (!isCurrent()) return "stale";
    const active = activeServerRef.current;
    if (!active || active.serverUrl !== serverUrl || serverIdFromUrl(serverUrl) !== serverId) {
      return "server-mismatch";
    }

    let bundle: Awaited<ReturnType<typeof signInToServer>>;
    try {
      bundle = await signInToServer(serverId, serverUrl, {
        mode: { kind: "invite-registration", loginHint: handle },
      });
    } catch (error) {
      // This flow must not pass provider text to the ceremony UI.
      if (error instanceof NativeAuthError) throw error;
      throw new NativeAuthError("exchange-failed");
    }

    if (activeServerRef.current?.serverUrl !== serverUrl || !isCurrent()) return "stale";
    // A prepared invite deliberately has no local Nautilo Human yet; do not
    // call whoami or start push binding before the canonical bind route.
    await saveTokens(serverId, bundle);
    if (activeServerRef.current?.serverUrl === serverUrl && isCurrent()) {
      getApiClient(serverUrl).setToken(bundle.accessToken);
      return "completed";
    }

    // A late browser result can only clear the exact bundle it wrote.
    const stored = (await loadTokenSnapshot(serverId)).tokens;
    if (stored?.accessToken === bundle.accessToken && stored.refreshToken === bundle.refreshToken) {
      await signOutServer(serverId);
    }
    return "stale";
  }, []);

  const clearInviteRegistration = useCallback<AuthValue["clearInviteRegistration"]>(async ({
    serverId,
    serverUrl,
    isCurrent,
  }) => {
    if (!isCurrent()) return "stale";
    const active = activeServerRef.current;
    if (!active || active.serverUrl !== serverUrl || serverIdFromUrl(serverUrl) !== serverId) {
      return "server-mismatch";
    }
    getApiClient(serverUrl).setToken(null);
    await clearViewerCache(serverId);
    if (!isCurrent()) return "stale";
    await signOutServer(serverId);
    return isCurrent() ? "cleared" : "stale";
  }, []);

  const reauthenticate = useCallback<AuthValue["reauthenticate"]>(async () => {
    if (!activeServer || viewerServerId !== activeServer.id || !viewer) {
      throw new Error("A verified signed-in identity is required before reauthentication.");
    }
    const server = activeServer;
    const sessionGeneration = ++sessionGenerationRef.current;
    viewerRefreshGenerationRef.current += 1;
    const expectedViewer = viewer;
    const serverId = serverIdFromUrl(server.serverUrl);
    let priorToken: string | null = null;
    try {
      // Keep the currently committed bearer available for restoration if the
      // fresh exchange cannot be verified or cannot be committed.
      priorToken = await ensureValidToken(serverId, server.serverUrl);
      if (!priorToken) {
        throw new Error("The current session is no longer valid.");
      }
      const snapshot = await loadTokenSnapshot(serverId);
      if (!snapshot.tokens || snapshot.tokens.accessToken !== priorToken) {
        throw new Error("The current session changed during reauthentication.");
      }
      const bundle = await reauthenticateToServer(serverId, server.serverUrl);
      if (
        sessionGenerationRef.current !== sessionGeneration ||
        activeServerRef.current?.id !== server.id
      ) {
        throw new Error("Active server changed during reauthentication.");
      }

      // Verify with the newly exchanged bearer before the Settings fence can
      // resume anything. The bundle is intentionally unpersisted until this
      // same-server/same-viewer check and the explicit commit below succeed.
      const client = getApiClient(server.serverUrl);
      client.setToken(bundle.accessToken);
      const next = toViewer(await client.whoami());
      if (
        !next ||
        next.userId !== expectedViewer.userId ||
        next.actorId !== expectedViewer.actorId
      ) {
        throw new Error("Reauthentication confirmed a different account.");
      }
      if (
        sessionGenerationRef.current !== sessionGeneration ||
        activeServerRef.current?.id !== server.id
      ) {
        throw new Error("Active server changed during reauthentication.");
      }

      // Fresh, same-viewer interactive auth is authoritative over an older
      // silent refresh. Session generation still lets sign-out/server switch
      // cancel this operation before any commit.
      await saveTokens(serverId, { ...bundle, userId: next.userId });
      if (
        sessionGenerationRef.current !== sessionGeneration ||
        activeServerRef.current?.id !== server.id
      ) {
        throw new Error("The current session changed during reauthentication.");
      }
      setViewer(next);
      setViewerState("verified");
      setViewerServerId(server.id);
      void writeViewerCache(serverId, next);
      return { serverId: server.id, userId: next.userId, actorId: next.actorId };
    } catch (e) {
      // Fresh-auth cancellation or verification failure must preserve the
      // committed session. Restore the API client's latched bearer as well as
      // retaining the untouched SecureStore bundle.
      if (
        priorToken &&
        sessionGenerationRef.current === sessionGeneration &&
        activeServerRef.current?.id === server.id
      ) {
        getApiClient(server.serverUrl).setToken(priorToken);
      }
      // The caller's reauth fence discards the sensitive action on this error.
      throw e instanceof Error ? e : new Error("Reauthentication failed");
    }
  }, [activeServer, toViewer, viewer, viewerServerId]);

  const beginReauthentication = useCallback<AuthValue["beginReauthentication"]>(async () => {
    await reauthenticate();
  }, [reauthenticate]);

  const endActiveSession = useCallback(async (
    server: typeof activeServer,
    notice: string | null,
  ): Promise<void> => {
    if (!server) {
      commitSignedOut(notice);
      return;
    }
    const id = serverIdFromUrl(server.serverUrl);
    const existing = sessionEndInFlightByServerRef.current.get(id);
    if (existing) return existing;
    const sessionGeneration = ++sessionGenerationRef.current;
    viewerRefreshGenerationRef.current += 1;
    const operation = (async () => {
      await clearPersistedSession(server, undefined);
      if (
        sessionGenerationRef.current === sessionGeneration
        && activeServerRef.current?.id === server.id
      ) {
        commitSignedOut(notice);
      }
    })();
    sessionEndInFlightByServerRef.current.set(id, operation);
    void operation.finally(() => {
      if (sessionEndInFlightByServerRef.current.get(id) === operation) {
        sessionEndInFlightByServerRef.current.delete(id);
      }
    }).catch(() => {});
    return operation;
  }, [clearPersistedSession, commitSignedOut]);

  const signOut = useCallback<AuthValue["signOut"]>(async () => {
    await endActiveSession(activeServerRef.current, null);
  }, [endActiveSession]);

  const commitAccountDeleted = useCallback<AuthValue["commitAccountDeleted"]>(async () => {
    const server = activeServerRef.current;
    if (!server) return;
    const serverId = serverIdFromUrl(server.serverUrl);
    // The canonical server cascade has already removed the push binding. Do
    // not attempt an authenticated revoke with credentials that are now dead.
    getApiClient(server.serverUrl).setToken(null);
    await Promise.allSettled([
      clearViewerCache(serverId),
      signOutServer(serverId),
    ]);
    await remove(server.id);
    // The durable non-secret receipt is removed only after the registry's
    // scoped removal succeeds. A failed removal leaves it for recovery after
    // process death, while other saved servers retain their own receipts.
    await clearAccountDeletionAttempt({
      serverId,
      serverUrl: server.serverUrl,
    }).catch(() => {});
    commitSignedOut(null);
  }, [commitSignedOut, remove]);

  // D398 — the api-client raises auth-dead when a token can no longer be
  // refreshed (expired access + dead/absent refresh). Sign out so the central
  // RootShell gate redirects to login, instead of leaving the user on a screen
  // that silently fails every authed request.
  useEffect(() => {
    return onAuthDead((serverId) => {
      const server = activeServerRef.current;
      if (!server) return;
      if (!shouldHandleAuthDead({
        activeServerId: serverIdFromUrl(server.serverUrl),
        rejectedServerId: serverId,
        authStatus: statusRef.current,
      })) return;
      // The old bearer remains available only until exact-binding revoke or
      // proof-tombstone persistence completes. Per-server coalescing prevents
      // concurrent failed requests from racing that ordering.
      void endActiveSession(server, "Your session ended. Sign in again.").catch(() => {
        if (activeServerRef.current?.id === server.id) setViewerState("stale");
      });
    });
  }, [endActiveSession]);

  const visibleViewer =
    viewerServerId === activeServer?.id ? viewer : null;
  const visibleViewerState: ViewerState =
    viewerServerId === activeServer?.id
      ? viewerState
      : activeServer
        ? "loading"
        : "none";

  const value = useMemo<AuthValue>(
    () => ({
      status,
      signInNotice,
      viewer: visibleViewer,
      viewerState: visibleViewerState,
      refreshViewer,
      signIn,
      registerInvite,
      clearInviteRegistration,
      reauthenticate,
      beginReauthentication,
      commitAccountDeleted,
      signOut,
    }),
    [status, signInNotice, visibleViewer, visibleViewerState, refreshViewer, signIn, registerInvite, clearInviteRegistration, reauthenticate, beginReauthentication, commitAccountDeleted, signOut],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
