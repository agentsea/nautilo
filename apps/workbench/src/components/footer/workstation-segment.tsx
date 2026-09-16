import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { PinDialog } from "../pin-dialog";
import { desktopAPI, isDesktop } from "../../lib/desktop";
import { useAuth } from "../../hooks/use-auth";
import { useCan } from "../../hooks/use-can";
import {
  publishWorkstationProfileChanged,
  subscribeToWorkstationProfileChanges,
} from "../../lib/workstation-profile-events";

type FooterState = "loading" | "setup" | "update" | "off" | "on" | "unavailable";

const FOOTER_LABELS: Record<FooterState, string> = {
  loading: "Workstation: Checking…",
  setup: "Workstation: Set up",
  update: "Workstation: Update needed",
  off: "Workstation: Off",
  on: "Workstation: On",
  unavailable: "Workstation: Unavailable",
};

function reviewAcknowledgementKey(userId: string, profileId: string, revision: number): string {
  return `nautilo.workstation-profile-review.${encodeURIComponent(userId)}.${encodeURIComponent(profileId)}.${revision}`;
}

function hasAcknowledgedReview(userId: string | null, profileId: string, revision: number): boolean {
  if (!userId || typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(reviewAcknowledgementKey(userId, profileId, revision)) === "acknowledged";
  } catch {
    return false;
  }
}

/**
 * D418 C4 — persistent, desktop-only Workstation affordance. It is a session
 * control, not an Auto-Approve indicator: "On" requires matching local and
 * server-confirmed profile selectors.
 */
export function WorkstationSegment() {
  const navigate = useNavigate();
  const auth = useAuth();
  const can = useCan();
  const canUseWorkstation = can("use_workstation");
  const profilesApi = desktopAPI?.workstationProfiles;
  const [state, setState] = useState<FooterState>("loading");
  const [profile, setProfile] = useState<{ id: string; revision: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pinOpen, setPinOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    if (!profilesApi || !isDesktop) {
      setState("unavailable");
      return;
    }
    if (!canUseWorkstation) {
      setState("unavailable");
      return;
    }
    setState("loading");
    setError(null);
    try {
      const [seedResult, profilesResult, activeResult, serverResult] = await Promise.all([
        profilesApi.getSeedDescriptor(),
        profilesApi.listProfiles(),
        profilesApi.getActiveProfileSummary(),
        profilesApi.getServerSessionStatus(),
      ]);
      if (!seedResult.ok || !profilesResult.ok || !activeResult.ok) {
        setState("unavailable");
        const failure = [seedResult, profilesResult, activeResult].find(
          (result) => !result.ok,
        );
        if (failure && !failure.ok) setError(failure.message);
        return;
      }

      const stored = profilesResult.data.profiles.find((item) => item.id === seedResult.data.id);
      if (!stored) {
        setProfile(null);
        setState("setup");
        return;
      }
      if (stored.revision !== seedResult.data.revision) {
        setProfile(null);
        setState("update");
        return;
      }

      const eligible = hasAcknowledgedReview(
        auth.viewer.sessionUserId,
        stored.id,
        stored.revision,
      );
      setProfile(eligible ? { id: stored.id, revision: stored.revision } : null);
      if (!eligible) {
        setState("setup");
        return;
      }

      if (!serverResult.confirmed) {
        setState("unavailable");
        setError("Developer Workstation server status could not be checked.");
        return;
      }

      const local = activeResult.data;
      const server = serverResult.session;
      const confirmedActive =
        local !== null &&
        server !== null &&
        local.profileId === stored.id &&
        local.profileRevision === stored.revision &&
        server.profileId === local.profileId &&
        server.profileRevision === local.profileRevision;
      setState(confirmedActive ? "on" : "off");
    } catch {
      setState("unavailable");
      setError("Developer Workstation status could not be checked.");
    }
  }, [auth.viewer.sessionUserId, canUseWorkstation, profilesApi]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() =>
    subscribeToWorkstationProfileChanges("footer", () => {
      void refresh();
    }), [refresh]);

  if (!isDesktop || !canUseWorkstation) return null;

  const label = FOOTER_LABELS[state];
  const unavailableReason = !profilesApi
    ? "This desktop build does not support Developer Workstation."
    : error ?? "Developer Workstation status is unavailable.";

  async function disable(): Promise<void> {
    if (!profilesApi) return;
    setBusy(true);
    setError(null);
    try {
      const result = await profilesApi.deactivateActiveProfile();
      if (!result.ok) {
        setError(result.message);
        return;
      }
      await refresh();
      publishWorkstationProfileChanged("footer");
    } catch {
      setError("Developer Workstation could not be disabled.");
    } finally {
      setBusy(false);
    }
  }

  async function enable(pin: string): Promise<void> {
    if (!profilesApi || !profile) return;
    setBusy(true);
    setError(null);
    try {
      const result = await profilesApi.selectActiveProfile({
        profileId: profile.id,
        profileRevision: profile.revision,
        pin,
      });
      if (!result.ok) {
        setError(result.message);
        return;
      }
      setPinOpen(false);
      await refresh();
      publishWorkstationProfileChanged("footer");
    } catch {
      setError("Developer Workstation could not be enabled.");
    } finally {
      setBusy(false);
    }
  }

  const disabled = state === "loading" || state === "unavailable" || busy;
  const tone =
    state === "on"
      ? "text-[var(--success)] hover:bg-[var(--success)]/10"
      : state === "setup" || state === "update"
        ? "text-[var(--warning)] hover:bg-[var(--warning)]/10"
        : state === "unavailable"
          ? "text-foreground-disabled"
          : "text-foreground-muted hover:bg-background-element hover:text-foreground";
  const action = state === "on"
    ? () => void disable()
    : state === "off"
      ? () => setPinOpen(true)
      : () => navigate("/settings#workstation-access");

  return (
    <>
      <button
        type="button"
        onClick={action}
        disabled={disabled}
        aria-label={
          state === "on"
            ? "Disable Developer Workstation immediately"
            : state === "off"
              ? "Enable Developer Workstation with your PIN"
              : state === "setup"
                ? "Set up Developer Workstation in Settings"
                : state === "update"
                  ? "Update Developer Workstation in Settings"
                : unavailableReason
        }
        title={state === "unavailable" ? unavailableReason : undefined}
        className={[
          "inline-flex min-w-0 items-center rounded px-1.5 py-0.5 text-[11px] transition-colors focus:outline-none focus:ring-1 focus:ring-primary disabled:cursor-not-allowed disabled:opacity-60",
          tone,
        ].join(" ")}
      >
        <span aria-live="polite">{label}</span>
      </button>
      {error && state !== "unavailable" ? <span role="alert" className="sr-only">{error}</span> : null}
      {pinOpen ? (
        <PinDialog
          title="Enable Developer Workstation"
          prompt="Enter your own PIN to re-enable this reviewed profile for this app session."
          error={error ?? undefined}
          onSubmit={(pin) => void enable(pin)}
          onCancel={() => {
            if (!busy) {
              setPinOpen(false);
              setError(null);
            }
          }}
        />
      ) : null}
    </>
  );
}
