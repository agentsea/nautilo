import { eq, sql, type SQL } from "drizzle-orm";
import type { DirectDatabase } from "../config/direct-database";
import { roomJournalState } from "../schema/room-journal";
import { rooms } from "../schema/rooms";
import { sessionMessages, sessions } from "../schema/sessions";
import { acquireRoomWriteLock, type RoomLockTransaction } from "./room-lock";

export const ROOM_JOURNAL_EXTRACTOR_VERSION = "m219-v1";

export interface RoomJournalMutationTransaction extends RoomLockTransaction {
  execute(query: SQL): Promise<unknown>;
  insert: DirectDatabase["insert"];
  select: DirectDatabase["select"];
}

/**
 * Create the empty journal state for a newly inserted Room before its first
 * transcript row can be committed. New rows start suspended and the
 * membership reconciliation performed by the Room-creation transaction clears
 * suspension for Agent-containing conversational Rooms.
 */
export async function createRoomJournalStateInTx(
  tx: RoomJournalMutationTransaction,
  roomId: string,
  now: Date = new Date(),
): Promise<void> {
  await acquireRoomWriteLock(tx, roomId);
  await tx
    .insert(roomJournalState)
    .values({
      roomId,
      lastProcessedMessageId: 0,
      extractorVersion: ROOM_JOURNAL_EXTRACTOR_VERSION,
      suspendedAt: now,
      historicalBackfillStatus: "not_needed",
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoNothing({ target: roomJournalState.roomId });
}

/**
 * Reconcile first-Agent/last-Agent transitions after membership changes.
 *
 * Lock order is always Room → room_journal_state. A missing state row (partial
 * restore/upgrade) is seeded at the complete current Room head, never at zero.
 * A suspended Room becoming eligible advances to the current head before
 * clearing suspension, so Agent-free discussion is not backfilled. A Room
 * losing its last Agent advances to its committed head and invalidates any
 * extraction lease, so an in-flight model result cannot publish.
 */
export async function reconcileRoomJournalMembershipInTx(
  tx: RoomJournalMutationTransaction,
  roomIds: readonly string[],
  now: Date = new Date(),
): Promise<void> {
  const ordered = [...new Set(roomIds)].sort();
  const timestamp = now.toISOString();
  for (const roomId of ordered) {
    await acquireRoomWriteLock(tx, roomId);
    await tx.insert(roomJournalState).select(tx.select({
      roomId: rooms.id,
      lastProcessedMessageId:
        sql<number>`coalesce(max(${sessionMessages.id}), 0)`
          .as("last_processed_message_id"),
      lastProcessedAt: sql<Date>`${timestamp}`.as("last_processed_at"),
      leaseToken: sql<null>`null`.as("lease_token"),
      leaseExpiresAt: sql<null>`null`.as("lease_expires_at"),
      compactionLeaseToken: sql<null>`null`.as("compaction_lease_token"),
      compactionLeaseExpiresAt: sql<null>`null`
        .as("compaction_lease_expires_at"),
      extractionAuthorizationWaitLane: sql<null>`null`
        .as("extraction_authorization_wait_lane"),
      extractionAuthorizationWaitingSince: sql<null>`null`
        .as("extraction_authorization_waiting_since"),
      compactionAuthorizationWaitingSince: sql<null>`null`
        .as("compaction_authorization_waiting_since"),
      extractionFailureCount: sql<number>`0`.as("extraction_failure_count"),
      extractionRetryAfter: sql<null>`null`.as("extraction_retry_after"),
      lastExtractionErrorCode: sql<null>`null`.as("last_extraction_error_code"),
      lastExtractionErrorAt: sql<null>`null`.as("last_extraction_error_at"),
      lastExtractionCompletedAt: sql<null>`null`
        .as("last_extraction_completed_at"),
      compactionDueAt: sql<null>`null`.as("compaction_due_at"),
      compactionFailureCount: sql<number>`0`.as("compaction_failure_count"),
      compactionRetryAfter: sql<null>`null`.as("compaction_retry_after"),
      lastCompactionErrorCode: sql<null>`null`.as("last_compaction_error_code"),
      lastCompactionErrorAt: sql<null>`null`.as("last_compaction_error_at"),
      lastCompactionErrorAttempt: sql<null>`null`
        .as("last_compaction_error_attempt"),
      lastCompactionErrorModelId: sql<null>`null`
        .as("last_compaction_error_model_id"),
      lastCompactionCompletedAt: sql<null>`null`
        .as("last_compaction_completed_at"),
      extractorVersion: sql<string>`${ROOM_JOURNAL_EXTRACTOR_VERSION}`
        .as("extractor_version"),
      suspendedAt: sql<Date>`${timestamp}`.as("suspended_at"),
      historicalBackfillStatus: sql<"not_needed">`'not_needed'`
        .as("historical_backfill_status"),
      historicalBackfillCursorMessageId: sql<null>`null`
        .as("historical_backfill_cursor_message_id"),
      historicalBackfillTargetMessageId: sql<null>`null`
        .as("historical_backfill_target_message_id"),
      historicalBackfillCompletedAt: sql<null>`null`
        .as("historical_backfill_completed_at"),
      rebuildGeneration: sql<number>`0`.as("rebuild_generation"),
      rebuildRequestedAt: sql<null>`null`.as("rebuild_requested_at"),
      rebuildTargetMessageId: sql<null>`null`.as("rebuild_target_message_id"),
      recordConversionStatus: sql<"not_needed">`'not_needed'`
        .as("record_conversion_status"),
      recordConversionCursorSequence: sql<number>`0`
        .as("record_conversion_cursor_sequence"),
      recordConversionFailureCount: sql<number>`0`
        .as("record_conversion_failure_count"),
      recordConversionRetryAfter: sql<null>`null`
        .as("record_conversion_retry_after"),
      recordConversionLeaseToken: sql<null>`null`
        .as("record_conversion_lease_token"),
      recordConversionLeaseExpiresAt: sql<null>`null`
        .as("record_conversion_lease_expires_at"),
      recordConversionLastErrorCode: sql<null>`null`
        .as("record_conversion_last_error_code"),
      createdAt: sql<Date>`${timestamp}`.as("created_at"),
      updatedAt: sql<Date>`${timestamp}`.as("updated_at"),
    }).from(rooms).leftJoin(sessions, eq(sessions.roomId, rooms.id)).leftJoin(
      sessionMessages,
      eq(sessionMessages.sessionId, sessions.id),
    ).where(eq(rooms.id, roomId)).groupBy(rooms.id)).onConflictDoNothing({
      target: roomJournalState.roomId,
    });
    await tx.execute(sql`
      SELECT room_id
      FROM room_journal_state
      WHERE room_id = ${roomId}
      FOR UPDATE
    `);
    await tx.execute(sql`
      WITH room_snapshot AS (
        SELECT
          r.kind,
          COALESCE(MAX(sm.id), 0)::integer AS head_message_id,
          EXISTS (
            SELECT 1
            FROM room_members rm
            INNER JOIN actors a ON a.id = rm.actor_id
            WHERE rm.room_id = r.id
              AND a.kind = 'agent'
          ) AS has_agent
        FROM rooms r
        LEFT JOIN sessions s ON s.room_id = r.id
        LEFT JOIN session_messages sm ON sm.session_id = s.id
        WHERE r.id = ${roomId}
        GROUP BY r.id, r.kind
      )
      UPDATE room_journal_state rjs
      SET
        last_processed_message_id = CASE
          WHEN rs.kind IN ('task', 'access') OR NOT rs.has_agent
            THEN GREATEST(rjs.last_processed_message_id, rs.head_message_id)
          WHEN rjs.suspended_at IS NOT NULL
            THEN GREATEST(rjs.last_processed_message_id, rs.head_message_id)
          ELSE rjs.last_processed_message_id
        END,
        last_processed_at = CASE
          WHEN rs.kind IN ('task', 'access')
            OR NOT rs.has_agent
            OR rjs.suspended_at IS NOT NULL
            THEN ${timestamp}
          ELSE rjs.last_processed_at
        END,
        suspended_at = CASE
          WHEN rs.kind IN ('task', 'access') OR NOT rs.has_agent
            THEN COALESCE(rjs.suspended_at, ${timestamp})
          ELSE NULL
        END,
        lease_token = CASE
          WHEN rs.kind IN ('task', 'access')
            OR NOT rs.has_agent
            OR rjs.suspended_at IS NOT NULL
            THEN NULL
          ELSE rjs.lease_token
        END,
        lease_expires_at = CASE
          WHEN rs.kind IN ('task', 'access')
            OR NOT rs.has_agent
            OR rjs.suspended_at IS NOT NULL
            THEN NULL
          ELSE rjs.lease_expires_at
        END,
        compaction_lease_token = CASE
          WHEN rs.kind IN ('task', 'access')
            OR NOT rs.has_agent
            OR rjs.suspended_at IS NOT NULL
            THEN NULL
          ELSE rjs.compaction_lease_token
        END,
        compaction_lease_expires_at = CASE
          WHEN rs.kind IN ('task', 'access')
            OR NOT rs.has_agent
            OR rjs.suspended_at IS NOT NULL
            THEN NULL
          ELSE rjs.compaction_lease_expires_at
        END,
        updated_at = ${timestamp}
      FROM room_snapshot rs
      WHERE rjs.room_id = ${roomId}
    `);
  }
}
