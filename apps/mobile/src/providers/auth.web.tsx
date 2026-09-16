import { NautiloApiClient } from "@nautilo/api-client/browser";
import type { WhoamiResponse } from "@nautilo/types";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

import { getApiClient } from "@/lib/api";
import {
  clearBrowserAuthSession,
  createBrowserAuthExclusiveRunner,
  ensureValidToken,
  installBrowserAuth,
  signOutServer,
} from "@/lib/auth.web";
import { onAuthDead } from "@/lib/auth-events";
import { mobileWebAuthBootstrap } from "@/lib/browser-auth-contract";
import {
  MobileWebAuthSession,
  MobileWebCallbackError,
  NautiloMobileWebLogtoClient,
} from "@/lib/browser-auth-session";
import { serverIdFromUrl } from "@/lib/server-store.web";
import type { SettingsReauthIdentity } from "@/lib/settings-reauth";
import { failedMobileWebSignInPath } from "@/lib/auth-gate-navigation";
import { settingsVerificationIncompletePath } from "@/lib/settings-reauth-navigation";
import {
  clearViewerCache,
  writeViewerCache,
  type CachedViewer,
} from "@/lib/viewer-cache";
import { useServers } from "@/providers/server-registry";

type AuthStatus = "loading" | "signed-in" | "signed-out";
export type ViewerState = "loading" | "cached" | "verified" | "stale" | "none";
export type ViewerIdentity = CachedViewer;
export type ViewerRefreshResult = "verified" | "failed" | "stale";

interface AuthValue {
  status: AuthStatus;
  signInNotice: string | null;
  viewer: ViewerIdentity | null;
  viewerState: ViewerState;
  refreshViewer: () => Promise<ViewerRefreshResult>;
  signIn: (returnPath?: string | null) => Promise<string | null>;
  registerInvite: (input: Readonly<{
    serverId: string;
    serverUrl: string;
    handle: string;
    isCurrent: () => boolean;
  }>) => Promise<"completed" | "stale" | "server-mismatch">;
  clearInviteRegistration: (input: Readonly<{
    serverId: string;
    serverUrl: string;
    isCurrent: () => boolean;
  }>) => Promise<"cleared" | "stale" | "server-mismatch">;
  reauthenticate: () => Promise<SettingsReauthIdentity>;
  beginReauthentication: (returnPath: string) => Promise<void>;
  commitAccountDeleted: () => Promise<void>;
  signOut: () => Promise<void>;
}

interface ActiveBrowserSession {
  readonly serverId: string;
  readonly serverUrl: string;
  readonly appId: string;
  readonly session: MobileWebAuthSession;
  readonly uninstall: () => void;
}

const AuthContext = createContext<AuthValue | null>(null);

export function browserViewerFromWhoami(whoami: WhoamiResponse): ViewerIdentity | null {
  if (!whoami.sessionUserId || !whoami.sessionActorId) return null;
  const displayName = whoami.displayName?.trim() || whoami.handle?.trim();
  return {
    userId: whoami.sessionUserId,
    actorId: whoami.sessionActorId,
    ...(whoami.handle?.trim() ? { handle: whoami.handle.trim() } : {}),
    ...(displayName ? { displayName } : {}),
    capabilities: whoami.capabilities,
  };
}

function currentReturnPath(): string {
  if (typeof window === "undefined") return "/mobile";
  return `${window.location.pathname}${window.location.search}${window.location.hash}`;
}

function lockManager(): Parameters<typeof createBrowserAuthExclusiveRunner>[1] {
  if (typeof navigator === "undefined" || !("locks" in navigator)) return null;
  return navigator.locks;
}

function callbackNotice(error: unknown): string {
  if (error instanceof MobileWebCallbackError) {
    if (error.code === "callback-session-missing") {
      return "That sign-in link is expired or was already used. Start sign-in again.";
    }
    return "Sign-in could not be completed. Start sign-in again.";
  }
  return "Mobile Web authentication is unavailable on this server.";
}

