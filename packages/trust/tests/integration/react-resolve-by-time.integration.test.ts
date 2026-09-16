import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { config } from "dotenv";

config({ path: resolve(import.meta.dirname, "../../../../.env") });

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  actors,
  agents,
  createDirectDb,
  ensureDatabase,
  eq,
  inArray,
  namespaces,
  rooms,
  roomMembers,
  sessions,
  sessionMessages,
  users,
} from "@nautilo/db";
import { bootstrapTestDbInstance } from "@nautilo/db/testing";
import { resolveRoomMessageByAuthorAndTime } from "../../src/queries";

/**
 * M121 — integration coverage for `resolveRoomMessageByAuthorAndTime`
 * (`(room, author @handle, ISO-UTC-second) -> message id`, most-recent on a
 * same-second collision; non-`main` / non user|assistant rows never resolve;
 * DM handle-omission targets the single user-kind member).
 */

let db: ReturnType<typeof createDirectDb>;

const suffix = `${Date.now().toString(36)}${randomUUID().slice(0, 6)}`.toLowerCase();
const userHandle = `m121res${suffix}`.replace(/[^a-z0-9]/g, "").slice(0, 40);

let ownerUserId: string;
let ownerActorId: string;
let agentId: string;
let agentActorId: string;
let namespaceId: string;
let roomId: string;
let sessionId: string;

const AT_ISO = "2026-06-04T12:00:00Z";
const AT_DATE = new Date("2026-06-04T12:00:00.000Z");

async function seedUserMessage(createdAt: Date, origin = "main"): Promise<number> {
  const [m] = await db
    .insert(sessionMessages)
    .values({
      sessionId,
      role: "user",
      content: `msg ${createdAt.toISOString()} ${origin}`,
      createdAt,
      transcriptOrigin: origin,
    })
    .returning({ id: sessionMessages.id });
  if (!m) throw new Error("seed message failed");
  return m.id;
}

beforeAll(async () => {
  bootstrapTestDbInstance();
  await ensureDatabase();
  db = createDirectDb(1);

  const [u] = await db
    .insert(users)
    .values({
      name: "m121-resolver-owner",
      email: `${userHandle}@test.local`,
      handle: userHandle,
      externalId: randomUUID(),
    })
    .returning({ id: users.id });
  if (!u) throw new Error("user insert failed");
  ownerUserId = u.id;

  const [oa] = await db
    .insert(actors)
    .values({
      ownerId: ownerUserId,
      displayName: "M121 Resolver Owner",
      trustState: "verified",
      kind: "user",
    })
    .returning({ id: actors.id });
  if (!oa) throw new Error("owner actor insert failed");
  ownerActorId = oa.id;

  const [ag] = await db
    .insert(agents)
    .values({
      handle: `ag-m121res-${suffix}`.slice(0, 28),
    })
    .returning({ id: agents.id });
  if (!ag) throw new Error("agent insert failed");
  agentId = ag.id;

  const [aa] = await db
    .insert(actors)
    .values({
      ownerId: ownerUserId,
      displayName: "M121 Resolver Agent Actor",
      trustState: "verified",
      kind: "agent",
      agentId,
    })
    .returning({ id: actors.id });
  if (!aa) throw new Error("agent actor insert failed");
  agentActorId = aa.id;

  const [ns] = await db
    .insert(namespaces)
    .values({ scope: "private", label: "m121-res-ns" })
    .returning({ id: namespaces.id });
  if (!ns) throw new Error("namespace insert failed");
  namespaceId = ns.id;

  const [rm] = await db
    .insert(rooms)
    .values({
      ownerId: ownerUserId,
      type: "private",
      label: "M121 Resolver Room",
      graphThreadId: "app:default",
      namespaceId,
      humanActorIds: [ownerActorId],
      createdBy: ownerActorId,
    })
    .returning({ id: rooms.id });
  if (!rm) throw new Error("room insert failed");
  roomId = rm.id;
  await db.update(rooms).set({ graphThreadId: `room:${roomId}` }).where(eq(rooms.id, roomId));

  await db.insert(roomMembers).values([
    { roomId, actorId: ownerActorId, roomRole: "admin" },
    { roomId, actorId: agentActorId, roomRole: "member" },
  ]);

  const [sess] = await db
    .insert(sessions)
    .values({
      threadId: `room:${roomId}`,
      ownerId: ownerUserId,
      personaId: "owner",
      agentId,
      roomId,
      channel: "tui",
    })
    .returning({ id: sessions.id });
  if (!sess) throw new Error("session insert failed");
  sessionId = sess.id;
});

