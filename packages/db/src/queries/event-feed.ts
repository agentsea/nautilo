import { and, count, desc, eq, inArray, isNull, lt, or, sql } from "drizzle-orm";
import type { EventFeedListOptions, EventFeedPage, EventFeedRecordInput } from "@nautilo/types";
import { EVENT_FEED_PAGE_SIZE, EventFeedQueryError, eventFeedItemSchema } from "@nautilo/types";
import type { DirectDatabase } from "../config/direct-database";
import { withTrustContext } from "../connection/with-trust-context";
import { feedEvents, feedRecipients } from "../schema/event-feed";

// Transport batch, never a history limit: every nonfinal page has continuation.
const PAGE_SIZE = EVENT_FEED_PAGE_SIZE;

/** Trusted server invalidation only. Historical recipients need a content-free
 * hint even after their resource authority is revoked. This never grants reads. */
export async function listArtifactFeedRecipientUserIds(db: DirectDatabase, artifactId: string): Promise<string[]> {
  return db.transaction(async tx => {
    await tx.execute(sql`select set_config('app.event_feed_writer', 'on', true)`);
    const rows = await tx.selectDistinct({ userId: feedRecipients.userId }).from(feedRecipients)
      .innerJoin(feedEvents, eq(feedEvents.id, feedRecipients.eventId))
      .where(and(inArray(feedEvents.type, ["artifact.added", "artifact.shared"]),
        eq(sql<string>`${feedEvents.data}->>'artifactId'`, artifactId)));
    return rows.map(row => row.userId);
  });
}

function encodeCursor(createdAt: Date, id: string): string {
  return Buffer.from(JSON.stringify([createdAt.toISOString(), id])).toString("base64url");
}
function decodeCursor(cursor: string): { createdAt: Date; id: string } {
  try {
    const value: unknown = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    if (!Array.isArray(value) || value.length !== 2 || typeof value[0] !== "string" || typeof value[1] !== "string") throw new Error();
    const createdAt = new Date(value[0]);
    if (!Number.isFinite(createdAt.getTime()) || createdAt.toISOString() !== value[0] || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value[1])) throw new Error();
    if (encodeCursor(createdAt, value[1]) !== cursor) throw new Error();
    return { createdAt, id: value[1] };
  } catch {
    throw new EventFeedQueryError("invalid_cursor");
  }
}

