import type { StenographerAdminStatus } from "@nautilo/types";
import { and, desc, eq, gt, gte, isNotNull, lte, sql } from "drizzle-orm";
import type { DirectDatabase } from "../config/direct-database";
import { getSharedDirectDb } from "../config/database";
import {
  roomEvents,
  roomJournalBatches,
  roomJournalState,
} from "../schema/room-journal";

interface CurrentRow {
  eligible_rooms: number | string;
  caught_up_rooms: number | string;
  accumulating_rooms: number | string;
  processing_rooms: number | string;
  retrying_rooms: number | string;
  due_rooms: number | string;
  stale_leases: number | string;
  oldest_overdue_ms: number | string;
  maximum_failure_count: number | string;
  rebuilding_rooms: number | string;
  historical_pending_rooms: number | string;
  historical_completed_rooms: number | string;
}

interface JournalCompactionRow {
  projected_body_code_points_p50: number | string | null;
  projected_body_code_points_p95: number | string | null;
  projected_body_code_points_max: number | string | null;
  awaiting_rooms: number | string;
  processing_rooms: number | string;
  retrying_rooms: number | string;
  stale_leases: number | string;
  oldest_overdue_ms: number | string;
  maximum_failure_count: number | string;
  last_completed_at: string | Date | null;
}

interface FailureRow {
  stage: "extraction" | "compaction";
  error_code: StenographerAdminStatus["recentFailures"][number]["errorCode"];
  occurred_at: string | Date;
  attempt_count: number | string;
  model_id: string | null;
}

function rows<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  if (
    result !== null &&
    typeof result === "object" &&
    "rows" in result &&
    Array.isArray((result as { rows: unknown }).rows)
  ) {
    return (result as { rows: T[] }).rows;
  }
  return [];
}

