import {
  getAttachmentsForTurns,
  getSessionMessageFingerprintById,
  stampTurnIdOnAttachments,
} from "@nautilo/db";
import { log } from "@nautilo/logger";
import type { ChatAttachmentStatus, MessageAttachmentRef } from "@nautilo/types";
import { retainedAttachmentIdsFromStatuses } from "./attachments";

/**
 * Link this send's retained attachments to its durable Human turn, then return
 * the room-safe descriptors for live delivery. The history read uses the same
 * retained-row query, so the live and history identities cannot drift.
 */
export async function linkAndLoadRetainedAttachmentRefs(args: {
  messageId: number | null;
  statuses: readonly ChatAttachmentStatus[];
  canonicalRoomNamespaceId?: string | null | undefined;
}): Promise<MessageAttachmentRef[]> {
  if (args.messageId == null) return [];
  const retainedIds = retainedAttachmentIdsFromStatuses(args.statuses);
  if (retainedIds.length === 0) return [];

  const fingerprint = await getSessionMessageFingerprintById(args.messageId);
  if (!fingerprint) {
    log(
      `[attachments] could not resolve human fingerprint for messageId=${args.messageId}; ${retainedIds.length} attachment(s) will not be linked to history`,
    );
    return [];
  }

  await stampTurnIdOnAttachments({ attachmentIds: retainedIds, turnId: fingerprint });

  const canonicalRoomNamespaceId = args.canonicalRoomNamespaceId ?? null;
  if (!canonicalRoomNamespaceId) return [];
  const retainedIdSet = new Set(retainedIds);
  const rows = await getAttachmentsForTurns([fingerprint]);
  return rows
    .filter((row) =>
      row.namespaceId === canonicalRoomNamespaceId && retainedIdSet.has(row.id)
    )
    .map((row) => ({
      attachmentId: row.id,
      filename: row.filename,
      mimeType: row.mimeType,
      sizeBytes: row.sizeBytes,
    }));
}
