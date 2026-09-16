/**
 * D271 — chat attachment normalization (upload model).
 *
 * The client uploads bytes first (`POST /api/message-attachments`) and sends
 * only `attachmentId`s. At send time we resolve each id to a PENDING upload
 * scoped to the sender + the turn's writable Namespace (the capability fence),
 * read the stored bytes, run the central attachment gate on them, and:
 *   - text  → inline content block into the turn; resolve `consumed`; release blob.
 *   - image → base64 multimodal part; resolve `consumed`; release blob.
 *   - audio → metadata-only (NO auto-transcribe, by design — ISSUE-D271);
 *             resolve `retained`; keep blob for an explicit transcribe-by-id.
 *   - anything else / rejected → reject status; cancel + release blob.
 *
 * No filesystem path from the client is ever read (supersedes the D066 path-ref
 * ingestion). `validateClientPath` remains for `currentFolder` / `workspacePath`
 * prompt context, which are still client-supplied strings.
 */
import { readFile, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type {
  ChatAttachmentStatus,
  ChatMultimodalImagePart,
  ResolvedFocusedResource,
  ResourceCapability,
} from "@nautilo/types";
import { MAX_CHAT_ATTACHMENTS_PER_MESSAGE } from "@nautilo/types";
import { log } from "@nautilo/logger";
import {
  ATTACHMENT_POLICY,
  attachmentTextToContentBlock,
  classifyAttachment,
  metadataBlockForClassification,
  sanitizeAttachmentMetadataLine,
  type AttachmentClassification,
  type AttachmentEnvelope,
} from "@nautilo/attachments";
import {
  cancelPendingMessageAttachment,
  findPendingMessageAttachmentForSender,
  markRetainedAttachmentsDeletedByTurn,
  resolvePendingMessageAttachment,
  type MessageAttachment,
} from "@nautilo/db";

/**
 * D079 Phase 2 — validate a client-supplied folder path before it enters the
 * server's trust boundary (prompt context only; not an attachment source).
 * Absolute-path shape, no control chars, a few protected roots blocked.
 */
export function validateClientPath(
  raw: string | null | undefined,
  label: string,
): string | null {
  if (raw == null || raw === "") return null;
  if (typeof raw !== "string") {
    throw new Error(`${label} must be a string (got ${typeof raw})`);
  }
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const posixAbs = trimmed.startsWith("/");
  const winAbs = /^[A-Za-z]:[\\/]/.test(trimmed);
  if (!posixAbs && !winAbs) {
    throw new Error(`${label} must be an absolute path (got ${trimmed.slice(0, 80)})`);
  }
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001F\u007F]/.test(trimmed)) {
    throw new Error(`${label} contains control characters`);
  }
  const low = trimmed.toLowerCase();
  // D304 — macOS firmlinks all user-accessible storage under /System/Volumes/
  // (the APFS data volume): e.g. ~/Documents resolves to
  // `/System/Volumes/Data/.../Documents`. That is normal USER space, not a
  // protected system path — the broad `/system/` rule below must not catch it,
  // or picking your own Documents folder wrongly trips the guard.
  const macUserVolume = low.startsWith("/system/volumes/");
  const blocked = [
    "/etc/",
    "/var/root/",
    "/system/",
    "/private/etc/",
    "/private/var/root/",
    "c:\\windows\\",
    "c:/windows/",
  ];
  if (!macUserVolume && blocked.some((p) => low.startsWith(p) || low === p.slice(0, -1))) {
    throw new Error(`${label} is a protected system path`);
  }
  return trimmed;
}

/**
 * D304 — best-effort variant for ADVISORY prompt-context paths
 * (`currentFolder` / `workspacePath`). These are never an attachment source and
 * never read from disk — they only flavor the prompt. So an invalid, weird, or
 * blocked value must NEVER block the user's message: we just drop it to null
 * and let the turn proceed. (Strict `validateClientPath` stays for any caller
 * that genuinely needs to fail closed.)
 */
export function validateClientPathSafe(
  raw: string | null | undefined,
  label: string,
): string | null {
  try {
    return validateClientPath(raw, label);
  } catch {
    return null;
  }
}

