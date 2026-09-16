import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { NautiloApiClient } from "../../src/client";

function requestUrl(input: Parameters<typeof fetch>[0]): string {
  return typeof input === "string" ? input : (input as URL).toString();
}

describe("redacted administration Integration contracts", () => {
  let realFetch: typeof fetch;
  beforeEach(() => { realFetch = globalThis.fetch; });
  afterEach(() => { globalThis.fetch = realFetch; });

  test("MCP lifecycle sends intent-only bodies and projects secret-bearing rows", async () => {
    const requests: Array<{ url: string; method: string; body: string | null }> = [];
    const raw = { id: "m1", name: "docs", host: "server", enabled: true, trustTier: "official", health: "connected", toolCount: 1, transport: { command: "secret-command", headers: { Authorization: "canary" } }, envPassthrough: ["CANARY_SECRET"] };
    const mockFetch = async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      requests.push({ url: requestUrl(input), method: init?.method ?? "GET", body: typeof init?.body === "string" ? init.body : null });
      return Response.json({ server: raw, tools: [{ name: "search", enabled: false, description: "canary-tool-secret" }] });
    };
    globalThis.fetch = Object.assign(mockFetch, { preconnect: realFetch.preconnect.bind(realFetch) }) as typeof fetch;
    const client = new NautiloApiClient("http://127.0.0.1:9"); client.setToken("tok");
    expect(await client.setMcpAdminEnabled("docs", true, "rev-1")).not.toHaveProperty("transport");
    const toolReceipt = await client.setMcpAdminToolEnabled("docs", "search", false, "rev-2");
    expect(toolReceipt.tools).toEqual([{ name: "search", enabled: false }]);
    expect(requests.map((row) => [row.method, row.url, row.body])).toEqual([
      ["PATCH", "http://127.0.0.1:9/api/mcp-servers/docs/enabled", '{"enabled":true,"expectedRevision":"rev-1"}'],
      ["PATCH", "http://127.0.0.1:9/api/mcp-servers/docs/tools/search", '{"enabled":false,"expectedRevision":"rev-2"}'],
    ]);
  });

  test("Google OAuth configure is multipart write-only and removal is typed", async () => {
    const requests: RequestInit[] = [];
    const mockFetch = async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      requests.push(init ?? {});
      return Response.json(init?.method === "DELETE" ? { configured: false } : { configured: true, clientId: "client-id" });
    };
    globalThis.fetch = Object.assign(mockFetch, { preconnect: realFetch.preconnect.bind(realFetch) }) as typeof fetch;
    const client = new NautiloApiClient("http://127.0.0.1:9"); client.setToken("tok");
    expect(await client.configureGoogleOAuthClient(new Blob(['{"installed":{"client_secret":"canary"}}']))).toEqual({ configured: true, clientId: "client-id" });
    expect(requests[0]?.body).toBeInstanceOf(FormData);
    expect(new Headers(requests[0]?.headers).has("content-type")).toBe(false);
    expect(await client.removeGoogleOAuthClient()).toEqual({ configured: false });
  });

  test("Google readiness preserves the server-authoritative setup boundary", async () => {
    const mockFetch = async () =>
      Response.json({
        configured: true,
        providerSetupStatus: "managed",
        canManageProviderSetup: false,
      });
    globalThis.fetch = Object.assign(mockFetch, {
      preconnect: realFetch.preconnect.bind(realFetch),
    }) as typeof fetch;
    const client = new NautiloApiClient("http://127.0.0.1:9");
    client.setToken("tok");

    expect(await client.getGoogleIntegrationStatus()).toEqual({
      configured: true,
      providerSetupStatus: "managed",
      canManageProviderSetup: false,
      clientId: null,
    });
  });
});
