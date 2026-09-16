import { GenieCustomizationApp, type OnboardingStartAt } from "@nautilo/genie-customization-ui";
import type { AgentProfileResponse } from "@nautilo/types";
import { useCallback, useEffect, useMemo, useRef } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { useAuth } from "../hooks/use-auth";
import { useProfile } from "../hooks/use-profile";
import { createWorkbenchOnboardingApi } from "./workbench-onboarding-api";

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
  const refreshRef = useRef(refresh);

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
  refreshRef.current = refresh;
  returnToWorkbenchRef.current = returnToWorkbench;

  const adapter = useMemo(() => createWorkbenchOnboardingApi({
    startAt,
    getAccessToken: () => sessionRef.current.getAccessToken(),
    getCanonicalProfile: () => ({ ok: true, data: profileResponse }),
    onCancel: () => returnToWorkbenchRef.current(),
    onComplete: async () => {
      window.dispatchEvent(new Event("nautilo:profile-changed"));
      await refreshRef.current();
      returnToWorkbenchRef.current();
    },
  }), [profileResponse, startAt]);

  useEffect(() => () => adapter.dispose(), [adapter]);

  return (
    <main
      aria-label="Customize your Genie"
      className="min-h-dvh overflow-y-auto bg-background text-foreground"
      data-testid="genie-customization-route"
    >
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