export function AuthProvider({ children }: { readonly children: ReactNode }) {
  const { activeServer, remove } = useServers();
  const [status, setStatus] = useState<AuthStatus>("loading");
  const [signInNotice, setSignInNotice] = useState<string | null>(null);
  const [viewer, setViewer] = useState<ViewerIdentity | null>(null);
  const [viewerState, setViewerState] = useState<ViewerState>("loading");
  const generationRef = useRef(0);
  const activeSessionRef = useRef<ActiveBrowserSession | null>(null);

  const detachSession = useCallback(() => {
    activeSessionRef.current?.uninstall();
    activeSessionRef.current = null;
  }, []);

  const commitSignedOut = useCallback((notice: string | null) => {
    generationRef.current += 1;
    setStatus("signed-out");
    setSignInNotice(notice);
    setViewer(null);
    setViewerState("none");
  }, []);

  const verifyViewer = useCallback(async (
    owner: ActiveBrowserSession,
    generation: number,
  ): Promise<ViewerRefreshResult> => {
    const isCurrent = () => generationRef.current === generation
      && activeSessionRef.current === owner;
    const token = await ensureValidToken(owner.serverId, owner.serverUrl);
    if (!isCurrent()) return "stale";
    if (!token) {
      await clearBrowserAuthSession(owner.serverId).catch(() => {});
      if (!isCurrent()) return "stale";
      getApiClient(owner.serverUrl).setToken(null);
      await clearViewerCache(owner.serverId);
      if (!isCurrent()) return "stale";
      commitSignedOut("Your session ended. Sign in again.");
      return "failed";
    }
    try {
      const verificationClient = new NautiloApiClient(owner.serverUrl);
      verificationClient.setToken(token);
      const next = browserViewerFromWhoami(await verificationClient.whoami());
      if (!isCurrent()) return "stale";
      if (!next) {
        await clearBrowserAuthSession(owner.serverId);
        if (!isCurrent()) return "stale";
        getApiClient(owner.serverUrl).setToken(null);
        await clearViewerCache(owner.serverId);
        if (!isCurrent()) return "stale";
        commitSignedOut("Your session could not be verified. Sign in again.");
        return "failed";
      }
      getApiClient(owner.serverUrl).setToken(token);
      setViewer(next);
      setViewerState("verified");
      setSignInNotice(null);
      setStatus("signed-in");
      void writeViewerCache(owner.serverId, next);
      return "verified";
    } catch {
      if (!isCurrent()) return "stale";
      setViewerState((current) => current === "verified" ? "stale" : "none");
      setStatus((current) => current === "signed-in" ? current : "signed-out");
      setSignInNotice("Nautilo could not verify your session. Check the connection and try again.");
      return "failed";
    }
  }, [commitSignedOut]);

  const refreshViewer = useCallback<AuthValue["refreshViewer"]>(async () => {
    const owner = activeSessionRef.current;
    if (!owner) return "failed";
    return verifyViewer(owner, generationRef.current);
  }, [verifyViewer]);

  useEffect(() => {
    const generation = ++generationRef.current;
    detachSession();
    setStatus("loading");
    setViewer(null);
    setViewerState("loading");
    setSignInNotice(null);
    if (!activeServer) {
      setStatus("signed-out");
      setViewerState("none");
      return;
    }
    getApiClient(activeServer.serverUrl).setToken(null);
    if (typeof window === "undefined") {
      setStatus("signed-out");
      setViewerState("none");
      setSignInNotice("Mobile Web authentication requires a browser.");
      return;
    }

    let cancelled = false;
    let removeStorageListener = () => {};
    void (async () => {
      try {
        const health = await new NautiloApiClient(activeServer.serverUrl).getHealth();
        if (cancelled || generationRef.current !== generation) return;
        const bootstrap = mobileWebAuthBootstrap(health, window.location.origin);
        if (!bootstrap) {
          setStatus("signed-out");
          setViewerState("none");
          setSignInNotice("This server has not enabled Mobile Web sign-in yet.");
          return;
        }
        const serverId = serverIdFromUrl(activeServer.serverUrl);
        if (serverId !== activeServer.id) throw new Error("active-server-origin-mismatch");
        const client = new NautiloMobileWebLogtoClient(bootstrap.logto);
        const session = new MobileWebAuthSession({
          client,
          bootstrap,
          location: window.location,
          history: window.history,
        });
        const owner: ActiveBrowserSession = {
          serverId,
          serverUrl: activeServer.serverUrl,
          appId: bootstrap.logto.appId,
          session,
          uninstall: () => {},
        };
        const uninstall = installBrowserAuth({
          serverId,
          serverOrigin: new URL(activeServer.serverUrl).origin,
          session,
          runExclusive: createBrowserAuthExclusiveRunner(bootstrap.logto.appId, lockManager()),
        });
        const installedOwner: ActiveBrowserSession = { ...owner, uninstall };
        activeSessionRef.current = installedOwner;

        const storagePrefix = `logto:${bootstrap.logto.appId}:`;
        const onStorage = (event: StorageEvent) => {
          if (event.storageArea !== window.localStorage || !event.key?.startsWith(storagePrefix)) return;
          const current = activeSessionRef.current;
          if (!current || current.appId !== bootstrap.logto.appId) return;
          void current.session.isAuthenticated().then((authenticated) => {
            if (activeSessionRef.current !== current) return;
            if (authenticated) void verifyViewer(current, generationRef.current);
            else {
              getApiClient(current.serverUrl).setToken(null);
              void clearViewerCache(current.serverId);
              commitSignedOut("Your session changed in another tab. Sign in again.");
            }
          });
        };
        window.addEventListener("storage", onStorage);
        removeStorageListener = () => window.removeEventListener("storage", onStorage);

        try {
          await session.initialize();
        } catch (error) {
          // A failed step-up must not destroy an otherwise valid signed-in
          // session. Primary sign-in failures have no authenticated session and
          // continue through the ordinary signed-out recovery below.
          const authenticated = error instanceof MobileWebCallbackError
            && await session.isAuthenticated().catch(() => false);
          if (!authenticated) throw error;
          const recovered = await verifyViewer(installedOwner, generation);
          if (recovered !== "verified") throw error;
          setSignInNotice("Verification did not finish. Nothing changed.");
          window.location.replace(settingsVerificationIncompletePath());
          return;
        }
        if (cancelled || generationRef.current !== generation || activeSessionRef.current !== installedOwner) return;
        if (!await session.isAuthenticated()) {
          getApiClient(installedOwner.serverUrl).setToken(null);
          await clearViewerCache(installedOwner.serverId);
          setStatus("signed-out");
          setViewerState("none");
          return;
        }
        await verifyViewer(installedOwner, generation);
      } catch (error) {
        if (cancelled || generationRef.current !== generation) return;
        detachSession();
        setStatus("signed-out");
        setViewer(null);
        setViewerState("none");
        setSignInNotice(callbackNotice(error));
        if (error instanceof MobileWebCallbackError) {
          window.location.replace(failedMobileWebSignInPath(error.returnPath));
        }
      }
    })();

    return () => {
      cancelled = true;
      removeStorageListener();
      if (generationRef.current === generation) generationRef.current += 1;
      detachSession();
    };
  }, [activeServer, commitSignedOut, detachSession, verifyViewer]);

  useEffect(() => onAuthDead((serverId) => {
    const owner = activeSessionRef.current;
    if (!owner || owner.serverId !== serverId) return;
    void clearBrowserAuthSession(owner.serverId).catch(() => {});
    getApiClient(owner.serverUrl).setToken(null);
    void clearViewerCache(serverId);
    commitSignedOut("Your session ended. Sign in again.");
  }), [commitSignedOut]);

  const signIn = useCallback<AuthValue["signIn"]>(async (returnPath) => {
    const owner = activeSessionRef.current;
    if (!owner) return signInNotice ?? "Mobile Web sign-in is unavailable.";
    setSignInNotice(null);
    try {
      await owner.session.signIn(returnPath ?? currentReturnPath());
      return null;
    } catch {
      return "Sign-in could not be started. Check the connection and try again.";
    }
  }, [signInNotice]);

  const signOut = useCallback(async () => {
    const owner = activeSessionRef.current;
    if (!owner) {
      commitSignedOut(null);
      return;
    }
    getApiClient(owner.serverUrl).setToken(null);
    await clearViewerCache(owner.serverId);
    commitSignedOut(null);
    await signOutServer(owner.serverId);
  }, [commitSignedOut]);

  const commitAccountDeleted = useCallback<AuthValue["commitAccountDeleted"]>(async () => {
    const owner = activeSessionRef.current;
    const server = activeServer;
    if (!owner || !server) return;
    getApiClient(owner.serverUrl).setToken(null);
    await Promise.allSettled([
      clearViewerCache(owner.serverId),
      signOutServer(owner.serverId),
    ]);
    await remove(server.id);
    // Native persists a pre-DELETE AsyncStorage receipt and can recover local
    // removal after process death. Mobile Web reauthentication is a full-page
    // redirect and has no safe replay continuation yet, so do not add native
    // receipt behavior here merely because this interface is shared.
    commitSignedOut(null);
  }, [activeServer, commitSignedOut, remove]);

  const beginReauthentication = useCallback<AuthValue["beginReauthentication"]>(async (returnPath) => {
    const owner = activeSessionRef.current;
    if (!owner || !viewer || status !== "signed-in") {
      throw new Error("A verified signed-in identity is required before reauthentication.");
    }
    await owner.session.signIn(returnPath);
  }, [status, viewer]);

  const reauthenticate = useCallback<AuthValue["reauthenticate"]>(async () => {
    await beginReauthentication(currentReturnPath());
    // Full-page browser reauthentication resumes from the callback. Never
    // authorize the fenced mutation from the pre-redirect process.
    throw new Error("Reauthentication continues in the browser.");
  }, [beginReauthentication]);

  const registerInvite = useCallback<AuthValue["registerInvite"]>((input) =>
    Promise.resolve(input.isCurrent() ? "server-mismatch" : "stale"), []);
  const clearInviteRegistration = useCallback<AuthValue["clearInviteRegistration"]>(async (input) => {
    if (!input.isCurrent()) return "stale";
    const owner = activeSessionRef.current;
    if (!owner || owner.serverId !== input.serverId || owner.serverUrl !== input.serverUrl) {
      return "server-mismatch";
    }
    await clearBrowserAuthSession(owner.serverId);
    getApiClient(owner.serverUrl).setToken(null);
    await clearViewerCache(owner.serverId);
    commitSignedOut(null);
    return input.isCurrent() ? "cleared" : "stale";
  }, [commitSignedOut]);

  const value = useMemo<AuthValue>(() => ({
    status,
    signInNotice,
    viewer,
    viewerState,
    refreshViewer,
    signIn,
    registerInvite,
    clearInviteRegistration,
    reauthenticate,
    beginReauthentication,
    commitAccountDeleted,
    signOut,
  }), [
    status,
    signInNotice,
    viewer,
    viewerState,
    refreshViewer,
    signIn,
    registerInvite,
    clearInviteRegistration,
    reauthenticate,
    beginReauthentication,
    commitAccountDeleted,
    signOut,
  ]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthValue {
  const value = useContext(AuthContext);
  if (!value) throw new Error("useAuth must be used within AuthProvider");
  return value;
}
