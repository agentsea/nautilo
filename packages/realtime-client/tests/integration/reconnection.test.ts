/**
 * D059 Phase 2.4 — integration tests for createWsRealtimeClient's
 * reconnection + heartbeat behavior.
 *
 * Each test spins up a minimal Fastify + @fastify/websocket server that
 * speaks just enough of the protocol to drive the client: accept /ws,
 * respond to ping with pong, and let the test broadcast events or
 * forcibly close connections.
 */

import { describe, test, expect, afterEach } from "bun:test";
import Fastify, { type FastifyInstance } from "fastify";
import websocket from "@fastify/websocket";
import type { WebSocket as WsSocket, RawData } from "ws";
import { createWsRealtimeClient } from "../../src/ws-client";

function rawDataToString(data: RawData): string {
  if (typeof data === "string") return data;
  if (data instanceof Buffer) return data.toString("utf8");
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf8");
  if (Array.isArray(data)) return Buffer.concat(data).toString("utf8");
  return "";
}

// ---------- test server ----------------------------------------------------

interface TestServer {
  app: FastifyInstance;
  port: number;
  url: string;
  /** All currently-connected sockets. Tests can close them to simulate drop. */
  sockets: Set<WsSocket>;
  /** If true, the server ignores incoming pings. Used by heartbeat-timeout test. */
  silentMode: { value: boolean };
  /** Broadcast a parsed JSON payload to every connected client. */
  broadcast: (payload: unknown) => void;
  /** Force-close every socket. Client should reconnect. */
  dropAll: (code?: number) => void;
  close: () => Promise<void>;
}

async function startTestServer(port: number): Promise<TestServer> {
  const app = Fastify({ logger: false });
  await app.register(websocket);

  const sockets = new Set<WsSocket>();
  const silentMode = { value: false };

  app.get("/ws", { websocket: true }, (socket: WsSocket) => {
    // M058 — fixture mirrors the production handshake: track
    // per-socket auth state so the existing reconnection test's
    // `states` assertions stay valid (`connecting → authenticating
    // → open → closed`). Add the socket to the broadcast set ONLY
    // after `auth.accepted`, matching the production deferred-
    // addClient behavior.
    let authed = false;
    socket.on("message", (raw: RawData) => {
      if (silentMode.value) return;
      let parsed: unknown;
      try {
        parsed = JSON.parse(rawDataToString(raw));
      } catch {
        return;
      }
      if (typeof parsed !== "object" || parsed === null || !("type" in parsed)) {
        return;
      }
      const msgType = (parsed as { type?: unknown }).type;
      if (!authed) {
        if (msgType === "auth") {
          authed = true;
          sockets.add(socket);
          if (socket.readyState === socket.OPEN) {
            socket.send(JSON.stringify({ type: "auth.accepted" }));
          }
        }
        return;
      }
      if (msgType === "ping" && socket.readyState === socket.OPEN) {
        socket.send(JSON.stringify({ type: "pong", timestamp: Date.now() }));
      }
    });
    socket.on("close", () => {
      sockets.delete(socket);
    });
  });

  await app.listen({ port, host: "127.0.0.1" });

  return {
    app,
    port,
    url: `ws://127.0.0.1:${port}/ws`,
    sockets,
    silentMode,
    broadcast(payload: unknown) {
      const data = JSON.stringify(payload);
      for (const s of sockets) {
        if (s.readyState === s.OPEN) s.send(data);
      }
    },
    dropAll(code = 1000) {
      for (const s of sockets) {
        try { s.close(code); } catch { /* already closing */ }
      }
    },
    async close() {
      app.server.closeAllConnections();
      await app.close().catch(() => { /* best effort */ });
    },
  };
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 2_000,
  stepMs = 10,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await wait(stepMs);
  }
  throw new Error(`waitFor timed out after ${timeoutMs}ms`);
}

// ---------- fixtures -------------------------------------------------------

const activeServers: TestServer[] = [];
const activeClients: Array<{ close: () => void }> = [];
let nextPort = 19_100;

afterEach(async () => {
  for (const c of activeClients.splice(0)) c.close();
  await Promise.all(activeServers.splice(0).map((s) => s.close()));
});

function allocatePort(): number {
  return nextPort++;
}

// Small timings so tests run in ~1s, not 45s.
// M058 — `getToken` is required by all M058-aware servers; the
// fixture above accepts any non-empty string. Single source of truth
// for both timings + auth so test bodies stay declarative.
const fastTimings = {
  reconnectBaseMs: 50,
  reconnectMaxMs: 200,
  heartbeatIntervalMs: 100,
  heartbeatTimeoutMs: 300,
  getToken: () => "test-session-uuid",
};

// ---------- tests ----------------------------------------------------------

