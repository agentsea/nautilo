import { randomUUID } from "node:crypto";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
  sql,
  users,
  type OwnedPhotoEntry,
} from "@nautilo/db";
import { bootstrapTestDbInstance } from "@nautilo/db/testing";
import {
  OwnedPhotoGarbageCollector,
  pruneAgentPhotoSelectionHistory,
  removeKnownOwnedAvatarMedia,
} from "../../src/photo-library/owned-photo-gc";

type Db = ReturnType<typeof createDirectDb>;
let db: Db;
let serverInstanceId: string;

beforeAll(async () => {
  bootstrapTestDbInstance();
  await ensureDatabase();
  db = createDirectDb(8);
  const [identity] = await db.select().from(nautiloInstanceIdentity)
    .where(eq(nautiloInstanceIdentity.id, "self")).limit(1);
  if (!identity) throw new Error("missing test server identity");
  serverInstanceId = identity.serverInstanceId;
}, 30_000);

afterAll(async () => {
  await db.end();
});

async function fixture() {
  const nonce = randomUUID();
  const [user] = await db.insert(users).values({
    name: "D487 GC owner",
    email: `d487-gc-${nonce}@test.invalid`,
    handle: `d487gc${nonce.replaceAll("-", "").slice(0, 12)}`,
  }).returning({ id: users.id });
  const [agent] = await db.insert(agents).values({ handle: `d487-gc-agent-${nonce}` }).returning({ id: agents.id });
  if (!user || !agent) throw new Error("GC fixture insert failed");
  await db.insert(actors).values({ ownerId: user.id, kind: "agent", agentId: agent.id, displayName: "D487 GC" });
  const [profile] = await db.insert(profiles).values({ userId: user.id, agentId: agent.id, avatarRef: null })
    .returning({ id: profiles.id });
  if (!profile) throw new Error("GC profile insert failed");
  return {
    userId: user.id,
    agentId: agent.id,
    profileId: profile.id,
    async cleanup() {
      await db.delete(agentPhotoSelectionRevisions).where(eq(agentPhotoSelectionRevisions.agentId, agent.id));
      await db.delete(ownedPhotoEntries).where(eq(ownedPhotoEntries.ownerUserId, user.id));
      await db.delete(profiles).where(eq(profiles.agentId, agent.id));
      await db.delete(actors).where(eq(actors.agentId, agent.id));
      await db.delete(agents).where(eq(agents.id, agent.id));
      await db.delete(users).where(eq(users.id, user.id));
    },
  };
}

async function dueEntry(
  owner: Awaited<ReturnType<typeof fixture>>,
  input: { kind?: "uploaded" | "generated"; subjectKind?: "agent" | "human"; now: Date },
): Promise<OwnedPhotoEntry> {
  const kind = input.kind ?? "uploaded";
  const deletedAt = new Date(input.now.getTime() - 31 * 24 * 60 * 60 * 1000);
  const [entry] = await db.insert(ownedPhotoEntries).values({
    serverInstanceId,
    ownerUserId: owner.userId,
    subjectKind: input.subjectKind ?? "agent",
    agentId: input.subjectKind === "human" ? null : owner.agentId,
    avatarKind: kind,
    blobId: `gc-${randomUUID()}`,
    source: "upload",
    origin: "mobile",
    operationId: randomUUID(),
    requestFingerprint: "a".repeat(64),
    mediaMimeType: "image/png",
    mediaByteSize: 12,
    mediaSha256: "b".repeat(64),
    deletedAt,
    purgeAfter: new Date(input.now.getTime() - 1),
  }).returning();
  if (!entry) throw new Error("GC entry insert failed");
  return entry;
}

function blobSnapshot(entries: OwnedPhotoEntry[]) {
  const variants = new Map(entries.map((entry) => [entry.id, entry.avatarKind === "generated" ? 2 : 1]));
  return {
    variants,
    remove: async (entry: OwnedPhotoEntry) => {
      const expected = entry.avatarKind === "generated" ? 2 : 1;
      const removed = variants.get(entry.id) ?? 0;
      variants.set(entry.id, 0);
      return { removed, missing: expected - removed };
    },
  };
}

