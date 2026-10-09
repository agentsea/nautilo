import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { FastifyInstance } from "fastify";
import {
  HEARTBEAT_TIMEOUT_MS,
  RELAY_PROTOCOL_VERSION,
  RELAY_TOKEN_AUTH_CLOSE_CODE,
  type RelayCapabilities,
} from "@nautilo/relay";
import { InMemoryRelayRegistry } from "@nautilo/runtime";
import { relayRoutes } from "../../src/realtime/relay-endpoint";
import {
  getRelayTokenStore,
  setRelayTokenStore,
  type RelayTokenStore,
} from "../../src/lib/relay-token-store";

interface CloseEvent {
  readonly code?: number;
  readonly reason?: string;
}

class FakeRelaySocket {
  readonly OPEN = 1;
  readyState = this.OPEN;
  readonly sent: unknown[] = [];
  readonly closes: CloseEvent[] = [];
  private readonly handlers = new Map<string, Array<(...args: unknown[]) => void>>();

  constructor(private readonly keepOpenAfterClose = false) {}

  on(event: string, handler: (...args: unknown[]) => void): this {
    const handlers = this.handlers.get(event) ?? [];
    handlers.push(handler);
    this.handlers.set(event, handlers);
    return this;
  }

  send(data: string): void {
    this.sent.push(JSON.parse(data));
  }

  close(code?: number, reason?: string): void {
    this.closes.push({
      ...(code !== undefined ? { code } : {}),
      ...(reason !== undefined ? { reason } : {}),
    });
    if (!this.keepOpenAfterClose) this.readyState = 3;
  }

  emitMessage(message: unknown): void {
    for (const handler of this.handlers.get("message") ?? []) {
      handler(JSON.stringify(message));
    }
  }

  emitClose(): void {
    this.readyState = 3;
    for (const handler of this.handlers.get("close") ?? []) handler();
  }
}

type RelayRouteHandler = (socket: FakeRelaySocket) => void;

function mountRelayRoute(registry: InMemoryRelayRegistry): RelayRouteHandler {
  let handler: RelayRouteHandler | undefined;
  const app = {
    get(_path: string, _options: unknown, routeHandler: RelayRouteHandler) {
      handler = routeHandler;
    },
  };
  relayRoutes(app as unknown as FastifyInstance, registry);
  if (!handler) throw new Error("relay route was not mounted");
  return handler;
}

function stubTokenStore(): void {
  const store: RelayTokenStore = {
    insertToken: async () => ({ id: "unused" }),
    pairForInstallation: async () => ({ id: "unused" }),
    findActiveByHash: async () => ({ id: "pairing-1", userId: "owner", actorId: "actor" }),
    withRegistrationAdmission: (_row, publish) => publish(),
    touchLastSeen: async () => {},
    listForUser: async () => [],
    revokeForUser: async () => false,
  };
  setRelayTokenStore(store);
}

const capabilities: RelayCapabilities = {
  profile: "desktop-agent",
  canRunShell: true,
};

function register(socket: FakeRelaySocket, relayId = "relay-1", caps = capabilities): void {
  socket.emitMessage({
    type: "relay:register",
    relayId,
    userId: "spoofed-owner",
    token: "rty_fixture",
    protocolVersion: RELAY_PROTOCOL_VERSION,
    capabilities: caps,
  });
}

async function waitForRegistration(socket: FakeRelaySocket): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt++) {
    if (socket.sent.some((message) =>
      (message as { type?: string }).type === "relay:registered"
    )) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
  throw new Error("relay registration did not complete");
}