describe("createWsRealtimeClient reconnection", () => {
  test("connects, receives broadcast events", async () => {
    const port = allocatePort();
    const server = await startTestServer(port);
    activeServers.push(server);

    const events: unknown[] = [];
    const states: string[] = [];
    const client = createWsRealtimeClient(server.url, {
      onEvent: (e) => events.push(e),
      onStateChange: (s) => states.push(s),
      ...fastTimings,
    });
    activeClients.push(client);

    await waitFor(() => states.includes("open"));
    expect(states).toContain("connecting");
    expect(states).toContain("open");

    server.broadcast({ type: "message.tokens", content: "hello" });
    await waitFor(() => events.length > 0);
    expect(events[0]).toEqual({ type: "message.tokens", content: "hello" });
  });

  test("reconnects after server drops the connection", async () => {
    const port = allocatePort();
    const server = await startTestServer(port);
    activeServers.push(server);

    const states: string[] = [];
    const client = createWsRealtimeClient(server.url, {
      onEvent: () => { /* noop */ },
      onStateChange: (s) => states.push(s),
      ...fastTimings,
    });
    activeClients.push(client);

    await waitFor(() => states.includes("open"));
    const openCount1 = states.filter((s) => s === "open").length;
    expect(openCount1).toBe(1);

    server.dropAll();
    await waitFor(() => states.filter((s) => s === "open").length >= 2, 3_000);

    // Transitions: connecting → open → closed → connecting → open
    expect(states.filter((s) => s === "closed").length).toBeGreaterThanOrEqual(1);
    expect(states.filter((s) => s === "open").length).toBeGreaterThanOrEqual(2);
  });

  test("reconnects when server starts late", async () => {
    const port = allocatePort();
    // Don't start the server yet.
    const states: string[] = [];
    const errors: Error[] = [];
    const client = createWsRealtimeClient(`ws://127.0.0.1:${port}/ws`, {
      onEvent: () => { /* noop */ },
      onStateChange: (s) => states.push(s),
      onError: (e) => errors.push(e),
      ...fastTimings,
    });
    activeClients.push(client);

    // Client should attempt, fail, and keep retrying.
    await waitFor(() => states.filter((s) => s === "closed").length >= 2, 2_000);
    expect(errors.length).toBeGreaterThanOrEqual(1);

    // Now start the server. Client should connect on the next retry.
    const server = await startTestServer(port);
    activeServers.push(server);

    await waitFor(() => states.includes("open"), 2_000);
    expect(states).toContain("open");
  });

  test("heartbeat: ping/pong keeps the connection alive", async () => {
    const port = allocatePort();
    const server = await startTestServer(port);
    activeServers.push(server);

    const states: string[] = [];
    const client = createWsRealtimeClient(server.url, {
      onEvent: () => { /* noop */ },
      onStateChange: (s) => states.push(s),
      ...fastTimings,
    });
    activeClients.push(client);

    await waitFor(() => states.includes("open"));

    // Wait longer than heartbeatTimeoutMs — pong replies should keep us open.
    await wait(fastTimings.heartbeatTimeoutMs + 200);
    expect(states.filter((s) => s === "closed").length).toBe(0);
    expect(states.filter((s) => s === "open").length).toBe(1);
  });

  test("heartbeat timeout: silent server → client force-closes + reconnects", async () => {
    const port = allocatePort();
    const server = await startTestServer(port);
    activeServers.push(server);

    const states: string[] = [];
    const errors: Error[] = [];
    const client = createWsRealtimeClient(server.url, {
      onEvent: () => { /* noop */ },
      onStateChange: (s) => states.push(s),
      onError: (e) => errors.push(e),
      ...fastTimings,
    });
    activeClients.push(client);

    await waitFor(() => states.includes("open"));

    // Silence the server. Pings go out, no pong comes back.
    server.silentMode.value = true;

    // Wait long enough for the staleness detector to fire.
    await waitFor(
      () => states.filter((s) => s === "closed").length >= 1,
      fastTimings.heartbeatTimeoutMs + 1_000,
    );

    // onError should have been called with the staleness message.
    expect(errors.some((e) => e.message.includes("stale"))).toBe(true);

    // Un-silence the server — client should reconnect.
    server.silentMode.value = false;
    await waitFor(
      () => states.filter((s) => s === "open").length >= 2,
      2_000,
    );
  });

  test("clean close: no reconnection after .close()", async () => {
    const port = allocatePort();
    const server = await startTestServer(port);
    activeServers.push(server);

    const states: string[] = [];
    const client = createWsRealtimeClient(server.url, {
      onEvent: () => { /* noop */ },
      onStateChange: (s) => states.push(s),
      ...fastTimings,
    });

    await waitFor(() => states.includes("open"));
    client.close();

    // Give any misbehaving timers a chance to fire.
    await wait(fastTimings.reconnectMaxMs + 200);

    // Exactly one "closed" should have fired, and never a second "open".
    expect(states.filter((s) => s === "closed").length).toBeLessThanOrEqual(1);
    expect(states.filter((s) => s === "open").length).toBe(1);
  });

  test("reconnect cancellation: .close() during pending reconnect stops it", async () => {
    const port = allocatePort();
    // Server not started — first connect will fail and schedule reconnect.
    const states: string[] = [];
    const client = createWsRealtimeClient(`ws://127.0.0.1:${port}/ws`, {
      onEvent: () => { /* noop */ },
      onStateChange: (s) => states.push(s),
      // Long reconnect so we catch the pending timer window.
      reconnectBaseMs: 1_000,
      reconnectMaxMs: 2_000,
      heartbeatIntervalMs: 0, // disable heartbeat
    });

    // Wait for the first failed connect + schedule.
    await waitFor(() => states.includes("closed"));
    // Timer is pending (baseMs=1000). Close before it fires.
    client.close();

    // Start the server now. A cancelled reconnect should NOT pick this up.
    const server = await startTestServer(port);
    activeServers.push(server);

    await wait(2_500);
    expect(states.filter((s) => s === "open").length).toBe(0);
  });
});
