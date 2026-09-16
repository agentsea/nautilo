/**
 * D426 Phase 2 §2.1 — `subthread_user_focus` durable Thread Responder
 * substrate: schema invariants (composite PK, CHECK constraints, FK
 * cascade + SET NULL). Live Postgres; run against a scratch instance.
 */
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { config } from "dotenv";

config({ path: resolve(import.meta.dirname, "../../../.env") });

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  actors,
  agents,
  and,
  createDirectDb,
  ensureDatabase,
  eq,
  namespaces,
  rooms,
  roomMembers,
  sessionMessages,
  sessions,
  sql,
  subthreadUserFocus,
  users,
} from "@nautilo/db";
import { bootstrapTestDbInstance } from "@nautilo/db/testing";

let db: ReturnType<typeof createDirectDb>;

beforeAll(async () => {
  bootstrapTestDbInstance();
  await ensureDatabase();
  db = createDirectDb(5);
});

afterAll(async () => {
  await db.end();
});

async function createUser(label: string): Promise<string> {
  const ts = Date.now();
  const [u] = await db
    .insert(users)
    .values({
      name: label,
      email: `${label}-${ts}-${randomUUID()}@d426p2.test`,
      handle: `${label}${ts}${Math.floor(Math.random() * 1e6)}`,
    })
    .returning({ id: users.id });
  if (!u) throw new Error("user");
  return u.id;
}

async function createHumanActor(ownerId: string, label: string): Promise<string> {
  const [a] = await db
    .insert(actors)
    .values({ ownerId, displayName: label, kind: "user" })
    .returning({ id: actors.id });
  if (!a) throw new Error("actor");
  return a.id;
}

async function createAgentActor(ownerId: string, label: string): Promise<{ actorId: string; agentId: string }> {
  const [ag] = await db
    .insert(agents)
    .values({ handle: `ag-${label}-${randomUUID()}` })
    .returning({ id: agents.id });
  if (!ag) throw new Error("agent");
  const [a] = await db
    .insert(actors)
    .values({ ownerId, displayName: label, kind: "agent", agentId: ag.id })
    .returning({ id: actors.id });
  if (!a) throw new Error("agent-actor");
  return { actorId: a.id, agentId: ag.id };
}

interface Fixture {
  userId: string;
  userActorId: string;
  botActorId: string;
  botAgentId: string;
  namespaceId: string;
  parentRoomId: string;
  subthreadRoomId: string;
  parentSessionId: string;
  anchorMessageId: number;
}

async function makeFixture(label: string, opts?: { botMode?: "active" | "mention_only" | "observe" }): Promise<Fixture> {
  const userId = await createUser(`d426p2${label}`);
  const userActorId = await createHumanActor(userId, label.toUpperCase());
  const bot = await createAgentActor(userId, `BOT-${label}`);
  const [ns] = await db
    .insert(namespaces)
    .values({ scope: "private", label: `ns-${randomUUID()}` })
    .returning({ id: namespaces.id });
  if (!ns) throw new Error("ns");

  const parentRoomId = randomUUID();
  await db.insert(rooms).values({
    id: parentRoomId,
    ownerId: userId,
    type: "private",
    label: `parent-${label}`,
    graphThreadId: `room:${parentRoomId}`,
    namespaceId: ns.id,
    humanActorIds: [userActorId],
    createdBy: userActorId,
    kind: "group",
  });
  await db.insert(roomMembers).values({ roomId: parentRoomId, actorId: userActorId, roomRole: "admin" });
  await db.insert(roomMembers).values({
    roomId: parentRoomId,
    actorId: bot.actorId,
    roomRole: "member",
    agentResponseMode: opts?.botMode ?? "mention_only",
  });

  const [parentSess] = await db
    .insert(sessions)
    .values({
      threadId: `room:${parentRoomId}`,
      ownerId: userId,
      personaId: "owner",
      agentId: bot.agentId,
      roomId: parentRoomId,
      channel: "tui",
    })
    .returning({ id: sessions.id });
  if (!parentSess) throw new Error("parentSess");
  const [anchor] = await db
    .insert(sessionMessages)
    .values({ sessionId: parentSess.id, role: "user", content: "anchor" })
    .returning({ id: sessionMessages.id });
  if (!anchor) throw new Error("anchor");

  const subthreadRoomId = randomUUID();
  await db.insert(rooms).values({
    id: subthreadRoomId,
    ownerId: userId,
    type: "private",
    label: `sub-${label}`,
    graphThreadId: `room:${subthreadRoomId}`,
    namespaceId: ns.id,
    humanActorIds: [userActorId],
    createdBy: userActorId,
    kind: "subthread",
    parentRoomId,
    threadRootMessageId: anchor.id,
  });
  await db.insert(roomMembers).values({ roomId: subthreadRoomId, actorId: userActorId, roomRole: "admin" });
  await db.insert(roomMembers).values({
    roomId: subthreadRoomId,
    actorId: bot.actorId,
    roomRole: "member",
    agentResponseMode: opts?.botMode ?? "mention_only",
  });

  return {
    userId,
    userActorId,
    botActorId: bot.actorId,
    botAgentId: bot.agentId,
    namespaceId: ns.id,
    parentRoomId,
    subthreadRoomId,
    parentSessionId: parentSess.id,
    anchorMessageId: anchor.id,
  };
}

