import {
  actors,
  and,
  asc,
  eq,
  inArray,
  isNotNull,
  lt,
  roomEventRollups,
  roomEvents,
  roomJournalBatches,
  roomJournalCryptoPublications,
  roomJournalState,
  roomMembers,
  sessionMessages,
  sessions,
  sql,
} from "@nautilo/db";
import {
  assertVerifiedConversationProductPostgresHandle,
  conversationProductTypedDb,
  executeTypedConversationProductQuery,
  type ConversationProductDatabaseRow,
  type ConversationProductPostgresHandle,
} from "@nautilo/lattice-bridge/server";

const typedDb = conversationProductTypedDb;

export const PROTECTED_JOURNAL_REBUILD_CLEANUP_BATCH = 256;

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

export type ProtectedJournalRebuildPreparationResult =
  | Readonly<{ readonly status: "missing" | "stale" }>
  | Readonly<{
    readonly status: "cleanup_pending";
    readonly publicationIdsNeedingTombstone: readonly string[];
    readonly hasMoreInvalidationWork: boolean;
  }>
  | Readonly<{ readonly status: "ready_to_finalize" }>;

export type ProtectedJournalRebuildFinalizationResult =
  | Readonly<{ readonly status: "missing" | "stale" | "cleanup_pending" }>
  | Readonly<{
    readonly status: "prepared" | "completed";
    readonly startCursor: number;
    readonly targetCursor: number;
  }>;

function strictInput(
  label: string,
  value: unknown,
  fields: readonly string[],
): asserts value is Record<string, unknown> {
  if (
    typeof value !== "object"
    || value === null
    || Array.isArray(value)
    || Reflect.getPrototypeOf(value) !== Object.prototype
  ) {
    throw new TypeError(`${label} must be a plain object`);
  }
  const actual = Object.keys(value).sort();
  const expected = [...fields].sort();
  if (
    actual.length !== expected.length
    || actual.some((field, index) => field !== expected[index])
  ) {
    throw new TypeError(`${label} has an invalid field set`);
  }
}

function roomId(value: unknown): string {
  if (typeof value !== "string" || !UUID.test(value)) {
    throw new TypeError("protected journal rebuild Room id is invalid");
  }
  return value;
}

function generation(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new RangeError(
      "protected journal rebuild generation must be a positive safe integer",
    );
  }
  return value as number;
}

function instant(value: unknown): Date {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new TypeError("protected journal rebuild time is invalid");
  }
  return new Date(value);
}

function safeCounter(label: string, value: unknown): number {
  const parsed = typeof value === "bigint"
    ? Number(value)
    : typeof value === "string" && /^(0|[1-9][0-9]*)$/u.test(value)
    ? Number(value)
    : value;
  if (!Number.isSafeInteger(parsed) || (parsed as number) < 0) {
    throw new TypeError(`${label} must be a non-negative safe integer`);
  }
  return parsed as number;
}

function stateRow(
  rows: readonly ConversationProductDatabaseRow[],
): Readonly<{
  rebuildGeneration: number;
  rebuildRequestedAt: Date | null;
}> | null {
  if (rows.length > 1) {
    throw new Error("duplicate protected journal rebuild state");
  }
  const row = rows[0];
  if (row === undefined) return null;
  const requested = row["rebuild_requested_at"];
  if (requested !== null && !(requested instanceof Date)) {
    throw new TypeError("protected journal rebuild request time is invalid");
  }
  return Object.freeze({
    rebuildGeneration: safeCounter(
      "protected journal rebuild generation",
      row["rebuild_generation"],
    ),
    rebuildRequestedAt: requested === null ? null : new Date(requested),
  });
}

function publicationIds(
  rows: readonly ConversationProductDatabaseRow[],
): readonly string[] {
  if (rows.length > PROTECTED_JOURNAL_REBUILD_CLEANUP_BATCH) {
    throw new RangeError("protected journal rebuild cleanup exceeded its bound");
  }
  return Object.freeze(rows.map((row) => {
    const value = row["publication_id"];
    if (typeof value !== "string" || value.length < 1 || value.length > 128) {
      throw new TypeError(
        "protected journal rebuild publication id is invalid",
      );
    }
    return value;
  }));
}

