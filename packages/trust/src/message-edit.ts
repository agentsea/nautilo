import {
  acquireOrdinaryEncryptionPublicationFence,
  acquireRoomWriteLock,
  and,
  eq,
  getSharedDirectDb,
  roomMembers,
  rooms,
  sessionMessages,
  sessions,
} from "@nautilo/db";
import {
  logicalMessageKey,
  normalizeHumanMessageText,
  type EditableRoomMessageConflictDto,
  type EditedRoomMessageDto,
} from "@nautilo/types";
import { editCanonicalTranscriptMessageInTx } from "./canonical-transcript-mutations";

export type MessageEditDenyReason =
  | "not_found"
  | "forbidden"
  | "ineligible"
  | "room_archived"
  | "invalid_message_content"
  | "message_edit_conflict";

export class MessageEditError extends Error {
  constructor(
    readonly reason: MessageEditDenyReason,
    readonly current?: EditableRoomMessageConflictDto,
  ) {
    super(`MessageEditError:${reason}`);
    this.name = "MessageEditError";
  }
}

export function decideHumanMessageEdit(input: {
  callerIsMember: boolean;
  roomArchived: boolean;
  messageExists: boolean;
  messageRole: string | null;
  sessionOwnerId: string | null;
  callerUserId: string;
  currentContent: string | null;
  originatedBy: string | null;
}):
  | "allowed"
  | Exclude<
      MessageEditDenyReason,
      "invalid_message_content" | "message_edit_conflict"
    > {
  if (!input.callerIsMember || !input.messageExists) return "not_found";
  if (input.roomArchived) return "room_archived";
  if (input.sessionOwnerId !== input.callerUserId) return "forbidden";
  if (
    input.messageRole !== "user" ||
    input.originatedBy === "task" ||
    input.originatedBy === "connected_web_operation" ||
    input.currentContent === null ||
    normalizeHumanMessageText(input.currentContent).length === 0
  ) {
    return "ineligible";
  }
  return "allowed";
}

/**
 * M230 — atomically edits one logical Human turn and invalidates all derived
 * Room-journal state. The canonical Room lock serializes this mutation with
 * transcript writes and other edits in the same Room.
 */
export async function editHumanRoomMessage(input: {
  roomId: string;
  messageId: number;
  callerUserId: string;
  callerActorId: string;
  content: string;
  expectedRevision: number;
  now?: Date;
}): Promise<EditedRoomMessageDto> {
  const content = normalizeHumanMessageText(input.content);
  if (content.length === 0) {
    throw new MessageEditError("invalid_message_content");
  }

  const db = getSharedDirectDb();
  return db.transaction(async (tx) => {
    // Fence the legacy ordinary endpoint before loading any confidential body.
    // Full therefore rejects a bypassing/stale client without observing or
    // changing the retained ordinary representation.
    await acquireOrdinaryEncryptionPublicationFence(tx);
    await acquireRoomWriteLock(tx, input.roomId);

    const [membership] = await tx
      .select({ actorId: roomMembers.actorId })
      .from(roomMembers)
      .where(
        and(
          eq(roomMembers.roomId, input.roomId),
          eq(roomMembers.actorId, input.callerActorId),
        ),
      )
      .limit(1);

    const [target] = await tx
      .select({
        id: sessionMessages.id,
        role: sessionMessages.role,
        content: sessionMessages.content,
        fingerprint: sessionMessages.fingerprint,
        editRevision: sessionMessages.editRevision,
        editedAt: sessionMessages.editedAt,
        metadata: sessionMessages.metadata,
        sessionOwnerId: sessions.ownerId,
        roomId: sessions.roomId,
        archivedAt: rooms.archivedAt,
      })
      .from(sessionMessages)
      .innerJoin(sessions, eq(sessionMessages.sessionId, sessions.id))
      .innerJoin(rooms, eq(sessions.roomId, rooms.id))
      .where(
        and(
          eq(sessionMessages.id, input.messageId),
          eq(sessions.roomId, input.roomId),
        ),
      )
      .limit(1)
      .for("update");

    const decision = decideHumanMessageEdit({
      callerIsMember: Boolean(membership),
      roomArchived: target?.archivedAt != null,
      messageExists: Boolean(target),
      messageRole: target?.role ?? null,
      sessionOwnerId: target?.sessionOwnerId ?? null,
      callerUserId: input.callerUserId,
      currentContent: target?.content ?? null,
      originatedBy:
        target?.metadata && typeof target.metadata["originatedBy"] === "string"
          ? target.metadata["originatedBy"]
          : null,
    });
    if (decision !== "allowed") {
      throw new MessageEditError(decision);
    }
    if (!target) throw new MessageEditError("not_found");
    if (target.content === null) throw new MessageEditError("ineligible");
    const ordinaryContent = target.content;

    const currentDto = (): EditableRoomMessageConflictDto => ({
      id: String(target.id),
      logicalMessageKey: logicalMessageKey(target),
      content: ordinaryContent,
      editedAt: target.editedAt?.toISOString() ?? null,
      editRevision: target.editRevision,
    });
    if (target.editRevision !== input.expectedRevision) {
      throw new MessageEditError("message_edit_conflict", currentDto());
    }

    const edited = await editCanonicalTranscriptMessageInTx(tx, {
      messageId: target.id,
      expectedRevision: input.expectedRevision,
      content,
      clearCryptoObjectId: true,
      ...(input.now === undefined ? {} : { editedAt: input.now }),
    });
    if (edited === null) {
      throw new MessageEditError("message_edit_conflict", currentDto());
    }

    return {
      id: String(target.id),
      logicalMessageKey: logicalMessageKey(target),
      content,
      editedAt: edited.editedAt.toISOString(),
      editRevision: edited.nextRevision,
    };
  });
}
