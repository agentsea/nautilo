import { and, eq, inArray, isNull, ne, notInArray, or, sql } from "drizzle-orm";
import { getSharedDirectDb, type DirectDatabase } from "../config/direct-database";
import { llmUsageEvents } from "../schema/llm-usage";

export type ModelAttemptReplayIdentity =
  | Readonly<{
      kind: "memory_review";
      roomId: string;
      workId: string;
      attemptIds: readonly string[];
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

/** Bounded callers pass exact prior attempt ids or one stable operation id. */
export async function resolveModelAttemptReplaySafety(
  identity: ModelAttemptReplayIdentity,
  options: Readonly<{ db?: ModelAttemptReplayDb; knownNonusableResult?: boolean }> = {},
): Promise<ModelAttemptReplaySafety> {
  if (identity.kind === "memory_review" && identity.attemptIds.length === 0) {
    return { decision: "allow" };
  }
  const callType = identity.kind === "memory_review" ? "memory_review" : identity.callType;
  // Image assistance has no separate durable work row that can prove a
  // succeeded provider result was unusable. Without a retained transcript
  // observation, every non-refusal wire outcome remains non-replayable.
  const knownNonusableResult = options.knownNonusableResult === true
    && callType !== "image_assistance";
  const unsafeFailedAttempt = and(
    eq(llmUsageEvents.attemptOutcome, "failed"),
    or(
      isNull(llmUsageEvents.failureCode),
      notInArray(llmUsageEvents.failureCode, [...SAFE_PRE_SERVICE_FAILURE_CODES]),
    ),
  );
  const blockingAttempt = knownNonusableResult
    ? or(
        isNull(llmUsageEvents.attemptOutcome),
        notInArray(llmUsageEvents.attemptOutcome, ["failed", "succeeded"]),
        unsafeFailedAttempt,
      )
    : or(
        isNull(llmUsageEvents.attemptOutcome),
        ne(llmUsageEvents.attemptOutcome, "failed"),
        unsafeFailedAttempt,
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
        ? [
            eq(sql<string>`${llmUsageEvents.metadata}->>'workId'`, identity.workId),
            inArray(sql<string>`${llmUsageEvents.metadata}->>'attemptId'`, [...identity.attemptIds]),
          ]
        : [eq(sql<string>`${llmUsageEvents.metadata}->>'operationId'`, identity.operationId)]),
      blockingAttempt,
    ))
    .limit(1);
  return classifyModelAttemptReplaySafety(rows, { knownNonusableResult });
}
