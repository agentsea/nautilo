import { useCallback, useEffect, useRef, useState } from "react";
import type { ServerProviderPolicy, ServerProviderFundingPreference } from "@nautilo/api-client";
import { apiClient } from "../../../lib/api";
import { useCan } from "../../../hooks/use-can";
import { Button } from "../../settings/ui";

function errorMessage(cause: unknown): string {
  return cause instanceof Error
    ? cause.message
    : "Personal provider key policy is unavailable.";
}

export function ServerProviderPolicyCard() {
  const can = useCan();
  const canManage = can("manage_server_settings");
  const canRead = can("read_server_settings") || canManage;
  const [persisted, setPersisted] = useState<ServerProviderPolicy | null>(null);
  const [draftEnabled, setDraftEnabled] = useState(false);
  const [draftFundingPreference, setDraftFundingPreference] =
    useState<ServerProviderFundingPreference>("personal_first");
  const [loading, setLoading] = useState(canRead);
  const [saving, setSaving] = useState(false);
  const [policyStateKnown, setPolicyStateKnown] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saveSuccess, setSaveSuccess] = useState<string | null>(null);
  const loadGeneration = useRef(0);

  const load = useCallback(async () => {
    if (!canRead) return;
    const generation = ++loadGeneration.current;
    setLoading(true);
    setLoadError(null);
    try {
      const policy = await apiClient.admin.serverProviderPolicy.get();
      if (generation !== loadGeneration.current) return;
      setPersisted(policy);
      setDraftEnabled(policy.allowPersonalProviderKeys);
      setDraftFundingPreference(policy.fundingPreference);
      setPolicyStateKnown(true);
      setSaveError(null);
    } catch (cause) {
      if (generation !== loadGeneration.current) return;
      setLoadError(errorMessage(cause));
    } finally {
      if (generation === loadGeneration.current) setLoading(false);
    }
  }, [canRead]);

  useEffect(() => {
    void load();
  }, [load]);

  if (!canRead) return null;

  const recoverUnknownPolicy = async () => {
    if (persisted === null) return;
    setLoading(true);
    setLoadError(null);
    try {
      const policy = await apiClient.admin.serverProviderPolicy.get();
      const effectivePolicyChanged =
        policy.allowPersonalProviderKeys !== persisted.allowPersonalProviderKeys
        || policy.fundingPreference !== persisted.fundingPreference;
      setPersisted(policy);
      setDraftEnabled(policy.allowPersonalProviderKeys);
      setDraftFundingPreference(policy.fundingPreference);
      setPolicyStateKnown(true);
      setSaveError(null);
      if (effectivePolicyChanged) {
        window.dispatchEvent(new Event("nautilo:personal-provider-policy-changed"));
      }
    } catch (cause) {
      setLoadError(errorMessage(cause));
    } finally {
      setLoading(false);
    }
  };

  const save = async () => {
    if (!canManage || persisted === null) return;
    setSaving(true);
    setSaveError(null);
    setSaveSuccess(null);
    try {
      const patch = {
        ...(draftEnabled !== persisted.allowPersonalProviderKeys
          ? { allowPersonalProviderKeys: draftEnabled }
          : {}),
        ...(draftFundingPreference !== persisted.fundingPreference
          ? { fundingPreference: draftFundingPreference }
          : {}),
      };
      const policy = await apiClient.admin.serverProviderPolicy.set(patch);
      setPersisted(policy);
      setDraftEnabled(policy.allowPersonalProviderKeys);
      setDraftFundingPreference(policy.fundingPreference);
      window.dispatchEvent(new Event("nautilo:personal-provider-policy-changed"));
      setSaveSuccess("Personal provider policy saved.");
    } catch (cause) {
      const saveFailure = errorMessage(cause);
      try {
        const policy = await apiClient.admin.serverProviderPolicy.get();
        const effectivePolicyChanged =
          policy.allowPersonalProviderKeys !== persisted.allowPersonalProviderKeys
          || policy.fundingPreference !== persisted.fundingPreference;
        setPersisted(policy);
        setDraftEnabled(policy.allowPersonalProviderKeys);
        setDraftFundingPreference(policy.fundingPreference);
        setPolicyStateKnown(true);
        if (effectivePolicyChanged) {
          window.dispatchEvent(new Event("nautilo:personal-provider-policy-changed"));
        }
        setSaveError(
          `${saveFailure} The save response could not be confirmed, so the current server policy was refreshed.`,
        );
      } catch (refreshCause) {
        setPolicyStateKnown(false);
        setSaveError(
          `${saveFailure} The save response could not be confirmed, and refreshing the server policy also failed: ${errorMessage(refreshCause)} Refresh the server policy before editing or saving again.`,
        );
      }
    } finally {
      setSaving(false);
    }
  };

  const changed = persisted !== null
    && (draftEnabled !== persisted.allowPersonalProviderKeys
      || draftFundingPreference !== persisted.fundingPreference);

  return (
    <div
      className="mt-4 border-t border-border/60 pt-4"
      data-testid="server-provider-policy-card"
    >
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="max-w-2xl">
          <h3 className="text-sm font-semibold text-foreground">Personal provider keys</h3>
          <p className="mt-1 text-xs text-foreground-muted">
            Controls whether eligible members may use their own provider credentials.
            When enabled, eligible members can add personal keys in Settings and
            use supported private text chat and native text Tasks with their own Genie. Other paid work is being added in
            later stages.
          </p>
          {persisted !== null ? (
            <p className="mt-2 text-xs font-medium text-foreground" data-testid="server-provider-policy-persisted">
              {policyStateKnown ? "Current server policy" : "Last confirmed server policy"}: {persisted.allowPersonalProviderKeys ? "On" : "Off"}
            </p>
          ) : null}
          {!canManage && persisted !== null ? (
            <p className="mt-1 text-xs text-foreground-muted">
              Read-only — manage server settings permission is required to change this policy.
            </p>
          ) : null}
        </div>

        {loading && persisted === null ? (
          <span className="text-xs text-foreground-muted">Loading…</span>
        ) : persisted !== null ? (
          <div className="flex shrink-0 items-center gap-2">
            <button
              type="button"
              role="switch"
              aria-label="Allow personal provider keys"
              aria-checked={draftEnabled}
              disabled={!canManage || saving || !policyStateKnown}
              onClick={() => {
                setDraftEnabled((enabled) => !enabled);
                setSaveError(null);
                setSaveSuccess(null);
              }}
              className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary disabled:opacity-60 ${
                draftEnabled ? "bg-emerald-600" : "bg-foreground-muted/40"
              }`}
            >
              <span
                aria-hidden="true"
                className={`h-4 w-4 rounded-full bg-white shadow-sm transition-transform ${
                  draftEnabled ? "translate-x-6" : "translate-x-1"
                }`}
              />
            </button>
            <span className="min-w-6 text-xs font-semibold text-foreground">
              {draftEnabled ? "On" : "Off"}
            </span>
          </div>
        ) : null}
      </div>

      {persisted !== null && draftEnabled ? (
        <fieldset className="mt-4" disabled={!canManage || saving || !policyStateKnown}>
          <legend className="text-sm font-semibold text-foreground">Funding priority</legend>
          <p className="mt-1 text-xs text-foreground-muted">
            When both keys are available and allowed for a model, use this source first.
            Members can still choose models available through either permitted source.
          </p>
          <div className="mt-3 flex flex-wrap gap-3">
            {([
              ["personal_first", "Personal keys first"],
              ["server_first", "Server keys first"],
            ] as const).map(([value, label]) => (
              <label
                key={value}
                className="flex min-h-10 items-center gap-2 rounded-md border border-border px-3 py-2 text-sm text-foreground"
              >
                <input
                  type="radio"
                  name="server-provider-funding-preference"
                  value={value}
                  checked={draftFundingPreference === value}
                  onChange={() => {
                    setDraftFundingPreference(value);
                    setSaveError(null);
                    setSaveSuccess(null);
                  }}
                />
                {label}
              </label>
            ))}
          </div>
          <p
            className="mt-2 text-xs font-medium text-foreground"
            data-testid="server-provider-policy-funding-persisted"
          >
            {policyStateKnown ? "Current saved priority" : "Last confirmed priority"}: {persisted.fundingPreference === "personal_first"
              ? "Personal keys first"
              : "Server keys first"}
          </p>
        </fieldset>
      ) : null}

      {loadError ? (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <p className="text-sm text-error" role="alert">{loadError}</p>
          <button
            type="button"
            className="text-sm font-medium text-primary"
            onClick={() => void (policyStateKnown ? load() : recoverUnknownPolicy())}
          >
            Try again
          </button>
        </div>
      ) : null}

      {canManage && persisted !== null && policyStateKnown ? (
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <Button
            type="button"
            variant="primary"
            loading={saving}
            disabled={saving || !changed}
            onClick={() => void save()}
          >
            Save personal provider policy
          </Button>
          {changed ? (
            <span className="text-xs text-foreground-muted">Unsaved selection</span>
          ) : null}
        </div>
      ) : null}

      {saveError ? <p className="mt-3 text-sm text-error" role="alert">{saveError}</p> : null}
      {!policyStateKnown ? (
        <button
          type="button"
          className="mt-3 text-sm font-medium text-primary"
          disabled={loading || saving}
          onClick={() => void recoverUnknownPolicy()}
        >
          Refresh server policy
        </button>
      ) : null}
      {saveSuccess ? (
        <p className="mt-3 text-sm text-foreground-muted" role="status">{saveSuccess}</p>
      ) : null}
    </div>
  );
}
