import { afterEach, describe, expect, test } from "bun:test";

import { NautiloApiClient } from "../../src/client";

const base = "http://127.0.0.1:9";
const payload = {
  commands: [{
    name: "review",
    description: "Review the supplied change.",
    enabled: true,
    source: "official",
    tokenEstimate: 12,
    updatedAt: "",
    official: true,
    forked: false,
    version: 1,
  }],
  summary: { total: 1, enabled: 1, disabled: 0 },
  // The server may include its internal catalogue projection too; command
  // discovery intentionally consumes only the public list response.
  catalog: [{ name: "review", description: "Review the supplied change." }],
};

describe("NautiloApiClient.getCommands", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("uses authenticated canonical catalogue and management endpoints", async () => {
    const seen: Array<{ url: string; method: string; body: unknown }> = [];
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const requestUrl = typeof input === "string"
        ? input
        : input instanceof URL
        ? input.href
        : input.url;
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer refreshed-command-token");
      const method = init?.method ?? "GET";
      const requestBody: unknown = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
      seen.push({ url: requestUrl, method, body: requestBody });
      const response = requestUrl === `${base}/api/commands` && method === "GET" ? payload
        : requestUrl.endsWith("/reset") || method === "DELETE" ? { ok: true }
        : { command: { ...payload.commands[0], body: "Review: $ARGUMENTS" } };
      return new Response(JSON.stringify(response), {
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    const client = new NautiloApiClient(base);
    client.setToken("command-token");
    client.setTokenProvider(async () => "refreshed-command-token");
    expect(await client.getCommands()).toMatchObject({
      commands: [{ name: "review", enabled: true }],
      summary: { enabled: 1 },
    });
    await client.getCommand("review command");
    await client.putCommand({ name: "review", description: "Review", body: "Review", enabled: true });
    await client.setCommandEnabled("review", false);
    await client.customizeCommand("review");
    await client.resetCommand("review");
    await client.deleteCommand("review");
    expect(seen).toEqual([
      { url: `${base}/api/commands`, method: "GET", body: undefined },
      { url: `${base}/api/commands/review%20command`, method: "GET", body: undefined },
      { url: `${base}/api/commands`, method: "PUT", body: { name: "review", description: "Review", body: "Review", enabled: true } },
      { url: `${base}/api/commands/review`, method: "PATCH", body: { enabled: false } },
      { url: `${base}/api/commands/review/customize`, method: "POST", body: {} },
      { url: `${base}/api/commands/review/reset`, method: "POST", body: {} },
      { url: `${base}/api/commands/review`, method: "DELETE", body: undefined },
    ]);
  });
});
