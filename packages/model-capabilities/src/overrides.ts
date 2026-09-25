import type {
  CapabilityProvenance,
  ModelCapabilityFeatures,
  ModelInputModality,
  ModelOutputModality,
  ResolvedModelCapabilities,
} from "./types";

type OverrideRow = {
  input: readonly ModelInputModality[];
  output: readonly ModelOutputModality[];
  provenance: CapabilityProvenance;
  /**
   * Checked-in feature flags. Present when we assert capabilities the
   * OpenRouter cache may not carry (e.g. `reasoning` for Anthropic, which has
   * no `features` block otherwise → reasoning would default false). When set,
   * `tools` MUST be stated explicitly because the eligible-model projection
   * switches from default-true to `f.tools === true` once any features exist.
   */
  features?: ModelCapabilityFeatures;
};

/**
 * Checked-in overrides — exact Nautilo model ids win over imported OpenRouter rows.
 * Unknown ids fall back to OpenRouter (via alias map + cache) or text-only default.
 */
export const MODEL_CAPABILITY_OVERRIDES: Readonly<Record<string, OverrideRow>> = {
  "fireworks:accounts/fireworks/models/kimi-k3": {
    input: ["text", "image"],
    output: ["text"],
    provenance: "override",
    features: { tools: true, structuredOutputs: false, reasoning: true },
  },
  "anthropic:claude-sonnet-4-6": {
    input: ["text", "image", "file"],
    output: ["text"],
    provenance: "override",
    // Anthropic 4.x support extended thinking; the OpenRouter cache
    // carries no features block for these, so reasoning would default false.
    features: { tools: true, structuredOutputs: false, reasoning: true },
  },
  "anthropic:claude-sonnet-5": {
    input: ["text", "image", "file"],
    output: ["text"],
    provenance: "override",
    features: { tools: true, structuredOutputs: false, reasoning: true },
  },
  // Fable 5: adaptive thinking always-on (factory routes adaptive);
  // raw CoT never returned. Vision + PDF confirmed via Anthropic Models API.
  "anthropic:claude-fable-5": {
    input: ["text", "image", "file"],
    output: ["text"],
    provenance: "override",
    features: { tools: true, structuredOutputs: false, reasoning: true },
  },
  "anthropic:claude-opus-5": {
    input: ["text", "image", "file"],
    output: ["text"],
    provenance: "override",
    features: { tools: true, structuredOutputs: false, reasoning: true },
  },
  "anthropic:claude-opus-5-5": {
    input: ["text", "image", "file"], output: ["text"], provenance: "override",
    features: { tools: true, structuredOutputs: true, reasoning: true, visualGrounding: true },
  },
  "anthropic:claude-opus-4-8": {
    input: ["text", "image", "file"],
    output: ["text"],
    provenance: "override",
    // Opus 4.8 uses adaptive thinking (factory routes the thinking shape).
    features: { tools: true, structuredOutputs: false, reasoning: true },
  },
  "anthropic:claude-opus-4-7": {
    input: ["text", "image", "file"],
    output: ["text"],
    provenance: "override",
    features: { tools: true, structuredOutputs: false, reasoning: true },
  },
  "anthropic:claude-opus-4-6": {
    input: ["text", "image", "file"],
    output: ["text"],
    provenance: "override",
    features: { tools: true, structuredOutputs: false, reasoning: true },
  },
  "openai:gpt-5.5-2026-04-23": {
    input: ["text", "image", "file"],
    output: ["text"],
    provenance: "override",
    features: { tools: true, structuredOutputs: false, reasoning: true },
  },
  "openai:gpt-5.4-2026-03-05": {
    input: ["text", "image", "file"],
    output: ["text"],
    provenance: "override",
    features: { tools: true, structuredOutputs: false, reasoning: true },
  },
  // GPT-5.6 frontier thinking family (sol/terra/luna). Modalities +
  // features confirmed live via POST /v1/responses on 2026-07-09: image input
  // and file (PDF) input accepted, function tools accepted, reasoning{effort}
  // accepted. structuredOutputs kept false to match the GPT-5.x family rows
  // (once a features block exists, tools must be stated explicitly or the
  // eligible-model projection flips to false).
  "openai:gpt-5.6-sol": {
    input: ["text", "image", "file"],
    output: ["text"],
    provenance: "override",
    features: { tools: true, structuredOutputs: false, reasoning: true },
  },
  "openai:gpt-5.6-terra": {
    input: ["text", "image", "file"],
    output: ["text"],
    provenance: "override",
    features: { tools: true, structuredOutputs: false, reasoning: true },
  },
  "openai:gpt-5.6-luna": {
    input: ["text", "image", "file"],
    output: ["text"],
    provenance: "override",
    features: { tools: true, structuredOutputs: false, reasoning: true },
  },
  "openai:gpt-6-sol": {
    input: ["text", "image", "file"], output: ["text"], provenance: "override",
    features: { tools: true, structuredOutputs: true, reasoning: true, visualGrounding: true },
  },
  "openai:gpt-6-luna": {
    input: ["text", "image", "file"], output: ["text"], provenance: "override",
    features: { tools: true, structuredOutputs: true, reasoning: true, visualGrounding: true },
  },
  "google:gemini-2.5-pro": {
    input: ["text", "image", "file"],
    output: ["text"],
    provenance: "override",
  },
  "google:gemini-3.1-pro-preview": {
    input: ["text", "image", "file"],
    output: ["text"],
    provenance: "override",
  },
  "google:gemini-3-flash-preview": {
    input: ["text", "image", "file"],
    output: ["text"],
    provenance: "override",
  },
  "google:gemini-3.1-flash-lite-preview": {
    input: ["text", "image", "file"],
    output: ["text"],
    provenance: "override",
  },
  "fireworks:accounts/fireworks/models/gemma-4-31b-it": {
    input: ["text", "image", "file"],
    output: ["text"],
    provenance: "override",
  },
  "fireworks:accounts/fireworks/models/gemma-4-26b-a4b-it": {
    input: ["text", "image", "file"],
    output: ["text"],
    provenance: "override",
  },
  "fireworks:accounts/fireworks/models/minimax-m3": {
    input: ["text", "image"],
    output: ["text"],
    provenance: "override",
    features: { tools: true, structuredOutputs: false, reasoning: true },
  },
  "openrouter:google/gemma-4-31b-it": {
    input: ["text", "image", "file"],
    output: ["text"],
    provenance: "override",
  },
  "openrouter:google/gemma-4-26b-a4b-it": {
    input: ["text", "image", "file"],
    output: ["text"],
    provenance: "override",
  },
  "fireworks:accounts/fireworks/models/kimi-k2p5": {
    input: ["text"],
    output: ["text"],
    provenance: "override",
  },
  // Fireworks Get Model: text-only + tools; GLM-5.3 author documents reasoning.
  // Structured-output support is not advertised without provider-specific proof.
  "fireworks:accounts/fireworks/models/glm-5p3": {
    input: ["text"], output: ["text"], provenance: "override",
    features: { tools: true, structuredOutputs: false, reasoning: true },
  },
  "fireworks:accounts/fireworks/models/glm-5p1": {
    input: ["text"],
    output: ["text"],
    provenance: "override",
    features: { tools: true, structuredOutputs: false, reasoning: true },
  },
  "fireworks:accounts/fireworks/models/deepseek-v4-pro": {
    input: ["text"],
    output: ["text"],
    provenance: "override",
    features: { tools: true, structuredOutputs: false, reasoning: true },
  },
  "fireworks:accounts/fireworks/models/deepseek-v4p1-flash": {
    input: ["text", "image"], output: ["text"], provenance: "override",
    features: { tools: true, structuredOutputs: false, reasoning: true },
  },
  "openrouter:z-ai/glm-5.1": {
    input: ["text"],
    output: ["text"],
    provenance: "override",
    features: { tools: true, structuredOutputs: false, reasoning: true },
  },
  "openrouter:z-ai/glm-5.3": {
    input: ["text"],
    output: ["text"],
    provenance: "override",
    features: { tools: true, structuredOutputs: true, reasoning: true },
  },
  "openrouter:deepseek/deepseek-v4-pro": {
    input: ["text"],
    output: ["text"],
    provenance: "override",
    features: { tools: true, structuredOutputs: false, reasoning: true },
  },
  "openrouter:deepseek/deepseek-v4-pro-0813": {
    input: ["text"],
    output: ["text"],
    provenance: "override",
    features: { tools: true, structuredOutputs: true, reasoning: true },
  },
  "venice:zai-org-glm-5-1": {
    input: ["text"],
    output: ["text"],
    provenance: "override",
    features: { tools: true, structuredOutputs: false, reasoning: true },
  },
  "venice:z-ai-glm-5-3": {
    input: ["text"],
    output: ["text"],
    provenance: "override",
    features: { tools: true, structuredOutputs: true, reasoning: true },
  },
  "venice:e2ee-deepseek-v4-flash": {
    input: ["text"],
    output: ["text"],
    provenance: "override",
    features: { tools: true, structuredOutputs: false, reasoning: true },
  },
  "venice:deepseek-v4-flash": {
    input: ["text"],
    output: ["text"],
    provenance: "override",
    features: { tools: true, structuredOutputs: false, reasoning: true },
  },
  "venice:kimi-k3": {
    input: ["text", "image"],
    output: ["text"],
    provenance: "override",
    features: { tools: true, structuredOutputs: true, reasoning: true },
  },
  "venice:deepseek-v4-pro": {
    input: ["text"],
    output: ["text"],
    provenance: "override",
    features: { tools: true, structuredOutputs: false, reasoning: true },
  },
  "venice:claude-sonnet-4-6": {
    input: ["text", "image", "file"],
    output: ["text"],
    provenance: "override",
    features: { tools: true, structuredOutputs: false, reasoning: true },
  },
  "venice:claude-opus-4-7": {
    input: ["text", "image", "file"],
    output: ["text"],
    provenance: "override",
    features: { tools: true, structuredOutputs: false, reasoning: true },
  },
  "venice:claude-opus-5-5": {
    input: ["text", "image"], output: ["text"], provenance: "override",
    features: { tools: true, structuredOutputs: true, reasoning: true },
  },
  "venice:openai-gpt-6-sol": {
    input: ["text", "image"], output: ["text"], provenance: "override",
    features: { tools: true, structuredOutputs: true, reasoning: true, visualGrounding: true },
  },
  "venice:openai-gpt-6-luna": {
    input: ["text", "image"], output: ["text"], provenance: "override",
    features: { tools: true, structuredOutputs: true, reasoning: true, visualGrounding: true },
  },
  "venice:gemini-3-1-pro-preview": {
    input: ["text", "image", "file"],
    output: ["text"],
    provenance: "override",
    features: { tools: true, structuredOutputs: false, reasoning: true },
  },
  "venice:openai-gpt-55-pro": {
    input: ["text", "image", "file"],
    output: ["text"],
    provenance: "override",
    features: { tools: true, structuredOutputs: false, reasoning: true },
  },
  "venice:qwen-3-6-plus": {
    input: ["text"],
    output: ["text"],
    provenance: "override",
    features: { tools: true, structuredOutputs: false, reasoning: true },
  },
  "fireworks:accounts/fireworks/models/glm-5": {
    input: ["text"],
    output: ["text"],
    provenance: "override",
  },
  // Image generation models. input is text+image (you can
  // condition on a reference image for some of these); output is image.
  "openai:gpt-image-2": {
    input: ["text", "image"],
    output: ["image"],
    provenance: "override",
  },
  "openai:gpt-image-2-2026-04-21": {
    input: ["text", "image"],
    output: ["image"],
    provenance: "override",
  },
  "openai:gpt-image-1.5": {
    input: ["text", "image"],
    output: ["image"],
    provenance: "override",
  },
  "openai:gpt-image-1": {
    input: ["text", "image"],
    output: ["image"],
    provenance: "override",
  },
  "openai:gpt-image-1-mini": {
    input: ["text", "image"],
    output: ["image"],
    provenance: "override",
  },
  "google:gemini-2.5-flash-image": {
    input: ["text", "image"],
    output: ["text", "image"],
    provenance: "override",
  },
  "google:imagen-4": {
    input: ["text"],
    output: ["image"],
    provenance: "override",
  },
};

