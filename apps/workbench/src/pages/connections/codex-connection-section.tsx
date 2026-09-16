import { useCallback, useEffect, useRef, useState } from "react";
import type {
  CodexConnectionProfile,
  CodexConnectionSummary,
  CodexPosture,
  CodexUserPreference,
} from "@nautilo/types";
import {
  desktopAPI,
  getDesktopRelayId,
  isDesktop,
  type DesktopCodexConnectionStatus,
} from "../../lib/desktop";
import { apiClient } from "../../lib/api";
import { useWorkbenchUiTargetReveal } from "../../lib/genie-application-targets";
import { Button, StatusPill } from "../settings/ui";

type LocalState =
  | { kind: "unavailable" }
  | { kind: "loading" }
  | { kind: "ready"; status: DesktopCodexConnectionStatus }
  | { kind: "error" };

type ProfileSnapshot = {
  rateLimits: CodexConnectionProfile["rateLimits"];
  usage: CodexConnectionProfile["usage"];
  usageUnavailable?: boolean;
  rateLimitsUnavailable?: boolean;
};

function localPill(status: DesktopCodexConnectionStatus): { tone: "ok" | "warn" | "error" | "info" | "muted"; label: string } {
  switch (status.state) {
    case "disabled": return { tone: "muted", label: "Disabled" };
    case "enabling": return { tone: "info", label: "Starting" };
    case "enabled": return status.ready
      ? { tone: "ok", label: "Runtime ready" }
      : { tone: "info", label: "Starting" };
    case "disabling": return { tone: "info", label: "Stopping" };
    case "faulted": return { tone: "error", label: "Needs attention" };
  }
}

function runtimeLabel(summary: CodexConnectionSummary): string {
  switch (summary.runtime.state) {
    case "absent": return "Not installed";
    // The current Connections DTO deliberately exposes only the install
    // lifecycle, not the runtime manager's byte/phase callback. Do not turn
    // this into a download claim: the native manager may be resolving,
    // verifying, staging, or atomically activating instead.
    case "installing": return "Installing";
    case "ready": return summary.runtime.available ? "Active" : "Detected";
    case "limited": return summary.runtime.available ? "Active (limited)" : "Detected (limited)";
    case "incompatible": return summary.runtime.source === "external"
      ? "External runtime incompatible"
      : "Runtime incompatible";
    case "draining": return "Stopping";
    case "failed": return "Needs attention";
    case "unavailable": return "Unavailable";
  }
}

function runtimeReceipt(runtime: CodexConnectionSummary["runtime"]): string | null {
  const installation = runtime.installation;
  if (!installation) return null;
  const bytes = installation.totalBytes > 0 ? `${Math.round(installation.receivedBytes / 1024)} KiB of ${Math.round(installation.totalBytes / 1024)} KiB` : null;
  return [installation.phase[0].toUpperCase() + installation.phase.slice(1), bytes].filter((value): value is string => value !== null).join(" · ");
}

function runtimeFailureMessage(runtime: CodexConnectionSummary["runtime"], receipt: string | null): string {
  switch (runtime.installation?.code) {
    case "CODEX_RUNTIME_UNHEALTHY":
      return `${receipt ? `Managed install: ${receipt}. ` : ""}The reviewed runtime downloaded and passed artifact verification, but its app server did not pass Nautilo's startup check. Check again or retry the managed installation.`;
    case "CODEX_RUNTIME_SIGNATURE_INVALID":
      return `${receipt ? `Managed install: ${receipt}. ` : ""}The downloaded runtime did not have the reviewed publisher signature and was rejected. Check again before retrying.`;
    case "CODEX_RUNTIME_ARTIFACT_INVALID":
      return `${receipt ? `Managed install: ${receipt}. ` : ""}The download did not match the reviewed runtime artifact and was rejected. Check again before retrying.`;
    default:
      return receipt
        ? `Managed install: ${receipt}. Check again or retry the managed installation.`
        : "Nautilo could not install or verify Codex. Check again or retry the managed installation.";
  }
}

function compatibilityDiagnosticMessage(
  runtime: CodexConnectionSummary["runtime"],
): string | null {
  const diagnostic = runtime.compatibilityDiagnostics?.[0];
  if (!diagnostic) return null;
  const feature = {
    core: "Core conversations",
    steer: "Steering",
    approvals: "Approvals",
    request_user_input: "Questions for you",
    collaboration_modes: "Collaboration modes",
  }[diagnostic.feature];
  const reason = {
    missing_member: "a required protocol operation is missing",
    missing_field: "a required protocol field is missing",
    changed_field_shape: "a protocol field has an unsafe shape",
  }[diagnostic.reason];
  const additional = runtime.compatibilityDiagnostics!.length - 1;
  return `Compatibility check — ${feature}: ${reason}${additional > 0 ? ` (${additional} more finding${additional === 1 ? "" : "s"})` : ""}.`;
}

function profileStatus(profile: CodexConnectionProfile): { tone: "ok" | "warn" | "error" | "info" | "muted"; label: string } {
  if (profile.reconciliationState === "cleanup_required") return { tone: "warn", label: "Cleanup required" };
  if (profile.reconciliationState === "reconnecting") return { tone: "info", label: "Reconnecting" };
  switch (profile.authState) {
    case "signed_in": return { tone: "ok", label: "Signed in" };
    case "login_pending": return { tone: "info", label: "Waiting for sign in" };
    case "expired": return { tone: "warn", label: "Sign in again" };
    case "error": return { tone: "error", label: "Needs attention" };
    case "signed_out": return { tone: "muted", label: "Account not connected" };
  }
}

const profileIsCurrent = (profile: CodexConnectionProfile): boolean =>
  profile.reconciliationState !== "reconnecting" && profile.reconciliationState !== "cleanup_required";
