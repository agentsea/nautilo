import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  NautiloApiClient,
  NotificationStateTooLargeApiError,
} from "../../src/client";

describe("notification preference client contracts", () => {
  let realFetch: typeof fetch;
  const requests: Array<{ url: string; init?: RequestInit }> = [];

  beforeEach(() => {
    realFetch = globalThis.fetch;
    requests.length = 0;
    const mockFetch = async (
      input: Parameters<typeof fetch>[0],
      init?: RequestInit,
    ) => {
      requests.push({
        url: typeof input === "string" ? input : (input as URL).toString(),
        ...(init ? { init } : {}),
      });
      return new Response(
        JSON.stringify({
          defaultLevel: "direct",
          roomOverrides: [],
          roomId: "room-1",
          effectiveLevel: "direct",
          inherited: true,
          overrideLevel: null,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    };
    globalThis.fetch = Object.assign(mockFetch, {
      preconnect: realFetch.preconnect.bind(realFetch),
    }) as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  function requestBody(index: number): unknown {
    const body = requests[index]?.init?.body;
    if (typeof body !== "string") {
      throw new Error(`request ${index} did not carry a JSON string body`);
    }
    return JSON.parse(body) as unknown;
  }

  test("reads and mutates account and Room preferences with typed bodies", async () => {
    const client = new NautiloApiClient("http://127.0.0.1:9");
    let invalidations = 0;
    client.setNotificationStateInvalidationHandler(() => {
      invalidations += 1;
    });
    client.setToken("token");
    await client.getNotificationPreferences();
    await client.getNotificationState();
    await client.setDefaultNotificationLevel("all");
    await client.setRoomNotificationPreference("room-1", "inherit");

    expect(requests.map((request) => request.url)).toEqual([
      "http://127.0.0.1:9/api/notifications/preferences",
      "http://127.0.0.1:9/api/notifications/state",
      "http://127.0.0.1:9/api/notifications/preferences",
      "http://127.0.0.1:9/api/rooms/room-1/notification-preference",
    ]);
    expect(requestBody(2)).toEqual({
      defaultLevel: "all",
    });
    expect(requestBody(3)).toEqual({
      level: "inherit",
    });
    expect(invalidations).toBe(2);
  });

  test("maps the fixed snapshot detail bound to a typed error", async () => {
    globalThis.fetch = Object.assign(
      async () =>
        new Response(
          JSON.stringify({
            error: "Notification state exceeds the supported detail limit",
            code: "notification_state_too_large",
          }),
          { status: 413, headers: { "content-type": "application/json" } },
        ),
      { preconnect: realFetch.preconnect.bind(realFetch) },
    ) as typeof fetch;
    const client = new NautiloApiClient("http://127.0.0.1:9");
    client.setToken("token");

    let caught: unknown;
    try {
      await client.getNotificationState();
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(NotificationStateTooLargeApiError);
  });
});
