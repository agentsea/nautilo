import {
  actors,
  and,
  getSharedDirectDb,
  eq,
  inArray,
  isNull,
  lte,
  markMessageRecipientDeliveredWith,
  markMessageRecipientReadWith,
  ne,
  or,
  roomMembers,
  sessionMessageRecipientState,
  sessionMessages,
  sessions,
  sql,
  type Database,
} from "@nautilo/db";

export interface AggregatedReadState {
  shape: "1:1" | "group";
  selfDelivered: boolean;
  selfRead: boolean;
  recipientCount: number;
  deliveredCount: number;
  readCount: number;
}

async function countHumanUsersInRoom(
  db: Database,
  roomId: string,
): Promise<number> {
  const [row] = await db
    .select({
      c: sql<number>`count(distinct ${actors.ownerId})::int`,
    })
    .from(roomMembers)
    .innerJoin(actors, eq(roomMembers.actorId, actors.id))
    .where(and(eq(roomMembers.roomId, roomId), eq(actors.kind, "user")));
  return row?.c ?? 0;
}

async function resolveMessageRoom(
  db: Database,
  messageId: number,
): Promise<{ roomId: string } | null> {
  const [msg] = await db
    .select({ sessionId: sessionMessages.sessionId })
    .from(sessionMessages)
    .where(eq(sessionMessages.id, messageId))
    .limit(1);
  if (!msg) return null;
  const [sess] = await db
    .select({ roomId: sessions.roomId })
    .from(sessions)
    .where(eq(sessions.id, msg.sessionId))
    .limit(1);
  if (!sess?.roomId) return null;
  return { roomId: sess.roomId };
}

/**
 * D124 — stamp delivery for `recipientId` (Human user id).
 * M158 (D-3): routes the scalar 1:1 path only for the single-human
 * (1 human, user↔agent) room; every 2+human room uses the per-recipient
 * junction. Must stay in lockstep with `markRead` / `getMessageReadState`
 * so reader and writer agree on the storage shape.
 *
 * Returns silently when the message id does not resolve to a Room (no row /
 * orphan session). HTTP routes must call `assertUserCanAccessMessage` first so
 * missing ids surface as 404. Direct callers (e.g. the WS publisher) tolerate
 * stale ids without failing the broadcast.
 */
export async function markDelivered(messageId: number, recipientId: string): Promise<void> {
  const db = getSharedDirectDb();
  const loc = await resolveMessageRoom(db, messageId);
  if (!loc) return;
  const n = await countHumanUsersInRoom(db, loc.roomId);
  if (n < 2) {
    await db
      .update(sessionMessages)
      .set({ deliveredAt: new Date() })
      .where(and(eq(sessionMessages.id, messageId), isNull(sessionMessages.deliveredAt)));
  } else {
    await markMessageRecipientDeliveredWith(db, messageId, recipientId);
  }
}

/**
 * D124 — stamp read for `recipientId` (Human user id).
 *
 * M122/M240 — returns `{ flipped }` so callers can gate the canonical
 * notification-state publish (D196 emit-on-change watchpoint). `flipped` is
 * true exactly when this
 * call moved the message from unread → read for the recipient (a fresh stamp or
 * a previously-NULL row); idempotent re-calls return `{ flipped: false }`.
 * `roomId` is the message's room (for the caller's WS recompute), or `null` when
 * the id does not resolve to a Room (then `flipped` is also false).
 */
export async function markRead(
  messageId: number,
  recipientId: string,
): Promise<{ flipped: boolean; roomId: string | null }> {
  const db = getSharedDirectDb();
  const loc = await resolveMessageRoom(db, messageId);
  if (!loc) return { flipped: false, roomId: null };
  const n = await countHumanUsersInRoom(db, loc.roomId);
  if (n < 2) {
    const rows = await db
      .update(sessionMessages)
      .set({ readAt: new Date() })
      .where(and(eq(sessionMessages.id, messageId), isNull(sessionMessages.readAt)))
      .returning({ id: sessionMessages.id });
    return { flipped: rows.length > 0, roomId: loc.roomId };
  }
  // Group substrate: the conflict update only fires when the existing row's
  // read_at IS NULL, so RETURNING yields a row exactly when we flipped
  // unread → read (fresh insert, or previously-NULL update).
  const flipped = await markMessageRecipientReadWith(db, messageId, recipientId);
  return { flipped, roomId: loc.roomId };
}

/**
 * M122 — mark every display-eligible, non-self-authored message in a room as
 * read for `userId`, optionally bounded by `upToMessageId` (inclusive,
 * `session_messages.id` is a monotonic serial so this is a chronological bound
 * across all sessions in the room). Routes the same bifurcated D124 substrate as
 * `markRead`. Returns `{ marked }` = rows that actually flipped unread → read;
 * idempotent re-call returns `{ marked: 0 }`. Publisher-unaware — the server
 * route gates the WS publish on `marked > 0`.
 *
 * M158 (D-3): the scalar branch now only covers the single-human (1:1
 * user↔agent) room; every 2+human room (DMs included) uses the per-recipient
 * junction, so one human reading no longer clears the other human's unread.
 */
