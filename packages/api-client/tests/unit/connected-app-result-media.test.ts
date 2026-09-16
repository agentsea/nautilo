import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { NautiloApiClient } from "../../src/client";

function requestUrl(input: Parameters<typeof fetch>[0]): string {
  return typeof input === "string" ? input : (input as URL).toString();
}

function authorization(init?: RequestInit): string | null {
  const headers = init?.headers;
  if (!headers || Array.isArray(headers)) return null;
  if (headers instanceof Headers) return headers.get("Authorization");
  return (headers as Record<string, string>)["Authorization"] ?? null;
}

describe("connected-app result media client contract", () => {
  let realFetch: typeof fetch;

  beforeEach(() => { realFetch = globalThis.fetch; });
  afterEach(() => { globalThis.fetch = realFetch; });

  test("refreshes session auth before fetching exact Room-scoped preview bytes", async () => {
    const seen: { url: string; authorization: string | null } = { url: "", authorization: null };
    const mockFetch = async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      seen.url = requestUrl(input);
      seen.authorization = authorization(init);
      return new Response(new Uint8Array([1, 2, 3]), {
        headers: { "content-type": "image/png" },
      });
    };
    globalThis.fetch = Object.assign(mockFetch, {
      preconnect: realFetch.preconnect.bind(realFetch),
    }) as typeof fetch;

    const client = new NautiloApiClient("http://127.0.0.1:9");
    client.setToken("stale-token");
    client.setTokenProvider(async () => "fresh-token");
    const blob = await client.getConnectedAppResultMedia("opaque_preview_A", {
      roomId: "77777777-7777-4777-8777-777777777777",
    });

    expect(seen.url).toBe(
      "http://127.0.0.1:9/api/connected-apps/result-media?ref=opaque_preview_A&roomId=77777777-7777-4777-8777-777777777777",
    );
    expect(seen.authorization).toBe("Bearer fresh-token");
    expect(blob.type).toBe("image/png");
    expect([...new Uint8Array(await blob.arrayBuffer())]).toEqual([1, 2, 3]);
  });
});
