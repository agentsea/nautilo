import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createWorkbenchPortal as createPortal } from "../workbench-portals";
import { Link, useNavigate } from "react-router-dom";
import type {
  ReadyToWorkAggregateStatus,
  ReadyToWorkCodingHarnessId,
  ReadyToWorkCodingHarnessStatus,
  ReadyToWorkComponentId,
  ReadyToWorkComponentStatus,
  ReadyToWorkReason,
  ReadyToWorkRepairTarget,
} from "../../../../desktop/electron/ready-to-work-contract";
import { desktopAPI, isDesktop, type DesktopReadyToWorkAPI } from "../../lib/desktop";
import {
  onReadyToWorkPresentationModeChanged,
  readReadyToWorkPresentationMode,
} from "../../lib/ready-to-work-presentation";
import { WorkstationSegment } from "./workstation-segment";

const COMPONENT_LABELS: Record<ReadyToWorkComponentId, string> = {
  voice: "Voice",
  auto_approve: "Auto-approve",
  workstation: "Developer Workstation",
  computer_use: "Computer Use",
  coding_connection: "Coding connection",
};
const HARNESS_LABELS: Record<ReadyToWorkCodingHarnessId, string> = {
  codex: "Codex",
  "hermes-acp": "Hermes",
};
type ReadyDisplayStatus = ReadyToWorkComponentStatus | ReadyToWorkCodingHarnessStatus;
const displayLabel = (component: ReadyDisplayStatus) =>
  component.id in HARNESS_LABELS
    ? HARNESS_LABELS[component.id as ReadyToWorkCodingHarnessId]
    : COMPONENT_LABELS[component.id as ReadyToWorkComponentId];

const REASON_COPY: Record<ReadyToWorkReason, string> = {
  not_selected: "This choice is off.",
  restore_requested: "Not restored yet.",
  owner_unavailable: "Unavailable.",
  owner_rejected: "Off.",
  authority_changed: "This Ready setup belongs to a different signed-in connection.",
  os_protection_unavailable: "Desktop protected startup storage is unavailable.",
  startup_receipt_missing: "Ready setup needs its protected startup receipt.",
  startup_receipt_invalid: "Ready setup's protected startup receipt is invalid.",
  workstation_profile_update_needed: "Developer Workstation needs its current profile.",
  workstation_capability_missing: "Developer Workstation is missing a required capability.",
  workstation_relay_unavailable: "Developer Workstation cannot reach its relay.",
  computer_use_setup_required: "Computer Use needs setup.",
  computer_use_accessibility_required: "Computer Use needs macOS Accessibility.",
  computer_use_screen_recording_required: "Computer Use needs macOS Screen Recording.",
  computer_use_provider_unavailable: "Computer Use unavailable.",
  coding_connection_unavailable: "The Coding connection is unavailable.",
  coding_harness_starting: "Starting.",
  coding_harness_not_installed: "Not installed.",
  coding_harness_sign_in_required: "Sign-in needed.",
  coding_harness_unavailable: "Unavailable.",
};

const REPAIR_DESTINATIONS: Record<ReadyToWorkRepairTarget, { href: string; label: string }> = {
  startup_settings: { href: "/settings#startup", label: "Open Startup" },
  voice_settings: { href: "/", label: "Open voice controls" },
  auto_approve_settings: { href: "/", label: "Open auto-approve" },
  workstation_settings: { href: "/settings#workstation-access", label: "Open Workstation" },
  computer_use_settings: { href: "/connections#computer-use", label: "Open Computer use" },
  coding_connection_settings: { href: "/connections#codex", label: "Open Coding connection" },
};

function repairDestination(component: ReadyDisplayStatus): { href: string; label: string } | null {
  if (!component.repairTarget) return null;
  if (component.id === "codex") return { href: "/connections#codex", label: "Open Codex" };
  if (component.id === "hermes-acp") return { href: "/connections#hermes-acp", label: "Open Hermes" };
  if (component.id === "computer_use" && (
    component.reason === "computer_use_accessibility_required"
    || component.reason === "computer_use_screen_recording_required"
  )) {
    return { href: "/settings#desktop-permissions", label: "Open Desktop permissions" };
  }
  return REPAIR_DESTINATIONS[component.repairTarget];
}

function selectedComponents(status: ReadyToWorkAggregateStatus): readonly ReadyDisplayStatus[] {
  if (status.codingHarnesses === undefined) {
    return status.components.filter((component) => component.state !== "off_by_choice");
  }
  return [
    ...status.components.filter((component) =>
      component.id !== "coding_connection" && component.state !== "off_by_choice"),
    ...(status.codingHarnesses ?? []),
  ];
}

