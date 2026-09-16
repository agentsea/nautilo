/**
 * D384 P2 / RES7 — chaos harness.
 *
 * Injects transport-proximate faults (upstream 5xx, connection refused,
 * dropped/stale session, malformed result, and a secret-bearing error) at
 * `client.callTool`, drives them through the REAL manager + resilience
 * policy + tool factory, and asserts the agent-facing contract holds under
 * every fault:
 *
 *   1. graceful degradation — the LangChain tool NEVER throws; it returns a
 *      string the model can reason about (RES2);
 *   2. no crash — repeated failures (breaker path) still return a string;
 *   3. no leaked internals — a secret in the upstream error is redacted out
 *      of the message the agent sees (SEC1).
 *
 * This is a TEST-ONLY harness: there is no runtime fault-injector shipped in
 * `@nautilo/mcp-client`, so it runs in the normal `bun test` pre-merge gate
 * and can never fire in production (nothing to guard off). The pure-hang /
 * timeout fault is intentionally NOT exercised here (it would wait on the
 * 10s per-attempt policy timeout); that path is covered by the resilience
 * unit tests.
 */
import { describe, expect, test } from "bun:test";
import { McpClientManager } from "../../src/manager.ts";
import type { McpManagedClient } from "../../src/manager.ts";
import type { McpCallToolResult } from "../../src/tool-factory.ts";
import type { McpDiscoveredTool, McpServerConfig } from "../../src/types.ts";

const TOOL: McpDiscoveredTool = {
  name: "do_thing",
  description: "does a thing",
  inputSchema: { type: "object", properties: {}, required: [] },
};

const cfg: McpServerConfig = {
  name: "chaos",
  host: "server",
  transportKind: "stdio",
  transport: { command: "echo" },
  namespaceId: "ns-1",
};

/** Build a manager whose client.callTool runs `callTool` (the injected fault). */
function makeChaosManager(
  callTool: McpManagedClient["callTool"],
): McpClientManager {
  const client: McpManagedClient = {
    connect: () => Promise.resolve(),
    close: () => Promise.resolve(),
    listTools: () => Promise.resolve({ tools: [TOOL] }),
    callTool,
  };
  return new McpClientManager({
    clientFactory: () => client,
    transportFactory: () => ({ inner: {}, close: () => Promise.resolve() }),
    // fast RES4 backoff (not that this suite reconnects, but keep it snappy)
    sleep: () => Promise.resolve(),
  });
}

/** Connect + build the agent-facing LangChain tool via the real bundle path. */
async function chaosToolFor(
  callTool: McpManagedClient["callTool"],
): Promise<{ invoke: () => Promise<string> }> {
  const mgr = makeChaosManager(callTool);
  await mgr.connect(cfg);
  const reg = mgr.getCatalogBundle("chaos").registrations[0]!;
  const t = reg.factory();
  return { invoke: async () => (await t.invoke({})) as unknown as string };
}

describe("RES7 chaos — agent-facing tool never throws under transport faults", () => {
  const faults: Array<{ name: string; callTool: McpManagedClient["callTool"] }> = [
    {
      name: "upstream 5xx",
      callTool: () => Promise.reject(new Error("HTTP 500 Internal Server Error")),
    },
    {
      name: "connection refused",
      callTool: () => Promise.reject(new Error("connect ECONNREFUSED 127.0.0.1:9999")),
    },
    {
      name: "dropped / stale session",
      callTool: () => Promise.reject(new Error("Server not initialized (session expired)")),
    },
    {
      name: "malformed result (isError)",
      callTool: (): Promise<McpCallToolResult> =>
        Promise.resolve({ isError: true, content: [{ type: "text", text: "boom" }] }),
    },
    {
      name: "empty / malformed content",
      callTool: (): Promise<McpCallToolResult> =>
        Promise.resolve({ content: [] } as McpCallToolResult),
    },
  ];

  for (const f of faults) {
    test(`degrades gracefully: ${f.name}`, async () => {
      const t = await chaosToolFor(f.callTool);
      const out = await t.invoke();
      expect(typeof out).toBe("string");
    });
  }

  test("SEC1 — a secret in the upstream error is redacted from the agent message", async () => {
    const secret = "sk-ABC123THISISASECRETVALUE";
    const t = await chaosToolFor(() =>
      Promise.reject(new Error(`auth failed: Authorization: Bearer ${secret}`)),
    );
    const out = await t.invoke();
    expect(typeof out).toBe("string");
    expect(out).not.toContain(secret);
  });

  test("no crash — repeated failures (breaker path) still return a string", async () => {
    const t = await chaosToolFor(() => Promise.reject(new Error("HTTP 503")));
    for (let i = 0; i < 8; i++) {
      const out = await t.invoke();
      expect(typeof out).toBe("string");
    }
  });
});
