import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import type {
  ReadyToWorkAggregateStatus,
  ReadyToWorkCodingHarnessId,
  ReadyToWorkCodingHarnessStatus,
  ReadyToWorkComponentId,
  ReadyToWorkComponentStatus,
  ReadyToWorkReason,
  ReadyToWorkRepairTarget,
  ReadyToWorkSelection,
} from "../../../../../desktop/electron/ready-to-work-contract";
import { PinDialog } from "../../../components/pin-dialog";
import { supportsAgentAccess } from "../../../hooks/use-agent-access";
import { desktopAPI, isDesktop, type DesktopReadyToWorkAPI } from "../../../lib/desktop";
import {
  readReadyToWorkPresentationMode,
  writeReadyToWorkPresentationMode,
  type ReadyToWorkPresentationMode,
} from "../../../lib/ready-to-work-presentation";
import { Button, SectionCard } from "../ui";

const DEFAULT_SELECTION: ReadyToWorkSelection = {
  voice: true,
  auto_approve: true,
  workstation: true,
  computer_use: true,
  coding_connection: true,
};

const COMPONENTS: ReadonlyArray<{ id: ReadyToWorkComponentId; label: string }> = [
  { id: "voice", label: "Voice" },
  { id: "auto_approve", label: "Auto-approve" },
  { id: "workstation", label: "Developer Workstation" },
  { id: "computer_use", label: "Computer Use" },
];
const HARNESS_LABELS: Record<ReadyToWorkCodingHarnessId, string> = {
  codex: "Codex",
  "hermes-acp": "Hermes",
};
type ReadyDisplayStatus = ReadyToWorkComponentStatus | ReadyToWorkCodingHarnessStatus;

const REASON_COPY: Record<ReadyToWorkReason, string> = {
  saved_state_unavailable: "Saved startup settings are unavailable.",
  not_selected: "This choice is off.",
  restore_requested: "Ready to work has not restored this choice yet.",
  owner_unavailable: "The feature owner is unavailable on this Desktop.",
  owner_rejected: "The feature owner rejected the requested setup.",
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
  startup_settings: { href: "/settings#startup", label: "Open Ready at startup" },
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
    return { href: "/settings#desktop-permissions", label: "Open macOS permissions" };
  }
  return REPAIR_DESTINATIONS[component.repairTarget];
}

function selectionFromStatus(status: ReadyToWorkAggregateStatus, managedAccess: boolean): ReadyToWorkSelection {
  const selected = (id: ReadyToWorkComponentId) =>
    managedAccess ? status.components.some(item => item.id === id && item.state !== "off_by_choice")
      : status.components.find((item) => item.id === id)?.state !== "off_by_choice";
  return {
    voice: selected("voice"),
    auto_approve: selected("auto_approve"),
    workstation: selected("workstation"),
    computer_use: selected("computer_use"),
    // Harness membership comes from each Connection's canonical owner toggle.
    coding_connection: managedAccess ? selected("coding_connection") : true,
  };
}

function displayError(cause: unknown, fallback: string): string {
  // Desktop error messages are intentionally not rendered: they can contain
  // platform details and never help a person safely recover from this card.
  void cause;
  return fallback;
}

function ComponentStatus({ component }: { component: ReadyDisplayStatus }) {
  const navigate = useNavigate();
  const stateLabel = component.state === "ready"
    ? "Ready"
    : component.state === "off_by_choice"
      ? "Off by choice"
      : REASON_COPY[component.reason ?? "restore_requested"];
  const repair = repairDestination(component);

  return (
    <li className="flex items-center justify-between gap-3 py-1.5 text-sm">
      <span className="font-medium text-foreground">{
        component.id === "codex" || component.id === "hermes-acp"
          ? HARNESS_LABELS[component.id]
          : COMPONENTS.find((item) => item.id === component.id)?.label
      }</span>
      <span className="flex items-center gap-2 text-right text-foreground-muted">
        <span>{stateLabel}</span>
        {repair ? <button type="button" onClick={() => { void navigate(repair.href); }} className="text-xs font-medium text-primary hover:underline">{repair.label}</button> : null}
      </span>
    </li>
  );
}