function compactStatusLabel(loading: boolean, error: boolean): string {
  return loading ? "Ready: Checking…" : error ? "Ready: Unavailable" : "Ready: Checking…";
}

function conciseBlockerCopy(component: ReadyDisplayStatus): string {
  const componentLabel = displayLabel(component);
  switch (component.reason ?? "restore_requested") {
    case "not_selected":
    case "owner_rejected":
      return `${componentLabel} off`;
    case "restore_requested":
      return `${componentLabel} pending`;
    case "owner_unavailable":
      return `${componentLabel} unavailable`;
    case "authority_changed":
      return "Connection changed";
    case "os_protection_unavailable":
      return "Startup storage unavailable";
    case "startup_receipt_missing":
    case "startup_receipt_invalid":
      return "Workstation setup needed";
    case "workstation_profile_update_needed":
      return "Workstation update needed";
    case "workstation_capability_missing":
      return "Workstation access missing";
    case "workstation_relay_unavailable":
      return "Workstation unavailable";
    case "computer_use_setup_required":
      return "Computer Use setup needed";
    case "computer_use_accessibility_required":
      return "Accessibility needed";
    case "computer_use_screen_recording_required":
      return "Screen Recording needed";
    case "computer_use_provider_unavailable":
      return "Computer Use unavailable";
    case "coding_connection_unavailable":
      return "Coding connection unavailable";
    case "coding_harness_starting":
      return `${componentLabel} starting`;
    case "coding_harness_not_installed":
      return `${componentLabel} not installed`;
    case "coding_harness_sign_in_required":
      return `${componentLabel} sign-in needed`;
    case "coding_harness_unavailable":
      return `${componentLabel} unavailable`;
  }
}

const POPOVER_WIDTH_PX = 320;
const VIEWPORT_MARGIN_PX = 8;
const POPOVER_GAP_PX = 4;

export type ReadyToWorkPopoverPosition = {
  left: number;
  width: number;
  maxHeight: number;
} & ({ top: number } | { bottom: number });

/** Fixed, viewport-clamped position for the body-portaled Ready details menu. */
export function computeReadyToWorkPopoverPosition(
  rect: DOMRect,
  viewport = { innerWidth: window.innerWidth, innerHeight: window.innerHeight },
): ReadyToWorkPopoverPosition {
  const width = Math.max(0, Math.min(POPOVER_WIDTH_PX, viewport.innerWidth - (VIEWPORT_MARGIN_PX * 2)));
  const maxLeft = Math.max(VIEWPORT_MARGIN_PX, viewport.innerWidth - width - VIEWPORT_MARGIN_PX);
  const left = Math.max(VIEWPORT_MARGIN_PX, Math.min(rect.right - width, maxLeft));
  const spaceAbove = Math.max(0, rect.top - VIEWPORT_MARGIN_PX - POPOVER_GAP_PX);
  const spaceBelow = Math.max(0, viewport.innerHeight - rect.bottom - VIEWPORT_MARGIN_PX - POPOVER_GAP_PX);

  if (spaceAbove >= spaceBelow) {
    return {
      left,
      width,
      maxHeight: spaceAbove,
      bottom: viewport.innerHeight - rect.top + POPOVER_GAP_PX,
    };
  }
  return {
    left,
    width,
    maxHeight: spaceBelow,
    top: rect.bottom + POPOVER_GAP_PX,
  };
}

/**
 * D557 — the composer-adjacent presentation of the persisted Ready posture.
 * It deliberately reports aggregate state only; feature controls continue to
 * own their own authority and their own on/off actions.
 */
