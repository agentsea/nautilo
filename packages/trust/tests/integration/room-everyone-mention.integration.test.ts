/**
 * Room-wide Human mention classification against an already-migrated,
 * disposable named instance.
 *
 * Run with:
 *   NAUTILO_INSTANCE_ID=your-disposable-instance bun test --timeout 60000 \
 *     packages/trust/tests/integration/room-everyone-mention.integration.test.ts
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  createDirectDb,
  eq,
  roomNotificationSettings,
  sessionMessageDirectedRecipients,
} from "@nautilo/db";
import { bootstrapTestDbInstance } from "@nautilo/db/testing";
import { appendCanonicalTranscriptRowsToExistingSessionInTx } from "../../src/canonical-transcript-mutations";
import { getImportantMessageArrivals } from "../../src/notification-state";
import {
  Tracker,
  cleanupAll,
  mkActor,
  mkAgent,
  mkNamespace,
  mkRoom,
  mkSession,
  mkUser,
  type Db,
} from "./helpers/unread-fixtures";

let db: Db;
const tracker = new Tracker();
let roomId: string;
let sessionId: string;
let senderId: string;
let mutedMemberId: string;
let directMemberId: string;
let duplicatedMentionId: string;
let staleNonmemberId: string;
let currentRecipientIds: string[];

beforeAll(async () => {
  bootstrapTestDbInstance();
  db = createDirectDb(4);

  const namespaceId = await mkNamespace(db, tracker);
  const agentId = await mkAgent(db, tracker);
  senderId = await mkUser(db, tracker, "everyone-sender");
  const senderActorId = await mkActor(db, tracker, senderId, "Everyone sender");

  const currentMembers = await Promise.all(
    Array.from({ length: 34 }, async (_, index) => {
      const userId = await mkUser(db, tracker, `everyone-member-${index}`);
      const actorId = await mkActor(
        db,
        tracker,
        userId,
        `Everyone member ${index}`,
      );
      return { userId, actorId };
    }),
  );
  currentRecipientIds = currentMembers.map((member) => member.userId);
  [mutedMemberId, directMemberId, duplicatedMentionId] = currentRecipientIds as [
    string,
    string,
    string,
  ];

  staleNonmemberId = await mkUser(db, tracker, "everyone-stale-nonmember");
  const staleNonmemberActorId = await mkActor(
    db,
    tracker,
    staleNonmemberId,
    "Stale nonmember",
  );

  roomId = await mkRoom(db, tracker, {
    ownerId: senderId,
    namespaceId,
    // Deliberately retain a stale denormalized Human id. Classification must
    // derive @everyone from current room_members instead.
    humanActorIds: [
      senderActorId,
      ...currentMembers.map((member) => member.actorId),
      staleNonmemberActorId,
    ],
    memberActorIds: [
      senderActorId,
      ...currentMembers.map((member) => member.actorId),
    ],
    kind: "group",
    type: "group",
  });
  sessionId = await mkSession(db, tracker, {
    roomId,
    ownerId: senderId,
    agentId,
  });

  await db.insert(roomNotificationSettings).values([
    { userId: mutedMemberId, roomId, level: "none" },
    { userId: directMemberId, roomId, level: "direct" },
  ]);
});

afterAll(async () => {
  try {
    await cleanupAll(db, tracker);
  } finally {
    await db.end();
  }
});

describe("Room @everyone notification classification", () => {
  test("directs every current Human once while respecting sender and notification policy", async () => {
    const append = await db.transaction((tx) =>
      appendCanonicalTranscriptRowsToExistingSessionInTx(tx, {
        sessionId,
        rows: [
          {
            role: "user",
            content: "A room-wide announcement",
            toolCalls: null,
            toolName: null,
            fingerprint: `everyone-${randomUUID()}`,
            humanTurnId: null,
            transcriptOrigin: "main",
            parentThreadId: null,
            scopeId: null,
            metadata: null,
            subthreadRoomId: null,
            replyToMessageId: null,
          },
        ],
        notificationContext: {
          mentionedHumanUserIds: [duplicatedMentionId],
          mentionEveryone: true,
          causalHumanUserId: null,
          causalHumanTurnId: null,
        },
      })
    );
    const messageId = Number(append.insertedRows[0]?.id);
    expect(Number.isSafeInteger(messageId)).toBe(true);
    tracker.messageIds.push(messageId);

    const directed = await db
      .select({
        recipientId: sessionMessageDirectedRecipients.recipientId,
        reason: sessionMessageDirectedRecipients.reason,
      })
      .from(sessionMessageDirectedRecipients)
      .where(eq(sessionMessageDirectedRecipients.messageId, messageId));

    expect(directed).toHaveLength(currentRecipientIds.length);
    expect(new Set(directed.map((fact) => fact.recipientId))).toEqual(
      new Set(currentRecipientIds),
    );
    expect(directed.every((fact) => fact.reason === "mention")).toBe(true);
    expect(directed.filter((fact) => fact.recipientId === duplicatedMentionId)).toHaveLength(1);
    expect(directed.some((fact) => fact.recipientId === senderId)).toBe(false);
    expect(directed.some((fact) => fact.recipientId === staleNonmemberId)).toBe(false);

    const arrivals = await getImportantMessageArrivals(messageId, db);
    const arrivalUserIds = new Set(arrivals.map((arrival) => arrival.userId));
    expect(arrivals).toHaveLength(currentRecipientIds.length - 1);
    expect(arrivalUserIds.has(mutedMemberId)).toBe(false);
    expect(arrivalUserIds.has(directMemberId)).toBe(true);
    expect(arrivalUserIds.has(duplicatedMentionId)).toBe(true);
    expect(arrivalUserIds.has(senderId)).toBe(false);
    expect(arrivalUserIds.has(staleNonmemberId)).toBe(false);
  });
});