async function cleanup(f: Fixture): Promise<void> {
  if (f.subthreadRoomId !== "__swept__") {
    // A failed assertion in a test that creates a child session must not mask
    // the original failure with sessions_room_id_rooms_id_fk during teardown.
    const childSessions = await db
      .select({ id: sessions.id })
      .from(sessions)
      .where(eq(sessions.roomId, f.subthreadRoomId));
    for (const childSession of childSessions) {
      await db.delete(sessionMessages).where(eq(sessionMessages.sessionId, childSession.id));
    }
    await db.delete(sessions).where(eq(sessions.roomId, f.subthreadRoomId));
    await db.delete(subthreadUserFocus).where(eq(subthreadUserFocus.subthreadRoomId, f.subthreadRoomId));
    await db.delete(roomMembers).where(eq(roomMembers.roomId, f.subthreadRoomId));
    await db.delete(rooms).where(eq(rooms.id, f.subthreadRoomId));
  }
  await db.delete(sessionMessages).where(eq(sessionMessages.sessionId, f.parentSessionId));
  await db.delete(sessions).where(eq(sessions.id, f.parentSessionId));
  await db.delete(roomMembers).where(eq(roomMembers.roomId, f.parentRoomId));
  await db.delete(rooms).where(eq(rooms.id, f.parentRoomId));
  await db.delete(namespaces).where(eq(namespaces.id, f.namespaceId));
  await db.delete(actors).where(eq(actors.id, f.botActorId));
  await db.delete(agents).where(eq(agents.id, f.botAgentId));
  await db.delete(actors).where(eq(actors.id, f.userActorId));
  await db.delete(users).where(eq(users.id, f.userId));
}

function expectPgError(fn: () => PromiseLike<unknown>, pattern: RegExp): Promise<void> {
  return expect(Promise.resolve(fn())).rejects.toThrow(pattern) as unknown as Promise<void>;
}

