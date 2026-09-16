/**
 * M127 — Agent deletion does NOT cascade to Memory or Artifact rows.
 *
 * Pre-M127: `artifacts.agent_id` had `onDelete: cascade` (and `memories`
 * carried an `agent_id` FK), so removing an Agent silently reaped that
 * Agent's authored content. Post-M127 the per-row column is gone — the
 * content is owned by its Namespace, not by any one Agent. Deleting an
 * Agent now removes only the Agent row + its `room_members` membership
 * (the existing FK cascade); attached Memory + Artifact rows survive.
 *
 * This test exercises that invariant end-to-end against real Postgres.
 *
 * Requires: running Postgres + Neon proxy (mirrors `memory-namespace-db`
 * and `file-tool-workspace-artifact` integration setups).
 */

import { resolve } from "node:path";
import { config } from "dotenv";

config({ path: resolve(import.meta.dirname, "../../../../.env") });

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import {
  createDirectDb,
  ensureDatabase,
  users,
  actors,
  agents,
  namespaces,
  rooms,
  roomMembers,
  memories,
  memoryNamespaces,
  artifacts,
  artifactNamespaces,
  attachArtifactToNamespace,
  insertArtifact,
  eq,
  inArray,
  sql,
} from "@nautilo/db";
import { bootstrapTestDbInstance } from "@nautilo/db/testing";


let db: ReturnType<typeof createDirectDb>;
let ownerId: string;
let actorId: string;
let nsId: string;
let roomId: string;
// The agent we'll delete mid-test. Its `id` is what we assert content
// rows survive against — they reference no agent column anymore, but we
// keep the captured id for the assertion's clarity.
let doomedAgentId: string;
let memoryId: string;
let artifactRowId: string;

const ts = Date.now().toString(36);

beforeAll(async () => {
  bootstrapTestDbInstance();
  await ensureDatabase();
  db = createDirectDb(1);

  const [user] = await db
    .insert(users)
    .values({
      name: "m127-survival",
      email: `m127-survival-${ts}@test.local`,
      handle: `m127s${ts.slice(-6)}`,
    })
    .returning({ id: users.id });
  if (!user) throw new Error("user insert failed");
  ownerId = user.id;

  const [actor] = await db
    .insert(actors)
    .values({ ownerId, displayName: "m127-survival-actor", kind: "user" })
    .returning({ id: actors.id });
  if (!actor) throw new Error("actor insert failed");
  actorId = actor.id;

  const [ns] = await db
    .insert(namespaces)
    .values({ scope: "private", label: `m127-survival-ns-${ts}` })
    .returning({ id: namespaces.id });
  if (!ns) throw new Error("namespace insert failed");
  nsId = ns.id;

  const [room] = await db
    .insert(rooms)
    .values({
      namespaceId: nsId,
      ownerId,
      type: "private",
      label: `m127 survival ${ts}`,
      graphThreadId: `m127-survival-${ts}`,
    })
    .returning({ id: rooms.id });
  if (!room) throw new Error("room insert failed");
  roomId = room.id;

  await db.insert(roomMembers).values({ roomId, actorId });

  const [agent] = await db
    .insert(agents)
    .values({
      handle: `m127-doomed-${ts}`,
    })
    .returning({ id: agents.id });
  if (!agent) throw new Error("agent insert failed");
  doomedAgentId = agent.id;

  // Memory authored "by" the doomed agent (post-M127 the row has no
  // agent column, but the test simulates: while the agent existed, it
  // wrote a memory into the Namespace).
  const [mem] = await db
    .insert(memories)
    .values({
      type: "fact",
      content: `m127-survival-memory-${ts}`,
      importance: 0.5,
    })
    .returning({ id: memories.id });
  if (!mem) throw new Error("memory insert failed");
  memoryId = mem.id;
  await db.insert(memoryNamespaces).values({ memoryId, namespaceId: nsId });

  // Artifact authored "by" the doomed agent. Use the canonical helper
  // (insertArtifact) so the row passes through the post-M127 input
  // shape (no agentId field).
  const externalArtifactId = `m127-art-${ts}`;
  const created = await insertArtifact({
    artifactId: externalArtifactId,
    path: `m127-survival/${ts}.md`,
    storageUri: `file:///tmp/m127-survival-${ts}.md`,
    mimeType: "text/markdown",
    size: 0,
  });
  artifactRowId = created.id;
  await attachArtifactToNamespace({ artifactId: artifactRowId, namespaceId: nsId });
});

