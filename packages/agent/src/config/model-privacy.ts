/** 10 = most private (local / on-prem / TEE); 1 = least (US hyperscaler API). */
export const MODEL_PRIVACY_GRADE: Record<string, number> = {
  // US hyperscaler first-party APIs
  "anthropic:claude-sonnet-4-6": 1,
  "anthropic:claude-sonnet-5": 1,
  "anthropic:claude-fable-5": 1,
  "anthropic:claude-opus-5": 1,
  "anthropic:claude-opus-4-8": 1,
  "anthropic:claude-opus-4-7": 1,
  "openai:gpt-5.5-2026-04-23": 1,
  "openai:gpt-5.4-2026-03-05": 1,
  "openai:gpt-5.6-sol": 1,
  "openai:gpt-5.6-terra": 1,
  "openai:gpt-5.6-luna": 1,
  "google:gemini-2.5-pro": 1,
  "google:gemini-3.1-pro-preview": 1,
  "google:gemini-3-flash-preview": 1,
  "google:gemini-3.1-flash-lite-preview": 1,

  // Open-weights via western inference hosts (Fireworks / OpenRouter)
  "fireworks:accounts/fireworks/models/kimi-k2p6": 4,
  "fireworks:accounts/fireworks/models/kimi-k3": 4,
  "openrouter:moonshotai/kimi-k2.6": 4,
  "fireworks:accounts/fireworks/models/glm-5p2": 4,
  "fireworks:accounts/fireworks/models/glm-5p1": 4,
  "openrouter:z-ai/glm-5.1": 4,
  "fireworks:accounts/fireworks/models/deepseek-v4-pro": 4,
  "fireworks:accounts/fireworks/models/deepseek-v4-pro-0813": 4,
  "fireworks:accounts/fireworks/models/deepseek-v4-flash-0731": 4,
  "openrouter:deepseek/deepseek-v4-pro": 4,
  "openrouter:deepseek/deepseek-v4-pro-0813": 4,
  "fireworks:accounts/fireworks/models/minimax-m3": 4,
  "openrouter:minimax/minimax-m2.7": 4,
  "openrouter:google/gemma-4-31b-it": 4,
  "openrouter:google/gemma-4-26b-a4b-it": 4,

  // Venice — venice-hosted (E2EE TEE = 10; others = 8)
  "venice:zai-org-glm-5-1": 8,
  "venice:e2ee-deepseek-v4-flash": 10,
  "venice:deepseek-v4-flash": 6,
  "venice:google-gemma-3-27b-it": 8,
  "venice:google-gemma-4-26b-a4b-it": 8,
  "venice:google-gemma-4-31b-it": 8,
  "venice:kimi-k3": 8,

  // Venice — western-anonymized
  "venice:deepseek-v4-pro": 6,
  "venice:minimax-m27": 6,
  "venice:claude-sonnet-4-6": 6,
  "venice:claude-opus-4-7": 6,
  "venice:gemini-3-1-pro-preview": 6,
  "venice:openai-gpt-55-pro": 6,

  // Venice — china-anonymized
  "venice:qwen-3-6-plus": 5,
};

export const DEFAULT_PRIVACY_GRADE = 1;

export function privacyGradeOf(modelId: string): number {
  return MODEL_PRIVACY_GRADE[modelId] ?? DEFAULT_PRIVACY_GRADE;
}
