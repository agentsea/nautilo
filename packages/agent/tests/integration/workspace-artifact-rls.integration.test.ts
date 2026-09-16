/**
 * M033 Phase 6 — workspace artifact store under Path C RLS.
 *
 * Exercises applyWorkspaceArtifactRowChange, listWorkspaceArtifacts, and
 * resolveWorkspaceArtifact through the nautilo_agent role with trust context.
 */
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { config } from "dotenv";

config({ path: resolve(import.meta.dirname, "../../../../.env") });

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  actors,
  agents,
  artifactNamespaces,
  artifacts,
  createDirectAgentDb,
  createDirectDb,
  ensureDatabase,
  eq,
  namespaces,
  roomMembers,
  rooms,
  sql,
  users,
} from "@nautilo/db";
import { bootstrapTestDbInstance } from "@nautilo/db/testing";
import {
  applyWorkspaceArtifactRowChange,
  listWorkspaceArtifacts,
  resolveWorkspaceArtifact,
  setWorkspaceArtifactEventSink,
  type EnvelopeFacts,
} from "../../src/tools/file/artifact-store";

let supDb: ReturnType<typeof createDirectDb>;
let agentDb: ReturnType<typeof createDirectAgentDb>;
let userId: string;
let actorId: string;
let agentId: string;
let namespaceId: string;
let roomId: string;
let artifactRowId: string;
let artifactExternalId: string;
let logicalPath: string;
let storageUri: string;

function envelopeFacts(): EnvelopeFacts {
  return {
    userId,
    agentId,
    readableNamespaces: [namespaceId],
    mutableNamespaces: [namespaceId],
    writableNamespaces: [namespaceId],
  };
}

beforeAll(async () => {
  bootstrapTestDbInstance();
  await ensureDatabase();
  supDb = createDirectDb(1);
  agentDb = createDirectAgentDb(1);

  const ts = Date.now().toString(36);
  const [user] = await supDb
    .insert(users)
    .values({
      name: "m033-workspace-artifact-rls",
      email: `m033-ws-art-${ts}@test.local`,
      handle: `m033wa${ts.slice(-6)}`,
    })
    .returning({ id: users.id });
  if (!user) throw new Error("Failed to create user");
  userId = user.id;

  const [actor] = await supDb
    .insert(actors)
    .values({ ownerId: userId, displayName: "m033-workspace-artifact-rls", kind: "user" })
    .returning({ id: actors.id });
  if (!actor) throw new Error("Failed to create actor");
  actorId = actor.id;

  const [agent] = await supDb
    .insert(agents)
    .values({ handle: `m033-ws-art-${ts}` })
    .returning({ id: agents.id });
  if (!agent) throw new Error("Failed to create agent");
  agentId = agent.id;

  const [ns] = await supDb
    .insert(namespaces)
    .values({ scope: "private", label: `M033 workspace artifact ${ts}` })
    .returning({ id: namespaces.id });
  if (!ns) throw new Error("Failed to create namespace");
  namespaceId = ns.id;

  const [room] = await supDb
    .insert(rooms)
    .values({
      namespaceId,
      ownerId: userId,
      type: "private",
      label: `M033 workspace artifact ${ts}`,
      graphThreadId: `m033-ws-art-${ts}`,
    })
    .returning({ id: rooms.id });
  if (!room) throw new Error("Failed to create room");
  roomId = room.id;

  await supDb.insert(roomMembers).values({ roomId, actorId });

  artifactExternalId = randomUUID();
  logicalPath = `notes/m033-${ts}.md`;
  storageUri = `file:///tmp/m033-artifact-${artifactExternalId}`;
});

afterAll(async () => {
  try {
    if (supDb && userId) {
      if (artifactRowId) {
        await supDb.execute(sql`DELETE FROM artifact_namespaces WHERE artifact_id = ${artifactRowId}`);
        await supDb.delete(artifacts).where(eq(artifacts.id, artifactRowId));
      }
      await supDb.delete(roomMembers).where(eq(roomMembers.roomId, roomId));
      await supDb.delete(rooms).where(eq(rooms.id, roomId));
      await supDb.delete(namespaces).where(eq(namespaces.id, namespaceId));
      await supDb.delete(actors).where(eq(actors.id, actorId));
      await supDb.delete(agents).where(eq(agents.id, agentId));
      await supDb.delete(users).where(eq(users.id, userId));
    }
  } finally {
    await agentDb?.end();
    await supDb?.end();
  }
});

