import {
  getCachedServerModelConfigRow,
  kickServerModelConfigRefresh,
} from "@nautilo/db";
import { getActiveModelCatalogSync } from "./model-catalog/runtime-catalog";
import { isSupportedModelCatalogProvider } from "./model-catalog/supported-providers";
import { resolveModelRole } from "./model-role-resolution";
import { hasRunnableOpenRouterTransport } from "../providers/openrouter-transport";

/** Venice upstream routing for privacy UX. */
export type VeniceRouting = "venice-hosted" | "western-anonymized" | "china-anonymized";

export interface AssistantModelConfig {
  id: string;
  displayName: string;
  priority: number;
  enabled: boolean;
  costCoefficient: number;
  /** Set only for `venice:*` catalog rows. */
  routing?: VeniceRouting;
}

export const ASSISTANT_MODELS: AssistantModelConfig[] = [
  { id: "anthropic:claude-sonnet-4-6", displayName: "Claude Sonnet 4.6 (Anthropic)", priority: 1, enabled: true, costCoefficient: 1.0 },
  // Claude Sonnet 5 (API id `claude-sonnet-5`, 1M ctx).
  // Enabled + selectable; priority 2 keeps Sonnet 4.6 as the catalog default
  // (global-default flip is a separate call).
  { id: "anthropic:claude-sonnet-5", displayName: "Claude Sonnet 5 (Anthropic)", priority: 2, enabled: true, costCoefficient: 1.0 },
  // Claude Fable 5 (API id `claude-fable-5`, 1M/128k; adaptive thinking always-on).
  // costCoefficient 3.3 ≈ $10/$50 vs Sonnet baseline $3/$15. Priority 2 — no default flip.
  { id: "anthropic:claude-fable-5", displayName: "Claude Fable 5 (Anthropic)", priority: 2, enabled: true, costCoefficient: 3.3 },
  { id: "anthropic:claude-opus-5", displayName: "Claude Opus 5 (Anthropic)", priority: 2, enabled: true, costCoefficient: 1.6 },
  { id: "anthropic:claude-opus-5-5", displayName: "Claude Opus 5.5 (Anthropic)", priority: 2, enabled: true, costCoefficient: 1.33 },
  { id: "anthropic:claude-opus-4-8", displayName: "Claude Opus 4.8 (Anthropic)", priority: 2, enabled: true, costCoefficient: 1.6 },
  { id: "anthropic:claude-opus-4-7", displayName: "Claude Opus 4.7 (Anthropic)", priority: 13, enabled: true, costCoefficient: 1.6 },
  // GPT-5.6 frontier thinking family (sol/terra/luna). Sol is the
  // flagship tier ($5/$30, coeff 2.0 ≈ GPT-5.5), Terra the mid tier ($2.50/$15,
  // coeff 1.0 ≈ Sonnet baseline), Luna the fast/cheap tier ($1/$6, coeff 0.4).
  { id: "openai:gpt-5.6-sol", displayName: "GPT-5.6 Sol (OpenAI)", priority: 3, enabled: true, costCoefficient: 2.0 },
  { id: "openai:gpt-5.6-terra", displayName: "GPT-5.6 Terra (OpenAI)", priority: 4, enabled: true, costCoefficient: 1.0 },
  { id: "openai:gpt-5.6-luna", displayName: "GPT-5.6 Luna (OpenAI)", priority: 5, enabled: true, costCoefficient: 0.4 },
  { id: "openai:gpt-6-sol", displayName: "GPT-6 Sol (OpenAI)", priority: 3, enabled: true, costCoefficient: 0.67 },
  { id: "openai:gpt-6-luna", displayName: "GPT-6 Luna (OpenAI)", priority: 5, enabled: true, costCoefficient: 0.03 },
  { id: "openai:gpt-5.5-2026-04-23", displayName: "GPT-5.5 (OpenAI)", priority: 3, enabled: true, costCoefficient: 2.0 },
  { id: "openai:gpt-5.4-2026-03-05", displayName: "GPT-5.4 (OpenAI)", priority: 4, enabled: true, costCoefficient: 1.0 },
  { id: "google:gemini-2.5-pro", displayName: "Gemini 2.5 Pro (Google)", priority: 5, enabled: true, costCoefficient: 1.0 },
  {
    id: "google:gemini-3.1-pro-preview",
    displayName: "Gemini 3.1 Pro Preview (Google)",
    priority: 6,
    enabled: true,
    costCoefficient: 1.1,
  },
  {
    id: "google:gemini-3-flash-preview",
    displayName: "Gemini 3 Flash Preview (Google)",
    priority: 7,
    enabled: true,
    costCoefficient: 0.45,
  },
  {
    id: "google:gemini-3.1-flash-lite-preview",
    displayName: "Gemini 3.1 Flash-Lite Preview (Google)",
    priority: 8,
    enabled: true,
    costCoefficient: 0.25,
  },
  {
    id: "fireworks:accounts/fireworks/models/kimi-k3",
    displayName: "Kimi K3 (Fireworks)",
    priority: 9,
    enabled: true,
    costCoefficient: 1,
  },
  {
    id: "openrouter:moonshotai/kimi-k2.6",
    displayName: "Kimi K2.6 (OpenRouter)",
    priority: 10,
    enabled: true,
    costCoefficient: 0.22,
  },
  {
    id: "fireworks:accounts/fireworks/models/glm-5p1",
    displayName: "GLM 5.1 (Fireworks)",
    priority: 12,
    enabled: true,
    costCoefficient: 0.3,
  },
  {
    id: "openrouter:z-ai/glm-5.1",
    displayName: "GLM 5.1 (OpenRouter)",
    priority: 13,
    enabled: true,
    costCoefficient: 0.32,
  },
  {
    id: "fireworks:accounts/fireworks/models/deepseek-v4-pro",
    displayName: "DeepSeek V4 Pro Preview (Fireworks, deprecated)",
    priority: 114,
    enabled: false,
    costCoefficient: 2.0,
  },
  {
    id: "openrouter:deepseek/deepseek-v4-pro",
    displayName: "DeepSeek V4 Pro Preview (OpenRouter, deprecated)",
    priority: 115,
    enabled: false,
    costCoefficient: 2.2,
  },
  {
    id: "openrouter:deepseek/deepseek-v4-pro-0813",
    displayName: "DeepSeek V4 Pro 0813 (OpenRouter)",
    priority: 15,
    enabled: true,
    costCoefficient: 0.08,
  },
  {
    id: "fireworks:accounts/fireworks/models/minimax-m3",
    displayName: "MiniMax M3 (Fireworks)",
    priority: 16,
    enabled: true,
    costCoefficient: 0.7,
  },
  {
    id: "openrouter:minimax/minimax-m2.7",
    displayName: "MiniMax M2.7 (OpenRouter)",
    priority: 17,
    enabled: true,
    costCoefficient: 0.35,
  },
  {
    id: "openrouter:google/gemma-4-31b-it",
    displayName: "Gemma 4 31B IT (OpenRouter)",
    priority: 18,
    enabled: true,
    costCoefficient: 0.22,
  },
  {
    id: "openrouter:google/gemma-4-26b-a4b-it",
    displayName: "Gemma 4 26B A4B IT (OpenRouter)",
    priority: 20,
    enabled: true,
    costCoefficient: 0.17,
  },
  { id: "openrouter:anthropic/claude-opus-5.5", displayName: "Claude Opus 5.5 (OpenRouter)", priority: 2, enabled: true, costCoefficient: 1.33 },
  { id: "openrouter:openai/gpt-6-sol", displayName: "GPT-6 Sol (OpenRouter)", priority: 3, enabled: true, costCoefficient: 0.67 },
  { id: "openrouter:openai/gpt-6-luna", displayName: "GPT-6 Luna (OpenRouter)", priority: 5, enabled: true, costCoefficient: 0.03 },
  // --- Venice — curated routes disabled by default; NAUTILO_MODEL or model picker.
  // Coefficients vs Claude Sonnet 4.6 = 1.0.
  { id: "venice:zai-org-glm-5-1", displayName: "GLM 5.1 Beta (Venice-hosted)", priority: 21, enabled: false, costCoefficient: 0.55, routing: "venice-hosted" },
  { id: "venice:e2ee-deepseek-v4-flash", displayName: "DeepSeek V4 Flash E2EE TEE (Venice-hosted, no vision)", priority: 22, enabled: false, costCoefficient: 0.05, routing: "venice-hosted" },
  { id: "venice:deepseek-v4-flash", displayName: "DeepSeek V4 Flash (Venice → DeepSeek)", priority: 23, enabled: false, costCoefficient: 0.1, routing: "western-anonymized" },
  { id: "venice:google-gemma-3-27b-it", displayName: "Gemma 3 27B (Venice-hosted)", priority: 23, enabled: false, costCoefficient: 0.02, routing: "venice-hosted" },
  { id: "venice:google-gemma-4-26b-a4b-it", displayName: "Gemma 4 26B A4B (Venice-hosted)", priority: 24, enabled: false, costCoefficient: 0.05, routing: "venice-hosted" },
  { id: "venice:google-gemma-4-31b-it", displayName: "Gemma 4 31B (Venice-hosted)", priority: 25, enabled: false, costCoefficient: 0.05, routing: "venice-hosted" },
  { id: "venice:kimi-k3", displayName: "Kimi K3 Beta (Venice-hosted)", priority: 26, enabled: false, costCoefficient: 1.3, routing: "venice-hosted" },
  { id: "venice:deepseek-v4-pro", displayName: "DeepSeek V4 Pro (Venice → Fireworks)", priority: 27, enabled: false, costCoefficient: 0.38, routing: "western-anonymized" },
  { id: "venice:minimax-m27", displayName: "MiniMax M2.7 (Venice → Fireworks)", priority: 28, enabled: false, costCoefficient: 0.15, routing: "western-anonymized" },
  { id: "venice:claude-sonnet-4-6", displayName: "Claude Sonnet 4.6 (Venice → Anthropic)", priority: 29, enabled: false, costCoefficient: 1.8, routing: "western-anonymized" },
  { id: "venice:claude-opus-4-7", displayName: "Claude Opus 4.7 (Venice → Anthropic)", priority: 30, enabled: false, costCoefficient: 3.0, routing: "western-anonymized" },
  { id: "venice:gemini-3-1-pro-preview", displayName: "Gemini 3.1 Pro Preview (Venice → Google)", priority: 31, enabled: false, costCoefficient: 1.5, routing: "western-anonymized" },
  { id: "venice:openai-gpt-55-pro", displayName: "GPT-5.5 Pro (Venice → OpenAI)", priority: 32, enabled: false, costCoefficient: 22.5, routing: "western-anonymized" },
  { id: "venice:claude-opus-5-5", displayName: "Claude Opus 5.5 (Venice → Anthropic)", priority: 37, enabled: false, costCoefficient: 1.6, routing: "western-anonymized" },
  { id: "venice:openai-gpt-6-sol", displayName: "GPT-6 Sol (Venice → OpenAI)", priority: 34, enabled: false, costCoefficient: 0.83, routing: "western-anonymized" },
  { id: "venice:openai-gpt-6-luna", displayName: "GPT-6 Luna (Venice → OpenAI)", priority: 35, enabled: false, costCoefficient: 0.04, routing: "western-anonymized" },
  { id: "venice:qwen-3-6-plus", displayName: "Qwen 3.6 Plus (Venice → Alibaba)", priority: 33, enabled: false, costCoefficient: 0.38, routing: "china-anonymized" },
];