/**
 * Product-side half of protected journal rebuild cleanup.
 *
 * The legacy plaintext rebuild deletes batches immediately. Protected output
 * cannot do that: its receipt is the only crash-safe list of crypto objects
 * that must first be tombstoned by the restricted crypto role. This adapter
 * invalidates a bounded receipt page, waits for those tombstones, and only
 * then removes the old product projection and resets the rebuild cursor.
 */
export class PostgresProtectedJournalRebuildRepository {
  constructor(
    private readonly handle: ConversationProductPostgresHandle,
  ) {
    assertVerifiedConversationProductPostgresHandle(handle);
    if (handle.role !== "nautilo") {
      throw new TypeError(
        "protected journal rebuild requires the nautilo product role",
      );
    }
  }

  async prepare(value: Readonly<{
    readonly roomId: string;
    readonly rebuildGeneration: number;
    readonly now: Date;
  }>): Promise<ProtectedJournalRebuildPreparationResult> {
    strictInput("protected journal rebuild preparation", value, [
      "roomId",
      "rebuildGeneration",
      "now",
    ]);
    const exactRoomId = roomId(value.roomId);
    const exactGeneration = generation(value.rebuildGeneration);
    const now = instant(value.now);
    return this.handle.transaction(async (transaction) => {
      const current = stateRow(await transaction.query(
        `SELECT rebuild_generation, rebuild_requested_at
           FROM room_journal_state
          WHERE room_id = $1
          LIMIT 2
          FOR UPDATE`,
        [exactRoomId],
      ));
      if (current === null) return Object.freeze({ status: "missing" as const });
      if (
        current.rebuildRequestedAt === null
        || current.rebuildGeneration !== exactGeneration
      ) return Object.freeze({ status: "stale" as const });

      const invalidated = await transaction.query(
        `WITH targets AS (
           SELECT publication_id
             FROM room_journal_crypto_publications
            WHERE room_id = $1
              AND rebuild_generation < $2
              AND state IN (
                'reserved',
                'crypto_committed',
                'attached',
                'quarantined'
              )
            ORDER BY created_at, publication_id
            LIMIT $3
            FOR UPDATE
         )
         UPDATE room_journal_crypto_publications AS publication
            SET state = CASE
                  WHEN publication.crypto_committed_at IS NULL
                    THEN 'superseded'
                  ELSE 'tombstone_pending'
                END,
                lease_token = NULL,
                lease_expires_at = NULL,
                retry_count = CASE
                  WHEN publication.crypto_committed_at IS NULL
                    THEN publication.retry_count
                  ELSE 0
                END,
                failure_code = 'rebuild_superseded',
                last_failure_at = $4,
                tombstone_requested_at = CASE
                  WHEN publication.crypto_committed_at IS NULL
                    THEN NULL
                  ELSE COALESCE(publication.tombstone_requested_at, $4)
                END,
                updated_at = $4
           FROM targets
          WHERE publication.publication_id = targets.publication_id
         RETURNING publication.publication_id,
                   publication.state`,
        [
          exactRoomId,
          exactGeneration,
          PROTECTED_JOURNAL_REBUILD_CLEANUP_BATCH,
          now,
        ],
      );
      if (invalidated.length > PROTECTED_JOURNAL_REBUILD_CLEANUP_BATCH) {
        throw new RangeError(
          "protected journal rebuild invalidation exceeded its bound",
        );
      }
      const pending = publicationIds(await executeTypedConversationProductQuery(
        transaction,
        typedDb.select({
          publication_id: roomJournalCryptoPublications.publicationId,
        })
          .from(roomJournalCryptoPublications)
          .where(and(
            eq(roomJournalCryptoPublications.roomId, exactRoomId),
            lt(roomJournalCryptoPublications.rebuildGeneration, exactGeneration),
            eq(roomJournalCryptoPublications.state, "tombstone_pending"),
          ))
          .orderBy(
            asc(roomJournalCryptoPublications.createdAt),
            asc(roomJournalCryptoPublications.publicationId),
          )
          .limit(PROTECTED_JOURNAL_REBUILD_CLEANUP_BATCH),
      ));
      const remaining = await executeTypedConversationProductQuery(
        transaction,
        typedDb.select({
          publication_id: roomJournalCryptoPublications.publicationId,
        })
          .from(roomJournalCryptoPublications)
          .where(and(
            eq(roomJournalCryptoPublications.roomId, exactRoomId),
            lt(roomJournalCryptoPublications.rebuildGeneration, exactGeneration),
            inArray(roomJournalCryptoPublications.state, [
              "reserved",
              "crypto_committed",
              "attached",
              "quarantined",
            ]),
          ))
          .limit(1),
      );
      if (pending.length > 0 || remaining.length > 0) {
        return Object.freeze({
          status: "cleanup_pending" as const,
          publicationIdsNeedingTombstone: pending,
          hasMoreInvalidationWork: remaining.length > 0,
        });
      }
      return Object.freeze({ status: "ready_to_finalize" as const });
    }, { isolationLevel: "serializable" });
  }

