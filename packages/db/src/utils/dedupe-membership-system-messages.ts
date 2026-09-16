import { eq, inArray, sql } from "drizzle-orm";
import { getSharedDirectDb } from "../config/direct-database";
import { sessions, sessionMessages } from "../schema/sessions";

/**
 * One-off cleanup for Stack 74 / D194.
 *
 * Before the write-once fix, `appendRoomMembershipSystemMessagesInTx` fanned
 * out a "joined/left the room" system row into EVERY human member's session.
 * Because the room transcript aggregates `session_messages` across sessions
 * by `room_id`, an N-human room shows each membership line N times. This
 * script collapses those duplicates to a single row.
 *
 * Dedup key: rows that share the same room (`sessions.room_id`), `content`,
 * `tool_calls` sidecar, AND `created_at` are fan-out copies of one event —
 * they were all inserted inside one transaction, so Postgres `now()` (the
 * transaction timestamp) is identical across them. Genuinely distinct
 * membership events carry a different `created_at` and are never collapsed.
 * The lowest `id` in each group is kept.
 *
 * Idempotent: re-running after a clean pass deletes nothing.
 */
export async function dedupeMembershipSystemMessages(): Promise<{
  deleted: number;
  sessionsAdjusted: number;
}> {
  const db = getSharedDirectDb();
  const dupRows = (await db.execute(sql`
    WITH membership_msgs AS (
      SELECT
        sm.id AS id,
        sm.session_id AS session_id,
        ROW_NUMBER() OVER (
          PARTITION BY s.room_id, sm.content, sm.tool_calls, sm.created_at
          ORDER BY sm.id
        ) AS rn
      FROM session_messages sm
      JOIN sessions s ON s.id = sm.session_id
      WHERE sm.role = 'system'
        AND (
          sm.tool_calls LIKE '%"kind":"member_added"%'
          OR sm.tool_calls LIKE '%"kind":"member_removed"%'
        )
    )
    SELECT id, session_id FROM membership_msgs WHERE rn > 1
  `)) as unknown as Array<{ id: number | string; session_id: string }>;

  if (dupRows.length === 0) {
    return { deleted: 0, sessionsAdjusted: 0 };
  }

  const ids = dupRows.map((r) => Number(r.id));
  const deletedPerSession = new Map<string, number>();
  for (const r of dupRows) {
    deletedPerSession.set(r.session_id, (deletedPerSession.get(r.session_id) ?? 0) + 1);
  }

  await db.transaction(async (tx) => {
    await tx.delete(sessionMessages).where(inArray(sessionMessages.id, ids));
    // Keep each session's denormalized message_count honest after the purge.
    for (const [sessionId, n] of deletedPerSession) {
      await tx
        .update(sessions)
        .set({ messageCount: sql`GREATEST(${sessions.messageCount} - ${n}, 0)` })
        .where(eq(sessions.id, sessionId));
    }
  });

  return { deleted: ids.length, sessionsAdjusted: deletedPerSession.size };
}

if (import.meta.main) {
  dedupeMembershipSystemMessages()
    .then((r) => {

      console.log(
        `dedupe-membership-system-messages: deleted ${r.deleted} duplicate row(s) across ${r.sessionsAdjusted} session(s).`,
      );
      process.exit(0);
    })
    .catch((e: unknown) => {

      console.error("dedupe-membership-system-messages failed:", e);
      process.exit(1);
    });
}
