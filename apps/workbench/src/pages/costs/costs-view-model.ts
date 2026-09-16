import type { CostsByModelRow, CostsRangeKey } from "../../lib/costs-api";

/** Per-model bar row input — same shape as the costs API `byModel` entry. */
export type CostsModelBarInput = CostsByModelRow;

export const MODEL_BADGE_ACTUAL = "actual" as const;
export const MODEL_BADGE_FALLBACK_ESTIMATE = "fallback estimate" as const;

export type ModelCostBadge = typeof MODEL_BADGE_ACTUAL | typeof MODEL_BADGE_FALLBACK_ESTIMATE;

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
  row: Pick<CostsModelBarInput, "hasActual" | "hasFallbackEstimate">,
): ModelCostBadge[] {
  const badges: ModelCostBadge[] = [];
  if (row.hasActual) badges.push(MODEL_BADGE_ACTUAL);
  if (row.hasFallbackEstimate) badges.push(MODEL_BADGE_FALLBACK_ESTIMATE);
  return badges;
}

/** Tooltip/title text keeps the raw model id alongside the display name. */
export function modelRowTitle(row: Pick<CostsModelBarInput, "model" | "displayName">): string {
  return `${row.displayName} (${row.model})`;
}

/** Maps every API model row — no silent truncation. */
export function buildModelBarRows(byModel: CostsModelBarInput[]): ModelCostBarRow[] {
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

export function formatPercent(part: number, whole: number): string {
  if (whole <= 0) return "0%";
  const pct = (part / whole) * 100;
  if (pct > 0 && pct < 1) return "<1%";
  return `${Math.round(pct)}%`;
}

const CALL_TYPE_LABELS: Record<string, string> = {
  chat: "Chat",
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
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}
