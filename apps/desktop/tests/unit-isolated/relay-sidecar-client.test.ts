import { afterEach, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { PassThrough } from "node:stream";
import { WebSocketServer, type WebSocket } from "ws";

import {
  RELAY_HOST_COMPONENT,
  RELAY_HOST_PROTOCOL_VERSION,
  RELAY_PROTOCOL_VERSION,
  RELAY_DESKTOP_AUTOMATION_INVOCATION_BINDING_VERSION,
  encodeRelayHostFrame,
  type RelayAdvertisedMcpTool,
  type RelayDispatchRequest,
  type RelayMcpHost,
} from "@nautilo/relay";
import {
  createDesktopRelaySidecarClient,
  resolveDesktopRelayHostLaunch,
} from "../../electron/relay-sidecar-client.ts";

const servers: WebSocketServer[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolveClose) => server.close(() => resolveClose()))));
});

async function server(): Promise<{ server: WebSocketServer; url: string; socket: Promise<WebSocket> }> {
  const wss = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  servers.push(wss);
  await new Promise<void>((resolveListen) => wss.once("listening", resolveListen));
  const address = wss.address();
  if (typeof address === "string" || address === null) throw new Error("test relay address unavailable");
  const socket = new Promise<WebSocket>((resolveSocket) => wss.once("connection", resolveSocket));
  return { server: wss, url: `http://127.0.0.1:${address.port}`, socket };
}

function nextJson(socket: WebSocket): Promise<Record<string, unknown>> {
  return new Promise((resolveMessage, reject) => {
    socket.once("message", (data) => {
      try {
        const raw = Array.isArray(data)
          ? Buffer.concat(data).toString("utf8")
          : data instanceof ArrayBuffer
            ? Buffer.from(data).toString("utf8")
            : data.toString("utf8");
        resolveMessage(JSON.parse(raw) as Record<string, unknown>);
      } catch (error) {
        reject(error instanceof Error ? error : new Error("test Relay emitted invalid JSON"));
      }
    });
  });
}

