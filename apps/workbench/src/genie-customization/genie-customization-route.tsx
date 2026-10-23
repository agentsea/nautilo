import { GenieCustomizationApp, type OnboardingStartAt } from "@nautilo/genie-customization-ui";
import type { AgentProfileResponse } from "@nautilo/types";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { useAuth } from "../hooks/use-auth";
import { useProfile } from "../hooks/use-profile";
import { apiClient } from "../lib/api";
import { roomPath } from "../routes/room-route";
import { resolveOwnedPersonalRoom } from "./personal-room-resolution";
import { createWorkbenchOnboardingApi } from "./workbench-onboarding-api";

const PERSONAL_CHAT_OPEN_ERROR = "Your Genie was saved, but we couldn’t open your Personal chat.";

export function parseCustomizeGenieStartAt(search: string): OnboardingStartAt | null {
  const value = new URLSearchParams(search).get("startAt");
  return value === "personality" || value === "avatar" ? value : null;
}

export function GenieCustomizationRoute(): React.ReactElement {
  const auth = useAuth();
  const profile = useProfile();
  const location = useLocation();
  const startAt = parseCustomizeGenieStartAt(location.search);
  // ProfileProvider refreshes after avatar generation. Keep the successful
  // projection that opened this wizard: replacing it mid-flight would rebuild
  // the adapter and reset the user's in-progress customization.
  const initialProfileRef = useRef<AgentProfileResponse | null>(null);

  if (!initialProfileRef.current && !profile.loading && !profile.error && profile.response) {
    initialProfileRef.current = profile.response;
  }

  if (!initialProfileRef.current && profile.loading) {
    return <GenieCustomizationRouteGate message="Loading your Genie…" />;
  }
  if (!initialProfileRef.current) {
    return <GenieCustomizationRouteGate message="Couldn’t load your Genie profile. Please try again." />;
  }

  return (
    <GenieCustomizationRouteReady
      auth={auth}
      profileResponse={initialProfileRef.current}
      refresh={profile.refresh}
      startAt={startAt}
    />
  );
}

function GenieCustomizationRouteReady({
  auth,
  profileResponse,
  refresh,
  startAt,
}: {
  auth: ReturnType<typeof useAuth>;
  profileResponse: AgentProfileResponse;
  refresh: () => Promise<void>;
  startAt: OnboardingStartAt | null;
}): React.ReactElement {
  const location = useLocation();
  const navigate = useNavigate();
  const sessionRef = useRef(auth.session);
  const authRef = useRef(auth);
  const refreshRef = useRef(refresh);
  const openingViewerRef = useRef({
    sessionUserId: auth.viewer.sessionUserId,
    sessionActorId: auth.viewer.sessionActorId,
  });
  const mountedRef = useRef(true);
  const personalChatOperationRef = useRef(0);
  const [personalChatError, setPersonalChatError] = useState<string | null>(null);
  const [openingPersonalChat, setOpeningPersonalChat] = useState(false);

  const returnToWorkbench = useCallback(() => {
    // Direct links and reloads have React Router's default history key. They
    // should return to a known in-app surface instead of leaving the app.
    if (location.key === "default") {
      void navigate("/", { replace: true });
      return;
    }
    void navigate(-1);
  }, [location.key, navigate]);
  const returnToWorkbenchRef = useRef(returnToWorkbench);
  sessionRef.current = auth.session;
  authRef.current = auth;
  refreshRef.current = refresh;
  returnToWorkbenchRef.current = returnToWorkbench;

  const openPersonalChat = useCallback(async (dispatchProfileChange: boolean) => {
    const operation = ++personalChatOperationRef.current;
    const openingViewer = openingViewerRef.current;
    const openingActorId = openingViewer.sessionActorId;
    const ownedAgentId = profileResponse.viewerRole === "owner"
      ? profileResponse.ownedAgents[0]?.agentId
      : undefined;
    const operationIsCurrent = (): boolean => {
      const current = authRef.current.viewer;
      return mountedRef.current
        && personalChatOperationRef.current === operation
        && openingViewer.sessionUserId !== null
        && openingActorId !== null
        && current.sessionUserId === openingViewer.sessionUserId
        && current.sessionActorId === openingActorId;
    };

    setOpeningPersonalChat(true);
    if (dispatchProfileChange) setPersonalChatError(null);
    try {
      if (!ownedAgentId || openingActorId === null || !operationIsCurrent()) {
        throw new Error("personal room unavailable");
      }
      if (dispatchProfileChange) window.dispatchEvent(new Event("nautilo:profile-changed"));
      await refreshRef.current();
      if (!operationIsCurrent()) return;
      const response = await apiClient.listRooms();
      if (!operationIsCurrent()) return;
      const room = resolveOwnedPersonalRoom(
        response.rooms,
        openingActorId,
        ownedAgentId,
      );
      if (!room) throw new Error("personal room unavailable");
      void navigate(roomPath(room.id), { replace: true });
    } catch {
      if (operationIsCurrent()) setPersonalChatError(PERSONAL_CHAT_OPEN_ERROR);
    } finally {
      if (operationIsCurrent()) setOpeningPersonalChat(false);
    }
  }, [navigate, profileResponse]);

  const cancel = useCallback(() => {
    personalChatOperationRef.current += 1;
    setOpeningPersonalChat(false);
    returnToWorkbenchRef.current();
  }, []);

  const adapter = useMemo(() => createWorkbenchOnboardingApi({
    startAt,
    getAccessToken: () => sessionRef.current.getAccessToken(),
    getCanonicalProfile: () => ({ ok: true, data: profileResponse }),
    onCancel: cancel,
    onOpenVoiceFundingRecovery: (recovery) => {
      window.open(recovery.href, "_blank", "noopener,noreferrer");
    },
    onComplete: async () => {
      const isFirstCustomization = profileResponse.viewerRole === "owner"
        && profileResponse.agent.onboardingCompleted === false;
      if (isFirstCustomization) {
        await openPersonalChat(true);
        return;
      }
      window.dispatchEvent(new Event("nautilo:profile-changed"));
      await refreshRef.current();
      returnToWorkbenchRef.current();
    },
  }), [cancel, openPersonalChat, profileResponse, startAt]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      personalChatOperationRef.current += 1;
    };
  }, []);
  useEffect(() => () => adapter.dispose(), [adapter]);

  return (
    <main
      aria-label="Customize your Genie"
      className="min-h-dvh overflow-y-auto bg-background text-foreground"
      data-testid="genie-customization-route"
    >
      {personalChatError ? (
        <div
          className="fixed inset-x-4 top-4 z-50 mx-auto max-w-md rounded-lg border border-border bg-background p-4 shadow-lg"
          role="alert"
        >
          <p className="text-sm text-foreground">{personalChatError}</p>
          <button
            className="mt-3 rounded-md bg-foreground px-3 py-2 text-sm text-background disabled:opacity-50"
            disabled={openingPersonalChat}
            onClick={() => void openPersonalChat(false)}
            type="button"
          >
            {openingPersonalChat ? "Opening Personal chat…" : "Retry opening Personal chat"}
          </button>
        </div>
      ) : null}
      <GenieCustomizationApp api={adapter.api} />
    </main>
  );
}

function GenieCustomizationRouteGate({ message }: { message: string }): React.ReactElement {
  return (
    <main
      aria-label="Customize your Genie"
      className="min-h-dvh overflow-y-auto bg-background text-foreground"
      data-testid="genie-customization-route"
    >
      <div className="flex min-h-dvh items-center justify-center text-sm text-muted-foreground">
        {message}
      </div>
    </main>
  );
}