const profileIsRegistered = (profile: CodexConnectionProfile): boolean =>
  profile.registrationState !== "provisional";

function formatObservedAt(value: string | null): string | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toLocaleString();
}

function usageDetails(
  profile: CodexConnectionProfile,
  snapshot: ProfileSnapshot | undefined,
): string[] {
  const rateLimits = snapshot?.rateLimits ?? profile.rateLimits;
  const usage = snapshot?.usage ?? profile.usage;
  const details: string[] = [];
  if (usage) {
    details.push(`Usage ${usage.freshness}`);
    const observedAt = formatObservedAt(usage.observedAt);
    if (observedAt) details.push(`Updated ${observedAt}`);
  } else if (rateLimits) {
    details.push(`Usage ${rateLimits.freshness}`);
  }
  if (snapshot?.usageUnavailable) details.push("Usage unavailable");
  if (rateLimits?.primary) {
    details.push(`Primary ${rateLimits.primary.usedPercent}% used`);
    const reset = formatObservedAt(rateLimits.primary.resetsAt);
    if (reset) details.push(`Resets ${reset}`);
  }
  if (rateLimits?.secondary) {
    details.push(`Secondary ${rateLimits.secondary.usedPercent}% used`);
    const reset = formatObservedAt(rateLimits.secondary.resetsAt);
    if (reset) details.push(`Resets ${reset}`);
  }
  if (rateLimits?.reached) details.push("Limit reached");
  if (snapshot?.rateLimitsUnavailable) details.push("Rate limits unavailable");
  if (details.length === 0) {
    const observedAt = formatObservedAt(profile.usageObservedAt);
    if (observedAt) details.push(`Usage updated ${observedAt}`);
  }
  return details;
}

function CodexToggle({
  enabled,
  disabled,
  loading,
  compact = false,
  onChange,
}: {
  enabled: boolean;
  disabled: boolean;
  loading: boolean;
  compact?: boolean;
  onChange: (enabled: boolean) => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={enabled}
      aria-label={enabled ? "Disable Codex" : "Enable Codex"}
      disabled={disabled}
      onClick={() => onChange(!enabled)}
      className={[
        "relative inline-flex shrink-0 items-center rounded-full transition-colors",
        compact ? "h-4 w-7" : "h-5 w-9",
        enabled ? "bg-[var(--success)]" : "bg-foreground-muted/40",
        disabled ? "cursor-not-allowed opacity-50" : "cursor-pointer",
      ].join(" ")}
    >
      <span
        className={[
          "inline-block rounded-full bg-background shadow transition-transform",
          compact ? "h-3 w-3" : "h-4 w-4",
          enabled ? (compact ? "translate-x-3.5" : "translate-x-4") : "translate-x-0.5",
          loading ? "animate-pulse" : "",
        ].join(" ")}
      />
    </button>
  );
}

