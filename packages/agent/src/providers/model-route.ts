export type ModelFamily = "openai" | "anthropic" | "google" | "unknown";

export function modelRouteProvider(modelId: string): string {
  return modelId.includes(":")
    ? (modelId.split(":", 1)[0]?.toLowerCase() ?? "unknown")
    : "unknown";
}

/** Behavior shared by adapters using OpenAI chat-completions wire semantics. */
export function usesOpenAICompatibleChatTransport(modelId: string): boolean {
  return ["openai", "openrouter", "gateway", "venice"].includes(
    modelRouteProvider(modelId),
  );
}

/**
 * Underlying family is separate from route transport. Keep family-specific
 * behavior behind this seam instead of branching on route prefixes.
 */
export function resolveUnderlyingModelFamily(modelId: string): ModelFamily {
  const provider = modelRouteProvider(modelId);
  if (provider === "openai" || provider === "anthropic" || provider === "google") {
    return provider;
  }
  const routeSlug = modelId.slice(modelId.indexOf(":") + 1).toLowerCase();
  if (provider === "openrouter") {
    const upstream = routeSlug.split("/", 1)[0];
    if (upstream === "openai" || upstream === "anthropic" || upstream === "google") {
      return upstream;
    }
  }
  if (routeSlug.includes("claude")) return "anthropic";
  if (routeSlug.includes("gemini")) return "google";
  if (routeSlug.includes("gpt") || routeSlug.includes("openai")) return "openai";
  return "unknown";
}
