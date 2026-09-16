import { afterAll, beforeAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import {
  ensureDatabase, createDirectDb, eq, inArray, users, actors, namespaces, artifacts,
  artifactNamespaces, rooms, roomMembers, shareWorkspaceArtifact,
} from "@nautilo/db";
import { bootstrapTestDbInstance } from "@nautilo/db/testing";
import {
  findReadableNamespacesForSubset, findRoomByExactHumanActorSet,
  findRecordAccessRoomByExactHumanActorSet,
} from "../../src/queries";
let conn: ReturnType<typeof createDirectDb>;
const personIds: string[] = [], actorIds: string[] = [], namespaceIds: string[] = [];
let fileId = "";
beforeAll(async () => {
  bootstrapTestDbInstance(); await ensureDatabase(); conn = createDirectDb();
  for (const label of ["Sender", "Recipient", "Unrelated"]) {
    const [user] = await conn.insert(users).values({ name: `workspace-access-test-${label}` }).returning();
    personIds.push(user!.id);
    const [actor] = await conn.insert(actors).values({ ownerId: user!.id, displayName: label, kind: "user" }).returning();
    actorIds.push(actor!.id);
  }
  const [ns] = await conn.insert(namespaces).values({ scope: "private", label: "sharing fixture" }).returning();
  namespaceIds.push(ns!.id);
  const [file] = await conn.insert(artifacts).values({ artifactId: randomUUID(), path: "plan.md", mimeType: "text/markdown", size: 4, storageUri: "file:///fixture/plan.md" }).returning();
  fileId = file!.id;
  await conn.insert(artifactNamespaces).values({ artifactId: fileId, namespaceId: ns!.id });
}, 120_000);
afterAll(async () => {
  if (!conn) return;
  try {
    if (fileId) await conn.delete(artifacts).where(eq(artifacts.id, fileId));
    if (namespaceIds.length) {
      const ownedRooms = await conn.select({ id: rooms.id }).from(rooms).where(inArray(rooms.namespaceId, namespaceIds));
      if (ownedRooms.length) {
        await conn.delete(roomMembers).where(inArray(roomMembers.roomId, ownedRooms.map((room) => room.id)));
        await conn.delete(rooms).where(inArray(rooms.id, ownedRooms.map((room) => room.id)));
      }
      await conn.delete(namespaces).where(inArray(namespaces.id, namespaceIds));
    }
    if (personIds.length) await conn.delete(users).where(inArray(users.id, personIds));
  } finally { await conn.end(); }
});
test("sharing admits the recipient privately but never a larger group or unrelated grant destination", async () => {
  const shared = await shareWorkspaceArtifact({ artifactId: fileId, readableNamespaceIds: [namespaceIds[0]!],
    senderUserId: personIds[0]!, senderActorId: actorIds[0]!, recipientUserId: personIds[1]!, recipientActorId: actorIds[1]! });
  expect(shared).not.toBeNull(); namespaceIds.push(shared!.namespaceId);
  expect(await findReadableNamespacesForSubset([actorIds[1]!])).toContain(shared!.namespaceId);
  expect(await findReadableNamespacesForSubset([actorIds[2]!])).not.toContain(shared!.namespaceId);
  expect(await findReadableNamespacesForSubset([actorIds[1]!, actorIds[2]!])).not.toContain(shared!.namespaceId);
  expect(await findRoomByExactHumanActorSet([actorIds[0]!, actorIds[1]!])).toBeNull();
  expect(await findRecordAccessRoomByExactHumanActorSet([actorIds[0]!, actorIds[1]!])).toBeNull();
});
