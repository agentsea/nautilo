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
  photoLibraryOperations,
  profiles,
  users,
} from "@nautilo/db";
import { bootstrapTestDbInstance } from "@nautilo/db/testing";
import {
  AgentPhotoLibraryService,
  type AgentPhotoLibraryAuthority,
  type AgentPhotoCreateResult,
  type AgentPhotoMutationResult,
} from "../../src/lib/agent-photo-library-service";
import { assertOwnedAvatarProtocolUpgradeReady } from "../../src/photo-library/owned-avatar-protocol-upgrade";
import { deriveOwnedAvatarBlobId } from "../../src/photo-library/owned-avatar-staging";
type Db = ReturnType<typeof createDirectDb>;

let db: Db;
let serverInstanceId: string;

interface Fixture {
  ownerUserId: string;
  agentId: string;
  profileId: string;
  authority: AgentPhotoLibraryAuthority;
  presentBlobIds: Set<string>;
  events: AgentPhotoMutationResult[];
  createEvents: AgentPhotoCreateResult[];
  service: AgentPhotoLibraryService;
}

beforeAll(async () => {
  bootstrapTestDbInstance();
  await ensureDatabase();
  db = createDirectDb(8);
  const [identity] = await db
    .select({ serverInstanceId: nautiloInstanceIdentity.serverInstanceId })
    .from(nautiloInstanceIdentity)
    .where(eq(nautiloInstanceIdentity.id, "self"))
    .limit(1);
  if (!identity) throw new Error("test instance identity is missing");
  serverInstanceId = identity.serverInstanceId;
}, 30_000);

afterAll(async () => {
  if (db) await db.end();
});

async function makeFixture(initialAvatar: { kind: "preset"; id: string } | null = { kind: "preset", id: "shell" }): Promise<Fixture> {
  const nonce = `${Date.now()}-${randomUUID().slice(0, 8)}`;
  const [owner] = await db
    .insert(users)
    .values({
      name: "selection owner",
      email: "user@example.invalid".replace("user", `user${nonce}`),
      handle: `photo${randomUUID().replaceAll("-", "").slice(0, 12)}`,
    })
    .returning({ id: users.id });
  if (!owner) throw new Error("selection owner insert failed");
  const [agent] = await db
    .insert(agents)
    .values({ handle: `agent-${randomUUID()}` })
    .returning({ id: agents.id });
  if (!agent) throw new Error("selection Agent insert failed");
  await db.insert(actors).values({
    ownerId: owner.id,
    displayName: "selection Agent",
    kind: "agent",
    agentId: agent.id,
  });
  const [profile] = await db
    .insert(profiles)
    .values({ userId: owner.id, agentId: agent.id, avatarRef: initialAvatar })
    .returning({ id: profiles.id });
  if (!profile) throw new Error("selection profile insert failed");

  const authority = {
    serverInstanceId,
    viewerUserId: owner.id,
    ownerUserId: owner.id,
    agentId: agent.id,
  } satisfies AgentPhotoLibraryAuthority;
  const presentBlobIds = new Set<string>();
  const events: AgentPhotoMutationResult[] = [];
  const createEvents: AgentPhotoCreateResult[] = [];
  return {
    ownerUserId: owner.id,
    agentId: agent.id,
    profileId: profile.id,
    authority,
    presentBlobIds,
    events,
    createEvents,
    service: new AgentPhotoLibraryService({
      db,
      blobExists: ({ blobId }) => presentBlobIds.has(blobId),
      presetExists: (presetId) => presetId === "shell" || presetId === "avatar-01",
      afterCommit: (result) => {
        events.push(result);
      },
      afterCreateCommit: (result) => {
        createEvents.push(result);
      },
    }),
  };
}

async function cleanupFixture(fixture: Fixture): Promise<void> {
  await db.delete(agentPhotoSelectionRevisions).where(eq(agentPhotoSelectionRevisions.agentId, fixture.agentId));
  await db.delete(photoLibraryOperations).where(eq(photoLibraryOperations.agentId, fixture.agentId));
  await db.delete(ownedPhotoEntries).where(eq(ownedPhotoEntries.agentId, fixture.agentId));
  await db.delete(profiles).where(eq(profiles.id, fixture.profileId));
  await db.delete(actors).where(eq(actors.agentId, fixture.agentId));
  await db.delete(agents).where(eq(agents.id, fixture.agentId));
  await db.delete(users).where(eq(users.id, fixture.ownerUserId));
}

async function readProfile(fixture: Fixture) {
  const [row] = await db
    .select({
      avatarRef: profiles.avatarRef,
      selectionRevision: profiles.avatarSelectionRevision,
      libraryRevision: profiles.avatarLibraryRevision,
    })
    .from(profiles)
    .where(eq(profiles.id, fixture.profileId));
  if (!row) throw new Error("Selection profile disappeared");
  return row;
}

