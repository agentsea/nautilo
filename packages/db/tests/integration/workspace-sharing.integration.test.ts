import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import {
  ensureDatabase, createDirectDb, type Database, eq, users, actors, namespaces,
  artifacts, artifactNamespaces, rooms, roomMembers, sessions,
  shareWorkspaceArtifact, listWorkspaceSharesForHuman, findArtifactByInternalIdForNamespaces,
} from "@nautilo/db";
import { bootstrapTestDbInstance } from "../../src/testing/instance-guard";

let conn: ReturnType<typeof createDirectDb>;
beforeAll(async () => {
  bootstrapTestDbInstance();
  await ensureDatabase();
  conn = createDirectDb();
}, 120_000);
afterAll(async () => { await conn?.end(); });

async function fixture(check: (value: {
  tx: Database; fileId: string; sourceNamespaceId: string;
  people: { userId: string; actorId: string }[];
}) => Promise<void>) {
  const rollback = new Error("rollback owned sharing fixtures");
  try {
    await conn.transaction(async (rawTx) => {
      const tx = rawTx as unknown as Database;
      const people: { userId: string; actorId: string }[] = [];
      for (const name of ["Sender", "Recipient", "Outsider"]) {
        const [user] = await tx.insert(users).values({ name: `workspace-share-test-${name}` }).returning();
        const [actor] = await tx.insert(actors).values({ ownerId: user!.id, displayName: name, kind: "user" }).returning();
        people.push({ userId: user!.id, actorId: actor!.id });
      }
      const [ns] = await tx.insert(namespaces).values({ scope: "private", label: "source" }).returning();
      const [file] = await tx.insert(artifacts).values({ artifactId: randomUUID(), path: "report.txt", mimeType: "text/plain", size: 5, storageUri: "file:///fixture/report.txt" }).returning();
      await tx.insert(artifactNamespaces).values({ artifactId: file!.id, namespaceId: ns!.id });
      await check({ tx, people, fileId: file!.id, sourceNamespaceId: ns!.id });
      throw rollback;
    });
  } catch (error) { if (error !== rollback) throw error; }
}

describe("human workspace sharing on PostgreSQL", () => {
  test("same file, exact humans-only audience, recipient provenance, idempotent delivery and no chat", async () => {
    await fixture(async ({ tx, people: [sender, recipient, outsider], fileId, sourceNamespaceId }) => {
      const input = { artifactId: fileId, readableNamespaceIds: [sourceNamespaceId], senderUserId: sender!.userId,
        senderActorId: sender!.actorId, recipientUserId: recipient!.userId, recipientActorId: recipient!.actorId };
      const result = await shareWorkspaceArtifact(input, tx);
      expect(result?.alreadyShared).toBe(false);
      expect(await shareWorkspaceArtifact(input, tx)).toEqual({ namespaceId: result!.namespaceId, alreadyShared: true });
      const received = await listWorkspaceSharesForHuman(recipient!.actorId, tx);
      expect(received).toHaveLength(1);
      expect(received[0]).toMatchObject({ id: fileId, sharedBy: "Sender", path: "report.txt" });
      expect(await listWorkspaceSharesForHuman(sender!.actorId, tx)).toEqual([]);
      expect(await listWorkspaceSharesForHuman(outsider!.actorId, tx)).toEqual([]);
      const [room] = await tx.select().from(rooms).where(eq(rooms.id, received[0]!.roomId));
      expect(room?.kind).toBe("access");
      expect(room?.humanActorIds.sort()).toEqual([sender!.actorId, recipient!.actorId].sort());
      expect(await tx.select().from(roomMembers).where(eq(roomMembers.roomId, room!.id))).toHaveLength(2);
      expect(await tx.select().from(sessions).where(eq(sessions.roomId, room!.id))).toHaveLength(0);
      expect(await findArtifactByInternalIdForNamespaces({ internalId: fileId, readableNamespaceIds: [result!.namespaceId] }, tx)).toMatchObject({ id: fileId });
      expect(await findArtifactByInternalIdForNamespaces({ internalId: fileId, readableNamespaceIds: [sourceNamespaceId] }, tx)).toMatchObject({ id: fileId });
    });
  });
  test("unreadable sources and disabled recipients create no share", async () => {
    await fixture(async ({ tx, people: [sender, recipient], fileId, sourceNamespaceId }) => {
      const input = { artifactId: fileId, readableNamespaceIds: [], senderUserId: sender!.userId,
        senderActorId: sender!.actorId, recipientUserId: recipient!.userId, recipientActorId: recipient!.actorId };
      expect(await shareWorkspaceArtifact(input, tx)).toBeNull();
      await tx.update(users).set({ disabledAt: new Date() }).where(eq(users.id, recipient!.userId));
      expect(await shareWorkspaceArtifact({ ...input, readableNamespaceIds: [sourceNamespaceId] }, tx)).toBeNull();
      expect(await listWorkspaceSharesForHuman(recipient!.actorId, tx)).toEqual([]);
      expect(await tx.select().from(rooms).where(eq(rooms.createdBy, sender!.actorId))).toEqual([]);
    });
  });
});
