/**
 * D476 — atomic projection creation under the agent-role/RLS path.
 *
 * Requires: OPENAI_API_KEY (the production embedding function) and the test
 * Postgres instance.
 */
import { resolve } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { config } from "dotenv";

config({ path: resolve(import.meta.dirname, "../../../../.env") });

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  actors,
  agents,
  createDirectDb,
  ensureDatabase,
  eq,
  memories,
  memoryNamespaces,
  namespaces,
  roomMembers,
  rooms,
  seedTrustPersonal,
  sql,
  users,
} from "@nautilo/db";
import { bootstrapTestDbInstance } from "@nautilo/db/testing";
import {
  executeAtomicProjectionMemory,
  fingerprintProjectionReadableAuthority,
} from "../../src/store/memory-store";

const hasOpenAiApiKey = Boolean(process.env["OPENAI_API_KEY"]?.trim());
if (!hasOpenAiApiKey) {
  console.warn("Skipping D476 atomic projection integration test: OPENAI_API_KEY not set");
}

let db: ReturnType<typeof createDirectDb>;
let userId: string;
let actorId: string;
let agentId: string;
let sourceNamespaceId: string;
let destinationNamespaceId: string;
let sourceRoomId: string;
let destinationRoomId: string;
let destinationRoomLabel: string;
let sourceMemoryId: string;
let similarDestinationMemoryId: string;

const SOURCE_CONTENT = "Private source content must remain private.";
const PROJECTED_CONTENT = "Alex operates Nautilo. Address him as Alex.";

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function projectionInput(creationKey: string, namespaceId = destinationNamespaceId) {
  const membership = `user:${userId}:${actorId}`;
  return {
    userId,
    agentId,
    requesterActorId: actorId,
    sourceFingerprints: [{ id: sourceMemoryId, contentHash: sha256(SOURCE_CONTENT) }],
    frozenReadableNamespaceIds: [sourceNamespaceId],
    frozenReadableAuthorityFingerprint: fingerprintProjectionReadableAuthority([sourceNamespaceId]),
    currentReadableNamespaceIds: [sourceNamespaceId],
    content: PROJECTED_CONTENT,
    contentHash: sha256(PROJECTED_CONTENT),
    type: "fact",
    importance: 0.8,
    roomId: destinationRoomId,
    namespaceId,
    roomLabel: destinationRoomLabel,
    roomKind: "private",
    audienceFingerprint: sha256(`d476:room-audience:v1\u0000${destinationRoomId}\u0000${membership}`),
    creationKey,
    expiresAt: Date.now() + 60_000,
  };
}

beforeAll(async () => {
  if (!hasOpenAiApiKey) return;
  bootstrapTestDbInstance();
  await ensureDatabase();
  db = createDirectDb(1);

  const suffix = Date.now().toString(36);
  const [user] = await db
    .insert(users)
    .values({
      name: "d476-force-create",
      email: `d476-force-create-${suffix}@test.local`,
      handle: `d476fc${suffix.slice(-6)}`,
    })
    .returning({ id: users.id });
  if (!user) throw new Error("user insert failed");
  userId = user.id;

  ({ actorId } = await seedTrustPersonal(userId, "d476-force-create"));

  const [agent] = await db
    .insert(agents)
    .values({ handle: `d476-force-create-${suffix}` })
    .returning({ id: agents.id });
  if (!agent) throw new Error("agent insert failed");
  agentId = agent.id;

  const [sourceNamespace] = await db
    .insert(namespaces)
    .values({ scope: "private", label: `D476 source ${suffix}` })
    .returning({ id: namespaces.id });
  const [destinationNamespace] = await db
    .insert(namespaces)
    .values({ scope: "shared", label: `D476 destination ${suffix}` })
    .returning({ id: namespaces.id });
  if (!sourceNamespace || !destinationNamespace) throw new Error("namespace insert failed");
  sourceNamespaceId = sourceNamespace.id;
  destinationNamespaceId = destinationNamespace.id;

  const [sourceRoom] = await db
    .insert(rooms)
    .values({
      namespaceId: sourceNamespaceId,
      ownerId: userId,
      type: "private",
      label: `D476 source ${suffix}`,
      graphThreadId: `d476-source-${suffix}`,
    })
    .returning({ id: rooms.id });
  destinationRoomLabel = `D476 destination ${suffix}`;
  const [destinationRoom] = await db
    .insert(rooms)
    .values({
      namespaceId: destinationNamespaceId,
      ownerId: userId,
      type: "shared",
      kind: "private",
      label: destinationRoomLabel,
      graphThreadId: `d476-destination-${suffix}`,
    })
    .returning({ id: rooms.id });
  if (!sourceRoom || !destinationRoom) throw new Error("room insert failed");
  sourceRoomId = sourceRoom.id;
  destinationRoomId = destinationRoom.id;
  await db.insert(roomMembers).values([
    { roomId: sourceRoomId, actorId },
    { roomId: destinationRoomId, actorId },
  ]);

  const [sourceMemory] = await db
    .insert(memories)
    .values({ type: "fact", content: SOURCE_CONTENT })
    .returning({ id: memories.id });
  const [similarDestinationMemory] = await db
    .insert(memories)
    .values({ type: "fact", content: PROJECTED_CONTENT })
    .returning({ id: memories.id });
  if (!sourceMemory || !similarDestinationMemory) throw new Error("memory seed failed");
  sourceMemoryId = sourceMemory.id;
  similarDestinationMemoryId = similarDestinationMemory.id;
  await db.insert(memoryNamespaces).values([
    { memoryId: sourceMemoryId, namespaceId: sourceNamespaceId },
    { memoryId: similarDestinationMemoryId, namespaceId: destinationNamespaceId },
  ]);
});

