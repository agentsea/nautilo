import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { link, lstat, mkdir, open, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import sharp from "sharp";
import { getAvatarBlobDir, isSafeBlobId } from "../routes/_helpers/avatar";

export type OwnedAvatarKind = "uploaded" | "generated";

export interface OwnedAvatarBlobScope {
  readonly serverInstanceId: string;
  readonly ownerUserId: string;
  readonly agentId: string;
}

export interface StagedOwnedAvatar {
  readonly operationId: string;
  /** A pending reservation fence, never a bearer credential. */
  readonly leaseToken: string;
  readonly ordinal: number;
  readonly blobId: string;
  readonly kind: OwnedAvatarKind;
  readonly byteSize: number;
  readonly sha256: string;
  readonly thumbnailByteSize: number | null;
  readonly thumbnailSha256: string | null;
}

const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;
const MAX_GENERATED_BYTES = 8 * 1024 * 1024;
const MAX_GENERATED_THUMBNAIL_BYTES = 5 * 1024 * 1024;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function stageDir(kind: OwnedAvatarKind, operationId: string, leaseToken: string): string {
  return join(getAvatarBlobDir(kind), ".photo-library-staging", operationId, leaseToken);
}

function digest(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function assertReservationIdentity(operationId: string, leaseToken: string, ordinal: number): void {
  if (!UUID_PATTERN.test(operationId) || !UUID_PATTERN.test(leaseToken) || !Number.isInteger(ordinal) || ordinal < 0 || ordinal > 3) {
    throw new Error("invalid owned-photo reservation identity");
  }
}

/**
 * The final blob id is deterministic for one scoped operation candidate. A
 * retry can therefore prove it is talking about the exact same media without
 * accepting a client-selected file name or adopting a different worker's blob.
 */
export function deriveOwnedAvatarBlobId(input: {
  readonly scope: OwnedAvatarBlobScope;
  readonly operationId: string;
  readonly ordinal: number;
}): string {
  if (!UUID_PATTERN.test(input.operationId) || !Number.isInteger(input.ordinal) || input.ordinal < 0 || input.ordinal > 3) {
    throw new Error("invalid owned-photo operation identity");
  }
  for (const value of [input.scope.serverInstanceId, input.scope.ownerUserId, input.scope.agentId]) {
    if (!UUID_PATTERN.test(value)) throw new Error("invalid owned-photo scope");
  }
  return createHash("sha256")
    .update("nautilo/d487/owned-avatar/v1\0", "utf8")
    .update(input.scope.serverInstanceId, "utf8")
    .update("\0", "utf8")
    .update(input.scope.ownerUserId, "utf8")
    .update("\0", "utf8")
    .update(input.scope.agentId, "utf8")
    .update("\0", "utf8")
    .update(input.operationId, "utf8")
    .update("\0", "utf8")
    .update(String(input.ordinal), "utf8")
    .digest("hex");
}

async function validateOriginal(kind: OwnedAvatarKind, bytes: Buffer): Promise<void> {
  const cap = kind === "uploaded" ? MAX_UPLOAD_BYTES : MAX_GENERATED_BYTES;
  const dimension = kind === "uploaded" ? 256 : 1024;
  if (bytes.length < 1 || bytes.length > cap) throw new Error("avatar bytes exceed the owned-photo limit");
  const metadata = await sharp(bytes, { limitInputPixels: 1024 * 1024 }).metadata();
  if (
    metadata.format !== "png"
    || metadata.width !== dimension
    || metadata.height !== dimension
    || (metadata.pages !== undefined && metadata.pages !== 1)
  ) {
    throw new Error("avatar bytes do not satisfy the owned-photo image contract");
  }
}

async function createExclusive(path: string, bytes: Buffer): Promise<void> {
  const handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function validateThumbnail(bytes: Buffer): Promise<void> {
  if (bytes.length < 1 || bytes.length > MAX_GENERATED_THUMBNAIL_BYTES) throw new Error("generated thumbnail exceeds the owned-photo limit");
  const metadata = await sharp(bytes, { limitInputPixels: 256 * 256 }).metadata();
  if (
    metadata.format !== "webp"
    || metadata.width !== 256
    || metadata.height !== 256
    || (metadata.pages !== undefined && metadata.pages !== 1)
  ) throw new Error("generated thumbnail validation failed");
}

function paths(staged: StagedOwnedAvatar) {
  const staging = stageDir(staged.kind, staged.operationId, staged.leaseToken);
  const final = getAvatarBlobDir(staged.kind);
  return {
    stagingOriginal: join(staging, `${staged.blobId}.png`),
    stagingThumbnail: join(staging, `${staged.blobId}.thumb.webp`),
    finalOriginal: join(final, `${staged.blobId}.png`),
    finalThumbnail: join(final, `${staged.blobId}.thumb.webp`),
  };
}

/** Strictly validate and token-fence bytes; no public path exists at this point. */
export async function stageOwnedAvatar(input: {
  readonly scope: OwnedAvatarBlobScope;
  readonly operationId: string;
  readonly leaseToken: string;
  readonly ordinal: number;
  readonly kind: OwnedAvatarKind;
  readonly bytes: Buffer;
}): Promise<StagedOwnedAvatar> {
  assertReservationIdentity(input.operationId, input.leaseToken, input.ordinal);
  await validateOriginal(input.kind, input.bytes);
  const blobId = deriveOwnedAvatarBlobId({ scope: input.scope, operationId: input.operationId, ordinal: input.ordinal });
  const staged: StagedOwnedAvatar = {
    operationId: input.operationId,
    leaseToken: input.leaseToken,
    ordinal: input.ordinal,
    blobId,
    kind: input.kind,
    byteSize: input.bytes.length,
    sha256: digest(input.bytes),
    thumbnailByteSize: null,
    thumbnailSha256: null,
  };
  const location = paths(staged);
  await mkdir(stageDir(input.kind, input.operationId, input.leaseToken), { recursive: true, mode: 0o700 });
  await createExclusive(location.stagingOriginal, input.bytes);
  try {
    if (input.kind !== "generated") return staged;
    const thumbnail = await sharp(input.bytes)
      .resize(256, 256, { fit: "cover", position: "center" })
      .webp({ quality: 82 })
      .toBuffer();
    await validateThumbnail(thumbnail);
    await createExclusive(location.stagingThumbnail, thumbnail);
    return {
      ...staged,
      thumbnailByteSize: thumbnail.length,
      thumbnailSha256: digest(thumbnail),
    };
  } catch (error) {
    await discardOwnedAvatarStaging(staged);
    throw error;
  }
}

async function assertExactRegularFile(path: string, expectedSize: number, expectedSha256: string): Promise<void> {
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== expectedSize) throw new Error("owned avatar publication collision");
  const bytes = await readFile(path);
  if (bytes.length !== expectedSize || digest(bytes) !== expectedSha256) throw new Error("owned avatar publication collision");
}

/**
 * Atomically publish using hard links, which fails rather than replacing an
 * existing final. A deterministic replay may see EEXIST only after proving
 * that the existing bytes are exactly the staged candidate.
 */
async function publishExclusive(from: string, to: string, expectedSize: number, expectedSha256: string): Promise<void> {
  try {
    await link(from, to);
  } catch (error: unknown) {
    if (!(error && typeof error === "object" && "code" in error && error.code === "EEXIST")) throw error;
    await assertExactRegularFile(to, expectedSize, expectedSha256);
  }
}

/**
 * Promotes only the exact token-scoped staged files. Promotion is deliberately
 * separate from the DB commit: callers must reconcile an ambiguous commit
 * before deleting any final path.
 */
export async function publishStagedOwnedAvatar(staged: StagedOwnedAvatar): Promise<void> {
  assertReservationIdentity(staged.operationId, staged.leaseToken, staged.ordinal);
  if (!isSafeBlobId(staged.blobId)) throw new Error("unsafe owned avatar blob id");
  const location = paths(staged);
  await mkdir(getAvatarBlobDir(staged.kind), { recursive: true, mode: 0o700 });
  await assertExactRegularFile(location.stagingOriginal, staged.byteSize, staged.sha256);
  await publishExclusive(location.stagingOriginal, location.finalOriginal, staged.byteSize, staged.sha256);
  if (staged.kind === "generated") {
    if (staged.thumbnailByteSize === null || staged.thumbnailSha256 === null) throw new Error("generated owned avatar is missing a thumbnail receipt");
    await assertExactRegularFile(location.stagingThumbnail, staged.thumbnailByteSize, staged.thumbnailSha256);
    await publishExclusive(location.stagingThumbnail, location.finalThumbnail, staged.thumbnailByteSize, staged.thumbnailSha256);
  }
}

/** Deletes only unobservable token-scoped staging, even after an uncertain DB outcome. */
export async function discardOwnedAvatarStaging(staged: StagedOwnedAvatar): Promise<void> {
  const location = paths(staged);
  await Promise.all([
    rm(location.stagingOriginal, { force: true }),
    rm(location.stagingThumbnail, { force: true }),
  ]);
}

/**
 * This is intentionally difficult to call casually. The coordinator may call
 * it only after it has *read* the authoritative database state and established
 * that no owned row committed for this operation. DB absence/error is not a
 * cleanup authorization: leave the final bytes quarantined instead.
 */
export async function discardPublishedOwnedAvatarAfterNoCommit(
  staged: StagedOwnedAvatar,
  proof: { readonly kind: "confirmed_no_committed_owned_rows"; readonly operationId: string; readonly leaseToken: string },
): Promise<void> {
  if (proof.operationId !== staged.operationId || proof.leaseToken !== staged.leaseToken) {
    throw new Error("owned avatar cleanup proof does not match staging lease");
  }
  const location = paths(staged);
  await Promise.all([
    rm(location.finalOriginal, { force: true }),
    rm(location.finalThumbnail, { force: true }),
    discardOwnedAvatarStaging(staged),
  ]);
}

/**
 * A reaper may remove only artifacts tied to an operation after its mutation
 * service has atomically proved there are no committed owned rows and written
 * a terminal receipt. It enumerates the tiny protocol maximum, never a user
 * directory, and deliberately does not re-run any provider work.
 */
export async function discardExpiredOwnedAvatarArtifacts(input: {
  readonly scope: OwnedAvatarBlobScope;
  readonly operationId: string;
  readonly leaseToken: string;
  readonly slotCount: number;
  readonly proof: { readonly kind: "confirmed_no_committed_owned_rows"; readonly operationId: string; readonly leaseToken: string };
}): Promise<void> {
  if (
    input.proof.kind !== "confirmed_no_committed_owned_rows"
    || input.proof.operationId !== input.operationId
    || input.proof.leaseToken !== input.leaseToken
    || !Number.isInteger(input.slotCount)
    || input.slotCount < 1
    || input.slotCount > 4
  ) throw new Error("expired owned avatar cleanup proof is invalid");
  for (const ordinal of Array.from({ length: input.slotCount }, (_, index) => index)) {
    const blobId = deriveOwnedAvatarBlobId({ scope: input.scope, operationId: input.operationId, ordinal });
    await Promise.all((["uploaded", "generated"] as const).flatMap((kind) => {
      const staging = stageDir(kind, input.operationId, input.leaseToken);
      const final = getAvatarBlobDir(kind);
      return [
        rm(join(staging, `${blobId}.png`), { force: true }),
        rm(join(staging, `${blobId}.thumb.webp`), { force: true }),
        rm(join(final, `${blobId}.png`), { force: true }),
        rm(join(final, `${blobId}.thumb.webp`), { force: true }),
      ];
    }));
  }
}
