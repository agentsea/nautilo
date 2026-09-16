import { useCallback, useEffect, useRef, useState } from "react";
import { Accessibility, Mic, Monitor, type LucideIcon } from "lucide-react";
import {
  desktopAPI,
  isDesktop,
  type DesktopSystemPermission,
  type DesktopSystemPermissionId,
  type DesktopSystemPermissionsAPI,
  type DesktopSystemPermissionsSnapshot,
} from "../lib/desktop";
import type { ComputerUseConnection } from "../pages/connections/computer-use-connection-section";

const REQUIRED_IDS = ["accessibility", "screen-recording"] as const;
const EXPECTED_IDS = ["accessibility", "screen-recording", "microphone"] as const;
const REQUIRED_FOR_BY_ID: Readonly<Record<DesktopSystemPermissionId, readonly ("computer-use" | "voice")[]>> = {
  accessibility: ["computer-use"],
  "screen-recording": ["computer-use"],
  microphone: ["voice"],
};

export type PermissionCardConnection = Pick<ComputerUseConnection, "status" | "onStatusChanged" | "check">;

export type LoadedSystemPermissionsSnapshot = DesktopSystemPermissionsSnapshot & {
  permissions: readonly DesktopSystemPermission[];
};

function isPermissionId(value: unknown): value is DesktopSystemPermissionId {
  return value === "accessibility" || value === "screen-recording" || value === "microphone";
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === expected.length && expected.every((key) => actual.includes(key));
}

function isExpectedAction(
  id: DesktopSystemPermissionId,
  state: DesktopSystemPermission["state"],
  action: DesktopSystemPermission["action"],
): boolean {
  if (state === "granted" || state === "restricted" || state === "unsupported") return action === null;
  if (id === "accessibility") return action === "request";
  // Screen Recording begins with Electron's native request. If macOS declines
  // or the native call fails, main latches the same state to its fixed Settings
  // fallback; both are exact states in that two-step main-owned state machine.
  if (id === "screen-recording") return action === "request" || action === "open-settings";
  return action === (state === "not-determined" ? "request" : "open-settings");
}

export function normalizeSystemPermissionsSnapshot(value: unknown): LoadedSystemPermissionsSnapshot | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const rawSnapshot = value as Record<string, unknown>;
  if (!hasExactKeys(rawSnapshot, ["version", "platform", "permissions"])) return null;
  const snapshot = rawSnapshot as Partial<DesktopSystemPermissionsSnapshot>;
  if (snapshot.version !== 1 || (snapshot.platform !== "macos" && snapshot.platform !== "other") || !Array.isArray(snapshot.permissions)) return null;
  const byId = new Map<DesktopSystemPermissionId, DesktopSystemPermission>();
  for (const rawCandidate of snapshot.permissions as unknown[]) {
    if (typeof rawCandidate !== "object" || rawCandidate === null || Array.isArray(rawCandidate)) return null;
    const candidate = rawCandidate as Record<string, unknown>;
    if (!hasExactKeys(candidate, ["id", "label", "reason", "requiredFor", "state", "action", "restart"])) return null;
    const id = candidate.id;
    const requiredFor = candidate.requiredFor;
    const state = candidate.state;
    const action = candidate.action;
    const restart = candidate.restart;
    if (!isPermissionId(id) || typeof candidate.label !== "string" || typeof candidate.reason !== "string"
      || !Array.isArray(requiredFor)
      || !requiredFor.every((feature: unknown) => feature === "computer-use" || feature === "voice")
      || !["not-determined", "granted", "denied", "restricted", "unknown", "unsupported"].includes(state as string)
      || !(action === "request" || action === "open-settings" || action === null)
      || !(restart === "not-required" || restart === "required")
      || byId.has(id)) return null;
    const expectedFeatures = REQUIRED_FOR_BY_ID[id];
    if (requiredFor.length !== expectedFeatures.length
      || new Set(requiredFor).size !== requiredFor.length
      || requiredFor.some((feature: unknown, index: number) => feature !== expectedFeatures[index])
      || !isExpectedAction(id, state as DesktopSystemPermission["state"], action as DesktopSystemPermission["action"])
      || (restart === "required" && !(id === "microphone" && (state === "denied" || state === "granted")))) return null;
    // Project only the documented renderer contract. Unknown data (including a
    // future provider URL) does not become an executable renderer instruction.
    byId.set(id, {
      id,
      label: candidate.label,
      reason: candidate.reason,
      requiredFor: requiredFor as DesktopSystemPermission["requiredFor"],
      state: state as DesktopSystemPermission["state"],
      action: action as DesktopSystemPermission["action"],
      restart: restart as DesktopSystemPermission["restart"],
    });
  }
  if (byId.size !== EXPECTED_IDS.length || EXPECTED_IDS.some((id) => !byId.has(id))) return null;
  return { version: 1, platform: snapshot.platform, permissions: EXPECTED_IDS.map((id) => byId.get(id)!) };
}

