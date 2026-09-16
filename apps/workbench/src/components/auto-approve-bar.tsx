/**
 * AutoApproveBar — D375 top tier of the 3-tier composer.
 *
 * Sits directly above the ApprovalAskDock / composer. This is the
 * PRIMARY surface for the ephemeral, session-scoped Auto-Approve mode
 * (a proactive "stop asking me about tool calls this session" toggle,
 * distinct from the durable PIN-gated `security.level: "yolo"` posture).
 *
 * Three visual states:
 *   - hidden      — guests / `!canToggle` render nothing.
 *   - OFF (slim)  — a subtle, non-obnoxious "turn on" affordance.
 *   - ON  (band)  — a loud warning-tinted band so the mode is
 *                   unmistakable; occupies the slot the dock would use
 *                   (when ON, ask-tier approvals auto-resolve so the
 *                   dock never fires).
 *
 * Turning ON goes through a confirm-once dialog that lists what stays
 * protected (PIN, dangerous-command block, network egress). No PIN —
 * this is a session flag, not a server-posture change. Turning OFF is a
 * single click, no confirm.
 */

import { useState, type ReactNode } from "react";
import { Zap } from "lucide-react";
import { useAutoApprove } from "../adapters/runtime-contexts";
import { isDesktop } from "../lib/desktop";
import { ReadyToWorkSegment } from "./footer/ready-to-work-segment";

export function AutoApproveBar() {
  const { enabled, setEnabled, canToggle } = useAutoApprove();
  return (
    <AutoApproveBarView
      enabled={enabled}
      setEnabled={setEnabled}
      canToggle={canToggle}
      isDesktopShell={isDesktop}
      statusSegment={<ReadyToWorkSegment />}
    />
  );
}

/** Kept small so the fixed composer strip can be exercised without module mocks. */
export function AutoApproveBarView({
  enabled,
  setEnabled,
  canToggle,
  isDesktopShell,
  statusSegment,
}: {
  enabled: boolean;
  setEnabled: (enabled: boolean) => void;
  canToggle: boolean;
  isDesktopShell: boolean;
  statusSegment: ReactNode;
}) {
  const [showConfirm, setShowConfirm] = useState(false);

  if (!canToggle && !isDesktopShell) return null;

  // D375 — single quiet corner control in both states (same slot). OFF opens
  // the confirm dialog (the loud moment); ON is a calm orange pill that
  // toggles straight back off. No full-width band: the confirm dialog already
  // warns on enable, so steady-state shouldn't scream at the user.
  return (
    <>
      <div className="flex w-full min-w-0 flex-nowrap items-center justify-end gap-1 overflow-hidden px-4 py-1">
        <div className="flex min-w-0 flex-1 justify-end overflow-hidden">{statusSegment}</div>
        {canToggle ? (
          <>
            <span aria-hidden="true" className="shrink-0 text-foreground-disabled">·</span>
            <button
              type="button"
              data-testid="auto-approve-toggle"
              aria-label={enabled ? "Auto-approve: on" : "Auto-approve: off"}
              onClick={() => (enabled ? setEnabled(false) : setShowConfirm(true))}
              title={
                enabled
                  ? "Auto-approve on — click to turn off. PIN still gates destructive actions."
                  : "Auto-approve tool calls for this session"
              }
              className={[
                "inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded px-1.5 py-0.5 text-[11px] transition-colors",
                enabled
                  ? "text-[var(--warning)] hover:bg-[var(--warning)]/10"
                  : "text-foreground-muted hover:bg-background-element hover:text-foreground",
              ].join(" ")}
            >
              <Zap className="h-3.5 w-3.5" aria-hidden="true" />
              {enabled ? "Approve: on" : "Approve: off"}
            </button>
          </>
        ) : null}
      </div>
      {canToggle && showConfirm ? (
        <AutoApproveConfirmDialog
          onCancel={() => setShowConfirm(false)}
          onConfirm={() => {
            setEnabled(true);
            setShowConfirm(false);
          }}
        />
      ) : null}
    </>
  );
}

function AutoApproveConfirmDialog({
  onCancel,
  onConfirm,
}: {
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/50 p-4 backdrop-blur-sm">
      <div className="w-full max-w-md rounded-lg border border-border-strong bg-background-panel p-5 shadow-xl">
        <div className="flex items-center gap-2">
          <Zap className="h-5 w-5 text-[var(--warning)]" aria-hidden="true" />
          <h2 className="text-lg font-semibold">Turn on Auto-Approve for this session?</h2>
        </div>
        <p className="mt-2 text-sm text-foreground-muted">
          The agent will run tools, edit files, and run shell commands without
          asking you first.
        </p>
        <div className="mt-4 rounded-md border border-border bg-background-element/60 px-3 py-2 text-sm">
          <div className="font-medium text-foreground">Still protected:</div>
          <ul className="mt-1 space-y-0.5 text-foreground-muted">
            <li>• PIN required for destructive actions</li>
            <li>• dangerous commands still blocked</li>
            <li>• network egress still gated</li>
          </ul>
        </div>
        <p className="mt-3 text-xs text-foreground-muted">
          Applies to this session on this device. Turn it off anytime.
        </p>
        <div className="mt-5 flex justify-end gap-3">
          <button
            type="button"
            onClick={onCancel}
            className="rounded-md border border-border px-3 py-2 text-sm text-foreground-muted hover:text-foreground"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            className="rounded-md bg-primary px-3 py-2 text-sm font-medium text-[var(--on-primary)] hover:bg-primary-hover"
          >
            Turn on
          </button>
        </div>
      </div>
    </div>
  );
}
