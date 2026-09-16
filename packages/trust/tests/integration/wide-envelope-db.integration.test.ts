/**
 * M137 Phase 1 — `buildWideEnvelopeForSpeaker` against live Postgres.
 *
 * Pins the load-bearing privacy properties of the `in_private_namespace`
 * excursion (M148-renamed; legacy `do_in_private_namespace` removed) at the
 * DB-integration level (the WS approval/resume + room-silence machinery is
 * shared with the M084-era run engine):
 *
 *   Topology — three humans {Alice, Bob, Carol} + one agent:
 *     - Alice's 1:1 private room {Alice, Agent}        → nsPrivA (+ "yesterday's report" memory)
 *     - Bob's   1:1 private room {Bob,   Agent}        → nsPrivB
 *     - Group room {Alice, Bob, Carol, Agent}          → nsGroup
 *
 *   1. (invisibility) From the group room (H={A,B,C}) the subset rule does NOT
 *      surface Alice's private namespace — her private content is invisible.
 *   2/3. (read + write target) Alice's WIDE envelope reaches nsPrivA (read) and
 *        targets ONLY nsPrivA for writes; the private memory is reachable via
 *        the wide readable set but NOT via the group readable set.
 *   5. (speaker scoping) Bob's wide envelope resolves Bob's private namespace,
 *      never Alice's. The privacy boundary.
 */
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { config } from "dotenv";

config({ path: resolve(import.meta.dirname, "../../../../.env") });

import {
  createDirectDb,
  ensureDatabase,
  users,
  actors,
  agents,
  rooms,
  roomMembers,
  namespaces,
  memories,
  memoryNamespaces,
  sessions,
  sessionMessages,
  inArray,
  eq,
  sql,
} from "@nautilo/db";
import { bootstrapTestDbInstance } from "@nautilo/db/testing";
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { findReadableNamespacesForSubset } from "../../src/queries";
import { buildWideEnvelopeForSpeaker } from "../../src/wide-envelope";

let db: ReturnType<typeof createDirectDb>;
let aliceUserId: string;
let bobUserId: string;
let carolUserId: string;
let aliceActorId: string;
let bobActorId: string;
let carolActorId: string;
let agentId: string;
let agentActorId: string;
let privRoomAId: string;
let privRoomBId: string;
let groupRoomId: string;
let nsPrivA: string;
let nsPrivB: string;
let nsGroup: string;
let reportMemoryId: string;

async function seedUserWithActor(
  ts: string,
  tag: string,
): Promise<{ userId: string; actorId: string }> {
  const [u] = await db
    .insert(users)
    .values({
      name: `m137-${tag}`,
      email: `m137-${tag}-${ts}@test.local`,
      handle: `m137${tag}${ts.slice(-6)}`,
    })
    .returning({ id: users.id });
  if (!u) throw new Error(`user ${tag}`);
  const [a] = await db
    .insert(actors)
    .values({
      ownerId: u.id,
      displayName: `M137 ${tag}`,
      trustState: "verified",
      kind: "user",
    })
    .returning({ id: actors.id });
  if (!a) throw new Error(`actor ${tag}`);
  return { userId: u.id, actorId: a.id };
}

async function seedPrivateRoom(
  ts: string,
  tag: string,
  humanActorId: string,
  ownerUserId: string,
): Promise<{ roomId: string; namespaceId: string }> {
  const [ns] = await db
    .insert(namespaces)
    .values({ scope: "private", label: `m137-priv-${tag}-${ts}` })
    .returning({ id: namespaces.id });
  if (!ns) throw new Error(`ns ${tag}`);
  const roomId = randomUUID();
  await db.insert(rooms).values({
    id: roomId,
    ownerId: ownerUserId,
    type: "private",
    label: `${tag} DM`,
    graphThreadId: `room:${roomId}`,
    namespaceId: ns.id,
    humanActorIds: [humanActorId],
    kind: "private",
  });
  await db.insert(roomMembers).values([
    { roomId, actorId: humanActorId, roomRole: "admin" },
    { roomId, actorId: agentActorId, roomRole: "member" },
  ]);
  return { roomId, namespaceId: ns.id };
}

