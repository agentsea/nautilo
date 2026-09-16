import { sql } from "drizzle-orm";
import {
  memoryAdminStatusSchema, memoryRetryResponseSchema,
  MEMORY_REVIEW_AUTOMATIC_RETRY_CODES, MEMORY_REVIEW_MANUAL_RETRY_CODES,
  memoryReviewFailureCodeSchema, memoryReviewFailurePhaseSchema,
  type MemoryAdminStatus,
} from "@nautilo/types";
import type { DirectDatabase } from "../config/direct-database";

export interface MemoryReviewStatusInput {
  now: Date;
  since: Date;
  until: Date;
  enabled: boolean;
  threshold: number;
  model: MemoryAdminStatus["model"];
  encryption: MemoryAdminStatus["encryption"];
}

/** One SQL snapshot. Group only metadata; no content or Room labels are read. */
export function buildMemoryReviewStatusQuery(input: MemoryReviewStatusInput) {
  const now = input.now.toISOString();
  const since = input.since.toISOString();
  const until = input.until.toISOString();
  return sql`
    WITH ranges AS (
      SELECT t.*,
        min(first_message_id) FILTER (WHERE state IN ('pending','awaiting'))
          OVER (PARTITION BY session_id, agent_id, owner_id, access_scope) AS barrier,
        sum(has_human) FILTER (WHERE state = 'completed') OVER (
          PARTITION BY session_id, agent_id, owner_id, access_scope ORDER BY first_message_id ROWS UNBOUNDED PRECEDING
        ) AS completed_position,
        max(completed_at) FILTER (WHERE state IN ('completed','interrupted')) OVER (
          PARTITION BY session_id, agent_id, owner_id, access_scope ORDER BY first_message_id ROWS UNBOUNDED PRECEDING
        ) AS prefix_completed_at
      FROM memory_review_turns t
    ), scopes AS (
      SELECT session_id, agent_id, owner_id, access_scope,
        count(*) FILTER (WHERE state <> 'covered') AS pending,
        coalesce(sum(has_human) FILTER (WHERE state = 'completed'
          AND (barrier IS NULL OR first_message_id < barrier)), 0) AS ready,
        coalesce(bool_or(state <> 'covered' AND attempt_id IS NOT NULL AND lease_until > ${now}::timestamptz), false) AS processing,
        bool_or(state <> 'covered' AND failure_code IS NOT NULL
          AND NOT (failure_code = ANY(${sql.param(MEMORY_REVIEW_MANUAL_RETRY_CODES)}::text[]))) AS unsafe_failure,
        bool_or(state <> 'covered' AND failure_code IS NOT NULL
          AND NOT (failure_code = ANY(${sql.param(MEMORY_REVIEW_AUTOMATIC_RETRY_CODES)}::text[]))) AS blocked_failure,
        bool_or(state <> 'covered' AND failure_code = ANY(${sql.param(MEMORY_REVIEW_MANUAL_RETRY_CODES)}::text[])) AS safe_failure,
        bool_or(state IN ('completed','interrupted') AND first_message_id > barrier) AS blocked_range,
        max(retry_at) FILTER (WHERE state <> 'covered' AND failure_code IS NOT NULL) AS retry_at,
        min(prefix_completed_at) FILTER (WHERE state IN ('completed','interrupted')
          AND completed_position >= ${input.threshold}
          AND (barrier IS NULL OR first_message_id < barrier)) AS due_since,
        min(created_at) AS tracked_since,
        max(last_attempt_at) AS last_attempt_at
      FROM ranges GROUP BY session_id, agent_id, owner_id, access_scope
    ), classified AS (
      SELECT *, CASE
        WHEN pending = 0 THEN 'caughtUp'
        WHEN processing THEN 'processing'
        WHEN blocked_failure THEN 'blocked'
        WHEN safe_failure AND retry_at > ${now}::timestamptz THEN 'retrying'
        WHEN safe_failure AND retry_at IS NULL THEN 'blocked'
        WHEN ready >= ${input.threshold} THEN 'due'
        WHEN blocked_range THEN 'blocked'
        ELSE 'accumulating' END AS state
      FROM scopes
    ), current AS (
      SELECT jsonb_build_object(
        'accumulating', count(*) FILTER (WHERE state = 'accumulating'),
        'due', count(*) FILTER (WHERE state = 'due'),
        'processing', count(*) FILTER (WHERE state = 'processing'),
        'retrying', count(*) FILTER (WHERE state = 'retrying'),
        'blocked', count(*) FILTER (WHERE state = 'blocked'),
        'caughtUp', count(*) FILTER (WHERE state = 'caughtUp'),
        'safelyRetryable', count(*) FILTER (WHERE safe_failure AND NOT processing AND NOT unsafe_failure),
        'oldestOverdueMs', greatest(0, extract(epoch FROM (${now}::timestamptz -
          min(due_since) FILTER (WHERE state = 'due'))) * 1000)
      ) AS data, min(tracked_since) AS tracked_since, max(last_attempt_at) AS last_attempt_at
      FROM classified
    ), receipts AS (
      SELECT count(*) FILTER (WHERE outcome = 'published' AND created_at BETWEEN ${since}::timestamptz AND ${until}::timestamptz) AS completed,
        count(*) FILTER (WHERE outcome = 'published' AND created_at BETWEEN ${since}::timestamptz AND ${until}::timestamptz
          AND (counts->>'created')::integer + (counts->>'replaced')::integer + (counts->>'promoted')::integer + (counts->>'demoted')::integer = 0) AS no_change,
        count(*) FILTER (WHERE outcome = 'failed' AND created_at BETWEEN ${since}::timestamptz AND ${until}::timestamptz) AS failures,
        coalesce(sum((counts->>'created')::integer) FILTER (WHERE outcome = 'published' AND created_at BETWEEN ${since}::timestamptz AND ${until}::timestamptz), 0) AS created,
        coalesce(sum((counts->>'replaced')::integer) FILTER (WHERE outcome = 'published' AND created_at BETWEEN ${since}::timestamptz AND ${until}::timestamptz), 0) AS replaced,
        coalesce(sum((counts->>'promoted')::integer) FILTER (WHERE outcome = 'published' AND created_at BETWEEN ${since}::timestamptz AND ${until}::timestamptz), 0) AS promoted,
        coalesce(sum((counts->>'demoted')::integer) FILTER (WHERE outcome = 'published' AND created_at BETWEEN ${since}::timestamptz AND ${until}::timestamptz), 0) AS demoted,
        max(created_at) FILTER (WHERE outcome = 'published') AS last_success,
        count(*) FILTER (WHERE outcome = 'published' AND jsonb_array_length(effects) > delivered) AS follow_up
      FROM memory_review_receipts
    ), failure_groups AS (
      SELECT CASE WHEN phase = ANY(${sql.param(memoryReviewFailurePhaseSchema.options)}::text[]) THEN phase ELSE 'unknown' END AS phase,
        CASE WHEN code = ANY(${sql.param(memoryReviewFailureCodeSchema.options)}::text[]) THEN code ELSE 'unknown' END AS code,
        max(created_at) AS occurred_at
      FROM memory_review_receipts WHERE (outcome = 'failed' OR code = 'effect_delivery_failed')
        AND created_at BETWEEN ${since}::timestamptz AND ${until}::timestamptz
      GROUP BY 1, 2
    )
    SELECT jsonb_build_object(
      'generatedAt', ${now}::text, 'window', jsonb_build_object('since', ${since}::text, 'until', ${until}::text),
      'enabled', ${input.enabled}::boolean, 'model', ${JSON.stringify(input.model)}::jsonb,
      'encryption', ${JSON.stringify(input.encryption)}::jsonb,
      'trackedSince', current.tracked_since,
      'health', CASE WHEN NOT ${input.enabled} THEN 'paused'
        WHEN NOT ${input.model.available} OR NOT ${input.encryption.available} THEN 'unavailable'
        WHEN (current.data->>'blocked')::integer > 0 OR receipts.follow_up > 0 THEN 'degraded'
        WHEN (current.data->>'due')::integer > 0 OR (current.data->>'retrying')::integer > 0 THEN 'delayed'
        WHEN current.tracked_since IS NULL OR (current.data->>'accumulating')::integer > 0 THEN 'waiting'
        ELSE 'healthy' END,
      'current', current.data,
      'lastSuccessfulReviewAt', coalesce(receipts.last_success,
        (SELECT max(last_attempt_at) FROM memory_review_turns WHERE state = 'covered')),
      'lastAttemptAt', current.last_attempt_at,
      'last24h', jsonb_build_object('completedReviews', receipts.completed, 'noChangeReviews', receipts.no_change,
        'created', receipts.created, 'replaced', receipts.replaced, 'promoted', receipts.promoted,
        'demoted', receipts.demoted, 'failures', receipts.failures,
        'lastReviewDurationMs', (SELECT duration_ms FROM memory_review_receipts WHERE outcome = 'published' ORDER BY created_at DESC LIMIT 1)),
      'recentFailures', coalesce((SELECT jsonb_agg(jsonb_build_object(
        'phase', f.phase, 'code', f.code, 'occurredAt', f.occurred_at,
        'nextRetryAt', (SELECT min(t.retry_at) FROM memory_review_turns t WHERE t.state <> 'covered' AND t.failure_code = f.code),
        'retryable', f.code = ANY(${sql.param(MEMORY_REVIEW_MANUAL_RETRY_CODES)}::text[]) AND EXISTS (
          SELECT 1 FROM memory_review_turns t WHERE t.state <> 'covered' AND t.failure_code = f.code
            AND (t.lease_until IS NULL OR t.lease_until <= ${now}::timestamptz))
      ) ORDER BY f.occurred_at DESC) FROM failure_groups f), '[]'::jsonb),
      'followUpPending', receipts.follow_up, 'exitFlush', 'not_scheduled'
    ) AS status FROM current CROSS JOIN receipts
  `;
}

