import { getAllKeyDefinitions } from "./key-registry";
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
 * True when at least one LLM provider key is present or verified.
 * Used by server setup-state derivation and config-guard summaries.
 */
export function computeHasLlmFromKeys(
  keys: KeyReport[],
): boolean {
  return keys.some((key) => LLM_KEY_IDS.has(key.id) && keyIsConfigured(key));
}
