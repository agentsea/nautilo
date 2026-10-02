const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";

export type OpenRouterTransport = Readonly<{
  kind: "openrouter";
  apiKey: string;
  baseUrl: string;
}>;

function nonEmpty(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/**
 * Resolve the transport for a signed `openrouter:*` catalog route.
 */
export function resolveOpenRouterTransport(options: Readonly<{
  env?: NodeJS.ProcessEnv;
  directApiKey?: unknown;
  personalApiKey?: unknown;
}> = {}): OpenRouterTransport | null {
  const env = options.env ?? process.env;
  if (Object.prototype.hasOwnProperty.call(options, "personalApiKey")) {
    const personalApiKey = nonEmpty(options.personalApiKey);
    if (!personalApiKey) {
      throw new Error("A valid personal OpenRouter credential is required.");
    }
    return {
      kind: "openrouter",
      apiKey: options.personalApiKey as string,
      baseUrl: OPENROUTER_BASE_URL,
    };
  }
  const directApiKey = nonEmpty(options.directApiKey) ?? nonEmpty(env["OPENROUTER_API_KEY"]);
  return directApiKey
    ? { kind: "openrouter", apiKey: directApiKey, baseUrl: OPENROUTER_BASE_URL }
    : null;
}

/** Credential-only admission check used by signed catalog selection. */
export function hasRunnableOpenRouterTransport(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  try {
    return resolveOpenRouterTransport({ env }) !== null;
  } catch {
    return false;
  }
}
