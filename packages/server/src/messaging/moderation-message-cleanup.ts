import { and, asc, eq, getSharedDirectDb, gt, inArray, lte, moderationSubjects, or,
  rooms, sessionMessages, sessionMessageCryptoRevisions, sessions, sql, type ModerationActionRow } from "@nautilo/db";
import { MessageDeleteError } from "@nautilo/trust";
import { deleteMessageWithConvergence } from "./message-deletion";

/** Consume a committed ban receipt, never a caller-supplied target or scope.
 * The cutoff prevents restart recovery from deleting post-readmission messages.
 * Each deletion commits its own receipt; a failed row cannot hide later rows. */
export async function deleteBannedCommunityMessages(receipt: ModerationActionRow): Promise<void> {
  if (!receipt.deleteCommunityMessages || receipt.action !== "ban" || receipt.roomId !== null) return;
  if (!receipt.requesterUserId) throw new Error("Ban cleanup requires its retained requester");
  const db = getSharedDirectDb();
  const [subject] = await db.select({ userId: moderationSubjects.userId }).from(moderationSubjects)
    .where(eq(moderationSubjects.id, receipt.subjectId));
  if (!subject?.userId) throw new Error("Ban cleanup subject is unavailable");
  const eligible = () => and(eq(sessions.ownerId, subject.userId!), eq(sessionMessages.role, "user"),
    lte(sessionMessages.createdAt, receipt.createdAt),
    or(inArray(rooms.kind, ["group", "open"]), and(eq(rooms.kind, "subthread"),
      sql`EXISTS (SELECT 1 FROM rooms parent WHERE parent.id = ${rooms.parentRoomId} AND parent.kind IN ('group', 'open'))`)));
  let after = 0;
  let incomplete = false;
  let firstFailure: unknown;
  while (true) {
    // One canonical transaction at a time; no history ceiling or bulk SQL delete.
    const [message] = await db.select({ id: sessionMessages.id, roomId: rooms.id }).from(sessionMessages)
      .innerJoin(sessions, eq(sessions.id, sessionMessages.sessionId))
      .innerJoin(rooms, eq(rooms.id, sessions.roomId))
      .where(and(eligible(), gt(sessionMessages.id, after))).orderBy(asc(sessionMessages.id)).limit(1);
    if (!message) break;
    after = message.id;
    try {
      await deleteMessageWithConvergence({ roomId: message.roomId, messageId: message.id,
        actorUserId: receipt.requesterUserId, actorId: null, source: "moderation_ban", authority: "server_ban",
        moderationOperationId: receipt.operationId,
        verifyInTx: async tx => {
          const [current] = await tx.select({ id: sessionMessages.id,
            classification: sessionMessageCryptoRevisions.subthreadReplyClassification }).from(sessionMessages)
            .innerJoin(sessions, eq(sessions.id, sessionMessages.sessionId)).innerJoin(rooms, eq(rooms.id, sessions.roomId))
            .leftJoin(sessionMessageCryptoRevisions, and(eq(sessionMessageCryptoRevisions.messageId, sessionMessages.id),
              eq(sessionMessageCryptoRevisions.editRevision, sessionMessages.editRevision)))
            .where(and(eligible(), eq(sessionMessages.id, message.id), eq(rooms.id, message.roomId)));
          if (!current) throw new MessageDeleteError("not_found");
          return current.classification ? { subthreadReplyClassification: current.classification } : undefined;
        },
      });
    } catch (error) {
      if (!(error instanceof MessageDeleteError && error.reason === "not_found")) {
        incomplete = true;
        firstFailure ??= error;
      }
    }
  }
  if (incomplete) throw new Error("Community message cleanup remains pending", { cause: firstFailure });
}
