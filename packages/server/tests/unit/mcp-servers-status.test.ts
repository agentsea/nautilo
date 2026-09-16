import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { DynamicStructuredTool } from "@langchain/core/tools";
import { z } from "zod";
import { ToolCatalog, initToolCatalog, clearToolCatalog } from "@nautilo/catalog";
import type { McpServer } from "@nautilo/db";
import { setRelayRegistry } from "@nautilo/agent";
import { setMcpClientManager } from "../../src/mcp/mcp-manager-singleton";
import {
  catalogSourceServerForRow,
  healthForRow,
  parseRelayIdFromHost,
  toolCountForRow,
  toolsForRow,
} from "../../src/mcp/connection-status";

function row(overrides: Partial<McpServer> & Pick<McpServer, "name">): McpServer {
  const now = new Date();
  return {
    id: "id",
    host: "server",
    transportKind: "stdio",
    transport: {},
    envPassthrough: null,
    envLiteral: null,
    authRef: null,
    namespaceId: null,
    includeTools: null,
    excludeTools: null,
    enabled: true,
    trustTier: null,
    spawnSandboxProfile: null,
    lastCheckStatus: null,
    lastCheckFailureCode: null,
    lastCheckMissingEnvironment: null,
    lastCheckedAt: null,
    lastConnectedAt: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function registerTool(catalog: ToolCatalog, name: string, sourceServer: string): void {
  catalog.register({
    name,
    source: "mcp",
    sourceServer,
    factory: () =>
      new DynamicStructuredTool({
        name,
        description: `desc:${name}`,
        schema: z.object({}),
        func: async () => "ok",
      }),
    category: "meta",
    trustTier: "standard",
    impact: "read-only",
  });
}

describe("connection-status helpers", () => {
  let catalog: ToolCatalog;

  beforeEach(() => {
    catalog = new ToolCatalog();
    initToolCatalog(catalog);
    setMcpClientManager(null);
    setRelayRegistry(null);
  });

  afterEach(() => {
    clearToolCatalog();
    setMcpClientManager(null);
    setRelayRegistry(null);
  });

  test("parseRelayIdFromHost + catalogSourceServerForRow", () => {
    expect(parseRelayIdFromHost("relay-abc")).toBe("abc");
    expect(parseRelayIdFromHost("server")).toBeNull();
    expect(catalogSourceServerForRow(row({ name: "fs" }))).toBe("fs");
    expect(catalogSourceServerForRow(row({ name: "ctx", host: "relay-r1" }))).toBe(
      "r1:ctx",
    );
  });

  test("toolCountForRow + toolsForRow honor excludeTools", () => {
    registerTool(catalog, "a", "fs");
    registerTool(catalog, "b", "fs");
    const r = row({ name: "fs", excludeTools: ["b"] });
    expect(toolCountForRow(r)).toBe(2);
    const tools = toolsForRow(r);
    expect(tools.find((t) => t.name === "a")?.enabled).toBe(true);
    expect(tools.find((t) => t.name === "b")?.enabled).toBe(false);
  });

  test("healthForRow — server tier maps manager state; disabled → disconnected", async () => {
    setMcpClientManager({
      getState: (name: string) => (name === "fs" ? "error" : undefined),
    } as never);
    expect(await healthForRow(row({ name: "fs", enabled: true }))).toBe("error");
    expect(await healthForRow(row({ name: "fs", enabled: false }))).toBe("disconnected");
    setMcpClientManager(null);
    expect(await healthForRow(row({ name: "fs", enabled: true }))).toBe("unknown");
  });

  test("healthForRow — relay tier connected only when relay live + tools advertised", async () => {
    registerTool(catalog, "t1", "r1:local");
    setRelayRegistry({
      listConnected: async () => ["r1"],
      getUserId: () => "user-1",
    } as never);
    expect(await healthForRow(row({ name: "local", host: "relay-r1" }))).toBe("connected");
    setRelayRegistry({
      listConnected: async () => [],
      getUserId: () => null,
    } as never);
    expect(await healthForRow(row({ name: "local", host: "relay-r1" }))).toBe(
      "disconnected",
    );
  });
});
