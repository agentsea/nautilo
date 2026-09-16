import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { RelayDispatchRequest } from "../../src/protocol";
import {
  RELAY_PROTOCOL_VERSION,
  RELAY_COMPUTER_USE_SEMANTIC_PROTOCOL_VERSION,
  RELAY_DESKTOP_AUTOMATION_INVOCATION_BINDING_VERSION,
  RELAY_WORKSTATION_SHELL_BINDING_EXECUTION_CLASS,
  RELAY_WORKSTATION_SHELL_BINDING_VERSION,
  RELAY_SSH_DISPATCH_BINDING_VERSION,
  type RelaySshDispatchBindingV1,
  type RelayWorkstationShellBinding,
  type DesktopAutomationInvocationBinding,
} from "../../src/protocol";
import type { RelayCapabilities } from "../../src/types";

const capabilities: RelayCapabilities = {
  profile: "device-relay",
  canRunShell: true,
};

const WORKSTATION_SHELL_BINDING: RelayWorkstationShellBinding = {
  version: RELAY_WORKSTATION_SHELL_BINDING_VERSION,
  toolCallId: "tc-run_shell",
  relayId: "relay-1",
  desktopSessionId: "desktop-1",
  serverBindingId: "server-binding-1",
  pairingGeneration: "pairing-1",
  profileId: "profile-1",
  profileRevision: 3,
  grantIds: ["grant-1", "grant-2"],
  capabilityRevision: 7,
  currentFolder: "/Users/test/project",
  grantRevision: 11,
  protectedPolicyVersion: 4,
  subject: {
    userId: "user-1",
    instanceId: "instance-1",
    relayId: "relay-1",
    agentScope: "all_owned_agents",
  },
  operation: "execute",
  executionClass: RELAY_WORKSTATION_SHELL_BINDING_EXECUTION_CLASS,
};

const SSH_BINDING: RelaySshDispatchBindingV1 = {
  version: RELAY_SSH_DISPATCH_BINDING_VERSION,
  admissionId: "admission-1",
  toolCallId: "tool-call-1",
  approvedRequestDigest: "a".repeat(64),
  operation: "exec",
  preparationId: "ssh-preparation-1",
  subject: {
    userId: "user-1",
    actorId: "actor-1",
    actorRole: "owner",
    agentId: "agent-1",
    executionEntrypoint: "foreground.main",
    instanceId: "instance-1",
    relayId: "relay-1",
    relaySessionId: "relay-session-1",
    desktopSessionId: "desktop-1",
    pairingGenerationRef: "pairing-1",
    capabilityRevision: 7,
  },
};

const DESKTOP_AUTOMATION_BINDING: DesktopAutomationInvocationBinding = {
  version: RELAY_DESKTOP_AUTOMATION_INVOCATION_BINDING_VERSION,
  computerUseContextId: "computer-use-context-1",
  computerUseInvocationId: "computer-invocation:fixture-1",
  originHumanId: "user-1",
  originRunId: "run-1",
  originAgentId: "agent-1",
  lineageId: "lineage-1",
  installationEpoch: "installation-epoch-1",
  grantGeneration: 2,
  provider: "cua",
  providerGeneration: "provider-generation-1",
  relayId: "relay-1",
  pairingGeneration: "pairing-1",
  desktopSessionId: "desktop-1",
};

const COMPUTER_USE_REQUEST = {
  contract: {
    contractNamespace: "nautilo.computer_use",
    contractId: "future.arbitrary_compatible_contract",
    contractVersion: 1,
    schemaDigest: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    effectClass: "read",
    replayClass: "safe",
    authorityClass: "standing_computer_use",
    attachmentClass: "none",
    disclosureClass: "semantic",
  },
  arguments: { opaque: "future-value" },
} as const;

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