function ProfileRow({
  profile,
  displayLabel,
  busy,
  loginRef,
  runtimeAvailable,
  snapshot,
  onStartLogin,
  onCancelLogin,
  onLogout,
  onRename,
  onRemove,
  onRefreshUsage,
}: {
  profile: CodexConnectionProfile;
  displayLabel: string;
  busy: boolean;
  loginRef: string | null;
  runtimeAvailable: boolean;
  snapshot: ProfileSnapshot | undefined;
  onStartLogin: (profileId: string) => void;
  onCancelLogin: (profileId: string, loginRef: string) => void;
  onLogout: (profileId: string) => void;
  onRename: (profile: CodexConnectionProfile, label: string) => void;
  onRemove: (profile: CodexConnectionProfile) => void;
  onRefreshUsage: (profileId: string) => void;
}) {
  const status = profileStatus(profile);
  const [editing, setEditing] = useState(false);
  const [label, setLabel] = useState(profile.label);
  const labelRef = useRef<HTMLInputElement>(null);
  const [confirmingRemoval, setConfirmingRemoval] = useState(false);
  const [actionsOpen, setActionsOpen] = useState(false);
  const actionsRef = useRef<HTMLDivElement>(null);
  const details = usageDetails(profile, snapshot);
  const rateLimitPlan = (snapshot?.rateLimits ?? profile.rateLimits)?.plan;
  const plan = profile.planType ?? (
    rateLimitPlan && rateLimitPlan !== "unknown" ? rateLimitPlan : null
  );
  const accountActionsAvailable = profileIsCurrent(profile);
  useEffect(() => {
    if (!actionsOpen) return;
    const closeIfOutside = (event: PointerEvent) => {
      if (!actionsRef.current?.contains(event.target as Node)) setActionsOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setActionsOpen(false);
    };
    document.addEventListener("pointerdown", closeIfOutside);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeIfOutside);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [actionsOpen]);
  const beginRename = () => {
    setLabel(profile.label);
    setEditing(true);
  };
  const saveRename = () => {
    const nextLabel = (labelRef.current?.value ?? label).trim();
    if (!nextLabel || nextLabel === profile.label) {
      setEditing(false);
      return;
    }
    onRename(profile, nextLabel);
    setEditing(false);
  };
  return (
    <li className="grid gap-3 border-b border-border/40 py-3 last:border-b-0 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center">
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          {editing && accountActionsAvailable ? (
            <label className="sr-only" htmlFor={`codex-profile-rename-${profile.id}`}>Account label</label>
          ) : null}
          {editing && accountActionsAvailable ? (
            <input
              id={`codex-profile-rename-${profile.id}`}
              ref={labelRef}
              value={label}
              onChange={(event) => setLabel(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") saveRename();
                if (event.key === "Escape") setEditing(false);
              }}
              className="min-w-36 rounded-md border border-border bg-background-element px-2 py-1 text-sm font-medium text-foreground"
              aria-label={`Rename ${profile.label}`}
              autoFocus
            />
          ) : (
            <span className="text-sm font-medium text-foreground">
              {profile.registrationState === "provisional" && !profile.accountEmail
                ? "Connecting Codex account"
                : displayLabel}
            </span>
          )}
          <StatusPill tone={status.tone}>{status.label}</StatusPill>
        </div>
        <div className="mt-0.5 flex flex-wrap gap-x-3 gap-y-1 text-xs text-foreground-muted">
          {profile.accountEmail && profile.label !== profile.accountEmail && profile.label !== "Codex account" ? <span>{profile.label}</span> : null}
          {!profile.accountEmail && profile.authState !== "signed_in" ? (
            <span>Choose the ChatGPT account in the sign-in window</span>
          ) : null}
          {plan ? <span>{planLabel(plan)}</span> : null}
          {details.map((detail) => <span key={detail}>{detail}</span>)}
          {profile.authState === "login_pending" || loginRef ? <span>Waiting for ChatGPT sign in…</span> : null}
        </div>
      </div>
      <div ref={actionsRef} className="relative flex shrink-0 flex-wrap items-center gap-1 sm:justify-end">
        {editing && accountActionsAvailable ? (
          <>
            <Button variant="secondary" disabled={busy || !label.trim()} onClick={saveRename}>Save</Button>
            <Button variant="ghost" disabled={busy} onClick={() => setEditing(false)}>Cancel</Button>
          </>
        ) : confirmingRemoval && accountActionsAvailable ? (
          <>
            <span className="text-xs text-foreground-muted">Remove this account?</span>
            <Button variant="secondary" loading={busy} onClick={() => onRemove(profile)}>Remove</Button>
            <Button variant="ghost" disabled={busy} onClick={() => setConfirmingRemoval(false)}>Cancel</Button>
          </>
        ) : (
          <>
            {profile.reconciliationState === "cleanup_required" ? (
              <Button variant="secondary" loading={busy} onClick={() => onRemove(profile)}>Finish cleanup</Button>
            ) : !accountActionsAvailable ? null : profile.authState === "signed_in" ? (
              <Button variant="ghost" loading={busy} onClick={() => onLogout(profile.id)}>Sign out</Button>
            ) : profile.authState === "login_pending" || loginRef ? (
              loginRef ? <Button variant="ghost" loading={busy} onClick={() => onCancelLogin(profile.id, loginRef)}>Cancel sign in</Button> : null
            ) : (
              <Button variant="secondary" loading={busy} disabled={!runtimeAvailable} onClick={() => onStartLogin(profile.id)}>
                Choose account
              </Button>
            )}
            {accountActionsAvailable && profileIsRegistered(profile) ? <button
              type="button"
              disabled={busy}
              onClick={() => setActionsOpen((open) => !open)}
              aria-label={`Account actions for ${profile.label}`}
              aria-haspopup="menu"
              aria-expanded={actionsOpen}
              title="Account actions"
              className="inline-flex items-center justify-center rounded-md px-3 py-1.5 text-sm font-medium text-foreground-muted transition-[color,transform,opacity] duration-150 hover:bg-background-element hover:text-foreground active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-50 disabled:active:scale-100"
            >
              More
            </button> : null}
            {accountActionsAvailable && profileIsRegistered(profile) && actionsOpen ? (
              <div
                role="menu"
                aria-label={`Account actions for ${profile.label}`}
                className="absolute right-0 top-full z-10 mt-1 min-w-36 rounded-md border border-border bg-background-panel p-1 shadow-lg"
              >
                <button type="button" role="menuitem" className="block w-full rounded px-2 py-1.5 text-left text-sm text-foreground hover:bg-background-element" onClick={() => {
                  setActionsOpen(false);
                  beginRename();
                }}>Rename</button>
                <button type="button" role="menuitem" className="block w-full rounded px-2 py-1.5 text-left text-sm text-foreground hover:bg-background-element" onClick={() => {
                  setActionsOpen(false);
                  onRefreshUsage(profile.id);
                }}>Refresh usage</button>
                <button type="button" role="menuitem" className="block w-full rounded px-2 py-1.5 text-left text-sm text-[var(--error)] hover:bg-background-element" onClick={() => {
                  setActionsOpen(false);
                  setConfirmingRemoval(true);
                }}>Remove</button>
              </div>
            ) : null}
          </>
        )}
      </div>
    </li>
  );
}

function disambiguatedProfileLabel(
  profile: CodexConnectionProfile,
  profiles: readonly CodexConnectionProfile[],
): string {
  if (profile.accountEmail) return profile.accountEmail;
  const duplicates = profiles.filter((candidate) => candidate.label === profile.label && !candidate.accountEmail);
  if (duplicates.length <= 1) return profile.label;
  return `${profile.label} · Slot ${duplicates.findIndex((candidate) => candidate.id === profile.id) + 1}`;
}

function planLabel(planType: string): string {
  switch (planType) {
    case "ent26":
    case "enterprise":
      return "Enterprise";
    case "self_serve_business_usage_based":
      return "Business usage-based";
    case "enterprise_cbp_usage_based":
      return "Enterprise usage-based";
    case "prolite":
      return "Pro Lite";
    default:
      return planType.charAt(0).toUpperCase() + planType.slice(1).replaceAll("_", " ");
  }
}

function profileOptionLabel(
  profile: CodexConnectionProfile,
  profiles: readonly CodexConnectionProfile[],
): string {
  const parts = [disambiguatedProfileLabel(profile, profiles)];
  if (profile.planType && profile.planType !== "unknown") parts.push(planLabel(profile.planType));
  if (profile.reconciliationState === "reconnecting") parts.push("Reconnecting");
  else if (profile.authState !== "signed_in") parts.push("Sign in again");
  return parts.join(" · ");
}