describe("Desktop Relay sidecar client", () => {
  test.each(["receipt", "disconnect"] as const)("Computer Use cancellation preserves settlement ownership through %s", async mode => {
    const live = await server();
    let started!: () => void;
    let aborted!: () => void;
    let finish!: () => void;
    const didStart = new Promise<void>(resolve => { started = resolve; });
    const didAbort = new Promise<void>(resolve => { aborted = resolve; });
    const mayFinish = new Promise<void>(resolve => { finish = resolve; });
    const settlement = { settlement: "unknown_completion", result: { deliveredCharacters: 7 } };
    const client = createDesktopRelaySidecarClient({
      executablePath: process.execPath,
      executableArguments: [resolve(import.meta.dir, "../../../../bin/nautilo-relay/src/desktop-host-main.ts")],
      serverUrl: live.url, userId: "user-1", relayId: "relay-1", desktopSessionId: "desktop-1",
      capabilities: { profile: "desktop-agent" },
      onDispatch: async (_request, signal) => {
        started();
        signal.addEventListener("abort", aborted, { once: true });
        await mayFinish;
        return { status: "ok", result: settlement };
      },
    });
    const connecting = client.connect();
    const socket = await live.socket;
    await nextJson(socket);
    socket.send(JSON.stringify({ type: "relay:registered", relayId: "relay-1",
      protocolVersion: RELAY_PROTOCOL_VERSION, selectedProtocolVersion: RELAY_PROTOCOL_VERSION,
      relaySessionId: "relay-session-1", pairingGenerationRef: "pairing-1" }));
    await connecting;
    try {
      const result = nextJson(socket);
      socket.send(JSON.stringify({ type: "relay:dispatch", correlationId: "cancel-cua",
        toolName: "future_catalogue_mutation", args: {}, impact: "high", approvalObtained: true,
        executionClass: "computer_use",
        desktopAutomationBinding: {
          version: RELAY_DESKTOP_AUTOMATION_INVOCATION_BINDING_VERSION,
          computerUseContextId: "context-1", computerUseInvocationId: "computer-invocation:fixture-1",
          originHumanId: "user-1", originRunId: "run-1", originAgentId: "agent-1", lineageId: "lineage-1",
          installationEpoch: "epoch-1", grantGeneration: 1, provider: "cua", providerGeneration: "provider-1",
          relayId: "relay-1", pairingGeneration: "pairing-1", desktopSessionId: "desktop-1",
        },
        computerUseRequest: { contract: {
          contractNamespace: "nautilo.computer_use", contractId: "future.operation", contractVersion: 1,
          schemaDigest: `sha256:${"a".repeat(64)}`, effectClass: "mutate", replayClass: "at_most_once",
          authorityClass: "standing_computer_use", attachmentClass: "none", disclosureClass: "semantic",
        }, arguments: {} },
      }));
      await didStart;
      socket.send(JSON.stringify({ type: "relay:cancel", correlationId: "cancel-cua" }));
      await didAbort;
      if (mode === "disconnect") {
        // The executor has not returned yet. Pipe retirement must still end
        // the owned child rather than leave retained callbacks hanging.
        await client.disconnect();
        expect(client.getStatus()).toBe("disconnected");
        return;
      }
      finish();
      expect(await result).toMatchObject({ type: "relay:result", correlationId: "cancel-cua",
        status: "ok", result: settlement });
    } finally {
      finish();
      if (client.getStatus() !== "disconnected") await client.disconnect();
    }
  }, 20_000);

  test("retires a pre-initialization identity failure without hanging cleanup", async () => {
    class FakeHost extends EventEmitter {
      readonly stdin = new PassThrough();
      readonly stdout = new PassThrough();
      readonly stderr = new PassThrough();
      exitCode: number | null = null;
      killedWith: NodeJS.Signals | null = null;

      kill(signal: NodeJS.Signals = "SIGTERM"): boolean {
        this.killedWith = signal;
        this.exitCode = 1;
        queueMicrotask(() => this.emit("close", 1, signal));
        return true;
      }
    }

    const host = new FakeHost();
    const client = createDesktopRelaySidecarClient({
      executablePath: "/fixed/relay-host-runtime",
      spawnHost: () => {
        queueMicrotask(() => host.stdout.write(encodeRelayHostFrame({
          protocolVersion: RELAY_HOST_PROTOCOL_VERSION,
          kind: "ready",
          component: RELAY_HOST_COMPONENT,
          hostVersion: "wrong-version",
          nonce: "nonce-1",
        })));
        return host as never;
      },
      serverUrl: "http://127.0.0.1:8001",
      userId: "user-1",
      relayId: "relay-1",
      desktopSessionId: "desktop-1",
      capabilities: { profile: "desktop-agent" },
      onDispatch: async () => ({ status: "error", error: "not reached" }),
    });

    const connectionFailure = await client.connect().then(
      () => "connected",
      (error: unknown) => error instanceof Error ? error.message : String(error),
    );
    expect(connectionFailure).toBe("Relay Host identity/version mismatch");
    expect(host.killedWith).toBe("SIGTERM");
    expect(await Promise.race([
      client.disconnect().then(() => "disconnected"),
      new Promise<string>((resolveTimeout) => setTimeout(() => resolveTimeout("timed-out"), 100)),
    ])).toBe("disconnected");
    expect(client.getStatus()).toBe("disconnected");
  });

  test("puts RelayClient/WebSocket in the child and bridges one bounded dispatch", async () => {
    const live = await server();
    const source = resolve(import.meta.dir, "../../../../bin/nautilo-relay/src/desktop-host-main.ts");
    const token = "secret-relay-token-sentinel";
    let launch: { command: string; args: readonly string[] } | null = null;
    let dispatched: RelayDispatchRequest | null = null;
    let childProcess: ReturnType<typeof spawn> | null = null;
    let resolveCrashDispatchStarted!: () => void;
    const crashDispatchStarted = new Promise<void>((resolveStarted) => { resolveCrashDispatchStarted = resolveStarted; });
    let crashDispatchAborted = false;
    const client = createDesktopRelaySidecarClient({
      executablePath: process.execPath,
      executableArguments: [source],
      spawnHost: (command, args) => {
        launch = { command, args };
        childProcess = spawn(command, [...args], { shell: false, stdio: ["pipe", "pipe", "pipe"] });
        return childProcess as never;
      },
      serverUrl: live.url,
      userId: "user-1",
      relayId: "relay-1",
      token,
      desktopSessionId: "desktop-1",
      initialCapabilityRevision: 0,
      runShellOwnerInstanceId: "instance-1",
      browserPageOwnerInstanceId: "instance-1",
      capabilities: { profile: "desktop-agent", canRunShell: true },
      onDispatch: async (request, signal) => {
        dispatched = request;
        if (request.toolName === "crash_fence_test") {
          resolveCrashDispatchStarted();
          await new Promise<void>((resolveAbort) => signal.addEventListener("abort", () => {
            crashDispatchAborted = true;
            resolveAbort();
          }, { once: true }));
          return { status: "error", error: "retired" };
        }
        return { status: "ok", result: { bridged: true } };
      },
    });

    const connecting = client.connect();
    const socket = await live.socket;
    const register = await nextJson(socket);
    expect(register["type"]).toBe("relay:register");
    expect(register["token"]).toBe(token);
    socket.send(JSON.stringify({
      type: "relay:registered",
      relayId: "relay-1",
      protocolVersion: RELAY_PROTOCOL_VERSION,
      selectedProtocolVersion: RELAY_PROTOCOL_VERSION,
      relaySessionId: "relay-session-1",
      pairingGenerationRef: "pairing-1",
    }));
    await connecting;

    expect(client.getStatus()).toBe("connected");
    expect(client.getDesktopTopology()).toMatchObject({ relayId: "relay-1", desktopSessionId: "desktop-1" });
    expect(launch).not.toBeNull();
    expect(JSON.stringify(launch)).not.toContain(token);

    const updating = client.updateCapabilities({ profile: "desktop-agent", canRunShell: true, canUseTerminal: true });
    const update = await nextJson(socket);
    expect(update["type"]).toBe("relay:update-capabilities");
    expect(update["capabilityRevision"]).toBe(Number(register["capabilityRevision"]) + 1);
    socket.send(JSON.stringify({
      type: "relay:capabilities-updated",
      relayId: "relay-1",
      capabilityRevision: update["capabilityRevision"],
      status: "ok",
    }));
    await updating;
    expect(client.getAcknowledgedCapabilityRevision()).toBe(Number(update["capabilityRevision"]));

    socket.send(JSON.stringify({
      type: "relay:dispatch",
      correlationId: "corr-1",
      toolName: "bounded_test_tool",
      args: { value: 1 },
      timeout: 1_000,
      impact: "low",
      approvalObtained: true,
      executionClass: "desktop",
    }));
    const result = await nextJson(socket);
    expect(result).toMatchObject({
      type: "relay:result",
      correlationId: "corr-1",
      status: "ok",
      result: { bridged: true },
    });
    expect(dispatched).toMatchObject({ toolName: "bounded_test_tool", args: { value: 1 } });

    const replacementSocket = new Promise<WebSocket>((resolveSocket) => live.server.once("connection", resolveSocket));
    socket.send(JSON.stringify({
      type: "relay:dispatch",
      correlationId: "corr-crash",
      toolName: "crash_fence_test",
      args: {},
      timeout: 1_000,
      impact: "low",
      approvalObtained: true,
      executionClass: "desktop",
    }));
    await crashDispatchStarted;
    childProcess!.kill("SIGKILL");
    const replacement = await replacementSocket;
    const replacementRegister = await nextJson(replacement);
    expect(replacementRegister["type"]).toBe("relay:register");
    replacement.send(JSON.stringify({
      type: "relay:registered",
      relayId: "relay-1",
      protocolVersion: RELAY_PROTOCOL_VERSION,
      selectedProtocolVersion: RELAY_PROTOCOL_VERSION,
      relaySessionId: "relay-session-2",
      pairingGenerationRef: "pairing-2",
    }));
    for (let attempts = 0; attempts < 50 && client.getStatus() !== "connected"; attempts += 1) {
      await new Promise((resolveWait) => setTimeout(resolveWait, 10));
    }
    expect(crashDispatchAborted).toBe(true);
    expect(client.getStatus()).toBe("connected");
    expect(client.getDesktopTopology()).toMatchObject({ relaySessionId: "relay-session-2" });
    await client.disconnect();
  }, 20_000);

  test.each(["child crash", "client recreation"] as const)(
    "preserves workstation revision across %s without inventing an acknowledgement",
    async (replacementKind) => {
      const live = await server();
      let child: ReturnType<typeof spawn> | null = null;
      const makeClient = () => createDesktopRelaySidecarClient({
        executablePath: process.execPath,
        executableArguments: [resolve(import.meta.dir, "../../../../bin/nautilo-relay/src/desktop-host-main.ts")],
        spawnHost: (command, args) => {
          child = spawn(command, [...args], { shell: false, stdio: ["pipe", "pipe", "pipe"] });
          return child as never;
        },
        serverUrl: live.url,
        userId: "user-1", relayId: "relay-1", desktopSessionId: "desktop-1",
        capabilities: { profile: "desktop-agent", canRunShell: true },
        onDispatch: async () => ({ status: "ok", result: "executed" }),
      });
      let client = makeClient();
      const acknowledge = (socket: WebSocket, sessionId: string) => socket.send(JSON.stringify({
        type: "relay:registered", relayId: "relay-1",
        protocolVersion: RELAY_PROTOCOL_VERSION, selectedProtocolVersion: RELAY_PROTOCOL_VERSION,
        relaySessionId: sessionId, pairingGenerationRef: "same-pairing",
      }));
      try {
        const connecting = client.connect();
        const socket = await live.socket;
        await nextJson(socket);
        acknowledge(socket, "session-before-replacement");
        await connecting;
        const updateFrame = nextJson(socket);
        const updating = client.updateCapabilities({ profile: "desktop-agent", canRunShell: true });
        const update = await updateFrame;
        const activeSessionRevision = Number(update["capabilityRevision"]);
        socket.send(JSON.stringify({ type: "relay:capabilities-updated", relayId: "relay-1",
          capabilityRevision: activeSessionRevision, status: "ok" }));
        await updating;
        expect(client.getAcknowledgedCapabilityRevision()).toBe(activeSessionRevision);

        const nextConnection = new Promise<WebSocket>(resolveSocket => live.server.once("connection", resolveSocket));
        let reconnecting: Promise<void> | null = null;
        if (replacementKind === "child crash") {
          child!.kill("SIGKILL");
        } else {
          await client.disconnect();
          client = makeClient();
          reconnecting = client.connect();
        }
        const replacement = await nextConnection;
        const registration = await nextJson(replacement);
        // A seed is a sequence number, never proof the new socket is admitted.
        expect(client.getAcknowledgedCapabilityRevision()).toBeNull();
        expect(client.getDesktopTopology()).toBeNull();
        const replacementRevision = Number(registration["capabilityRevision"]);
        acknowledge(replacement, "session-after-replacement");
        if (reconnecting !== null) await reconnecting;
        for (let attempts = 0; attempts < 50 && client.getAcknowledgedCapabilityRevision() === null; attempts += 1) {
          await new Promise(resolveWait => setTimeout(resolveWait, 10));
        }
        expect(client.getAcknowledgedCapabilityRevision()).toBe(replacementRevision);
        expect(replacementRevision).toBeGreaterThan(activeSessionRevision);
        expect(client.getDesktopTopology()).toMatchObject({
          desktopSessionId: "desktop-1", pairingGeneration: "same-pairing",
        });
      } finally {
        await client.disconnect();
      }
    }, 20_000,
  );

  test("resolves only the fixed packaged or vendored executable", () => {
    expect(() => resolveDesktopRelayHostLaunch({
      isPackaged: true,
      resourcesPath: null,
      devVendorRoot: "/tmp/ignored",
    })).toThrow("Packaged Relay Host resource root is unavailable");
    expect(() => resolveDesktopRelayHostLaunch({
      isPackaged: false,
      resourcesPath: null,
      devVendorRoot: "/definitely/missing/relay-host",
    })).toThrow("Managed Relay Host runtime is unavailable or invalid");
  });

  test("accepts the exact hashed host program and rejects changed bytes", () => {
    const root = mkdtempSync(join(tmpdir(), "nautilo-relay-host-resolution-"));
    try {
      const hostRoot = join(root, "relay-host");
      const runtimeRoot = join(root, "bun", "arm64");
      mkdirSync(hostRoot, { recursive: true });
      mkdirSync(runtimeRoot, { recursive: true });
      const runtime = join(runtimeRoot, "bun");
      const script = join(hostRoot, "nautilo-relay-host.js");
      writeFileSync(runtime, "runtime");
      chmodSync(runtime, 0o755);
      const bytes = Buffer.from("host-program");
      writeFileSync(script, bytes);
      writeFileSync(join(hostRoot, "manifest.json"), JSON.stringify({
        schemaVersion: 1,
        script: "nautilo-relay-host.js",
        packageVersion: "0.1.0",
        hostVersion: "1.0.0",
        protocolVersion: 1,
        bytes: bytes.byteLength,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      }));
      expect(resolveDesktopRelayHostLaunch({
        isPackaged: false,
        resourcesPath: null,
        devVendorRoot: hostRoot,
        architecture: "arm64",
      })).toEqual({
        executablePath: runtime,
        executableArguments: [script],
        hostVersion: "1.0.0",
      });
      writeFileSync(script, "tampered");
      expect(() => resolveDesktopRelayHostLaunch({
        isPackaged: false,
        resourcesPath: null,
        devVendorRoot: hostRoot,
        architecture: "arm64",
      })).toThrow("Managed Relay Host runtime is unavailable or invalid");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("keeps MCP execution in Electron while the child owns provenance routing", async () => {
    const live = await server();
    const source = resolve(import.meta.dir, "../../../../bin/nautilo-relay/src/desktop-host-main.ts");
    let toolsChanged: (serverName: string, tools: RelayAdvertisedMcpTool[]) => void = () => {};
    const dispatches: string[] = [];
    const mcpHost: RelayMcpHost = {
      configure: () => {
        toolsChanged("context7", [{ name: "context7__lookup", inputSchema: { type: "object" } }]);
      },
      has: () => false,
      dispatch: async (toolName) => {
        dispatches.push(toolName);
        return { status: "ok", result: { fromElectronMcp: true } };
      },
      onToolsChanged: (listener) => { toolsChanged = listener; },
      stop: async () => {},
    };
    const client = createDesktopRelaySidecarClient({
      executablePath: process.execPath,
      executableArguments: [source],
      serverUrl: live.url,
      userId: "user-1",
      relayId: "relay-1",
      desktopSessionId: "desktop-1",
      capabilities: { profile: "desktop-agent", mcpTools: [] },
      mcpHost,
      onDispatch: async () => ({ status: "error", error: "wrong route" }),
    });
    const connecting = client.connect();
    const socket = await live.socket;
    await nextJson(socket);
    socket.send(JSON.stringify({
      type: "relay:registered",
      relayId: "relay-1",
      protocolVersion: RELAY_PROTOCOL_VERSION,
      selectedProtocolVersion: RELAY_PROTOCOL_VERSION,
      relaySessionId: "relay-session-1",
      pairingGenerationRef: "pairing-1",
    }));
    await connecting;
    socket.send(JSON.stringify({
      type: "relay:configure-mcp",
      servers: [{ name: "context7", transportKind: "stdio", transport: { command: "npx" } }],
    }));
    const advertised = await nextJson(socket);
    expect(advertised).toMatchObject({
      type: "relay:advertise-mcp-tools",
      serverName: "context7",
    });
    socket.send(JSON.stringify({
      type: "relay:dispatch",
      correlationId: "mcp-1",
      toolName: "context7__lookup",
      args: { q: "relay" },
      impact: "read-only",
      approvalObtained: false,
      hostedBy: "relay-1",
    }));
    expect(await nextJson(socket)).toMatchObject({
      type: "relay:result",
      correlationId: "mcp-1",
      status: "ok",
      result: { fromElectronMcp: true },
    });
    expect(dispatches).toEqual(["context7__lookup"]);
    await client.disconnect();
  }, 20_000);
});
