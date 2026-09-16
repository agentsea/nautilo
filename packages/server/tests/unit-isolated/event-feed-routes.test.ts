import { afterEach, describe, expect, mock, test } from "bun:test";
import Fastify, { type FastifyInstance } from "fastify";
import { EventFeedQueryError } from "@nautilo/types";
import {
  eventFeedRoutes,
  type EventFeedReadService,
  type EventFeedRoutesDeps,
} from "../../src/routes/event-feed";

const USER_A = "11111111-1111-4111-8111-111111111111";
const USER_B = "22222222-2222-4222-8222-222222222222";
const EVENT_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

const apps: FastifyInstance[] = [];

function makeFeed(overrides: Partial<EventFeedReadService> = {}): EventFeedReadService {
  return {
    list: mock(async () => ({ events: [], nextCursor: null })),
    countUnread: mock(async () => 0),
    setRead: mock(async (_userId: string, eventId: string, read: boolean) => ({
      eventId,
      readAt: read ? "2026-09-09T12:00:00.000Z" : null,
      changed: true,
    })),
    markAllRead: mock(async () => ({ updatedCount: 0 })),
    ...overrides,
  };
}

function makeApp(feed: EventFeedReadService, resolveActorNames?: EventFeedRoutesDeps["resolveActorNames"]): FastifyInstance {
  const app = Fastify({ logger: false });
  app.decorateRequest("sessionUserId", null);
  app.addHook("preHandler", async (request) => {
    const user = request.headers["x-test-user"];
    request.sessionUserId = typeof user === "string" ? user : null;
  });
  eventFeedRoutes(app, { feed, ...(resolveActorNames ? { resolveActorNames } : {}) });
  apps.push(app);
  return app;
}

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe("event feed routes", () => {
  test("hydrates only returned own-feed actors and drops stale names when resolution fails", async () => {
    let unavailable = false;
    const resolveNames = mock(async (ids: readonly string[]) => {
      expect(ids).toEqual([USER_B]);
      if (unavailable) throw new Error("identity unavailable");
      return new Map([[USER_B, "Current author"]]);
    });
    const list = mock(async (userId: string) => {
      expect(userId).toBe(USER_A);
      return { events: [{ id: EVENT_A, actorId: USER_B, actorKind: "human" as const,
        actorDisplayName: "Stale name", type: "artifact.shared" as const,
        createdAt: "2026-09-11T12:00:00.000Z", readAt: null,
        data: { artifactId: EVENT_A, destination: { kind: "person" as const, userId: USER_A } },
      }], nextCursor: null };
    });
    const app = makeApp(makeFeed({ list }), resolveNames);
    const get = () => app.inject({ method: "GET", url: "/api/event-feed", headers: { "x-test-user": USER_A } });
    expect((await get()).json<{ events: { actorDisplayName: string | null }[] }>().events[0]?.actorDisplayName).toBe("Current author");
    unavailable = true;
    const response = await get();
    expect(response.statusCode).toBe(200);
    expect(response.json<{ events: { actorDisplayName: string | null }[] }>().events[0]?.actorDisplayName).toBeNull();
  });
  test("lists only for the authenticated Human with validated filters", async () => {
    const list = mock(async () => ({ events: [], nextCursor: "next-page" }));
    const app = makeApp(makeFeed({ list }));

    const response = await app.inject({
      method: "GET",
      url: "/api/event-feed?cursor=opaque&unreadOnly=true&types=room.member_joined&types=artifact.added&limit=25",
      headers: { "x-test-user": USER_A },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json<{ events: unknown[]; nextCursor: string }>()).toEqual({
      events: [],
      nextCursor: "next-page",
    });
    expect(list).toHaveBeenCalledWith(USER_A, {
      cursor: "opaque",
      unreadOnly: true,
      types: ["room.member_joined", "artifact.added"],
      limit: 25,
    });
  });

  test("rejects selectable user identity and malformed list input", async () => {
    const list = mock(async () => ({ events: [], nextCursor: null }));
    const app = makeApp(makeFeed({ list }));

    for (const url of [
      `/api/event-feed?userId=${USER_B}`,
      "/api/event-feed?unreadOnly=yes",
      "/api/event-feed?types=unknown.event",
      "/api/event-feed?limit=0",
    ]) {
      const response = await app.inject({
        method: "GET",
        url,
        headers: { "x-test-user": USER_A },
      });
      expect(response.statusCode).toBe(400);
      expect(response.json<{ error: string; code: string }>()).toEqual({
        error: "event_feed_error",
        code: "invalid_input",
      });
    }
    expect(list).not.toHaveBeenCalled();
  });

  test("requires authentication before every service operation", async () => {
    const feed = makeFeed();
    const app = makeApp(feed);
    const requests: Array<{
      method: "GET" | "PUT" | "POST";
      url: string;
      payload?: { read: boolean };
    }> = [
      { method: "GET", url: "/api/event-feed" },
      { method: "GET", url: "/api/event-feed/unread-count" },
      { method: "PUT", url: `/api/event-feed/${EVENT_A}/read`, payload: { read: true } },
      { method: "POST", url: "/api/event-feed/mark-all-read" },
    ];

    for (const request of requests) {
      const response = await app.inject(request);
      expect(response.statusCode).toBe(401);
    }
    expect(feed.list).not.toHaveBeenCalled();
    expect(feed.countUnread).not.toHaveBeenCalled();
    expect(feed.setRead).not.toHaveBeenCalled();
    expect(feed.markAllRead).not.toHaveBeenCalled();
  });

  test("reads counts and mutates read state only as the authenticated Human", async () => {
    const countUnread = mock(async (userId: string) => userId === USER_A ? 4 : 1);
    const setRead = mock(async (userId: string, eventId: string, read: boolean) => {
      if (userId !== USER_A || eventId !== EVENT_A) throw new EventFeedQueryError("not_found");
      return {
        eventId,
        readAt: read ? "2026-09-09T12:00:00.000Z" : null,
        changed: true,
      };
    });
    const markAllRead = mock(async (userId: string) => ({
      updatedCount: userId === USER_A ? 4 : 1,
    }));
    const app = makeApp(makeFeed({ countUnread, setRead, markAllRead }));

    const count = await app.inject({
      method: "GET",
      url: "/api/event-feed/unread-count",
      headers: { "x-test-user": USER_A },
    });
    const update = await app.inject({
      method: "PUT",
      url: `/api/event-feed/${EVENT_A}/read`,
      headers: { "x-test-user": USER_A },
      payload: { read: false },
    });
    const markAll = await app.inject({
      method: "POST",
      url: "/api/event-feed/mark-all-read",
      headers: { "x-test-user": USER_A },
    });

    expect(count.json<{ unreadCount: number }>()).toEqual({ unreadCount: 4 });
    expect(update.statusCode).toBe(200);
    expect(setRead).toHaveBeenCalledWith(USER_A, EVENT_A, false);
    expect(markAll.json<{ updatedCount: number }>()).toEqual({ updatedCount: 4 });
    expect(markAllRead).toHaveBeenCalledWith(USER_A);
  });

  test("does not disclose whether a missing or another user's event exists", async () => {
    const setRead = mock(async () => {
      throw new EventFeedQueryError("not_found");
    });
    const app = makeApp(makeFeed({ setRead }));

    const response = await app.inject({
      method: "PUT",
      url: `/api/event-feed/${EVENT_A}/read`,
      headers: { "x-test-user": USER_B },
      payload: { read: true },
    });

    expect(response.statusCode).toBe(404);
    expect(response.json<{ error: string; code: string }>()).toEqual({
      error: "event_feed_error",
      code: "not_found",
    });
    expect(setRead).toHaveBeenCalledWith(USER_B, EVENT_A, true);
  });

  test("maps an invalid opaque cursor to the stable client error", async () => {
    const list = mock(async () => {
      throw new EventFeedQueryError("invalid_cursor");
    });
    const app = makeApp(makeFeed({ list }));

    const response = await app.inject({
      method: "GET",
      url: "/api/event-feed?cursor=expired",
      headers: { "x-test-user": USER_A },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json<{ error: string; code: string }>()).toEqual({
      error: "event_feed_error",
      code: "invalid_cursor",
    });
  });

  test("rejects malformed event ids and bodies without reaching storage", async () => {
    const setRead = mock(async (_userId: string, eventId: string) => ({
      eventId,
      readAt: null,
      changed: false,
    }));
    const app = makeApp(makeFeed({ setRead }));

    for (const request of [
      { url: "/api/event-feed/not-a-uuid/read", payload: { read: true } },
      { url: `/api/event-feed/${EVENT_A}/read`, payload: { read: "yes" } },
      { url: `/api/event-feed/${EVENT_A}/read`, payload: { read: true, userId: USER_B } },
    ]) {
      const response = await app.inject({
        method: "PUT",
        url: request.url,
        headers: { "x-test-user": USER_A },
        payload: request.payload,
      });
      expect(response.statusCode).toBe(400);
    }
    expect(setRead).not.toHaveBeenCalled();
  });

  test("exposes no generic append endpoint", async () => {
    const app = makeApp(makeFeed());
    const response = await app.inject({
      method: "POST",
      url: "/api/event-feed",
      headers: { "x-test-user": USER_A },
      payload: {
        type: "artifact.added",
        recipientUserIds: [USER_A],
      },
    });
    expect(response.statusCode).toBe(404);
  });
});
