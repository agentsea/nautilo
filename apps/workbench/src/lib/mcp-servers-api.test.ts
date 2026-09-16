import { afterEach, describe, expect, test } from "bun:test";
import {
  deleteMcpServer,
  fetchMcpServerTools,
  setMcpServerEnabled,
  setMcpServerToolEnabled,
  updateMcpServer,
} from "./mcp-servers-api";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("MCP API exact host identity", () => {
  test("threads host through update, enable, delete, tool GET, and tool PATCH", async () => {
    const calls: Array<{ url: string; method: string }> = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), method: init?.method ?? "GET" });
      return new Response(JSON.stringify({ server: {}, tools: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;

    const host = "relay-writer mac";
    await updateMcpServer("same/name", { transportKind: "stdio", transport: {} }, host);
    await setMcpServerEnabled("same/name", true, host);
    await deleteMcpServer("same/name", host);
    await fetchMcpServerTools("same/name", host);
    await setMcpServerToolEnabled("same/name", "tool/name", false, host);

    expect(calls).toEqual([
      { url: "/api/mcp-servers/same%2Fname?host=relay-writer%20mac", method: "PUT" },
      { url: "/api/mcp-servers/same%2Fname/enabled?host=relay-writer%20mac", method: "PATCH" },
      { url: "/api/mcp-servers/same%2Fname?host=relay-writer%20mac", method: "DELETE" },
      { url: "/api/mcp-servers/same%2Fname/tools?host=relay-writer%20mac", method: "GET" },
      { url: "/api/mcp-servers/same%2Fname/tools/tool%2Fname?host=relay-writer%20mac", method: "PATCH" },
    ]);
  });
});