describe("relay heartbeat recovery", () => {
  const originalTokenStore = getRelayTokenStore();
  const realNow = Date.now;
  let now = 10_000;

  beforeEach(() => {
    now = 10_000;
    Date.now = () => now;
    stubTokenStore();
  });

  afterEach(() => {
    Date.now = realNow;
    setRelayTokenStore(originalTokenStore);
  });

  test("a late heartbeat after stale eviction closes retryably and re-registration restores capability", async () => {
    const registry = new InMemoryRelayRegistry();
    const connect = mountRelayRoute(registry);
    const stale = new FakeRelaySocket();
    connect(stale);
    register(stale);
    await waitForRegistration(stale);
    expect(registry.findByCapabilityForUser("canRunShell", "owner")).toEqual(["relay-1"]);

    now += HEARTBEAT_TIMEOUT_MS + 1;
    (registry as unknown as { sweepStale(): void }).sweepStale();
    expect(registry.findByCapabilityForUser("canRunShell", "owner")).toEqual([]);

    stale.emitMessage({ type: "relay:heartbeat", relayId: "relay-1" });
    expect(stale.closes.at(-1)).toEqual({ code: 1012, reason: "Relay registration expired" });
    expect(stale.closes.at(-1)?.code).not.toBe(RELAY_TOKEN_AUTH_CLOSE_CODE);

    const replacement = new FakeRelaySocket();
    connect(replacement);
    register(replacement);
    await waitForRegistration(replacement);
    expect(registry.findByCapabilityForUser("canRunShell", "owner")).toEqual(["relay-1"]);
  });

  test("a healthy heartbeat refreshes the current connection", async () => {
    const registry = new InMemoryRelayRegistry();
    const connect = mountRelayRoute(registry);
    const socket = new FakeRelaySocket();
    connect(socket);
    register(socket);
    await waitForRegistration(socket);

    now += 1_000;
    socket.emitMessage({ type: "relay:heartbeat", relayId: "relay-1" });
    expect(registry.snapshotForUser("owner")[0]?.lastSeenAt).toBe(now);
    expect(socket.closes).toEqual([]);
  });

  test("a heartbeat naming another relay remains ignored", async () => {
    const registry = new InMemoryRelayRegistry();
    const connect = mountRelayRoute(registry);
    const socket = new FakeRelaySocket();
    connect(socket);
    register(socket);
    await waitForRegistration(socket);
    const registeredAt = registry.snapshotForUser("owner")[0]?.lastSeenAt;

    now += 1_000;
    socket.emitMessage({ type: "relay:heartbeat", relayId: "relay-other" });
    expect(registry.snapshotForUser("owner")[0]?.lastSeenAt).toBe(registeredAt);
    expect(socket.closes).toEqual([]);
  });

  test("an obsolete socket cannot refresh or unregister its replacement", async () => {
    const registry = new InMemoryRelayRegistry();
    const connect = mountRelayRoute(registry);
    // Preserve OPEN after close to model an event already queued during the
    // replacement close handshake; the endpoint must still generation-fence it.
    const obsolete = new FakeRelaySocket(true);
    connect(obsolete);
    register(obsolete);
    await waitForRegistration(obsolete);

    now += 1_000;
    const replacement = new FakeRelaySocket();
    connect(replacement);
    register(replacement, "relay-1", { profile: "desktop-agent", canReadWorkspace: true });
    await waitForRegistration(replacement);
    expect(obsolete.closes).toContainEqual({ code: 1000, reason: "Relay connection replaced" });
    const replacementRegisteredAt = registry.snapshotForUser("owner")[0]?.lastSeenAt;

    now += 1_000;
    obsolete.emitMessage({ type: "relay:heartbeat", relayId: "relay-1" });
    expect(obsolete.closes.at(-1)).toEqual({ code: 1012, reason: "Relay registration expired" });
    expect(registry.snapshotForUser("owner")[0]?.lastSeenAt).toBe(replacementRegisteredAt);
    expect(replacement.closes).toEqual([]);

    obsolete.emitClose();
    expect(registry.findByCapabilityForUser("canReadWorkspace", "owner")).toEqual(["relay-1"]);

    now += 1_000;
    replacement.emitMessage({ type: "relay:heartbeat", relayId: "relay-1" });
    expect(registry.snapshotForUser("owner")[0]?.lastSeenAt).toBe(now);
    expect(replacement.closes).toEqual([]);
  });
});
