import {
  actors,
  and,
  eq,
  getSharedDirectDb,
  roomMembers,
  rooms,
  sessionMessages,
  sessions,
} from "@nautilo/db";
import { userHasCapability } from "./queries";

export class MessageAccessError extends Error {
  readonly reason: "not_found" | "forbidden";

  constructor(reason: "not_found" | "forbidden") {
    super(`MessageAccessError:${reason}`);
    this.name = "MessageAccessError";
    this.reason = reason;
  }
}

/**
 * Ensures `userId` (Human `users.id`) may read or mutate read-state for
 * `messageId` by checking membership in the Room that owns the message.
 */
export async function assertUserCanAccessMessage(
  messageId: number,
  userId: string,
): Promise<void> {
  const db = getSharedDirectDb();
  const [row] = await db
    .select({ roomId: sessions.roomId })
    .from(sessionMessages)
    .innerJoin(sessions, eq(sessionMessages.sessionId, sessions.id))
    .where(eq(sessionMessages.id, messageId))
    .limit(1);
  if (!row?.roomId) {
    throw new MessageAccessError("not_found");
  }
  const [actor] = await db
    .select({ id: actors.id })
    .from(actors)
    .where(and(eq(actors.ownerId, userId), eq(actors.kind, "user")))
    .limit(1);
  if (!actor) {
    throw new MessageAccessError("forbidden");
  }
  const [mem] = await db
    .select({ actorId: roomMembers.actorId })
    .from(roomMembers)
    .where(and(eq(roomMembers.roomId, row.roomId), eq(roomMembers.actorId, actor.id)))
    .limit(1);
  if (!mem) {
    throw new MessageAccessError("forbidden");
  }
}

export type DeleteDenyReason = "not_found" | "forbidden" | "message_anchors_thread";

export class MessageDeleteError extends Error {
  readonly reason: DeleteDenyReason;
  constructor(reason: DeleteDenyReason) {
    super(`MessageDeleteError:${reason}`);
    this.name = "MessageDeleteError";
    this.reason = reason;
  }
}

/**
 * Pure permission decision for deleting a message (no DB access). Encapsulates
 * the ISSUE-M172 §5 policy so it can be unit-tested without a database. The
 * anchor-thread refusal (message_anchors_thread) is decided later, in
 * deleteMessageHard, not here.
 */
export function decideMessageDelete(input: {
  messageExists: boolean;
  callerIsMember: boolean;
  messageRole: string | null;
  sessionOwnerId: string | null;
  callerUserId: string;
  callerHasManageRooms: boolean;
  callerHasRoomStewardship: boolean;
}): "allowed" | "not_found" | "forbidden" {
  if (!input.messageExists) return "not_found";
  if (!input.callerIsMember) return "not_found";
  const ownMessage =
    input.messageRole === "user" &&
    !!input.sessionOwnerId &&
    input.sessionOwnerId === input.callerUserId;
  if (ownMessage || input.callerHasManageRooms || input.callerHasRoomStewardship) {
    return "allowed";
  }
  return "forbidden";
}

/**
 * ISSUE-M172 — throws MessageDeleteError("not_found") if the message/room
 * doesn't resolve or the caller isn't a verified member; ("forbidden") if the
 * caller may not delete it per the §5 policy (own role='user' message OR holds
 * the manage_rooms capability). Resolves silently when allowed.
 */
export async function assertUserCanDeleteMessage(
  messageId: number,
  userId: string,
): Promise<void> {
  const db = getSharedDirectDb();
  const [row] = await db
    .select({
      roomId: sessions.roomId,
      role: sessionMessages.role,
      sessionOwnerId: sessions.ownerId,
      roomOwnerId: rooms.ownerId,
    })
    .from(sessionMessages)
    .innerJoin(sessions, eq(sessionMessages.sessionId, sessions.id))
    .innerJoin(rooms, eq(sessions.roomId, rooms.id))
    .where(eq(sessionMessages.id, messageId))
    .limit(1);

  let callerIsMember = false;
  let callerHasRoomStewardship = row?.roomOwnerId === userId;
  if (row?.roomId) {
    const [actor] = await db
      .select({ id: actors.id })
      .from(actors)
      .where(and(eq(actors.ownerId, userId), eq(actors.kind, "user")))
      .limit(1);
    if (actor) {
      const [mem] = await db
        .select({ actorId: roomMembers.actorId, roomRole: roomMembers.roomRole })
        .from(roomMembers)
        .where(and(eq(roomMembers.roomId, row.roomId), eq(roomMembers.actorId, actor.id)))
        .limit(1);
      callerIsMember = Boolean(mem);
      callerHasRoomStewardship ||= mem?.roomRole === "admin";
    }
  }

  let callerHasManageRooms = false;
  if (callerIsMember) {
    callerHasManageRooms = await userHasCapability(userId, "manage_rooms");
  }

  const decision = decideMessageDelete({
    messageExists: Boolean(row?.roomId),
    callerIsMember,
    messageRole: row?.role ?? null,
    sessionOwnerId: row?.sessionOwnerId ?? null,
    callerUserId: userId,
    callerHasManageRooms,
    callerHasRoomStewardship,
  });
  if (decision !== "allowed") {
    throw new MessageDeleteError(decision === "not_found" ? "not_found" : "forbidden");
  }
}
