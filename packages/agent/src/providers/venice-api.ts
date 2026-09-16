/**
 * Single source for Venice OpenAI-compatible API roots (chat completions,
 * models list, etc.). Keep in sync with {@link ./universal} Venice routing.
 */
export const VENICE_API_V1_BASE = "https://api.venice.ai/api/v1";

export const VENICE_CHAT_COMPLETIONS_URL = `${VENICE_API_V1_BASE}/chat/completions`;

export const VENICE_EMBEDDINGS_URL = `${VENICE_API_V1_BASE}/embeddings`;

export const VENICE_IMAGE_GENERATION_URL = `${VENICE_API_V1_BASE}/image/generate`;

/**
 * Default cached catalog-refresh target. `type=all` is essential: media rows
 * must be visible to generation discovery while remaining workload-isolated
 * from chat routing. Overridable via `NAUTILO_VENICE_MODELS_URL`.
 */
export const VENICE_MODELS_LIST_URL = `${VENICE_API_V1_BASE}/models?type=all`;