describe("workspace-artifact Path C RLS (M033 Phase 6)", () => {
  test("applyWorkspaceArtifactRowChange create inserts artifacts + junction rows", async () => {
    let visibilityAtEvent:
      | Promise<{ artifactVisible: boolean; namespaceVisible: boolean }>
      | null = null;
    setWorkspaceArtifactEventSink((event) => {
      if (
        event.type !== "workspace.artifact.changed" ||
        event.artifactId !== artifactExternalId
      ) {
        return;
      }
      // This superuser handle uses a different pool from the agent
      // transaction. It models the server's SSE and list-generation
      // consumers, both of which re-query after receiving the event.
      visibilityAtEvent = (async () => {
        const [visibleArtifacts, visibleNamespaces] = await Promise.all([
          supDb
            .select({ id: artifacts.id })
            .from(artifacts)
            .where(eq(artifacts.id, event.id)),
          supDb
            .select({ namespaceId: artifactNamespaces.namespaceId })
            .from(artifactNamespaces)
            .where(eq(artifactNamespaces.artifactId, event.id)),
        ]);
        return {
          artifactVisible: visibleArtifacts.length === 1,
          namespaceVisible: visibleNamespaces.some(
            (row) => row.namespaceId === namespaceId,
          ),
        };
      })();
    });
    try {
      await applyWorkspaceArtifactRowChange(
        {
          mode: "create",
          artifactId: artifactExternalId,
          logicalPath,
          namespaceId,
          storageUri,
          mimeType: "text/markdown",
        },
        128,
        userId,
        agentId,
        { kind: "agent", agentId },
      );
    } finally {
      setWorkspaceArtifactEventSink(null);
    }

    expect(visibilityAtEvent).not.toBeNull();
    expect(await visibilityAtEvent!).toEqual({
      artifactVisible: true,
      namespaceVisible: true,
    });

    const rows = await supDb
      .select({ id: artifacts.id, path: artifacts.path, artifactId: artifacts.artifactId })
      .from(artifacts)
      .where(eq(artifacts.artifactId, artifactExternalId));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.path).toBe(logicalPath);
    artifactRowId = rows[0]!.id;

    const junction = await supDb
      .select({ namespaceId: artifactNamespaces.namespaceId })
      .from(artifactNamespaces)
      .where(eq(artifactNamespaces.artifactId, artifactRowId));
    expect(junction.map((r) => r.namespaceId)).toContain(namespaceId);
  });

  test("listWorkspaceArtifacts returns the created artifact", async () => {
    const listed = await listWorkspaceArtifacts(envelopeFacts());
    expect(listed.some((a) => a.artifactId === artifactExternalId && a.path === logicalPath)).toBe(true);
  });

  test("resolveWorkspaceArtifact read intent resolves the artifact", async () => {
    const resolved = await resolveWorkspaceArtifact({
      logicalPath,
      facts: envelopeFacts(),
      intent: "read",
    });
    expect(resolved.ok).toBe(true);
    if (resolved.ok) {
      expect(resolved.artifact?.artifactId).toBe(artifactExternalId);
      expect(resolved.logicalPath).toBe(logicalPath);
    }
  });

  test("listWorkspaceArtifacts with empty userId fails closed or returns zero rows", async () => {
    let threw = false;
    let rows: Awaited<ReturnType<typeof listWorkspaceArtifacts>> = [];
    try {
      rows = await listWorkspaceArtifacts({
        ...envelopeFacts(),
        userId: "",
      });
    } catch (e) {
      threw = true;
      expect(String((e as Error).message)).toMatch(/userId is required/i);
    }

    if (!threw) {
      expect(rows).toHaveLength(0);
    }
  });

  test("artifacts rows are invisible without trust context (zero-rows regression)", async () => {
    const withoutTrust = await agentDb
      .select({ id: artifacts.id })
      .from(artifacts)
      .where(eq(artifacts.id, artifactRowId));
    expect(withoutTrust).toHaveLength(0);
  });
});