function isOpenRouterModelId(id: string): boolean {
  return id.toLowerCase().startsWith("openrouter:") && id.slice("openrouter:".length).trim().length > 0;
}

function openRouterModelConfig(id: string, catalogModel?: AssistantModelConfig): AssistantModelConfig {
  return {
    id,
    displayName: catalogModel?.displayName ?? `OpenRouter: ${id.slice("openrouter:".length)}`,
    priority: catalogModel?.priority ?? 999,
    enabled: true,
    costCoefficient: catalogModel?.costCoefficient ?? 1.0,
  };
}

export function getDefaultModel(): AssistantModelConfig {
  const envDefault = process.env["NAUTILO_MODEL"];
  if (envDefault) {
    const id = resolveModelRole("chat", { configuredId: envDefault });
    const configured = getModelById(id);
    if (!configured) throw new Error(`Resolved default model "${id}" is absent from the catalog`);
    return configured;
  }
  // Server-wide admin-configured default (DB-backed, live via cache).
  // Precedence: explicit NAUTILO_MODEL env (operator host pin) > server config
  // > catalog auto-pick. Cache read is sync; kick a background refresh for TTL.
  kickServerModelConfigRefresh();
  const serverDefault = getCachedServerModelConfigRow()?.defaultChatModel;
  if (serverDefault && serverDefault.trim()) {
    const id = resolveModelRole("chat", { configuredId: serverDefault });
    const model = getModelById(id);
    if (!model) throw new Error(`Resolved default model "${id}" is absent from the catalog`);
    return model;
  }
  const id = resolveModelRole("chat");
  const model = getModelById(id);
  if (!model) throw new Error(`Resolved default model "${id}" is absent from the catalog`);
  return model;
}

