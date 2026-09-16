import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { useAuth } from "../../hooks/use-auth";
import { desktopAPI, isDesktop, type DesktopSystemPermissionsAPI } from "../../lib/desktop";
import { stableViewerKeyForStorage } from "../../rooms/room-navigation-storage";
import { StatusPill } from "../settings/ui";
import { ConnectionDisclosureControl, useConnectionDisclosure } from "./connection-disclosure";
import { missingComputerUsePermissions } from "../../components/system-permissions-section";

export type ComputerUseState = "unavailable" | "not-enabled" | "enabled";
export type ComputerUseOwnedAgent = { agentId: string; displayName: string; handle: string };
export type ComputerUseProviderReadiness = {
  cua:
    | { ready: true; reason: null; lifecycle: "healthy" }
    | {
      ready: false;
      reason: "not_installed" | "not_checked" | "checking" | "unhealthy";
      lifecycle: "not_installed" | "installed" | "starting" | "unhealthy";
    };
};
export type ComputerUseEffectiveProvider = { provider: "cua" };

/** The renderer-safe local management port. It never receives a grant or provider runtime. */
export interface ComputerUseConnection {
  status: () => Promise<{
    state: ComputerUseState;
    reason: string | null;
    agentId: string | null;
    grantGeneration: number | null;
    canDisable: boolean;
    providers?: ComputerUseProviderReadiness;
    effectiveProvider?: ComputerUseEffectiveProvider | null;
  }>;
  ownedAgents: () => Promise<readonly ComputerUseOwnedAgent[]>;
  onStatusChanged?: (callback: () => void) => () => void;
  check?: () => Promise<unknown>;
  enable: (pin: string, agentId: string) => Promise<unknown>;
  disable: () => Promise<unknown>;
}

type ComputerUseStatus = {
  state: ComputerUseState;
  reason: string | null;
  agentId: string | null;
  grantGeneration: number | null;
  canDisable: boolean;
  providers: ComputerUseProviderReadiness | null;
  effectiveProvider: ComputerUseEffectiveProvider | null;
};

function failureMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error))
    .replace(/^Error invoking remote method '[^']+': Error: /, "");
}

function normalizeProviderReadiness(value: unknown): ComputerUseProviderReadiness | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const cua: unknown = Reflect.get(value, "cua");
  if (typeof cua !== "object" || cua === null || Array.isArray(cua)) return null;
  if (Reflect.get(cua, "ready") === true
    && Reflect.get(cua, "reason") === null
    && Reflect.get(cua, "lifecycle") === "healthy") {
    return { cua: { ready: true, reason: null, lifecycle: "healthy" } };
  }
  const lifecycle: unknown = Reflect.get(cua, "lifecycle");
  const strictUnavailable = Reflect.get(cua, "ready") === false
    && ((Reflect.get(cua, "reason") === "not_installed" && lifecycle === "not_installed")
      || (Reflect.get(cua, "reason") === "not_checked" && lifecycle === "installed")
      || (Reflect.get(cua, "reason") === "checking" && lifecycle === "starting")
      || (Reflect.get(cua, "reason") === "unhealthy" && lifecycle === "unhealthy"));
  if (strictUnavailable) {
    return {
      cua: lifecycle === "not_installed"
        ? { ready: false, reason: "not_installed", lifecycle }
        : lifecycle === "installed"
          ? { ready: false, reason: "not_checked", lifecycle }
          : lifecycle === "starting"
            ? { ready: false, reason: "checking", lifecycle }
            : { ready: false, reason: "unhealthy", lifecycle: "unhealthy" },
    };
  }
  // Older shells exposed only an observed Cua lifecycle. Reduce it to an
  // unavailable current-contract state; legacy bytes can never admit Cua.
  if (Reflect.get(cua, "ready") === false && Reflect.get(cua, "reason") === "adapter_not_admitted"
    && (lifecycle === "not_installed" || lifecycle === "installed" || lifecycle === "starting" || lifecycle === "healthy" || lifecycle === "unhealthy")) {
    return {
      cua: lifecycle === "not_installed"
        ? { ready: false, reason: "not_installed", lifecycle }
        : lifecycle === "installed"
          ? { ready: false, reason: "not_checked", lifecycle }
          : lifecycle === "starting"
            ? { ready: false, reason: "checking", lifecycle }
            : { ready: false, reason: "unhealthy", lifecycle: "unhealthy" },
    };
  }
  return null;
}

