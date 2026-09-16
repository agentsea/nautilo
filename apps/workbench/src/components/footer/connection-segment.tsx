import { useContext, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { RotateCw } from "lucide-react";
import type { WsStateFull } from "../../hooks/use-ws-state";
import { useWsState } from "../../hooks/use-ws-state";
import { useRuntimeShellState } from "../../adapters/runtime-contexts";
import { FOOTER_HEIGHT_PX } from "../../layouts/chrome-shell.layout";
import { requestCryptoAdmissionRefresh } from "../../lib/crypto-admission-access";
import { getMaintenanceNoticeSnapshot, subscribeMaintenanceNotice } from "../maintenance-notice-state";
import { ConnectionRecoveryPortalContext } from "./connection-recovery-portal";
import { FooterSegment } from "./footer-segment";

export interface ConnectionStateMeta {
  readonly color: string;
  readonly label: string;
  readonly title: string;
}

export function connectionStateMeta(state: WsStateFull): ConnectionStateMeta {
  if (state === "open") {
    return {
      color: "var(--success)",
      label: "Connected",
      title: "Connected",
    };
  }
  if (state === "connecting") {
    return {
      color: "var(--warning)",
      label: "Reconnecting",
      title: "Reconnecting...",
    };
  }
  return {
    color: "var(--warning)",
    label: "Connection lost",
    title: "Connection lost",
  };
}

export function ConnectionSegment() {
  const ws = useWsState();
  const shell = useRuntimeShellState();
  const recoveryHost = useContext(ConnectionRecoveryPortalContext);
  const maintenance = useSyncExternalStore(
    subscribeMaintenanceNotice,
    getMaintenanceNoticeSnapshot,
    getMaintenanceNoticeSnapshot,
  );
  const meta = shell.kind === "authenticated_idle"
    ? { color: "var(--foreground-muted)", label: "Idle", title: "Idle" }
    : connectionStateMeta(ws.state);
  // An admission refresh alone never creates a connection warning. Use the
  // existing transport outage classification and suppress intentional idle.
  const canRetry = ws.state === "disconnected-long"
    && (shell.kind === "authenticated_disconnected" || shell.kind === "authenticated_resuming")
    && maintenance.kind === "normal";
  const content = (
    <span className="inline-flex items-center gap-1">
      <FooterSegment
        title={meta.title}
        icon={<span
          aria-hidden="true"
          className="inline-block h-2 w-2 rounded-full align-middle"
          style={{ backgroundColor: meta.color }}
        />}
        label={<span role="status" aria-live="polite">{meta.label}</span>}
      />
      {canRetry ? (
        <button
          type="button"
          onClick={() => requestCryptoAdmissionRefresh("manual_retry")}
          className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-xs text-foreground-muted hover:bg-background-element hover:text-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary"
        >
          <RotateCw className="h-3 w-3" aria-hidden="true" />
          Retry
        </button>
      ) : null}
    </span>
  );

  // Reserve the exact same footer space while presenting only recovery
  // outside the gate. No product control becomes interactive through this.
  if (canRetry && recoveryHost !== null) {
    return <>
      <span aria-hidden="true" className="invisible">{content}</span>
      {createPortal(
        <div
          className="fixed bottom-0 left-0 z-50 flex items-center border-t border-border bg-background-panel pl-4 text-xs text-foreground-muted"
          style={{ height: FOOTER_HEIGHT_PX }}
        >
          {content}
        </div>,
        recoveryHost,
      )}
    </>;
  }
  return content;
}