afterAll(async () => {
  if (!db) return;

  // Reap any survivors the test left behind.
  try {
    await db.delete(memoryNamespaces).where(eq(memoryNamespaces.memoryId, memoryId));
  } catch (err) {
    console.warn("[m127-survival teardown] memoryNamespaces", err);
  }
  try {
    await db.delete(memories).where(eq(memories.id, memoryId));
  } catch (err) {
    console.warn("[m127-survival teardown] memories", err);
  }
  try {
    await db.delete(artifactNamespaces).where(eq(artifactNamespaces.artifactId, artifactRowId));
  } catch (err) {
    console.warn("[m127-survival teardown] artifactNamespaces", err);
  }
  try {
    await db.delete(artifacts).where(eq(artifacts.id, artifactRowId));
  } catch (err) {
    console.warn("[m127-survival teardown] artifacts", err);
  }
  try {
    await db.delete(roomMembers).where(eq(roomMembers.roomId, roomId));
  } catch (err) {
    console.warn("[m127-survival teardown] roomMembers", err);
  }
  try {
    await db.delete(rooms).where(eq(rooms.id, roomId));
  } catch (err) {
    console.warn("[m127-survival teardown] rooms", err);
  }
  try {
    await db.delete(namespaces).where(eq(namespaces.id, nsId));
  } catch (err) {
    console.warn("[m127-survival teardown] namespaces", err);
  }
  try {
    await db.delete(actors).where(eq(actors.id, actorId));
  } catch (err) {
    console.warn("[m127-survival teardown] actors", err);
  }
  try {
    await db.delete(users).where(eq(users.id, ownerId));
  } catch (err) {
    console.warn("[m127-survival teardown] users", err);
  }
  // doomedAgentId is deleted by the test itself; if the test failed
  // before reaching that point, clean it up here.
  try {
    await db.delete(agents).where(eq(agents.id, doomedAgentId));
  } catch {
    /* expected to be already gone */
  }
  await db.end();
});

describe("M127 — content survives agent deletion (integration)", () => {
  test("baseline: Memory + Artifact rows + junctions exist before delete", async () => {
    const memRows = await db
      .select({ id: memories.id })
      .from(memories)
      .where(eq(memories.id, memoryId));
    expect(memRows).toHaveLength(1);

    const memNsRows = await db
      .select({ namespaceId: memoryNamespaces.namespaceId })
      .from(memoryNamespaces)
      .where(eq(memoryNamespaces.memoryId, memoryId));
    expect(memNsRows.map((r) => r.namespaceId)).toEqual([nsId]);

    const artRows = await db
      .select({ id: artifacts.id })
      .from(artifacts)
      .where(eq(artifacts.id, artifactRowId));
    expect(artRows).toHaveLength(1);

    const artNsRows = await db
      .select({ namespaceId: artifactNamespaces.namespaceId })
      .from(artifactNamespaces)
      .where(eq(artifactNamespaces.artifactId, artifactRowId));
    expect(artNsRows.map((r) => r.namespaceId)).toEqual([nsId]);
  });

  test("delete agent → Memory + Artifact + junctions all survive", async () => {
    // Schema-level invariant: post-M127, neither `memories` nor
    // `artifacts` carries an `agent_id` column, so the FK that used to
    // cascade from `agents` is gone. Deleting the agent must not affect
    // its previously-authored content.
    const cols = await db.execute<{ column_name: string }>(sql`
      SELECT column_name FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name IN ('memories', 'artifacts')
         AND column_name = 'agent_id'
    `);
    // Drizzle's execute() shape varies across drivers; iterate both shapes.
    const rows = Array.isArray(cols) ? cols : ((cols as { rows?: unknown }).rows ?? []);
    expect((rows as unknown[]).length).toBe(0);

    // Delete the agent (this used to cascade-reap the artifact row).
    await db.delete(agents).where(eq(agents.id, doomedAgentId));

    const agentSurvives = await db
      .select({ id: agents.id })
      .from(agents)
      .where(eq(agents.id, doomedAgentId));
    expect(agentSurvives).toHaveLength(0);

    // Memory row survives.
    const memAfter = await db
      .select({ id: memories.id, content: memories.content })
      .from(memories)
      .where(eq(memories.id, memoryId));
    expect(memAfter).toHaveLength(1);
    expect(memAfter[0]?.content).toBe(`m127-survival-memory-${ts}`);

    // Memory junction edge survives.
    const memNsAfter = await db
      .select({ namespaceId: memoryNamespaces.namespaceId })
      .from(memoryNamespaces)
      .where(eq(memoryNamespaces.memoryId, memoryId));
    expect(memNsAfter.map((r) => r.namespaceId)).toEqual([nsId]);

    // Artifact row survives.
    const artAfter = await db
      .select({ id: artifacts.id, path: artifacts.path })
      .from(artifacts)
      .where(eq(artifacts.id, artifactRowId));
    expect(artAfter).toHaveLength(1);
    expect(artAfter[0]?.path).toBe(`m127-survival/${ts}.md`);

    // Artifact junction edge survives.
    const artNsAfter = await db
      .select({ namespaceId: artifactNamespaces.namespaceId })
      .from(artifactNamespaces)
      .where(eq(artifactNamespaces.artifactId, artifactRowId));
    expect(artNsAfter.map((r) => r.namespaceId)).toEqual([nsId]);
  });

  test("post-delete: Memory + Artifact still reachable by Namespace overlap", async () => {
    // The content is now genuinely owned by its Namespace, not by any
    // Agent. A new Agent joining the Namespace can still find these
    // rows via the canonical junction-based query (which is what the
    // memory-store + artifact-store helpers do internally).
    const memHits = await db
      .selectDistinct({ id: memories.id })
      .from(memories)
      .innerJoin(memoryNamespaces, eq(memoryNamespaces.memoryId, memories.id))
      .where(
        inArray(memoryNamespaces.namespaceId, [nsId]),
      );
    expect(memHits.some((r) => r.id === memoryId)).toBe(true);

    const artHits = await db
      .selectDistinct({ id: artifacts.id })
      .from(artifacts)
      .innerJoin(artifactNamespaces, eq(artifactNamespaces.artifactId, artifacts.id))
      .where(inArray(artifactNamespaces.namespaceId, [nsId]));
    expect(artHits.some((r) => r.id === artifactRowId)).toBe(true);
  });
});