beforeAll(async () => {
  bootstrapTestDbInstance();
  await ensureDatabase();
  db = createDirectDb(1);
  const ts = Date.now().toString(36);

  ({ userId: aliceUserId, actorId: aliceActorId } = await seedUserWithActor(ts, "alice"));
  ({ userId: bobUserId, actorId: bobActorId } = await seedUserWithActor(ts, "bob"));
  ({ userId: carolUserId, actorId: carolActorId } = await seedUserWithActor(ts, "carol"));

  const [ag] = await db
    .insert(agents)
    .values({ handle: `m137-ag-${ts}` })
    .returning({ id: agents.id });
  if (!ag) throw new Error("agent");
  agentId = ag.id;
  const [agAct] = await db
    .insert(actors)
    .values({ ownerId: aliceUserId, displayName: "M137 Agent mirror", kind: "agent", agentId })
    .returning({ id: actors.id });
  if (!agAct) throw new Error("agent actor");
  agentActorId = agAct.id;

  ({ roomId: privRoomAId, namespaceId: nsPrivA } = await seedPrivateRoom(
    ts,
    "alice",
    aliceActorId,
    aliceUserId,
  ));
  ({ roomId: privRoomBId, namespaceId: nsPrivB } = await seedPrivateRoom(
    ts,
    "bob",
    bobActorId,
    bobUserId,
  ));

  // Group room {Alice, Bob, Carol, Agent}.
  const [nsG] = await db
    .insert(namespaces)
    .values({ scope: "shared", label: `m137-group-${ts}` })
    .returning({ id: namespaces.id });
  if (!nsG) throw new Error("group ns");
  nsGroup = nsG.id;
  groupRoomId = randomUUID();
  await db.insert(rooms).values({
    id: groupRoomId,
    ownerId: aliceUserId,
    type: "shared",
    label: "Group",
    graphThreadId: `room:${groupRoomId}`,
    namespaceId: nsGroup,
    humanActorIds: [aliceActorId, bobActorId, carolActorId],
    kind: "group",
  });
  await db.insert(roomMembers).values([
    { roomId: groupRoomId, actorId: aliceActorId, roomRole: "admin" },
    { roomId: groupRoomId, actorId: bobActorId, roomRole: "member" },
    { roomId: groupRoomId, actorId: carolActorId, roomRole: "member" },
    { roomId: groupRoomId, actorId: agentActorId, roomRole: "member" },
  ]);

  // "Yesterday's report" lives only in Alice's private namespace.
  const [mem] = await db
    .insert(memories)
    .values({ type: "fact", content: `m137-yesterdays-report-${ts}` })
    .returning({ id: memories.id });
  if (!mem) throw new Error("memory");
  reportMemoryId = mem.id;
  await db.insert(memoryNamespaces).values({ memoryId: reportMemoryId, namespaceId: nsPrivA });
});

afterAll(async () => {
  if (!db) return;
  try {
    if (reportMemoryId) {
      await db.execute(sql`DELETE FROM memories WHERE id = ${reportMemoryId}::uuid`);
    }
    const roomIds = [privRoomAId, privRoomBId, groupRoomId].filter(Boolean);
    if (roomIds.length > 0) {
      const sessRows = await db
        .select({ id: sessions.id })
        .from(sessions)
        .where(inArray(sessions.roomId, roomIds));
      const sessIds = sessRows.map((s) => s.id);
      if (sessIds.length > 0) {
        await db.delete(sessionMessages).where(inArray(sessionMessages.sessionId, sessIds));
        await db.delete(sessions).where(inArray(sessions.id, sessIds));
      }
      await db.delete(roomMembers).where(inArray(roomMembers.roomId, roomIds));
      await db.delete(rooms).where(inArray(rooms.id, roomIds));
    }
    for (const ns of [nsPrivA, nsPrivB, nsGroup].filter(Boolean)) {
      await db.delete(namespaces).where(eq(namespaces.id, ns));
    }
    if (agentActorId) await db.delete(actors).where(eq(actors.id, agentActorId));
    if (agentId) await db.delete(agents).where(eq(agents.id, agentId));
    for (const uid of [aliceUserId, bobUserId, carolUserId].filter(Boolean)) {
      await db.delete(actors).where(eq(actors.ownerId, uid));
      await db.delete(users).where(eq(users.id, uid));
    }
  } finally {
    await db.end();
  }
});

