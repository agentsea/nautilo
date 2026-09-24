/**
 * M124 Phase 4 — M044 namespace-subset pin (live Postgres).
 *
 * Per M044 (REL-HUM-NSP), a room's namespace is readable from any room whose
 * HUMAN set is a SUBSET of it. A public room with humans {A,B,C} is therefore
 * readable from A's private DM (humans {A}) — a memory saved in the public
 * room surfaces in the private DM. This is INTENTIONAL cross-room visibility,
 * not a leak, and M124 must not regress it. We pin both halves:
 *   1. `findReadableNamespacesForSubset(H(privateDM))` includes the open
 *      room's namespace.
 *   2. A memory stored in the open room's namespace is retrievable via the
 *      readable-namespace set derived from the private DM's human subset.
 *
 * Subset is over the HUMAN set only — agent membership is irrelevant (the
 * private DM has the default agent; the open room has none).
 */
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { config } from "dotenv";

config({ path: resolve(import.meta.dirname, "../../../../.env") });

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { listMemories } from "../../../agent/src/store/memory-store";
import {
  createDirectDb,
  ensureDatabase,
  users,
  serverAdmission,
  actors,
  agents,
  rooms,
  roomMembers,
  namespaces,
  memories,
  memoryNamespaces,
  artifacts,
  artifactNamespaces,
  listArtifactsForNamespaces,
  sessions,
  sessionMessages,
  inArray,
  eq,
  sql,
} from "@nautilo/db";
import {
  createOpenRoom,
  joinOpenRoom,
  findReadableNamespacesForSubset,
  findRoomByExactHumanActorSet,
  getRoomWithAccess,
} from "../../src/queries";
import { bootstrapTestDbInstance } from "@nautilo/db/testing";

let db: ReturnType<typeof createDirectDb>;
let userAId: string;
let userBId: string;
let userCId: string;
let actorAId: string;
let actorBId: string;
let actorCId: string;
let agentId: string;
let agentActorId: string;
let privateRoomId: string;
let privateNsId: string;
let openRoomId: string;
let openNsId: string;
let smallerOpenRoomId: string;
let smallerOpenNsId: string;
let publicSubthreadRoomId: string;
let privatePairRoomId: string;
let privatePairNsId: string;
let privateLargerRoomId: string;
let privateLargerNsId: string;
let memoryId: string;
const matrixMemoryIds: string[] = [];
const matrixMemoryContents: string[] = [];
const matrixArtifactIds: string[] = [];
let matrixPathPrefix: string;

async function seedUserWithActor(
  ts: string,
  tag: string,
): Promise<{ userId: string; actorId: string }> {
  const [u] = await db
    .insert(users)
    .values({
      name: `m124-sub-${tag}`,
      email: null,
      handle: `m124sub${tag}${ts.slice(-6)}`,
    })
    .returning({ id: users.id });
  if (!u) throw new Error(`user ${tag}`);
  await db.insert(serverAdmission).values({ userId: u.id, admitted: true });
  const [a] = await db
    .insert(actors)
    .values({ ownerId: u.id, displayName: `Sub ${tag}`, trustState: "verified", kind: "user" })
    .returning({ id: actors.id });
  if (!a) throw new Error(`actor ${tag}`);
  return { userId: u.id, actorId: a.id };
}

