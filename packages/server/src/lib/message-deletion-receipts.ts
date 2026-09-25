import {
  and,
  desc,
  eq,
  getSharedDirectDb,
  messageDeletionReceipts,
  or,
  type MessageDeletionReceipt,
} from "@nautilo/db";
import { getTableColumns, lt, sql } from "drizzle-orm";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const EXACT_UTC_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;

export class InvalidMessageDeletionQuery extends Error {
  constructor() {
    super("invalid_message_deletion_query");
  }
}

export interface MessageDeletionReceiptQuery {
  roomId?: string;
  messageId?: string;
  operationId?: string;
  cursor?: string;
  limit?: string;
  /** Non-owner audit readers are restricted to their own actor. */
  actorId?: string;
}

export interface MessageDeletionReceiptPage {
  receipts: MessageDeletionReceipt[];
  nextCursor: string | null;
}

function decodeCursor(raw: string): { committedAt: string; operationId: string } {
  try {
    const value: unknown = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
    if (!value || typeof value !== "object") throw new Error("invalid cursor");
    const row = value as Record<string, unknown>;
    if (typeof row["committedAt"] !== "string" || typeof row["operationId"] !== "string") {
      throw new Error("invalid cursor");
    }
    const committedAt = row["committedAt"];
    const parsed = new Date(committedAt);
    if (!EXACT_UTC_TIMESTAMP.test(committedAt)
      || Number.isNaN(parsed.getTime())
      || parsed.toISOString().slice(0, 23) !== committedAt.slice(0, 23)
      || !UUID.test(row["operationId"])) {
      throw new Error("invalid cursor");
    }
    return { committedAt, operationId: row["operationId"] };
  } catch {
    throw new InvalidMessageDeletionQuery();
  }
}

export async function findMessageDeletionReceiptByReportId(
  reportId: string,
): Promise<MessageDeletionReceipt | null> {
  const [receipt] = await getSharedDirectDb()
    .select()
    .from(messageDeletionReceipts)
    .where(eq(messageDeletionReceipts.reportId, reportId))
    .limit(1);
  return receipt ?? null;
}

export async function listMessageDeletionReceipts(
  query: MessageDeletionReceiptQuery,
): Promise<MessageDeletionReceiptPage> {
  // An owner must choose an indexed incident scope; non-owner reads have an
  // actor scope imposed by the route. Never sort the entire receipt table.
  if (!query.roomId && !query.messageId && !query.operationId && !query.actorId) {
    throw new InvalidMessageDeletionQuery();
  }
  if (query.roomId !== undefined && !UUID.test(query.roomId)) throw new InvalidMessageDeletionQuery();
  if (query.operationId !== undefined && !UUID.test(query.operationId)) throw new InvalidMessageDeletionQuery();
  if (query.actorId !== undefined && !UUID.test(query.actorId)) throw new InvalidMessageDeletionQuery();
  const messageId = query.messageId === undefined ? undefined : Number(query.messageId);
  if (messageId !== undefined && (!Number.isSafeInteger(messageId) || messageId <= 0)) {
    throw new InvalidMessageDeletionQuery();
  }
  const limit = query.limit === undefined ? 50 : Number(query.limit);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new InvalidMessageDeletionQuery();
  const cursor = query.cursor === undefined ? undefined : decodeCursor(query.cursor);
  const cursorTime = cursor === undefined
    ? undefined : sql`${cursor.committedAt}::timestamptz`;
  const conditions = [
    query.roomId === undefined ? undefined : eq(messageDeletionReceipts.roomId, query.roomId),
    messageId === undefined ? undefined : eq(messageDeletionReceipts.messageId, messageId),
    query.operationId === undefined ? undefined : eq(messageDeletionReceipts.operationId, query.operationId),
    query.actorId === undefined ? undefined : eq(messageDeletionReceipts.actorId, query.actorId),
    cursor === undefined || cursorTime === undefined ? undefined : or(
      lt(messageDeletionReceipts.committedAt, cursorTime),
      and(
        eq(messageDeletionReceipts.committedAt, cursorTime),
        lt(messageDeletionReceipts.operationId, cursor.operationId),
      ),
    ),
  ].filter((condition) => condition !== undefined);
  const rows = await getSharedDirectDb()
    .select({
      ...getTableColumns(messageDeletionReceipts),
      cursorCommittedAt: sql<string>`to_char(${messageDeletionReceipts.committedAt} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`,
    })
    .from(messageDeletionReceipts)
    .where(and(...conditions))
    .orderBy(desc(messageDeletionReceipts.committedAt), desc(messageDeletionReceipts.operationId))
    .limit(limit + 1);
  const receipts = rows.slice(0, limit).map(({ cursorCommittedAt, ...receipt }) => {
    void cursorCommittedAt;
    return receipt;
  });
  const last = rows[limit - 1];
  return {
    receipts,
    nextCursor: rows.length > limit && last
      ? Buffer.from(JSON.stringify({
          committedAt: last.cursorCommittedAt,
          operationId: last.operationId,
        })).toString("base64url")
      : null,
  };
}
