import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  agents,
  agentPhotoSelectionRevisions,
  createDirectDb,
  createOwnedPhotoEntryIdempotently,
  ensureDatabase,
  eq,
  findOwnedAgentPhotoEntry,
  isOwnedPhotoEntryEligibleForGc,
  listOwnedAgentPhotoEntries,
  ownedPhotoEntries,
  photoLibraryOperations,
  profiles,
  type OwnedPhotoListCursor,
  users,
} from "@nautilo/db";
import { bootstrapTestDbInstance } from "../../src/testing/instance-guard";

type Db = ReturnType<typeof createDirectDb>;

const serverInstanceId = "10000000-0000-4000-8000-000000000001";
const fingerprint = "a".repeat(64);
const mediaSha256 = "b".repeat(64);
let db: Db;
let ownerId: string;
let otherOwnerId: string;
let agentId: string;
let profileId: string;
let pageAgentId: string | undefined;
let largePageAgentId: string | undefined;

function photoInput(blobId: string, ownerUserId = ownerId) {
  return {
    serverInstanceId,
    ownerUserId,
    subjectKind: "agent" as const,
    agentId,
    avatarKind: "generated" as const,
    blobId,
    source: "generation" as const,
    origin: "manage_avatar" as const,
    operationId: crypto.randomUUID(),
    requestFingerprint: fingerprint,
    generationProvider: "elevenlabs-image",
    generationModel: "test-model",
    mediaMimeType: "image/png",
    mediaByteSize: 42,
    mediaSha256,
  };
}

function requiredId(rows: Array<{ id: string }>, label: string): string {
  const id = rows[0]?.id;
  if (!id) throw new Error(`missing ${label}`);
  return id;
}

async function expectRejected(
  query: PromiseLike<unknown>,
  message: RegExp,
): Promise<void> {
  try {
    await query;
  } catch (error) {
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(message);
    return;
  }
  throw new Error(`Expected query rejection matching ${message}`);
}

beforeAll(async () => {
  bootstrapTestDbInstance();
  await ensureDatabase();
  db = createDirectDb(3);
  const nonce = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  ownerId = requiredId(await db.insert(users).values({ name: "D487 owner", email: `d487-owner-${nonce}@test.invalid` }).returning({ id: users.id }), "owner");
  otherOwnerId = requiredId(await db.insert(users).values({ name: "D487 other", email: `d487-other-${nonce}@test.invalid` }).returning({ id: users.id }), "other owner");
  agentId = requiredId(await db.insert(agents).values({ handle: `d487-${nonce}` }).returning({ id: agents.id }), "agent");
  profileId = requiredId(await db.insert(profiles).values({ userId: ownerId, agentId }).returning({ id: profiles.id }), "profile");
}, 30_000);

afterAll(async () => {
  if (!db) return;
  await db.delete(agentPhotoSelectionRevisions).where(eq(agentPhotoSelectionRevisions.agentId, agentId));
  await db.delete(photoLibraryOperations).where(eq(photoLibraryOperations.agentId, agentId));
  if (pageAgentId) {
    await db.delete(ownedPhotoEntries).where(eq(ownedPhotoEntries.agentId, pageAgentId));
    await db.delete(agents).where(eq(agents.id, pageAgentId));
  }
  if (largePageAgentId) {
    await db.delete(ownedPhotoEntries).where(eq(ownedPhotoEntries.agentId, largePageAgentId));
    await db.delete(agents).where(eq(agents.id, largePageAgentId));
  }
  await db.delete(ownedPhotoEntries).where(eq(ownedPhotoEntries.agentId, agentId));
  await db.delete(profiles).where(eq(profiles.id, profileId));
  await db.delete(agents).where(eq(agents.id, agentId));
  await db.delete(users).where(eq(users.id, ownerId));
  await db.delete(users).where(eq(users.id, otherOwnerId));
  await db.end();
});

