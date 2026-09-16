/**
 * D271 — message attachment upload helpers.
 *
 * Pending rows are temporary upload capabilities bound to uploader +
 * Namespace. On send each pending row resolves to:
 *   - `consumed` (text/image materialized into the turn; blob released), or
 *   - `retained` (audio; blob kept for explicit, opt-in transcribe-by-id).
 * Cancel/expiry → `deleted`. No `message_id` coupling (M127 namespace-only).
 */

import { and, asc, eq, inArray, isNotNull, isNull, lt, sql } from "drizzle-orm";
import { db, type Database } from "../config/database";
import {
  messageAttachments,
  type MessageAttachment,
  type NewMessageAttachment,
} from "../schema/message-attachments";
import { sessionMessages } from "../schema/sessions";

type Db = Database;

export interface InsertPendingMessageAttachmentInput {
  /** Pre-minted id lets upload code choose the blob path before insert. */
  id?: string | undefined;
  namespaceId: string;
  uploaderActorId: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  storageUri: string;
  expiresAt: Date;
  claimedMime?: string | undefined;
}

export async function insertPendingMessageAttachment(
  input: InsertPendingMessageAttachmentInput,
  conn: Db = db,
): Promise<MessageAttachment> {
  const row: NewMessageAttachment = {
    ...(input.id ? { id: input.id } : {}),
    namespaceId: input.namespaceId,
    uploaderActorId: input.uploaderActorId,
    filename: input.filename,
    mimeType: input.mimeType,
    sizeBytes: input.sizeBytes,
    storageUri: input.storageUri,
    expiresAt: input.expiresAt,
    ...(input.claimedMime ? { claimedMime: input.claimedMime } : {}),
  };
  const inserted = await conn.insert(messageAttachments).values(row).returning();
  return inserted[0]!;
}

/**
 * Load a pending row scoped to (uploader, namespace). The send seam calls this
 * to enforce the capability fence before reading bytes — a leaked/guessed id
 * owned by another actor or targeting another namespace returns null.
 */
