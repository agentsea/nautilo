import { describe, expect, mock, test } from "bun:test";
import { PgDialect } from "drizzle-orm/pg-core";
import type { DirectDatabase } from "@nautilo/db";
import {
  MAX_NOTIFICATION_STATE_DETAILS,
  NotificationStateTooLargeError,
  getChangedNotificationState,
  getImportantMessageArrivals,
  getLegacyOwnRoomUnreadCounts,
  getNotificationState,
  getNotificationUnreadCount,
  sanitizeNotificationLabel,
} from "../../src/notification-state";

const USER = "11111111-1111-4111-8111-111111111111";
const PARENT = "22222222-2222-4222-8222-222222222222";
const CHILD = "33333333-3333-4333-8333-333333333333";

function databaseReturning(rows: unknown[]): {
  database: DirectDatabase;
  execute: ReturnType<typeof mock>;
} {
  const execute = mock(async () => rows);
  return {
    database: { execute } as unknown as DirectDatabase,
    execute,
  };
}

function renderedSql(query: unknown): string {
  return new PgDialect().sqlToQuery(
    query as Parameters<PgDialect["sqlToQuery"]>[0],
  ).sql;
}

describe("M236 notification state folding", () => {
  test("legacy unread calculation excludes internal website supervision with NULL-safe predicates", async () => {
    const { database, execute } = databaseReturning([]);
    await getNotificationState(USER, database);
    const query = renderedSql(execute.mock.calls[0]?.[0]);
    expect(query).toContain("IS DISTINCT FROM 'connected_web_operation'");
    expect(query).toContain("IS DISTINCT FROM 'task'");
  });
  test("folds own, participating child, aggregate, global, and explicit preferences", async () => {
    const { database, execute } = databaseReturning([
      {
        user_id: USER,
        room_id: PARENT,
        top_level_room_id: PARENT,
        parent_room_id: null,
        thread_root_message_id: null,
        reply_count: null,
        default_level: "none",
        override_level: "direct",
        effective_level: "direct",
        own_unread_count: "3",
        own_important_unread_count: "1",
      },
      {
        user_id: USER,
        room_id: CHILD,
        top_level_room_id: PARENT,
        parent_room_id: PARENT,
        thread_root_message_id: "42",
        reply_count: "7",
        default_level: "none",
        override_level: "direct",
        effective_level: "direct",
        own_unread_count: "2",
        own_important_unread_count: "1",
      },
    ]);

    const state = await getNotificationState(USER, database);

    expect(execute).toHaveBeenCalledTimes(1);
    expect(state.preferences).toEqual({
      defaultLevel: "none",
      roomOverrides: [{ roomId: PARENT, level: "direct" }],
    });
    expect(state.rooms).toEqual([
      {
        roomId: PARENT,
        ownUnreadCount: 3,
        ownImportantUnreadCount: 1,
        subthreadUnreadCount: 2,
        subthreadImportantUnreadCount: 1,
        unreadCount: 5,
        importantUnreadCount: 2,
      },
    ]);
    expect(state.subthreads).toEqual([
      {
        roomId: CHILD,
        parentRoomId: PARENT,
        anchorMessageId: 42,
        replyCount: 7,
        unreadCount: 2,
        importantUnreadCount: 1,
      },
    ]);
    expect(state.totals).toEqual({
      unreadCount: 5,
      importantUnreadCount: 2,
    });
    expect(Number.isNaN(Date.parse(state.generatedAt))).toBe(false);
  });

  test("returns default preferences and zero totals for an empty authorized scope", async () => {
    const { database } = databaseReturning([
      {
        user_id: USER,
        room_id: null,
        top_level_room_id: null,
        parent_room_id: null,
        thread_root_message_id: null,
        reply_count: null,
        default_level: "all",
        override_level: null,
        effective_level: "all",
        own_unread_count: "0",
        own_important_unread_count: "0",
      },
    ]);

    const state = await getNotificationState(USER, database);
    expect(state.preferences.defaultLevel).toBe("all");
    expect(state.rooms).toEqual([]);
    expect(state.subthreads).toEqual([]);
    expect(state.totals).toEqual({
      unreadCount: 0,
      importantUnreadCount: 0,
    });
  });

  test("recomputes a changed child and its top-level rollup in one DB call", async () => {
    const { database, execute } = databaseReturning([
      {
        user_id: USER,
        room_id: PARENT,
        top_level_room_id: PARENT,
        parent_room_id: null,
        thread_root_message_id: null,
        reply_count: null,
        default_level: "direct",
        override_level: null,
        effective_level: "direct",
        own_unread_count: 4,
        own_important_unread_count: 1,
      },
      {
        user_id: USER,
        room_id: CHILD,
        top_level_room_id: PARENT,
        parent_room_id: PARENT,
        thread_root_message_id: 42,
        reply_count: 7,
        default_level: "direct",
        override_level: null,
        effective_level: "direct",
        own_unread_count: 2,
        own_important_unread_count: 2,
      },
    ]);

    expect(
      await getChangedNotificationState(CHILD, [USER], database),
    ).toEqual([
      {
        userId: USER,
        roomId: CHILD,
        topLevelRoomId: PARENT,
        roomOwnUnreadCount: 2,
        roomOwnImportantUnreadCount: 2,
        topLevelUnreadCount: 6,
        topLevelImportantUnreadCount: 3,
      },
    ]);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  test("fails closed above the fixed complete-detail bound", async () => {
    const row = {
      user_id: USER,
      top_level_room_id: PARENT,
      parent_room_id: null,
      thread_root_message_id: null,
      reply_count: null,
      default_level: "direct",
      override_level: null,
      effective_level: "direct",
      own_unread_count: 0,
      own_important_unread_count: 0,
    };
    const { database } = databaseReturning(
      Array.from({ length: 10_001 }, (_, index) => ({
        ...row,
        room_id: `${index}`,
      })),
    );

    let caught: unknown;
    try {
      await getNotificationState(USER, database);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(NotificationStateTooLargeError);
  });

  test("builds arrival DTOs only from durable rows and sanitizes every label", async () => {
    const longLabel = ` Room\u0000\n${"x".repeat(250)} `;
    const { database, execute } = databaseReturning([
      {
        user_id: USER,
        message_id: 42,
        room_id: CHILD,
        top_level_room_id: PARENT,
        sender_actor_id: "actor-sender",
        sender_display_name: "\u0007  Alice\nExample ",
        room_label: longLabel,
        parent_room_label: "\tParent\rRoom",
        occurred_at: new Date("2026-08-03T12:00:00.000Z"),
      },
    ]);

    const arrivals = await getImportantMessageArrivals(42, database);

    expect(execute).toHaveBeenCalledTimes(1);
    expect(arrivals).toEqual([
      {
        type: "notification.message.important",
        userId: USER,
        messageId: "42",
        roomId: CHILD,
        topLevelRoomId: PARENT,
        senderActorId: "actor-sender",
        senderDisplayName: "Alice Example",
        roomLabel: sanitizeNotificationLabel(longLabel, "A conversation"),
        parentRoomLabel: "Parent Room",
        occurredAt: "2026-08-03T12:00:00.000Z",
      },
    ]);
    expect(arrivals[0]!.roomLabel.length).toBe(200);
    expect(JSON.stringify(arrivals[0])).not.toContain("content");
  });

  test("reads important-arrival eligibility only from committed structural facts", async () => {
    const { database, execute } = databaseReturning([]);

    await getImportantMessageArrivals(42, database);

    const query = renderedSql(execute.mock.calls[0]?.[0]);
    expect(query).toContain("push_message_candidates");
    expect(query).toContain("human_blocks");
    expect(query).toContain("member_count");
    expect(query).not.toMatch(/\bcontent\b/i);
    expect(query).not.toMatch(/\bmetadata\b/i);
    expect(query).not.toMatch(/\bcrypto\b/i);
  });

  test("fails closed for an invalid durable message identifier", async () => {
    const { database, execute } = databaseReturning([]);
    expect(await getImportantMessageArrivals(Number.NaN, database)).toEqual([]);
    expect(execute).not.toHaveBeenCalled();
  });

  test("keeps legacy own counts independent of the REST detail bound", async () => {
    const { database, execute } = databaseReturning(
      Array.from({ length: MAX_NOTIFICATION_STATE_DETAILS + 1 }, (_, index) => ({
        user_id: USER,
        room_id: `room-${index}`,
        top_level_room_id: `room-${index}`,
        parent_room_id: null,
        thread_root_message_id: null,
        reply_count: null,
        default_level: "direct",
        override_level: null,
        effective_level: "direct",
        own_unread_count: 1,
        own_important_unread_count: 0,
      })),
    );

    const counts = await getLegacyOwnRoomUnreadCounts(USER, database);

    expect(execute).toHaveBeenCalledTimes(1);
    expect(counts.size).toBe(MAX_NOTIFICATION_STATE_DETAILS + 1);
    expect(counts.get("room-10000")).toBe(1);
  });

  test("computes a lightweight badge total independently of the REST detail bound", async () => {
    const { database, execute } = databaseReturning(
      Array.from({ length: MAX_NOTIFICATION_STATE_DETAILS + 1 }, (_, index) => ({
        user_id: USER,
        room_id: `room-${index}`,
        top_level_room_id: `room-${index}`,
        parent_room_id: null,
        thread_root_message_id: null,
        reply_count: null,
        default_level: "direct",
        override_level: null,
        effective_level: "direct",
        own_unread_count: 1,
        own_important_unread_count: 0,
      })),
    );

    expect(await getNotificationUnreadCount(USER, database)).toBe(
      MAX_NOTIFICATION_STATE_DETAILS + 1,
    );
    expect(execute).toHaveBeenCalledTimes(1);
  });
});