/**
 * Parse the wire `attachments` array into a list of `attachmentId`s. Each item
 * is `{ attachmentId: string }`. Bounds + shape only; ownership/namespace are
 * enforced at resolve time against the DB.
 */
export function parseChatAttachmentRefs(raw: unknown): string[] {
  if (raw == null) return [];
  if (!Array.isArray(raw)) {
    throw new Error("attachments must be an array");
  }
  return raw.map((item, index) => {
    if (!item || typeof item !== "object") {
      throw new Error(`attachments[${index}] must be an object`);
    }
    const candidate = item as Record<string, unknown>;
    const attachmentId = candidate["attachmentId"];
    if (typeof attachmentId !== "string" || attachmentId.trim().length === 0) {
      throw new Error(`attachments[${index}].attachmentId must be a non-empty string`);
    }
    // eslint-disable-next-line no-control-regex
    if (/[\u0000-\u001F\u007F]/.test(attachmentId)) {
      throw new Error(`attachments[${index}].attachmentId contains control characters`);
    }
    if (attachmentId.length > 256) {
      throw new Error(`attachments[${index}].attachmentId exceeds maximum length`);
    }
    return attachmentId;
  });
}

/**
 * D391 — extract the ids of attachments that were retained (blob kept) from a
 * normalization result's `statuses`. Images and audio resolve `retained`; text
 * resolves `consumed` (no blob). The send seam (dispatch.ts) stamps `turn_id`
 * on exactly these rows after the human message is persisted.
 */
export function retainedAttachmentIdsFromStatuses(
  statuses: readonly ChatAttachmentStatus[],
): string[] {
  return statuses
    .filter((s) => s.decision === "accept" && (s.kind === "image" || s.kind === "audio"))
    .map((s) => s.id);
}

/**
 * D423 Phase 4 — compatibility adapter: mirror already-normalized D271
 * attachments into the common `ResolvedFocusedResource` manifest as
 * `kind:"message-attachment"` entries. This does NOT replace D271 upload,
 * storage, scanning, or lifecycle — it only surfaces accepted attachments in
 * the unified manifest so the model sees ONE `## Focused resources` block.
 *
 * Only `decision === "accept"` entries are adapted; rejected / stub / blocked
 * attachments never reach the manifest (they were already surfaced to the user
 * as statuses, not as focus context). Capabilities are server-derived from the
 * normalized kind, never client-authored. The `locator` carries the attachment
 * id as private server-side run metadata; it never enters the prompt block.
 */
export function adaptNormalizedAttachments(
  statuses: readonly ChatAttachmentStatus[],
): ResolvedFocusedResource[] {
  const out: ResolvedFocusedResource[] = [];
  for (const status of statuses) {
    if (status.decision !== "accept") continue;
    const filename = typeof status.filename === "string" ? status.filename.trim() : "";
    if (!filename || !status.id) continue;
    const capabilities = attachmentCapabilitiesForKind(status.kind);
    out.push({
      kind: "message-attachment",
      displayName: filename,
      location: "server",
      lifetime: "message",
      capabilities,
      // D271 attachments are already materialized into the turn (image
      // multimodal part, text content block, or retained-audio metadata);
      // they do not map to a `file` tool target.
      locator: { attachmentId: status.id },
    });
  }
  return out;
}

function attachmentCapabilitiesForKind(kind: string | undefined): ResourceCapability[] {
  if (kind === "image") return ["read"];
  if (kind === "audio") return ["transcribe"];
  if (kind === "text") return ["read"];
  return [];
}

function blobPathFromStorageUri(storageUri: string): string | null {
  if (!storageUri.startsWith("file://")) return null;
  try {
    return fileURLToPath(storageUri);
  } catch {
    return null;
  }
}

async function releaseBlob(storageUri: string): Promise<void> {
  const p = blobPathFromStorageUri(storageUri);
  if (!p) return;
  await rm(p, { force: true }).catch(() => {});
}

