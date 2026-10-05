export const PERSONAL_COSTS_RANGE_KEYS = ["7d", "30d", "90d"] as const;

export type PersonalCostsRangeKey = (typeof PERSONAL_COSTS_RANGE_KEYS)[number];

export interface PersonalCostsEntryState {
  available: boolean;
  hasPersonalCredentials: boolean;
  hasHistory: boolean;
}

export interface PersonalCostsTotals {
  calls: number;
  providerOperations: number;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  totalTokens: number;
  estimatedCostUsd: number;
  actualCostUsd: number;
  totalCostUsd: number;
  pendingAttempts: number;
  unknownAttempts: number;
  retryableAttempts: number;
  blockedAttempts: number;
}

export interface PersonalCostsByModelRow {
  model: string;
  provider: string;
  displayName: string;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  estimatedCostUsd: number;
  actualCostUsd: number;
  totalCostUsd: number;
  hasActual: boolean;
  hasFallbackEstimate: boolean;
  pendingAttempts: number;
  unknownAttempts: number;
  blockedAttempts: number;
}

export interface PersonalCostsByCallTypeRow {
  callType: string;
  calls: number;
  totalCostUsd: number;
}

export interface PersonalCostsByProviderRow {
  provider: string;
  operation: string;
  operations: number;
  unknownOperations: number;
  estimatedCostUsd: number;
  actualCostUsd: number;
  totalCostUsd: number;
}

export interface PersonalCostsTimeSeriesPoint {
  /** UTC calendar day in YYYY-MM-DD form. */
  day: string;
  estimatedCostUsd: number;
  actualCostUsd: number;
  totalCostUsd: number;
}

export interface PersonalCostsRecoverySummary {
  pendingAttempts: number;
  retryableAttempts: number;
  blockedAttempts: number;
  unknownAttempts: number;
}

export interface PersonalCostsSummary {
  currency: "USD";
  range: {
    key: PersonalCostsRangeKey;
    since: string;
    until: string;
  };
  pricingVersion: string;
  entry: PersonalCostsEntryState;
  totals: PersonalCostsTotals;
  byModel: PersonalCostsByModelRow[];
  byCallType: PersonalCostsByCallTypeRow[];
  byProvider: PersonalCostsByProviderRow[];
  timeSeries: PersonalCostsTimeSeriesPoint[];
  recovery: PersonalCostsRecoverySummary;
}