function compactConnectionSummary(
  summary: CodexConnectionSummary | null,
  preference: CodexUserPreference | null,
): string {
  if (!summary) return "Codex connection details";
  const runtime = summary.runtime;
  const parts = [
    runtime.source === "managed"
      ? "Managed runtime"
      : runtime.source === "external"
        ? "External runtime"
        : runtimeLabel(summary),
  ];
  if (runtime.version) parts.push(`v${runtime.version}`);
  const selectedProfile = preference?.profileId
    ? summary.profiles.find((profile) => profile.id === preference.profileId)
    : null;
  if (selectedProfile) {
    parts.push(disambiguatedProfileLabel(selectedProfile, summary.profiles));
    if (selectedProfile.reconciliationState === "reconnecting") parts.push("Reconnecting");
    else if (selectedProfile.authState !== "signed_in") parts.push("Sign in again");
    if (!preference?.enabled || !summary.runtime.available || !profileIsCurrent(selectedProfile)) {
      parts.push("Genie unavailable");
    }
  } else {
    parts.push("Account not connected");
  }
  if (preference?.profileId) {
    parts.push({
      codex_default: "Codex default",
      prompted_workspace: "Ask for changes",
      full_access_headless: "Full access",
    }[preference.posture]);
  }
  return parts.join(" · ");
}

/**
 * D453 — intentionally narrow local connection section. It never receives an
 * upstream URL or account credentials; Electron opens official Codex login in
 * the browser as part of the account control-plane flow.
 */