export async function findPendingMessageAttachmentForSender(
  input: { attachmentId: string; uploaderActorId: string; namespaceId: string },
  conn: Db = db,
): Promise<MessageAttachment | null> {
  const rows = await conn
    .select()
    .from(messageAttachments)
    .where(
      and(
        eq(messageAttachments.id, input.attachmentId),
        eq(messageAttachments.status, "pending"),
        eq(messageAttachments.uploaderActorId, input.uploaderActorId),
        eq(messageAttachments.namespaceId, input.namespaceId),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

/**
 * Resolve a pending row at send time. `consumed` = text/image materialized
 * into the turn (caller releases the blob); `retained` = audio (blob kept).
 */
export async function resolvePendingMessageAttachment(
  input: {
    attachmentId: string;
    uploaderActorId: string;
    status: "consumed" | "retained";
    now?: Date | undefined;
  },
  conn: Db = db,
): Promise<MessageAttachment | null> {
  const now = input.now ?? new Date();
  const rows = await conn
    .update(messageAttachments)
    .set({ status: input.status, resolvedAt: now, expiresAt: null })
    .where(
      and(
        eq(messageAttachments.id, input.attachmentId),
        eq(messageAttachments.status, "pending"),
        eq(messageAttachments.uploaderActorId, input.uploaderActorId),
      ),
    )
    .returning();
  return rows[0] ?? null;
}

export async function cancelPendingMessageAttachment(
  input: { attachmentId: string; uploaderActorId: string; now?: Date | undefined },
  conn: Db = db,
): Promise<MessageAttachment | null> {
  const now = input.now ?? new Date();
  const rows = await conn
    .update(messageAttachments)
    .set({ status: "deleted", deletedAt: now, expiresAt: null })
    .where(
      and(
        eq(messageAttachments.id, input.attachmentId),
        eq(messageAttachments.status, "pending"),
        eq(messageAttachments.uploaderActorId, input.uploaderActorId),
      ),
    )
    .returning();
  return rows[0] ?? null;
}

/**
 * Read a `retained` attachment (audio) by id, namespace-gated. Used by the
 * explicit transcribe-by-attachmentId path (D271 audio sub-task).
 */
export async function findRetainedMessageAttachmentForNamespaces(
  input: { attachmentId: string; readableNamespaceIds: readonly string[] },
  conn: Db = db,
): Promise<MessageAttachment | null> {
  if (input.readableNamespaceIds.length === 0) return null;
  const rows = await conn
    .select()
    .from(messageAttachments)
    .where(
      and(
        eq(messageAttachments.id, input.attachmentId),
        eq(messageAttachments.status, "retained"),
        inArray(messageAttachments.namespaceId, [...input.readableNamespaceIds]),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

export async function sumPendingMessageAttachmentBytesForActor(
  input: { uploaderActorId: string },
  conn: Db = db,
): Promise<number> {
  const rows = await conn
    .select({ total: sql<string>`coalesce(sum(${messageAttachments.sizeBytes}), 0)::bigint` })
    .from(messageAttachments)
    .where(
      and(
        eq(messageAttachments.uploaderActorId, input.uploaderActorId),
        eq(messageAttachments.status, "pending"),
      ),
    );
  return Number(rows[0]?.total ?? 0);
}

export async function findExpiredPendingMessageAttachments(
  input: { now?: Date | undefined; limit?: number | undefined },
  conn: Db = db,
): Promise<MessageAttachment[]> {
  const now = input.now ?? new Date();
  const limit = input.limit ?? 100;
  return conn
    .select()
    .from(messageAttachments)
    .where(
      and(
        eq(messageAttachments.status, "pending"),
        isNotNull(messageAttachments.expiresAt),
        lt(messageAttachments.expiresAt, now),
      ),
    )
    .orderBy(asc(messageAttachments.expiresAt))
    .limit(limit);
}

/**
 * D391 — durable message attachments.
 *
 * Retained attachments (images now, audio already) carry a `turn_id` equal to
 * the M134 `session_messages.fingerprint` of the human turn they were sent
 * with. The room history read joins on it, so an attachment renders once per
 * deduped message regardless of how many per-bot copies of the message exist.
 */

/**
 * Stamp `turn_id` on a batch of retained attachment rows. Called from the
 * send seam (dispatch.ts) after the human message is persisted: the row's
 * `fingerprint` is looked up by `messageId` and applied to every retained
 * attachment that came in with this turn. Idempotent — re-stamping the same
 * value is a no-op; rows already carrying a different `turn_id` are left
 * untouched (matched by id AND `turn_id IS NULL`).
 */
export async function stampTurnIdOnAttachments(
  input: { attachmentIds: readonly string[]; turnId: string },
  conn: Db = db,
): Promise<void> {
  if (input.attachmentIds.length === 0) return;
  await conn
    .update(messageAttachments)
    .set({ turnId: input.turnId })
    .where(
      and(
        inArray(messageAttachments.id, [...input.attachmentIds]),
        isNull(messageAttachments.turnId),
      ),
    );
}

/**
 * Read the retained attachments linked to a set of human turns (by
 * `turn_id` = M134 fingerprint). Used by the room history read to attach
 * `attachments[]` per deduped message. Returns only `retained` rows (the
 * durable ones); `consumed`/`pending`/`deleted` have no blob to serve.
 */
export async function getAttachmentsForTurns(
  turnIds: readonly string[],
  conn: Db = db,
): Promise<MessageAttachment[]> {
  if (turnIds.length === 0) return [];
  return conn
    .select()
    .from(messageAttachments)
    .where(
      and(
        inArray(messageAttachments.turnId, [...turnIds]),
        eq(messageAttachments.status, "retained"),
      ),
    )
    .orderBy(asc(messageAttachments.createdAt), asc(messageAttachments.id));
}

/**
 * D391 R8 — minimal blob-cleanup-on-delete. Marks a retained attachment
 * `deleted` and returns the row (so the caller can `rm` the blob from its
 * `storage_uri`). No broader retained-blob GC/quota here (deferred to the
 * D271/cloud track); this is the "no orphaned files when an attachment is
 * removed" floor. Namespace-gated like the retained-by-id read.
 */
export async function markRetainedAttachmentDeletedForNamespaces(
  input: { attachmentId: string; readableNamespaceIds: readonly string[]; now?: Date | undefined },
  conn: Db = db,
): Promise<MessageAttachment | null> {
  if (input.readableNamespaceIds.length === 0) return null;
  const now = input.now ?? new Date();
  const rows = await conn
    .update(messageAttachments)
    .set({ status: "deleted", deletedAt: now })
    .where(
      and(
        eq(messageAttachments.id, input.attachmentId),
        eq(messageAttachments.status, "retained"),
        inArray(messageAttachments.namespaceId, [...input.readableNamespaceIds]),
      ),
    )
    .returning();
  return rows[0] ?? null;
}


/**
 * D391 — look up a `session_messages` row's `fingerprint` by id. Used by the
 * send seam (dispatch.ts) after the human message is persisted: the returned
 * `messageId` is the just-inserted human row, and its `fingerprint` is the
 * M134 dedup key to stamp on this turn's retained attachments. Uses the
 * full-privilege `db` (the send seam already enforced sender + namespace
 * authz; this is an internal server-side linkage, not a user-facing read).
 * Returns `null` if the row is gone or has no fingerprint (non-user rows).
 */
export async function getSessionMessageFingerprintById(
  messageId: number,
  conn: Db = db,
): Promise<string | null> {
  const rows = await conn
    .select({ fingerprint: sessionMessages.fingerprint })
    .from(sessionMessages)
    .where(eq(sessionMessages.id, messageId))
    .limit(1);
  return rows[0]?.fingerprint ?? null;
}

/**
 * D391 R8 — cascade cleanup: mark every `retained` attachment for a turn
 * (`turn_id` = fingerprint) as `deleted` and RETURN the rows so the caller can
 * `rm` their blobs. Called from the message-delete path when the last per-bot
 * copy of a turn is removed (no orphaned files). Un-gated (internal
 * server-side linkage; the delete route already authorized the message delete).
 */
export async function markRetainedAttachmentsDeletedByTurn(
  turnId: string,
  conn: Db = db,
): Promise<MessageAttachment[]> {
  return conn
    .update(messageAttachments)
    .set({ status: "deleted", deletedAt: new Date() })
    .where(
      and(
        eq(messageAttachments.turnId, turnId),
        eq(messageAttachments.status, "retained"),
      ),
    )
    .returning();
}
