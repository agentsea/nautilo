import { randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, rm, stat as fsStat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { pipeline } from "node:stream/promises";
import type { FastifyInstance, FastifyReply } from "fastify";
import { getArtifactsRoot } from "@nautilo/config";
import {
  ATTACHMENT_POLICY,
  classifyAttachment,
  metadataBlockForClassification,
  sanitizeAttachmentMetadataLine,
  type AttachmentEnvelope,
} from "@nautilo/attachments";
import {
  cancelPendingMessageAttachment,
  findRetainedMessageAttachmentForNamespaces,
  insertPendingMessageAttachment,
  markRetainedAttachmentDeletedForNamespaces,
  sumPendingMessageAttachmentBytesForActor,
} from "@nautilo/db";
import { warn } from "@nautilo/logger";
import { envelopeReadableNamespaces, envelopeWritableNamespaces, isScopeMemoryEnvelope } from "@nautilo/trust";

const PENDING_TTL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_PENDING_BYTES_PER_ACTOR = 100 * 1024 * 1024;
const SCOPE_REJECTION_MESSAGE =
  "Message attachment upload is not implemented for scope-mode runs; use a room namespace context.";

function uploadCapBytes(): number {
  return ATTACHMENT_POLICY.maxAcceptedBytesPerMessage;
}

function pendingBytesCapPerActor(): number {
  const raw = process.env["NAUTILO_MESSAGE_ATTACHMENT_PENDING_MAX_MB"];
  const n = raw ? Number.parseInt(raw, 10) : NaN;
  return (Number.isFinite(n) && n > 0 ? n * 1024 * 1024 : DEFAULT_PENDING_BYTES_PER_ACTOR);
}

function attachmentBlobPath(id: string): string {
  return join(getArtifactsRoot(), "message-attachments", id);
}

function isMultipartTooLarge(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const o = err as { statusCode?: number; code?: string };
  return o.statusCode === 413 || o.code === "FST_REQ_FILE_TOO_LARGE";
}

async function sendUploadError(reply: FastifyReply, status: number, error: string, detail?: unknown) {
  return reply.code(status).send({ error, ...(detail ? { detail } : {}) });
}

export interface MessageAttachmentRouteDeps {
  sumPendingBytesForActor: typeof sumPendingMessageAttachmentBytesForActor;
  insertPending: typeof insertPendingMessageAttachment;
  cancelPending: typeof cancelPendingMessageAttachment;
  findRetained: typeof findRetainedMessageAttachmentForNamespaces;
  markRetainedDeleted: typeof markRetainedAttachmentDeletedForNamespaces;
}

const DEFAULT_DEPS: MessageAttachmentRouteDeps = {
  sumPendingBytesForActor: sumPendingMessageAttachmentBytesForActor,
  insertPending: insertPendingMessageAttachment,
  cancelPending: cancelPendingMessageAttachment,
  findRetained: findRetainedMessageAttachmentForNamespaces,
  markRetainedDeleted: markRetainedAttachmentDeletedForNamespaces,
};

export function messageAttachmentRoutes(
  app: FastifyInstance,
  deps: MessageAttachmentRouteDeps = DEFAULT_DEPS,
) {
  app.post("/api/message-attachments", async (request, reply) => {
    const env = request.memoryEnvelope;
    if (!env || !request.sessionActorId) {
      return reply.code(401).send({ error: "Authentication required" });
    }
    if (isScopeMemoryEnvelope(env)) {
      return reply.code(501).send({ error: SCOPE_REJECTION_MESSAGE });
    }
    const writable = envelopeWritableNamespaces(env);
    const namespaceId = writable[0];
    if (!namespaceId) {
      return reply.code(403).send({ error: "No writable namespace for attachment upload" });
    }

    let data;
    try {
      data = await request.file({
        limits: {
          fileSize: uploadCapBytes(),
          files: 1,
        },
      });
    } catch (err) {
      if (isMultipartTooLarge(err)) {
        return sendUploadError(reply, 413, "too_large");
      }
      throw err;
    }
    if (!data || data.fieldname !== "file") {
      return sendUploadError(reply, 400, "no_file");
    }

    let bytes: Buffer;
    try {
      bytes = await data.toBuffer();
    } catch (err) {
      if (isMultipartTooLarge(err)) {
        return sendUploadError(reply, 413, "too_large");
      }
      return sendUploadError(reply, 400, "no_file");
    }

    const pendingCap = pendingBytesCapPerActor();
    const pendingBytes = await deps.sumPendingBytesForActor({
      uploaderActorId: request.sessionActorId,
    });
    if (pendingBytes + bytes.byteLength > pendingCap) {
      return sendUploadError(reply, 429, "pending_attachment_quota_exceeded");
    }

    const filename = data.filename || "attachment";
    const id = randomUUID();
    const envelope: AttachmentEnvelope = {
      id,
      source: "workbench-chat",
      filename,
      sizeBytes: bytes.byteLength,
      bytes,
      ...(data.mimetype ? { claimedMime: data.mimetype } : {}),
    };
    const classification = await classifyAttachment(envelope);
    if (classification.decision !== "accept") {
      const metadata = metadataBlockForClassification(envelope, classification);
      return sendUploadError(reply, 400, "attachment_rejected", {
        classification,
        message: metadata.text,
      });
    }

    const filePath = attachmentBlobPath(id);
    try {
      await mkdir(dirname(filePath), { recursive: true });
      await writeFile(filePath, bytes);
      const row = await deps.insertPending({
        id,
        namespaceId,
        uploaderActorId: request.sessionActorId,
        filename,
        mimeType: classification.normalizedMime,
        sizeBytes: bytes.byteLength,
        storageUri: pathToFileURL(filePath).toString(),
        expiresAt: new Date(Date.now() + PENDING_TTL_MS),
        ...(data.mimetype ? { claimedMime: data.mimetype } : {}),
      });
      return reply.send({
        attachmentId: row.id,
        filename: row.filename,
        mimeType: row.mimeType,
        sizeBytes: row.sizeBytes,
        status: row.status,
        expiresAt: row.expiresAt?.toISOString() ?? null,
      });
    } catch (err) {
      await rm(filePath, { force: true }).catch(() => {});
      throw err;
    }
  });

  // D391 — authed byte route for retained attachments (images + audio).
  // Streams the blob with `Content-Type` from `mime_type`, gated by the
  // same namespace-readability check the history read uses (mirror of the
  // retained-by-id read at queries/message-attachments.ts). Type-agnostic:
  // serves any retained kind. Non-members (no readable namespace) get 404
  // (not 403) so the route does not leak existence — same shape as the
  // artifact byte route.
  app.get("/api/message-attachments/:id", async (request, reply) => {
    const env = request.memoryEnvelope;
    if (!env || !request.sessionActorId) {
      return reply.code(401).send({ error: "Authentication required" });
    }
    if (isScopeMemoryEnvelope(env)) {
      return reply.code(501).send({ error: SCOPE_REJECTION_MESSAGE });
    }
    const params = request.params as { id?: string };
    const attachmentId = params.id?.trim();
    if (!attachmentId) return reply.code(400).send({ error: "attachment id required" });
    const readable = envelopeReadableNamespaces(env);
    const row = await deps.findRetained({
      attachmentId,
      readableNamespaceIds: readable,
    });
    if (!row) return reply.code(404).send({ error: "not found" });
    const abs = row.storageUri.startsWith("file://")
      ? fileURLToPath(row.storageUri)
      : null;
    if (!abs) return reply.code(500).send({ error: "invalid storage uri" });
    let size = row.sizeBytes;
    try {
      const st = await fsStat(abs);
      size = st.size;
    } catch {
      warn(`[message-attachments] stat failed for ${sanitizeAttachmentMetadataLine(abs)}`);
    }
    reply.hijack();
    reply.raw.writeHead(200, {
      "Content-Type": row.mimeType || "application/octet-stream",
      "Content-Length": String(size),
      "Cache-Control": "private, max-age=3600",
    });
    const rs = createReadStream(abs);
    try {
      await pipeline(rs, reply.raw);
    } catch (err) {
      // Socket already torn down (client disconnect) — log, do not throw
      // into the hijacked reply.
      warn(`[message-attachments] stream failed for ${sanitizeAttachmentMetadataLine(abs)}: ${err instanceof Error ? err.message : String(err)}`);
    }
  });

  app.delete("/api/message-attachments/:id", async (request, reply) => {
    if (!request.sessionActorId) {
      return reply.code(401).send({ error: "Authentication required" });
    }
    const params = request.params as { id?: string };
    const attachmentId = params.id?.trim();
    if (!attachmentId) return reply.code(400).send({ error: "attachment id required" });
    // Pending path (pre-send cancel) — uploader-scoped capability fence.
    const pendingRow = await deps.cancelPending({
      attachmentId,
      uploaderActorId: request.sessionActorId,
    });
    if (pendingRow) {
      const filePath = pendingRow.storageUri.startsWith("file://")
        ? fileURLToPath(pendingRow.storageUri)
        : null;
      if (filePath) {
        await rm(filePath, { force: true }).catch((err) => {
          warn(`[message-attachments] failed to delete pending blob ${sanitizeAttachmentMetadataLine(filePath)}: ${err instanceof Error ? err.message : String(err)}`);
        });
      }
      return reply.send({ ok: true });
    }
    // D391 R8 — retained path: namespace-gated delete + blob cleanup (no
    // orphans). Lets an owner remove a durable attachment; the broader
    // message-delete -> attachment cascade is wired separately (deferred to
    // the message-delete path, which is not in this stack's owned set).
    const env = request.memoryEnvelope;
    const readable = env ? envelopeReadableNamespaces(env) : [];
    const retainedRow = await deps.markRetainedDeleted({
      attachmentId,
      readableNamespaceIds: readable,
    });
    if (!retainedRow) return reply.code(404).send({ error: "not found" });
    const retainedPath = retainedRow.storageUri.startsWith("file://")
      ? fileURLToPath(retainedRow.storageUri)
      : null;
    if (retainedPath) {
      await rm(retainedPath, { force: true }).catch((err) => {
        warn(`[message-attachments] failed to delete retained blob ${sanitizeAttachmentMetadataLine(retainedPath)}: ${err instanceof Error ? err.message : String(err)}`);
      });
    }
    return reply.send({ ok: true });
  });
}