function n(value: number | string | null | undefined): number {
  if (value == null) return 0;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function nullableNumber(value: number | string | null): number | null {
  return value === null ? null : n(value);
}

function iso(value: string | Date): string {
  return (value instanceof Date ? value : new Date(value)).toISOString();
}

export function buildStenographerRollingStatusQuery(
  input: { since: Date; until: Date },
  db: Pick<DirectDatabase, "select">,
) {
  const completedInWindow = and(
    eq(roomJournalBatches.status, "completed"),
    gte(roomJournalBatches.completedAt, input.since),
    lte(roomJournalBatches.completedAt, input.until),
  );
  const erroredInWindow = and(
    gte(roomJournalBatches.lastErrorAt, input.since),
    lte(roomJournalBatches.lastErrorAt, input.until),
  );
  const eventsInWindow = and(
    gte(roomEvents.createdAt, input.since),
    lte(roomEvents.createdAt, input.until),
  );

  return db
    .select({
      completed_extraction_batches:
        sql<number>`COUNT(*) FILTER (WHERE ${completedInWindow})::integer`,
      extraction_batches_with_errors:
        sql<number>`COUNT(*) FILTER (WHERE ${erroredInWindow})::integer`,
      retried_extraction_batches:
        sql<number>`COUNT(*) FILTER (
          WHERE ${completedInWindow} AND ${gt(roomJournalBatches.attemptCount, 1)}
        )::integer`,
      zero_event_extraction_batches:
        sql<number>`COUNT(*) FILTER (
          WHERE ${completedInWindow} AND ${eq(roomJournalBatches.operationCount, 0)}
        )::integer`,
      events_written: sql<number>`(
        SELECT COUNT(*)::integer
        FROM ${roomEvents}
        WHERE ${eventsInWindow}
      )`,
      extraction_duration_p50_ms: sql<number | null>`
        percentile_cont(0.5) WITHIN GROUP (
          ORDER BY EXTRACT(EPOCH FROM (
            ${roomJournalBatches.completedAt} - ${roomJournalBatches.startedAt}
          )) * 1000
        ) FILTER (
          WHERE ${completedInWindow}
            AND ${roomJournalBatches.startedAt} IS NOT NULL
        )
      `,
      extraction_duration_p95_ms: sql<number | null>`
        percentile_cont(0.95) WITHIN GROUP (
          ORDER BY EXTRACT(EPOCH FROM (
            ${roomJournalBatches.completedAt} - ${roomJournalBatches.startedAt}
          )) * 1000
        ) FILTER (
          WHERE ${completedInWindow}
            AND ${roomJournalBatches.startedAt} IS NOT NULL
        )
      `,
    })
    .from(roomJournalBatches);
}

export function buildStenographerRecentFailuresQuery(
  input: { since: Date; until: Date },
  db: Pick<DirectDatabase, "select">,
) {
  const extractionFailures = db
    .select({
      stage:
        sql<"extraction" | "compaction">`'extraction'::text`,
      error_code: roomJournalBatches.errorCode,
      occurred_at: roomJournalBatches.lastErrorAt,
      attempt_count:
        sql<number>`COALESCE(${roomJournalBatches.lastErrorAttempt}, 0)::integer`,
      model_id: roomJournalBatches.lastErrorModelId,
    })
    .from(roomJournalBatches)
    .where(
      and(
        gte(roomJournalBatches.lastErrorAt, input.since),
        lte(roomJournalBatches.lastErrorAt, input.until),
        isNotNull(roomJournalBatches.errorCode),
      ),
    );
  const compactionFailures = db
    .select({
      stage:
        sql<"extraction" | "compaction">`'compaction'::text`,
      error_code: roomJournalState.lastCompactionErrorCode,
      occurred_at: roomJournalState.lastCompactionErrorAt,
      attempt_count:
        sql<number>`COALESCE(${roomJournalState.lastCompactionErrorAttempt}, 0)::integer`,
      model_id: roomJournalState.lastCompactionErrorModelId,
    })
    .from(roomJournalState)
    .where(
      and(
        gte(roomJournalState.lastCompactionErrorAt, input.since),
        lte(roomJournalState.lastCompactionErrorAt, input.until),
        isNotNull(roomJournalState.lastCompactionErrorCode),
      ),
    );

  return extractionFailures
    .unionAll(compactionFailures)
    .orderBy(({ occurred_at }) => desc(occurred_at))
    .limit(5);
}

export async function queryStenographerAdminStatus(
  input: {
    now: Date;
    since: Date;
    until: Date;
  },
  db: DirectDatabase = getSharedDirectDb(),
): Promise<StenographerAdminStatus> {
  const now = input.now.toISOString();
  const current = rows<CurrentRow>(
    await db.execute(sql`
      WITH eligible_rooms AS (
        SELECT
          r.id AS room_id,
          rjs.last_processed_message_id,
          rjs.lease_token,
          rjs.lease_expires_at,
          rjs.extraction_retry_after,
          rjs.extraction_failure_count,
          rjs.historical_backfill_status,
          rjs.rebuild_requested_at
        FROM rooms r
        INNER JOIN room_journal_state rjs ON rjs.room_id = r.id
        WHERE r.kind NOT IN ('task', 'access')
          AND rjs.suspended_at IS NULL
          AND EXISTS (
            SELECT 1
            FROM room_members rm
            INNER JOIN actors a ON a.id = rm.actor_id
            WHERE rm.room_id = r.id AND a.kind = 'agent'
          )
      ),
      eligible_source AS (
        SELECT
          er.room_id,
          sm.id,
          sm.created_at,
          sm.role,
          sm.fingerprint,
          CASE
            WHEN sm.role = 'user' AND (
              sm.fingerprint IS NULL OR NOT EXISTS (
                SELECT 1
                FROM sessions prior_s
                INNER JOIN session_messages prior_sm ON prior_sm.session_id = prior_s.id
                WHERE prior_s.room_id = er.room_id
                  AND prior_sm.role = 'user'
                  AND prior_sm.fingerprint = sm.fingerprint
                  AND (
                    prior_sm.created_at < sm.created_at
                    OR (prior_sm.created_at = sm.created_at AND prior_sm.id < sm.id)
                  )
              )
            ) THEN true
            WHEN sm.role = 'assistant' AND btrim(sm.content) <> '' THEN true
            ELSE false
          END AS conversational
        FROM eligible_rooms er
        INNER JOIN sessions s ON s.room_id = er.room_id
        INNER JOIN session_messages sm ON sm.session_id = s.id
        WHERE sm.id > er.last_processed_message_id
          AND sm.transcript_origin = 'main'
          AND s.thread_id NOT LIKE 'subagent:%'
          AND sm.role IN ('user', 'assistant', 'tool')
          AND (sm.metadata->>'originatedBy') IS DISTINCT FROM 'task' AND (sm.metadata->>'originatedBy') IS DISTINCT FROM 'connected_web_operation'
          AND NOT EXISTS (
            SELECT 1
            FROM room_silence_state rss
            WHERE rss.room_id = er.room_id
              AND rss.kind = 'deaf'
              AND sm.created_at >= rss.started_at
              AND sm.created_at <= rss.expires_at
          )
      ),
      ranked_conversation AS (
        SELECT
          room_id,
          id,
          created_at,
          row_number() OVER (
            PARTITION BY room_id
            ORDER BY created_at ASC, id ASC
          ) AS conversation_number
        FROM eligible_source
        WHERE conversational
      ),
      first_five AS (
        SELECT *
        FROM ranked_conversation
        WHERE conversation_number <= 5
      ),
      source_stats AS (
        SELECT
          room_id,
          COUNT(*)::integer AS source_count,
          MAX(created_at) AS newest_source_at
        FROM eligible_source
        GROUP BY room_id
      ),
      conversation_stats AS (
        SELECT
          room_id,
          COUNT(*)::integer AS conversation_count_capped,
          MAX(created_at) FILTER (WHERE conversation_number = 5) AS fifth_at
        FROM first_five
        GROUP BY room_id
      ),
      pending AS (
        SELECT
          er.room_id,
          COALESCE(ss.source_count, 0) AS source_count,
          COALESCE(cs.conversation_count_capped, 0) AS conversation_count_capped,
          ss.newest_source_at,
          cs.fifth_at,
          er.lease_token,
          er.lease_expires_at,
          er.extraction_retry_after,
          er.extraction_failure_count,
          er.historical_backfill_status,
          er.rebuild_requested_at
        FROM eligible_rooms er
        LEFT JOIN source_stats ss ON ss.room_id = er.room_id
        LEFT JOIN conversation_stats cs ON cs.room_id = er.room_id
      ),
      classified AS (
        SELECT
          *,
          CASE
            WHEN conversation_count_capped >= 5 THEN fifth_at
            WHEN conversation_count_capped >= 1
              THEN newest_source_at + interval '2 minutes'
            ELSE NULL
          END AS due_at,
          CASE
            WHEN lease_token IS NOT NULL AND lease_expires_at > ${now}
              THEN 'processing'
            WHEN extraction_failure_count > 0
              AND extraction_retry_after > ${now}
              THEN 'retrying'
            WHEN source_count = 0 THEN 'caught_up'
            WHEN (
              CASE
                WHEN conversation_count_capped >= 5 THEN fifth_at
                WHEN conversation_count_capped >= 1
                  THEN newest_source_at + interval '2 minutes'
                ELSE NULL
              END
            ) IS NULL OR (
              CASE
                WHEN conversation_count_capped >= 5 THEN fifth_at
                WHEN conversation_count_capped >= 1
                  THEN newest_source_at + interval '2 minutes'
                ELSE NULL
              END
            ) > ${now} THEN 'accumulating'
            ELSE 'due'
          END AS category
        FROM pending
      )
      SELECT
        COUNT(*)::integer AS eligible_rooms,
        COUNT(*) FILTER (WHERE category = 'caught_up')::integer AS caught_up_rooms,
        COUNT(*) FILTER (WHERE category = 'accumulating')::integer AS accumulating_rooms,
        COUNT(*) FILTER (WHERE category = 'processing')::integer AS processing_rooms,
        COUNT(*) FILTER (WHERE category = 'retrying')::integer AS retrying_rooms,
        COUNT(*) FILTER (WHERE category = 'due')::integer AS due_rooms,
        COUNT(*) FILTER (
          WHERE lease_token IS NOT NULL
            AND (lease_expires_at IS NULL OR lease_expires_at <= ${now})
        )::integer AS stale_leases,
        COALESCE(MAX(
          CASE WHEN category = 'due'
            THEN EXTRACT(EPOCH FROM (${now} - due_at)) * 1000
            ELSE 0
          END
        ), 0)::bigint AS oldest_overdue_ms,
        COALESCE(MAX(extraction_failure_count), 0)::integer AS maximum_failure_count,
        COUNT(*) FILTER (
          WHERE rebuild_requested_at IS NOT NULL
        )::integer AS rebuilding_rooms,
        COUNT(*) FILTER (
          WHERE historical_backfill_status = 'pending'
        )::integer AS historical_pending_rooms,
        COUNT(*) FILTER (
          WHERE historical_backfill_status IN ('completed', 'not_needed')
        )::integer AS historical_completed_rooms
      FROM classified
    `),
  )[0] ?? {
    eligible_rooms: 0,
    caught_up_rooms: 0,
    accumulating_rooms: 0,
    processing_rooms: 0,
    retrying_rooms: 0,
    due_rooms: 0,
    stale_leases: 0,
    oldest_overdue_ms: 0,
    maximum_failure_count: 0,
    rebuilding_rooms: 0,
    historical_pending_rooms: 0,
    historical_completed_rooms: 0,
  };

  const rolling = (await buildStenographerRollingStatusQuery(input, db))[0]!;

  const journalCompaction = rows<JournalCompactionRow>(
    await db.execute(sql`
      WITH eligible_rooms AS (
        SELECT r.id AS room_id
        FROM rooms r
        INNER JOIN room_journal_state rjs ON rjs.room_id = r.id
        WHERE r.kind NOT IN ('task', 'access')
          AND rjs.suspended_at IS NULL
          AND EXISTS (
            SELECT 1
            FROM room_members rm
            INNER JOIN actors a ON a.id = rm.actor_id
            WHERE rm.room_id = r.id AND a.kind = 'agent'
          )
      ),
      latest_rollups AS (
        SELECT DISTINCT ON (room_id)
          room_id,
          through_event_sequence,
          char_length(content)::integer AS body_chars
        FROM room_event_rollups
        ORDER BY room_id, through_event_sequence DESC, created_at DESC
      ),
      journal_sizes AS (
        SELECT
          er.room_id,
          (
            COALESCE(lr.body_chars, 0) +
            COALESCE(SUM(char_length(re.statement)) FILTER (
              WHERE re.status = 'active'
                AND re.sequence > COALESCE(lr.through_event_sequence, 0)
            ), 0)
          )::integer AS body_chars
        FROM eligible_rooms er
        LEFT JOIN latest_rollups lr ON lr.room_id = er.room_id
        LEFT JOIN room_events re ON re.room_id = er.room_id
        GROUP BY er.room_id, lr.body_chars, lr.through_event_sequence
      ),
      compaction_state AS (
        SELECT
          rjs.*,
          CASE
            WHEN rjs.compaction_lease_token IS NOT NULL
              AND rjs.compaction_lease_expires_at > ${now}
              THEN 'processing'
            WHEN rjs.compaction_failure_count > 0
              AND rjs.compaction_retry_after > ${now}
              THEN 'retrying'
            WHEN rjs.compaction_due_at IS NOT NULL THEN 'awaiting'
            ELSE 'idle'
          END AS category
        FROM room_journal_state rjs
        INNER JOIN eligible_rooms er ON er.room_id = rjs.room_id
      )
      SELECT
        (SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY body_chars)
          FROM journal_sizes) AS projected_body_code_points_p50,
        (SELECT percentile_cont(0.95) WITHIN GROUP (ORDER BY body_chars)
          FROM journal_sizes) AS projected_body_code_points_p95,
        (SELECT MAX(body_chars) FROM journal_sizes) AS projected_body_code_points_max,
        COUNT(*) FILTER (WHERE category = 'awaiting')::integer AS awaiting_rooms,
        COUNT(*) FILTER (WHERE category = 'processing')::integer AS processing_rooms,
        COUNT(*) FILTER (WHERE category = 'retrying')::integer AS retrying_rooms,
        COUNT(*) FILTER (
          WHERE compaction_lease_token IS NOT NULL
            AND (
              compaction_lease_expires_at IS NULL
              OR compaction_lease_expires_at <= ${now}
            )
        )::integer AS stale_leases,
        COALESCE(MAX(
          CASE WHEN category = 'awaiting'
            THEN EXTRACT(EPOCH FROM (${now} - compaction_due_at)) * 1000
            ELSE 0
          END
        ), 0)::bigint AS oldest_overdue_ms,
        COALESCE(MAX(compaction_failure_count), 0)::integer AS maximum_failure_count,
        MAX(last_compaction_completed_at) AS last_completed_at
      FROM compaction_state
    `),
  )[0]!;

  const failures = (await buildStenographerRecentFailuresQuery(
    input,
    db,
  )) as FailureRow[];

  const extractionDegraded =
    n(current.stale_leases) > 0 ||
    n(current.maximum_failure_count) >= 3 ||
    n(current.oldest_overdue_ms) >= 5 * 60_000;
  const compactionDegraded =
    n(journalCompaction.stale_leases) > 0 ||
    n(journalCompaction.maximum_failure_count) >= 3 ||
    n(journalCompaction.oldest_overdue_ms) >= 5 * 60_000;
  const delayed =
    n(current.retrying_rooms) > 0 ||
    n(current.rebuilding_rooms) > 0 ||
    n(journalCompaction.retrying_rooms) > 0 ||
    n(current.oldest_overdue_ms) >= 60_000 ||
    n(journalCompaction.oldest_overdue_ms) >= 60_000;

  return {
    generatedAt: input.now.toISOString(),
    window: {
      since: input.since.toISOString(),
      until: input.until.toISOString(),
    },
    health:
      extractionDegraded || compactionDegraded
        ? "degraded"
        : delayed
          ? "delayed"
          : "healthy",
    current: {
      eligibleRooms: n(current.eligible_rooms),
      caughtUpRooms: n(current.caught_up_rooms),
      accumulatingRooms: n(current.accumulating_rooms),
      processingRooms: n(current.processing_rooms),
      retryingRooms: n(current.retrying_rooms),
      dueRooms: n(current.due_rooms),
      staleLeases: n(current.stale_leases),
      oldestOverdueMs: Math.max(0, Math.trunc(n(current.oldest_overdue_ms))),
      rebuildingRooms: n(current.rebuilding_rooms),
      historicalPendingRooms: n(current.historical_pending_rooms),
      historicalCompletedRooms: n(current.historical_completed_rooms),
    },
    last24h: {
      completedExtractionBatches: n(rolling.completed_extraction_batches),
      extractionBatchesWithErrors: n(rolling.extraction_batches_with_errors),
      retriedExtractionBatches: n(rolling.retried_extraction_batches),
      zeroEventExtractionBatches: n(rolling.zero_event_extraction_batches),
      eventsWritten: n(rolling.events_written),
      extractionDurationP50Ms: nullableNumber(
        rolling.extraction_duration_p50_ms,
      ),
      extractionDurationP95Ms: nullableNumber(
        rolling.extraction_duration_p95_ms,
      ),
    },
    journal: {
      projectedBodyCodePointsP50: nullableNumber(
        journalCompaction.projected_body_code_points_p50,
      ),
      projectedBodyCodePointsP95: nullableNumber(
        journalCompaction.projected_body_code_points_p95,
      ),
      projectedBodyCodePointsMax: nullableNumber(
        journalCompaction.projected_body_code_points_max,
      ),
    },
    compaction: {
      awaitingRooms: n(journalCompaction.awaiting_rooms),
      processingRooms: n(journalCompaction.processing_rooms),
      retryingRooms: n(journalCompaction.retrying_rooms),
      staleLeases: n(journalCompaction.stale_leases),
      oldestOverdueMs: Math.max(
        0,
        Math.trunc(n(journalCompaction.oldest_overdue_ms)),
      ),
      lastCompletedAt: journalCompaction.last_completed_at
        ? iso(journalCompaction.last_completed_at)
        : null,
    },
    recentFailures: failures.map((failure) => ({
      stage: failure.stage,
      errorCode: failure.error_code,
      occurredAt: iso(failure.occurred_at),
      attemptCount: n(failure.attempt_count),
      modelId: failure.model_id,
    })),
  };
}