function cuaReadinessCopy(readiness: ComputerUseProviderReadiness | null): string {
  if (readiness?.cua.ready) return "Cua is checked, ready, and admitted for focus, snapshot-click, text, key, and deterministic verification Computer use tasks.";
  switch (readiness?.cua.lifecycle) {
    case "installed":
      return "Cua is embedded in this Desktop build and has not completed its automatic local readiness check. Choose Check to retry now.";
    case "starting":
      return "Cua is checking its local permissions and health.";
    case "unhealthy":
      return "Cua did not pass its local permission or health check. It remains unavailable for Computer use tasks.";
    case "not_installed":
      return "Cua is not present in this Nautilo Desktop build.";
    default:
      return "This Nautilo Desktop cannot report Cua lifecycle state. Update Nautilo Desktop to manage Computer use.";
  }
}

function isEffectiveProvider(
  value: unknown,
  readiness: ComputerUseProviderReadiness | null,
): value is ComputerUseEffectiveProvider {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const provider: unknown = Reflect.get(value, "provider");
  return provider === "cua" && readiness?.cua.ready === true;
}

function normalizeOwnedAgents(value: unknown): readonly ComputerUseOwnedAgent[] | null {
  if (!Array.isArray(value)) return null;
  const seen = new Set<string>();
  const agents: ComputerUseOwnedAgent[] = [];
  for (const raw of value) {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
    const agentId: unknown = Reflect.get(raw, "agentId");
    const displayName: unknown = Reflect.get(raw, "displayName");
    const handle: unknown = Reflect.get(raw, "handle");
    if (typeof agentId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(agentId)
      || typeof displayName !== "string" || typeof handle !== "string" || seen.has(agentId)) return null;
    seen.add(agentId);
    agents.push({ agentId, displayName, handle });
  }
  return agents;
}

function normalizeStatus(value: unknown, hasDesktopShell: boolean): ComputerUseStatus {
  if (value && typeof value === "object") {
    const candidate = value as Partial<ComputerUseStatus> & { reason?: unknown; providers?: unknown; effectiveProvider?: unknown };
    if (candidate.state === "unavailable" || candidate.state === "not-enabled" || candidate.state === "enabled") {
      const providers = normalizeProviderReadiness(candidate.providers);
      return {
        state: candidate.state,
        reason: typeof candidate.reason === "string" ? candidate.reason : null,
        agentId: typeof candidate.agentId === "string" ? candidate.agentId : null,
        grantGeneration: typeof candidate.grantGeneration === "number" && Number.isSafeInteger(candidate.grantGeneration) && candidate.grantGeneration > 0 ? candidate.grantGeneration : null,
        canDisable: candidate.canDisable === true,
        providers,
        effectiveProvider: isEffectiveProvider(candidate.effectiveProvider, providers) ? candidate.effectiveProvider : null,
      };
    }
  }
  return {
    state: "unavailable",
    reason: hasDesktopShell
      ? "Computer use is unavailable in this version of Nautilo Desktop."
      : "Computer use is available in the Nautilo desktop app.",
    agentId: null,
    grantGeneration: null,
    canDisable: false,
    providers: null,
    effectiveProvider: null,
  };
}

