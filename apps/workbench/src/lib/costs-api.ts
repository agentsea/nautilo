import { apiClient } from "./api";
import { workbenchFetch } from "./admission-fetch";

/**
 * Costs dashboard (D405) — client types + fetch. Declared locally (Skills /
 * Connections pattern) so the browser bundle never imports from `@nautilo/db`.
 * All dollar amounts are USD; token counts are integers.
 */

export type CostsRangeKey = "7d" | "30d" | "90d";

export interface CostsTotals {
  calls: number;
  providerOperations: number;
  unknownProviderOperations: number;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  totalTokens: number;
  estimatedCostUsd: number;
  actualCostUsd: number;
  /** actual where known, else estimated — the headline spend. */
  totalCostUsd: number;
}

export interface CostsByModelRow {
  model: string;
  provider: string;
  displayName: string;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  estimatedCostUsd: number;
  actualCostUsd: number;
  totalCostUsd: number;
  /** True when this model reported real provider cost (OpenRouter/gateway). */
  hasActual: boolean;
  /**
   * True when at least one effective estimated row for this model used
   * coefficient/default fallback pricing stored on the row at insert time.
   */
  hasFallbackEstimate: boolean;
}

export interface CostsByCallTypeRow {
  callType: string;
  calls: number;
  totalCostUsd: number;
}

export interface CostsByProviderRow {
  provider: string;
  operation: string;
  operations: number;
  unknownOperations: number;
  estimatedCostUsd: number;
  actualCostUsd: number;
  totalCostUsd: number;
}

export interface CostsByUserRow {
  userId: string | null;
  handle: string | null;
  name: string | null;
  label: string;
  calls: number;
  providerOperations: number;
  unknownProviderOperations: number;
  totalTokens: number;
  estimatedCostUsd: number;
  actualCostUsd: number;
  totalCostUsd: number;
}

export interface CostsTimeSeriesPoint {
  day: string;
  estimatedCostUsd: number;
  actualCostUsd: number;
  totalCostUsd: number;
}

export interface CostsSummary {
  range: { since: string; until: string; key: string };
  pricingVersion: string;
  providerPricingVersion: string;
  providerCoverage: {
    state: "partial";
    accounted: Array<{ provider: string; operation: string }>;
    unavailable: string[];
  };
  totals: CostsTotals;
  byModel: CostsByModelRow[];
  byCallType: CostsByCallTypeRow[];
  byProvider: CostsByProviderRow[];
  byUser: CostsByUserRow[];
  timeSeries: CostsTimeSeriesPoint[];
}

function authHeaders(): HeadersInit {
  const token = apiClient.getToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

export async function fetchCostsSummary(range: CostsRangeKey): Promise<CostsSummary> {
  const res = await workbenchFetch(`/api/costs?range=${encodeURIComponent(range)}`, {
    headers: authHeaders(),
  });
  if (!res.ok) {
    let detail = "Failed to load costs";
    try {
      const json = (await res.json()) as { error?: string };
      if (json.error) detail = json.error;
    } catch {
      /* ignore */
    }
    throw new Error(detail);
  }
  return (await res.json()) as CostsSummary;
}
