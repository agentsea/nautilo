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

export const MANAGED_GATEWAY_OUTCOME_UNKNOWN_ERROR_CODE =
  "managed_gateway_outcome_unknown" as const;

/**
 * Marks a managed Gateway request whose upstream acceptance/billing outcome
 * cannot be proved. Callers may surface the failure, but must not
 * automatically replay the model operation.
 */
export class ManagedGatewayOutcomeUnknownError extends Error {
  readonly code = MANAGED_GATEWAY_OUTCOME_UNKNOWN_ERROR_CODE;
  readonly status?: number;

  constructor(cause: unknown) {
    super(
      cause instanceof Error
        ? cause.message
        : "Managed Gateway request outcome is unknown.",
    );
    this.name = "ManagedGatewayOutcomeUnknownError";
    const status = cause && typeof cause === "object"
      ? (cause as { status?: unknown }).status
      : undefined;
    if (typeof status === "number") this.status = status;
  }
}

export function markManagedGatewayOutcomeUnknown(
  cause: unknown,
): ManagedGatewayOutcomeUnknownError {
  return cause instanceof ManagedGatewayOutcomeUnknownError
    ? cause
    : new ManagedGatewayOutcomeUnknownError(cause);
}

export function isManagedGatewayOutcomeUnknownError(
  error: unknown,
): error is ManagedGatewayOutcomeUnknownError {
  return error instanceof ManagedGatewayOutcomeUnknownError
    || (
      error !== null
      && typeof error === "object"
      && (error as { code?: unknown }).code
        === MANAGED_GATEWAY_OUTCOME_UNKNOWN_ERROR_CODE
    );
}

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