beforeAll(async () => {
  bootstrapTestDbInstance();
  await ensureDatabase();
  db = createDirectDb(1);
  const ts = Date.now().toString(36);

  ({ userId: userAId, actorId: actorAId } = await seedUserWithActor(ts, "a"));
  ({ userId: userBId, actorId: actorBId } = await seedUserWithActor(ts, "b"));
  ({ userId: userCId, actorId: actorCId } = await seedUserWithActor(ts, "c"));

  // Default agent + its mirror actor — private-DM member only.
  const [ag] = await db
    .insert(agents)
    .values({ handle: `m124sub-ag-${ts}` })
    .returning({ id: agents.id });
  if (!ag) throw new Error("agent");
  agentId = ag.id;
  const [agAct] = await db
    .insert(actors)
    .values({ ownerId: userAId, displayName: "Sub Agent mirror", kind: "agent", agentId })
    .returning({ id: actors.id });
  if (!agAct) throw new Error("agent actor");
  agentActorId = agAct.id;

  // Private DM: humans {A} (+ default agent). humanActorIds is the HUMAN set only.
  const [nsP] = await db
    .insert(namespaces)
    .values({ scope: "private", label: `m124sub-priv-${ts}` })
    .returning({ id: namespaces.id });
  if (!nsP) throw new Error("private ns");
  privateNsId = nsP.id;
  privateRoomId = randomUUID();
  await db.insert(rooms).values({
    id: privateRoomId,
    ownerId: userAId,
    type: "private",
    label: "A's DM",
    graphThreadId: `room:${privateRoomId}`,
    namespaceId: privateNsId,
    humanActorIds: [actorAId],
    kind: "private",
  });
  await db.insert(roomMembers).values([
    { roomId: privateRoomId, actorId: actorAId, roomRole: "admin" },
    { roomId: privateRoomId, actorId: agentActorId, roomRole: "member" },
  ]);

  // Private pair: humans {A,B}, deliberately with no Agent membership.
  const [nsPair] = await db
    .insert(namespaces)
    .values({ scope: "private", label: `m227-private-pair-${ts}` })
    .returning({ id: namespaces.id });
  if (!nsPair) throw new Error("private pair ns");
  privatePairNsId = nsPair.id;
  privatePairRoomId = randomUUID();
  await db.insert(rooms).values({
    id: privatePairRoomId,
    ownerId: userAId,
    type: "private",
    label: "A+B private",
    graphThreadId: `room:${privatePairRoomId}`,
    namespaceId: privatePairNsId,
    humanActorIds: [actorAId, actorBId].sort(),
    kind: "group",
  });
  await db.insert(roomMembers).values([
    { roomId: privatePairRoomId, actorId: actorAId, roomRole: "admin" },
    { roomId: privatePairRoomId, actorId: actorBId, roomRole: "member" },
  ]);

  // Private strict superset: humans {A,B,C}. This makes the public-denial
  // assertion non-vacuous: ordinary Human containment would admit it.
  const [nsLarger] = await db
    .insert(namespaces)
    .values({ scope: "private", label: `m227-private-larger-${ts}` })
    .returning({ id: namespaces.id });
  if (!nsLarger) throw new Error("private larger ns");
  privateLargerNsId = nsLarger.id;
  privateLargerRoomId = randomUUID();
  await db.insert(rooms).values({
    id: privateLargerRoomId,
    ownerId: userAId,
    type: "private",
    label: "A+B+C private",
    graphThreadId: `room:${privateLargerRoomId}`,
    namespaceId: privateLargerNsId,
    humanActorIds: [actorAId, actorBId, actorCId].sort(),
    kind: "group",
  });
  await db.insert(roomMembers).values([
    { roomId: privateLargerRoomId, actorId: actorAId, roomRole: "admin" },
    { roomId: privateLargerRoomId, actorId: actorBId, roomRole: "member" },
    { roomId: privateLargerRoomId, actorId: actorCId, roomRole: "member" },
    { roomId: privateLargerRoomId, actorId: agentActorId, roomRole: "member" },
  ]);

  // Open room created by C; A and B self-join → human set {A,B,C}.
  const detail = await createOpenRoom({
    creatorUserId: userCId,
    creatorActorId: actorCId,
    label: "#public",
  });
  openRoomId = detail.id;
  const [openRow] = await db
    .select({ namespaceId: rooms.namespaceId })
    .from(rooms)
    .where(eq(rooms.id, openRoomId))
    .limit(1);
  openNsId = openRow?.namespaceId ?? "";

  await joinOpenRoom({ userId: userAId, actorId: actorAId, roomId: openRoomId });
  await joinOpenRoom({ userId: userBId, actorId: actorBId, roomId: openRoomId });

  // Smaller open room: humans {A,B}. Its effective audience is
  // {A,B,cosmos}, so it can read the larger {A,B,C,cosmos} public namespace.
  const smallerDetail = await createOpenRoom({
    creatorUserId: userAId,
    creatorActorId: actorAId,
    label: "#public-smaller",
  });
  smallerOpenRoomId = smallerDetail.id;
  const [smallerOpenRow] = await db
    .select({ namespaceId: rooms.namespaceId })
    .from(rooms)
    .where(eq(rooms.id, smallerOpenRoomId))
    .limit(1);
  smallerOpenNsId = smallerOpenRow?.namespaceId ?? "";
  await joinOpenRoom({
    userId: userBId,
    actorId: actorBId,
    roomId: smallerOpenRoomId,
  });

  // Public Subthread: leaf kind is `subthread`, but the shared Namespace
  // boundary remains public through the top-level open Room.
  const [anchorSession] = await db
    .insert(sessions)
    .values({
      threadId: `m227-public-anchor-${ts}`,
      ownerId: userAId,
      personaId: "owner",
      roomId: smallerOpenRoomId,
    })
    .returning({ id: sessions.id });
  if (!anchorSession) throw new Error("public anchor session");
  const [anchorMessage] = await db
    .insert(sessionMessages)
    .values({
      sessionId: anchorSession.id,
      role: "user",
      content: `m227 public subthread anchor ${ts}`,
    })
    .returning({ id: sessionMessages.id });
  if (!anchorMessage) throw new Error("public anchor message");
  publicSubthreadRoomId = randomUUID();
  await db.insert(rooms).values({
    id: publicSubthreadRoomId,
    ownerId: userAId,
    type: "shared",
    label: "#public-smaller thread",
    graphThreadId: `room:${publicSubthreadRoomId}`,
    namespaceId: smallerOpenNsId,
    humanActorIds: [actorAId, actorBId].sort(),
    kind: "subthread",
    parentRoomId: smallerOpenRoomId,
    threadRootMessageId: anchorMessage.id,
  });
  await db.insert(roomMembers).values([
    {
      roomId: publicSubthreadRoomId,
      actorId: actorAId,
      roomRole: "admin",
    },
    {
      roomId: publicSubthreadRoomId,
      actorId: actorBId,
      roomRole: "member",
    },
  ]);

  // Memory saved in the open room's namespace.
  const [mem] = await db
    .insert(memories)
    .values({ type: "fact", content: `m124-public-secret-${ts}` })
    .returning({ id: memories.id });
  if (!mem) throw new Error("memory");
  memoryId = mem.id;
  await db.insert(memoryNamespaces).values({ memoryId, namespaceId: openNsId });

  matrixPathPrefix = `/m227-cosmos-${ts}/`;
  const matrixNamespaces = [
    ["private-pair", privatePairNsId],
    ["private-larger", privateLargerNsId],
    ["public-pair", smallerOpenNsId],
    ["public-larger", openNsId],
  ] as const;
  for (const [label, namespaceId] of matrixNamespaces) {
    const matrixMemoryContent = `m227-matrix-${label}-${ts}`;
    const [matrixMemory] = await db
      .insert(memories)
      .values({ type: "fact", content: matrixMemoryContent })
      .returning({ id: memories.id });
    if (!matrixMemory) throw new Error(`matrix memory ${label}`);
    matrixMemoryIds.push(matrixMemory.id);
    matrixMemoryContents.push(matrixMemoryContent);
    await db.insert(memoryNamespaces).values({
      memoryId: matrixMemory.id,
      namespaceId,
    });

    const [matrixArtifact] = await db
      .insert(artifacts)
      .values({
        artifactId: `m227-matrix-${label}-${ts}`,
        path: `${matrixPathPrefix}${label}.md`,
        storageUri: `memory://m227/${label}/${ts}`,
        mimeType: "text/markdown",
        size: label.length,
      })
      .returning({ id: artifacts.id });
    if (!matrixArtifact) throw new Error(`matrix artifact ${label}`);
    matrixArtifactIds.push(matrixArtifact.id);
    await db.insert(artifactNamespaces).values({
      artifactId: matrixArtifact.id,
      namespaceId,
    });
  }
});