/**
 * D391 R8 — cascade cleanup for a deleted turn. Marks the turn's `retained`
 * attachments `deleted` and removes their blobs (no orphaned files). Called
 * from the message-delete route when the LAST per-bot copy of a turn is gone
 * (see `deleteMessageHard`'s `orphanedTurnId`). Best-effort by contract: the
 * caller invokes it non-fatally, so a blob-rm miss never fails the delete.
 */
export async function cleanupRetainedAttachmentsForTurn(turnId: string): Promise<void> {
  const rows = await markRetainedAttachmentsDeletedByTurn(turnId);
  for (const row of rows) {
    await releaseBlob(row.storageUri);
  }
}

function envelopeForRow(row: MessageAttachment, bytes: Uint8Array): AttachmentEnvelope {
  const envelope: AttachmentEnvelope = {
    id: row.id,
    source: "workbench-chat",
    filename: row.filename,
    sizeBytes: row.sizeBytes,
    bytes,
  };
  if (row.claimedMime) envelope.claimedMime = row.claimedMime;
  return envelope;
}

function rejectStatus(id: string, filename: string, code: string, reason: string): ChatAttachmentStatus {
  return { id, filename, decision: "reject", code, reason };
}

function audioMetadataText(row: MessageAttachment, normalizedMime: string | undefined): string {
  const name = sanitizeAttachmentMetadataLine(row.filename);
  const mimePart = normalizedMime ? sanitizeAttachmentMetadataLine(normalizedMime) : "audio";
  return `[Attachment received audio: ${name} (${row.sizeBytes} bytes, ${mimePart}). Stored as metadata only — transcription is not automatic. Ask me to transcribe it if you want the text (long audio can be slow/costly).]`;
}

