import {
  isManagedGatewayKey,
  normalizeManagedGatewayBaseUrl,
  MANAGED_GATEWAY_API_KEY_ENV_VAR,
  MANAGED_GATEWAY_BASE_URL_ENV_VAR,
} from "@nautilo/config-guard/managed-gateway";

export {
  normalizeManagedGatewayBaseUrl,
  MANAGED_GATEWAY_API_KEY_ENV_VAR,
  MANAGED_GATEWAY_BASE_URL_ENV_VAR,
} from "@nautilo/config-guard/managed-gateway";

const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";

export type OpenRouterTransport = Readonly<{
  kind: "managed-gateway" | "openrouter";
  apiKey: string;
  baseUrl: string;
}>;

function nonEmpty(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function managedGatewayKeyIsPresent(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return nonEmpty(env[MANAGED_GATEWAY_API_KEY_ENV_VAR]) !== undefined;
}

/**
 * Resolve the transport for a signed `openrouter:*` catalog route.
 *
 * A present managed key is authoritative. Invalid managed configuration fails
 * closed and never falls through to a separately configured OpenRouter key.
 */
export function resolveOpenRouterTransport(options: Readonly<{
  env?: NodeJS.ProcessEnv;
  directApiKey?: unknown;
}> = {}): OpenRouterTransport | null {
  const env = options.env ?? process.env;
  const managedKey = nonEmpty(env[MANAGED_GATEWAY_API_KEY_ENV_VAR]);
  if (managedKey) {
    if (!isManagedGatewayKey(managedKey)) {
      throw new Error(`${MANAGED_GATEWAY_API_KEY_ENV_VAR} is malformed.`);
    }
    const baseUrl = normalizeManagedGatewayBaseUrl(env[MANAGED_GATEWAY_BASE_URL_ENV_VAR]);
    if (!baseUrl) {
      throw new Error(
        `${MANAGED_GATEWAY_BASE_URL_ENV_VAR} must be an HTTPS API root ending in /v1 `
        + "(HTTP is allowed only for localhost QA).",
      );
    }
    return { kind: "managed-gateway", apiKey: managedKey, baseUrl };
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

export function managedGatewayTransportIsRunnable(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  try {
    return resolveOpenRouterTransport({ env })?.kind === "managed-gateway";
  } catch {
    return false;
  }
}
