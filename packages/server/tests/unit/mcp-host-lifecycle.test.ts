import { describe, expect, test } from "bun:test";
import { ToolCatalog } from "@nautilo/catalog";
import type { DirectDatabase } from "@nautilo/db";
import {
  McpClientManager,
  type McpDiscoveredTool,
  type McpManagedClient,
  type McpServerConfig,
} from "@nautilo/mcp-client";
import { startMcpHost } from "../../src/mcp/mcp-host";

const config: McpServerConfig = {
  name: "dynamic",
  host: "server",
  transportKind: "stdio",
  transport: { command: "echo" },
  namespaceId: "private-ns",
  trustTier: "high",
};

const discovered: McpDiscoveredTool = {
  name: "dynamic_read",
  description: "Read data from the dynamic MCP server",
  inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
  annotations: { readOnlyHint: true },
};

function fakeDb(): DirectDatabase {
  return {
    select: () => ({
      from: () => ({
        where: () => Promise.resolve([{ ...config, enabled: true }]),
      }),
    }),
  } as unknown as DirectDatabase;
}

function managerWith(client: McpManagedClient): McpClientManager {
  return new McpClientManager({
    clientFactory: () => client,
    transportFactory: () => ({ inner: {}, close: () => Promise.resolve() }),
  });
}

describe("MCP host progressive lifecycle", () => {
  test("disconnect removes an activated tool's schema and execution path until reconnect", async () => {
    let calls = 0;
    const client: McpManagedClient = {
      connect: () => Promise.resolve(),
      close: () => Promise.resolve(),
      listTools: () => Promise.resolve({ tools: [discovered] }),
      callTool: () => {
        calls += 1;
        return Promise.resolve({ content: [{ type: "text", text: "ok" }] });
      },
    };
    const catalog = new ToolCatalog();
    const manager = managerWith(client);
    await startMcpHost({ catalog, db: fakeDb(), manager });

    const active = catalog.resolveProgressiveTools({
      activatedToolNames: ["dynamic_read"],
      readableNamespaces: ["private-ns"],
    });
    expect(active.snapshot.entries[0]).toMatchObject({
      name: "dynamic_read",
      source: "mcp",
      sourceServer: "dynamic",
      namespaceId: "private-ns",
      trustTier: "high",
      impact: "read-only",
      requiresApproval: false,
    });
    expect(await active.tools[0]!.invoke({ path: "/tmp/a" })).toBe("ok");
    expect(calls).toBe(1);

    await manager.disconnect("dynamic");
    const stale = catalog.resolveProgressiveTools({
      activatedToolNames: ["dynamic_read"],
      readableNamespaces: ["private-ns"],
    });
    expect(catalog.get("dynamic_read")).toBeUndefined();
    expect(stale.snapshot.entries).toEqual([]);
    expect(stale.tools).toEqual([]);
    let dispatchError: unknown;
    try {
      await manager.dispatch("dynamic_read", { path: "/tmp/a" });
    } catch (error) {
      dispatchError = error;
    }
    expect((dispatchError as Error).message).toContain("no connected server exposes tool");

    await manager.connect(config);
    const reactivated = catalog.resolveProgressiveTools({
      activatedToolNames: ["dynamic_read"],
      readableNamespaces: ["private-ns"],
    });
    expect(reactivated.snapshot.entries).toHaveLength(1);
    expect(reactivated.tools).toHaveLength(1);
  });
});