describe("createRelayClient send()", () => {
  let warnSpy: ReturnType<typeof mock>;
  let origWarn: typeof console.warn;

  beforeEach(() => {
    created.length = 0;
    warnSpy = mock((..._args: unknown[]) => {});
    origWarn = console.warn;
    console.warn = warnSpy as typeof console.warn;
  });

  afterEach(() => {
    console.warn = origWarn;
  });

  test("warns when dropping relay:result on a closed socket", async () => {
    let releaseDispatch: (() => void) | undefined;
    const dispatchGate = new Promise<void>((resolve) => {
      releaseDispatch = resolve;
    });

    const client = createRelayClient({
      serverUrl: "http://127.0.0.1:9",
      userId: "user-1",
      relayId: "relay-1",
      desktopSessionId: "desktop-1",
      initialCapabilityRevision: 7,
      capabilities,
      onDispatch: async () => {
        await dispatchGate;
        return { status: "ok", result: "ok" };
      },
    });

    const connectPromise = client.connect();
    const ws = created[0]!;
    ws.triggerOpen();
    ws.triggerMessage(JSON.stringify({
      type: "relay:registered", relayId: "relay-1", protocolVersion: RELAY_PROTOCOL_VERSION,
      selectedProtocolVersion: RELAY_PROTOCOL_VERSION, relaySessionId: "relay-session-1", pairingGenerationRef: "pairing-1",
    }));
    await connectPromise;

    ws.triggerMessage(
      JSON.stringify({
        type: "relay:dispatch",
        correlationId: "corr-1",
        toolName: "run_shell",
        args: { command: "echo hi" },
        timeout: 1000,
        impact: "low",
        approvalObtained: true,
        allowedRoots: ["/tmp"],
        sandboxProfile: {
          deploymentMode: "server",
          securityLevel: "standard",
          mode: "enabled",
          networkPolicy: { mode: "host" },
        },
      }),
    );

    ws.readyState = RS_CLOSED;
    releaseDispatch?.();

    await new Promise((resolve) => setTimeout(resolve, 20));

    const resultWarns = warnSpy.mock.calls.filter((call) =>
      String(call[0]).includes("dropped message type=relay:result"),
    );
    expect(resultWarns.length).toBeGreaterThanOrEqual(1);

    const heartbeatWarns = warnSpy.mock.calls.filter((call) =>
      String(call[0]).includes("relay:heartbeat"),
    );
    expect(heartbeatWarns).toHaveLength(0);

    await client.disconnect();
  });

  test("projects only server-acknowledged desktop topology and clears it on disconnect", async () => {
    const observed: Array<{ pairingGeneration: string } | null> = [];
    const client = createRelayClient({
      serverUrl: "http://127.0.0.1:9",
      userId: "user-1",
      relayId: "relay-1",
      desktopSessionId: "desktop-1",
      capabilities,
      onDesktopTopologyChange: (topology) => observed.push(topology === null ? null : {
        pairingGeneration: topology.pairingGeneration,
      }),
      onDispatch: async () => ({ status: "ok" }),
    });
    const connecting = client.connect();
    const ws = created[0]!;
    ws.triggerOpen();
    ws.triggerMessage(JSON.stringify({
      type: "relay:registered", relayId: "relay-1", protocolVersion: RELAY_PROTOCOL_VERSION,
      selectedProtocolVersion: RELAY_PROTOCOL_VERSION, relaySessionId: "relay-session-1", pairingGenerationRef: "pairing-1",
    }));
    await connecting;
    expect(client.getDesktopTopology()).toMatchObject({
      relayId: "relay-1", pairingGeneration: "pairing-1", desktopSessionId: "desktop-1",
    });
    expect(observed).toEqual([{ pairingGeneration: "pairing-1" }]);
    await client.disconnect();
    expect(client.getDesktopTopology()).toBeNull();
    expect(observed.at(-1)).toBeNull();
  });

  test("clears the old pairing before projecting a reconnect's new acknowledged pairing", async () => {
    const originalRandom = Math.random;
    Math.random = () => 0;
    try {
    const observed: Array<string | null> = [];
    const client = createRelayClient({
      serverUrl: "http://127.0.0.1:9",
      userId: "user-1",
      relayId: "relay-1",
      desktopSessionId: "desktop-1",
      reconnectDelayMs: 1,
      capabilities,
      onDesktopTopologyChange: (topology) => observed.push(topology?.pairingGeneration ?? null),
      onDispatch: async () => ({ status: "ok" }),
    });
    const connecting = client.connect();
    const first = created[0]!;
    first.triggerOpen();
    first.triggerMessage(JSON.stringify({
      type: "relay:registered", relayId: "relay-1", protocolVersion: RELAY_PROTOCOL_VERSION,
      selectedProtocolVersion: RELAY_PROTOCOL_VERSION, relaySessionId: "relay-session-1", pairingGenerationRef: "pairing-1",
    }));
    await connecting;
    first.close();
    await new Promise((resolve) => setTimeout(resolve, 10));
    const second = created[1]!;
    expect(second).toBeDefined();
    second.triggerOpen();
    second.triggerMessage(JSON.stringify({
      type: "relay:registered", relayId: "relay-1", protocolVersion: RELAY_PROTOCOL_VERSION,
      selectedProtocolVersion: RELAY_PROTOCOL_VERSION, relaySessionId: "relay-session-2", pairingGenerationRef: "pairing-2",
    }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(client.getDesktopTopology()).toMatchObject({ pairingGeneration: "pairing-2" });
    expect(observed).toEqual(["pairing-1", null, "pairing-2"]);
    await client.disconnect();
    } finally {
      Math.random = originalRandom;
    }
  });

  test("handleDispatch preserves workstationShellBinding on the onDispatch request (D418)", async () => {
    let captured: RelayDispatchRequest | undefined;

    const client = createRelayClient({
      serverUrl: "http://127.0.0.1:9",
      userId: "user-1",
      desktopSessionId: "desktop-1",
      runShellOwnerInstanceId: "instance-1",
      capabilities,
      onDispatch: async (request) => {
        captured = request;
        return { status: "ok" };
      },
    });

    const connectPromise = client.connect();
    const ws = created[0]!;
    ws.triggerOpen();
    ws.triggerMessage(JSON.stringify({
      type: "relay:registered",
      relayId: client.getRelayId(),
      protocolVersion: 11,
    }));
    await connectPromise;

    ws.triggerMessage(
      JSON.stringify({
        type: "relay:dispatch",
        correlationId: "corr-binding-1",
        toolName: "run_shell",
        args: { command: "echo hi" },
        timeout: 1000,
        impact: "high",
        approvalObtained: true,
        allowedRoots: ["/tmp"],
        workstationShellBinding: WORKSTATION_SHELL_BINDING,
        sandboxProfile: {
          deploymentMode: "server",
          securityLevel: "standard",
          mode: "enabled",
          networkPolicy: { mode: "host" },
        },
      }),
    );

    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(captured).toBeDefined();
    expect(captured!.workstationShellBinding).toEqual(WORKSTATION_SHELL_BINDING);
    expect(captured!.correlationId).toBe("corr-binding-1");
    expect(captured!.runShellOwnerBinding).toEqual({
      instanceId: "instance-1",
      userId: "user-1",
      relayId: client.getRelayId(),
      desktopSessionId: "desktop-1",
    });

    await client.disconnect();
  });

  test("handleDispatch rebuilds and preserves a valid structured SSH binding", async () => {
    let captured: RelayDispatchRequest | undefined;
    const client = createRelayClient({
      serverUrl: "http://127.0.0.1:9",
      userId: "user-1",
      relayId: "relay-1",
      desktopSessionId: "desktop-1",
      runShellOwnerInstanceId: "instance-1",
      initialCapabilityRevision: 7,
      capabilities,
      onDispatch: async (request) => {
        captured = request;
        return { status: "ok" };
      },
    });
    const connectPromise = client.connect();
    const ws = created[0]!;
    ws.triggerOpen();
    ws.triggerMessage(JSON.stringify({
      type: "relay:registered", relayId: "relay-1", protocolVersion: RELAY_PROTOCOL_VERSION,
      selectedProtocolVersion: RELAY_PROTOCOL_VERSION, relaySessionId: "relay-session-1", pairingGenerationRef: "pairing-1",
    }));
    await connectPromise;

    ws.triggerMessage(JSON.stringify({
      type: "relay:dispatch",
      correlationId: "corr-ssh-valid",
      toolName: "ssh",
      args: { operation: "exec" },
      impact: "high",
      approvalObtained: true,
      executionClass: "structured-ssh",
      sshBinding: SSH_BINDING,
    }));
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(captured?.sshBinding).toEqual(SSH_BINDING);
    expect(captured?.executionClass).toBe("structured-ssh");
    expect(captured?.structuredSshOutputOwnerBinding).toEqual({
      instanceId: "instance-1", userId: "user-1", relayId: "relay-1", desktopSessionId: "desktop-1",
    });

    ws.triggerMessage(JSON.stringify({
      type: "relay:dispatch",
      correlationId: "corr-ssh-output",
      toolName: "structured_ssh_output",
      args: { output_artifact: { reference: "a".repeat(43) } },
      impact: "read-only",
      approvalObtained: true,
      executionClass: "desktop",
    }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(captured).toMatchObject({
      correlationId: "corr-ssh-output",
      toolName: "structured_ssh_output",
      structuredSshOutputOwnerBinding: {
        instanceId: "instance-1", userId: "user-1", relayId: "relay-1", desktopSessionId: "desktop-1",
      },
    });
    await client.disconnect();
  });

  test("handleDispatch carries an exact binding for an unknown future Computer Use catalogue key", async () => {
    const captured: RelayDispatchRequest[] = [];
    const client = createRelayClient({
      serverUrl: "http://127.0.0.1:9",
      userId: "user-1",
      relayId: "relay-1",
      desktopSessionId: "desktop-1",
      capabilities,
      onDispatch: async (request) => {
        captured.push(request);
        return { status: "ok" };
      },
    });
    const connectPromise = client.connect();
    const ws = created[0]!;
    ws.triggerOpen();
    ws.triggerMessage(JSON.stringify({
      type: "relay:registered", relayId: "relay-1", protocolVersion: RELAY_PROTOCOL_VERSION,
      selectedProtocolVersion: RELAY_PROTOCOL_VERSION, relaySessionId: "relay-session-1", pairingGenerationRef: "pairing-1",
    }));
    await connectPromise;

    ws.triggerMessage(JSON.stringify({
      type: "relay:dispatch", correlationId: "corr-desktop-valid", toolName: "future_catalogue_operation", args: {},
      impact: "low", approvalObtained: false, executionClass: "computer_use",
      desktopAutomationBinding: DESKTOP_AUTOMATION_BINDING,
      computerUseRequest: COMPUTER_USE_REQUEST,
    }));
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(captured).toHaveLength(1);
    expect(captured[0]?.desktopAutomationBinding).toEqual(DESKTOP_AUTOMATION_BINDING);
    expect(captured[0]?.computerUseRequest).toEqual(COMPUTER_USE_REQUEST);
    await client.disconnect();
  });

  test("rejects semantic Computer Use dispatch on a negotiated pre-v17 socket", async () => {
    let calls = 0;
    const client = createRelayClient({
      serverUrl: "http://127.0.0.1:9",
      userId: "user-1",
      relayId: "relay-1",
      desktopSessionId: "desktop-1",
      capabilities,
      onDispatch: async () => { calls += 1; return { status: "ok" }; },
    });
    const connectPromise = client.connect();
    const ws = created[0]!;
    ws.triggerOpen();
    ws.triggerMessage(JSON.stringify({
      type: "relay:registered",
      relayId: "relay-1",
      protocolVersion: RELAY_COMPUTER_USE_SEMANTIC_PROTOCOL_VERSION - 1,
      selectedProtocolVersion: RELAY_COMPUTER_USE_SEMANTIC_PROTOCOL_VERSION - 1,
      relaySessionId: "relay-session-1",
      pairingGenerationRef: "pairing-1",
    }));
    await connectPromise;

    ws.triggerMessage(JSON.stringify({
      type: "relay:dispatch", correlationId: "corr-desktop-old-peer", toolName: "computer_do", args: {},
      impact: "low", approvalObtained: false, executionClass: "computer_use",
      desktopAutomationBinding: DESKTOP_AUTOMATION_BINDING,
    }));
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(calls).toBe(0);
    const result = ws.sent.map((frame) => JSON.parse(frame) as Record<string, unknown>)
      .find((frame) => frame["correlationId"] === "corr-desktop-old-peer");
    expect(result).toMatchObject({ errorCode: "DESKTOP_AUTOMATION_BINDING_INVALID" });
    await client.disconnect();
  });

  test("handleDispatch rejects missing, foreign, and non-desktop desktop bindings", async () => {
    let calls = 0;
    const client = createRelayClient({
      serverUrl: "http://127.0.0.1:9",
      userId: "user-1",
      relayId: "relay-1",
      desktopSessionId: "desktop-1",
      capabilities,
      onDispatch: async () => {
        calls += 1;
        return { status: "ok" };
      },
    });
    const connectPromise = client.connect();
    const ws = created[0]!;
    ws.triggerOpen();
    ws.triggerMessage(JSON.stringify({
      type: "relay:registered", relayId: "relay-1", protocolVersion: RELAY_PROTOCOL_VERSION,
      selectedProtocolVersion: RELAY_PROTOCOL_VERSION, relaySessionId: "relay-session-1", pairingGenerationRef: "pairing-1",
    }));
    await connectPromise;

    const base = {
      type: "relay:dispatch",
      toolName: "computer_do",
      args: {},
      impact: "low",
      approvalObtained: false,
      executionClass: "computer_use",
    };
    for (const frame of [
      { ...base, correlationId: "corr-desktop-missing" },
      {
        ...base,
        correlationId: "corr-desktop-foreign",
        computerUseRequest: COMPUTER_USE_REQUEST,
        desktopAutomationBinding: {
          ...DESKTOP_AUTOMATION_BINDING,
          pairingGeneration: "pairing-2",
        },
      },
      {
        ...base,
        correlationId: "corr-desktop-epoch-malformed",
        computerUseRequest: COMPUTER_USE_REQUEST,
        desktopAutomationBinding: {
          ...DESKTOP_AUTOMATION_BINDING,
          installationEpoch: "installation\u2028epoch",
        },
      },
      {
        ...base,
        correlationId: "corr-desktop-nondesk",
        executionClass: "browser",
        desktopAutomationBinding: DESKTOP_AUTOMATION_BINDING,
        computerUseRequest: COMPUTER_USE_REQUEST,
      },
    ]) {
      ws.triggerMessage(JSON.stringify(frame));
      await new Promise((resolve) => setTimeout(resolve, 5));
    }

    expect(calls).toBe(0);
    const results = ws.sent
      .map((frame) => JSON.parse(frame) as Record<string, unknown>)
      .filter((frame) => frame["type"] === "relay:result");
    expect(results).toHaveLength(4);
    expect(results[0]).toMatchObject({
      correlationId: "corr-desktop-missing",
      errorCode: "DESKTOP_AUTOMATION_BINDING_INVALID",
    });
    expect(results[1]).toMatchObject({
      correlationId: "corr-desktop-foreign",
      errorCode: "DESKTOP_AUTOMATION_BINDING_STALE",
    });
    expect(results[2]).toMatchObject({
      correlationId: "corr-desktop-epoch-malformed",
      errorCode: "DESKTOP_AUTOMATION_BINDING_INVALID",
    });
    expect(results[3]).toMatchObject({
      correlationId: "corr-desktop-nondesk",
      errorCode: "DESKTOP_AUTOMATION_BINDING_INVALID",
    });
    await client.disconnect();
  });

  test("handleDispatch rejects a final SSH binding after authenticated socket topology drifts", async () => {
    let calls = 0;
    const client = createRelayClient({
      serverUrl: "http://127.0.0.1:9",
      userId: "user-1",
      relayId: "relay-1",
      desktopSessionId: "desktop-1",
      initialCapabilityRevision: 7,
      capabilities,
      onDispatch: async () => { calls += 1; return { status: "ok" }; },
    });
    const connectPromise = client.connect();
    const ws = created[0]!;
    ws.triggerOpen();
    ws.triggerMessage(JSON.stringify({
      type: "relay:registered", relayId: "relay-1", protocolVersion: RELAY_PROTOCOL_VERSION,
      selectedProtocolVersion: RELAY_PROTOCOL_VERSION, relaySessionId: "relay-session-1", pairingGenerationRef: "pairing-1",
    }));
    await connectPromise;
    ws.triggerMessage(JSON.stringify({
      type: "relay:dispatch", correlationId: "corr-ssh-stale", toolName: "ssh",
      args: { operation: "exec" }, impact: "high", approvalObtained: true,
      executionClass: "structured-ssh",
      sshBinding: { ...SSH_BINDING, subject: { ...SSH_BINDING.subject, relaySessionId: "relay-session-2" } },
    }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(calls).toBe(0);
    expect(JSON.parse(ws.sent.at(-1)!)).toMatchObject({
      correlationId: "corr-ssh-stale", errorCode: "STRUCTURED_SSH_BINDING_STALE",
    });
    await client.disconnect();
  });

  test("handleDispatch rejects malformed structured SSH bindings before invoking onDispatch", async () => {
    let calls = 0;
    const client = createRelayClient({
      serverUrl: "http://127.0.0.1:9",
      userId: "user-1",
      relayId: "relay-1",
      desktopSessionId: "desktop-1",
      initialCapabilityRevision: 7,
      capabilities,
      onDispatch: async () => {
        calls += 1;
        return { status: "ok" };
      },
    });
    const connectPromise = client.connect();
    const ws = created[0]!;
    ws.triggerOpen();
    ws.triggerMessage(JSON.stringify({
      type: "relay:registered", relayId: "relay-1", protocolVersion: RELAY_PROTOCOL_VERSION,
      selectedProtocolVersion: RELAY_PROTOCOL_VERSION, relaySessionId: "relay-session-1", pairingGenerationRef: "pairing-1",
    }));
    await connectPromise;

    ws.triggerMessage(JSON.stringify({
      type: "relay:dispatch",
      correlationId: "corr-ssh-invalid",
      toolName: "ssh",
      args: { operation: "exec" },
      impact: "high",
      approvalObtained: true,
      executionClass: "structured-ssh",
      sshBinding: { ...SSH_BINDING, host: "must-not-cross-the-wire" },
    }));
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(calls).toBe(0);
    expect(JSON.parse(ws.sent.at(-1)!)).toEqual({
      type: "relay:result",
      correlationId: "corr-ssh-invalid",
      status: "error",
      error: "Malformed structured SSH binding.",
      errorCode: "STRUCTURED_SSH_BINDING_INVALID",
    });
    await client.disconnect();
  });

  test("handleDispatch requires the exact SSH tool, class, approval, binding, and operation tuple", async () => {
    let calls = 0;
    const client = createRelayClient({
      serverUrl: "http://127.0.0.1:9",
      userId: "user-1",
      capabilities,
      onDispatch: async () => {
        calls += 1;
        return { status: "ok" };
      },
    });
    const connectPromise = client.connect();
    const ws = created[0]!;
    ws.triggerOpen();
    ws.triggerMessage(JSON.stringify({ type: "relay:registered" }));
    await connectPromise;

    const base = {
      type: "relay:dispatch",
      correlationId: "corr-ssh-tuple",
      toolName: "ssh",
      args: { operation: "exec" },
      impact: "high",
      approvalObtained: true,
      executionClass: "structured-ssh",
      sshBinding: SSH_BINDING,
    };
    for (const mismatch of [
      { ...base, toolName: "run_shell" },
      { ...base, executionClass: "desktop" },
      { ...base, approvalObtained: false },
      { ...base, sshBinding: undefined },
      { ...base, args: { operation: "auth" } },
    ]) {
      ws.triggerMessage(JSON.stringify(mismatch));
      await new Promise((resolve) => setTimeout(resolve, 5));
    }

    expect(calls).toBe(0);
    const denials = ws.sent
      .map((frame) => JSON.parse(frame) as Record<string, unknown>)
      .filter((frame) => frame["errorCode"] === "STRUCTURED_SSH_BINDING_INVALID");
    expect(denials).toHaveLength(5);
    await client.disconnect();
  });

  test("keeps browser-page continuation local-only and gates it away from a v11 peer", async () => {
    let captured: RelayDispatchRequest | undefined;
    const client = createRelayClient({
      serverUrl: "http://127.0.0.1:9",
      userId: "user-1",
      desktopSessionId: "desktop-1",
      browserPageOwnerInstanceId: "instance-1",
      capabilities: { profile: "desktop-agent", canControlBrowser: true, canContinueBrowserPageRead: true },
      onDispatch: async (request) => { captured = request; return { status: "ok" }; },
    });
    const connectPromise = client.connect();
    const ws = created[0]!;
    ws.triggerOpen();
    // Explicit old-client fixture: browser reads remain ordinary and receive
    // neither a continuation binding nor any server-supplied authority.
    ws.triggerMessage(JSON.stringify({ type: "relay:registered", relayId: client.getRelayId(), protocolVersion: 11 }));
    await connectPromise;
    ws.triggerMessage(JSON.stringify({
      type: "relay:dispatch", correlationId: "corr-browser-v11", toolName: "browser_read_page", args: {},
      impact: "read-only", approvalObtained: false, executionClass: "browser",
    }));
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(captured?.browserPageOwnerBinding).toBeUndefined();
    await client.disconnect();
  });

  test("installs the browser-page owner binding for v12 visible and internal research reads", async () => {
    const captured: RelayDispatchRequest[] = [];
    const client = createRelayClient({
      serverUrl: "http://127.0.0.1:9",
      userId: "user-1",
      desktopSessionId: "desktop-1",
      browserPageOwnerInstanceId: "instance-1",
      capabilities: { profile: "desktop-agent", canControlBrowser: true, canContinueBrowserPageRead: true },
      onDispatch: async (request) => { captured.push(request); return { status: "ok" }; },
    });
    const connectPromise = client.connect();
    const ws = created[0]!;
    ws.triggerOpen();
    ws.triggerMessage(JSON.stringify({ type: "relay:registered", relayId: client.getRelayId(), protocolVersion: 12 }));
    await connectPromise;
    ws.triggerMessage(JSON.stringify({
      type: "relay:dispatch", correlationId: "corr-browser-v12", toolName: "browser_read_page", args: {},
      impact: "read-only", approvalObtained: false, executionClass: "browser",
    }));
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(captured[0]?.browserPageOwnerBinding).toEqual({
      instanceId: "instance-1", userId: "user-1", relayId: client.getRelayId(), desktopSessionId: "desktop-1",
    });
    expect(captured[0]?.browserPageSnapshotReferencePublication).toBeUndefined();
    ws.triggerMessage(JSON.stringify({
      type: "relay:dispatch", correlationId: "corr-research-v12", toolName: "browser_research_read",
      args: { url: "https://example.com", toolCallId: "tool-1", laneKey: "room:1" },
      impact: "read-only", approvalObtained: true, executionClass: "browser",
    }));
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(captured[1]?.browserPageOwnerBinding).toEqual({
      instanceId: "instance-1", userId: "user-1", relayId: client.getRelayId(), desktopSessionId: "desktop-1",
    });
    expect(captured[1]?.browserPageSnapshotReferencePublication).toBeUndefined();
    await client.disconnect();
  });

  test("separately marks v13 page-reference publication only when inspection is advertised", async () => {
    const captured: RelayDispatchRequest[] = [];
    const client = createRelayClient({
      serverUrl: "http://127.0.0.1:9",
      userId: "user-1",
      desktopSessionId: "desktop-1",
      browserPageOwnerInstanceId: "instance-1",
      capabilities: {
        profile: "desktop-agent",
        canControlBrowser: true,
        canContinueBrowserPageRead: true,
        canInspectBrowserPageSnapshot: true,
      },
      onDispatch: async (request) => { captured.push(request); return { status: "ok" }; },
    });
    const connectPromise = client.connect();
    const ws = created[0]!;
    ws.triggerOpen();
    ws.triggerMessage(JSON.stringify({ type: "relay:registered", relayId: client.getRelayId(), protocolVersion: 13 }));
    await connectPromise;
    ws.triggerMessage(JSON.stringify({
      type: "relay:dispatch", correlationId: "corr-browser-v13", toolName: "browser_read_page", args: {},
      impact: "read-only", approvalObtained: false, executionClass: "browser",
    }));
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(captured[0]?.browserPageOwnerBinding).toEqual({
      instanceId: "instance-1", userId: "user-1", relayId: client.getRelayId(), desktopSessionId: "desktop-1",
    });
    expect(captured[0]?.browserPageSnapshotReferencePublication).toBe(true);
    await client.disconnect();
  });

  test("keeps v13 continuation ownership without publishing references when inspection is absent", async () => {
    let captured: RelayDispatchRequest | undefined;
    const client = createRelayClient({
      serverUrl: "http://127.0.0.1:9",
      userId: "user-1",
      desktopSessionId: "desktop-1",
      browserPageOwnerInstanceId: "instance-1",
      capabilities: {
        profile: "desktop-agent",
        canControlBrowser: true,
        canContinueBrowserPageRead: true,
      },
      onDispatch: async (request) => { captured = request; return { status: "ok" }; },
    });
    const connectPromise = client.connect();
    const ws = created[0]!;
    ws.triggerOpen();
    ws.triggerMessage(JSON.stringify({ type: "relay:registered", relayId: client.getRelayId(), protocolVersion: 13 }));
    await connectPromise;
    ws.triggerMessage(JSON.stringify({
      type: "relay:dispatch", correlationId: "corr-browser-v13-no-inspect", toolName: "browser_read_page", args: {},
      impact: "read-only", approvalObtained: false, executionClass: "browser",
    }));
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(captured?.browserPageOwnerBinding).toEqual({
      instanceId: "instance-1", userId: "user-1", relayId: client.getRelayId(), desktopSessionId: "desktop-1",
    });
    expect(captured?.browserPageSnapshotReferencePublication).toBeUndefined();
    await client.disconnect();
  });

  test("does not install page ownership or publication when continuation is not advertised", async () => {
    let captured: RelayDispatchRequest | undefined;
    const client = createRelayClient({
      serverUrl: "http://127.0.0.1:9",
      userId: "user-1",
      desktopSessionId: "desktop-1",
      browserPageOwnerInstanceId: "instance-1",
      capabilities: { profile: "desktop-agent", canControlBrowser: true, canInspectBrowserPageSnapshot: true },
      onDispatch: async (request) => { captured = request; return { status: "ok" }; },
    });
    const connectPromise = client.connect();
    const ws = created[0]!;
    ws.triggerOpen();
    ws.triggerMessage(JSON.stringify({ type: "relay:registered", relayId: client.getRelayId(), protocolVersion: 13 }));
    await connectPromise;
    ws.triggerMessage(JSON.stringify({
      type: "relay:dispatch", correlationId: "corr-browser-capability", toolName: "browser_read_page", args: {},
      impact: "read-only", approvalObtained: false, executionClass: "browser",
    }));
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(captured?.browserPageOwnerBinding).toBeUndefined();
    expect(captured?.browserPageSnapshotReferencePublication).toBeUndefined();
    await client.disconnect();
  });

  test("relay:cancel aborts only the matching dispatch controller", async () => {
    const capturedSignals = new Map<string, AbortSignal>();
    const releases = new Map<string, () => void>();
    const client = createRelayClient({
      serverUrl: "http://127.0.0.1:9",
      userId: "user-1",
      capabilities,
      onDispatch: async (request, signal) => {
        capturedSignals.set(request.correlationId, signal);
        await new Promise<void>((resolve) => { releases.set(request.correlationId, resolve); });
        return { status: "ok" };
      },
    });
    const connectPromise = client.connect();
    const ws = created[0]!;
    ws.triggerOpen();
    ws.triggerMessage(JSON.stringify({ type: "relay:registered" }));
    await connectPromise;
    ws.triggerMessage(JSON.stringify({
      type: "relay:dispatch",
      correlationId: "corr-cancel-first",
      toolName: "local-file",
      args: {},
      impact: "read-only",
      approvalObtained: false,
      executionClass: "local-file",
    }));
    ws.triggerMessage(JSON.stringify({
      type: "relay:dispatch",
      correlationId: "corr-keep-second",
      toolName: "local-file",
      args: {},
      impact: "read-only",
      approvalObtained: false,
      executionClass: "local-file",
    }));
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(capturedSignals.get("corr-cancel-first")?.aborted).toBe(false);
    expect(capturedSignals.get("corr-keep-second")?.aborted).toBe(false);
    ws.triggerMessage(JSON.stringify({ type: "relay:cancel", correlationId: "corr-cancel-first" }));
    expect(capturedSignals.get("corr-cancel-first")?.aborted).toBe(true);
    expect(capturedSignals.get("corr-keep-second")?.aborted).toBe(false);
    releases.get("corr-cancel-first")?.();
    releases.get("corr-keep-second")?.();
    await new Promise((resolve) => setTimeout(resolve, 5));
    await client.disconnect();
  });
});
