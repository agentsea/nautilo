import type { AssistantModelSummary } from "@nautilo/api-client/browser";

/** Keep aligned with `SUPPORTED_MODEL_PREFIXES` in `@nautilo/agent` `config/model-id-validation.ts`. */

const PROVIDER_ORDER = [
  "anthropic",
  "openai",
  "google",
  "fireworks",
  "openrouter",
  "venice",
] as const;

const PROVIDER_GROUP_LABELS: Record<string, string> = {
  anthropic: "Anthropic",
  openai: "OpenAI",
  google: "Google",
  fireworks: "Fireworks",
  openrouter: "OpenRouter",
  together: "Together",
  xai: "xAI",
  venice: "Venice",
  unknown: "Unknown",
};

const SUPPORTED_MODEL_PREFIXES = [
  "anthropic:",
  "openai:",
  "google:",
  "xai:",
  "fireworks:",
  "openrouter:",
  "together:",
  "venice:",
] as const;

export function formatProviderGroupLabel(providerKey: string): string {
  return (
    PROVIDER_GROUP_LABELS[providerKey] ??
    (providerKey.charAt(0).toUpperCase() + providerKey.slice(1))
  );
}
/**
 * First segment of `provider:rest` model ids — mirrors
 * `getProviderFromModelId` in `@nautilo/agent` (Workbench does not depend on
 * that package; keep behavior aligned for consistent grouping vs catalog).
 */
export function providerFromModelId(modelId: string): string {
  if (!modelId || !modelId.includes(":")) return "unknown";
  return modelId.split(":")[0] || "unknown";
}

export function isSupportedCustomModelId(modelId: string): boolean {
  const normalized = modelId.trim().toLowerCase();
  return SUPPORTED_MODEL_PREFIXES.some((prefix) => normalized.startsWith(prefix));
}

function sortProviderKeys(a: string, b: string): number {
  const ia = PROVIDER_ORDER.indexOf(a as (typeof PROVIDER_ORDER)[number]);
  const ib = PROVIDER_ORDER.indexOf(b as (typeof PROVIDER_ORDER)[number]);
  if (ia !== -1 || ib !== -1) {
    if (ia === -1) return 1;
    if (ib === -1) return -1;
    return ia - ib;
  }
  return a.localeCompare(b);
}

export function groupModelsByProvider(
  models: readonly AssistantModelSummary[],
): { provider: string; items: AssistantModelSummary[] }[] {
  const map = new Map<string, AssistantModelSummary[]>();
  for (const m of models) {
    const p = providerFromModelId(m.id);
    const list = map.get(p);
    if (list) list.push(m);
    else map.set(p, [m]);
  }
  for (const items of map.values()) {
    items.sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id));
  }
  return [...map.keys()]
    .sort(sortProviderKeys)
    .map((provider) => ({ provider, items: map.get(provider)! }));
}

export function filterModels(
  models: readonly AssistantModelSummary[],
  query: string,
): AssistantModelSummary[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...models];
  return models.filter(
    (m) =>
      m.displayName.toLowerCase().includes(q) ||
      m.id.toLowerCase().includes(q) ||
      providerFromModelId(m.id).toLowerCase().includes(q) ||
      formatProviderGroupLabel(providerFromModelId(m.id)).toLowerCase().includes(q),
  );
}

export function formatCostCoefficient(c: number): string {
  if (typeof c !== "number" || Number.isNaN(c)) return "?";
  return Number.isInteger(c) ? String(c) : c.toFixed(1);
}

/** Plain labels for D086 Venice routing (Workbench badges). */
function formatVeniceRoutingBadge(
  routing: AssistantModelSummary["routing"],
): string | null {
  switch (routing) {
    case "venice-hosted":
      return "Hosted";
    case "western-anonymized":
      return "Western anonymized";
    case "china-anonymized":
      return "China anonymized";
    default:
      return null;
  }
}

/** Compact capability tags from enriched `/api/config/models` payload. */
export function formatModelCapabilityBadges(m: AssistantModelSummary): string[] {
  const badges: string[] = [];
  const r = formatVeniceRoutingBadge(m.routing);
  if (r) badges.push(r);
  const c = m.capabilities;
  if (!c) return badges;
  if (c.tools) badges.push("Tools");
  if (c.vision) badges.push("Vision");
  if (c.reasoning) badges.push("Reasoning");
  if (c.e2ee) badges.push("E2EE");
  if (c.webSearch) badges.push("Web search");
  return badges;
}

/** D331 — reasoning-capable catalog models may expose the operator off-switch. */
export function modelHasReasoningCapability(m: AssistantModelSummary): boolean {
  return m.capabilities?.reasoning === true;
}

/** D331 — absent key defaults ON (operator opt-out only). */
export function resolveStreamReasoningEnabled(
  reasoningOutput: Readonly<Record<string, boolean>>,
  modelId: string,
): boolean {
  return reasoningOutput[modelId] ?? true;
}

/** Merge one model's stream-reasoning toggle into the server config map. */
export function patchReasoningOutputMap(
  current: Readonly<Record<string, boolean>>,
  modelId: string,
  enabled: boolean,
): Record<string, boolean> {
  if (enabled) {
    const next = { ...current };
    delete next[modelId];
    return next;
  }
  return { ...current, [modelId]: false };
}
