import { createHash } from "node:crypto";
import { and, asc, desc, eq, gte, isNull, lt, ne, or, sql } from "drizzle-orm";
import type { DirectDatabase } from "../config/direct-database";
import { getSharedDirectDb } from "../config/direct-database";
import { providerCostEvents } from "../schema/provider-costs";
import { users } from "../schema/users";

export type ProviderCostEvidenceState = "actual" | "estimated" | "unknown";

export const PROVIDER_TOOL_PRICING_VERSION = "2026-09-02.1";

const PROVIDER_TOOL_RATE_EIGHT_DECIMALS = {
  "tavily:credit": 800_000n,
  "elevenlabs:v3_character": 10_000n,
  "openai:web_search_call": 1_000_000n,
  "anthropic:web_search_call": 1_000_000n,
} as const;

export type ProviderToolPriceKey = keyof typeof PROVIDER_TOOL_RATE_EIGHT_DECIMALS;

/** Returns an exact eight-decimal public baseline estimate for a measurable provider unit. */
export function estimateProviderToolCostUsd(key: ProviderToolPriceKey, units: number): string | null {
  if (!Number.isSafeInteger(units) || units <= 0) return null;
  const amount = PROVIDER_TOOL_RATE_EIGHT_DECIMALS[key] * BigInt(units);
  const digits = amount.toString().padStart(9, "0");
  return `${digits.slice(0, -8)}.${digits.slice(-8)}`;
}

export interface InsertProviderCostEventInput {
  occurredAt?: Date;
  userId?: string | null;
  roomId?: string | null;
  agentId?: string | null;
  provider: string;
  operation: string;
  fundingKind?: "personal" | "server" | "service" | null;
  payerHumanId?: string | null;
  providerRoute?: string | null;
  credentialId?: string | null;
  credentialRevision?: number | null;
  estimatedCostUsd?: string | null;
  actualCostUsd?: string | null;
  evidenceState: ProviderCostEvidenceState;
  /** Lowercase SHA-256 digest; raw provider operation IDs are never stored. */
  idempotencyKey: string;
}

/** Hashes provider receipts and local execution coordinates before persistence. */
export function providerCostIdempotencyKey(identity: string): string {
  return createHash("sha256").update(identity, "utf8").digest("hex");
}

function normalizedUsd(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const match = /^(0|[1-9]\d{0,5})(?:\.(\d{1,8}))?$/.exec(value.trim());
  if (match === null) throw new Error("Invalid provider cost amount");
  return `${match[1]}.${(match[2] ?? "").padEnd(8, "0")}`;
}

function assertEvidence(input: InsertProviderCostEventInput): {
  estimatedCostUsd: string | null;
  actualCostUsd: string | null;
} {
  const estimatedCostUsd = normalizedUsd(input.estimatedCostUsd);
  const actualCostUsd = normalizedUsd(input.actualCostUsd);
  const valid = input.evidenceState === "actual"
    ? actualCostUsd !== null
    : input.evidenceState === "estimated"
      ? actualCostUsd === null && estimatedCostUsd !== null
      : actualCostUsd === null && estimatedCostUsd === null;
  if (!valid || !/^[0-9a-f]{64}$/.test(input.idempotencyKey)) {
    throw new Error("Invalid provider cost evidence");
  }
  return { estimatedCostUsd, actualCostUsd };
}

export async function insertProviderCostEventWith(
  handle: Pick<DirectDatabase, "insert">,
  input: InsertProviderCostEventInput,
): Promise<void> {
  const amounts = assertEvidence(input);
  await handle
    .insert(providerCostEvents)
    .values({
      ...(input.occurredAt ? { occurredAt: input.occurredAt } : {}),
      userId: input.userId ?? null,
      roomId: input.roomId ?? null,
      agentId: input.agentId ?? null,
      provider: input.provider,
      operation: input.operation,
      fundingKind: input.fundingKind ?? null,
      payerHumanId: input.payerHumanId ?? null,
      providerRoute: input.providerRoute ?? null,
      credentialId: input.credentialId ?? null,
      credentialRevision: input.credentialRevision ?? null,
      evidenceState: input.evidenceState,
      idempotencyKey: input.idempotencyKey,
      ...amounts,
    })
    .onConflictDoNothing({ target: providerCostEvents.idempotencyKey });
}

export async function insertProviderCostEvent(input: InsertProviderCostEventInput): Promise<void> {
  await insertProviderCostEventWith(getSharedDirectDb(), input);
}

/** Replace only the unresolved evidence of one already-recorded service call. */
export async function settleProviderCostEvent(input: InsertProviderCostEventInput): Promise<void> {
  const amounts = assertEvidence(input);
  if (input.evidenceState === "unknown") return;
  const db = getSharedDirectDb();
  await db.update(providerCostEvents).set({ ...amounts, evidenceState: input.evidenceState })
    .where(and(
      eq(providerCostEvents.idempotencyKey, input.idempotencyKey),
      eq(providerCostEvents.provider, input.provider),
      eq(providerCostEvents.operation, input.operation),
      eq(providerCostEvents.evidenceState, "unknown"),
      input.fundingKind ? eq(providerCostEvents.fundingKind, input.fundingKind) : isNull(providerCostEvents.fundingKind),
      input.providerRoute ? eq(providerCostEvents.providerRoute, input.providerRoute) : isNull(providerCostEvents.providerRoute),
      input.payerHumanId ? eq(providerCostEvents.payerHumanId, input.payerHumanId) : isNull(providerCostEvents.payerHumanId),
      input.credentialId ? eq(providerCostEvents.credentialId, input.credentialId) : isNull(providerCostEvents.credentialId),
      input.credentialRevision ? eq(providerCostEvents.credentialRevision, input.credentialRevision) : isNull(providerCostEvents.credentialRevision),
    ));
}

