import {
  type ReactNode,
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import nautiloLogo from "../../../../assets/brand/nautilo-logo_v1_logo_only_transparent.png?inline";
import { Server } from "lucide-react";
import { getHasUnsentComposerText } from "../adapters/upgrade-reload-guard";
import {
  allowsOrdinaryConversationPersistence,
  useConversationEncryptionPolicyMode,
} from "../adapters/runtime-contexts";
import { useRoomComposerDraftStore } from "../contexts/room-composer-draft-context";
import { apiClient } from "../lib/api";
import {
  canSwitchDesktopServer,
  canSwitchDesktopServerInProcess,
  desktopAPI,
} from "../lib/desktop";
import {
  applyMaintenanceStatus,
  beginMaintenanceRecoveryReload,
  getMaintenanceNoticeSnapshot,
  getMaintenanceStatusVersion,
  hasMaintenanceNormalCompletion,
  restoreApplyingLatchAfterFailedRecoveryReload,
  subscribeMaintenanceNotice,
  type MaintenanceNoticeSnapshot,
} from "./maintenance-notice-state";
import { ServerSwitcherOverlay } from "./server-switcher-overlay";

const HEALTH_RETRY_INTERVAL_MS = 5_000;

export function shouldShowMaintenanceApplyingGate(
  maintenance: MaintenanceNoticeSnapshot,
): boolean {
  return maintenance.applyingLatched;
}

/**
 * A healthy HTTP server is not enough: the durable lease must explicitly say
 * `normal`. Old servers omit the field, where the authenticated WS snapshot
 * remains the completion authority.
 */
export function shouldCompleteMaintenanceRecovery(input: {
  healthMaintenanceState: "normal" | "draining" | "applying" | undefined;
  normalCompletionObserved: boolean;
}): boolean {
  return (
    input.healthMaintenanceState === "normal" ||
    (input.healthMaintenanceState === undefined && input.normalCompletionObserved)
  );
}

function NautiloMark() {
  return (
    <img
      aria-hidden="true"
      alt=""
      src={nautiloLogo}
      className="h-20 w-20 animate-pulse object-contain [animation-duration:3s] motion-reduce:animate-none"
    />
  );
}

export function MaintenanceApplyingScreen({
  hasUnsentDraft,
  failure,
  onTryAgain,
  onSwitchServer,
  onCopyDetails,
  copied,
}: {
  hasUnsentDraft: boolean;
  failure: string | null;
  onTryAgain: () => void;
  onSwitchServer: (() => void) | null;
  onCopyDetails: () => void;
  copied: boolean;
}) {
  const detail = failure
    ?? (hasUnsentDraft
      ? "Your unsent draft is safely preserved and will return after the upgrade."
      : "The Workbench will reconnect automatically when the upgrade is ready.");

  return (
    <main
      className="fixed inset-0 z-[100] flex min-h-dvh items-center justify-center bg-background p-6 text-foreground"
      data-testid="maintenance-applying-gate"
      aria-labelledby="maintenance-applying-title"
    >
      {onSwitchServer && (
        <button
          type="button"
          onClick={onSwitchServer}
          data-testid="maintenance-server-rail"
          aria-label="Switch server"
          title="Switch server"
          className="fixed left-3 top-3 flex h-11 w-11 items-center justify-center rounded-xl border border-border-strong bg-background-panel text-foreground-muted shadow-lg transition-colors hover:bg-background-element hover:text-foreground"
        >
          <Server aria-hidden="true" className="h-5 w-5" />
        </button>
      )}
      <section className="w-full max-w-md rounded-2xl border border-border-strong bg-background-panel p-8 text-center shadow-2xl">
        <div
          className="mx-auto flex h-24 w-24 items-center justify-center rounded-full bg-white p-2 shadow-inner ring-1 ring-border-strong"
          data-testid="maintenance-brand-halo"
        >
          <NautiloMark />
        </div>
        <p className="mt-6 text-xs font-semibold uppercase tracking-[0.18em] text-primary">
          Nautilo
        </p>
        <h1 id="maintenance-applying-title" className="mt-2 text-2xl font-semibold">
          Applying a server upgrade
        </h1>
        <p className="mt-3 text-sm leading-6 text-foreground-muted">
          Your server is briefly unavailable while the upgrade is applied.
        </p>
        <p className="mt-3 text-sm leading-6 text-foreground-muted" aria-live="polite">
          {detail}
        </p>

        {onSwitchServer && (
          <button
            type="button"
            onClick={onSwitchServer}
            className="mt-6 rounded-md border border-border px-3 py-2 text-sm font-medium hover:bg-background-element"
          >
            Switch server
          </button>
        )}

        {failure && (
          <div className="mt-6 flex flex-wrap justify-center gap-2">
            <button
              type="button"
              onClick={onTryAgain}
              className="rounded-md bg-primary px-3 py-2 text-sm font-medium text-[var(--on-primary)] hover:bg-[var(--primary-hover)]"
            >
              Try again
            </button>
            <button
              type="button"
              onClick={onCopyDetails}
              className="rounded-md border border-border px-3 py-2 text-sm font-medium hover:bg-background-element"
            >
              {copied ? "Details copied" : "Copy details"}
            </button>
          </div>
        )}
      </section>
    </main>
  );
}

/**
 * Owns the applying lifecycle above every Workbench shell, route and lazy
 * surface. Runtime and draft providers intentionally remain outside it, so a
 * planned disconnect cannot erase maintenance truth or an unsent draft.
 */
export function MaintenanceApplyingBoundary({ children }: { children: ReactNode }) {
  const draftStore = useRoomComposerDraftStore();
  const encryptionPolicyMode = useConversationEncryptionPolicyMode();
  const maintenance = useSyncExternalStore(
    subscribeMaintenanceNotice,
    getMaintenanceNoticeSnapshot,
    getMaintenanceNoticeSnapshot,
  );
  const showingGate = shouldShowMaintenanceApplyingGate(maintenance);
  const maintenanceStatusVersion = useSyncExternalStore(
    subscribeMaintenanceNotice,
    getMaintenanceStatusVersion,
    getMaintenanceStatusVersion,
  );
  const draftAtGateRef = useRef(false);
  const reloadStartedRef = useRef(false);
  const [probeNonce, setProbeNonce] = useState(0);
  const [failure, setFailure] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [serverSwitcherOpen, setServerSwitcherOpen] = useState(false);

  // Capture synchronously while the composer is still mounted. Its unmount
  // cleanup clears the module-level guard, but the provider-owned draft store
  // itself remains alive above this boundary.
  if (showingGate && getHasUnsentComposerText()) draftAtGateRef.current = true;

  useEffect(() => {
    if (!showingGate) {
      draftAtGateRef.current = false;
      reloadStartedRef.current = false;
      setFailure(null);
      setServerSwitcherOpen(false);
      return;
    }
  }, [showingGate]);

  const reload = useCallback(async () => {
    if (reloadStartedRef.current) return;
    reloadStartedRef.current = true;
    setFailure(null);
    if (!draftStore.prepareForRendererReload({
      plaintextPersistence: allowsOrdinaryConversationPersistence(encryptionPolicyMode)
        ? "allowed"
        : "forbidden",
    })) {
      reloadStartedRef.current = false;
      setFailure(
        "Nautilo could not preserve your draft for the reload. Keep this window open and try again.",
      );
      return;
    }
    beginMaintenanceRecoveryReload();
    try {
      if (desktopAPI?.workbench?.reload) {
        await desktopAPI.workbench.reload();
        return;
      }
      window.location.reload();
    } catch {
      restoreApplyingLatchAfterFailedRecoveryReload();
      reloadStartedRef.current = false;
      setFailure("Nautilo could not reload this window. Try again, or reopen the Workbench.");
    }
  }, [draftStore, encryptionPolicyMode]);

  const probeHealth = useCallback(async () => {
    if (!showingGate || reloadStartedRef.current) return;
    try {
      const health = await apiClient.getHealth();
      if (health.maintenanceState === "normal") {
        // The public health read is a durable-state proof for a renderer that
        // was backgrounded and missed its final WS maintenance frame.
        applyMaintenanceStatus({ state: "normal" });
      }
      if (
        shouldCompleteMaintenanceRecovery({
          healthMaintenanceState: health.maintenanceState,
          normalCompletionObserved: hasMaintenanceNormalCompletion(),
        })
      ) {
        // Start recovery in the same async turn as the successful proof. A
        // background server renderer can continue polling while React effects
        // are suspended; deferring this to a state-driven effect can leave the
        // preserved renderer latched when the user switches back to it.
        setFailure(null);
        await reload();
      }
      // `applying` / `draining` is a live server that is still deliberately
      // unavailable. Never let it bypass the gate just because /health is up.
    } catch {
      // Keep polling. A replacement may be temporarily unreachable.
    }
  }, [reload, showingGate]);

  useEffect(() => {
    if (!showingGate || reloadStartedRef.current) return;
    void probeHealth();
    const interval = window.setInterval(() => void probeHealth(), HEALTH_RETRY_INTERVAL_MS);
    return () => window.clearInterval(interval);
  }, [maintenanceStatusVersion, probeHealth, probeNonce, showingGate]);

  const retry = useCallback(() => setProbeNonce((value) => value + 1), []);
  const switchServer = useCallback(() => {
    if (canSwitchDesktopServerInProcess()) {
      setServerSwitcherOpen(true);
      return;
    }
    void desktopAPI?.servers?.openPicker().catch(() => {
      setFailure("Could not open the server picker. Try again or reopen the Workbench.");
    });
  }, []);
  const copyDetails = useCallback(() => {
    const detail = [
      "Nautilo maintenance recovery",
      `Maintenance state: ${maintenance.kind}`,
      `Server: ${window.location.origin}`,
      `Time: ${new Date().toISOString()}`,
    ].join("\n");
    void navigator.clipboard?.writeText(detail).then(
      () => setCopied(true),
      () => setFailure("Could not copy diagnostics. You can try again after the server returns."),
    );
  }, [maintenance.kind]);

  if (!showingGate) return <>{children}</>;
  const canSwitchServer = canSwitchDesktopServerInProcess() || canSwitchDesktopServer();
  return (
    <>
      <MaintenanceApplyingScreen
        hasUnsentDraft={draftAtGateRef.current}
        failure={failure}
        onTryAgain={retry}
        onSwitchServer={canSwitchServer ? switchServer : null}
        onCopyDetails={copyDetails}
        copied={copied}
      />
      {serverSwitcherOpen ? (
        <ServerSwitcherOverlay onClose={() => setServerSwitcherOpen(false)} />
      ) : null}
    </>
  );
}