describe("D487 owned photo library persistence", () => {
  test("applies the migration, refuses immutable rewrites, and allows explicit clear history", async () => {
    const [entry] = await db.insert(ownedPhotoEntries).values(photoInput(`d487-trigger-${Date.now()}`)).returning();
    if (!entry) throw new Error("missing D487 owned photo entry");

    await expectRejected(db.update(ownedPhotoEntries).set({ source: "upload" }).where(eq(ownedPhotoEntries.id, entry.id)), /Failed query/);
    const [unchangedEntry] = await db.select({ source: ownedPhotoEntries.source }).from(ownedPhotoEntries).where(eq(ownedPhotoEntries.id, entry.id));
    expect(unchangedEntry?.source).toBe("generation");
    await db.update(ownedPhotoEntries).set({ deletedAt: new Date(), purgeAfter: new Date() }).where(eq(ownedPhotoEntries.id, entry.id));

    await db.update(profiles).set({ avatarSelectionRevision: 1 }).where(eq(profiles.id, profileId));
    await expectRejected(db.update(profiles).set({ avatarSelectionRevision: 0 }).where(eq(profiles.id, profileId)), /Failed query/);

    const [selection] = await db.insert(agentPhotoSelectionRevisions).values({
      serverInstanceId,
      ownerUserId: ownerId,
      agentId,
      revision: 1,
      beforeAvatarRef: { kind: "generated", blobId: entry.blobId },
      afterAvatarRef: null,
      beforeEntryId: entry.id,
      actorUserId: ownerId,
      origin: "manage_avatar",
      operationId: crypto.randomUUID(),
    }).returning();
    if (!selection) throw new Error("missing D487 selection revision");
    await expectRejected(db.update(agentPhotoSelectionRevisions).set({ origin: "mobile" }).where(eq(agentPhotoSelectionRevisions.id, selection.id)), /Failed query/);

    const [operation] = await db.insert(photoLibraryOperations).values({
      serverInstanceId,
      viewerUserId: ownerId,
      ownerUserId: ownerId,
      agentId,
      operationId: crypto.randomUUID(),
      operationKind: "select",
      requestFingerprint: fingerprint,
    }).returning();
    if (!operation) throw new Error("missing D487 operation receipt");
    await db.update(photoLibraryOperations).set({
      state: "completed",
      result: { ok: true },
      completedAt: new Date(),
    }).where(eq(photoLibraryOperations.id, operation.id));
    await expectRejected(db.update(photoLibraryOperations).set({ result: { ok: false } }).where(eq(photoLibraryOperations.id, operation.id)), /Failed query/);
  });

  test("returns an exact retry but never discloses a conflicting entry", async () => {
    const input = photoInput(`d487-idempotent-${Date.now()}`);
    const first = await createOwnedPhotoEntryIdempotently(db, input);
    expect(first.kind).toBe("created");
    const retry = await createOwnedPhotoEntryIdempotently(db, input);
    expect(retry.kind).toBe("replayed");
    const conflict = await createOwnedPhotoEntryIdempotently(db, {
      ...input,
      ownerUserId: otherOwnerId,
      operationId: crypto.randomUUID(),
    });
    expect(conflict).toEqual({ kind: "collision" });
  });

  test("enforces owner/agent scope and stable 48-item keyset pages", async () => {
    pageAgentId = requiredId(
      await db.insert(agents).values({ handle: `d487-page-${Date.now()}` }).returning({ id: agents.id }),
      "page agent",
    );
    const newest = new Date("2031-08-04T17:00:02.000Z");
    const tied = new Date("2031-08-04T17:00:01.000Z");
    const rows = await db.insert(ownedPhotoEntries).values([
      { ...photoInput(`d487-page-a-${Date.now()}`), id: "30000000-0000-4000-8000-000000000001", agentId: pageAgentId, createdAt: tied },
      { ...photoInput(`d487-page-b-${Date.now()}`), id: "30000000-0000-4000-8000-000000000002", agentId: pageAgentId, createdAt: tied },
      { ...photoInput(`d487-page-c-${Date.now()}`), id: "30000000-0000-4000-8000-000000000003", agentId: pageAgentId, createdAt: newest },
    ]).returning();
    const [foreign] = await db.insert(ownedPhotoEntries).values({
      ...photoInput(`d487-foreign-${Date.now()}`, otherOwnerId),
      id: "30000000-0000-4000-8000-000000000004",
      agentId: pageAgentId,
      createdAt: new Date("2031-08-04T17:00:03.000Z"),
    }).returning();
    if (!foreign) throw new Error("missing D487 foreign entry");

    const scope = { serverInstanceId, ownerUserId: ownerId, agentId: pageAgentId };
    const first = await listOwnedAgentPhotoEntries(db, { scope, limit: 1 });
    expect(first.hasMore).toBe(true);
    expect(first.nextCursor).not.toBeNull();
    const second = first.nextCursor
      ? await listOwnedAgentPhotoEntries(db, { scope, limit: 48, cursor: first.nextCursor })
      : await listOwnedAgentPhotoEntries(db, { scope, limit: 48 });
    const pageIds = [...first.entries, ...second.entries].map((entry) => entry.id);
    const expectedIds = [...rows]
      .sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime() || right.id.localeCompare(left.id))
      .map((row) => row.id);
    expect(pageIds).toEqual(expectedIds);
    expect(pageIds).not.toContain(foreign.id);
    expect(await findOwnedAgentPhotoEntry(db, scope, foreign.id)).toBeNull();
    await expectRejected(listOwnedAgentPhotoEntries(db, { scope, limit: 49 }), /1 to 48/);
  });

  test("walks the 200-photo active-library cap in bounded keyset pages", async () => {
    largePageAgentId = requiredId(
      await db.insert(agents).values({ handle: `d487-large-page-${Date.now()}` }).returning({ id: agents.id }),
      "large page agent",
    );
    const baseTime = Date.now();
    await db.insert(ownedPhotoEntries).values(
      Array.from({ length: 200 }, (_, ordinal) => ({
        ...photoInput(`d487-large-page-${ordinal}-${crypto.randomUUID()}`),
        agentId: largePageAgentId,
        createdAt: new Date(baseTime - ordinal),
      })),
    );

    const scope = { serverInstanceId, ownerUserId: ownerId, agentId: largePageAgentId };
    const seen = new Set<string>();
    const pageSizes: number[] = [];
    let cursor: OwnedPhotoListCursor | undefined;
    const startedAt = performance.now();
    do {
      const page = await listOwnedAgentPhotoEntries(
        db,
        cursor ? { scope, limit: 48, cursor } : { scope, limit: 48 },
      );
      pageSizes.push(page.entries.length);
      for (const entry of page.entries) {
        expect(seen.has(entry.id)).toBe(false);
        seen.add(entry.id);
      }
      cursor = page.nextCursor ?? undefined;
      expect(page.hasMore).toBe(cursor !== undefined);
    } while (cursor);

    expect(pageSizes).toEqual([48, 48, 48, 48, 8]);
    expect(seen.size).toBe(200);
    expect(performance.now() - startedAt).toBeLessThan(5_000);
  });

  test("fails GC closed for any current or retained historical reference", async () => {
    const input = photoInput(`d487-gc-${Date.now()}`);
    const result = await createOwnedPhotoEntryIdempotently(db, input);
    if (result.kind !== "created") throw new Error("expected D487 GC fixture creation");
    const due = new Date(Date.now() - 1_000);
    await db.update(ownedPhotoEntries).set({ deletedAt: due, purgeAfter: due }).where(eq(ownedPhotoEntries.id, result.entry.id));
    await db.update(profiles).set({ avatarRef: { kind: "generated", blobId: input.blobId } }).where(eq(profiles.id, profileId));
    expect(await isOwnedPhotoEntryEligibleForGc(db, { serverInstanceId, ownerUserId: ownerId, agentId }, result.entry.id)).toBe(false);

    await db.update(profiles).set({ avatarRef: null }).where(eq(profiles.id, profileId));
    const [revision] = await db.insert(agentPhotoSelectionRevisions).values({
      serverInstanceId,
      ownerUserId: ownerId,
      agentId,
      revision: 2,
      beforeAvatarRef: { kind: "generated", blobId: input.blobId },
      afterAvatarRef: null,
      beforeEntryId: result.entry.id,
      actorUserId: ownerId,
      origin: "manage_avatar",
      operationId: crypto.randomUUID(),
    }).returning();
    if (!revision) throw new Error("missing D487 GC revision");
    expect(await isOwnedPhotoEntryEligibleForGc(db, { serverInstanceId, ownerUserId: ownerId, agentId }, result.entry.id)).toBe(false);
    await db.delete(agentPhotoSelectionRevisions).where(eq(agentPhotoSelectionRevisions.id, revision.id));
    expect(await isOwnedPhotoEntryEligibleForGc(db, { serverInstanceId, ownerUserId: ownerId, agentId }, result.entry.id)).toBe(true);
  });
});
