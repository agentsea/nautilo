import { describe, test, expect, afterAll } from "bun:test";
import Fastify, { type FastifyInstance } from "fastify";
import websocket from "@fastify/websocket";
import WebSocket, { type RawData } from "ws";
import { InMemoryRelayRegistry } from "@nautilo/runtime";
import { RELAY_MCP_TRUTH_MAX_FRAME_BYTES } from "@nautilo/relay";
import { parseRelayEndpointClientMessage, relayRoutes } from "../../src/realtime/relay-endpoint";
import {
  setRelayTokenStore,
  resetRelayTokenStore,
  type RelayTokenStore,
} from "../../src/lib/relay-token-store";
import {
  createRelayClient,
  type RelayDispatchRequest,
  type RelayDispatchResult,
  type RelaySandboxProfile,
} from "@nautilo/relay";

const TEST_PORT = 19876;
const SERVER_URL = `http://localhost:${TEST_PORT}`;

// Token validation is unconditional post-M072 (the relay-endpoint gate
// that previously skipped it is gone). Inject a fake
// store that resolves any rty_test-* token to the requested user.
const TEST_RELAY_TOKEN = "rty_test-relay-token";
const TEST_USER_ID = "@john-user@nautilo.local";
const MCP_DESKTOP_SESSION = "mcp-integration-desktop";

const fakeRelayTokenStore: RelayTokenStore = {
  async findActiveByHash(_hash: string) {
    return {
      id: "test-token-id",
      userId: TEST_USER_ID,
      actorId: "test-actor",
    };
  },
  async touchLastSeen() {
    /* no-op */
  },
  async insertToken() {
    return { id: "test-token-id" };
  },
  async pairForInstallation() {
    return { id: "test-token-id" };
  },
  async listForUser() {
    return [];
  },
  async revokeForUser() {
    return false;
  },
};

let server: FastifyInstance | null = null;
let registry: InMemoryRelayRegistry | null = null;
let relaySocketLifecycle: ReturnType<typeof relayRoutes> | null = null;

async function startTestServer() {
  setRelayTokenStore(fakeRelayTokenStore);
  registry = new InMemoryRelayRegistry();
  registry.start();

  server = Fastify({ logger: false });
  await server.register(websocket);
  relaySocketLifecycle = relayRoutes(server, registry);
  await server.listen({ port: TEST_PORT, host: "127.0.0.1" });
  return { server, registry };
}

function rawRelayMessageToString(raw: RawData): string {
  if (typeof raw === "string") return raw;
  if (raw instanceof Buffer) return raw.toString("utf8");
  if (raw instanceof ArrayBuffer) return Buffer.from(raw).toString("utf8");
  if (Array.isArray(raw)) return Buffer.concat(raw).toString("utf8");
  return "";
}

async function connectRawRelay(
  relayId: string,
  desktopSessionId = `${relayId}-desktop`,
): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`${SERVER_URL.replace(/^http/, "ws")}/relay`);
    const timer = setTimeout(() => reject(new Error("raw relay registration timed out")), 5_000);
    let settled = false;
    const finish = (result: WebSocket | Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (result instanceof Error) reject(result);
      else resolve(result);
    };
    socket.once("error", (error) => finish(error));
    socket.on("open", () => {
      socket.send(JSON.stringify({
        type: "relay:register",
        relayId,
        userId: TEST_USER_ID,
        token: TEST_RELAY_TOKEN,
        capabilities: { profile: "desktop-agent", mcpTools: [] },
        desktopSessionId,
        protocolVersion: 9,
        protocolRange: { minimum: 9, maximum: 12 },
        capabilitiesByProtocolVersion: {
          12: { profile: "desktop-agent", mcpTools: [] },
        },
      }));
    });
    socket.on("message", (raw: RawData) => {
      const message = JSON.parse(rawRelayMessageToString(raw)) as { type?: string };
      if (message.type === "relay:registered") finish(socket);
      if (message.type === "relay:error") finish(new Error("raw relay registration rejected"));
    });
  });
}

