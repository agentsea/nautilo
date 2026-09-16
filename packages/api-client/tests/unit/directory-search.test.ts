import { afterEach, describe, expect, test } from "bun:test";

import { NautiloApiClient } from "../../src/client";

describe("NautiloApiClient.searchDirectory", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("can request only the caller's owned Genies", async () => {
    let requestedUrl = "";
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
      requestedUrl = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      return new Response(JSON.stringify({ results: [] }), {
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    const client = new NautiloApiClient("https://alpha.example.test");
    client.setToken("token");
    await client.searchDirectory({ kind: "agent", agentScope: "owned", q: "jeannie" });

    expect(requestedUrl).toBe(
      "https://alpha.example.test/api/directory/search?q=jeannie&kind=agent&agentScope=owned",
    );
  });
});
