import { useCallback, useEffect, useRef, useState } from "react";
import { Zap } from "lucide-react";
import { usePosture } from "../../contexts/posture-context";
import { useCan } from "../../hooks/use-can";
import { useAutoApprove } from "../../adapters/runtime-contexts";
import { desktopAPI, isDesktop } from "../../lib/desktop";
import { formatLevel, postureTone } from "./posture-colors";
import { PostureModal } from "./posture-modal";

type UncontainedStatus = {
  confirmed: boolean;
  active: boolean;
  eligible: boolean;
  reason: string | null;
  activatedAt: string | null;
};

export function PostureBadge() {
  const { posture, loading, error, refresh } = usePosture();
  const can = useCan();
  const canReadServerSettings = can("read_server_settings");
  const canUseWorkstation = can("use_workstation");
  // D375 — secondary echo of the session Auto-Approve mode. The composer
  // band is the primary indicator; this footer badge flips to a warning
  // treatment when the mode is on so the state is visible from the status
  // bar too.
  const { enabled: autoApprove } = useAutoApprove();
  const [open, setOpen] = useState(false);
  const [uncontainedStatus, setUncontainedStatus] = useState<UncontainedStatus | null>(null);
  const [uncontainedBusy, setUncontainedBusy] = useState(false);
  const [uncontainedError, setUncontainedError] = useState<string | null>(null);
  const uncontainedRequestGeneration = useRef(0);
  const uncontainedAPI = desktopAPI?.uncontainedHostCommands;

  const refreshUncontainedStatus = useCallback(async () => {
    const generation = ++uncontainedRequestGeneration.current;
    if (!uncontainedAPI || !isDesktop || !canUseWorkstation) {
      if (generation === uncontainedRequestGeneration.current) setUncontainedStatus(null);
      return;
    }
    try {
      const next = await uncontainedAPI.getStatus();
      if (generation === uncontainedRequestGeneration.current) setUncontainedStatus(next);
    } catch {
      if (generation === uncontainedRequestGeneration.current) {
        setUncontainedStatus({
          confirmed: false,
          active: false,
          eligible: false,
          reason: "server_status_unavailable",
          activatedAt: null,
        });
      }
    }
  }, [canUseWorkstation, uncontainedAPI]);

  const clearUncontainedConfirmation = useCallback(() => {
    ++uncontainedRequestGeneration.current;
    setUncontainedStatus((current) => current === null
      ? current
      : { ...current, confirmed: false, active: false, reason: "server_status_refreshing" });
  }, []);

  useEffect(() => {
    void refreshUncontainedStatus();
  }, [refreshUncontainedStatus]);

  useEffect(() => {
    const refreshAfterLifecycle = () => {
      clearUncontainedConfirmation();
      void refreshUncontainedStatus();
    };
    window.addEventListener("nautilo:uncontained-host-commands-changed", refreshAfterLifecycle);
    window.addEventListener("nautilo:policy-changed", refreshAfterLifecycle);
    window.addEventListener("nautilo:auth-changed", refreshAfterLifecycle);
    document.addEventListener("visibilitychange", refreshAfterLifecycle);
    return () => {
      window.removeEventListener("nautilo:uncontained-host-commands-changed", refreshAfterLifecycle);
      window.removeEventListener("nautilo:policy-changed", refreshAfterLifecycle);
      window.removeEventListener("nautilo:auth-changed", refreshAfterLifecycle);
      document.removeEventListener("visibilitychange", refreshAfterLifecycle);
    };
  }, [clearUncontainedConfirmation, refreshUncontainedStatus]);

  useEffect(() => {
    if (uncontainedStatus?.confirmed !== true || !uncontainedStatus.active) return;
    const interval = window.setInterval(() => {
      clearUncontainedConfirmation();
      void refreshUncontainedStatus();
    }, 12_000);
    return () => window.clearInterval(interval);
  }, [clearUncontainedConfirmation, refreshUncontainedStatus, uncontainedStatus?.active, uncontainedStatus?.confirmed]);

  const disableUncontained = useCallback(async (): Promise<void> => {
    if (!uncontainedAPI) return;
    setUncontainedBusy(true);
    setUncontainedError(null);
    try {
      const result = await uncontainedAPI.disable();
      if (!result.ok) {
        setUncontainedError(result.message);
        return;
      }
      clearUncontainedConfirmation();
      window.dispatchEvent(new CustomEvent("nautilo:uncontained-host-commands-changed"));
      await refreshUncontainedStatus();
    } catch {
      setUncontainedError("Direct Mac execution could not be disabled.");
    } finally {
      setUncontainedBusy(false);
    }
  }, [clearUncontainedConfirmation, refreshUncontainedStatus, uncontainedAPI]);

  const activateUncontained = useCallback(async (pin: string): Promise<boolean> => {
    if (!uncontainedAPI) return false;
    setUncontainedBusy(true);
    setUncontainedError(null);
    try {
      const result = await uncontainedAPI.activate({ pin });
      if (!result.ok) {
        setUncontainedError(result.message);
        return false;
      }
      clearUncontainedConfirmation();
      window.dispatchEvent(new CustomEvent("nautilo:uncontained-host-commands-changed"));
      await refreshUncontainedStatus();
      return true;
    } catch {
      setUncontainedError("Direct Mac execution could not be activated.");
      return false;
    } finally {
      setUncontainedBusy(false);
    }
  }, [clearUncontainedConfirmation, refreshUncontainedStatus, uncontainedAPI]);

  if (!canReadServerSettings) return null;

  if (loading && posture === null) {
    return <span className="text-xs text-foreground-muted">Security: loading</span>;
  }
  if (error && posture === null) {
    return <span className="text-xs text-error">Security unavailable</span>;
  }
  if (posture === null) return null;

  const uncontainedActive = uncontainedStatus?.confirmed === true && uncontainedStatus.active;
  const desktopUncontainedHostCommands = isDesktop && canUseWorkstation && uncontainedAPI
    ? {
        status: uncontainedStatus,
        busy: uncontainedBusy,
        error: uncontainedError,
        activate: activateUncontained,
        disable: disableUncontained,
      }
    : undefined;

  const openPosture = () => {
    setOpen(true);
    clearUncontainedConfirmation();
    void refreshUncontainedStatus();
  };

  return (
    <>
      <button
        type="button"
        onClick={openPosture}
        title={
          uncontainedActive
            ? "This Desktop is uncontained. Open Security to turn it off immediately."
            : autoApprove
            ? `Auto-Approve ON (this session) · Security posture: ${posture.securityLevel} / ${posture.deploymentMode} / network=${posture.networkPolicy.mode} / ${posture.backend.kind}`
            : `Security posture: ${posture.securityLevel} / ${posture.deploymentMode} / network=${posture.networkPolicy.mode} / ${posture.backend.kind}`
        }
        className={[
          "inline-flex items-center gap-1.5 rounded px-1.5 py-0.5 text-xs hover:bg-background-element",
          uncontainedActive ? "bg-[var(--error)]/10 text-[var(--error)]" : "",
        ].join(" ")}
      >
        {uncontainedActive ? (
          <>
            <span aria-hidden="true" className="inline-block h-2 w-2 rounded-full bg-[var(--error)]" />
            <span>SECURITY: UNCONTAINED</span>
          </>
        ) : autoApprove ? (
          <>
            <Zap
              aria-hidden="true"
              className="h-3 w-3 text-[var(--warning)]"
            />
            <span className="text-[var(--warning)]">Auto-Approve</span>
          </>
        ) : (
          <>
            <span
              aria-hidden="true"
              className="inline-block h-2 w-2 rounded-full"
              style={{ backgroundColor: postureTone(posture.securityLevel) }}
            />
            <span>Security: {formatLevel(posture.securityLevel)}</span>
          </>
        )}
      </button>

      {open && (
        <PostureModal
          posture={posture}
          desktopUncontainedHostCommands={desktopUncontainedHostCommands}
          onClose={() => setOpen(false)}
          onRefresh={refresh}
        />
      )}
    </>
  );
}
