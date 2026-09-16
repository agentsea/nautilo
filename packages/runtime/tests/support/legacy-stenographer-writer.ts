import { sql, type DirectDatabase, type SQL } from "@nautilo/db";

import {
  planEventTransitions,
  type EventTransitionPlan,
} from "../../src/stenographer/event-transition-planner";
import type { ExtractionClaim } from "../../src/stenographer/repository";
import type {
  EffectiveRoomEvent,
  RoomEventKind,
  StenographerOperation,
} from "../../src/stenographer/types";

interface Executor {
  execute(query: SQL): Promise<unknown>;
}

function rows<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  if (
    result !== null
    && typeof result === "object"
    && "rows" in result
    && Array.isArray((result as { rows: unknown }).rows)
  ) return (result as { rows: T[] }).rows;
  return [];
}

function counter(value: number | string): number {
  const normalized = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(normalized)) throw new TypeError("unsafe counter");
  return normalized;
}

function timestamp(value: Date): string {
  return value.toISOString();
}

function integerArray(values: readonly number[]): SQL {
  return sql`ARRAY[${sql.join(values.map((value) => sql`${value}`), sql`, `)}]::integer[]`;
}

async function legacyEvents(
  tx: Executor,
  roomId: string,
): Promise<EffectiveRoomEvent[]> {
  return rows<{
    id: string;
    room_id: string;
    sequence: number | string;
    kind: RoomEventKind;
    statement: string;
    status: "active" | "superseded" | "resolved";
    supersedes_event_id: string | null;
    resolves_event_id: string | null;
  }>(await tx.execute(sql`
    SELECT id, room_id, sequence, kind, statement, status,
           supersedes_event_id, resolves_event_id
      FROM room_events
     WHERE room_id = ${roomId}
     ORDER BY sequence
  `)).map((row) => ({
    id: row.id,
    roomId: row.room_id,
    sequence: counter(row.sequence),
    kind: row.kind,
    statement: row.statement,
    status: row.status,
    supersedesEventId: row.supersedes_event_id,
    resolvesEventId: row.resolves_event_id,
  }));
}

async function applyPlan(
  tx: Executor,
  claim: ExtractionClaim,
  plan: EventTransitionPlan,
  now: Date,
): Promise<number> {
  for (const update of plan.statusUpdates) {
    const updated = rows<{ id: string }>(await tx.execute(sql`
      UPDATE room_events
         SET status = ${update.toStatus}
       WHERE id = ${update.eventId}
         AND room_id = ${claim.roomId}
         AND status = 'active'
       RETURNING id
    `));
    if (updated.length !== 1) throw new Error("legacy target changed");
  }
  let insertedCount = 0;
  for (const insert of plan.inserts) {
    insertedCount += rows(await tx.execute(sql`
      INSERT INTO room_events (
        room_id, sequence, kind, statement, status, supersedes_event_id,
        resolves_event_id, source_message_ids, source_batch_id,
        batch_local_ordinal, extractor_version, created_at
      ) VALUES (
        ${claim.roomId}, ${insert.sequence}, ${insert.kind},
        ${insert.statement}, 'active', ${insert.supersedesEventId},
        ${insert.resolvesEventId}, ${integerArray(insert.sourceMessageIds)},
        ${claim.batchId}, ${insert.batchLocalOrdinal}, 'm219-v1',
        ${timestamp(now)}
      )
      ON CONFLICT (source_batch_id, batch_local_ordinal) DO NOTHING
      RETURNING id
    `)).length;
  }
  return insertedCount;
}