function firstRow(result: unknown): Record<string, unknown> {
  const data = Array.isArray(result) ? result :
    result && typeof result === "object" && "rows" in result ? result.rows : null;
  if (!Array.isArray(data) || !data[0] || typeof data[0] !== "object") {
    throw new Error("Memory status query returned no observation");
  }
  return data[0] as Record<string, unknown>;
}

export async function queryMemoryReviewStatus(
  db: Pick<DirectDatabase, "execute">, input: MemoryReviewStatusInput,
): Promise<MemoryAdminStatus> {
  return memoryAdminStatusSchema.parse(firstRow(await db.execute(buildMemoryReviewStatusQuery(input)))["status"]);
}

/** Only safe failures change; publication/authority failures never become a run button. */
export function buildRetryFailedMemoryReviewsQuery(now: Date) {
  return sql`
    WITH retried AS (
      UPDATE memory_review_turns t
      SET failure_code = NULL, failure_phase = NULL, retry_at = NULL, updated_at = ${now.toISOString()}::timestamptz
      WHERE t.state <> 'covered' AND t.receipt_id IS NULL
        AND (t.attempt_id IS NULL OR t.lease_until IS NULL OR t.lease_until <= ${now.toISOString()}::timestamptz)
        AND t.failure_code = ANY(${sql.param(MEMORY_REVIEW_MANUAL_RETRY_CODES)}::text[])
        AND NOT EXISTS (SELECT 1 FROM memory_review_turns active
          WHERE active.session_id = t.session_id AND active.agent_id = t.agent_id
            AND active.owner_id = t.owner_id AND active.access_scope = t.access_scope
            AND active.attempt_id IS NOT NULL AND active.lease_until > ${now.toISOString()}::timestamptz)
        AND NOT EXISTS (SELECT 1 FROM memory_review_turns blocked
          WHERE blocked.session_id = t.session_id AND blocked.agent_id = t.agent_id
            AND blocked.owner_id = t.owner_id AND blocked.access_scope = t.access_scope
            AND blocked.state <> 'covered' AND blocked.failure_code IS NOT NULL
            AND NOT (blocked.failure_code = ANY(${sql.param(MEMORY_REVIEW_MANUAL_RETRY_CODES)}::text[])))
      RETURNING t.session_id, t.agent_id, t.owner_id, t.access_scope
    ) SELECT count(*)::integer AS requested FROM (
      SELECT DISTINCT session_id, agent_id, owner_id, access_scope FROM retried
    ) scopes
  `;
}

export async function retryFailedMemoryReviews(
  db: Pick<DirectDatabase, "execute">, now = new Date(),
): Promise<{ requested: number }> {
  return memoryRetryResponseSchema.parse(firstRow(await db.execute(buildRetryFailedMemoryReviewsQuery(now))));
}
