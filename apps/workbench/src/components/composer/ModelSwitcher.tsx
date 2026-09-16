import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { ChevronDown, Check, Eye, Brain } from "lucide-react";
import { type AssistantModelSummary } from "@nautilo/api-client/browser";
import { apiClient } from "../../lib/api";
import { isSelectableModel, mergeModelRows } from "../../lib/model-availability";
import { useProfile } from "../../hooks/use-profile";
import {
  ModelControlRows,
  ReasoningOptions,
  ServingOptions,
  defaultRoomModelControlSelection,
  hasReasoningPicker,
  hasServingPicker,
  normalizeRoomModelControlSelection,
  type RoomReasoningEffort,
  type RoomModelControlSelection,
} from "../model-controls/model-control-picker";
import {
  filterModels,
  formatProviderGroupLabel,
  groupModelsByProvider,
  providerFromModelId,
} from "../../pages/settings/sections/model-browser-helpers";

type PickerPanel = "model" | "reasoning" | "serving";

/**
 * Browser API contract supplied by D462's Room+Agent route. Kept narrow here
 * so the composer cannot accidentally reach profile/default-model methods.
 */
/**
 * D462 — fast, Room-local model controls in the composer's left cluster.
 *
 * Settings remains the owner of Agent defaults. This picker saves the complete
 * safe selection tuple for the current Room and lets the server translate it
 * against the catalog; provider selectors never enter the browser.
 */
