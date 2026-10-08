import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import type { AgentAccessStatus, AgentAccessReason } from "../../../desktop/electron/ready-to-work-contract";
import { desktopAPI, type DesktopReadyToWorkAPI, type DesktopUncontainedHostCommandsAPI, type DesktopWorkstationProfilesAPI } from "../lib/desktop";
import { useAgentAccess } from "../hooks/use-agent-access";
import { createWorkbenchPortal } from "./workbench-portals";
import { PinDialog } from "./pin-dialog";

const REASON_COPY: Record<AgentAccessReason, string> = {
  authentication_unavailable: "Sign in to check Agent access.",
  relay_reconnecting: "Reconnecting to this Desktop…",
  managed_execution_unavailable: "This connection cannot run managed commands.",
  development_not_active: "Development is selected but is not active.",
  full_mac_unconfirmed: "Full Mac status is unconfirmed.",
  saved_state_unavailable: "Your saved access choice could not be read.",
  not_selected: "This access choice is off.",
  restore_requested: "Your selected access has not restored yet.",
  owner_unavailable: "The access owner is unavailable on this Desktop.",
  owner_rejected: "The access owner could not enable this choice.",
  authority_changed: "Your signed-in connection changed. Check current access.",
  os_protection_unavailable: "Protected startup storage is unavailable on this Desktop.",
  startup_receipt_missing: "Your saved choice needs its protected startup receipt.",
  startup_receipt_invalid: "The protected startup receipt could not be validated.",
  workstation_profile_update_needed: "Your Development profile needs review and updating.",
  workstation_capability_missing: "Development is missing a required capability.",
  workstation_relay_unavailable: "Development cannot reach its Desktop relay.",
  computer_use_setup_required: "Computer Use needs setup.",
  computer_use_accessibility_required: "Computer Use needs macOS Accessibility permission.",
  computer_use_screen_recording_required: "Computer Use needs macOS Screen Recording permission.",
  computer_use_provider_unavailable: "The Computer Use provider is unavailable.",
  coding_connection_unavailable: "The coding connection is unavailable.",
  coding_harness_starting: "The coding connection is starting.",
  coding_harness_not_installed: "The coding harness is not installed.",
  coding_harness_sign_in_required: "The coding connection needs sign-in.",
  coding_harness_unavailable: "The coding harness is unavailable.",
};

function readinessCopy(status: AgentAccessStatus | null, loading: boolean): string {
  if (loading) return "Checking current access…";
  if (!status) return "Current access is unavailable.";
  if (status.readiness === "reconnecting") return "Reconnecting to this Desktop…";
  if (status.readiness === "needs_attention") return status.reason ? REASON_COPY[status.reason] : "Current access needs attention.";
  return status.capabilities.commands ? "Commands ready." : "Commands are unavailable on this connection.";
}

