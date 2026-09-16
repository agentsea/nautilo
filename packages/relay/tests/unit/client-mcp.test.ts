import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { RelayCapabilities } from "../../src/types";
import type {
  RelayAdvertisedMcpTool,
  RelayMcpHost,
} from "../../src/client";
import type { RelayMcpServerConfig } from "../../src/protocol";

const capabilities: RelayCapabilities = {
  profile: "device-relay",
  canRunShell: true,
};

const RS_OPEN = 1;
const RS_CLOSED = 3;

class MockRelayWebSocket {
  static OPEN = RS_OPEN;
  static CONNECTING = 0;
  static CLOSED = RS_CLOSED;

  readyState = MockRelayWebSocket.CONNECTING;
  sent: string[] = [];
  private handlers = new Map<string, Array<(...args: unknown[]) => void>>();

  constructor(_url: string) {}

  on(event: string, handler: (...args: unknown[]) => void): this {
    const list = this.handlers.get(event) ?? [];
    list.push(handler);
    this.handlers.set(event, list);
    return this;
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.readyState = MockRelayWebSocket.CLOSED;
    for (const handler of this.handlers.get("close") ?? []) handler();
  }

  triggerOpen(): void {
    this.readyState = RS_OPEN;
    for (const handler of this.handlers.get("open") ?? []) handler();
  }

  triggerMessage(payload: unknown): void {
    for (const handler of this.handlers.get("message") ?? []) handler(payload);
  }
}

const created: MockRelayWebSocket[] = [];

mock.module("ws", () => ({
  default: class extends MockRelayWebSocket {
    constructor(url: string) {
      super(url);
      created.push(this);
    }
  },
}));

const { createRelayClient } = await import("../../src/client");

type SentFrame = { readonly type: string; readonly [key: string]: unknown };

function parseSentFrame(raw: string): SentFrame {
  const parsed: unknown = JSON.parse(raw);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("expected an object relay frame");
  }
  const type = (parsed as Record<string, unknown>)["type"];
  if (typeof type !== "string") throw new Error("expected a relay frame type");
  return parsed as SentFrame;
}

/** Minimal fake host capturing calls + exposing the emit hook. */
function makeFakeHost() {
  let emit: (s: string, t: RelayAdvertisedMcpTool[]) => void = () => {};
  const configured: RelayMcpServerConfig[][] = [];
  const dispatched: Array<{ name: string; args: Record<string, unknown> }> = [];
  let stopCalls = 0;
  const hosted = new Set<string>();
  const host: RelayMcpHost = {
    configure(servers) {
      configured.push(servers);
      for (const s of servers) hosted.add(`${s.name}__tool`);
    },
    has: (name) => hosted.has(name),
    dispatch(name, args) {
      dispatched.push({ name, args });
      return Promise.resolve({ status: "ok", result: { ok: true } });
    },
    onToolsChanged(listener) {
      emit = listener;
    },
    stop() {
      stopCalls += 1;
      return Promise.resolve();
    },
  };
  return {
    host,
    configured,
    dispatched,
    getStopCalls: () => stopCalls,
    emitTools: (s: string, t: RelayAdvertisedMcpTool[]) => emit(s, t),
  };
}

async function connectWithHost(
  host: RelayMcpHost,
  protocolVersion = 12,
  reconnectDelayMs?: number,
) {
  const client = createRelayClient({
    serverUrl: "http://127.0.0.1:9",
    userId: "user-1",
    relayId: "relay-1",
    capabilities,
    onDispatch: () => Promise.resolve({ status: "ok", result: "cloud-path" }),
    mcpHost: host,
    ...(reconnectDelayMs !== undefined ? { reconnectDelayMs } : {}),
  });
  const connectPromise = client.connect();
  const ws = created[created.length - 1]!;
  ws.triggerOpen();
  ws.triggerMessage(JSON.stringify({ type: "relay:registered", protocolVersion }));
  await connectPromise;
  return { client, ws };
}

