import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { FastifyReply, FastifyRequest } from "fastify";
import sharp, { type Metadata } from "sharp";
import type { AvatarRef } from "@nautilo/types";

const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;
const MAX_DIMENSION = 8192;
const ALLOWED_UPLOAD_MIMES = new Set(["image/png", "image/jpeg", "image/webp"]);

function isMultipartTooLarge(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const o = err as { statusCode?: number; code?: string };
  return o.statusCode === 413 || o.code === "FST_REQ_FILE_TOO_LARGE";
}

/**
 * D280 — shared sharp upload pipeline (256×256 PNG blob). Used by profile
 * avatars and the server icon route; callers pass the destination directory.
 */
export async function persistUploadedServerImage(
  request: FastifyRequest,
  reply: FastifyReply,
  destinationDir: string,
): Promise<Extract<AvatarRef, { kind: "uploaded" }> | null> {
  let data;
  try {
    data = await request.file({
      limits: {
        fileSize: MAX_UPLOAD_BYTES,
        files: 1,
      },
    });
  } catch (err) {
    if (isMultipartTooLarge(err)) {
      void reply.code(413).send({ error: "too_large" });
      return null;
    }
    throw err;
  }

  if (!data || data.fieldname !== "file") {
    void reply.code(400).send({ error: "no file" });
    return null;
  }

  const mimetype = data.mimetype ?? "";
  if (!ALLOWED_UPLOAD_MIMES.has(mimetype)) {
    void reply.code(400).send({ error: "unsupported_mime" });
    return null;
  }

  let inputBuf: Buffer;
  try {
    inputBuf = await data.toBuffer();
  } catch (err) {
    if (isMultipartTooLarge(err)) {
      void reply.code(413).send({ error: "too_large" });
      return null;
    }
    void reply.code(400).send({ error: "no file" });
    return null;
  }

  if (inputBuf.byteLength > MAX_UPLOAD_BYTES) {
    void reply.code(413).send({ error: "too_large" });
    return null;
  }

  let meta: Metadata;
  try {
    meta = await sharp(inputBuf).metadata();
  } catch {
    void reply.code(400).send({ error: "decode_failed" });
    return null;
  }

  const width = meta.width ?? 0;
  const height = meta.height ?? 0;
  if (width > MAX_DIMENSION || height > MAX_DIMENSION) {
    void reply.code(400).send({ error: "dimensions_too_large" });
    return null;
  }

  let out: Buffer;
  try {
    out = await sharp(inputBuf)
      .rotate()
      .resize(256, 256, { fit: "cover", position: "center" })
      .png({ compressionLevel: 9 })
      .toBuffer();
  } catch {
    void reply.code(400).send({ error: "decode_failed" });
    return null;
  }

  const blobId = randomUUID();
  mkdirSync(destinationDir, { recursive: true });
  writeFileSync(join(destinationDir, `${blobId}.png`), out);
  return { kind: "uploaded", blobId };
}