/**
 * Pure catalog lookup by ID. Returns disabled rows (e.g. Venice) so callers can
 * inspect `routing` / `enabled`. Dynamic OpenRouter/Gateway ids work without a
 * catalog row.
 */
export function getModelById(id: string): AssistantModelConfig | undefined {
  const active = getActiveModelCatalogSync().catalog.entries.find(
    (entry) => entry.id === id,
  );
  if (active && isSupportedModelCatalogProvider(active.provider)) {
    const config: AssistantModelConfig = {
      id: active.id,
      displayName: active.displayName,
      priority: active.priority,
      enabled: active.defaultEnabled,
      costCoefficient: active.cost.coefficient,
    };
    if (active.provider === "venice") {
      config.routing = active.routing as VeniceRouting;
    }
    return config;
  }
  const found = ASSISTANT_MODELS.find((model) => model.id === id);
  if (found) return found;
  return undefined;
}

export function getEnabledModels(): AssistantModelConfig[] {
  return ASSISTANT_MODELS.filter((m) => m.enabled).sort((a, b) => a.priority - b.priority);
}

export function getSelectableModels(): AssistantModelConfig[] {
  const models = new Map<string, AssistantModelConfig>();
  for (const model of getEnabledModels()) {
    models.set(model.id, model);
  }
  if (hasRunnableOpenRouterTransport()) {
    for (const model of ASSISTANT_MODELS.filter((m) => isOpenRouterModelId(m.id))) {
      models.set(model.id, openRouterModelConfig(model.id, model));
    }
  }
  return Array.from(models.values()).sort((a, b) => a.priority - b.priority);
}