afterAll(async () => {
  if (!db) return;
  try {
    if (memoryId) {
      await db.execute(
        sql`DELETE FROM memories WHERE id = ${memoryId}::uuid`,
      );
    }
    if (matrixMemoryIds.length > 0) {
      await db.delete(memoryNamespaces).where(
        inArray(memoryNamespaces.memoryId, matrixMemoryIds),
      );
      await db.delete(memories).where(inArray(memories.id, matrixMemoryIds));
    }
    if (matrixArtifactIds.length > 0) {
      await db.delete(artifactNamespaces).where(
        inArray(artifactNamespaces.artifactId, matrixArtifactIds),
      );
      await db.delete(artifacts).where(inArray(artifacts.id, matrixArtifactIds));
    }
    // The Subthread's anchor FK is ON DELETE SET NULL, but the canonical
    // invariant requires a live anchor for every live Subthread. Retire the
    // child before deleting its parent-session message.
    if (publicSubthreadRoomId) {
      await db.delete(roomMembers).where(
        eq(roomMembers.roomId, publicSubthreadRoomId),
      );
      await db.delete(rooms).where(eq(rooms.id, publicSubthreadRoomId));
    }
    const subsetRoomIds = [
      privateRoomId,
      privatePairRoomId,
      privateLargerRoomId,
      openRoomId,
      smallerOpenRoomId,
    ].filter(Boolean);
    if (subsetRoomIds.length > 0) {
      const sessRows = await db
        .select({ id: sessions.id })
        .from(sessions)
        .where(inArray(sessions.roomId, subsetRoomIds));
      const sessIds = sessRows.map((s) => s.id);
      if (sessIds.length > 0) {
        await db.delete(sessionMessages).where(inArray(sessionMessages.sessionId, sessIds));
        await db.delete(sessions).where(inArray(sessions.id, sessIds));
      }
    }
    if (privateRoomId) {
      await db.delete(roomMembers).where(eq(roomMembers.roomId, privateRoomId));
      await db.delete(rooms).where(eq(rooms.id, privateRoomId));
    }
    if (privatePairRoomId) {
      await db.delete(roomMembers).where(eq(roomMembers.roomId, privatePairRoomId));
      await db.delete(rooms).where(eq(rooms.id, privatePairRoomId));
    }
    if (privateLargerRoomId) {
      await db.delete(roomMembers).where(eq(roomMembers.roomId, privateLargerRoomId));
      await db.delete(rooms).where(eq(rooms.id, privateLargerRoomId));
    }
    if (openRoomId) {
      await db.delete(roomMembers).where(eq(roomMembers.roomId, openRoomId));
      await db.delete(rooms).where(eq(rooms.id, openRoomId));
    }
    if (smallerOpenRoomId) {
      await db.delete(roomMembers).where(eq(roomMembers.roomId, smallerOpenRoomId));
      await db.delete(rooms).where(eq(rooms.id, smallerOpenRoomId));
    }
    if (privateNsId) await db.delete(namespaces).where(eq(namespaces.id, privateNsId));
    if (privatePairNsId) {
      await db.delete(namespaces).where(eq(namespaces.id, privatePairNsId));
    }
    if (privateLargerNsId) {
      await db.delete(namespaces).where(eq(namespaces.id, privateLargerNsId));
    }
    if (openNsId) await db.delete(namespaces).where(eq(namespaces.id, openNsId));
    if (smallerOpenNsId) await db.delete(namespaces).where(eq(namespaces.id, smallerOpenNsId));
    if (agentActorId) await db.delete(actors).where(eq(actors.id, agentActorId));
    if (agentId) await db.delete(agents).where(eq(agents.id, agentId));
    await db.delete(actors).where(eq(actors.ownerId, userAId));
    await db.delete(actors).where(eq(actors.ownerId, userBId));
    await db.delete(actors).where(eq(actors.ownerId, userCId));
    await db.delete(users).where(eq(users.id, userAId));
    await db.delete(users).where(eq(users.id, userBId));
    await db.delete(users).where(eq(users.id, userCId));
  } finally {
    await db.end();
  }
});

