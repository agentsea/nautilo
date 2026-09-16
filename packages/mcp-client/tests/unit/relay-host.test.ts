import { describe, expect, test } from "bun:test";
import { McpClientManager } from "../../src/manager.ts";
import type { McpManagedClient } from "../../src/manager.ts";
import type { McpCallToolResult } from "../../src/tool-factory.ts";
import type { McpDiscoveredTool } from "../../src/types.ts";
import { createRelayMcpHost, mapRelayMcpConfig } from "../../src/relay-host.ts";
import type { RelayMcpServerConfig } from "@nautilo/relay";
import type { RelayAdvertisedMcpTool } from "@nautilo/relay";

function makeTool(name: string): McpDiscoveredTool {
  return { name, description: `desc ${name}`, inputSchema: { type: "object" } };
}

class StubClient implements McpManagedClient {
  constructor(
    private readonly tools: readonly McpDiscoveredTool[],
    private readonly result: McpCallToolResult = { content: [{ type: "text", text: "OK" }] },
  ) {}
  connect(): Promise<void> {
    return Promise.resolve();
  }
  close(): Promise<void> {
    return Promise.resolve();
  }
  listTools(): Promise<{ tools: readonly McpDiscoveredTool[] }> {
    return Promise.resolve({ tools: this.tools });
  }
  callTool(p: { name: string; arguments?: Record<string, unknown> }): Promise<McpCallToolResult> {
    void p;
    return Promise.resolve(this.result);
  }
}

function hostWith(client: McpManagedClient) {
  const manager = new McpClientManager({
    clientFactory: () => client,
    transportFactory: () => ({ inner: {}, close: () => Promise.resolve() }),
  });
  return createRelayMcpHost({ relayId: "relay-abc", manager });
}

const wireCfg: RelayMcpServerConfig = {
  name: "context7",
  transportKind: "stdio",
  transport: { command: "npx", args: ["-y", "@upstash/context7-mcp"] },
  envPassthrough: ["CONTEXT7_API_KEY"],
  namespaceId: null,
};

