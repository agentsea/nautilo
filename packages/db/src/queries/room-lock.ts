import { sql, type SQL } from "drizzle-orm";

/**
 * Minimal transaction surface shared by the app-role and agent-role Drizzle
 * handles. Room transcript writes use both, but both expose `execute(SQL)`.
 */
export interface RoomLockTransaction {
  execute(query: SQL): Promise<unknown>;
}

/**
 * Acquire the canonical Room-first row lock used by transcript persistence,
 * membership transitions, and the Room journal.
 *
 * Callers must invoke this inside their transaction before inserting any
 * `session_messages` row. PostgreSQL allocates the message sequence value as
 * part of that INSERT, so serializing on `rooms.id` first makes same-Room
 * message-id allocation/commit order authoritative without blocking writes in
 * other Rooms.
 *
 * The helper deliberately does not throw when the Room is absent. Existing
 * callers already own their not-found behavior, and FK enforcement remains the
 * final guard for inserts. Keeping this primitive lock-only also makes it safe
 * for delete/race paths where a missing Room is an expected no-op.
 */
export async function acquireRoomWriteLock(
  tx: RoomLockTransaction,
  roomId: string,
): Promise<void> {
  if (roomId.trim().length === 0) {
    throw new Error("acquireRoomWriteLock: roomId is required");
  }

  await tx.execute(sql`
    SELECT id
    FROM rooms
    WHERE id = ${roomId}
    FOR UPDATE
  `);
}
