import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { access, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import {
  actors,
  agents,
  and,
  createDirectDb,
  ensureDatabase,
  eq,
  groupMembers,
  groupRoles,
  groups,
  nautiloInstanceIdentity,
  ownedPhotoEntries,
  photoLibraryOperations,
  profiles,
  roles,
  seedTrustPersonal,
  serverMaintenance,
  sessionMessages,
  sessions,
  users,
} from "@nautilo/db";
import { bootstrapTestDbInstance } from "@nautilo/db/testing";
import { AgentPhotoLibraryReadService } from "../../src/lib/agent-photo-library-read-service";
import { inspectLegacyAvatarMedia } from "../../src/photo-library/legacy-current-reference-backfill";
import { backfillLegacyManageAvatarHistory } from "../../src/photo-library/legacy-manage-avatar-history-backfill";
import {
  applyPhotoLibraryRecovery,
  previewPhotoLibraryRecovery,
  type PhotoLibraryRecoveryDependencies,
  type PhotoLibraryRecoveryTarget,
} from "../../src/photo-library/operator-photo-recovery";
import type { PhotoLibraryRecoveryAuditEvent } from "../../src/photo-library/operator-photo-recovery-audit";

type Db = ReturnType<typeof createDirectDb>;

let db: Db;
let root: string;
let originalMediaRoot: string | undefined;
let serverInstanceId: string;
let operatorUserId: string;
let operatorActorId: string;
let ownerUserId: string;
let agentId: string;
let profileId: string;
let ownerGroupId: string;
let clockMs: number;
let audits: PhotoLibraryRecoveryAuditEvent[];
const historySessionIds: string[] = [];
const nonce = `${Date.now()}-${Math.random().toString(36).slice(2)}`;

function target(blobId: string, overrides: Partial<PhotoLibraryRecoveryTarget> = {}): PhotoLibraryRecoveryTarget {
  return {
    serverInstanceId,
    operatorUserId,
    ownerUserId,
    agentId,
    kind: "uploaded",
    blobId,
    ...overrides,
  };
}

function dependencies(): PhotoLibraryRecoveryDependencies {
  return {
    db,
    now: () => new Date(clockMs),
    audit: (event) => { audits.push(event); },
  };
}

function blob(label: string): string {
  return `d487-recovery-${nonce}-${label}`;
}

function uploadedPath(blobId: string): string {
  return join(root, "profile-avatars", "uploaded", `${blobId}.png`);
}

async function writeUploaded(blobId: string, color: string): Promise<void> {
  const bytes = await sharp({
    create: { width: 256, height: 256, channels: 4, background: color },
  }).png().toBuffer();
  await writeFile(uploadedPath(blobId), bytes, { mode: 0o600 });
}

async function writeGeneratedOriginal(blobId: string, color: string): Promise<void> {
  const bytes = await sharp({
    create: { width: 1024, height: 1024, channels: 4, background: color },
  }).png().toBuffer();
  await writeFile(join(root, "profile-avatars", "generated", `${blobId}.png`), bytes, { mode: 0o600 });
}

beforeAll(async () => {
  bootstrapTestDbInstance();
  await ensureDatabase();
  db = createDirectDb(3);
  originalMediaRoot = process.env["NAUTILO_MEDIA_ROOT"];
  root = await mkdtemp(join(tmpdir(), "d487-photo-recovery-"));
  process.env["NAUTILO_MEDIA_ROOT"] = root;
  await mkdir(join(root, "profile-avatars", "uploaded"), { recursive: true });
  await mkdir(join(root, "profile-avatars", "generated"), { recursive: true });
  const [identity] = await db.select({ id: nautiloInstanceIdentity.serverInstanceId })
    .from(nautiloInstanceIdentity).where(eq(nautiloInstanceIdentity.id, "self"));
  if (!identity) throw new Error("test-cruft server identity is missing");
  serverInstanceId = identity.id;
  const insertedUsers = await db.insert(users).values([
    { name: "D487 recovery operator", email: `d487-recovery-operator-${nonce}@test.invalid` },
    { name: "D487 recovery owner", email: `d487-recovery-owner-${nonce}@test.invalid` },
  ]).returning({ id: users.id });
  operatorUserId = insertedUsers[0]!.id;
  ownerUserId = insertedUsers[1]!.id;
  const [agent] = await db.insert(agents).values({ handle: `d487-recovery-${nonce}` }).returning({ id: agents.id });
  if (!agent) throw new Error("test Agent was not created");
  agentId = agent.id;
  const insertedActors = await db.insert(actors).values([
    { ownerId: operatorUserId, displayName: "Recovery Operator", kind: "user" },
    { ownerId: ownerUserId, displayName: "Recovery Owner", kind: "user" },
    { ownerId: ownerUserId, displayName: "Recovery Agent", kind: "agent", agentId },
  ]).returning({ id: actors.id, ownerId: actors.ownerId });
  operatorActorId = insertedActors.find((actor) => actor.ownerId === operatorUserId)!.id;
  const [profile] = await db.insert(profiles).values({
    userId: ownerUserId,
    agentId,
    avatarRef: { kind: "preset", id: "shell" },
  }).returning({ id: profiles.id });
  if (!profile) throw new Error("test profile was not created");
  profileId = profile.id;
  // A freshly migrated scratch database has schema but no trust catalogue.
  // Seed the same canonical Owner role/group contract production boot uses so
  // this test cannot pass merely because another suite previously dirtied the
  // shared test-cruft database.
  await seedTrustPersonal(operatorUserId, "D487 recovery operator");
  const [ownerGroup] = await db.select({ id: groups.id }).from(groups)
    .innerJoin(groupRoles, eq(groupRoles.groupId, groups.id))
    .innerJoin(roles, eq(roles.id, groupRoles.roleId))
    .where(eq(groups.type, "owners")).limit(1);
  if (!ownerGroup) throw new Error("test-cruft Owner group is missing");
  ownerGroupId = ownerGroup.id;
  await db.insert(groupMembers).values({
    groupId: ownerGroupId,
    userId: operatorUserId,
    grantedBy: operatorActorId,
  }).onConflictDoNothing();
  clockMs = Date.now();
  audits = [];
}, 30_000);

afterAll(async () => {
  if (!db) return;
  await db.update(serverMaintenance).set({
    state: "normal",
    operationId: null,
    leaseExpiresAt: null,
    hardExpiresAt: null,
    updatedAt: new Date(),
  });
  await db.delete(ownedPhotoEntries).where(eq(ownedPhotoEntries.ownerUserId, ownerUserId));
  for (const sessionId of historySessionIds) {
    await db.delete(sessionMessages).where(eq(sessionMessages.sessionId, sessionId));
    await db.delete(sessions).where(eq(sessions.id, sessionId));
  }
  await db.delete(profiles).where(eq(profiles.id, profileId));
  await db.delete(groupMembers).where(eq(groupMembers.userId, operatorUserId));
  await db.delete(actors).where(eq(actors.ownerId, operatorUserId));
  await db.delete(actors).where(eq(actors.ownerId, ownerUserId));
  await db.delete(agents).where(eq(agents.id, agentId));
  await db.delete(users).where(eq(users.id, operatorUserId));
  await db.delete(users).where(eq(users.id, ownerUserId));
  await db.end();
  await rm(root, { recursive: true, force: true });
  if (originalMediaRoot === undefined) delete process.env["NAUTILO_MEDIA_ROOT"];
  else process.env["NAUTILO_MEDIA_ROOT"] = originalMediaRoot;
}, 30_000);

describe("D487 explicit operator photo recovery", () => {
  test("boot history recovers only an exact manage_avatar success for its canonical owner and Agent", async () => {
    const blobId = randomUUID();
    await writeGeneratedOriginal(blobId, "#0891b2");
    const [session] = await db.insert(sessions).values({
      threadId: `d487-history-${nonce}`,
      ownerId: ownerUserId,
      agentId,
    }).returning({ id: sessions.id });
    if (!session) throw new Error("history test session was not created");
    historySessionIds.push(session.id);
    await db.insert(sessionMessages).values([
      {
        sessionId: session.id,
        role: "tool",
        toolName: "manage_avatar",
        content: `Avatar set to generated image (${blobId}).`,
      },
      {
        sessionId: session.id,
        role: "tool",
        toolName: "manage_avatar",
        content: `Almost Avatar set to generated image (${randomUUID()}).`,
      },
    ]);
    const before = await db.select().from(profiles).where(eq(profiles.id, profileId));

    const first = await backfillLegacyManageAvatarHistory({ db });
    expect(first.adopted).toBeGreaterThanOrEqual(1);
    const [entry] = await db.select().from(ownedPhotoEntries).where(eq(ownedPhotoEntries.blobId, blobId));
    expect(entry).toMatchObject({
      ownerUserId,
      agentId,
      source: "legacy_backfill",
      origin: "legacy_backfill",
      deletedAt: null,
    });
    expect((await db.select().from(profiles).where(eq(profiles.id, profileId)))[0]?.avatarRef)
      .toEqual(before[0]?.avatarRef);
    const second = await backfillLegacyManageAvatarHistory({ db });
    expect(second.alreadyAdopted).toBeGreaterThanOrEqual(1);
    expect(await db.select().from(ownedPhotoEntries).where(eq(ownedPhotoEntries.blobId, blobId))).toHaveLength(1);
  });

  test("dry-run leaves a missing generated thumbnail untouched and apply rebuilds it", async () => {
    const blobId = blob("generated-without-thumbnail");
    const generatedTarget = target(blobId, { kind: "generated" });
    const thumbnailPath = join(root, "profile-avatars", "generated", `${blobId}.thumb.webp`);
    await writeGeneratedOriginal(blobId, "#9333ea");

    const preview = await previewPhotoLibraryRecovery(dependencies(), generatedTarget);
    expect(preview).toMatchObject({ outcome: "would_adopt" });
    expect(access(thumbnailPath)).rejects.toBeDefined();

    const applied = await applyPhotoLibraryRecovery(dependencies(), generatedTarget, preview.confirmToken!);
    expect(applied).toMatchObject({ outcome: "adopted" });
    const metadata = await sharp(thumbnailPath).metadata();
    expect(metadata).toMatchObject({ format: "webp", width: 256, height: 256 });
  });

  test("dry-runs by default, adopts unselected under maintenance, and exactly replays one entry", async () => {
    audits = [];
    const blobId = blob("happy");
    await writeUploaded(blobId, "#7c3aed");
    const before = await db.select().from(profiles).where(eq(profiles.id, profileId));
    const preview = await previewPhotoLibraryRecovery(dependencies(), target(blobId));
    expect(preview).toMatchObject({ action: "dry_run", outcome: "would_adopt", source: "operator_adoption" });
    expect(typeof preview.confirmToken).toBe("string");
    expect(preview).not.toHaveProperty("path");
    expect(await db.select().from(ownedPhotoEntries).where(eq(ownedPhotoEntries.blobId, blobId))).toHaveLength(0);

    const applied = await applyPhotoLibraryRecovery(dependencies(), target(blobId), preview.confirmToken!);
    expect(applied).toMatchObject({ action: "apply", outcome: "adopted" });
    expect(typeof applied.entryId).toBe("string");
    const replay = await applyPhotoLibraryRecovery(dependencies(), target(blobId), preview.confirmToken!);
    expect(replay).toMatchObject({ outcome: "already_adopted", entryId: applied.entryId });
    const rows = await db.select().from(ownedPhotoEntries).where(eq(ownedPhotoEntries.blobId, blobId));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      source: "operator_adoption",
      origin: "operator_adoption",
      operationId: preview.operationId,
      ownerUserId,
      agentId,
    });
    const [after] = await db.select().from(profiles).where(eq(profiles.id, profileId));
    expect(after?.avatarRef).toEqual(before[0]?.avatarRef);
    expect(after?.avatarSelectionRevision).toBe(before[0]?.avatarSelectionRevision);
    expect(after?.avatarLibraryRevision).toBe((before[0]?.avatarLibraryRevision ?? 0) + 1);
    const [maintenance] = await db.select().from(serverMaintenance);
    expect(maintenance?.state).toBe("normal");
    expect(audits.map((event) => event.outcome)).toEqual(["would_adopt", "adopted", "already_adopted"]);
  });

  test("refuses changed, missing, expired, and foreign confirmations without ownership", async () => {
    const changed = blob("changed");
    await writeUploaded(changed, "#0ea5e9");
    const changedPreview = await previewPhotoLibraryRecovery(dependencies(), target(changed));
    await writeUploaded(changed, "#dc2626");
    expect(await applyPhotoLibraryRecovery(dependencies(), target(changed), changedPreview.confirmToken!))
      .toMatchObject({ outcome: "refused", reason: "media_changed" });

    const missing = blob("missing");
    await writeUploaded(missing, "#22c55e");
    const missingPreview = await previewPhotoLibraryRecovery(dependencies(), target(missing));
    await rm(uploadedPath(missing));
    expect(await applyPhotoLibraryRecovery(dependencies(), target(missing), missingPreview.confirmToken!))
      .toMatchObject({ outcome: "refused", reason: "missing_or_invalid_media" });

    const expired = blob("expired");
    await writeUploaded(expired, "#eab308");
    const expiredPreview = await previewPhotoLibraryRecovery(dependencies(), target(expired));
    clockMs += 10 * 60 * 1000 + 1;
    expect(await applyPhotoLibraryRecovery(dependencies(), target(expired), expiredPreview.confirmToken!))
      .toMatchObject({ outcome: "refused", reason: "confirmation_expired" });
    clockMs = Date.now();

    const foreign = blob("foreign");
    const other = blob("other-target");
    await writeUploaded(foreign, "#f97316");
    await writeUploaded(other, "#14b8a6");
    const foreignPreview = await previewPhotoLibraryRecovery(dependencies(), target(foreign));
    expect(await applyPhotoLibraryRecovery(dependencies(), target(other), foreignPreview.confirmToken!))
      .toMatchObject({ outcome: "refused", reason: "confirmation_mismatch" });

    for (const id of [changed, missing, expired, foreign, other]) {
      expect(await db.select().from(ownedPhotoEntries).where(eq(ownedPhotoEntries.blobId, id))).toHaveLength(0);
    }
  });

  test("refuses existing ownership and any current Human or Agent reference", async () => {
    const duplicate = blob("duplicate");
    await writeUploaded(duplicate, "#9333ea");
    await db.insert(ownedPhotoEntries).values({
      serverInstanceId,
      ownerUserId,
      subjectKind: "agent",
      agentId,
      avatarKind: "uploaded",
      blobId: duplicate,
      source: "upload",
      origin: "workbench",
      operationId: randomUUID(),
      requestFingerprint: "a".repeat(64),
      mediaMimeType: "image/png",
      mediaByteSize: 42,
      mediaSha256: "b".repeat(64),
    });
    expect(await previewPhotoLibraryRecovery(dependencies(), target(duplicate)))
      .toMatchObject({ outcome: "refused", reason: "existing_ownership_conflict" });
    await db.delete(ownedPhotoEntries).where(eq(ownedPhotoEntries.blobId, duplicate));

    const referenced = blob("referenced");
    await writeUploaded(referenced, "#db2777");
    await db.update(profiles).set({ avatarRef: { kind: "uploaded", blobId: referenced } }).where(eq(profiles.id, profileId));
    expect(await previewPhotoLibraryRecovery(dependencies(), target(referenced)))
      .toMatchObject({ outcome: "refused", reason: "current_reference_conflict" });
    await db.update(profiles).set({ avatarRef: { kind: "preset", id: "shell" } }).where(eq(profiles.id, profileId));
  });

  test("ordinary reads never disclose quarantine and reveal only the adopted target scope", async () => {
    const quarantined = blob("quarantine");
    const adopted = blob("visible-after-adoption");
    await writeUploaded(quarantined, "#64748b");
    await writeUploaded(adopted, "#0891b2");
    const readService = new AgentPhotoLibraryReadService({
      db,
      blobExists: () => true,
      now: () => new Date(clockMs),
    });
    const authority = { serverInstanceId, viewerUserId: ownerUserId, ownerUserId, agentId };
    const before = await readService.list(authority, { projection: "recent", limit: 48 });
    expect(await db.select().from(ownedPhotoEntries).where(eq(ownedPhotoEntries.blobId, quarantined))).toHaveLength(0);

    const preview = await previewPhotoLibraryRecovery(dependencies(), target(adopted));
    const applied = await applyPhotoLibraryRecovery(dependencies(), target(adopted), preview.confirmToken!);
    expect(applied.outcome).toBe("adopted");
    if (!applied.entryId) throw new Error("recovery apply did not return its adopted entry");
    const after = await readService.list(authority, { projection: "recent", limit: 48 });
    const entry = after.entries.find((candidate) => candidate.id === applied.entryId);
    expect(entry).toMatchObject({ isCurrent: false, source: "operator_adoption" });
    expect(after.entries.map((candidate) => candidate.id)).toEqual([
      applied.entryId,
      ...before.entries.map((candidate) => candidate.id),
    ]);
    expect(await db.select().from(ownedPhotoEntries).where(eq(ownedPhotoEntries.blobId, quarantined))).toHaveLength(0);
  });

  test("counts live create reservations before adopting into the active capacity", async () => {
    const reserved = blob("reserved-capacity");
    await writeUploaded(reserved, "#be123c");
    const existing = Array.from({ length: 199 }, (_, index) => ({
      serverInstanceId,
      ownerUserId,
      subjectKind: "agent" as const,
      agentId,
      avatarKind: "uploaded" as const,
      blobId: blob(`capacity-${index}`),
      source: "upload" as const,
      origin: "workbench" as const,
      operationId: randomUUID(),
      requestFingerprint: "c".repeat(64),
      mediaMimeType: "image/png",
      mediaByteSize: 1,
      mediaSha256: "d".repeat(64),
    }));
    const reservationOperationId = randomUUID();
    try {
      await db.insert(ownedPhotoEntries).values(existing);
      await db.insert(photoLibraryOperations).values({
        serverInstanceId,
        viewerUserId: ownerUserId,
        ownerUserId,
        agentId,
        operationId: reservationOperationId,
        operationKind: "create",
        requestFingerprint: "e".repeat(64),
        state: "pending",
        reservedSlots: 2,
        reservationExpiresAt: new Date(clockMs + 60_000),
        reservationLeaseToken: randomUUID(),
      });
      const preview = await previewPhotoLibraryRecovery(dependencies(), target(reserved));
      expect(preview.outcome).toBe("would_adopt");
      expect(await applyPhotoLibraryRecovery(dependencies(), target(reserved), preview.confirmToken!))
        .toMatchObject({ outcome: "refused", reason: "library_capacity_reached" });
      expect(await db.select().from(ownedPhotoEntries).where(eq(ownedPhotoEntries.blobId, reserved)))
        .toHaveLength(0);
    } finally {
      await db.delete(photoLibraryOperations).where(eq(photoLibraryOperations.operationId, reservationOperationId));
      await db.delete(ownedPhotoEntries).where(eq(ownedPhotoEntries.ownerUserId, ownerUserId));
    }
  });

  test("revalidates and locks current Owner authority in the committing transaction", async () => {
    const revoked = blob("owner-revoked-during-preflight");
    await writeUploaded(revoked, "#4338ca");
    const preview = await previewPhotoLibraryRecovery(dependencies(), target(revoked));
    let inspections = 0;
    try {
      const applyDependencies: PhotoLibraryRecoveryDependencies = {
        ...dependencies(),
        inspectMedia: async (ref) => {
          const inspected = await inspectLegacyAvatarMedia(ref);
          inspections += 1;
          if (inspections === 1) {
            await db.delete(groupMembers).where(and(
              eq(groupMembers.groupId, ownerGroupId),
              eq(groupMembers.userId, operatorUserId),
            ));
          }
          return inspected;
        },
      };
      expect(await applyPhotoLibraryRecovery(applyDependencies, target(revoked), preview.confirmToken!))
        .toMatchObject({ outcome: "refused", reason: "operator_not_owner" });
      expect(await db.select().from(ownedPhotoEntries).where(eq(ownedPhotoEntries.blobId, revoked)))
        .toHaveLength(0);
    } finally {
      await db.insert(groupMembers).values({
        groupId: ownerGroupId,
        userId: operatorUserId,
        grantedBy: operatorActorId,
      }).onConflictDoNothing();
    }
  });
});
