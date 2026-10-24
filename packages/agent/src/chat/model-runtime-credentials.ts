import { hasRunnableOpenRouterTransport } from "../providers/openrouter-transport";

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
type CredentialBearingProviderPrefix = SupportedChatProviderPrefix | "typesafe";

function credentialProviderForModel(modelId: string): CredentialBearingProviderPrefix | null {
  const id = String(modelId || "").trim();
  if (!id) return null;
  const colon = id.indexOf(":");
  const prefix = colon >= 0 ? id.slice(0, colon).toLowerCase() : inferLegacyProvider(id);
  if (prefix === "typesafe" || (SUPPORTED_CHAT_PROVIDER_PREFIXES as readonly string[]).includes(prefix)) {
    return prefix as CredentialBearingProviderPrefix;
  }
  return null;
}

function credentialEnvNames(provider: CredentialBearingProviderPrefix): readonly string[] {
  switch (provider) {
    case "anthropic": return ["ANTHROPIC_API_KEY"];
    case "openai": return ["OPENAI_API_KEY"];
    case "openrouter": return ["OPENROUTER_API_KEY"];
    case "gateway": return ["NAUTILO_GATEWAY_API_KEY", "NAUTILO_GATEWAY_BASE_URL"];
    case "google": return ["GOOGLE_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "GEMINI_API_KEY"];
    case "xai": return ["XAI_API_KEY"];
    case "fireworks": return ["FIREWORKS_API_KEY"];
    case "together": return ["TOGETHER_API_KEY"];
    case "venice": return ["VENICE_API_KEY"];
    case "typesafe": return ["TYPESAFE_API_KEY"];
  }
}

function providerHasRunnableCredentials(
  provider: SupportedChatProviderPrefix,
  env: NodeJS.ProcessEnv,
): boolean {
  switch (provider) {
    case "anthropic":
      return !!trimEnv(env, "ANTHROPIC_API_KEY");
    case "openai":
      return !!trimEnv(env, "OPENAI_API_KEY");
    case "openrouter":
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
): boolean {
  const prefix = credentialProviderForModel(modelId);
  if (!prefix) return false;

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
      return providerHasRunnableCredentials(prefix, env);
  }
}

export interface ModelRunnableCredentialSnapshot {
  readonly modelId: string;
  readonly environment: readonly (readonly [string, string | undefined])[];
}

/** Freeze the exact environment binding used by one currently runnable direct model. */
export function captureModelRunnableCredentialSnapshot(
  modelId: string,
  env: NodeJS.ProcessEnv = process.env,
): ModelRunnableCredentialSnapshot | null {
  const provider = credentialProviderForModel(modelId);
  if (!provider || !modelHasRunnableCredentials(modelId, env)) return null;
  return Object.freeze({
    modelId,
    environment: Object.freeze(credentialEnvNames(provider)
      .map((name) => Object.freeze([name, env[name]] as const))),
  });
}

/** Confirm that no credential or endpoint involved in the captured direct route changed. */
export function isModelRunnableCredentialSnapshotCurrent(
  snapshot: ModelRunnableCredentialSnapshot,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return modelHasRunnableCredentials(snapshot.modelId, env)
    && snapshot.environment.every(([name, value]) => env[name] === value);
}
