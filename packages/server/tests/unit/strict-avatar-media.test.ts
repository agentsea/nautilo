import { createHash, randomUUID } from "node:crypto";
import { afterAll, describe, expect, test } from "bun:test";
import { mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import sharp from "sharp";
import { getAvatarBlobDir } from "../../src/routes/_helpers/avatar";
import { hasCompleteOwnedAvatarMedia, readStrictOwnedAvatarMedia } from "../../src/photo-library/strict-avatar-media";
import {
  deriveOwnedAvatarBlobId,
  discardOwnedAvatarStaging,
  discardPublishedOwnedAvatarAfterNoCommit,
  publishStagedOwnedAvatar,
  stageOwnedAvatar,
} from "../../src/photo-library/owned-avatar-staging";
import {
  AgentPhotoLibraryCreateCoordinator,
  type AgentPhotoLibraryCreateService,
} from "../../src/lib/agent-photo-library-create-coordinator";

const blobs: string[] = [];

function digest(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function expectRejected(action: () => Promise<unknown>, message: string): Promise<void> {
  try {
    await action();
  } catch (error) {
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain(message);
    return;
  }
  throw new Error(`Expected rejection containing ${message}`);
}

async function writeUploaded(bytes: Buffer): Promise<string> {
  const blobId = `d487-strict-${randomUUID()}`;
  blobs.push(blobId);
  await mkdir(getAvatarBlobDir("uploaded"), { recursive: true });
  await writeFile(join(getAvatarBlobDir("uploaded"), `${blobId}.png`), bytes);
  return blobId;
}

afterAll(async () => {
  await Promise.all(blobs.map((blobId) => rm(join(getAvatarBlobDir("uploaded"), `${blobId}.png`), { force: true })));
});

describe("strict owned avatar media", () => {
  test("never invokes a candidate producer before reservation and skips it for an exact replay", async () => {
    const scope = { serverInstanceId: randomUUID(), ownerUserId: randomUUID(), agentId: randomUUID() };
    const operationId = randomUUID();
    const entryId = randomUUID();
    const replay = {
      operation: "create" as const,
      entryIds: [entryId],
      entries: [{
        id: entryId,
        source: "upload",
        origin: "mobile",
        createdAt: new Date().toISOString(),
        media: {
          thumbnailUrl: `/api/profile/agent-photo-library/entries/${entryId}/media?size=thumb&v=${entryId}`,
          fullUrl: `/api/profile/agent-photo-library/entries/${entryId}/media?size=full&v=${entryId}`,
        },
      }],
      scope: { ...scope, viewerUserId: scope.ownerUserId, selectionRevision: "0", libraryRevision: "1" },
    };
    let produced = 0;
    const service: AgentPhotoLibraryCreateService = {
      reserveCreate: async () => replay,
      finalizeCreate: async () => { throw new Error("finalize must not run for replay"); },
      failCreate: async () => false,
      inspectCreateCommitState: async () => ({ kind: "committed", value: replay }),
      reapExpiredCreateReservations: async () => [],
      markExpiredCreateArtifactCleanupComplete: async () => true,
    };
    const result = await new AgentPhotoLibraryCreateCoordinator(service).produceStageAndFinalize({
      authority: { ...scope, viewerUserId: scope.ownerUserId },
      operationId,
      slotCount: 1,
      source: "upload",
      origin: "mobile",
      semantics: [{ avatarKind: "uploaded", media: { mimeType: "image/png", byteSize: 1, sha256: "a".repeat(64) } }],
      produceCandidates: async () => { produced += 1; return []; },
    });
    expect(result).toEqual(replay);
    expect(produced).toBe(0);
  });

  test("stages under the lease, publishes without overwrite, and requires matching no-commit proof before cleanup", async () => {
    const scope = { serverInstanceId: randomUUID(), ownerUserId: randomUUID(), agentId: randomUUID() };
    const operationId = randomUUID();
    const leaseToken = randomUUID();
    const bytes = await sharp({ create: { width: 256, height: 256, channels: 4, background: "#bada55" } }).png().toBuffer();
    const staged = await stageOwnedAvatar({ scope, operationId, leaseToken, ordinal: 0, kind: "uploaded", bytes });
    expect(staged.blobId).toBe(deriveOwnedAvatarBlobId({ scope, operationId, ordinal: 0 }));
    await publishStagedOwnedAvatar(staged);
    const finalPath = join(getAvatarBlobDir("uploaded"), `${staged.blobId}.png`);
    try {
      // A second lease with the same scoped operation sees the existing exact
      // final as a replay, rather than replacing it through rename().
      const replay = await stageOwnedAvatar({ scope, operationId, leaseToken: randomUUID(), ordinal: 0, kind: "uploaded", bytes });
      await publishStagedOwnedAvatar(replay);
      await discardOwnedAvatarStaging(replay);
      await expectRejected(() => discardPublishedOwnedAvatarAfterNoCommit(staged, {
        kind: "confirmed_no_committed_owned_rows",
        operationId,
        leaseToken: randomUUID(),
      }), "cleanup proof");
      expect(await Bun.file(finalPath).exists()).toBe(true);
      await discardPublishedOwnedAvatarAfterNoCommit(staged, {
        kind: "confirmed_no_committed_owned_rows",
        operationId,
        leaseToken,
      });
      expect(await Bun.file(finalPath).exists()).toBe(false);
    } finally {
      await rm(finalPath, { force: true });
      await discardOwnedAvatarStaging(staged);
    }
  });

  test("rejects malformed staging and refuses to overwrite a different final blob", async () => {
    const scope = { serverInstanceId: randomUUID(), ownerUserId: randomUUID(), agentId: randomUUID() };
    const operationId = randomUUID();
    const leaseToken = randomUUID();
    const tooSmall = await sharp({ create: { width: 128, height: 128, channels: 4, background: "#111111" } }).png().toBuffer();
    await expectRejected(() => stageOwnedAvatar({ scope, operationId, leaseToken, ordinal: 0, kind: "uploaded", bytes: tooSmall }), "image contract");
    const bytes = await sharp({ create: { width: 256, height: 256, channels: 4, background: "#222222" } }).png().toBuffer();
    const staged = await stageOwnedAvatar({ scope, operationId, leaseToken, ordinal: 0, kind: "uploaded", bytes });
    const finalPath = join(getAvatarBlobDir("uploaded"), `${staged.blobId}.png`);
    await mkdir(getAvatarBlobDir("uploaded"), { recursive: true });
    const different = await sharp({ create: { width: 256, height: 256, channels: 4, background: "#333333" } }).png().toBuffer();
    await writeFile(finalPath, different, { flag: "wx" });
    try {
      await expectRejected(() => publishStagedOwnedAvatar(staged), "publication collision");
      expect(await Bun.file(finalPath).exists()).toBe(true);
      expect(digest(Buffer.from(await Bun.file(finalPath).arrayBuffer()))).toBe(digest(different));
    } finally {
      await discardOwnedAvatarStaging(staged);
      await rm(finalPath, { force: true });
    }
  });

  test("reconciles a partial generated original/thumbnail publish after no-commit proof", async () => {
    const scope = { serverInstanceId: randomUUID(), ownerUserId: randomUUID(), agentId: randomUUID() };
    const operationId = randomUUID();
    const leaseToken = randomUUID();
    const bytes = await sharp({ create: { width: 1024, height: 1024, channels: 4, background: "#8844cc" } }).png().toBuffer();
    const staged = await stageOwnedAvatar({ scope, operationId, leaseToken, ordinal: 0, kind: "generated", bytes });
    const original = join(getAvatarBlobDir("generated"), `${staged.blobId}.png`);
    const thumbnail = join(getAvatarBlobDir("generated"), `${staged.blobId}.thumb.webp`);
    await mkdir(getAvatarBlobDir("generated"), { recursive: true });
    await writeFile(thumbnail, Buffer.from("not the staged thumbnail"), { flag: "wx" });
    try {
      await expectRejected(() => publishStagedOwnedAvatar(staged), "publication collision");
      expect(await Bun.file(original).exists()).toBe(true);
      await discardPublishedOwnedAvatarAfterNoCommit(staged, {
        kind: "confirmed_no_committed_owned_rows",
        operationId,
        leaseToken,
      });
      expect(await Bun.file(original).exists()).toBe(false);
      expect(await Bun.file(thumbnail).exists()).toBe(false);
    } finally {
      await discardOwnedAvatarStaging(staged);
      await rm(original, { force: true });
      await rm(thumbnail, { force: true });
    }
  });

  test("leaves finals quarantined when the post-finalize database re-read is unavailable", async () => {
    const scope = { serverInstanceId: randomUUID(), ownerUserId: randomUUID(), agentId: randomUUID() };
    const operationId = randomUUID();
    const leaseToken = randomUUID();
    const blobId = deriveOwnedAvatarBlobId({ scope, operationId, ordinal: 0 });
    const finalPath = join(getAvatarBlobDir("uploaded"), `${blobId}.png`);
    const unavailable: AgentPhotoLibraryCreateService = {
      reserveCreate: async () => ({
        operationId,
        leaseToken,
        slotCount: 1,
        expiresAt: new Date(Date.now() + 60_000),
        scope: { ...scope, viewerUserId: scope.ownerUserId, selectionRevision: "0", libraryRevision: "0" },
      }),
      finalizeCreate: async (_input, promoteStaged) => {
        await promoteStaged();
        throw new Error("connection lost after commit boundary");
      },
      failCreate: async () => false,
      inspectCreateCommitState: async () => { throw new Error("database unavailable"); },
      reapExpiredCreateReservations: async () => [],
      markExpiredCreateArtifactCleanupComplete: async () => true,
    };
    const bytes = await sharp({ create: { width: 256, height: 256, channels: 4, background: "#123456" } }).png().toBuffer();
    try {
      await expectRejected(() => new AgentPhotoLibraryCreateCoordinator(unavailable).produceStageAndFinalize({
        authority: { ...scope, viewerUserId: scope.ownerUserId },
        operationId,
        slotCount: 1,
        source: "upload",
        origin: "mobile",
        semantics: [{ avatarKind: "uploaded", media: { mimeType: "image/png", byteSize: bytes.length, sha256: digest(bytes) } }],
        produceCandidates: async () => [{ kind: "uploaded", bytes }],
      }), "connection lost");
      expect(await Bun.file(finalPath).exists()).toBe(true);
    } finally {
      await rm(finalPath, { force: true });
    }
  });

  test("serves an original only when its entry size and sha256 match", async () => {
    const bytes = await sharp({ create: { width: 256, height: 256, channels: 4, background: "#ff0000" } }).png().toBuffer();
    const blobId = await writeUploaded(bytes);
    const accepted = await readStrictOwnedAvatarMedia({
      kind: "uploaded", entryId: randomUUID(), blobId, variant: "full", mediaByteSize: bytes.length, mediaSha256: digest(bytes), mediaMimeType: "image/png",
    });
    expect(accepted.ok).toBe(true);
    if (accepted.ok) expect(accepted.etag).not.toContain(blobId);
    const rejected = await readStrictOwnedAvatarMedia({
      kind: "uploaded", entryId: randomUUID(), blobId, variant: "full", mediaByteSize: bytes.length, mediaSha256: "0".repeat(64), mediaMimeType: "image/png",
    });
    expect(rejected).toEqual({ ok: false });
    const wrongMime = await readStrictOwnedAvatarMedia({
      kind: "uploaded", entryId: randomUUID(), blobId, variant: "full", mediaByteSize: bytes.length, mediaSha256: digest(bytes), mediaMimeType: "image/jpeg",
    });
    expect(wrongMime).toEqual({ ok: false });
    const small = await sharp({ create: { width: 16, height: 16, channels: 4, background: "#ff0000" } }).png().toBuffer();
    const smallBlobId = await writeUploaded(small);
    const wrongDimensions = await readStrictOwnedAvatarMedia({
      kind: "uploaded", entryId: randomUUID(), blobId: smallBlobId, variant: "full", mediaByteSize: small.length, mediaSha256: digest(small), mediaMimeType: "image/png",
    });
    expect(wrongDimensions).toEqual({ ok: false });
  });

  test("rejects generated thumbnails that are not 256-square WebP", async () => {
    const blobId = `d487-strict-${randomUUID()}`;
    const original = await sharp({ create: { width: 1024, height: 1024, channels: 4, background: "#00ff00" } }).png().toBuffer();
    const invalidThumb = await sharp({ create: { width: 128, height: 128, channels: 4, background: "#00ff00" } }).webp().toBuffer();
    await mkdir(getAvatarBlobDir("generated"), { recursive: true });
    await writeFile(join(getAvatarBlobDir("generated"), `${blobId}.png`), original);
    await writeFile(join(getAvatarBlobDir("generated"), `${blobId}.thumb.webp`), invalidThumb);
    try {
      const result = await readStrictOwnedAvatarMedia({
        kind: "generated", entryId: randomUUID(), blobId, variant: "thumb", mediaByteSize: original.length, mediaSha256: digest(original), mediaMimeType: "image/png",
      });
      expect(result).toEqual({ ok: false });
    } finally {
      await rm(join(getAvatarBlobDir("generated"), `${blobId}.png`), { force: true });
      await rm(join(getAvatarBlobDir("generated"), `${blobId}.thumb.webp`), { force: true });
    }
  });

  test("rejects symlinks, over-cap metadata, and a missing required generated thumbnail", async () => {
    const bytes = await sharp({ create: { width: 256, height: 256, channels: 4, background: "#0000ff" } }).png().toBuffer();
    const target = await writeUploaded(bytes);
    const link = `d487-strict-link-${randomUUID()}`;
    blobs.push(link);
    await symlink(join(getAvatarBlobDir("uploaded"), `${target}.png`), join(getAvatarBlobDir("uploaded"), `${link}.png`));
    const linked = await readStrictOwnedAvatarMedia({
      kind: "uploaded", entryId: randomUUID(), blobId: link, variant: "full", mediaByteSize: bytes.length, mediaSha256: digest(bytes), mediaMimeType: "image/png",
    });
    expect(linked).toEqual({ ok: false });
    const overCap = await readStrictOwnedAvatarMedia({
      kind: "uploaded", entryId: randomUUID(), blobId: target, variant: "full", mediaByteSize: 6 * 1024 * 1024, mediaSha256: digest(bytes), mediaMimeType: "image/png",
    });
    expect(overCap).toEqual({ ok: false });
    const missingThumb = await readStrictOwnedAvatarMedia({
      kind: "generated", entryId: randomUUID(), blobId: `d487-strict-missing-${randomUUID()}`, variant: "thumb", mediaByteSize: 1, mediaSha256: "a".repeat(64), mediaMimeType: "image/png",
    });
    expect(missingThumb).toEqual({ ok: false });
  });

  test("requires the complete generated original and thumbnail set for lifecycle recovery", async () => {
    const blobId = `d487-strict-complete-${randomUUID()}`;
    const entryId = randomUUID();
    const original = await sharp({ create: { width: 1024, height: 1024, channels: 4, background: "#c0ffee" } }).png().toBuffer();
    const thumbnail = await sharp(original).resize(256, 256).webp().toBuffer();
    await mkdir(getAvatarBlobDir("generated"), { recursive: true });
    await writeFile(join(getAvatarBlobDir("generated"), `${blobId}.png`), original);
    try {
      const input = {
        kind: "generated" as const,
        entryId,
        blobId,
        mediaByteSize: original.length,
        mediaSha256: digest(original),
        mediaMimeType: "image/png",
      };
      expect(await hasCompleteOwnedAvatarMedia(input)).toBe(false);
      await writeFile(join(getAvatarBlobDir("generated"), `${blobId}.thumb.webp`), thumbnail);
      expect(await hasCompleteOwnedAvatarMedia(input)).toBe(true);
      await rm(join(getAvatarBlobDir("generated"), `${blobId}.png`), { force: true });
      expect(await hasCompleteOwnedAvatarMedia(input)).toBe(false);
    } finally {
      await rm(join(getAvatarBlobDir("generated"), `${blobId}.png`), { force: true });
      await rm(join(getAvatarBlobDir("generated"), `${blobId}.thumb.webp`), { force: true });
    }
  });
});
