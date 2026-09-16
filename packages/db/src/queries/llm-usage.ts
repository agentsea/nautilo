import { and, asc, desc, eq, gte, lt, sql } from "drizzle-orm";
import { llmUsageEvents } from "../schema/llm-usage";
import { users } from "../schema/users";
import { getSharedDirectDb } from "../config/direct-database";
import type { DirectDatabase } from "../config/direct-database";
import { buildProviderCostsSummaryQueries } from "./provider-costs";

let _dbOverride: DirectDatabase | null = null;

function db() {
  return _dbOverride ?? getSharedDirectDb();
}

/** @internal test seam — inject a drizzle handle so unit tests avoid a real pool. */
export function __setLlmUsageDbForTests(handle: unknown): void {
  _dbOverride = handle as DirectDatabase;
}

export interface InsertLlmUsageInput {
  occurredAt?: Date;
  userId?: string | null;
  roomId?: string | null;
  callType: string;
  provider: string;
  model: string;
  inputTokens?: number;
  outputTokens?: number;
  reasoningTokens?: number;
  cachedInputTokens?: number;
  totalTokens?: number;
  estimatedCostUsd: number;
  actualCostUsd?: number | null;
  pricingVersion?: string | null;
  metadata?: Record<string, unknown> | null;
}

/** numeric(14,8) columns take strings in drizzle; keep 8 dp of precision. */
function toNumeric(n: number): string {
  return (Number.isFinite(n) ? n : 0).toFixed(8);
}

export async function insertLlmUsageEvent(input: InsertLlmUsageInput): Promise<void> {
  const inputTokens = Math.max(0, Math.round(input.inputTokens ?? 0));
  const outputTokens = Math.max(0, Math.round(input.outputTokens ?? 0));
  const totalTokens =
    input.totalTokens !== undefined
      ? Math.max(0, Math.round(input.totalTokens))
      : inputTokens + outputTokens;

  await db()
    .insert(llmUsageEvents)
    .values({
      ...(input.occurredAt ? { occurredAt: input.occurredAt } : {}),
      userId: input.userId ?? null,
      roomId: input.roomId ?? null,
      callType: input.callType,
      provider: input.provider,
      model: input.model,
      inputTokens,
      outputTokens,
      reasoningTokens: Math.max(0, Math.round(input.reasoningTokens ?? 0)),
      cachedInputTokens: Math.max(0, Math.round(input.cachedInputTokens ?? 0)),
      totalTokens,
      estimatedCostUsd: toNumeric(input.estimatedCostUsd),
      actualCostUsd:
        input.actualCostUsd === undefined || input.actualCostUsd === null
          ? null
          : toNumeric(input.actualCostUsd),
      pricingVersion: input.pricingVersion ?? null,
      metadata: input.metadata ?? null,
    });
}

// ---------------------------------------------------------------------------
// Costs dashboard aggregations (D405)
// ---------------------------------------------------------------------------

export interface CostsRange {
  sinceIso: string;
  untilIso: string;
}

export interface CostsTotals {
  /** Model/API calls represented by llm_usage_events. */
  calls: number;
  /** Paid non-model operations represented by provider_cost_events. */
  providerOperations: number;
  /** Provider operations with no actual or frozen estimated amount. */
  unknownProviderOperations: number;
  inputTokens: number;
  /** Cache-read input tokens (subset of inputTokens). 0 when caching is off. */
  cachedInputTokens: number;
  outputTokens: number;
  totalTokens: number;
  estimatedCostUsd: number;
  /** Sum of provider-reported actual cost (subset of rows). */
  actualCostUsd: number;
  /** actual where known, else estimated — the headline "total spend". */
  totalCostUsd: number;
}

export interface CostsByModelRow {
  model: string;
  provider: string;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  estimatedCostUsd: number;
  actualCostUsd: number;
  totalCostUsd: number;
  /** True when any row for this model carried a provider-reported cost. */
  hasActual: boolean;
  /**
   * True when at least one effective estimated row (no provider actual cost)
   * was frozen using coefficient/default fallback pricing stored on the row.
   * Legacy rows without `metadata.usagePricingSource` do not set this.
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
  calls: number;
  providerOperations: number;
  unknownProviderOperations: number;
  totalTokens: number;
  estimatedCostUsd: number;
  actualCostUsd: number;
  totalCostUsd: number;
}

export interface CostsTimeSeriesPoint {
  /** UTC day, `YYYY-MM-DD`. */
  day: string;
  estimatedCostUsd: number;
  actualCostUsd: number;
  totalCostUsd: number;
}

