import type { Configuration } from "../shared/config";
import type { ChatModel } from "../../../providers/types";
import { createUniversalModel } from "../../../providers/universal";
import { assertDeepResearchServerFunding } from "../shared/funding";

export type Provider = "openai" | "anthropic" | "google" | "fireworks" | "openrouter" | "xai" | "together" | "venice";

function guardPaidModel(model: ChatModel): ChatModel {
  return {
    invoke: async (messages, options) => {
      await assertDeepResearchServerFunding("deep_research_model_dispatch");
      return model.invoke(messages, options);
    },
    ...(model.stream ? {
      stream: async function* (messages, options) {
        await assertDeepResearchServerFunding("deep_research_model_dispatch");
        const chunks = await model.stream!(messages, options);
        yield* chunks;
      },
    } : {}),
    ...(model.bindTools ? {
      bindTools: (tools, options) => guardPaidModel(model.bindTools!(tools, options)),
    } : {}),
  };
}

function inferProvider(modelId: string): Provider {
  const id = modelId.toLowerCase();
  // Venice must short-circuit before any substring-based fallback, because
  // venice: IDs often contain substrings like "claude", "gpt", "grok", "kimi",
  // "qwen" that would otherwise route to the wrong provider + wrong API key.
  if (id.startsWith("venice:")) return "venice";
  if (id.startsWith("openrouter:")) return "openrouter";
  if (
    id.startsWith("fireworks:") ||
    id.includes("fireworks/") ||
    id.includes("accounts/fireworks/models") ||
    id.includes("kimi") ||
    id.includes("k2") ||
    id.includes("minimax") ||
    id.includes("qwen")
  ) {
    return "fireworks";
  }
  if (id.startsWith("together:") || id.includes("together.ai") || id.includes("together.xyz")) return "together";
  if (id.startsWith("openai:") || id.includes("gpt-")) return "openai";
  if (id.startsWith("anthropic:") || id.includes("claude")) return "anthropic";
  if (id.startsWith("google:") || id.includes("gemini")) return "google";
  if (id.startsWith("xai:") || id.includes("grok")) return "xai";
  return "openai";
}

function getApiKey(modelId: string, cfg: Configuration): string | undefined {
  const provider = inferProvider(modelId);
  switch (provider) {
    case "openai": return cfg.openai_api_key ?? process.env?.["OPENAI_API_KEY"];
    case "anthropic": return cfg.anthropic_api_key ?? process.env?.["ANTHROPIC_API_KEY"];
    case "google": return cfg.google_api_key ?? process.env?.["GOOGLE_API_KEY"];
    case "fireworks": return cfg.fireworks_api_key ?? process.env?.["FIREWORKS_API_KEY"];
    case "openrouter":
      return cfg.openrouter_api_key ?? process.env?.["OPENROUTER_API_KEY"];
    case "xai": return cfg.xai_api_key ?? process.env?.["XAI_API_KEY"];
    case "together": return cfg.together_api_key ?? process.env?.["TOGETHER_API_KEY"];
    case "venice": return cfg.venice_api_key ?? process.env?.["VENICE_API_KEY"];
    default: return undefined;
  }
}

function getBaseUrl(modelId: string, cfg: Configuration): string | undefined {
  const provider = inferProvider(modelId);
  const overrides = cfg.base_url_overrides;
  if (!overrides) return undefined;
  return (overrides[provider] ?? undefined);
}

export async function createModel(
  modelId: string,
  cfg: Configuration,
  options?: { maxTokens?: number | undefined },
): Promise<ChatModel> {
  await assertDeepResearchServerFunding("deep_research_model");
  const apiKey = getApiKey(modelId, cfg);
  const baseUrl = getBaseUrl(modelId, cfg);
  const opts: Record<string, unknown> = {};
  if (apiKey) opts["apiKey"] = apiKey;
  if (baseUrl) opts["baseURL"] = baseUrl;
  if (cfg.anthropic_long_context_beta) opts["anthropicLongContextBeta"] = true;
  if (options?.maxTokens !== undefined) opts["maxTokens"] = options.maxTokens;
  return guardPaidModel(await createUniversalModel(modelId, opts));
}
