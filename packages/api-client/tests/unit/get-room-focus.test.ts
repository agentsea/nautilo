import { afterEach, describe, expect, test } from "bun:test";
import { NautiloApiClient } from "../../src/client";

const ROOM_ID = "11111111-1111-4111-8111-111111111111";

describe("NautiloApiClient.getRoomFocus", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("preserves the requester-private eligible Genie access order", async () => {
    globalThis.fetch = (async (url: Parameters<typeof fetch>[0]) => {
      const requestUrl = typeof url === "string"
        ? url
        : url instanceof URL
        ? url.href
        : url.url;
      expect(requestUrl).toBe(`http://127.0.0.1:9/api/rooms/${ROOM_ID}/focus`);
      return new Response(JSON.stringify({
        foci: [],
        recentBotActorIds: ["newest-genie", "older-genie"],
      }), { headers: { "content-type": "application/json" } });
    }) as typeof fetch;

    const client = new NautiloApiClient("http://127.0.0.1:9");
    const focus = await client.getRoomFocus(ROOM_ID);
    expect(focus).toEqual({
      foci: [],
      recentBotActorIds: ["newest-genie", "older-genie"],
    });
  });
});