afterAll(async () => {
  if (!db) return;
  const sessRows = await db
    .select({ id: sessions.id })
    .from(sessions)
    .where(eq(sessions.roomId, roomId));
  const ids = sessRows.map((r) => r.id);
  if (ids.length > 0) {
    await db.delete(sessionMessages).where(inArray(sessionMessages.sessionId, ids));
    await db.delete(sessions).where(inArray(sessions.id, ids));
  }
  await db.delete(roomMembers).where(eq(roomMembers.roomId, roomId));
  await db.delete(rooms).where(eq(rooms.id, roomId));
  await db.delete(namespaces).where(eq(namespaces.id, namespaceId));
  await db.delete(actors).where(eq(actors.ownerId, ownerUserId));
  await db.delete(agents).where(eq(agents.id, agentId));
  await db.delete(users).where(eq(users.id, ownerUserId));
  await db.end();
});

describe("resolveRoomMessageByAuthorAndTime (M121)", () => {
  test("returns the MOST RECENT message on a same-second, same-author collision", async () => {
    const older = await seedUserMessage(new Date(AT_DATE.getTime() + 100));
    const newer = await seedUserMessage(new Date(AT_DATE.getTime() + 900));
    const resolved = await resolveRoomMessageByAuthorAndTime({
      roomId,
      authorHandle: userHandle,
      atIso: AT_ISO,
    });
    expect(resolved).toBe(Math.max(older, newer));
    expect(resolved).toBe(newer);
  });

  test("authorHandle null resolves the nearest reactable message", async () => {
    const resolved = await resolveRoomMessageByAuthorAndTime({
      roomId,
      authorHandle: null,
      atIso: AT_ISO,
    });
    expect(resolved).not.toBeNull();
  });

  test("omitting `at` resolves the MOST RECENT reactable message", async () => {
    const latest = await seedUserMessage(new Date("2026-06-04T20:00:00.000Z"));
    const resolved = await resolveRoomMessageByAuthorAndTime({
      roomId,
      authorHandle: userHandle,
      atIso: null,
    });
    expect(resolved).toBe(latest);
  });

  test("an APPROXIMATE `at` (off by 2s) still resolves the target", async () => {
    const target = await seedUserMessage(new Date("2026-06-04T09:30:05.000Z"));
    const resolved = await resolveRoomMessageByAuthorAndTime({
      roomId,
      authorHandle: userHandle,
      atIso: "2026-06-04T09:30:03Z", // 2s early — mirrors the real agent skew
    });
    expect(resolved).toBe(target);
  });

  test("non-main (subagent) rows are never resolved", async () => {
    const otherIso = "2026-06-04T13:00:00Z";
    await seedUserMessage(new Date("2026-06-04T13:00:00.300Z"), "subagent");
    const resolved = await resolveRoomMessageByAuthorAndTime({
      roomId,
      authorHandle: userHandle,
      atIso: otherIso,
    });
    expect(resolved).toBeNull();
  });

  test("unknown handle resolves to null", async () => {
    const resolved = await resolveRoomMessageByAuthorAndTime({
      roomId,
      authorHandle: "definitely-not-a-real-handle-xyz",
      atIso: AT_ISO,
    });
    expect(resolved).toBeNull();
  });

  // M121 fix — the real-world dogfood bug: an agent calling `react` with no
  // anchor was self-targeting its OWN just-inserted (empty, tool-call-only)
  // assistant turn instead of the user message it was replying to.
  test("omitted anchor + excludeCallerAgentId skips the caller agent's own turns and targets the user message", async () => {
    const userMsg = await seedUserMessage(new Date("2026-06-05T10:00:00.000Z"));
    // The caller agent's own empty tool-call turn (newer than the user msg).
    await db.insert(sessionMessages).values({
      sessionId,
      role: "assistant",
      content: "",
      createdAt: new Date("2026-06-05T10:00:01.000Z"),
      transcriptOrigin: "main",
    });
    // A NON-empty assistant turn by the same caller agent, newer still —
    // proves the exclusion is by-author, not merely the empty-content guard.
    await db.insert(sessionMessages).values({
      sessionId,
      role: "assistant",
      content: "on it",
      createdAt: new Date("2026-06-05T10:00:02.000Z"),
      transcriptOrigin: "main",
    });

    const resolved = await resolveRoomMessageByAuthorAndTime({
      roomId,
      authorHandle: null,
      atIso: null,
      excludeCallerAgentId: agentId,
    });
    expect(resolved).toBe(userMsg);
  });

  test("empty-content turns are never the resolved target (no anchor)", async () => {
    // Newest row in the room is an empty assistant turn; resolver must skip it.
    await db.insert(sessionMessages).values({
      sessionId,
      role: "assistant",
      content: "   ",
      createdAt: new Date("2026-06-05T11:00:00.000Z"),
      transcriptOrigin: "main",
    });
    const target = await seedUserMessage(new Date("2026-06-05T11:00:01.000Z"));
    const resolved = await resolveRoomMessageByAuthorAndTime({
      roomId,
      authorHandle: null,
      atIso: null,
      excludeCallerAgentId: agentId,
    });
    expect(resolved).toBe(target);
  });
});
