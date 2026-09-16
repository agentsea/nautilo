import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  createRelayClient,
  RELAY_PROTOCOL_VERSION,
  type RelayCapabilities,
  type RelayClient,
  type RelayClientOptions,
} from "@nautilo/relay";
import { WebSocketServer, type WebSocket } from "ws";

import { createDesktopRelaySidecarClient } from "../../../apps/desktop/electron/relay-sidecar-client.ts";

type LifecycleSample = Readonly<{
  connectMs: number;
  capabilityUpdateMs: number;
  dispatchRoundTripMs: readonly number[];
  reconnectMs: number;
  disconnectMs: number;
}>;

type Summary = Readonly<{
  count: number;
  minMs: number;
  medianMs: number;
  p95Ms: number;
  maxMs: number;
}>;

const repositoryRoot = fileURLToPath(new URL("../../..", import.meta.url));
const hostSource = resolve(repositoryRoot, "bin/nautilo-relay/src/desktop-host-main.ts");
const resultPath = resolve(repositoryRoot, "dev/qualification/fixtures/d565-relay-sidecar-benchmark-results.json");
const sampleCount = positiveInteger(process.argv[2] ?? "12", "sample count");
const dispatchRounds = positiveInteger(process.argv[3] ?? "100", "dispatch rounds");

function positiveInteger(raw: string, name: string): number {
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
  return value;
}

function rounded(value: number): number {
  return Number(value.toFixed(3));
}

function summarize(values: readonly number[]): Summary {
  const sorted = [...values].sort((left, right) => left - right);
  return {
    count: sorted.length,
    minMs: rounded(sorted[0]!),
    medianMs: rounded(sorted[Math.floor((sorted.length - 1) / 2)]!),
    p95Ms: rounded(sorted[Math.ceil(sorted.length * 0.95) - 1]!),
    maxMs: rounded(sorted.at(-1)!),
  };
}

function nextJson(socket: WebSocket): Promise<Record<string, unknown>> {
  return new Promise((resolveMessage, rejectMessage) => {
    socket.once("message", (data) => {
      try {
        const bytes = Array.isArray(data)
          ? Buffer.concat(data)
          : data instanceof ArrayBuffer
            ? Buffer.from(data)
            : Buffer.from(data as never);
        resolveMessage(JSON.parse(bytes.toString("utf8")) as Record<string, unknown>);
      } catch (error) {
        rejectMessage(error instanceof Error ? error : new Error(String(error)));
      }
    });
  });
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  while (!predicate()) await new Promise((resolveWait) => setTimeout(resolveWait, 1));
}

function acknowledgeRegistration(socket: WebSocket, relaySessionId: string): void {
  socket.send(JSON.stringify({
    type: "relay:registered",
    relayId: "relay-benchmark",
    protocolVersion: RELAY_PROTOCOL_VERSION,
    selectedProtocolVersion: RELAY_PROTOCOL_VERSION,
    relaySessionId,
    pairingGenerationRef: `${relaySessionId}-pairing`,
  }));
}

async function createServer(): Promise<{ server: WebSocketServer; url: string }> {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise<void>((resolveListening) => server.once("listening", resolveListening));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("benchmark server address unavailable");
  return { server, url: `http://127.0.0.1:${address.port}` };
}

function nextConnection(server: WebSocketServer): Promise<WebSocket> {
  return new Promise((resolveSocket) => server.once("connection", resolveSocket));
}

function commonOptions(serverUrl: string): RelayClientOptions {
  return {
    serverUrl,
    userId: "user-benchmark",
    relayId: "relay-benchmark",
    desktopSessionId: "desktop-benchmark",
    heartbeatIntervalMs: 3_600_000,
    capabilities: { profile: "desktop-agent", canRunShell: true },
    onDispatch: (request) => Promise.resolve({
      status: "ok",
      result: { sequence: (request.args as { sequence?: unknown }).sequence },
    }),
  };
}

function createClient(kind: "direct" | "sidecar", serverUrl: string): RelayClient {
  const options = commonOptions(serverUrl);
  if (kind === "direct") return createRelayClient(options);
  return createDesktopRelaySidecarClient({
    ...options,
    executablePath: process.execPath,
    executableArguments: [hostSource],
  });
}

