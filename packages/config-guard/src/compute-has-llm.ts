import { getAllKeyDefinitions } from "./key-registry";
import {
  isManagedGatewayKey,
  MANAGED_GATEWAY_API_KEY_ENV_VAR,
  MANAGED_GATEWAY_BASE_URL_ENV_VAR,
  normalizeManagedGatewayBaseUrl,
} from "./managed-gateway";
import type { KeyReport } from "./types";

/** Same LLM-category registry used by `buildSummary()` and setup-state derivation. */
const LLM_KEY_IDS = new Set(
  getAllKeyDefinitions()
    .filter((d) => d.category === "llm" || d.category === "llm+embeddings")
    .map((d) => d.id),
);

function keyIsConfigured(key: KeyReport | undefined): boolean {
  return key?.status === "present" || key?.status === "verified";
}

/**
 * The managed Gateway is one runtime credential split across two settings.
 * A valid-looking key alone must not make setup ready when every request would
 * be rejected because its API root is missing or invalid.
 */
export function managedGatewayIsConfigured(
  keys: KeyReport[],
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return keyIsConfigured(keys.find((key) => key.id === "nautilo-gateway"))
    && isManagedGatewayKey(env[MANAGED_GATEWAY_API_KEY_ENV_VAR])
    && normalizeManagedGatewayBaseUrl(env[MANAGED_GATEWAY_BASE_URL_ENV_VAR]) !== null;
}

/**
 * True when at least one LLM provider key is present or verified.
 * Used by server setup-state derivation and config-guard summaries.
 */
export function computeHasLlmFromKeys(
  keys: KeyReport[],
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return keys.some(
    (k) =>
      k.id !== "nautilo-gateway"
      && LLM_KEY_IDS.has(k.id)
      && keyIsConfigured(k),
  ) || managedGatewayIsConfigured(keys, env);
}