  async finalize(value: Readonly<{
    readonly roomId: string;
    readonly rebuildGeneration: number;
    readonly now: Date;
  }>): Promise<ProtectedJournalRebuildFinalizationResult> {
    strictInput("protected journal rebuild finalization", value, [
      "roomId",
      "rebuildGeneration",
      "now",
    ]);
    const exactRoomId = roomId(value.roomId);
    const exactGeneration = generation(value.rebuildGeneration);
    const now = instant(value.now);
    return this.handle.transaction(async (transaction) => {
      const current = stateRow(await transaction.query(
        `SELECT rebuild_generation, rebuild_requested_at
           FROM room_journal_state
          WHERE room_id = $1
          LIMIT 2
          FOR UPDATE`,
        [exactRoomId],
      ));
      if (current === null) return Object.freeze({ status: "missing" as const });
      if (
        current.rebuildRequestedAt === null
        || current.rebuildGeneration !== exactGeneration
      ) return Object.freeze({ status: "stale" as const });

      const unfinished = await transaction.query(
        `SELECT publication_id
           FROM room_journal_crypto_publications
          WHERE room_id = $1
            AND rebuild_generation < $2
            AND state NOT IN ('superseded', 'tombstoned')
          LIMIT 1
          FOR UPDATE`,
        [exactRoomId, exactGeneration],
      );
      if (unfinished.length > 0) {
        return Object.freeze({ status: "cleanup_pending" as const });
      }

      const currentPublications = await transaction.query(
        `SELECT publication_id
           FROM room_journal_crypto_publications
          WHERE room_id = $1
            AND rebuild_generation >= $2
            AND state NOT IN ('superseded', 'tombstoned')
          LIMIT 1
          FOR UPDATE`,
        [exactRoomId, exactGeneration],
      );
      if (currentPublications.length > 0) {
        return Object.freeze({ status: "cleanup_pending" as const });
      }

      const firstAgentRows = await executeTypedConversationProductQuery(
        transaction,
        typedDb.select({
          joined_at:
            sql<Date | null>`MIN(${roomMembers.joinedAt})`.as("joined_at"),
        })
          .from(roomMembers)
          .innerJoin(actors, eq(actors.id, roomMembers.actorId))
          .where(and(
            eq(roomMembers.roomId, exactRoomId),
            eq(actors.kind, "agent"),
          )),
      );
      if (firstAgentRows.length !== 1) {
        throw new Error("protected journal rebuild agent bound is unavailable");
      }
      const firstAgentJoinedAt = firstAgentRows[0]?.["joined_at"];
      if (
        firstAgentJoinedAt !== null
        && !(firstAgentJoinedAt instanceof Date)
      ) {
        throw new TypeError(
          "protected journal rebuild agent join time is invalid",
        );
      }

      const boundsRows = await executeTypedConversationProductQuery(
        transaction,
        typedDb.select({
          start_cursor: sql<number>`COALESCE(MAX(CASE
            WHEN ${sessionMessages.createdAt} <= ${firstAgentJoinedAt}
              THEN ${sessionMessages.id}
          END), 0)::integer`.as("start_cursor"),
          target_cursor:
            sql<number>`COALESCE(MAX(${sessionMessages.id}), 0)::integer`
              .as("target_cursor"),
        })
          .from(sessions)
          .innerJoin(
            sessionMessages,
            eq(sessionMessages.sessionId, sessions.id),
          )
          .where(eq(sessions.roomId, exactRoomId)),
      );
      if (boundsRows.length !== 1) {
        throw new Error("protected journal rebuild bounds are unavailable");
      }
      const startCursor = safeCounter(
        "protected journal rebuild start cursor",
        boundsRows[0]?.["start_cursor"],
      );
      const targetCursor = safeCounter(
        "protected journal rebuild target cursor",
        boundsRows[0]?.["target_cursor"],
      );
      if (targetCursor < startCursor) {
        throw new Error("protected journal rebuild bounds are incoherent");
      }

      await executeTypedConversationProductQuery(transaction, typedDb
        .delete(roomEventRollups)
        .where(eq(roomEventRollups.roomId, exactRoomId)));
      await executeTypedConversationProductQuery(transaction, typedDb
        .delete(roomEvents)
        .where(eq(roomEvents.roomId, exactRoomId)));
      await executeTypedConversationProductQuery(transaction, typedDb
        .delete(roomJournalCryptoPublications)
        .where(and(
          eq(roomJournalCryptoPublications.roomId, exactRoomId),
          lt(roomJournalCryptoPublications.rebuildGeneration, exactGeneration),
          inArray(roomJournalCryptoPublications.state, ["superseded", "tombstoned"]),
        )));
      await executeTypedConversationProductQuery(transaction, typedDb
        .delete(roomJournalBatches)
        .where(eq(roomJournalBatches.roomId, exactRoomId)));
      const completed = targetCursor <= startCursor;
      const updated = await executeTypedConversationProductQuery(
        transaction,
        typedDb.update(roomJournalState)
          .set({
            lastProcessedMessageId: startCursor,
            lastProcessedAt: null,
            leaseToken: null,
            leaseExpiresAt: null,
            extractionFailureCount: 0,
            extractionRetryAfter: null,
            lastExtractionErrorCode: null,
            lastExtractionErrorAt: null,
            lastExtractionCompletedAt: null,
            compactionDueAt: null,
            compactionLeaseToken: null,
            compactionLeaseExpiresAt: null,
            compactionFailureCount: 0,
            compactionRetryAfter: null,
            lastCompactionErrorCode: null,
            lastCompactionErrorAt: null,
            lastCompactionErrorAttempt: null,
            lastCompactionErrorModelId: null,
            lastCompactionCompletedAt: null,
            historicalBackfillStatus: "not_needed",
            historicalBackfillCursorMessageId: null,
            historicalBackfillTargetMessageId: null,
            historicalBackfillCompletedAt: null,
            rebuildTargetMessageId: completed ? null : targetCursor,
            rebuildRequestedAt: completed ? null : roomJournalState.rebuildRequestedAt,
            updatedAt: now,
          })
          .where(and(
            eq(roomJournalState.roomId, exactRoomId),
            eq(roomJournalState.rebuildGeneration, exactGeneration),
            isNotNull(roomJournalState.rebuildRequestedAt),
          ))
          .returning({ room_id: roomJournalState.roomId }),
      );
      if (updated.length !== 1) {
        throw new Error("protected journal rebuild state update was stale");
      }
      return Object.freeze({
        status: completed ? "completed" as const : "prepared" as const,
        startCursor,
        targetCursor,
      });
    }, { isolationLevel: "serializable" });
  }
}
