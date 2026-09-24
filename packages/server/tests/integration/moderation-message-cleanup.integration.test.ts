import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { __resetSharedDirectDbForTests, ensureDatabase, getSharedDirectDb, eq, inArray,
  actors, namespaces, rooms, roomMembers, sessions, sessionMessages, users, moderationActions,
  moderationSubjects, messageDeletionReceipts, sessionMessageCryptoRevisions } from "@nautilo/db";
import { bootstrapTestDbInstance } from "@nautilo/db/testing";
import { appendCanonicalTranscriptRowsToExistingSessionInTx, getSubthreadDetailForMember, recoverModerationEffects } from "@nautilo/trust";
import { getSubthreadDetailForMemberWithDb, listSubthreadsForRoom } from "../../../trust/src/queries";
import { deleteBannedCommunityMessages } from "../../src/messaging/moderation-message-cleanup";

beforeAll(async () => { bootstrapTestDbInstance(); await ensureDatabase(); }, 120_000);
afterAll(async () => { await __resetSharedDirectDbForTests(); });

test.each([false, true])("ban cleanup preserves private history and other people's threads across recovery (protected reply: %s)", async (protectedReply) => {
  const db = getSharedDirectDb();
  const [target, moderator] = await db.insert(users).values([{ name: "Banned fixture" }, { name: "Moderator fixture" }]).returning();
  const [actor] = await db.insert(actors).values({ kind: "user", ownerId: moderator!.id, displayName: "Moderator fixture" }).returning();
  const [namespace] = await db.insert(namespaces).values({ scope: "room", label: "Cleanup fixture" }).returning();
  const [group, privateRoom] = await db.insert(rooms).values([
    { ownerId: moderator!.id, namespaceId: namespace!.id, kind: "group" as const, type: "shared", label: "Community", graphThreadId: randomUUID() },
    { ownerId: moderator!.id, namespaceId: namespace!.id, kind: "private" as const, type: "private", label: "Private", graphThreadId: randomUUID() },
  ]).returning();
  const [groupSession, privateSession] = await db.insert(sessions).values([
    { ownerId: target!.id, roomId: group!.id, threadId: randomUUID(), messageCount: 3 },
    { ownerId: target!.id, roomId: privateRoom!.id, threadId: randomUUID(), messageCount: 1 },
  ]).returning();
  const before = new Date(Date.now() - 60_000);
  const after = new Date(Date.now() + 60_000);
  const [root, assistant, future, privateMessage] = await db.insert(sessionMessages).values([
    { sessionId: groupSession!.id, role: "user", content: "Remove this root", createdAt: before, replyCount: 2, summaryRevision: 4 },
    { sessionId: groupSession!.id, role: "assistant", content: "Agent reply stays", createdAt: before },
    { sessionId: groupSession!.id, role: "user", content: "Post-readmission history stays", createdAt: after },
    { sessionId: privateSession!.id, role: "user", content: "Private history stays", createdAt: before },
  ]).returning();
  const [child] = await db.insert(rooms).values({ ownerId: moderator!.id, namespaceId: namespace!.id, kind: "subthread", type: "shared",
    label: "Existing discussion", graphThreadId: randomUUID(), parentRoomId: group!.id, threadRootMessageId: root!.id }).returning();
  await db.insert(roomMembers).values({ roomId: child!.id, actorId: actor!.id });
  const childSessions = await db.insert(sessions).values([target!, moderator!].map(user => ({ ownerId: user.id, roomId: child!.id, threadId: randomUUID(), messageCount: 1 }))).returning();
  const [targetReply, otherReply] = await db.insert(sessionMessages).values(childSessions.map((session, index) => ({ sessionId: session.id, role: "user", content: index ? "Other person's reply" : "Remove my reply",
    subthreadRoomId: child!.id, createdAt: before }))).returning();
  const [subject] = await db.insert(moderationSubjects).values({ userId: target!.id }).returning();
  const [ban] = await db.insert(moderationActions).values({ operationId: randomUUID(), requestDigest: "0".repeat(64), requesterUserId: moderator!.id,
    subjectId: subject!.id, roomId: null, action: "ban", restrictionId: randomUUID(), reason: "Fixture ban", deleteCommunityMessages: true }).returning();
  const sessionIds = [groupSession!.id, privateSession!.id, ...childSessions.map(session => session.id)];
  try {
    if (protectedReply) {
      await db.insert(sessionMessageCryptoRevisions).values({
        sessionId: targetReply!.sessionId, messageId: targetReply!.id, editRevision: 0,
        roomId: child!.id, namespaceIdAtAllocation: namespace!.id, cryptoObjectId: `cleanup:${randomUUID()}`,
        keyClass: "human", authorRole: "user", subthreadReplyClassification: "counted",
        appendIdempotencyKey: `cleanup:${randomUUID()}`,
        allocationRequestDigest: new Uint8Array(32),
      });
    }
    expect(await getSubthreadDetailForMemberWithDb(db, child!.id, actor!.id, true)).toBeNull();
    const effects = { appendAudit: async () => {}, converge: async () => {}, deleteCommunityMessages: async (row: typeof ban & {}) => {
      await deleteBannedCommunityMessages(row); throw new Error("Simulated restart before checkpoint");
    } };
    await recoverModerationEffects(ban!.operationId, effects);
    expect((await db.select().from(moderationActions).where(eq(moderationActions.operationId, ban!.operationId)))[0]?.communityMessagesDeletedAt).toBeNull();
    const survivors = await db.select({ id: sessionMessages.id }).from(sessionMessages).where(inArray(sessionMessages.sessionId, sessionIds));
    expect(survivors.map(row => row.id).sort()).toEqual([assistant!.id, future!.id, privateMessage!.id, otherReply!.id].sort());
    const detail = await getSubthreadDetailForMember(child!.id, actor!.id);
    expect(detail?.anchor.content).toBe("Message removed by moderation");
    expect((await getSubthreadDetailForMemberWithDb(db, child!.id, actor!.id, true))?.anchor.content).toBe("Message removed by moderation");
    expect(detail?.anchor.id).toBe(root!.id); expect(detail?.summary.replyCount).toBe(1);
    expect(detail!.summary.summaryRevision).toBeGreaterThan(4);
    expect((await listSubthreadsForRoom(group!.id, actor!.id)).map(row => row.id)).toContain(child!.id);
    await db.transaction(tx => appendCanonicalTranscriptRowsToExistingSessionInTx(tx, {
      sessionId: childSessions[1]!.id,
      rows: [{ role: "user", content: "The remaining conversation can continue", toolCalls: null, toolName: null,
        fingerprint: null, humanTurnId: null, transcriptOrigin: "main", parentThreadId: null, scopeId: null,
        metadata: null, subthreadRoomId: child!.id, replyToMessageId: null }],
    }));
    const continued = await getSubthreadDetailForMember(child!.id, actor!.id);
    expect(continued?.summary.replyCount).toBe(2);
    expect(continued!.summary.summaryRevision).toBeGreaterThan(detail!.summary.summaryRevision);
    await recoverModerationEffects(ban!.operationId, { ...effects, deleteCommunityMessages: deleteBannedCommunityMessages });
    expect((await db.select().from(moderationActions).where(eq(moderationActions.operationId, ban!.operationId)))[0]?.communityMessagesDeletedAt).not.toBeNull();
    const receipts = await db.select().from(messageDeletionReceipts).where(eq(messageDeletionReceipts.moderationOperationId, ban!.operationId));
    expect(receipts.map(row => row.messageId).sort()).toEqual([root!.id, targetReply!.id].sort());
    expect(receipts.every(row => row.source === "moderation_ban" && row.authority === "server_ban")).toBe(true);
  } finally {
    await db.delete(sessionMessages).where(inArray(sessionMessages.sessionId, childSessions.map(session => session.id)));
    await db.delete(sessions).where(inArray(sessions.id, childSessions.map(session => session.id)));
    await db.delete(rooms).where(eq(rooms.id, child!.id));
    await db.delete(sessionMessages).where(inArray(sessionMessages.sessionId, sessionIds));
    await db.delete(sessions).where(inArray(sessions.id, sessionIds));
    await db.delete(rooms).where(inArray(rooms.id, [child!.id, group!.id, privateRoom!.id]));
    await db.delete(namespaces).where(eq(namespaces.id, namespace!.id));
    await db.delete(actors).where(eq(actors.id, actor!.id));
    await db.delete(users).where(inArray(users.id, [target!.id, moderator!.id]));
  }
});
