import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { NautiloApiClient, ApiError } from "../../src/client";

function requestUrl(input: Parameters<typeof fetch>[0]): string {
  return typeof input === "string" ? input : (input as URL).toString();
}

describe("markRoomRead (M122)", () => {
  let realFetch: typeof fetch;

  beforeEach(() => {
    realFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  test("POST /api/rooms/:roomId/read — empty body when no opts", async () => {
    let seenUrl = "";
    let seenMethod = "";
    let bodyText = "";
    const roomId = "550e8400-e29b-41d4-a716-446655440000";
    const mockFetch = async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      seenUrl = requestUrl(input);
      seenMethod = init?.method ?? "GET";
      bodyText = typeof init?.body === "string" ? init.body : "";
      return new Response(JSON.stringify({ ok: true, marked: 5 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };
    globalThis.fetch = Object.assign(mockFetch, {
      preconnect: realFetch.preconnect.bind(realFetch),
    }) as typeof fetch;

    const client = new NautiloApiClient("http://127.0.0.1:9");
    client.setToken("tok");
    const out = await client.markRoomRead(roomId);

    expect(seenUrl).toBe(`http://127.0.0.1:9/api/rooms/${encodeURIComponent(roomId)}/read`);
    expect(seenMethod).toBe("POST");
    expect(JSON.parse(bodyText)).toEqual({});
    expect(out.ok).toBe(true);
    expect(out.marked).toBe(5);
  });

  test("POST body carries upToMessageId when provided", async () => {
    let bodyText = "";
    const mockFetch = async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      bodyText = typeof init?.body === "string" ? init.body : "";
      return new Response(JSON.stringify({ ok: true, marked: 3 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };
    globalThis.fetch = Object.assign(mockFetch, {
      preconnect: realFetch.preconnect.bind(realFetch),
    }) as typeof fetch;

    const client = new NautiloApiClient("http://127.0.0.1:9");
    client.setToken("tok");
    const out = await client.markRoomRead("660e8400-e29b-41d4-a716-446655440001", {
      upToMessageId: 42,
    });

    expect(JSON.parse(bodyText)).toEqual({ upToMessageId: 42 });
    expect(out.marked).toBe(3);
  });

  test("non-2xx throws ApiError with server error string", async () => {
    const mockFetch = async () =>
      new Response(JSON.stringify({ error: "Not found" }), {
        status: 404,
        headers: { "content-type": "application/json" },
      });
    globalThis.fetch = Object.assign(mockFetch, {
      preconnect: realFetch.preconnect.bind(realFetch),
    }) as typeof fetch;

    const client = new NautiloApiClient("http://127.0.0.1:9");
    client.setToken("tok");
    let caught: unknown;
    try {
      await client.markRoomRead("770e8400-e29b-41d4-a716-446655440002");
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ApiError);
    expect((caught as ApiError).status).toBe(404);
    expect((caught as ApiError).message).toBe("Not found");
  });
});
