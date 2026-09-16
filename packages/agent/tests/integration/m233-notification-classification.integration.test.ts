import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { config } from "dotenv";

config({ path: resolve(import.meta.dirname, "../../../../.env") });

import {
  afterAll,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import { AIMessage, HumanMessage } from "@langchain/core/messages";
import {
  actors,
  agents,
  and,
  createDirectDb,
  ensureDatabase,
  eq,
  inArray,
  namespaces,
  roomMembers,
  rooms,
  sessionMessageDirectedRecipients,
  sessionMessages,
  sessions,
  subthreadNotificationParticipants,
  users,
} from "@nautilo/db";
import { bootstrapTestDbInstance } from "@nautilo/db/testing";
import { buildForegroundUserHumanMessage } from "../../src/chat/foreground-user-message";
import { appendTranscriptMessages } from "../../src/store/session-store";

let db: ReturnType<typeof createDirectDb>;
const createdUserIds: string[] = [];
const createdActorIds: string[] = [];
const createdRoomIds: string[] = [];
let agentId = "";
let agentActorId = "";
let namespaceId = "";
const ts = Date.now().toString(36);

async function createHuman(label: string): Promise<{
  userId: string;
  actorId: string;
}> {
  const [user] = await db
    .insert(users)
    .values({
      name: `m233-${label}-${ts}`,
      email: `m233-${label}-${ts}@test.local`,
      handle: `m233${label}${ts.slice(-5)}`,
    })
    .returning({ id: users.id });
  if (!user) throw new Error("failed to create M233 Human");
  const [actor] = await db
    .insert(actors)
    .values({
      ownerId: user.id,
      displayName: label,
      kind: "user",
    })
    .returning({ id: actors.id });
  if (!actor) throw new Error("failed to create M233 Human Actor");
  createdUserIds.push(user.id);
  createdActorIds.push(actor.id);
  return { userId: user.id, actorId: actor.id };
}

async function createRoom(input: {
  ownerId: string;
  createdBy: string;
  humanActorIds: string[];
  kind?: "group" | "subthread";
  parentRoomId?: string;
  threadRootMessageId?: number;
}): Promise<string> {
  const id = randomUUID();
  await db.insert(rooms).values({
    id,
    ownerId: input.ownerId,
    type: "shared",
    label: `m233-${input.kind ?? "group"}-${ts}`,
    graphThreadId: `room:${id}`,
    namespaceId,
    humanActorIds: [...input.humanActorIds].sort(),
    createdBy: input.createdBy,
    kind: input.kind ?? "group",
    ...(input.parentRoomId ? { parentRoomId: input.parentRoomId } : {}),
    ...(input.threadRootMessageId != null
      ? { threadRootMessageId: input.threadRootMessageId }
      : {}),
  });
  await db.insert(roomMembers).values([
    ...input.humanActorIds.map((actorId, index) => ({
      roomId: id,
      actorId,
      roomRole: index === 0 ? ("admin" as const) : ("member" as const),
    })),
    { roomId: id, actorId: agentActorId, roomRole: "member" as const },
  ]);
  createdRoomIds.push(id);
  return id;
}

beforeAll(async () => {
  bootstrapTestDbInstance();
  await ensureDatabase();
  db = createDirectDb(2);
  const [agentOwner] = await db
    .insert(users)
    .values({
      name: `m233-agent-owner-${ts}`,
      email: `m233-agent-owner-${ts}@test.local`,
      handle: `m233agentowner${ts.slice(-5)}`,
    })
    .returning({ id: users.id });
  if (!agentOwner) throw new Error("failed to create M233 Agent owner");
  createdUserIds.push(agentOwner.id);
  const [agent] = await db
    .insert(agents)
    .values({ handle: `m233-agent-${ts}` })
    .returning({ id: agents.id });
  if (!agent) throw new Error("failed to create M233 Agent");
  agentId = agent.id;
  const [agentActor] = await db
    .insert(actors)
    .values({
      ownerId: agentOwner.id,
      agentId,
      displayName: "M233 Agent",
      kind: "agent",
    })
    .returning({ id: actors.id });
  if (!agentActor) throw new Error("failed to create M233 Agent Actor");
  agentActorId = agentActor.id;
  const [namespace] = await db
    .insert(namespaces)
    .values({ scope: "shared", label: `m233-${ts}` })
    .returning({ id: namespaces.id });
  if (!namespace) throw new Error("failed to create M233 Namespace");
  namespaceId = namespace.id;
});

afterAll(async () => {
  if (!db) return;
  try {
    if (createdRoomIds.length > 0) {
      const sessionRows = await db
        .select({ id: sessions.id, roomId: sessions.roomId })
        .from(sessions)
        .where(inArray(sessions.roomId, createdRoomIds));
      const subthreadRows = await db
        .select({ id: rooms.id })
        .from(rooms)
        .where(
          and(
            inArray(rooms.id, createdRoomIds),
            eq(rooms.kind, "subthread"),
          ),
        );
      const subthreadRoomIds = new Set(subthreadRows.map((row) => row.id));
      const subthreadSessionIds = sessionRows
        .filter(
          (row) =>
            row.roomId !== null && subthreadRoomIds.has(row.roomId),
        )
        .map((row) => row.id);
      const remainingSessionIds = sessionRows
        .filter(
          (row) =>
            row.roomId !== null && !subthreadRoomIds.has(row.roomId),
        )
        .map((row) => row.id);

      // A Subthread must retain its parent-Room root message while the child
      // Room exists. Remove the child transcript and Session, then the child
      // Room, before cleaning the parent transcript that owns that root.
      if (subthreadSessionIds.length > 0) {
        await db
          .delete(sessionMessages)
          .where(inArray(sessionMessages.sessionId, subthreadSessionIds));
        await db
          .delete(sessions)
          .where(inArray(sessions.id, subthreadSessionIds));
      }
      if (subthreadRows.length > 0) {
        await db
          .delete(rooms)
          .where(inArray(rooms.id, subthreadRows.map((row) => row.id)));
      }
      if (remainingSessionIds.length > 0) {
        await db
          .delete(sessionMessages)
          .where(inArray(sessionMessages.sessionId, remainingSessionIds));
        await db
          .delete(sessions)
          .where(inArray(sessions.id, remainingSessionIds));
      }
      await db.delete(rooms).where(inArray(rooms.id, createdRoomIds));
    }
    if (agentActorId) {
      await db.delete(actors).where(eq(actors.id, agentActorId));
    }
    if (createdActorIds.length > 0) {
      await db.delete(actors).where(inArray(actors.id, createdActorIds));
    }
    if (agentId) await db.delete(agents).where(eq(agents.id, agentId));
    if (namespaceId) {
      await db.delete(namespaces).where(eq(namespaces.id, namespaceId));
    }
    if (createdUserIds.length > 0) {
      await db.delete(users).where(inArray(users.id, createdUserIds));
    }
  } finally {
    await db.end();
  }
});

describe("M233 canonical append classification", () => {
  test("persists additive mention/reply and explicit Agent causality", async () => {
    const alice = await createHuman("alice");
    const bob = await createHuman("bob");
    const carol = await createHuman("carol");
    const roomId = await createRoom({
      ownerId: alice.userId,
      createdBy: alice.actorId,
      humanActorIds: [alice.actorId, bob.actorId, carol.actorId],
    });
    const threadId = `room:${roomId}`;

    const aliceTurn = randomUUID();
    const aliceResult = await appendTranscriptMessages(
      threadId,
      alice.userId,
      "owner",
      [new HumanMessage("root")],
      {
        agentId,
        roomId,
        humanTurnId: aliceTurn,
        notificationContext: {
          mentionedHumanUserIds: [],
          causalHumanUserId: null,
          causalHumanTurnId: null,
        },
      },
    );
    const aliceMessageId = Number(aliceResult.insertedRows[0]?.id);

    const bobTurn = randomUUID();
    const bobResult = await appendTranscriptMessages(
      threadId,
      bob.userId,
      "owner",
      [
        buildForegroundUserHumanMessage({
          userText: "@alice reply",
          attachmentTextBlocks: [],
          multimodalImages: [],
          modelId: "test",
          replyToMessageId: aliceMessageId,
        }),
      ],
      {
        agentId,
        roomId,
        humanTurnId: bobTurn,
        notificationContext: {
          mentionedHumanUserIds: [alice.userId],
          causalHumanUserId: null,
          causalHumanTurnId: null,
        },
      },
    );
    const bobMessageId = Number(bobResult.insertedRows[0]?.id);
    const bobFacts = await db
      .select({
        recipientId: sessionMessageDirectedRecipients.recipientId,
        reason: sessionMessageDirectedRecipients.reason,
      })
      .from(sessionMessageDirectedRecipients)
      .where(
        eq(sessionMessageDirectedRecipients.messageId, bobMessageId),
      );
    expect(
      bobFacts
        .filter((fact) => fact.recipientId === alice.userId)
        .map((fact) => fact.reason)
        .sort(),
    ).toEqual(["explicit_reply", "mention"]);

    const assistant = await appendTranscriptMessages(
      threadId,
      alice.userId,
      "owner",
      [new AIMessage("answer")],
      {
        agentId,
        roomId,
        humanTurnId: bobTurn,
        notificationContext: {
          mentionedHumanUserIds: [],
          causalHumanUserId: bob.userId,
          causalHumanTurnId: bobTurn,
        },
      },
    );
    const assistantMessageId = Number(assistant.insertedRows[0]?.id);
    expect(
      await db
        .select({ reason: sessionMessageDirectedRecipients.reason })
        .from(sessionMessageDirectedRecipients)
        .where(
          and(
            eq(
              sessionMessageDirectedRecipients.messageId,
              assistantMessageId,
            ),
            eq(sessionMessageDirectedRecipients.recipientId, bob.userId),
          ),
        ),
    ).toEqual([{ reason: "agent_response" }]);
  });

  test("uses exactly two Actors for direct classification and keeps reasons additive", async () => {
    const alice = await createHuman("direct-alice");
    const twoActorRoomId = await createRoom({
      ownerId: alice.userId,
      createdBy: alice.actorId,
      humanActorIds: [alice.actorId],
    });
    const turnId = randomUUID();
    await appendTranscriptMessages(
      `room:${twoActorRoomId}`,
      alice.userId,
      "owner",
      [new HumanMessage("direct boundary")],
      {
        agentId,
        roomId: twoActorRoomId,
        humanTurnId: turnId,
        notificationContext: {
          mentionedHumanUserIds: [],
          causalHumanUserId: null,
          causalHumanTurnId: null,
        },
      },
    );
    const assistant = await appendTranscriptMessages(
      `room:${twoActorRoomId}`,
      alice.userId,
      "owner",
      [new AIMessage("direct answer")],
      {
        agentId,
        roomId: twoActorRoomId,
        humanTurnId: turnId,
        notificationContext: {
          mentionedHumanUserIds: [],
          causalHumanUserId: alice.userId,
          causalHumanTurnId: turnId,
        },
      },
    );
    const assistantMessageId = Number(assistant.insertedRows[0]?.id);
    expect(
      (
        await db
          .select({ reason: sessionMessageDirectedRecipients.reason })
          .from(sessionMessageDirectedRecipients)
          .where(
            and(
              eq(
                sessionMessageDirectedRecipients.messageId,
                assistantMessageId,
              ),
              eq(
                sessionMessageDirectedRecipients.recipientId,
                alice.userId,
              ),
            ),
          )
      )
        .map((row) => row.reason)
        .sort(),
    ).toEqual(["agent_response", "direct_room"]);

    const bob = await createHuman("ambient-bob");
    const threeActorRoomId = await createRoom({
      ownerId: alice.userId,
      createdBy: alice.actorId,
      humanActorIds: [alice.actorId, bob.actorId],
    });
    const threeActorTurn = randomUUID();
    await appendTranscriptMessages(
      `room:${threeActorRoomId}`,
      alice.userId,
      "owner",
      [new HumanMessage("three actor boundary")],
      {
        agentId,
        roomId: threeActorRoomId,
        humanTurnId: threeActorTurn,
        notificationContext: {
          mentionedHumanUserIds: [],
          causalHumanUserId: null,
          causalHumanTurnId: null,
        },
      },
    );
    const threeActorAssistant = await appendTranscriptMessages(
      `room:${threeActorRoomId}`,
      alice.userId,
      "owner",
      [new AIMessage("three actor answer")],
      {
        agentId,
        roomId: threeActorRoomId,
        humanTurnId: threeActorTurn,
        notificationContext: {
          mentionedHumanUserIds: [],
          causalHumanUserId: alice.userId,
          causalHumanTurnId: threeActorTurn,
        },
      },
    );
    const threeActorMessageId = Number(
      threeActorAssistant.insertedRows[0]?.id,
    );
    expect(
      await db
        .select({ recipientId: sessionMessageDirectedRecipients.recipientId })
        .from(sessionMessageDirectedRecipients)
        .where(
          and(
            eq(
              sessionMessageDirectedRecipients.messageId,
              threeActorMessageId,
            ),
            eq(
              sessionMessageDirectedRecipients.reason,
              "direct_room",
            ),
          ),
        ),
    ).toHaveLength(0);
  });

  test("rejects half-null, unknown, mismatched, cross-Room, and non-assistant causal provenance", async () => {
    const alice = await createHuman("causal-alice");
    const bob = await createHuman("causal-bob");
    const roomId = await createRoom({
      ownerId: alice.userId,
      createdBy: alice.actorId,
      humanActorIds: [alice.actorId, bob.actorId],
    });
    const otherRoomId = await createRoom({
      ownerId: bob.userId,
      createdBy: bob.actorId,
      humanActorIds: [bob.actorId],
    });
    const aliceTurn = randomUUID();
    await appendTranscriptMessages(
      `room:${roomId}`,
      alice.userId,
      "owner",
      [new HumanMessage("causal source")],
      {
        agentId,
        roomId,
        humanTurnId: aliceTurn,
        notificationContext: {
          mentionedHumanUserIds: [],
          causalHumanUserId: null,
          causalHumanTurnId: null,
        },
      },
    );
    const otherTurn = randomUUID();
    await appendTranscriptMessages(
      `room:${otherRoomId}`,
      bob.userId,
      "owner",
      [new HumanMessage("other room source")],
      {
        agentId,
        roomId: otherRoomId,
        humanTurnId: otherTurn,
        notificationContext: {
          mentionedHumanUserIds: [],
          causalHumanUserId: null,
          causalHumanTurnId: null,
        },
      },
    );

    const invalidPairs = [
      {
        label: "half-null",
        causalHumanUserId: alice.userId,
        causalHumanTurnId: null,
        error: "half_null_causal_pair",
      },
      {
        label: "unknown",
        causalHumanUserId: alice.userId,
        causalHumanTurnId: randomUUID(),
        error: "invalid_causal_pair",
      },
      {
        label: "mismatched",
        causalHumanUserId: bob.userId,
        causalHumanTurnId: aliceTurn,
        error: "invalid_causal_pair",
      },
      {
        label: "cross-room",
        causalHumanUserId: bob.userId,
        causalHumanTurnId: otherTurn,
        error: "invalid_causal_pair",
      },
    ] as const;
    for (const invalid of invalidPairs) {
      expect(
        appendTranscriptMessages(
          `room:${roomId}`,
          alice.userId,
          "owner",
          [new AIMessage(`invalid-${invalid.label}`)],
          {
            agentId,
            roomId,
            humanTurnId: aliceTurn,
            notificationContext: {
              mentionedHumanUserIds: [],
              causalHumanUserId: invalid.causalHumanUserId,
              causalHumanTurnId: invalid.causalHumanTurnId,
            },
          },
        ),
      ).rejects.toThrow(invalid.error);
    }

    expect(
      appendTranscriptMessages(
        `room:${roomId}`,
        alice.userId,
        "owner",
        [new HumanMessage("invalid non-assistant causal pair")],
        {
          agentId,
          roomId,
          humanTurnId: randomUUID(),
          notificationContext: {
            mentionedHumanUserIds: [],
            causalHumanUserId: alice.userId,
            causalHumanTurnId: aliceTurn,
          },
        },
      ),
    ).rejects.toThrow("causal_pair_on_non_assistant");

    expect(
      await db
        .select({ id: sessionMessages.id })
        .from(sessionMessages)
        .innerJoin(sessions, eq(sessionMessages.sessionId, sessions.id))
        .where(
          and(
            eq(sessions.roomId, roomId),
            inArray(sessionMessages.content, [
              "invalid-half-null",
              "invalid-unknown",
              "invalid-mismatched",
              "invalid-cross-room",
              "invalid non-assistant causal pair",
            ]),
          ),
        ),
    ).toHaveLength(0);
  });

  test("classification failure rolls back the inserted transcript row", async () => {
    const alice = await createHuman("rollback-alice");
    const bob = await createHuman("rollback-bob");
    const roomId = await createRoom({
      ownerId: alice.userId,
      createdBy: alice.actorId,
      humanActorIds: [alice.actorId, bob.actorId],
    });
    const content = `rollback-${randomUUID()}`;

    expect(
      appendTranscriptMessages(
        `room:${roomId}`,
        alice.userId,
        "owner",
        [new HumanMessage(content)],
        {
          agentId,
          roomId,
          humanTurnId: randomUUID(),
          notificationContext: {
            mentionedHumanUserIds: [randomUUID()],
            causalHumanUserId: null,
            causalHumanTurnId: null,
          },
        },
      ),
    ).rejects.toThrow("invalid_mention_recipient");

    expect(
      await db
        .select({ id: sessionMessages.id })
        .from(sessionMessages)
        .innerJoin(sessions, eq(sessionMessages.sessionId, sessions.id))
        .where(
          and(
            eq(sessions.roomId, roomId),
            eq(sessionMessages.content, content),
          ),
        ),
    ).toHaveLength(0);
  });

  test("Subthread participation keeps the first qualifying boundary", async () => {
    const alice = await createHuman("thread-alice");
    const bob = await createHuman("thread-bob");
    const carol = await createHuman("thread-carol");
    const parentRoomId = await createRoom({
      ownerId: alice.userId,
      createdBy: alice.actorId,
      humanActorIds: [alice.actorId, bob.actorId, carol.actorId],
    });
    const [parentSession] = await db
      .insert(sessions)
      .values({
        threadId: `room:${parentRoomId}`,
        ownerId: alice.userId,
        personaId: "owner",
        agentId,
        roomId: parentRoomId,
        channel: "tui",
      })
      .returning({ id: sessions.id });
    if (!parentSession) throw new Error("failed to create parent session");
    const [anchor] = await db
      .insert(sessionMessages)
      .values({
        sessionId: parentSession.id,
        role: "user",
        content: "anchor",
      })
      .returning({ id: sessionMessages.id });
    if (!anchor) throw new Error("failed to create anchor");
    const subthreadRoomId = await createRoom({
      ownerId: alice.userId,
      createdBy: alice.actorId,
      humanActorIds: [alice.actorId, bob.actorId, carol.actorId],
      kind: "subthread",
      parentRoomId,
      threadRootMessageId: anchor.id,
    });

    const first = await appendTranscriptMessages(
      `room:${subthreadRoomId}`,
      bob.userId,
      "owner",
      [new HumanMessage("@carol first")],
      {
        agentId,
        roomId: subthreadRoomId,
        subthreadRoomId,
        humanTurnId: randomUUID(),
        notificationContext: {
          mentionedHumanUserIds: [carol.userId],
          causalHumanUserId: null,
          causalHumanTurnId: null,
        },
      },
    );
    const firstMessageId = Number(first.insertedRows[0]?.id);
    await appendTranscriptMessages(
      `room:${subthreadRoomId}`,
      alice.userId,
      "owner",
      [new HumanMessage("@carol later")],
      {
        agentId,
        roomId: subthreadRoomId,
        subthreadRoomId,
        humanTurnId: randomUUID(),
        notificationContext: {
          mentionedHumanUserIds: [carol.userId],
          causalHumanUserId: null,
          causalHumanTurnId: null,
        },
      },
    );

    const [carolParticipation] = await db
      .select({
        fromMessageId: subthreadNotificationParticipants.fromMessageId,
        reason: subthreadNotificationParticipants.reason,
      })
      .from(subthreadNotificationParticipants)
      .where(
        and(
          eq(
            subthreadNotificationParticipants.subthreadRoomId,
            subthreadRoomId,
          ),
          eq(subthreadNotificationParticipants.userId, carol.userId),
        ),
      );
    expect(carolParticipation).toEqual({
      fromMessageId: firstMessageId,
      reason: "mention",
    });
  });
});