/** Desktop-local desired startup posture; it is never a feature authority. */
export function StartupSection({
  isDesktopShell = isDesktop,
  readyToWork = desktopAPI?.readyToWork,
}: {
  isDesktopShell?: boolean;
  readyToWork?: DesktopReadyToWorkAPI;
} = {}) {
  const [status, setStatus] = useState<ReadyToWorkAggregateStatus | null>(null);
  const [selection, setSelection] = useState<ReadyToWorkSelection>({ ...DEFAULT_SELECTION });
  const [desiredMode, setDesiredMode] = useState<ReadyToWorkPresentationMode>(
    readReadyToWorkPresentationMode,
  );
  const [loading, setLoading] = useState(Boolean(isDesktopShell && readyToWork));
  const [saving, setSaving] = useState(false);
  const [pinPromptOpen, setPinPromptOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const offRequested = useRef(false);
  const statusVersion = useRef(0);
  const managedAccess = supportsAgentAccess(readyToWork);
  const componentAPIReady = !managedAccess || !!(readyToWork?.enrollComponents && readyToWork.disableComponents && readyToWork.restoreComponents);
  const components = managedAccess ? COMPONENTS.filter(item => item.id !== "workstation") : COMPONENTS;

  const applyStatus = useCallback((next: ReadyToWorkAggregateStatus) => {
    statusVersion.current += 1;
    setStatus(next);
    setLoading(false);
    if (next.mode === "ready") {
      offRequested.current = false;
      const nextSelection = selectionFromStatus(next, managedAccess);
      setSelection(nextSelection);
      const componentMode = !managedAccess || nextSelection.voice || nextSelection.auto_approve || nextSelection.computer_use || nextSelection.coding_connection ? "ready" : "individual";
      setDesiredMode(componentMode);
      writeReadyToWorkPresentationMode(componentMode);
    } else if (next.mode === "standard" && offRequested.current) {
      setDesiredMode("individual");
      writeReadyToWorkPresentationMode("individual");
      offRequested.current = false;
    }
    setError(null);
  }, [managedAccess]);

  useEffect(() => {
    if (!isDesktopShell || !readyToWork) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    let receivedSubscriptionStatus = false;
    const unsubscribe = readyToWork.onStatusChanged((next) => {
      receivedSubscriptionStatus = true;
      if (!cancelled) applyStatus(next);
    });
    void readyToWork.get().then((next) => {
      if (!cancelled && !receivedSubscriptionStatus) applyStatus(next);
    }).catch((cause) => {
      if (!cancelled && !receivedSubscriptionStatus) setError(displayError(cause, "Ready to work status could not be loaded."));
    }).finally(() => {
      if (!cancelled && !receivedSubscriptionStatus) setLoading(false);
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [applyStatus, isDesktopShell, readyToWork]);

  const selectedCount = components.filter((component) => selection[component.id]).length;
  const enabledHarnesses = status?.codingHarnesses ?? [];
  const includedCount = selectedCount + enabledHarnesses.length;
  const includedTotal = components.length + enabledHarnesses.length;

  if (!isDesktopShell) return null;

  const isEnrolled = status?.mode === "ready" && (!managedAccess || status.components.some(component => component.id !== "workstation" && component.state !== "off_by_choice"));
  const canChooseReady = Boolean(readyToWork && !loading && !saving && componentAPIReady);
  const showIndividualAction = isEnrolled && desiredMode === "individual";

  const submitPin = async (pin: string) => {
    if (!readyToWork || !componentAPIReady) return;
    setSaving(true);
    setError(null);
    try {
      const { workstation: _workstation, ...componentSelection } = selection;
      applyStatus(await (managedAccess
        ? readyToWork.enrollComponents!({ selection: componentSelection, pin })
        : readyToWork.enroll({ selection, pin })));
      setPinPromptOpen(false);
    } catch (cause) {
      setError(displayError(cause, "Ready to work could not be enabled. Nothing was changed. Try again."));
    } finally {
      setSaving(false);
    }
  };

  const restore = async () => {
    if (!readyToWork || !componentAPIReady) return;
    setSaving(true);
    setError(null);
    try {
      if (managedAccess && !readyToWork.restoreComponents) throw new Error("Component restore requires a compatible Desktop");
      applyStatus(await (managedAccess ? readyToWork.restoreComponents!() : readyToWork.restore()));
    } catch (cause) {
      setError(displayError(cause, "Ready to work could not be restored."));
    } finally {
      setSaving(false);
    }
  };

  const disable = async () => {
    if (!readyToWork || !componentAPIReady) return;
    offRequested.current = true;
    setSaving(true);
    setError(null);
    try {
      if (managedAccess && !readyToWork.disableComponents) throw new Error("Component reduction requires a compatible Desktop");
      const next = await (managedAccess ? readyToWork.disableComponents!() : readyToWork.disable());
      applyStatus(next);
    } catch (cause) {
      setError(displayError(cause, "Ready to work could not be turned off."));
    } finally {
      setSaving(false);
    }
  };

  const retryStatus = async () => {
    if (!readyToWork) return;
    const requestedVersion = statusVersion.current;
    setSaving(true);
    setError(null);
    try {
      const next = await readyToWork.get();
      if (statusVersion.current === requestedVersion) applyStatus(next);
    } catch {
      if (statusVersion.current === requestedVersion) setError("Ready to work status could not be refreshed. Current access may be unchanged.");
    } finally {
      setSaving(false);
    }
  };

  if (status?.mode === "needs_attention") {
    const persistence = status.persistence;
    const primaryCopy = persistence?.liveAccess === "stopping"
      ? "Stopping current access. Saved startup settings still need attention."
      : "Saved settings need attention. Check the individual controls for current access.";
    const reasonCopy = persistence?.reason === "unsupported"
      ? "Use a compatible Desktop version to read these saved settings."
      : persistence?.reason === "invalid"
        ? "The saved settings could not be validated. Retry the status check or turn off Ready to work."
        : "Retry the status check. Turning off Ready to work will be confirmed only when Desktop reports Standard.";

    return (
      <SectionCard
        id="startup"
        title="Ready at startup"
        description="Choose how this Nautilo Desktop starts. Ready to work records your choices; it does not grant feature access."
      >
        <div role="status" aria-live="polite" className="space-y-2 rounded-md border border-[var(--warning)]/40 bg-[var(--warning)]/5 px-3 py-3">
          <p className="text-sm font-medium text-foreground">Needs attention</p>
          <p className="text-sm text-foreground-muted">{primaryCopy}</p>
          <p className="text-sm text-foreground-muted">{reasonCopy}</p>
        </div>
        {error ? <p role="alert" className="text-sm text-error">{error}</p> : null}
        <div className="mt-3 flex flex-wrap gap-2">
          <Button variant="secondary" onClick={() => { void retryStatus(); }} loading={saving}>Retry status</Button>
          <Button variant="secondary" onClick={() => { void disable(); }} disabled={!componentAPIReady} loading={saving}>
            {persistence?.liveAccess === "stopping" ? "Retry turn off" : "Turn off Ready to work"}
          </Button>
        </div>
      </SectionCard>
    );
  }

  return (
    <SectionCard
      id="startup"
      title="Ready at startup"
      description="Choose how this Nautilo Desktop starts. Ready to work records your choices; it does not grant feature access."
    >
      {!readyToWork ? <p className="text-sm text-foreground-muted">Ready to work requires a current Nautilo Desktop build.</p> : null}
      {managedAccess && !componentAPIReady ? <p className="text-sm text-foreground-muted">A compatible Desktop is required to change startup components without changing Development.</p> : null}
      {loading ? <p className="text-sm text-foreground-muted" role="status">Loading Ready to work status…</p> : null}
      {readyToWork && !loading ? <div className="space-y-4">
        <fieldset disabled={!canChooseReady} aria-describedby="startup-mode-description" className="space-y-2">
          <legend className="sr-only">Startup mode</legend>
          <p id="startup-mode-description" className="text-sm text-foreground-muted">Pick one startup posture for this Desktop.</p>
          <label className="flex cursor-pointer items-start gap-3 rounded-md border border-border px-3 py-2 has-[:checked]:border-primary has-[:checked]:bg-primary/5">
            <input type="radio" name="startup-mode" value="ready" checked={desiredMode === "ready"} onChange={() => setDesiredMode("ready")} />
            <span><span className="block text-sm font-medium">Ready to work</span><span className="text-xs text-foreground-muted">Recommended. Starts core work controls and every coding harness you turned on.</span></span>
          </label>
          <label className="flex cursor-pointer items-start gap-3 rounded-md border border-border px-3 py-2 has-[:checked]:border-primary has-[:checked]:bg-primary/5">
            <input
              type="radio"
              name="startup-mode"
              value="individual"
              checked={desiredMode === "individual"}
              onChange={() => {
                setDesiredMode("individual");
                if (!isEnrolled) writeReadyToWorkPresentationMode("individual");
              }}
            />
            <span><span className="block text-sm font-medium">Individual controls</span><span className="text-xs text-foreground-muted">Use separate controls for each capability.</span></span>
          </label>
        </fieldset>

        {desiredMode === "ready" ? <details className="rounded-md border border-border px-3 py-2">
          <summary className="cursor-pointer text-sm text-foreground">Included choices ({includedCount} of {includedTotal})</summary>
          <div className="mt-2 grid gap-1 sm:grid-cols-2">
            {components.map((component) => <label key={component.id} className="flex items-center gap-2 text-sm text-foreground-muted">
              <input type="checkbox" checked={selection[component.id]} disabled={!canChooseReady} onChange={(event) => setSelection((current) => ({ ...current, [component.id]: event.target.checked }))} />
              {component.label}
            </label>)}
            {enabledHarnesses.map((harness) => <span key={harness.id} className="flex items-center gap-2 text-sm text-foreground-muted">
              <input type="checkbox" checked disabled aria-label={`${HARNESS_LABELS[harness.id]} included from Connections`} />
              {HARNESS_LABELS[harness.id]}
              <span className="text-xs text-foreground-dim">Connections</span>
            </span>)}
          </div>
          {enabledHarnesses.length === 0 ? <p className="mt-2 text-xs text-foreground-dim">No coding harnesses are turned on in Connections.</p> : null}
        </details> : null}

        {status?.mode === "ready" ? <div aria-live="polite" className="rounded-md border border-border px-3 py-2">
          <p className="text-xs font-semibold uppercase tracking-wide text-foreground-dim">Current status</p>
          <ul className="mt-1 divide-y divide-border/60">{
            status.components.filter((component) => (!managedAccess || component.id !== "workstation") && (status.codingHarnesses === undefined || component.id !== "coding_connection"))
              .map((component) => <ComponentStatus key={component.id} component={component} />)
          }{(status.codingHarnesses ?? []).map((harness) => <ComponentStatus key={harness.id} component={harness} />)}</ul>
        </div> : null}

        {error ? <p role="alert" className="text-sm text-error">{error}</p> : null}
        <div className="flex flex-wrap gap-2">
          {showIndividualAction ? <Button variant="secondary" onClick={() => { void disable(); }} disabled={!componentAPIReady} loading={saving}>Use individual controls</Button> : null}
          {!showIndividualAction && desiredMode === "ready" ? <Button variant="primary" onClick={() => setPinPromptOpen(true)} disabled={!canChooseReady || selectedCount === 0} loading={saving}>{isEnrolled ? "Update with PIN" : "Review and enable with PIN"}</Button> : null}
          {isEnrolled && desiredMode === "ready" ? <Button variant="secondary" onClick={() => { void restore(); }} disabled={!canChooseReady} loading={saving}>Restore Ready</Button> : null}
        </div>
      </div> : null}
      {pinPromptOpen ? <PinDialog
        title={isEnrolled ? "Update Ready to work" : "Enable Ready to work"}
        prompt="Enter your 6–8 digit PIN to confirm this Desktop startup choice."
        error={error ?? undefined}
        submitting={saving}
        submittingLabel="Checking and enabling…"
        onCancel={() => setPinPromptOpen(false)}
        onSubmit={(pin) => { void submitPin(pin); }}
      /> : null}
    </SectionCard>
  );
}