export interface CostsSummary {
  range: CostsRange;
  totals: CostsTotals;
  byModel: CostsByModelRow[];
  byCallType: CostsByCallTypeRow[];
  byProvider: CostsByProviderRow[];
  byUser: CostsByUserRow[];
  timeSeries: CostsTimeSeriesPoint[];
}

function n(v: unknown): number {
  const parsed = typeof v === "number" ? v : Number(v ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

/** Text column → string | null (guards eslint no-base-to-string on unknown). */
function s(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

/**
 * `actual where known, else estimated` cost expression, per row. This is the
 * "total spend" convention used everywhere in the dashboard.
 */
const EFFECTIVE_COST = sql`COALESCE(${llmUsageEvents.actualCostUsd}, ${llmUsageEvents.estimatedCostUsd})`;

/** Stored metadata sources written by ISSUE-M217 forward-only metering. */
const FALLBACK_PRICING_SOURCES = sql.raw(
  "'catalog_coefficient', 'baseline_default', 'image_default'",
);

/**
 * A row counts toward fallback disclosure only when its effective cost is the
 * frozen estimate (no provider actual) and the stored metadata says the
 * estimate used coefficient/default pricing — never the current catalog.
 */
const ROW_HAS_FALLBACK_ESTIMATE = sql`
  ${llmUsageEvents.actualCostUsd} IS NULL
  AND (${llmUsageEvents.metadata}->>'usagePricingSource') IN (${FALLBACK_PRICING_SOURCES})
`;

export function buildCostsSummaryQueries(
  range: CostsRange,
  handle: Pick<DirectDatabase, "select">,
) {
  const inWindow = and(
    gte(llmUsageEvents.occurredAt, new Date(range.sinceIso)),
    lt(llmUsageEvents.occurredAt, new Date(range.untilIso)),
  );

  const totals = handle
    .select({
      calls: sql<number>`COUNT(*)::int`,
      input_tokens:
        sql<number>`COALESCE(SUM(${llmUsageEvents.inputTokens}), 0)::bigint`,
      cached_input_tokens:
        sql<number>`COALESCE(SUM(${llmUsageEvents.cachedInputTokens}), 0)::bigint`,
      output_tokens:
        sql<number>`COALESCE(SUM(${llmUsageEvents.outputTokens}), 0)::bigint`,
      total_tokens:
        sql<number>`COALESCE(SUM(${llmUsageEvents.totalTokens}), 0)::bigint`,
      estimated_cost:
        sql<string>`COALESCE(SUM(${llmUsageEvents.estimatedCostUsd}), 0)`,
      actual_cost:
        sql<string>`COALESCE(SUM(${llmUsageEvents.actualCostUsd}), 0)`,
      total_cost: sql<string>`COALESCE(SUM(${EFFECTIVE_COST}), 0)`,
    })
    .from(llmUsageEvents)
    .where(inWindow);

  const byModel = handle
    .select({
      model: llmUsageEvents.model,
      provider: llmUsageEvents.provider,
      calls: sql<number>`COUNT(*)::int`,
      input_tokens:
        sql<number>`COALESCE(SUM(${llmUsageEvents.inputTokens}), 0)::bigint`,
      output_tokens:
        sql<number>`COALESCE(SUM(${llmUsageEvents.outputTokens}), 0)::bigint`,
      estimated_cost:
        sql<string>`COALESCE(SUM(${llmUsageEvents.estimatedCostUsd}), 0)`,
      actual_cost:
        sql<string>`COALESCE(SUM(${llmUsageEvents.actualCostUsd}), 0)`,
      total_cost:
        sql<string>`COALESCE(SUM(${EFFECTIVE_COST}), 0)`.as("total_cost"),
      has_actual:
        sql<boolean>`BOOL_OR(${llmUsageEvents.actualCostUsd} IS NOT NULL)`.as(
          "has_actual",
        ),
      has_fallback_estimate:
        sql<boolean>`BOOL_OR(${ROW_HAS_FALLBACK_ESTIMATE})`.as(
          "has_fallback_estimate",
        ),
    })
    .from(llmUsageEvents)
    .where(inWindow)
    .groupBy(llmUsageEvents.model, llmUsageEvents.provider)
    .orderBy(({ total_cost }) => desc(total_cost));

  const byCallType = handle
    .select({
      call_type: llmUsageEvents.callType,
      calls: sql<number>`COUNT(*)::int`,
      total_cost:
        sql<string>`COALESCE(SUM(${EFFECTIVE_COST}), 0)`.as("total_cost"),
    })
    .from(llmUsageEvents)
    .where(inWindow)
    .groupBy(llmUsageEvents.callType)
    .orderBy(({ total_cost }) => desc(total_cost));

  const userCosts = handle
    .select({
      user_id: llmUsageEvents.userId,
      calls: sql<number>`COUNT(*)::int`.as("calls"),
      total_tokens:
        sql<number>`COALESCE(SUM(${llmUsageEvents.totalTokens}), 0)::bigint`.as(
          "total_tokens",
        ),
      estimated_cost:
        sql<string>`COALESCE(SUM(${llmUsageEvents.estimatedCostUsd}), 0)`.as(
          "estimated_cost",
        ),
      actual_cost:
        sql<string>`COALESCE(SUM(${llmUsageEvents.actualCostUsd}), 0)`.as(
          "actual_cost",
        ),
      total_cost: sql<string>`COALESCE(SUM(${EFFECTIVE_COST}), 0)`.as(
        "total_cost",
      ),
    })
    .from(llmUsageEvents)
    .where(inWindow)
    .groupBy(llmUsageEvents.userId)
    .as("u");
  const byUser = handle
    .select({
      user_id: userCosts.user_id,
      handle: users.handle,
      name: users.name,
      calls: userCosts.calls,
      total_tokens: userCosts.total_tokens,
      estimated_cost: userCosts.estimated_cost,
      actual_cost: userCosts.actual_cost,
      total_cost: userCosts.total_cost,
    })
    .from(userCosts)
    .leftJoin(users, eq(users.id, userCosts.user_id))
    .orderBy(desc(userCosts.total_cost));

  const day = sql<string>`to_char(
    date_trunc('day', ${llmUsageEvents.occurredAt} AT TIME ZONE 'UTC'),
    'YYYY-MM-DD'
  )`;
  const timeSeries = handle
    .select({
      day,
      estimated_cost:
        sql<string>`COALESCE(SUM(${llmUsageEvents.estimatedCostUsd}), 0)`,
      actual_cost:
        sql<string>`COALESCE(SUM(${llmUsageEvents.actualCostUsd}), 0)`,
      total_cost: sql<string>`COALESCE(SUM(${EFFECTIVE_COST}), 0)`,
    })
    .from(llmUsageEvents)
    .where(inWindow)
    .groupBy(day)
    .orderBy(asc(day));

  return { totals, byModel, byCallType, byUser, timeSeries };
}

export async function getCostsSummary(range: CostsRange): Promise<CostsSummary> {
  const since = range.sinceIso;
  const until = range.untilIso;
  const queries = buildCostsSummaryQueries(range, db());
  const [totalsRow] = await queries.totals;
  const byModel = await queries.byModel;
  const byCallType = await queries.byCallType;
  const byUser = await queries.byUser;
  const timeSeries = await queries.timeSeries;
  const providerQueries = buildProviderCostsSummaryQueries(range, db());
  const [providerTotalsRow] = await providerQueries.totals;
  const byProvider = await providerQueries.byProvider;
  const providerByUser = await providerQueries.byUser;
  const providerTimeSeries = await providerQueries.timeSeries;

  const providerOperations = n(providerTotalsRow?.["operations"]);
  const providerEstimatedCostUsd = n(providerTotalsRow?.["estimated_cost"]);
  const providerActualCostUsd = n(providerTotalsRow?.["actual_cost"]);
  const providerTotalCostUsd = n(providerTotalsRow?.["total_cost"]);

  const usersById = new Map<string | null, CostsByUserRow>();
  for (const row of byUser) {
    const userId = s(row["user_id"]);
    usersById.set(userId, {
      userId,
      handle: s(row["handle"]),
      name: s(row["name"]),
      calls: n(row["calls"]),
      providerOperations: 0,
      unknownProviderOperations: 0,
      totalTokens: n(row["total_tokens"]),
      estimatedCostUsd: n(row["estimated_cost"]),
      actualCostUsd: n(row["actual_cost"]),
      totalCostUsd: n(row["total_cost"]),
    });
  }
  for (const row of providerByUser) {
    const userId = s(row["user_id"]);
    const current = usersById.get(userId);
    usersById.set(userId, {
      userId,
      handle: current?.handle ?? s(row["handle"]),
      name: current?.name ?? s(row["name"]),
      calls: current?.calls ?? 0,
      providerOperations: n(row["operations"]),
      unknownProviderOperations: n(row["unknown_operations"]),
      totalTokens: current?.totalTokens ?? 0,
      estimatedCostUsd: (current?.estimatedCostUsd ?? 0) + n(row["estimated_cost"]),
      actualCostUsd: (current?.actualCostUsd ?? 0) + n(row["actual_cost"]),
      totalCostUsd: (current?.totalCostUsd ?? 0) + n(row["total_cost"]),
    });
  }

  const days = new Map<string, CostsTimeSeriesPoint>();
  for (const row of timeSeries) {
    const day = String(row["day"]);
    days.set(day, {
      day,
      estimatedCostUsd: n(row["estimated_cost"]),
      actualCostUsd: n(row["actual_cost"]),
      totalCostUsd: n(row["total_cost"]),
    });
  }
  for (const row of providerTimeSeries) {
    const day = String(row["day"]);
    const current = days.get(day);
    days.set(day, {
      day,
      estimatedCostUsd: (current?.estimatedCostUsd ?? 0) + n(row["estimated_cost"]),
      actualCostUsd: (current?.actualCostUsd ?? 0) + n(row["actual_cost"]),
      totalCostUsd: (current?.totalCostUsd ?? 0) + n(row["total_cost"]),
    });
  }

  return {
    range: { sinceIso: since, untilIso: until },
    totals: {
      calls: n(totalsRow?.["calls"]),
      providerOperations,
      unknownProviderOperations: n(providerTotalsRow?.["unknown_operations"]),
      inputTokens: n(totalsRow?.["input_tokens"]),
      cachedInputTokens: n(totalsRow?.["cached_input_tokens"]),
      outputTokens: n(totalsRow?.["output_tokens"]),
      totalTokens: n(totalsRow?.["total_tokens"]),
      estimatedCostUsd: n(totalsRow?.["estimated_cost"]) + providerEstimatedCostUsd,
      actualCostUsd: n(totalsRow?.["actual_cost"]) + providerActualCostUsd,
      totalCostUsd: n(totalsRow?.["total_cost"]) + providerTotalCostUsd,
    },
    byModel: byModel.map((r) => ({
      model: String(r["model"]),
      provider: String(r["provider"]),
      calls: n(r["calls"]),
      inputTokens: n(r["input_tokens"]),
      outputTokens: n(r["output_tokens"]),
      estimatedCostUsd: n(r["estimated_cost"]),
      actualCostUsd: n(r["actual_cost"]),
      totalCostUsd: n(r["total_cost"]),
      hasActual: r["has_actual"] === true,
      hasFallbackEstimate: r["has_fallback_estimate"] === true,
    })),
    byCallType: byCallType.map((r) => ({
      callType: String(r["call_type"]),
      calls: n(r["calls"]),
      totalCostUsd: n(r["total_cost"]),
    })),
    byProvider: byProvider.map((r) => ({
      provider: String(r["provider"]),
      operation: String(r["operation"]),
      operations: n(r["operations"]),
      unknownOperations: n(r["unknown_operations"]),
      estimatedCostUsd: n(r["estimated_cost"]),
      actualCostUsd: n(r["actual_cost"]),
      totalCostUsd: n(r["total_cost"]),
    })),
    byUser: [...usersById.values()].sort((left, right) => right.totalCostUsd - left.totalCostUsd),
    timeSeries: [...days.values()].sort((left, right) => left.day.localeCompare(right.day)),
  };
}