async function sample(kind: "direct" | "sidecar"): Promise<LifecycleSample> {
  const { server, url } = await createServer();
  const client = createClient(kind, url);
  let activeSocket: WebSocket | null = null;
  try {
    const initialConnection = nextConnection(server);
    const connectStarted = performance.now();
    const connected = client.connect();
    activeSocket = await initialConnection;
    const register = await nextJson(activeSocket);
    if (register["type"] !== "relay:register") throw new Error("initial registration missing");
    acknowledgeRegistration(activeSocket, "relay-session-1");
    await connected;
    const connectMs = performance.now() - connectStarted;

    const updatedCapabilities: RelayCapabilities = {
      profile: "desktop-agent",
      canRunShell: true,
      canUseTerminal: true,
    };
    const capabilityStarted = performance.now();
    const updated = client.updateCapabilities(updatedCapabilities);
    const update = await nextJson(activeSocket);
    if (update["type"] !== "relay:update-capabilities" || update["capabilityRevision"] !== 1) {
      throw new Error("capability update missing");
    }
    activeSocket.send(JSON.stringify({
      type: "relay:capabilities-updated",
      relayId: "relay-benchmark",
      capabilityRevision: 1,
      status: "ok",
    }));
    await updated;
    const capabilityUpdateMs = performance.now() - capabilityStarted;

    const dispatchRoundTripMs: number[] = [];
    for (let sequence = 0; sequence < dispatchRounds; sequence += 1) {
      const dispatchStarted = performance.now();
      activeSocket.send(JSON.stringify({
        type: "relay:dispatch",
        correlationId: `dispatch-${sequence}`,
        toolName: "benchmark_tool",
        args: { sequence },
        timeout: 1_000,
        impact: "low",
        approvalObtained: true,
        executionClass: "desktop",
      }));
      const result = await nextJson(activeSocket);
      if (result["type"] !== "relay:result" || result["correlationId"] !== `dispatch-${sequence}`) {
        throw new Error(`dispatch ${sequence} returned the wrong result`);
      }
      dispatchRoundTripMs.push(rounded(performance.now() - dispatchStarted));
    }

    const replacementConnection = nextConnection(server);
    const reconnectStarted = performance.now();
    activeSocket.terminate();
    activeSocket = await replacementConnection;
    const reconnectRegister = await nextJson(activeSocket);
    if (reconnectRegister["type"] !== "relay:register") throw new Error("reconnect registration missing");
    acknowledgeRegistration(activeSocket, "relay-session-2");
    await waitUntil(() => client.getDesktopTopology()?.relaySessionId === "relay-session-2");
    const reconnectMs = performance.now() - reconnectStarted;

    const disconnectStarted = performance.now();
    await client.disconnect();
    const disconnectMs = performance.now() - disconnectStarted;

    return {
      connectMs: rounded(connectMs),
      capabilityUpdateMs: rounded(capabilityUpdateMs),
      dispatchRoundTripMs,
      reconnectMs: rounded(reconnectMs),
      disconnectMs: rounded(disconnectMs),
    };
  } finally {
    await client.disconnect().catch(() => undefined);
    activeSocket?.terminate();
    for (const socket of server.clients) socket.terminate();
    await new Promise((resolveTurn) => setImmediate(resolveTurn));
    server.close();
    await new Promise((resolveTurn) => setTimeout(resolveTurn, 5));
  }
}

async function run(kind: "direct" | "sidecar"): Promise<readonly LifecycleSample[]> {
  const samples: LifecycleSample[] = [];
  for (let index = 0; index < sampleCount; index += 1) {
    samples.push(await sample(kind));
    console.error(`${kind} sample ${index + 1}/${sampleCount}`);
  }
  return samples;
}

function aggregate(samples: readonly LifecycleSample[]): Record<string, Summary> {
  return {
    connect: summarize(samples.map((entry) => entry.connectMs)),
    capabilityUpdate: summarize(samples.map((entry) => entry.capabilityUpdateMs)),
    dispatchRoundTrip: summarize(samples.flatMap((entry) => entry.dispatchRoundTripMs)),
    reconnect: summarize(samples.map((entry) => entry.reconnectMs)),
    disconnect: summarize(samples.map((entry) => entry.disconnectMs)),
  };
}

const direct = await run("direct");
const sidecar = await run("sidecar");
const output = {
  artifactKind: "qualification-benchmark",
  schemaVersion: 1,
  candidateSha: execFileSync("git", ["rev-parse", "HEAD"], { cwd: repositoryRoot, encoding: "utf8" }).trim(),
  runtime: { bun: process.versions["bun"] ?? null, platform: process.platform, architecture: process.arch },
  fixture: {
    sampleCount,
    dispatchRoundsPerSample: dispatchRounds,
    relayServer: "loopback WebSocketServer with immediate acknowledgements",
    handler: "immediate deterministic result through identical Relay dispatch frames",
    comparison: "direct in-process RelayClient versus DesktopRelaySidecarClient plus Bun child",
  },
  direct: { summary: aggregate(direct), raw: direct },
  sidecar: { summary: aggregate(sidecar), raw: sidecar },
};

writeFileSync(resultPath, `${JSON.stringify(output, null, 2)}\n`, { encoding: "utf8", mode: 0o644 });
console.log(JSON.stringify({ resultPath, direct: output.direct.summary, sidecar: output.sidecar.summary }, null, 2));
