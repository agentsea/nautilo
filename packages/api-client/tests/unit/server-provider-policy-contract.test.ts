import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { NautiloApiClient } from "../../src/client";

function requestUrl(input: Parameters<typeof fetch>[0]): string {
  return typeof input === "string" ? input : (input as URL).toString();
}

describe("admin.serverProviderPolicy HTTP contract", () => {
  let realFetch: typeof fetch;

  beforeEach(() => {
    realFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  test("get defaults an older response to personal-first", async () => {
    let seenUrl = "";
    let seenMethod = "";
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      seenUrl = requestUrl(input);
      seenMethod = init?.method ?? "GET";
      return Response.json({ allowPersonalProviderKeys: false });
    }) as typeof fetch;

    const client = new NautiloApiClient("http://127.0.0.1:9");
    const result = await client.admin.serverProviderPolicy.get();

    expect(seenMethod).toBe("GET");
    expect(seenUrl).toBe("http://127.0.0.1:9/api/admin/server-provider-policy");
    expect(result).toEqual({
      allowPersonalProviderKeys: false,
      fundingPreference: "personal_first",
    });
  });

  test("set posts an exact partial policy and validates the response", async () => {
    let seenUrl = "";
    let seenMethod = "";
    let seenBody: unknown;
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      seenUrl = requestUrl(input);
      seenMethod = init?.method ?? "GET";
      seenBody = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
      return Response.json({
        allowPersonalProviderKeys: true,
        fundingPreference: "server_first",
      });
    }) as typeof fetch;

    const client = new NautiloApiClient("http://127.0.0.1:9");
    const result = await client.admin.serverProviderPolicy.set({
      fundingPreference: "server_first",
    });

    expect(seenMethod).toBe("POST");
    expect(seenUrl).toBe("http://127.0.0.1:9/api/admin/server-provider-policy");
    expect(seenBody).toEqual({ fundingPreference: "server_first" });
    expect(result).toEqual({
      allowPersonalProviderKeys: true,
      fundingPreference: "server_first",
    });
  });

  test("rejects empty and unknown request fields before fetch", async () => {
    let fetchCalls = 0;
    globalThis.fetch = (async () => {
      fetchCalls += 1;
      return Response.json({ allowPersonalProviderKeys: false });
    }) as unknown as typeof fetch;

    const client = new NautiloApiClient("http://127.0.0.1:9");
    for (const input of [{}, { unknown: true }]) {
      let caught: unknown;
      try {
        await client.admin.serverProviderPolicy.set(input as never);
      } catch (cause) {
        caught = cause;
      }
      expect(caught).toBeInstanceOf(Error);
    }
    expect(fetchCalls).toBe(0);
  });

  test("rejects malformed response shapes", async () => {
    globalThis.fetch = (async () => Response.json({ allowPersonalProviderKeys: "yes" })) as unknown as typeof fetch;

    const client = new NautiloApiClient("http://127.0.0.1:9");
    let caught: unknown;
    try {
      await client.admin.serverProviderPolicy.get();
    } catch (cause) {
      caught = cause;
    }
    expect(caught).toBeInstanceOf(Error);
  });
});