async function revisionRows(fixture: Fixture) {
  return db
    .select()
    .from(agentPhotoSelectionRevisions)
    .where(eq(agentPhotoSelectionRevisions.agentId, fixture.agentId));
}

async function expectLibraryError(action: Promise<unknown>, expected: object): Promise<void> {
  try {
    await action;
  } catch (error) {
    expect(error).toMatchObject(expected);
    return;
  }
  throw new Error("Expected photo library rejection");
}

describe("Agent photo selection recovery", () => {
  test("blocks upgrade and publication for an old in-flight lease while retaining its reservation", async () => {
    const fixture = await makeFixture();
    try {
      const input = {
        authority: fixture.authority, operationId: randomUUID(), slotCount: 1,
        source: "upload" as const, origin: "mobile" as const,
        semantics: [{ avatarKind: "uploaded" as const, media: { mimeType: "image/png" as const, byteSize: 42, sha256: "a".repeat(64) } }],
      };
      const reservation = await fixture.service.reserveCreate(input);
      expect("leaseToken" in reservation && reservation.leaseToken[14]).toBe("8");
      const [current] = await db.select().from(photoLibraryOperations).where(eq(photoLibraryOperations.operationId, input.operationId));
      if (!current) throw new Error("Missing reservation");
      const operationId = randomUUID();
      const leaseToken = randomUUID();
      await db.insert(photoLibraryOperations).values({
        serverInstanceId, viewerUserId: fixture.ownerUserId, ownerUserId: fixture.ownerUserId,
        agentId: fixture.agentId, operationId, operationKind: "create",
        requestFingerprint: current.requestFingerprint, state: "pending", reservedSlots: 1,
        reservationExpiresAt: new Date(Date.now() + 60_000), reservationLeaseToken: leaseToken,
      });
      await expectLibraryError(assertOwnedAvatarProtocolUpgradeReady(db), { message: "Photo protocol upgrade requires the previous server to finish reservations and reconcile failed creation artifacts first" });
      let published = false;
      await expectLibraryError(fixture.service.finalizeCreate({
        ...input, operationId, leaseToken,
        entries: [{ ordinal: 0, blobId: deriveOwnedAvatarBlobId({ scope: fixture.authority, operationId, ordinal: 0 }), avatarKind: "uploaded", mediaMimeType: "image/png", mediaByteSize: 42, mediaSha256: "a".repeat(64) }],
      }, async () => { published = true; }), { code: "operation_incomplete" });
      expect(published).toBe(false);
      const [legacy] = await db.select().from(photoLibraryOperations).where(eq(photoLibraryOperations.operationId, operationId));
      expect(legacy).toMatchObject({ state: "pending", reservationLeaseToken: leaseToken, artifactCleanupCompletedAt: null });
    } finally {
      await cleanupFixture(fixture);
    }
  });
  test("explicitly replaces an unindexed current reference and preserves its audit ref without granting Undo", async () => {
    const fixture = await makeFixture(null);
    try {
      const oldRef = { kind: "uploaded" as const, blobId: `unowned-${randomUUID()}` };
      await db.update(profiles).set({ avatarRef: oldRef }).where(eq(profiles.id, fixture.profileId));
      const input = {
        authority: fixture.authority, operationId: randomUUID(), origin: "mobile" as const,
        expectedSelectionRevision: "0", target: { kind: "preset" as const, presetId: "shell" },
        replaceMissingCurrent: true,
      };
      const selected = await fixture.service.select(input);
      expect(selected).toMatchObject({ changed: true, currentAvatarRef: { kind: "preset", id: "shell" }, scope: { selectionRevision: "1", libraryRevision: "1" } });
      expect(await fixture.service.select(input)).toEqual(selected);
      await expectLibraryError(fixture.service.select({ ...input, replaceMissingCurrent: false }), { code: "idempotency_mismatch" });
      const revisions = await revisionRows(fixture);
      expect(revisions).toHaveLength(1);
      expect(revisions[0]).toMatchObject({ beforeAvatarRef: oldRef, beforeEntryId: null });
      expect(fixture.events).toHaveLength(1);
      if (!selected.revisionId) throw new Error("Missing selection revision");
      await expectLibraryError(fixture.service.undo({
        authority: fixture.authority, operationId: randomUUID(), origin: "mobile",
        expectedSelectionRevision: "1", revisionId: selected.revisionId,
      }), { code: "photo_not_found", retryable: false });
      expect(await readProfile(fixture)).toMatchObject({ avatarRef: { kind: "preset", id: "shell" }, selectionRevision: 1, libraryRevision: 1 });
      expect(fixture.events).toHaveLength(1);
    } finally {
      await cleanupFixture(fixture);
    }
  });
});
