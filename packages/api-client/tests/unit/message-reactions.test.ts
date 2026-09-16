import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { NautiloApiClient, ApiError } from "../../src/client";

function requestUrl(input: Parameters<typeof fetch>[0]): string {
  return typeof input === "string" ? input : (input as URL).toString();
}

describe("addReaction / removeReaction (D312 Phase 1)", () => {
  let realFetch: typeof fetch;

  beforeEach(() => {
    realFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  const roomId = "550e8400-e29b-41d4-a716-446655440000";
  const messageId = "42";
  const emoji = "👍";
  const reactions = [
    {
      emoji: "👍",
      count: 2,
      actorIds: ["actor-a", "actor-b"],
      truncated: false,
    },
  ];

  test("PUT /api/rooms/:roomId/messages/:messageId/reactions/:emoji — encoded path, parsed reactions", async () => {
    let seenUrl = "";
    let seenMethod = "";
    let seenBody: string | undefined;
    const mockFetch = async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      seenUrl = requestUrl(input);
      seenMethod = init?.method ?? "GET";
      seenBody = typeof init?.body === "string" ? init.body : undefined;
      return new Response(JSON.stringify({ reactions }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };
    globalThis.fetch = Object.assign(mockFetch, {
      preconnect: realFetch.preconnect.bind(realFetch),
    }) as typeof fetch;

    const client = new NautiloApiClient("http://127.0.0.1:9");
    client.setToken("tok");
    const out = await client.addReaction(roomId, messageId, emoji);

    expect(seenUrl).toBe(
      `http://127.0.0.1:9/api/rooms/${encodeURIComponent(roomId)}/messages/${encodeURIComponent(messageId)}/reactions/${encodeURIComponent(emoji)}`,
    );
    expect(seenMethod).toBe("PUT");
    expect(seenBody).toBeUndefined();
    expect(out.reactions).toEqual(reactions);
  });

  test("DELETE /api/rooms/:roomId/messages/:messageId/reactions/:emoji — encoded path, parsed reactions", async () => {
    let seenUrl = "";
    let seenMethod = "";
    let seenBody: string | undefined;
    const mockFetch = async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      seenUrl = requestUrl(input);
      seenMethod = init?.method ?? "GET";
      seenBody = typeof init?.body === "string" ? init.body : undefined;
      return new Response(JSON.stringify({ reactions: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };
    globalThis.fetch = Object.assign(mockFetch, {
      preconnect: realFetch.preconnect.bind(realFetch),
    }) as typeof fetch;

    const client = new NautiloApiClient("http://127.0.0.1:9");
    client.setToken("tok");
    const out = await client.removeReaction(roomId, messageId, emoji);

    expect(seenUrl).toBe(
      `http://127.0.0.1:9/api/rooms/${encodeURIComponent(roomId)}/messages/${encodeURIComponent(messageId)}/reactions/${encodeURIComponent(emoji)}`,
    );
    expect(seenMethod).toBe("DELETE");
    expect(seenBody).toBeUndefined();
    expect(out.reactions).toEqual([]);
  });

  test("non-2xx throws ApiError with server error string", async () => {
    const mockFetch = async () =>
      new Response(JSON.stringify({ error: "invalid emoji" }), {
        status: 400,
        headers: { "content-type": "application/json" },
      });
    globalThis.fetch = Object.assign(mockFetch, {
      preconnect: realFetch.preconnect.bind(realFetch),
    }) as typeof fetch;

    const client = new NautiloApiClient("http://127.0.0.1:9");
    client.setToken("tok");
    let caught: unknown;
    try {
      await client.addReaction(roomId, messageId, "not-an-emoji");
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ApiError);
    expect((caught as ApiError).status).toBe(400);
    expect((caught as ApiError).message).toBe("invalid emoji");
  });
});