describe("D426 Phase 2 — subthread_user_focus schema invariants", () => {
  test("exposes the expected D426 Phase 2 columns", async () => {
    const cols = await db.execute(sql`
      SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'subthread_user_focus'
      ORDER BY ordinal_position
    `);
    const names = new Set((cols as unknown as { column_name: string }[]).map((r) => r.column_name));
    for (const c of [
      "subthread_room_id",
      "user_actor_id",
      "bot_actor_id",
      "status",
      "source",
      "established_message_id",
      "established_at",
      "revision",
      "invalidated_reason",
      "updated_at",
    ]) {
      expect(names.has(c)).toBe(true);
    }
  });

  test("composite PK enforces one responder per (subthread, human)", async () => {
    const f = await makeFixture("pk");
    try {
      await db.insert(subthreadUserFocus).values({
        subthreadRoomId: f.subthreadRoomId,
        userActorId: f.userActorId,
        botActorId: f.botActorId,
        status: "active",
        source: "ui",
        revision: 1,
      });
      await expectPgError(
        async () => {
          await db.insert(subthreadUserFocus).values({
            subthreadRoomId: f.subthreadRoomId,
            userActorId: f.userActorId,
            botActorId: f.botActorId,
            status: "active",
            source: "mention",
            revision: 1,
          });
        },
        /duplicate key|23505|Failed query/i,
      );
    } finally {
      await cleanup(f);
    }
  });

  test("status CHECK rejects unknown values", async () => {
    const f = await makeFixture("status");
    try {
      await expectPgError(
        async () => {
          await db.insert(subthreadUserFocus).values({
            subthreadRoomId: f.subthreadRoomId,
            userActorId: f.userActorId,
            botActorId: f.botActorId,
            status: "bogus" as never,
            revision: 1,
          });
        },
        /subthread_user_focus_status_check|check|constraint|23514|Failed query/i,
      );
    } finally {
      await cleanup(f);
    }
  });

  test("source CHECK rejects unknown non-NULL values but allows NULL", async () => {
    const f = await makeFixture("source");
    try {
      await expectPgError(
        async () => {
          await db.insert(subthreadUserFocus).values({
            subthreadRoomId: f.subthreadRoomId,
            userActorId: f.userActorId,
            botActorId: f.botActorId,
            status: "active",
            source: "bogus" as never,
            revision: 1,
          });
        },
        /subthread_user_focus_source_check|check|constraint|23514|Failed query/i,
      );
      // NULL source is allowed.
      const [row] = await db
        .insert(subthreadUserFocus)
        .values({
          subthreadRoomId: f.subthreadRoomId,
          userActorId: f.userActorId,
          botActorId: f.botActorId,
          status: "cleared",
          source: null,
          revision: 1,
        })
        .returning({ id: subthreadUserFocus.subthreadRoomId });
      expect(row).toBeDefined();
    } finally {
      await cleanup(f);
    }
  });

  test("revision defaults to 0 and status defaults to active", async () => {
    const f = await makeFixture("defaults");
    try {
      const [row] = await db
        .insert(subthreadUserFocus)
        .values({
          subthreadRoomId: f.subthreadRoomId,
          userActorId: f.userActorId,
          botActorId: f.botActorId,
          source: "ui",
        })
        .returning({
          status: subthreadUserFocus.status,
          revision: subthreadUserFocus.revision,
        });
      expect(row?.status).toBe("active");
      expect(row?.revision).toBe(0);
    } finally {
      await cleanup(f);
    }
  });

  test("deleting the subthread room cascades its responder rows", async () => {
    const f = await makeFixture("cascade");
    const subId = f.subthreadRoomId;
    try {
      await db.insert(subthreadUserFocus).values({
        subthreadRoomId: subId,
        userActorId: f.userActorId,
        botActorId: f.botActorId,
        status: "active",
        source: "ui",
        revision: 1,
      });
      await db.delete(roomMembers).where(eq(roomMembers.roomId, subId));
      await db.delete(rooms).where(eq(rooms.id, subId));
      f.subthreadRoomId = "__swept__"; // signal cleanup to skip subthread deletes
      const left = await db
        .select()
        .from(subthreadUserFocus)
        .where(eq(subthreadUserFocus.subthreadRoomId, subId));
      expect(left.length).toBe(0);
    } finally {
      await cleanup(f);
    }
  });

  test("deleting the establishing message SET NULLs established_message_id (responder survives)", async () => {
    const f = await makeFixture("setnull");
    try {
      const [subSess] = await db
        .insert(sessions)
        .values({
          threadId: `room:${f.subthreadRoomId}`,
          ownerId: f.userId,
          personaId: "owner",
          agentId: f.botAgentId,
          roomId: f.subthreadRoomId,
          channel: "tui",
        })
        .returning({ id: sessions.id });
      if (!subSess) throw new Error("subSess");
      const [establishing] = await db
        .insert(sessionMessages)
        .values({ sessionId: subSess.id, role: "user", content: "first", subthreadRoomId: f.subthreadRoomId })
        .returning({ id: sessionMessages.id });
      if (!establishing) throw new Error("establishing");

      await db.insert(subthreadUserFocus).values({
        subthreadRoomId: f.subthreadRoomId,
        userActorId: f.userActorId,
        botActorId: f.botActorId,
        status: "active",
        source: "affinity",
        establishedMessageId: establishing.id,
        revision: 1,
      });

      await db.delete(sessionMessages).where(eq(sessionMessages.id, establishing.id));

      const [row] = await db
        .select({ establishedMessageId: subthreadUserFocus.establishedMessageId, status: subthreadUserFocus.status })
        .from(subthreadUserFocus)
        .where(
          and(
            eq(subthreadUserFocus.subthreadRoomId, f.subthreadRoomId),
            eq(subthreadUserFocus.userActorId, f.userActorId),
          ),
        )
        .limit(1);
      expect(row?.establishedMessageId).toBeNull();
      expect(row?.status).toBe("active"); // responder survives
      await db.delete(sessionMessages).where(eq(sessionMessages.sessionId, subSess.id));
      await db.delete(sessions).where(eq(sessions.id, subSess.id));
    } finally {
      await cleanup(f);
    }
  });
});