export function AgentAccessControl({ readyToWork = desktopAPI?.readyToWork,
  fullMac = desktopAPI?.uncontainedHostCommands, compact = false, workstationProfiles = desktopAPI?.workstationProfiles,
}: { readyToWork?: DesktopReadyToWorkAPI; fullMac?: DesktopUncontainedHostCommandsAPI; compact?: boolean; workstationProfiles?: Pick<DesktopWorkstationProfilesAPI, "materializeSeedProfile" | "prepareActivation"> } = {}) {
  const access = useAgentAccess(readyToWork);
  const [pinAction, setPinAction] = useState<"development" | "full_mac" | null>(null);
  type Review = Extract<Awaited<ReturnType<DesktopWorkstationProfilesAPI["prepareActivation"]>>, { ok: true }>["data"];
  const [developmentReview, setDevelopmentReview] = useState<Review | null>(null);
  const [reviewing, setReviewing] = useState(false);
  const [reviewError, setReviewError] = useState<string | null>(null);
  const reviewPending = useRef(false);
  const [fullMacBusy, setFullMacBusy] = useState(false);
  const [fullMacError, setFullMacError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<{ left: number; width: number; top?: number; bottom?: number; maxHeight: number } | null>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const popover = useRef<HTMLDivElement>(null);
  const popoverId = useId();
  useLayoutEffect(() => {
    if (!compact || !open) return;
    const reposition = () => {
      const rect = trigger.current?.getBoundingClientRect();
      if (!rect) return;
      const margin = 8, gap = 4;
      const width = Math.max(0, Math.min(320, window.innerWidth - margin * 2));
      const left = Math.max(margin, Math.min(rect.right - width, window.innerWidth - width - margin));
      const above = Math.max(0, rect.top - margin - gap);
      const below = Math.max(0, window.innerHeight - rect.bottom - margin - gap);
      setPosition({ left, width, ...(above >= below ? { bottom: window.innerHeight - rect.top + gap, maxHeight: above } : { top: rect.bottom + gap, maxHeight: below }) });
    };
    const dismiss = (event: PointerEvent) => {
      if (!popover.current?.contains(event.target as Node) && !trigger.current?.contains(event.target as Node)) setOpen(false);
    };
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") { event.preventDefault(); setOpen(false); trigger.current?.focus(); } };
    reposition();
    document.addEventListener("pointerdown", dismiss);
    document.addEventListener("keydown", escape);
    window.addEventListener("resize", reposition);
    window.addEventListener("scroll", reposition, true);
    return () => { document.removeEventListener("pointerdown", dismiss); document.removeEventListener("keydown", escape); window.removeEventListener("resize", reposition); window.removeEventListener("scroll", reposition, true); };
  }, [compact, open]);
  useEffect(() => { if (open && position) popover.current?.focus(); }, [open, position]);
  const pending = useRef(false);
  const mounted = useRef(true);
  const context = useRef(0);
  const retire = useCallback(() => { mounted.current = false; ++context.current; }, []);
  useEffect(() => {
    mounted.current = true;
    ++context.current;
    const invalidate = () => { ++context.current; setPinAction(null); setDevelopmentReview(null); setReviewError(null); setFullMacError(null); setOpen(false); };
    window.addEventListener("nautilo:auth-changed", invalidate);
    return () => { retire(); window.removeEventListener("nautilo:auth-changed", invalidate); };
  }, [readyToWork, fullMac, workstationProfiles, retire]);
  if (!access.supported) return null;
  const status = access.status;
  const busy = access.busy || fullMacBusy || reviewing;
  const label = status?.sandboxedChoice === "development" ? "Development" : status?.sandboxedChoice === "basic" ? "Basic" : access.loading ? "Checking…" : "Unavailable";
  const fullMacCopy = access.loading ? "Checking…" : !status ? "Status unconfirmed" : status.fullMac.state === "active" ? "Active for this app session" : status?.fullMac.state === "unconfirmed" ? "Status unconfirmed" : "Inactive";

  const beginDevelopment = async () => {
    if (reviewPending.current) return;
    reviewPending.current = true; setReviewing(true); setReviewError(null); setDevelopmentReview(null);
    const requestContext = context.current;
    const current = () => mounted.current && context.current === requestContext;
    try {
      if (!workstationProfiles) throw new Error("Profile review unavailable");
      const stored = await workstationProfiles.materializeSeedProfile();
      if (!current()) return;
      if (!stored.ok) throw new Error("Profile unavailable");
      const reviewed = await workstationProfiles.prepareActivation();
      if (!current()) return;
      if (!reviewed.ok || !reviewed.data.scope || reviewed.data.seed.id !== stored.data.profile.id
        || reviewed.data.seed.revision !== stored.data.profile.revision
        || reviewed.data.seed.protectedPolicyVersion !== stored.data.profile.protectedPolicyVersion) throw new Error("Profile changed during review");
      setDevelopmentReview(reviewed.data); setOpen(false); setPinAction("development");
    } catch {
      if (current()) setReviewError("Development scope could not be reviewed. Check the profile and try again.");
    } finally { reviewPending.current = false; if (mounted.current) setReviewing(false); }
  };

  const changeFullMac = async (pin?: string) => {
    if (!fullMac || pending.current) return;
    pending.current = true; setFullMacBusy(true); setFullMacError(null);
    const requestContext = context.current;
    try {
      const result = pin === undefined ? await fullMac.disable() : await fullMac.activate({ pin });
      if (!mounted.current || context.current !== requestContext) return;
      if (!result.ok) { setFullMacError("Temporary Full Mac access could not be changed. Check the connection and try again."); return; }
      setPinAction(null);
      window.dispatchEvent(new CustomEvent("nautilo:uncontained-host-commands-changed"));
      await access.refresh();
    } catch {
      if (mounted.current && context.current === requestContext) setFullMacError("Temporary Full Mac access could not be confirmed. Check its current status before trying again.");
    } finally { pending.current = false; if (mounted.current) setFullMacBusy(false); }
  };
  const submit = async (pin: string) => {
    if (pinAction === "full_mac") { await changeFullMac(pin); return; }
    if (!developmentReview) return;
    if (await access.choose("development", pin, { profileId: developmentReview.seed.id, profileRevision: developmentReview.seed.revision })) setPinAction(null);
  };
  const content = <div className="space-y-3">
    <div role="radiogroup" aria-label="Agent access on this Mac" className="flex gap-1 rounded-md border border-border p-1">
      {(["basic", "development"] as const).map(choice => <button key={choice} type="button" role="radio"
        aria-checked={status?.sandboxedChoice === choice} disabled={busy || (choice === "development" && access.loading)}
        onClick={() => { if (status?.sandboxedChoice === choice) return; if (choice === "basic") { setPinAction(null); void access.choose(choice); } else void beginDevelopment(); }}
        className={`flex-1 rounded px-3 py-1.5 text-sm ${status?.sandboxedChoice === choice ? "bg-background-element text-foreground" : "text-foreground-muted"}`}>
        {choice === "basic" ? "Basic" : "Development"}
      </button>)}
    </div>
    <p className="text-xs text-foreground-muted">Basic keeps work contained. Development uses a profile you review with your PIN.</p>
    <p role="status" aria-live="polite" className="text-xs text-foreground-muted">{readinessCopy(status, access.loading)}</p>
    {reviewing && <p role="status" className="text-xs text-foreground-muted">Reading Development scope…</p>}
    {status?.choiceReason === "saved_state_unavailable" && status.reason !== "saved_state_unavailable" && <p className="text-xs text-foreground-muted">Your saved choice could not be read.</p>}
    {status?.repairAction === "restore_development" ? <button type="button" disabled={busy || access.loading} onClick={() => { void access.restoreDevelopment(); }} className="text-xs text-primary">Restore Development</button>
      : status?.repairAction === "review_development" ? <button type="button" disabled={busy || access.loading} onClick={() => { void beginDevelopment(); }} className="text-xs text-primary">Review Development with PIN</button>
        : status?.repairAction === "open_settings" ? <a href="/settings#startup" className="text-xs text-primary">Open settings</a>
        : status?.repairAction === "retry" || access.error ? <button type="button" disabled={busy} onClick={() => { void access.refresh(); }} className="text-xs text-primary">Retry status</button> : null}
    <details className="border-t border-border pt-2">
      <summary className="cursor-pointer text-xs text-foreground-muted">Temporary Full Mac access · {fullMacCopy}</summary>
      <div className="mt-2 space-y-2 text-xs text-foreground-muted">
        <p>Runs as your macOS account across what it can access. This is separate from Basic and Development and ends with this app session.</p>
        <p>Agent-created Full Mac terminals are not supported. Human terminal handoff is separate.</p>
        {status?.fullMac.state === "active" && <p>{status.capabilities.fullMacOneShot ? "Command access is ready." : "Managed command access is unavailable in this mode."}</p>}
        {!status || status.fullMac.state === "active" || status.fullMac.state === "unconfirmed"
          ? <button type="button" disabled={busy || !fullMac} onClick={() => { void changeFullMac(); }} className="text-primary">Turn off Full Mac access</button>
          : <button type="button" disabled={busy || access.loading || !fullMac || !status?.fullMac.eligible} onClick={() => { setFullMacError(null); setPinAction("full_mac"); }} className="text-primary">Enable temporarily with PIN</button>}
      </div>
    </details>
    {access.error || fullMacError || reviewError ? <p role="alert" className="text-xs text-error">{reviewError ?? fullMacError ?? access.error}</p> : null}
  </div>;
  return <>
    {compact ? <>
      <button ref={trigger} type="button" aria-haspopup="dialog" aria-expanded={open} aria-controls={open ? popoverId : undefined}
        onClick={() => { if (!open) void access.refresh(); setOpen(current => !current); }} className="rounded px-1.5 py-0.5 text-[11px] text-foreground-muted">Agent access: {label}</button>
      {open && position ? createWorkbenchPortal(<div ref={popover} id={popoverId} role="dialog" aria-label="Agent access on this Mac" tabIndex={-1}
        style={position} className="fixed z-50 overflow-y-auto rounded-md border border-border bg-background-panel p-3 shadow-lg">{content}</div>, document.body) : null}
    </> : <section aria-label="Agent access on this Mac" className="space-y-2"><h3 className="text-sm font-semibold">Agent access on this Mac</h3>{content}</section>}
    {pinAction && createWorkbenchPortal(<PinDialog title={pinAction === "development" ? "Choose Development" : "Enable temporary Full Mac access"}
      prompt={pinAction === "development" ? "Review the Development scope below, then enter your PIN to enable it." : "Enter your PIN to allow temporary access as your macOS account."}
      details={pinAction === "development" && developmentReview ? <div className="mt-3 max-h-56 space-y-2 overflow-y-auto rounded-md border border-border p-3 text-xs text-foreground-muted">
        <p className="font-medium text-foreground">{developmentReview.seed.name} · revision {developmentReview.seed.revision}</p>
        <p>Current Folder: {developmentReview.scope.currentProject ?? "No project selected"}. Read and write authority follows your current selection and is checked for every command.</p>
        <div><p className="font-medium">Additional profile locations</p>{developmentReview.scope.roots.length ? <ul>{developmentReview.scope.roots.map((root, index) => <li key={`${index}:${root.path}`}>{root.path} · {root.access.map(access => access === "create_modify" ? "create and modify files" : access).join(", ")}</li>)}</ul> : <p>None.</p>}</div>
        <p>Network: {developmentReview.scope.network.mode === "host" ? "Destinations available to this Mac, including the internet." : developmentReview.scope.network.mode === "isolated" ? "Isolated network." : developmentReview.scope.network.allow.map(rule => `${rule.kind}: ${rule.value}`).join(", ") || "No allowed destinations."}</p>
        <p>Tools: {developmentReview.seed.capabilities.map(capability => capability.id).join(", ") || "None declared"}.</p>
        <p>Environment names: {developmentReview.scope.environmentKeys.join(", ") || "None"}.</p>
        <p>Tool and network access can send data to reachable destinations. This does not grant Full Mac access.</p>
      </div> : undefined}
      error={fullMacError ?? access.error ?? undefined} submitting={busy} submittingLabel="Checking access…"
      onCancel={() => { if (!busy) setPinAction(null); }} onSubmit={pin => { void submit(pin); }} />, document.body)}
  </>;
}
