import { useCallback, useEffect, useState } from "react";
import { ApiError } from "@nautilo/api-client/browser";
import type {
  PersonalCapabilityModelReadiness,
  PersonalCapabilityPreferenceOverrides,
  PersonalCapabilityPreferencesResponse,
  PersonalCapabilityRole,
} from "@nautilo/types";
import { apiClient } from "../../../lib/api";
import { useAuth } from "../../../hooks/use-auth";
import { GuestPlaceholder, SectionCard, StatusPill } from "../ui";

export function nextPersonalCapabilityOverrides(
  current: PersonalCapabilityPreferenceOverrides,
  role: PersonalCapabilityRole,
  modelId: string | null,
): PersonalCapabilityPreferenceOverrides {
  const next = { ...current };
  if (modelId === null) delete next[role];
  else next[role] = modelId;
  return next;
}

function statusTone(status: "ready" | "missing-credentials" | "unavailable") {
  return status === "ready" ? "ok" as const
    : status === "missing-credentials" ? "warn" as const
    : "error" as const;
}

function statusLabel(status: "ready" | "missing-credentials" | "unavailable") {
  return status === "ready" ? "Ready"
    : status === "missing-credentials" ? "Key needed"
    : "Unavailable";
}

function fundingLabel(readiness: PersonalCapabilityModelReadiness): string {
  if (!readiness.fundingSource || !readiness.providerRoute) return "No current funding source";
  return readiness.fundingSource === "personal"
    ? `Your ${readiness.providerRoute} credential`
    : `Server ${readiness.providerRoute} credential`;
}

export function PersonalCapabilityPreferencesSection() {
  const auth = useAuth();
  const enabled = auth.viewer.isVerified;
  const [state, setState] = useState<PersonalCapabilityPreferencesResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [savingRole, setSavingRole] = useState<PersonalCapabilityRole | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!enabled) return;
    setLoading(true);
    try {
      setState(await apiClient.getPersonalCapabilityPreferences());
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Capability model preferences could not be loaded.");
    } finally {
      setLoading(false);
    }
  }, [enabled]);

  useEffect(() => { void load(); }, [load, auth.viewerGeneration]);

  const save = async (role: PersonalCapabilityRole, value: string) => {
    if (!state || savingRole) return;
    const modelId = value === "" ? null : value;
    setSavingRole(role);
    setError(null);
    try {
      const next = await apiClient.replacePersonalCapabilityPreferences({
        expectedRevision: state.revision,
        overrides: nextPersonalCapabilityOverrides(state.overrides, role, modelId),
      });
      setState(next);
    } catch (cause) {
      if (cause instanceof ApiError && cause.status === 409) {
        await load();
        setError("These preferences changed elsewhere. The current choices were reloaded; choose again if needed.");
      } else {
        setError(cause instanceof Error ? cause.message : "The preference was not saved.");
      }
    } finally {
      setSavingRole(null);
    }
  };

  return (
    <SectionCard
      id="capability-models"
      title="Research & decision models"
      description="Choose account-wide models for your own research and decision work. Inherit keeps each workflow's current default; Genie and Room model settings remain separate."
    >
      {!enabled ? <GuestPlaceholder what="Research and decision model preferences" /> : null}
      {enabled && loading && !state ? <p className="text-sm text-foreground-muted">Loading model choices…</p> : null}
      {enabled && state ? (
        <div className="space-y-5">
          <p className="rounded-md border border-border bg-background-element p-3 text-xs text-foreground-muted">
            Admin funding priority: <strong className="text-foreground">{state.fundingPreference === "server_first" ? "Server credentials first" : "Personal keys first"}</strong>. A sole permitted source remains usable.
          </p>
          {state.capabilities.map((capability) => {
            const saved = state.overrides[capability.role];
            return (
              <div key={capability.role} className="border-b border-border/40 pb-5 last:border-0 last:pb-0">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div>
                    <label htmlFor={`capability-${capability.role}`} className="text-sm font-medium text-foreground">
                      {capability.label}
                    </label>
                    <p className="mt-0.5 text-xs text-foreground-muted">{capability.description}</p>
                  </div>
                  <StatusPill tone={statusTone(capability.readiness.status)}>
                    {statusLabel(capability.readiness.status)}
                  </StatusPill>
                </div>
                <select
                  id={`capability-${capability.role}`}
                  className="mt-3 w-full rounded-md border border-border bg-background-element px-3 py-2 text-sm text-foreground disabled:opacity-60"
                  value={saved ?? ""}
                  disabled={savingRole !== null}
                  onChange={(event) => { void save(capability.role, event.target.value); }}
                >
                  <option value="">Inherit — {capability.selection.source === "inherited" ? capability.selection.displayName : "workflow default"}</option>
                  {capability.options.map((option) => (
                    <option key={option.modelId} value={option.modelId}>
                      {option.displayName} · {option.provider} · {option.readiness.status === "ready" ? fundingLabel(option.readiness) : statusLabel(option.readiness.status)}
                    </option>
                  ))}
                </select>
                <p className="mt-2 text-xs text-foreground-muted">
                  Effective: <strong className="text-foreground">{capability.selection.displayName}</strong>
                  {` · ${capability.selection.source === "personal" ? "Your choice" : "Inherited"}`}
                  {` · ${fundingLabel(capability.readiness)}`}
                  {capability.readiness.reason ? ` · ${capability.readiness.reason}` : ""}
                </p>
              </div>
            );
          })}
          <p className="text-xs text-foreground-muted">
            A choice can be saved before its provider key is ready. Funding and credentials are checked again when fresh work starts.
            {" "}<a className="text-primary hover:underline" href="/settings#personal-provider-keys">Manage personal API keys.</a>
            {" "}<a className="text-primary hover:underline" href="/account/costs">View your costs.</a>
          </p>
        </div>
      ) : null}
      {enabled && error ? <p className="mt-3 text-sm text-[var(--error)]" role="alert">{error}</p> : null}
      {enabled && error && !state ? (
        <button type="button" onClick={() => { void load(); }} className="mt-3 text-sm font-medium text-primary">Try again</button>
      ) : null}
    </SectionCard>
  );
}