function ComputerUseSwitch({ enabled, disabled, onChange, buttonRef }: {
  enabled: boolean;
  disabled: boolean;
  onChange: (next: boolean) => void;
  buttonRef?: RefObject<HTMLButtonElement | null>;
}) {
  return <button type="button" role="switch" aria-checked={enabled}
    aria-label={`${enabled ? "Turn off" : "Turn on"} Computer use for Genie`}
    ref={buttonRef} disabled={disabled} onClick={() => onChange(!enabled)}
    className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors ${enabled ? "bg-[var(--success)]" : "bg-foreground-muted/40"} ${disabled ? "cursor-not-allowed opacity-50" : "cursor-pointer"}`}>
    <span className={`inline-block h-4 w-4 rounded-full bg-background shadow transition-transform ${enabled ? "translate-x-4" : "translate-x-0.5"}`} />
  </button>;
}

function ComputerUseEnableDialog({
  agents, selectedAgentId, onSelect, onSubmit, onCancel, error, busy,
}: {
  agents: readonly ComputerUseOwnedAgent[];
  selectedAgentId: string | null;
  onSelect: (agentId: string | null) => void;
  onSubmit: (pin: string) => void;
  onCancel: () => void;
  error?: string;
  busy: boolean;
}) {
  const [pin, setPin] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const selectRef = useRef<HTMLSelectElement>(null);
  const selectedAgent = agents.find((agent) => agent.agentId === selectedAgentId) ?? null;
  const canSubmit = selectedAgent !== null && pin.length >= 6 && !busy;

  useEffect(() => {
    if (selectedAgent === null) selectRef.current?.focus();
    else inputRef.current?.focus();
  }, [selectedAgent]);

  const submit = () => { if (canSubmit) onSubmit(pin); };
  return <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm" role="dialog" aria-modal="true" aria-labelledby="computer-use-enable-title"
    onKeyDown={(event) => {
      if (event.key === "Escape") { event.preventDefault(); onCancel(); }
      if (event.key === "Enter") { event.preventDefault(); submit(); }
    }}>
    <div className="w-full max-w-sm rounded-lg border border-border-strong bg-background-panel p-6 shadow-xl">
      <div className="flex items-center justify-between"><h2 id="computer-use-enable-title" className="text-lg font-semibold text-primary">Turn on Computer use</h2><button type="button" onClick={onCancel} className="rounded p-1 text-foreground-muted hover:text-foreground" aria-label="Cancel">✕</button></div>
      <p className="mt-3 text-sm text-foreground-muted">Desktop automation lets {selectedAgent?.displayName ?? "the Genie you choose"} see and operate anything your signed-in Mac account can access through supported Computer use tools, including actions that can send, change, or delete data. Nautilo will not ask again for each action. You can turn it off at any time. Enter your own PIN to continue.</p>
      <label className="mt-4 block text-xs text-foreground-muted">Genie allowed to operate this Mac
        <select ref={selectRef} aria-label="Genie allowed to operate this Mac" value={selectedAgentId ?? ""} disabled={busy || agents.length === 1}
          onChange={(event) => onSelect(event.target.value || null)} className="mt-1 block w-full rounded border border-border bg-background px-2 py-1 text-sm text-foreground">
          <option value="" disabled>Select one of your Genies</option>
          {agents.map((agent) => <option key={agent.agentId} value={agent.agentId}>{agent.displayName}{agent.handle ? ` (@${agent.handle})` : ""}</option>)}
        </select>
      </label>
      <input ref={inputRef} type="password" inputMode="numeric" maxLength={8} value={pin} onChange={(event) => setPin(event.target.value.replace(/\D/g, "").slice(0, 8))} placeholder="••••••"
        className="mt-4 w-full rounded-md border border-border bg-background-element px-3 py-2 text-center text-lg tracking-[0.3em] text-foreground placeholder:text-foreground-disabled focus:border-border-interactive focus:outline-none" autoComplete="off" />
      {error ? <p className="mt-2 text-sm text-error">{error}</p> : null}
      <p className="mt-2 text-xs text-foreground-dim">{pin.length < 6 ? "Type 6–8 digits" : "Press Enter to verify"}</p>
      <div className="mt-5 flex gap-3"><button type="button" onClick={onCancel} disabled={busy} className="flex-1 rounded-md border border-border px-3 py-2 text-sm text-foreground-muted hover:bg-background-element disabled:opacity-50">Cancel</button><button type="button" onClick={submit} disabled={!canSubmit} className="flex-1 rounded-md bg-primary px-3 py-2 text-sm text-[var(--on-primary)] hover:bg-primary-hover disabled:cursor-not-allowed disabled:opacity-40">Verify</button></div>
    </div>
  </div>;
}

export function ComputerUseConnectionSection({
  connection = isDesktop ? desktopAPI?.computerUse : undefined,
  permissions = isDesktop ? desktopAPI?.systemPermissions : undefined,
  isDesktopShell = isDesktop,
  routeHash,
  routeKey,
}: {
  connection?: ComputerUseConnection;
  permissions?: DesktopSystemPermissionsAPI;
  isDesktopShell?: boolean;
  routeHash?: string;
  routeKey?: string;
}) {
  const auth = useAuth();
  const [status, setStatus] = useState<ComputerUseStatus | null>(null);
  const [ownedAgents, setOwnedAgents] = useState<readonly ComputerUseOwnedAgent[] | null>(null);
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [checking, setChecking] = useState(false);
  const [pinOpen, setPinOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [missingPermissions, setMissingPermissions] = useState<readonly string[] | null>(null);
  const stateRevisionRef = useRef(0);
  const checkRevisionRef = useRef(0);
  const mutationRef = useRef(false);
  const switchRef = useRef<HTMLButtonElement>(null);

  const invalidatePendingCheck = () => {
    // A Human mutation wins over an observation already in flight. Advance the
    // shared state revision immediately, before the IPC mutation has a chance
    // to settle, so an old explicit check cannot restore stale authority.
    stateRevisionRef.current += 1;
    checkRevisionRef.current += 1;
    setChecking(false);
  };

  const refresh = useCallback(async () => {
    const revision = ++stateRevisionRef.current;
    if (!connection) {
      if (stateRevisionRef.current === revision) { setStatus(normalizeStatus(null, isDesktopShell)); setOwnedAgents(null); setPinOpen(false); }
      return;
    }
    try {
      const next = normalizeStatus(await connection.status(), isDesktopShell);
      if (stateRevisionRef.current !== revision) return;
      setStatus(next);
      setError(null);
      if (next.state === "unavailable") {
        setOwnedAgents(null);
        setPinOpen(false);
      } else if (next.state === "enabled") {
        // Another surface has already completed the transition. A stale PIN
        // ceremony must not reappear after a later observation.
        setPinOpen(false);
      } else {
        try {
          const agents = normalizeOwnedAgents(await connection.ownedAgents());
          if (agents === null) throw new Error("Nautilo could not verify the Genies you currently own on this Desktop.");
          if (stateRevisionRef.current !== revision) return;
          setOwnedAgents(agents);
          setSelectedAgentId((selected) => {
            const candidate = next.agentId ?? selected;
            return candidate !== null && agents.some((agent) => agent.agentId === candidate)
              ? candidate
              : null;
          });
        } catch (cause) {
          if (stateRevisionRef.current !== revision) return;
          // Selection is required only for a new On transition. A temporary
          // profile read failure must never hide an already PIN-free Off path.
          setOwnedAgents(null);
          setPinOpen(false);
          setError(failureMessage(cause));
        }
      }
    } catch (cause) {
      if (stateRevisionRef.current !== revision) return;
      setStatus(normalizeStatus(null, isDesktopShell));
      setPinOpen(false);
      setError(failureMessage(cause));
    }
  }, [connection, isDesktopShell]);

  useEffect(() => {
    void refresh();
  }, [connection, isDesktopShell, refresh]);
  useEffect(() => connection?.onStatusChanged?.(() => { void refresh(); }), [connection, refresh]);
  useEffect(() => {
    let cancelled = false;
    if (!permissions || !isDesktopShell) {
      setMissingPermissions(null);
      return;
    }
    const apply = (value: unknown) => {
      if (!cancelled) setMissingPermissions(missingComputerUsePermissions(value));
    };
    const unsubscribe = permissions.onStatusChanged(apply);
    void permissions.status().then(apply).catch(() => {
      if (!cancelled) setMissingPermissions(null);
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [isDesktopShell, permissions]);
  const enable = async (pin: string) => {
    if (!connection || mutationRef.current || selectedAgentId === null
      || ownedAgents === null || !ownedAgents.some((agent) => agent.agentId === selectedAgentId)) {
      if (selectedAgentId !== null && ownedAgents !== null) {
        setError("Choose a Genie you currently own before turning on Computer use.");
        setPinOpen(false);
      }
      return;
    }
    invalidatePendingCheck();
    mutationRef.current = true;
    setBusy(true); setError(null);
    try { await connection.enable(pin, selectedAgentId); await refresh(); setPinOpen(false); }
    catch (cause) { setError(failureMessage(cause)); }
    finally { mutationRef.current = false; setBusy(false); }
  };
  const disable = async () => {
    if (!connection || mutationRef.current) return;
    invalidatePendingCheck();
    mutationRef.current = true;
    setBusy(true); setError(null);
    try { await connection.disable(); await refresh(); }
    catch (cause) { setError(failureMessage(cause)); }
    finally { mutationRef.current = false; setBusy(false); }
  };
  const checkReadiness = async () => {
    if (!connection?.check) return;
    const revision = ++stateRevisionRef.current;
    const checkRevision = ++checkRevisionRef.current;
    setChecking(true); setError(null);
    try {
      const next = await connection.check();
      if (stateRevisionRef.current === revision) setStatus(normalizeStatus(next, isDesktopShell));
    }
    catch (cause) { if (stateRevisionRef.current === revision) setError(failureMessage(cause)); }
    finally { if (checkRevisionRef.current === checkRevision) setChecking(false); }
  };
  const current = status ?? normalizeStatus(null, isDesktopShell);
  // A disconnected relay is unavailable for new work, but an extant local
  // receipt must still render as revocable.  Off is intentionally never
  // trapped behind transport availability.
  const enabled = current.state === "enabled" || current.canDisable;
  const unavailable = current.state === "unavailable";
  const selectedAgent = ownedAgents?.find((agent) => agent.agentId === (current.agentId ?? selectedAgentId)) ?? null;

  const compactSummary = current.state === "enabled"
    ? `On${selectedAgent ? ` for ${selectedAgent.displayName}` : ""}${current.effectiveProvider ? " · Cua" : ""}`
    : current.canDisable
      ? "Needs Off"
      : unavailable
        ? "Unavailable"
        : `Off${current.effectiveProvider ? " · Cua" : ""}`;
  const disclosure = useConnectionDisclosure({
    cardId: "computer-use",
    viewerKey: stableViewerKeyForStorage(auth.viewer),
    forceOpen: busy || checking || pinOpen || error !== null || (missingPermissions?.length ?? 0) > 0,
    routeHash,
    routeKey,
  });

  const beginEnable = () => {
    if (unavailable || busy || checking) return;
    setError(null);
    if (ownedAgents === null) {
      setError("Nautilo could not verify the Genies you currently own on this Desktop. Try again after your signed-in profile is available.");
      return;
    }
    if (ownedAgents.length === 0) {
      setError("You do not own a Genie that can be allowed to use this Mac yet. Create or claim a Genie, then try again.");
      return;
    }
    if (ownedAgents.length === 1) {
      setSelectedAgentId(ownedAgents[0].agentId);
      setPinOpen(true);
      return;
    }
    if (selectedAgentId !== null && ownedAgents.some((agent) => agent.agentId === selectedAgentId)) {
      setPinOpen(true);
      return;
    }
    setPinOpen(true);
  };

  return <div id="computer-use" tabIndex={-1}
    className="scroll-mt-6 rounded-lg border border-border bg-background-panel outline-none" data-testid="computer-use-connection" aria-labelledby="computer-use-connection-title">
    <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-4 py-3">
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <h3 id="computer-use-connection-title" className="text-sm font-medium text-foreground">Computer use for Genie</h3>
          <StatusPill tone={current.state === "enabled" ? "ok" : "muted"}>{current.state === "enabled" ? "On" : current.canDisable ? "Needs Off" : unavailable ? "Unavailable" : "Off"}</StatusPill>
        </div>
        <p className="mt-1 text-xs text-foreground-muted">
          {disclosure.expanded
            ? "Lets the selected Genie use anything the signed-in Mac account can access through supported Computer use tools. Its actions can send, change, or delete data; there are no per-action asks. Turn Computer use Off anytime."
            : compactSummary}
        </p>
      </div>
      <div className="flex items-center gap-2">
        <ConnectionDisclosureControl expanded={disclosure.expanded} detailsId={disclosure.detailsId} onToggle={disclosure.toggle} />
        <ComputerUseSwitch buttonRef={switchRef} enabled={enabled} disabled={busy || (!enabled && unavailable)} onChange={(next) => {
          if (next) beginEnable(); else void disable();
        }} />
      </div>
    </div>
    <div id={disclosure.detailsId} hidden={!disclosure.expanded} className="space-y-3 px-4 py-3">
    <div className="rounded-md border border-border/60 bg-background-element/40 p-3 text-xs" aria-label="Computer use driver readiness">
      <div className="flex flex-wrap items-center justify-between gap-2"><span className="text-foreground-muted">Cua driver</span><StatusPill tone={current.providers?.cua.ready ? "ok" : "muted"}>{current.providers?.cua.ready ? "Ready (computer use)" : current.providers?.cua.lifecycle === "starting" ? "Checking" : current.providers?.cua.lifecycle === "installed" ? "Installed" : current.providers?.cua.lifecycle === "unhealthy" ? "Needs attention" : "Not installed"}</StatusPill></div>
      <p className="mt-1 text-foreground-dim">{cuaReadinessCopy(current.providers)}</p>
      {missingPermissions && missingPermissions.length > 0 ? <div className="mt-2 rounded border border-[var(--warning)]/50 px-2.5 py-2 text-foreground-muted">
        <p>{missingPermissions.join(" and ")} {missingPermissions.length === 1 ? "is" : "are"} required before Computer Use can run.</p>
        <a href="/settings#desktop-permissions" className="mt-1 inline-block font-medium text-primary hover:underline">Fix in Settings</a>
      </div> : null}
      {connection?.check ? <button type="button" className="mt-2 text-xs font-medium text-primary hover:underline disabled:opacity-50" disabled={checking} onClick={() => void checkReadiness()}>{checking ? "Checking…" : "Check"}</button> : null}
      <p className="mt-3 text-foreground-dim">{current.effectiveProvider === null
        ? "Cua is not executable for Genie tasks yet."
        : "Cua is ready for new Computer use work."}</p>
    </div>
    {unavailable && current.reason ? <p className="text-xs text-foreground-muted">{current.reason}</p> : null}
    {error ? <p className="text-xs text-[var(--error)]" role="alert">{error}</p> : null}
    </div>
    {pinOpen && ownedAgents !== null ? <ComputerUseEnableDialog agents={ownedAgents} selectedAgentId={selectedAgentId} onSelect={setSelectedAgentId} error={error ?? undefined} busy={busy}
      onSubmit={(pin) => void enable(pin)} onCancel={() => { if (!busy) { setPinOpen(false); setError(null); switchRef.current?.focus(); } }} /> : null}
  </div>;
}