/**
 * Map Nautilo assistant ids to OpenRouter slug keys present in
 * `GET https://openrouter.ai/api/v1/models`. Used only when no override exists.
 * Slugs drift — overrides remain authoritative for Tier-1 assistants.
 */
export const NAUTILO_ID_TO_OPENROUTER_SLUG: Readonly<Record<string, string>> = {
  "anthropic:claude-sonnet-4-6": "anthropic/claude-sonnet-4.6",
  "anthropic:claude-sonnet-5": "anthropic/claude-sonnet-5",
  "anthropic:claude-fable-5": "anthropic/claude-fable-5",
  "anthropic:claude-opus-5": "anthropic/claude-opus-5",
  "anthropic:claude-opus-5-5": "anthropic/claude-opus-5.5",
  "anthropic:claude-opus-4-8": "anthropic/claude-opus-4.8",
  "anthropic:claude-opus-4-7": "anthropic/claude-opus-4.7",
  "anthropic:claude-opus-4-6": "anthropic/claude-opus-4.6",
  "openai:gpt-5.5-2026-04-23": "openai/gpt-5.5",
  "openai:gpt-5.4-2026-03-05": "openai/gpt-5.4",
  "openai:gpt-5.6-sol": "openai/gpt-5.6-sol",
  "openai:gpt-5.6-terra": "openai/gpt-5.6-terra",
  "openai:gpt-5.6-luna": "openai/gpt-5.6-luna",
  "openai:gpt-6-sol": "openai/gpt-6-sol",
  "openai:gpt-6-luna": "openai/gpt-6-luna",
  "google:gemini-2.5-pro": "google/gemini-2.5-pro",
  "google:gemini-3.1-pro-preview": "google/gemini-3.1-pro-preview",
  "google:gemini-3-flash-preview": "google/gemini-3-flash-preview",
  "google:gemini-3.1-flash-lite-preview": "google/gemini-3.1-flash-lite-preview",
  "fireworks:accounts/fireworks/models/gemma-4-31b-it": "fireworks/gemma-4-31b-it",
  "fireworks:accounts/fireworks/models/gemma-4-26b-a4b-it": "fireworks/gemma-4-26b-a4b-it",
  "openrouter:google/gemma-4-31b-it": "google/gemma-4-31b-it",
  "openrouter:google/gemma-4-26b-a4b-it": "google/gemma-4-26b-a4b-it",
  "openrouter:moonshotai/kimi-k2.6": "moonshotai/kimi-k2.6",
  "fireworks:accounts/fireworks/models/glm-5p1": "fireworks/glm-5p1",
  "openrouter:z-ai/glm-5.1": "z-ai/glm-5.1",
  "openrouter:z-ai/glm-5.3": "z-ai/glm-5.3",
  "fireworks:accounts/fireworks/models/minimax-m3": "fireworks/minimax-m3",
  "fireworks:accounts/fireworks/models/minimax-m2p7": "fireworks/minimax-m2p7",
  "fireworks:accounts/fireworks/models/deepseek-v4-pro": "fireworks/deepseek-v4-pro",
  "fireworks:accounts/fireworks/models/deepseek-v4p1-flash": "fireworks/deepseek-v4p1-flash",
  "openrouter:deepseek/deepseek-v4-pro": "deepseek/deepseek-v4-pro",
  "openrouter:deepseek/deepseek-v4-pro-0813": "deepseek/deepseek-v4-pro-0813",
  "openrouter:minimax/minimax-m2.7": "minimax/minimax-m2.7",
  "fireworks:accounts/fireworks/models/kimi-k2p5": "fireworks/kimi-k2p5",
  "fireworks:accounts/fireworks/models/glm-5": "fireworks/glm-5",
};

export function overrideRowToResolved(modelId: string, row: OverrideRow): ResolvedModelCapabilities {
  return {
    modelId,
    input: row.input,
    output: row.output,
    provenance: row.provenance,
    ...(row.features ? { features: row.features } : {}),
  };
}