const EFFECTIVE_COST = sql`COALESCE(${providerCostEvents.actualCostUsd}, ${providerCostEvents.estimatedCostUsd}, 0)`;
const CURRENT_ESTIMATED_COST = sql`CASE
  WHEN ${providerCostEvents.evidenceState} = 'estimated'
    THEN ${providerCostEvents.estimatedCostUsd}
  ELSE 0
END`;

export function buildProviderCostsSummaryQueries(
  range: { sinceIso: string; untilIso: string },
  handle: Pick<DirectDatabase, "select">,
  payerHumanId?: string,
) {
  const inWindow = and(
    gte(providerCostEvents.occurredAt, new Date(range.sinceIso)),
    lt(providerCostEvents.occurredAt, new Date(range.untilIso)),
    ...(payerHumanId === undefined
      ? [or(
          isNull(providerCostEvents.fundingKind),
          ne(providerCostEvents.fundingKind, "personal"),
        )]
      : [
          eq(providerCostEvents.fundingKind, "personal"),
          eq(providerCostEvents.payerHumanId, payerHumanId),
        ]),
  );
  // Actual provider evidence may retain its earlier estimate for audit. Every
  // dashboard reports only estimates that remain the current evidence.
  const estimatedCost = CURRENT_ESTIMATED_COST;
  const totals = handle
    .select({
      operations: sql<number>`COUNT(*)::int`,
      unknown_operations:
        sql<number>`COUNT(*) FILTER (WHERE ${providerCostEvents.evidenceState} = 'unknown')::int`,
      estimated_cost: sql<string>`COALESCE(SUM(${estimatedCost}), 0)`,
      actual_cost: sql<string>`COALESCE(SUM(${providerCostEvents.actualCostUsd}), 0)`,
      total_cost: sql<string>`COALESCE(SUM(${EFFECTIVE_COST}), 0)`,
    })
    .from(providerCostEvents)
    .where(inWindow);

  const byProvider = handle
    .select({
      provider: providerCostEvents.provider,
      operation: providerCostEvents.operation,
      operations: sql<number>`COUNT(*)::int`,
      unknown_operations:
        sql<number>`COUNT(*) FILTER (WHERE ${providerCostEvents.evidenceState} = 'unknown')::int`,
      estimated_cost: sql<string>`COALESCE(SUM(${estimatedCost}), 0)`,
      actual_cost: sql<string>`COALESCE(SUM(${providerCostEvents.actualCostUsd}), 0)`,
      total_cost: sql<string>`COALESCE(SUM(${EFFECTIVE_COST}), 0)`.as("total_cost"),
    })
    .from(providerCostEvents)
    .where(inWindow)
    .groupBy(providerCostEvents.provider, providerCostEvents.operation)
    .orderBy(({ total_cost }) => desc(total_cost));

  const userCosts = handle
    .select({
      user_id: providerCostEvents.userId,
      operations: sql<number>`COUNT(*)::int`.as("operations"),
      unknown_operations:
        sql<number>`COUNT(*) FILTER (WHERE ${providerCostEvents.evidenceState} = 'unknown')::int`.as("unknown_operations"),
      estimated_cost:
        sql<string>`COALESCE(SUM(${estimatedCost}), 0)`.as("estimated_cost"),
      actual_cost:
        sql<string>`COALESCE(SUM(${providerCostEvents.actualCostUsd}), 0)`.as("actual_cost"),
      total_cost: sql<string>`COALESCE(SUM(${EFFECTIVE_COST}), 0)`.as("total_cost"),
    })
    .from(providerCostEvents)
    .where(inWindow)
    .groupBy(providerCostEvents.userId)
    .as("provider_user_costs");
  const byUser = handle
    .select({
      user_id: userCosts.user_id,
      handle: users.handle,
      name: users.name,
      operations: userCosts.operations,
      unknown_operations: userCosts.unknown_operations,
      estimated_cost: userCosts.estimated_cost,
      actual_cost: userCosts.actual_cost,
      total_cost: userCosts.total_cost,
    })
    .from(userCosts)
    .leftJoin(users, eq(users.id, userCosts.user_id))
    .orderBy(desc(userCosts.total_cost));

  const day = sql<string>`to_char(
    date_trunc('day', ${providerCostEvents.occurredAt} AT TIME ZONE 'UTC'),
    'YYYY-MM-DD'
  )`;
  const timeSeries = handle
    .select({
      day,
      estimated_cost: sql<string>`COALESCE(SUM(${estimatedCost}), 0)`,
      actual_cost: sql<string>`COALESCE(SUM(${providerCostEvents.actualCostUsd}), 0)`,
      total_cost: sql<string>`COALESCE(SUM(${EFFECTIVE_COST}), 0)`,
    })
    .from(providerCostEvents)
    .where(inWindow)
    .groupBy(day)
    .orderBy(asc(day));

  return { totals, byProvider, byUser, timeSeries };
}
