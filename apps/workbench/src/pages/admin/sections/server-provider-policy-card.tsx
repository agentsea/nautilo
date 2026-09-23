import { useCallback, useEffect, useState } from "react";
import { apiClient } from "../../../lib/api";
import { useCan } from "../../../hooks/use-can";
import { Button } from "../../settings/ui";

type ServerProviderPolicy = Readonly<{ allowPersonalProviderKeys: boolean }>;

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
  const [loading, setLoading] = useState(canRead);
  const [saving, setSaving] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saveSuccess, setSaveSuccess] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!canRead) return;
    setLoading(true);
    setLoadError(null);
    try {
      const policy = await apiClient.admin.serverProviderPolicy.get();
      setPersisted(policy);
      setDraftEnabled(policy.allowPersonalProviderKeys);
    } catch (cause) {
      setLoadError(errorMessage(cause));
    } finally {
      setLoading(false);
    }
  }, [canRead]);

  useEffect(() => {
    void load();
  }, [load]);

  if (!canRead) return null;

  const save = async () => {
    if (!canManage || persisted === null) return;
    setSaving(true);
    setSaveError(null);
    setSaveSuccess(null);
    try {
      const policy = await apiClient.admin.serverProviderPolicy.set({
        allowPersonalProviderKeys: draftEnabled,
      });
      setPersisted(policy);
      setDraftEnabled(policy.allowPersonalProviderKeys);
      setSaveSuccess(
        policy.allowPersonalProviderKeys
          ? "Personal provider keys are allowed by server policy."
          : "Personal provider keys are disabled by server policy.",
      );
    } catch (cause) {
      setDraftEnabled(persisted.allowPersonalProviderKeys);
      setSaveError(errorMessage(cause));
    } finally {
      setSaving(false);
    }
  };

  const changed = persisted !== null
    && draftEnabled !== persisted.allowPersonalProviderKeys;

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
            Personal-key setup and chat are not available in this release.
          </p>
          {persisted !== null ? (
            <p className="mt-2 text-xs font-medium text-foreground" data-testid="server-provider-policy-persisted">
              Current server policy: {persisted.allowPersonalProviderKeys ? "On" : "Off"}
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
              disabled={!canManage || saving}
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

      {loadError ? (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <p className="text-sm text-error" role="alert">{loadError}</p>
          <button type="button" className="text-sm font-medium text-primary" onClick={() => void load()}>
            Try again
          </button>
        </div>
      ) : null}

      {canManage && persisted !== null ? (
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
      {saveSuccess ? (
        <p className="mt-3 text-sm text-foreground-muted" role="status">{saveSuccess}</p>
      ) : null}
    </div>
  );
}
