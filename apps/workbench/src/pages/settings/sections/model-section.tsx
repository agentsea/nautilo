import { useEffect, useId, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import {
  type AssistantModelSummary,
  ApiError,
} from "@nautilo/api-client/browser";
import type { KeyReport } from "@nautilo/config-guard";
import { apiClient } from "../../../lib/api";
import { isSelectableModel, mergeModelRows } from "../../../lib/model-availability";
import { useCan } from "../../../hooks/use-can";
import { useProfile } from "../../../hooks/use-profile";
import {
  Button,
  FieldRow,
  GuestPlaceholder,
  SectionCard,
  StatusPill,
  TextInput,
} from "../ui";
import {
  filterModels,
  formatCostCoefficient,
  formatModelCapabilityBadges,
  formatProviderGroupLabel,
  groupModelsByProvider,
  providerFromModelId,
} from "./model-browser-helpers";

type SaveState = "idle" | "saving" | "saved" | { error: string };
type ChoiceMode = "default" | "catalog" | "unavailable";

// Mirrors `category: "llm" | "llm+embeddings"` entries in
// `packages/config-guard/src/key-registry.ts`. Kept hand-maintained because
// this module ships in Workbench's browser bundle; do not import config-guard
// runtime here (its `index.ts` transitively pulls `node:path` via
// `@nautilo/config`, which Vite externalizes and crashes the renderer on
// first evaluation). Keep in sync with `LLM_KEY_IDS` in
// `packages/api-client/src/client.ts`. Providers not in `key-registry.ts`
// (e.g. xai, together) won't surface a key hint here until they are added
// to the registry — that's the consolidation trade-off (D086 Phase 5.2).
const LLM_KEY_IDS = new Set<string>([
  "anthropic",
  "openai",
  "openrouter",
  "nautilo-gateway",
  "gateway",
  "google",
  "fireworks",
  "venice",
]);

function keyStatusPill(status: KeyReport["status"]) {
  switch (status) {
    case "verified":
      return <StatusPill tone="ok">Key verified</StatusPill>;
    case "present":
      return <StatusPill tone="info">Key set</StatusPill>;
    case "invalid_format":
      return <StatusPill tone="warn">Key format</StatusPill>;
    case "invalid_key":
      return <StatusPill tone="error">Key rejected</StatusPill>;
    case "unreachable":
      return <StatusPill tone="warn">Key check failed</StatusPill>;
    case "missing":
      return <StatusPill tone="muted">No key</StatusPill>;
    default: {
      const _exhaustive: never = status;
      return <StatusPill tone="muted">{String(_exhaustive)}</StatusPill>;
    }
  }
}

function modeForModelId(
  modelId: string | null,
  models: readonly AssistantModelSummary[] | null,
): ChoiceMode {
  if (!modelId) return "default";
  if (models?.some((m) => m.id === modelId && isSelectableModel(m))) return "catalog";
  return "unavailable";
}

export function ModelSection({ showProviderKeyStatus = true }: { showProviderKeyStatus?: boolean }) {
  const { response } = useProfile();
  const profile = response?.viewerRole === "owner" ? response.agent : null;
  const agentName = profile?.name.trim() || "your Agent";
  const sectionTitle = `Default model for ${agentName} (per-Agent)`;
  const can = useCan();
  const canReadServerModels = can("read_server_settings");
  // M129 — the agent's default model is PERSONAL, per-agent config (it
  // lives on the viewer's own profile, same as fallback), NOT a server
  // setting. Gate on owning this Agent (per-agent `viewerRole === "owner"`,
  // i.e. self-edit AR-5), so any verified user configures their own
  // model. Provider KEYS (keys-section) remain server config.
  const enabled = response?.viewerRole === "owner";
  const [models, setModels] = useState<AssistantModelSummary[] | null>(null);
  const [current, setCurrent] = useState<string | null>(null);
  const [draftMode, setDraftMode] = useState<ChoiceMode>("default");
  const [draftCatalogId, setDraftCatalogId] = useState<string>("");
  const [filter, setFilter] = useState("");
  const [loadError, setLoadError] = useState<string | null>(null);
  const [save, setSave] = useState<SaveState>("idle");
  const [keyReports, setKeyReports] = useState<KeyReport[] | null>(null);
  /** True after the user changes draft; false after a successful save — avoids clobbering edits when profile refetches. */
  const draftDirtyRef = useRef(false);
  const groupId = useId();

  useEffect(() => {
    if (!enabled) {
      draftDirtyRef.current = false;
    }
  }, [enabled]);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    void (async () => {
      setLoadError(null);
      try {
        const retainedIds = profile?.defaultModel ? [profile.defaultModel] : [];
        const [raw, retained] = await Promise.all([
          apiClient.getModels(),
          retainedIds.length > 0
            ? apiClient.resolveRetainedModels(retainedIds)
            : Promise.resolve([]),
        ]);
        if (cancelled) return;
        setModels(mergeModelRows(raw.filter(isSelectableModel), retained));
      } catch (e) {
        if (!cancelled) {
          setLoadError(e instanceof Error ? e.message : "Failed to load models");
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [enabled, profile?.defaultModel]);

  useEffect(() => {
    if (!enabled || !showProviderKeyStatus) {
      setKeyReports([]);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const { keys } = await apiClient.getKeySummary();
        if (!cancelled) setKeyReports(keys);
      } catch (e) {
        if (!cancelled) {
          if (e instanceof ApiError && e.status === 403) {
            setKeyReports([]);
          } else {
            setKeyReports([]);
          }
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [enabled, showProviderKeyStatus]);

  useEffect(() => {
    if (!enabled || !profile) return;
    const cur = profile.defaultModel ?? null;
    setCurrent(cur);
    if (!draftDirtyRef.current) {
      const nextMode = modeForModelId(cur, models);
      setDraftMode(nextMode);
      setDraftCatalogId(nextMode === "catalog" ? cur ?? "" : models?.[0]?.id ?? "");
    }
  }, [enabled, profile, models]);

  const selectableModels = useMemo(
    () => models?.filter(isSelectableModel) ?? [],
    [models],
  );
  const catalogDefaultId = selectableModels[0]?.id ?? null;

  const filteredModels = useMemo(
    () => filterModels(selectableModels, filter),
    [selectableModels, filter],
  );

  const providerGroups = useMemo(
    () => groupModelsByProvider(filteredModels),
    [filteredModels],
  );

  const currentModel = current
    ? models?.find((m) => m.id === current) ?? null
    : null;
  const effectiveModel = currentModel;
  const currentProvider = current
    ? providerFromModelId(current)
    : effectiveModel
      ? providerFromModelId(effectiveModel.id)
      : "unknown";
  const currentMode = modeForModelId(current, models);

  const staleCurrent =
    current !== null && currentModel && !isSelectableModel(currentModel)
      ? currentModel
      : null;

  const catalogValid =
    draftMode !== "catalog" ||
    (draftCatalogId.length > 0 && selectableModels.some((m) => m.id === draftCatalogId));
  const draftValid = draftMode !== "unavailable" && catalogValid;
  const draftValue =
    draftMode === "default"
      ? null
      : draftCatalogId;

  const selectedCatalogModel = selectableModels.find((m) => m.id === draftCatalogId) ?? null;

  const draftTargetId =
    draftMode === "default"
      ? ""
      : draftCatalogId;
  const draftTargetProvider =
    draftTargetId && draftTargetId.includes(":") ? providerFromModelId(draftTargetId) : null;
  const draftKeyReport =
    keyReports && draftTargetProvider && LLM_KEY_IDS.has(draftTargetProvider)
      ? keyReports.find((k) => k.id === draftTargetProvider)
      : undefined;
  const showKeyHint =
    showProviderKeyStatus &&
    draftTargetProvider !== null &&
    draftTargetProvider !== "unknown" &&
    LLM_KEY_IDS.has(draftTargetProvider);

  const canSave = draftValue !== current && draftValid;

  const handleSave = async () => {
    const next = draftValue;
    if (next === current) {
      setSave("saved");
      return;
    }
    if (!draftValid) return;
    setSave("saving");
    try {
      await apiClient.updateProfile({ defaultModel: next });
      setCurrent(next);
      draftDirtyRef.current = false;
      setSave("saved");
      window.dispatchEvent(new Event("nautilo:profile-changed"));
    } catch (e) {
      const message =
        e instanceof ApiError
          ? e.message
          : e instanceof Error
            ? e.message
            : "Save failed";
      setSave({ error: message });
    }
  };

  const markDirty = () => {
    draftDirtyRef.current = true;
    if (save !== "idle") setSave("idle");
  };

  const setMode = (mode: ChoiceMode) => {
    markDirty();
    setDraftMode(mode);
    if (mode === "catalog" && !draftCatalogId) {
      setDraftCatalogId(catalogDefaultId ?? "");
    }
  };

  const onPickCatalog = (value: string) => {
    markDirty();
    setDraftCatalogId(value);
  };

  if (!enabled) {
    return (
      <SectionCard
        id="model"
        title={sectionTitle}
        description="Choose the model this Agent uses unless a Room has its own override."
      >
        <GuestPlaceholder what="Default model selection" />
      </SectionCard>
    );
  }

  return (
    <SectionCard
      id="model"
      title={sectionTitle}
      description={`Only ${agentName}'s model preference. Used by ${agentName} in every Room unless that Room has its own override.`}
    >
      {loadError ? (
        <p className="text-sm text-[var(--error)]">{loadError}</p>
      ) : !models ? (
        <p className="text-sm text-foreground-muted">Loading…</p>
      ) : (
        <div className="space-y-4">
          <p className="rounded-md border border-border/60 bg-background-panel/50 px-3 py-2 text-xs text-foreground-muted">
            This setting changes only {agentName}&apos;s model preference; it
            never changes the server default or reasoning-output policy.
            {canReadServerModels ? (
              <>
                {" "}
                <Link to="/admin#models" className="font-medium text-foreground underline">
                  Manage server-wide model policy in Server Admin.
                </Link>
              </>
            ) : null}
          </p>
          {selectableModels.length === 0 ? (
            <p className="rounded-md border border-[var(--warning)]/40 bg-[var(--warning)]/10 px-3 py-2 text-xs text-foreground">
              No model is runnable. A server owner must add a provider credential,
              then return here.
            </p>
          ) : null}
          <div className="rounded-lg border border-border/70 bg-background-panel/70 p-3">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <p className="text-xs font-semibold uppercase tracking-wide text-foreground-muted">
                    Current default for {agentName}
                  </p>
                  <StatusPill tone={currentMode === "unavailable" ? "warn" : "info"}>
                    {currentMode === "default"
                      ? "Following server default"
                      : currentMode === "catalog"
                        ? "Pinned catalog model"
                        : "Unavailable"}
                  </StatusPill>
                  <StatusPill tone="muted">{formatProviderGroupLabel(currentProvider)}</StatusPill>
                </div>
                <p className="mt-2 text-sm font-medium text-foreground">
                  {effectiveModel?.displayName ?? (current ? current : "Resolved by server")}
                </p>
                <code className="mt-1 block truncate font-mono text-[11px] text-foreground-muted">
                  {current ?? "server chat-role policy"}
                </code>
              </div>
            </div>
            {showKeyHint && keyReports === null ? (
              <p className="mt-2 text-[11px] text-foreground-muted">Loading provider key status…</p>
            ) : null}
            {showKeyHint && keyReports !== null && draftKeyReport ? (
              <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-border/60 pt-3">
                <span className="text-[11px] text-foreground-muted">
                  API key for this choice ({formatProviderGroupLabel(draftKeyReport.id)}):
                </span>
                {keyStatusPill(draftKeyReport.status)}
              </div>
            ) : null}
            {showKeyHint && keyReports !== null && !draftKeyReport ? (
              <p className="mt-2 text-[11px] text-foreground-muted">
                Provider key status is unavailable from this browser session. Open Server admin →
                API Keys on the machine that runs the API (localhost).
              </p>
            ) : null}
          </div>

          <FieldRow
            label={`Default model for ${agentName}`}
            hint={`Choose the model ${agentName} uses when this Room has no Agent-specific override.`}
          >
            <div className="space-y-4">
              <div className="grid gap-2 sm:grid-cols-2" role="tablist" aria-label="Model selection mode">
                {[
                  {
                    id: "default" as const,
                    title: "Follow default",
                    body: "Use the server's resolved chat default.",
                  },
                  {
                    id: "catalog" as const,
                    title: "Catalog",
                    body: "Pick a configured model.",
                  },
                ].map((mode) => (
                  <button
                    key={mode.id}
                    type="button"
                    aria-pressed={draftMode === mode.id}
                    onClick={() => setMode(mode.id)}
                    className={[
                      "rounded-lg border p-3 text-left transition-colors",
                      draftMode === mode.id
                        ? "border-primary bg-primary/10"
                        : "border-border bg-background-panel/40 hover:bg-background-element/70",
                    ].join(" ")}
                  >
                    <span className="block text-sm font-medium text-foreground">{mode.title}</span>
                    <span className="mt-1 block text-xs text-foreground-muted">{mode.body}</span>
                  </button>
                ))}
              </div>

              {draftMode === "default" ? (
                <div className="rounded-md border border-border/60 bg-background-panel/50 px-3 py-2 text-sm">
                  <div className="font-medium text-foreground">Server default</div>
                  <div className="mt-1 text-xs text-foreground-muted">
                    Saves an empty profile default and lets the server choose the first runnable built-in chat candidate.
                  </div>
                </div>
              ) : null}

              {draftMode === "catalog" ? (
                <div className="space-y-3">
                  <label className="block text-xs font-medium text-foreground-muted">
                    Search catalog
                    <span className="mt-1 block">
                      <TextInput
                        id="settings-model-filter"
                        value={filter}
                        onChange={setFilter}
                        placeholder="Name, id, or provider…"
                        ariaLabel="Filter model catalog"
                      />
                    </span>
                  </label>

                  <div
                    className="max-h-80 overflow-y-auto rounded-lg border border-border bg-background-panel/50"
                    role="radiogroup"
                    aria-labelledby={`${groupId}-legend`}
                  >
                    <span id={`${groupId}-legend`} className="sr-only">
                      Catalog assistant models
                    </span>
                    {providerGroups.map(({ provider, items }) => (
                      <div key={provider}>
                        <div className="sticky top-0 z-[1] border-b border-border/80 bg-background-panel px-3 py-1.5 text-[11px] font-semibold uppercase tracking-wide text-foreground-muted">
                          {formatProviderGroupLabel(provider)}
                        </div>
                        {items.map((m) => {
                          const isSelected = draftCatalogId === m.id;
                          const veniceBadges =
                            provider === "venice" ? formatModelCapabilityBadges(m) : [];
                          return (
                            <label
                              key={m.id}
                              className={[
                                "flex cursor-pointer items-start gap-3 border-b border-border/40 px-3 py-3 transition-colors last:border-b-0",
                                isSelected
                                  ? "border-l-2 border-l-primary bg-primary/10"
                                  : "border-l-2 border-l-transparent hover:bg-background-element/80",
                              ].join(" ")}
                            >
                              <input
                                type="radio"
                                className="mt-1 shrink-0"
                                name={`${groupId}-default-model`}
                                checked={isSelected}
                                onChange={() => onPickCatalog(m.id)}
                              />
                              <span className="min-w-0 flex-1">
                                <span className="flex flex-wrap items-center gap-1.5">
                                  <span className="text-sm font-medium text-foreground">
                                    {m.displayName}
                                  </span>
                                  <StatusPill tone="muted">{formatProviderGroupLabel(provider)}</StatusPill>
                                </span>
                                <code className="mt-1 block truncate font-mono text-[11px] text-foreground-muted">
                                  {m.id}
                                </code>
                                <span className="mt-1 block text-[11px] text-foreground-dim">
                                  Priority {m.priority} · cost ×{formatCostCoefficient(m.costCoefficient)}
                                </span>
                                {veniceBadges.length > 0 ? (
                                  <span className="mt-1 block text-[10px] leading-snug text-foreground-dim">
                                    {veniceBadges.join(" · ")}
                                  </span>
                                ) : null}
                              </span>
                              {isSelected ? (
                                <span className="mt-0.5 text-primary" aria-hidden="true">
                                  ✓
                                </span>
                              ) : null}
                            </label>
                          );
                        })}
                      </div>
                    ))}
                  </div>

                  {filter.trim() && providerGroups.length === 0 ? (
                    <p className="text-xs text-foreground-muted">
                      No models match this filter.
                    </p>
                  ) : null}

                  {selectedCatalogModel ? (
                    <p className="text-xs text-foreground-muted">
                      Selected catalog model:{" "}
                      <span className="font-medium text-foreground">{selectedCatalogModel.displayName}</span>
                    </p>
                  ) : null}
                </div>
              ) : null}

              {staleCurrent ? (
                <p
                  className="rounded-md border border-[var(--warning)]/40 bg-[var(--warning)]/10 px-3 py-2 text-xs text-foreground"
                  role="status"
                >
                  Your profile currently references{" "}
                  <code className="rounded bg-background-element px-1 py-0.5 font-mono text-[11px]">
                    {staleCurrent.id}
                  </code>
                  , which is unavailable: {staleCurrent.unavailableReason ?? "it is not runnable now"}.
                  Reset to default or choose a runnable catalog model.
                </p>
              ) : null}

              <div className="flex flex-wrap items-center gap-2">
                <Button
                  variant="primary"
                  onClick={() => void handleSave()}
                  loading={save === "saving"}
                  disabled={!canSave}
                >
                  Save
                </Button>
                {save === "saved" ? (
                  <StatusPill tone="ok">Saved</StatusPill>
                ) : typeof save === "object" ? (
                  <StatusPill tone="error">{save.error}</StatusPill>
                ) : null}
              </div>
            </div>
          </FieldRow>
        </div>
      )}
    </SectionCard>
  );
}
