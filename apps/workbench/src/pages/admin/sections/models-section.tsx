import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ApiError,
  type AssistantModelSummary,
  type ServerModelConfig,
} from "@nautilo/api-client/browser";
import { apiClient } from "../../../lib/api";
import { isSelectableModel, mergeModelRows } from "../../../lib/model-availability";
import { useCan } from "../../../hooks/use-can";
import { Button } from "../../settings/ui";
import { modelHasReasoningCapability } from "../../settings/sections/model-browser-helpers";
import { ModelCatalogTable } from "./model-catalog-table";

/**
 * Server-wide model config. Reads/writes
 * `/api/admin/server-models`. View requires `read_server_settings`; saving
 * requires `manage_server_operations`. Changes take effect live (DB-backed; no
 * restart).
 */

// Match the automatic auxiliary-role preference on each supported route.
const RECOMMENDED_CONDUCTOR_IDS = new Set<string>([
  "openrouter:minimax/minimax-m3",
  "venice:minimax-m3-preview",
  "openai:gpt-5.6-luna",
]);

const SERVER_EMBEDDING_CONFIGURATION = "__server_configuration__";
const SERVER_MEDIA_CONFIGURATION = "__server_media_configuration__";
const SUPPORTED_EMBEDDING_MODEL_IDS = new Set([
  "venice:text-embedding-qwen3-8b",
  "openrouter:qwen/qwen3-embedding-8b",
  "venice:text-embedding-3-small",
  "openrouter:openai/text-embedding-3-small",
  "openai:text-embedding-3-small",
]);

type SaveState = "idle" | "saving" | "saved" | { error: string };

type MediaGenerationModel = ServerModelConfig["imageModels"][number];

function mergeProviderAvailability(
  current: ServerModelConfig,
  refreshed: ServerModelConfig,
): ServerModelConfig {
  return {
    ...current,
    catalogModels: refreshed.catalogModels,
    effectiveEmbeddingModel: refreshed.effectiveEmbeddingModel,
    embeddingSelectionPending: refreshed.embeddingSelectionPending,
    embeddingModels: refreshed.embeddingModels,
    effectiveImageModel: refreshed.effectiveImageModel,
    effectiveMusicModel: refreshed.effectiveMusicModel,
    effectiveVideoModel: refreshed.effectiveVideoModel,
    imageModels: refreshed.imageModels,
    musicModels: refreshed.musicModels,
    videoModels: refreshed.videoModels,
  };
}

function retainedDraftModelIds(config: ServerModelConfig | null): {
  chat: string[];
  utility: string[];
} {
  if (!config) return { chat: [], utility: [] };
  return {
    chat: [
      config.defaultChatModel,
      config.memoryReviewModel ?? "",
      ...config.fallbackChain,
    ].filter(Boolean),
    utility: [
      config.conductorModel,
      config.stenographerModel,
      config.reflectionModel,
    ].filter(Boolean),
  };
}

function retainedDraftSignature(config: ServerModelConfig | null): string {
  const ids = retainedDraftModelIds(config);
  return JSON.stringify([ids.chat, ids.utility]);
}

function MediaGenerationModelSelect(props: {
  kind: "image" | "music" | "video";
  selection: string | null;
  effective: string | null;
  models: MediaGenerationModel[];
  canManage: boolean;
  onChange(value: string | null): void;
}) {
  const selectedModel = props.selection
    ? props.models.find((model) => model.id === props.selection)
    : undefined;
  const effectiveModel = props.effective
    ? props.models.find((model) => model.id === props.effective)
    : undefined;
  const explicitUnavailable = props.selection !== null && props.selection !== "" &&
    (!selectedModel || !selectedModel.available);
  const label = `${props.kind.charAt(0).toUpperCase()}${props.kind.slice(1)} model`;
  const automatic = props.kind === "image"
    ? "Automatic — Venice → OpenRouter → OpenAI → Google"
    : "Automatic — first available supported model";
  return (
    <div className="space-y-1.5">
      <label htmlFor={`server-${props.kind}-model`} className="block text-xs font-semibold text-foreground">
        {label}
      </label>
      <select
        id={`server-${props.kind}-model`}
        data-testid={`server-${props.kind}-model`}
        className="w-full rounded-md border border-border bg-background-element px-2 py-1.5 text-sm"
        value={props.selection === null ? SERVER_MEDIA_CONFIGURATION : props.selection}
        disabled={!props.canManage}
        onChange={(event) => props.onChange(
          event.target.value === SERVER_MEDIA_CONFIGURATION ? null : event.target.value,
        )}
      >
        <option value={SERVER_MEDIA_CONFIGURATION}>Server configuration</option>
        <option value="">{automatic}</option>
        {props.selection !== null && props.selection !== "" && !selectedModel ? (
          <option value={props.selection} disabled>{props.selection} (Unavailable)</option>
        ) : null}
        {props.models.map((model) => (
          <option key={model.id} value={model.id} disabled={!model.available}>
            {model.displayName}{model.available ? "" : " (Unavailable)"}
          </option>
        ))}
      </select>
      <p className="text-[11px] text-foreground-muted" data-testid={`effective-${props.kind}-model`}>
        Current effective model: {effectiveModel?.displayName ?? props.effective ?? "Unavailable"}
      </p>
      {explicitUnavailable ? (
        <p className="text-[11px] text-[var(--warning)]">
          {selectedModel?.unavailableReason ?? "This saved model is not present in the current supported catalogue."}
        </p>
      ) : null}
    </div>
  );
}

