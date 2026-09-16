import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  actors,
  agents,
  agentPhotoSelectionRevisions,
  createDirectDb,
  ensureDatabase,
  eq,
  nautiloInstanceIdentity,
  ownedPhotoEntries,
  profiles,
  users,
} from "../../src";
import { bootstrapTestDbInstance } from "../../src/testing/instance-guard";

type Db = ReturnType<typeof createDirectDb>;
let db: Db;

beforeAll(async () => {
  bootstrapTestDbInstance();
  await ensureDatabase();
  db = createDirectDb(2);
}, 30_000);

afterAll(async () => {
  if (db) await db.end();
});

describe("D487 migration 0141 real constraints", () => {
  test("accepts truthful CLI origins and rejects CLI as a maintenance import origin", async () => {
    const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
    const [identity] = await db.select().from(nautiloInstanceIdentity).limit(1);
    if (!identity) throw new Error("test-cruft instance identity is unavailable");
    const [owner] = await db.insert(users).values({
      name: "D487 CLI origin",
      email: `d487-cli-${suffix}@test.invalid`,
      handle: `d487cli${suffix}`,
    }).returning({ id: users.id });
    const [agent] = await db.insert(agents).values({
      handle: `d487-cli-agent-${suffix}`,
    }).returning({ id: agents.id });
    if (!owner || !agent) throw new Error("D487 CLI origin fixture creation failed");

    try {
      await db.insert(actors).values({
        ownerId: owner.id,
        displayName: "D487 CLI Agent",
        kind: "agent",
        agentId: agent.id,
      });
      await db.insert(profiles).values({ userId: owner.id, agentId: agent.id });
      const [entry] = await db.insert(ownedPhotoEntries).values({
        serverInstanceId: identity.serverInstanceId,
        ownerUserId: owner.id,
        subjectKind: "agent",
        agentId: agent.id,
        avatarKind: "uploaded",
        blobId: `d487_cli_${suffix}`,
        source: "upload",
        origin: "cli_setup",
        operationId: randomUUID(),
        requestFingerprint: "a".repeat(64),
        mediaMimeType: "image/png",
        mediaByteSize: 1,
        mediaSha256: "b".repeat(64),
      }).returning({ id: ownedPhotoEntries.id });
      expect(entry?.id).toBeDefined();

      const [revision] = await db.insert(agentPhotoSelectionRevisions).values({
        serverInstanceId: identity.serverInstanceId,
        ownerUserId: owner.id,
        agentId: agent.id,
        revision: 1,
        beforeAvatarRef: null,
        afterAvatarRef: { kind: "preset", id: "avatar-01" },
        actorUserId: owner.id,
        origin: "cli_setup",
        operationId: randomUUID(),
      }).returning({ id: agentPhotoSelectionRevisions.id });
      expect(revision?.id).toBeDefined();

      let invalidMaintenanceOriginRejected = false;
      try {
        await db.insert(ownedPhotoEntries).values({
          serverInstanceId: identity.serverInstanceId,
          ownerUserId: owner.id,
          subjectKind: "agent",
          agentId: agent.id,
          avatarKind: "uploaded",
          blobId: `d487_cli_bad_${suffix}`,
          source: "bundle_import",
          origin: "cli_setup",
          operationId: randomUUID(),
          requestFingerprint: "c".repeat(64),
          mediaMimeType: "image/png",
          mediaByteSize: 1,
          mediaSha256: "d".repeat(64),
        }).returning({ id: ownedPhotoEntries.id });
      } catch {
        invalidMaintenanceOriginRejected = true;
      }
      expect(invalidMaintenanceOriginRejected).toBe(true);
    } finally {
      await db.delete(agentPhotoSelectionRevisions).where(eq(agentPhotoSelectionRevisions.agentId, agent.id));
      await db.delete(ownedPhotoEntries).where(eq(ownedPhotoEntries.agentId, agent.id));
      await db.delete(profiles).where(eq(profiles.agentId, agent.id));
      await db.delete(actors).where(eq(actors.agentId, agent.id));
      await db.delete(agents).where(eq(agents.id, agent.id));
      await db.delete(users).where(eq(users.id, owner.id));
    }
  });
});
