import { useEffect, useState } from "react";
import { ApiError } from "@nautilo/api-client/browser";
import { apiClient } from "../../../lib/api";
import { useAuth } from "../../../hooks/use-auth";
import { useCan } from "../../../hooks/use-can";
import {
  Button,
  GuestPlaceholder,
  PermissionPlaceholder,
  SectionCard,
} from "../ui";

type ResearchProvider = "auto" | "duckduckgo_html";
type ProviderState = {
  provider: ResearchProvider;
  tavilyConfigured?: boolean;
};

/** Server-wide web-research policy. Caller-scoped availability lives with Devices. */
export function WebResearchSection() {
  const auth = useAuth();
  const can = useCan();
  const canRead = can("read_server_settings") || can("manage_server_operations");
  const canManage = can("manage_server_operations");
  const enabled = auth.viewer.isVerified && canRead;
  const [current, setCurrent] = useState<ProviderState | null>(null);
  const [draft, setDraft] = useState<ResearchProvider>("auto");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    void apiClient.getResearchProvider().then((result) => {
      if (cancelled) return;
      setCurrent(result);
      setDraft(result.provider);
      setError(null);
    }).catch((cause: unknown) => {
      if (!cancelled) setError(cause instanceof Error ? cause.message : "Web research settings could not be loaded");
    });
    return () => { cancelled = true; };
  }, [enabled]);

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const result = await apiClient.updateResearchProvider(draft);
      setCurrent(result);
      setDraft(result.provider);
    } catch (cause) {
      setError(cause instanceof ApiError || cause instanceof Error ? cause.message : "Save failed");
    } finally {
      setSaving(false);
    }
  };

  const body = !auth.viewer.isVerified ? (
    <GuestPlaceholder what="Web research settings" />
  ) : !enabled ? (
    <PermissionPlaceholder what="web research settings" />
  ) : !current && !error ? (
    <p className="text-sm text-foreground-muted">Loading…</p>
  ) : (
    <div className="space-y-4">
      <fieldset className="space-y-2">
        <legend className="text-sm font-medium text-foreground">Search provider</legend>
        {([
          {
            value: "auto" as const,
            title: "Automatic (recommended)",
            detail: "Use Tavily when configured; otherwise fall back to DuckDuckGo in Nautilo Desktop.",
          },
          {
            value: "duckduckgo_html" as const,
            title: "DuckDuckGo only",
            detail: "Always use the temporary anonymous research Browser. No API key is required.",
          },
        ]).map((option) => (
          <label key={option.value} className="flex cursor-pointer gap-3 rounded-lg border border-border bg-background-panel/40 p-3 hover:bg-background-element/60">
            <input
              type="radio"
              name="web-research-provider"
              value={option.value}
              checked={draft === option.value}
              disabled={!canManage || saving}
              onChange={() => setDraft(option.value)}
              className="mt-1"
            />
            <span>
              <span className="block text-sm font-medium text-foreground">{option.title}</span>
              <span className="mt-0.5 block text-xs text-foreground-muted">{option.detail}</span>
            </span>
          </label>
        ))}
      </fieldset>

      <div className="space-y-2 rounded-lg border border-border/70 p-3 text-sm">
        <p>
          Tavily credential: <strong>{current?.tavilyConfigured === undefined
            ? "Managed by this deployment"
            : current.tavilyConfigured ? "Configured" : "Not configured"}</strong>
        </p>
        <p className="text-xs text-foreground-muted">
          Connected-Desktop reader and keyless-search availability is personal and appears under Settings → Devices → Work computers.
        </p>
      </div>

      {error ? <p className="text-xs text-[var(--error)]">{error}</p> : null}
      {canManage ? (
        <div className="flex justify-end">
          <Button onClick={() => { void save(); }} loading={saving} disabled={!current || draft === current.provider}>
            Save
          </Button>
        </div>
      ) : (
        <p className="text-xs text-foreground-muted">
          Read-only — <code>manage_server_operations</code> is required to change this server-wide policy.
        </p>
      )}
    </div>
  );

  return (
    <SectionCard
      id="web-research"
      title="Web research"
      description="Choose how all Genies on this server search and read the web. This changes provider mode only; provider credentials remain separate."
    >
      {body}
    </SectionCard>
  );
}
