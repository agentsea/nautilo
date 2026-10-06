import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import {
  and,
  asc,
  desc,
  eq,
  exists,
  gte,
  inArray,
  isNotNull,
  isNull,
  lt,
  lte,
  ne,
  or,
  sql,
} from "drizzle-orm";
import { llmUsageEvents } from "../schema/llm-usage";
import { users } from "../schema/users";
import { getSharedDirectDb } from "../config/direct-database";
import type { DirectDatabase } from "../config/direct-database";
import { buildProviderCostsSummaryQueries } from "./provider-costs";
import { personalProviderCredentials } from "../schema/personal-provider-credentials";
import { providerCostEvents } from "../schema/provider-costs";
import type {
  PersonalCostsByCallTypeRow,
  PersonalCostsByModelRow,
  PersonalCostsByProviderRow,
  PersonalCostsByTaskRow,
  PersonalCostsRecoveryAttempt,
  PersonalCostsRecoverySummary,
  PersonalCostsSummary,
  PersonalCostsTimeSeriesPoint,
} from "@nautilo/types";

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
  fundingKind?: "personal" | "server" | "service" | null;
  payerHumanId?: string | null;
  providerRoute?: string | null;
  credentialId?: string | null;
  credentialRevision?: number | null;
  metadata?: Record<string, unknown> | null;
}

export type SurplusAttemptOutcome =
  | "in_progress"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "interrupted"
  | "unknown";

export type SurplusCostState = "actual" | "estimated" | "pending" | "unknown";

export interface BeginSurplusLlmAttemptInput {
  /** Caller-generated UUID; retrying the same begin is idempotent. */
  id: string;
  occurredAt?: Date;
  userId?: string | null;
  roomId?: string | null;
  taskId?: string | null;
  callType: string;
  /** Canonical Nautilo catalogue provider, never the marketplace seller. */
  provider: string;
  /** Canonical Nautilo catalogue model id. */
  model: string;
  endpoint: string;
  fundingKind: "personal" | "server" | "service";
  payerHumanId?: string | null;
  credentialId?: string | null;
  credentialRevision?: number | null;
  metadata?: Record<string, unknown> | null;
}

export interface BeginPersonalLlmAttemptInput {
  /** Caller-generated UUID; retrying the same begin is idempotent. */
  id: string;
  occurredAt?: Date;
  userId: string;
  roomId?: string | null;
  taskId?: string | null;
  callType: string;
  provider: string;
  model: string;
  providerRoute: string;
  credentialId: string;
  credentialRevision: number;
  endpoint: string;
  metadata?: Record<string, unknown> | null;
}

export interface AttachSurplusRequestReceiptInput {
  attemptId: string;
  providerRequestId: string;
  servingProvider?: string | null;
  endpoint?: string;
  metadata?: Record<string, unknown>;
}

export interface SettleSurplusLlmAttemptInput {
  attemptId: string;
  providerRequestId?: string;
  metadata?: Record<string, unknown>;
  outcome: Exclude<SurplusAttemptOutcome, "in_progress">;
  costState: SurplusCostState;
  inputTokens?: number;
  outputTokens?: number;
  reasoningTokens?: number;
  cachedInputTokens?: number;
  totalTokens?: number;
  estimatedCostUsd?: number;
  actualCostUsd?: number | null;
  pricingVersion?: string | null;
  servingProvider?: string | null;
  failureCode?: string | null;
  settledAt?: Date;
}

export interface SettlePersonalLlmAttemptInput {
  attemptId: string;
  outcome: Exclude<SurplusAttemptOutcome, "in_progress">;
  costState: "actual" | "estimated" | "unknown";
  inputTokens?: number;
  outputTokens?: number;
  reasoningTokens?: number;
  cachedInputTokens?: number;
  totalTokens?: number;
  estimatedCostUsd?: number;
  actualCostUsd?: number | null;
  pricingVersion?: string | null;
  providerRequestId?: string;
  servingProvider?: string | null;
  failureCode?: string | null;
  metadata?: Record<string, unknown>;
  settledAt?: Date;
  /** Late verified usage may replace unknown cost without rewriting the terminal outcome. */
  preserveOutcome?: boolean;
}

export interface ListPendingSurplusAttemptsInput {
  limit?: number;
  updatedBefore?: Date;
}

// Bound each fair-ranked recovery pass and the corresponding diagnostic list.
export const DEFAULT_SURPLUS_RECOVERY_BATCH_LIMIT = 100;

export interface SurplusPendingAttempt {
  id: string;
  occurredAt: Date;
  updatedAt: Date;
  /** Lossless database timestamp token used by recovery compare-and-set. */
  updatedAtToken: string;
  userId: string | null;
  roomId: string | null;
  taskId: string | null;
  callType: string;
  provider: string;
  model: string;
  providerRequestId: string | null;
  endpoint: string;
  servingProvider: string | null;
  attemptOutcome: SurplusAttemptOutcome;
  costState: "pending" | "unknown";
  recoveryState: "pending" | "retryable" | "blocked_repair" | null;
  fundingKind: "personal" | "server" | "service";
  payerHumanId: string | null;
  credentialId: string | null;
  credentialRevision: number | null;
  failureCode: string | null;
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
      fundingKind: input.fundingKind ?? null,
      payerHumanId: input.payerHumanId ?? null,
      providerRoute: input.providerRoute ?? null,
      credentialId: input.credentialId ?? null,
      credentialRevision: input.credentialRevision ?? null,
      metadata: input.metadata ?? null,
    });
}

