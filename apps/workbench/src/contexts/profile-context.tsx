import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  PROFILE_AVATAR_URL,
  SHELL_AGENT_NAME,
  SHELL_AVATAR_REF,
  type AgentProfileResponse,
} from "@nautilo/types";
import { apiClient } from "../lib/api";
import { fetchAvatarObjectUrl } from "../components/avatar/authenticated-image";
import { desktopAPI, isDesktop } from "../lib/desktop";
import { useAuth } from "../hooks/use-auth";
import {
  addAuthTransitionListener,
  shouldIgnoreCredentialOnlyTransition,
} from "../lib/auth-transition";

const SHELL_PROFILE: AgentProfileResponse = {
  viewerRole: "guest",
  agent: {
    name: SHELL_AGENT_NAME,
    avatar: SHELL_AVATAR_REF,
    avatarUrl: PROFILE_AVATAR_URL,
  },
};

const SHELL_AVATAR_SRC = `data:image/svg+xml;utf8,${encodeURIComponent(
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128" role="img" aria-label="Genie shell avatar"><rect width="128" height="128" rx="24" fill="#101820"/><text x="64" y="79" text-anchor="middle" font-size="58" font-family="Apple Color Emoji, Segoe UI Emoji, sans-serif">🐚</text></svg>`,
)}`;

export interface ProfileContextValue {
  response: AgentProfileResponse | null;
  agent: AgentProfileResponse["agent"] | null;
  avatarSrc: string;
  avatarLoading: boolean;
  avatarError: Error | null;
  loading: boolean;
  error: Error | null;
  refresh: () => Promise<void>;
}

const ProfileContext = createContext<ProfileContextValue | null>(null);

function queryFlag(name: string): boolean {
  if (typeof window === "undefined") return false;
  const value = new URLSearchParams(window.location.search).get(name);
  return value === "1" || value === "true";
}

function profileDiagnosticsEnabled(): boolean {
  return (
    (import.meta.env.DEV && import.meta.env.VITE_NAUTILO_PANEL_DIAGNOSTICS === "1") ||
    queryFlag("panelDiagnostics")
  );
}

function logProfileTiming(
  event: string,
  startedAt: number,
  extra: Record<string, unknown> = {},
): void {
  if (!profileDiagnosticsEnabled()) return;
  console.info("[d242][profile]", JSON.stringify({
    event,
    elapsedMs: Math.round(performance.now() - startedAt),
    ...extra,
  }));
}

export function shouldDeferShellProfileOnMissingToken(input: {
  viewerIsVerified: boolean;
  sessionState: string;
}): boolean {
  return input.viewerIsVerified && input.sessionState !== "signed-out";
}

export function ProfileProvider({ children }: { children: ReactNode }) {
  const auth = useAuth();
  const [response, setResponse] = useState<AgentProfileResponse | null>(
    auth.viewer.isVerified ? null : SHELL_PROFILE,
  );
  const [loading, setLoading] = useState(auth.viewer.isVerified);
  const [error, setError] = useState<Error | null>(null);
  const [avatarSrc, setAvatarSrc] = useState(SHELL_AVATAR_SRC);
  const [avatarLoading, setAvatarLoading] = useState(false);
  const [avatarError, setAvatarError] = useState<Error | null>(null);
  const [tokenRetryTick, setTokenRetryTick] = useState(0);
  const avatarObjectUrlRef = useRef<string | null>(null);
  const requestIdRef = useRef(0);
  const refreshInflightRef = useRef<Promise<void> | null>(null);
  const lastProcessedViewerGenerationRef = useRef<number | null>(null);

  const setAvatarObjectUrl = useCallback((url: string | null) => {
    if (avatarObjectUrlRef.current) {
      URL.revokeObjectURL(avatarObjectUrlRef.current);
      avatarObjectUrlRef.current = null;
    }
    if (url) {
      avatarObjectUrlRef.current = url;
      setAvatarSrc(url);
    } else {
      setAvatarSrc(SHELL_AVATAR_SRC);
    }
  }, []);

  const setGuestProfile = useCallback(() => {
    requestIdRef.current += 1;
    setResponse(SHELL_PROFILE);
    setAvatarObjectUrl(null);
    setLoading(false);
    setError(null);
    setAvatarLoading(false);
    setAvatarError(null);
  }, [setAvatarObjectUrl]);

  const refreshAvatar = useCallback(async (token: string | null, requestId: number) => {
    const startedAt = performance.now();
    if (!token) {
      setAvatarObjectUrl(null);
      setAvatarLoading(false);
      setAvatarError(null);
      logProfileTiming("avatar:skip-no-token", startedAt, { requestId });
      return;
    }
    setAvatarLoading(true);
    logProfileTiming("avatar:start", startedAt, { requestId });
    try {
      // D243 — the server sends `Cache-Control: private, no-cache` with an
      // ETag keyed on `${blobId}.thumb` (or `.full`), so warm reloads and
      // WS-reconnect refreshes go through the conditional-GET path (304 +
      // empty body). In-session avatar changes invalidate immediately because
      // the new `blobId` yields a new ETag — the `nautilo:profile-changed`
      // listener already re-triggers `refresh` after upload/regenerate.
      //
      // D300 follow-up — the fetch+blob itself now goes through the shared
      // `fetchAvatarObjectUrl` so the workbench has exactly one authenticated
      // avatar fetch implementation. This context keeps its own request-id
      // cancellation + object-URL lifecycle (revoke-on-replace/unmount).
      const result = await fetchAvatarObjectUrl(PROFILE_AVATAR_URL, token);
      logProfileTiming("avatar:response", startedAt, {
        requestId,
        kind: result.kind,
      });
      if (requestId !== requestIdRef.current) {
        if (result.kind === "image") URL.revokeObjectURL(result.objectUrl);
        return;
      }
      if (result.kind === "image") {
        setAvatarObjectUrl(result.objectUrl);
        setAvatarError(null);
        logProfileTiming("avatar:set-object-url", startedAt, { requestId });
      } else {
        // SHELL fallback or fetch failure → inline SHELL avatar.
        setAvatarObjectUrl(null);
        setAvatarError(
          result.kind === "none" ? new Error(`GET ${PROFILE_AVATAR_URL} failed`) : null,
        );
        logProfileTiming("avatar:fallback", startedAt, {
          requestId,
          kind: result.kind,
        });
      }
    } catch (err) {
      if (requestId !== requestIdRef.current) return;
      setAvatarObjectUrl(null);
      setAvatarError(err instanceof Error ? err : new Error("Failed to load avatar"));
      logProfileTiming("avatar:error", startedAt, {
        requestId,
        error: err instanceof Error ? err.message : String(err),
      });
    } finally {
      if (requestId === requestIdRef.current) setAvatarLoading(false);
      logProfileTiming("avatar:finish", startedAt, { requestId });
    }
  }, [setAvatarObjectUrl]);

  const refresh = useCallback(async () => {
    const startedAt = performance.now();
    if (!auth.viewer.isVerified) {
      // Guest projection is synchronous local state, not a network request.
      // Do not publish it through the verified-profile single-flight: during
      // cold auth restoration React can flip the viewer to verified before
      // the guest promise's `finally` clears the ref, causing the real profile
      // refresh to join the completed guest operation and never reach
      // GET /api/profile.
      setGuestProfile();
      logProfileTiming("refresh:guest-profile", startedAt);
      return;
    }
    if (refreshInflightRef.current) return refreshInflightRef.current;
    const run = async (): Promise<void> => {

    const requestId = requestIdRef.current + 1;
    requestIdRef.current = requestId;
    setLoading(true);
    logProfileTiming("refresh:start", startedAt, {
      requestId,
      sessionState: auth.session.state,
    });
    try {
      const token = await auth.session.getAccessToken();
      logProfileTiming("refresh:token", startedAt, {
        requestId,
        hasToken: Boolean(token),
      });
      if (requestId !== requestIdRef.current) return;
      if (!token) {
        if (shouldDeferShellProfileOnMissingToken({
          viewerIsVerified: auth.viewer.isVerified,
          sessionState: auth.session.state,
        })) {
          // A verified viewer can be hydrated from the last-known cache before
          // the Logto SDK finishes restoring tokens. Don't overwrite that
          // verified path with the anonymous shell profile; wait for the
          // session state to settle, then this effect reruns and fetches.
          setLoading(true);
          window.setTimeout(() => {
            if (requestId === requestIdRef.current) {
              setTokenRetryTick((tick) => tick + 1);
            }
          }, 250);
          logProfileTiming("refresh:defer-missing-token", startedAt, { requestId });
          return;
        }
        setGuestProfile();
        logProfileTiming("refresh:fallback-guest", startedAt, { requestId });
        return;
      }
      const data = await apiClient.getProfile();
      logProfileTiming("refresh:profile-response", startedAt, {
        requestId,
        agentName: data.agent.name,
        hasSoulFile: "soulFile" in data.agent && Boolean(data.agent.soulFile),
      });
      if (requestId !== requestIdRef.current) return;
      setResponse(data);
      setError(null);
      setLoading(false);
      logProfileTiming("refresh:profile-ready", startedAt, { requestId });
      void refreshAvatar(token, requestId).then(() => {
        logProfileTiming("refresh:avatar-ready", startedAt, { requestId });
      });
    } catch (err) {
      if (requestId !== requestIdRef.current) return;
      setError(err instanceof Error ? err : new Error("Failed to load profile"));
      setResponse(null);
      setAvatarObjectUrl(null);
      logProfileTiming("refresh:error", startedAt, {
        requestId,
        error: err instanceof Error ? err.message : String(err),
      });
    } finally {
      if (requestId === requestIdRef.current) setLoading(false);
      logProfileTiming("refresh:loading-false", startedAt, { requestId });
    }
    };
    const promise = run().finally(() => {
      if (refreshInflightRef.current === promise) refreshInflightRef.current = null;
    });
    refreshInflightRef.current = promise;
    return promise;
  }, [
    auth.session,
    auth.viewer.isVerified,
    refreshAvatar,
    setAvatarObjectUrl,
    setGuestProfile,
  ]);

  useEffect(() => {
    void refresh();
    const onProfileChanged = (): void => {
      void refresh();
    };
    const removeAuthListener = addAuthTransitionListener((detail) => {
      if (
        shouldIgnoreCredentialOnlyTransition(
          lastProcessedViewerGenerationRef.current,
          detail,
        )
      ) {
        return;
      }
      lastProcessedViewerGenerationRef.current = detail.viewerGeneration;
      void refresh();
    });
    window.addEventListener("nautilo:profile-changed", onProfileChanged);
    return () => {
      removeAuthListener();
      window.removeEventListener("nautilo:profile-changed", onProfileChanged);
    };
  }, [
    refresh,
    tokenRetryTick,
    auth.credentialGeneration,
    auth.viewerGeneration,
  ]);

  useEffect(() => {
    if (!isDesktop || !desktopAPI) return undefined;
    return desktopAPI.onboarding.onCompleted(() => void refresh());
  }, [refresh]);

  useEffect(() => {
    return () => {
      requestIdRef.current += 1;
      if (avatarObjectUrlRef.current) {
        URL.revokeObjectURL(avatarObjectUrlRef.current);
      }
    };
  }, []);

  return (
    <ProfileContext.Provider
      value={{
        response,
        agent: response?.agent ?? null,
        avatarSrc,
        avatarLoading,
        avatarError,
        loading,
        error,
        refresh,
      }}
    >
      {children}
    </ProfileContext.Provider>
  );
}

export function useProfile(): ProfileContextValue {
  const value = useContext(ProfileContext);
  if (!value) {
    throw new Error("useProfile must be used within <ProfileProvider>");
  }
  return value;
}
