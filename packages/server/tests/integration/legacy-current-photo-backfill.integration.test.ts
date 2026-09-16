import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import sharp from "sharp";
import { getProfileAvatarsRoot } from "@nautilo/config";
import {
  actors,
  agentPhotoSelectionRevisions,
  agents,
  createDirectDb,
  ensureDatabase,
  eq,
  nautiloInstanceIdentity,
  ownedPhotoEntries,
  profiles,
  users,
} from "@nautilo/db";
import { bootstrapTestDbInstance } from "@nautilo/db/testing";
import {
  backfillLegacyCurrentPhotoReferences,
  inspectLegacyAvatarMedia,
  type LegacyPhotoMediaInspection,
} from "../../src/photo-library/legacy-current-reference-backfill";

type Db = ReturnType<typeof createDirectDb>;

const sha = (value: string) => value.repeat(64).slice(0, 64);
let db: Db;
let ownerId: string;
let otherOwnerId: string;
let agentId: string;
let duplicateAgentId: string;
let profileId: string;
let duplicateProfileId: string;
let serverInstanceId: string;
let nonce: string;
const extraAgentIds: string[] = [];

function blob(label: string): string {
  return `d487-backfill-${nonce}-${label}`;
}

function inspection(ref: { kind: "generated" | "uploaded"; blobId: string }): LegacyPhotoMediaInspection {
  if (ref.blobId.endsWith("missing")) return { exists: false };
  const changed = ref.blobId.endsWith("changed");
  return {
    exists: true,
    mediaByteSize: changed ? 91 : 42,
    mediaSha256: sha(changed ? "c" : "a"),
    mediaMimeType: "image/png",
    ...(ref.kind === "generated" ? { generatedThumbnailReady: true } : {}),
  };
}

function required<T>(value: T | undefined, label: string): T {
  if (value === undefined) throw new Error(`missing ${label}`);
  return value;
}

beforeAll(async () => {
  bootstrapTestDbInstance();
  await ensureDatabase();
  db = createDirectDb(3);
  nonce = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const [identity] = await db.select().from(nautiloInstanceIdentity)
    .where(eq(nautiloInstanceIdentity.id, "self"));
  serverInstanceId = required(identity?.serverInstanceId, "server identity");
  [ownerId, otherOwnerId] = (await db.insert(users).values([
    { name: "D487 backfill owner", email: `d487-backfill-owner-${nonce}@test.invalid` },
    { name: "D487 backfill other", email: `d487-backfill-other-${nonce}@test.invalid` },
  ]).returning({ id: users.id })).map((row) => row.id) as [string, string];
  [agentId, duplicateAgentId] = (await db.insert(agents).values([
    { handle: `d487-backfill-agent-${nonce}` },
    { handle: `d487-backfill-duplicate-${nonce}` },
  ]).returning({ id: agents.id })).map((row) => row.id) as [string, string];
  await db.insert(actors).values([
    { ownerId, displayName: "Agent", kind: "agent", agentId },
    { ownerId, displayName: "Duplicate Agent", kind: "agent", agentId: duplicateAgentId },
  ]);
  [profileId, duplicateProfileId] = (await db.insert(profiles).values([
    { userId: ownerId, agentId, avatarRef: { kind: "generated", blobId: blob("agent") } },
    { userId: ownerId, agentId: duplicateAgentId, avatarRef: null },
  ]).returning({ id: profiles.id })).map((row) => row.id) as [string, string];
  await db.update(users).set({ humanAvatarRef: { kind: "uploaded", blobId: blob("human") } }).where(eq(users.id, ownerId));
}, 30_000);

afterAll(async () => {
  if (!db) return;
  await db.delete(agentPhotoSelectionRevisions).where(eq(agentPhotoSelectionRevisions.agentId, agentId));
  await db.delete(ownedPhotoEntries).where(eq(ownedPhotoEntries.ownerUserId, ownerId));
  await db.delete(profiles).where(eq(profiles.userId, ownerId));
  await db.delete(actors).where(eq(actors.ownerId, ownerId));
  await db.delete(agents).where(eq(agents.id, agentId));
  await db.delete(agents).where(eq(agents.id, duplicateAgentId));
  for (const extraAgentId of extraAgentIds) {
    await db.delete(actors).where(eq(actors.agentId, extraAgentId));
    await db.delete(agents).where(eq(agents.id, extraAgentId));
  }
  await db.delete(users).where(eq(users.id, ownerId));
  await db.delete(users).where(eq(users.id, otherOwnerId));
  await db.end();
});