describe("M124 — M044 namespace-subset pin (public room → private DM)", () => {
  test("findReadableNamespacesForSubset(H(private DM)={A}) includes the open room's namespace", async () => {
    const readable = await findReadableNamespacesForSubset([actorAId]);
    // Private DM's own namespace is in the set, and the open room's namespace
    // is too because its human set {A,B,C} is a superset of {A}.
    expect(readable).toContain(openNsId);
    expect(readable).toContain(privateNsId);
  });

  test("a memory saved in the open room is retrievable from the private-DM subset envelope", async () => {
    const readable = await findReadableNamespacesForSubset([actorAId]);
    const rows = await db
      .select({ memoryId: memoryNamespaces.memoryId })
      .from(memoryNamespaces)
      .where(inArray(memoryNamespaces.namespaceId, readable));
    expect(rows.some((r) => r.memoryId === memoryId)).toBe(true);
  });
});

describe("M227 — virtual cosmos public Namespace boundary", () => {
  test("a private Room remains private while unrelated open Rooms exist", async () => {
    const access = await getRoomWithAccess(privateRoomId);
    expect(access).toMatchObject({
      namespaceId: privateNsId,
      isPublicNamespaceBoundary: false,
    });
  });

  test("an open Room is projected as a public Namespace boundary", async () => {
    const access = await getRoomWithAccess(openRoomId);
    expect(access).toMatchObject({
      namespaceId: openNsId,
      isPublicNamespaceBoundary: true,
    });
  });

  test("a public source cannot read an otherwise qualifying private Namespace", async () => {
    const readable = await findReadableNamespacesForSubset(
      [actorAId, actorBId],
      { isPublicNamespaceBoundary: true },
    );
    expect(readable).toContain(smallerOpenNsId);
    expect(readable).toContain(openNsId);
    expect(readable).not.toContain(privatePairNsId);
    expect(readable).not.toContain(privateLargerNsId);
    expect(readable).not.toContain(privateNsId);
  });

  test("a smaller public Room still reads a larger public Room", async () => {
    const readable = await findReadableNamespacesForSubset(
      [actorAId, actorBId],
      { isPublicNamespaceBoundary: true },
    );
    expect(readable).toContain(smallerOpenNsId);
    expect(readable).toContain(openNsId);
    expect(readable).not.toContain(privateNsId);
  });

  test("a Subthread sharing an open Room Namespace inherits the public boundary", async () => {
    const access = await getRoomWithAccess(publicSubthreadRoomId);
    expect(access).toMatchObject({
      namespaceId: smallerOpenNsId,
      isPublicNamespaceBoundary: true,
    });
    if (!access) throw new Error("public subthread missing");
    const readable = await findReadableNamespacesForSubset(
      access.humanActorIds,
      { isPublicNamespaceBoundary: access.isPublicNamespaceBoundary },
    );
    expect(readable).toContain(smallerOpenNsId);
    expect(readable).toContain(openNsId);
    expect(readable).not.toContain(privatePairNsId);
    expect(readable).not.toContain(privateLargerNsId);
  });

  test("an exact human-only audience lookup prefers the matching private Room, never open", async () => {
    const exact = await findRoomByExactHumanActorSet([
      actorAId,
      actorBId,
      actorCId,
    ]);
    expect(exact).toEqual({
      roomId: privateLargerRoomId,
      namespaceId: privateLargerNsId,
    });
  });

  test("Agent-less private {A,B} retrieves private and public equal/superset content", async () => {
    const access = await getRoomWithAccess(privatePairRoomId);
    expect(access).toMatchObject({
      namespaceId: privatePairNsId,
      isPublicNamespaceBoundary: false,
    });
    if (!access) throw new Error("private pair room missing");
    const readable = await findReadableNamespacesForSubset(
      access.humanActorIds,
      { isPublicNamespaceBoundary: access.isPublicNamespaceBoundary },
    );
    const artifactRows = await listArtifactsForNamespaces(
      { readableNamespaceIds: readable, pathPrefix: matrixPathPrefix },
      db,
    );
    const memoryPage = await listMemories({
      namespaceIds: readable,
      userId: userAId,
      limit: 100,
      includeArchive: true,
    });

    expect(artifactRows.map((row) => row.path).sort()).toEqual(
      [
        `${matrixPathPrefix}private-pair.md`,
        `${matrixPathPrefix}private-larger.md`,
        `${matrixPathPrefix}public-pair.md`,
        `${matrixPathPrefix}public-larger.md`,
      ].sort(),
    );
    const ordinaryMemoryContents = memoryPage.items.map((row) => {
      if (row.content === null) throw new Error("seeded ordinary Memory missing content");
      return row.content;
    });
    expect(
      ordinaryMemoryContents
        .filter((content) => content.startsWith("m227-matrix-"))
        .sort(),
    ).toEqual([...matrixMemoryContents].sort());
  });

  test("Agent-less public {A,B,cosmos} retrieves only public equal/superset content", async () => {
    const access = await getRoomWithAccess(smallerOpenRoomId);
    expect(access).toMatchObject({
      namespaceId: smallerOpenNsId,
      isPublicNamespaceBoundary: true,
    });
    if (!access) throw new Error("smaller open room missing");
    const readable = await findReadableNamespacesForSubset(
      access.humanActorIds,
      { isPublicNamespaceBoundary: access.isPublicNamespaceBoundary },
    );
    const artifactRows = await listArtifactsForNamespaces(
      { readableNamespaceIds: readable, pathPrefix: matrixPathPrefix },
      db,
    );
    const memoryPage = await listMemories({
      namespaceIds: readable,
      userId: userAId,
      limit: 100,
      includeArchive: true,
    });

    expect(artifactRows.map((row) => row.path).sort()).toEqual(
      [
        `${matrixPathPrefix}public-pair.md`,
        `${matrixPathPrefix}public-larger.md`,
      ].sort(),
    );
    const ordinaryMemoryContents = memoryPage.items.map((row) => {
      if (row.content === null) throw new Error("seeded ordinary Memory missing content");
      return row.content;
    });
    expect(
      ordinaryMemoryContents
        .filter((content) => content.startsWith("m227-matrix-"))
        .sort(),
    ).toEqual(
      matrixMemoryContents
        .filter((content) => content.includes("m227-matrix-public-"))
        .sort(),
    );
  });
});
