import type { PersonalCostsSummary } from "@nautilo/api-client/browser";
import type {
  CostsByModelRow,
  CostsRangeKey,
  CostsSummary,
} from "../../lib/costs-api";
import type { NormalizedCostsDashboard } from "./costs-dashboard";

/** Per-model bar row input — same shape as the costs API `byModel` entry. */
export type CostsModelBarInput = CostsByModelRow;

export const MODEL_BADGE_ACTUAL = "actual" as const;
export const MODEL_BADGE_FALLBACK_ESTIMATE = "fallback estimate" as const;
export const MODEL_BADGE_PENDING = "pending cost" as const;
export const MODEL_BADGE_UNKNOWN = "unknown cost" as const;

export type ModelCostBadge =
  | typeof MODEL_BADGE_ACTUAL
  | typeof MODEL_BADGE_FALLBACK_ESTIMATE
  | typeof MODEL_BADGE_PENDING
  | typeof MODEL_BADGE_UNKNOWN;

export interface ModelCostBarRow {
  key: string;
  label: string;
  /** Display name plus raw model id for diagnosis. */
  title: string;
  amount: number;
  badges: ModelCostBadge[];
}

/**
 * Badges for a model aggregate row. `actual` is unchanged; fallback disclosure
 * appears even when some calls on the same model also reported actual cost.
 */
export function modelRowBadges(
  row: Pick<CostsModelBarInput, "hasActual" | "hasFallbackEstimate"> &
    Partial<Pick<CostsModelBarInput, "pendingAttempts" | "unknownAttempts">>,
): ModelCostBadge[] {
  const badges: ModelCostBadge[] = [];
  if (row.hasActual) badges.push(MODEL_BADGE_ACTUAL);
  if (row.hasFallbackEstimate) badges.push(MODEL_BADGE_FALLBACK_ESTIMATE);
  if ((row.pendingAttempts ?? 0) > 0) badges.push(MODEL_BADGE_PENDING);
  if ((row.unknownAttempts ?? 0) > 0) badges.push(MODEL_BADGE_UNKNOWN);
  return badges;
}

/** Tooltip/title text keeps the raw model id alongside the display name. */
export function modelRowTitle(
  row: Pick<CostsModelBarInput, "model" | "displayName">,
): string {
  return `${row.displayName} (${row.model})`;
}

/** Maps every API model row — no silent truncation. */
export function buildModelBarRows(
  byModel: CostsModelBarInput[],
): ModelCostBarRow[] {
  return byModel.map((m) => ({
    key: m.model,
    label: m.displayName,
    title: modelRowTitle(m),
    amount: m.totalCostUsd,
    badges: modelRowBadges(m),
  }));
}

export const RANGE_OPTIONS: { key: CostsRangeKey; label: string }[] = [
  { key: "7d", label: "Last 7 days" },
  { key: "30d", label: "Last 30 days" },
  { key: "90d", label: "Last 90 days" },
];

const USD = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

const COMPACT = new Intl.NumberFormat("en-US", {
  notation: "compact",
  maximumFractionDigits: 1,
});

const INT = new Intl.NumberFormat("en-US");

/** `$1,284.57`; tiny positive amounts collapse to `<$0.01` so they don't read as $0.00. */
export function formatUsd(value: number): string {
  if (value > 0 && value < 0.005) return "<$0.01";
  return USD.format(value);
}

/** Compact token/number formatting: `412.9M`, `1.2K`. */
export function formatCompact(value: number): string {
  return COMPACT.format(value);
}

export function formatInt(value: number): string {
  return INT.format(Math.round(value));
}

const MEASURED_UNITS = new Intl.NumberFormat("en-US", {
  maximumFractionDigits: 8,
});

export function formatMeasuredUsage(
  measuredUnits: number | null | undefined,
  unitType: string | null | undefined,
): string | null {
  return measuredUnits === null || measuredUnits === undefined || !unitType
    ? null
    : `${MEASURED_UNITS.format(measuredUnits)} ${unitType === "cloudconvert_credit" ? "credits" : unitType}`;
}

export function formatPercent(part: number, whole: number): string {
  if (whole <= 0) return "0%";
  const pct = (part / whole) * 100;
  if (pct > 0 && pct < 1) return "<1%";
  return `${Math.round(pct)}%`;
}

const CALL_TYPE_LABELS: Record<string, string> = {
  chat: "Chat",
  decision: "Decision",
  deep_research: "Deep research",
  subagent: "Subagents",
  conductor: "Conductor",
  room_stenographer: "Room stenographer",
  room_reflection: "Room Reflection / Sleep",
  room_event_compaction: "Room event compaction",
  embedding: "Embeddings",
  image_gen: "Image generation",
  memory_flush: "Memory flush",
  memory_review: "Memory review",
  web_search: "Web search",
  session_search: "Session search",
  title: "Title generation",
  capability_probe: "Capability probes",
  soul: "Soul generation",
  other: "Other",
};

export function callTypeLabel(callType: string): string {
  return CALL_TYPE_LABELS[callType] ?? callType;
}

/** Short axis label for a `YYYY-MM-DD` day, e.g. `Jul 9`. */
export function formatDayShort(day: string): string {
  const d = new Date(`${day}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return day;
  return d.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

export function normalizeAdminCosts(
  data: CostsSummary,
): NormalizedCostsDashboard {
  return {
    totals: {
      ...data.totals,
      // Admin's stored estimate is historical and can remain on rows that later
      // received an actual charge. The headline needs the mutually exclusive
      // current estimate so actual + estimate reconciles to known spend.
      estimatedCostUsd: Math.max(
        0,
        data.totals.totalCostUsd - data.totals.actualCostUsd,
      ),
      unresolvedModelAttempts:
        data.totals.pendingModelAttempts + data.totals.unknownModelAttempts,
    },
    byModel: buildModelBarRows(data.byModel),
    byCallType: data.byCallType,
    byProvider: normalizeProviderCosts(data.byProvider),
    timeSeries: data.timeSeries,
  };
}

export function normalizePersonalCosts(
  data: PersonalCostsSummary,
): NormalizedCostsDashboard {
  const totals = data.totals as PersonalCostsSummary["totals"] & {
    unknownProviderOperations?: number;
  };
  return {
    totals: {
      ...totals,
      unknownProviderOperations: totals.unknownProviderOperations ?? 0,
      unresolvedModelAttempts:
        data.recovery.pendingAttempts + data.recovery.unknownAttempts,
    },
    byModel: buildModelBarRows(data.byModel),
    byCallType: data.byCallType,
    byProvider: normalizeProviderCosts(data.byProvider),
    timeSeries: data.timeSeries,
  };
}

function normalizeProviderCosts(
  rows: Array<{
    provider: string;
    operation: string;
    operations: number;
    unknownOperations?: number;
    measuredUnits?: number | null;
    unitType?: string | null;
    estimatedCostUsd?: number;
    actualCostUsd?: number;
    totalCostUsd: number;
  }>,
): NormalizedCostsDashboard["byProvider"] {
  return rows.map((row) => ({
    ...row,
    unknownOperations: row.unknownOperations ?? 0,
    measuredUnits: row.measuredUnits ?? null,
    unitType: row.unitType ?? null,
    estimatedCostUsd: row.estimatedCostUsd ?? 0,
    actualCostUsd: row.actualCostUsd ?? 0,
  }));
}
