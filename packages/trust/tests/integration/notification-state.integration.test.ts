import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  and,
  createDirectDb,
  eq,
  pushMessageCandidates,
  roomNotificationSettings,
  sessionMessageDirectedRecipients,
  sessionMessages,
  sql,
  subthreadNotificationParticipants,
  userNotificationSettings,
  users,
  type DirectDatabase,
} from "@nautilo/db";
import { bootstrapTestDbInstance } from "@nautilo/db/testing";
import {
  getChangedNotificationState,
  getImportantMessageArrivals,
  getNotificationState,
} from "../../src/notification-state";
import { appendCanonicalTranscriptRowsToExistingSessionInTx } from "../../src/canonical-transcript-mutations";
import {
  Tracker,
  cleanupAll,
  markRecipRead,
  mkActor,
  mkAgent,
  mkMessage,
  mkNamespace,
  mkRoom,
  mkSession,
  mkUser,
  type Db,
} from "./helpers/unread-fixtures";

let db: Db;
const tracker = new Tracker();
let viewer: string;
let nonparticipant: string;
let parentRoom: string;
let childRoom: string;
let parentDirected: number;
let parentAmbient: number;
let childBoundaryDirected: number;
let childAfterBoundary: number;
let childSession: string;
let parentSession: string;

beforeAll(async () => {
  bootstrapTestDbInstance();
  db = createDirectDb(2);
  const namespaceId = await mkNamespace(db, tracker);
  const agentId = await mkAgent(db, tracker);
  const author = await mkUser(db, tracker, "m236-author");
  viewer = await mkUser(db, tracker, "m236-viewer");
  nonparticipant = await mkUser(db, tracker, "m236-nonparticipant");
  const authorActor = await mkActor(db, tracker, author, "Author");
  const viewerActor = await mkActor(db, tracker, viewer, "Viewer");
  const nonparticipantActor = await mkActor(
    db,
    tracker,
    nonparticipant,
    "Nonparticipant",
  );
  parentRoom = await mkRoom(db, tracker, {
    ownerId: author,
    namespaceId,
    humanActorIds: [authorActor, viewerActor, nonparticipantActor],
    memberActorIds: [authorActor, viewerActor, nonparticipantActor],
    kind: "group",
    type: "group",
  });
  parentSession = await mkSession(db, tracker, {
    roomId: parentRoom,
    ownerId: author,
    agentId,
  });
  parentAmbient = await mkMessage(db, tracker, {
    sessionId: parentSession,
    role: "user",
  });
  parentDirected = await mkMessage(db, tracker, {
    sessionId: parentSession,
    role: "user",
  });
  await db.insert(sessionMessageDirectedRecipients).values({
    messageId: parentDirected,
    recipientId: viewer,
    reason: "mention",
  });
  childRoom = await mkRoom(db, tracker, {
    ownerId: author,
    namespaceId,
    humanActorIds: [authorActor, viewerActor, nonparticipantActor],
    memberActorIds: [authorActor, viewerActor, nonparticipantActor],
    kind: "subthread",
    parentRoomId: parentRoom,
    threadRootMessageId: parentAmbient,
  });
  childSession = await mkSession(db, tracker, {
    roomId: childRoom,
    ownerId: author,
    agentId,
  });
  await mkMessage(db, tracker, {
    sessionId: childSession,
    role: "user",
  });
  childBoundaryDirected = await mkMessage(db, tracker, {
    sessionId: childSession,
    role: "user",
  });
  await db.insert(sessionMessageDirectedRecipients).values({
    messageId: childBoundaryDirected,
    recipientId: viewer,
    reason: "mention",
  });
  await db.insert(pushMessageCandidates).values({
    messageId: childBoundaryDirected,
  });
  await db.insert(subthreadNotificationParticipants).values({
    subthreadRoomId: childRoom,
    userId: viewer,
    fromMessageId: childBoundaryDirected,
    reason: "mention",
  });
  childAfterBoundary = await mkMessage(db, tracker, {
    sessionId: childSession,
    role: "user",
  });
});