function modelLabel(models: AssistantModelSummary[], id: string): string {
  return models.find((m) => m.id === id)?.displayName ?? id;
}

export function ModelsSection() {
  const can = useCan();
  const canRead = can("read_server_settings");
  const canManage = can("manage_server_operations");

  const [models, setModels] = useState<AssistantModelSummary[]>([]);
  const [utilityModels, setUtilityModels] = useState<AssistantModelSummary[]>([]);
  const [config, setConfig] = useState<ServerModelConfig | null>(null);
  const [draft, setDraft] = useState<ServerModelConfig | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [save, setSave] = useState<SaveState>("idle");
  const [reasoningScope, setReasoningScope] = useState<"all" | "specific">("all");
  const [reasoningModelId, setReasoningModelId] = useState("");
  const loadGenerationRef = useRef(0);
  const initializedRef = useRef(false);
  const pendingProviderRefreshRef = useRef(false);
  const draftRef = useRef<ServerModelConfig | null>(null);
  const loadRef = useRef<(preserveDraft?: boolean) => Promise<void>>(async () => {});

  useEffect(() => {
    draftRef.current = draft;
  }, [draft]);

  const load = useCallback(async (preserveDraft = false) => {
    const generation = ++loadGenerationRef.current;
    if (!preserveDraft) {
      setLoading(true);
      setLoadError(null);
    }
    try {
      const [rawModels, rawUtilityModels, cfg] = await Promise.all([
        apiClient.getModels(),
        apiClient.getModels({ purpose: "chat" }),
        apiClient.admin.serverModels.get(),
      ]);
      if (loadGenerationRef.current !== generation) return;
      const currentDraft = preserveDraft ? draftRef.current : null;
      const currentDraftIds = retainedDraftModelIds(currentDraft);
      const currentDraftSignature = retainedDraftSignature(currentDraft);
      const retainedChatIds = [...new Set([
        cfg.defaultChatModel,
        cfg.memoryReviewModel ?? "",
        ...cfg.fallbackChain,
        ...currentDraftIds.chat,
      ].filter(Boolean))];
      const retainedUtilityIds = [...new Set([
        cfg.conductorModel,
        cfg.stenographerModel,
        cfg.reflectionModel,
        ...currentDraftIds.utility,
      ].filter(Boolean))];
      const [retainedChat, retainedUtility] = await Promise.all([
        retainedChatIds.length > 0
          ? apiClient.resolveRetainedModels(retainedChatIds, { purpose: "chat-tools" })
          : Promise.resolve([]),
        retainedUtilityIds.length > 0
          ? apiClient.resolveRetainedModels(retainedUtilityIds, { purpose: "chat" })
          : Promise.resolve([]),
      ]);
      if (loadGenerationRef.current !== generation) return;
      if (preserveDraft && retainedDraftSignature(draftRef.current) !== currentDraftSignature) {
        void loadRef.current(true);
        return;
      }
      setModels(mergeModelRows(rawModels.filter(isSelectableModel), retainedChat));
      setUtilityModels(
        mergeModelRows(rawUtilityModels.filter(isSelectableModel), retainedUtility),
      );
      if (preserveDraft) {
        setConfig((current) => current ? mergeProviderAvailability(current, cfg) : cfg);
        setDraft((current) => current ? mergeProviderAvailability(current, cfg) : cfg);
      } else {
        setConfig(cfg);
        setDraft(cfg);
        const existingOverride = Object.keys(cfg.reasoningPolicy.overrides)[0];
        setReasoningScope(existingOverride ? "specific" : "all");
        setReasoningModelId(existingOverride ?? "");
        initializedRef.current = true;
        if (pendingProviderRefreshRef.current) {
          pendingProviderRefreshRef.current = false;
          queueMicrotask(() => {
            if (initializedRef.current) void loadRef.current(true);
          });
        }
      }
    } catch (e) {
      if (loadGenerationRef.current !== generation || preserveDraft) return;
      const message =
        e instanceof ApiError && e.status === 403
          ? "You don't have permission to view server model settings."
          : e instanceof Error
            ? e.message
            : "Could not load server model config.";
      setLoadError(message);
    } finally {
      if (loadGenerationRef.current === generation) setLoading(false);
    }
  }, []);
  loadRef.current = load;

  useEffect(() => {
    if (!canRead) {
      initializedRef.current = false;
      setLoading(false);
      return;
    }
    initializedRef.current = false;
    void load();
    return () => {
      initializedRef.current = false;
      pendingProviderRefreshRef.current = false;
      loadGenerationRef.current += 1;
    };
  }, [canRead, load]);

  useEffect(() => {
    if (!canRead) return;
    const onProviderKeysSaved = () => {
      if (!initializedRef.current) {
        pendingProviderRefreshRef.current = true;
        return;
      }
      void load(true);
    };
    window.addEventListener("nautilo:provider-keys-saved", onProviderKeysSaved);
    return () => {
      window.removeEventListener("nautilo:provider-keys-saved", onProviderKeysSaved);
    };
  }, [canRead, load]);

  const selectableModels = useMemo(() => models.filter(isSelectableModel), [models]);
  const selectableUtilityModels = useMemo(
    () => utilityModels.filter(isSelectableModel),
    [utilityModels],
  );

  const conductorOptions = useMemo(() => {
    const recommended = selectableUtilityModels.filter((m) => RECOMMENDED_CONDUCTOR_IDS.has(m.id));
    const rest = selectableUtilityModels.filter((m) => !RECOMMENDED_CONDUCTOR_IDS.has(m.id));
    return { recommended, rest };
  }, [selectableUtilityModels]);

  const reasoningModels = useMemo(
    () => selectableUtilityModels.filter(modelHasReasoningCapability),
    [selectableUtilityModels],
  );
  const supportedEmbeddingModels = useMemo(
    () => draft?.embeddingModels.filter((model) => SUPPORTED_EMBEDDING_MODEL_IDS.has(model.id)) ?? [],
    [draft?.embeddingModels],
  );
  const reasoningTarget = reasoningScope === "all" ? "all" : reasoningModelId;
  const selectedReasoningModel = reasoningScope === "all"
    ? null
    : reasoningModels.find((model) => model.id === reasoningTarget) ?? reasoningModels[0] ?? null;
  const selectedReasoningEffort = draft?.reasoningPolicy
    ? reasoningScope === "all"
      ? draft.reasoningPolicy.defaultEffort
      : draft.reasoningPolicy.overrides[selectedReasoningModel?.id ?? ""] ?? null
    : null;
  const reasoningLevels = reasoningScope === "all"
    ? (["minimal", "low", "medium", "high", "xhigh", "max"] as const).filter((level) =>
        reasoningModels.every((model) => model.controls?.reasoning?.levels?.includes(level) ?? true),
      )
    : selectedReasoningModel?.controls?.reasoning?.levels ?? [
        "minimal", "low", "medium", "high", "xhigh", "max",
      ];

  const fallbackAddable = useMemo(
    () => (draft ? selectableModels.filter((m) => !draft.fallbackChain.includes(m.id)) : []),
    [draft, selectableModels],
  );
  const modelsForPurpose = (purpose: "chat-tools" | "chat") =>
    purpose === "chat-tools" ? models : utilityModels;
  const unavailableRow = (id: string, purpose: "chat-tools" | "chat" = "chat-tools") => {
    const row = modelsForPurpose(purpose).find((model) => model.id === id);
    return row && !isSelectableModel(row) ? row : null;
  };
  const unavailableReason = (id: string, purpose: "chat-tools" | "chat" = "chat-tools") =>
    unavailableRow(id, purpose)?.unavailableReason ?? "This model is not runnable now.";

  const dirty =
    config !== null &&
    draft !== null &&
    (config.defaultChatModel !== draft.defaultChatModel ||
      config.conductorModel !== draft.conductorModel ||
      config.stenographerModel !== draft.stenographerModel ||
      config.reflectionModel !== draft.reflectionModel ||
      config.memoryReviewModel !== draft.memoryReviewModel ||
      config.embeddingModel !== draft.embeddingModel ||
      config.imageModel !== draft.imageModel ||
      config.musicModel !== draft.musicModel ||
      config.videoModel !== draft.videoModel ||
      config.fallbackChain.join(",") !== draft.fallbackChain.join(",") ||
      JSON.stringify(config.reasoningPolicy) !== JSON.stringify(draft.reasoningPolicy));

  const patch = (next: Partial<ServerModelConfig>) => {
    setDraft((prev) => (prev ? { ...prev, ...next } : prev));
    if (save !== "idle") setSave("idle");
  };

  const setReasoningPolicy = (target: string, effort: ServerModelConfig["reasoningPolicy"]["defaultEffort"]) => {
    if (!draft) return;
    const current = draft.reasoningPolicy;
    const overrides = { ...current.overrides };
    if (target === "all") {
      patch({ reasoningPolicy: { defaultEffort: effort, overrides } });
      return;
    }
    if (effort === null) delete overrides[target];
    else overrides[target] = effort;
    patch({ reasoningPolicy: { defaultEffort: current.defaultEffort, overrides } });
  };

  const moveFallback = (index: number, dir: -1 | 1) => {
    if (!draft) return;
    const chain = [...draft.fallbackChain];
    const target = index + dir;
    if (target < 0 || target >= chain.length) return;
    [chain[index], chain[target]] = [chain[target], chain[index]];
    patch({ fallbackChain: chain });
  };

  const removeFallback = (id: string) => {
    if (!draft) return;
    patch({ fallbackChain: draft.fallbackChain.filter((m) => m !== id) });
  };

  const addFallback = (id: string) => {
    if (!draft || id === "" || draft.fallbackChain.includes(id)) return;
    patch({ fallbackChain: [...draft.fallbackChain, id] });
  };

  const handleSave = async () => {
    if (!draft || !dirty) return;
    setSave("saving");
    try {
      const saved = await apiClient.admin.serverModels.set({
        defaultChatModel: draft.defaultChatModel,
        conductorModel: draft.conductorModel,
        stenographerModel: draft.stenographerModel,
        reflectionModel: draft.reflectionModel,
        memoryReviewModel: draft.memoryReviewModel,
        embeddingModel: draft.embeddingModel,
        ...(draft.imageModel === config?.imageModel ? {} : { imageModel: draft.imageModel }),
        ...(draft.musicModel === config?.musicModel ? {} : { musicModel: draft.musicModel }),
        ...(draft.videoModel === config?.videoModel ? {} : { videoModel: draft.videoModel }),
        fallbackChain: draft.fallbackChain,
        reasoningPolicy: draft.reasoningPolicy,
      });
      setConfig(saved);
      setDraft(saved);
      setSave("saved");
    } catch (e) {
      const message = e instanceof Error ? e.message : "Save failed";
      setSave({ error: message });
    }
  };

  return (
    <section
      id="models"
      data-testid="admin-models-section"
      className="rounded-lg border border-border bg-background-panel"
      aria-labelledby="models-title"
    >
      <header className="border-b border-border px-5 py-3">
        <h2 id="models-title" className="text-sm font-semibold">
          Models
        </h2>
        <p className="mt-1 text-xs text-foreground-muted">
          Server-wide model defaults, fallback policy, and reasoning-output
          defaults. These apply when an Agent follows the server policy; they do
          not change an Agent&apos;s own pinned model or fallback chain. Changes take
          effect immediately — no restart.
        </p>
      </header>

      <div className="px-5 py-4">
        {!canRead ? (
          <p className="text-sm text-foreground-muted">
            You don&apos;t have permission to view server model settings.
          </p>
        ) : loading ? (
          <p className="text-sm text-foreground-muted">Loading…</p>
        ) : loadError ? (
          <p className="text-sm text-[var(--error)]">{loadError}</p>
        ) : draft ? (
          <div className="space-y-6">
            <ModelCatalogTable models={config?.catalogModels} />
            {!canManage ? (
              <p className="rounded-md border border-border/60 bg-background-element/50 px-3 py-2 text-xs text-foreground-muted">
                Read-only — you need <code>manage_server_operations</code> to change
                these values.
              </p>
            ) : null}

            {/* Default chat model */}
            <div className="space-y-1.5">
              <label
                htmlFor="server-default-model"
                className="block text-xs font-semibold text-foreground"
              >
                Default chat model
              </label>
              <p className="text-[11px] text-foreground-muted">
                Used when an Agent has no per-Agent model pinned.
              </p>
              <select
                id="server-default-model"
                className="w-full rounded-md border border-border bg-background-element px-2 py-1.5 text-sm"
                value={draft.defaultChatModel}
                disabled={!canManage}
                onChange={(e) => patch({ defaultChatModel: e.target.value })}
              >
                {unavailableRow(draft.defaultChatModel) ? (
                  <option value={draft.defaultChatModel} disabled>
                    {modelLabel(models, draft.defaultChatModel)} (Unavailable)
                  </option>
                ) : null}
                {selectableModels.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.displayName}
                  </option>
                ))}
              </select>
              {unavailableRow(draft.defaultChatModel) ? (
                <p className="text-[11px] text-[var(--warning)]">
                  {unavailableReason(draft.defaultChatModel)}
                </p>
              ) : null}
            </div>

            {/* Conductor model */}
            <div className="space-y-1.5">
              <label
                htmlFor="server-conductor-model"
                className="block text-xs font-semibold text-foreground"
              >
                Conductor / floor-manager model
              </label>
              <p className="text-[11px] text-foreground-muted">
                Arbitrates multi-user rooms. Wants a fast, strict-JSON model (★
                recommended). Automatic prefers MiniMax M3 when available.
              </p>
              <select
                id="server-conductor-model"
                className="w-full rounded-md border border-border bg-background-element px-2 py-1.5 text-sm"
                value={draft.conductorModel}
                disabled={!canManage}
                onChange={(e) => patch({ conductorModel: e.target.value })}
              >
                <option value="">— Automatic auxiliary model —</option>
                {unavailableRow(draft.conductorModel, "chat") ? (
                  <option value={draft.conductorModel} disabled>
                    {modelLabel(utilityModels, draft.conductorModel)} (Unavailable)
                  </option>
                ) : null}
                {conductorOptions.recommended.length > 0 ? (
                  <optgroup label="★ Recommended for Conductor">
                    {conductorOptions.recommended.map((m) => (
                      <option key={m.id} value={m.id}>
                        ★ {m.displayName}
                      </option>
                    ))}
                  </optgroup>
                ) : null}
                <optgroup label="All models">
                  {conductorOptions.rest.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.displayName}
                    </option>
                  ))}
                </optgroup>
              </select>
              {unavailableRow(draft.conductorModel, "chat") ? (
                <p className="text-[11px] text-[var(--warning)]">
                  {unavailableReason(draft.conductorModel, "chat")}
                </p>
              ) : null}
            </div>

            <div className="space-y-1.5">
              <label htmlFor="server-memory-review-model" className="block text-xs font-semibold text-foreground">
                Memory review model
              </label>
              <p className="text-[11px] text-foreground-muted">
                Reviews conversation and maintains Memories. Inherits the Conductor model unless you select a dedicated model. The model must support Memory tools.
              </p>
              <select id="server-memory-review-model" data-testid="server-memory-review-model"
                className="w-full rounded-md border border-border bg-background-element px-2 py-1.5 text-sm"
                value={draft.memoryReviewModel ?? ""} disabled={!canManage}
                onChange={(e) => patch({ memoryReviewModel: e.target.value || null })}>
                <option value="">— Inherit Conductor model —</option>
                {unavailableRow(draft.memoryReviewModel ?? "", "chat-tools") ? (
                  <option value={draft.memoryReviewModel ?? ""} disabled>
                    {modelLabel(models, draft.memoryReviewModel ?? "")} (Unavailable)
                  </option>
                ) : null}
                {selectableModels.map((m) => <option key={m.id} value={m.id}>{m.displayName}</option>)}
              </select>
              {unavailableRow(draft.memoryReviewModel ?? "", "chat-tools") ? (
                <p className="text-[11px] text-[var(--warning)]">
                  {unavailableReason(draft.memoryReviewModel ?? "", "chat-tools")}
                </p>
              ) : null}
            </div>

            <div className="space-y-1.5">
              <label htmlFor="server-embedding-model" className="block text-xs font-semibold text-foreground">
                Embedding model
              </label>
              <p className="text-[11px] text-foreground-muted">
                Creates vectors for semantic Memory search and Reflection. Server configuration inherits the operator setting. Automatic selects the first configured provider: Qwen3 Embedding 8B on Venice or OpenRouter, then text-embedding-3-small on OpenAI.
              </p>
              <select
                id="server-embedding-model"
                data-testid="server-embedding-model"
                className="w-full rounded-md border border-border bg-background-element px-2 py-1.5 text-sm"
                value={draft.embeddingModel === null ? SERVER_EMBEDDING_CONFIGURATION : draft.embeddingModel}
                disabled={!canManage}
                onChange={(event) => patch({
                  embeddingModel: event.target.value === SERVER_EMBEDDING_CONFIGURATION
                    ? null
                    : event.target.value,
                })}
              >
                <option value={SERVER_EMBEDDING_CONFIGURATION}>Server configuration</option>
                <option value="">Automatic — Venice → OpenRouter → OpenAI</option>
                {draft.embeddingModel !== null && draft.embeddingModel !== "" &&
                !supportedEmbeddingModels.some((model) => model.id === draft.embeddingModel) ? (
                  <option value={draft.embeddingModel} disabled>
                    {draft.embeddingModel} (Unavailable)
                  </option>
                ) : null}
                {supportedEmbeddingModels.map((model) => (
                  <option key={model.id} value={model.id} disabled={!model.available}>
                    {model.displayName}{model.available ? "" : " (Unavailable)"}
                  </option>
                ))}
              </select>
              <p className="text-[11px] text-foreground-muted" data-testid="effective-embedding-model">
                Current effective model: {draft.effectiveEmbeddingModel
                  ? draft.embeddingModels.find((model) => model.id === draft.effectiveEmbeddingModel)?.displayName
                    ?? draft.effectiveEmbeddingModel
                  : "Unavailable"}
              </p>
              {draft.embeddingSelectionPending ? (
                <p className="text-[11px] text-[var(--warning)]" role="status">
                  Saved selection is not active yet. Reload to retry applying it.
                </p>
              ) : null}
              <p className="text-[11px] text-[var(--warning)]">
                Changing the embedding provider or model does not rebuild existing vectors.
              </p>
            </div>

            {/* Stenographer model */}
            <div className="space-y-1.5">
              <label
                htmlFor="server-stenographer-model"
                className="block text-xs font-semibold text-foreground"
              >
                Stenographer model
              </label>
              <p className="text-[11px] text-foreground-muted">
                Extracts and compacts the Room event journal. Empty ⇒ inherits
                the resolved Conductor model.
              </p>
              <select
                id="server-stenographer-model"
                data-testid="server-stenographer-model"
                className="w-full rounded-md border border-border bg-background-element px-2 py-1.5 text-sm"
                value={draft.stenographerModel}
                disabled={!canManage}
                onChange={(e) => patch({ stenographerModel: e.target.value })}
              >
                <option value="">— Inherit Conductor model —</option>
                {unavailableRow(draft.stenographerModel, "chat") ? (
                  <option value={draft.stenographerModel} disabled>
                    {modelLabel(utilityModels, draft.stenographerModel)} (Unavailable)
                  </option>
                ) : null}
                {selectableUtilityModels.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.displayName}
                  </option>
                ))}
              </select>
              {unavailableRow(draft.stenographerModel, "chat") ? (
                <p className="text-[11px] text-[var(--warning)]">
                  {unavailableReason(draft.stenographerModel, "chat")}
                </p>
              ) : null}
            </div>

            {/* Reflection model */}
            <div className="space-y-1.5">
              <label
                htmlFor="server-reflection-model"
                className="block text-xs font-semibold text-foreground"
              >
                Reflection / Sleep model
              </label>
              <p className="text-[11px] text-foreground-muted">
                Organizes Room Records and rewrites dependency-loss successors.
                Empty ⇒ inherits the resolved Stenographer model.
              </p>
              <select
                id="server-reflection-model"
                data-testid="server-reflection-model"
                className="w-full rounded-md border border-border bg-background-element px-2 py-1.5 text-sm"
                value={draft.reflectionModel}
                disabled={!canManage}
                onChange={(e) => patch({ reflectionModel: e.target.value })}
              >
                <option value="">— Inherit Stenographer model —</option>
                {unavailableRow(draft.reflectionModel, "chat") ? (
                  <option value={draft.reflectionModel} disabled>
                    {modelLabel(utilityModels, draft.reflectionModel)} (Unavailable)
                  </option>
                ) : null}
                {selectableUtilityModels.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.displayName}
                  </option>
                ))}
              </select>
              {unavailableRow(draft.reflectionModel, "chat") ? (
                <p className="text-[11px] text-[var(--warning)]">
                  {unavailableReason(draft.reflectionModel, "chat")}
                </p>
              ) : null}
            </div>

            <div className="border-t border-border/60 pt-5">
              <h3 className="text-xs font-semibold text-foreground">Media generation</h3>
              <p className="mt-1 text-[11px] text-foreground-muted">
                Defaults apply when a generation request does not explicitly choose a model. Explicit choices are preserved. Reference-video workflows continue to require their explicit reference model and attached source media. Approved or queued work keeps its quoted model.
              </p>
              <div className="mt-3 grid gap-4">
                <MediaGenerationModelSelect
                  kind="image"
                  selection={draft.imageModel}
                  effective={draft.effectiveImageModel}
                  models={draft.imageModels}
                  canManage={canManage}
                  onChange={(imageModel) => patch({ imageModel })}
                />
                <MediaGenerationModelSelect
                  kind="music"
                  selection={draft.musicModel}
                  effective={draft.effectiveMusicModel}
                  models={draft.musicModels}
                  canManage={canManage}
                  onChange={(musicModel) => patch({ musicModel })}
                />
                <MediaGenerationModelSelect
                  kind="video"
                  selection={draft.videoModel}
                  effective={draft.effectiveVideoModel}
                  models={draft.videoModels}
                  canManage={canManage}
                  onChange={(videoModel) => patch({ videoModel })}
                />
              </div>
            </div>

            {/* Fallback chain */}
            <div className="space-y-1.5">
              <span className="block text-xs font-semibold text-foreground">
                Chat-model fallback chain
              </span>
              <p className="text-[11px] text-foreground-muted">
                When a chat model errors mid-reply, these are tried in order. This
                is the server-wide baseline for <strong>assistant replies</strong>{" "}
                (the default chat model above); the Conductor also falls back
                through it. A per-Agent fallback chain overrides this baseline.
                It does <strong>not</strong> change which model is used first —
                only what runs if that one fails.
              </p>
              {draft.fallbackChain.length === 0 ? (
                <p className="text-xs text-foreground-muted">No fallback models.</p>
              ) : (
                <ol className="space-y-1">
                  {draft.fallbackChain.map((id, i) => (
                    <li
                      key={id}
                      className="flex items-center gap-2 rounded-md border border-border/60 bg-background-element/40 px-2 py-1.5"
                    >
                      <span className="w-5 text-center text-[11px] text-foreground-muted">
                        {i + 1}
                      </span>
                      <span className="min-w-0 flex-1 truncate text-sm">
                        {modelLabel(models, id)}
                      </span>
                      {unavailableRow(id) ? (
                        <span className="text-right text-[11px] text-[var(--warning)]">
                          Unavailable
                          <span className="block">{unavailableReason(id)}</span>
                        </span>
                      ) : null}
                      {canManage ? (
                        <span className="flex items-center gap-1">
                          <button
                            type="button"
                            aria-label="Move up"
                            disabled={i === 0}
                            onClick={() => moveFallback(i, -1)}
                            className="rounded px-1.5 py-0.5 text-xs hover:bg-background-element disabled:opacity-40"
                          >
                            ↑
                          </button>
                          <button
                            type="button"
                            aria-label="Move down"
                            disabled={i === draft.fallbackChain.length - 1}
                            onClick={() => moveFallback(i, 1)}
                            className="rounded px-1.5 py-0.5 text-xs hover:bg-background-element disabled:opacity-40"
                          >
                            ↓
                          </button>
                          <button
                            type="button"
                            aria-label="Remove"
                            onClick={() => removeFallback(id)}
                            className="rounded px-1.5 py-0.5 text-xs text-[var(--error)] hover:bg-background-element"
                          >
                            ✕
                          </button>
                        </span>
                      ) : null}
                    </li>
                  ))}
                </ol>
              )}
              {canManage && fallbackAddable.length > 0 ? (
                <select
                  aria-label="Add fallback model"
                  className="mt-1 w-full rounded-md border border-border bg-background-element px-2 py-1.5 text-sm"
                  value=""
                  onChange={(e) => addFallback(e.target.value)}
                >
                  <option value="">+ Add fallback model…</option>
                  {fallbackAddable.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.displayName}
                    </option>
                  ))}
                </select>
              ) : null}
            </div>

            <div className="border-t border-border/60 pt-5">
              <h3 className="text-xs font-semibold text-foreground">Reasoning defaults</h3>
              <p className="mt-1 text-[11px] text-foreground-muted">
                Set reasoning intensity for every capable model or one specific model.
              </p>
              {reasoningModels.length === 0 ? (
                <p className="mt-3 text-xs text-foreground-muted">No reasoning-capable models are currently runnable.</p>
              ) : (
                <div className="mt-3 grid gap-3 sm:grid-cols-2">
                  <label className="space-y-1.5">
                    <span className="block text-[11px] font-semibold text-foreground-muted">Apply to</span>
                    <select
                      aria-label="Reasoning policy scope"
                      className="w-full rounded-md border border-border bg-background-element px-2 py-1.5 text-sm"
                      value={reasoningScope}
                      disabled={!canManage}
                      onChange={(event) => {
                        const scope = event.target.value as "all" | "specific";
                        setReasoningScope(scope);
                        if (scope === "specific" && !reasoningModelId) setReasoningModelId(reasoningModels[0]?.id ?? "");
                      }}
                    >
                      <option value="all">All capable models</option>
                      <option value="specific">A specific model</option>
                    </select>
                  </label>
                  {reasoningScope !== "all" ? (
                    <label className="space-y-1.5">
                      <span className="block text-[11px] font-semibold text-foreground-muted">Model</span>
                      <select
                        aria-label="Reasoning policy model"
                        className="w-full rounded-md border border-border bg-background-element px-2 py-1.5 text-sm"
                        value={selectedReasoningModel?.id ?? reasoningModelId}
                        disabled={!canManage}
                        onChange={(event) => { setReasoningModelId(event.target.value); }}
                      >
                        {reasoningModels.map((model) => <option key={model.id} value={model.id}>{model.displayName}</option>)}
                      </select>
                    </label>
                  ) : null}
                  <label className="space-y-1.5">
                    <span className="block text-[11px] font-semibold text-foreground-muted">Reasoning intensity</span>
                    <select
                      aria-label="Reasoning intensity"
                      className="w-full rounded-md border border-border bg-background-element px-2 py-1.5 text-sm"
                      value={selectedReasoningEffort ?? "default"}
                      disabled={!canManage}
                      onChange={(event) => setReasoningPolicy(
                        reasoningScope === "all" ? "all" : selectedReasoningModel?.id ?? reasoningModelId,
                        event.target.value === "default" ? null : event.target.value as ServerModelConfig["reasoningPolicy"]["defaultEffort"],
                      )}
                    >
                      <option value="default">Model default</option>
                      <option value="off">Off</option>
                      {reasoningLevels.map((level) => <option key={level} value={level}>{level[0].toUpperCase() + level.slice(1)}</option>)}
                    </select>
                  </label>
                </div>
              )}
            </div>

            {canManage ? (
              <div className="flex items-center gap-3 border-t border-border/60 pt-4">
                <Button
                  variant="primary"
                  onClick={() => void handleSave()}
                  loading={save === "saving"}
                  disabled={!dirty || save === "saving"}
                >
                  {save === "saving" ? "Saving…" : "Save changes"}
                </Button>
                {save === "saved" ? (
                  <span className="text-xs text-[var(--success,#16a34a)]">Saved. Live now.</span>
                ) : typeof save === "object" ? (
                  <span className="text-xs text-[var(--error)]" role="alert">
                    {save.error}
                  </span>
                ) : null}
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
    </section>
  );
}