/** Test-only pre-cutover writer; no production package exports this path. */
export async function publishLegacyExtractionBeforeRecordCutoverForTests(
  input: Readonly<{
    claim: ExtractionClaim;
    operations: readonly StenographerOperation[];
    modelId: string | null;
    now?: Date;
    db: DirectDatabase;
  }>,
): Promise<{ published: boolean; eventsWritten: number }> {
  const now = input.now ?? new Date();
  const rebuildGeneration = input.claim.rebuildGeneration ?? null;
  return input.db.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT id FROM rooms WHERE id = ${input.claim.roomId} FOR UPDATE`,
    );
    const state = rows<{
      lease_token: string | null;
      suspended_at: string | Date | null;
      has_agent: boolean;
      rebuild_generation: number | string;
    }>(await tx.execute(sql`
      SELECT rjs.lease_token, rjs.suspended_at, rjs.rebuild_generation,
             EXISTS (
               SELECT 1 FROM room_members rm
               JOIN actors a ON a.id = rm.actor_id
                AND a.kind = 'agent'
              WHERE rm.room_id = rjs.room_id
             ) AS has_agent
        FROM room_journal_state rjs
       WHERE rjs.room_id = ${input.claim.roomId}
       FOR UPDATE
    `))[0];
    if (
      state === undefined
      || state.lease_token !== input.claim.leaseToken
      || state.suspended_at !== null
      || !state.has_agent
      || (
        rebuildGeneration !== null
        && counter(state.rebuild_generation) !== rebuildGeneration
      )
    ) return { published: false, eventsWritten: 0 };

    const citedIds = [
      ...new Set(input.operations.flatMap((item) => item.sourceMessageIds)),
    ];
    if (citedIds.length > 0) {
      const sourceRows = rows(await tx.execute(sql`
        SELECT sm.id FROM sessions s
        JOIN session_messages sm ON sm.session_id = s.id
       WHERE s.room_id = ${input.claim.roomId}
         AND sm.id IN (${sql.join(citedIds.map((id) => sql`${id}`), sql`, `)})
         AND sm.id > ${input.claim.plan.fromMessageIdExclusive}
         AND sm.id <= ${input.claim.plan.throughMessageIdInclusive}
      `));
      if (sourceRows.length !== citedIds.length) {
        throw new Error("legacy source changed");
      }
    }
    const transition = planEventTransitions({
      roomId: input.claim.roomId,
      events: await legacyEvents(tx, input.claim.roomId),
      operations: input.operations,
    });
    if (!transition.ok) throw new Error(`legacy transition: ${transition.reason}`);
    const eventsWritten = await applyPlan(tx, input.claim, transition.plan, now);
    await tx.execute(sql`
      UPDATE room_journal_batches
         SET status = 'completed',
             operation_count = ${input.operations.length},
             model_id = ${input.modelId},
             completed_at = ${timestamp(now)}
       WHERE id = ${input.claim.batchId}
         AND room_id = ${input.claim.roomId}
    `);
    const cursor = input.claim.lane === "live"
      ? sql`
          last_processed_message_id = GREATEST(
            rjs.last_processed_message_id,
            ${input.claim.plan.throughMessageIdInclusive}
          ),
          last_processed_at = ${timestamp(now)}
        `
      : sql`
          historical_backfill_cursor_message_id = GREATEST(
            rjs.historical_backfill_cursor_message_id,
            ${input.claim.plan.throughMessageIdInclusive}
          ),
          historical_backfill_status = CASE
            WHEN ${input.claim.plan.throughMessageIdInclusive} >=
              rjs.historical_backfill_target_message_id
            THEN 'completed' ELSE rjs.historical_backfill_status END,
          historical_backfill_completed_at = CASE
            WHEN ${input.claim.plan.throughMessageIdInclusive} >=
              rjs.historical_backfill_target_message_id
            THEN ${timestamp(now)} ELSE rjs.historical_backfill_completed_at END
        `;
    await tx.execute(sql`
      WITH latest_rollup AS (
        SELECT COALESCE(MAX(through_event_sequence), 0) AS through_sequence
          FROM room_event_rollups WHERE room_id = ${input.claim.roomId}
      ), uncompacted AS (
        SELECT COUNT(*)::integer AS event_count,
               COALESCE(SUM(char_length(event.statement)), 0)::integer
                 AS statement_chars
          FROM room_events event CROSS JOIN latest_rollup rollup
         WHERE event.room_id = ${input.claim.roomId}
           AND event.status = 'active'
           AND event.sequence > rollup.through_sequence
      )
      UPDATE room_journal_state rjs
         SET ${cursor}, lease_token = NULL, lease_expires_at = NULL,
             extraction_failure_count = 0, extraction_retry_after = NULL,
             last_extraction_completed_at = ${timestamp(now)},
             rebuild_requested_at = CASE
               WHEN rjs.rebuild_requested_at IS NOT NULL
                AND rjs.rebuild_generation = ${rebuildGeneration}
                AND ${input.claim.plan.throughMessageIdInclusive} >=
                  rjs.rebuild_target_message_id
               THEN NULL ELSE rjs.rebuild_requested_at END,
             rebuild_target_message_id = CASE
               WHEN rjs.rebuild_requested_at IS NOT NULL
                AND rjs.rebuild_generation = ${rebuildGeneration}
                AND ${input.claim.plan.throughMessageIdInclusive} >=
                  rjs.rebuild_target_message_id
               THEN NULL ELSE rjs.rebuild_target_message_id END,
             compaction_due_at = CASE
               WHEN work.event_count >= 200 OR work.statement_chars >= 40000
               THEN COALESCE(rjs.compaction_due_at, ${timestamp(now)})
               ELSE rjs.compaction_due_at END,
             updated_at = ${timestamp(now)}
        FROM uncompacted work
       WHERE rjs.room_id = ${input.claim.roomId}
         AND rjs.lease_token = ${input.claim.leaseToken}
    `);
    return { published: true, eventsWritten };
  });
}
