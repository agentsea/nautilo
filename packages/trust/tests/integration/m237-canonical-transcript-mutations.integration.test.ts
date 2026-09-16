/**
 * M237 — canonical transcript mutation primitives against disposable Postgres.
 *
 * This suite proves the protected hook seams share the exact physical product
 * mutation used by legacy append/delete. It is integration-only: never import
 * it from a unit runner.
 */
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { config } from "dotenv";

config({ path: resolve(import.meta.dirname, "../../../.env") });

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  actors,
  agents,
  createDirectDb,
  ensureDatabase,
  eq,
  namespaces,
  roomMembers,
  rooms,
  sessionMessages,
  sessions,
  sql,
  users,
} from "@nautilo/db";
import { bootstrapTestDbInstance } from "@nautilo/db/testing";
import {
  appendCanonicalTranscriptRowsToExistingSessionInTx,
  deleteMessageHardInTx,
  type CanonicalTranscriptAppendRow,
} from "../../src/canonical-transcript-mutations";

let db: ReturnType<typeof createDirectDb>;

beforeAll(async () => {
  bootstrapTestDbInstance();
  await ensureDatabase();
  db = createDirectDb(3);
});

afterAll(async () => {
  await db.end();
});

interface Fixture {
  userId: string;
  actorId: string;
  agentId: string;
  namespaceId: string;
  roomId: string;
  sessionId: string;
}

async function createFixture(): Promise<Fixture> {
  const suffix = randomUUID();
  const [user] = await db
    .insert(users)
    .values({
      name: "M237 canonical mutation",
      email: `m237-${suffix}@test.invalid`,
      handle: `m237-${suffix.replaceAll("-", "")}`,
    })
    .returning({ id: users.id });
  if (!user) throw new Error("fixture user");

  const [actor] = await db
    .insert(actors)
    .values({
      ownerId: user.id,
      displayName: "M237 Human",
      kind: "user",
    })
    .returning({ id: actors.id });
  if (!actor) throw new Error("fixture actor");

  const [namespace] = await db
    .insert(namespaces)
    .values({ scope: "private", label: `m237-${suffix}` })
    .returning({ id: namespaces.id });
  if (!namespace) throw new Error("fixture namespace");

  const [room] = await db
    .insert(rooms)
    .values({
      ownerId: user.id,
      type: "private",
      label: "M237 canonical mutation",
      graphThreadId: `room:${suffix}`,
      namespaceId: namespace.id,
      humanActorIds: [actor.id],
    })
    .returning({ id: rooms.id });
  if (!room) throw new Error("fixture room");
  await db.insert(roomMembers).values({
    roomId: room.id,
    actorId: actor.id,
    roomRole: "admin",
  });

  const [agent] = await db
    .insert(agents)
    .values({ handle: `m237-${suffix}` })
    .returning({ id: agents.id });
  if (!agent) throw new Error("fixture agent");

  const [session] = await db
    .insert(sessions)
    .values({
      threadId: `room:${room.id}`,
      ownerId: user.id,
      personaId: "owner",
      agentId: agent.id,
      roomId: room.id,
      channel: "tui",
      messageCount: 1,
    })
    .returning({ id: sessions.id });
  if (!session) throw new Error("fixture session");

  return {
    userId: user.id,
    actorId: actor.id,
    agentId: agent.id,
    namespaceId: namespace.id,
    roomId: room.id,
    sessionId: session.id,
  };
}

async function cleanup(fixture: Fixture): Promise<void> {
  await db
    .delete(sessionMessages)
    .where(eq(sessionMessages.sessionId, fixture.sessionId));
  await db.delete(sessions).where(eq(sessions.id, fixture.sessionId));
  await db.delete(agents).where(eq(agents.id, fixture.agentId));
  await db
    .delete(roomMembers)
    .where(eq(roomMembers.roomId, fixture.roomId));
  await db.delete(rooms).where(eq(rooms.id, fixture.roomId));
  await db
    .delete(namespaces)
    .where(eq(namespaces.id, fixture.namespaceId));
  await db.delete(actors).where(eq(actors.id, fixture.actorId));
  await db.delete(users).where(eq(users.id, fixture.userId));
}

function appendRow(
  replyToMessageId: number,
): CanonicalTranscriptAppendRow {
  return {
    role: "user",
    content: "protected canonical content",
    toolCalls: null,
    toolName: null,
    fingerprint: `m237-fingerprint-${randomUUID()}`,
    humanTurnId: `m237-turn-${randomUUID()}`,
    transcriptOrigin: "main",
    parentThreadId: null,
    scopeId: null,
    metadata: { source: "m237-integration" },
    subthreadRoomId: null,
    replyToMessageId,
  };
}

