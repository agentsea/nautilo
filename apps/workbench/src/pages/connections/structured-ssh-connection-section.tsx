import { useCallback, useEffect, useRef, useState } from "react";
import { PinDialog } from "../../components/pin-dialog";
import { useAuth } from "../../hooks/use-auth";
import { desktopAPI, isDesktop } from "../../lib/desktop";
import { stableViewerKeyForStorage } from "../../rooms/room-navigation-storage";
import { useWorkbenchUiTargetReveal } from "../../lib/genie-application-targets";
import { StatusPill } from "../settings/ui";
import { ConnectionDisclosureControl, useConnectionDisclosure } from "./connection-disclosure";

export type ManagedSshState = "unavailable" | "not-enabled" | "enabled";

/** Renderer-safe Human control for the single managed SSH capability. */
export interface ManagedSshConnection {
  status: () => Promise<{
    state: ManagedSshState;
    reason: string | null;
    enabledTools: readonly string[];
  }>;
  enable: (pin: string) => Promise<unknown>;
  disable: () => Promise<unknown>;
}

type ManagedSshStatus = Awaited<ReturnType<ManagedSshConnection["status"]>>;

function failureMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/^Error invoking remote method '[^']+': Error: /, "");
}

function normalizeStatus(value: unknown, hasDesktopShell: boolean): ManagedSshStatus {
  if (value && typeof value === "object") {
    const candidate = value as Partial<ManagedSshStatus> & { reason?: unknown };
    if (candidate.state === "unavailable" || candidate.state === "not-enabled" || candidate.state === "enabled") {
      return {
        state: candidate.state,
        reason: typeof candidate.reason === "string" ? candidate.reason : null,
        enabledTools: [],
      };
    }
  }
  return {
    state: "unavailable",
    reason: hasDesktopShell
      ? "SSH status is unavailable in this version of Nautilo Desktop."
      : "SSH access for Genie is available in the Nautilo desktop app.",
    enabledTools: [],
  };
}

function CapabilitySwitch({ enabled, disabled, onChange }: {
  enabled: boolean;
  disabled: boolean;
  onChange: (next: boolean) => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={enabled}
      aria-label={`${enabled ? "Turn off" : "Turn on"} SSH access for Genie`}
      disabled={disabled}
      onClick={() => onChange(!enabled)}
      className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors ${enabled ? "bg-[var(--success)]" : "bg-foreground-muted/40"} ${disabled ? "cursor-not-allowed opacity-50" : "cursor-pointer"}`}
    >
      <span className={`inline-block h-4 w-4 rounded-full bg-background shadow transition-transform ${enabled ? "translate-x-4" : "translate-x-0.5"}`} />
    </button>
  );
}

export function StructuredSshConnectionSection({
  connection = isDesktop ? desktopAPI?.structuredSsh : undefined,
  isDesktopShell = isDesktop,
  routeHash,
  routeKey,
}: {
  connection?: ManagedSshConnection;
  isDesktopShell?: boolean;
  routeHash?: string;
  routeKey?: string;
}) {
  const auth = useAuth();
  const [status, setStatus] = useState<ManagedSshStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [pinOpen, setPinOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const sectionRef = useRef<HTMLDivElement | null>(null);

  const refresh = useCallback(async () => {
    if (!connection) {
      setStatus(normalizeStatus(null, isDesktopShell));
      return;
    }
    try {
      setStatus(normalizeStatus(await connection.status(), isDesktopShell));
      setError(null);
    } catch (cause) {
      setStatus(normalizeStatus(null, isDesktopShell));
      setError(failureMessage(cause));
    }
  }, [connection, isDesktopShell]);

  useEffect(() => { void refresh(); }, [refresh]);
  useWorkbenchUiTargetReveal("connections.ssh");

  const enable = async (pin: string) => {
    if (!connection) return;
    setBusy(true);
    setError(null);
    try {
      await connection.enable(pin);
      await refresh();
      setPinOpen(false);
    } catch (cause) {
      setError(failureMessage(cause));
    } finally {
      setBusy(false);
    }
  };

  const disable = async () => {
    if (!connection) return;
    setBusy(true);
    setError(null);
    try {
      await connection.disable();
      await refresh();
    } catch (cause) {
      setError(failureMessage(cause));
    } finally {
      setBusy(false);
    }
  };

  const current = status ?? normalizeStatus(null, isDesktopShell);
  const enabled = current.state === "enabled";
  const unavailable = current.state === "unavailable";
  const disclosure = useConnectionDisclosure({
    cardId: "ssh",
    viewerKey: stableViewerKeyForStorage(auth.viewer),
    forceOpen: busy || pinOpen || error !== null,
    routeHash,
    routeKey,
  });

  return (
    <div ref={sectionRef} id="ssh" tabIndex={-1} className="rounded-lg border border-border bg-background-panel px-4 py-4 focus:outline-none focus:ring-2 focus:ring-accent focus:ring-offset-2" data-testid="structured-ssh-connection">
      <div className="flex items-center gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-sm font-medium text-foreground">SSH access for Genie</h3>
            <StatusPill tone={enabled ? "ok" : "muted"}>{enabled ? "On" : unavailable ? "Unavailable" : "Off"}</StatusPill>
          </div>
          <p className="mt-1 text-xs text-foreground-muted">
            Allows Genie to use this Mac’s configured SSH connections. Keys stay in local custody; trusted hosts follow your session approval setting.
          </p>
        </div>
        <div className="flex items-center gap-2"><ConnectionDisclosureControl expanded={disclosure.expanded} detailsId={disclosure.detailsId} onToggle={disclosure.toggle} /><CapabilitySwitch
            enabled={enabled}
            disabled={busy || unavailable}
            onChange={(next) => {
              if (next) {
                setError(null);
                setPinOpen(true);
              } else {
                void disable();
              }
            }}
          /></div>
      </div>
      <div id={disclosure.detailsId} hidden={!disclosure.expanded} className="px-4 pb-4">
        {current.state === "unavailable" && current.reason ? <p className="mt-3 text-xs text-foreground-muted">{current.reason}</p> : null}
        {error ? <p className="mt-3 text-xs text-[var(--error)]" role="alert">{error}</p> : null}
      </div>
      {pinOpen ? (
        <PinDialog
          title="Turn on SSH access"
          prompt="Enter your own PIN to let Genie use this Mac’s configured SSH connections. New or changed host trust still requires you."
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
    </div>
  );
}
