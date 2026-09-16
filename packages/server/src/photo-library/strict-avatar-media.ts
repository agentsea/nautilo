import { createHash } from "node:crypto";
import { constants, lstatSync } from "node:fs";
import { open } from "node:fs/promises";
import { join } from "node:path";
import sharp from "sharp";
import { getAvatarBlobDir, isSafeBlobId } from "../routes/_helpers/avatar";

export type OwnedAvatarMediaVariant = "thumb" | "full";

export type StrictOwnedAvatarMediaRead =
  | { readonly ok: true; readonly bytes: Buffer; readonly contentType: "image/png" | "image/webp"; readonly etag: string }
  | { readonly ok: false };

const MAX_UPLOADED_AVATAR_BYTES = 5 * 1024 * 1024;
const MAX_GENERATED_AVATAR_BYTES = 8 * 1024 * 1024;
/** Thumbnails are rejected before allocation and image decoding. */
const MAX_GENERATED_THUMBNAIL_BYTES = 5 * 1024 * 1024;

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function readBounded(
  handle: Awaited<ReturnType<typeof open>>,
  expectedSize: number,
  cap: number,
): Promise<Buffer | null> {
  if (expectedSize < 1 || expectedSize > cap) return null;
  // One sentinel byte detects growth after fstat without an unbounded read.
  const buffer = Buffer.allocUnsafe(expectedSize + 1);
  let offset = 0;
  while (offset < buffer.length) {
    const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
    if (bytesRead === 0) break;
    offset += bytesRead;
  }
  if (offset !== expectedSize) return null;
  return buffer.subarray(0, expectedSize);
}

/**
 * Reads only media whose durable entry facts have already been authorized.
 * There is no write-on-read repair: a missing, swapped, malformed, or stale
 * blob is a typed absence instead of a shell placeholder or filesystem leak.
 */
export async function readStrictOwnedAvatarMedia(input: {
  readonly kind: "generated" | "uploaded";
  readonly entryId: string;
  readonly blobId: string;
  readonly variant: OwnedAvatarMediaVariant;
  /** Exact original facts from the owned entry. */
  readonly mediaByteSize: number;
  readonly mediaSha256: string;
  readonly mediaMimeType: string;
}): Promise<StrictOwnedAvatarMediaRead> {
  if (
    !isSafeBlobId(input.blobId)
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(input.entryId)
    || !Number.isSafeInteger(input.mediaByteSize)
    || input.mediaByteSize < 1
    || !/^[0-9a-f]{64}$/.test(input.mediaSha256)
    || input.mediaMimeType !== "image/png"
  ) return { ok: false };

  const generatedThumb = input.kind === "generated" && input.variant === "thumb";
  const originalCap = input.kind === "uploaded"
    ? MAX_UPLOADED_AVATAR_BYTES
    : MAX_GENERATED_AVATAR_BYTES;
  if (input.mediaByteSize > originalCap) return { ok: false };
  const expectedBytes = generatedThumb ? MAX_GENERATED_THUMBNAIL_BYTES : input.mediaByteSize;
  const fileName = generatedThumb ? `${input.blobId}.thumb.webp` : `${input.blobId}.png`;
  const filePath = join(getAvatarBlobDir(input.kind), fileName);
  let before;
  try {
    before = lstatSync(filePath);
  } catch {
    return { ok: false };
  }
  if (
    !before.isFile()
    || before.isSymbolicLink()
    || before.size < 1
    || before.size > expectedBytes
    || (!generatedThumb && before.size !== input.mediaByteSize)
  ) return { ok: false };

  let handle;
  try {
    handle = await open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
    const opened = await handle.stat();
    if (
      !opened.isFile()
      || opened.size < 1
      || opened.size > expectedBytes
      || (!generatedThumb && opened.size !== input.mediaByteSize)
      || opened.dev !== before.dev
      || opened.ino !== before.ino
    ) return { ok: false };
    const bytes = await readBounded(handle, opened.size, expectedBytes);
    if (!bytes) return { ok: false };

    if (!generatedThumb) {
      if (sha256(bytes) !== input.mediaSha256) return { ok: false };
      const metadata = await sharp(bytes, { limitInputPixels: 1024 * 1024 }).metadata();
      const expectedDimension = input.kind === "uploaded" ? 256 : 1024;
      if (
        metadata.format !== "png"
        || metadata.width !== expectedDimension
        || metadata.height !== expectedDimension
        || (metadata.pages !== undefined && metadata.pages !== 1)
      ) return { ok: false };
      return {
        ok: true,
        bytes,
        contentType: "image/png",
        etag: `${input.entryId}.full.${input.mediaSha256}`,
      };
    }

    const metadata = await sharp(bytes, { limitInputPixels: 256 * 256 }).metadata();
    if (
      metadata.format !== "webp"
      || metadata.width !== 256
      || metadata.height !== 256
      || (metadata.pages !== undefined && metadata.pages !== 1)
    ) {
      return { ok: false };
    }
    return {
      ok: true,
      bytes,
      contentType: "image/webp",
      etag: `${input.entryId}.thumb.${sha256(bytes)}`,
    };
  } catch {
    return { ok: false };
  } finally {
    await handle?.close().catch(() => {});
  }
}

/**
 * Lifecycle recovery needs a stronger predicate than a single original-file
 * stat: generated avatars are one public media set only when both the PNG and
 * its required WebP thumbnail still satisfy the exact read contract.
 */
export async function hasCompleteOwnedAvatarMedia(input: {
  readonly kind: "generated" | "uploaded";
  readonly entryId: string;
  readonly blobId: string;
  readonly mediaByteSize: number;
  readonly mediaSha256: string;
  readonly mediaMimeType: string;
}): Promise<boolean> {
  const full = await readStrictOwnedAvatarMedia({ ...input, variant: "full" });
  if (!full.ok) return false;
  if (input.kind !== "generated") return true;
  const thumbnail = await readStrictOwnedAvatarMedia({ ...input, variant: "thumb" });
  return thumbnail.ok;
}