describe("createRelayClient — D384 Phase 5 MCP host seam", () => {
  beforeEach(() => {
    created.length = 0;
  });

  test("relay:configure-mcp reconciles the host with the sent servers", async () => {
    const { host, configured } = makeFakeHost();
    const { ws, client } = await connectWithHost(host);

    const servers: RelayMcpServerConfig[] = [
      { name: "context7", transportKind: "stdio", transport: { command: "npx" }, namespaceId: null },
    ];
    ws.triggerMessage(JSON.stringify({ type: "relay:configure-mcp", servers }));
    await new Promise((r) => setTimeout(r, 5));

    expect(configured).toHaveLength(1);
    expect(configured[0]?.[0]?.name).toBe("context7");
    await client.disconnect();
  });

  test("host tool-changes are emitted as relay:advertise-mcp-tools frames", async () => {
    const { host, emitTools } = makeFakeHost();
    const { ws, client } = await connectWithHost(host);

    emitTools("context7", [
      { name: "get-library-docs", description: "docs", inputSchema: { type: "object" } },
    ]);

    const advertised = ws.sent
      .map((s) => JSON.parse(s) as { type: string; serverName?: string; tools?: unknown[] })
      .filter((m) => m.type === "relay:advertise-mcp-tools");
    expect(advertised).toHaveLength(1);
    expect(advertised[0]?.serverName).toBe("context7");
    expect(advertised[0]?.tools).toHaveLength(1);
    await client.disconnect();
  });

  test("v12 preflight and configure operations return the exact matching correlation", async () => {
    let emit: (s: string, t: RelayAdvertisedMcpTool[]) => void = () => {};
    const host: RelayMcpHost = {
      configure: () => Promise.resolve(),
      preflight: async () => ({
        status: "ready",
        machineLabel: "Test Desktop",
        launcher: "present",
        environment: [{ name: "MCP_TOKEN", present: true }],
      }),
      configureWithOutcome: async (_servers, operation) => ({
        state: operation.phase === "rollback" ? "stopped" : "connected",
        toolNames: operation.phase === "rollback" ? [] : ["search-docs"],
      }),
      has: () => false,
      dispatch: () => Promise.resolve({ status: "ok", result: {} }),
      onToolsChanged(listener) {
        emit = listener;
      },
    };
    void emit;
    const { ws, client } = await connectWithHost(host);
    const server = { name: "context7", transportKind: "stdio", transport: { command: "npx" } } as RelayMcpServerConfig;
    ws.triggerMessage(JSON.stringify({
      type: "relay:mcp-preflight",
      requestId: "preflight-1",
      digest: "digest-1",
      server,
    }));
    ws.triggerMessage(JSON.stringify({
      type: "relay:configure-mcp",
      servers: [server],
      operation: { operationId: "operation-1", digest: "digest-1", targetName: "context7", phase: "start" },
    }));
    await new Promise((resolve) => setTimeout(resolve, 5));

    const frames = ws.sent.map(parseSentFrame);
    const preflight = frames.find((frame) => frame.type === "relay:mcp-preflight-result");
    expect(preflight?.["requestId"]).toBe("preflight-1");
    expect(preflight?.["digest"]).toBe("digest-1");
    expect(preflight?.["targetName"]).toBe("context7");
    expect(preflight?.["environment"]).toEqual([{ name: "MCP_TOKEN", present: true }]);
    const configure = frames.find((frame) => frame.type === "relay:mcp-configure-result");
    expect(configure?.["operationId"]).toBe("operation-1");
    expect(configure?.["digest"]).toBe("digest-1");
    expect(configure?.["targetName"]).toBe("context7");
    expect(configure?.["state"]).toBe("connected");
    expect(configure?.["toolNames"]).toEqual(["search-docs"]);
    await client.disconnect();
  });

  test("v11 keeps configure-mcp fire-and-forget even when a v12 operation is present", async () => {
    const { host, configured } = makeFakeHost();
    const { ws, client } = await connectWithHost(host, 11);
    const server = { name: "context7", transportKind: "stdio", transport: { command: "npx" } } as RelayMcpServerConfig;
    ws.triggerMessage(JSON.stringify({
      type: "relay:configure-mcp",
      servers: [server],
      operation: { operationId: "operation-v11", digest: "digest-v11", targetName: "context7", phase: "start" },
    }));
    await new Promise((resolve) => setTimeout(resolve, 5));

    expect(configured).toEqual([[server]]);
    expect(ws.sent.map((raw) => parseSentFrame(raw).type)).not.toContain("relay:mcp-configure-result");
    await client.disconnect();
  });

  test("local exceptions become fixed failure categories and never traverse the relay", async () => {
    const secret = "API_KEY=totally-secret-value arbitrary-unknown-secret";
    const host: RelayMcpHost = {
      configure: () => Promise.resolve(),
      preflight: async () => {
        throw new Error(secret);
      },
      configureWithOutcome: async () => {
        throw new Error(secret);
      },
      has: () => false,
      dispatch: () => Promise.resolve({ status: "ok", result: {} }),
      onToolsChanged: () => {},
    };
    const { ws, client } = await connectWithHost(host);
    const server = { name: "context7", transportKind: "stdio", transport: { command: "npx" } } as RelayMcpServerConfig;
    ws.triggerMessage(JSON.stringify({
      type: "relay:mcp-preflight",
      requestId: "secret-preflight",
      digest: "digest-secret",
      server,
    }));
    ws.triggerMessage(JSON.stringify({
      type: "relay:configure-mcp",
      servers: [server],
      operation: { operationId: "secret-configure", digest: "digest-secret", targetName: "context7", phase: "start" },
    }));
    await new Promise((resolve) => setTimeout(resolve, 5));

    const truthFrames = ws.sent
      .map((raw) => JSON.parse(raw) as { type: string; failure?: unknown })
      .filter((frame) => frame.type === "relay:mcp-preflight-result" || frame.type === "relay:mcp-configure-result");
    expect(truthFrames).toHaveLength(2);
    expect(truthFrames.map((frame) => frame.failure)).toEqual([
      { code: "protocol_failed" },
      { code: "protocol_failed" },
    ]);
    expect(JSON.stringify(truthFrames)).not.toContain("totally-secret-value");
    expect(JSON.stringify(truthFrames)).not.toContain("arbitrary-unknown-secret");
    await client.disconnect();
  });

  test("socket loss stops local MCP hosting without pretending the server acknowledged it", async () => {
    const { host, getStopCalls } = makeFakeHost();
    const { ws } = await connectWithHost(host);
    ws.close();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(getStopCalls()).toBe(1);
  });

  test("a reconnect configure waits for the previous socket-loss stop to finish", async () => {
    let resolveFirstStop: (() => void) | undefined;
    let stopCalls = 0;
    let configureCalls = 0;
    const host: RelayMcpHost = {
      configure: () => {
        configureCalls += 1;
        return Promise.resolve();
      },
      has: () => false,
      dispatch: () => Promise.resolve({ status: "ok", result: {} }),
      onToolsChanged: () => {},
      stop: () => {
        stopCalls += 1;
        if (stopCalls > 1) return Promise.resolve();
        return new Promise<void>((resolve) => {
          resolveFirstStop = resolve;
        });
      },
    };
    const { ws: firstSocket, client } = await connectWithHost(host, 12, 100_000);
    firstSocket.close();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(resolveFirstStop).toBeDefined();

    const reconnect = client.connect();
    const secondSocket = created[created.length - 1]!;
    secondSocket.triggerOpen();
    secondSocket.triggerMessage(JSON.stringify({ type: "relay:registered", protocolVersion: 12 }));
    await reconnect;
    secondSocket.triggerMessage(JSON.stringify({
      type: "relay:configure-mcp",
      servers: [{ name: "context7", transportKind: "stdio", transport: { command: "npx" } }],
    }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(configureCalls).toBe(0);

    resolveFirstStop!();
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(configureCalls).toBe(1);
    await client.disconnect();
  });

  test("a second socket loss queues its own stop behind a blocked prior stop and reconnect configure", async () => {
    let resolveFirstStop: (() => void) | undefined;
    const events: string[] = [];
    let stopCalls = 0;
    let running = false;
    const host: RelayMcpHost = {
      configure: () => {
        events.push("configure");
        running = true;
        return Promise.resolve();
      },
      has: () => false,
      dispatch: () => Promise.resolve({ status: "ok", result: {} }),
      onToolsChanged: () => {},
      stop: () => {
        stopCalls += 1;
        events.push(`stop-${stopCalls}`);
        if (stopCalls === 1) {
          return new Promise<void>((resolve) => {
            resolveFirstStop = () => {
              running = false;
              resolve();
            };
          });
        }
        running = false;
        return Promise.resolve();
      },
    };
    const { ws: firstSocket, client } = await connectWithHost(host, 12, 100_000);
    firstSocket.close();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(events).toEqual(["stop-1"]);

    const reconnect = client.connect();
    const secondSocket = created[created.length - 1]!;
    secondSocket.triggerOpen();
    secondSocket.triggerMessage(JSON.stringify({ type: "relay:registered", protocolVersion: 12 }));
    await reconnect;
    secondSocket.triggerMessage(JSON.stringify({
      type: "relay:configure-mcp",
      servers: [{ name: "context7", transportKind: "stdio", transport: { command: "npx" } }],
    }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(events).toEqual(["stop-1"]);

    // This is the regression: the second close lands before stop-1 settles.
    secondSocket.close();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(events).toEqual(["stop-1"]);

    resolveFirstStop!();
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(events).toEqual(["stop-1", "configure", "stop-2"]);
    expect(stopCalls).toBe(2);
    expect(running).toBe(false);
    await client.disconnect();
  });

  test("dispatch of a hosted MCP tool routes to the host, not onDispatch", async () => {
    const { host, dispatched } = makeFakeHost();
    const { ws, client } = await connectWithHost(host);

    // Configure so the host reports has("context7__tool") === true.
    ws.triggerMessage(
      JSON.stringify({
        type: "relay:configure-mcp",
        servers: [{ name: "context7", transportKind: "stdio", transport: {}, namespaceId: null }],
      }),
    );
    await new Promise((r) => setTimeout(r, 5));

    ws.triggerMessage(
      JSON.stringify({
        type: "relay:dispatch",
        correlationId: "corr-mcp-1",
        toolName: "context7__tool",
        args: { q: "react" },
        impact: "low",
        approvalObtained: true,
      }),
    );
    await new Promise((r) => setTimeout(r, 10));

    expect(dispatched).toEqual([{ name: "context7__tool", args: { q: "react" } }]);
    const results = ws.sent
      .map((s) => JSON.parse(s) as { type: string; correlationId?: string; status?: string })
      .filter((m) => m.type === "relay:result" && m.correlationId === "corr-mcp-1");
    expect(results[0]?.status).toBe("ok");
    await client.disconnect();
  });

  test("v19 MCP dispatch requires exact hostedBy provenance", async () => {
    const { host, dispatched } = makeFakeHost();
    const { ws, client } = await connectWithHost(host, 19);
    ws.triggerMessage(
      JSON.stringify({
        type: "relay:configure-mcp",
        servers: [
          {
            name: "context7",
            transportKind: "stdio",
            transport: {},
            namespaceId: null,
          },
        ],
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 5));

    ws.triggerMessage(
      JSON.stringify({
        type: "relay:dispatch",
        correlationId: "corr-mcp-v19",
        toolName: "context7__tool",
        args: { q: "relay" },
        impact: "low",
        approvalObtained: true,
        hostedBy: "relay-1",
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(dispatched).toEqual([
      { name: "context7__tool", args: { q: "relay" } },
    ]);
    await client.disconnect();
  });

  test("v19 name collision without hostedBy stays on the built-in dispatch path", async () => {
    const dispatched: Array<{ name: string; args: Record<string, unknown> }> = [];
    const host: RelayMcpHost = {
      configure: () => undefined,
      has: (name) => name === "run_shell",
      dispatch: (name, args) => {
        dispatched.push({ name, args });
        return Promise.resolve({ status: "ok", result: "mcp-path" });
      },
      onToolsChanged: () => undefined,
    };
    const { ws, client } = await connectWithHost(host, 19);

    ws.triggerMessage(
      JSON.stringify({
        type: "relay:dispatch",
        correlationId: "corr-builtin-v19",
        toolName: "run_shell",
        args: { command: "printf safe" },
        impact: "low",
        approvalObtained: true,
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(dispatched).toEqual([]);
    const result = ws.sent
      .map((raw) => parseSentFrame(raw))
      .find(
        (frame) =>
          frame.type === "relay:result" &&
          frame["correlationId"] === "corr-builtin-v19",
      );
    expect(result?.["result"]).toBe("cloud-path");
    await client.disconnect();
  });

  test("v19 rejects foreign hostedBy provenance before either dispatch path", async () => {
    const { host, dispatched } = makeFakeHost();
    const { ws, client } = await connectWithHost(host, 19);
    ws.triggerMessage(
      JSON.stringify({
        type: "relay:configure-mcp",
        servers: [
          {
            name: "context7",
            transportKind: "stdio",
            transport: {},
            namespaceId: null,
          },
        ],
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 5));

    ws.triggerMessage(
      JSON.stringify({
        type: "relay:dispatch",
        correlationId: "corr-foreign-v19",
        toolName: "context7__tool",
        args: { secret: "must-not-dispatch" },
        impact: "low",
        approvalObtained: true,
        hostedBy: "another-relay",
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(dispatched).toEqual([]);
    const result = ws.sent
      .map((raw) => parseSentFrame(raw))
      .find(
        (frame) =>
          frame.type === "relay:result" &&
          frame["correlationId"] === "corr-foreign-v19",
      );
    expect(result).toMatchObject({ status: "error" });
    await client.disconnect();
  });
});