export function missingComputerUsePermissions(value: unknown): readonly string[] | null {
  const snapshot = normalizeSystemPermissionsSnapshot(value);
  if (snapshot === null) return null;
  return snapshot.permissions
    .filter((permission) => permission.requiredFor.includes("computer-use") && permission.state !== "granted")
    .map((permission) => permission.label);
}

function permissionStateCopy(permission: DesktopSystemPermission): string {
  switch (permission.state) {
    case "granted": return "Ready";
    case "not-determined": return "Not enabled";
    case "denied": return "Access denied";
    case "restricted": return "Restricted by macOS";
    case "unsupported": return "Not available on this Mac";
    default: return "Nautilo cannot verify";
  }
}

function permissionTone(permission: DesktopSystemPermission): "ready" | "missing" | "neutral" {
  if (permission.state === "granted") return "ready";
  if (permission.state === "unsupported") return "neutral";
  return "missing";
}

function cuaIsReady(value: unknown): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const providers = (value as Record<string, unknown>).providers;
  if (typeof providers !== "object" || providers === null || Array.isArray(providers)) return false;
  const cua = (providers as Record<string, unknown>).cua;
  return typeof cua === "object" && cua !== null && !Array.isArray(cua)
    && (cua as Record<string, unknown>).ready === true && (cua as Record<string, unknown>).lifecycle === "healthy";
}

function permissionIcon(id: DesktopSystemPermissionId): LucideIcon {
  switch (id) {
    case "accessibility": return Accessibility;
    case "screen-recording": return Monitor;
    case "microphone": return Mic;
  }
}

/**
 * Desktop-wide permission checklist. macOS, rather than this page, owns the
 * authorization toggle and any password/Touch ID ceremony.
 */