describe("M237 canonical transcript mutation primitives", () => {
  test("commits each notification-eligible canonical message with one content-free push candidate", async () => {
    const fixture = await createFixture();
    try {
      const result = await db.transaction((tx) =>
        appendCanonicalTranscriptRowsToExistingSessionInTx(tx, {
          sessionId: fixture.sessionId,
          rows: [{
            ...appendRow(0),
            role: "assistant",
            content: "A durable notification candidate must accompany me.",
            humanTurnId: null,
            replyToMessageId: null,
          }],
        })
      );
      const messageId = Number(result.insertedRows[0]?.id);
      expect(messageId).toBeGreaterThan(0);

      const candidates = await db.execute<{
        message_id: number;
        state: string;
      }>(sql`
        SELECT message_id, state
          FROM push_message_candidates
         WHERE message_id = ${messageId}
      `);
      expect([...candidates]).toEqual([
        { message_id: messageId, state: "pending" },
      ]);

      const columns = await db.execute<{ column_name: string }>(sql`
        SELECT column_name
          FROM information_schema.columns
         WHERE table_schema = 'public'
           AND table_name = 'push_message_candidates'
         ORDER BY ordinal_position
      `);
      expect(columns.map((column) => column.column_name)).toEqual([
        "message_id",
        "state",
        "created_at",
        "claim_owner",
        "claim_expires_at",
        "terminal_at",
      ]);
    } finally {
      await cleanup(fixture);
    }
  });

  test("append hook observes allocated ID before the complete row is inserted", async () => {
    const fixture = await createFixture();
    try {
      const [replyTarget] = await db
        .insert(sessionMessages)
        .values({
          sessionId: fixture.sessionId,
          role: "user",
          content: "reply target",
        })
        .returning({ id: sessionMessages.id });
      if (!replyTarget) throw new Error("reply target");
      const row = appendRow(replyTarget.id);
      const hookIds: number[] = [];

      const result = await db.transaction((tx) =>
        appendCanonicalTranscriptRowsToExistingSessionInTx(
          tx,
          {
            sessionId: fixture.sessionId,
            rows: [row],
          },
          {
            afterMessageIdAllocated: async ({ tx: hookTx, messageId }) => {
              const existing = await hookTx
                .select({ id: sessionMessages.id })
                .from(sessionMessages)
                .where(eq(sessionMessages.id, messageId));
              expect(existing).toHaveLength(0);
              hookIds.push(messageId);
              return `receipt:${messageId}`;
            },
          },
        ),
      );

      expect(result.insertedCount).toBe(1);
      expect(hookIds).toEqual([
        Number(result.insertedRows[0]?.id),
      ]);
      expect(result.insertedRows[0]?.hookResult).toBe(
        `receipt:${result.insertedRows[0]?.id}`,
      );

      const [persisted] = await db
        .select({
          id: sessionMessages.id,
          content: sessionMessages.content,
          fingerprint: sessionMessages.fingerprint,
          humanTurnId: sessionMessages.humanTurnId,
          metadata: sessionMessages.metadata,
          replyToMessageId: sessionMessages.replyToMessageId,
        })
        .from(sessionMessages)
        .where(eq(sessionMessages.id, Number(result.insertedRows[0]?.id)));
      expect(persisted).toMatchObject({
        content: row.content,
        fingerprint: row.fingerprint,
        humanTurnId: row.humanTurnId,
        metadata: row.metadata,
        replyToMessageId: replyTarget.id,
      });

      let replayHooked = false;
      const replay = await db.transaction((tx) =>
        appendCanonicalTranscriptRowsToExistingSessionInTx(
          tx,
          {
            sessionId: fixture.sessionId,
            rows: [row],
          },
          {
            afterMessageIdAllocated: async () => {
              replayHooked = true;
            },
          },
        ),
      );
      expect(replay.insertedCount).toBe(0);
      expect(replayHooked).toBe(false);
    } finally {
      await cleanup(fixture);
    }
  });

  test("delete hook sees the physical row gone and the Session count updated", async () => {
    const fixture = await createFixture();
    try {
      const [message] = await db
        .insert(sessionMessages)
        .values({
          sessionId: fixture.sessionId,
          role: "assistant",
          content: "delete me",
          readAt: null,
        })
        .returning({ id: sessionMessages.id });
      if (!message) throw new Error("message");

      const result = await db.transaction((tx) =>
        deleteMessageHardInTx(
          tx,
          message.id,
          {
            afterDeleteEffects: async ({ tx: hookTx, effects }) => {
              const remaining = await hookTx
                .select({ id: sessionMessages.id })
                .from(sessionMessages)
                .where(eq(sessionMessages.id, message.id));
              const [session] = await hookTx
                .select({ messageCount: sessions.messageCount })
                .from(sessions)
                .where(eq(sessions.id, fixture.sessionId));
              expect(remaining).toHaveLength(0);
              expect(session?.messageCount).toBe(0);
              return effects.wasUnread ? "unread-receipt" : "read-receipt";
            },
          },
        ),
      );

      expect(result).toMatchObject({
        roomId: fixture.roomId,
        wasUnread: true,
        hookResult: "unread-receipt",
      });
    } finally {
      await cleanup(fixture);
    }
  });

  test("serializes concurrent append and delete before Session and root summary effects", async () => {
    const fixture = await createFixture();
    const subthreadRoomId = randomUUID();
    const subthreadSessionId = randomUUID();
    try {
      const [root] = await db
        .insert(sessionMessages)
        .values({
          sessionId: fixture.sessionId,
          role: "user",
          content: "Subthread root",
        })
        .returning({ id: sessionMessages.id });
      if (!root) throw new Error("Subthread root");
      await db.insert(rooms).values({
        id: subthreadRoomId,
        ownerId: fixture.userId,
        type: "private",
        label: "M237 concurrent Subthread",
        graphThreadId: `room:${subthreadRoomId}`,
        namespaceId: fixture.namespaceId,
        humanActorIds: [fixture.actorId],
        kind: "subthread",
        parentRoomId: fixture.roomId,
        threadRootMessageId: root.id,
      });
      await db.insert(sessions).values({
        id: subthreadSessionId,
        threadId: `room:${subthreadRoomId}`,
        ownerId: fixture.userId,
        personaId: "owner",
        agentId: fixture.agentId,
        roomId: subthreadRoomId,
        channel: "tui",
        messageCount: 1,
      });
      const [oldReply] = await db
        .insert(sessionMessages)
        .values({
          sessionId: subthreadSessionId,
          role: "assistant",
          content: "old reply",
          subthreadRoomId,
        })
        .returning({ id: sessionMessages.id });
      if (!oldReply) throw new Error("Old reply");
      await db
        .update(sessionMessages)
        .set({
          replyCount: 1,
          lastReplyAt: new Date(),
        })
        .where(eq(sessionMessages.id, root.id));

      const newReply: CanonicalTranscriptAppendRow = {
        role: "assistant",
        content: "new reply",
        toolCalls: null,
        toolName: null,
        fingerprint: `race-${randomUUID()}`,
        humanTurnId: null,
        transcriptOrigin: "main",
        parentThreadId: null,
        scopeId: null,
        metadata: null,
        subthreadRoomId,
        replyToMessageId: null,
      };
      await Promise.all([
        db.transaction((tx) =>
          appendCanonicalTranscriptRowsToExistingSessionInTx(tx, {
            sessionId: subthreadSessionId,
            rows: [newReply],
          })
        ),
        db.transaction((tx) =>
          deleteMessageHardInTx(tx, oldReply.id)
        ),
      ]);

      const remaining = await db
        .select({
          id: sessionMessages.id,
          createdAt: sessionMessages.createdAt,
        })
        .from(sessionMessages)
        .where(eq(sessionMessages.sessionId, subthreadSessionId));
      const [session] = await db
        .select({ messageCount: sessions.messageCount })
        .from(sessions)
        .where(eq(sessions.id, subthreadSessionId));
      const [summary] = await db
        .select({
          replyCount: sessionMessages.replyCount,
          lastReplyAt: sessionMessages.lastReplyAt,
        })
        .from(sessionMessages)
        .where(eq(sessionMessages.id, root.id));
      expect(remaining).toHaveLength(1);
      expect(session?.messageCount).toBe(1);
      expect(summary?.replyCount).toBe(1);
      expect(summary?.lastReplyAt?.getTime()).toBe(
        remaining[0]?.createdAt.getTime(),
      );
    } finally {
      await db
        .delete(sessionMessages)
        .where(eq(sessionMessages.sessionId, subthreadSessionId));
      await db.delete(sessions).where(eq(sessions.id, subthreadSessionId));
      await db.delete(rooms).where(eq(rooms.id, subthreadRoomId));
      await cleanup(fixture);
    }
  });
});