export function CodexConnectionSection({
  isDesktopShell = isDesktop,
}: {
  isDesktopShell?: boolean;
} = {}) {
  const sectionRef = useRef<HTMLElement>(null);
  const connection = isDesktopShell ? desktopAPI?.codexConnection : undefined;
  const [local, setLocal] = useState<LocalState>(() => connection ? { kind: "loading" } : { kind: "unavailable" });
  const [summary, setSummary] = useState<CodexConnectionSummary | null>(null);
  const [summaryFailed, setSummaryFailed] = useState(false);
  const [busy, setBusy] = useState<"enable" | "disable" | null>(null);
  const [serverBusy, setServerBusy] = useState<string | null>(null);
  const [actionFailed, setActionFailed] = useState(false);
  const [preferenceError, setPreferenceError] = useState<string | null>(null);
  const [pendingLogins, setPendingLogins] = useState<Record<string, string>>({});
  const [profileSnapshots, setProfileSnapshots] = useState<Record<string, ProfileSnapshot>>({});
  const [preference, setPreference] = useState<CodexUserPreference | null>(null);
  const [confirmingFullAccess, setConfirmingFullAccess] = useState(false);
  const [expanded, setExpanded] = useState(true);
  const expandForRouteReveal = useCallback(() => setExpanded(true), []);
  useWorkbenchUiTargetReveal("connections.codex", true, expandForRouteReveal);
  const mountedRef = useRef(true);
  const refreshGenerationRef = useRef(0);
  const summaryGenerationRef = useRef(0);
  const summaryRequestRef = useRef<Promise<void> | null>(null);
  // An explicit install needs one post-completion inspection. The Electron
  // controller records the verified generation asynchronously; inspecting it
  // again is what activates that exact generation without a Nautilo restart.
  // Do not do this for an externally discovered candidate.
  const managedInstallPendingRef = useRef(false);
  const hasSummary = summary !== null;
  const localRelayId = useCallback(
    () => isDesktopShell ? getDesktopRelayId() : Promise.resolve(null),
    [isDesktopShell],
  );

  // A Codex inspection can legitimately be slow on a cold native runtime.
  // Keep its lifecycle separate from the lightweight Electron status check:
  // disabling must take effect immediately, while the obsolete inspection is
  // simply ignored when it eventually settles.
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      refreshGenerationRef.current += 1;
      summaryGenerationRef.current += 1;
    };
  }, []);

  const clearSummary = useCallback(() => {
    summaryGenerationRef.current += 1;
    if (!mountedRef.current) return;
    setSummary(null);
    setSummaryFailed(false);
  }, []);

  const refreshSummary = useCallback(async () => {
    // All render-driven polling paths converge here. Reusing the promise is
    // intentional: a 1s retry must never queue another serialized app-server
    // inspection behind the one already running.
    if (summaryRequestRef.current) return summaryRequestRef.current;

    const generation = summaryGenerationRef.current;
    const request = localRelayId().then((relayId) => apiClient.codex.summary(relayId));
    const completion = request.then(
      (nextSummary) => {
        if (!mountedRef.current || generation !== summaryGenerationRef.current) return;
        setSummary(nextSummary);
        setSummaryFailed(false);
      },
      () => {
        // Account detail availability must never take the local desktop
        // control surface down with it. Its route is independently staged.
        if (!mountedRef.current || generation !== summaryGenerationRef.current) return;
        setSummary(null);
        setSummaryFailed(true);
      },
    ).finally(() => {
      if (summaryRequestRef.current === completion) {
        summaryRequestRef.current = null;
      }
    });
    summaryRequestRef.current = completion;
    return completion;
  }, [localRelayId]);

  const refresh = useCallback(async () => {
    const refreshGeneration = ++refreshGenerationRef.current;
    if (!connection) {
      if (mountedRef.current && refreshGeneration === refreshGenerationRef.current) {
        setLocal({ kind: "unavailable" });
        clearSummary();
      }
      return;
    }
    try {
      const status = await connection.status();
      if (!mountedRef.current || refreshGeneration !== refreshGenerationRef.current) return;
      setLocal({ kind: "ready", status });
      if (status.state !== "enabled") {
        clearSummary();
        return;
      }
    } catch {
      if (!mountedRef.current || refreshGeneration !== refreshGenerationRef.current) return;
      setLocal({ kind: "error" });
      clearSummary();
      return;
    }
    await refreshSummary();
  }, [clearSummary, connection, refreshSummary]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (!hasSummary) {
      setPreference(null);
      return;
    }
    let cancelled = false;
    void apiClient.codex.userPreference().then((nextPreference) => {
      if (!cancelled) setPreference(nextPreference);
    }).catch(() => {
      if (!cancelled) setPreference(null);
    });
    return () => {
      cancelled = true;
    };
  }, [hasSummary]);

  useEffect(() => {
    const profileIds = Object.keys(pendingLogins);
    if (profileIds.length === 0) return;
    let cancelled = false;
    let timer: number | undefined;
    const poll = async () => {
      await Promise.all(profileIds.map(async (profileId) => {
        try {
          const account = await apiClient.codex.readAccount(profileId);
          if (cancelled || !mountedRef.current || account.authState !== "signed_in") return;
          const nextPreference = await apiClient.codex.userPreference();
          if (cancelled || !mountedRef.current) return;
          setPendingLogins((current) => {
            const { [profileId]: _loginRef, ...remaining } = current;
            return remaining;
          });
          setPreference(nextPreference);
          void refresh();
        } catch {
          // A transient account read failure must not discard the opaque
          // login reference needed to offer a human Cancel action.
        }
      }));
      if (!cancelled) timer = window.setTimeout(() => void poll(), 2_000);
    };
    timer = window.setTimeout(() => void poll(), 2_000);
    return () => {
      cancelled = true;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [pendingLogins, refresh]);

  useEffect(() => {
    if (!summary?.profiles.some((profile) => profile.reconciliationState === "reconnecting")) return;
    let cancelled = false;
    let timer: number | undefined;
    const poll = async () => {
      await refresh();
      if (!cancelled) timer = window.setTimeout(() => void poll(), 2_000);
    };
    timer = window.setTimeout(() => void poll(), 2_000);
    return () => {
      cancelled = true;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [refresh, summary?.profiles]);

  // Installation has no renderer event stream. Poll only while the canonical
  // summary says a download is active, and stop immediately on every other
  // runtime state or when this section unmounts.
  useEffect(() => {
    if (summary?.runtime.state !== "installing") return;
    let cancelled = false;
    let timer: number | undefined;
    const poll = async () => {
      await refresh();
      if (!cancelled) timer = window.setTimeout(() => void poll(), 2_000);
    };
    timer = window.setTimeout(() => void poll(), 2_000);
    return () => {
      cancelled = true;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [refresh, summary?.runtime.state]);

  const change = async (operation: "enable" | "disable") => {
    if (!connection) return;
    setBusy(operation);
    setActionFailed(false);
    clearSummary();
    // Electron fences the requested lifecycle transition synchronously. Mirror
    // that intent immediately instead of leaving an enabled/Connecting card on
    // screen while IPC waits for local teardown or relay reconciliation.
    if (status) {
      setLocal({
        kind: "ready",
        status: {
          ...status,
          state: operation === "enable" ? "enabling" : "disabling",
          ready: false,
        },
      });
    }
    try {
      await connection[operation]();
      await refresh();
    } catch {
      // Electron intentionally keeps operational errors local; do not render
      // arbitrary process, account, or runtime details in the workbench.
      if (mountedRef.current) setActionFailed(true);
      await refresh();
    } finally {
      if (mountedRef.current) setBusy(null);
    }
  };

  const runServerAction = useCallback(async (key: string, action: () => Promise<unknown>) => {
    setServerBusy(key);
    setActionFailed(false);
    try {
      await action();
      await refresh();
    } catch {
      if (mountedRef.current) setActionFailed(true);
    } finally {
      if (mountedRef.current) setServerBusy(null);
    }
  }, [refresh]);

  const completeManagedInstall = useCallback(() => {
    const runtime = summary?.runtime;
    if (!managedInstallPendingRef.current || !runtime || runtime.state === "installing") return;
    managedInstallPendingRef.current = false;
    // A successful managed acquisition is only usable after the controller
    // re-probes and selects the generation it just admitted. The renderer
    // receives neither an install handle nor a path, only the activation-safe
    // generation returned by the server.
    if ((runtime.state === "ready" || runtime.state === "limited") && !runtime.available) {
      void runServerAction("activate-installed", async () => {
        const relayId = await localRelayId();
        const inspected = await apiClient.codex.inspectRuntime(relayId);
        if (
          (inspected.state === "ready" || inspected.state === "limited")
          && !inspected.available
          && inspected.runtimeGeneration !== null
        ) {
          await apiClient.codex.activateRuntime(inspected.runtimeGeneration, relayId);
        }
      });
    }
  }, [localRelayId, runServerAction, summary?.runtime]);

  useEffect(() => {
    completeManagedInstall();
  }, [completeManagedInstall]);

  const createProfile = () => {
    void runServerAction("create-profile", async () => {
      const connected = await apiClient.codex.createProfile(await localRelayId());
      if (!mountedRef.current) return;
      setPendingLogins((current) => ({ ...current, [connected.profile.id]: connected.loginRef }));
    });
  };

  const startLogin = (profileId: string) => {
    void runServerAction(`login:${profileId}`, async () => {
      const login = await apiClient.codex.startLogin(profileId);
      if (!mountedRef.current) return;
      setPendingLogins((current) => ({ ...current, [profileId]: login.loginRef }));
    });
  };

  const cancelLogin = (profileId: string, loginRef: string) => {
    void runServerAction(`cancel-login:${profileId}`, async () => {
      await apiClient.codex.cancelLogin(profileId, loginRef);
      if (!mountedRef.current) return;
      setPendingLogins((current) => {
        const { [profileId]: _ignored, ...remaining } = current;
        return remaining;
      });
    });
  };

  const renameProfile = (profile: CodexConnectionProfile, label: string) => {
    void runServerAction(`rename:${profile.id}`, () =>
      apiClient.codex.renameProfile(profile.id, label, profile.revision),
    );
  };

  const refreshUsage = (profileId: string) => {
    void runServerAction(`usage:${profileId}`, async () => {
      const [usageResult, rateLimitsResult] = await Promise.allSettled([
        apiClient.codex.usage(profileId),
        apiClient.codex.rateLimits(profileId),
      ]);
      if (usageResult.status === "rejected" && rateLimitsResult.status === "rejected") {
        throw new Error("Codex usage refresh unavailable");
      }
      if (!mountedRef.current) return;
      setProfileSnapshots((current) => ({
        ...current,
        [profileId]: {
          usage: usageResult.status === "fulfilled"
            ? usageResult.value
            : current[profileId]?.usage ?? null,
          rateLimits: rateLimitsResult.status === "fulfilled"
            ? rateLimitsResult.value
            : current[profileId]?.rateLimits ?? null,
          usageUnavailable: usageResult.status === "rejected",
          rateLimitsUnavailable: rateLimitsResult.status === "rejected",
        },
      }));
    });
  };

  const removeProfile = (profile: CodexConnectionProfile) => {
    void runServerAction(`remove:${profile.id}`, async () => {
      await apiClient.codex.removeProfile(profile.id, profile.revision);
      // The server's removal gate clears an invalid owner default before it
      // drains the exact child. Read that persisted authority back; do not
      // optimistically pick another account in the renderer.
      const nextPreference = await apiClient.codex.userPreference();
      if (mountedRef.current) {
        setPreference(nextPreference);
        setProfileSnapshots((current) => {
          const { [profile.id]: _removed, ...remaining } = current;
          return remaining;
        });
      }
    });
  };

  const savePreference = (
    patch: Partial<Pick<CodexUserPreference, "enabled" | "profileId" | "posture">>,
  ) => {
    if (!preference) return;
    const next = { ...preference, ...patch };
    if (next.enabled && !next.profileId) return;
    setServerBusy("preference");
    setActionFailed(false);
    setPreferenceError(null);
    void apiClient.codex.setUserPreference({
      enabled: next.enabled,
      profileId: next.profileId,
      posture: next.posture,
      expectedRevision: preference.revision,
    }).then(async (saved) => {
      if (mountedRef.current) setPreference(saved);
      await refresh();
    }).catch(() => {
      if (mountedRef.current) setPreferenceError("Codex defaults could not be saved. Try again.");
    }).finally(() => {
      if (mountedRef.current) setServerBusy(null);
    });
  };

  const requestPosture = (posture: CodexPosture) => {
    if (!preference?.profileId) return;
    if (posture === "full_access_headless" && preference?.posture !== posture) {
      setConfirmingFullAccess(true);
      return;
    }
    setConfirmingFullAccess(false);
    savePreference({ posture });
  };

  const status = local.kind === "ready" ? local.status : null;
  const pill = status?.state === "enabled" && summary === null
    ? { tone: "info" as const, label: "Connecting" }
    : status ? localPill(status) : null;
  const canEnable = status?.state === "disabled";
  const canDisable = status?.state === "enabled" || status?.state === "enabling";
  const runtime = summary?.runtime;
  const isInstalling = runtime?.state === "installing";
  const installReceipt = runtime ? runtimeReceipt(runtime) : null;
  const isCompletingManagedInstall = serverBusy === "activate-installed";
  const selectedProfile = preference?.profileId
    ? summary?.profiles.find((profile) => profile.id === preference.profileId)
    : undefined;
  const genieAvailable = preference?.enabled === true
    && summary?.runtime.available === true
    && selectedProfile !== undefined
    && profileIsRegistered(selectedProfile)
    && profileIsCurrent(selectedProfile)
    && selectedProfile.authState === "signed_in";

  // Enabling the local host and publishing its first server-side status are
  // separate asynchronous steps. Keep retrying that narrow handoff instead
  // of stranding the card behind a one-shot 409 race.
  useEffect(() => {
    if (status?.state !== "enabled" || summary !== null) return;
    let cancelled = false;
    let timer: number | undefined;
    const poll = async () => {
      await refresh();
      if (!cancelled) timer = window.setTimeout(() => void poll(), 1_000);
    };
    timer = window.setTimeout(() => void poll(), 1_000);
    return () => {
      cancelled = true;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [refresh, status?.state, summary]);

  return (
    <section
      id="codex"
      ref={sectionRef}
      tabIndex={-1}
      className="scroll-mt-6 rounded-lg border border-border bg-background-panel outline-none focus-visible:ring-2 focus-visible:ring-accent"
      aria-labelledby="codex-connection-title"
    >
      <header className="flex items-center justify-between gap-3 border-b border-border px-4 py-3">
        <div className="min-w-0 flex-1">
          <h2 id="codex-connection-title" className="text-sm font-semibold">Codex</h2>
          <p className="mt-1 text-xs text-foreground-muted">
            {expanded
              ? "Use Codex on this desktop with Nautilo. The first connected account becomes the default; later account changes are manual."
              : compactConnectionSummary(summary, preference)}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {pill ? <StatusPill tone={pill.tone}>{pill.label}</StatusPill> : null}
          <button
            type="button"
            className="rounded px-2 py-1 text-xs font-medium text-foreground-muted hover:bg-background-element hover:text-foreground"
            aria-expanded={expanded}
            aria-controls="codex-connection-details"
            onClick={() => setExpanded((current) => !current)}
          >
            {expanded ? "Collapse" : "Expand"}
          </button>
          {status ? (
            <CodexToggle
              enabled={canDisable}
              disabled={!canEnable && !canDisable}
              loading={busy !== null}
              onChange={(enabled) => void change(enabled ? "enable" : "disable")}
            />
          ) : null}
        </div>
      </header>
      {expanded ? <div id="codex-connection-details" className="space-y-3 px-4 py-3">
        {!isDesktopShell ? (
          <p className="text-sm text-foreground-muted">Open Nautilo desktop to connect Codex.</p>
        ) : local.kind === "unavailable" ? (
          <p className="text-sm text-foreground-muted">Update Nautilo desktop to connect Codex.</p>
        ) : local.kind === "loading" ? (
          <p className="text-sm text-foreground-muted">Checking Codex connection…</p>
        ) : local.kind === "error" ? (
          <p className="text-sm text-[var(--error)]" role="alert">Codex connection status could not be loaded.</p>
        ) : status?.state === "disabling" ? (
          <p className="text-sm text-foreground-muted">Codex is stopping…</p>
        ) : status?.state === "faulted" ? (
          <p className="text-sm text-foreground-muted">Restart Nautilo to recover Codex.</p>
        ) : null}

        {actionFailed ? <p className="text-sm text-[var(--error)]" role="alert">Codex connection could not be updated.</p> : null}
        {summaryFailed ? (
          <p className="text-xs text-foreground-muted">
            Codex is enabled locally; waiting for Nautilo to receive its status. Retrying…
          </p>
        ) : null}

        {summary ? (
          <div className="border-t border-border/60">
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border/40 py-3">
              <div>
                <div className="text-sm font-medium text-foreground">Runtime</div>
                <div className="mt-0.5 text-xs text-foreground-muted">{runtimeLabel(summary)}</div>
                {runtime?.source || runtime?.version ? <div className="mt-0.5 text-xs text-foreground-muted">{[runtime.source === "managed" ? "Managed runtime" : runtime.source === "external" ? "External runtime" : null, runtime.version ? `v${runtime.version}` : null].filter(Boolean).join(" · ")}</div> : null}
              </div>
              <div className="flex flex-wrap justify-end gap-2">
              <Button variant="ghost" disabled={isInstalling || isCompletingManagedInstall} loading={serverBusy === "inspect" || isCompletingManagedInstall} onClick={() => void runServerAction("inspect", async () => apiClient.codex.inspectRuntime(await localRelayId()))}>Check again</Button>
              {summary.runtime.state === "absent" || summary.runtime.state === "failed" || summary.runtime.state === "incompatible" ? (
                <Button
                  variant="primary"
                  loading={serverBusy === "install"}
                  onClick={() => {
                    managedInstallPendingRef.current = true;
                    void runServerAction("install", async () => apiClient.codex.installRuntime(await localRelayId()));
                  }}
                >
                  {summary.runtime.state === "failed"
                    ? "Retry install"
                    : summary.runtime.state === "incompatible"
                      ? "Install reviewed runtime"
                      : "Install Codex"}
                </Button>
              ) : null}
              {summary.runtime.state === "installing" && summary.runtime.installation?.canCancel !== false ? (
                <Button
                  variant="secondary"
                  loading={serverBusy === "cancel-install"}
                  onClick={() => {
                    managedInstallPendingRef.current = false;
                    void runServerAction("cancel-install", async () => apiClient.codex.cancelRuntimeInstall(await localRelayId()));
                  }}
                >
                  Cancel installation
                </Button>
              ) : null}
              {(summary.runtime.state === "ready" || summary.runtime.state === "limited") && !summary.runtime.available && summary.runtime.runtimeGeneration !== null ? (
                <Button variant="primary" loading={serverBusy === "activate"} onClick={() => void runServerAction("activate", async () => apiClient.codex.activateRuntime(summary.runtime.runtimeGeneration!, await localRelayId()))}>Use this Codex</Button>
              ) : null}
              </div>
            </div>
            {summary.runtime.state === "installing" ? (
              <p className="border-b border-border/40 py-2 text-xs text-foreground-muted" aria-live="polite">
                {installReceipt ? `Managed install: ${installReceipt}` : "Preparing the reviewed managed Codex app-server runtime…"}
              </p>
            ) : isCompletingManagedInstall ? (
              <p className="border-b border-border/40 py-2 text-xs text-foreground-muted" aria-live="polite">
                Checking and activating the verified runtime…
              </p>
            ) : summary.runtime.state === "failed" ? (
              <p className="border-b border-border/40 py-2 text-xs text-foreground-muted">
                {runtimeFailureMessage(summary.runtime, installReceipt)}
              </p>
            ) : summary.runtime.state === "incompatible" ? (
              <p className="border-b border-border/40 py-2 text-xs text-foreground-muted">
                Nautilo found this Codex runtime, but its app-server protocol is incompatible with this Nautilo build. Install the reviewed managed runtime to continue. Your existing Codex installation and data will not be changed.
              </p>
            ) : null}
            {compatibilityDiagnosticMessage(summary.runtime) ? (
              <p className="border-b border-border/40 py-2 text-xs text-foreground-muted">
                {compatibilityDiagnosticMessage(summary.runtime)}
              </p>
            ) : null}
            <p className="border-b border-border/40 py-2 text-xs text-foreground-muted">
              Codex is never bundled with Nautilo. Use an external runtime, or explicitly install the review-pinned managed app-server runtime outside Nautilo.app.
            </p>
            {!summary.runtime.available ? (
              <p className="border-b border-border/40 py-2 text-xs text-foreground-muted">
                Activate a compatible runtime before adding or signing in to an account.
              </p>
            ) : null}
            <div className="flex items-center justify-between gap-3 py-3">
              <h3 className="text-xs font-semibold uppercase tracking-wide text-foreground-muted">Accounts</h3>
              <Button variant="primary" loading={serverBusy === "create-profile"} disabled={!summary.runtime.available || summary.profiles.some((profile) => !profileIsRegistered(profile) || !profileIsCurrent(profile))} onClick={createProfile}>Connect Codex account</Button>
            </div>
            {summary.profiles.length > 0 ? (
              <ul aria-label="Codex accounts">
                {summary.profiles.map((profile) => <ProfileRow
                  key={profile.id}
                  profile={profile}
                  displayLabel={disambiguatedProfileLabel(profile, summary.profiles)}
                  busy={serverBusy === `login:${profile.id}` || serverBusy === `cancel-login:${profile.id}` || serverBusy === `logout:${profile.id}` || serverBusy === `rename:${profile.id}` || serverBusy === `usage:${profile.id}` || serverBusy === `remove:${profile.id}`}
                  loginRef={pendingLogins[profile.id] ?? null}
                  runtimeAvailable={summary.runtime.available}
                  snapshot={profileSnapshots[profile.id]}
                  onStartLogin={startLogin}
                  onCancelLogin={cancelLogin}
                  onLogout={(profileId) => void runServerAction(`logout:${profileId}`, () => apiClient.codex.logout(profileId))}
                  onRename={renameProfile}
                  onRemove={removeProfile}
                  onRefreshUsage={refreshUsage}
                />)}
              </ul>
            ) : (
              <p className="border-b border-border/40 py-3 text-sm text-foreground-muted">Account not connected.</p>
            )}

            <div className="border-b border-border/40 py-4">
              <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-foreground-muted">Defaults for new Codex work</h3>
              <div className="grid gap-1.5">
                <label className="grid min-w-0 gap-1 sm:grid-cols-[10rem_minmax(0,32rem)] sm:items-center">
                  <span className="text-sm font-medium text-foreground">Default account</span>
                  <select
                    aria-label="Default account"
                    value={preference?.profileId ?? ""}
                    disabled={!preference || serverBusy === "preference"}
                    onChange={(event) => {
                      const profileId = event.target.value || null;
                      savePreference({
                        profileId,
                        // Choosing a signed-in account is the one explicit
                        // action that makes Codex available user-wide.
                        // Clearing it removes that authority and disables it.
                        enabled: profileId !== null,
                      });
                    }}
                    className="w-full min-w-0 rounded-md border border-border bg-background-element px-2 py-1.5 text-sm text-foreground"
                  >
                    <option value="">Choose account</option>
                    {summary.profiles
                      .filter(profileIsRegistered)
                      .map((profile) => (
                        <option
                          key={profile.id}
                          value={profile.id}
                          disabled={profile.authState !== "signed_in" || !profileIsCurrent(profile)}
                        >
                          {profileOptionLabel(profile, summary.profiles)}
                        </option>
                    ))}
                  </select>
                </label>
                <label className="grid min-w-0 gap-1 sm:grid-cols-[10rem_minmax(0,32rem)] sm:items-center">
                  <span className="text-sm font-medium text-foreground">Permissions</span>
                  <select
                    aria-label="Codex permissions"
                    value={preference?.posture ?? "codex_default"}
                    disabled={!genieAvailable || serverBusy === "preference"}
                    onChange={(event) => requestPosture(event.target.value as CodexPosture)}
                    className="w-full min-w-0 rounded-md border border-border bg-background-element px-2 py-1.5 text-sm text-foreground"
                  >
                    <option value="codex_default">Codex default</option>
                    <option value="prompted_workspace">Ask for changes</option>
                    <option value="full_access_headless">Full access</option>
                  </select>
                </label>
                <p className="text-xs text-foreground-muted sm:ml-[10rem]">
                  Genie availability: {genieAvailable ? "Available for new Codex work" : "Unavailable until a registered account is current and signed in"}
                </p>
                {!preference?.profileId ? (
                  <p className="text-xs text-foreground-muted sm:ml-[10rem]">Choose a default account first.</p>
                ) : null}
                {confirmingFullAccess ? (
                  <div className="rounded-md border border-[var(--warning)]/50 bg-[var(--warning)]/10 p-3 sm:ml-[10rem] sm:max-w-[32rem]" role="alert" aria-label="Confirm full access">
                    <div className="text-sm font-medium text-foreground">Enable full access?</div>
                    <p className="mt-1 text-xs text-foreground-muted">Codex may run commands and modify files without Nautilo approval or sandboxing.</p>
                    <div className="mt-3 flex justify-end gap-2">
                      <Button variant="ghost" disabled={serverBusy === "preference"} onClick={() => { setConfirmingFullAccess(false); setPreferenceError(null); }}>Cancel</Button>
                      <Button variant="primary" loading={serverBusy === "preference"} onClick={() => {
                        setConfirmingFullAccess(false);
                        savePreference({ posture: "full_access_headless" });
                      }}>Enable full access</Button>
                    </div>
                  </div>
                ) : null}
                <div className="grid min-w-0 gap-1 sm:grid-cols-[10rem_minmax(0,32rem)] sm:items-center">
                  <span className="text-sm font-medium text-foreground">Genie access</span>
                  <div className="flex min-h-9 items-center justify-between gap-3 rounded-md border border-border bg-background-element px-3 py-1.5">
                    <span className="text-sm text-foreground">{genieAvailable ? "Available to all non-Guest Genies" : "Unavailable"}</span>
                    <CodexToggle
                      compact
                      enabled={Boolean(preference?.profileId && preference.enabled)}
                      disabled={
                        !preference?.profileId ||
                        serverBusy === "preference"
                      }
                      loading={serverBusy === "preference"}
                      onChange={(enabled) => savePreference({ enabled })}
                    />
                  </div>
                </div>
                {preferenceError ? <p className="text-xs text-[var(--error)] sm:ml-[10rem]" role="alert">{preferenceError}</p> : null}
              </div>
            </div>
            <p className="border-b border-border/40 py-3 text-xs text-foreground-muted">
              Account and default changes affect only new Codex Tasks and threads. They never mutate a running Codex binding. Full access lets Codex work headlessly; Nautilo does not approve or sandbox those actions.
            </p>
          </div>
        ) : null}
      </div> : null}
    </section>
  );
}