describe("D487 legacy current-reference backfill", () => {
  test("refuses apply without an exact explicit Server identity", async () => {
    let missingConfirmationRejected = false;
    try {
      await backfillLegacyCurrentPhotoReferences(
        { db, inspectMedia: async (ref) => inspection(ref) },
        { dryRun: false, ownerUserIds: [ownerId] },
      );
    } catch (error) {
      expect((error as Error).message).toContain("explicit expected Server UUID");
      missingConfirmationRejected = true;
    }
    expect(missingConfirmationRejected).toBe(true);

    let wrongServerRejected = false;
    try {
      await backfillLegacyCurrentPhotoReferences(
        { db, inspectMedia: async (ref) => inspection(ref) },
        { dryRun: false, expectedServerInstanceId: randomUUID(), ownerUserIds: [ownerId] },
      );
    } catch (error) {
      expect((error as Error).message).toContain("does not match");
      wrongServerRejected = true;
    }
    expect(wrongServerRejected).toBe(true);
    let maintenanceAdmissionRejected = false;
    try {
      await backfillLegacyCurrentPhotoReferences(
        { db, inspectMedia: async (ref) => inspection(ref) },
        { dryRun: false, expectedServerInstanceId: serverInstanceId, ownerUserIds: [ownerId] },
      );
    } catch (error) {
      expect((error as Error).message).toContain("exclusive maintenance");
      maintenanceAdmissionRejected = true;
    }
    expect(maintenanceAdmissionRejected).toBe(true);
    expect(await db.select().from(ownedPhotoEntries).where(eq(ownedPhotoEntries.ownerUserId, ownerId))).toHaveLength(0);
  });

  test("dry-run classifies only canonical current refs and never discovers debris", async () => {
    const inspected: string[] = [];
    const report = await backfillLegacyCurrentPhotoReferences({
      db,
      inspectMedia: async (ref) => {
        inspected.push(ref.blobId);
        return inspection(ref);
      },
    }, { ownerUserIds: [ownerId] });
    expect(report.dryRun).toBe(true);
    expect(report.serverInstanceId).toBe(serverInstanceId);
    expect(report.counts.would_adopt).toBe(2);
    const reportedBlobIds = report.rows.map((row) => row.blobId);
    expect(reportedBlobIds.includes(blob("agent"))).toBe(true);
    expect(reportedBlobIds.includes(blob("human"))).toBe(true);
    expect(inspected).not.toContain(blob("raw-test-debris"));
    expect(await db.select().from(ownedPhotoEntries).where(eq(ownedPhotoEntries.ownerUserId, ownerId))).toHaveLength(0);
  });

  test("rejects symlinks and oversized uploads and strictly derives a missing generated thumbnail before adoption", async () => {
    const root = getProfileAvatarsRoot();
    const generatedDir = join(root, "generated");
    const uploadedDir = join(root, "uploaded");
    await mkdir(generatedDir, { recursive: true });
    await mkdir(uploadedDir, { recursive: true });
    const generatedBlobId = blob("strict-generated");
    const generatedPath = join(generatedDir, `${generatedBlobId}.png`);
    const thumbnailPath = join(generatedDir, `${generatedBlobId}.thumb.webp`);
    const targetPath = join(uploadedDir, `${blob("symlink-target")}.png`);
    const symlinkBlobId = blob("symlink");
    const symlinkPath = join(uploadedDir, `${symlinkBlobId}.png`);
    const oversizedBlobId = blob("oversized");
    const oversizedPath = join(uploadedDir, `${oversizedBlobId}.png`);
    try {
      const original = await sharp({
        create: { width: 1024, height: 1024, channels: 4, background: "#446688" },
      }).png().toBuffer();
      await writeFile(generatedPath, original);
      await writeFile(targetPath, original);
      await symlink(targetPath, symlinkPath);
      await writeFile(oversizedPath, Buffer.alloc(5 * 1024 * 1024 + 1));
      expect((await inspectLegacyAvatarMedia({ kind: "uploaded", blobId: symlinkBlobId })).exists).toBe(false);
      expect((await inspectLegacyAvatarMedia({ kind: "uploaded", blobId: oversizedBlobId })).exists).toBe(false);
      expect(await inspectLegacyAvatarMedia({ kind: "generated", blobId: generatedBlobId })).toMatchObject({
        exists: true,
        generatedThumbnailReady: false,
      });

      await db.update(profiles).set({
        avatarRef: { kind: "generated", blobId: generatedBlobId },
      }).where(eq(profiles.id, duplicateProfileId));
      const report = await backfillLegacyCurrentPhotoReferences(
        { db },
        { dryRun: false, exclusiveMaintenance: true, expectedServerInstanceId: serverInstanceId, ownerUserIds: [ownerId] },
      );
      expect(report.rows.some((row) =>
        row.blobId === generatedBlobId && row.outcome === "adopted"
      )).toBe(true);
      expect(await inspectLegacyAvatarMedia({ kind: "generated", blobId: generatedBlobId })).toMatchObject({
        exists: true,
        generatedThumbnailReady: true,
      });
    } finally {
      await db.delete(ownedPhotoEntries).where(eq(ownedPhotoEntries.blobId, generatedBlobId));
      await db.update(profiles).set({ avatarRef: null }).where(eq(profiles.id, duplicateProfileId));
      await Promise.all([
        rm(generatedPath, { force: true }),
        rm(thumbnailPath, { force: true }),
        rm(targetPath, { force: true }),
        rm(symlinkPath, { force: true }),
        rm(oversizedPath, { force: true }),
      ]);
    }
  });

  test("adopts exact Agent and Human current refs, then reruns without revising or selecting", async () => {
    let inspections = 0;
    const interruptedInspector = async (ref: { kind: "generated" | "uploaded"; blobId: string }) => {
      inspections += 1;
      // Calls 1/2 are planning; 3 commits the Agent; call 4 interrupts the
      // Human's independent batch before it can write anything.
      if (inspections === 4) throw new Error("simulated process interruption");
      return inspection(ref);
    };
    let interrupted = false;
    try {
      await backfillLegacyCurrentPhotoReferences(
        { db, inspectMedia: interruptedInspector },
        { dryRun: false, exclusiveMaintenance: true, expectedServerInstanceId: serverInstanceId, ownerUserIds: [ownerId] },
      );
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toBe("simulated process interruption");
      interrupted = true;
    }
    expect(interrupted).toBe(true);
    expect(await db.select().from(ownedPhotoEntries).where(eq(ownedPhotoEntries.ownerUserId, ownerId))).toHaveLength(1);

    const first = await backfillLegacyCurrentPhotoReferences({ db, inspectMedia: async (ref) => inspection(ref) }, { dryRun: false, exclusiveMaintenance: true, expectedServerInstanceId: serverInstanceId, ownerUserIds: [ownerId] });
    expect(first.counts.adopted).toBe(1);
    expect(first.counts.already_adopted).toBe(1);
    const entries = await db.select().from(ownedPhotoEntries).where(eq(ownedPhotoEntries.ownerUserId, ownerId));
    expect(entries).toHaveLength(2);
    expect(entries.every((entry) => entry.source === "legacy_backfill" && entry.origin === "legacy_backfill")).toBe(true);
    const [profile] = await db.select().from(profiles).where(eq(profiles.id, profileId));
    expect(profile?.avatarRef).toEqual({ kind: "generated", blobId: blob("agent") });
    expect(profile?.avatarSelectionRevision).toBe(0);
    expect(profile?.avatarLibraryRevision).toBe(1);
    expect(await db.select().from(agentPhotoSelectionRevisions).where(eq(agentPhotoSelectionRevisions.agentId, agentId))).toHaveLength(0);

    const rerun = await backfillLegacyCurrentPhotoReferences({ db, inspectMedia: async (ref) => inspection(ref) }, { dryRun: false, exclusiveMaintenance: true, expectedServerInstanceId: serverInstanceId, ownerUserIds: [ownerId] });
    expect(rerun.counts.already_adopted).toBe(2);
    const [afterRerun] = await db.select().from(profiles).where(eq(profiles.id, profileId));
    expect(afterRerun?.avatarSelectionRevision).toBe(0);
    expect(afterRerun?.avatarLibraryRevision).toBe(1);

    const changed = await backfillLegacyCurrentPhotoReferences({
      db,
      inspectMedia: async (ref) => ref.blobId === blob("agent")
        ? { exists: true, mediaByteSize: 91, mediaSha256: sha("c"), mediaMimeType: "image/png" }
        : inspection(ref),
    }, { ownerUserIds: [ownerId] });
    expect(changed.rows.some((row) => row.blobId === blob("agent") && row.reason === "changed_current_bytes")).toBe(true);
    expect((await db.select().from(ownedPhotoEntries).where(eq(ownedPhotoEntries.ownerUserId, ownerId))).find((entry) => entry.blobId === blob("agent"))?.mediaSha256).toBe(sha("a"));
  });

  test("quarantines duplicate, owner-mismatched, missing, invalid, and changed current refs without rewriting them", async () => {
    const missingAgentId = required((await db.insert(agents).values({ handle: `d487-backfill-missing-${nonce}` }).returning({ id: agents.id }))[0]?.id, "missing agent");
    extraAgentIds.push(missingAgentId);
    await db.insert(actors).values({ ownerId, displayName: "Missing Agent", kind: "agent", agentId: missingAgentId });
    const missingProfileId = required((await db.insert(profiles).values({ userId: ownerId, agentId: missingAgentId, avatarRef: { kind: "uploaded", blobId: blob("missing") } }).returning({ id: profiles.id }))[0]?.id, "missing profile");
    const mismatchAgentId = required((await db.insert(agents).values({ handle: `d487-backfill-mismatch-${nonce}` }).returning({ id: agents.id }))[0]?.id, "mismatch agent");
    extraAgentIds.push(mismatchAgentId);
    const mismatchProfileId = required((await db.insert(profiles).values({ userId: ownerId, agentId: mismatchAgentId, avatarRef: { kind: "generated", blobId: blob("mismatch") } }).returning({ id: profiles.id }))[0]?.id, "mismatch profile");
    await db.insert(actors).values({ ownerId: otherOwnerId, displayName: "Wrong owner", kind: "agent", agentId: mismatchAgentId });
    await db.update(profiles).set({ avatarRef: { kind: "generated", blobId: blob("agent") } }).where(eq(profiles.id, duplicateProfileId));
    await db.update(users).set({ humanAvatarRef: { kind: "generated", blobId: "../unsafe" } as never }).where(eq(users.id, otherOwnerId));

    const report = await backfillLegacyCurrentPhotoReferences({ db, inspectMedia: async (ref) => inspection(ref) }, { dryRun: false, exclusiveMaintenance: true, expectedServerInstanceId: serverInstanceId, ownerUserIds: [ownerId, otherOwnerId] });
    expect(report.rows.filter((row) => row.reason === "duplicate_current_ref")).toHaveLength(2);
    expect(report.rows.some((row) => row.reason === "owner_mismatch" && row.agentId === mismatchAgentId)).toBe(true);
    expect(report.rows.some((row) => row.reason === "missing_current_bytes" && row.agentId === missingAgentId)).toBe(true);
    expect(report.rows.some((row) => row.reason === "invalid_current_ref" && row.ownerUserId === otherOwnerId)).toBe(true);
    expect(await db.select().from(ownedPhotoEntries).where(eq(ownedPhotoEntries.agentId, missingAgentId))).toHaveLength(0);
    expect(await db.select().from(ownedPhotoEntries).where(eq(ownedPhotoEntries.agentId, mismatchAgentId))).toHaveLength(0);
    const [missing] = await db.select().from(profiles).where(eq(profiles.id, missingProfileId));
    expect(missing?.avatarRef).toEqual({ kind: "uploaded", blobId: blob("missing") });

    await db.delete(profiles).where(eq(profiles.id, missingProfileId));
    await db.delete(profiles).where(eq(profiles.id, mismatchProfileId));
    await db.delete(actors).where(eq(actors.agentId, mismatchAgentId));
    await db.delete(agents).where(eq(agents.id, missingAgentId));
    await db.delete(agents).where(eq(agents.id, mismatchAgentId));
  });

  test("accepts exact non-legacy ownership and rechecks duplicates introduced after discovery", async () => {
    const existingBlobId = blob("already-uploaded");
    await db.update(profiles).set({
      avatarRef: { kind: "uploaded", blobId: existingBlobId },
    }).where(eq(profiles.id, duplicateProfileId));
    await db.insert(ownedPhotoEntries).values({
      serverInstanceId,
      ownerUserId: ownerId,
      subjectKind: "agent",
      agentId: duplicateAgentId,
      avatarKind: "uploaded",
      blobId: existingBlobId,
      source: "upload",
      origin: "workbench",
      operationId: randomUUID(),
      requestFingerprint: sha("f"),
      mediaMimeType: "image/png",
      mediaByteSize: 42,
      mediaSha256: sha("a"),
    });
    const alreadyOwned = await backfillLegacyCurrentPhotoReferences(
      { db, inspectMedia: async (ref) => inspection(ref) },
      { dryRun: false, exclusiveMaintenance: true, expectedServerInstanceId: serverInstanceId, ownerUserIds: [ownerId] },
    );
    expect(alreadyOwned.rows.some((row) =>
      row.blobId === existingBlobId && row.outcome === "already_adopted"
    )).toBe(true);

    await db.delete(ownedPhotoEntries).where(eq(ownedPhotoEntries.blobId, existingBlobId));
    const foreignBlobId = blob("foreign-owned");
    await db.update(profiles).set({
      avatarRef: { kind: "uploaded", blobId: foreignBlobId },
    }).where(eq(profiles.id, duplicateProfileId));
    await db.insert(ownedPhotoEntries).values({
      serverInstanceId,
      ownerUserId: otherOwnerId,
      subjectKind: "human",
      agentId: null,
      avatarKind: "uploaded",
      blobId: foreignBlobId,
      source: "upload",
      origin: "workbench",
      operationId: randomUUID(),
      requestFingerprint: sha("e"),
      mediaMimeType: "image/png",
      mediaByteSize: 42,
      mediaSha256: sha("a"),
    });
    const foreignOwned = await backfillLegacyCurrentPhotoReferences(
      { db, inspectMedia: async (ref) => inspection(ref) },
      { dryRun: false, exclusiveMaintenance: true, expectedServerInstanceId: serverInstanceId, ownerUserIds: [ownerId] },
    );
    expect(foreignOwned.rows.some((row) =>
      row.blobId === foreignBlobId && row.reason === "duplicate_current_ref"
    )).toBe(true);
    await db.delete(ownedPhotoEntries).where(eq(ownedPhotoEntries.blobId, foreignBlobId));
    await db.update(profiles).set({ avatarRef: null }).where(eq(profiles.id, duplicateProfileId));
    const racedBlobId = blob("post-discovery-duplicate");
    await db.update(profiles).set({
      avatarRef: { kind: "uploaded", blobId: racedBlobId },
    }).where(eq(profiles.id, profileId));
    let inspections = 0;
    const raced = await backfillLegacyCurrentPhotoReferences({
      db,
      inspectMedia: async (ref) => {
        if (ref.blobId === racedBlobId) {
          inspections += 1;
          if (inspections === 2) {
            await db.update(users).set({
              humanAvatarRef: { kind: "uploaded", blobId: racedBlobId },
            }).where(eq(users.id, otherOwnerId));
          }
        }
        return inspection(ref);
      },
    }, {
      dryRun: false,
      exclusiveMaintenance: true,
      expectedServerInstanceId: serverInstanceId,
      ownerUserIds: [ownerId],
    });
    expect(raced.rows.some((row) =>
      row.blobId === racedBlobId && row.reason === "duplicate_current_ref"
    )).toBe(true);
    expect(await db.select().from(ownedPhotoEntries).where(eq(ownedPhotoEntries.blobId, racedBlobId))).toHaveLength(0);

    await db.update(profiles).set({
      avatarRef: { kind: "generated", blobId: blob("agent") },
    }).where(eq(profiles.id, profileId));
    await db.update(users).set({ humanAvatarRef: null }).where(eq(users.id, otherOwnerId));
  });

  test("shares the profile-first lock order with interactive selection without deadlock", async () => {
    const racedBlobId = blob("selection-lock-race");
    await db.update(profiles).set({
      avatarRef: { kind: "uploaded", blobId: racedBlobId },
    }).where(eq(profiles.id, profileId));
    try {
      const backfill = backfillLegacyCurrentPhotoReferences(
        { db, inspectMedia: async (ref) => inspection(ref) },
        { dryRun: false, exclusiveMaintenance: true, expectedServerInstanceId: serverInstanceId, ownerUserIds: [ownerId] },
      );
      const interactiveSelection = db.transaction(async (tx) => {
        await tx.select({ id: profiles.id }).from(profiles)
          .where(eq(profiles.id, profileId)).for("update");
        await tx.select({ id: actors.id }).from(actors)
          .where(eq(actors.agentId, agentId)).for("update");
        await tx.update(profiles).set({ avatarRef: { kind: "preset", id: "shell" } })
          .where(eq(profiles.id, profileId));
      });
      let timeoutId: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<never>((_, reject) => {
        timeoutId = setTimeout(() => reject(new Error("profile-first lock race timed out")), 2_000);
      });
      const settled = await Promise.race([
        Promise.allSettled([backfill, interactiveSelection]),
        timeout,
      ]);
      if (timeoutId) clearTimeout(timeoutId);
      expect(settled.some((result) => result.status === "fulfilled")).toBe(true);
      const [profile] = await db.select().from(profiles).where(eq(profiles.id, profileId));
      expect(profile?.avatarRef).toEqual({ kind: "preset", id: "shell" });
    } finally {
      await db.delete(ownedPhotoEntries).where(eq(ownedPhotoEntries.blobId, racedBlobId));
      await db.update(profiles).set({
        avatarRef: { kind: "generated", blobId: blob("agent") },
      }).where(eq(profiles.id, profileId));
    }
  });
});
