import { describe, expect, test } from "bun:test";
import { McpClientManager, computeBackoffDelay } from "../../src/manager.ts";
import type { McpManagedClient } from "../../src/manager.ts";
import type { McpCallToolResult } from "../../src/tool-factory.ts";
import type { McpDiscoveredTool, McpResolvedAuth, McpServerConfig } from "../../src/types.ts";

function makeTool(
  name: string,
  extra: Partial<McpDiscoveredTool> = {},
): McpDiscoveredTool {
  return {
    name,
    description: `desc ${name}`,
    inputSchema: { type: "object", properties: {}, required: [] },
    ...extra,
  };
}

/** A stub SDK client: records lifecycle calls, returns canned tools/results. */
class StubClient implements McpManagedClient {
  connectCalls = 0;
  closeCalls = 0;
  lastCall: { name: string; arguments?: Record<string, unknown> } | null = null;

  constructor(
    private readonly tools: readonly McpDiscoveredTool[],
    private readonly result: McpCallToolResult = {
      content: [{ type: "text", text: "OK" }],
    },
  ) {}

  connect(_transport: unknown): Promise<void> {
    void _transport;
    this.connectCalls += 1;
    return Promise.resolve();
  }
  close(): Promise<void> {
    this.closeCalls += 1;
    return Promise.resolve();
  }
  listTools(): Promise<{ tools: readonly McpDiscoveredTool[] }> {
    return Promise.resolve({ tools: this.tools });
  }
  callTool(params: {
    name: string;
    arguments?: Record<string, unknown>;
  }): Promise<McpCallToolResult> {
    this.lastCall = params;
    return Promise.resolve(this.result);
  }
}

function makeManager(client: McpManagedClient): McpClientManager {
  return new McpClientManager({
    clientFactory: () => client,
    transportFactory: () => ({
      inner: {},
      close: () => Promise.resolve(),
    }),
  });
}

/** Assert a promise rejects with a message containing `msg`. */
async function expectReject(p: Promise<unknown>, msg: string): Promise<void> {
  try {
    await p;
  } catch (e) {
    expect((e as Error).message).toContain(msg);
    return;
  }
  throw new Error(`expected rejection containing "${msg}", but it resolved`);
}

const baseCfg: McpServerConfig = {
  name: "fs",
  host: "server",
  transportKind: "stdio",
  transport: { command: "echo" },
  namespaceId: "ns-1",
};