afterAll(async () => {
  if (!hasOpenAiApiKey) return;
  try {
    if (db && userId) {
      await db.execute(sql`DELETE FROM memories WHERE id IN (
        SELECT memory_id FROM memory_namespaces
        WHERE namespace_id IN (${sourceNamespaceId}, ${destinationNamespaceId})
      )`);
      await db.delete(roomMembers).where(eq(roomMembers.actorId, actorId));
      await db.delete(rooms).where(eq(rooms.id, sourceRoomId));
      await db.delete(rooms).where(eq(rooms.id, destinationRoomId));
      await db.delete(namespaces).where(eq(namespaces.id, sourceNamespaceId));
      await db.delete(namespaces).where(eq(namespaces.id, destinationNamespaceId));
      await db.delete(agents).where(eq(agents.id, agentId));
      await db.delete(actors).where(eq(actors.ownerId, userId));
      await db.delete(users).where(eq(users.id, userId));
    }
  } finally {
    await db?.end();
  }
});

describe.skipIf(!hasOpenAiApiKey)("D476 atomic projection idempotency", () => {
  test("creates one destination Memory without mutating similar destination or source Memories", async () => {
    const sourceBefore = await db
      .select({ content: memories.content, updatedAt: memories.updatedAt })
      .from(memories)
      .where(eq(memories.id, sourceMemoryId));
    const sourceEdgesBefore = await db
      .select({ namespaceId: memoryNamespaces.namespaceId })
      .from(memoryNamespaces)
      .where(eq(memoryNamespaces.memoryId, sourceMemoryId));
    const similarBefore = await db
      .select({ content: memories.content, updatedAt: memories.updatedAt })
      .from(memories)
      .where(eq(memories.id, similarDestinationMemoryId));

    const result = await executeAtomicProjectionMemory(
      projectionInput(`projection:${randomUUID()}`),
    );
    expect(result.status).toBe("created");
    if (result.status !== "created") throw new Error(`unexpected result: ${result.status}`);
    expect(result.memoryId).not.toBe(similarDestinationMemoryId);
    expect(result.memoryId).not.toBe(sourceMemoryId);

    const created = await db
      .select({ content: memories.content, type: memories.type, importance: memories.importance })
      .from(memories)
      .where(eq(memories.id, result.memoryId));
    expect(created[0]).toMatchObject({
      content: PROJECTED_CONTENT,
      type: "fact",
      importance: 0.8,
    });
    const createdEdges = await db
      .select({ namespaceId: memoryNamespaces.namespaceId })
      .from(memoryNamespaces)
      .where(eq(memoryNamespaces.memoryId, result.memoryId));
    expect(createdEdges).toEqual([{ namespaceId: destinationNamespaceId }]);

    expect(await db.select({ content: memories.content, updatedAt: memories.updatedAt }).from(memories).where(eq(memories.id, sourceMemoryId))).toEqual(sourceBefore);
    expect(await db.select({ namespaceId: memoryNamespaces.namespaceId }).from(memoryNamespaces).where(eq(memoryNamespaces.memoryId, sourceMemoryId))).toEqual(sourceEdgesBefore);
    expect(await db.select({ content: memories.content, updatedAt: memories.updatedAt }).from(memories).where(eq(memories.id, similarDestinationMemoryId))).toEqual(similarBefore);
  });

  test("returns the original Memory on replay without a second edge", async () => {
    const creationKey = `projection:${randomUUID()}`;
    const first = await executeAtomicProjectionMemory(projectionInput(creationKey));
    const replay = await executeAtomicProjectionMemory(projectionInput(creationKey));

    expect(first.status).toBe("created");
    if (first.status !== "created") throw new Error(`unexpected result: ${first.status}`);
    expect(replay).toEqual({ status: "replayed", memoryId: first.memoryId });
    const matchingMemories = await db
      .select({ id: memories.id })
      .from(memories)
      .where(eq(memories.creationKey, creationKey));
    expect(matchingMemories).toEqual([{ id: first.memoryId }]);
    const edges = await db
      .select({ namespaceId: memoryNamespaces.namespaceId })
      .from(memoryNamespaces)
      .where(eq(memoryNamespaces.memoryId, first.memoryId));
    expect(edges).toEqual([{ namespaceId: destinationNamespaceId }]);

    const alteredContent = "altered after approval";
    expect(await executeAtomicProjectionMemory({
      ...projectionInput(creationKey),
      content: alteredContent,
      contentHash: sha256(alteredContent),
    })).toEqual({ status: "idempotency_conflict", reason: "creation_key_mismatch" });
    expect(await db.select({ namespaceId: memoryNamespaces.namespaceId }).from(memoryNamespaces).where(eq(memoryNamespaces.memoryId, first.memoryId))).toEqual([
      { namespaceId: destinationNamespaceId },
    ]);
  });

  test("fails closed before writing when the frozen destination no longer matches", async () => {
    const creationKey = `projection:${randomUUID()}`;
    expect(await executeAtomicProjectionMemory(
      projectionInput(creationKey, sourceNamespaceId),
    )).toEqual({ status: "stale", reason: "destination_changed" });

    const matchingMemories = await db
      .select({ id: memories.id })
      .from(memories)
      .where(eq(memories.creationKey, creationKey));
    expect(matchingMemories).toHaveLength(0);
  });
});