export async function markRoomRead(args: {
  roomId: string;
  userId: string;
  upToMessageId?: number | null;
}): Promise<{ marked: number }> {
  const { roomId, userId } = args;
  const upTo = args.upToMessageId ?? null;
  if (!roomId || !userId) return { marked: 0 };
  const db = getSharedDirectDb();
  const n = await countHumanUsersInRoom(db, roomId);
  if (n < 2) {
    const rows = await db
      .update(sessionMessages)
      .set({ readAt: sql<Date>`now()` })
      .from(sessions)
      .where(and(
        eq(sessionMessages.sessionId, sessions.id),
        eq(sessions.roomId, roomId),
        isNull(sessionMessages.readAt),
        // M158: include subagent so a sub-agent reply that lands in a real
        // human-visible room (e.g. a task-created DM) is marked read too;
        // must match queryUnreadCountsForRooms or the dot lights but never clears.
        inArray(sessionMessages.transcriptOrigin, ["main", "subagent"]),
        inArray(sessionMessages.role, ["user", "assistant"]),
        or(
          ne(sessionMessages.role, "user"),
          ne(sessions.ownerId, userId),
        ),
        upTo === null ? undefined : lte(sessionMessages.id, upTo),
      ))
      .returning({ id: sessionMessages.id });
    return { marked: rows.length };
  }
  const rows = await db
    .insert(sessionMessageRecipientState)
    .select(
      db
        .select({
          messageId: sessionMessages.id,
          recipientId: sql<string>`${userId}`.as("recipient_id"),
          deliveredAt: sql<Date | null>`null`.as("delivered_at"),
          readAt: sql<Date>`now()`.as("read_at"),
        })
        .from(sessionMessages)
        .innerJoin(sessions, eq(sessionMessages.sessionId, sessions.id))
        .where(and(
          eq(sessions.roomId, roomId),
          inArray(sessionMessages.transcriptOrigin, ["main", "subagent"]),
          inArray(sessionMessages.role, ["user", "assistant"]),
          or(
            ne(sessionMessages.role, "user"),
            ne(sessions.ownerId, userId),
          ),
          upTo === null ? undefined : lte(sessionMessages.id, upTo),
        )),
    )
    .onConflictDoUpdate({
      target: [
        sessionMessageRecipientState.messageId,
        sessionMessageRecipientState.recipientId,
      ],
      set: { readAt: sql<Date>`excluded.read_at` },
      setWhere: isNull(sessionMessageRecipientState.readAt),
    })
    .returning({ messageId: sessionMessageRecipientState.messageId });
  return { marked: rows.length };
}

/**
 * Resolves the Human `users.id` whose message should skip WS `markDelivered`
 * self-stamps: session owner for `role = user` rows; `null` for assistant /
 * system / unknown (no skip — every recipient connection is stamped).
 */
export async function getHumanSenderUserIdForMessageBroadcast(
  messageId: number,
): Promise<string | null> {
  const db = getSharedDirectDb();
  const [row] = await db
    .select({
      role: sessionMessages.role,
      ownerId: sessions.ownerId,
    })
    .from(sessionMessages)
    .innerJoin(sessions, eq(sessionMessages.sessionId, sessions.id))
    .where(eq(sessionMessages.id, messageId))
    .limit(1);
  if (!row || row.role !== "user") return null;
  return row.ownerId;
}

/** D124 — aggregated read/delivery state for API + renderers. */
export async function getMessageReadState(
  messageId: number,
  viewerUserId: string,
): Promise<AggregatedReadState> {
  const db = getSharedDirectDb();
  const loc = await resolveMessageRoom(db, messageId);
  if (!loc) {
    return {
      shape: "1:1",
      selfDelivered: false,
      selfRead: false,
      recipientCount: 0,
      deliveredCount: 0,
      readCount: 0,
    };
  }
  const n = await countHumanUsersInRoom(db, loc.roomId);
  if (n < 2) {
    const [msg] = await db
      .select({
        deliveredAt: sessionMessages.deliveredAt,
        readAt: sessionMessages.readAt,
      })
      .from(sessionMessages)
      .where(eq(sessionMessages.id, messageId))
      .limit(1);
    const delivered = Boolean(msg?.deliveredAt);
    const read = Boolean(msg?.readAt);
    return {
      shape: "1:1",
      selfDelivered: delivered,
      selfRead: read,
      recipientCount: n,
      deliveredCount: delivered ? n : 0,
      readCount: read ? n : 0,
    };
  }
  // M158 (Phase 1c / MR7) off-by-one fix: `n` counts every human in the
  // room, but the message author never stamps a read on their own message
  // (self-stamp is ignored). Counting the author in `recipientCount` makes a
  // fully-read 2-human DM compute readCount:1 / recipientCount:2 → "Read by
  // some" forever. Exclude the author (the session owner for `role='user'`
  // rows; agent-authored `role='assistant'` rows have no human author) so a
  // counterpart-read DM reaches readCount === recipientCount → "Read by all".
  const [authorRow] = await db
    .select({
      role: sessionMessages.role,
      ownerId: sessions.ownerId,
    })
    .from(sessionMessages)
    .innerJoin(sessions, eq(sessionMessages.sessionId, sessions.id))
    .where(eq(sessionMessages.id, messageId))
    .limit(1);
  const authorHumanUserId =
    authorRow?.role === "user" ? authorRow.ownerId : null;
  const recipientCount = Math.max(0, n - (authorHumanUserId ? 1 : 0));
  const rows = await db
    .select({
      recipientId: sessionMessageRecipientState.recipientId,
      deliveredAt: sessionMessageRecipientState.deliveredAt,
      readAt: sessionMessageRecipientState.readAt,
    })
    .from(sessionMessageRecipientState)
    .where(eq(sessionMessageRecipientState.messageId, messageId));
  let deliveredCount = 0;
  let readCount = 0;
  let selfDelivered = false;
  let selfRead = false;
  for (const r of rows) {
    if (r.deliveredAt) deliveredCount += 1;
    if (r.readAt) readCount += 1;
    if (r.recipientId === viewerUserId) {
      selfDelivered = Boolean(r.deliveredAt);
      selfRead = Boolean(r.readAt);
    }
  }
  return {
    shape: "group",
    selfDelivered,
    selfRead,
    recipientCount,
    deliveredCount,
    readCount,
  };
}