describe("D487 reference-safe owned-photo garbage collection", () => {
  test("dry-run reports eligibility without claiming rows or touching bytes", async () => {
    const owner = await fixture();
    try {
      const now = new Date("2026-08-04T12:00:00.000Z");
      const entry = await dueEntry(owner, { now });
      const blobs = blobSnapshot([entry]);
      const report = await new OwnedPhotoGarbageCollector({ db, now: () => now, removeMedia: blobs.remove })
        .run({ dryRun: true, batchSize: 25 });
      expect(report).toMatchObject({ scanned: 1, eligible: 1, claimed: 0, rowsPurged: 0, filesRemoved: 0 });
      expect(blobs.variants.get(entry.id)).toBe(1);
      const [stored] = await db.select().from(ownedPhotoEntries).where(eq(ownedPhotoEntries.id, entry.id));
      expect(stored).toMatchObject({ gcClaimToken: null, gcClaimedAt: null });
    } finally { await owner.cleanup(); }
  });

  test("current Agent and Human pointers fail closed", async () => {
    const owner = await fixture();
    try {
      const now = new Date("2026-08-04T12:00:00.000Z");
      const agentEntry = await dueEntry(owner, { now });
      const humanEntry = await dueEntry(owner, { now, subjectKind: "human" });
      await db.update(profiles).set({ avatarRef: { kind: "uploaded", blobId: agentEntry.blobId } })
        .where(eq(profiles.id, owner.profileId));
      await db.update(users).set({ humanAvatarRef: { kind: "uploaded", blobId: humanEntry.blobId } })
        .where(eq(users.id, owner.userId));
      const report = await new OwnedPhotoGarbageCollector({ db, now: () => now, removeMedia: blobSnapshot([agentEntry, humanEntry]).remove })
        .run({ dryRun: false, batchSize: 25 });
      expect(report).toMatchObject({ scanned: 2, protectedCurrent: 2, rowsPurged: 0 });
    } finally { await owner.cleanup(); }
  });

  test("retained history protects a deleted entry", async () => {
    const owner = await fixture();
    try {
      const now = new Date("2026-08-04T12:00:00.000Z");
      const entry = await dueEntry(owner, { now });
      await db.insert(agentPhotoSelectionRevisions).values({
        serverInstanceId, ownerUserId: owner.userId, agentId: owner.agentId,
        revision: 1, beforeAvatarRef: null,
        afterAvatarRef: { kind: "uploaded", blobId: entry.blobId },
        beforeEntryId: null, afterEntryId: entry.id, actorUserId: owner.userId,
        origin: "mobile", operationId: randomUUID(), createdAt: now,
      });
      await db.update(profiles).set({ avatarSelectionRevision: 1 }).where(eq(profiles.id, owner.profileId));
      const report = await new OwnedPhotoGarbageCollector({ db, now: () => now, removeMedia: blobSnapshot([entry]).remove })
        .run({ dryRun: false });
      expect(report).toMatchObject({ protectedHistory: 1, rowsPurged: 0 });
    } finally { await owner.cleanup(); }
  });

  test("a restore or newly selected pointer that wins before claim prevents cleanup", async () => {
    const owner = await fixture();
    try {
      const now = new Date("2026-08-04T12:00:00.000Z");
      const restored = await dueEntry(owner, { now });
      const selected = await dueEntry(owner, { now });
      const report = await new OwnedPhotoGarbageCollector({
        db,
        now: () => now,
        removeMedia: blobSnapshot([restored, selected]).remove,
        beforeClaim: async (entry) => {
          if (entry.id === restored.id) {
            await db.update(ownedPhotoEntries).set({ deletedAt: null, purgeAfter: null })
              .where(eq(ownedPhotoEntries.id, entry.id));
          } else {
            await db.update(profiles).set({ avatarRef: { kind: "uploaded", blobId: entry.blobId } })
              .where(eq(profiles.id, owner.profileId));
          }
        },
      }).run({ dryRun: false });
      expect(report).toMatchObject({ stateChanged: 1, protectedCurrent: 1, rowsPurged: 0 });
    } finally { await owner.cleanup(); }
  });

  test("a selection holding subject authority and entry wins before GC observes either", async () => {
    const owner = await fixture();
    try {
      const now = new Date("2026-08-04T12:00:00.000Z");
      const entry = await dueEntry(owner, { now });
      let markSelectionReady!: () => void;
      const selectionReady = new Promise<void>((resolve) => { markSelectionReady = resolve; });
      let releaseSelection!: () => void;
      const selectionMayCommit = new Promise<void>((resolve) => { releaseSelection = resolve; });

      const selection = db.transaction(async (tx) => {
        await tx.execute(sql`SELECT id FROM profiles WHERE id = ${owner.profileId} FOR UPDATE`);
        await tx.execute(sql`SELECT id FROM owned_photo_entries WHERE id = ${entry.id} FOR UPDATE`);
        await tx.update(profiles).set({ avatarRef: { kind: "uploaded", blobId: entry.blobId } })
          .where(eq(profiles.id, owner.profileId));
        markSelectionReady();
        await selectionMayCommit;
      });
      await selectionReady;

      let markGcAtClaim!: () => void;
      const gcAtClaim = new Promise<void>((resolve) => { markGcAtClaim = resolve; });
      const gc = new OwnedPhotoGarbageCollector({
        db,
        now: () => now,
        removeMedia: blobSnapshot([entry]).remove,
        beforeClaim: async () => { markGcAtClaim(); },
      }).run({ dryRun: false });
      await gcAtClaim;
      // Let GC enter its transaction while selection still owns both locks.
      // Correct authority-first ordering blocks; the former pointer-first
      // query could observe the old pointer and later resume behind entry.
      await Bun.sleep(50);
      releaseSelection();
      await selection;

      const report = await gc;
      expect(report).toMatchObject({ protectedCurrent: 1, claimed: 0, rowsPurged: 0 });
      expect(await db.select().from(ownedPhotoEntries).where(eq(ownedPhotoEntries.id, entry.id))).toHaveLength(1);
    } finally { await owner.cleanup(); }
  });

  test("missing bytes are reconciliation evidence and do not block exact-row finalization", async () => {
    const owner = await fixture();
    try {
      const now = new Date("2026-08-04T12:00:00.000Z");
      const entry = await dueEntry(owner, { now, kind: "generated" });
      const report = await new OwnedPhotoGarbageCollector({
        db, now: () => now, removeMedia: async () => ({ removed: 0, missing: 2 }),
      }).run({ dryRun: false });
      expect(report).toMatchObject({ claimed: 1, rowsPurged: 1, filesMissing: 2, filesRemoved: 0 });
      expect(await db.select().from(ownedPhotoEntries).where(eq(ownedPhotoEntries.id, entry.id))).toHaveLength(0);
    } finally { await owner.cleanup(); }
  });

  test("filesystem cleanup removes only the row's known original and thumbnail variants", async () => {
    const owner = await fixture();
    const root = await mkdtemp(join(tmpdir(), "d487-gc-media-"));
    try {
      const now = new Date("2026-08-04T12:00:00.000Z");
      const entry = await dueEntry(owner, { now, kind: "generated" });
      await mkdir(root, { recursive: true });
      await Promise.all([
        writeFile(join(root, `${entry.blobId}.png`), "full"),
        writeFile(join(root, `${entry.blobId}.thumb.webp`), "thumb"),
        writeFile(join(root, `${entry.blobId}.operator-note`), "must survive"),
      ]);
      expect(await removeKnownOwnedAvatarMedia(entry, root)).toEqual({ removed: 2, missing: 0 });
      expect(await pathExists(join(root, `${entry.blobId}.png`))).toBe(false);
      expect(await pathExists(join(root, `${entry.blobId}.thumb.webp`))).toBe(false);
      expect(await pathExists(join(root, `${entry.blobId}.operator-note`))).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
      await owner.cleanup();
    }
  });

  test("interrupted cleanup retains its lease and a stale-lease restart reconciles safely", async () => {
    const owner = await fixture();
    try {
      const startedAt = new Date("2026-08-04T12:00:00.000Z");
      const entry = await dueEntry(owner, { now: startedAt });
      const blobs = blobSnapshot([entry]);
      let interrupt = true;
      const remove = async (row: OwnedPhotoEntry) => {
        const result = await blobs.remove(row);
        if (interrupt) { interrupt = false; throw new Error("worker stopped after unlink"); }
        return result;
      };
      const first = await new OwnedPhotoGarbageCollector({ db, now: () => startedAt, removeMedia: remove })
        .run({ dryRun: false });
      expect(first).toMatchObject({ claimed: 1, cleanupInterrupted: 1, rowsPurged: 0 });
      const [claimed] = await db.select().from(ownedPhotoEntries).where(eq(ownedPhotoEntries.id, entry.id));
      expect(claimed?.gcClaimToken).not.toBeNull();

      const freshLease = await new OwnedPhotoGarbageCollector({
        db, now: () => new Date(startedAt.getTime() + 14 * 60 * 1000), removeMedia: remove,
      }).run({ dryRun: false });
      expect(freshLease.scanned).toBe(0);

      const restarted = await new OwnedPhotoGarbageCollector({
        db, now: () => new Date(startedAt.getTime() + 16 * 60 * 1000), removeMedia: remove,
      }).run({ dryRun: false });
      expect(restarted).toMatchObject({ staleClaimsRecovered: 1, rowsPurged: 1, filesMissing: 1 });
    } finally { await owner.cleanup(); }
  });

  test("one invocation never claims more than 25 rows", async () => {
    const owner = await fixture();
    try {
      const now = new Date("2026-08-04T12:00:00.000Z");
      const entries = await Promise.all(Array.from({ length: 30 }, () => dueEntry(owner, { now })));
      const blobs = blobSnapshot(entries);
      const first = await new OwnedPhotoGarbageCollector({ db, now: () => now, removeMedia: blobs.remove })
        .run({ dryRun: false, batchSize: 25 });
      expect(first).toMatchObject({ scanned: 25, claimed: 25, rowsPurged: 25 });
      const second = await new OwnedPhotoGarbageCollector({ db, now: () => now, removeMedia: blobs.remove })
        .run({ dryRun: false, batchSize: 25 });
      expect(second).toMatchObject({ scanned: 5, claimed: 5, rowsPurged: 5 });
      let batchError: unknown;
      try {
        await new OwnedPhotoGarbageCollector({ db }).run({ dryRun: true, batchSize: 26 });
      } catch (error) {
        batchError = error;
      }
      expect(batchError).toBeInstanceOf(Error);
      expect((batchError as Error).message).toContain("1 to 25");
    } finally { await owner.cleanup(); }
  });

  test("history pruning applies latest-100 and 90-day bounds but retains current revision", async () => {
    const owner = await fixture();
    try {
      const now = new Date("2026-08-04T12:00:00.000Z");
      const values = Array.from({ length: 102 }, (_, index) => ({
        serverInstanceId, ownerUserId: owner.userId, agentId: owner.agentId,
        revision: index + 1, beforeAvatarRef: null, afterAvatarRef: { kind: "preset" as const, id: `avatar-${index + 1}` },
        beforeEntryId: null, afterEntryId: null, actorUserId: owner.userId,
        origin: "workbench" as const, operationId: randomUUID(),
        createdAt: index === 0 || index === 101
          ? new Date(now.getTime() - 91 * 24 * 60 * 60 * 1000)
          : new Date(now.getTime() - index * 1000),
      }));
      await db.insert(agentPhotoSelectionRevisions).values(values);
      await db.update(profiles).set({ avatarSelectionRevision: 102 }).where(eq(profiles.id, owner.profileId));
      expect(await pruneAgentPhotoSelectionHistory(db, { now, dryRun: true })).toEqual({ eligible: 2, pruned: 0 });
      expect(await db.select().from(agentPhotoSelectionRevisions).where(eq(agentPhotoSelectionRevisions.agentId, owner.agentId))).toHaveLength(102);
      expect(await pruneAgentPhotoSelectionHistory(db, { now, dryRun: false })).toEqual({ eligible: 2, pruned: 2 });
      const retained = await db.select().from(agentPhotoSelectionRevisions)
        .where(eq(agentPhotoSelectionRevisions.agentId, owner.agentId));
      expect(retained).toHaveLength(100);
      expect(retained.some((revision) => revision.revision === 102)).toBe(true);
      expect(await pruneAgentPhotoSelectionHistory(db, { now, dryRun: true })).toEqual({ eligible: 0, pruned: 0 });
    } finally { await owner.cleanup(); }
  });
});

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