function assertNonEmpty(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${label} is required`);
  return normalized;
}

function nonnegativeInteger(value: number | undefined): number {
  return Math.max(0, Math.round(value ?? 0));
}

function optionalUsd(value: number | null | undefined, label: string): string | null {
  if (value === null || value === undefined) return null;
  if (!Number.isFinite(value) || value < 0) throw new Error(`${label} must be nonnegative`);
  return toNumeric(value);
}

/** Persist the attempt before any Surplus wire request is sent. */
export async function beginSurplusLlmAttempt(
  input: BeginSurplusLlmAttemptInput,
): Promise<void> {
  const personal = input.fundingKind === "personal";
  const hasPersonalProvenance = Boolean(input.payerHumanId && input.credentialId)
    && Number.isSafeInteger(input.credentialRevision)
    && (input.credentialRevision ?? 0) >= 1;
  if (personal !== hasPersonalProvenance) {
    throw new Error("Personal Surplus attempts require complete payer and credential provenance");
  }
  await db()
    .insert(llmUsageEvents)
    .values({
      id: input.id,
      ...(input.occurredAt ? { occurredAt: input.occurredAt } : {}),
      userId: input.userId ?? null,
      roomId: input.roomId ?? null,
      taskId: input.taskId ?? null,
      callType: assertNonEmpty(input.callType, "callType"),
      provider: assertNonEmpty(input.provider, "provider"),
      model: assertNonEmpty(input.model, "model"),
      endpoint: assertNonEmpty(input.endpoint, "endpoint"),
      providerRoute: "surplus",
      fundingKind: input.fundingKind,
      payerHumanId: input.payerHumanId ?? null,
      credentialId: input.credentialId ?? null,
      credentialRevision: input.credentialRevision ?? null,
      attemptOutcome: "in_progress",
      costState: "pending",
      recoveryState: "pending",
      estimatedCostUsd: "0.00000000",
      actualCostUsd: null,
      metadata: input.metadata ?? null,
    })
    .onConflictDoNothing({ target: llmUsageEvents.id });
}

/** Persist a direct personal-provider wire attempt before dispatch. */
export async function beginPersonalLlmAttempt(
  input: BeginPersonalLlmAttemptInput,
): Promise<void> {
  if (!Number.isSafeInteger(input.credentialRevision) || input.credentialRevision < 1) {
    throw new Error("credentialRevision must be a positive integer");
  }
  await db()
    .insert(llmUsageEvents)
    .values({
      id: input.id,
      ...(input.occurredAt ? { occurredAt: input.occurredAt } : {}),
      userId: input.userId,
      roomId: input.roomId ?? null,
      taskId: input.taskId ?? null,
      callType: assertNonEmpty(input.callType, "callType"),
      provider: assertNonEmpty(input.provider, "provider"),
      model: assertNonEmpty(input.model, "model"),
      endpoint: assertNonEmpty(input.endpoint, "endpoint"),
      providerRoute: assertNonEmpty(input.providerRoute, "providerRoute"),
      fundingKind: "personal",
      payerHumanId: input.userId,
      credentialId: input.credentialId,
      credentialRevision: input.credentialRevision,
      attemptOutcome: "in_progress",
      costState: "pending",
      estimatedCostUsd: "0.00000000",
      actualCostUsd: null,
      metadata: input.metadata ?? null,
    })
    .onConflictDoNothing({ target: llmUsageEvents.id });
}

/** Bind the provider request receipt to the already-durable local attempt. */
export async function attachSurplusRequestReceipt(
  input: AttachSurplusRequestReceiptInput,
): Promise<void> {
  const requestId = assertNonEmpty(input.providerRequestId, "providerRequestId");
  const rows = await db()
    .update(llmUsageEvents)
    .set({
      providerRequestId: requestId,
      ...(input.servingProvider === undefined
        ? {}
        : { servingProvider: input.servingProvider?.trim() || null }),
      ...(input.endpoint === undefined
        ? {}
        : { endpoint: assertNonEmpty(input.endpoint, "endpoint") }),
      ...(input.metadata === undefined ? {} : {
        metadata: sql`coalesce(${llmUsageEvents.metadata}, '{}'::jsonb) || ${JSON.stringify(input.metadata)}::jsonb`,
      }),
      updatedAt: new Date(),
    })
    .where(and(
      eq(llmUsageEvents.id, input.attemptId),
      eq(llmUsageEvents.providerRoute, "surplus"),
      or(
        isNull(llmUsageEvents.providerRequestId),
        eq(llmUsageEvents.providerRequestId, requestId),
      ),
    ))
    .returning({ id: llmUsageEvents.id });
  if (rows.length !== 1) throw new Error("Surplus attempt receipt conflicts with durable state");
}

/** Settle or classify one durable attempt without creating another cost row. */
export async function settleSurplusLlmAttempt(
  input: SettleSurplusLlmAttemptInput,
): Promise<void> {
  const actualCostUsd = optionalUsd(input.actualCostUsd, "actualCostUsd");
  const estimatedCostUsd = optionalUsd(input.estimatedCostUsd, "estimatedCostUsd");
  if (input.costState === "actual" && actualCostUsd === null) {
    throw new Error("actual costState requires actualCostUsd, including explicit zero");
  }
  if (input.costState !== "actual" && actualCostUsd !== null) {
    throw new Error("actualCostUsd requires actual costState");
  }
  if (input.costState === "estimated" && estimatedCostUsd === null) {
    throw new Error("estimated costState requires estimatedCostUsd");
  }

  const inputTokens = input.inputTokens === undefined
    ? undefined
    : nonnegativeInteger(input.inputTokens);
  const outputTokens = input.outputTokens === undefined
    ? undefined
    : nonnegativeInteger(input.outputTokens);
  const totalTokens = input.totalTokens !== undefined
    ? nonnegativeInteger(input.totalTokens)
    : inputTokens !== undefined && outputTokens !== undefined
      ? inputTokens + outputTokens
      : undefined;
  const requestId = input.providerRequestId === undefined
    ? undefined : assertNonEmpty(input.providerRequestId, "providerRequestId");
  const mayReplaceCost = input.costState === "actual"
    ? undefined
    : input.costState === "estimated"
      ? or(
          isNull(llmUsageEvents.costState),
          inArray(llmUsageEvents.costState, ["pending", "unknown", "estimated"]),
        )
      : or(
          isNull(llmUsageEvents.costState),
          inArray(llmUsageEvents.costState, ["pending", "unknown"]),
        );
  const rows = await db()
    .update(llmUsageEvents)
    .set({
      attemptOutcome: input.outcome,
      // A request-detail read may have already recovered the actual charge.
      // Still record the local terminal result while keeping that stronger
      // financial evidence; cost and answer outcome are independent.
      costState: mayReplaceCost
        ? sql`case when ${mayReplaceCost} then ${input.costState} else ${llmUsageEvents.costState} end`
        : input.costState,
      ...(requestId === undefined ? {} : { providerRequestId: requestId }),
      ...(input.metadata === undefined ? {} : {
        metadata: sql`coalesce(${llmUsageEvents.metadata}, '{}'::jsonb) || ${JSON.stringify(input.metadata)}::jsonb`,
      }),
      ...(inputTokens === undefined ? {} : { inputTokens }),
      ...(outputTokens === undefined ? {} : { outputTokens }),
      ...(input.reasoningTokens === undefined
        ? {}
        : { reasoningTokens: nonnegativeInteger(input.reasoningTokens) }),
      ...(input.cachedInputTokens === undefined
        ? {}
        : { cachedInputTokens: nonnegativeInteger(input.cachedInputTokens) }),
      ...(totalTokens === undefined ? {} : { totalTokens }),
      ...(estimatedCostUsd === null ? {} : { estimatedCostUsd: mayReplaceCost
        ? sql`case when ${mayReplaceCost} then ${estimatedCostUsd}::numeric else ${llmUsageEvents.estimatedCostUsd} end`
        : estimatedCostUsd }),
      actualCostUsd: mayReplaceCost
        ? sql`case when ${mayReplaceCost} then ${actualCostUsd}::numeric else ${llmUsageEvents.actualCostUsd} end`
        : actualCostUsd,
      ...(input.pricingVersion === undefined ? {} : { pricingVersion: input.pricingVersion }),
      recoveryState: input.costState === "actual" || input.costState === "estimated"
        ? null
        : mayReplaceCost
          ? sql`case
              when ${mayReplaceCost}
                then coalesce(${llmUsageEvents.recoveryState}, 'pending')
              else null
            end`
          : sql`coalesce(${llmUsageEvents.recoveryState}, 'pending')`,
      ...(input.servingProvider === undefined
        ? {}
        : { servingProvider: input.servingProvider?.trim() || null }),
      failureCode: input.failureCode?.trim() || null,
      settledAt: mayReplaceCost
        ? sql`case when ${mayReplaceCost} then ${input.costState === "estimated" ? (input.settledAt ?? new Date()).toISOString() : null}::timestamptz else ${llmUsageEvents.settledAt} end`
        : input.settledAt ?? new Date(),
      updatedAt: new Date(),
    })
    .where(and(
      eq(llmUsageEvents.id, input.attemptId),
      eq(llmUsageEvents.providerRoute, "surplus"),
      ...(requestId === undefined ? [] : [or(
        isNull(llmUsageEvents.providerRequestId), eq(llmUsageEvents.providerRequestId, requestId),
      )]),
    ))
    .returning({ id: llmUsageEvents.id });
  if (rows.length !== 1) throw new Error("Surplus attempt settlement conflicts with durable state");
}

/** Settle a prewired direct personal attempt in place. */
export async function settlePersonalLlmAttempt(
  input: SettlePersonalLlmAttemptInput,
): Promise<void> {
  const actualCostUsd = optionalUsd(input.actualCostUsd, "actualCostUsd");
  const estimatedCostUsd = optionalUsd(input.estimatedCostUsd, "estimatedCostUsd");
  if (input.costState === "actual" && actualCostUsd === null) {
    throw new Error("actual costState requires actualCostUsd, including explicit zero");
  }
  if (input.costState !== "actual" && actualCostUsd !== null) {
    throw new Error("actualCostUsd requires actual costState");
  }
  if (input.costState === "estimated"
    && (estimatedCostUsd === null || !input.pricingVersion?.trim())) {
    throw new Error("estimated costState requires estimatedCostUsd and pricingVersion");
  }
  if (input.preserveOutcome && input.costState === "unknown") {
    throw new Error("Late personal settlement requires known financial evidence");
  }

  const inputTokens = input.inputTokens === undefined
    ? undefined : nonnegativeInteger(input.inputTokens);
  const outputTokens = input.outputTokens === undefined
    ? undefined : nonnegativeInteger(input.outputTokens);
  const totalTokens = input.totalTokens !== undefined
    ? nonnegativeInteger(input.totalTokens)
    : inputTokens !== undefined && outputTokens !== undefined
      ? inputTokens + outputTokens : undefined;
  const providerRequestId = input.providerRequestId === undefined
    ? undefined : assertNonEmpty(input.providerRequestId, "providerRequestId");
  const metadataPatch = input.metadata === undefined
    ? undefined
    : JSON.parse(JSON.stringify(input.metadata)) as Record<string, unknown>;
  const pricingVersion = input.pricingVersion?.trim() || null;
  const servingProvider = input.servingProvider === undefined
    ? undefined
    : input.servingProvider?.trim() || null;
  const failureCode = input.failureCode?.trim() || null;
  const settledAt = input.settledAt ?? new Date();
  const rows = await db().update(llmUsageEvents).set({
    ...(input.preserveOutcome ? {} : { attemptOutcome: input.outcome }),
    costState: input.costState,
    ...(providerRequestId === undefined ? {} : { providerRequestId }),
    ...(metadataPatch === undefined ? {} : {
      metadata: sql`coalesce(${llmUsageEvents.metadata}, '{}'::jsonb) || ${JSON.stringify(metadataPatch)}::jsonb`,
    }),
    ...(inputTokens === undefined ? {} : { inputTokens }),
    ...(outputTokens === undefined ? {} : { outputTokens }),
    ...(input.reasoningTokens === undefined
      ? {} : { reasoningTokens: nonnegativeInteger(input.reasoningTokens) }),
    ...(input.cachedInputTokens === undefined
      ? {} : { cachedInputTokens: nonnegativeInteger(input.cachedInputTokens) }),
    ...(totalTokens === undefined ? {} : { totalTokens }),
    estimatedCostUsd: estimatedCostUsd ?? "0.00000000",
    actualCostUsd,
    pricingVersion,
    ...(servingProvider === undefined ? {} : { servingProvider }),
    ...(input.preserveOutcome ? {} : { failureCode }),
    ...(input.preserveOutcome ? {} : { settledAt }),
    updatedAt: new Date(),
  }).where(and(
    eq(llmUsageEvents.id, input.attemptId),
    eq(llmUsageEvents.fundingKind, "personal"),
    ne(llmUsageEvents.providerRoute, "surplus"),
    ...(input.preserveOutcome
      ? [eq(llmUsageEvents.costState, "unknown")]
      : [eq(llmUsageEvents.attemptOutcome, "in_progress")]),
  )).returning({ id: llmUsageEvents.id });
  if (rows.length === 1) return;
  const [current] = await db().select({
    attemptOutcome: llmUsageEvents.attemptOutcome,
    costState: llmUsageEvents.costState,
    providerRequestId: llmUsageEvents.providerRequestId,
    metadata: llmUsageEvents.metadata,
    inputTokens: llmUsageEvents.inputTokens,
    outputTokens: llmUsageEvents.outputTokens,
    reasoningTokens: llmUsageEvents.reasoningTokens,
    cachedInputTokens: llmUsageEvents.cachedInputTokens,
    totalTokens: llmUsageEvents.totalTokens,
    estimatedCostUsd: llmUsageEvents.estimatedCostUsd,
    actualCostUsd: llmUsageEvents.actualCostUsd,
    pricingVersion: llmUsageEvents.pricingVersion,
    servingProvider: llmUsageEvents.servingProvider,
    failureCode: llmUsageEvents.failureCode,
    settledAt: llmUsageEvents.settledAt,
  }).from(llmUsageEvents).where(and(
    eq(llmUsageEvents.id, input.attemptId),
    eq(llmUsageEvents.fundingKind, "personal"),
    ne(llmUsageEvents.providerRoute, "surplus"),
  )).limit(1);
  const sameMetadata = metadataPatch === undefined
    || Object.entries(metadataPatch).every(([key, value]) => (
      isDeepStrictEqual(current?.metadata?.[key], value)
    ));
  const sameEvidence = current?.costState === input.costState
    && (providerRequestId === undefined || current.providerRequestId === providerRequestId)
    && sameMetadata
    && (inputTokens === undefined || current.inputTokens === inputTokens)
    && (outputTokens === undefined || current.outputTokens === outputTokens)
    && (input.reasoningTokens === undefined
      || current.reasoningTokens === nonnegativeInteger(input.reasoningTokens))
    && (input.cachedInputTokens === undefined
      || current.cachedInputTokens === nonnegativeInteger(input.cachedInputTokens))
    && (totalTokens === undefined || current.totalTokens === totalTokens)
    && current.estimatedCostUsd === (estimatedCostUsd ?? "0.00000000")
    && current.actualCostUsd === actualCostUsd
    && current.pricingVersion === pricingVersion
    && (servingProvider === undefined || current.servingProvider === servingProvider);
  const sameTerminalState = input.preserveOutcome || (
    current?.attemptOutcome === input.outcome
    && current.failureCode === failureCode
    && (input.settledAt === undefined
      || current.settledAt?.getTime() === input.settledAt.getTime())
  );
  if (sameEvidence && sameTerminalState) return;
  throw new Error("Personal attempt settlement conflicts with durable state");
}

/** Content-free queue view for restart-safe settlement reconciliation. */
export async function listPendingSurplusAttempts(
  input: ListPendingSurplusAttemptsInput = {},
): Promise<SurplusPendingAttempt[]> {
  const limit = input.limit === undefined ? DEFAULT_SURPLUS_RECOVERY_BATCH_LIMIT : input.limit;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) {
    throw new RangeError("limit must be an integer between 1 and 1000");
  }
  const rows = await db()
    .select({
      id: llmUsageEvents.id,
      occurredAt: llmUsageEvents.occurredAt,
      updatedAt: llmUsageEvents.updatedAt,
      updatedAtToken: sql<string>`to_char(
        ${llmUsageEvents.updatedAt} AT TIME ZONE 'UTC',
        'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
      )`,
      userId: llmUsageEvents.userId,
      roomId: llmUsageEvents.roomId,
      taskId: llmUsageEvents.taskId,
      callType: llmUsageEvents.callType,
      provider: llmUsageEvents.provider,
      model: llmUsageEvents.model,
      providerRequestId: llmUsageEvents.providerRequestId,
      endpoint: llmUsageEvents.endpoint,
      servingProvider: llmUsageEvents.servingProvider,
      attemptOutcome: llmUsageEvents.attemptOutcome,
      costState: llmUsageEvents.costState,
      recoveryState: llmUsageEvents.recoveryState,
      fundingKind: llmUsageEvents.fundingKind,
      payerHumanId: llmUsageEvents.payerHumanId,
      credentialId: llmUsageEvents.credentialId,
      credentialRevision: llmUsageEvents.credentialRevision,
      failureCode: llmUsageEvents.failureCode,
      metadata: llmUsageEvents.metadata,
    })
    .from(llmUsageEvents)
    .where(and(
      eq(llmUsageEvents.providerRoute, "surplus"),
      inArray(llmUsageEvents.costState, ["pending", "unknown"]),
      or(
        isNull(llmUsageEvents.recoveryState),
        inArray(llmUsageEvents.recoveryState, ["pending", "retryable"]),
      ),
      ...(input.updatedBefore ? [lte(llmUsageEvents.updatedAt, input.updatedBefore)] : []),
    ))
    // Rank within each payer before global age so one noisy account cannot
    // monopolize a bounded recovery pass.
    .orderBy(
      sql`row_number() over (
        partition by case
          when ${llmUsageEvents.fundingKind} = 'personal' then ${llmUsageEvents.payerHumanId}::text
          else coalesce(${llmUsageEvents.fundingKind}, 'legacy')
        end
        order by ${llmUsageEvents.updatedAt}, ${llmUsageEvents.id}
      )`,
      asc(llmUsageEvents.updatedAt),
      asc(llmUsageEvents.id),
    )
    .limit(limit);
  return rows as SurplusPendingAttempt[];
}

function recoveryUpdatedAtPredicate(input: {
  expectedUpdatedAt?: Date;
  expectedUpdatedAtToken?: string;
}) {
  if (input.expectedUpdatedAtToken?.trim()) {
    return sql`to_char(
      ${llmUsageEvents.updatedAt} AT TIME ZONE 'UTC',
      'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
    ) = ${input.expectedUpdatedAtToken}`;
  }
  if (input.expectedUpdatedAt) return eq(llmUsageEvents.updatedAt, input.expectedUpdatedAt);
  throw new Error("An exact recovery updatedAt token is required");
}

/** Persist a content-free recovery classification without altering cost evidence. */
export async function classifySurplusLlmAttemptRecovery(input: {
  attemptId: string;
  expectedUpdatedAt?: Date;
  expectedUpdatedAtToken?: string;
  recoveryState: "pending" | "retryable" | "blocked_repair";
  failureCode: string;
}): Promise<boolean> {
  const rows = await db().update(llmUsageEvents).set({
    recoveryState: input.recoveryState,
    failureCode: assertNonEmpty(input.failureCode, "failureCode"),
    updatedAt: new Date(),
  }).where(and(
    eq(llmUsageEvents.id, input.attemptId),
    eq(llmUsageEvents.providerRoute, "surplus"),
    recoveryUpdatedAtPredicate(input),
    inArray(llmUsageEvents.costState, ["pending", "unknown"]),
  )).returning({ id: llmUsageEvents.id });
  return rows.length === 1;
}

/** Requeue one payer's blocked receipts after proving the supplied key is still current. */
export async function requeueBlockedPersonalSurplusAttempts(input: {
  payerHumanId: string;
  credentialId: string;
  credentialRevision: number;
}): Promise<number> {
  if (!Number.isSafeInteger(input.credentialRevision) || input.credentialRevision < 1) {
    throw new Error("credentialRevision must be a positive integer");
  }
  const rows = await db().update(llmUsageEvents).set({
    recoveryState: "retryable",
    failureCode: null,
    updatedAt: new Date(),
  }).where(and(
    eq(llmUsageEvents.providerRoute, "surplus"),
    eq(llmUsageEvents.fundingKind, "personal"),
    eq(llmUsageEvents.payerHumanId, input.payerHumanId),
    eq(llmUsageEvents.recoveryState, "blocked_repair"),
    inArray(llmUsageEvents.costState, ["pending", "unknown"]),
    exists(db().select({ id: personalProviderCredentials.id })
      .from(personalProviderCredentials)
      .where(and(
        eq(personalProviderCredentials.userId, input.payerHumanId),
        eq(personalProviderCredentials.provider, "surplus"),
        eq(personalProviderCredentials.id, input.credentialId),
        eq(personalProviderCredentials.revision, input.credentialRevision),
      ))),
  )).returning({ id: llmUsageEvents.id });
  return rows.length;
}

/**
 * Wake server-owned receipts after the process observes an available server
 * credential at startup or a different credential while running. Permanent
 * binding/protocol defects stay blocked; the exact authenticated receipt read
 * decides whether the current credential can repair these access failures.
 */
export async function requeueBlockedServerSurplusAttempts(): Promise<number> {
  const rows = await db().update(llmUsageEvents).set({
    recoveryState: "retryable",
    failureCode: null,
    updatedAt: new Date(),
  }).where(and(
    eq(llmUsageEvents.providerRoute, "surplus"),
    inArray(llmUsageEvents.fundingKind, ["server", "service"]),
    eq(llmUsageEvents.recoveryState, "blocked_repair"),
    inArray(llmUsageEvents.costState, ["pending", "unknown"]),
    inArray(llmUsageEvents.failureCode, [
      "credential_missing",
      "credential_fingerprint_mismatch",
      "receipt_account_unproven",
      "receipt_read_unauthorized",
    ]),
  )).returning({ id: llmUsageEvents.id });
  return rows.length;
}

/** Conditional late financial settlement: never replace a newer local outcome or known cost. */
export async function reconcileSurplusLlmAttemptCost(input: {
  attemptId: string;
  providerRequestId: string;
  expectedUpdatedAt?: Date;
  expectedUpdatedAtToken?: string;
  actualCostUsd: number;
}): Promise<boolean> {
  const actualCostUsd = optionalUsd(input.actualCostUsd, "actualCostUsd");
  const rows = await db().update(llmUsageEvents).set({
    actualCostUsd,
    costState: "actual",
    recoveryState: null,
    attemptOutcome: sql`case when ${llmUsageEvents.attemptOutcome} = 'in_progress' then 'unknown' else ${llmUsageEvents.attemptOutcome} end`,
    settledAt: new Date(),
    updatedAt: new Date(),
  }).where(and(
    eq(llmUsageEvents.id, input.attemptId),
    eq(llmUsageEvents.providerRoute, "surplus"),
    eq(llmUsageEvents.providerRequestId, input.providerRequestId),
    recoveryUpdatedAtPredicate(input),
    inArray(llmUsageEvents.costState, ["pending", "unknown"]),
  )).returning({ id: llmUsageEvents.id });
  return rows.length === 1;
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
  /** Surplus attempts whose provider charge remains unresolved. */
  pendingModelAttempts: number;
  /** Surplus attempts that ended without a currently reconcilable charge. */
  unknownModelAttempts: number;
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
  pendingAttempts: number;
  unknownAttempts: number;
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
  recovery: PersonalCostsRecoverySummary;
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
const COST_IS_UNRESOLVED = sql`${llmUsageEvents.costState} IN ('pending', 'unknown')`;
const CURRENT_ESTIMATED_COST = sql`CASE
  WHEN ${llmUsageEvents.costState} = 'estimated' THEN ${llmUsageEvents.estimatedCostUsd}
  WHEN ${llmUsageEvents.costState} IS NULL
    AND ${llmUsageEvents.actualCostUsd} IS NULL
    THEN ${llmUsageEvents.estimatedCostUsd}
  ELSE 0
END`;
const EFFECTIVE_COST = sql`CASE
  WHEN ${COST_IS_UNRESOLVED} THEN 0
  WHEN ${llmUsageEvents.costState} = 'actual' THEN COALESCE(${llmUsageEvents.actualCostUsd}, 0)
  WHEN ${llmUsageEvents.costState} = 'estimated' THEN ${llmUsageEvents.estimatedCostUsd}
  ELSE COALESCE(${llmUsageEvents.actualCostUsd}, ${llmUsageEvents.estimatedCostUsd})
END`;

/** Stored metadata sources written by forward-only usage metering. */
const FALLBACK_PRICING_SOURCES = sql.raw(
  "'catalog_coefficient', 'baseline_default', 'image_default'",
);

/**
 * A row counts toward fallback disclosure only when its effective cost is the
 * frozen estimate (no provider actual) and the stored metadata says the
 * estimate used coefficient/default pricing — never the current catalog.
 */
const ROW_HAS_FALLBACK_ESTIMATE = sql`
  NOT COALESCE(${COST_IS_UNRESOLVED}, FALSE)
  AND
  ${llmUsageEvents.actualCostUsd} IS NULL
  AND (${llmUsageEvents.metadata}->>'usagePricingSource') IN (${FALLBACK_PRICING_SOURCES})
`;

export function buildCostsSummaryQueries(
  range: CostsRange,
  handle: Pick<DirectDatabase, "select">,
  payerHumanId?: string,
) {
  // The administrator dashboard represents server/service spend plus its
  // pre-provenance history. Historical NULL rows stay visibly unclassified at
  // the storage boundary and remain in totals for continuity; explicitly
  // personal-funded calls are excluded.
  const inWindow = and(
    gte(llmUsageEvents.occurredAt, new Date(range.sinceIso)),
    lt(llmUsageEvents.occurredAt, new Date(range.untilIso)),
    ...(payerHumanId === undefined
      ? [or(isNull(llmUsageEvents.fundingKind), ne(llmUsageEvents.fundingKind, "personal"))]
      : [
          eq(llmUsageEvents.fundingKind, "personal"),
          eq(llmUsageEvents.payerHumanId, payerHumanId),
        ]),
  );
  // Settled actual rows retain their frozen estimate for audit, but that
  // superseded estimate is not current estimated spend for either audience.
  const estimatedCost = CURRENT_ESTIMATED_COST;

  const totals = handle
    .select({
      calls: sql<number>`COUNT(*)::int`,
      pending_model_attempts:
        sql<number>`COUNT(*) FILTER (WHERE ${llmUsageEvents.costState} = 'pending')::int`,
      unknown_model_attempts:
        sql<number>`COUNT(*) FILTER (WHERE ${llmUsageEvents.costState} = 'unknown')::int`,
      retryable_model_attempts:
        sql<number>`COUNT(*) FILTER (WHERE ${llmUsageEvents.recoveryState} = 'retryable')::int`,
      blocked_model_attempts:
        sql<number>`COUNT(*) FILTER (WHERE ${llmUsageEvents.recoveryState} = 'blocked_repair')::int`,
      input_tokens:
        sql<number>`COALESCE(SUM(${llmUsageEvents.inputTokens}), 0)::bigint`,
      cached_input_tokens:
        sql<number>`COALESCE(SUM(${llmUsageEvents.cachedInputTokens}), 0)::bigint`,
      output_tokens:
        sql<number>`COALESCE(SUM(${llmUsageEvents.outputTokens}), 0)::bigint`,
      total_tokens:
        sql<number>`COALESCE(SUM(${llmUsageEvents.totalTokens}), 0)::bigint`,
      estimated_cost:
        sql<string>`COALESCE(SUM(${estimatedCost}), 0)`,
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
      pending_attempts:
        sql<number>`COUNT(*) FILTER (WHERE ${llmUsageEvents.costState} = 'pending')::int`,
      unknown_attempts:
        sql<number>`COUNT(*) FILTER (WHERE ${llmUsageEvents.costState} = 'unknown')::int`,
      blocked_attempts:
        sql<number>`COUNT(*) FILTER (WHERE ${llmUsageEvents.recoveryState} = 'blocked_repair')::int`,
      input_tokens:
        sql<number>`COALESCE(SUM(${llmUsageEvents.inputTokens}), 0)::bigint`,
      output_tokens:
        sql<number>`COALESCE(SUM(${llmUsageEvents.outputTokens}), 0)::bigint`,
      estimated_cost:
        sql<string>`COALESCE(SUM(${estimatedCost}), 0)`,
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
        sql<string>`COALESCE(SUM(${estimatedCost}), 0)`.as(
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
        sql<string>`COALESCE(SUM(${estimatedCost}), 0)`,
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

/** Personal model spend grouped by the actual funded transport route. */
export function buildPersonalCostsByRouteQuery(
  range: CostsRange,
  handle: Pick<DirectDatabase, "select">,
  payerHumanId: string,
) {
  return handle.select({
    provider: llmUsageEvents.providerRoute,
    operation: llmUsageEvents.callType,
    operations: sql<number>`COUNT(*)::int`,
    unknown_operations: sql<number>`COUNT(*) FILTER (
      WHERE ${llmUsageEvents.costState} IN ('pending', 'unknown')
    )::int`,
    estimated_cost: sql<string>`COALESCE(SUM(${CURRENT_ESTIMATED_COST}), 0)`,
    actual_cost: sql<string>`COALESCE(SUM(${llmUsageEvents.actualCostUsd}), 0)`,
    total_cost: sql<string>`COALESCE(SUM(${EFFECTIVE_COST}), 0)`.as("total_cost"),
  }).from(llmUsageEvents).where(and(
    gte(llmUsageEvents.occurredAt, new Date(range.sinceIso)),
    lt(llmUsageEvents.occurredAt, new Date(range.untilIso)),
    eq(llmUsageEvents.fundingKind, "personal"),
    eq(llmUsageEvents.payerHumanId, payerHumanId),
  )).groupBy(llmUsageEvents.providerRoute, llmUsageEvents.callType)
    .orderBy(({ total_cost }) => desc(total_cost));
}

/** Personal model spend grouped by Task, without joining protected Task content. */
export function buildPersonalCostsByTaskQuery(
  range: CostsRange,
  handle: Pick<DirectDatabase, "select">,
  payerHumanId: string,
) {
  return handle.select({
    task_id: llmUsageEvents.taskId,
    calls: sql<number>`COUNT(*)::int`,
    pending_attempts:
      sql<number>`COUNT(*) FILTER (WHERE ${llmUsageEvents.costState} = 'pending')::int`,
    unknown_attempts:
      sql<number>`COUNT(*) FILTER (WHERE ${llmUsageEvents.costState} = 'unknown')::int`,
    estimated_cost: sql<string>`COALESCE(SUM(${CURRENT_ESTIMATED_COST}), 0)`,
    actual_cost: sql<string>`COALESCE(SUM(${llmUsageEvents.actualCostUsd}), 0)`,
    total_cost: sql<string>`COALESCE(SUM(${EFFECTIVE_COST}), 0)`.as("total_cost"),
  }).from(llmUsageEvents).where(and(
    gte(llmUsageEvents.occurredAt, new Date(range.sinceIso)),
    lt(llmUsageEvents.occurredAt, new Date(range.untilIso)),
    eq(llmUsageEvents.fundingKind, "personal"),
    eq(llmUsageEvents.payerHumanId, payerHumanId),
    isNotNull(llmUsageEvents.taskId),
  )).groupBy(llmUsageEvents.taskId)
    .orderBy(({ total_cost }) => desc(total_cost));
}

/** Bounded, content-free unresolved-attempt diagnostics for one audience. */
export function buildCostsRecoveryAttemptsQuery(
  range: CostsRange,
  handle: Pick<DirectDatabase, "select">,
  payerHumanId?: string,
) {
  return handle.select({
    id: llmUsageEvents.id,
    taskId: llmUsageEvents.taskId,
    providerRoute: llmUsageEvents.providerRoute,
    providerRequestId: llmUsageEvents.providerRequestId,
    costState: llmUsageEvents.costState,
    recoveryState: llmUsageEvents.recoveryState,
    failureCode: llmUsageEvents.failureCode,
    updatedAt: llmUsageEvents.updatedAt,
  }).from(llmUsageEvents).where(and(
    gte(llmUsageEvents.occurredAt, new Date(range.sinceIso)),
    lt(llmUsageEvents.occurredAt, new Date(range.untilIso)),
    inArray(llmUsageEvents.costState, ["pending", "unknown"]),
    ...(payerHumanId === undefined
      ? [or(isNull(llmUsageEvents.fundingKind), ne(llmUsageEvents.fundingKind, "personal"))]
      : [
          eq(llmUsageEvents.fundingKind, "personal"),
          eq(llmUsageEvents.payerHumanId, payerHumanId),
        ]),
  )).orderBy(desc(llmUsageEvents.updatedAt), desc(llmUsageEvents.id))
    .limit(DEFAULT_SURPLUS_RECOVERY_BATCH_LIMIT);
}

const SAFE_RECOVERY_REASONS = new Set([
  "adapted_parameters",
  "cancelled",
  "credential_custody_unavailable",
  "credential_fingerprint_mismatch",
  "credential_lookup_failed",
  "credential_missing",
  "credential_replaced",
  "incomplete_response",
  "no_sellers_for_model",
  "outcome_unknown",
  "pre_service_refusal",
  "provider_refused",
  "provider_route_mismatch",
  "receipt_account_unproven",
  "receipt_binding_invalid",
  "receipt_binding_missing",
  "receipt_binding_pending",
  "receipt_endpoint_unsupported",
  "receipt_not_confirmed",
  "receipt_not_found",
  "receipt_rate_limited",
  "receipt_read_failed",
  "receipt_read_unauthorized",
  "receipt_read_unavailable",
  "receipt_request_rejected",
  "receipt_service_unavailable",
  "truncated_response",
]);

function safeRecoveryReason(value: string | null, fallback: string): string {
  return value !== null && SAFE_RECOVERY_REASONS.has(value) ? value : fallback;
}

// A 48-bit display tag is compact enough to copy while distinguishing the at
// most 100 recent rows in this diagnostic. It is correlation, not identity or
// a security boundary; the raw provider receipt remains server-side.
const SAFE_REQUEST_REFERENCE_HEX_LENGTH = 12;

function safeRequestReference(providerRequestId: string | null): string | null {
  if (providerRequestId === null) return null;
  const digest = createHash("sha256").update(providerRequestId, "utf8").digest("hex");
  return `req_${digest.slice(0, SAFE_REQUEST_REFERENCE_HEX_LENGTH)}`;
}

function personalRecoveryAttempt(row: {
  id: string;
  taskId: string | null;
  providerRoute: string | null;
  providerRequestId: string | null;
  costState: "actual" | "estimated" | "pending" | "unknown" | null;
  recoveryState: "pending" | "retryable" | "blocked_repair" | null;
  failureCode: string | null;
  updatedAt: Date;
}): PersonalCostsRecoveryAttempt {
  const status = row.recoveryState === "blocked_repair"
    ? "blocked"
    : row.recoveryState === "retryable"
      ? "retryable"
      : row.recoveryState === "pending" || row.costState === "pending"
        ? "pending"
        : "unrecoverable";
  const fallbackReason = status === "blocked"
    ? "receipt_recovery_blocked"
    : status === "retryable"
      ? "receipt_read_retry_scheduled"
      : status === "pending"
        ? "awaiting_provider_receipt"
        : "cost_evidence_unavailable";
  const reason = safeRecoveryReason(row.failureCode, fallbackReason);
  const repairAction = status === "blocked"
    ? reason === "receipt_read_unavailable" || reason === "receipt_read_unauthorized" || reason === "receipt_account_unproven"
      ? "check_receipt_access"
      : reason === "credential_custody_unavailable"
        ? "contact_operator"
        : "review_cost"
    : status === "retryable"
      ? "retry_receipt_read"
      : status === "pending"
        ? "wait_for_receipt"
        : "review_cost";
  return {
    attemptId: row.id,
    status,
    reason,
    providerRoute: row.providerRoute ?? "unknown",
    requestReference: safeRequestReference(row.providerRequestId),
    lastObservedAt: row.updatedAt.toISOString(),
    repairAction,
    taskId: row.taskId,
  };
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
  const recoveryRows = await buildCostsRecoveryAttemptsQuery(range, db());

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
      pendingModelAttempts: n(totalsRow?.["pending_model_attempts"]),
      unknownModelAttempts: n(totalsRow?.["unknown_model_attempts"]),
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
      pendingAttempts: n(r["pending_attempts"]),
      unknownAttempts: n(r["unknown_attempts"]),
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
    recovery: {
      pendingAttempts: n(totalsRow?.["pending_model_attempts"]),
      retryableAttempts: n(totalsRow?.["retryable_model_attempts"]),
      blockedAttempts: n(totalsRow?.["blocked_model_attempts"]),
      unknownAttempts: n(totalsRow?.["unknown_model_attempts"]),
      attempts: recoveryRows.map(personalRecoveryAttempt),
    },
  };
}

export type PersonalCostsData = Omit<
  PersonalCostsSummary,
  "currency" | "range" | "pricingVersion"
>;

/** Account-scoped costs. Every aggregation applies payer identity in SQL. */
export async function getPersonalCostsSummary(input: {
  payerHumanId: string;
  range: CostsRange;
}): Promise<PersonalCostsData> {
  const payerHumanId = assertNonEmpty(input.payerHumanId, "payerHumanId");
  const queries = buildCostsSummaryQueries(input.range, db(), payerHumanId);
  const providerQueries = buildProviderCostsSummaryQueries(input.range, db(), payerHumanId);
  const modelByRouteQuery = buildPersonalCostsByRouteQuery(input.range, db(), payerHumanId);
  const modelByTaskQuery = buildPersonalCostsByTaskQuery(input.range, db(), payerHumanId);
  const [
    [totalsRow], byModelRows, byCallTypeRows, modelTimeSeriesRows,
    [providerTotalsRow], byProviderRows, providerTimeSeriesRows, modelByRouteRows,
    modelByTaskRows, recoveryRows, credentialRows, llmHistoryRows, providerHistoryRows,
  ] = await Promise.all([
    queries.totals,
    queries.byModel,
    queries.byCallType,
    queries.timeSeries,
    providerQueries.totals,
    providerQueries.byProvider,
    providerQueries.timeSeries,
    modelByRouteQuery,
    modelByTaskQuery,
    buildCostsRecoveryAttemptsQuery(input.range, db(), payerHumanId),
    db().select({ id: personalProviderCredentials.id })
      .from(personalProviderCredentials)
      .where(eq(personalProviderCredentials.userId, payerHumanId))
      .limit(1),
    db().select({ id: llmUsageEvents.id })
      .from(llmUsageEvents)
      .where(and(
        eq(llmUsageEvents.fundingKind, "personal"),
        eq(llmUsageEvents.payerHumanId, payerHumanId),
      ))
      .limit(1),
    db().select({ id: providerCostEvents.id })
      .from(providerCostEvents)
      .where(and(
        eq(providerCostEvents.fundingKind, "personal"),
        eq(providerCostEvents.payerHumanId, payerHumanId),
      ))
      .limit(1),
  ]);

  const providerOperations = n(providerTotalsRow?.["operations"]);
  const providerEstimatedCostUsd = n(providerTotalsRow?.["estimated_cost"]);
  const providerActualCostUsd = n(providerTotalsRow?.["actual_cost"]);
  const providerTotalCostUsd = n(providerTotalsRow?.["total_cost"]);
  const pendingAttempts = n(totalsRow?.["pending_model_attempts"]);
  const unknownAttempts = n(totalsRow?.["unknown_model_attempts"]);
  const retryableAttempts = n(totalsRow?.["retryable_model_attempts"]);
  const blockedAttempts = n(totalsRow?.["blocked_model_attempts"]);

  const byModel: PersonalCostsByModelRow[] = byModelRows.map((row) => ({
    model: String(row["model"]),
    provider: String(row["provider"]),
    displayName: String(row["model"]),
    calls: n(row["calls"]),
    inputTokens: n(row["input_tokens"]),
    outputTokens: n(row["output_tokens"]),
    estimatedCostUsd: n(row["estimated_cost"]),
    actualCostUsd: n(row["actual_cost"]),
    totalCostUsd: n(row["total_cost"]),
    hasActual: row["has_actual"] === true,
    hasFallbackEstimate: row["has_fallback_estimate"] === true,
    pendingAttempts: n(row["pending_attempts"]),
    unknownAttempts: n(row["unknown_attempts"]),
    blockedAttempts: n(row["blocked_attempts"]),
  }));
  const byCallType: PersonalCostsByCallTypeRow[] = byCallTypeRows.map((row) => ({
    callType: String(row["call_type"]),
    calls: n(row["calls"]),
    totalCostUsd: n(row["total_cost"]),
  }));
  const byProvider: PersonalCostsByProviderRow[] = byProviderRows.map((row) => ({
    provider: String(row["provider"]),
    operation: String(row["operation"]),
    operations: n(row["operations"]),
    unknownOperations: n(row["unknown_operations"]),
    estimatedCostUsd: n(row["estimated_cost"]),
    actualCostUsd: n(row["actual_cost"]),
    totalCostUsd: n(row["total_cost"]),
  }));
  byProvider.push(...modelByRouteRows.map((row) => ({
    provider: String(row["provider"]),
    operation: String(row["operation"]),
    operations: n(row["operations"]),
    unknownOperations: n(row["unknown_operations"]),
    estimatedCostUsd: n(row["estimated_cost"]),
    actualCostUsd: n(row["actual_cost"]),
    totalCostUsd: n(row["total_cost"]),
  })));
  byProvider.sort((left, right) => right.totalCostUsd - left.totalCostUsd);
  const byTask: PersonalCostsByTaskRow[] = modelByTaskRows.map((row) => ({
    taskId: String(row["task_id"]),
    calls: n(row["calls"]),
    estimatedCostUsd: n(row["estimated_cost"]),
    actualCostUsd: n(row["actual_cost"]),
    totalCostUsd: n(row["total_cost"]),
    pendingAttempts: n(row["pending_attempts"]),
    unknownAttempts: n(row["unknown_attempts"]),
  }));
  const days = new Map<string, PersonalCostsTimeSeriesPoint>();
  for (const row of modelTimeSeriesRows) {
    const day = String(row["day"]);
    days.set(day, {
      day,
      estimatedCostUsd: n(row["estimated_cost"]),
      actualCostUsd: n(row["actual_cost"]),
      totalCostUsd: n(row["total_cost"]),
    });
  }
  for (const row of providerTimeSeriesRows) {
    const day = String(row["day"]);
    const current = days.get(day);
    days.set(day, {
      day,
      estimatedCostUsd: (current?.estimatedCostUsd ?? 0) + n(row["estimated_cost"]),
      actualCostUsd: (current?.actualCostUsd ?? 0) + n(row["actual_cost"]),
      totalCostUsd: (current?.totalCostUsd ?? 0) + n(row["total_cost"]),
    });
  }
  const hasPersonalCredentials = credentialRows.length > 0;
  const hasHistory = llmHistoryRows.length > 0 || providerHistoryRows.length > 0;
  return {
    entry: {
      available: hasPersonalCredentials || hasHistory,
      hasPersonalCredentials,
      hasHistory,
    },
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
      pendingAttempts,
      unknownAttempts,
      retryableAttempts,
      blockedAttempts,
    },
    byModel,
    byCallType,
    byProvider,
    byTask,
    timeSeries: [...days.values()].sort((left, right) => left.day.localeCompare(right.day)),
    recovery: {
      pendingAttempts,
      retryableAttempts,
      blockedAttempts,
      unknownAttempts,
      attempts: recoveryRows.map(personalRecoveryAttempt),
    },
  };
}
