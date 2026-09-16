import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { RelayCapabilities } from "../../src/types";
import {
  RELAY_PROTOCOL_VERSION,
  projectRelayCapabilitiesForProtocol,
  type RelayUpdateCapabilitiesMessage,
} from "../../src/protocol";

const RS_OPEN = 1;
const RS_CLOSED = 3;

class MockRelayWebSocket {
  static OPEN = RS_OPEN;
  static CONNECTING = 0;
  static CLOSED = RS_CLOSED;

  readyState = MockRelayWebSocket.CONNECTING;
  sent: string[] = [];
  sendError: Error | null = null;
  private handlers = new Map<string, Array<(...args: unknown[]) => void>>();

  constructor(_url: string) {}

  on(event: string, handler: (...args: unknown[]) => void): this {
    const list = this.handlers.get(event) ?? [];
    list.push(handler);
    this.handlers.set(event, list);
    return this;
  }

  send(data: string): void {
    if (this.sendError !== null) throw this.sendError;
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

  triggerError(error = new Error("mock socket error")): void {
    for (const handler of this.handlers.get("error") ?? []) handler(error);
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

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

function updateFrames(ws: MockRelayWebSocket): RelayUpdateCapabilitiesMessage[] {
  return ws.sent
    .map((raw) => JSON.parse(raw) as { type: string })
    .filter((m) => m.type === "relay:update-capabilities") as RelayUpdateCapabilitiesMessage[];
}

function acknowledge(
  ws: MockRelayWebSocket,
  capabilityRevision: number,
  status: "ok" | "rejected" = "ok",
  relayId = "relay-1",
): void {
  ws.triggerMessage(JSON.stringify({
    type: "relay:capabilities-updated",
    relayId,
    capabilityRevision,
    status,
    ...(status === "rejected" ? { error: "rejected for test" } : {}),
  }));
}

const REGISTERED_V10 = JSON.stringify({
  type: "relay:registered",
  relayId: "relay-1",
  protocolVersion: 10,
});

function currentCapabilities(register: {
  capabilitiesByProtocolVersion?: Record<string, RelayCapabilities>;
}): RelayCapabilities {
  return register.capabilitiesByProtocolVersion?.[String(RELAY_PROTOCOL_VERSION)]
    ?? { profile: "desktop-agent" };
}

const CAPS: RelayCapabilities = { profile: "desktop-agent", canReadWorkspace: true };

async function connectClient(
  options: {
    desktopSessionId?: string;
    initialCapabilityRevision?: number;
    protocolVersion?: number;
    reconnectDelayMs?: number;
  },
): Promise<ReturnType<typeof createRelayClient>> {
  const client = createRelayClient({
    serverUrl: "http://127.0.0.1:9",
    userId: "user-1",
    relayId: "relay-1",
    capabilities: CAPS,
    ...(options.desktopSessionId !== undefined
      ? { desktopSessionId: options.desktopSessionId }
      : {}),
    ...(options.initialCapabilityRevision !== undefined
      ? { initialCapabilityRevision: options.initialCapabilityRevision }
      : {}),
    ...(options.reconnectDelayMs !== undefined
      ? { reconnectDelayMs: options.reconnectDelayMs }
      : {}),
    onDispatch: async () => ({ status: "ok" }),
  });
  const connectPromise = client.connect();
  const ws = created[created.length - 1]!;
  ws.triggerOpen();
  ws.triggerMessage(options.protocolVersion === undefined
    ? REGISTERED_V10
    : JSON.stringify({
        type: "relay:registered",
        relayId: "relay-1",
        protocolVersion: options.protocolVersion,
        selectedProtocolVersion: options.protocolVersion,
        relaySessionId: "relay-session-1",
        pairingGenerationRef: "pairing-1",
      }));
  await connectPromise;
  return client;
}

describe("createRelayClient updateCapabilities (D418 protocol v7)", () => {
  beforeEach(() => {
    created.length = 0;
  });

  afterEach(() => {});

  test("keeps Claude execution as an exact v18 Desktop-only capability", () => {
    expect(RELAY_PROTOCOL_VERSION).toBe(20);
    const execution: RelayCapabilities = {
      profile: "desktop-agent",
      claudeExecution: { version: 2 },
    };
    expect(projectRelayCapabilitiesForProtocol(execution, 17).claudeExecution).toBeUndefined();
    expect(projectRelayCapabilitiesForProtocol(execution, 18).claudeExecution).toEqual({ version: 2 });
    expect(projectRelayCapabilitiesForProtocol({
      profile: "device-relay",
      claudeExecution: { version: 2 },
    }, 18).claudeExecution).toBeUndefined();
    expect(projectRelayCapabilitiesForProtocol({
      profile: "desktop-agent",
      claudeExecution: { version: 1 } as never,
    }, 18).claudeExecution).toBeUndefined();
  });

  test("register carries desktopSessionId and the initial capability revision", async () => {
    const client = await connectClient({
      desktopSessionId: "session-1",
      initialCapabilityRevision: 0,
    });
    const ws = created[0]!;
    const register = JSON.parse(ws.sent[0]!) as {
      type: string;
      desktopSessionId?: string;
      capabilityRevision?: number;
      protocolVersion?: number;
      protocolRange?: { minimum: number; maximum: number };
      capabilities: RelayCapabilities;
      capabilitiesByProtocolVersion?: Record<string, RelayCapabilities>;
    };
    expect(register.type).toBe("relay:register");
    expect(register.desktopSessionId).toBe("session-1");
    expect(register.capabilityRevision).toBe(0);
    expect(register.protocolVersion).toBe(9);
    expect(register.protocolRange).toEqual({ minimum: 9, maximum: RELAY_PROTOCOL_VERSION });
    expect(register.capabilities.canReadWorkspace).toBeUndefined();
    expect(currentCapabilities(register).canReadWorkspace).toBe(true);
    await client.disconnect();
  });

  test("projects the register frame revision only after its registered acknowledgement", async () => {
    const client = createRelayClient({
      serverUrl: "http://127.0.0.1:9",
      userId: "user-1",
      relayId: "relay-1",
      capabilities: CAPS,
      desktopSessionId: "session-1",
      initialCapabilityRevision: 7,
      onDispatch: async () => ({ status: "ok" }),
    });
    const connecting = client.connect();
    const ws = created[created.length - 1]!;
    expect(client.getAcknowledgedCapabilityRevision()).toBeNull();
    ws.triggerOpen();
    expect(client.getAcknowledgedCapabilityRevision()).toBeNull();
    ws.triggerMessage(REGISTERED_V10);
    await connecting;
    expect(client.getAcknowledgedCapabilityRevision()).toBe(7);
    await client.disconnect();
  });

  test("ignores an early registered frame while the async capability builder is pending", async () => {
    let resolveCapabilities!: (capabilities: RelayCapabilities) => void;
    const client = createRelayClient({
      serverUrl: "http://127.0.0.1:9",
      userId: "user-1",
      relayId: "relay-1",
      capabilities: CAPS,
      desktopSessionId: "session-1",
      getCapabilities: () => new Promise<RelayCapabilities>((resolve) => {
        resolveCapabilities = resolve;
      }),
      onDispatch: async () => ({ status: "ok" }),
    });
    const connecting = client.connect();
    const ws = created[created.length - 1]!;
    ws.triggerOpen();
    await tick();
    ws.triggerMessage(REGISTERED_V10);
    expect(client.getAcknowledgedCapabilityRevision()).toBeNull();
    expect(client.getStatus()).toBe("connecting");

    resolveCapabilities(CAPS);
    await tick();
    expect(ws.sent).toHaveLength(1);
    ws.triggerMessage(REGISTERED_V10);
    await connecting;
    expect(client.getAcknowledgedCapabilityRevision()).toBe(0);
    await client.disconnect();
  });

  test("ignores a wrong-relay registration acknowledgement until the matching frame arrives", async () => {
    const client = createRelayClient({
      serverUrl: "http://127.0.0.1:9",
      userId: "user-1",
      relayId: "relay-1",
      capabilities: CAPS,
      desktopSessionId: "session-1",
      onDispatch: async () => ({ status: "ok" }),
    });
    const connecting = client.connect();
    const ws = created[created.length - 1]!;
    ws.triggerOpen();
    ws.triggerMessage(JSON.stringify({ type: "relay:registered", relayId: "another-relay" }));
    expect(client.getAcknowledgedCapabilityRevision()).toBeNull();
    expect(client.getStatus()).toBe("connecting");
    ws.triggerMessage(REGISTERED_V10);
    await connecting;
    expect(client.getAcknowledgedCapabilityRevision()).toBe(0);
    await client.disconnect();
  });

  test("a legacy v9 acknowledgement keeps capability updates filesystem-safe", async () => {
    const client = createRelayClient({
      serverUrl: "http://127.0.0.1:9",
      userId: "user-1",
      relayId: "relay-1",
      capabilities: CAPS,
      desktopSessionId: "session-1",
      onDispatch: async () => ({ status: "ok" }),
    });
    const connectPromise = client.connect();
    const ws = created[created.length - 1]!;
    ws.triggerOpen();
    ws.triggerMessage(JSON.stringify({ type: "relay:registered", relayId: "relay-1" }));
    await connectPromise;

    const done = client.updateCapabilities({
      profile: "desktop-agent",
      canReadWorkspace: true,
      canWriteWorkspace: true,
      canRunShell: true,
      workspaceRoot: "/Users/test/Nautilo",
    });
    await tick();
    const frame = updateFrames(ws)[0]!;
    expect(frame.capabilities.canRunShell).toBe(true);
    expect(frame.capabilities.canReadWorkspace).toBeUndefined();
    expect(frame.capabilities.canWriteWorkspace).toBeUndefined();
    expect(frame.capabilities.workspaceRoot).toBeUndefined();
    ws.triggerMessage(JSON.stringify({
      type: "relay:capabilities-updated",
      relayId: "relay-1",
      capabilityRevision: 1,
      status: "ok",
    }));
    await done;
    await client.disconnect();
  });

  test("sends one update frame and resolves on the matching ack", async () => {
    const client = await connectClient({ desktopSessionId: "session-1", protocolVersion: RELAY_PROTOCOL_VERSION });
    const ws = created[0]!;

    const done = client.updateCapabilities({
      profile: "desktop-agent",
      canReadWorkspace: false,
    });
    await tick();
    const frames = updateFrames(ws);
    expect(frames).toHaveLength(1);
    expect(frames[0]!.capabilityRevision).toBe(1);
    expect(frames[0]!.desktopSessionId).toBe("session-1");
    expect(frames[0]!.capabilities.canReadWorkspace).toBe(false);
    // Sending revision 1 must not expose it as server-accepted before ack.
    expect(client.getAcknowledgedCapabilityRevision()).toBe(0);

    ws.triggerMessage(
      JSON.stringify({
        type: "relay:capabilities-updated",
        relayId: "relay-1",
        capabilityRevision: 1,
        status: "ok",
      }),
    );
    await done;
    expect(client.getAcknowledgedCapabilityRevision()).toBe(1);
    expect(client.getDesktopTopology()?.capabilityRevision).toBe(1);
    await client.disconnect();
  });

  test("ignores a duplicate registered frame after a later accepted capability update", async () => {
    const client = await connectClient({ desktopSessionId: "session-1" });
    const ws = created[0]!;
    const update = client.updateCapabilities({ profile: "desktop-agent", canReadWorkspace: false });
    await tick();
    acknowledge(ws, 1);
    await update;
    expect(client.getAcknowledgedCapabilityRevision()).toBe(1);
    ws.triggerMessage(REGISTERED_V10);
    expect(client.getAcknowledgedCapabilityRevision()).toBe(1);
    await client.disconnect();
  });

  test("preserves the strictly redacted Computer use snapshot on capability updates", async () => {
    const client = await connectClient({ desktopSessionId: "session-1", protocolVersion: RELAY_PROTOCOL_VERSION });
    const ws = created[0]!;
    const done = client.updateCapabilities({
      profile: "desktop-agent",
      desktopAutomation: {
        enabled: true,
        agentId: "agent-1",
        installationEpoch: "epoch-1",
        grantGeneration: 7,
        provider: "cua",
        providerGeneration: "provider-generation-1",
      },
    });
    await tick();
    const snapshot = updateFrames(ws)[0]!.capabilities.desktopAutomation;
    expect(snapshot).toEqual({
      enabled: true,
      agentId: "agent-1",
      installationEpoch: "epoch-1",
      grantGeneration: 7,
      provider: "cua",
      providerGeneration: "provider-generation-1",
    });
    expect(Object.keys(snapshot ?? {}).sort()).toEqual([
      "agentId", "enabled", "grantGeneration", "installationEpoch", "provider", "providerGeneration",
    ]);
    ws.triggerMessage(JSON.stringify({
      type: "relay:capabilities-updated", relayId: "relay-1", capabilityRevision: 1, status: "ok",
    }));
    await done;
    await client.disconnect();
  });

  test("serializes and coalesces concurrent updates — only the latest full capabilities is sent", async () => {
    const client = await connectClient({ desktopSessionId: "session-1" });
    const ws = created[0]!;

    // First update is in flight (awaiting its ack).
    const update1 = client.updateCapabilities({
      profile: "desktop-agent",
      canReadWorkspace: true,
    });
    await tick();
    expect(updateFrames(ws)).toHaveLength(1);

    // Queue two more while update1 is in flight. Neither should be sent yet.
    const update2 = client.updateCapabilities({
      profile: "desktop-agent",
      canReadWorkspace: false,
      canWriteWorkspace: true,
    });
    const update3 = client.updateCapabilities({
      profile: "desktop-agent",
      canReadWorkspace: false,
      canWriteWorkspace: false,
    });
    await tick();
    expect(updateFrames(ws)).toHaveLength(1); // still only the in-flight frame

    // Ack update1. The pump drains [update2, update3] and sends ONLY update3
    // (the latest full capabilities) — never a merge of update2 + update3.
    ws.triggerMessage(
      JSON.stringify({
        type: "relay:capabilities-updated",
        relayId: "relay-1",
        capabilityRevision: 1,
        status: "ok",
      }),
    );
    await update1;
    expect(client.getAcknowledgedCapabilityRevision()).toBe(1);
    await tick();
    const frames = updateFrames(ws);
    expect(frames).toHaveLength(2);
    expect(frames[1]!.capabilityRevision).toBe(2);
    expect(frames[1]!.capabilities.canReadWorkspace).toBe(false);
    expect(frames[1]!.capabilities.canWriteWorkspace).toBe(false);

    // Ack the coalesced frame; both concurrent promises resolve.
    ws.triggerMessage(
      JSON.stringify({
        type: "relay:capabilities-updated",
        relayId: "relay-1",
        capabilityRevision: 2,
        status: "ok",
      }),
    );
    await Promise.all([update2, update3]);
    expect(client.getAcknowledgedCapabilityRevision()).toBe(2);
    await client.disconnect();
  });

  test("rejects the caller when the server rejects the update", async () => {
    const client = await connectClient({ desktopSessionId: "session-1" });
    const ws = created[0]!;
    const done = client.updateCapabilities({ profile: "desktop-agent" });
    await tick();
    ws.triggerMessage(
      JSON.stringify({
        type: "relay:capabilities-updated",
        relayId: "relay-1",
        capabilityRevision: 1,
        status: "rejected",
        error: "stale or duplicate capability revision",
      }),
    );
    const rejection = await done.then(
      () => null,
      (error: unknown) => error,
    );
    expect(rejection).toBeInstanceOf(Error);
    expect((rejection as Error).message).toMatch(/stale or duplicate capability revision/);
    expect(client.getAcknowledgedCapabilityRevision()).toBe(0);
    await client.disconnect();
  });

  test("keeps the accepted revision exact across a rejected issued-revision gap", async () => {
    const client = await connectClient({ desktopSessionId: "session-1" });
    const ws = created[0]!;

    const rejected = client.updateCapabilities({ profile: "desktop-agent", canReadWorkspace: false });
    await tick();
    expect(updateFrames(ws)[0]!.capabilityRevision).toBe(1);
    acknowledge(ws, 1, "rejected");
    const rejection = await rejected.then(
      () => null,
      (error: unknown) => error,
    );
    expect(rejection).toBeInstanceOf(Error);
    expect((rejection as Error).message).toMatch(/rejected for test/);
    expect(client.getAcknowledgedCapabilityRevision()).toBe(0);

    const accepted = client.updateCapabilities({ profile: "desktop-agent", canReadWorkspace: true });
    await tick();
    expect(updateFrames(ws)[1]!.capabilityRevision).toBe(2);
    expect(client.getAcknowledgedCapabilityRevision()).toBe(0);
    acknowledge(ws, 2);
    await accepted;
    expect(client.getAcknowledgedCapabilityRevision()).toBe(2);
    await client.disconnect();
  });

  test("ignores stray, relay-mismatched, and stale-socket capability acknowledgements", async () => {
    const originalRandom = Math.random;
    Math.random = () => 0;
    try {
      const client = await connectClient({ desktopSessionId: "session-1", reconnectDelayMs: 0 });
      const ws1 = created[0]!;
      const update = client.updateCapabilities({ profile: "desktop-agent", canReadWorkspace: false });
      await tick();
      acknowledge(ws1, 1, "ok", "another-relay");
      acknowledge(ws1, 9);
      expect(client.getAcknowledgedCapabilityRevision()).toBe(0);

      // The only matching acknowledgement advances the accepted projection.
      acknowledge(ws1, 1);
      await update;
      expect(client.getAcknowledgedCapabilityRevision()).toBe(1);

      ws1.close();
      expect(client.getAcknowledgedCapabilityRevision()).toBeNull();
      await tick();
      const ws2 = created[1]!;
      ws2.triggerOpen();
      await tick();
      ws2.triggerMessage(REGISTERED_V10);
      await tick();
      expect(client.getAcknowledgedCapabilityRevision()).toBe(1);

      // Buffered frames from the old generation cannot mutate the replacement.
      ws1.triggerMessage(REGISTERED_V10);
      const update2 = client.updateCapabilities({ profile: "desktop-agent", canReadWorkspace: true });
      await tick();
      expect(updateFrames(ws2)[0]!.capabilityRevision).toBe(2);
      let update2Settled = false;
      void update2.then(() => { update2Settled = true; });
      acknowledge(ws1, 2);
      await tick();
      expect(client.getAcknowledgedCapabilityRevision()).toBe(1);
      expect(update2Settled).toBeFalse();
      acknowledge(ws2, 2);
      await update2;
      expect(client.getAcknowledgedCapabilityRevision()).toBe(2);
      await client.disconnect();
    } finally {
      Math.random = originalRandom;
    }
  });

  test("is a no-op for headless relays with no desktop session", async () => {
    const client = await connectClient({});
    const ws = created[0]!;
    const register = JSON.parse(ws.sent[0]!) as { desktopSessionId?: string };
    expect(register.desktopSessionId).toBeUndefined();
    // Resolves immediately without sending any update frame.
    await client.updateCapabilities({ profile: "device-relay", canRunShell: true });
    expect(updateFrames(ws)).toHaveLength(0);
    expect(client.getAcknowledgedCapabilityRevision()).toBeNull();
    await client.disconnect();
  });

  test("clears acknowledged state on disconnect and establishes the reconnect baseline", async () => {
    const originalRandom = Math.random;
    Math.random = () => 0;
    try {
      const client = await connectClient({ desktopSessionId: "session-1", reconnectDelayMs: 0 });
      const ws1 = created[0]!;
      const update = client.updateCapabilities({ profile: "desktop-agent", canReadWorkspace: false });
      await tick();
      acknowledge(ws1, 1);
      await update;
      expect(client.getAcknowledgedCapabilityRevision()).toBe(1);

      ws1.close();
      expect(client.getAcknowledgedCapabilityRevision()).toBeNull();
      await tick();
      const ws2 = created[1]!;
      ws2.triggerOpen();
      await tick();
      const register = JSON.parse(ws2.sent[0]!) as { capabilityRevision: number };
      expect(register.capabilityRevision).toBe(1);
      expect(client.getAcknowledgedCapabilityRevision()).toBeNull();
      ws2.triggerMessage(REGISTERED_V10);
      await tick();
      expect(client.getAcknowledgedCapabilityRevision()).toBe(1);
      await client.disconnect();
      expect(client.getAcknowledgedCapabilityRevision()).toBeNull();
    } finally {
      Math.random = originalRandom;
    }
  });

  test("does not let a stale socket close or error tear down a replacement connection", async () => {
    const client = createRelayClient({
      serverUrl: "http://127.0.0.1:9",
      userId: "user-1",
      relayId: "relay-1",
      capabilities: CAPS,
      desktopSessionId: "session-1",
      onDispatch: async () => ({ status: "ok" }),
    });
    const firstConnect = client.connect().then(
      () => null,
      (error: unknown) => error,
    );
    const ws1 = created[0]!;
    ws1.triggerOpen();
    const replacementConnect = client.connect();
    const ws2 = created[1]!;
    ws2.triggerOpen();
    ws2.triggerMessage(REGISTERED_V10);
    await replacementConnect;
    expect(client.getStatus()).toBe("connected");
    expect(client.getAcknowledgedCapabilityRevision()).toBe(0);

    ws1.triggerError();
    expect(await firstConnect).toBeInstanceOf(Error);
    ws1.close();
    expect(client.getStatus()).toBe("connected");
    expect(client.getAcknowledgedCapabilityRevision()).toBe(0);
    await client.disconnect();
  });

  test("rejects a connect attempt when synchronous register send throws and reconnects once", async () => {
    const originalRandom = Math.random;
    Math.random = () => 0;
    try {
      const client = createRelayClient({
        serverUrl: "http://127.0.0.1:9",
        userId: "user-1",
        relayId: "relay-1",
        capabilities: CAPS,
        desktopSessionId: "session-1",
        reconnectDelayMs: 0,
        onDispatch: async () => ({ status: "ok" }),
      });
      const connecting = client.connect();
      const ws1 = created[0]!;
      ws1.sendError = new Error("register send failed");
      ws1.triggerOpen();
      const rejection = await connecting.then(
        () => null,
        (error: unknown) => error,
      );
      expect(rejection).toBeInstanceOf(Error);
      expect((rejection as Error).message).toMatch(/register send failed/);
      await tick();
      expect(created).toHaveLength(2);
      await client.disconnect();
    } finally {
      Math.random = originalRandom;
    }
  });

  test("rejects when the relay is not connected", async () => {
    const client = createRelayClient({
      serverUrl: "http://127.0.0.1:9",
      userId: "user-1",
      relayId: "relay-1",
      capabilities: CAPS,
      desktopSessionId: "session-1",
      onDispatch: async () => ({ status: "ok" }),
    });
    const rejection = await Promise.resolve(client.updateCapabilities(CAPS)).then(
      () => null,
      (error: unknown) => error,
    );
    expect(rejection).toBeInstanceOf(Error);
    expect((rejection as Error).message).toMatch(/not connected/);
  });
});

describe("createRelayClient register re-advertises CURRENT capabilities (D418 reconnect fix)", () => {
  beforeEach(() => {
    created.length = 0;
  });

  afterEach(() => {});

  test("register advertises the dynamic getCapabilities value, not the frozen static value", async () => {
    const dynamicCaps: RelayCapabilities = {
      profile: "desktop-agent",
      canReadWorkspace: true,
      canRunShell: true,
    };
    const client = createRelayClient({
      serverUrl: "http://127.0.0.1:9",
      userId: "user-1",
      relayId: "relay-1",
      // Frozen static value — must NOT be what the register frame carries.
      capabilities: { profile: "desktop-agent", canReadWorkspace: false },
      desktopSessionId: "session-1",
      getCapabilities: () => dynamicCaps,
      onDispatch: async () => ({ status: "ok" }),
    });
    const connectPromise = client.connect();
    const ws = created[created.length - 1]!;
    ws.triggerOpen();
    // The open handler awaits getCapabilities before sending register.
    await tick();
    const register = JSON.parse(ws.sent[0]!) as {
      type: string;
      capabilities: RelayCapabilities;
      capabilitiesByProtocolVersion?: Record<string, RelayCapabilities>;
    };
    expect(register.type).toBe("relay:register");
    expect(register.capabilities.canReadWorkspace).toBeUndefined();
    expect(register.capabilities.canRunShell).toBe(true);
    expect(currentCapabilities(register).canReadWorkspace).toBe(true);
    expect(currentCapabilities(register).canRunShell).toBe(true);
    ws.triggerMessage(REGISTERED_V10);
    await connectPromise;
    await client.disconnect();
  });

  test("getCapabilities may be async (Promise) — register awaits it", async () => {
    const dynamicCaps: RelayCapabilities = {
      profile: "desktop-agent",
      canReadWorkspace: true,
    };
    const client = createRelayClient({
      serverUrl: "http://127.0.0.1:9",
      userId: "user-1",
      relayId: "relay-1",
      capabilities: { profile: "desktop-agent", canReadWorkspace: false },
      desktopSessionId: "session-1",
      getCapabilities: async () => dynamicCaps,
      onDispatch: async () => ({ status: "ok" }),
    });
    const connectPromise = client.connect();
    const ws = created[created.length - 1]!;
    ws.triggerOpen();
    await tick();
    const register = JSON.parse(ws.sent[0]!) as {
      capabilities: RelayCapabilities;
      capabilitiesByProtocolVersion?: Record<string, RelayCapabilities>;
    };
    expect(register.capabilities.canReadWorkspace).toBeUndefined();
    expect(currentCapabilities(register).canReadWorkspace).toBe(true);
    ws.triggerMessage(REGISTERED_V10);
    await connectPromise;
    await client.disconnect();
  });

  test("a throwing getCapabilities falls back to the static capabilities so registration proceeds", async () => {
    const client = createRelayClient({
      serverUrl: "http://127.0.0.1:9",
      userId: "user-1",
      relayId: "relay-1",
      capabilities: { profile: "desktop-agent", canReadWorkspace: false },
      desktopSessionId: "session-1",
      getCapabilities: () => {
        throw new Error("builder unavailable");
      },
      onDispatch: async () => ({ status: "ok" }),
    });
    const connectPromise = client.connect();
    const ws = created[created.length - 1]!;
    ws.triggerOpen();
    await tick();
    const register = JSON.parse(ws.sent[0]!) as {
      type: string;
      capabilities: RelayCapabilities;
      capabilitiesByProtocolVersion?: Record<string, RelayCapabilities>;
    };
    expect(register.type).toBe("relay:register");
    // Fallback to the frozen static value (canReadWorkspace: false).
    expect(register.capabilities.canReadWorkspace).toBeUndefined();
    expect(currentCapabilities(register).canReadWorkspace).toBe(false);
    ws.triggerMessage(REGISTERED_V10);
    await connectPromise;
    await client.disconnect();
  });

  test("reconnect re-registers the CURRENT capabilities from getCapabilities, not the frozen initial value", async () => {
    // Deterministic reconnect timing: zero base delay + zero jitter → the
    // reconnect timer fires on the next macrotask.
    const originalRandom = Math.random;
    Math.random = () => 0;
    let dynamicCaps: RelayCapabilities = {
      profile: "desktop-agent",
      canReadWorkspace: true,
      canRunShell: true,
    };
    try {
      const client = createRelayClient({
        serverUrl: "http://127.0.0.1:9",
        userId: "user-1",
        relayId: "relay-1",
        // Frozen pre-activation capabilities (no profile snapshot). The
        // split-brain bug would re-register THIS on reconnect.
        capabilities: { profile: "desktop-agent", canReadWorkspace: false },
        desktopSessionId: "session-1",
        reconnectDelayMs: 0,
        getCapabilities: () => dynamicCaps,
        onDispatch: async () => ({ status: "ok" }),
      });
      const connectPromise = client.connect();
      const ws1 = created[created.length - 1]!;
      ws1.triggerOpen();
      await tick();
      const register1 = JSON.parse(ws1.sent[0]!) as {
        capabilities: RelayCapabilities;
        capabilitiesByProtocolVersion?: Record<string, RelayCapabilities>;
      };
      expect(currentCapabilities(register1).canReadWorkspace).toBe(true);
      ws1.triggerMessage(REGISTERED_V10);
      await connectPromise;

      // Simulate post-activation state: the dynamic capabilities now carry
      // an advisory Workstation Profile binding snapshot. A reconnect must
      // re-advertise THIS, not the frozen pre-activation value.
      dynamicCaps = {
        profile: "desktop-agent",
        canReadWorkspace: true,
        canRunShell: true,
        workstationProfileSnapshot: {
          profileId: "profile-A",
          profileRevision: 1,
          grantIds: ["grant-1"],
          protectedPolicyVersion: 1,
          networkMode: "isolated",
          capabilities: [],
        },
      } as unknown as RelayCapabilities;

      // Drop the socket and let the client reconnect (delay 0).
      ws1.close();
      await tick(); // reconnect timer fires → connectInternal → new WebSocket
      const ws2 = created[created.length - 1]!;
      expect(ws2).not.toBe(ws1);
      ws2.triggerOpen();
      await tick(); // async open handler awaits getCapabilities + sends register
      const register2 = JSON.parse(ws2.sent[0]!) as {
        type: string;
        capabilities: RelayCapabilities & { workstationProfileSnapshot?: unknown };
        capabilitiesByProtocolVersion?: Record<string, RelayCapabilities>;
      };
      expect(register2.type).toBe("relay:register");
      // The reconnect re-advertised the CURRENT (post-activation)
      // capabilities — canReadWorkspace true + profile snapshot present —
      // NOT the frozen pre-activation value (canReadWorkspace: false, no
      // snapshot). This is the split-brain fix: the server relay registry's
      // profile snapshot is not overwritten with null on reconnect.
      expect(currentCapabilities(register2).canReadWorkspace).toBe(true);
      expect(currentCapabilities(register2).workstationProfileSnapshot).toBeDefined();
      ws2.triggerMessage(REGISTERED_V10);
      await tick();
      await client.disconnect();
    } finally {
      Math.random = originalRandom;
    }
  });

  test("does not let a stale async capability builder register through its replacement socket", async () => {
    const originalRandom = Math.random;
    Math.random = () => 0;
    const capabilityResolvers: Array<(capabilities: RelayCapabilities) => void> = [];
    try {
      const client = createRelayClient({
        serverUrl: "http://127.0.0.1:9",
        userId: "user-1",
        relayId: "relay-1",
        capabilities: CAPS,
        desktopSessionId: "session-1",
        reconnectDelayMs: 0,
        getCapabilities: () => new Promise<RelayCapabilities>((resolve) => {
          capabilityResolvers.push(resolve);
        }),
        onDispatch: async () => ({ status: "ok" }),
      });
      const firstConnect = client.connect().catch(() => undefined);
      const ws1 = created[0]!;
      ws1.triggerOpen();
      await tick();
      expect(capabilityResolvers).toHaveLength(1);

      ws1.close();
      await firstConnect;
      await tick();
      const ws2 = created[1]!;
      ws2.triggerOpen();
      await tick();
      expect(capabilityResolvers).toHaveLength(2);

      capabilityResolvers[0]!(CAPS);
      await tick();
      expect(ws1.sent).toHaveLength(0);
      expect(ws2.sent).toHaveLength(0);

      capabilityResolvers[1]!(CAPS);
      await tick();
      expect(ws2.sent).toHaveLength(1);
      expect((JSON.parse(ws2.sent[0]!) as { type: string }).type).toBe("relay:register");
      ws2.triggerMessage(REGISTERED_V10);
      await tick();
      await client.disconnect();
    } finally {
      Math.random = originalRandom;
    }
  });
});