afterAll(async () => {
  registry?.stop();
  relaySocketLifecycle = null;
  if (server) {
    server.server.closeAllConnections();
    await server.close().catch(() => {});
  }
  resetRelayTokenStore();
});

describe("relay protocol", () => {
  test("rejects oversized MCP truth frames before JSON materialization", () => {
    const raw = `{"type":"relay:mcp-configure-result","padding":"${"x".repeat(RELAY_MCP_TRUTH_MAX_FRAME_BYTES)}"}`;
    expect(parseRelayEndpointClientMessage(raw)).toEqual({
      ok: false,
      codex: false,
      error: "MCP_TRUTH_FRAME_TOO_LARGE",
    });
  });

  test("client connects, registers, and appears in registry", async () => {
    await startTestServer();

    const client = createRelayClient({
      serverUrl: SERVER_URL,
      token: TEST_RELAY_TOKEN,
      userId: "@john-user@nautilo.local",
      capabilities: {
        profile: "desktop-agent",
        canReadWorkspace: true,
        canWriteWorkspace: true,
        canRunShell: true,
        allowedRoots: ["/tmp/test-workspace"],
        securityLevel: "standard",
      },
      onDispatch: async () => ({ status: "ok", result: "noop" }),
    });

    await client.connect();
    expect(client.getStatus()).toBe("connected");

    const connected = await registry!.listConnected();
    expect(connected).toContain(client.getRelayId());

    const caps = registry!.getCapabilities(client.getRelayId());
    expect(caps?.profile).toBe("desktop-agent");
    expect(caps?.canRunShell).toBe(true);

    const userId = registry!.getUserId(client.getRelayId());
    expect(userId).toBe("@john-user@nautilo.local");

    await client.disconnect();
    expect(client.getStatus()).toBe("disconnected");

    // Small delay for server-side unregister to process
    await new Promise((r) => setTimeout(r, 100));
    const afterDisconnect = await registry!.listConnected();
    expect(afterDisconnect).not.toContain(client.getRelayId());
  });

  test("dispatch round trip: server sends tool call, client executes, result returns", async () => {
    const dispatches: RelayDispatchRequest[] = [];

    const client = createRelayClient({
      serverUrl: SERVER_URL,
      token: TEST_RELAY_TOKEN,
      userId: "@john-user@nautilo.local",
      capabilities: {
        profile: "desktop-agent",
        canReadWorkspace: true,
        canRunShell: true,
      },
      onDispatch: async (req: RelayDispatchRequest): Promise<RelayDispatchResult> => {
        dispatches.push(req);
        return {
          status: "ok",
          result: { files: ["README.md", "package.json"] },
        };
      },
    });

    await client.connect();

    const result = await registry!.dispatch(client.getRelayId(), {
      toolName: "run_shell",
      args: { command: "ls /workspace" },
      impact: "destructive",
      approvalObtained: true,
      allowedRoots: ["/workspace"],
    });

    expect(result.status).toBe("ok");
    expect(result.result).toEqual({ files: ["README.md", "package.json"] });
    expect(dispatches).toHaveLength(1);
    expect(dispatches[0]!.toolName).toBe("run_shell");
    expect(dispatches[0]!.impact).toBe("destructive");

    await client.disconnect();
  });

  test("dispatch round trip preserves sandboxProfile envelope", async () => {
    const dispatches: RelayDispatchRequest[] = [];
    const sandboxProfile: RelaySandboxProfile = {
      workspace: "/workspace",
      dataDir: "/home/test/.nautilo",
      toolsBin: "/home/test/.bun/bin",
      mode: "server",
      securityLevel: "standard",
      failIfNoBackend: true,
      config: {
        mode: "enabled",
        writablePaths: ["/workspace"],
        projectPaths: ["/workspace"],
        passthroughEnv: [],
        networkPolicy: { mode: "isolated" },
      },
    };

    const client = createRelayClient({
      serverUrl: SERVER_URL,
      token: TEST_RELAY_TOKEN,
      userId: "@john-user@nautilo.local",
      capabilities: {
        profile: "desktop-agent",
        canRunShell: true,
        allowedRoots: ["/workspace"],
      },
      onDispatch: async (req: RelayDispatchRequest): Promise<RelayDispatchResult> => {
        dispatches.push(req);
        return { status: "ok", result: "sandboxed" };
      },
    });

    await client.connect();

    const result = await registry!.dispatch(client.getRelayId(), {
      toolName: "run_shell",
      args: { command: "echo ok" },
      impact: "destructive",
      approvalObtained: true,
      allowedRoots: ["/workspace"],
      sandboxProfile,
    });

    expect(result.status).toBe("ok");
    expect(dispatches).toHaveLength(1);
    expect(dispatches[0]!.sandboxProfile).toEqual(sandboxProfile);

    await client.disconnect();
  });

  test("dispatch to disconnected relay throws", async () => {
    let caught: unknown = null;
    try {
      await registry!.dispatch("nonexistent-relay", {
        toolName: "test",
        args: {},
        impact: "read-only",
        approvalObtained: false,
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toContain("not connected");
  });

  test("findByCapabilityForUser returns correct relays", async () => {
    const client1 = createRelayClient({
      serverUrl: SERVER_URL,
      token: TEST_RELAY_TOKEN,
      userId: "@john-user@nautilo.local",
      capabilities: { profile: "desktop-agent", canRunShell: true },
      onDispatch: async () => ({ status: "ok" }),
    });

    const client2 = createRelayClient({
      serverUrl: SERVER_URL,
      token: TEST_RELAY_TOKEN,
      userId: "@alice@nautilo.local",
      capabilities: { profile: "desktop-agent", canReadWorkspace: true },
      onDispatch: async () => ({ status: "ok" }),
    });

    await client1.connect();
    await client2.connect();

    const shellRelays = registry!.findByCapabilityForUser("canRunShell", "@john-user@nautilo.local");
    expect(shellRelays).toContain(client1.getRelayId());
    expect(shellRelays).not.toContain(client2.getRelayId());

    const aliceShell = registry!.findByCapabilityForUser("canRunShell", "@alice@nautilo.local");
    expect(aliceShell).toHaveLength(0);

    const anyShell = registry!.findByCapability("canRunShell");
    expect(anyShell).toContain(client1.getRelayId());

    await client1.disconnect();
    await client2.disconnect();
  });

  test("dispatch error from relay is returned correctly", async () => {
    const client = createRelayClient({
      serverUrl: SERVER_URL,
      token: TEST_RELAY_TOKEN,
      userId: "@john-user@nautilo.local",
      capabilities: { profile: "desktop-agent", canRunShell: true },
      onDispatch: async () => ({
        status: "error",
        error: "Permission denied: /etc/passwd is outside allowed roots",
      }),
    });

    await client.connect();

    const result = await registry!.dispatch(client.getRelayId(), {
      toolName: "run_shell",
      args: { command: "cat /etc/passwd" },
      impact: "destructive",
      approvalObtained: false,
    });

    expect(result.status).toBe("error");
    expect(result.error).toContain("Permission denied");

    await client.disconnect();
  });

  test("v12 MCP truth messages round-trip through the authenticated relay endpoint", async () => {
    const mcpHost = {
      configure: () => Promise.resolve(),
      preflight: async () => ({
        status: "ready" as const,
        machineLabel: "Integration Desktop",
        launcher: "present" as const,
        environment: [{ name: "MCP_TEST_ENV", present: true }],
      }),
      configureWithOutcome: async () => ({
        state: "connected" as const,
        toolNames: ["search-docs"],
      }),
      has: () => false,
      dispatch: async () => ({ status: "ok" as const, result: {} }),
      onToolsChanged: () => {},
      stop: () => Promise.resolve(),
    };
    const client = createRelayClient({
      serverUrl: SERVER_URL,
      token: TEST_RELAY_TOKEN,
      userId: TEST_USER_ID,
      capabilities: { profile: "desktop-agent", mcpTools: [] },
      desktopSessionId: MCP_DESKTOP_SESSION,
      onDispatch: async () => ({ status: "ok" }),
      mcpHost,
    });
    await client.connect();
    const relayId = client.getRelayId();
    const server = {
      name: "context7",
      transportKind: "stdio" as const,
      transport: { command: "npx" },
      envPassthrough: ["MCP_TEST_ENV"],
    };
    const preflight = await registry!.preflightMcp(relayId, {
      requestId: "integration-preflight",
      digest: "digest-1",
      expectedDesktopSessionId: MCP_DESKTOP_SESSION,
      server,
    });
    expect(preflight).toMatchObject({
      targetName: "context7",
      machineLabel: "Integration Desktop",
      environment: [{ name: "MCP_TEST_ENV", present: true }],
    });
    const configured = await registry!.configureMcpWithOutcome(relayId, {
      servers: [server],
      operation: {
        operationId: "integration-configure",
        digest: "digest-1",
        targetName: "context7",
        phase: "start",
      },
      expectedDesktopSessionId: MCP_DESKTOP_SESSION,
    });
    expect(configured).toMatchObject({ state: "connected", toolNames: ["search-docs"] });
    await client.disconnect();
  });

  test("a superseded relay socket cannot satisfy a pending MCP truth operation", async () => {
    const relayId = "relay-mcp-replacement";
    const firstDesktopSession = "replacement-first-desktop";
    const replacementDesktopSession = "replacement-second-desktop";
    const firstSocket = await connectRawRelay(relayId, firstDesktopSession);
    const server = {
      name: "context7",
      transportKind: "stdio" as const,
      transport: { command: "npx" },
    };
    const oldPending = registry!.preflightMcp(relayId, {
      requestId: "replacement-old",
      digest: "replacement-digest",
      expectedDesktopSessionId: firstDesktopSession,
      server,
    });
    const oldPendingOutcome = oldPending.then(
      () => null,
      (error: unknown) => error,
    );

    const secondSocket = await connectRawRelay(relayId, replacementDesktopSession);
    expect(oldPendingOutcome).resolves.toMatchObject({ code: "relay_replaced" });

    let resolved = false;
    const currentPending = registry!.preflightMcp(relayId, {
      requestId: "replacement-current",
      digest: "replacement-current-digest",
      expectedDesktopSessionId: replacementDesktopSession,
      server,
    });
    void currentPending.then(() => {
      resolved = true;
    });
    const truth = {
      type: "relay:mcp-preflight-result",
      requestId: "replacement-current",
      digest: "replacement-current-digest",
      targetName: "context7",
      status: "ready",
      machineLabel: "Replacement Desktop",
      launcher: "present",
      environment: [],
    };
    firstSocket.send(JSON.stringify(truth));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(resolved).toBe(false);

    secondSocket.send(JSON.stringify(truth));
    expect(currentPending).resolves.toMatchObject({ requestId: "replacement-current" });
    firstSocket.close();
    secondSocket.close();
  });

  test("local-MCP safety close synchronously refuses a replacement Desktop session", async () => {
    const relayId = "relay-mcp-safety-close";
    const firstSocket = await connectRawRelay(relayId, "safety-first-desktop");
    const replacement = await connectRawRelay(relayId, "safety-replacement-desktop");
    const lifecycle = relaySocketLifecycle;
    if (!lifecycle) throw new Error("expected relay socket lifecycle");
    const forceClose = lifecycle.forceCloseRelays;
    if (!forceClose) throw new Error("expected local-MCP safety closer");

    // The old transaction's safety close must not touch the replacement.
    expect(forceClose([relayId], "safety-first-desktop")).toBe(0);
    expect(replacement.readyState).toBe(WebSocket.OPEN);

    const closed = new Promise<void>((resolve) => replacement.once("close", () => resolve()));
    expect(forceClose([relayId], "safety-replacement-desktop")).toBe(1);
    await closed;
    firstSocket.close();
  });
});
