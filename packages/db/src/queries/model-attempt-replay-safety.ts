import { and, eq, inArray, isNull, notExists, notInArray, or, sql } from "drizzle-orm";
import { QueryBuilder } from "drizzle-orm/pg-core";
import { getSharedDirectDb, type DirectDatabase } from "../config/direct-database";
import { llmUsageEvents } from "../schema/llm-usage";
import { memoryReviewReceipts } from "../schema/memory-review";

export const KNOWN_NONUSABLE_MEMORY_REVIEW_FAILURES = ["invalid_proposal", "iteration_exhausted"] as const;

export type ModelAttemptReplayIdentity =
  | Readonly<{
      kind: "memory_review";
      roomId: string;
      workId: string;
    }>
  | Readonly<{
      kind: "operation";
      roomId: string;
      callType: "room_stenographer" | "room_event_compaction" | "room_reflection" | "image_assistance";
      operationId: string;
    }>;

export type ModelAttemptReplaySafety = Readonly<{
  decision: "allow" | "block_unknown";
  blockingAttemptId?: string;
}>;

type ModelAttemptReplayDb = Pick<DirectDatabase, "select">;

/** The operator recovery is limited to exact, already settled service calls. */
export async function hasSettledServiceMemoryReview(
  input: Readonly<{ roomId: string; workId: string; modelId: string }>,
  db: ModelAttemptReplayDb,
): Promise<boolean> {
  const rows = await db.select({
    fundingKind: llmUsageEvents.fundingKind,
    payerHumanId: llmUsageEvents.payerHumanId,
    providerRoute: llmUsageEvents.providerRoute,
    model: llmUsageEvents.model,
    actualCost: llmUsageEvents.actualCostUsd,
    requestId: llmUsageEvents.providerRequestId,
    attemptOutcome: llmUsageEvents.attemptOutcome,
    costState: llmUsageEvents.costState,
    recoveryState: llmUsageEvents.recoveryState,
    attemptId: sql<string | null>`${llmUsageEvents.metadata}->>'attemptId'`,
  }).from(llmUsageEvents).where(and(
    eq(llmUsageEvents.roomId, input.roomId),
    eq(llmUsageEvents.callType, "memory_review"),
    eq(sql<string>`${llmUsageEvents.metadata}->>'workId'`, input.workId),
  ));
  return rows.length > 0 && rows.every((row) =>
    (row.fundingKind === "service" || row.fundingKind === "server")
    && row.payerHumanId === null
    && row.providerRoute === "surplus"
    && row.model === input.modelId
    && row.actualCost !== null
    && row.requestId
    && row.attemptId
    && row.attemptOutcome === "succeeded"
    && row.costState === "actual"
    && row.recoveryState === null);
}

type AttemptRow = Pick<
  typeof llmUsageEvents.$inferSelect,
  "id" | "attemptOutcome" | "failureCode" | "metadata"
>;

const SAFE_PRE_SERVICE_FAILURE_CODES = [
  "provider_refused",
  "no_sellers_for_model",
  "pre_service_refusal",
] as const;

function isSafePreServiceFailure(row: AttemptRow): boolean {
  return row.attemptOutcome === "failed"
    && typeof row.failureCode === "string"
    && (SAFE_PRE_SERVICE_FAILURE_CODES as readonly string[]).includes(row.failureCode);
}

/**
 * Pure classification for a job-owned operation. A durable funding binding is
 * not wire evidence. Once a matching wire row exists, only a verified
 * provider refusal can authorize another call; a canonical job owner may also
 * declare that its retained model result was unusable.
 */
export function classifyModelAttemptReplaySafety(
  rows: readonly AttemptRow[],
  options: Readonly<{ knownNonusableResult?: boolean }> = {},
): ModelAttemptReplaySafety {
  for (const row of rows) {
    if (isSafePreServiceFailure(row)) continue;
    if (row.attemptOutcome === "succeeded" && options.knownNonusableResult === true) continue;
    return { decision: "block_unknown", blockingAttemptId: row.id };
  }
  return { decision: "allow" };
}

/** Match one stable work identity and inspect at most one blocking wire outcome. */
export async function resolveModelAttemptReplaySafety(
  identity: ModelAttemptReplayIdentity,
  options: Readonly<{ db?: ModelAttemptReplayDb; knownNonusableResult?: boolean }> = {},
): Promise<ModelAttemptReplaySafety> {
  const callType = identity.kind === "memory_review" ? "memory_review" : identity.callType;
  // Image assistance has no separate durable work row that can prove a
  // succeeded provider result was unusable. Without a retained transcript
  // observation, every non-refusal wire outcome remains non-replayable.
  const knownNonusableResult = options.knownNonusableResult === true
    && identity.kind === "operation" && callType !== "image_assistance";
  const unsafeFailedAttempt = and(
    eq(llmUsageEvents.attemptOutcome, "failed"),
    or(
      isNull(llmUsageEvents.failureCode),
      notInArray(llmUsageEvents.failureCode, [...SAFE_PRE_SERVICE_FAILURE_CODES]),
    ),
  );
  const provenRejection = identity.kind === "memory_review"
    ? new QueryBuilder().select({ id: memoryReviewReceipts.id }).from(memoryReviewReceipts).where(and(
        eq(memoryReviewReceipts.workId, identity.workId),
        eq(sql<string>`${memoryReviewReceipts.id}::text`, sql<string>`${llmUsageEvents.metadata}->>'attemptId'`),
        eq(memoryReviewReceipts.outcome, "failed"),
        eq(memoryReviewReceipts.phase, "model"),
        inArray(memoryReviewReceipts.code, [...KNOWN_NONUSABLE_MEMORY_REVIEW_FAILURES]),
      ))
    : undefined;
  const blockingAttempt = or(
    isNull(llmUsageEvents.attemptOutcome),
    notInArray(llmUsageEvents.attemptOutcome, ["failed", "succeeded"]),
    unsafeFailedAttempt,
    knownNonusableResult ? undefined : and(
      eq(llmUsageEvents.attemptOutcome, "succeeded"),
      provenRejection === undefined ? undefined : notExists(provenRejection),
    ),
  );
  const rows = await (options.db ?? getSharedDirectDb())
    .select({
      id: llmUsageEvents.id,
      attemptOutcome: llmUsageEvents.attemptOutcome,
      failureCode: llmUsageEvents.failureCode,
      metadata: llmUsageEvents.metadata,
    })
    .from(llmUsageEvents)
    .where(and(
      eq(llmUsageEvents.roomId, identity.roomId),
      eq(llmUsageEvents.callType, callType),
      ...(identity.kind === "memory_review"
        ? [eq(sql<string>`${llmUsageEvents.metadata}->>'workId'`, identity.workId)]
        : [eq(sql<string>`${llmUsageEvents.metadata}->>'operationId'`, identity.operationId)]),
      blockingAttempt,
    ))
    .limit(1);
  return classifyModelAttemptReplaySafety(rows, { knownNonusableResult });
}