/** Structural adapter: database owns queries without importing the feed engine. */
export function createEventFeedStorage(db: DirectDatabase) {
  type Transaction = Parameters<Parameters<DirectDatabase["transaction"]>[0]>[0];
  function asReader<T>(userId: string, operation: (tx: Transaction) => Promise<T>): Promise<T> {
    return withTrustContext({ userId }, async (tx) => {
      // The application role has BYPASSRLS; downgrade on the same transaction.
      await tx.execute(sql`set local role nautilo_feed_reader`);
      return operation(tx);
    }, db);
  }
  return {
    async record(input: EventFeedRecordInput): Promise<{ status: "stored" | "duplicate"; eventId: string } | { status: "conflict" }> {
      return db.transaction(async (tx) => {
        // This flag is server-owned and transaction-local; no endpoint accepts it.
        await tx.execute(sql`select set_config('app.event_feed_writer', 'on', true)`);
        const [inserted] = await tx.insert(feedEvents).values({
          occurrenceKey: input.key, type: input.type, actorId: input.actorId,
          actorKind: input.actorKind, data: input.data,
        }).onConflictDoNothing({ target: feedEvents.occurrenceKey }).returning({ id: feedEvents.id });
        if (!inserted) {
          // JSONB equality is order-independent. A replay never widens recipients.
          const [existing] = await tx.select({ id: feedEvents.id }).from(feedEvents).where(and(
            eq(feedEvents.occurrenceKey, input.key), eq(feedEvents.type, input.type),
            eq(feedEvents.actorKind, input.actorKind), eq(feedEvents.actorId, input.actorId),
            eq(feedEvents.data, input.data),
          ));
          return existing ? { status: "duplicate", eventId: existing.id } : { status: "conflict" };
        }
        // One array parameter avoids PostgreSQL bind-count limits without a queue.
        const recipientIds = [...new Set(input.recipientUserIds)];
        await tx.insert(feedRecipients).select(
          tx.select({
            eventId: sql<string>`${inserted.id}::uuid`.as("event_id"),
            userId: sql<string>`recipient_id`.as("user_id"),
            readAt: sql<Date | null>`null::timestamptz`.as("read_at"),
          }).from(sql`unnest(${sql.param(recipientIds)}::uuid[]) as recipient_id`),
        );
        return { status: "stored", eventId: inserted.id };
      });
    },
    async list(userId: string, options: EventFeedListOptions = {}): Promise<EventFeedPage> {
      const limit = options.limit ?? PAGE_SIZE;
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > PAGE_SIZE) throw new EventFeedQueryError("invalid_input");
      const cursor = options.cursor === undefined ? undefined : decodeCursor(options.cursor);
      return asReader(userId, async (tx) => {
        const rows = await tx.select({
          id: feedEvents.id, type: feedEvents.type, actorId: feedEvents.actorId,
          actorKind: feedEvents.actorKind, data: feedEvents.data,
          createdAt: feedEvents.createdAt, readAt: feedRecipients.readAt,
        }).from(feedRecipients).innerJoin(feedEvents, eq(feedEvents.id, feedRecipients.eventId))
          .where(and(
            eq(feedRecipients.userId, userId),
            options.unreadOnly ? isNull(feedRecipients.readAt) : undefined,
            options.types?.length ? inArray(feedEvents.type, [...options.types]) : undefined,
            cursor ? or(lt(feedEvents.createdAt, cursor.createdAt), and(eq(feedEvents.createdAt, cursor.createdAt), lt(feedEvents.id, cursor.id))) : undefined,
          )).orderBy(desc(feedEvents.createdAt), desc(feedEvents.id)).limit(limit + 1);
        const page = rows.slice(0, limit);
        const last = page.at(-1);
        return {
          events: page.map((row) => eventFeedItemSchema.parse({ ...row, createdAt: row.createdAt.toISOString(), readAt: row.readAt?.toISOString() ?? null })),
          nextCursor: rows.length > limit && last ? encodeCursor(last.createdAt, last.id) : null,
        };
      });
    },
    async countUnread(userId: string): Promise<number> {
      return asReader(userId, async (tx) => {
        const [row] = await tx.select({ value: count() }).from(feedRecipients).where(and(eq(feedRecipients.userId, userId), isNull(feedRecipients.readAt)));
        return row?.value ?? 0;
      });
    },
    async setRead(userId: string, eventId: string, read: boolean) {
      return asReader(userId, async (tx) => {
        const [current] = await tx.select({ readAt: feedRecipients.readAt }).from(feedRecipients)
          .where(and(eq(feedRecipients.userId, userId), eq(feedRecipients.eventId, eventId))).for("update");
        if (!current) throw new EventFeedQueryError("not_found");
        if ((current.readAt !== null) === read) return { eventId, readAt: current.readAt?.toISOString() ?? null, changed: false };
        const [updated] = await tx.update(feedRecipients).set({ readAt: read ? sql`statement_timestamp()` : null })
          .where(and(eq(feedRecipients.userId, userId), eq(feedRecipients.eventId, eventId))).returning({ readAt: feedRecipients.readAt });
        return { eventId, readAt: updated!.readAt?.toISOString() ?? null, changed: true };
      });
    },
    async markAllRead(userId: string) {
      return asReader(userId, async (tx) => {
        // One UPDATE snapshot; no client-page loop and no history watermark.
        const result = await tx.update(feedRecipients).set({ readAt: sql`statement_timestamp()` })
          .where(and(eq(feedRecipients.userId, userId), isNull(feedRecipients.readAt)));
        return { updatedCount: result.count };
      });
    },
  };
}
