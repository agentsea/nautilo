import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  EventFeedApiError,
  NautiloApiClient,
} from "../../src/client";

const EVENT_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

describe("event feed client contract", () => {
  let realFetch: typeof fetch;
  const requests: Array<{ url: string; init?: RequestInit }> = [];

  beforeEach(() => {
    realFetch = globalThis.fetch;
    requests.length = 0;
    const mockFetch = async (
      input: Parameters<typeof fetch>[0],
      init?: RequestInit,
    ) => {
      const url = typeof input === "string" ? input : (input as URL).toString();
      requests.push({ url, ...(init ? { init } : {}) });
      if (url.endsWith("/preference")) return Response.json(
        init?.method === "PUT" && typeof init.body === "string" ? JSON.parse(init.body) : { mode: "active" },
      );
      if (url.endsWith("/unread-count")) {
        return Response.json({ unreadCount: 3 });
      }
      if (url.endsWith("/mark-all-read")) {
        return Response.json({ updatedCount: 3 });
      }
      if (url.endsWith("/read")) {
        return Response.json({
          eventId: EVENT_ID,
          readAt: "2026-09-09T12:00:00.000Z",
          changed: true,
        });
      }
      return Response.json({
        events: [
          {
            id: EVENT_ID,
            type: "artifact.added",
            actorKind: "human",
            actorId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
            data: {
              artifactId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
              roomId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
            },
            createdAt: "2026-09-09T11:00:00.000Z",
            readAt: null,
          },
        ],
        nextCursor: "opaque-next",
      });
    };
    globalThis.fetch = Object.assign(mockFetch, {
      preconnect: realFetch.preconnect.bind(realFetch),
    }) as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  test("lists with stable pagination and filter query parameters", async () => {
    const client = new NautiloApiClient("http://127.0.0.1:9");
    client.setToken("token");

    const page = await client.listEventFeed({
      cursor: "opaque",
      unreadOnly: true,
      types: ["room.member_joined", "artifact.added"],
      limit: 25,
    });

    expect(page.events[0]?.id).toBe(EVENT_ID);
    expect(requests[0]?.url).toBe(
      "http://127.0.0.1:9/api/event-feed?cursor=opaque&unreadOnly=true&types=room.member_joined&types=artifact.added&limit=25",
    );
    expect(requests[0]?.init?.method).toBe("GET");
  });

  test("reads and writes typed personal preferences without sending an identity", async () => {
    const client = new NautiloApiClient("http://127.0.0.1:9");
    client.setToken("token");
    expect(await client.getEventFeedPreference()).toEqual({ mode: "active" });
    expect(await client.setEventFeedPreference({ mode: "quiet" })).toEqual({ mode: "quiet" });
    expect(requests[0]?.url).toBe("http://127.0.0.1:9/api/event-feed/preference");
    expect(requests[1]?.init?.body).toBe('{"mode":"quiet"}');
  });

  test("reads count and sends explicit read-state and mark-all mutations", async () => {
    const client = new NautiloApiClient("http://127.0.0.1:9");
    client.setToken("token");

    expect(await client.getEventFeedUnreadCount()).toEqual({ unreadCount: 3 });
    expect(await client.setEventFeedReadState(EVENT_ID, true)).toMatchObject({
      eventId: EVENT_ID,
      changed: true,
    });
    expect(await client.markAllEventFeedRead()).toEqual({ updatedCount: 3 });

    expect(requests.map(({ url, init }) => ({
      url,
      method: init?.method ?? "GET",
      body: init?.body,
    }))).toEqual([
      {
        url: "http://127.0.0.1:9/api/event-feed/unread-count",
        method: "GET",
        body: undefined,
      },
      {
        url: `http://127.0.0.1:9/api/event-feed/${EVENT_ID}/read`,
        method: "PUT",
        body: JSON.stringify({ read: true }),
      },
      {
        url: "http://127.0.0.1:9/api/event-feed/mark-all-read",
        method: "POST",
        body: undefined,
      },
    ]);
  });

  test("maps stable server codes to EventFeedApiError", async () => {
    globalThis.fetch = Object.assign(
      async () => Response.json(
        { error: "event_feed_error", code: "invalid_cursor" },
        { status: 400 },
      ),
      { preconnect: realFetch.preconnect.bind(realFetch) },
    ) as typeof fetch;
    const client = new NautiloApiClient("http://127.0.0.1:9");
    client.setToken("token");

    let caught: unknown;
    try {
      await client.listEventFeed({ cursor: "stale" });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(EventFeedApiError);
    expect((caught as EventFeedApiError).code).toBe("invalid_cursor");
    expect((caught as EventFeedApiError).status).toBe(400);
  });
});
