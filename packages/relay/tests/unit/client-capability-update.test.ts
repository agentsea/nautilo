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
    capabilities?: RelayCapabilities;
    runShellOwnerInstanceId?: string;
    onDispatch?: (request: import("../../src/protocol").RelayDispatchRequest) => Promise<import("../../src/protocol").RelayDispatchResult>;
  },
): Promise<ReturnType<typeof createRelayClient>> {
  const client = createRelayClient({
    serverUrl: "http://127.0.0.1:9",
    userId: "user-1",
    relayId: "relay-1",
    capabilities: options.capabilities ?? CAPS,
    ...(options.runShellOwnerInstanceId !== undefined
      ? { runShellOwnerInstanceId: options.runShellOwnerInstanceId }
      : {}),
    ...(options.desktopSessionId !== undefined
      ? { desktopSessionId: options.desktopSessionId }
      : {}),
    ...(options.initialCapabilityRevision !== undefined
      ? { initialCapabilityRevision: options.initialCapabilityRevision }
      : {}),
    ...(options.reconnectDelayMs !== undefined
      ? { reconnectDelayMs: options.reconnectDelayMs }
      : {}),
    onDispatch: options.onDispatch ?? (async () => ({ status: "ok" })),
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

describe("createRelayClient capability updates", () => {
  beforeEach(() => {
    created.length = 0;
  });

  afterEach(() => {});

  test("keeps Claude execution as an exact v18 Desktop-only capability", () => {
    expect(RELAY_PROTOCOL_VERSION).toBe(27);
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

  test("projects managed execution only to protocol v20 and newer peers", () => {
    const execution: RelayCapabilities = {
      profile: "desktop-agent",
      canExecuteLocal: true,
      localExecution: { version: 1, generation: "generation-fixture", pipe: true, pty: true, capacity: 2 },
    };

    expect(projectRelayCapabilitiesForProtocol(execution, 19)).toEqual({ profile: "desktop-agent" });
    expect(projectRelayCapabilitiesForProtocol(execution, 20)).toEqual(execution);
    expect(projectRelayCapabilitiesForProtocol(execution, 21)).toEqual(execution);
  });

  test("dispatches retained shell output only on v22 with the option-owned binding", async () => {
    const dispatched: import("../../src/protocol").RelayDispatchRequest[] = [];
    const client = await connectClient({
      desktopSessionId: "desktop-session-1",
      protocolVersion: 22,
      runShellOwnerInstanceId: "instance-from-options",
      capabilities: { profile: "desktop-agent", canReadShellOutput: true },
      onDispatch: async (request) => {
        dispatched.push(request);
        return { status: "ok", result: { data: "saved output" } };
      },
    });
    try {
      const ws = created[0]!;
      ws.triggerMessage(JSON.stringify({
        type: "relay:dispatch",
        correlationId: "read-output-call",
        toolName: "read_shell_output",
        args: { session_id: "execution-fixture", query: "failure" },
        impact: "read-only",
        approvalObtained: true,
        // An incoming value cannot choose or override the host owner binding.
        runShellOwnerBinding: { instanceId: "model-supplied-instance", userId: "other-user" },
      }));
      await tick();
      expect(dispatched).toHaveLength(1);
      expect(dispatched[0]!.runShellOwnerBinding).toEqual({
        instanceId: "instance-from-options",
        userId: "user-1",
        relayId: "relay-1",
        desktopSessionId: "desktop-session-1",
      });
      const result = ws.sent.map((raw) => JSON.parse(raw) as { type: string; correlationId?: string; status?: string })
        .find((message) => message.type === "relay:result" && message.correlationId === "read-output-call");
      expect(result?.status).toBe("ok");
    } finally {
      await client.disconnect();
    }
  });

  test.each([
    { label: "old protocol", protocolVersion: 21, capabilities: { profile: "desktop-agent", canReadShellOutput: true } as RelayCapabilities },
    { label: "missing capability", protocolVersion: 22, capabilities: { profile: "desktop-agent" } as RelayCapabilities },
  ])("refuses retained shell output with $label", async ({ protocolVersion, capabilities }) => {
    let dispatchCount = 0;
    const client = await connectClient({
      desktopSessionId: "desktop-session-1",
      protocolVersion,
      capabilities,
      onDispatch: async () => { dispatchCount += 1; return { status: "ok" }; },
    });
    try {
      const ws = created[0]!;
      ws.triggerMessage(JSON.stringify({
        type: "relay:dispatch",
        correlationId: "read-output-call",
        toolName: "read_shell_output",
        args: { session_id: "execution-fixture" },
        impact: "read-only",
        approvalObtained: true,
      }));
      await tick();
      expect(dispatchCount).toBe(0);
      const result = ws.sent.map((raw) => JSON.parse(raw) as { type: string; correlationId?: string; status?: string; errorCode?: string })
        .find((message) => message.type === "relay:result" && message.correlationId === "read-output-call");
      expect(result).toMatchObject({ status: "error", errorCode: "LOCAL_TOOL_UNAVAILABLE" });
    } finally {
      await client.disconnect();
    }
  });

  test("requires the typed Local Git marker at dispatch time", async () => {
    for (const localGit of [undefined, { version: 1, extra: true }]) {
      let dispatchCount = 0;
      const client = await connectClient({
        desktopSessionId: "desktop-session-1",
        protocolVersion: 22,
        capabilities: { profile: "desktop-agent", canUseLocalGit: true, localGit } as RelayCapabilities,
        onDispatch: async () => { dispatchCount += 1; return { status: "ok" }; },
      });
      try {
        const ws = created[created.length - 1]!;
        ws.triggerMessage(JSON.stringify({
          type: "relay:dispatch",
          correlationId: "local-git-call",
          toolName: "local_git",
          args: { operation: "status" },
          impact: "destructive",
          approvalObtained: true,
        }));
        await tick();
        expect(dispatchCount).toBe(0);
        const result = ws.sent.map((raw) => JSON.parse(raw) as { type: string; correlationId?: string; status?: string; errorCode?: string })
          .find((message) => message.type === "relay:result" && message.correlationId === "local-git-call");
        expect(result).toMatchObject({ status: "error", errorCode: "LOCAL_TOOL_UNAVAILABLE" });
      } finally {
        await client.disconnect();
      }
    }

    let validDispatchCount = 0;
    const validClient = await connectClient({
      desktopSessionId: "desktop-session-1",
      protocolVersion: 22,
      capabilities: { profile: "desktop-agent", canUseLocalGit: true, localGit: { version: 1 } },
      onDispatch: async () => { validDispatchCount += 1; return { status: "ok" }; },
    });
    try {
      const ws = created[created.length - 1]!;
      ws.triggerMessage(JSON.stringify({
        type: "relay:dispatch",
        correlationId: "local-git-call",
        toolName: "local_git",
        args: { operation: "status" },
        impact: "destructive",
        approvalObtained: true,
      }));
      await tick();
      expect(validDispatchCount).toBe(1);
    } finally {
      await validClient.disconnect();
    }

    let missingBooleanDispatchCount = 0;
    const missingBooleanClient = await connectClient({
      desktopSessionId: "desktop-session-1",
      protocolVersion: 22,
      capabilities: { profile: "desktop-agent", localGit: { version: 1 } },
      onDispatch: async () => { missingBooleanDispatchCount += 1; return { status: "ok" }; },
    });
    try {
      const ws = created[created.length - 1]!;
      ws.triggerMessage(JSON.stringify({
        type: "relay:dispatch",
        correlationId: "local-git-missing-flag",
        toolName: "local_git",
        args: { operation: "status" },
        impact: "destructive",
        approvalObtained: true,
      }));
      await tick();
      expect(missingBooleanDispatchCount).toBe(0);
    } finally {
      await missingBooleanClient.disconnect();
    }
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
      workspaceRoot: "/tmp/test/Nautilo",
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

describe("createRelayClient registration advertises current capabilities", () => {
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

  test("reconnect re-advertises the current managed execution capability to a v20 peer", async () => {
    const originalRandom = Math.random;
    Math.random = () => 0;
    const localExecution = {
      version: 1 as const,
      generation: "generation-fixture",
      pipe: true as const,
      pty: true,
      capacity: 2,
    };
    let dynamicCaps: RelayCapabilities = {
      profile: "desktop-agent",
      canExecuteLocal: true,
      canReadLocalExecutionHistory: true,
      localExecution,
    };
    let client: ReturnType<typeof createRelayClient> | null = null;
    try {
      client = createRelayClient({
        serverUrl: "http://127.0.0.1:9",
        userId: "user-1",
        relayId: "relay-1",
        capabilities: { profile: "desktop-agent" },
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
        capabilitiesByProtocolVersion?: Record<string, RelayCapabilities>;
      };
      expect(register1.capabilitiesByProtocolVersion?.["20"]?.localExecution).toEqual(localExecution);
      expect(register1.capabilitiesByProtocolVersion?.["20"]?.canExecuteLocal).toBe(true);
      expect(register1.capabilitiesByProtocolVersion?.["20"]?.canReadLocalExecutionHistory).toBeUndefined();
      expect(register1.capabilitiesByProtocolVersion?.["19"]?.localExecution).toBeUndefined();
      expect(register1.capabilitiesByProtocolVersion?.["19"]?.canExecuteLocal).toBeUndefined();
      expect(register1.capabilitiesByProtocolVersion?.["21"]?.canReadLocalExecutionHistory).toBe(true);
      ws1.triggerMessage(JSON.stringify({
        type: "relay:registered",
        relayId: "relay-1",
        protocolVersion: 20,
        selectedProtocolVersion: 20,
        relaySessionId: "relay-session-1",
        pairingGenerationRef: "pairing-1",
      }));
      await connectPromise;

      const reconnectedLocalExecution = { ...localExecution, generation: "generation-reconnected", capacity: 3 };
      dynamicCaps = {
        profile: "desktop-agent",
        canExecuteLocal: true,
        canReadLocalExecutionHistory: true,
        localExecution: reconnectedLocalExecution,
      };
      ws1.close();
      await tick();
      const ws2 = created[created.length - 1]!;
      expect(ws2).not.toBe(ws1);
      ws2.triggerOpen();
      await tick();
      const register2 = JSON.parse(ws2.sent[0]!) as {
        capabilitiesByProtocolVersion?: Record<string, RelayCapabilities>;
      };
      expect(register2.capabilitiesByProtocolVersion?.["20"]?.localExecution).toEqual(reconnectedLocalExecution);
      expect(register2.capabilitiesByProtocolVersion?.["20"]?.canExecuteLocal).toBe(true);
      expect(register2.capabilitiesByProtocolVersion?.["20"]?.canReadLocalExecutionHistory).toBeUndefined();
      expect(register2.capabilitiesByProtocolVersion?.["19"]?.localExecution).toBeUndefined();
      expect(register2.capabilitiesByProtocolVersion?.["19"]?.canExecuteLocal).toBeUndefined();
      expect(register2.capabilitiesByProtocolVersion?.["21"]?.canReadLocalExecutionHistory).toBe(true);
      ws2.triggerMessage(JSON.stringify({
        type: "relay:registered",
        relayId: "relay-1",
        protocolVersion: 20,
        selectedProtocolVersion: 20,
        relaySessionId: "relay-session-2",
        pairingGenerationRef: "pairing-1",
      }));
      await tick();
    } finally {
      await client?.disconnect();
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

for (const protocolVersion of [22, 23]) test(`Basic wire dispatch requires negotiated v23 (peer ${protocolVersion})`, async () => {
  created.length = 0;
  const dispatched: import("../../src/protocol").RelayDispatchRequest[] = [];
  const capabilities: RelayCapabilities = { profile: "desktop-agent", canExecuteLocal: true,
    localExecution: { version: 1, generation: "generation-basic", pipe: true, pty: true, capacity: 4 },
    basicExecution: { version: 1, currentFolder: "/tmp/basic", serverBindingId: "server", protectedPolicyVersion: 1 } };
  const client = await connectClient({ desktopSessionId: "desktop", protocolVersion, runShellOwnerInstanceId: "", capabilities,
    onDispatch: async request => { dispatched.push(request); return { status: "ok" }; } });
  try {
    const ws = created[0]!;
    const binding = { version: 2, generation: "generation-basic", executionId: "execution", invocationId: "call", operation: "start",
      authority: { kind: "basic", roomId: "room-fixture", currentFolder: "/tmp/basic", capabilityRevision: 0, protectedPolicyVersion: 1 },
      owner: { instanceId: "", humanUserId: "user-1", agentId: "agent", runId: "run", conversationId: "conversation", relayId: "relay-1", desktopSessionId: "desktop", pairingGeneration: "pairing-1", serverBindingId: "server", profileId: null, profileRevision: null, grantIds: [], grantRevision: null, protectedPolicyVersion: 1 } };
    const send = (localExecutionBinding: unknown) => ws.triggerMessage(JSON.stringify({ type: "relay:dispatch", correlationId: "basic-call", toolName: "exec_command", args: { cmd: "printf fixture" }, impact: "destructive", approvalObtained: true, localExecutionBinding }));
    send(binding); await tick(); expect(dispatched).toHaveLength(protocolVersion === 23 ? 1 : 0);
    send({ ...binding, authority: { ...binding.authority, currentFolder: "/tmp/foreign" } }); await tick();
    expect(dispatched).toHaveLength(protocolVersion === 23 ? 1 : 0);
    const registration = JSON.parse(ws.sent[0]!) as { capabilitiesByProtocolVersion: Record<string, RelayCapabilities> };
    expect(registration.capabilitiesByProtocolVersion["22"]?.canExecuteLocal).toBeUndefined();
    expect(registration.capabilitiesByProtocolVersion["23"]?.basicExecution).toEqual(capabilities.basicExecution);
  } finally { await client.disconnect(); }
});

for (const protocolVersion of [23, 24]) test(`Human Terminal incoming frame requires scoped v24 consent (peer ${protocolVersion})`, async () => {
  created.length = 0;
  const dispatched: import("../../src/protocol").RelayDispatchRequest[] = [];
  const owner = { humanUserId: "user-1", agentId: "agent", roomId: "room", relayId: "relay-1", desktopSessionId: "desktop", pairingGeneration: "pairing-1", serverOrigin: "https://server.example", serverFingerprint: "fingerprint" };
  const capabilities: RelayCapabilities = { profile: "desktop-agent", canUseHumanTerminal: true, humanTerminal: { version: 1, generation: "consent", owner } };
  const client = await connectClient({ desktopSessionId: "desktop", protocolVersion, capabilities,
    onDispatch: async request => { dispatched.push(request); return { status: "ok" }; } });
  try {
    const ws = created[0]!;
    const binding = { version: 1, generation: "consent", invocationId: "call", owner: { ...owner, conversationId: "thread" } };
    const send = (humanTerminalBinding: unknown, args: unknown = { action: "read" }) => ws.triggerMessage(JSON.stringify({ type: "relay:dispatch", correlationId: "handoff", toolName: "human_terminal", args, impact: "read-only", approvalObtained: true, humanTerminalBinding }));
    send(binding); await tick(); expect(dispatched).toHaveLength(protocolVersion === 24 ? 1 : 0);
    send({ ...binding, generation: "old" }); send({ ...binding, owner: { ...binding.owner, agentId: "other" } }); send(binding, { action: "read", session_id: "arbitrary" });
    await tick(); expect(dispatched).toHaveLength(protocolVersion === 24 ? 1 : 0);
    const registration = JSON.parse(ws.sent[0]!) as { capabilitiesByProtocolVersion: Record<string, RelayCapabilities> };
    expect(registration.capabilitiesByProtocolVersion["23"]?.humanTerminal).toBeUndefined();
    expect(registration.capabilitiesByProtocolVersion["24"]?.humanTerminal).toEqual(capabilities.humanTerminal);
  } finally { await client.disconnect(); }
});

for (const protocolVersion of [24, 25]) test(`Full Mac frames require the one-shot v25 contract (peer ${protocolVersion})`, async () => {
  created.length = 0;
  const dispatched: import("../../src/protocol").RelayDispatchRequest[] = [];
  const capabilities: RelayCapabilities = { profile: "desktop-agent", canExecuteLocal: true, canExecuteFullMacOneShot: true,
    localExecution: { version: 1, generation: "host", pipe: true, pty: true, capacity: 4 } };
  const client = await connectClient({ desktopSessionId: "desktop", protocolVersion, runShellOwnerInstanceId: "", capabilities,
    onDispatch: async request => { dispatched.push(request); return { status: "ok" }; } });
  try {
    const ws = created[0]!;
    const binding = { version: 3, generation: "host", executionId: "execution", invocationId: "call", operation: "start",
      authority: { kind: "full_mac", activationId: "activation", roomId: "room" },
      owner: { instanceId: "", humanUserId: "user-1", agentId: "agent", runId: "run", conversationId: "conversation", relayId: "relay-1", desktopSessionId: "desktop", pairingGeneration: "pairing-1", serverBindingId: "server", profileId: null, profileRevision: null, grantIds: [], grantRevision: null, protectedPolicyVersion: null } };
    const send = (args: unknown) => ws.triggerMessage(JSON.stringify({ type: "relay:dispatch", correlationId: "full-mac-call", toolName: "exec_command", args,
      impact: "destructive", approvalObtained: true, executionClass: "real_workstation", uncontainedHostCommandsSession: true, localExecutionBinding: binding }));
    send({ cmd: "printf fixture" }); await tick(); expect(dispatched).toHaveLength(protocolVersion === 25 ? 1 : 0);
    send({ cmd: "printf fixture", tty: true }); await tick(); expect(dispatched).toHaveLength(protocolVersion === 25 ? 1 : 0);
    const registration = JSON.parse(ws.sent[0]!) as { capabilitiesByProtocolVersion: Record<string, RelayCapabilities> };
    expect(registration.capabilitiesByProtocolVersion["24"]?.canExecuteFullMacOneShot).toBeUndefined();
    expect(registration.capabilitiesByProtocolVersion["25"]?.canExecuteFullMacOneShot).toBeTrue();
  } finally { await client.disconnect(); }
});

for (const protocolVersion of [25, 26]) test(`live and history search frames require negotiated v26 (peer ${protocolVersion})`, async () => {
  created.length = 0;
  const dispatched: import("../../src/protocol").RelayDispatchRequest[] = [];
  const capabilities: RelayCapabilities = { profile: "desktop-agent", canExecuteLocal: true, canReadLocalExecutionHistory: true, canSearchLocalExecutionOutput: true,
    localExecution: { version: 1, generation: "host", pipe: true, pty: true, capacity: 4 } };
  const client = await connectClient({ desktopSessionId: "desktop", protocolVersion, runShellOwnerInstanceId: "", capabilities,
    onDispatch: async request => { dispatched.push(request); return { status: "ok" }; } });
  try {
    const ws = created[0]!;
    const owner = { instanceId: "", humanUserId: "user-1", agentId: "agent", runId: "run", conversationId: "conversation", relayId: "relay-1", desktopSessionId: "desktop", pairingGeneration: "pairing-1", serverBindingId: "server", profileId: null, profileRevision: null, grantIds: [], grantRevision: null, protectedPolicyVersion: null };
    const localExecutionBinding = { version: 1, generation: "host", executionId: "execution", invocationId: "call", operation: "read", owner };
    const localExecutionHistoryBinding = { version: 1, generation: "old-host", executionId: "execution", invocationId: "history", sourceMessageId: 1,
      reader: { instanceId: "", humanUserId: "user-1", agentId: "agent", conversationId: "conversation", roomId: "room", relayId: "relay-1", desktopSessionId: "desktop", pairingGeneration: "pairing-1" } };
    const send = (binding: object, args: object) => ws.triggerMessage(JSON.stringify({ type: "relay:dispatch", correlationId: "search-call", toolName: "write_stdin", args, impact: "read-only", approvalObtained: true, ...binding }));
    send({ localExecutionBinding }, { session_id: "execution", search: "needle" });
    send({ localExecutionHistoryBinding }, { session_id: "execution", search: "needle" });
    await tick(); expect(dispatched).toHaveLength(protocolVersion === 26 ? 2 : 0);
    for (const extra of [{ chars: "" }, { cancel: false }, { yield_time_ms: 0 }]) {
      send({ localExecutionBinding }, { session_id: "execution", search: "needle", ...extra });
      send({ localExecutionHistoryBinding }, { session_id: "execution", search: "needle", ...extra });
    }
    await tick(); expect(dispatched).toHaveLength(protocolVersion === 26 ? 2 : 0);
    send({ localExecutionBinding }, { session_id: "execution" });
    await tick(); expect(dispatched).toHaveLength(protocolVersion === 26 ? 3 : 1);
    const registration = JSON.parse(ws.sent[0]!) as { capabilitiesByProtocolVersion: Record<string, RelayCapabilities> };
    expect(registration.capabilitiesByProtocolVersion["25"]?.canSearchLocalExecutionOutput).toBeUndefined();
    expect(registration.capabilitiesByProtocolVersion["26"]?.canSearchLocalExecutionOutput).toBeTrue();
  } finally { await client.disconnect(); }
});

for (const protocolVersion of [26, 27]) test(`GitHub incoming frames require exact admitted v27 custody (peer ${protocolVersion})`, async () => {
  created.length = 0;
  const dispatched: import("../../src/protocol").RelayDispatchRequest[] = [];
  const identity = { instanceId: "", humanUserId: "user-1", relayId: "relay-1", desktopSessionId: "desktop", pairingGeneration: "pairing-1", serverOrigin: "https://server.example", serverFingerprint: "fingerprint", profileId: "profile", profileRevision: 1, grantRevision: 1, protectedPolicyVersion: 1 };
  const capabilities: RelayCapabilities = { profile: "desktop-agent", canUseGitHub: true, github: { version: 1, generation: "custody", identity } };
  const client = await connectClient({ desktopSessionId: "desktop", protocolVersion, runShellOwnerInstanceId: "", capabilities,
    onDispatch: async request => { dispatched.push(request); return { status: "ok" }; } });
  try {
    const ws = created[0]!;
    const binding = { version: 1, generation: "custody", toolCallId: "call", stage: "read", owner: { ...identity, agentId: "agent", roomId: "room", conversationId: "thread", runId: "turn" } };
    const send = (githubBinding: unknown) => ws.triggerMessage(JSON.stringify({ type: "relay:dispatch", correlationId: "github", toolName: "local_github", args: { operation: "issue_read", repository: "fixture/project", number: 12 }, impact: "read-only", approvalObtained: false, githubBinding }));
    send(binding); await tick(); expect(dispatched).toHaveLength(protocolVersion === 27 ? 1 : 0);
    send({ ...binding, generation: "old" }); send({ ...binding, owner: { ...binding.owner, humanUserId: "other" } });
    await tick(); expect(dispatched).toHaveLength(protocolVersion === 27 ? 1 : 0);
    const registration = JSON.parse(ws.sent[0]!) as { capabilitiesByProtocolVersion: Record<string, RelayCapabilities> };
    expect(registration.capabilitiesByProtocolVersion["26"]?.github).toBeUndefined();
    expect(registration.capabilitiesByProtocolVersion["27"]?.github).toEqual(capabilities.github);
  } finally { await client.disconnect(); }
});
