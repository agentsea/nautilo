/**
 * Legacy prefix helpers remain exported for migration/read compatibility.
 * New selections are signed-catalog-only; callers supply the active catalog
 * ids and perform credential/capability validation separately.
 */
export const SUPPORTED_MODEL_PREFIXES = [
  "anthropic:",
  "openai:",
  "google:",
  "xai:",
  "fireworks:",
  "openrouter:",
  "together:",
  "venice:",
] as const;

export function normalizeProfileDefaultModel(value: string | null | undefined): string | null {
  if (value === undefined || value === null) return null;
  const t = value.trim();
  return t.length === 0 ? null : t;
}

export function isSupportedRoutedModelId(modelId: string): boolean {
  const normalized = modelId.trim().toLowerCase();
  return SUPPORTED_MODEL_PREFIXES.some((prefix) => normalized.startsWith(prefix));
}

export function assertProfileDefaultModelAllowed(
  modelId: string | null,
  catalogIds: ReadonlySet<string>,
): void {
  if (modelId === null) return;
  if (catalogIds.has(modelId)) return;
  throw new Error(
    "Invalid defaultModel: use null or a model id from the active signed catalog.",
  );
}
