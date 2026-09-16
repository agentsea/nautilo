import { useCallback, useEffect, useSyncExternalStore, useState } from "react";
import { apiClient } from "../lib/api";
import { desktopAPI } from "../lib/desktop";
import { useVoiceControls } from "../adapters/runtime-contexts";
import {
  getHasUnsentComposerText,
  subscribeUpgradeReloadGuard,
} from "../adapters/upgrade-reload-guard";
import {
  acceptDeploymentIdentity,
  DEPLOYMENT_BASELINE_KEY,
  DEPLOYMENT_LATER_KEY,
  DEPLOYMENT_PENDING_KEY,
  readDeploymentValue,
  removeDeploymentValue,
  writeDeploymentValue,
} from "../adapters/deployment-identity-storage";
import {
  getMaintenanceNoticeSnapshot,
  resolveWorkbenchMessageBar,
  subscribeMaintenanceNotice,
  type MaintenanceNoticeKind,
} from "./maintenance-notice-state";

const POLL_INTERVAL_MS = 60_000;

/** Lets the reconnect toast avoid announcing a generic recovery over this notice. */
export function hasPendingServerUpgradeNotice(): boolean {
  return readDeploymentValue(DEPLOYMENT_PENDING_KEY) !== null;
}

function MaintenanceNotice({ kind }: { kind: Exclude<MaintenanceNoticeKind, "normal"> }) {
  const applying = kind === "applying";
  return (
    <section
      role="status"
      aria-live="polite"
      aria-label={applying ? "Server maintenance applying" : "Server maintenance draining"}
      className="mx-3 mb-2 flex flex-wrap items-center gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm"
    >
      <span className="min-w-0 flex-1 text-foreground">
        {applying
          ? "A server upgrade is being applied. The Workbench will reconnect automatically."
          : "A server upgrade is preparing. Active work is draining before maintenance begins."}
      </span>
    </section>
  );
}

export function ServerUpgradeNotice() {
  const voice = useVoiceControls();
  const maintenance = useSyncExternalStore(
    subscribeMaintenanceNotice,
    getMaintenanceNoticeSnapshot,
    getMaintenanceNoticeSnapshot,
  );
  const hasUnsentComposerText = useSyncExternalStore(
    subscribeUpgradeReloadGuard,
    getHasUnsentComposerText,
    () => false,
  );
  const [identity, setIdentity] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    const check = async (): Promise<void> => {
      try {
        const health = await apiClient.getHealth();
        const next = health.deploymentIdentity?.trim() ?? "";
        if (!next || cancelled) return;

        const baseline = readDeploymentValue(DEPLOYMENT_BASELINE_KEY);
        if (baseline === null) {
          acceptDeploymentIdentity(next);
          return;
        }
        if (baseline === next) return;
        if (readDeploymentValue(DEPLOYMENT_LATER_KEY) === next) return;
        writeDeploymentValue(DEPLOYMENT_PENDING_KEY, next);
        setIdentity(next);
      } catch {
        // A failed probe is ordinary during a rolling replacement; retry later.
      }
    };

    void check();
    const interval = window.setInterval(() => void check(), POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, []);

  const refreshNow = useCallback(async () => {
    if (!identity) return;
    if (voice.isRunning || hasUnsentComposerText) {
      const detail = voice.isRunning
        ? "A turn is still running. Refreshing can interrupt it."
        : "Your unsent composer text will be lost.";
      if (!window.confirm(`${detail}\n\nRefresh anyway?`)) return;
    }

    // Record before navigation so a failed reload/retry does not produce a
    // duplicate generic reconnect toast. Authentication remains in the
    // browser/Electron session; this reloads only the Workbench renderer.
    acceptDeploymentIdentity(identity);
    try {
      if (desktopAPI?.workbench?.reload) {
        await desktopAPI.workbench.reload();
        return;
      }
    } catch {
      // Older Electron preload: browser-style reload is still safe.
    }
    window.location.reload();
  }, [hasUnsentComposerText, identity, voice.isRunning]);

  const refreshLater = useCallback(() => {
    if (!identity) return;
    writeDeploymentValue(DEPLOYMENT_LATER_KEY, identity);
    removeDeploymentValue(DEPLOYMENT_PENDING_KEY);
    setIdentity(null);
  }, [identity]);

  const messageBar = resolveWorkbenchMessageBar({
    maintenance,
    refreshPending: identity !== null,
    reconnecting: false,
  });
  // Applying replaces the router with MaintenanceApplyingBoundary. Never
  // leave a competing message bar mounted beneath that full-screen gate.
  if (messageBar === "draining") {
    return <MaintenanceNotice kind={messageBar} />;
  }

  if (messageBar !== "refresh") return null;

  return (
    <section
      role="status"
      aria-label="Server upgrade available"
      className="mx-3 mb-2 flex flex-wrap items-center gap-2 rounded-lg border border-primary/40 bg-[var(--primary-muted)] px-3 py-2 text-sm"
    >
      <span className="min-w-0 flex-1 text-foreground">
        A server upgrade is ready. Refresh the Workbench when you&apos;re ready.
      </span>
      <button
        type="button"
        onClick={() => void refreshNow()}
        className="rounded-md bg-primary px-2.5 py-1 text-xs font-medium text-[var(--on-primary)] hover:bg-[var(--primary-hover)]"
      >
        Refresh Now
      </button>
      <button
        type="button"
        onClick={refreshLater}
        className="rounded-md border border-border px-2.5 py-1 text-xs font-medium text-foreground hover:bg-background-element"
      >
        Refresh Later
      </button>
    </section>
  );
}