export function ModelSwitcher({
  roomId,
  agentId,
  compact = false,
}: {
  roomId: string | null;
  /** Exact active Agent in this Room; null means the Room target is ambiguous. */
  agentId: string | null;
  /** Shorten the trigger label when the composer is in the reader rail. */
  compact?: boolean;
}) {
  const { response } = useProfile();
  const profile = response?.viewerRole === "owner" ? response.agent : null;
  const isOwner = response?.viewerRole === "owner";
  const navigate = useNavigate();

  const [models, setModels] = useState<AssistantModelSummary[] | null>(null);
  const [roomSelection, setRoomSelection] = useState<RoomModelControlSelection | null>(null);
  const [selectionLoaded, setSelectionLoaded] = useState(false);
  const [open, setOpen] = useState(false);
  const [panel, setPanel] = useState<PickerPanel>("model");
  const [query, setQuery] = useState("");
  const [saveState, setSaveState] = useState<"idle" | "saving" | { error: string }>("idle");

  useEffect(() => {
    if (!isOwner) return;
    let cancelled = false;
    void (async () => {
      try {
        const raw = await apiClient.getModels();
        if (cancelled) return;
        setModels(
          raw.filter(isSelectableModel).sort(
            (a, b) => a.priority - b.priority || a.id.localeCompare(b.id),
          ),
        );
      } catch {
        if (!cancelled) setModels([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [isOwner]);

  useEffect(() => {
    if (!isOwner || !roomId || !agentId) {
      setRoomSelection(null);
      setSelectionLoaded(true);
      return;
    }
    let cancelled = false;
    setSelectionLoaded(false);
    void (async () => {
      try {
        const selection = await apiClient.getRoomModelControlSelection(roomId, agentId);
        if (!cancelled) setRoomSelection(selection);
      } catch {
        // The model picker remains usable with the Agent default; a later write
        // will surface its own actionable error to the owner.
        if (!cancelled) setRoomSelection(null);
      } finally {
        if (!cancelled) setSelectionLoaded(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [agentId, isOwner, roomId]);

  const defaultModelId = profile?.defaultModel ?? null;
  // A null Agent default means the server resolves the shared chat-role
  // policy. The browser must not guess that result from catalog priority.
  const agentDefaultId = defaultModelId;
  const effectiveId = roomSelection?.modelId ?? agentDefaultId;
  const currentModel = useMemo(
    () => (effectiveId ? models?.find((model) => model.id === effectiveId) ?? null : null),
    [models, effectiveId],
  );
  useEffect(() => {
    const retainedIds = [roomSelection?.modelId, defaultModelId].filter(
      (id): id is string => !!id,
    );
    if (!isOwner || retainedIds.length === 0) return;
    let cancelled = false;
    void apiClient.resolveRetainedModels(retainedIds).then((retained) => {
      if (!cancelled) setModels((current) => mergeModelRows(current ?? [], retained));
    }).catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [defaultModelId, isOwner, roomSelection?.modelId]);
  const effectiveSelection = useMemo(
    () =>
      currentModel && isSelectableModel(currentModel)
        ? normalizeRoomModelControlSelection(currentModel, roomSelection)
        : null,
    [currentModel, roomSelection],
  );
  const providerGroups = useMemo(
    () => groupModelsByProvider(filterModels((models ?? []).filter(isSelectableModel), query)),
    [models, query],
  );
  const fallbackConfigured = profile?.fallback?.enabled === true && (profile.fallback.chain?.length ?? 0) > 0;

  // A catalog refresh or a Room selection for a now-removed model must never
  // leave a stale effort/profile in the menu. Rebuild it from the current row.
  useEffect(() => {
    if (!currentModel || !isSelectableModel(currentModel) || !roomSelection) return;
    const normalized = normalizeRoomModelControlSelection(currentModel, roomSelection);
    if (JSON.stringify(normalized) !== JSON.stringify(roomSelection)) setRoomSelection(normalized);
  }, [currentModel, roomSelection]);

  if (!isOwner) return null;

  const fullLabel =
    currentModel?.displayName ?? (effectiveId ? effectiveId.split(":").pop() ?? effectiveId : "Server default");
  const triggerLabel = compact ? fullLabel.replace(/\s*\([^)]*\)\s*$/, "") : fullLabel;

  const closePicker = (): void => {
    setQuery("");
    setPanel("model");
    setOpen(false);
  };

  const save = async (next: RoomModelControlSelection | null, close = false): Promise<void> => {
    if (!roomId || !agentId || !selectionLoaded || saveState === "saving") return;
    setSaveState("saving");
    try {
      const saved = await apiClient.updateRoomModelControlSelection(roomId, agentId, next);
      setRoomSelection(saved);
      setSaveState("idle");
      if (close) closePicker();
    } catch (error) {
      setSaveState({
        error: error instanceof Error ? error.message : "Unable to save this Room's model controls.",
      });
    }
  };

  const pickModel = async (model: AssistantModelSummary): Promise<void> => {
    // Model-only rows stay a complete one-field Room override. The agent's
    // profile default is intentionally never edited from this composer.
    await save(defaultRoomModelControlSelection(model), true);
  };

  const pickEffort = async (effort: RoomReasoningEffort): Promise<void> => {
    if (!currentModel || !effectiveSelection) return;
    await save({ ...effectiveSelection, reasoningEffort: effort });
  };

  const pickServing = async (servingProfileId: string): Promise<void> => {
    if (!currentModel || !effectiveSelection) return;
    await save({ ...effectiveSelection, servingProfileId });
  };

  return (
    <div className="relative">
      <button
        type="button"
        data-testid="composer-model-switcher"
        onClick={() => {
          if (open) closePicker();
          else {
            setQuery("");
            setPanel("model");
            setOpen(true);
          }
        }}
        aria-haspopup="dialog"
        aria-expanded={open}
        title={compact ? `${fullLabel} — Room model` : "Room model"}
        className="flex items-center gap-1 rounded-md border border-border bg-background px-2 py-1 text-xs text-foreground-muted transition-colors hover:bg-background-element hover:text-foreground"
      >
        <span className={`${compact ? "max-w-[6.5rem]" : "max-w-[10rem]"} truncate font-medium text-foreground`}>
          {triggerLabel}
        </span>
        {currentModel?.capabilities?.reasoning ? (
          <Brain aria-label="thinking" className="h-3 w-3 shrink-0 text-foreground-muted" />
        ) : null}
        {currentModel?.capabilities?.vision ? (
          <Eye aria-label="vision" className="h-3 w-3 shrink-0 text-foreground-muted" />
        ) : null}
        <ChevronDown aria-hidden className="h-3 w-3 shrink-0" />
      </button>

      {open ? (
        <>
          <button
            type="button"
            aria-hidden
            tabIndex={-1}
            className="fixed inset-0 z-40 cursor-default"
            onClick={closePicker}
          />
          <div
            role="dialog"
            aria-label="Room model controls"
            className="absolute bottom-full left-0 z-50 mb-2 flex max-h-80 w-72 flex-col overflow-hidden rounded-lg border border-border bg-background shadow-lg"
          >
            <ModelControlRows
              currentPanel={panel}
              model={currentModel}
              selection={effectiveSelection}
              onPanelChange={setPanel}
            />

            {panel === "model" ? (
              <ModelOptions
                models={models}
                providerGroups={providerGroups}
                query={query}
                effectiveId={effectiveId}
                saving={saveState === "saving" || !roomId || !agentId || !selectionLoaded}
                onQueryChange={setQuery}
                onPick={pickModel}
              />
            ) : panel === "reasoning" && currentModel && effectiveSelection && hasReasoningPicker(currentModel.controls) ? (
              <ReasoningOptions
                model={currentModel}
                selection={effectiveSelection}
                disabled={saveState === "saving" || !roomId || !agentId}
                onSelect={(effort) => void pickEffort(effort)}
              />
            ) : panel === "serving" && currentModel && effectiveSelection && hasServingPicker(currentModel.controls) ? (
              <ServingOptions
                model={currentModel}
                selection={effectiveSelection}
                disabled={saveState === "saving" || !roomId || !agentId}
                onSelect={(profileId) => void pickServing(profileId)}
              />
            ) : (
              <div className="px-3 py-2 text-xs text-foreground-muted">This control is not available.</div>
            )}

            <div className="border-t border-border/60 px-3 py-2">
              {currentModel && !isSelectableModel(currentModel) ? (
                <div role="status" className="mb-1 text-[11px] text-[var(--warning)]">
                  {currentModel.displayName} is unavailable: {currentModel.unavailableReason ?? "not runnable now"}.
                  Choose another model or reset the Room override.
                </div>
              ) : null}
              {saveState === "saving" ? (
                <div className="text-[11px] text-foreground-muted">Saving Room model controls…</div>
              ) : null}
              {!selectionLoaded ? <div className="text-[11px] text-foreground-muted">Loading Room controls…</div> : null}
              {!roomId ? <div role="alert" className="text-[11px] text-destructive">Open a Room to save model controls.</div> : null}
              {roomId && !agentId ? (
                <div role="status" className="text-[11px] text-foreground-muted">
                  Focus one of your Agents to set Room model controls.
                </div>
              ) : null}
              {typeof saveState === "object" ? (
                <div role="alert" className="text-[11px] text-destructive">
                  Could not save Room model controls: {saveState.error}
                </div>
              ) : null}
              {roomSelection ? (
                <button
                  type="button"
                  disabled={saveState === "saving" || !roomId || !agentId}
                  onClick={() => void save(null, true)}
                  className="mt-1 block text-left text-[11px] text-foreground-muted hover:text-foreground disabled:cursor-wait"
                >
                  Reset to Agent default
                </button>
              ) : null}
              {!fallbackConfigured ? (
                <button
                  type="button"
                  onClick={() => {
                    closePicker();
                    void navigate("/settings#fallback");
                  }}
                  className="mt-1 block w-full text-left text-[11px] text-foreground-muted hover:text-foreground"
                >
                  Fallback is off — set up a fallback chain →
                </button>
              ) : null}
            </div>
          </div>
        </>
      ) : null}
    </div>
  );
}

function ModelOptions({
  models,
  providerGroups,
  query,
  effectiveId,
  saving,
  onQueryChange,
  onPick,
}: {
  models: AssistantModelSummary[] | null;
  providerGroups: ReturnType<typeof groupModelsByProvider>;
  query: string;
  effectiveId: string | null;
  saving: boolean;
  onQueryChange: (query: string) => void;
  onPick: (model: AssistantModelSummary) => Promise<void>;
}) {
  return (
    <>
      <div className="border-b border-border/60 p-2">
        <label htmlFor="composer-model-search" className="sr-only">Search models</label>
        <input
          id="composer-model-search"
          type="search"
          autoFocus
          value={query}
          onChange={(event) => onQueryChange(event.target.value)}
          placeholder="Search models"
          className="w-full rounded-md border border-border bg-background px-2 py-1.5 text-xs text-foreground outline-none placeholder:text-foreground-muted focus:border-primary"
        />
      </div>
      <div role="listbox" aria-label="Models" className="min-h-0 flex-1 overflow-y-auto">
        {!models ? (
          <div className="px-3 py-2 text-xs text-foreground-muted">Loading…</div>
        ) : models.length === 0 ? (
          <div className="px-3 py-2 text-xs text-foreground-muted">No models available.</div>
        ) : providerGroups.length === 0 ? (
          <div role="status" className="px-3 py-2 text-xs text-foreground-muted">No models match this search.</div>
        ) : (
          providerGroups.map((group) => (
            <div key={group.provider} role="group" aria-label={formatProviderGroupLabel(group.provider)}>
              <div className="sticky top-0 z-10 border-y border-border/60 bg-background px-3 py-1 text-[10px] font-medium uppercase tracking-wide text-foreground-muted">
                {formatProviderGroupLabel(group.provider)}
              </div>
              {group.items.map((model) => {
                const selected = model.id === effectiveId;
                return (
                  <button
                    key={model.id}
                    type="button"
                    role="option"
                    aria-selected={selected}
                    disabled={saving}
                    onClick={() => void onPick(model)}
                    className={[
                      "flex w-full items-start gap-2 px-3 py-2 text-left text-sm transition-colors disabled:cursor-wait disabled:opacity-50",
                      selected ? "bg-[var(--primary-muted)]" : "hover:bg-background-element",
                    ].join(" ")}
                  >
                    <span className="mt-0.5 w-3.5 shrink-0">
                      {selected ? <Check aria-hidden className="h-3.5 w-3.5 text-primary" /> : null}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="flex flex-wrap items-center gap-1.5">
                        <span className="font-medium text-foreground">{model.displayName}</span>
                        {model.capabilities?.reasoning ? <span className="rounded bg-background-element px-1 text-[10px] text-foreground-muted">thinking</span> : null}
                        {model.capabilities?.vision ? <span className="rounded bg-background-element px-1 text-[10px] text-foreground-muted">vision</span> : null}
                      </span>
                      <span className="mt-0.5 block truncate text-[11px] text-foreground-muted">
                        {formatProviderGroupLabel(providerFromModelId(model.id))}
                      </span>
                    </span>
                  </button>
                );
              })}
            </div>
          ))
        )}
      </div>
    </>
  );
}