export async function normalizeChatAttachments(args: {
  attachmentIds: readonly string[];
  uploaderActorId: string;
  writableNamespaceId: string | null;
  readableNamespaceIds: readonly string[];
}): Promise<{
  textBlocks: string[];
  mediaParts: ChatMultimodalImagePart[];
  statuses: ChatAttachmentStatus[];
}> {
  const textBlocks: string[] = [];
  const mediaParts: ChatMultimodalImagePart[] = [];
  const statuses: ChatAttachmentStatus[] = [];

  if (args.attachmentIds.length === 0) {
    return { textBlocks, mediaParts, statuses };
  }
  if (args.attachmentIds.length > MAX_CHAT_ATTACHMENTS_PER_MESSAGE) {
    for (const id of args.attachmentIds) {
      statuses.push(rejectStatus(id, id, "too_many_attachments", "Too many attachments in one message"));
    }
    return { textBlocks, mediaParts, statuses };
  }
  if (!args.writableNamespaceId) {
    for (const id of args.attachmentIds) {
      statuses.push(rejectStatus(id, id, "no_writable_namespace", "No writable namespace for this turn"));
    }
    return { textBlocks, mediaParts, statuses };
  }

  let acceptedBytes = 0;
  for (const attachmentId of args.attachmentIds) {
    const row = await findPendingMessageAttachmentForSender({
      attachmentId,
      uploaderActorId: args.uploaderActorId,
      namespaceId: args.writableNamespaceId,
    });
    if (!row) {
      // Missing / expired / not owned by sender / wrong namespace — the
      // capability fence. A leaked or guessed id resolves to nothing.
      statuses.push(
        rejectStatus(attachmentId, attachmentId, "attachment_unavailable", "Attachment is not available; re-attach the file."),
      );
      continue;
    }

    let bytes: Uint8Array;
    try {
      const p = blobPathFromStorageUri(row.storageUri);
      if (!p) throw new Error("bad storage uri");
      bytes = await readFile(p);
    } catch {
      await cancelPendingMessageAttachment({ attachmentId: row.id, uploaderActorId: args.uploaderActorId });
      await releaseBlob(row.storageUri);
      statuses.push(rejectStatus(row.id, row.filename, "read_failed", "Attachment could not be read."));
      continue;
    }

    const envelope = envelopeForRow(row, bytes);
    let classification: AttachmentClassification = await classifyAttachment(envelope);

    if (classification.decision === "accept") {
      const next = acceptedBytes + row.sizeBytes;
      if (next > ATTACHMENT_POLICY.maxAcceptedBytesPerMessage) {
        classification = {
          decision: "reject",
          code: "total_bytes_exceeded",
          reason: "Total accepted attachment bytes exceed the message cap",
        };
      } else {
        acceptedBytes = next;
      }
    }

    if (classification.decision === "accept" && classification.kind === "audio") {
      // Metadata-only by design — retain the blob for an explicit transcribe.
      await resolvePendingMessageAttachment({ attachmentId: row.id, uploaderActorId: args.uploaderActorId, status: "retained" });
      textBlocks.push(audioMetadataText(row, classification.normalizedMime));
      statuses.push({ id: row.id, filename: row.filename, decision: "accept", kind: "audio" });
      log(`[chat] audio attachment retained (metadata-only) id=${row.id} sizeBytes=${row.sizeBytes}`);
      continue;
    }

    if (classification.decision === "accept" && classification.kind === "image") {
      if (row.sizeBytes > ATTACHMENT_POLICY.maxImageBytes) {
        await cancelPendingMessageAttachment({ attachmentId: row.id, uploaderActorId: args.uploaderActorId });
        await releaseBlob(row.storageUri);
        const tooLarge: AttachmentClassification = {
          decision: "reject",
          code: "image_too_large",
          reason: "Image exceeds server size cap",
        };
        textBlocks.push(metadataBlockForClassification(envelope, tooLarge).text);
        statuses.push(rejectStatus(row.id, row.filename, "image_too_large", tooLarge.reason));
        continue;
      }
      mediaParts.push({
        type: "image",
        attachmentId: row.id,
        filename: row.filename,
        mimeType: classification.normalizedMime,
        base64: Buffer.from(bytes).toString("base64"),
      });
      statuses.push({ id: row.id, filename: row.filename, decision: "accept", kind: "image" });
      // D391 — retain the image blob (mirror the audio path) so the image
      // persists across reload and renders for other room members from the
      // authed byte route. The base64 still feeds the model in-turn; the
      // blob is now kept, not released. `turn_id` is stamped by the send
      // seam (dispatch.ts) after the human message is persisted.
      await resolvePendingMessageAttachment({ attachmentId: row.id, uploaderActorId: args.uploaderActorId, status: "retained" });
      continue;
    }

    if (classification.decision === "accept" && classification.kind === "text") {
      const result = attachmentTextToContentBlock(envelope, classification);
      if (result.ok) {
        textBlocks.push(result.block.text);
        statuses.push(
          result.block.blocked
            ? { id: row.id, filename: row.filename, decision: "blocked", kind: "text", reason: "Attachment content was blocked by the content scanner", threats: result.block.threats }
            : { id: row.id, filename: row.filename, decision: "accept", kind: "text" },
        );
      } else {
        textBlocks.push(
          `[Attachment rejected: ${sanitizeAttachmentMetadataLine(row.filename)} (${sanitizeAttachmentMetadataLine(result.reason)})]`,
        );
        statuses.push(rejectStatus(row.id, row.filename, "text_block_failed", result.reason));
      }
      await resolvePendingMessageAttachment({ attachmentId: row.id, uploaderActorId: args.uploaderActorId, status: "consumed" });
      await releaseBlob(row.storageUri);
      continue;
    }

    // Unsupported kind (document/etc.), stub, or reject → cancel + release.
    await cancelPendingMessageAttachment({ attachmentId: row.id, uploaderActorId: args.uploaderActorId });
    await releaseBlob(row.storageUri);
    textBlocks.push(metadataBlockForClassification(envelope, classification).text);
    if (classification.decision === "reject") {
      statuses.push(rejectStatus(row.id, row.filename, classification.code, classification.reason));
    } else if (classification.decision === "stub") {
      statuses.push({ id: row.id, filename: row.filename, decision: "stub", kind: classification.kind, reason: classification.reason });
    } else {
      statuses.push(rejectStatus(row.id, row.filename, "unsupported", "Attachment type is not supported in chat"));
    }
  }

  return { textBlocks, mediaParts, statuses };
}