/**
 * @deprecated The chat path now uses a user-defined fallback chain.
 *
 * The chat path no longer walks the catalog priority list — fallback
 * is now user-defined per `profiles.fallback_chain` /
 * `agents.customization.fallback.chain` and resolved at invocation
 * time by `resolveFallbackPolicy` in
 * `packages/agent/src/utils/chat-model-invocation.ts`.
 *
 * This function is retained only for legacy catalog-shape callers and tests.
 * Default and internal-role resolution now use the shared role-candidate
 * policy. DO NOT add new callers; user-chat fallback flows through
 * `invokeChatModelWithFallback` and its configured policy.
 */
export function getNextFallbackModel(currentId: string): AssistantModelConfig | undefined {
  const current = ASSISTANT_MODELS.find((m) => m.id === currentId);
  if (!current) return undefined;
  if (!current.enabled) return getEnabledModels()[0];
  return ASSISTANT_MODELS.filter((m) => m.enabled && m.priority > current.priority).sort((a, b) => a.priority - b.priority)[0];
}

export function getProviderFromModelId(modelId: string): string {
  if (!modelId || !modelId.includes(":")) return "unknown";
  return modelId.split(":")[0] || "unknown";
}

export function getCostCoefficient(modelId: string): number {
  const active = getActiveModelCatalogSync().catalog.entries.find(
    (entry) => entry.id === modelId,
  );
  if (active) return active.cost.coefficient;
  const model = ASSISTANT_MODELS.find((candidate) => candidate.id === modelId);
  return model?.costCoefficient ?? 1.0;
}
