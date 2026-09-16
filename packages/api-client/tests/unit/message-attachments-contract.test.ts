import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { ApiError, NautiloApiClient } from "../../src/client";

function requestUrl(input: Parameters<typeof fetch>[0]): string {
  return typeof input === "string" ? input : (input as URL).toString();
}

function authorization(init?: RequestInit): string | null {
  const headers = init?.headers;
  if (!headers || Array.isArray(headers)) return null;
  if (headers instanceof Headers) return headers.get("Authorization");
  return (headers as Record<string, string>)["Authorization"] ?? null;
}

describe("message attachment client contract", () => {
  let realFetch: typeof fetch;

  beforeEach(() => { realFetch = globalThis.fetch; });
  afterEach(() => { globalThis.fetch = realFetch; });

  test("builds an encoded Room-narrowed retained-byte URL", () => {
    const client = new NautiloApiClient("https://nautilo.example");
    expect(client.getMessageAttachmentUrl("attachment/a+b", { roomId: "room/a+b" }))
      .toBe("https://nautilo.example/api/message-attachments/attachment%2Fa%2Bb?roomId=room%2Fa%2Bb");
  });

  test("deleteMessageAttachment uses fresh session auth, DELETE, and an encoded canonical route", async () => {
    const seen: { url: string; method: string; authorization: string | null } = { url: "", method: "", authorization: null };
    const mockFetch = async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      seen.url = requestUrl(input);
      seen.method = init?.method ?? "GET";
      seen.authorization = authorization(init);
      return new Response(JSON.stringify({ ok: true }), { headers: { "content-type": "application/json" } });
    };
    globalThis.fetch = Object.assign(mockFetch, { preconnect: realFetch.preconnect.bind(realFetch) }) as typeof fetch;

    const client = new NautiloApiClient("http://127.0.0.1:9");
    client.setToken("stale-token");
    client.setTokenProvider(async () => "fresh-token");
    expect(await client.deleteMessageAttachment("attachment/a+b")).toEqual({ ok: true });
    expect(seen.method).toBe("DELETE");
    expect(seen.url).toBe("http://127.0.0.1:9/api/message-attachments/attachment%2Fa%2Bb");
    expect(seen.authorization).toBe("Bearer fresh-token");
  });

  test("deleteMessageAttachment preserves canonical non-2xx ApiError detail", async () => {
    const mockFetch = async () => new Response(JSON.stringify({ error: "not found" }), {
      status: 404,
      headers: { "content-type": "application/json" },
    });
    globalThis.fetch = Object.assign(mockFetch, { preconnect: realFetch.preconnect.bind(realFetch) }) as typeof fetch;

    const client = new NautiloApiClient("http://127.0.0.1:9");
    client.setToken("token");
    let failure: unknown;
    try { await client.deleteMessageAttachment("missing"); } catch (caught) { failure = caught; }
    expect(failure).toBeInstanceOf(ApiError);
    expect(failure).toMatchObject({ status: 404, message: "not found" });
  });
});
