import { hasRunnableOpenRouterTransport } from "../providers/openrouter-transport";
import type { ResolvedCatalogModel } from "@nautilo/trust";

/**
 * Best-effort check that a model id is likely invokable in the current process
 * (API keys / gateway URL present). Mirrors `createUniversalModel` provider branches.
 */
function trimEnv(env: NodeJS.ProcessEnv, key: string): string | undefined {
  const v = env[key]?.trim();
  return v && v.length > 0 ? v : undefined;
}

function inferLegacyProvider(modelId: string): "anthropic" | "openai" | "google" {
  const low = modelId.toLowerCase();
  if (low.includes("claude")) return "anthropic";
  if (low.includes("gemini")) return "google";
  return "openai";
}

const SUPPORTED_CHAT_PROVIDER_PREFIXES = [
  "anthropic",
  "openai",
  "openrouter",
  "gateway",
  "google",
  "xai",
  "fireworks",
  "together",
  "venice",
] as const;

type SupportedChatProviderPrefix = (typeof SUPPORTED_CHAT_PROVIDER_PREFIXES)[number];

function providerHasRunnableCredentials(
  provider: SupportedChatProviderPrefix,
  env: NodeJS.ProcessEnv,
  workload: ResolvedCatalogModel["workload"] = "chat",
): boolean {
  switch (provider) {
    case "anthropic":
      return !!trimEnv(env, "ANTHROPIC_API_KEY");
    case "openai":
      return !!trimEnv(env, "OPENAI_API_KEY");
    case "openrouter":
      // The managed Gateway currently exposes OpenRouter-compatible text and
      // embedding routes only. Generation remains a direct-provider workload,
      // so managed configuration must neither admit it nor shadow a direct key.
      if (workload === "generation") {
        return !!trimEnv(env, "OPENROUTER_API_KEY");
      }
      return hasRunnableOpenRouterTransport(env);
    case "gateway":
      return !!(
        trimEnv(env, "NAUTILO_GATEWAY_API_KEY") &&
        trimEnv(env, "NAUTILO_GATEWAY_BASE_URL")
      );
    case "google":
      return !!(
        trimEnv(env, "GOOGLE_API_KEY") ??
        trimEnv(env, "GOOGLE_GENERATIVE_AI_API_KEY") ??
        trimEnv(env, "GEMINI_API_KEY")
      );
    case "xai":
      return !!trimEnv(env, "XAI_API_KEY");
    case "fireworks":
      return !!trimEnv(env, "FIREWORKS_API_KEY");
    case "together":
      return !!trimEnv(env, "TOGETHER_API_KEY");
    case "venice":
      return !!trimEnv(env, "VENICE_API_KEY");
  }
}

/**
 * Returns true when the environment can authenticate at least one chat
 * provider implemented by `createUniversalModel`.
 *
 * This is deliberately narrower than product readiness: embeddings, search,
 * voice, and conversion credentials do not satisfy chat admission.
 */
export function hasRunnableChatProviderCredentials(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return SUPPORTED_CHAT_PROVIDER_PREFIXES.some((provider) =>
    providerHasRunnableCredentials(provider, env),
  );
}

/**
 * @returns true when required credentials for this model's provider appear present.
 */
export function modelHasRunnableCredentials(
  modelId: string,
  env: NodeJS.ProcessEnv = process.env,
  workload: ResolvedCatalogModel["workload"] = "chat",
): boolean {
  const id = String(modelId || "").trim();
  if (!id) return false;

  const colon = id.indexOf(":");
  const prefix = colon >= 0 ? id.slice(0, colon).toLowerCase() : inferLegacyProvider(id);

  switch (prefix) {
    case "typesafe":
      return !!trimEnv(env, "TYPESAFE_API_KEY");
    case "anthropic":
    case "openai":
    case "openrouter":
    case "gateway":
    case "google":
    case "xai":
    case "fireworks":
    case "together":
    case "venice":
      return providerHasRunnableCredentials(prefix, env, workload);
    default:
      // Unknown explicit prefixes are not routable until the provider registry knows them.
      return false;
  }
}
