/**
 * D111 — migration 0046 subthread substrate (live Postgres).
 */
import { resolve } from "node:path";
import { config } from "dotenv";

config({ path: resolve(import.meta.dirname, "../../../../.env") });

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import {
  ensureDatabase,
  createDirectDb,
  users,
  actors,
  namespaces,
  rooms,
  roomMembers,
  sessions,
  sessionMessages,
  eq,
  sql,
} from "@nautilo/db";
import { bootstrapTestDbInstance } from "../../src/testing/instance-guard";

let db: ReturnType<typeof createDirectDb>;

beforeAll(async () => {
  bootstrapTestDbInstance();
  await ensureDatabase();
  db = createDirectDb(3);
});

afterAll(async () => {
  await db.end();
});

async function createUser(name: string): Promise<string> {
  const ts = Date.now();
  const [u] = await db
    .insert(users)
    .values({
      name,
      email: `${name}-${ts}@m0046.test`,
    })
    .returning({ id: users.id });
  if (!u) throw new Error("user");
  return u.id;
}

async function createHumanActor(ownerId: string, label: string): Promise<string> {
  const [a] = await db
    .insert(actors)
    .values({
      ownerId,
      displayName: label,
      kind: "user",
    })
    .returning({ id: actors.id });
  if (!a) throw new Error("actor");
  return a.id;
}

describe("migration 0046 — D111 subthread substrate", () => {
  test("rooms.kind defaults to private for new rows", async () => {
    const u = await createUser("m046-kind");
    const [ns] = await db
      .insert(namespaces)
      .values({ scope: "private", label: "ns-k" })
      .returning({ id: namespaces.id });
    if (!ns) throw new Error("ns");
    const [room] = await db
      .insert(rooms)
      .values({
        ownerId: u,
        type: "private",
        label: "r",
        graphThreadId: `gt-k-${Date.now()}`,
        namespaceId: ns.id,
        humanActorIds: [],
      })
      .returning({ id: rooms.id, kind: rooms.kind });
    if (!room) throw new Error("room");
    expect(room.kind).toBe("private");
    await db.delete(rooms).where(eq(rooms.id, room.id));
    await db.delete(namespaces).where(eq(namespaces.id, ns.id));
    await db.delete(users).where(eq(users.id, u));
  });

  test("rooms_subthread_invariant rejects subthread without both FKs", async () => {
    const u = await createUser("m046-inv");
    const [ns] = await db
      .insert(namespaces)
      .values({ scope: "private", label: "ns-i" })
      .returning({ id: namespaces.id });
    if (!ns) throw new Error("ns");
    const [parent] = await db
      .insert(rooms)
      .values({
        ownerId: u,
        type: "private",
        label: "parent",
        graphThreadId: `gt-p-${Date.now()}`,
        namespaceId: ns.id,
        humanActorIds: [],
      })
      .returning({ id: rooms.id });
    if (!parent) throw new Error("parent");
    let caught = false;
    try {
      await db.insert(rooms).values({
        ownerId: u,
        type: "private",
        label: "bad-sub",
        graphThreadId: `gt-bad-${Date.now()}`,
        namespaceId: ns.id,
        humanActorIds: [],
        kind: "subthread",
        parentRoomId: parent.id,
        threadRootMessageId: null,
      });
    } catch (e) {
      caught = true;
      expect(String(e)).toMatch(/Failed query|subthread_invariant|check constraint|violates check/i);
    }
    expect(caught).toBe(true);
    await db.delete(rooms).where(eq(rooms.id, parent.id));
    await db.delete(namespaces).where(eq(namespaces.id, ns.id));
    await db.delete(users).where(eq(users.id, u));
  });

  test("uq_rooms_thread_root rejects two subthreads on same anchor", async () => {
    const u = await createUser("m046-uq");
    const actor = await createHumanActor(u, "h");
    const [ns] = await db
      .insert(namespaces)
      .values({ scope: "private", label: "ns-uq" })
      .returning({ id: namespaces.id });
    if (!ns) throw new Error("ns");
    const [parent] = await db
      .insert(rooms)
      .values({
        ownerId: u,
        type: "private",
        label: "p",
        graphThreadId: `gt-uq-p-${Date.now()}`,
        namespaceId: ns.id,
        humanActorIds: [actor],
      })
      .returning({ id: rooms.id });
    if (!parent) throw new Error("parent");
    await db.insert(roomMembers).values({ roomId: parent.id, actorId: actor, roomRole: "admin" });
    const [sess] = await db
      .insert(sessions)
      .values({
        threadId: `th-uq-${Date.now()}`,
        ownerId: u,
        personaId: "owner",
        roomId: parent.id,
      })
      .returning({ id: sessions.id });
    if (!sess) throw new Error("sess");
    const [msg] = await db
      .insert(sessionMessages)
      .values({ sessionId: sess.id, role: "user", content: "hi" })
      .returning({ id: sessionMessages.id });
    if (!msg) throw new Error("msg");

    const [st1] = await db
      .insert(rooms)
      .values({
        ownerId: u,
        type: "private",
        label: "t1",
        graphThreadId: `gt-st1-${Date.now()}`,
        namespaceId: ns.id,
        humanActorIds: [actor],
        kind: "subthread",
        parentRoomId: parent.id,
        threadRootMessageId: msg.id,
      })
      .returning({ id: rooms.id });
    if (!st1) throw new Error("st1");
    await db.insert(roomMembers).values({ roomId: st1.id, actorId: actor, roomRole: "member" });

    let caughtDup = false;
    try {
      await db.insert(rooms).values({
        ownerId: u,
        type: "private",
        label: "t2",
        graphThreadId: `gt-st2-${Date.now()}`,
        namespaceId: ns.id,
        humanActorIds: [actor],
        kind: "subthread",
        parentRoomId: parent.id,
        threadRootMessageId: msg.id,
      });
    } catch (e) {
      caughtDup = true;
      expect(String(e)).toMatch(/Failed query|uq_rooms_thread_root|unique|23505|violates unique/i);
    }
    expect(caughtDup).toBe(true);

    await db.delete(rooms).where(eq(rooms.id, st1.id));
    await db.delete(sessionMessages).where(eq(sessionMessages.id, msg.id));
    await db.delete(sessions).where(eq(sessions.id, sess.id));
    await db.delete(roomMembers).where(eq(roomMembers.roomId, parent.id));
    await db.delete(rooms).where(eq(rooms.id, parent.id));
    await db.delete(namespaces).where(eq(namespaces.id, ns.id));
    await db.delete(actors).where(eq(actors.id, actor));
    await db.delete(users).where(eq(users.id, u));
  });

  test("rooms.parent_room_id FK is ON DELETE CASCADE (catalog)", async () => {
    const res = await db.execute(sql`
      SELECT pg_catalog.pg_get_constraintdef(c.oid, true) AS def
      FROM pg_catalog.pg_constraint c
      JOIN pg_catalog.pg_class cl ON c.conrelid = cl.oid
      WHERE cl.relname = 'rooms'
        AND c.contype = 'f'
        AND pg_catalog.pg_get_constraintdef(c.oid, true) LIKE '%parent_room_id%'
    `);
    const rows = res as unknown as { def: string }[];
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows.some((row) => /ON DELETE CASCADE/i.test(row.def))).toBe(true);
  });
});