afterAll(async () => {
  try {
    await cleanupAll(db, tracker);
  } finally {
    await db.end();
  }
});

describe("M236 authoritative notification state", () => {
  test("applies direct preference, inclusive participation, and aggregate folding", async () => {
    const state = await getNotificationState(viewer, db);
    expect(state.rooms).toHaveLength(1);
    expect(state.rooms[0]).toMatchObject({
      roomId: parentRoom,
      ownUnreadCount: 2,
      ownImportantUnreadCount: 1,
      subthreadUnreadCount: 2,
      subthreadImportantUnreadCount: 1,
      unreadCount: 4,
      importantUnreadCount: 2,
    });
    expect(state.subthreads).toHaveLength(1);
    expect(state.subthreads[0]).toMatchObject({
      roomId: childRoom,
      parentRoomId: parentRoom,
      unreadCount: 2,
      importantUnreadCount: 1,
    });
    expect(state.totals).toEqual({
      unreadCount: 4,
      importantUnreadCount: 2,
    });
  });

  test("omits a nonparticipating child from detail and parent/global totals", async () => {
    const state = await getNotificationState(nonparticipant, db);
    expect(state.subthreads).toEqual([]);
    expect(state.rooms[0]).toMatchObject({
      ownUnreadCount: 2,
      subthreadUnreadCount: 0,
      unreadCount: 2,
    });
  });

  test("reclassifies existing unread for all and none without changing unread", async () => {
    await db.insert(roomNotificationSettings).values({
      userId: viewer,
      roomId: parentRoom,
      level: "all",
    });
    const all = await getNotificationState(viewer, db);
    expect(all.totals).toEqual({
      unreadCount: 4,
      importantUnreadCount: 4,
    });

    await db
      .update(roomNotificationSettings)
      .set({ level: "none" })
      .where(
        and(
          eq(roomNotificationSettings.userId, viewer),
          eq(roomNotificationSettings.roomId, parentRoom),
        ),
      );
    const none = await getNotificationState(viewer, db);
    expect(none.totals).toEqual({
      unreadCount: 4,
      importantUnreadCount: 0,
    });
  });

  test("changed-child batch returns own count and complete parent aggregate", async () => {
    const [change] = await getChangedNotificationState(
      childRoom,
      [viewer, nonparticipant],
      db,
    );
    expect(change).toMatchObject({
      userId: viewer,
      roomId: childRoom,
      topLevelRoomId: parentRoom,
      roomOwnUnreadCount: 2,
      topLevelUnreadCount: 4,
    });
  });

  test("read state changes counts but preserves parent/child independence", async () => {
    await markRecipRead(db, parentDirected, viewer);
    const parentRead = await getNotificationState(viewer, db);
    expect(parentRead.rooms[0]).toMatchObject({
      ownUnreadCount: 1,
      subthreadUnreadCount: 2,
      unreadCount: 3,
    });

    await markRecipRead(db, childAfterBoundary, viewer);
    const childRead = await getNotificationState(viewer, db);
    expect(childRead.subthreads[0]).toMatchObject({
      unreadCount: 1,
    });
    expect(childRead.rooms[0]).toMatchObject({
      ownUnreadCount: 1,
      subthreadUnreadCount: 1,
      unreadCount: 2,
    });
  });

  test("arrival classification loads the durable message and honors current policy", async () => {
    await db
      .update(roomNotificationSettings)
      .set({ level: "direct" })
      .where(
        and(
          eq(roomNotificationSettings.userId, viewer),
          eq(roomNotificationSettings.roomId, parentRoom),
        ),
      );
    expect(
      (await getImportantMessageArrivals(parentAmbient, db)).some(
        (arrival) => arrival.userId === viewer,
      ),
    ).toBe(false);
    const arrivals = await getImportantMessageArrivals(
      childBoundaryDirected,
      db,
    );
    expect(arrivals).toHaveLength(1);
    expect(arrivals[0]).toMatchObject({
      userId: viewer,
      messageId: String(childBoundaryDirected),
      roomId: childRoom,
      topLevelRoomId: parentRoom,
    });
  });

  test("full and changed-family plans stay one service query under high chatter", async () => {
    const inserted = await db
      .insert(sessionMessages)
      .values(
        Array.from({ length: 250 }, (_, index) => ({
          sessionId: childSession,
          role: "assistant",
          content: `high-chatter-${index}`,
          transcriptOrigin: "main",
        })),
      )
      .returning({ id: sessionMessages.id });
    tracker.messageIds.push(...inserted.map((message) => message.id));

    // Give the participant relation enough unrelated cardinality for the
    // production index path to be cost-effective. The service query selects
    // viewer/nonparticipant only, so these rows preserve the exact result
    // while making the planner contract deterministic on a clean database.
    const noiseUsers = await db
      .insert(users)
      .values(
        Array.from({ length: 512 }, () => {
          const suffix = randomUUID().replaceAll("-", "");
          return {
            name: `M236 plan noise ${suffix.slice(0, 8)}`,
            email: `m236-plan-${suffix}@test.invalid`,
            handle: `m236plan${suffix}`,
          };
        }),
      )
      .returning({ id: users.id });
    tracker.userIds.push(...noiseUsers.map((user) => user.id));
    // Keep both repeatedly joined preference relations large enough for their
    // indexed paths to be cost-effective under the planner assertion below.
    await db.insert(userNotificationSettings).values(
      noiseUsers.map((user) => ({ userId: user.id })),
    );
    await db.insert(subthreadNotificationParticipants).values(
      noiseUsers.map((user) => ({
        subthreadRoomId: childRoom,
        userId: user.id,
        fromMessageId: childBoundaryDirected,
        reason: "posted" as const,
      })),
    );
    await db.execute(sql`ANALYZE subthread_notification_participants`);
    await db.execute(sql`ANALYZE user_notification_settings`);

    const plans: unknown[] = [];
    let serviceExecuteCalls = 0;
    const explainingDatabase = {
      execute: async (query: unknown) => {
        serviceExecuteCalls += 1;
        plans.push(
          await db.execute(
            sql`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${
              query as Parameters<DirectDatabase["execute"]>[0]
            }`,
          ),
        );
        return db.execute(
          query as Parameters<DirectDatabase["execute"]>[0],
        );
      },
    } as unknown as DirectDatabase;

    await getNotificationState(viewer, explainingDatabase);
    expect(serviceExecuteCalls).toBe(1);
    await getChangedNotificationState(
      childRoom,
      [viewer, nonparticipant],
      explainingDatabase,
    );
    expect(serviceExecuteCalls).toBe(2);
    expect(plans).toHaveLength(2);

    const planEvidence = JSON.stringify(plans);
    expect(planEvidence).toContain("Execution Time");
    expect(planEvidence).toContain("Planning Time");
    expect(planEvidence).toContain("idx_session_messages_session_id");
    expect(planEvidence).toContain("idx_smdr_recipient_message");
    expect(planEvidence).toContain("idx_snp_user_room_message");
    expect(planEvidence).toContain("idx_room_notification_settings_room");
    const repeatedSequentialScans: Array<{
      relation: string;
      loops: number;
    }> = [];
    const inspectPlanNode = (value: unknown): void => {
      if (Array.isArray(value)) {
        for (const item of value) inspectPlanNode(item);
        return;
      }
      if (value === null || typeof value !== "object") return;
      const record = value as Record<string, unknown>;
      if (
        record["Node Type"] === "Seq Scan" &&
        typeof record["Actual Loops"] === "number" &&
        record["Actual Loops"] > 1
      ) {
        repeatedSequentialScans.push({
          relation:
            typeof record["Relation Name"] === "string"
              ? record["Relation Name"]
              : "unknown",
          loops: record["Actual Loops"],
        });
      }
      for (const child of Object.values(record)) inspectPlanNode(child);
    };
    inspectPlanNode(plans);
    expect(repeatedSequentialScans).toEqual([]);
    if (process.env["M236_PLAN_VERBOSE"] === "1") {
      console.info(`[M236 query-plan JSON] ${planEvidence}`);
    }
    console.info(
      `[M236 query-plan] full+changed plans captured; ` +
        `serviceExecuteCalls=${serviceExecuteCalls}; highChatterRows=${inserted.length}`,
    );
  });

  test("classifies legacy and protected eligible appends from committed structural admission", async () => {
    const append = await db.transaction((tx) =>
      appendCanonicalTranscriptRowsToExistingSessionInTx(tx, {
        sessionId: parentSession,
        rows: [
          {
            role: "user",
            content: "Legacy body stays outside notification classification.",
            toolCalls: null,
            toolName: null,
            fingerprint: `m236-legacy-${randomUUID()}`,
            humanTurnId: null,
            transcriptOrigin: "main",
            parentThreadId: null,
            scopeId: null,
            metadata: null,
            subthreadRoomId: null,
            replyToMessageId: null,
          },
          {
            role: "user",
            content: "Protected body stays outside notification classification.",
            toolCalls: null,
            toolName: null,
            fingerprint: `m236-protected-${randomUUID()}`,
            humanTurnId: null,
            transcriptOrigin: "main",
            parentThreadId: null,
            scopeId: null,
            metadata: { source: "protected-product" },
            subthreadRoomId: null,
            replyToMessageId: null,
            protectedStructuralProjection: {
              notificationEligibility: "eligible",
              subthreadReplyClassification: "excluded",
            },
          },
        ],
        notificationContext: {
          mentionedHumanUserIds: [viewer],
          causalHumanUserId: null,
          causalHumanTurnId: null,
        },
      })
    );
    const messageIds = append.insertedRows.map((row) => Number(row.id));
    tracker.messageIds.push(...messageIds);

    const arrivals = await Promise.all(
      messageIds.map((messageId) => getImportantMessageArrivals(messageId, db)),
    );

    expect(arrivals).toHaveLength(2);
    for (const [index, arrival] of arrivals.entries()) {
      expect(arrival).toHaveLength(1);
      expect(arrival[0]).toMatchObject({
        userId: viewer,
        messageId: String(messageIds[index]),
        roomId: parentRoom,
      });
    }
    expect(JSON.stringify(arrivals)).not.toContain("body stays outside");
  });

  test("does not classify legacy task rows or protected structural exclusions", async () => {
    const append = await db.transaction((tx) =>
      appendCanonicalTranscriptRowsToExistingSessionInTx(tx, {
        sessionId: parentSession,
        rows: [
          {
            role: "assistant",
            content: "legacy task report",
            toolCalls: null,
            toolName: null,
            fingerprint: `m236-task-${randomUUID()}`,
            humanTurnId: null,
            transcriptOrigin: "main",
            parentThreadId: null,
            scopeId: null,
            metadata: { originatedBy: "task" },
            subthreadRoomId: null,
            replyToMessageId: null,
          },
          {
            role: "assistant",
            content: "protected excluded row",
            toolCalls: null,
            toolName: null,
            fingerprint: `m236-excluded-${randomUUID()}`,
            humanTurnId: null,
            transcriptOrigin: "main",
            parentThreadId: null,
            scopeId: null,
            metadata: { source: "protected-product" },
            subthreadRoomId: null,
            replyToMessageId: null,
            protectedStructuralProjection: {
              notificationEligibility: "excluded",
              subthreadReplyClassification: "excluded",
            },
          },
        ],
        notificationContext: {
          mentionedHumanUserIds: [],
          causalHumanUserId: null,
          causalHumanTurnId: null,
        },
      })
    );
    const messageIds = append.insertedRows.map((row) => Number(row.id));
    tracker.messageIds.push(...messageIds);

    const admitted = await db
      .select({ messageId: pushMessageCandidates.messageId })
      .from(pushMessageCandidates);
    expect(
      admitted.filter((candidate) => messageIds.includes(candidate.messageId)),
    ).toEqual([]);
    expect(
      await Promise.all(
        messageIds.map((messageId) => getImportantMessageArrivals(messageId, db)),
      ),
    ).toEqual([[], []]);
  });
});
