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

  test("get reads and validates the persisted policy", async () => {
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
    expect(result).toEqual({ allowPersonalProviderKeys: false });
  });

  test("set posts the exact boolean policy and validates the response", async () => {
    let seenUrl = "";
    let seenMethod = "";
    let seenBody: unknown;
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      seenUrl = requestUrl(input);
      seenMethod = init?.method ?? "GET";
      seenBody = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
      return Response.json({ allowPersonalProviderKeys: true });
    }) as typeof fetch;

    const client = new NautiloApiClient("http://127.0.0.1:9");
    const result = await client.admin.serverProviderPolicy.set({
      allowPersonalProviderKeys: true,
    });

    expect(seenMethod).toBe("POST");
    expect(seenUrl).toBe("http://127.0.0.1:9/api/admin/server-provider-policy");
    expect(seenBody).toEqual({ allowPersonalProviderKeys: true });
    expect(result).toEqual({ allowPersonalProviderKeys: true });
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