describe("M137 — wide envelope privacy boundary (live Postgres)", () => {
  test("(1) Alice's private namespace is INVISIBLE from the group room subset", async () => {
    const groupReadable = await findReadableNamespacesForSubset([
      aliceActorId,
      bobActorId,
      carolActorId,
    ]);
    expect(groupReadable).toContain(nsGroup);
    expect(groupReadable).not.toContain(nsPrivA);
    expect(groupReadable).not.toContain(nsPrivB);
  });

  test("(2+3) Alice's WIDE envelope reads her private NS and writes ONLY there", async () => {
    const result = await buildWideEnvelopeForSpeaker({
      speakerActorId: aliceActorId,
      speakerUserId: aliceUserId,
      agentId,
      toolPolicy: {},
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.privateRoomId).toBe(privRoomAId);
    // Write target is the private NS only — never the group room.
    expect(result.envelope.writableNamespaces).toEqual([nsPrivA]);
    expect(result.envelope.writableNamespaces).not.toContain(nsGroup);
    // Readable widens to her private NS (and the group room, which is a superset of {Alice}).
    expect(result.envelope.readableNamespaces).toContain(nsPrivA);
    expect(result.envelope.readableNamespaces).toContain(nsGroup);
    // Mutable mirrors readable.
    expect(result.envelope.mutableNamespaces).toEqual(result.envelope.readableNamespaces);
    expect(result.envelope.ownerId).toBe(aliceUserId);
    expect(result.envelope.actorId).toBe(aliceActorId);
  });

  test("(2) 'yesterday's report' is reachable via Alice's WIDE set but NOT the group set", async () => {
    const wide = await buildWideEnvelopeForSpeaker({
      speakerActorId: aliceActorId,
      speakerUserId: aliceUserId,
      agentId,
      toolPolicy: {},
    });
    expect(wide.ok).toBe(true);
    if (!wide.ok) return;

    const reachableWide = await db
      .select({ memoryId: memoryNamespaces.memoryId })
      .from(memoryNamespaces)
      .where(inArray(memoryNamespaces.namespaceId, wide.envelope.readableNamespaces));
    expect(reachableWide.some((r) => r.memoryId === reportMemoryId)).toBe(true);

    const groupReadable = await findReadableNamespacesForSubset([
      aliceActorId,
      bobActorId,
      carolActorId,
    ]);
    const reachableGroup = await db
      .select({ memoryId: memoryNamespaces.memoryId })
      .from(memoryNamespaces)
      .where(inArray(memoryNamespaces.namespaceId, groupReadable));
    expect(reachableGroup.some((r) => r.memoryId === reportMemoryId)).toBe(false);
  });

  test("(2/3/6) return-room namespace becomes the primary write target", async () => {
    const result = await buildWideEnvelopeForSpeaker({
      speakerActorId: aliceActorId,
      speakerUserId: aliceUserId,
      agentId,
      toolPolicy: {},
      returnRoomNamespaceId: nsGroup,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Bring-it-here: the group room is writableNamespaces[0] so workspace
    // writes/attachments (which use writableNamespaces[0]) land in the room
    // every participant — humans AND agents — can see; private NS stays
    // writable as a secondary target.
    expect(result.envelope.writableNamespaces).toEqual([nsGroup, nsPrivA]);
    expect(result.envelope.readableNamespaces).toContain(nsPrivA);
    expect(result.envelope.readableNamespaces).toContain(nsGroup);
  });

  test("(5) speaker scoping: Bob's WIDE envelope resolves Bob's private NS, never Alice's", async () => {
    const result = await buildWideEnvelopeForSpeaker({
      speakerActorId: bobActorId,
      speakerUserId: bobUserId,
      agentId,
      toolPolicy: {},
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.privateRoomId).toBe(privRoomBId);
    expect(result.envelope.writableNamespaces).toEqual([nsPrivB]);
    expect(result.envelope.writableNamespaces).not.toContain(nsPrivA);
    expect(result.envelope.readableNamespaces).not.toContain(nsPrivA);
  });
});