export function ReadyToWorkSegment({
  isDesktopShell = isDesktop,
  readyToWork = desktopAPI?.readyToWork,
  standardSegment,
}: {
  isDesktopShell?: boolean;
  readyToWork?: DesktopReadyToWorkAPI;
  /** Test seam; production retains the established WorkstationSegment. */
  standardSegment?: ReactNode;
} = {}) {
  const [status, setStatus] = useState<ReadyToWorkAggregateStatus | null>(null);
  const [loading, setLoading] = useState(Boolean(isDesktopShell && readyToWork));
  const [error, setError] = useState(false);
  const [presentationMode, setPresentationMode] = useState(readReadyToWorkPresentationMode);

  const applyStatus = useCallback((next: ReadyToWorkAggregateStatus) => {
    setStatus(next);
    setError(false);
    setLoading(false);
  }, []);

  useEffect(() => {
    return onReadyToWorkPresentationModeChanged(setPresentationMode);
  }, []);

  useEffect(() => {
    if (!isDesktopShell || !readyToWork) {
      setStatus(null);
      setLoading(false);
      setError(false);
      return;
    }

    let cancelled = false;
    let receivedSubscriptionStatus = false;
    setLoading(true);
    setError(false);
    const unsubscribe = readyToWork.onStatusChanged((next) => {
      receivedSubscriptionStatus = true;
      if (!cancelled) applyStatus(next);
    });
    void readyToWork.get().then((next) => {
      if (!cancelled && !receivedSubscriptionStatus) applyStatus(next);
    }).catch(() => {
      if (!cancelled && !receivedSubscriptionStatus) {
        setLoading(false);
        setError(true);
      }
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [applyStatus, isDesktopShell, readyToWork]);

  // Ready to work owns the default composer slot. The legacy Workstation
  // control returns only when the person explicitly chooses Individual controls.
  // Before the aggregate resolves, report uncertainty rather than claim On.
  if (!isDesktopShell || !readyToWork) return standardSegment ?? <WorkstationSegment />;
  if (status?.mode === "standard") {
    return presentationMode === "individual"
      ? standardSegment ?? <WorkstationSegment />
      : <ReadyToWorkSetupSegment />;
  }
  if (!status || loading || error) {
    return (
      <span
        aria-live="polite"
        aria-label={loading ? "Ready to work: Checking…" : error ? "Ready to work: Unavailable" : "Ready to work: Checking…"}
        className="inline-flex min-w-0 items-center rounded px-1.5 py-0.5 text-[11px] text-foreground-muted"
      >
        {compactStatusLabel(loading, error)}
      </span>
    );
  }
  return <ReadyToWorkStatusSegment status={status} readyToWork={readyToWork} onStatus={applyStatus} />;
}

function ReadyToWorkSetupSegment() {
  const navigate = useNavigate();
  return (
    <button
      type="button"
      aria-label="Ready to work: Set up"
      onClick={() => { void navigate("/settings#startup"); }}
      className="inline-flex min-w-0 items-center whitespace-nowrap rounded px-1.5 py-0.5 text-[11px] text-[var(--warning)] transition-colors hover:bg-[var(--warning)]/10 focus:outline-none focus:ring-1 focus:ring-primary"
    >
      Ready: Set up
    </button>
  );
}

function ReadyToWorkStatusSegment({
  status,
  readyToWork,
  onStatus,
}: {
  status: ReadyToWorkAggregateStatus;
  readyToWork: DesktopReadyToWorkAPI;
  onStatus: (status: ReadyToWorkAggregateStatus) => void;
}) {
  const navigate = useNavigate();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [popoverPosition, setPopoverPosition] = useState<ReadyToWorkPopoverPosition | null>(null);
  const [restoring, setRestoring] = useState(false);
  const [restoreError, setRestoreError] = useState(false);
  const selected = useMemo(() => selectedComponents(status), [status]);
  const readyCount = selected.filter((component) => component.state === "ready").length;
  const isFullyReady = selected.length > 0 && readyCount === selected.length;
  const blocker = selected.find((component) => component.state !== "ready");
  const blockerCopy = blocker ? conciseBlockerCopy(blocker) : null;
  const blockerRepair = blocker ? repairDestination(blocker) : null;
  const accessibleLabel = isFullyReady
    ? "Ready to work: On"
    : `Ready to work: ${readyCount}/${selected.length}${blockerCopy ? ` · ${blockerCopy}` : ""}`;
  const visibleLabel = isFullyReady
    ? "Ready: On"
    : `Ready: ${readyCount}/${selected.length}${blockerCopy ? ` · ${blockerCopy}` : ""}`;

  const reposition = useCallback(() => {
    const rect = triggerRef.current?.getBoundingClientRect();
    if (rect) setPopoverPosition(computeReadyToWorkPopoverPosition(rect));
  }, []);

  const close = useCallback((restoreFocus = false) => {
    setOpen(false);
    setPopoverPosition(null);
    if (restoreFocus) triggerRef.current?.focus();
  }, []);

  useLayoutEffect(() => {
    if (open) reposition();
  }, [open, reposition]);

  useEffect(() => {
    if (open && popoverPosition) popoverRef.current?.focus();
  }, [open, popoverPosition]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!popoverRef.current?.contains(event.target as Node) && !triggerRef.current?.contains(event.target as Node)) {
        close(false);
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        close(true);
      }
    };
    const onScrollOrResize = () => reposition();
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    window.addEventListener("resize", onScrollOrResize);
    window.addEventListener("scroll", onScrollOrResize, true);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("resize", onScrollOrResize);
      window.removeEventListener("scroll", onScrollOrResize, true);
    };
  }, [close, open, reposition]);

  const restore = async () => {
    setRestoring(true);
    setRestoreError(false);
    try {
      onStatus(await readyToWork.restore());
    } catch {
      setRestoreError(true);
    } finally {
      setRestoring(false);
    }
  };

  const navigateTo = (href: string) => {
    close(false);
    void navigate(href);
  };

  return (
    <div className="relative min-w-0">
      <button
        ref={triggerRef}
        type="button"
        aria-label={accessibleLabel}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls="ready-to-work-popover"
        onClick={() => setOpen((current) => !current)}
        className={[
          "inline-flex max-w-full min-w-0 items-center overflow-hidden whitespace-nowrap rounded px-1.5 py-0.5 text-[11px] transition-colors focus:outline-none focus:ring-1 focus:ring-primary",
          isFullyReady
            ? "text-[var(--success)] hover:bg-[var(--success)]/10"
            : "text-foreground-muted hover:bg-background-element hover:text-foreground",
        ].join(" ")}
      >
        <span aria-live="polite" className="overflow-hidden text-ellipsis whitespace-nowrap">{visibleLabel}</span>
      </button>
      {open && popoverPosition ? createPortal(
        <div
          ref={popoverRef}
          id="ready-to-work-popover"
          role="dialog"
          aria-label="Ready to work details"
          tabIndex={-1}
          style={{
            position: "fixed",
            left: popoverPosition.left,
            width: popoverPosition.width,
            maxHeight: popoverPosition.maxHeight,
            ...("top" in popoverPosition
              ? { top: popoverPosition.top }
              : { bottom: popoverPosition.bottom }),
            zIndex: 60,
          }}
          className="overflow-y-auto rounded-md border border-border-strong bg-background-panel p-3 shadow-lg focus:outline-none"
        >
          <p className="text-sm font-medium text-foreground">Ready to work</p>
          {blockerCopy ? blockerRepair ? (
            <button
              type="button"
              onClick={() => navigateTo(blockerRepair.href)}
              className="mt-2 flex w-full items-center justify-between gap-3 rounded bg-[var(--warning)]/10 px-2 py-1.5 text-left text-xs text-foreground transition-colors hover:bg-[var(--warning)]/15 focus:outline-none focus:ring-1 focus:ring-[var(--warning)]"
              aria-label={`Review ${displayLabel(blocker!)}`}
            >
              <span><span className="font-semibold text-[var(--warning)]">Needs attention:</span> {blockerCopy}.</span>
              <span className="shrink-0 font-semibold text-primary">Review →</span>
            </button>
          ) : <p role="status" className="mt-2 rounded bg-[var(--warning)]/10 px-2 py-1.5 text-xs text-foreground"><span className="font-semibold text-[var(--warning)]">Needs attention:</span> {blockerCopy}.</p> : null}
          <ul className="mt-2 divide-y divide-border/60">
            {selected.map((component) => {
              const repair = component !== blocker && component.state !== "ready"
                ? repairDestination(component)
                : null;
              const detail = component.state === "ready"
                ? "Ready"
                : REASON_COPY[component.reason ?? "restore_requested"];
              return (
                <li key={component.id} className="flex items-start justify-between gap-3 py-1.5 text-xs">
                <span className="font-medium text-foreground">{displayLabel(component)}</span>
                  <span className="flex max-w-48 flex-col items-end gap-1 text-right text-foreground-muted">
                    <span>{detail}</span>
                    {repair ? <button type="button" onClick={() => navigateTo(repair.href)} className="font-medium text-primary hover:underline">{repair.label}</button> : null}
                  </span>
                </li>
              );
            })}
          </ul>
          {restoreError ? <p role="alert" className="mt-2 text-xs text-error">Ready to work could not be restored.</p> : null}
          <div className="mt-3 flex items-center justify-between gap-3">
            {!isFullyReady ? <button type="button" disabled={restoring} onClick={() => { void restore(); }} className="rounded border border-border px-2 py-1 text-xs font-medium text-foreground hover:bg-background-element disabled:opacity-60">{restoring ? "Restoring…" : "Restore Ready"}</button> : <span />}
            <Link to="/settings#startup" onClick={() => close(false)} className="text-xs font-medium text-primary hover:underline">Startup settings</Link>
          </div>
        </div>,
        document.body,
      ) : null}
    </div>
  );
}
