import { getAllKeyDefinitions } from "./key-registry";
import type { KeyReport } from "./types";

/** Same LLM-category registry used by `buildSummary()` and setup-state derivation. */
const LLM_KEY_IDS = new Set(
  getAllKeyDefinitions()
    .filter((d) => d.category === "llm" || d.category === "llm+embeddings")
    .map((d) => d.id),
);

/**
 * True when at least one LLM provider key is present or verified.
 * Shared by `@nautilo/api-client` and server setup-state derivation (D112).
 */
export function computeHasLlmFromKeys(keys: KeyReport[]): boolean {
  return keys.some(
    (k) =>
      LLM_KEY_IDS.has(k.id) && (k.status === "present" || k.status === "verified"),
  );
}