describe("createRelayMcpHost (D384 P5/5.1.1)", () => {
  test("mapRelayMcpConfig stamps host=relay-<id> and preserves scope/filters", () => {
    const mapped = mapRelayMcpConfig("r1", { ...wireCfg, includeTools: ["get-docs"] });
    expect(mapped.host).toBe("relay-r1");
    expect(mapped.transportKind).toBe("stdio");
    expect(mapped.envPassthrough).toEqual(["CONTEXT7_API_KEY"]);
    expect(mapped.includeTools).toEqual(["get-docs"]);
    expect(mapped.enabled).toBe(true);
  });

  test("configure → tools-changed populates has() and emits advertise payload", async () => {
    const host = hostWith(new StubClient([makeTool("get-docs"), makeTool("resolve-id")]));
    const advertised: Array<{ server: string; tools: RelayAdvertisedMcpTool[] }> = [];
    host.onToolsChanged((server, tools) => advertised.push({ server, tools }));

    await host.configure([wireCfg]);

    expect(host.has("get-docs")).toBe(true);
    expect(host.has("resolve-id")).toBe(true);
    expect(host.has("nonexistent")).toBe(false);
    expect(advertised).toHaveLength(1);
    expect(advertised[0]?.server).toBe("context7");
    expect(advertised[0]?.tools.map((t) => t.name)).toEqual(["get-docs", "resolve-id"]);
    await host.stop();
  });

  test("dispatch runs through the manager and returns an ok result", async () => {
    const host = hostWith(new StubClient([makeTool("get-docs")]));
    host.onToolsChanged(() => {});
    await host.configure([wireCfg]);

    const res = await host.dispatch("get-docs", { q: "react" });
    expect(res.status).toBe("ok");
    expect(res.result).toBe("OK");
    await host.stop();
  });

  test("dispatch NEVER throws — unknown tool yields an error result, not a throw", async () => {
    const host = hostWith(new StubClient([makeTool("get-docs")]));
    host.onToolsChanged(() => {});
    await host.configure([wireCfg]);

    const res = await host.dispatch("no-such-tool", {});
    expect(res.status).toBe("error");
    expect(res.error).toContain("no-such-tool");
    await host.stop();
  });

  test("removing a server via reconcile drops its tools from has()", async () => {
    const host = hostWith(new StubClient([makeTool("get-docs")]));
    host.onToolsChanged(() => {});
    await host.configure([wireCfg]);
    expect(host.has("get-docs")).toBe(true);

    await host.configure([]); // reconcile to empty → server removed
    expect(host.has("get-docs")).toBe(false);
    await host.stop();
  });

  test("preflight reports a machine label, launcher, and env names without values", async () => {
    const manager = new McpClientManager({
      clientFactory: () => new StubClient([]),
      transportFactory: () => ({ inner: {}, close: () => Promise.resolve() }),
    });
    const host = createRelayMcpHost({
      relayId: "relay-abc",
      manager,
      machineLabel: "Writer Desktop",
      spawnEnvBase: { MCP_D503_READY: "not-on-the-wire" },
    });
    const report = await host.preflight!({
      ...wireCfg,
      transport: { command: process.execPath },
      envPassthrough: ["MCP_D503_READY", "MCP_D503_MISSING"],
    });

    expect(report.machineLabel).toBe("Writer Desktop");
    expect(report.launcher).toBe("present");
    expect(report.environment).toEqual([
      { name: "MCP_D503_READY", present: true },
      { name: "MCP_D503_MISSING", present: false },
    ]);
    expect(report.status).toBe("blocked");
    expect(report.failure?.code).toBe("missing_environment");
    expect(JSON.stringify(report)).not.toContain("not-on-the-wire");
    await host.stop();
  });

  test("correlated configure waits for the manager's target state and confirms rollback", async () => {
    const host = hostWith(new StubClient([makeTool("get-docs")]));
    const start = await host.configureWithOutcome?.([wireCfg], {
      operationId: "operation-1",
      digest: "digest-1",
      targetName: "context7",
      phase: "start",
    });
    expect(start).toEqual({ state: "connected", toolNames: ["get-docs"] });

    const stopped = await host.configureWithOutcome?.([], {
      operationId: "operation-2",
      digest: "digest-1",
      targetName: "context7",
      phase: "rollback",
    });
    expect(stopped).toEqual({ state: "stopped", toolNames: [] });
    await host.stop();
  });

  test("correlated configure rejects invalid phase/desired-fleet combinations before reconciliation", async () => {
    const host = hostWith(new StubClient([makeTool("get-docs")]));
    const invalidStart = await host.configureWithOutcome!([], {
      operationId: "operation-invalid-start",
      digest: "digest-1",
      targetName: "context7",
      phase: "start",
    });
    expect(invalidStart).toEqual({
      state: "failed",
      toolNames: [],
      failure: { code: "invalid_request" },
    });
    expect(host.manager.getState("context7")).toBeUndefined();

    const invalidRollback = await host.configureWithOutcome!([wireCfg], {
      operationId: "operation-invalid-rollback",
      digest: "digest-1",
      targetName: "context7",
      phase: "rollback",
    });
    expect(invalidRollback).toEqual({
      state: "failed",
      toolNames: [],
      failure: { code: "invalid_request" },
    });
    expect(host.manager.getState("context7")).toBeUndefined();
    await host.stop();
  });

  test("preflight trims a Unicode machine label on a UTF-8 boundary", async () => {
    const manager = new McpClientManager({
      clientFactory: () => new StubClient([]),
      transportFactory: () => ({ inner: {}, close: () => Promise.resolve() }),
    });
    const host = createRelayMcpHost({
      relayId: "relay-abc",
      manager,
      machineLabel: "😀".repeat(50),
    });
    const report = await host.preflight!({
      ...wireCfg,
      transport: { command: process.execPath },
      envPassthrough: [],
    });
    expect(Buffer.byteLength(report.machineLabel, "utf8")).toBeLessThanOrEqual(160);
    expect(report.machineLabel.endsWith("�")).toBe(false);
    await host.stop();
  });
});