export function SystemPermissionsSection({
  permissions = isDesktop ? desktopAPI?.systemPermissions : undefined,
  computerUse = isDesktop ? desktopAPI?.computerUse : undefined,
  isDesktopShell = isDesktop,
  onContinue,
  continueLabel = "Continue to Computer Use",
  collapseWhenReady = false,
  sectionId = "system-permissions",
  eyebrow = "System permissions",
  title = "Finish setting up this Mac",
  description = "Use each row to request access. Nautilo updates this list when macOS reports the change.",
  visiblePermissionIds = EXPECTED_IDS,
  showComputerUseProgress = true,
  showOnboardingControls = false,
}: {
  permissions?: DesktopSystemPermissionsAPI;
  computerUse?: PermissionCardConnection;
  isDesktopShell?: boolean;
  onContinue?: () => void;
  continueLabel?: string;
  collapseWhenReady?: boolean;
  sectionId?: string;
  eyebrow?: string;
  title?: string;
  description?: string;
  visiblePermissionIds?: readonly DesktopSystemPermissionId[];
  showComputerUseProgress?: boolean;
  showOnboardingControls?: boolean;
}) {
  const [snapshot, setSnapshot] = useState<LoadedSystemPermissionsSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<DesktopSystemPermissionId | null>(null);
  const [restarting, setRestarting] = useState(false);
  const [cuaReady, setCuaReady] = useState(false);
  const [cuaLoaded, setCuaLoaded] = useState(false);
  const [readyDetailsOpen, setReadyDetailsOpen] = useState(false);
  const [onboardingPreference, setOnboardingPreference] = useState<boolean | null>(null);
  const [onboardingPreferenceBusy, setOnboardingPreferenceBusy] = useState(false);
  const [onboardingPreferenceError, setOnboardingPreferenceError] = useState<string | null>(null);
  const versionRef = useRef(0);
  const wasPermissionsReadyRef = useRef(false);
  const automaticCheckPendingRef = useRef(false);

  const refreshPermissions = useCallback(async () => {
    const version = ++versionRef.current;
    if (!permissions || !isDesktopShell) {
      if (versionRef.current === version) {
        setSnapshot(null);
        setError("Update Nautilo Desktop to check and guide this Mac’s system permissions.");
      }
      return;
    }
    try {
      const next = normalizeSystemPermissionsSnapshot(await permissions.status());
      if (versionRef.current !== version) return;
      if (next === null) {
        setSnapshot(null);
        setError("Update Nautilo Desktop to check and guide this Mac’s system permissions.");
        return;
      }
      setSnapshot(next);
      setError(null);
    } catch {
      if (versionRef.current !== version) return;
      setSnapshot(null);
      setError("Nautilo could not check this Mac’s system permissions. Try reopening Nautilo Desktop.");
    }
  }, [isDesktopShell, permissions]);

  const refreshCua = useCallback(async () => {
    if (!computerUse || !isDesktopShell) { setCuaReady(false); setCuaLoaded(true); return; }
    try { setCuaReady(cuaIsReady(await computerUse.status())); }
    catch { setCuaReady(false); }
    finally { setCuaLoaded(true); }
  }, [computerUse, isDesktopShell]);

  useEffect(() => { void refreshPermissions(); }, [refreshPermissions]);
  useEffect(() => { void refreshCua(); }, [refreshCua]);
  useEffect(() => permissions?.onStatusChanged((next) => {
    const normalized = normalizeSystemPermissionsSnapshot(next);
    if (normalized === null) {
      setSnapshot(null);
      setError("Update Nautilo Desktop to check and guide this Mac’s system permissions.");
      return;
    }
    versionRef.current += 1;
    setSnapshot(normalized);
    setError(null);
  }), [permissions]);
  useEffect(() => computerUse?.onStatusChanged?.(() => { void refreshCua(); }), [computerUse, refreshCua]);
  useEffect(() => {
    if (!showOnboardingControls || !permissions?.onboardingPreference) return;
    let cancelled = false;
    void permissions.onboardingPreference().then((preference) => {
      if (!cancelled) setOnboardingPreference(preference.showAutomatically);
    }).catch(() => {
      if (!cancelled) setOnboardingPreferenceError("Nautilo could not load the setup reminder preference.");
    });
    const unsubscribe = permissions.onOnboardingPreferenceChanged?.((preference) => {
      setOnboardingPreference(preference.showAutomatically);
      setOnboardingPreferenceError(null);
    });
    return () => { cancelled = true; unsubscribe?.(); };
  }, [permissions, showOnboardingControls]);

  const updateOnboardingPreference = async (showAutomatically: boolean) => {
    if (!permissions?.setOnboardingPreference || onboardingPreferenceBusy) return;
    setOnboardingPreferenceBusy(true);
    setOnboardingPreferenceError(null);
    try {
      const preference = await permissions.setOnboardingPreference(showAutomatically);
      setOnboardingPreference(preference.showAutomatically);
    } catch {
      setOnboardingPreferenceError("Nautilo could not save the setup reminder preference.");
    } finally {
      setOnboardingPreferenceBusy(false);
    }
  };

  const runGuidedSetup = async () => {
    if (!permissions?.requestGuidedSetup) return;
    setOnboardingPreferenceError(null);
    try { await permissions.requestGuidedSetup(); }
    catch { setOnboardingPreferenceError("Nautilo could not open guided setup."); }
  };

  const resolve = async (id: DesktopSystemPermissionId) => {
    if (!permissions || busyId !== null) return;
    setBusyId(id);
    setError(null);
    const version = ++versionRef.current;
    try {
      const next = normalizeSystemPermissionsSnapshot(await permissions.resolve(id));
      if (versionRef.current !== version) return;
      if (next === null) throw new Error("invalid permission snapshot");
      setSnapshot(next);
    } catch {
      if (versionRef.current === version) setError("Nautilo could not open that macOS permission. Try again from this list.");
    } finally {
      setBusyId((current) => current === id ? null : current);
    }
  };

  const restart = async () => {
    if (!permissions || restarting) return;
    setRestarting(true);
    setError(null);
    try { await permissions.restart(); }
    catch { setError("Nautilo could not restart. Quit and reopen Nautilo to finish this permission change."); setRestarting(false); }
  };

  const readyCount = snapshot?.permissions.filter((permission) => REQUIRED_IDS.includes(permission.id as typeof REQUIRED_IDS[number]) && permission.state === "granted").length ?? 0;
  const permissionsReady = readyCount === REQUIRED_IDS.length;
  const visiblePermissions = snapshot?.permissions.filter((permission) =>
    visiblePermissionIds.includes(permission.id)) ?? [];
  const allPermissionsReady = snapshot !== null
    && visiblePermissions.length === visiblePermissionIds.length
    && visiblePermissions.every((permission) => permission.state === "granted");

  useEffect(() => {
    if (!permissionsReady) {
      wasPermissionsReadyRef.current = false;
      automaticCheckPendingRef.current = false;
      return;
    }
    if (!wasPermissionsReadyRef.current) {
      wasPermissionsReadyRef.current = true;
      automaticCheckPendingRef.current = true;
    }
    if (!automaticCheckPendingRef.current || !cuaLoaded || cuaReady || !computerUse?.check) return;
    // The just-granted TCC row can make an already-installed Cua healthy. This
    // is an automatic local readiness refresh, never a Human "Check" chore;
    // consume this transition before awaiting so a persistent failure cannot
    // loop or spam the driver.
    automaticCheckPendingRef.current = false;
    void (async () => {
      try { await computerUse.check!(); }
      catch { setCuaReady(false); }
      finally { await refreshCua(); }
    })();
  }, [computerUse, cuaLoaded, cuaReady, permissionsReady, refreshCua]);

  // Guided setup dismisses into Nautilo once the required macOS permissions
  // are ready. Cua health is separate runtime state and must not trap the
  // Human inside an OS-permission guide. The Computer Use destination still
  // requires Cua before its own navigation action is enabled.
  const continueDismissesSetup = onContinue !== undefined;
  const canContinue = permissionsReady && (continueDismissesSetup || cuaReady);
  const driverCopy = !permissionsReady
    ? "Computer Use is waiting for permissions"
    : cuaReady
      ? "Cua driver healthy · Computer Use is ready"
      : continueDismissesSetup
        ? "Required permissions are ready. Computer Use will finish starting separately."
        : "Computer Use is waiting for Cua";

  const continueToComputerUse = () => {
    if (!canContinue) return;
    if (onContinue) {
      onContinue();
      return;
    }
    const target = document.getElementById("computer-use");
    target?.scrollIntoView?.({ behavior: "smooth", block: "start" });
    target?.focus({ preventScroll: true });
  };

  const onboardingControls = showOnboardingControls && permissions?.onboardingPreference
    && permissions.setOnboardingPreference && permissions.requestGuidedSetup ? <div className="border-t border-border px-4 py-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <label className="flex items-start gap-2 text-xs text-foreground-muted">
          <input type="checkbox" className="mt-0.5" checked={onboardingPreference ?? true}
            disabled={onboardingPreference === null || onboardingPreferenceBusy}
            onChange={(event) => void updateOnboardingPreference(event.currentTarget.checked)} />
          <span><span className="font-medium text-foreground">Show setup automatically</span><br />Remind me when Computer Use permissions are missing.</span>
        </label>
        <button type="button" onClick={() => void runGuidedSetup()}
          className="rounded-md border border-border px-3 py-2 text-xs font-medium text-primary hover:bg-background-element">Run guided setup</button>
      </div>
      <p className="mt-2 text-xs text-foreground-dim">This preference applies to this Nautilo Desktop identity on this Mac. Development builds keep a separate preference.</p>
      {onboardingPreferenceError ? <p className="mt-2 text-xs text-[var(--error)]" role="alert">{onboardingPreferenceError}</p> : null}
    </div> : null;

  if (collapseWhenReady && allPermissionsReady && !readyDetailsOpen) {
    return <section id={sectionId} tabIndex={-1} data-testid="system-permissions-section"
      className="scroll-mt-6 rounded-lg border border-border bg-background-panel px-4 py-4 outline-none" aria-labelledby={`${sectionId}-title`}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          {eyebrow ? <p className="text-xs font-medium uppercase tracking-wide text-primary">{eyebrow}</p> : null}
          <h3 id={`${sectionId}-title`} className={`${eyebrow ? "mt-1 " : ""}text-sm font-medium text-foreground`}>This Mac is ready</h3>
          <p className="mt-1 text-xs text-foreground-muted">{visiblePermissions.map((permission) => permission.label).join(", ")} are ready.</p>
        </div>
        <div className="flex items-center gap-3">
          <span className="text-xs font-medium text-[var(--success)]">✓ {visiblePermissions.length} permissions ready</span>
          <button type="button" onClick={() => setReadyDetailsOpen(true)}
            className="rounded-md border border-border px-3 py-2 text-xs font-medium text-foreground-muted hover:bg-background-element hover:text-foreground">Show details</button>
        </div>
      </div>
      {onboardingControls}
    </section>;
  }

  return <section id={sectionId} tabIndex={-1} data-testid="system-permissions-section"
    className="scroll-mt-6 rounded-lg border border-border bg-background-panel outline-none" aria-labelledby={`${sectionId}-title`}>
    <div className="border-b border-border px-4 py-4">
      {eyebrow ? <p className="text-xs font-medium uppercase tracking-wide text-primary">{eyebrow}</p> : null}
      <h3 id={`${sectionId}-title`} className={`${eyebrow ? "mt-1 " : ""}text-base font-medium text-foreground`}>{title}</h3>
      <p className="mt-1 text-sm text-foreground-muted">{description}</p>
    </div>
    {snapshot === null ? <div className="px-4 py-4">
      <p className="text-sm text-foreground-muted">{error ?? "Checking this Mac’s system permissions…"}</p>
    </div> : <>
      <ul className="divide-y divide-border" aria-label="System permissions">
        {visiblePermissions.map((permission) => {
          const ready = permission.state === "granted";
          const tone = permissionTone(permission);
          const optional = !permission.requiredFor.includes("computer-use");
          const Icon = permissionIcon(permission.id);
          return <li key={permission.id} className="flex flex-wrap items-center gap-3 px-4 py-4 sm:flex-nowrap">
            <span aria-hidden="true" className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md bg-background-element text-primary"><Icon className="h-4 w-4" /></span>
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium text-foreground">{permission.label}{optional ? <span className="text-foreground-muted"> · Optional</span> : null}</p>
              <p className="mt-0.5 text-xs text-foreground-muted">{permission.reason}</p>
              {permission.restart === "required" ? <p className="mt-1 text-xs text-foreground-muted">Restart Nautilo after changing this permission.</p> : null}
            </div>
            <div className="ml-13 flex shrink-0 flex-wrap items-center gap-2 sm:ml-0 sm:flex-col sm:items-end">
              <span className={tone === "ready" ? "text-xs font-medium text-[var(--success)]" : tone === "missing" ? "text-xs font-medium text-[var(--error)]" : "text-xs font-medium text-foreground-muted"}>
                {ready ? "✓ Ready" : permissionStateCopy(permission)}
              </span>
              {!ready && permission.action !== null ? <button type="button" disabled={busyId !== null}
                onClick={() => void resolve(permission.id)} className="rounded-md border border-border px-2.5 py-1.5 text-xs font-medium text-primary hover:bg-background-element disabled:cursor-not-allowed disabled:opacity-50">
                {busyId === permission.id ? "Opening…" : permission.action === "request" ? "Request access" : "Open System Settings"}
              </button> : null}
              {permission.restart === "required" ? <button type="button" disabled={restarting} onClick={() => void restart()}
                className="rounded-md border border-border px-2.5 py-1.5 text-xs font-medium text-foreground-muted hover:bg-background-element disabled:cursor-not-allowed disabled:opacity-50">{restarting ? "Restarting…" : "Restart Nautilo"}</button> : null}
            </div>
          </li>;
        })}
      </ul>
      {showComputerUseProgress ? <div className="border-t border-border px-4 py-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="min-w-48 flex-1">
            <div className="flex justify-between gap-4 text-xs font-medium text-foreground-muted"><span>Computer Use permissions</span><span>{readyCount} of 2 required ready</span></div>
            <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-background-element" role="progressbar" aria-label="Required permissions ready" aria-valuemin={0} aria-valuemax={2} aria-valuenow={readyCount}>
              <div className="h-full bg-[var(--success)] transition-all" style={{ width: `${readyCount * 50}%` }} />
            </div>
            <p className={canContinue ? "mt-2 text-xs text-[var(--success)]" : "mt-2 text-xs text-foreground-muted"}>{canContinue ? "✓ " : ""}{driverCopy}</p>
          </div>
          <div className="flex items-center gap-2">
            {collapseWhenReady && allPermissionsReady ? <button type="button" onClick={() => setReadyDetailsOpen(false)}
              className="rounded-md border border-border px-3 py-2 text-sm font-medium text-foreground-muted hover:bg-background-element">Hide details</button> : null}
            <button type="button" disabled={!canContinue} onClick={continueToComputerUse}
              className="rounded-md bg-primary px-3 py-2 text-sm font-medium text-[var(--on-primary)] hover:bg-primary-hover disabled:cursor-not-allowed disabled:opacity-40">{continueLabel}</button>
          </div>
        </div>
        {error ? <p className="mt-3 text-xs text-[var(--error)]" role="alert">{error}</p> : null}
        <p className="mt-3 text-xs text-foreground-dim">Microphone is optional and is not included in the Computer Use count. Future features add permissions here only when they need them.</p>
      </div> : error ? <p className="border-t border-border px-4 py-3 text-xs text-[var(--error)]" role="alert">{error}</p> : null}
    </>}
    {onboardingControls}
  </section>;
}
