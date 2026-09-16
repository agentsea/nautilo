import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { NautiloApiClient, ApiError } from "../../src/client";

function requestUrl(input: Parameters<typeof fetch>[0]): string {
  return typeof input === "string" ? input : (input as URL).toString();
}

function authHeader(init?: RequestInit): string | undefined {
  const h = init?.headers;
  if (!h) return undefined;
  if (h instanceof Headers) return h.get("Authorization") ?? undefined;
  if (Array.isArray(h)) {
    const pair = h.find(([k]) => k?.toLowerCase() === "authorization");
    return pair?.[1];
  }
  const rec = h as Record<string, string>;
  return rec["Authorization"] ?? rec["authorization"];
}

describe("markMessageRead / getMessageReadState (M158)", () => {
  let realFetch: typeof fetch;

  beforeEach(() => {
    realFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  test("markMessageRead(123) POST with session-fresh bearer", async () => {
    let seenUrl = "";
    let seenMethod = "";
    let seenAuth: string | undefined;
    const mockFetch = async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      seenUrl = requestUrl(input);
      seenMethod = init?.method ?? "GET";
      seenAuth = authHeader(init);
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };
    globalThis.fetch = Object.assign(mockFetch, {
      preconnect: realFetch.preconnect.bind(realFetch),
    }) as typeof fetch;

    const client = new NautiloApiClient("http://127.0.0.1:9");
    client.setToken("tok");
    const out = await client.markMessageRead(123);

    expect(seenUrl).toBe("http://127.0.0.1:9/api/messages/123/read");
    expect(seenMethod).toBe("POST");
    expect(seenAuth).toBe("Bearer tok");
    expect(out.ok).toBe(true);
  });

  test("getMessageReadState(123) GET with bearer and parsed body", async () => {
    let seenUrl = "";
    let seenMethod = "";
    let seenAuth: string | undefined;
    const payload = {
      shape: "1:1" as const,
      selfDelivered: true,
      selfRead: false,
      recipientCount: 1,
      deliveredCount: 1,
      readCount: 0,
    };
    const mockFetch = async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      seenUrl = requestUrl(input);
      seenMethod = init?.method ?? "GET";
      seenAuth = authHeader(init);
      return new Response(JSON.stringify(payload), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };
    globalThis.fetch = Object.assign(mockFetch, {
      preconnect: realFetch.preconnect.bind(realFetch),
    }) as typeof fetch;

    const client = new NautiloApiClient("http://127.0.0.1:9");
    client.setToken("tok");
    const out = await client.getMessageReadState(123);

    expect(seenUrl).toBe("http://127.0.0.1:9/api/messages/123/read-state");
    expect(seenMethod).toBe("GET");
    expect(seenAuth).toBe("Bearer tok");
    expect(out).toEqual(payload);
  });

  test("non-2xx throws ApiError", async () => {
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
      await client.getMessageReadState(999);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ApiError);
    expect((caught as ApiError).status).toBe(404);
    expect((caught as ApiError).message).toBe("Not found");
  });
});