describe("McpClientManager", () => {
  test("connect discovers tools, sets state, emits events", async () => {
    const client = new StubClient([makeTool("read_file"), makeTool("list_dir")]);
    const mgr = makeManager(client);
    const events: string[] = [];
    mgr.on("mcp:connected", (n) => events.push(`connected:${n}`));
    mgr.on("mcp:tools-changed", (n, t) => events.push(`tools:${n}:${t.length}`));

    const tools = await mgr.connect(baseCfg);

    expect(tools.map((t) => t.name)).toEqual(["read_file", "list_dir"]);
    expect(mgr.getState("fs")).toBe("connected");
    expect(client.connectCalls).toBe(1);
    expect(events).toContain("connected:fs");
    expect(events).toContain("tools:fs:2");
  });

  test("include/exclude filters applied at connect", async () => {
    const client = new StubClient([makeTool("a"), makeTool("b"), makeTool("c")]);
    const mgr = makeManager(client);
    const tools = await mgr.connect({ ...baseCfg, excludeTools: ["b"] });
    expect(tools.map((t) => t.name)).toEqual(["a", "c"]);
  });

  test("getCatalogBundle yields mcp/cloud registrations scoped to the namespace", async () => {
    const client = new StubClient([makeTool("read_file")]);
    const mgr = makeManager(client);
    await mgr.connect(baseCfg);

    const bundle = mgr.getCatalogBundle("fs");
    expect(bundle.serverName).toBe("fs");
    expect(bundle.namespaceId).toBe("ns-1");
    expect(bundle.registrations).toHaveLength(1);
    const reg = bundle.registrations[0]!;
    expect(reg.source).toBe("mcp");
    expect(reg.exposure).toBe("discoverable");
    expect(reg.executor).toBe("cloud");
    expect(reg.sourceServer).toBe("fs");
    expect(typeof reg.factory).toBe("function");
    // SEC2 — registered with a scan policy so the agent's toolsNode pipeline
    // runs scanToolResult (content scan + secret redaction) on MCP results.
    expect(reg.resultScanPolicy).toBe("on-suspicious");
  });

  test("dispatch routes to the owning server and returns text content", async () => {
    const client = new StubClient([makeTool("read_file")], {
      content: [{ type: "text", text: "file contents" }],
    });
    const mgr = makeManager(client);
    await mgr.connect(baseCfg);

    const out = await mgr.dispatch("read_file", { path: "/x" });
    expect(out).toBe("file contents");
    expect(client.lastCall).toEqual({
      name: "read_file",
      arguments: { path: "/x" },
    });
  });

  test("dispatch throws when the tool result is an error", async () => {
    const client = new StubClient([makeTool("read_file")], {
      isError: true,
      content: [{ type: "text", text: "boom" }],
    });
    const mgr = makeManager(client);
    await mgr.connect(baseCfg);
    await expectReject(mgr.dispatch("read_file", {}), "boom");
  });

  test("disconnect clears tools and moves to disconnected", async () => {
    const client = new StubClient([makeTool("read_file")]);
    const mgr = makeManager(client);
    await mgr.connect(baseCfg);
    await mgr.disconnect("fs");
    expect(mgr.getState("fs")).toBe("disconnected");
    expect(mgr.getTools("fs")).toEqual([]);
    expect(client.closeCalls).toBe(1);
    await expectReject(
      mgr.dispatch("read_file", { path: "/tmp/stale" }),
      'no connected server exposes tool "read_file"',
    );
  });

  test("2.2.1: tools/list_changed re-lists and re-emits mcp:tools-changed", async () => {
    // A mutable stub: `tools` can change between list calls; captures the
    // notification handler the manager registers so the test can fire it.
    let currentTools: readonly McpDiscoveredTool[] = [makeTool("read_file")];
    let notifyHandler: (() => void) | null = null;
    const client: McpManagedClient = {
      connect: () => Promise.resolve(),
      close: () => Promise.resolve(),
      listTools: () => Promise.resolve({ tools: currentTools }),
      callTool: () => Promise.resolve({ content: [] }),
      setNotificationHandler: (_schema, handler) => {
        notifyHandler = handler as unknown as () => void;
      },
    };
    const mgr = makeManager(client);
    const changed: Array<readonly McpDiscoveredTool[]> = [];
    mgr.on("mcp:tools-changed", (_name, tools) => changed.push(tools));

    await mgr.connect(baseCfg);
    expect(notifyHandler).not.toBeNull();
    expect(mgr.getTools("fs").map((t) => t.name)).toEqual(["read_file"]);

    // Server adds a tool, then pushes list_changed.
    currentTools = [makeTool("read_file"), makeTool("write_file")];
    notifyHandler!();
    await new Promise((r) => setTimeout(r, 0)); // let the async refresh settle

    expect(mgr.getTools("fs").map((t) => t.name)).toEqual(["read_file", "write_file"]);
    // one emit on connect + one on the list_changed refresh
    expect(changed.length).toBe(2);
    expect(changed[1]!.map((t) => t.name)).toEqual(["read_file", "write_file"]);
  });

  test("2.2.1: list_changed still honors include/exclude filter", async () => {
    let currentTools: readonly McpDiscoveredTool[] = [makeTool("a")];
    let notifyHandler: (() => void) | null = null;
    const client: McpManagedClient = {
      connect: () => Promise.resolve(),
      close: () => Promise.resolve(),
      listTools: () => Promise.resolve({ tools: currentTools }),
      callTool: () => Promise.resolve({ content: [] }),
      setNotificationHandler: (_schema, handler) => {
        notifyHandler = handler as unknown as () => void;
      },
    };
    const mgr = makeManager(client);
    await mgr.connect({ ...baseCfg, excludeTools: ["b"] });
    currentTools = [makeTool("a"), makeTool("b"), makeTool("c")];
    notifyHandler!();
    await new Promise((r) => setTimeout(r, 0));
    expect(mgr.getTools("fs").map((t) => t.name)).toEqual(["a", "c"]);
  });

  test("2.2.3 hot-reload: updateServer reconnects a running server with new config", async () => {
    const client = new StubClient([makeTool("read_file")]);
    const mgr = makeManager(client);
    await mgr.connect(baseCfg);
    expect(client.connectCalls).toBe(1);
    // Apply a config change (e.g. a new excludeTools) — should disconnect + reconnect.
    await mgr.updateServer({ ...baseCfg, excludeTools: ["nothing"] });
    expect(mgr.getState("fs")).toBe("connected");
    expect(client.connectCalls).toBe(2);
    expect(client.closeCalls).toBe(1);
  });

  test("2.2.3 hot-reload: updateServer with enabled:false leaves the server down", async () => {
    const client = new StubClient([makeTool("read_file")]);
    const mgr = makeManager(client);
    await mgr.connect(baseCfg);
    await mgr.updateServer({ ...baseCfg, enabled: false });
    expect(mgr.getState("fs")).toBe("disconnected");
    expect(mgr.getTools("fs")).toEqual([]);
  });

  test("2.2.3 hot-reload: updateServer connects a not-yet-managed server", async () => {
    const client = new StubClient([makeTool("read_file")]);
    const mgr = makeManager(client);
    await mgr.updateServer(baseCfg);
    expect(mgr.getState("fs")).toBe("connected");
  });

  test("2.2.3 hot-reload: removeServer tears down and forgets the entry", async () => {
    const client = new StubClient([makeTool("read_file")]);
    const mgr = makeManager(client);
    await mgr.connect(baseCfg);
    await mgr.removeServer("fs");
    expect(mgr.getState("fs")).toBeUndefined();
    expect(client.closeCalls).toBe(1);
  });

  test("2.2.3 hot-reload: reconcile adds desired, removes undesired", async () => {
    const client = new StubClient([makeTool("read_file")]);
    const mgr = makeManager(client);
    await mgr.connect(baseCfg); // "fs" is up
    // Desired set drops "fs", adds "gh".
    await mgr.reconcile([{ ...baseCfg, name: "gh" }]);
    expect(mgr.getState("fs")).toBeUndefined();
    expect(mgr.getState("gh")).toBe("connected");
  });

  test("D503: reconcileTarget returns the exact target state and tools", async () => {
    const client = new StubClient([makeTool("read_file")]);
    const mgr = makeManager(client);
    const started = await mgr.reconcileTarget([{ ...baseCfg, name: "target" }], "target");
    expect(started.state).toBe("connected");
    expect(started.tools.map((tool) => tool.name)).toEqual(["read_file"]);

    const stopped = await mgr.reconcileTarget([], "target");
    expect(stopped.state).toBeUndefined();
    expect(stopped.tools).toEqual([]);
  });

  test("2.2.2 session: registerSessionServers tags and connects; stopSession removes only those", async () => {
    const client = new StubClient([makeTool("read_file")]);
    const mgr = makeManager(client);
    // A persistent (boot) server.
    await mgr.connect({ ...baseCfg, name: "persistent" });
    // Two session-scoped servers for session "S1".
    await mgr.registerSessionServers("S1", [
      { ...baseCfg, name: "sess-a" },
      { ...baseCfg, name: "sess-b" },
    ]);
    expect(mgr.getState("sess-a")).toBe("connected");
    expect(mgr.getState("sess-b")).toBe("connected");
    expect([...mgr.listSessionServers("S1")].sort()).toEqual(["sess-a", "sess-b"]);

    await mgr.stopSession("S1");
    // Session servers gone; persistent server untouched.
    expect(mgr.getState("sess-a")).toBeUndefined();
    expect(mgr.getState("sess-b")).toBeUndefined();
    expect(mgr.getState("persistent")).toBe("connected");
    expect(mgr.listSessionServers("S1")).toEqual([]);
  });

  test("2.2.2 session: stopSession leaves other sessions running", async () => {
    const client = new StubClient([makeTool("read_file")]);
    const mgr = makeManager(client);
    await mgr.registerSessionServers("S1", [{ ...baseCfg, name: "a" }]);
    await mgr.registerSessionServers("S2", [{ ...baseCfg, name: "b" }]);
    await mgr.stopSession("S1");
    expect(mgr.getState("a")).toBeUndefined();
    expect(mgr.getState("b")).toBe("connected");
  });

  test("2.2.2 session: removeServer clears the session tag", async () => {
    const client = new StubClient([makeTool("read_file")]);
    const mgr = makeManager(client);
    await mgr.registerSessionServers("S1", [{ ...baseCfg, name: "a" }]);
    await mgr.removeServer("a");
    expect(mgr.listSessionServers("S1")).toEqual([]);
  });

  test("connecting an already-connected server throws", async () => {
    const client = new StubClient([makeTool("read_file")]);
    const mgr = makeManager(client);
    await mgr.connect(baseCfg);
    await expectReject(mgr.connect(baseCfg), "already connected");
  });

  test("connecting a disabled server throws", async () => {
    const client = new StubClient([makeTool("read_file")]);
    const mgr = makeManager(client);
    await expectReject(mgr.connect({ ...baseCfg, enabled: false }), "disabled");
  });

  test("dispatch for an unknown tool throws", async () => {
    const client = new StubClient([makeTool("read_file")]);
    const mgr = makeManager(client);
    await mgr.connect(baseCfg);
    await expectReject(mgr.dispatch("nope", {}), "no connected server");
  });

  test("RES3: a stale-session error triggers reconnect then retry", async () => {
    let connects = 0;
    const client: McpManagedClient = {
      connect() {
        connects += 1;
        return Promise.resolve();
      },
      close() {
        return Promise.resolve();
      },
      listTools() {
        return Promise.resolve({ tools: [makeTool("read_file")] });
      },
      callTool() {
        // Fail with a stale-session error until a reconnect has happened.
        if (connects < 2) {
          return Promise.reject(new Error("Server not initialized"));
        }
        return Promise.resolve({ content: [{ type: "text", text: "recovered" }] });
      },
    };
    const mgr = makeManager(client);
    await mgr.connect(baseCfg); // connects === 1
    const out = await mgr.dispatch("read_file", {});
    expect(out).toBe("recovered");
    expect(connects).toBe(2);
  });

  test("RES4: computeBackoffDelay follows 1s→2s→…→60s cap", () => {
    expect(computeBackoffDelay(0)).toBe(1000);
    expect(computeBackoffDelay(1)).toBe(2000);
    expect(computeBackoffDelay(2)).toBe(4000);
    expect(computeBackoffDelay(6)).toBe(60000); // 64000 capped
    expect(computeBackoffDelay(20)).toBe(60000);
  });

  test("RES4: reconnectWithBackoff retries with backoff then succeeds", async () => {
    let connectAttempts = 0;
    const client: McpManagedClient = {
      connect() {
        connectAttempts += 1;
        if (connectAttempts === 2 || connectAttempts === 3) {
          return Promise.reject(new Error("refused"));
        }
        return Promise.resolve();
      },
      close: () => Promise.resolve(),
      listTools: () => Promise.resolve({ tools: [makeTool("t")] }),
      callTool: () => Promise.resolve({ content: [] }),
    };
    const sleeps: number[] = [];
    const mgr = new McpClientManager({
      clientFactory: () => client,
      transportFactory: () => ({ inner: {}, close: () => Promise.resolve() }),
      sleep: (ms) => {
        sleeps.push(ms);
        return Promise.resolve();
      },
      maxReconnectAttempts: 5,
    });
    await mgr.connect(baseCfg); // connectAttempts === 1
    await mgr.reconnectWithBackoff("fs");
    expect(mgr.getState("fs")).toBe("connected");
    expect(sleeps).toEqual([1000, 2000]);
  });

  test("RES4: reconnectWithBackoff gives up and sets error after max attempts", async () => {
    let connectAttempts = 0;
    const client: McpManagedClient = {
      connect() {
        connectAttempts += 1;
        if (connectAttempts === 1) return Promise.resolve();
        return Promise.reject(new Error("always"));
      },
      close: () => Promise.resolve(),
      listTools: () => Promise.resolve({ tools: [makeTool("t")] }),
      callTool: () => Promise.resolve({ content: [] }),
    };
    const sleeps: number[] = [];
    const mgr = new McpClientManager({
      clientFactory: () => client,
      transportFactory: () => ({ inner: {}, close: () => Promise.resolve() }),
      sleep: (ms) => {
        sleeps.push(ms);
        return Promise.resolve();
      },
      maxReconnectAttempts: 3,
    });
    await mgr.connect(baseCfg);
    await mgr.reconnectWithBackoff("fs");
    expect(mgr.getState("fs")).toBe("error");
    expect(sleeps).toEqual([1000, 2000, 4000]);
  });

  test("D384 seam 3: a custom authResolver is called (not the default) on connect and connect still succeeds", async () => {
    const client = new StubClient([makeTool("read_file")]);
    const calls: Array<{ cfgName: string; scope: string }> = [];
    const customResolver = (
      cfg: McpServerConfig,
      scope: "spawn" | "headers",
    ): McpResolvedAuth => {
      calls.push({ cfgName: cfg.name, scope });
      return null;
    };
    const mgr = new McpClientManager({
      clientFactory: () => client,
      transportFactory: () => ({ inner: {}, close: () => Promise.resolve() }),
      authResolver: customResolver,
    });
    const tools = await mgr.connect(baseCfg);
    expect(calls).toEqual([{ cfgName: "fs", scope: "spawn" }]);
    expect(tools.map((t) => t.name)).toEqual(["read_file"]);
    expect(mgr.getState("fs")).toBe("connected");
  });

  test("D384 seam 3: default path (no authResolver option) still connects successfully", async () => {
    const client = new StubClient([makeTool("read_file")]);
    const mgr = makeManager(client);
    const tools = await mgr.connect(baseCfg);
    expect(tools.map((t) => t.name)).toEqual(["read_file"]);
    expect(mgr.getState("fs")).toBe("connected");
  });
});
